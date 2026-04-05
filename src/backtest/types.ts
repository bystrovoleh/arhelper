export type OhlcvCandle = [number, number, number, number, number, number]
// [timestamp_ms, open, high, low, close, volume_usd]

export interface BacktestPosition {
  priceLower: number
  priceUpper: number
  entryPrice: number
  entryCapitalUsd: number
  openedAtIndex: number
}

export interface CandleResult {
  timestamp: number
  price: number
  inRange: boolean
  feesEarnedUsd: number
  equityUsd: number
  rebalancedThisCandle: boolean
}

export interface StrategyResult {
  name: string
  totalFeesUsd: number
  totalGasCostUsd: number
  rebalanceCount: number
  netPnlUsd: number
  finalEquityUsd: number
  pctTimeInRange: number
  equityCurve: Array<{ t: number; equity: number; fees: number }>
}

export interface BacktestOutput {
  periodDays: number
  candleCount: number
  startPrice: number
  endPrice: number
  priceChangePct: number
  hodlFinalUsd: number
  tvlUsd: number
  strategies: StrategyResult[]
  generatedAt: string
}

export interface SimConfig {
  capitalUsd: number
  gasCostUsd: number
  feeTierPct: number
  tvlUsd: number
}
