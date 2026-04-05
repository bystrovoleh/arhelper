import { Position, PoolState, RebalanceSignal } from '../types'
import { db } from '../../server/db'

// ── Rebalance rules ───────────────────────────────────────────────────────────
// Goal: rebalance as rarely as possible to minimize gas + IL crystallization.
// Only rebalance when price has clearly and persistently left the range.
//
// Rules:
//   1. Position must be at least 8h old
//   2. Price must be out of range for 4h+ consecutively
//   3. Price must be ≥3% beyond the range boundary (not just 1 tick out)
//   4. Price must NOT be returning toward range (no reversal in last 30 min)

const MIN_DISTANCE_PCT = 0.07  // price must be 7%+ beyond boundary
const REVERSAL_WINDOW_MS = 30 * 60_000  // 30 min reversal check

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

    // ── In range ─────────────────────────────────────────────────────────────
    if (currentTick >= tickLower && currentTick < tickUpper) {
      return {
        shouldRebalance: false,
        reason: `In range — ${centerPct}% from lower boundary`,
        urgency: 'low',
        currentTick, tickLower, tickUpper,
      }
    }

    // ── Out of range — apply all checks ──────────────────────────────────────

    // Rule 3: price must be ≥3% beyond boundary
    const decimalAdj = 1e12 // WETH/USDC
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

  // Check if price is moving back toward the range in recent snapshots
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

      // Check if price trend is toward range center
      const oldest = recentSnaps[0]!.current_price
      const distOld = Math.abs(oldest - midRange)
      const distNew = Math.abs(currentPrice - midRange)

      // Returning if current price is closer to range than 30 min ago
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
