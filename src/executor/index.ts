import { ethers, Contract, Wallet } from 'ethers'
import {
  Pool,
  Position as UniPosition,
  NonfungiblePositionManager,
  nearestUsableTick,
} from '@uniswap/v3-sdk'
import { Token as UniToken, CurrencyAmount, Percent } from '@uniswap/sdk-core'
import { rpcClient } from '../data-layer'
import { PoolConfig, RangeRecommendation, Network } from '../types'
import { NETWORKS, WALLET } from '../config'

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
]

const POOL_STATE_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() external view returns (uint128)',
  'function ticks(int24) external view returns (uint128, int128, uint256, uint256, int56, uint160, uint32, bool)',
]

// ─── Executor ─────────────────────────────────────────────────────────────────

export class Executor {
  private getWallet(network: Network): Wallet {
    const provider = rpcClient.getProvider(network)
    return new Wallet(WALLET.privateKey, provider)
  }

  /**
   * Approve the NonfungiblePositionManager to spend tokens.
   * Only sends tx if allowance is insufficient.
   */
  async ensureApproval(tokenAddress: string, amount: bigint, network: Network): Promise<void> {
    const wallet = this.getWallet(network)
    const nfpm = NETWORKS[network]!.nonfungiblePositionManager
    const token = new Contract(tokenAddress, ERC20_ABI, wallet)

    const allowance: bigint = await token.allowance(wallet.address, nfpm)
    if (allowance >= amount) return

    console.log(`Approving ${tokenAddress} for ${nfpm}…`)
    const tx = await token.approve(nfpm, ethers.MaxUint256)
    await tx.wait()
    console.log(`Approval confirmed: ${tx.hash}`)
  }

  /**
   * Mint a new concentrated liquidity position.
   */
  async mintPosition(
    pool: PoolConfig,
    range: RangeRecommendation,
    amount0Desired: bigint,
    amount1Desired: bigint,
  ): Promise<{ tokenId: bigint; txHash: string }> {
    const wallet = this.getWallet(pool.network)
    const nfpmAddress = NETWORKS[pool.network]!.nonfungiblePositionManager
    const provider = rpcClient.getProvider(pool.network)

    // ── Fetch on-chain pool state ────────────────────────────────────────────
    const poolContract = new Contract(pool.address, POOL_STATE_ABI, provider)
    const [slot0, liquidityRaw] = await Promise.all([poolContract.slot0(), poolContract.liquidity()])

    const uniToken0 = new UniToken(this.chainId(pool), pool.token0.address, pool.token0.decimals, pool.token0.symbol)
    const uniToken1 = new UniToken(this.chainId(pool), pool.token1.address, pool.token1.decimals, pool.token1.symbol)

    const uniPool = new Pool(
      uniToken0,
      uniToken1,
      pool.feeTier,
      slot0.sqrtPriceX96.toString(),
      liquidityRaw.toString(),
      Number(slot0.tick),
    )

    const position = UniPosition.fromAmounts({
      pool: uniPool,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      amount0: amount0Desired.toString(),
      amount1: amount1Desired.toString(),
      useFullPrecision: true,
    })

    // ── Ensure token approvals ───────────────────────────────────────────────
    await Promise.all([
      this.ensureApproval(pool.token0.address, amount0Desired, pool.network),
      this.ensureApproval(pool.token1.address, amount1Desired, pool.network),
    ])

    // ── Build calldata ───────────────────────────────────────────────────────
    const { calldata, value } = NonfungiblePositionManager.addCallParameters(position, {
      slippageTolerance: new Percent(50, 10_000), // 0.5%
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    })

    const tx = await wallet.sendTransaction({
      to: nfpmAddress,
      data: calldata,
      value: BigInt(value),
    })

    console.log(`Mint tx submitted: ${tx.hash}`)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error(`Mint tx failed: ${tx.hash}`)

    // Parse tokenId from Transfer event (ERC721 mint)
    const transferTopic = ethers.id('Transfer(address,address,uint256)')
    const transferLog = receipt.logs.find(l => l.topics[0] === transferTopic)
    const tokenId = transferLog ? BigInt(transferLog.topics[3] ?? '0') : 0n

    console.log(`Position minted. TokenId: ${tokenId}, tx: ${tx.hash}`)
    return { tokenId, txHash: tx.hash }
  }

