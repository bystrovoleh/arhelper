import type { OhlcvCandle } from '../backtest/types'

// ─── Trend Analyzer ───────────────────────────────────────────────────────────
// Multi-timeframe trend analysis for range selection.
//
// Three levels:
//   1. Global  (90d candles) — macro direction
//   2. Local   (14d candles) — medium-term context
//   3. Short   (48h candles) — entry timing
//
// Each level returns a TrendSignal with direction + confidence (0–1).
// Final RangeDecision combines all three + S/R + volume.

export type Direction = 'bull' | 'bear' | 'sideways'

export interface TrendSignal {
  direction: Direction
  confidence: number   // 0–1
  adx: number
  volatilityPct: number  // daily vol %
  emaFast: number
  emaSlow: number
}

export interface SupportResistance {
  support: number
  resistance: number
  nearSupport: boolean   // price within 2% of support
  nearResistance: boolean
  withinLevels: boolean  // price between S and R (not near either)
}

export interface VolumeSignal {
  relativeVolume: number  // current vs 20-period avg (1.0 = average)
  trending: boolean       // volume confirms price direction
}

export interface RangeAdvice {
  rangePct: number        // e.g. 0.10 = ±10%
  lowerBias: number       // shift lower boundary extra (0 = symmetric, 0.05 = 5% extra down)
  upperBias: number       // shift upper boundary extra
  shouldOpen: boolean     // false = conditions unfavorable, wait
  reason: string
  confidence: number
  global: TrendSignal
  local: TrendSignal
  short: TrendSignal
  sr: SupportResistance
  volume: VolumeSignal
}

// ─── EMA ─────────────────────────────────────────────────────────────────────
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: number[] = []
  let prev = values[0]!
  for (const v of values) {
    prev = v * k + prev * (1 - k)
    result.push(prev)
  }
  return result
}

// ─── ADX (Wilder's) ──────────────────────────────────────────────────────────
function adx(candles: OhlcvCandle[], period = 14): number {
  if (candles.length < period * 2) return 0
  const trueRanges: number[] = []
  const plusDMs: number[] = []
  const minusDMs: number[] = []

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i]![2], low = candles[i]![3], close = candles[i]![4]
    const prevHigh = candles[i - 1]![2], prevLow = candles[i - 1]![3], prevClose = candles[i - 1]![4]
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
    const upMove = high - prevHigh
    const downMove = prevLow - low
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0)
  }

  // Wilder smoothing
  const smooth = (arr: number[]) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0)
    const out = [s]
    for (let i = period; i < arr.length; i++) {
      s = s - s / period + arr[i]!
      out.push(s)
    }
    return out
  }

  const sTR = smooth(trueRanges)
  const sPDM = smooth(plusDMs)
  const sMDM = smooth(minusDMs)

  const dxValues: number[] = []
  for (let i = 0; i < sTR.length; i++) {
    if (sTR[i]! === 0) continue
    const pDI = (sPDM[i]! / sTR[i]!) * 100
    const mDI = (sMDM[i]! / sTR[i]!) * 100
    const sum = pDI + mDI
    if (sum === 0) continue
    dxValues.push(Math.abs(pDI - mDI) / sum * 100)
  }

  if (dxValues.length < period) return 0
  return dxValues.slice(-period).reduce((a, b) => a + b, 0) / period
}

// ─── Daily volatility (stddev of log-returns × √24 for hourly candles) ───────
function dailyVol(candles: OhlcvCandle[]): number {
  const closes = candles.map(c => c[4])
  const returns: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]! > 0) returns.push(Math.log(closes[i]! / closes[i - 1]!))
  }
  if (returns.length < 2) return 0
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
  return Math.sqrt(variance) * Math.sqrt(24) * 100
}

