import { geckoTerminalClient } from '../data-layer/geckoterminal-client'
import { theGraphClient } from '../data-layer/thegraph-client'
import { WATCHED_POOLS } from '../config'
import { SimulationEngine } from './simulator'
import { strategyFixed20, strategyFixed10, strategyFixed15, strategyVolBased, strategyAgent } from './strategies'
import type { BacktestOutput, OhlcvCandle, StrategyResult } from './types'

// ─── Fetch candles: The Graph first, GeckoTerminal as fallback ────────────────
async function fetchAllCandles(poolAddress: string, network: string): Promise<OhlcvCandle[]> {
  // Try The Graph first — much more history (months vs 42 days)
  if (process.env['THEGRAPH_API_KEY']) {
    try {
      console.log('Fetching from The Graph...')
      const candles = await theGraphClient.fetchWethUsdcCandles(5000)
      if (candles.length >= 100) return candles
      console.warn('[TheGraph] Not enough data, falling back to GeckoTerminal')
    } catch (err) {
      console.warn('[TheGraph] Failed, falling back to GeckoTerminal:', String(err))
    }
  }

  // Fallback: GeckoTerminal (~42 days)
  console.log('Fetching from GeckoTerminal...')
  const batch1 = await geckoTerminalClient.fetchOhlcv(poolAddress, network, 'hour', 1000)
  console.log(`  Batch 1: ${batch1.length} candles`)
  if (batch1.length < 100) return batch1

  const oldestTs = batch1[0]?.[0]
  if (!oldestTs) return batch1

  try {
    const batch2 = await geckoTerminalClient.fetchOhlcvBefore(poolAddress, network, 'hour', 1000, oldestTs)
    console.log(`  Batch 2: ${batch2.length} candles`)
    const combined = [...batch2, ...batch1]
    const seen = new Set<number>()
    const deduped = combined.filter(c => {
      if (seen.has(c[0])) return false
      seen.add(c[0])
      return true
    })
    deduped.sort((a, b) => a[0] - b[0])
    return deduped
  } catch {
    return batch1.sort((a, b) => a[0] - b[0])
  }
}

// ─── Trend classifier ─────────────────────────────────────────────────────────
// Returns 'bull' | 'bear' | 'sideways' based on price change and volatility
type Trend = 'bull' | 'bear' | 'sideways'

function classifyTrend(candles: OhlcvCandle[]): { trend: Trend; pricePct: number; volatility: number } {
  const startPrice = candles[0]![4]
  const endPrice = candles[candles.length - 1]![4]
  const pricePct = ((endPrice - startPrice) / startPrice) * 100

  // Hourly log-returns stddev
  const closes = candles.map(c => c[4])
  const returns: number[] = []
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i]! / closes[i - 1]!))
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length
  const volatility = Math.sqrt(variance) * Math.sqrt(24) * 100 // daily vol %

  let trend: Trend
  if (pricePct > 8) trend = 'bull'
  else if (pricePct < -8) trend = 'bear'
  else trend = 'sideways'

  return { trend, pricePct, volatility }
}

// ─── Print window results ─────────────────────────────────────────────────────
function printWindow(
  label: string,
  trend: Trend,
  pricePct: number,
  volatility: number,
  strategies: StrategyResult[],
  hodlFinalUsd: number,
) {
  const trendEmoji = trend === 'bull' ? '↑ BULL' : trend === 'bear' ? '↓ BEAR' : '→ SIDE'
  console.log(`\n${'═'.repeat(88)}`)
  console.log(`${label}  [${trendEmoji}  price ${pricePct >= 0 ? '+' : ''}${pricePct.toFixed(1)}%  vol ${volatility.toFixed(1)}%/day]`)
  console.log(
    'Strategy'.padEnd(20),
    'Final $'.padStart(10),
    'Net P&L'.padStart(10),
    'Fees'.padStart(10),
    'Rebal'.padStart(7),
    'InRange%'.padStart(9),
    'vs HODL'.padStart(10),
  )
  console.log('─'.repeat(88))
  for (const s of strategies) {
    const vsHodl = s.finalEquityUsd - hodlFinalUsd
    console.log(
      s.name.padEnd(20),
      `$${s.finalEquityUsd.toFixed(2)}`.padStart(10),
      `${s.netPnlUsd >= 0 ? '+' : ''}$${s.netPnlUsd.toFixed(2)}`.padStart(10),
      `$${s.totalFeesUsd.toFixed(2)}`.padStart(10),
      `${s.rebalanceCount}x`.padStart(7),
      `${s.pctTimeInRange.toFixed(1)}%`.padStart(9),
      `${vsHodl >= 0 ? '+' : ''}$${vsHodl.toFixed(2)}`.padStart(10),
    )
  }
}

