import type { OhlcvCandle } from './types'

export interface RangeDecision {
  priceLower: number
  priceUpper: number
}

// ── Strategy A: Fixed ±20% ────────────────────────────────────────────────────
export function strategyFixed20(currentPrice: number): RangeDecision {
  return {
    priceLower: currentPrice * 0.80,
    priceUpper: currentPrice * 1.20,
  }
}

// ── Strategy B: Fixed ±10% ────────────────────────────────────────────────────
export function strategyFixed10(currentPrice: number): RangeDecision {
  return {
    priceLower: currentPrice * 0.90,
    priceUpper: currentPrice * 1.10,
  }
}

// ── Strategy C: Volatility-based ─────────────────────────────────────────────
// Uses rolling 24h stddev of log-returns to set range width.
// rangePct = dailySigma × 2, clamped to [8%, 40%]
export function strategyVolBased(currentPrice: number, recentCandles: OhlcvCandle[]): RangeDecision {
  if (recentCandles.length < 4) {
    // Not enough data — fallback to ±20%
    return strategyFixed20(currentPrice)
  }

  const closes = recentCandles.map(c => c[4]).filter(p => p > 0)
  const returns: number[] = []
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i]! / closes[i - 1]!))
  }

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length
  const sigma = Math.sqrt(variance)

  // Scale hourly sigma to daily, then use 2σ as range half-width
  const dailySigma = sigma * Math.sqrt(24)
  const rangePct = Math.min(Math.max(dailySigma * 2, 0.08), 0.40)

  return {
    priceLower: currentPrice * (1 - rangePct),
    priceUpper: currentPrice * (1 + rangePct),
  }
}
