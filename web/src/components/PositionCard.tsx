import { useState } from 'react'
import { apiPost } from '../hooks/useApi'

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
  token0_amount?: number
  token1_amount?: number
  current_token0_amount?: number
  current_token1_amount?: number
  swap_costs_usd?: number
  gas_costs_usd?: number
  swap_count?: number
}

const tickToPrice = (tick: number) => Math.pow(1.0001, tick) * 1e12

function RangeBar({ tickLower, tickUpper, currentTick, currentPrice }: {
  tickLower: number; tickUpper: number; currentTick: number; currentPrice?: number
}) {
  const total = tickUpper - tickLower
  const pos = Math.max(0, Math.min(1, (currentTick - tickLower) / total))
  const inRange = currentTick >= tickLower && currentTick < tickUpper
  const priceLower = tickToPrice(tickLower)
  const priceUpper = tickToPrice(tickUpper)
  const rangeWidthPct = ((priceUpper / priceLower - 1) * 100).toFixed(1)

  // How far from boundaries (% of range)
  const distFromLower = currentPrice ? ((currentPrice - priceLower) / (priceUpper - priceLower) * 100).toFixed(0) : null
  const distFromUpper = currentPrice ? ((priceUpper - currentPrice) / (priceUpper - priceLower) * 100).toFixed(0) : null

  return (
    <div style={{ margin: '14px 0 4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text2)', marginBottom: 6 }}>
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text)' }}>${priceLower.toFixed(0)}</div>
          <div style={{ marginTop: 2 }}>lower</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: inRange ? 'var(--green)' : 'var(--red)', fontWeight: 700, fontSize: 12 }}>
            {inRange ? '● IN RANGE' : '○ OUT OF RANGE'}
          </div>
          {currentPrice && (
            <div style={{ color: 'var(--blue)', fontSize: 13, fontWeight: 600, marginTop: 2 }}>
              ${currentPrice.toFixed(2)}
            </div>
          )}
          <div style={{ color: 'var(--text2)', fontSize: 10, marginTop: 2 }}>
            range width {rangeWidthPct}%
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 600, color: 'var(--text)' }}>${priceUpper.toFixed(0)}</div>
          <div style={{ marginTop: 2 }}>upper</div>
        </div>
      </div>

      <div style={{ height: 8, background: 'var(--bg3)', borderRadius: 4, position: 'relative', marginTop: 4 }}>
        <div style={{
          position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
          background: inRange ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.12)',
          borderRadius: 4,
        }} />
        <div style={{
          position: 'absolute', top: -4, width: 16, height: 16,
          background: inRange ? 'var(--green)' : 'var(--red)',
          borderRadius: '50%', left: `calc(${pos * 100}% - 8px)`,
          border: '2px solid var(--bg2)',
          boxShadow: `0 0 6px ${inRange ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)'}`,
        }} />
      </div>

      {inRange && distFromLower && distFromUpper && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text2)', marginTop: 6 }}>
          <span>{distFromLower}% from lower</span>
          <span>{distFromUpper}% from upper</span>
        </div>
      )}
    </div>
  )
}

