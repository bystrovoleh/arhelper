import { JsonRpcProvider, Contract, Interface } from 'ethers'
import { NETWORKS } from '../config'
import { Network, PoolState } from '../types'

// ─── ABIs (minimal) ───────────────────────────────────────────────────────────

// Uniswap v3: 7 fields (includes bool unlocked at end)
const UNISWAP_SLOT0_SIG = 'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'

// Aerodrome Slipstream: 6 fields (no bool unlocked)
const AERODROME_SLOT0_SIG = 'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol)'

const SHARED_ABI = [
  'function liquidity() external view returns (uint128)',
  'function feeGrowthGlobal0X128() external view returns (uint256)',
  'function feeGrowthGlobal1X128() external view returns (uint256)',
  'function ticks(int24 tick) external view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
]

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external view returns (tuple(bool success, bytes returnData)[] returnData)',
]

const UNISWAP_IFACE = new Interface([UNISWAP_SLOT0_SIG, ...SHARED_ABI])
const AERODROME_IFACE = new Interface([AERODROME_SLOT0_SIG, ...SHARED_ABI])
const POOL_IFACE = UNISWAP_IFACE

// ─── RPC Client ───────────────────────────────────────────────────────────────

export class RpcClient {
  private providers: Map<Network, JsonRpcProvider> = new Map()

  getProvider(network: Network): JsonRpcProvider {
    if (!this.providers.has(network)) {
      const config = NETWORKS[network]
      if (!config) throw new Error(`Unknown network: ${network}`)
      this.providers.set(network, new JsonRpcProvider(config.rpcUrl))
    }
    return this.providers.get(network)!
  }

  // Fetch pool state using Multicall3 — single RPC call for slot0 + liquidity + feeGrowth
  async fetchPoolState(
    poolAddress: string,
    network: Network,
    token0Decimals = 18,
    token1Decimals = 18,
    protocol: 'uniswap-v3' | 'aerodrome' = 'uniswap-v3',
  ): Promise<PoolState> {
    const iface = protocol === 'aerodrome' ? AERODROME_IFACE : UNISWAP_IFACE
    const provider = this.getProvider(network)
    const multicallAddress = NETWORKS[network]!.multicall3
    const multicall = new Contract(multicallAddress, MULTICALL3_ABI, provider)

    const calls = [
      { target: poolAddress, allowFailure: false, callData: iface.encodeFunctionData('slot0') },
      { target: poolAddress, allowFailure: false, callData: iface.encodeFunctionData('liquidity') },
      { target: poolAddress, allowFailure: false, callData: iface.encodeFunctionData('feeGrowthGlobal0X128') },
      { target: poolAddress, allowFailure: false, callData: iface.encodeFunctionData('feeGrowthGlobal1X128') },
    ]

    const results = await multicall.aggregate3(calls)

    const [slot0Result, liquidityResult, feeGrowth0Result, feeGrowth1Result] = results as Array<{ success: boolean; returnData: string }>

    const slot0 = iface.decodeFunctionResult('slot0', slot0Result.returnData)
    const liquidity = iface.decodeFunctionResult('liquidity', liquidityResult.returnData)
    const feeGrowth0 = iface.decodeFunctionResult('feeGrowthGlobal0X128', feeGrowth0Result.returnData)
    const feeGrowth1 = iface.decodeFunctionResult('feeGrowthGlobal1X128', feeGrowth1Result.returnData)

    const sqrtPriceX96 = BigInt(slot0[0].toString())
    const tick = Number(slot0[1])

    // Price from sqrtPriceX96: price = (sqrtPriceX96 / 2^96)^2 × 10^(decimals0 - decimals1)
    const Q96 = 2n ** 96n
    const sqrtPrice = Number(sqrtPriceX96) / Number(Q96)
    const rawPrice = sqrtPrice * sqrtPrice
    const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals)
    const token0Price = rawPrice * decimalAdjustment // human-readable: token1 per token0

    return {
      address: poolAddress,
      sqrtPriceX96,
      tick,
      liquidity: BigInt(liquidity[0].toString()),
      token0Price,
      token1Price: token0Price > 0 ? 1 / token0Price : 0,
      feeGrowthGlobal0X128: BigInt(feeGrowth0[0].toString()),
      feeGrowthGlobal1X128: BigInt(feeGrowth1[0].toString()),
      fetchedAt: Date.now(),
    }
  }

  // Fetch tick data for a specific tick index
  async fetchTick(poolAddress: string, tickIndex: number, network: Network) {
    const provider = this.getProvider(network)
    const pool = new Contract(poolAddress, SHARED_ABI, provider)
    return pool.ticks(tickIndex)
  }

  async getBlockNumber(network: Network): Promise<number> {
    return this.getProvider(network).getBlockNumber()
  }
}

export const rpcClient = new RpcClient()
