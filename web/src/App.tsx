import { useState } from 'react'
import { RefreshCw, TrendingUp, Activity, List, BarChart2, FlaskConical } from 'lucide-react'
import { useApi, apiPost } from './hooks/useApi'
import { StatCard } from './components/StatCard'
import { PositionCard } from './components/PositionCard'
import { PoolTable } from './components/PoolTable'
import { EventLog } from './components/EventLog'
import { PnlChart } from './components/PnlChart'
import { RegimeCard } from './components/RegimeCard'
import { LiquidityHeatmap } from './components/LiquidityHeatmap'
import { InRangeStatsCard } from './components/InRangeStats'

const POOL_ADDRESS = '0xC6962004f452bE9203591991D15f6b388e09E8D0'

type Tab = 'overview' | 'positions' | 'pools' | 'analytics' | 'log'

const S = {
  app: { minHeight: '100vh', background: 'var(--bg)' } as React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 32px', height: 56,
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg2)',
    position: 'sticky', top: 0, zIndex: 10,
  } as React.CSSProperties,
  logo: { fontWeight: 700, fontSize: 16, letterSpacing: '-0.02em', color: '#fff' } as React.CSSProperties,
  badge: {
    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
    background: 'rgba(34,197,94,0.15)', color: 'var(--green)', border: '1px solid rgba(34,197,94,0.3)',
    marginLeft: 10,
  } as React.CSSProperties,
  nav: { display: 'flex', gap: 4 } as React.CSSProperties,
  navBtn: (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
    fontSize: 13, fontWeight: 500,
    background: active ? 'var(--bg3)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text2)',
  }),
  main: { padding: '24px 32px', maxWidth: 1400, margin: '0 auto' } as React.CSSProperties,
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 24 } as React.CSSProperties,
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 } as React.CSSProperties,
  card: {
    background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20,
  } as React.CSSProperties,
  sectionTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.06em' } as React.CSSProperties,
}

