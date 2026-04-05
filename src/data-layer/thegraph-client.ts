import axios from 'axios'
import dotenv from 'dotenv'
import type { OhlcvCandle } from '../backtest/types'

dotenv.config()

// ─── The Graph Client ─────────────────────────────────────────────────────────
// Fetches historical OHLCV data from Uniswap v3 Arbitrum subgraph.
//
// Subgraph: Uniswap v3 Arbitrum
// ID: FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM
// Entity: poolHourData — hourly OHLCV per pool

// Uniswap v3 Arbitrum subgraph (has poolHourData with OHLCV)
// Verified working on The Graph Gateway (decentralized network)
const SUBGRAPH_ID = 'FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM'
const GATEWAY = 'https://gateway.thegraph.com/api'

// Uniswap v3 WETH/USDC 0.05% pool on Arbitrum
// token0=WETH, token1=USDC → prices are WETH/USDC, no inversion needed
const UNISWAP_WETH_USDC_ARBITRUM = '0xc6962004f452be9203591991d15f6b388e09e8d0'

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
    // poolHourData prices are token0/token1 = WETH/USDC ≈ 0.000489 (WETH per 1 USDC)
    // Must invert to get ETH price in USD: 1/0.000489 ≈ $2045
    // high price = 1/low_raw, low price = 1/high_raw (inverted)
    const candles: OhlcvCandle[] = rows
      .filter(r => parseFloat(r.close) > 0)
      .map(r => {
        const open  = 1 / parseFloat(r.open)
        const close = 1 / parseFloat(r.close)
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

  // Convenience: fetch WETH/USDC candles on Arbitrum
  async fetchWethUsdcCandles(maxCandles = 5000): Promise<OhlcvCandle[]> {
    return this.fetchAllHourlyCandles(UNISWAP_WETH_USDC_ARBITRUM, maxCandles)
  }
}

export const theGraphClient = new TheGraphClient()
