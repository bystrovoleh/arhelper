import { Contract } from 'ethers'
import { db, logEvent } from './db'
import { rpcClient } from '../src/data-layer/rpc-client'
import { geckoTerminalClient } from '../src/data-layer/geckoterminal-client'
import { theGraphClient } from '../src/data-layer/thegraph-client'
import { apyCalculator } from '../src/analytics/apy-calculator'
import { rebalanceTrigger } from '../src/strategy/rebalance-trigger'
import { rangeCalculator } from '../src/strategy/range-calculator'
import { poolRanker } from '../src/analytics/pool-ranker'
import { executor } from '../src/executor'
import { calcLiquidity, calcFeesFromGrowth, feesToUsd } from '../src/analytics/fee-math'
import { WATCHED_POOLS, WALLET } from '../src/config'
import type { Position, PoolState } from '../src/types'

// ─── Live Trading Engine ───────────────────────────────────────────────────────
// Executes REAL on-chain transactions on Arbitrum.
// ⚠️  REAL MONEY — every openPosition/rebalance sends transactions.

const MAX_CAPITAL_USD = (() => {
  const val = Number(process.env['MAX_CAPITAL_USD'] ?? 100)
  if (isNaN(val) || val <= 0) throw new Error(`Invalid MAX_CAPITAL_USD: "${process.env['MAX_CAPITAL_USD']}"`)
  return val
})()
const DRY_RUN = process.env['DRY_RUN'] === 'true'

export class LiveEngine {
  private monitorTimer: NodeJS.Timeout | null = null
  private rankTimer: NodeJS.Timeout | null = null

  start() {
    console.log(`[Live] Engine starting… DRY_RUN=${DRY_RUN} MAX_CAPITAL=$${MAX_CAPITAL_USD}`)
    if (DRY_RUN) console.log('[Live] ⚠️  DRY RUN MODE — no real transactions will be sent')
    logEvent('INFO', `Live engine started. DRY_RUN=${DRY_RUN} MAX_CAPITAL=$${MAX_CAPITAL_USD}`)
    this.rankAndMaybeOpen()
    this.monitorTimer = setInterval(() => this.monitorPositions(), 60_000)
    this.rankTimer = setInterval(() => this.rankAndMaybeOpen(), 30 * 60_000)
  }

  stop() {
    if (this.monitorTimer) clearInterval(this.monitorTimer)
    if (this.rankTimer) clearInterval(this.rankTimer)
    console.log('[Live] Engine stopped.')
  }

  // ── Open a real on-chain position ──────────────────────────────────────────

