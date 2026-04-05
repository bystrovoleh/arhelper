import { db, logEvent } from './db'
import { rpcClient } from '../src/data-layer/rpc-client'
import { geckoTerminalClient } from '../src/data-layer/geckoterminal-client'
import { apyCalculator } from '../src/analytics/apy-calculator'
import { rebalanceTrigger } from '../src/strategy/rebalance-trigger'
import { rangeCalculator } from '../src/strategy/range-calculator'
import { poolRanker } from '../src/analytics/pool-ranker'
import { calcLiquidity, calcFeesFromGrowth, feesToUsd } from '../src/analytics/fee-math'
import { WATCHED_POOLS, STRATEGY } from '../src/config'
import type { Position, PoolState } from '../src/types'

// ─── Paper Trading Engine ─────────────────────────────────────────────────────
// Simulates LP positions on real on-chain data without sending transactions.
// All state is persisted in SQLite.

export class PaperEngine {
  private monitorTimer: NodeJS.Timeout | null = null
  private rankTimer: NodeJS.Timeout | null = null

  start() {
    console.log('[Paper] Engine starting…')
    this.rankAndMaybeOpen()
    this.monitorTimer = setInterval(() => this.monitorPositions(), 60_000)
    this.rankTimer = setInterval(() => this.rankAndMaybeOpen(), 30 * 60_000)
  }

  stop() {
    if (this.monitorTimer) clearInterval(this.monitorTimer)
    if (this.rankTimer) clearInterval(this.rankTimer)
  }

  // ── Open a simulated position ──────────────────────────────────────────────

  async openPosition(poolAddress: string, capitalUsd: number): Promise<string> {
    const pool = WATCHED_POOLS.find(p => p.address === poolAddress)
    if (!pool) throw new Error(`Pool not found: ${poolAddress}`)

    const state = await rpcClient.fetchPoolState(pool.address, pool.network, pool.token0.decimals, pool.token1.decimals, pool.protocol)
    const currentPrice = state.token0Price

    const ohlcv = await geckoTerminalClient.fetchOhlcv(pool.address, pool.network, 'hour', 24)
    const range = rangeCalculator.buildOptimalRange(currentPrice, pool, ohlcv)

    // Split capital 50/50 between token0 and token1
    const token0Amount = (capitalUsd / 2) / currentPrice
    const token1Amount = capitalUsd / 2

    // Calculate real liquidity units from capital and price range
    const decimalAdj = Math.pow(10, pool.token0.decimals - pool.token1.decimals)
    const priceLower = Math.pow(1.0001, range.tickLower) * decimalAdj
    const priceUpper = Math.pow(1.0001, range.tickUpper) * decimalAdj
    const liquidity = calcLiquidity(capitalUsd, currentPrice, priceLower, priceUpper, pool.token0.decimals, pool.token1.decimals)

    const tokenId = `paper-${Date.now()}`

    db.prepare(`
      INSERT INTO positions
        (token_id, pool_address, network, protocol, token0_symbol, token1_symbol,
         tick_lower, tick_upper, liquidity, token0_amount, token1_amount,
         entry_price, entry_price_usd, opened_at, is_paper, status,
         fee_growth_global0_entry, fee_growth_global1_entry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', ?, ?)
    `).run(
      tokenId, pool.address, pool.network, pool.protocol,
      pool.token0.symbol, pool.token1.symbol,
      range.tickLower, range.tickUpper, liquidity.toString(),
      token0Amount, token1Amount,
      currentPrice, capitalUsd,
      Date.now(),
      state.feeGrowthGlobal0X128.toString(),
      state.feeGrowthGlobal1X128.toString(),
    )

    logEvent('POSITION_OPENED', `Paper position opened: ${pool.token0.symbol}/${pool.token1.symbol} @ $${currentPrice.toFixed(2)}, range ${range.reason}`, {
      poolAddress, tokenId, data: { range, capitalUsd, currentPrice }
    })

    console.log(`[Paper] Opened position ${tokenId} — ${range.reason}`)
    return tokenId
  }

  // ── Monitor all open positions ─────────────────────────────────────────────

