import express from 'express'
import cors from 'cors'
import { db, logEvent } from './db'
import { paperEngine } from './paper-engine'
import { liveEngine } from './live-engine'
import { executor } from '../src/executor'
import { WATCHED_POOLS } from '../src/config'
import { rpcClient } from '../src/data-layer/rpc-client'
import { geckoTerminalClient } from '../src/data-layer/geckoterminal-client'
import { liquidityDistribution } from '../src/analytics/liquidity-distribution'
import { detectVolatilityRegime, calcInRangeTime, gasAdjustedRebalance } from '../src/analytics/range-analytics'

const LIVE = process.env['LIVE'] === 'true'

export const app = express()
app.use(cors())
app.use(express.json())

// ─── Positions ────────────────────────────────────────────────────────────────

app.get('/api/positions', (_req, res) => {
  const positions = db.prepare(`
    SELECT p.*,
      s.current_price, s.fees_usd, s.il_pct, s.pnl_usd, s.in_range,
      s.token0_amount as current_token0_amount,
      s.token1_amount as current_token1_amount,
      s.recorded_at as last_snapshot_at,
      COALESCE(sw.total_swap_costs, 0) as swap_costs_usd,
      COALESCE(sw.total_gas_costs, 0)  as gas_costs_usd,
      COALESCE(sw.swap_count, 0)       as swap_count
    FROM positions p
    LEFT JOIN position_snapshots s ON s.token_id = p.token_id
      AND s.id = (SELECT MAX(id) FROM position_snapshots WHERE token_id = p.token_id)
    LEFT JOIN (
      SELECT token_id,
        SUM(CASE WHEN token_in != 'GAS' THEN amount_in_usd - amount_out_usd ELSE 0 END) as total_swap_costs,
        SUM(gas_usd) as total_gas_costs,
        COUNT(CASE WHEN token_in != 'GAS' THEN 1 END) as swap_count
      FROM swap_events
      GROUP BY token_id
    ) sw ON sw.token_id = p.token_id
    ORDER BY p.opened_at DESC
  `).all()
  res.json(positions)
})