  async openPosition(poolAddress: string, capitalUsd: number): Promise<string> {
    if (capitalUsd > MAX_CAPITAL_USD) {
      throw new Error(`Capital $${capitalUsd} exceeds MAX_CAPITAL_USD $${MAX_CAPITAL_USD}`)
    }

    const pool = WATCHED_POOLS.find(p => p.address === poolAddress)
    if (!pool) throw new Error(`Pool not found: ${poolAddress}`)

    const state = await rpcClient.fetchPoolState(
      pool.address, pool.network, pool.token0.decimals, pool.token1.decimals, pool.protocol
    )
    const currentPrice = state.token0Price

    const candles = await this.fetchCandles(pool.address, pool.network)
    const range = rangeCalculator.buildAgentRange(currentPrice, pool, candles)
      ?? rangeCalculator.buildSymmetricRange(currentPrice, pool, 0.15)

    // Read real wallet balances — use them directly, don't assume 50/50 split
    const provider = rpcClient.getProvider(pool.network)
    const ERC20_ABI = ['function balanceOf(address) external view returns (uint256)']
    const [bal0Raw, bal1Raw]: [bigint, bigint] = await Promise.all([
      new Contract(pool.token0.address, ERC20_ABI, provider).balanceOf(WALLET.address).then((b: bigint) => BigInt(b.toString())),
      new Contract(pool.token1.address, ERC20_ABI, provider).balanceOf(WALLET.address).then((b: bigint) => BigInt(b.toString())),
    ])
    const token0Amount = Number(bal0Raw) / Math.pow(10, pool.token0.decimals)
    const token1Amount = Number(bal1Raw) / Math.pow(10, pool.token1.decimals)
    const actualCapitalUsd = token0Amount * currentPrice + token1Amount
    console.log(`[Live]   Wallet: ${token0Amount.toFixed(6)} ${pool.token0.symbol} + ${token1Amount.toFixed(4)} ${pool.token1.symbol} = $${actualCapitalUsd.toFixed(2)}`)

    // Cap to MAX_CAPITAL_USD — use proportional fraction if wallet has more
    const fraction = Math.min(1, capitalUsd / actualCapitalUsd)
    const amount0Raw = BigInt(Math.floor(Number(bal0Raw) * fraction))
    const amount1Raw = BigInt(Math.floor(Number(bal1Raw) * fraction))

    console.log(`[Live] Opening position: ${pool.token0.symbol}/${pool.token1.symbol}`)
    console.log(`[Live]   Price: $${currentPrice.toFixed(2)}`)
    console.log(`[Live]   Range: ${range.reason}`)
    console.log(`[Live]   Capital: $${(actualCapitalUsd * fraction).toFixed(2)} (${(token0Amount * fraction).toFixed(6)} ${pool.token0.symbol} + ${(token1Amount * fraction).toFixed(4)} ${pool.token1.symbol})`)

    if (DRY_RUN) {
      console.log('[Live] DRY RUN — skipping real transaction')
      const tokenId = `live-dry-${Date.now()}`
      this.savePosition(tokenId, pool, range, state, token0Amount, token1Amount, currentPrice, capitalUsd, false)
      return tokenId
    }

    // ⚠️  REAL TRANSACTION
    const { tokenId: onChainTokenId, txHash, swapMetas, mintGasUsd } = await executor.mintPosition(
      pool, range, amount0Raw, amount1Raw
    )

    const tokenId = onChainTokenId.toString()

    // Record each swap event for P&L tracking
    for (const meta of swapMetas) {
      this.recordSwapEvent(tokenId, meta)
    }

    // Record mint gas cost as a swap event with 0 impact (just gas)
    if (mintGasUsd > 0) {
      db.prepare(`
        INSERT INTO swap_events (token_id, tx_hash, token_in, amount_in_usd, token_out, amount_out_usd, price_impact_pct, gas_usd, occurred_at)
        VALUES (?, ?, 'GAS', 0, 'GAS', 0, 0, ?, ?)
      `).run(tokenId, txHash, mintGasUsd, Date.now())
    }

    // Read actual on-chain position value (post-swap, post-mint) as entry capital
    let realCapitalUsd = capitalUsd
    const onChain = await rpcClient.fetchPositionAmounts(
      onChainTokenId, pool.network, pool.address, pool.token0.decimals, pool.token1.decimals
    )
    if (onChain && (onChain.amount0 > 0 || onChain.amount1 > 0)) {
      realCapitalUsd = onChain.amount0 * currentPrice + onChain.amount1
      console.log(`[Live] Real capital from chain: $${realCapitalUsd.toFixed(2)} (desired: $${capitalUsd})`)
    } else {
      console.log(`[Live] fetchPositionAmounts returned 0, using wallet total as entry: $${realCapitalUsd.toFixed(2)}`)
    }

    this.savePosition(tokenId, pool, range, state, onChain?.amount0 ?? token0Amount, onChain?.amount1 ?? token1Amount, currentPrice, realCapitalUsd, false)

    const totalSwapCostOpen = swapMetas.reduce((sum, m) => sum + (m.amountInUsd - m.amountOutUsd), 0)
    logEvent('POSITION_OPENED',
      `LIVE position opened: ${pool.token0.symbol}/${pool.token1.symbol} @ $${currentPrice.toFixed(2)} | tx: ${txHash}${swapMetas.length > 0 ? ` | swap cost $${totalSwapCostOpen.toFixed(4)} (${swapMetas.length} swaps)` : ''}`,
      { poolAddress, tokenId, data: { range, capitalUsd, currentPrice, txHash, swapMetas, mintGasUsd } }
    )

    console.log(`[Live] ✅ Position opened. TokenId: ${tokenId}, tx: ${txHash}`)
    return tokenId
  }

  // ── Monitor all open live positions ───────────────────────────────────────