// ─── Run one window ───────────────────────────────────────────────────────────
function runWindow(
  candles: OhlcvCandle[],
  allCandles: OhlcvCandle[],
  config: { capitalUsd: number; gasCostUsd: number; feeTierPct: number; tvlUsd: number },
) {
  const engine = new SimulationEngine(candles, config)
  // Agent gets full history up to window start for proper global trend analysis
  const windowStartTs = candles[0]![0]
  return {
    fixed10: engine.run('±10%', strategyFixed10),
    fixed15: engine.run('±15%', strategyFixed15),
    fixed20: engine.run('±20%', strategyFixed20),
    volBased: engine.run('Vol-Based', (p, c) => strategyVolBased(p, c)),
    agent: engine.run('Agent', (p, c) => {
      // Pass all candles up to current candle for full context
      const currentTs = c[c.length - 1]![0]
      const fullContext = allCandles.filter(x => x[0] <= currentTs)
      return strategyAgent(p, fullContext)
    }),
  }
}

// ─── Summary table ────────────────────────────────────────────────────────────
function printSummary(
  windows: Array<{ label: string; trend: Trend; winner: string; pricePct: number; volatility: number }>
) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log('SUMMARY — best strategy per period')
  console.log('─'.repeat(60))
  console.log('Period'.padEnd(20), 'Trend'.padStart(8), 'Price%'.padStart(8), 'Vol/day'.padStart(9), 'Winner'.padStart(12))
  console.log('─'.repeat(60))
  for (const w of windows) {
    const trendLabel = w.trend === 'bull' ? '↑ bull' : w.trend === 'bear' ? '↓ bear' : '→ side'
    console.log(
      w.label.padEnd(20),
      trendLabel.padStart(8),
      `${w.pricePct >= 0 ? '+' : ''}${w.pricePct.toFixed(1)}%`.padStart(8),
      `${w.volatility.toFixed(1)}%`.padStart(9),
      w.winner.padStart(12),
    )
  }
  console.log('═'.repeat(60))
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const pool = WATCHED_POOLS[0]
  if (!pool) throw new Error('No pool configured')

  const allCandles = await fetchAllCandles(pool.address, pool.network)
  if (allCandles.length < 24) throw new Error('Not enough historical data')

  const poolData = await geckoTerminalClient.fetchPool(pool.address, pool.network, pool.feeTier)
  const tvlUsd = poolData?.tvlUsd ?? 5_000_000

  console.log(`\nTotal candles: ${allCandles.length} (~${(allCandles.length / 24).toFixed(0)} days)`)
  console.log(`Pool TVL: $${(tvlUsd / 1_000_000).toFixed(1)}M | Fee tier: ${pool.feeTier / 10000}%`)

  const config = {
    capitalUsd: 1000,
    gasCostUsd: 0.30,
    feeTierPct: pool.feeTier / 1_000_000,
    tvlUsd,
  }

  // Windows: last 7d, 14d, 21d, full
  const windowDays = [7, 14, 21, Math.floor(allCandles.length / 24)]
  const summaryRows: Array<{ label: string; trend: Trend; winner: string; pricePct: number; volatility: number }> = []
  const allOutputs: BacktestOutput[] = []

  for (const days of windowDays) {
    const hours = days * 24
    const slice = allCandles.slice(-hours)
    if (slice.length < 24) continue

    const { trend, pricePct, volatility } = classifyTrend(slice)
    const results = runWindow(slice, allCandles, config)
    const strategies = [results.fixed10, results.fixed15, results.fixed20, results.volBased, results.agent]

    const startPrice = slice[0]![4]
    const endPrice = slice[slice.length - 1]![4]

    // HODL baseline (50/50 split)
    const hodlToken0 = (config.capitalUsd / 2) / startPrice
    const hodlToken1 = config.capitalUsd / 2
    const hodlFinalUsd = hodlToken0 * endPrice + hodlToken1

    const label = `Last ${days}d`
    printWindow(label, trend, pricePct, volatility, strategies, hodlFinalUsd)

    const winner = strategies.reduce((best, s) => s.finalEquityUsd > best.finalEquityUsd ? s : best)
    summaryRows.push({ label, trend, winner: winner.name, pricePct, volatility })

    allOutputs.push({
      periodDays: days,
      candleCount: slice.length,
      startPrice,
      endPrice,
      priceChangePct: pricePct,
      hodlFinalUsd,
      tvlUsd,
      strategies,
      generatedAt: new Date().toISOString(),
    })
  }

  printSummary(summaryRows)

  const fs = await import('fs')
  const outPath = `results/backtest-multi-${new Date().toISOString().slice(0, 10)}.json`
  fs.mkdirSync('results', { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(allOutputs, null, 2))
  console.log(`\nFull results saved to ${outPath}`)
}

main().catch(err => {
  console.error('Backtest failed:', err)
  process.exit(1)
})
