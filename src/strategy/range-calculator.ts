import { nearestUsableTick, priceToClosestTick, tickToPrice } from '@uniswap/v3-sdk'
import { Token as UniToken } from '@uniswap/sdk-core'
import { PoolConfig, PoolState, RangeRecommendation } from '../types'
import { STRATEGY } from '../config'
import { detectVolatilityRegime, calcInRangeTime } from '../analytics/range-analytics'

// ─── Range Calculator ─────────────────────────────────────────────────────────
// Converts price targets to aligned Uniswap v3 ticks.
//
// Uniswap v3 uses a discrete tick system where each tick represents a 0.01%
// price step. Positions must start and end on "usable ticks" — multiples of
// tickSpacing (varies by fee tier: 10 for 0.05%, 60 for 0.3%, 200 for 1%).

const FEE_TO_TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
}

export class RangeCalculator {
  /**
   * Calculate tick range from a price range.
   * Returns tick-aligned RangeRecommendation.
   */
  priceRangeToTicks(
    priceLower: number,
    priceUpper: number,
    pool: PoolConfig,
  ): RangeRecommendation {
    const tickSpacing = FEE_TO_TICK_SPACING[pool.feeTier] ?? 60

    const uniToken0 = new UniToken(this.chainId(pool), pool.token0.address, pool.token0.decimals, pool.token0.symbol)
    const uniToken1 = new UniToken(this.chainId(pool), pool.token1.address, pool.token1.decimals, pool.token1.symbol)

    // priceToClosestTick expects a Price<Token, Token> object
    // We use the SDK's tickToPrice helper in reverse by computing ticks manually
    // via the log formula: tick = log(price) / log(1.0001)
    const tickLowerRaw = Math.floor(Math.log(priceLower) / Math.log(1.0001))
    const tickUpperRaw = Math.ceil(Math.log(priceUpper) / Math.log(1.0001))

    const tickLower = nearestUsableTick(tickLowerRaw, tickSpacing)
    const tickUpper = nearestUsableTick(tickUpperRaw, tickSpacing)

    // Convert back to actual prices for display
    const actualPriceLower = Math.pow(1.0001, tickLower)
    const actualPriceUpper = Math.pow(1.0001, tickUpper)

    const rangePct = (actualPriceUpper / actualPriceLower - 1) / 2

    return {
      tickLower,
      tickUpper,
      priceLower: actualPriceLower,
      priceUpper: actualPriceUpper,
      rangePct,
      reason: `±${(rangePct * 100).toFixed(1)}% range [tick ${tickLower} → ${tickUpper}]`,
    }
  }

  /**
   * Build a symmetric range around current price.
   * rangePct = 0.20 means ±20% (price range is currentPrice × 0.8 to × 1.2)
   */
  buildSymmetricRange(
    currentPrice: number,
    pool: PoolConfig,
    rangePct = STRATEGY.defaultRangePct,
  ): RangeRecommendation {
    const priceLower = currentPrice * (1 - rangePct)
    const priceUpper = currentPrice * (1 + rangePct)
    const range = this.priceRangeToTicks(priceLower, priceUpper, pool)
    range.reason = `Symmetric ±${(rangePct * 100).toFixed(0)}% around $${currentPrice.toFixed(2)}`
    return range
  }

  /**
   * Build a volatility-adjusted range using recent OHLCV data.
   * Uses 2× standard deviation of recent hourly returns as range width.
   */
  buildVolatilityRange(
    currentPrice: number,
    pool: PoolConfig,
    ohlcv: Array<[number, number, number, number, number, number]>, // [ts, o, h, l, c, vol]
    sigmaMultiplier = 2,
  ): RangeRecommendation {
    if (ohlcv.length < 4) {
      return this.buildSymmetricRange(currentPrice, pool)
    }

    // Compute hourly log-returns
    const closes = ohlcv.map(c => c[4]).filter(p => p > 0)
    const returns: number[] = []
    for (let i = 1; i < closes.length; i++) {
      returns.push(Math.log(closes[i]! / closes[i - 1]!))
    }

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length
    const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length
    const sigma = Math.sqrt(variance)

    // Annualised to daily: sigma_hourly × sqrt(24) — then scale to N sigma
    const dailySigma = sigma * Math.sqrt(24)
    const rangePct = Math.min(Math.max(dailySigma * sigmaMultiplier, 0.05), 0.50) // clamp 5%–50%

    const range = this.buildSymmetricRange(currentPrice, pool, rangePct)
    range.reason = `Volatility-based ±${(rangePct * 100).toFixed(1)}% (${sigmaMultiplier}σ daily, σ=${(dailySigma * 100).toFixed(2)}%)`
    return range
  }

  /**
   * Best range: combines volatility regime + historical in-range time.
   * This is the recommended method to call for opening/rebalancing.
   */
  buildOptimalRange(
    currentPrice: number,
    pool: PoolConfig,
    ohlcv: Array<[number, number, number, number, number, number]>,
  ): RangeRecommendation {
    const regime = detectVolatilityRegime(pool.address)
    const inRangeStats = calcInRangeTime(pool.address, currentPrice * 0.8, currentPrice * 1.2)

    // Start from volatility-based range
    let rangePct: number
    let reason: string

    if (regime.regime === 'unknown' || ohlcv.length < 4) {
      // Not enough data — use regime recommendation or default
      rangePct = regime.recommendedRangePct || STRATEGY.defaultRangePct
      reason = `Default range ±${(rangePct * 100).toFixed(1)}% (insufficient history)`
    } else {
      // Use regime-aware range, but cross-check with historical in-range time
      const volBasedPct = this.calcVolPct(ohlcv)
      const regimePct = regime.recommendedRangePct

      // Blend: 60% regime, 40% vol-based
      rangePct = regimePct * 0.6 + volBasedPct * 0.4

      // If historical in-range time is low (<70%), widen the range
      if (inRangeStats.inRangePct < 0.70 && inRangeStats.inRangePct > 0) {
        rangePct = Math.max(rangePct, inRangeStats.recommendedRangePct)
      }

      rangePct = Math.min(Math.max(rangePct, 0.05), 0.50)

      reason = `Optimal ±${(rangePct * 100).toFixed(1)}% [${regime.regime}, ADX=${regime.adx.toFixed(0)}, in-range=${(inRangeStats.inRangePct * 100).toFixed(0)}%]`
    }

    const range = this.buildSymmetricRange(currentPrice, pool, rangePct)
    range.reason = reason
    return range
  }

  private calcVolPct(ohlcv: Array<[number, number, number, number, number, number]>): number {
    const closes = ohlcv.map(c => c[4]).filter(p => p > 0)
    if (closes.length < 2) return STRATEGY.defaultRangePct
    const returns: number[] = []
    for (let i = 1; i < closes.length; i++) {
      returns.push(Math.log(closes[i]! / closes[i - 1]!))
    }
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length
    const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length
    const dailySigma = Math.sqrt(variance) * Math.sqrt(24)
    return Math.min(Math.max(dailySigma * 2, 0.05), 0.50)
  }

  private chainId(pool: PoolConfig): number {
    const map: Record<string, number> = { base: 8453, arbitrum: 42161, ethereum: 1 }
    return map[pool.network] ?? 1
  }
}

export const rangeCalculator = new RangeCalculator()
