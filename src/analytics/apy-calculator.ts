import { PoolConfig, PoolMarketData, RangeRecommendation } from '../types'

// ─── APY Calculator ───────────────────────────────────────────────────────────
// Estimates concentrated liquidity APY for a given price range.
//
// Key insight: in Uniswap v3, your fee share scales by how concentrated your
// position is vs. the total in-range liquidity. A ±10% range around current
// price earns ~5-10x more than full-range — but only while price stays inside.

export class ApyCalculator {
  /**
   * Estimate APY for a concentrated LP position.
   *
   * Formula:
   *   concentrationFactor = sqrt(upperPrice / lowerPrice) / (sqrt(upperPrice/lowerPrice) - 1)
   *   concentratedApy = fullRangeApy * concentrationFactor * inRangeTimeFraction
   *
   * This is an approximation. Actual returns depend on your share of in-range liquidity.
   */
  estimateConcentratedApy(
    fullRangeApyPct: number,  // from DefiLlama (full-range estimate)
    priceLower: number,
    priceUpper: number,
    currentPrice: number,
    inRangeTimeFraction = 0.85, // assume 85% of time price is in range (conservative)
  ): number {
    if (priceLower <= 0 || priceUpper <= priceLower || currentPrice <= 0) return 0

    // Concentration multiplier: how much more liquidity you provide per dollar
    // vs full-range in the active region
    const sqrtUpper = Math.sqrt(priceUpper)
    const sqrtLower = Math.sqrt(priceLower)
    const sqrtCurrent = Math.sqrt(currentPrice)

    // Capital efficiency factor (Uniswap v3 whitepaper derivation)
    // concentrationFactor = (sqrtUpper * sqrtLower) / (sqrtCurrent * (sqrtUpper - sqrtLower))
    const denominator = sqrtCurrent * (sqrtUpper - sqrtLower)

    if (denominator <= 0) return 0
    const concentrationFactor = (sqrtUpper * sqrtLower) / denominator

    return fullRangeApyPct * concentrationFactor * inRangeTimeFraction
  }

  /**
   * Estimate daily fees earned by a position in USD.
   *
   * positionSizeUsd: your capital in the position
   * concentratedApyPct: from estimateConcentratedApy()
   */
  estimateDailyFeesUsd(positionSizeUsd: number, concentratedApyPct: number): number {
    return positionSizeUsd * (concentratedApyPct / 100) / 365
  }

  /**
   * Calculate impermanent loss for a given price movement.
   * Returns IL as a negative percentage (e.g. -2.5 means 2.5% loss vs holding).
   */
  calculateImpermanentLoss(
    entryPrice: number,
    currentPrice: number,
    priceLower?: number,
    priceUpper?: number,
  ): number {
    if (entryPrice <= 0) return 0
    const k = currentPrice / entryPrice

    // If range bounds provided, use concentrated IL formula
    if (priceLower != null && priceUpper != null && priceLower > 0 && priceUpper > priceLower) {
      const sqrtK = Math.sqrt(k)
      const sqrtLower = Math.sqrt(priceLower / entryPrice)
      const sqrtUpper = Math.sqrt(priceUpper / entryPrice)

      // In-range: standard concentrated IL
      if (k >= priceLower / entryPrice && k <= priceUpper / entryPrice) {
        const lpValue = 2 * sqrtK - sqrtLower - (k / sqrtUpper)
        const hodlValue = 1 + k - sqrtLower - (k / sqrtUpper) // normalized HODL at entry range
        if (hodlValue <= 0) return 0
        return ((lpValue / hodlValue) - 1) * 100
      }

      // Below range: all converted to token0, full IL vs HODL
      if (k < priceLower / entryPrice) {
        const lpValue = sqrtUpper - sqrtLower // all token0
        const hodlValue = 1 + k
        return ((lpValue * 2 * Math.sqrt(entryPrice) / hodlValue) - 1) * 100
      }

      // Above range: all converted to token1, full IL vs HODL
      const lpValue = (1 / sqrtLower - 1 / sqrtUpper) * k
      const hodlValue = 1 + k
      return ((lpValue * 2 / hodlValue) - 1) * 100
    }

    // Fallback: full-range IL formula (always <= 0)
    const lpValue = 2 * Math.sqrt(k)
    const hodlValue = 1 + k
    return ((lpValue / hodlValue) - 1) * 100
  }

  /**
   * Score a pool based on fee APY, volume stability, and TVL.
   * Higher score = better pool to LP in.
   */
  scorePool(market: PoolMarketData, pool: PoolConfig, range: RangeRecommendation): number {
    const feeTierPct = pool.feeTier / 1_000_000

    // Annualised fee APY from raw 24h data
    const rawApy = market.tvlUsd > 0 ? (market.feesUsd24h * 365 / market.tvlUsd) * 100 : 0

    // Concentrated APY estimate for the proposed range
    const midPrice = Math.sqrt(range.priceLower * range.priceUpper)
    const concentratedApy = this.estimateConcentratedApy(rawApy, range.priceLower, range.priceUpper, midPrice)

    // TVL score: penalise very thin pools (<$100K) and very thick (>$50M, less IL risk but lower APY edge)
    const tvlScore = market.tvlUsd < 100_000 ? 0.5 : market.tvlUsd > 50_000_000 ? 0.8 : 1.0

    // Volume consistency: prefer pools with vol/TVL > 0.1 (active but not manipulated)
    const volRatio = market.tvlUsd > 0 ? market.volumeUsd24h / market.tvlUsd : 0
    const volScore = volRatio > 0.05 && volRatio < 5 ? 1.0 : 0.6

    // Fee tier bonus: higher fee = fewer but larger trades (less IL pressure)
    const feeTierScore = feeTierPct >= 0.003 ? 1.1 : 1.0

    return concentratedApy * tvlScore * volScore * feeTierScore
  }
}

export const apyCalculator = new ApyCalculator()
