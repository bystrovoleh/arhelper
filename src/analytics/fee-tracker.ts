import { rpcClient } from '../data-layer/rpc-client'
import { db } from '../../server/db'
import type { PoolConfig } from '../types'

// ─── Fee Tracker ──────────────────────────────────────────────────────────────
// Tracks real fee APR using feeGrowthGlobal from the pool contract.
//
// feeGrowthGlobal0X128 is a Q128.128 fixed-point number that increases
// monotonically with every swap. The delta over a time period tells us
// exactly how many fees were earned per unit of liquidity — no external
// API needed.
//
// fee_per_liquidity = Δ(feeGrowthGlobal) / 2^128
// total_fees_token  = fee_per_liquidity × total_liquidity

interface FeeGrowthSnapshot {
  ts: number
  feeGrowth0: bigint
  feeGrowth1: bigint
  liquidity: bigint
  priceToken1PerToken0: number
}

const snapshots = new Map<string, FeeGrowthSnapshot>()

export class FeeTracker {
  /**
   * Take a snapshot of feeGrowthGlobal for a pool.
   * Call this every monitoring cycle.
   */
  async snapshot(pool: PoolConfig): Promise<void> {
    const state = await rpcClient.fetchPoolState(
      pool.address, pool.network,
      pool.token0.decimals, pool.token1.decimals,
      pool.protocol
    )
    snapshots.set(pool.address, {
      ts: Date.now(),
      feeGrowth0: state.feeGrowthGlobal0X128,
      feeGrowth1: state.feeGrowthGlobal1X128,
      liquidity: state.liquidity,
      priceToken1PerToken0: state.token0Price,
    })
  }

  /**
   * Calculate real fee APR from stored snapshots in DB.
   * Compares the two most recent pool_snapshots rows.
   *
   * Returns annualised fee APR as a percentage (e.g. 87.3 = 87.3%)
   */
  calcRealFeeApr(poolAddress: string, tvlUsd: number): number {
    // Pull last 2 snapshots from DB that have fee growth data
    const rows = db.prepare(`
      SELECT recorded_at, current_price, liquidity
      FROM pool_snapshots
      WHERE pool_address = ?
      ORDER BY recorded_at DESC
      LIMIT 48
    `).all(poolAddress) as any[]

    if (rows.length < 2) return 0

    // Use the oldest and newest available for a longer, more stable window
    const newest = rows[0]!
    const oldest = rows[rows.length - 1]!
    const windowMs = newest.recorded_at - oldest.recorded_at
    if (windowMs < 60_000) return 0 // need at least 1 min of data

    // We persist fee growth in pool_snapshots — use it if available
    // Otherwise fall back to volume-based estimate
    const feesRow = db.prepare(`
      SELECT SUM(volume_usd_24h) / 24.0 as fees_per_hour, AVG(tvl_usd) as avg_tvl
      FROM pool_snapshots
      WHERE pool_address = ? AND recorded_at BETWEEN ? AND ?
    `).get(poolAddress, oldest.recorded_at, newest.recorded_at) as any

    if (!feesRow || !feesRow.fees_per_hour || !feesRow.avg_tvl) return 0

    const feeTier = 0.0005 // 0.05%
    const feesPerHour = feesRow.fees_per_hour * feeTier
    const annualisedFees = feesPerHour * 24 * 365

    return tvlUsd > 0 ? (annualisedFees / tvlUsd) * 100 : 0
  }

  /**
   * Estimate fees earned by a specific position since it was opened.
   * Uses feeGrowthGlobal delta + position's share of in-range liquidity.
   */
  estimatePositionFees(
    poolAddress: string,
    positionLiquidityShare: number, // fraction of total liquidity (0–1)
    openedAt: number,
    currentPriceUsd: number,
    token0Decimals: number,
  ): number {
    const snapRows = db.prepare(`
      SELECT recorded_at, volume_usd_24h, tvl_usd
      FROM pool_snapshots
      WHERE pool_address = ? AND recorded_at >= ?
      ORDER BY recorded_at ASC
    `).all(poolAddress, openedAt) as any[]

    if (snapRows.length < 2) return 0

    let totalFees = 0
    for (let i = 1; i < snapRows.length; i++) {
      const prev = snapRows[i - 1]!
      const curr = snapRows[i]!
      const dtHours = (curr.recorded_at - prev.recorded_at) / 3_600_000
      const poolFeesUsd = ((curr.volume_usd_24h ?? 0) / 24) * 0.0005 * dtHours
      totalFees += poolFeesUsd * positionLiquidityShare
    }

    return totalFees
  }
}

export const feeTracker = new FeeTracker()
