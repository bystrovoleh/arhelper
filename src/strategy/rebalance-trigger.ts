import { Position, PoolState, RebalanceSignal } from '../types'
import { STRATEGY } from '../config'
import { gasAdjustedRebalance } from '../analytics/range-analytics'

export class RebalanceTrigger {
  evaluate(
    position: Position,
    poolState: PoolState,
    gasCostUsd = 0.5,
    tvlUsd = 0,
  ): RebalanceSignal {
    const currentTick = poolState.tick
    const { tickLower, tickUpper } = position

    // ── 1. Out of range ──────────────────────────────────────────────────────
    if (currentTick < tickLower || currentTick >= tickUpper) {
      // Use gas-adjusted decision: is it worth rebalancing right now?
      const decision = gasAdjustedRebalance(
        position.poolAddress,
        position.token0Amount * poolState.token0Price + position.token1Amount,
        false,
        gasCostUsd,
        tvlUsd,
      )

      return {
        shouldRebalance: decision.shouldRebalance,
        reason: currentTick < tickLower
          ? `Price BELOW range (tick ${currentTick} < ${tickLower}). ${decision.reason}`
          : `Price ABOVE range (tick ${currentTick} >= ${tickUpper}). ${decision.reason}`,
        urgency: 'high',
        currentTick,
        tickLower,
        tickUpper,
      }
    }

    // ── 2. Near boundary ─────────────────────────────────────────────────────
    const rangeWidth = tickUpper - tickLower
    const lowerPct = (currentTick - tickLower) / rangeWidth
    const upperPct = (tickUpper - currentTick) / rangeWidth

    if (lowerPct < STRATEGY.rebalanceThresholdPct || upperPct < STRATEGY.rebalanceThresholdPct) {
      const side = lowerPct < upperPct ? 'lower' : 'upper'
      const pct = Math.min(lowerPct, upperPct)
      return {
        shouldRebalance: true,
        reason: `Near ${side} boundary (${(pct * 100).toFixed(1)}% of range remaining)`,
        urgency: 'medium',
        currentTick,
        tickLower,
        tickUpper,
      }
    }

    // ── 3. In range ──────────────────────────────────────────────────────────
    const centerPct = ((currentTick - tickLower) / rangeWidth * 100).toFixed(1)
    return {
      shouldRebalance: false,
      reason: `In range — ${centerPct}% from lower boundary`,
      urgency: 'low',
      currentTick,
      tickLower,
      tickUpper,
    }
  }

  shouldCollectFees(position: Position, estimatedGasCostUsd: number, token1PriceUsd: number): boolean {
    const uncollectedUsd = position.uncollectedFees0 + position.uncollectedFees1 * token1PriceUsd
    return uncollectedUsd > estimatedGasCostUsd * 3
  }
}

export const rebalanceTrigger = new RebalanceTrigger()
