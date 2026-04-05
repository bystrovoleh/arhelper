import { PoolConfig, PoolMarketData, RangeRecommendation } from '../types'
import { apyCalculator } from './apy-calculator'
import { geckoTerminalClient } from '../data-layer/geckoterminal-client'
import { WATCHED_POOLS, STRATEGY } from '../config'

export interface RankedPool {
  pool: PoolConfig
  market: PoolMarketData
  estimatedConcentratedApy: number
  score: number
  range: RangeRecommendation
}

// ─── Pool Ranker ──────────────────────────────────────────────────────────────

export class PoolRanker {
  /**
   * Rank all watched pools by estimated concentrated APY.
   * Returns pools sorted best → worst.
   */
  async rankPools(currentPrices: Map<string, number>): Promise<RankedPool[]> {
    const ranked: RankedPool[] = []

    for (const pool of WATCHED_POOLS) {
      if (ranked.length > 0) await new Promise(r => setTimeout(r, 2000))
      let market: PoolMarketData | null = null
      try {
        market = await geckoTerminalClient.fetchPool(pool.address, pool.network, pool.feeTier)
      } catch { continue }
      if (!market) continue

      const currentPrice = currentPrices.get(pool.address) ?? market.tvlUsd / market.volumeUsd24h
      if (!currentPrice) continue

      const range = this.buildDefaultRange(currentPrice, STRATEGY.defaultRangePct)

      const rawApy = market.tvlUsd > 0
        ? (market.feesUsd24h * 365 / market.tvlUsd) * 100
        : 0

      const estimatedConcentratedApy = apyCalculator.estimateConcentratedApy(
        rawApy,
        range.priceLower,
        range.priceUpper,
        currentPrice,
      )

      const score = apyCalculator.scorePool(market, pool, range)

      ranked.push({ pool, market, estimatedConcentratedApy, score, range })
    }

    return ranked.sort((a, b) => b.score - a.score)
  }

  buildDefaultRange(currentPrice: number, rangePct: number): RangeRecommendation {
    const priceLower = currentPrice * (1 - rangePct)
    const priceUpper = currentPrice * (1 + rangePct)
    return {
      priceLower,
      priceUpper,
      tickLower: 0, // filled by strategy module with proper tick alignment
      tickUpper: 0,
      rangePct,
      reason: `Default ±${(rangePct * 100).toFixed(0)}% range around current price`,
    }
  }

  /**
   * Print a ranked summary to console (useful for monitoring logs).
   */
  printSummary(ranked: RankedPool[]): void {
    console.log('\n═══════════════════════ POOL RANKING ═══════════════════════')
    ranked.forEach((r, i) => {
      console.log(
        `${i + 1}. ${r.pool.token0.symbol}/${r.pool.token1.symbol} [${r.pool.protocol}]` +
        `\n   APY (concentrated): ${r.estimatedConcentratedApy.toFixed(1)}%` +
        `\n   Score: ${r.score.toFixed(2)}` +
        `\n   TVL: $${(r.market.tvlUsd / 1000).toFixed(0)}K` +
        `\n   Vol 24h: $${(r.market.volumeUsd24h / 1000).toFixed(0)}K` +
        `\n   Range: $${r.range.priceLower.toFixed(2)} – $${r.range.priceUpper.toFixed(2)}\n`
      )
    })
    console.log('════════════════════════════════════════════════════════════\n')
  }
}

export const poolRanker = new PoolRanker()
