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
    'uniswap-v3-arbitrum': 'FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX',
    'aerodrome-base': 'GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM',
  },
}

// ─── Watched pools ────────────────────────────────────────────────────────────

export const WATCHED_POOLS: PoolConfig[] = [
  {
    address: '0xC6962004f452bE9203591991D15f6b388e09E8D0', // Uniswap v3 WETH/USDC 0.05% — most liquid, ~$53M TVL
    token0: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
    token1: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
    feeTier: 500,
    network: 'arbitrum',
    protocol: 'uniswap-v3',
  },
  {
    address: '0x0E4831319A50228B9e450861297aB92dee15B44F', // Uniswap v3 WBTC/USDC 0.05%
    token0: { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', symbol: 'WBTC', decimals: 8 },
    token1: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
    feeTier: 500,
    network: 'arbitrum',
    protocol: 'uniswap-v3',
  },
{
    address: '0x2f5e87C9312fa29aed5c179E456625D79015299c', // Uniswap v3 WBTC/WETH 0.05%
    token0: { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', symbol: 'WBTC', decimals: 8 },
    token1: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
    feeTier: 500,
    network: 'arbitrum',
    protocol: 'uniswap-v3',
  },
]

// ─── Strategy params ──────────────────────────────────────────────────────────

export const STRATEGY = {
  defaultRangePct: 0.20,       // ±20% around current price
  rebalanceThresholdPct: 0.05, // rebalance when price within 5% of range boundary
  minPositionUsd: 50,          // don't open position smaller than $50
  maxGasUsd: 5,                // abort rebalance if gas > $5
}
