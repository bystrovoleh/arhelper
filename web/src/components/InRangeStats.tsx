interface InRangeStats {
  inRangePct: number
  avgHoursInRange: number
  outOfRangeEvents: number
  recommendedRangePct: number
}

interface RebalanceDecision {
  shouldRebalance: boolean
  reason: string
  feesLostPerHourUsd: number
  gasCostUsd: number
  breakEvenHours: number
  netBenefitUsd: number
}

export function InRangeStatsCard({ stats, decision }: { stats: InRangeStats; decision?: RebalanceDecision }) {
  const pct = stats.inRangePct * 100

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* In-range time gauge */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>Historical in-range time</span>
          <span style={{ fontWeight: 700, color: pct >= 70 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)' }}>
            {pct.toFixed(1)}%
          </span>
        </div>
        <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 3 }}>
          <div style={{
            height: '100%', borderRadius: 3,
            width: `${Math.min(pct, 100)}%`,
            background: pct >= 70 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)',
            transition: 'width 0.5s',
          }} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
        {[
          { label: 'Avg hours in range', value: stats.avgHoursInRange > 0 ? `${stats.avgHoursInRange.toFixed(1)}h` : '—' },
          { label: 'Out-of-range events', value: stats.outOfRangeEvents.toString() },
          { label: 'Recommended ±%', value: `±${(stats.recommendedRangePct * 100).toFixed(1)}%` },
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg3)', borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ color: 'var(--text2)', fontSize: 10, marginBottom: 3 }}>{s.label}</div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Gas-adjusted rebalance decision */}
      {decision && (
        <div style={{
          background: decision.shouldRebalance ? 'rgba(34,197,94,0.08)' : 'rgba(136,146,164,0.08)',
          border: `1px solid ${decision.shouldRebalance ? 'rgba(34,197,94,0.25)' : 'var(--border)'}`,
          borderRadius: 8, padding: '10px 14px',
        }}>
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4, color: decision.shouldRebalance ? 'var(--green)' : 'var(--text2)' }}>
            {decision.shouldRebalance ? '⚡ Rebalance recommended' : '✓ Hold position'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.5 }}>{decision.reason}</div>
          {decision.breakEvenHours < 100 && (
            <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
              Break-even: <span style={{ fontWeight: 600, color: 'var(--text)' }}>{decision.breakEvenHours.toFixed(1)}h</span>
              {' · '}Fees/hr: <span style={{ fontWeight: 600, color: 'var(--green)' }}>${decision.feesLostPerHourUsd.toFixed(3)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
