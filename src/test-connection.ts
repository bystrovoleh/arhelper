import dotenv from 'dotenv'
dotenv.config()

import { rpcClient } from './data-layer/rpc-client'
import { geckoTerminalClient } from './data-layer/geckoterminal-client'

const WETH_USDC_BASE = '0xd0b53D9277642d899DF5C87A3966A349A798F224'

async function main() {
  console.log('=== Testing connections ===\n')

  // ── 1. Alchemy RPC — fetch pool state via Multicall3
  console.log('1. Alchemy RPC (Base) — fetching WETH/USDC pool state...')
  try {
    // token0=WETH (18 decimals), token1=USDC (6 decimals)
    const state = await rpcClient.fetchPoolState(WETH_USDC_BASE, 'base', 18, 6)
    const ethPrice = state.token0Price  // USDC per WETH
    console.log(`   ✓ Connected`)
    console.log(`   Current tick:     ${state.tick}`)
    console.log(`   ETH price (USDC): $${ethPrice.toFixed(2)}`)
    console.log(`   In-range liq:     ${state.liquidity.toString()}`)
    console.log(`   Fetched at:       ${new Date(state.fetchedAt).toISOString()}\n`)
  } catch (err) {
    console.error('   ✗ RPC failed:', err)
  }

  // ── 2. GeckoTerminal — market data
  console.log('2. GeckoTerminal — fetching WETH/USDC market data...')
  try {
    const market = await geckoTerminalClient.fetchPool(WETH_USDC_BASE, 'base')
    if (market) {
      console.log(`   ✓ Connected`)
      console.log(`   TVL:       $${(market.tvlUsd / 1_000_000).toFixed(2)}M`)
      console.log(`   Vol 24h:   $${(market.volumeUsd24h / 1_000_000).toFixed(2)}M`)
      console.log(`   APY est:   ${market.apyBase.toFixed(1)}%\n`)
    }
  } catch (err) {
    console.error('   ✗ GeckoTerminal failed:', err)
  }

  // ── 3. Block number — sanity check
  console.log('3. Latest block number on Base...')
  try {
    const block = await rpcClient.getBlockNumber('base')
    console.log(`   ✓ Block: ${block}\n`)
  } catch (err) {
    console.error('   ✗ Block fetch failed:', err)
  }

  console.log('=== Done ===')
}

main().catch(console.error)
