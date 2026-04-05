interface Position {
  token_id: string
  token0_symbol: string
  token1_symbol: string
  protocol: string
  network: string
  tick_lower: number
  tick_upper: number
  entry_price: number
  entry_price_usd: number
  opened_at: number
  status: string
  current_price?: number
  fees_usd?: number
  il_pct?: number
  pnl_usd?: number
  in_range?: number
}

// WETH(18)/USDC(6): price = 1.0001^tick * 10^(18-6) = 1.0001^tick * 1e12
const tickToPrice = (tick: number) => Math.pow(1.0001, tick) * 1e12

function RangeBar({ tickLower, tickUpper, currentTick, currentPrice }: {
  tickLower: number; tickUpper: number; currentTick: number; currentPrice?: number
}) {
  const total = tickUpper - tickLower
  const pos = Math.max(0, Math.min(1, (currentTick - tickLower) / total))
  const inRange = currentTick >= tickLower && currentTick < tickUpper
  const priceLower = tickToPrice(tickLower)
  const priceUpper = tickToPrice(tickUpper)

  return (
    <div style={{ margin: '12px 0 4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text2)', marginBottom: 4 }}>
        <span>${priceLower.toFixed(0)}</span>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
          <span style={{ color: inRange ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
            {inRange ? 'IN RANGE' : 'OUT OF RANGE'}
          </span>
          {currentPrice && (
            <span style={{ color: 'var(--blue)', fontSize: 10 }}>${currentPrice.toFixed(2)}</span>
          )}
        </div>
        <span>${priceUpper.toFixed(0)}</span>
      </div>
      <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 3, position: 'relative' }}>
        <div style={{
          position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
          background: inRange ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.15)',
          borderRadius: 3,
        }} />
        <div style={{
          position: 'absolute', top: -3, width: 12, height: 12,
          background: inRange ? 'var(--green)' : 'var(--red)',
          borderRadius: '50%', left: `calc(${pos * 100}% - 6px)`,
          border: '2px solid var(--bg2)',
        }} />
      </div>
    </div>
  )
}

export function PositionCard({ pos }: { pos: Position }) {
  const pnl = pos.pnl_usd ?? 0
  const fees = pos.fees_usd ?? 0
  const il = pos.il_pct ?? 0
  const age = Math.floor((Date.now() - pos.opened_at) / 3600_000)

  // Approximate current tick from current price
  const currentTick = pos.current_price
    ? Math.floor(Math.log(pos.current_price) / Math.log(1.0001))
    : (pos.tick_lower + pos.tick_upper) / 2

  return (
    <div style={{
      background: 'var(--bg2)',
      border: `1px solid ${pos.in_range ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
      borderRadius: 12,
      padding: 20,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 16 }}>
            {pos.token0_symbol}/{pos.token1_symbol}
          </div>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginTop: 2 }}>
            {pos.protocol} · {pos.network} · {age}h ago
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontSize: 18, fontWeight: 600,
            color: pnl >= 0 ? 'var(--green)' : 'var(--red)',
          }}>
            {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} USD
          </div>
          <div style={{ color: 'var(--text2)', fontSize: 12 }}>P&L</div>
        </div>
      </div>

      {/* Range bar */}
      <RangeBar tickLower={pos.tick_lower} tickUpper={pos.tick_upper} currentTick={currentTick} currentPrice={pos.current_price} />

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginTop: 16 }}>
        {[
          { label: 'Fees earned', value: `$${fees.toFixed(3)}`, color: 'var(--green)' },
          { label: 'Imp. Loss', value: `${il.toFixed(2)}%`, color: il < -1 ? 'var(--red)' : 'var(--text2)' },
          { label: 'Capital', value: `$${pos.entry_price_usd.toFixed(0)}`, color: 'var(--text)' },
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontWeight: 600, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Token ID */}
      <div style={{ marginTop: 12, color: 'var(--text2)', fontSize: 11 }}>
        ID: {pos.token_id}
      </div>
    </div>
  )
}
