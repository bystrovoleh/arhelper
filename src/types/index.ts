// ─── Pool ────────────────────────────────────────────────────────────────────

export interface Token {
  address: string
  symbol: string
  decimals: number
}

export interface PoolConfig {
  address: string
  token0: Token
  token1: Token
  feeTier: number       // 100 | 500 | 3000 | 10000
  network: Network
  protocol: Protocol
}

export interface PoolState {
  address: string
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  token0Price: number   // token1 per token0
  token1Price: number   // token0 per token1
  feeGrowthGlobal0X128: bigint
  feeGrowthGlobal1X128: bigint
  fetchedAt: number     // unix ms
}

// ─── Position ────────────────────────────────────────────────────────────────

export interface Position {
  tokenId: bigint
  poolAddress: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
  token0Amount: number
  token1Amount: number
  uncollectedFees0: number
  uncollectedFees1: number
  inRange: boolean
  openedAt: number
}

// ─── Market Data ─────────────────────────────────────────────────────────────

export interface PoolMarketData {
  address: string
  volumeUsd24h: number
  tvlUsd: number
  feesUsd24h: number
  priceChange24h: number
  apyBase: number       // from DefiLlama (full-range estimate)
  fetchedAt: number
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export interface PositionAnalytics {
  tokenId: bigint
  estimatedApyConcentrated: number  // estimated APY for current range
  impermanentLoss: number           // % IL since open
  collectedFeesUsd: number
  unrealizedFeesUsd: number
  totalPnlUsd: number
  daysOpen: number
}

// ─── Strategy ────────────────────────────────────────────────────────────────

export interface RangeRecommendation {
  tickLower: number
  tickUpper: number
  priceLower: number
  priceUpper: number
  rangePct: number      // e.g. 0.20 = ±20% around current price
  reason: string
}

export interface RebalanceSignal {
  shouldRebalance: boolean
  reason: string
  urgency: 'low' | 'medium' | 'high'
  currentTick: number
  tickLower: number
  tickUpper: number
}

// ─── Network / Protocol ──────────────────────────────────────────────────────

export type Network = 'base' | 'arbitrum' | 'ethereum'
export type Protocol = 'uniswap-v3' | 'aerodrome'

export interface NetworkConfig {
  rpcUrl: string
  chainId: number
  nonfungiblePositionManager: string
  multicall3: string
}
