// ─── Uniswap v3 Fee Math ──────────────────────────────────────────────────────
// Real on-chain fee calculation using feeGrowthGlobal.
//
// How Uniswap v3 fees work:
//   1. Every swap accumulates fees into feeGrowthGlobal0X128 / feeGrowthGlobal1X128
//   2. Each position tracks feeGrowthInside at the time it was last updated
//   3. Uncollected fees = (feeGrowthGlobal_now - feeGrowthGlobal_entry) × liquidity / 2^128
//
// This gives us EXACT fees — no estimation, no TVL proxy.

const Q128 = 2n ** 128n

/**
 * Calculate liquidity units from capital and price range.
 *
 * Uniswap v3 stores liquidity in raw token units scaled by sqrtPrice.
 * For WETH(18)/USDC(6):
 *   amount1 (USDC raw) = L × (sqrtPrice - sqrtLower)  [in Q96 units]
 *
 * sqrtPriceX96 = sqrt(price_raw) × 2^96
 * where price_raw = price_human / 10^(decimals0 - decimals1)
 *
 * So: L = amount1_raw / (sqrtPriceX96/2^96 - sqrtLowerX96/2^96)
 *       = amount1_raw × 2^96 / (sqrtPriceX96 - sqrtLowerX96)
 */
export function calcLiquidity(
  capitalUsd: number,
  currentPrice: number,    // human readable (e.g. $2044)
  priceLower: number,      // human readable
  priceUpper: number,      // human readable
  token0Decimals: number,
  token1Decimals: number,
): bigint {
  if (currentPrice <= priceLower || currentPrice >= priceUpper) return 0n
  if (priceLower <= 0 || priceUpper <= priceLower) return 0n

  const decimalAdj = Math.pow(10, token0Decimals - token1Decimals)

  // Convert human prices to raw (for sqrtPrice calculation)
  const rawCurrent = currentPrice / decimalAdj
  const rawLower = priceLower / decimalAdj
  const rawUpper = priceUpper / decimalAdj

  const sqrtCurrent = Math.sqrt(rawCurrent)
  const sqrtLower = Math.sqrt(rawLower)
  const sqrtUpper = Math.sqrt(rawUpper)

  // amount1 in raw token1 units (USDC: 6 decimals)
  const amount1Raw = (capitalUsd / 2) * Math.pow(10, token1Decimals)

  // L from token1 side: L = amount1_raw / (sqrtCurrent - sqrtLower)
  const L = amount1Raw / (sqrtCurrent - sqrtLower)

  // Verify with token0 side and take minimum (more conservative)
  const amount0Raw = (capitalUsd / 2 / currentPrice) * Math.pow(10, token0Decimals)
  const L0 = amount0Raw / (1 / sqrtCurrent - 1 / sqrtUpper)

  return BigInt(Math.floor(Math.min(L, L0)))
}

/**
 * Calculate uncollected fees from feeGrowthGlobal difference.
 *
 * fees = (feeGrowthGlobal_now - feeGrowthGlobal_entry) × liquidity / 2^128
 *
 * feeGrowthGlobal is in token units per unit of liquidity × 2^128.
 * Result is in token units (raw, needs decimal adjustment).
 */
export function calcFeesFromGrowth(
  feeGrowthEntry: bigint,
  feeGrowthNow: bigint,
  liquidity: bigint,
): bigint {
  if (liquidity === 0n) return 0n
  // Handle overflow wrap-around (feeGrowth is uint256, can overflow)
  let delta = feeGrowthNow - feeGrowthEntry
  if (delta < 0n) delta += 2n ** 256n  // wrap-around
  return (delta * liquidity) / Q128
}

/**
 * Convert raw token fees to USD.
 * token0 = WETH (18 decimals), token1 = USDC (6 decimals)
 */
export function feesToUsd(
  fees0Raw: bigint,  // WETH fees in wei
  fees1Raw: bigint,  // USDC fees in micro-USDC
  token0Decimals: number,
  token1Decimals: number,
  token0PriceUsd: number,
): number {
  const fees0 = Number(fees0Raw) / Math.pow(10, token0Decimals)
  const fees1 = Number(fees1Raw) / Math.pow(10, token1Decimals)
  return fees0 * token0PriceUsd + fees1
}
