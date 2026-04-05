import { db } from '../../server/db'

// ─── Range Analytics ──────────────────────────────────────────────────────────
// Three analytical tools:
//   1. Historical in-range time — how often would a given range have been active
//   2. Gas-adjusted rebalance decision — is it worth rebalancing now?
//   3. Volatility regime detection — trending vs ranging market

// ── 1. Historical In-Range Time ───────────────────────────────────────────────

export interface InRangeStats {
  inRangePct: number       // 0–1, fraction of time price was in range
  avgHoursInRange: number  // average consecutive hours before going out
  outOfRangeEvents: number // how many times it left the range
  recommendedRangePct: number // suggested ±% for 80% in-range time
}

export function calcInRangeTime(
  poolAddress: string,
  priceLower: number,
  priceUpper: number,
  lookbackHours = 168, // 7 days
): InRangeStats {
  const since = Date.now() - lookbackHours * 3_600_000

  const rows = db.prepare(`
    SELECT current_price, recorded_at
    FROM pool_snapshots
    WHERE pool_address = ? AND recorded_at >= ?
    ORDER BY recorded_at ASC
  `).all(poolAddress, since) as Array<{ current_price: number; recorded_at: number }>

  if (rows.length < 2) {
    return { inRangePct: 0.85, avgHoursInRange: 24, outOfRangeEvents: 0, recommendedRangePct: 0.20 }
  }

  let inRangeCount = 0
  let outOfRangeEvents = 0
  let wasInRange = true
  let consecutiveInRangeStart = rows[0]!.recorded_at
  const consecutiveWindows: number[] = []

  for (const row of rows) {
    const inRange = row.current_price >= priceLower && row.current_price <= priceUpper
    if (inRange) {
      inRangeCount++
      if (!wasInRange) {
        consecutiveInRangeStart = row.recorded_at
      }
    } else {
      if (wasInRange && consecutiveInRangeStart) {
        const hours = (row.recorded_at - consecutiveInRangeStart) / 3_600_000
        consecutiveWindows.push(hours)
      }
      outOfRangeEvents++
    }
    wasInRange = inRange
  }

  // Record the final open window if price ended in range
  if (wasInRange && consecutiveInRangeStart) {
    const lastRow = rows[rows.length - 1]!
    const hours = (lastRow.recorded_at - consecutiveInRangeStart) / 3_600_000
    if (hours > 0) consecutiveWindows.push(hours)
  }

  const inRangePct = inRangeCount / rows.length
  const avgHoursInRange = consecutiveWindows.length > 0
    ? consecutiveWindows.reduce((s, h) => s + h, 0) / consecutiveWindows.length
    : lookbackHours

  // Find range width needed for 80% in-range time using price history
  const prices = rows.map(r => r.current_price).filter(p => p > 0)
  const recommendedRangePct = calcRangeForTargetInRange(prices, 0.80)

  return { inRangePct, avgHoursInRange, outOfRangeEvents, recommendedRangePct }
}

function calcRangeForTargetInRange(prices: number[], target: number): number {
  if (prices.length < 2) return 0.20
  const mid = prices[Math.floor(prices.length / 2)]!

  // Binary search for the ±% that achieves target in-range time
  let lo = 0.02, hi = 0.80
  for (let iter = 0; iter < 20; iter++) {
    const mid_pct = (lo + hi) / 2
    const lower = mid * (1 - mid_pct)
    const upper = mid * (1 + mid_pct)
    const inRangePct = prices.filter(p => p >= lower && p <= upper).length / prices.length
    if (inRangePct < target) lo = mid_pct
    else hi = mid_pct
  }

  return parseFloat(((lo + hi) / 2).toFixed(3))
}

// ── 2. Gas-Adjusted Rebalance Decision ───────────────────────────────────────

export interface RebalanceDecision {
  shouldRebalance: boolean
  reason: string
  feesLostPerHourUsd: number
  gasCostUsd: number
  breakEvenHours: number
  netBenefitUsd: number // over next 24h if we rebalance now
}

export function gasAdjustedRebalance(
  poolAddress: string,
  positionCapitalUsd: number,
  isCurrentlyInRange: boolean,
  gasCostUsd: number,
  tvlUsd: number,
): RebalanceDecision {
  // Get recent hourly fee rate from pool snapshots
  const recentSnaps = db.prepare(`
    SELECT volume_usd_24h
    FROM pool_snapshots
    WHERE pool_address = ?
    ORDER BY recorded_at DESC
    LIMIT 24
  `).all(poolAddress) as Array<{ volume_usd_24h: number }>

  const avgVol24h = recentSnaps.length > 0
    ? recentSnaps.reduce((s, r) => s + (r.volume_usd_24h ?? 0), 0) / recentSnaps.length
    : 0

  const feeTier = 0.0005
  const poolFeesPerHour = (avgVol24h / 24) * feeTier
  const positionShare = tvlUsd > 0 ? positionCapitalUsd / tvlUsd : 0
  const concentrationMultiplier = 5 // ±10% range ≈ 5x
  const feesPerHourUsd = poolFeesPerHour * positionShare * concentrationMultiplier

  if (isCurrentlyInRange) {
    return {
      shouldRebalance: false,
      reason: 'Position is in range — earning fees',
      feesLostPerHourUsd: 0,
      gasCostUsd,
      breakEvenHours: Infinity,
      netBenefitUsd: -gasCostUsd,
    }
  }

  // Out of range: fees = $0 until we rebalance
  // Net benefit over 24h = fees we'd earn after rebalance - gas cost
  const netBenefit24h = feesPerHourUsd * 24 - gasCostUsd
  const breakEvenHours = feesPerHourUsd > 0 ? gasCostUsd / feesPerHourUsd : Infinity

  return {
    shouldRebalance: netBenefit24h > 0,
    reason: netBenefit24h > 0
      ? `Rebalance profitable: earn ~$${(feesPerHourUsd * 24).toFixed(2)}/day, gas $${gasCostUsd.toFixed(2)}, break-even in ${breakEvenHours.toFixed(1)}h`
      : `Not worth rebalancing yet: would earn $${(feesPerHourUsd * 24).toFixed(2)}/day but gas is $${gasCostUsd.toFixed(2)}`,
    feesLostPerHourUsd: feesPerHourUsd,
    gasCostUsd,
    breakEvenHours,
    netBenefitUsd: netBenefit24h,
  }
}