  /**
   * Remove 100% liquidity from an existing position and collect fees.
   */
  async closePosition(
    tokenId: bigint,
    pool: PoolConfig,
    tickLower: number,
    tickUpper: number,
    liquidity: bigint,
  ): Promise<string> {
    const wallet = this.getWallet(pool.network)
    const nfpmAddress = NETWORKS[pool.network]!.nonfungiblePositionManager
    const provider = rpcClient.getProvider(pool.network)

    const poolContract = new Contract(pool.address, POOL_STATE_ABI, provider)
    const [slot0, liquidityRaw] = await Promise.all([poolContract.slot0(), poolContract.liquidity()])

    const uniToken0 = new UniToken(this.chainId(pool), pool.token0.address, pool.token0.decimals, pool.token0.symbol)
    const uniToken1 = new UniToken(this.chainId(pool), pool.token1.address, pool.token1.decimals, pool.token1.symbol)

    const uniPool = new Pool(
      uniToken0, uniToken1, pool.feeTier,
      slot0.sqrtPriceX96.toString(), liquidityRaw.toString(), Number(slot0.tick),
    )

    const position = new UniPosition({ pool: uniPool, tickLower, tickUpper, liquidity: liquidity.toString() })

    const { calldata, value } = NonfungiblePositionManager.removeCallParameters(position, {
      tokenId: tokenId.toString(),
      liquidityPercentage: new Percent(1),
      slippageTolerance: new Percent(50, 10_000),
      deadline: Math.floor(Date.now() / 1000) + 60 * 20,
      collectOptions: {
        expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(uniToken0, 0),
        expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(uniToken1, 0),
        recipient: wallet.address,
      },
    })

    const tx = await wallet.sendTransaction({ to: nfpmAddress, data: calldata, value: BigInt(value) })
    console.log(`Close tx submitted: ${tx.hash}`)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error(`Close tx failed: ${tx.hash}`)

    console.log(`Position ${tokenId} closed. tx: ${tx.hash}`)
    return tx.hash
  }

  /**
   * Full rebalance: close existing position → open new one in a fresh range.
   */
  async rebalance(
    tokenId: bigint,
    pool: PoolConfig,
    oldTickLower: number,
    oldTickUpper: number,
    oldLiquidity: bigint,
    newRange: RangeRecommendation,
    amount0: bigint,
    amount1: bigint,
  ): Promise<{ newTokenId: bigint; closeTxHash: string; mintTxHash: string }> {
    console.log(`\nRebalancing position ${tokenId}…`)
    const closeTxHash = await this.closePosition(tokenId, pool, oldTickLower, oldTickUpper, oldLiquidity)
    const { tokenId: newTokenId, txHash: mintTxHash } = await this.mintPosition(pool, newRange, amount0, amount1)
    return { newTokenId, closeTxHash, mintTxHash }
  }

  /**
   * Estimate gas cost in USD for a rebalance.
   */
  async estimateRebalanceGasUsd(pool: PoolConfig, ethPriceUsd: number): Promise<number> {
    try {
      const provider = rpcClient.getProvider(pool.network)
      const feeData = await provider.getFeeData()
      const gasPrice = feeData.gasPrice ?? 1_000_000_000n
      // Typical rebalance: ~300K gas (close + mint)
      const gasUnits = 300_000n
      const gasCostEth = Number(gasPrice * gasUnits) / 1e18
      return gasCostEth * ethPriceUsd
    } catch {
      return 2 // fallback $2 estimate
    }
  }

  private chainId(pool: PoolConfig): number {
    const map: Record<string, number> = { base: 8453, arbitrum: 42161, ethereum: 1 }
    return map[pool.network] ?? 1
  }
}

export const executor = new Executor()
