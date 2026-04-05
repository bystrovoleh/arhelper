import { geckoTerminalClient } from '../data-layer/geckoterminal-client'
import { WATCHED_POOLS } from '../config'
import { SimulationEngine } from './simulator'
import { strategyFixed20, strategyFixed10, strategyVolBased } from './strategies'
import type { BacktestOutput, OhlcvCandle } from './types'

// ─── Fetch up to 2000 hourly candles (paginated) ─────────────────────────────
async function fetchAllCandles(poolAddress: string, network: string): Promise<OhlcvCandle[]> {
  console.log('Fetching historical OHLCV data...')

  // First batch: most recent 1000 candles
  const batch1 = await geckoTerminalClient.fetchOhlcv(poolAddress, network, 'hour', 1000)
  console.log(`  Batch 1: ${batch1.length} candles`)

  if (batch1.length < 100) {
    console.warn('  Warning: very little historical data available')
    return batch1
  }

  // Second batch: older candles (before earliest in batch1)
  const oldestTs = batch1[0]?.[0]
  if (!oldestTs) return batch1

  try {
    const batch2 = await geckoTerminalClient.fetchOhlcvBefore(poolAddress, network, 'hour', 1000, oldestTs)
    console.log(`  Batch 2: ${batch2.length} candles`)
    const combined = [...batch2, ...batch1]
    // Deduplicate by timestamp
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

// ─── Print comparison table ───────────────────────────────────────────────────
function printTable(output: BacktestOutput) {
  console.log('\n' + '═'.repeat(80))
  console.log(`BACKTEST RESULTS — ${output.periodDays.toFixed(0)} days`)
  console.log(`Price: $${output.startPrice.toFixed(0)} → $${output.endPrice.toFixed(0)} (${output.priceChangePct >= 0 ? '+' : ''}${output.priceChangePct.toFixed(1)}%)`)
  console.log(`HODL $1000 → $${output.hodlFinalUsd.toFixed(2)} | Pool TVL: $${(output.tvlUsd / 1_000_000).toFixed(1)}M`)
  console.log('═'.repeat(80))
  console.log(
    'Strategy'.padEnd(25),
    'Final $'.padStart(10),
    'Net P&L'.padStart(10),
    'Fees'.padStart(10),
    'Gas'.padStart(8),
    'Rebalances'.padStart(12),
    'In-Range%'.padStart(10),
  )
  console.log('─'.repeat(80))
  for (const s of output.strategies) {
    console.log(
      s.name.padEnd(25),
      `$${s.finalEquityUsd.toFixed(2)}`.padStart(10),
      `${s.netPnlUsd >= 0 ? '+' : ''}$${s.netPnlUsd.toFixed(2)}`.padStart(10),
      `$${s.totalFeesUsd.toFixed(2)}`.padStart(10),
      `$${s.totalGasCostUsd.toFixed(2)}`.padStart(8),
      `${s.rebalanceCount}x`.padStart(12),
      `${s.pctTimeInRange.toFixed(1)}%`.padStart(10),
    )
  }
  console.log('═'.repeat(80))
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const pool = WATCHED_POOLS[0]
  if (!pool) throw new Error('No pool configured')

  // Fetch data
  const candles = await fetchAllCandles(pool.address, pool.network)
  if (candles.length < 24) throw new Error('Not enough historical data')

  const poolData = await geckoTerminalClient.fetchPool(pool.address, pool.network, pool.feeTier)
  const tvlUsd = poolData?.tvlUsd ?? 5_000_000

  console.log(`\nRunning backtest on ${candles.length} hourly candles (~${(candles.length / 24).toFixed(0)} days)`)
  console.log(`Pool TVL: $${(tvlUsd / 1_000_000).toFixed(1)}M | Fee tier: ${pool.feeTier / 10000}%`)

  const config = {
    capitalUsd: 1000,
    gasCostUsd: 0.30,
    feeTierPct: pool.feeTier / 1_000_000,
    tvlUsd,
  }

  const engine = new SimulationEngine(candles, config)

  console.log('\nSimulating strategies...')
  const resultA = engine.run('A: Fixed ±20%', strategyFixed20)
  const resultB = engine.run('B: Fixed ±10%', strategyFixed10)
  const resultC = engine.run('C: Vol-Based', (p, c) => strategyVolBased(p, c))

  // HODL baseline
  const startPrice = candles[0]![4]
  const endPrice = candles[candles.length - 1]![4]
  const hodlToken0 = (config.capitalUsd / 2) / startPrice
  const hodlToken1 = config.capitalUsd / 2
  const hodlFinalUsd = hodlToken0 * endPrice + hodlToken1

  const output: BacktestOutput = {
    periodDays: candles.length / 24,
    candleCount: candles.length,
    startPrice,
    endPrice,
    priceChangePct: ((endPrice - startPrice) / startPrice) * 100,
    hodlFinalUsd,
    tvlUsd,
    strategies: [resultA, resultB, resultC],
    generatedAt: new Date().toISOString(),
  }

  printTable(output)

  // Write JSON results
  const fs = await import('fs')
  const outPath = `results/backtest-${new Date().toISOString().slice(0, 10)}.json`
  fs.mkdirSync('results', { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2))
  console.log(`\nFull results saved to ${outPath}`)
}

main().catch(err => {
  console.error('Backtest failed:', err)
  process.exit(1)
})