// ─── Trend signal from a slice of candles ────────────────────────────────────
function analyzeTrend(candles: OhlcvCandle[]): TrendSignal {
  const closes = candles.map(c => c[4])
  const fastPeriod = Math.max(8, Math.floor(candles.length * 0.15))
  const slowPeriod = Math.max(16, Math.floor(candles.length * 0.40))

  const emaFastArr = ema(closes, fastPeriod)
  const emaSlowArr = ema(closes, slowPeriod)
  const emaFast = emaFastArr[emaFastArr.length - 1]!
  const emaSlow = emaSlowArr[emaSlowArr.length - 1]!

  const adxVal = adx(candles)
  const vol = dailyVol(candles)

  const emaDiffPct = (emaFast - emaSlow) / emaSlow

  // Direction
  let direction: Direction
  if (Math.abs(emaDiffPct) < 0.02 || adxVal < 15) {
    direction = 'sideways'
  } else {
    direction = emaDiffPct > 0 ? 'bull' : 'bear'
  }

  // Confidence: combination of ADX strength and EMA separation
  const adxConf = Math.min(adxVal / 50, 1)
  const emaConf = Math.min(Math.abs(emaDiffPct) / 0.10, 1)
  const confidence = direction === 'sideways' ? 0.5 : (adxConf * 0.6 + emaConf * 0.4)

  return { direction, confidence, adx: adxVal, volatilityPct: vol, emaFast, emaSlow }
}

// ─── Support / Resistance ─────────────────────────────────────────────────────
function findSupportResistance(candles: OhlcvCandle[], currentPrice: number): SupportResistance {
  // Find swing highs and lows over the window
  const highs = candles.map(c => c[2])
  const lows = candles.map(c => c[3])

  // Simple: use rolling 10-period local extrema
  const swingHighs: number[] = []
  const swingLows: number[] = []
  const w = 5

  for (let i = w; i < candles.length - w; i++) {
    const slice = candles.slice(i - w, i + w + 1)
    const h = candles[i]![2]
    const l = candles[i]![3]
    if (slice.every(c => c[2] <= h)) swingHighs.push(h)
    if (slice.every(c => c[3] >= l)) swingLows.push(l)
  }

  // Cluster nearby levels (within 1%)
  const cluster = (levels: number[]): number[] => {
    if (levels.length === 0) return []
    levels.sort((a, b) => a - b)
    const clusters: number[][] = [[levels[0]!]]
    for (let i = 1; i < levels.length; i++) {
      const last = clusters[clusters.length - 1]!
      const avg = last.reduce((s, v) => s + v, 0) / last.length
      if (Math.abs(levels[i]! - avg) / avg < 0.01) {
        last.push(levels[i]!)
      } else {
        clusters.push([levels[i]!])
      }
    }
    return clusters.map(c => c.reduce((s, v) => s + v, 0) / c.length)
  }

  const resistanceLevels = cluster(swingHighs).filter(l => l > currentPrice)
  const supportLevels = cluster(swingLows).filter(l => l < currentPrice)

  // Nearest levels
  const resistance = resistanceLevels.length > 0
    ? Math.min(...resistanceLevels)
    : Math.max(...highs)
  const support = supportLevels.length > 0
    ? Math.max(...supportLevels)
    : Math.min(...lows)

  const nearResistance = (resistance - currentPrice) / currentPrice < 0.02
  const nearSupport = (currentPrice - support) / currentPrice < 0.02
  const withinLevels = !nearSupport && !nearResistance

  return { support, resistance, nearSupport, nearResistance, withinLevels }
}

// ─── Volume signal ────────────────────────────────────────────────────────────
function analyzeVolume(candles: OhlcvCandle[]): VolumeSignal {
  const period = Math.min(20, candles.length)
  const recent = candles.slice(-period)
  const avgVol = recent.reduce((s, c) => s + c[5], 0) / recent.length
  const lastVol = candles[candles.length - 1]![5]
  const relativeVolume = avgVol > 0 ? lastVol / avgVol : 1

  // Volume confirms trend if last 3 candles: price direction matches volume
  const last3 = candles.slice(-3)
  let volTrend = 0
  for (let i = 1; i < last3.length; i++) {
    const priceUp = last3[i]![4] > last3[i - 1]![4]
    const volUp = last3[i]![5] > last3[i - 1]![5]
    if (priceUp === volUp) volTrend++
  }
  const trending = volTrend >= 2

  return { relativeVolume, trending }
}