export default function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [opening, setOpening] = useState(false)

  const { data: stats, refetch: refetchStats } = useApi<any>('/api/stats', 30_000)
  const { data: positions } = useApi<any[]>('/api/positions', 30_000)
  const { data: pools } = useApi<any[]>('/api/pools', 120_000)
  const { data: events } = useApi<any[]>('/api/events?limit=100', 30_000)

  // Snapshots for the first open position
  const firstOpen = positions?.find((p: any) => p.status === 'open')
  const { data: posDetail } = useApi<any>(
    firstOpen ? `/api/positions/${firstOpen.token_id}` : '/api/stats',
    15_000
  )
  const snapshots = posDetail?.snapshots ?? []

  // Analytics data (only fetch when on analytics tab)
  const { data: regime } = useApi<any>(
    tab === 'analytics' ? `/api/pools/${POOL_ADDRESS}/regime` : '/api/stats',
    60_000
  )
  const { data: liquidityData } = useApi<any>(
    tab === 'analytics' ? `/api/pools/${POOL_ADDRESS}/liquidity` : '/api/stats',
    120_000
  )
  const { data: rebalanceDecisionData } = useApi<any>(
    tab === 'analytics' && firstOpen ? `/api/positions/${firstOpen.token_id}/rebalance-decision` : '/api/stats',
    5 * 60_000  // 5 min — matches server cache TTL
  )

  async function openPaperPosition() {
    if (!pools || pools.length === 0) return
    setOpening(true)
    try {
      await apiPost('/api/paper/open', { poolAddress: pools[0].address, capitalUsd: 1000 })
      refetchStats()
    } finally {
      setOpening(false)
    }
  }

  const pnl = stats?.totalPnlUsd ?? 0
  const fees = stats?.totalFeesUsd ?? 0

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <BarChart2 size={14} /> },
    { id: 'positions', label: `Positions (${stats?.openPositions ?? 0})`, icon: <TrendingUp size={14} /> },
    { id: 'pools', label: 'Pools', icon: <Activity size={14} /> },
    { id: 'analytics', label: 'Analytics', icon: <FlaskConical size={14} /> },
    { id: 'log', label: 'Event Log', icon: <List size={14} /> },
  ]

  return (
    <div style={S.app}>
      {/* Header */}
      <header style={S.header}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={S.logo}>crhelper</span>
          <span style={S.badge}>PAPER</span>
        </div>
        <nav style={S.nav}>
          {tabs.map(t => (
            <button key={t.id} style={S.navBtn(tab === t.id)} onClick={() => setTab(t.id)}>
              {t.icon}{t.label}
            </button>
          ))}
        </nav>
        <button
          onClick={openPaperPosition}
          disabled={opening}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: 'var(--green)', color: '#000', fontSize: 13, fontWeight: 600,
            opacity: opening ? 0.6 : 1,
          }}
        >
          <RefreshCw size={13} />
          {opening ? 'Opening…' : 'Open $1K Position'}
        </button>
      </header>

      <main style={S.main}>
        {/* ── Overview ─────────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <>
            <div style={S.grid4}>
              <StatCard
                label="Active Position"
                value={firstOpen ? `${firstOpen.token0_symbol}/${firstOpen.token1_symbol}` : '—'}
                sub={firstOpen
                  ? (() => {
                      const h = (Date.now() - firstOpen.opened_at) / 3_600_000
                      const d = Math.floor(h / 24), rh = Math.floor(h % 24)
                      return d > 0 ? `${d}d ${rh}h running` : `${rh}h running`
                    })()
                  : 'No position'}
                color="blue"
              />
              <StatCard
                label="Fees Earned"
                value={`$${fees.toFixed(4)}`}
                sub={firstOpen
                  ? (() => {
                      const ageHours = (Date.now() - firstOpen.opened_at) / 3_600_000
                      if (ageHours < 1) return 'accumulating…'
                      return `$${((fees / ageHours) * 24).toFixed(4)}/day`
                    })()
                  : '—'}
                color="green"
              />
              <StatCard
                label="Total P&L"
                value={`${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`}
                sub={firstOpen
                  ? (firstOpen.in_range == null ? '…'
                    : firstOpen.in_range ? '✓ In range' : '✗ Out of range')
                  : ''}
                color={pnl >= 0 ? 'green' : 'red'}
              />
              <StatCard
                label="IL / Rebalances"
                value={firstOpen?.il_pct != null ? `${(firstOpen.il_pct as number).toFixed(3)}%` : '—'}
                sub={`${stats?.rebalances ?? 0} rebalances total`}
                color={firstOpen?.il_pct != null && (firstOpen.il_pct as number) < -1 ? 'red' : 'default'}
              />
            </div>

            <div style={S.grid2}>
              <div style={S.card}>
                <div style={S.sectionTitle}>P&L Over Time</div>
                <PnlChart snapshots={snapshots} />
              </div>
              <div style={S.card}>
                <div style={S.sectionTitle}>Active Position</div>
                {firstOpen
                  ? <PositionCard pos={firstOpen} />
                  : <div style={{ color: 'var(--text2)', textAlign: 'center', padding: 40 }}>
                      No open positions — click "Open $1K Position"
                    </div>
                }
              </div>
            </div>

            {/* Rebalance history */}
            {(positions ?? []).filter((p: any) => p.status === 'rebalanced').length > 0 && (
              <div style={S.card}>
                <div style={S.sectionTitle}>Rebalance History</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--text2)', textAlign: 'left' }}>
                      {['Pair', 'Opened', 'Closed', 'Age', 'P&L', 'Fees'].map(h => (
                        <th key={h} style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontWeight: 500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(positions ?? []).filter((p: any) => p.status === 'rebalanced').slice(0, 10).map((p: any) => {
                      const ageH = p.closed_at ? ((p.closed_at - p.opened_at) / 3_600_000).toFixed(1) : '—'
                      const pnl = p.pnl_usd ?? 0
                      return (
                        <tr key={p.token_id} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '8px 10px', color: 'var(--text)' }}>{p.token0_symbol}/{p.token1_symbol}</td>
                          <td style={{ padding: '8px 10px', color: 'var(--text2)' }}>{new Date(p.opened_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                          <td style={{ padding: '8px 10px', color: 'var(--text2)' }}>{p.closed_at ? new Date(p.closed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                          <td style={{ padding: '8px 10px', color: 'var(--text2)' }}>{ageH}h</td>
                          <td style={{ padding: '8px 10px', color: pnl >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}</td>
                          <td style={{ padding: '8px 10px', color: 'var(--green)' }}>${(p.fees_usd ?? 0).toFixed(4)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div style={S.card}>
              <div style={S.sectionTitle}>Recent Events</div>
              <EventLog events={(events ?? []).slice(0, 15)} />
            </div>
          </>
        )}

        {/* ── Positions ────────────────────────────────────────────────── */}
        {tab === 'positions' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {(positions ?? []).length === 0 && (
              <div style={{ ...S.card, textAlign: 'center', color: 'var(--text2)', padding: 60 }}>
                No positions yet
              </div>
            )}
            {(positions ?? []).map((p: any) => <PositionCard key={p.token_id} pos={p} />)}
          </div>
        )}

        {/* ── Pools ────────────────────────────────────────────────────── */}
        {tab === 'pools' && (
          <div style={S.card}>
            <div style={S.sectionTitle}>Watched Pools</div>
            {pools ? <PoolTable pools={pools} /> : <div style={{ color: 'var(--text2)' }}>Loading…</div>}
          </div>
        )}

        {/* ── Analytics ────────────────────────────────────────────────── */}
        {tab === 'analytics' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Volatility Regime */}
            {regime && regime.regime
              ? <RegimeCard regime={regime} />
              : <div style={{ ...S.card, color: 'var(--text2)' }}>Collecting regime data… (need a few minutes of snapshots)</div>
            }

            {/* Liquidity Heatmap */}
            <div style={S.card}>
              <div style={S.sectionTitle}>Liquidity Distribution</div>
              <LiquidityHeatmap
                buckets={liquidityData?.buckets ?? []}
                currentPrice={liquidityData?.currentPrice ?? 0}
                positionPriceLower={firstOpen ? Math.pow(1.0001, firstOpen.tick_lower) * 1e12 : undefined}
                positionPriceUpper={firstOpen ? Math.pow(1.0001, firstOpen.tick_upper) * 1e12 : undefined}
              />
            </div>

            {/* In-Range Stats + Rebalance Decision */}
            {firstOpen && rebalanceDecisionData?.inRangeStats && (
              <div style={S.card}>
                <div style={S.sectionTitle}>Position Analysis</div>
                <InRangeStatsCard
                  stats={rebalanceDecisionData.inRangeStats}
                  decision={rebalanceDecisionData.decision}
                />
              </div>
            )}

            {!firstOpen && (
              <div style={{ ...S.card, color: 'var(--text2)', textAlign: 'center', padding: 40 }}>
                Open a position to see position analysis
              </div>
            )}
          </div>
        )}

        {/* ── Event Log ────────────────────────────────────────────────── */}
        {tab === 'log' && (
          <div style={S.card}>
            <div style={S.sectionTitle}>Full Event Log</div>
            <EventLog events={events ?? []} />
          </div>
        )}
      </main>
    </div>
  )
}