// ── 3. Volatility Regime Detection ───────────────────────────────────────────

export type VolatilityRegime = 'ranging' | 'trending' | 'breakout' | 'unknown'

export interface RegimeAnalysis {
  regime: VolatilityRegime
  adx: number            // 0–100, >25 = trending
  realizedVol24h: number // annualised % volatility
  realizedVol7d: number
  recommendedRangePct: number
  description: string
}

export function detectVolatilityRegime(poolAddress: string): RegimeAnalysis {
  const rows = db.prepare(`
    SELECT current_price, recorded_at
    FROM pool_snapshots
    WHERE pool_address = ?
    ORDER BY recorded_at DESC
    LIMIT 336  -- 7 days of hourly data (assuming ~2min snapshots = ~3 per hour)
  `).all(poolAddress) as Array<{ current_price: number; recorded_at: number }>

  if (rows.length < 10) {
    return {
      regime: 'unknown', adx: 0,
      realizedVol24h: 0, realizedVol7d: 0,
      recommendedRangePct: 0.20,
      description: 'Not enough data yet',
    }
  }

  const prices = rows.map(r => r.current_price).reverse() // oldest first

  // ── Realized Volatility ──────────────────────────────────────────────────
  const logReturns = prices.slice(1).map((p, i) => Math.log(p / prices[i]!))

  const last24 = logReturns.slice(-24)
  const last7d = logReturns

  // Annualize: each log return spans one snapshot interval.
  // rows covers ~7 days → logReturns.length intervals in 7 days → per-year factor = logReturns.length * (365/7)
  const periodsPerYear = logReturns.length * (365 / 7)
  const realizedVol24h = stdDev(last24) * Math.sqrt(periodsPerYear) * 100
  const realizedVol7d = stdDev(last7d) * Math.sqrt(periodsPerYear) * 100

  // ── ADX (Average Directional Index) ─────────────────────────────────────
  // Simplified ADX using price-only data (normally uses OHLCV)
  // We approximate True Range as |price[i] - price[i-1]|
  const period = 14
  const adx = calcSimpleADX(prices, period)

  // ── Regime Classification ─────────────────────────────────────────────────
  let regime: VolatilityRegime
  let description: string
  let recommendedRangePct: number

  const volRatio = realizedVol24h / Math.max(realizedVol7d, 0.1) // spike detector

  if (volRatio > 2.0) {
    regime = 'breakout'
    description = `Breakout detected: 24h vol ${realizedVol24h.toFixed(1)}% >> 7d vol ${realizedVol7d.toFixed(1)}%. Widen range.`
    recommendedRangePct = 0.40
  } else if (adx > 25) {
    regime = 'trending'
    description = `Trending market (ADX=${adx.toFixed(0)}). Price has directional momentum. Use wider range.`
    recommendedRangePct = Math.min(0.35, realizedVol7d / 100 * 3)
  } else {
    regime = 'ranging'
    description = `Ranging market (ADX=${adx.toFixed(0)}). Price oscillating. Tighter range captures more fees.`
    recommendedRangePct = Math.max(0.08, realizedVol7d / 100 * 1.5)
  }

  return {
    regime, adx, realizedVol24h, realizedVol7d,
    recommendedRangePct: parseFloat(recommendedRangePct.toFixed(3)),
    description,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stdDev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length
  return Math.sqrt(variance)
}

function calcSimpleADX(prices: number[], period: number): number {
  if (prices.length < period * 2) return 20 // default mid-value

  const tr: number[] = []
  const plusDM: number[] = []
  const minusDM: number[] = []

  for (let i = 1; i < prices.length; i++) {
    const high = Math.max(prices[i]!, prices[i - 1]!)
    const low = Math.min(prices[i]!, prices[i - 1]!)
    tr.push(high - low)

    const upMove = prices[i]! - prices[i - 1]!
    const downMove = prices[i - 1]! - prices[i]!
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)
  }

  // Wilder's smoothing: seed with average of first `period` values, then apply EMA
  const smooth = (arr: number[]) => {
    let smoothed = arr.slice(0, period).reduce((s, v) => s + v, 0) / period
    const result = [smoothed]
    for (let i = period; i < arr.length; i++) {
      smoothed = smoothed - smoothed / period + arr[i]!
      result.push(smoothed)
    }
    return result
  }

  const sTR = smooth(tr)
  const sPDM = smooth(plusDM)
  const sMDM = smooth(minusDM)

  const dx: number[] = []
  for (let i = 0; i < sTR.length; i++) {
    if (!sTR[i]) continue
    const pdi = (sPDM[i]! / sTR[i]!) * 100
    const mdi = (sMDM[i]! / sTR[i]!) * 100
    const sum = pdi + mdi
    dx.push(sum > 0 ? (Math.abs(pdi - mdi) / sum) * 100 : 0)
  }

  if (dx.length < period) return 20
  return dx.slice(-period).reduce((s, v) => s + v, 0) / period
}