// ─── Main analyzer ────────────────────────────────────────────────────────────
export class TrendAnalyzer {
  /**
   * Analyze candles at three timeframes and produce a range recommendation.
   * @param candles  All available hourly candles (oldest → newest)
   * @param currentPrice  Current market price
   */
  analyze(candles: OhlcvCandle[], currentPrice: number): RangeAdvice {
    const n = candles.length

    // Slice each timeframe (hours)
    const globalCandles = candles.slice(-Math.min(n, 90 * 24))
    const localCandles  = candles.slice(-Math.min(n, 14 * 24))
    const shortCandles  = candles.slice(-Math.min(n, 48))

    const global = analyzeTrend(globalCandles)
    const local  = analyzeTrend(localCandles)
    const short  = analyzeTrend(shortCandles)
    const sr     = findSupportResistance(candles.slice(-30 * 24), currentPrice)
    const volume = analyzeVolume(candles.slice(-48))

    // ── Volatility regime ─────────────────────────────────────────────────────
    const vol = local.volatilityPct  // 7–14d daily vol

    // ── Confidence-weighted direction ─────────────────────────────────────────
    // Global matters most, local second, short least
    const weightedScore =
      this.dirScore(global.direction) * global.confidence * 0.5 +
      this.dirScore(local.direction)  * local.confidence  * 0.35 +
      this.dirScore(short.direction)  * short.confidence  * 0.15

    // ── Should we open at all? ────────────────────────────────────────────────
    // Don't open if: extreme volatility OR conflicting strong signals
    const extremeVol = vol > 6
    const conflicting = (
      global.direction !== 'sideways' &&
      local.direction !== 'sideways' &&
      global.direction !== local.direction &&
      global.confidence > 0.6 &&
      local.confidence > 0.6
    )

    if (extremeVol || conflicting) {
      return {
        rangePct: 0.15,
        lowerBias: 0,
        upperBias: 0,
        shouldOpen: false,
        reason: extremeVol
          ? `Extreme volatility ${vol.toFixed(1)}%/day — wait for calmer conditions`
          : `Global ${global.direction} vs local ${local.direction} — signals conflict, waiting`,
        confidence: 0.2,
        global, local, short, sr, volume,
      }
    }

    // ── Range selection ───────────────────────────────────────────────────────
    let rangePct: number
    let reason: string

    if (vol < 3.5 && global.adx < 30) {
      rangePct = 0.10
      reason = `Vol ${vol.toFixed(1)}%/day, ADX=${global.adx.toFixed(0)} — tight ±10%`
    } else if (vol < 4.5 || global.adx < 40) {
      rangePct = 0.15
      reason = `Vol ${vol.toFixed(1)}%/day, ADX=${global.adx.toFixed(0)} — ±15%`
    } else {
      rangePct = 0.15
      reason = `High vol ${vol.toFixed(1)}%/day — capped at ±15%`
    }

    // S/R adjustment: only widen if price is very close (<1%) to a level
    const veryNearSupport = (currentPrice - sr.support) / currentPrice < 0.01
    const veryNearResistance = (sr.resistance - currentPrice) / currentPrice < 0.01
    if (veryNearSupport || veryNearResistance) {
      rangePct = Math.min(rangePct + 0.01, 0.15)
      reason += veryNearSupport
        ? ` | very near support $${sr.support.toFixed(0)}, widened`
        : ` | very near resistance $${sr.resistance.toFixed(0)}, widened`
    }

    // ── Asymmetric bias ───────────────────────────────────────────────────────
    let lowerBias = 0
    let upperBias = 0

    if (global.direction === 'bear' && global.confidence > 0.5) {
      // Bearish: extend lower boundary, shrink upper
      lowerBias = 0.03 * global.confidence
      upperBias = -0.02 * global.confidence
      reason += ` | bearish bias (lower +${(lowerBias * 100).toFixed(1)}%)`
    } else if (global.direction === 'bull' && global.confidence > 0.5) {
      // Bullish: extend upper boundary, shrink lower
      upperBias = 0.03 * global.confidence
      lowerBias = -0.02 * global.confidence
      reason += ` | bullish bias (upper +${(upperBias * 100).toFixed(1)}%)`
    }

    // ── Overall confidence ────────────────────────────────────────────────────
    const confidence = Math.min(
      (global.confidence * 0.5 + local.confidence * 0.35 + short.confidence * 0.15) *
      (volume.trending ? 1.1 : 0.9),
      1,
    )

    return {
      rangePct,
      lowerBias,
      upperBias,
      shouldOpen: true,
      reason,
      confidence,
      global, local, short, sr, volume,
    }
  }

  private dirScore(d: Direction): number {
    return d === 'bull' ? 1 : d === 'bear' ? -1 : 0
  }
}

export const trendAnalyzer = new TrendAnalyzer()
