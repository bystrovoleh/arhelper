interface RegimeAnalysis {
  regime: 'ranging' | 'trending' | 'breakout' | 'unknown'
  adx: number
  realizedVol24h: number
  realizedVol7d: number
  recommendedRangePct: number
  description: string
}

const REGIME_COLORS = {
  ranging: { bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.3)', text: '#22c55e', label: 'RANGING' },
  trending: { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)', text: '#f59e0b', label: 'TRENDING' },
  breakout: { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.3)', text: '#ef4444', label: 'BREAKOUT' },
  unknown: { bg: 'rgba(136,146,164,0.12)', border: 'rgba(136,146,164,0.3)', text: '#8892a4', label: 'UNKNOWN' },
}

export function RegimeCard({ regime }: { regime: RegimeAnalysis }) {
  const c = REGIME_COLORS[regime.regime]

  return (
    <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Volatility Regime
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 99, background: c.bg, color: c.text, border: `1px solid ${c.border}` }}>
          {c.label}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'ADX', value: regime.adx.toFixed(0), sub: regime.adx > 25 ? 'trending' : 'ranging' },
          { label: 'Vol 24h', value: `${regime.realizedVol24h.toFixed(1)}%`, sub: 'annualised' },
          { label: 'Vol 7d', value: `${regime.realizedVol7d.toFixed(1)}%`, sub: 'annualised' },
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontWeight: 700, fontSize: 18, color: c.text }}>{s.value}</div>
            <div style={{ color: 'var(--text2)', fontSize: 11 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
        <span style={{ color: 'var(--text2)', fontSize: 12 }}>{regime.description}</span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: 'var(--text2)', fontSize: 12 }}>Recommended range</span>
        <span style={{ fontWeight: 700, color: c.text, fontSize: 16 }}>
          ±{(regime.recommendedRangePct * 100).toFixed(1)}%
        </span>
      </div>
    </div>
  )
}
