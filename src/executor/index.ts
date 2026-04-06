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

// Uniswap v3 SwapRouter02 on Arbitrum
const SWAP_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
]

// ─── Executor ─────────────────────────────────────────────────────────────────

export class Executor {
  private getWallet(network: Network): Wallet {
    const provider = rpcClient.getProvider(network)
    return new Wallet(WALLET.privateKey, provider)
  }

  /**
   * Swap 50% of token1 (USDC) to token0 (WETH) so we have both tokens for mint.
   * Uses Uniswap v3 SwapRouter02 exactInputSingle with 1% slippage.
   */
  async swapHalfToToken0(pool: PoolConfig, token1AmountRaw: bigint): Promise<void> {
    const wallet = this.getWallet(pool.network)
    const halfAmount = token1AmountRaw / 2n

    console.log(`[Swap] Swapping ${halfAmount} raw ${pool.token1.symbol} → ${pool.token0.symbol}…`)

    // Approve SwapRouter for token1
    await this.ensureApprovalFor(pool.token1.address, halfAmount, SWAP_ROUTER, pool.network)

    // Estimate minimum output with 1% slippage using current pool price
    const provider = rpcClient.getProvider(pool.network)
    const poolContract = new Contract(pool.address, POOL_STATE_ABI, provider)
    const slot0 = await poolContract.slot0()
    const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96.toString())
    const Q96 = 2n ** 96n
    const decAdj = Math.pow(10, pool.token0.decimals - pool.token1.decimals)
    const sqrtPrice = Number(sqrtPriceX96) / Number(Q96)
    const currentPrice = sqrtPrice * sqrtPrice * decAdj // token0 per token1 (e.g. WETH per USDC)
    // halfAmount is in token1 raw units; expected token0 out = halfAmount / 10^decimals1 * (1/price)
    const expectedToken0 = (Number(halfAmount) / Math.pow(10, pool.token1.decimals)) / currentPrice
    const minOut = BigInt(Math.floor(expectedToken0 * Math.pow(10, pool.token0.decimals) * 0.99)) // 1% slippage

    const router = new Contract(SWAP_ROUTER, SWAP_ROUTER_ABI, wallet)
    const tx = await router.exactInputSingle({
      tokenIn: pool.token1.address,
      tokenOut: pool.token0.address,
      fee: pool.feeTier,
      recipient: wallet.address,
      amountIn: halfAmount,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    })

    console.log(`[Swap] Swap tx submitted: ${tx.hash}`)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error(`Swap tx failed: ${tx.hash}`)
    console.log(`[Swap] Swap confirmed: ${tx.hash}`)
  }

  /**
   * Approve a specific spender (not just NFPM).
   */
  async ensureApprovalFor(tokenAddress: string, amount: bigint, spender: string, network: Network): Promise<void> {
    const wallet = this.getWallet(network)
    const token = new Contract(tokenAddress, ERC20_ABI, wallet)
    const allowance: bigint = await token.allowance(wallet.address, spender)
    if (allowance >= amount) return
    console.log(`Approving ${tokenAddress} for ${spender}…`)
    const tx = await token.approve(spender, ethers.MaxUint256)
    await tx.wait()
    console.log(`Approval confirmed: ${tx.hash}`)
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

    // ── Swap half of token1 → token0 if token0 balance is insufficient ──────
    const token0Contract = new Contract(pool.token0.address, ERC20_ABI, provider)
    const token0Balance: bigint = await token0Contract.balanceOf(wallet.address)
    if (token0Balance < amount0Desired) {
      console.log(`[Swap] token0 balance insufficient (${token0Balance} < ${amount0Desired}), swapping half of token1…`)
      await this.swapHalfToToken0(pool, amount1Desired * 2n)
    }

    // ── Ensure token approvals (sequential to avoid nonce collision) ────────
    await this.ensureApproval(pool.token0.address, amount0Desired, pool.network)
    await this.ensureApproval(pool.token1.address, amount1Desired, pool.network)

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

    // Parse tokenId from ERC721 Transfer event emitted by NFPM (mint = from address(0))
    const transferTopic = ethers.id('Transfer(address,address,uint256)')
    const zeroAddress = '0x0000000000000000000000000000000000000000000000000000000000000000'
    const transferLog = receipt.logs.find(l =>
      l.address.toLowerCase() === nfpmAddress.toLowerCase() &&
      l.topics[0] === transferTopic &&
      l.topics[1] === zeroAddress  // from = address(0) means mint
    )
    if (!transferLog || !transferLog.topics[3]) {
      throw new Error(`Mint tx succeeded (${tx.hash}) but could not find Transfer event to extract tokenId`)
    }
    const tokenId = BigInt(transferLog.topics[3])

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

    // Always read real liquidity from NFPM to avoid stale DB values
    const NFPM_ABI_POS = ['function positions(uint256) external view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)']
    const nfpm = new Contract(nfpmAddress, NFPM_ABI_POS, provider)
    const posData = await nfpm.positions(tokenId)
    const realLiquidity: bigint = BigInt(posData[7].toString())
    console.log(`[Close] Real liquidity from chain: ${realLiquidity} (was: ${liquidity})`)

    const poolContract = new Contract(pool.address, POOL_STATE_ABI, provider)
    const [slot0, liquidityRaw] = await Promise.all([poolContract.slot0(), poolContract.liquidity()])

    const uniToken0 = new UniToken(this.chainId(pool), pool.token0.address, pool.token0.decimals, pool.token0.symbol)
    const uniToken1 = new UniToken(this.chainId(pool), pool.token1.address, pool.token1.decimals, pool.token1.symbol)

    const uniPool = new Pool(
      uniToken0, uniToken1, pool.feeTier,
      slot0.sqrtPriceX96.toString(), liquidityRaw.toString(), Number(slot0.tick),
    )

    const position = new UniPosition({ pool: uniPool, tickLower, tickUpper, liquidity: realLiquidity.toString() })

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

    // Parse Collect event to log how much was actually received
    try {
      const collectTopic = ethers.id('Collect(uint256,address,uint256,uint256)')
      const collectLog = receipt.logs.find(l => l.topics[0] === collectTopic)
      if (collectLog) {
        const [, amount0, amount1] = ethers.AbiCoder.defaultAbiCoder().decode(
          ['address', 'uint256', 'uint256'], collectLog.data
        )
        const a0 = Number(amount0) / Math.pow(10, pool.token0.decimals)
        const a1 = Number(amount1) / Math.pow(10, pool.token1.decimals)
        console.log(`[Close] Received: ${a0.toFixed(6)} ${pool.token0.symbol} + ${a1.toFixed(4)} ${pool.token1.symbol}`)
      }
    } catch { /* non-critical */ }

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