export function PositionCard({ pos }: { pos: Position }) {
  const pnl = pos.pnl_usd ?? 0
  const fees = pos.fees_usd ?? 0
  const il = pos.il_pct ?? 0
  const swapCosts = pos.swap_costs_usd ?? 0
  const gasCosts = pos.gas_costs_usd ?? 0
  const netPnl = pnl - swapCosts - gasCosts
  const ageMs = Date.now() - pos.opened_at
  const ageHours = ageMs / 3_600_000
  const ageDays = Math.floor(ageHours / 24)
  const ageRemHours = Math.floor(ageHours % 24)
  const ageLabel = ageDays > 0 ? `${ageDays}d ${ageRemHours}h` : `${Math.floor(ageHours)}h`

  const feesPerDay = ageHours > 1 ? (fees / ageHours) * 24 : null
  const pnlPct = pos.entry_price_usd > 0 ? (pnl / pos.entry_price_usd) * 100 : 0
  const feesPct = pos.entry_price_usd > 0 ? (fees / pos.entry_price_usd) * 100 : 0

  const DECIMAL_ADJ = 1e12
  const currentTick = pos.current_price
    ? Math.floor(Math.log(pos.current_price / DECIMAL_ADJ) / Math.log(1.0001))
    : (pos.tick_lower + pos.tick_upper) / 2

  const priceLower = tickToPrice(pos.tick_lower)
  const priceUpper = tickToPrice(pos.tick_upper)
  const priceChangeFromEntry = pos.entry_price && pos.current_price
    ? ((pos.current_price - pos.entry_price) / pos.entry_price * 100)
    : null

  const isOpen = pos.status === 'open'
  const [closing, setClosing] = useState(false)

  async function handleClose() {
    if (!confirm(`Close position ${pos.token_id}? This will send a real transaction.`)) return
    setClosing(true)
    try {
      await apiPost(`/api/positions/${pos.token_id}/close`, {})
      window.location.reload()
    } finally {
      setClosing(false)
    }
  }

  return (
    <div style={{
      background: 'var(--bg2)',
      border: `1px solid ${isOpen ? (pos.in_range ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)') : 'var(--border)'}`,
      borderRadius: 12,
      padding: 20,
      opacity: isOpen ? 1 : 0.7,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 16 }}>
              {pos.token0_symbol}/{pos.token1_symbol}
            </span>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
              background: isOpen ? 'rgba(34,197,94,0.15)' : 'rgba(100,100,100,0.15)',
              color: isOpen ? 'var(--green)' : 'var(--text2)',
              border: `1px solid ${isOpen ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
            }}>
              {pos.status.toUpperCase()}
            </span>
          </div>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginTop: 3 }}>
            {pos.protocol} · {pos.network} · opened {ageLabel} ago
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} USD
          </div>
          <div style={{ color: 'var(--text2)', fontSize: 12, marginTop: 1 }}>
            {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}% on capital
          </div>
          {isOpen && (
            <button
              onClick={handleClose}
              disabled={closing}
              style={{
                marginTop: 8, padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.4)',
                background: 'rgba(239,68,68,0.1)', color: 'var(--red)', fontSize: 11,
                fontWeight: 600, cursor: 'pointer', opacity: closing ? 0.6 : 1,
              }}
            >
              {closing ? 'Closing…' : 'Close Position'}
            </button>
          )}
        </div>
      </div>

      {/* Range bar */}
      <RangeBar
        tickLower={pos.tick_lower}
        tickUpper={pos.tick_upper}
        currentTick={currentTick}
        currentPrice={pos.current_price}
      />

      {/* Stats grid — row 1: P&L breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginTop: 16 }}>
        {[
          {
            label: 'Fees Earned',
            value: `+$${fees.toFixed(4)}`,
            sub: feesPerDay != null ? `$${feesPerDay.toFixed(4)}/day` : 'accumulating…',
            color: 'var(--green)',
          },
          {
            label: 'Swap Costs',
            value: swapCosts > 0 ? `-$${swapCosts.toFixed(4)}` : '$0',
            sub: pos.swap_count ? `${pos.swap_count} swap${pos.swap_count > 1 ? 's' : ''}` : 'no swaps',
            color: swapCosts > 0 ? 'var(--red)' : 'var(--text2)',
          },
          {
            label: 'Gas Costs',
            value: gasCosts > 0 ? `-$${gasCosts.toFixed(4)}` : '$0',
            sub: 'tx fees',
            color: 'var(--text2)',
          },
          {
            label: 'Net P&L',
            value: `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(4)}`,
            sub: 'after all costs',
            color: netPnl >= 0 ? 'var(--green)' : 'var(--red)',
          },
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontWeight: 600, color: s.color, fontSize: 14 }}>{s.value}</div>
            {s.sub && <div style={{ color: 'var(--text2)', fontSize: 10, marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Stats grid — row 2: position metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginTop: 10 }}>
        {[
          {
            label: 'Fees %',
            value: `${feesPct.toFixed(3)}%`,
            sub: feesPerDay != null ? `${(feesPct / ageHours * 24).toFixed(3)}%/day` : '',
            color: 'var(--green)',
          },
          {
            label: 'Imp. Loss',
            value: `${il.toFixed(3)}%`,
            sub: 'vs holding',
            color: il < -1 ? 'var(--red)' : 'var(--text2)',
          },
          {
            label: 'Price Change',
            value: priceChangeFromEntry != null ? `${priceChangeFromEntry >= 0 ? '+' : ''}${priceChangeFromEntry.toFixed(2)}%` : '—',
            sub: `entry $${pos.entry_price.toFixed(0)}`,
            color: priceChangeFromEntry != null && priceChangeFromEntry >= 0 ? 'var(--green)' : 'var(--red)',
          },
          {
            label: 'APY Est.',
            value: ageHours > 1 && fees > 0 && pos.entry_price_usd > 0
              ? `${((fees / ageHours * 24 * 365 / pos.entry_price_usd) * 100).toFixed(1)}%`
              : '—',
            sub: ageHours > 1 ? `based on ${ageHours.toFixed(1)}h` : 'accumulating…',
            color: 'var(--green)',
          },
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontWeight: 600, color: s.color, fontSize: 14 }}>{s.value}</div>
            {s.sub && <div style={{ color: 'var(--text2)', fontSize: 10, marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Third stats row: position value / composition / range */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginTop: 10 }}>
        {[
          {
            label: 'Position Value',
            value: pos.current_price
              ? `$${((pos.current_token0_amount ?? pos.token0_amount ?? 0) * pos.current_price + (pos.current_token1_amount ?? pos.token1_amount ?? 0) + fees).toFixed(2)}`
              : '—',
            sub: `entry $${pos.entry_price_usd.toFixed(2)}`,
            color: 'var(--text)',
          },
          {
            label: 'Composition',
            value: (() => {
              const t0 = pos.current_token0_amount ?? pos.token0_amount
              const t1 = pos.current_token1_amount ?? pos.token1_amount
              if (!pos.current_price || t0 == null || t1 == null) return '—'
              const v0 = t0 * pos.current_price
              const v1 = t1
              const total = v0 + v1
              return total > 0 ? `${(v0/total*100).toFixed(0)}% / ${(v1/total*100).toFixed(0)}%` : '—'
            })(),
            sub: `${pos.token0_symbol} / ${pos.token1_symbol}`,
            color: 'var(--text2)',
          },
          {
            label: 'Range Width',
            value: `±${((priceUpper / priceLower - 1) * 50 * 100).toFixed(1)}%`,
            sub: `$${priceLower.toFixed(0)} – $${priceUpper.toFixed(0)}`,
            color: 'var(--text2)',
          },
          {
            label: 'Gross P&L',
            value: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}`,
            sub: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% on capital`,
            color: pnl >= 0 ? 'var(--green)' : 'var(--red)',
          },
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontWeight: 600, color: s.color, fontSize: 14 }}>{s.value}</div>
            {s.sub && <div style={{ color: 'var(--text2)', fontSize: 10, marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* P&L breakdown + Range info */}
      <div style={{
        display: 'flex', gap: 16, marginTop: 12, padding: '10px 12px',
        background: 'var(--bg3)', borderRadius: 8, fontSize: 12, flexWrap: 'wrap',
      }}>
        <span style={{ color: 'var(--text2)' }}>Fees: <span style={{ color: 'var(--green)', fontWeight: 600 }}>+${fees.toFixed(4)}</span></span>
        <span style={{ color: 'var(--text2)' }}>Swaps: <span style={{ color: swapCosts > 0 ? 'var(--red)' : 'var(--text2)', fontWeight: 600 }}>-${swapCosts.toFixed(4)}</span></span>
        <span style={{ color: 'var(--text2)' }}>Gas: <span style={{ color: 'var(--text2)', fontWeight: 600 }}>-${gasCosts.toFixed(4)}</span></span>
        <span style={{ color: 'var(--text2)' }}>Net: <span style={{ color: netPnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)}</span></span>
        <span style={{ color: 'var(--text2)', marginLeft: 'auto' }}>Capital: <span style={{ color: 'var(--text)', fontWeight: 600 }}>${pos.entry_price_usd.toFixed(0)}</span></span>
        <span style={{ color: 'var(--text2)' }}>ID: <span style={{ color: 'var(--text)', fontWeight: 600 }}>{pos.token_id}</span></span>
      </div>
    </div>
  )
}
