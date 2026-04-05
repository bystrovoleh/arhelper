import axios from 'axios'
import dotenv from 'dotenv'
import type { OhlcvCandle } from '../backtest/types'

dotenv.config()

// ─── The Graph Client ─────────────────────────────────────────────────────────
// Fetches historical OHLCV data from Uniswap v3 Base subgraph.
// Uniswap v3 is a close proxy for Aerodrome Slipstream prices (same pool, arb keeps them in sync).
//
// Subgraph: Uniswap v3 Base
// ID: FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS
// Entity: poolHourData — hourly OHLCV per pool

// Uniswap v3 Base subgraph (has poolHourData with OHLCV)
const SUBGRAPH_ID = '43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG'
const GATEWAY = 'https://gateway.thegraph.com/api'

// Uniswap v3 WETH/USDC 0.05% pool on Base
// token0=USDC, token1=WETH → prices are USDC/WETH, must invert to get WETH/USDC
const UNISWAP_WETH_USDC_BASE = '0xd0b53d9277642d899df5c87a3966a349a798f224'

export class TheGraphClient {

  /**
   * Fetch hourly candles for a pool from The Graph.
   * Returns candles sorted oldest → newest.
   * @param poolAddress  pool address (lowercase)
   * @param limit        max candles to fetch per request (max 1000)
   * @param beforeTs     unix seconds — fetch candles before this timestamp (for pagination)
   */
  async fetchHourlyCandles(
    poolAddress: string,
    limit = 1000,
    beforeTs?: number,
  ): Promise<OhlcvCandle[]> {
    const whereClause = beforeTs
      ? `where: { pool: "${poolAddress.toLowerCase()}", periodStartUnix_lt: ${beforeTs} }`
      : `where: { pool: "${poolAddress.toLowerCase()}" }`

    const query = `{
      poolHourDatas(
        first: ${limit}
        orderBy: periodStartUnix
        orderDirection: desc
        ${whereClause}
      ) {
        periodStartUnix
        open
        high
        low
        close
        volumeUSD
      }
    }`

    const key = process.env['THEGRAPH_API_KEY'] ?? ''
    if (!key) throw new Error('THEGRAPH_API_KEY not set')
    const url = `${GATEWAY}/${key}/subgraphs/id/${SUBGRAPH_ID}`
    const { data } = await axios.post(url, { query }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    })

    if (data.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`)
    }

    const rows = data.data?.poolHourDatas as Array<{
      periodStartUnix: number
      open: string
      high: string
      low: string
      close: string
      volumeUSD: string
    }>

    if (!rows || rows.length === 0) return []

    // Convert to OhlcvCandle [timestamp_ms, open, high, low, close, volume_usd]
    // poolHourData prices are USDC/WETH (token0/token1), invert to get WETH price in USD
    const candles: OhlcvCandle[] = rows
      .filter(r => parseFloat(r.close) > 0)
      .map(r => {
        const open  = 1 / parseFloat(r.open)
        const close = 1 / parseFloat(r.close)
        // high price = low raw value, low price = high raw value (inverted)
        const high  = 1 / parseFloat(r.low)
        const low   = 1 / parseFloat(r.high)
        return [r.periodStartUnix * 1000, open, high, low, close, parseFloat(r.volumeUSD)]
      })

    // Sort oldest → newest
    candles.sort((a, b) => a[0] - b[0])
    return candles
  }

  /**
   * Fetch up to maxCandles hourly candles with pagination.
   * The Graph limits to 1000 per query, so we paginate backwards.
   */
  async fetchAllHourlyCandles(
    poolAddress: string,
    maxCandles = 5000,
  ): Promise<OhlcvCandle[]> {
    const all: OhlcvCandle[] = []
    let beforeTs: number | undefined = undefined
    const BATCH = 1000

    console.log(`[TheGraph] Fetching up to ${maxCandles} hourly candles...`)

    while (all.length < maxCandles) {
      const batch = await this.fetchHourlyCandles(poolAddress, BATCH, beforeTs)
      if (batch.length === 0) break

      all.unshift(...batch)  // prepend older candles
      beforeTs = Math.floor(batch[0]![0] / 1000)  // oldest ts in seconds

      console.log(`  Fetched ${batch.length} candles, total: ${all.length}`)

      if (batch.length < BATCH) break  // no more data
      if (all.length >= maxCandles) break

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 300))
    }

    // Deduplicate and sort
    const seen = new Set<number>()
    const deduped = all.filter(c => {
      if (seen.has(c[0])) return false
      seen.add(c[0])
      return true
    })
    deduped.sort((a, b) => a[0] - b[0])

    console.log(`[TheGraph] Total: ${deduped.length} candles (~${(deduped.length / 24).toFixed(0)} days)`)
    return deduped
  }

  // Convenience: fetch WETH/USDC candles on Base
  async fetchWethUsdcCandles(maxCandles = 5000): Promise<OhlcvCandle[]> {
    return this.fetchAllHourlyCandles(UNISWAP_WETH_USDC_BASE, maxCandles)
  }
}

export const theGraphClient = new TheGraphClient()
