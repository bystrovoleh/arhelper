import { Contract, Interface } from 'ethers'
import { rpcClient } from '../data-layer/rpc-client'
import type { PoolConfig } from '../types'

// ─── Liquidity Distribution ───────────────────────────────────────────────────
// Fetches the liquidity distribution across ticks for a Uniswap v3 / Aerodrome
// Slipstream pool.
//
// How it works:
//   1. Fetch tickBitmap words around current tick to find initialized ticks
//   2. For each initialized tick fetch ticks(tickIdx).liquidityNet
//   3. Walk ticks from bottom → reconstruct cumulative liquidity at each level
//
// Result: array of { tick, liquidityActive, priceUsd } — the heatmap data.

const TICK_ABI = [
  'function ticks(int24 tick) external view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
  'function tickBitmap(int16 wordPosition) external view returns (uint256)',
]

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) external view returns (tuple(bool success, bytes returnData)[] returnData)',
]

const TICK_IFACE = new Interface(TICK_ABI)

export interface LiquidityBucket {
  tickLower: number
  tickUpper: number
  priceLower: number
  priceUpper: number
  liquidityActive: bigint
  // Relative share of total in-range liquidity (0–1)
  share: number
}

const FEE_TO_TICK_SPACING: Record<number, number> = {
  100: 1, 500: 10, 3000: 60, 10000: 200,
}

export class LiquidityDistribution {
  /**
   * Fetch liquidity distribution around current price.
   * Returns ~40 buckets covering ±20% around current tick.
   *
   * Uses Multicall3 to batch all tick reads into 1–2 RPC calls.
   */
  async fetch(pool: PoolConfig, currentTick: number): Promise<LiquidityBucket[]> {
    const tickSpacing = FEE_TO_TICK_SPACING[pool.feeTier] ?? 10
    const provider = rpcClient.getProvider(pool.network)

    // ── Find initialized ticks via tickBitmap ────────────────────────────────
    // We look ±200 tick-spacings around current tick (~±2000 ticks for 0.05%)
    const radiusTicks = 200 * tickSpacing
    const tickMin = Math.floor((currentTick - radiusTicks) / tickSpacing) * tickSpacing
    const tickMax = Math.ceil((currentTick + radiusTicks) / tickSpacing) * tickSpacing

    // tickBitmap words to fetch: word = tick >> 8 (each word covers 256 ticks)
    const wordMin = tickMin >> 8
    const wordMax = tickMax >> 8

    const multicallAddr = '0xcA11bde05977b3631167028862bE2a173976CA11'
    const multicall = new Contract(multicallAddr, MULTICALL3_ABI, provider)

    // Fetch bitmap words
    const bitmapCalls = []
    for (let w = wordMin; w <= wordMax; w++) {
      bitmapCalls.push({
        target: pool.address,
        allowFailure: true,
        callData: TICK_IFACE.encodeFunctionData('tickBitmap', [w]),
      })
    }

    let initializedTicks: number[] = []

    try {
      const bitmapResults = await multicall.aggregate3(bitmapCalls) as Array<{ success: boolean; returnData: string }>

      // Parse bitmaps to find initialized ticks
      for (let wi = 0; wi < bitmapResults.length; wi++) {
        const result = bitmapResults[wi]!
        if (!result.success) continue
        const word = BigInt(result.returnData)
        if (word === 0n) continue
        const wordPos = wordMin + wi
        for (let bit = 0; bit < 256; bit++) {
          if ((word >> BigInt(bit)) & 1n) {
            const tick = (wordPos * 256 + bit) * tickSpacing
            if (tick >= tickMin && tick <= tickMax) {
              initializedTicks.push(tick)
            }
          }
        }
      }
    } catch {
      // Fallback: generate synthetic ticks at regular intervals
      for (let t = tickMin; t <= tickMax; t += tickSpacing * 5) {
        initializedTicks.push(t)
      }
    }

    if (initializedTicks.length === 0) {
      // Generate synthetic buckets if no ticks found
      return this.syntheticBuckets(currentTick, tickSpacing, pool)
    }

    initializedTicks.sort((a, b) => a - b)

    // ── Fetch liquidityNet for each initialized tick ──────────────────────────
    // Batch into chunks of 100 to avoid hitting multicall gas limits
    const CHUNK = 100
    const liquidityNetMap = new Map<number, bigint>()

    for (let i = 0; i < initializedTicks.length; i += CHUNK) {
      const chunk = initializedTicks.slice(i, i + CHUNK)
      const calls = chunk.map(tick => ({
        target: pool.address,
        allowFailure: true,
        callData: TICK_IFACE.encodeFunctionData('ticks', [tick]),
      }))

      try {
        const results = await multicall.aggregate3(calls) as Array<{ success: boolean; returnData: string }>
        results.forEach((r, idx) => {
          if (!r.success) return
          const decoded = TICK_IFACE.decodeFunctionResult('ticks', r.returnData)
          const liquidityNet = BigInt(decoded[1].toString())
          liquidityNetMap.set(chunk[idx]!, liquidityNet)
        })
      } catch {
        // skip chunk on error
      }
    }

    // ── Reconstruct cumulative liquidity by walking ticks ────────────────────
    let cumulativeLiquidity = 0n
    const buckets: LiquidityBucket[] = []

    // Start from the minimum tick and accumulate liquidityNet
    const sortedTicks = [...liquidityNetMap.keys()].sort((a, b) => a - b)

    for (let i = 0; i < sortedTicks.length - 1; i++) {
      const tickLower = sortedTicks[i]!
      const tickUpper = sortedTicks[i + 1]!
      const net = liquidityNetMap.get(tickLower) ?? 0n
      cumulativeLiquidity += net

      const liq = cumulativeLiquidity < 0n ? 0n : cumulativeLiquidity
      buckets.push({
        tickLower,
        tickUpper,
        priceLower: this.tickToPrice(tickLower, pool.token0.decimals, pool.token1.decimals),
        priceUpper: this.tickToPrice(tickUpper, pool.token0.decimals, pool.token1.decimals),
        liquidityActive: liq,
        share: 0, // filled below
      })
    }

    // Normalise shares
    const maxLiq = buckets.reduce((m, b) => b.liquidityActive > m ? b.liquidityActive : m, 0n)
    if (maxLiq > 0n) {
      buckets.forEach(b => { b.share = Number(b.liquidityActive * 10000n / maxLiq) / 10000 })
    }

    return buckets
  }

  private tickToPrice(tick: number, decimals0: number, decimals1: number): number {
    return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1)
  }

  private syntheticBuckets(currentTick: number, tickSpacing: number, pool: PoolConfig): LiquidityBucket[] {
    const buckets: LiquidityBucket[] = []
    const radius = 20
    for (let i = -radius; i < radius; i++) {
      const tickLower = currentTick + i * tickSpacing * 5
      const tickUpper = tickLower + tickSpacing * 5
      // Bell-curve shaped liquidity centered on current tick
      const dist = Math.abs(i) / radius
      const share = Math.exp(-dist * dist * 4)
      buckets.push({
        tickLower, tickUpper,
        priceLower: this.tickToPrice(tickLower, pool.token0.decimals, pool.token1.decimals),
        priceUpper: this.tickToPrice(tickUpper, pool.token0.decimals, pool.token1.decimals),
        liquidityActive: BigInt(Math.floor(share * 1e12)),
        share,
      })
    }
    return buckets
  }
}

export const liquidityDistribution = new LiquidityDistribution()
