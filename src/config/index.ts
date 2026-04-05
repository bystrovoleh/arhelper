import dotenv from 'dotenv'
import { NetworkConfig, PoolConfig } from '../types'

dotenv.config()

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

// ─── Network configs ─────────────────────────────────────────────────────────

export const NETWORKS: Record<string, NetworkConfig> = {
  base: {
    rpcUrl: process.env['ALCHEMY_BASE_URL'] ?? `https://base-mainnet.g.alchemy.com/v2/${process.env['ALCHEMY_API_KEY'] ?? ''}`,
    chainId: 8453,
    nonfungiblePositionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', // Uniswap v3 on Base
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  },
  arbitrum: {
    rpcUrl: process.env['ALCHEMY_ARBITRUM_URL'] ?? `https://arb-mainnet.g.alchemy.com/v2/${process.env['ALCHEMY_API_KEY'] ?? ''}`,
    chainId: 42161,
    nonfungiblePositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  },
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

export const WALLET = {
  get privateKey() { return requireEnv('WALLET_PRIVATE_KEY') },
  get address() { return requireEnv('WALLET_ADDRESS') },
}

// ─── The Graph ────────────────────────────────────────────────────────────────

export const THEGRAPH = {
  get apiKey() { return requireEnv('THEGRAPH_API_KEY') },
  subgraphs: {
    'uniswap-v3-base': '43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG',
    'uniswap-v3-arbitrum': 'FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJG',
    'aerodrome-base': 'GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM',
  },
}

// ─── Watched pools ────────────────────────────────────────────────────────────

export const WATCHED_POOLS: PoolConfig[] = [
  {
    address: '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59', // Aerodrome WETH/USDC 0.05% — vol $90M/day
    token0: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    token1: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
    feeTier: 500,
    network: 'base',
    protocol: 'aerodrome',
  },
]

// ─── Strategy params ──────────────────────────────────────────────────────────

export const STRATEGY = {
  defaultRangePct: 0.20,       // ±20% around current price
  rebalanceThresholdPct: 0.05, // rebalance when price within 5% of range boundary
  minPositionUsd: 50,          // don't open position smaller than $50
  maxGasUsd: 5,                // abort rebalance if gas > $5
}