  async monitorPositions() {
    const openRows = db.prepare(
      `SELECT * FROM positions WHERE status = 'open' AND is_paper = 0`
    ).all() as any[]
    if (openRows.length === 0) return

    for (const row of openRows) {
      try {
        const pool = WATCHED_POOLS.find(p => p.address === row.pool_address)
        if (!pool) continue

        const state = await rpcClient.fetchPoolState(
          pool.address, pool.network, pool.token0.decimals, pool.token1.decimals, pool.protocol
        )
        const market = await this.fetchMarket(pool)
        const currentPrice = state.token0Price
        const inRange = state.tick >= row.tick_lower && state.tick < row.tick_upper

        // ── Real token amounts from chain (for live positions) ─────────────────
        const tokenId = /^\d+$/.test(row.token_id) ? BigInt(row.token_id) : null
        const onChain = tokenId
          ? await rpcClient.fetchPositionAmounts(tokenId, pool.network, pool.address, pool.token0.decimals, pool.token1.decimals)
          : null
        const token0Amount = onChain?.amount0 ?? row.token0_amount
        const token1Amount = onChain?.amount1 ?? row.token1_amount

        // ── Fee accrual ────────────────────────────────────────────────────────
        const feesUsd = inRange ? this.calcRealFees(row, state) : (
          (db.prepare(`SELECT COALESCE(MAX(fees_usd), 0) as total FROM position_snapshots WHERE token_id = ?`).get(row.token_id) as any).total
        )

        // ── IL ─────────────────────────────────────────────────────────────────
        const decAdj = Math.pow(10, pool.token0.decimals - pool.token1.decimals)
        const priceLower = Math.pow(1.0001, row.tick_lower) * decAdj
        const priceUpper = Math.pow(1.0001, row.tick_upper) * decAdj
        const ilPct = apyCalculator.calculateImpermanentLoss(row.entry_price, currentPrice, priceLower, priceUpper)

        // ── P&L: use real on-chain amounts ────────────────────────────────────
        const currentValueUsd = token0Amount * currentPrice + token1Amount + feesUsd
        const pnlUsd = currentValueUsd - row.entry_price_usd

        // ── Snapshot ───────────────────────────────────────────────────────────
        db.prepare(`
          INSERT INTO position_snapshots
            (token_id, recorded_at, current_price, token0_amount, token1_amount,
             uncollected_fees0, uncollected_fees1, fees_usd, il_pct, pnl_usd, in_range)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.token_id, Date.now(), currentPrice,
          token0Amount, token1Amount,
          feesUsd / 2 / currentPrice, feesUsd / 2,
          feesUsd, ilPct, pnlUsd, inRange ? 1 : 0
        )

        // ── Pool snapshot ──────────────────────────────────────────────────────
        if (market) {
          const concentratedApy = apyCalculator.estimateConcentratedApy(
            market.apyBase, priceLower, priceUpper, currentPrice
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

        // ── Rebalance check ────────────────────────────────────────────────────
        const position: Position = {
          tokenId: /^\d+$/.test(row.token_id) ? BigInt(row.token_id) : 0n,
          poolAddress: row.pool_address,
          tickLower: row.tick_lower,
          tickUpper: row.tick_upper,
          liquidity: BigInt(row.liquidity ?? 0),
          token0Amount: row.token0_amount,
          token1Amount: row.token1_amount,
          uncollectedFees0: feesUsd / 2 / currentPrice,
          uncollectedFees1: feesUsd / 2,
          inRange,
          openedAt: row.opened_at,
        }

        const signal = rebalanceTrigger.evaluate(position, state)

        if (signal.shouldRebalance && signal.urgency === 'high') {
          logEvent('SIGNAL', `[LIVE] Rebalance signal: ${signal.reason}`, {
            poolAddress: pool.address, tokenId: row.token_id,
            data: { signal, pnlUsd: pnlUsd.toFixed(2), ilPct: ilPct.toFixed(2) }
          })
          await this.liveRebalance(row, pool, state)
        } else {
          const ageHours = (Date.now() - row.opened_at) / 3_600_000
          const feesPerDay = ageHours > 0 ? (feesUsd / ageHours) * 24 : 0
          const rangeStatus = inRange ? '✓ IN RANGE' : '✗ OUT OF RANGE'
          logEvent('INFO',
            `[LIVE] ${rangeStatus} | price $${currentPrice.toFixed(2)} | fees +$${feesUsd.toFixed(4)} ($${feesPerDay.toFixed(4)}/day) | pnl ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(4)} | il ${ilPct.toFixed(3)}% | age ${ageHours.toFixed(1)}h`,
            { poolAddress: pool.address, tokenId: row.token_id }
          )
        }
      } catch (err) {
        logEvent('ERROR', `[Live] Monitor error for ${row.token_id}: ${String(err)}`, { tokenId: row.token_id })
        console.error('[Live] Monitor error:', err)
      }
    }
  }

  // ── Real on-chain rebalance ────────────────────────────────────────────────

  private async liveRebalance(row: any, pool: any, state: PoolState) {
    const currentPrice = state.token0Price
    const candles = await this.fetchCandles(pool.address, pool.network)
    const newRange = rangeCalculator.buildAgentRange(currentPrice, pool, candles)
      ?? rangeCalculator.buildSymmetricRange(currentPrice, pool, 0.15)

    console.log(`[Live] Rebalancing position ${row.token_id}…`)

    if (DRY_RUN) {
      console.log('[Live] DRY RUN — skipping real rebalance transaction')
      db.prepare(`UPDATE positions SET status = 'rebalanced', closed_at = ? WHERE token_id = ?`)
        .run(Date.now(), row.token_id)
      const newTokenId = `live-dry-${Date.now()}`
      this.savePosition(newTokenId, pool, newRange, state, row.token0_amount, row.token1_amount, currentPrice, row.entry_price_usd, false)
      logEvent('REBALANCE', `[DRY] Rebalance: ${row.token_id} → ${newTokenId}`, { poolAddress: pool.address, tokenId: newTokenId })
      return
    }

    // ⚠️  REAL TRANSACTIONS: close old → open new
    try {
      // Fetch real on-chain amounts before rebalancing (don't trust stale DB values)
      const onChain = await rpcClient.fetchPositionAmounts(
        BigInt(row.token_id), pool.network, pool.address, pool.token0.decimals, pool.token1.decimals
      )
      if (!onChain || onChain.liquidity === 0n) throw new Error(`Cannot fetch on-chain position data for ${row.token_id} (liquidity=${onChain?.liquidity ?? 'null'}) — aborting rebalance`)

      const { newTokenId, closeTxHash, mintTxHash, swapMetas, mintGasUsd } = await executor.rebalance(
        BigInt(row.token_id),
        pool,
        row.tick_lower,
        row.tick_upper,
        onChain.liquidity,
        newRange,
        BigInt(Math.floor(onChain.amount0 * Math.pow(10, pool.token0.decimals))),
        BigInt(Math.floor(onChain.amount1 * Math.pow(10, pool.token1.decimals))),
      )

      // Read real on-chain amounts for new position
      const newOnChain = await rpcClient.fetchPositionAmounts(
        newTokenId, pool.network, pool.address, pool.token0.decimals, pool.token1.decimals
      )
      const newCapitalUsd = newOnChain
        ? newOnChain.amount0 * currentPrice + newOnChain.amount1
        : onChain.amount0 * currentPrice + onChain.amount1

      const newTokenIdStr = newTokenId.toString()

      // Update DB atomically: close old + save new in one transaction
      db.transaction(() => {
        db.prepare(`UPDATE positions SET status = 'rebalanced', closed_at = ? WHERE token_id = ?`)
          .run(Date.now(), row.token_id)
        this.savePosition(newTokenIdStr, pool, newRange, state,
          newOnChain?.amount0 ?? onChain.amount0,
          newOnChain?.amount1 ?? onChain.amount1,
          currentPrice, newCapitalUsd, false
        )
        for (const meta of swapMetas) this.recordSwapEvent(newTokenIdStr, meta)
        if (mintGasUsd > 0) {
          db.prepare(`INSERT INTO swap_events (token_id, tx_hash, token_in, amount_in_usd, token_out, amount_out_usd, price_impact_pct, gas_usd, occurred_at) VALUES (?, ?, 'GAS', 0, 'GAS', 0, 0, ?, ?)`)
            .run(newTokenIdStr, mintTxHash, mintGasUsd, Date.now())
        }
      })()

      const totalSwapCost = swapMetas.reduce((sum, m) => sum + (m.amountInUsd - m.amountOutUsd), 0)
      logEvent('REBALANCE',
        `[LIVE] Rebalance: ${row.token_id} → ${newTokenId} | close: ${closeTxHash} | mint: ${mintTxHash}${swapMetas.length > 0 ? ` | swap cost $${totalSwapCost.toFixed(4)} (${swapMetas.length} swaps)` : ''}`,
        { poolAddress: pool.address, tokenId: newTokenIdStr, data: { newRange, closeTxHash, mintTxHash, swapMetas, mintGasUsd } }
      )

      console.log(`[Live] ✅ Rebalanced → ${newTokenId}`)
    } catch (err) {
      logEvent('ERROR', `[Live] Rebalance FAILED for ${row.token_id}: ${String(err)}`, { tokenId: row.token_id })
      console.error('[Live] Rebalance failed:', err)
      throw err
    }
  }

  // ── Rank pools and open if none open ──────────────────────────────────────

  private async rankAndMaybeOpen() {
    try {
      const currentPrices = new Map<string, number>()
      for (const pool of WATCHED_POOLS) {
        const state = await rpcClient.fetchPoolState(
          pool.address, pool.network, pool.token0.decimals, pool.token1.decimals, pool.protocol
        )
        currentPrices.set(pool.address, state.token0Price)
      }

      const ranked = await poolRanker.rankPools(currentPrices)
      poolRanker.printSummary(ranked)

      logEvent('INFO',
        `[Live] Pool ranking updated. Top: ${ranked[0]?.pool.token0.symbol}/${ranked[0]?.pool.token1.symbol} APY=${ranked[0]?.estimatedConcentratedApy.toFixed(1)}%`,
        { data: ranked.map(r => ({ pool: r.pool.address, apy: r.estimatedConcentratedApy.toFixed(1) })) }
      )

      // Auto-open on best pool if no live position open
      // Check DB first — if open position exists, verify it still has liquidity on-chain
      const openRows = db.prepare(
        `SELECT token_id, pool_address FROM positions WHERE status = 'open' AND is_paper = 0`
      ).all() as any[]

      let hasLivePosition = false
      for (const row of openRows) {
        if (!/^\d+$/.test(row.token_id)) { hasLivePosition = true; break }
        const pool = WATCHED_POOLS.find(p => p.address === row.pool_address)
        if (!pool) { hasLivePosition = true; break }  // unknown pool — assume open, don't touch
        const onChain = await rpcClient.fetchPositionAmounts(
          BigInt(row.token_id), pool.network, pool.address, pool.token0.decimals, pool.token1.decimals
        )
        if (onChain && onChain.liquidity > 0n) { hasLivePosition = true; break }
        // Liquidity is 0 on-chain but DB says open — sync DB
        console.log(`[Live] Position ${row.token_id} has 0 liquidity on-chain, marking closed in DB`)
        db.prepare(`UPDATE positions SET status='closed', closed_at=? WHERE token_id=?`).run(Date.now(), row.token_id)
      }

      if (!hasLivePosition && ranked.length > 0) {
        const best = ranked[0]!
        console.log(`[Live] No open position. Opening on ${best.pool.token0.symbol}/${best.pool.token1.symbol}…`)
        await this.openPosition(best.pool.address, MAX_CAPITAL_USD)
      }
    } catch (err) {
      logEvent('ERROR', `[Live] Rank loop error: ${String(err)}`)
      console.error('[Live] Rank error:', err)
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private savePosition(
    tokenId: string, pool: any, range: any, state: PoolState,
    token0Amount: number, token1Amount: number,
    currentPrice: number, capitalUsd: number,
    isPaper: boolean,
  ) {
    const decimalAdj = Math.pow(10, pool.token0.decimals - pool.token1.decimals)
    const priceLower = Math.pow(1.0001, range.tickLower) * decimalAdj
    const priceUpper = Math.pow(1.0001, range.tickUpper) * decimalAdj
    const liquidity = calcLiquidity(capitalUsd, currentPrice, priceLower, priceUpper, pool.token0.decimals, pool.token1.decimals)

    db.prepare(`
      INSERT INTO positions
        (token_id, pool_address, network, protocol, token0_symbol, token1_symbol,
         tick_lower, tick_upper, liquidity, token0_amount, token1_amount,
         entry_price, entry_price_usd, opened_at, is_paper, status,
         fee_growth_global0_entry, fee_growth_global1_entry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      tokenId, pool.address, pool.network, pool.protocol,
      pool.token0.symbol, pool.token1.symbol,
      range.tickLower, range.tickUpper, liquidity.toString(),
      token0Amount, token1Amount,
      currentPrice, capitalUsd,
      Date.now(),
      isPaper ? 1 : 0,
      state.feeGrowthGlobal0X128.toString(),
      state.feeGrowthGlobal1X128.toString(),
    )
  }

  private calcRealFees(row: any, state: PoolState): number {
    if (!row.fee_growth_global0_entry || !row.fee_growth_global1_entry) return 0
    if (!row.liquidity || row.liquidity === '0') return 0
    try {
      const liquidity = BigInt(row.liquidity)
      const fees0Raw = calcFeesFromGrowth(BigInt(row.fee_growth_global0_entry), state.feeGrowthGlobal0X128, liquidity)
      const fees1Raw = calcFeesFromGrowth(BigInt(row.fee_growth_global1_entry), state.feeGrowthGlobal1X128, liquidity)
      const pool = WATCHED_POOLS.find(p => p.address === row.pool_address)
      const feesUsd = feesToUsd(fees0Raw, fees1Raw, pool?.token0.decimals ?? 18, pool?.token1.decimals ?? 6, state.token0Price)
      const existing = (db.prepare(
        `SELECT COALESCE(MAX(fees_usd), 0) as total FROM position_snapshots WHERE token_id = ?`
      ).get(row.token_id) as any).total
      return Math.max(feesUsd, existing as number)
    } catch { return 0 }
  }

  private marketCache: Map<string, { data: any; ts: number }> = new Map()
  private readonly MARKET_CACHE_TTL = 5 * 60_000

  private async fetchMarket(pool: any) {
    const cached = this.marketCache.get(pool.address)
    if (cached && Date.now() - cached.ts < this.MARKET_CACHE_TTL) return cached.data
    try {
      const data = await geckoTerminalClient.fetchPool(pool.address, pool.network, pool.feeTier)
      if (data) this.marketCache.set(pool.address, { data, ts: Date.now() })
      return data
    } catch { return null }
  }

  private candleCache: { candles: any[]; ts: number } | null = null
  private readonly CANDLE_CACHE_TTL = 4 * 3_600_000

  private async fetchCandles(poolAddress: string, network: string) {
    if (this.candleCache && Date.now() - this.candleCache.ts < this.CANDLE_CACHE_TTL) {
      return this.candleCache.candles
    }
    try {
      const candles = await theGraphClient.fetchWethUsdcCandles(2000)
      if (candles.length >= 48) {
        this.candleCache = { candles, ts: Date.now() }
        return candles
      }
    } catch { /* fallback */ }
    const candles = await geckoTerminalClient.fetchOhlcv(poolAddress, network, 'hour', 168)
    this.candleCache = { candles, ts: Date.now() }
    return candles
  }

  private recordSwapEvent(tokenId: string, meta: import('../src/executor').SwapMeta) {
    db.prepare(`
      INSERT INTO swap_events
        (token_id, tx_hash, token_in, amount_in_usd, token_out, amount_out_usd, price_impact_pct, gas_usd, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tokenId, meta.txHash, meta.tokenIn, meta.amountInUsd, meta.tokenOut, meta.amountOutUsd, meta.priceImpactPct, meta.gasUsd, Date.now())
    console.log(`[Live] Swap recorded: ${meta.tokenIn}→${meta.tokenOut} cost=$${(meta.amountInUsd - meta.amountOutUsd).toFixed(4)} gas=$${meta.gasUsd.toFixed(5)}`)
  }
}

export const liveEngine = new LiveEngine()