// Close a live position on-chain
app.post('/api/positions/:tokenId/close', async (req, res) => {
  const { tokenId } = req.params
  const row = db.prepare(`SELECT * FROM positions WHERE token_id = ? AND status = 'open'`).get(tokenId) as any
  if (!row) { res.status(404).json({ error: 'Open position not found' }); return }

  const pool = WATCHED_POOLS.find(p => p.address === row.pool_address)
  if (!pool) { res.status(400).json({ error: 'Pool not found' }); return }

  try {
    if (LIVE && !/^live-dry/.test(tokenId)) {
      const txHash = await executor.closePosition(
        BigInt(tokenId), pool,
        row.tick_lower, row.tick_upper,
        BigInt(row.liquidity ?? 0),
      )
      db.prepare(`UPDATE positions SET status = 'closed', closed_at = ? WHERE token_id = ?`).run(Date.now(), tokenId)
      logEvent('INFO', `[LIVE] Position ${tokenId} closed manually. tx: ${txHash}`, { tokenId })
      res.json({ ok: true, txHash })
    } else {
      // Paper / dry-run: just mark closed
      db.prepare(`UPDATE positions SET status = 'closed', closed_at = ? WHERE token_id = ?`).run(Date.now(), tokenId)
      logEvent('INFO', `Position ${tokenId} closed manually (paper/dry)`, { tokenId })
      res.json({ ok: true, txHash: null })
    }
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.get('/api/positions/:tokenId', (req, res) => {
  const position = db.prepare(`SELECT * FROM positions WHERE token_id = ?`).get(req.params['tokenId'])
  if (!position) { res.status(404).json({ error: 'Not found' }); return }

  const snapshots = db.prepare(`
    SELECT * FROM position_snapshots WHERE token_id = ? ORDER BY recorded_at ASC
  `).all(req.params['tokenId'])

  res.json({ position, snapshots })
})

// Swap history for a position
app.get('/api/positions/:tokenId/swaps', (req, res) => {
  const swaps = db.prepare(`
    SELECT * FROM swap_events WHERE token_id = ? ORDER BY occurred_at ASC
  `).all(req.params['tokenId'])
  res.json(swaps)
})

// ─── Events / Log ─────────────────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  const limit = Number(req.query['limit'] ?? 50)
  const type = req.query['type'] as string | undefined
  const events = type
    ? db.prepare(`SELECT * FROM events WHERE type = ? ORDER BY occurred_at DESC LIMIT ?`).all(type, limit)
    : db.prepare(`SELECT * FROM events ORDER BY occurred_at DESC LIMIT ?`).all(limit)
  res.json(events)
})

// ─── Pool data ────────────────────────────────────────────────────────────────

let poolsCache: { data: any[]; ts: number } | null = null
const POOLS_CACHE_TTL = 60_000 // refresh at most once per minute

// Cache for rebalance-decision (expensive: RPC + GeckoTerminal)
const rebalanceDecisionCache = new Map<string, { data: any; ts: number }>()
const REBALANCE_DECISION_CACHE_TTL = 5 * 60_000 // 5 minutes

app.get('/api/pools', async (_req, res) => {
  if (poolsCache && Date.now() - poolsCache.ts < POOLS_CACHE_TTL) {
    res.json(poolsCache.data)
    return
  }
  try {
    const result = []
    for (const pool of WATCHED_POOLS) {
      if (result.length > 0) await new Promise(r => setTimeout(r, 2000))
      const state = await rpcClient.fetchPoolState(pool.address, pool.network, pool.token0.decimals, pool.token1.decimals, pool.protocol)
      let market = null
      try { market = await geckoTerminalClient.fetchPool(pool.address, pool.network, pool.feeTier) } catch { /* rate limited */ }

      const snap = db.prepare(`
        SELECT * FROM pool_snapshots WHERE pool_address = ? ORDER BY recorded_at DESC LIMIT 1
      `).get(pool.address) as any

      result.push({
        ...pool,
        currentPrice: state.token0Price,
        tick: state.tick,
        volumeUsd24h: market?.volumeUsd24h ?? 0,
        tvlUsd: market?.tvlUsd ?? 0,
        apyBase: market?.apyBase ?? 0,
        estimatedConcentratedApy: snap?.estimated_concentrated_apy ?? 0,
      })
    }
    poolsCache = { data: result, ts: Date.now() }
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.get('/api/pools/:address/history', (req, res) => {
  const snapshots = db.prepare(`
    SELECT * FROM pool_snapshots WHERE pool_address = ? ORDER BY recorded_at ASC
  `).all(req.params['address'])
  res.json(snapshots)
})

// ─── Stats ────────────────────────────────────────────────────────────────────

app.get('/api/stats', (_req, res) => {
  const totalPositions = (db.prepare(`SELECT COUNT(*) as c FROM positions`).get() as any).c
  const openPositions = (db.prepare(`SELECT COUNT(*) as c FROM positions WHERE status = 'open'`).get() as any).c
  const rebalances = (db.prepare(`SELECT COUNT(*) as c FROM positions WHERE status = 'rebalanced'`).get() as any).c

  const pnl = db.prepare(`
    SELECT
      COALESCE(SUM(s.pnl_usd), 0) as total_pnl,
      COALESCE(SUM(s.fees_usd), 0) as total_fees,
      COALESCE(SUM(sw.total_swap_costs), 0) as total_swap_costs,
      COALESCE(SUM(sw.total_gas_costs), 0) as total_gas_costs
    FROM positions p
    JOIN position_snapshots s ON s.token_id = p.token_id
      AND s.id = (SELECT MAX(id) FROM position_snapshots WHERE token_id = p.token_id)
    LEFT JOIN (
      SELECT token_id,
        SUM(CASE WHEN token_in != 'GAS' THEN amount_in_usd - amount_out_usd ELSE 0 END) as total_swap_costs,
        SUM(gas_usd) as total_gas_costs
      FROM swap_events GROUP BY token_id
    ) sw ON sw.token_id = p.token_id
    WHERE p.status = 'open'
  `).get() as any

  res.json({
    totalPositions,
    openPositions,
    rebalances,
    totalPnlUsd: pnl.total_pnl,
    totalFeesUsd: pnl.total_fees,
    totalSwapCostsUsd: pnl.total_swap_costs,
    totalGasCostsUsd: pnl.total_gas_costs,
    netPnlUsd: pnl.total_pnl - pnl.total_swap_costs - pnl.total_gas_costs,
    mode: LIVE ? 'live' : 'paper',
  })
})

// ─── Analytics endpoints ──────────────────────────────────────────────────────

// Liquidity distribution heatmap for a pool
app.get('/api/pools/:address/liquidity', async (req, res) => {
  const pool = WATCHED_POOLS.find(p => p.address.toLowerCase() === req.params['address']!.toLowerCase())
  if (!pool) { res.status(404).json({ error: 'Pool not found' }); return }

  try {
    const state = await rpcClient.fetchPoolState(pool.address, pool.network, pool.token0.decimals, pool.token1.decimals, pool.protocol)
    let buckets = []
    try {
      buckets = await liquidityDistribution.fetch(pool, state.tick)
    } catch (fetchErr) {
      console.warn('[liquidity] fetch failed, using synthetic:', String(fetchErr))
      buckets = liquidityDistribution.syntheticBuckets(state.tick, 10, pool)
    }
    res.json({ currentTick: state.tick, currentPrice: state.token0Price, buckets })
  } catch (err) {
    console.warn('[liquidity] RPC failed, returning empty:', String(err))
    res.json({ currentTick: 0, currentPrice: 0, buckets: [] })
  }
})

// Volatility regime + ADX
app.get('/api/pools/:address/regime', (req, res) => {
  try {
    const regime = detectVolatilityRegime(req.params['address']!)
    res.json(regime)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Historical in-range time for a given price range
app.get('/api/pools/:address/inrange', (req, res) => {
  try {
    const pool = WATCHED_POOLS.find(p => p.address.toLowerCase() === req.params['address']!.toLowerCase())
    if (!pool) { res.status(404).json({ error: 'Pool not found' }); return }
    const priceLower = parseFloat(req.query['priceLower'] as string || '0')
    const priceUpper = parseFloat(req.query['priceUpper'] as string || '0')
    if (!priceLower || !priceUpper) { res.status(400).json({ error: 'priceLower and priceUpper required' }); return }
    const stats = calcInRangeTime(req.params['address']!, priceLower, priceUpper)
    res.json(stats)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Gas-adjusted rebalance decision for open position
app.get('/api/positions/:tokenId/rebalance-decision', async (req, res) => {
  try {
    const tokenId = req.params['tokenId']!
    const cached = rebalanceDecisionCache.get(tokenId)
    if (cached && Date.now() - cached.ts < REBALANCE_DECISION_CACHE_TTL) {
      res.json(cached.data)
      return
    }

    const row = db.prepare(`SELECT * FROM positions WHERE token_id = ?`).get(tokenId) as any
    if (!row) { res.status(404).json({ error: 'Not found' }); return }

    const pool = WATCHED_POOLS.find(p => p.address === row.pool_address)
    if (!pool) { res.status(404).json({ error: 'Pool not found' }); return }

    const state = await rpcClient.fetchPoolState(pool.address, pool.network, pool.token0.decimals, pool.token1.decimals, pool.protocol)
    const market = await geckoTerminalClient.fetchPool(pool.address, pool.network, pool.feeTier)
    const inRange = state.tick >= row.tick_lower && state.tick < row.tick_upper

    const decision = gasAdjustedRebalance(
      pool.address,
      row.entry_price_usd,
      inRange,
      0.30,
      market?.tvlUsd ?? 0,
    )

    const regime = detectVolatilityRegime(pool.address)
    const inRangeStats = calcInRangeTime(
      pool.address,
      Math.pow(1.0001, row.tick_lower) * Math.pow(10, pool.token0.decimals - pool.token1.decimals),
      Math.pow(1.0001, row.tick_upper) * Math.pow(10, pool.token0.decimals - pool.token1.decimals),
    )

    const result = { decision, regime, inRangeStats }
    rebalanceDecisionCache.set(tokenId, { data: result, ts: Date.now() })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ─── Manual controls ─────────────────────────────────────────────────────────

app.post('/api/paper/open', async (req, res) => {
  try {
    const { poolAddress, capitalUsd } = req.body as { poolAddress: string; capitalUsd: number }
    const tokenId = await paperEngine.openPosition(poolAddress, capitalUsd ?? 1000)
    res.json({ success: true, tokenId })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.post('/api/paper/monitor', async (_req, res) => {
  try {
    await paperEngine.monitorPositions()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})
