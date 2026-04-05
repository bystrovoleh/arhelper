import axios from 'axios'

interface DefiLlamaPool {
  pool: string
  chain: string
  project: string
  symbol: string
  tvlUsd: number
  apy: number
  apyBase: number | null
  apyReward: number | null
  rewardTokens: string[] | null
  underlyingTokens: string[] | null
  poolMeta: string | null
  il7d: number | null
  apyBase7d: number | null
}

// ─── DefiLlama Client ─────────────────────────────────────────────────────────

export class DefiLlamaClient {
  private poolsCache: DefiLlamaPool[] | null = null
  private cacheTs = 0
  private cacheTtlMs = 30 * 60 * 1000 // 30 min

  // Returns all yield pools (cached)
  async getAllPools(): Promise<DefiLlamaPool[]> {
    if (this.poolsCache && Date.now() - this.cacheTs < this.cacheTtlMs) {
      return this.poolsCache
    }
    const { data } = await axios.get('https://yields.llama.fi/pools', { timeout: 20_000 })
    this.poolsCache = data.data as DefiLlamaPool[]
    this.cacheTs = Date.now()
    return this.poolsCache
  }

  // Find a specific pool by underlying token addresses
  async findPool(token0: string, token1: string, chain: string, project: string): Promise<DefiLlamaPool | null> {
    const pools = await this.getAllPools()
    const t0 = token0.toLowerCase()
    const t1 = token1.toLowerCase()
    const chainLower = chain.toLowerCase()

    return pools.find(p => {
      if (p.chain.toLowerCase() !== chainLower) return false
      if (!p.project.includes(project.replace('-', ''))) return false
      if (!p.underlyingTokens) return false
      const tokens = p.underlyingTokens.map(t => t.toLowerCase())
      return tokens.includes(t0) && tokens.includes(t1)
    }) ?? null
  }

  // Get top pools by APY for a given chain
  async getTopPools(chain: string, minTvlUsd = 100_000, limit = 20): Promise<DefiLlamaPool[]> {
    const pools = await this.getAllPools()
    return pools
      .filter(p => p.chain.toLowerCase() === chain.toLowerCase() && p.tvlUsd >= minTvlUsd && (p.apyBase ?? 0) > 0)
      .sort((a, b) => (b.apyBase ?? 0) - (a.apyBase ?? 0))
      .slice(0, limit)
  }

  // Get APY history for a specific pool UUID
  async getPoolHistory(poolId: string): Promise<Array<{ timestamp: string; apy: number; tvlUsd: number }>> {
    try {
      const { data } = await axios.get(`https://yields.llama.fi/chart/${poolId}`, { timeout: 10_000 })
      return data.data as Array<{ timestamp: string; apy: number; tvlUsd: number }>
    } catch {
      return []
    }
  }
}

export const defiLlamaClient = new DefiLlamaClient()
