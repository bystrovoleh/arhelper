import { Position, PoolState, RebalanceSignal } from '../types'
import { db } from '../../server/db'
import { WATCHED_POOLS } from '../config'

// ── Rebalance rules ───────────────────────────────────────────────────────────
// Goal: rebalance as rarely as possible to minimize gas + IL crystallization.
// Only rebalance when price has clearly and persistently left the range.
//
// Rules:
//   1. Position must be at least 8h old
//   2. Price must be out of range for 4h+ consecutively
//   3. Price must be ≥7% beyond the range boundary (not just 1 tick out)
//   4. Price must NOT be returning toward range (no reversal in last 30 min)

const MIN_DISTANCE_PCT = 0.07  // price must be 7%+ beyond boundary
const REVERSAL_WINDOW_MS = 30 * 60_000  // 30 min reversal check
const MIN_POSITION_AGE_MS = 3 * 3_600_000  // position must be 3h+ old
const MIN_OUT_OF_RANGE_MS = 4 * 3_600_000  // must be out of range for 4h+

export class RebalanceTrigger {
  evaluate(
    position: Position,
    poolState: PoolState,
  ): RebalanceSignal {
    const currentTick = poolState.tick
    const currentPrice = poolState.token0Price
    const { tickLower, tickUpper } = position

    const rangeWidth = tickUpper - tickLower
    const centerPct = ((currentTick - tickLower) / rangeWidth * 100).toFixed(1)

    // ── Rule 1: position must be at least 8h old ─────────────────────────────
    const ageMs = Date.now() - (position.openedAt ?? 0)
    if (ageMs < MIN_POSITION_AGE_MS) {
      return {
        shouldRebalance: false,
        reason: `Position too young (${(ageMs / 3_600_000).toFixed(1)}h < 8h required)`,
        urgency: 'low',
        currentTick, tickLower, tickUpper,
      }
    }

    // ── In range ─────────────────────────────────────────────────────────────
    if (currentTick >= tickLower && currentTick < tickUpper) {
      return {
        shouldRebalance: false,
        reason: `In range — ${centerPct}% from lower boundary`,
        urgency: 'low',
        currentTick, tickLower, tickUpper,
      }
    }

    // ── Rule 2: must be out of range for 4h+ ─────────────────────────────────
    const outOfRangeSince = this.getOutOfRangeSince(position.poolAddress, tickLower, tickUpper)
    const outOfRangeMs = outOfRangeSince ? Date.now() - outOfRangeSince : 0
    if (outOfRangeMs < MIN_OUT_OF_RANGE_MS) {
      return {
        shouldRebalance: false,
        reason: `Out of range but only for ${(outOfRangeMs / 3_600_000).toFixed(1)}h (need 4h+)`,
        urgency: 'medium',
        currentTick, tickLower, tickUpper,
      }
    }

    // ── Out of range — apply remaining checks ─────────────────────────────────

    // Rule 3: price must be ≥7% beyond boundary
    const poolCfg = WATCHED_POOLS.find(p => p.address.toLowerCase() === position.poolAddress.toLowerCase())
    const decimalAdj = Math.pow(10, (poolCfg?.token0.decimals ?? 18) - (poolCfg?.token1.decimals ?? 6))
    const priceLower = Math.pow(1.0001, tickLower) * decimalAdj
    const priceUpper = Math.pow(1.0001, tickUpper) * decimalAdj

    let distancePct = 0
    let side = ''
    if (currentTick < tickLower) {
      distancePct = (priceLower - currentPrice) / priceLower
      side = 'BELOW'
    } else {
      distancePct = (currentPrice - priceUpper) / priceUpper
      side = 'ABOVE'
    }

    if (distancePct < MIN_DISTANCE_PCT) {
      return {
        shouldRebalance: false,
        reason: `${side} range but only ${(distancePct * 100).toFixed(2)}% out — waiting for ≥${MIN_DISTANCE_PCT * 100}%`,
        urgency: 'low',
        currentTick, tickLower, tickUpper,
      }
    }

    // Rule 4: check for price reversal toward range in last 30 min
    if (this.isPriceReturning(position.poolAddress, currentPrice, tickLower, tickUpper, decimalAdj)) {
      return {
        shouldRebalance: false,
        reason: `${side} range ${(distancePct * 100).toFixed(2)}% — but price returning toward range, holding`,
        urgency: 'medium',
        currentTick, tickLower, tickUpper,
      }
    }

    return {
      shouldRebalance: true,
      reason: `${side} range by ${(distancePct * 100).toFixed(2)}% for extended period — rebalance`,
      urgency: 'high',
      currentTick, tickLower, tickUpper,
    }
  }

  private getOutOfRangeSince(poolAddress: string, tickLower: number, tickUpper: number): number | null {
    try {
      const snaps = db.prepare(`
        SELECT recorded_at, tick FROM pool_snapshots
        WHERE pool_address = ? AND recorded_at >= ?
        ORDER BY recorded_at ASC
      `).all(poolAddress, Date.now() - 24 * 3_600_000) as Array<{ recorded_at: number; tick: number }>

      if (snaps.length === 0) return null

      // Walk backwards: find last snapshot where tick was in range
      for (let i = snaps.length - 1; i >= 0; i--) {
        const s = snaps[i]!
        if (s.tick >= tickLower && s.tick < tickUpper) {
          return snaps[i + 1]?.recorded_at ?? null
        }
      }

      // All 24h was out of range — use oldest snapshot time
      return snaps[0]!.recorded_at
    } catch {
      return null
    }
  }

  private isPriceReturning(
    poolAddress: string,
    currentPrice: number,
    tickLower: number,
    tickUpper: number,
    decimalAdj: number,
  ): boolean {
    try {
      const recentSnaps = db.prepare(`
        SELECT current_price FROM pool_snapshots
        WHERE pool_address = ? AND recorded_at >= ?
        ORDER BY recorded_at ASC
      `).all(poolAddress, Date.now() - REVERSAL_WINDOW_MS) as Array<{ current_price: number }>

      if (recentSnaps.length < 3) return false

      const priceLower = Math.pow(1.0001, tickLower) * decimalAdj
      const priceUpper = Math.pow(1.0001, tickUpper) * decimalAdj
      const midRange = (priceLower + priceUpper) / 2

      const oldest = recentSnaps[0]!.current_price
      const distOld = Math.abs(oldest - midRange)
      const distNew = Math.abs(currentPrice - midRange)

      return distNew < distOld * 0.95
    } catch {
      return false
    }
  }

  shouldCollectFees(position: Position, estimatedGasCostUsd: number, token1PriceUsd: number): boolean {
    const uncollectedUsd = position.uncollectedFees0 + position.uncollectedFees1 * token1PriceUsd
    return uncollectedUsd > estimatedGasCostUsd * 3
  }
}

export const rebalanceTrigger = new RebalanceTrigger()
