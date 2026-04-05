import axios, { AxiosInstance } from 'axios'
import { PoolMarketData } from '../types'

interface GeckoPool {
  id: string
  attributes: {
    address: string
    name: string
    base_token_price_usd: string
    quote_token_price_usd: string
    base_token_price_native_currency: string
    volume_usd: { h24: string; h6: string; h1: string; m5: string }
    reserve_in_usd: string
    price_change_percentage: { h24: string; h6: string; h1: string; m5: string }
    transactions: { h24: { buys: number; sells: number } }
  }
}

// ─── GeckoTerminal Client ─────────────────────────────────────────────────────

export class GeckoTerminalClient {
  private client: AxiosInstance
  // Map our network names to GeckoTerminal network slugs
  private networkMap: Record<string, string> = {
    base: 'base',
    arbitrum: 'arbitrum',
    ethereum: 'eth',
  }

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.geckoterminal.com/api/v2',
      timeout: 10_000,
      headers: { Accept: 'application/json;version=20230302' },
    })
  }

  async fetchPool(poolAddress: string, network: string, feeTier?: number): Promise<PoolMarketData | null> {
    const networkSlug = this.networkMap[network] ?? network
    try {
      const { data } = await this.client.get(`/networks/${networkSlug}/pools/${poolAddress}`)
      const pool: GeckoPool = data.data
      const attr = pool.attributes

      const tvlUsd = parseFloat(attr.reserve_in_usd)
      const volumeUsd24h = parseFloat(attr.volume_usd.h24)
      // Use actual fee tier from pool config (e.g. 500 = 0.05%, 3000 = 0.3%)
      const feeRate = feeTier != null ? feeTier / 1_000_000 : 0.0005
      const feesUsd24h = volumeUsd24h * feeRate

      return {
        address: poolAddress,
        volumeUsd24h,
        tvlUsd,
        feesUsd24h,
        priceChange24h: parseFloat(attr.price_change_percentage.h24),
        apyBase: tvlUsd > 0 ? (feesUsd24h * 365 / tvlUsd) * 100 : 0,
        fetchedAt: Date.now(),
      }
    } catch (err: any) {
      const status = err?.response?.status
      if (status === 429) {
        console.warn(`GeckoTerminal: rate limited (429) for ${poolAddress.slice(0, 10)}…`)
      } else {
        console.warn(`GeckoTerminal: failed to fetch pool ${poolAddress}`, err?.message ?? err)
      }
      return null
    }
  }

  // Search top pools by volume for a given DEX on a network
  async fetchTopPools(network: string, dex: string, limit = 20): Promise<GeckoPool[]> {
    const networkSlug = this.networkMap[network] ?? network
    try {
      const { data } = await this.client.get(`/networks/${networkSlug}/dexes/${dex}/pools`, {
        params: { page: 1, sort: 'h24_volume_usd_liquidity_score_desc' },
      })
      return (data.data as GeckoPool[]).slice(0, limit)
    } catch (err) {
      console.warn(`GeckoTerminal: failed to fetch top pools for ${dex}`, err)
      return []
    }
  }

  // Get OHLCV for price range analysis (hourly, last 24h)
  async fetchOhlcv(poolAddress: string, network: string, timeframe: 'minute' | 'hour' | 'day' = 'hour', limit = 24) {
    const networkSlug = this.networkMap[network] ?? network
    try {
      const { data } = await this.client.get(
        `/networks/${networkSlug}/pools/${poolAddress}/ohlcv/${timeframe}`,
        { params: { limit } }
      )
      return data.data?.attributes?.ohlcv_list as Array<[number, number, number, number, number, number]> ?? []
    } catch (err) {
      console.warn(`GeckoTerminal: failed to fetch OHLCV for ${poolAddress}`, err)
      return []
    }
  }

  // Fetch older candles before a given timestamp (for pagination)
  async fetchOhlcvBefore(poolAddress: string, network: string, timeframe: 'minute' | 'hour' | 'day', limit: number, beforeTimestamp: number) {
    const networkSlug = this.networkMap[network] ?? network
    try {
      const { data } = await this.client.get(
        `/networks/${networkSlug}/pools/${poolAddress}/ohlcv/${timeframe}`,
        { params: { limit, before_timestamp: Math.floor(beforeTimestamp / 1000) } }
      )
      return data.data?.attributes?.ohlcv_list as Array<[number, number, number, number, number, number]> ?? []
    } catch (err) {
      console.warn(`GeckoTerminal: failed to fetch older OHLCV for ${poolAddress}`, err)
      return []
    }
  }
}

export const geckoTerminalClient = new GeckoTerminalClient()
