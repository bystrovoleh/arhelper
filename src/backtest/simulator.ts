import type { OhlcvCandle, BacktestPosition, CandleResult, StrategyResult, SimConfig } from './types'
import type { RangeDecision } from './strategies'

// ─── Simulation Engine ────────────────────────────────────────────────────────
// Replays historical OHLCV candles for a single strategy.
// No DB, no RPC — pure math on historical data.

export class SimulationEngine {
  constructor(
    private readonly candles: OhlcvCandle[],
    private readonly config: SimConfig,
  ) {}

  run(
    name: string,
    strategyFn: (price: number, recentCandles: OhlcvCandle[]) => RangeDecision,
  ): StrategyResult {
    const { capitalUsd, gasCostUsd, feeTierPct, tvlUsd } = this.config

    let position: BacktestPosition | null = null
    let capitalNow = capitalUsd
    let cumulativeFeesUsd = 0
    let totalGasCostUsd = 0
    let rebalanceCount = 0
    let candlesInRange = 0
    const results: CandleResult[] = []

    // Track HODL baseline (set on first candle)
    let hodlToken0 = 0 // WETH units
    let hodlToken1 = 0 // USDC units

    for (let i = 0; i < this.candles.length; i++) {
      const candle = this.candles[i]!
      const price = candle[4]  // close price
      const volumeUsd = candle[5]
      if (price <= 0) continue

      // ── Open position if none ───────────────────────────────────────────────
      if (!position) {
        const recent = this.candles.slice(Math.max(0, i - 24), i + 1)
        const range = strategyFn(price, recent)
        position = {
          priceLower: range.priceLower,
          priceUpper: range.priceUpper,
          entryPrice: price,
          entryCapitalUsd: capitalNow,
          openedAtIndex: i,
        }

        // HODL baseline: fixed 50/50 split at entry
        if (hodlToken0 === 0 && hodlToken1 === 0) {
          hodlToken0 = (capitalNow / 2) / price
          hodlToken1 = capitalNow / 2
        }
      }

      // ── Check in-range ──────────────────────────────────────────────────────
      const inRange = price >= position.priceLower && price <= position.priceUpper

      // ── Estimate fees this candle ───────────────────────────────────────────
      let feesThisCandle = 0
      if (inRange) {
        candlesInRange++
        const poolFees1h = volumeUsd * feeTierPct
        const positionShare = tvlUsd > 0 ? capitalNow / tvlUsd : 0
        const cf = this.concentrationFactor(position.priceLower, position.priceUpper, price)
        feesThisCandle = poolFees1h * positionShare * cf
        cumulativeFeesUsd += feesThisCandle
      }

      // ── Compute current equity ──────────────────────────────────────────────
      const lpFraction = this.lpValueFraction(position.entryPrice, price, position.priceLower, position.priceUpper)
      const lpValueUsd = position.entryCapitalUsd * lpFraction
      const equityUsd = lpValueUsd + cumulativeFeesUsd

      // ── Check rebalance ─────────────────────────────────────────────────────
      let rebalanced = false
      if (!inRange) {
        // Rebalance: realize current equity, deduct gas, open new position
        const newCapital = equityUsd - gasCostUsd
        totalGasCostUsd += gasCostUsd
        rebalanceCount++
        capitalNow = Math.max(newCapital, 1)
        cumulativeFeesUsd = 0  // fees restart from new position capital

        const recent = this.candles.slice(Math.max(0, i - 24), i + 1)
        const range = strategyFn(price, recent)
        position = {
          priceLower: range.priceLower,
          priceUpper: range.priceUpper,
          entryPrice: price,
          entryCapitalUsd: capitalNow,
          openedAtIndex: i,
        }
        rebalanced = true
      }

      results.push({
        timestamp: candle[0],
        price,
        inRange,
        feesEarnedUsd: feesThisCandle,
        equityUsd: rebalanced ? capitalNow : equityUsd,
        rebalancedThisCandle: rebalanced,
      })
    }

    // ── Aggregate metrics ───────────────────────────────────────────────────
    const totalFeesUsd = results.reduce((s, r) => s + r.feesEarnedUsd, 0)
    const finalEquity = results[results.length - 1]?.equityUsd ?? capitalUsd
    const netPnlUsd = finalEquity - capitalUsd

    return {
      name,
      totalFeesUsd,
      totalGasCostUsd,
      rebalanceCount,
      netPnlUsd,
      finalEquityUsd: finalEquity,
      pctTimeInRange: this.candles.length > 0 ? (candlesInRange / this.candles.length) * 100 : 0,
      equityCurve: results.map(r => ({ t: r.timestamp, equity: r.equityUsd, fees: r.feesEarnedUsd })),
    }
  }

  // ── Concentration factor ─────────────────────────────────────────────────
  private concentrationFactor(priceLower: number, priceUpper: number, currentPrice: number): number {
    if (currentPrice <= priceLower || currentPrice >= priceUpper) return 0
    const sqrtU = Math.sqrt(priceUpper)
    const sqrtL = Math.sqrt(priceLower)
    const sqrtC = Math.sqrt(currentPrice)
    const denom = sqrtC * (sqrtU - sqrtL)
    if (denom <= 0) return 1
    return Math.min((sqrtU * sqrtL) / denom, 20)
  }

  // ── LP value as fraction of entry capital ────────────────────────────────
  // Returns current value of LP position relative to entry capital (not IL%).
  // Tracks actual token0/token1 amounts as price moves through the range.
  private lpValueFraction(entryPrice: number, currentPrice: number, priceLower: number, priceUpper: number): number {
    if (entryPrice <= 0) return 1

    // At entry, capital split 50/50:
    // token0 = 0.5 / entryPrice (in token0 units)
    // token1 = 0.5 (in token1 units, normalized to 1 USD = 1 unit)
    const token0Entry = 0.5 / entryPrice
    const token1Entry = 0.5

    const sqrtEntry = Math.sqrt(entryPrice)
    const sqrtLower = Math.sqrt(priceLower)
    const sqrtUpper = Math.sqrt(priceUpper)
    const sqrtCurrent = Math.sqrt(currentPrice)

    // Liquidity L from entry position (Uniswap v3 formula)
    // L = token1Entry / (sqrtEntry - sqrtLower)  (from token1 side)
    const L = token1Entry / (sqrtEntry - sqrtLower)

    let token0Now: number
    let token1Now: number

    if (currentPrice <= priceLower) {
      // All converted to token0
      token0Now = L * (1 / sqrtLower - 1 / sqrtUpper)
      token1Now = 0
    } else if (currentPrice >= priceUpper) {
      // All converted to token1
      token0Now = 0
      token1Now = L * (sqrtUpper - sqrtLower)
    } else {
      // In range — mixed
      token0Now = L * (1 / sqrtCurrent - 1 / sqrtUpper)
      token1Now = L * (sqrtCurrent - sqrtLower)
    }

    const valueNow = token0Now * currentPrice + token1Now
    const entryValue = token0Entry * entryPrice + token1Entry // = 1.0

    return valueNow / entryValue
  }
}
