import { ethers, Contract, Wallet, TransactionReceipt } from 'ethers'
import {
  Pool,
  Position as UniPosition,
  NonfungiblePositionManager,
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

const WETH_ABI = [
  ...ERC20_ABI,
  'function deposit() external payable',
  'function withdraw(uint256 wad) external',
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

// ETH to keep as gas reserve on Arbitrum (0.003 ETH ~ $6 at $2000)
const GAS_RESERVE_ETH = 0.003

// Minimum imbalance (fraction of total capital) that justifies a swap
const SWAP_THRESHOLD = 0.05  // 5%

// ─── Swap metadata returned to caller for P&L tracking ───────────────────────

export interface SwapMeta {
  txHash: string
  tokenIn: string
  tokenOut: string
  amountInUsd: number
  amountOutUsd: number
  priceImpactPct: number
  gasUsd: number
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export class Executor {
  private getWallet(network: Network): Wallet {
    const provider = rpcClient.getProvider(network)
    return new Wallet(WALLET.privateKey, provider)
  }

  // ── Wrap native ETH → WETH, keeping GAS_RESERVE_ETH for gas ───────────────
  async wrapEthIfNeeded(pool: PoolConfig): Promise<void> {
    const wallet = this.getWallet(pool.network)
    const provider = rpcClient.getProvider(pool.network)

    const ethBalance = await provider.getBalance(wallet.address)
    const reserveWei = BigInt(Math.floor(GAS_RESERVE_ETH * 1e18))
    const wrapAmount = ethBalance - reserveWei

    if (wrapAmount <= 0n) {
      console.log(`[Wrap] ETH balance ${ethers.formatEther(ethBalance)} ETH — below reserve, skipping wrap`)
      return
    }

    const wethAmount = Number(wrapAmount) / 1e18
    console.log(`[Wrap] Wrapping ${wethAmount.toFixed(6)} ETH → WETH (keeping ${GAS_RESERVE_ETH} ETH for gas)`)

    const weth = new Contract(pool.token0.address, WETH_ABI, wallet)
    const tx = await weth.deposit({ value: wrapAmount })
    console.log(`[Wrap] Wrap tx submitted: ${tx.hash}`)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error(`Wrap tx failed: ${tx.hash}`)
    console.log(`[Wrap] ✅ Wrapped ${wethAmount.toFixed(6)} ETH → WETH. tx: ${tx.hash}`)
  }

  // ── Generic exact-input swap with slippage protection ──────────────────────
  private async swapExact(
    pool: PoolConfig,
    tokenIn: { address: string; decimals: number; symbol: string },
    tokenOut: { address: string; decimals: number; symbol: string },
    amountInRaw: bigint,
    token0PriceUsd: number,
  ): Promise<{ receipt: TransactionReceipt; amountOut: bigint }> {
    const wallet = this.getWallet(pool.network)

    // Calculate min output with 1% slippage
    let expectedOut: number
    if (tokenIn.address.toLowerCase() === pool.token1.address.toLowerCase()) {
      // token1 → token0: amountIn (USDC) / price = WETH out
      expectedOut = (Number(amountInRaw) / Math.pow(10, tokenIn.decimals)) / token0PriceUsd
    } else {
      // token0 → token1: amountIn (WETH) * price = USDC out
      expectedOut = (Number(amountInRaw) / Math.pow(10, tokenIn.decimals)) * token0PriceUsd
    }
    const minOut = BigInt(Math.floor(expectedOut * Math.pow(10, tokenOut.decimals) * 0.99))

    console.log(`[Swap] ${tokenIn.symbol} → ${tokenOut.symbol}`)
    console.log(`[Swap]   Amount in:  ${(Number(amountInRaw) / Math.pow(10, tokenIn.decimals)).toFixed(6)} ${tokenIn.symbol}`)
    console.log(`[Swap]   Expected:   ${expectedOut.toFixed(6)} ${tokenOut.symbol}`)
    console.log(`[Swap]   Min out:    ${(Number(minOut) / Math.pow(10, tokenOut.decimals)).toFixed(6)} ${tokenOut.symbol} (1% slippage)`)

    await this.ensureApprovalFor(tokenIn.address, amountInRaw, SWAP_ROUTER, pool.network)

    const router = new Contract(SWAP_ROUTER, SWAP_ROUTER_ABI, wallet)
    const tx = await router.exactInputSingle({
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      fee: pool.feeTier,
      recipient: wallet.address,
      amountIn: amountInRaw,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    })

    console.log(`[Swap] Tx submitted: ${tx.hash}`)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error(`Swap tx failed: ${tx.hash}`)

    // Parse actual amount out from Swap event
    // Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, ...)
    // sender+recipient are indexed (topics), amount0/amount1 are in data
    // Convention: negative amount = tokens leaving the pool (i.e. received by user)
    let amountOut = minOut
    try {
      const swapTopic = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)')
      const swapLog = receipt.logs.find((l: any) => l.topics[0] === swapTopic)
      if (swapLog) {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ['int256', 'int256', 'uint160', 'uint128', 'int24'], swapLog.data
        )
        const amount0 = BigInt(decoded[0].toString())
        const amount1 = BigInt(decoded[1].toString())
        console.log(`[Swap] Event: amount0=${amount0} amount1=${amount1}`)
        const outIsToken0 = tokenOut.address.toLowerCase() === pool.token0.address.toLowerCase()
        const rawOut = outIsToken0 ? -amount0 : -amount1
        if (rawOut > 0n) amountOut = rawOut
        else console.warn(`[Swap] Warning: rawOut=${rawOut} is not positive, falling back to minOut`)
      }
    } catch (e) {
      console.warn(`[Swap] Failed to parse Swap event, using minOut: ${e}`)
    }

    const amountOutHuman = Number(amountOut) / Math.pow(10, tokenOut.decimals)
    console.log(`[Swap] ✅ Received: ${amountOutHuman.toFixed(6)} ${tokenOut.symbol} | tx: ${tx.hash}`)

    return { receipt, amountOut }
  }

  // ── Build SwapMeta for P&L tracking ───────────────────────────────────────
  private buildSwapMeta(
    receipt: TransactionReceipt,
    tokenIn: { symbol: string; decimals: number },
    tokenOut: { symbol: string; decimals: number },
    amountInRaw: bigint,
    amountOutRaw: bigint,
    token0PriceUsd: number,
    isToken0In: boolean,
  ): SwapMeta {
    const amountInHuman = Number(amountInRaw) / Math.pow(10, tokenIn.decimals)
    const amountOutHuman = Number(amountOutRaw) / Math.pow(10, tokenOut.decimals)

    const amountInUsd  = isToken0In ? amountInHuman * token0PriceUsd : amountInHuman
    const amountOutUsd = isToken0In ? amountOutHuman : amountOutHuman * token0PriceUsd

    const priceImpactPct = amountInUsd > 0
      ? ((amountInUsd - amountOutUsd) / amountInUsd) * 100
      : 0

    const gasEth = Number(receipt.gasUsed * (receipt as any).gasPrice) / 1e18
    const gasUsd = gasEth * token0PriceUsd

    console.log(`[Swap] P&L impact: in=$${amountInUsd.toFixed(4)} out=$${amountOutUsd.toFixed(4)} slippage=${priceImpactPct.toFixed(3)}% gas=$${gasUsd.toFixed(5)}`)

    return {
      txHash: receipt.hash,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountInUsd,
      amountOutUsd,
      priceImpactPct,
      gasUsd,
    }
  }

  /**
   * Approve a specific spender (not just NFPM).
   */
  async ensureApprovalFor(tokenAddress: string, amount: bigint, spender: string, network: Network): Promise<void> {
    const wallet = this.getWallet(network)
    const token = new Contract(tokenAddress, ERC20_ABI, wallet)
    const allowance = BigInt((await token.allowance(wallet.address, spender)).toString())
    if (allowance >= amount) return
    console.log(`[Approve] ${tokenAddress.slice(0, 10)}… for ${spender.slice(0, 10)}…`)
    const tx = await token.approve(spender, ethers.MaxUint256)
    await tx.wait()
    console.log(`[Approve] ✅ Confirmed: ${tx.hash}`)
  }

  /**
   * Approve the NonfungiblePositionManager to spend tokens.
   */
  async ensureApproval(tokenAddress: string, amount: bigint, network: Network): Promise<void> {
    const wallet = this.getWallet(network)
    const nfpm = NETWORKS[network]!.nonfungiblePositionManager
    const token = new Contract(tokenAddress, ERC20_ABI, wallet)
    const allowance = BigInt((await token.allowance(wallet.address, nfpm)).toString())
    if (allowance >= amount) return
    console.log(`[Approve] ${tokenAddress.slice(0, 10)}… for NFPM`)
    const tx = await token.approve(nfpm, ethers.MaxUint256)
    await tx.wait()
    console.log(`[Approve] ✅ Confirmed: ${tx.hash}`)
  }

  /**
   * Consolidate wallet to 50/50 WETH/USDC split:
   * 1. Wrap native ETH → WETH (keep gas reserve)
   * 2. Swap all WETH → USDC
   * 3. Swap half of total USDC → WETH
   */
  private async consolidateToUsdc(pool: PoolConfig): Promise<SwapMeta[]> {
    const wallet = this.getWallet(pool.network)
    const provider = rpcClient.getProvider(pool.network)
    const token0Contract = new Contract(pool.token0.address, ERC20_ABI, provider)
    const token1Contract = new Contract(pool.token1.address, ERC20_ABI, provider)
    const results: SwapMeta[] = []

    // Get current price from pool
    const poolContract = new Contract(pool.address, POOL_STATE_ABI, provider)
    const slot0 = await poolContract.slot0()
    const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96.toString())
    const Q96 = 2n ** 96n
    const decAdj = Math.pow(10, pool.token0.decimals - pool.token1.decimals)
    const sqrtPrice = Number(sqrtPriceX96) / Number(Q96)
    const token0PriceUsd = sqrtPrice * sqrtPrice * decAdj
    console.log(`[Consolidate] token0PriceUsd = $${token0PriceUsd.toFixed(2)}`)

    // Step 1: Wrap ETH → WETH
    await this.wrapEthIfNeeded(pool)

    // Step 2: Swap all WETH → USDC
    const wethBal: bigint = await token0Contract.balanceOf(wallet.address).then((b: any) => BigInt(b.toString()))
    const wethHuman = Number(wethBal) / Math.pow(10, pool.token0.decimals)
    const dustThreshold = 0.0001 // ignore dust < 0.0001 WETH

    if (wethHuman > dustThreshold) {
      console.log(`[Consolidate] Swapping ${wethHuman.toFixed(6)} WETH → USDC`)
      const { receipt, amountOut } = await this.swapExact(pool, pool.token0, pool.token1, wethBal, token0PriceUsd)
      results.push(this.buildSwapMeta(receipt, pool.token0, pool.token1, wethBal, amountOut, token0PriceUsd, true))
      console.log(`[Consolidate] ✅ Got ${(Number(amountOut) / Math.pow(10, pool.token1.decimals)).toFixed(4)} USDC from WETH`)
    } else {
      console.log(`[Consolidate] WETH balance ${wethHuman.toFixed(6)} is dust, skipping WETH→USDC swap`)
    }

    // Step 3: Swap half of USDC → WETH
    const usdcBal: bigint = await token1Contract.balanceOf(wallet.address).then((b: any) => BigInt(b.toString()))
    const usdcHuman = Number(usdcBal) / Math.pow(10, pool.token1.decimals)
    const halfUsdc = usdcBal / 2n

    console.log(`[Consolidate] Total USDC: ${usdcHuman.toFixed(4)}, swapping half (${(usdcHuman / 2).toFixed(4)}) → WETH`)
    console.log(`[Consolidate] Wallet address: ${wallet.address}`)

    if (halfUsdc > 0n) {
      const { receipt, amountOut } = await this.swapExact(pool, pool.token1, pool.token0, halfUsdc, token0PriceUsd)
      results.push(this.buildSwapMeta(receipt, pool.token1, pool.token0, halfUsdc, amountOut, token0PriceUsd, false))
      // Read WETH balance immediately after swap to verify
      const wethAfterSwap: bigint = await token0Contract.balanceOf(wallet.address).then((b: any) => BigInt(b.toString()))
      console.log(`[Consolidate] WETH balance immediately after swap: ${(Number(wethAfterSwap) / Math.pow(10, pool.token0.decimals)).toFixed(6)} (raw: ${wethAfterSwap})`)
    }

    // Verify final balances
    const finalWeth: bigint = await token0Contract.balanceOf(wallet.address).then((b: any) => BigInt(b.toString()))
    const finalUsdc: bigint = await token1Contract.balanceOf(wallet.address).then((b: any) => BigInt(b.toString()))
    console.log(`[Consolidate] Final balances: ${(Number(finalWeth) / Math.pow(10, pool.token0.decimals)).toFixed(6)} WETH + ${(Number(finalUsdc) / Math.pow(10, pool.token1.decimals)).toFixed(4)} USDC`)
    if (finalWeth === 0n && finalUsdc === 0n) {
      throw new Error('[Consolidate] Both balances are zero after consolidation — aborting mint')
    }

    return results
  }

  /**
   * Mint a new concentrated liquidity position.
   * Returns tokenId, txHash, and optional swap metadata for P&L tracking.
   */
  async mintPosition(
    pool: PoolConfig,
    range: RangeRecommendation,
    amount0Desired: bigint,
    amount1Desired: bigint,
  ): Promise<{ tokenId: bigint; txHash: string; swapMetas: SwapMeta[]; mintGasUsd: number }> {
    const wallet = this.getWallet(pool.network)
    const nfpmAddress = NETWORKS[pool.network]!.nonfungiblePositionManager
    const provider = rpcClient.getProvider(pool.network)

    console.log(`\n[Mint] ── Starting mint for ${pool.token0.symbol}/${pool.token1.symbol} ──`)
    console.log(`[Mint] Range: tick ${range.tickLower} → ${range.tickUpper}`)

    // ── Step 1: Consolidate everything → 50/50 WETH/USDC ────────────────────
    // Wrap ETH → WETH, then swap all WETH → USDC, then swap half USDC → WETH
    // This gives a predictable 50/50 split every time with minimum complexity.
    const swapMetas = await this.consolidateToUsdc(pool)

    // ── Step 2: Fetch pool state (fresh, post-swap) ───────────────────────────
    const poolContract = new Contract(pool.address, POOL_STATE_ABI, provider)
    const [slot0, liquidityRaw] = await Promise.all([poolContract.slot0(), poolContract.liquidity()])

    const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96.toString())
    const currentTick = Number(slot0.tick)
    const Q96 = 2n ** 96n
    const decAdj = Math.pow(10, pool.token0.decimals - pool.token1.decimals)
    const sqrtPrice = Number(sqrtPriceX96) / Number(Q96)
    const token0PriceUsd = sqrtPrice * sqrtPrice * decAdj

    // ── Step 3: Read wallet balances (after consolidation) ───────────────────
    const token0Contract = new Contract(pool.token0.address, ERC20_ABI, provider)
    const token1Contract = new Contract(pool.token1.address, ERC20_ABI, provider)
    let [bal0, bal1]: [bigint, bigint] = await Promise.all([
      token0Contract.balanceOf(wallet.address).then((b: any) => BigInt(b.toString())),
      token1Contract.balanceOf(wallet.address).then((b: any) => BigInt(b.toString())),
    ])

    const bal0Human = Number(bal0) / Math.pow(10, pool.token0.decimals)
    const bal1Human = Number(bal1) / Math.pow(10, pool.token1.decimals)
    const totalUsd = bal0Human * token0PriceUsd + bal1Human
    console.log(`[Mint] Wallet after consolidation: ${bal0Human.toFixed(6)} ${pool.token0.symbol} + ${bal1Human.toFixed(4)} ${pool.token1.symbol} = $${totalUsd.toFixed(2)}`)

    // ── Step 5: Build Uniswap position ────────────────────────────────────────
    const uniToken0 = new UniToken(this.chainId(pool), pool.token0.address, pool.token0.decimals, pool.token0.symbol)
    const uniToken1 = new UniToken(this.chainId(pool), pool.token1.address, pool.token1.decimals, pool.token1.symbol)

    const uniPool = new Pool(
      uniToken0, uniToken1, pool.feeTier,
      slot0.sqrtPriceX96.toString(), liquidityRaw.toString(), currentTick,
    )

    const position = UniPosition.fromAmounts({
      pool: uniPool,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      amount0: bal0.toString(),
      amount1: bal1.toString(),
      useFullPrecision: true,
    })

    if (position.liquidity.toString() === '0') {
      throw new Error(`Position liquidity is zero — bal0=${bal0} bal1=${bal1} tick=${currentTick} range=${range.tickLower}..${range.tickUpper}`)
    }

    console.log(`[Mint] Position liquidity: ${position.liquidity.toString()}`)

    // ── Step 6: Approve and mint ──────────────────────────────────────────────
    await this.ensureApproval(pool.token0.address, bal0, pool.network)
    await this.ensureApproval(pool.token1.address, bal1, pool.network)

    const { calldata, value } = NonfungiblePositionManager.addCallParameters(position, {
      slippageTolerance: new Percent(50, 10_000), // 0.5%
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    })

    const tx = await wallet.sendTransaction({ to: nfpmAddress, data: calldata, value: BigInt(value) })
    console.log(`[Mint] Tx submitted: ${tx.hash}`)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error(`Mint tx failed: ${tx.hash}`)

    // ── Step 7: Parse tokenId from Transfer event ─────────────────────────────
    const transferTopic = ethers.id('Transfer(address,address,uint256)')
    const zeroAddress = '0x0000000000000000000000000000000000000000000000000000000000000000'
    const transferLog = receipt.logs.find(l =>
      l.address.toLowerCase() === nfpmAddress.toLowerCase() &&
      l.topics[0] === transferTopic &&
      l.topics[1] === zeroAddress
    )
    if (!transferLog || !transferLog.topics[3]) {
      throw new Error(`Mint tx succeeded (${tx.hash}) but could not find Transfer event`)
    }
    const tokenId = BigInt(transferLog.topics[3])

    // ── Step 8: Compute mint gas cost ─────────────────────────────────────────
    const mintGasEth = Number(receipt.gasUsed * (receipt as any).gasPrice) / 1e18
    const mintGasUsd = mintGasEth * token0PriceUsd
    console.log(`[Mint] ✅ TokenId: ${tokenId} | gas: ${mintGasEth.toFixed(6)} ETH ($${mintGasUsd.toFixed(4)}) | tx: ${tx.hash}`)

    return { tokenId, txHash: tx.hash, swapMetas, mintGasUsd }
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

    console.log(`\n[Close] ── Closing position ${tokenId} ──`)

    // Always read real liquidity from NFPM
    const NFPM_ABI_POS = ['function positions(uint256) external view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)']
    const nfpm = new Contract(nfpmAddress, NFPM_ABI_POS, provider)
    const posData = await nfpm.positions(tokenId)
    const realLiquidity: bigint = BigInt(posData[7].toString())
    console.log(`[Close] Liquidity on-chain: ${realLiquidity} (DB had: ${liquidity})`)

    const poolContract = new Contract(pool.address, POOL_STATE_ABI, provider)
    const [slot0, liquidityRaw] = await Promise.all([poolContract.slot0(), poolContract.liquidity()])

    const uniToken0 = new UniToken(this.chainId(pool), pool.token0.address, pool.token0.decimals, pool.token0.symbol)
    const uniToken1 = new UniToken(this.chainId(pool), pool.token1.address, pool.token1.decimals, pool.token1.symbol)
    const uniPool = new Pool(uniToken0, uniToken1, pool.feeTier, slot0.sqrtPriceX96.toString(), liquidityRaw.toString(), Number(slot0.tick))
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
    console.log(`[Close] Tx submitted: ${tx.hash}`)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) throw new Error(`Close tx failed: ${tx.hash}`)

    // Parse Collect event for received amounts
    // Collect(uint256 indexed tokenId, address recipient, uint256 amount0Collect, uint256 amount1Collect)
    // tokenId is indexed → in topics[1]; recipient + amounts are in data
    try {
      const collectTopic = ethers.id('Collect(uint256,address,uint256,uint256)')
      const collectLog = receipt.logs.find(l => l.topics[0] === collectTopic)
      if (collectLog) {
        const [, amount0, amount1] = ethers.AbiCoder.defaultAbiCoder().decode(
          ['address', 'uint256', 'uint256'], collectLog.data
        )
        const a0 = Number(BigInt(amount0.toString())) / Math.pow(10, pool.token0.decimals)
        const a1 = Number(BigInt(amount1.toString())) / Math.pow(10, pool.token1.decimals)
        const gasEth = Number(receipt.gasUsed * (receipt as any).gasPrice) / 1e18
        console.log(`[Close] ✅ Received: ${a0.toFixed(6)} ${pool.token0.symbol} + ${a1.toFixed(4)} ${pool.token1.symbol}`)
        console.log(`[Close]    Gas: ${gasEth.toFixed(6)} ETH | tx: ${tx.hash}`)
      }
    } catch { /* non-critical */ }

    console.log(`[Close] Position ${tokenId} closed. tx: ${tx.hash}`)
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
  ): Promise<{ newTokenId: bigint; closeTxHash: string; mintTxHash: string; swapMetas: SwapMeta[]; mintGasUsd: number }> {
    console.log(`\n[Rebalance] ── Starting rebalance of position ${tokenId} ──`)
    const closeTxHash = await this.closePosition(tokenId, pool, oldTickLower, oldTickUpper, oldLiquidity)
    const { tokenId: newTokenId, txHash: mintTxHash, swapMetas, mintGasUsd } = await this.mintPosition(pool, newRange, amount0, amount1)
    console.log(`[Rebalance] ✅ Done: ${tokenId} → ${newTokenId}`)
    return { newTokenId, closeTxHash, mintTxHash, swapMetas, mintGasUsd }
  }

  /**
   * Estimate gas cost in USD for a rebalance.
   */
  async estimateRebalanceGasUsd(pool: PoolConfig, ethPriceUsd: number): Promise<number> {
    try {
      const provider = rpcClient.getProvider(pool.network)
      const feeData = await provider.getFeeData()
      const gasPrice = feeData.gasPrice ?? 1_000_000_000n
      const gasUnits = 300_000n
      const gasCostEth = Number(gasPrice * gasUnits) / 1e18
      return gasCostEth * ethPriceUsd
    } catch {
      return 2
    }
  }

  private chainId(pool: PoolConfig): number {
    const map: Record<string, number> = { base: 8453, arbitrum: 42161, ethereum: 1 }
    return map[pool.network] ?? 1
  }
}

export const executor = new Executor()