  async monitorPositions() {
    const openRows = db.prepare(`SELECT * FROM positions WHERE status = 'open'`).all() as any[]
    if (openRows.length === 0) return

    for (const row of openRows) {
      try {
        const pool = WATCHED_POOLS.find(p => p.address === row.pool_address)
        if (!pool) continue

        const state = await rpcClient.fetchPoolState(pool.address, pool.network, pool.token0.decimals, pool.token1.decimals, pool.protocol)
        const market = await geckoTerminalClient.fetchPool(pool.address, pool.network, pool.feeTier)

        const currentPrice = state.token0Price
        const inRange = state.tick >= row.tick_lower && state.tick < row.tick_upper

        // ── Real fee accrual via feeGrowthGlobal delta ───────────────────────
        const feesUsd = inRange ? this.calcRealFees(row, state) : (
          // Out of range: no new fees, keep last recorded value
          (db.prepare(`SELECT COALESCE(MAX(fees_usd), 0) as total FROM position_snapshots WHERE token_id = ?`).get(row.token_id) as any).total
        )

        // ── IL calculation ───────────────────────────────────────────────────
        const _decAdj = pool ? Math.pow(10, pool.token0.decimals - pool.token1.decimals) : 1e12
        const _priceLower = Math.pow(1.0001, row.tick_lower) * _decAdj
        const _priceUpper = Math.pow(1.0001, row.tick_upper) * _decAdj
        const ilPct = apyCalculator.calculateImpermanentLoss(row.entry_price, currentPrice, _priceLower, _priceUpper)

        // ── P&L ──────────────────────────────────────────────────────────────
        // Current value of tokens at current price
        const currentToken0ValueUsd = row.token0_amount * currentPrice
        const currentToken1ValueUsd = row.token1_amount
        const currentValueUsd = currentToken0ValueUsd + currentToken1ValueUsd + feesUsd
        const pnlUsd = currentValueUsd - row.entry_price_usd

        // ── Save snapshot ────────────────────────────────────────────────────
        db.prepare(`
          INSERT INTO position_snapshots
            (token_id, recorded_at, current_price, token0_amount, token1_amount,
             uncollected_fees0, uncollected_fees1, fees_usd, il_pct, pnl_usd, in_range)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.token_id, Date.now(), currentPrice,
          row.token0_amount, row.token1_amount,
          feesUsd / 2 / currentPrice, feesUsd / 2,
          feesUsd, ilPct, pnlUsd, inRange ? 1 : 0
        )

        // ── Save pool snapshot ───────────────────────────────────────────────
        if (market) {
          const range = rangeCalculator.buildOptimalRange(currentPrice, pool, [])
          const concentratedApy = apyCalculator.estimateConcentratedApy(
            market.apyBase, range.priceLower, range.priceUpper, currentPrice
          )
          db.prepare(`
            INSERT INTO pool_snapshots
              (recorded_at, pool_address, network, current_price, tick, liquidity,
               volume_usd_24h, tvl_usd, apy_base, estimated_concentrated_apy)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            Date.now(), pool.address, pool.network, currentPrice, state.tick,
            state.liquidity.toString(), market.volumeUsd24h, market.tvlUsd,
            market.apyBase, concentratedApy
          )
        }

        // ── Rebalance check ──────────────────────────────────────────────────
        const MIN_POSITION_AGE_MS = 4 * 3_600_000   // must hold at least 4h before rebalancing
        const MIN_OUT_OF_RANGE_MS = 2 * 3_600_000   // must be out of range for 2h+ consecutively

        const positionAgeMs = Date.now() - row.opened_at
        if (positionAgeMs < MIN_POSITION_AGE_MS) {
          logEvent('INFO',
            `[${row.token_id}] price=$${currentPrice.toFixed(2)} pnl=${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} il=${ilPct.toFixed(2)}% ${inRange ? 'IN_RANGE' : 'OUT_OF_RANGE'} (cooldown: ${((MIN_POSITION_AGE_MS - positionAgeMs) / 3_600_000).toFixed(1)}h left)`,
            { poolAddress: pool.address, tokenId: row.token_id }
          )
          continue
        }

        // Check how long we've been out of range consecutively
        if (!inRange) {
          // Find the most recent snapshot where we WERE in range — out-of-range streak starts after that
          const lastInRange = db.prepare(`
            SELECT recorded_at FROM position_snapshots
            WHERE token_id = ? AND in_range = 1
            ORDER BY recorded_at DESC
            LIMIT 1
          `).get(row.token_id) as any
          const outOfRangeMs = lastInRange?.recorded_at
            ? Date.now() - lastInRange.recorded_at
            : Date.now() - row.opened_at

          if (outOfRangeMs < MIN_OUT_OF_RANGE_MS) {
            logEvent('INFO',
              `[${row.token_id}] OUT_OF_RANGE for ${(outOfRangeMs / 60_000).toFixed(0)}min — waiting for ${(MIN_OUT_OF_RANGE_MS / 3_600_000).toFixed(0)}h before rebalance`,
              { poolAddress: pool.address, tokenId: row.token_id }
            )
            continue
          }
        }

        const position: Position = {
          tokenId: BigInt(0),
          poolAddress: row.pool_address,
          tickLower: row.tick_lower,
          tickUpper: row.tick_upper,
          liquidity: BigInt(0),
          token0Amount: row.token0_amount,
          token1Amount: row.token1_amount,
          uncollectedFees0: feesUsd / 2 / currentPrice,
          uncollectedFees1: feesUsd / 2,
          inRange,
          openedAt: row.opened_at,
        }

        const signal = rebalanceTrigger.evaluate(position, state, 0.3, market?.tvlUsd ?? 0)

        if (signal.shouldRebalance && signal.urgency === 'high') {
          logEvent('SIGNAL', `Rebalance signal: ${signal.reason}`, {
            poolAddress: pool.address, tokenId: row.token_id,
            data: { signal, pnlUsd: pnlUsd.toFixed(2), ilPct: ilPct.toFixed(2) }
          })
          await this.paperRebalance(row, pool, state)
        } else {
          const ageHours = (Date.now() - row.opened_at) / 3_600_000
          const feesPerHour = ageHours > 0 ? feesUsd / ageHours : 0
          const feesPerDay = feesPerHour * 24
          const rangeStatus = inRange ? '✓ IN RANGE' : '✗ OUT OF RANGE'
          logEvent('INFO',
            `${rangeStatus} | price $${currentPrice.toFixed(2)} | fees +$${feesUsd.toFixed(4)} ($${feesPerDay.toFixed(4)}/day) | pnl ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(4)} | il ${ilPct.toFixed(3)}% | age ${ageHours.toFixed(1)}h`,
            { poolAddress: pool.address, tokenId: row.token_id }
          )
        }
      } catch (err) {
        logEvent('ERROR', `Monitor error for ${row.token_id}: ${String(err)}`, { tokenId: row.token_id })
      }
    }
  }

  // ── Simulate a rebalance ───────────────────────────────────────────────────

  private async paperRebalance(row: any, pool: any, state: PoolState) {
    const currentPrice = state.token0Price
    const ohlcv = await geckoTerminalClient.fetchOhlcv(pool.address, pool.network, 'hour', 24)
    const newRange = rangeCalculator.buildOptimalRange(currentPrice, pool, ohlcv)

    // Close old
    db.prepare(`UPDATE positions SET status = 'rebalanced', closed_at = ? WHERE token_id = ?`)
      .run(Date.now(), row.token_id)

    // Open new with same capital + real liquidity + new feeGrowthGlobal baseline
    const newTokenId = `paper-${Date.now()}`
    const decimalAdj = Math.pow(10, pool.token0.decimals - pool.token1.decimals)
    const newPriceLower = Math.pow(1.0001, newRange.tickLower) * decimalAdj
    const newPriceUpper = Math.pow(1.0001, newRange.tickUpper) * decimalAdj
    const newLiquidity = calcLiquidity(row.entry_price_usd, currentPrice, newPriceLower, newPriceUpper, pool.token0.decimals, pool.token1.decimals)

    db.prepare(`
      INSERT INTO positions
        (token_id, pool_address, network, protocol, token0_symbol, token1_symbol,
         tick_lower, tick_upper, liquidity, token0_amount, token1_amount,
         entry_price, entry_price_usd, opened_at, is_paper, status,
         fee_growth_global0_entry, fee_growth_global1_entry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', ?, ?)
    `).run(
      newTokenId, pool.address, pool.network, pool.protocol,
      pool.token0.symbol, pool.token1.symbol,
      newRange.tickLower, newRange.tickUpper, newLiquidity.toString(),
      row.token0_amount, row.token1_amount,
      currentPrice, row.entry_price_usd,
      Date.now(),
      state.feeGrowthGlobal0X128.toString(),
      state.feeGrowthGlobal1X128.toString(),
    )

    logEvent('REBALANCE',
      `Paper rebalance: ${row.token_id} → ${newTokenId}. New range: ${newRange.reason}`,
      { poolAddress: pool.address, tokenId: newTokenId, data: { newRange, currentPrice } }
    )

    console.log(`[Paper] Rebalanced → ${newTokenId}`)
  }

  // ── Rank pools and open position if none open ──────────────────────────────

  private async rankAndMaybeOpen() {
    try {
      const currentPrices = new Map<string, number>()
      for (const pool of WATCHED_POOLS) {
        const state = await rpcClient.fetchPoolState(pool.address, pool.network, pool.token0.decimals, pool.token1.decimals, pool.protocol)
        currentPrices.set(pool.address, state.token0Price)
      }

      const ranked = await poolRanker.rankPools(currentPrices)
      poolRanker.printSummary(ranked)

      // Log ranking
      logEvent('INFO', `Pool ranking updated. Top: ${ranked[0]?.pool.token0.symbol}/${ranked[0]?.pool.token1.symbol} APY=${ranked[0]?.estimatedConcentratedApy.toFixed(1)}%`, {
        data: ranked.map(r => ({ pool: r.pool.address, apy: r.estimatedConcentratedApy.toFixed(1), score: r.score.toFixed(2) }))
      })

      // Auto-open paper position on best pool if none open
      const openCount = (db.prepare(`SELECT COUNT(*) as c FROM positions WHERE status = 'open'`).get() as any).c
      if (openCount === 0 && ranked.length > 0) {
        const best = ranked[0]!
        await this.openPosition(best.pool.address, 1000) // simulate $1000
      }
    } catch (err) {
      logEvent('ERROR', `Rank loop error: ${String(err)}`)
      console.error('[Paper] Rank error:', err)
    }
  }

  // ── Fee simulation ─────────────────────────────────────────────────────────
  // Estimate fees accrued since last snapshot (or position open).

  private calcRealFees(row: any, state: PoolState): number {
    // ── Real on-chain fee calculation ─────────────────────────────────────────
    // Uses feeGrowthGlobal delta × liquidity / 2^128
    // This is the exact same formula Uniswap uses internally.

    if (!row.fee_growth_global0_entry || !row.fee_growth_global1_entry) return 0
    if (!row.liquidity || row.liquidity === '0') return 0

    try {
      const liquidity = BigInt(row.liquidity)
      const fg0Entry = BigInt(row.fee_growth_global0_entry)
      const fg1Entry = BigInt(row.fee_growth_global1_entry)
      const fg0Now = state.feeGrowthGlobal0X128
      const fg1Now = state.feeGrowthGlobal1X128

      const fees0Raw = calcFeesFromGrowth(fg0Entry, fg0Now, liquidity)
      const fees1Raw = calcFeesFromGrowth(fg1Entry, fg1Now, liquidity)

      const pool = WATCHED_POOLS.find(p => p.address === row.pool_address)
      const t0dec = pool?.token0.decimals ?? 18
      const t1dec = pool?.token1.decimals ?? 6

      const feesUsd = feesToUsd(fees0Raw, fees1Raw, t0dec, t1dec, state.token0Price)

      // Never go backwards (snapshots can be out of order)
      const existing = db.prepare(
        `SELECT COALESCE(MAX(fees_usd), 0) as total FROM position_snapshots WHERE token_id = ?`
      ).get(row.token_id) as any

      return Math.max(feesUsd, existing.total as number)
    } catch (err) {
      console.warn('[fees] real fee calc failed:', err)
      return 0
    }
  }
}

export const paperEngine = new PaperEngine()
