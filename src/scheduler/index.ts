import { rpcClient } from '../data-layer'
import { geckoTerminalClient } from '../data-layer/geckoterminal-client'
import { poolRanker } from '../analytics/pool-ranker'
import { rebalanceTrigger } from '../strategy/rebalance-trigger'
import { rangeCalculator } from '../strategy/range-calculator'
import { executor } from '../executor'
import { WATCHED_POOLS, STRATEGY, WALLET } from '../config'
import { Position, PoolState } from '../types'

// In-memory state (replace with DB persistence later)
const openPositions: Map<string, Position> = new Map() // tokenId.toString() → Position

// ─── Scheduler ────────────────────────────────────────────────────────────────

export class Scheduler {
  private monitorInterval: NodeJS.Timeout | null = null
  private rankInterval: NodeJS.Timeout | null = null

  start(): void {
    console.log('🚀 crhelper-v2 starting…')

    // Monitor open positions every 60 seconds
    this.monitorInterval = setInterval(() => this.monitorPositions(), 60_000)

    // Re-rank pools every 30 minutes
    this.rankInterval = setInterval(() => this.rankPools(), 30 * 60_000)

    // Run immediately on startup
    this.rankPools()
    this.monitorPositions()
  }

  stop(): void {
    if (this.monitorInterval) clearInterval(this.monitorInterval)
    if (this.rankInterval) clearInterval(this.rankInterval)
    console.log('Scheduler stopped.')
  }

  // ── Pool ranking loop ──────────────────────────────────────────────────────

  private async rankPools(): Promise<void> {
    try {
      console.log('\n[Ranker] Fetching pool data…')
      const currentPrices = await this.fetchCurrentPrices()
      const ranked = await poolRanker.rankPools(currentPrices)
      poolRanker.printSummary(ranked)
    } catch (err) {
      console.error('[Ranker] Error:', err)
    }
  }

  // ── Position monitoring loop ───────────────────────────────────────────────

  private async monitorPositions(): Promise<void> {
    if (openPositions.size === 0) {
      console.log('[Monitor] No open positions.')
      return
    }

    for (const [tokenIdStr, position] of openPositions) {
      try {
        const pool = WATCHED_POOLS.find(p => p.address === position.poolAddress)
        if (!pool) continue

        const poolState = await rpcClient.fetchPoolState(pool.address, pool.network, pool.token0.decimals, pool.token1.decimals, pool.protocol)
        const signal = rebalanceTrigger.evaluate(position, poolState)

        console.log(`[Monitor] Position ${tokenIdStr}: ${signal.reason}`)

        if (!signal.shouldRebalance) continue

        // ── Rebalance decision ───────────────────────────────────────────────
        const ethPrice = await this.getEthPriceUsd()
        const gasCostUsd = await executor.estimateRebalanceGasUsd(pool, ethPrice)

        if (gasCostUsd > STRATEGY.maxGasUsd) {
          console.warn(`[Monitor] Skipping rebalance — gas $${gasCostUsd.toFixed(2)} > max $${STRATEGY.maxGasUsd}`)
          continue
        }

        if (signal.urgency === 'medium') {
          console.log(`[Monitor] Urgency medium — waiting for next cycle before rebalancing.`)
          continue // proactive rebalances wait one more cycle
        }

        // ── Execute rebalance ────────────────────────────────────────────────
        const ohlcv = await geckoTerminalClient.fetchOhlcv(pool.address, pool.network, 'hour', 24)
        const currentPrice = poolState.token0Price
        const newRange = ohlcv.length >= 4
          ? rangeCalculator.buildVolatilityRange(currentPrice, pool, ohlcv)
          : rangeCalculator.buildSymmetricRange(currentPrice, pool)

        console.log(`[Executor] Rebalancing to range: ${newRange.reason}`)

        const { newTokenId, closeTxHash, mintTxHash } = await executor.rebalance(
          position.tokenId,
          pool,
          position.tickLower,
          position.tickUpper,
          position.liquidity,
          newRange,
          BigInt(Math.floor(position.token0Amount * 10 ** pool.token0.decimals)),
          BigInt(Math.floor(position.token1Amount * 10 ** pool.token1.decimals)),
        )

        // Update in-memory state
        openPositions.delete(tokenIdStr)
        openPositions.set(newTokenId.toString(), {
          ...position,
          tokenId: newTokenId,
          tickLower: newRange.tickLower,
          tickUpper: newRange.tickUpper,
          openedAt: Date.now(),
        })

        console.log(`[Executor] Rebalance done. New tokenId: ${newTokenId}`)
        console.log(`  Close: ${closeTxHash}`)
        console.log(`  Mint:  ${mintTxHash}`)
      } catch (err) {
        console.error(`[Monitor] Error on position ${tokenIdStr}:`, err)
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async fetchCurrentPrices(): Promise<Map<string, number>> {
    const prices = new Map<string, number>()
    for (const pool of WATCHED_POOLS) {
      try {
        const state = await rpcClient.fetchPoolState(pool.address, pool.network, pool.token0.decimals, pool.token1.decimals, pool.protocol)
        prices.set(pool.address, state.token0Price)
      } catch (err) {
        console.warn(`[Ranker] Could not fetch price for ${pool.address}:`, err)
      }
    }
    return prices
  }

  private async getEthPriceUsd(): Promise<number> {
    try {
      const market = await geckoTerminalClient.fetchPool(
        '0xd0b53D9277642d899DF5C87A3966A349A798F224', // WETH/USDC on Base
        'base',
      )
      return market ? 1 / market.tvlUsd * market.volumeUsd24h : 3000
    } catch {
      return 3000
    }
  }

  // ── External API: register a position opened outside the system ────────────

  registerPosition(position: Position): void {
    openPositions.set(position.tokenId.toString(), position)
    console.log(`Registered position ${position.tokenId} for monitoring.`)
  }

  getOpenPositions(): Position[] {
    return Array.from(openPositions.values())
  }
}

export const scheduler = new Scheduler()
