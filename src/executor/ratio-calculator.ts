/**
 * Calculates the optimal token0/token1 ratio for a Uniswap v3 position.
 *
 * Given a tick range and current pool state, returns what fraction of total
 * capital should be in token0 vs token1 to minimize swap waste on mint.
 */

export interface OptimalRatio {
  ratio0: number  // fraction of total USD → token0 (0–1)
  ratio1: number  // fraction of total USD → token1 (0–1)
}

export function calcOptimalRatio(
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  token0PriceUsd: number,  // price of token0 in USD (e.g. ~$2115 for WETH)
): OptimalRatio {
  // Fully out of range cases
  if (currentTick < tickLower) {
    // Position is 100% token0 (price below range)
    return { ratio0: 1.0, ratio1: 0.0 }
  }
  if (currentTick >= tickUpper) {
    // Position is 100% token1 (price above range)
    return { ratio0: 0.0, ratio1: 1.0 }
  }

  // In range: compute virtual amounts per unit liquidity
  // sqrtPrice at boundaries (raw, not X96)
  const sqrtPA = Math.sqrt(Math.pow(1.0001, tickLower))
  const sqrtPB = Math.sqrt(Math.pow(1.0001, tickUpper))
  const sqrtP  = Math.sqrt(Math.pow(1.0001, currentTick))

  // token0 per unit liquidity in range: (sqrtPB - sqrtP) / (sqrtP * sqrtPB)
  const amt0PerL = (sqrtPB - sqrtP) / (sqrtP * sqrtPB)
  // token1 per unit liquidity in range: sqrtP - sqrtPA
  const amt1PerL = sqrtP - sqrtPA

  // These are in "raw ratio" space — convert to USD values
  // token0Price is already in USD (e.g. $2115/WETH)
  // token1 is assumed to be a stablecoin ($1), so its USD value = amt1PerL directly
  const v0 = amt0PerL * token0PriceUsd
  const v1 = amt1PerL  // token1 = stablecoin, price = 1

  const total = v0 + v1
  if (total <= 0) return { ratio0: 0.5, ratio1: 0.5 }

  return {
    ratio0: v0 / total,
    ratio1: v1 / total,
  }
}
