import axios from 'axios'
import { THEGRAPH } from '../config'
import { Network, Protocol } from '../types'

interface SubgraphPoolData {
  id: string
  feeTier: string
  liquidity: string
  sqrtPrice: string
  tick: string
  token0: { id: string; symbol: string; decimals: string }
  token1: { id: string; symbol: string; decimals: string }
  totalValueLockedUSD: string
  volumeUSD: string
  feesUSD: string
  poolDayData: Array<{
    date: number
    volumeUSD: string
    feesUSD: string
    tvlUSD: string
  }>
}

interface SubgraphPosition {
  id: string
  liquidity: string
  tickLower: { tickIdx: string }
  tickUpper: { tickIdx: string }
  collectedFeesToken0: string
  collectedFeesToken1: string
  depositedToken0: string
  depositedToken1: string
  pool: { id: string }
}

// ─── Subgraph Client ──────────────────────────────────────────────────────────

export class SubgraphClient {
  private baseUrl = 'https://gateway.thegraph.com/api'

  private getSubgraphId(network: Network, protocol: Protocol): string {
    const key = `${protocol}-${network}` as keyof typeof THEGRAPH.subgraphs
    const id = THEGRAPH.subgraphs[key]
    if (!id) throw new Error(`No subgraph for ${protocol} on ${network}`)
    return id
  }

  private async query<T>(subgraphId: string, gql: string, variables: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.baseUrl}/${THEGRAPH.apiKey}/subgraphs/id/${subgraphId}`
    const { data } = await axios.post(url, { query: gql, variables }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    })
    if (data.errors) throw new Error(`Subgraph error: ${JSON.stringify(data.errors)}`)
    return data.data as T
  }

  // Fetch pool data with 7-day history
  async fetchPool(poolAddress: string, network: Network, protocol: Protocol): Promise<SubgraphPoolData | null> {
    const subgraphId = this.getSubgraphId(network, protocol)
    const gql = `
      query Pool($id: ID!) {
        pool(id: $id) {
          id
          feeTier
          liquidity
          sqrtPrice
          tick
          token0 { id symbol decimals }
          token1 { id symbol decimals }
          totalValueLockedUSD
          volumeUSD
          feesUSD
          poolDayData(first: 7, orderBy: date, orderDirection: desc) {
            date
            volumeUSD
            feesUSD
            tvlUSD
          }
        }
      }
    `
    const result = await this.query<{ pool: SubgraphPoolData | null }>(subgraphId, gql, { id: poolAddress.toLowerCase() })
    return result.pool
  }

  // Fetch all positions for a wallet address
  async fetchPositions(ownerAddress: string, network: Network, protocol: Protocol): Promise<SubgraphPosition[]> {
    const subgraphId = this.getSubgraphId(network, protocol)
    const gql = `
      query Positions($owner: String!) {
        positions(where: { owner: $owner, liquidity_gt: "0" }) {
          id
          liquidity
          tickLower { tickIdx }
          tickUpper { tickIdx }
          collectedFeesToken0
          collectedFeesToken1
          depositedToken0
          depositedToken1
          pool { id }
        }
      }
    `
    const result = await this.query<{ positions: SubgraphPosition[] }>(subgraphId, gql, { owner: ownerAddress.toLowerCase() })
    return result.positions
  }

  // Get daily fees collected for a pool over the last N days
  async fetchDailyFees(poolAddress: string, network: Network, protocol: Protocol, days = 30): Promise<Array<{ date: number; feesUSD: number; volumeUSD: number }>> {
    const subgraphId = this.getSubgraphId(network, protocol)
    const gql = `
      query DailyFees($id: ID!, $days: Int!) {
        pool(id: $id) {
          poolDayData(first: $days, orderBy: date, orderDirection: desc) {
            date
            feesUSD
            volumeUSD
          }
        }
      }
    `
    const result = await this.query<{ pool: { poolDayData: Array<{ date: number; feesUSD: string; volumeUSD: string }> } }>(
      subgraphId, gql, { id: poolAddress.toLowerCase(), days }
    )
    return result.pool.poolDayData.map(d => ({
      date: d.date,
      feesUSD: parseFloat(d.feesUSD),
      volumeUSD: parseFloat(d.volumeUSD),
    }))
  }
}

export const subgraphClient = new SubgraphClient()
