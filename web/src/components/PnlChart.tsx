import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts'

interface Snapshot {
  recorded_at: number
  pnl_usd: number
  fees_usd: number
  il_pct: number
  current_price?: number
}

export function PnlChart({ snapshots }: { snapshots: Snapshot[] }) {
  if (snapshots.length < 2) {
    return (
      <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', fontSize: 13 }}>
        Collecting data…
      </div>
    )
  }

  // Downsample if too many points (keep max 200)
  const step = Math.max(1, Math.floor(snapshots.length / 200))
  const sampled = snapshots.filter((_, i) => i % step === 0 || i === snapshots.length - 1)

  const data = sampled.map(s => ({
    t: snapshots.length > 48
      ? new Date(s.recorded_at).toLocaleDateString([], { month: 'short', day: 'numeric' })
      : new Date(s.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    pnl: +s.pnl_usd.toFixed(3),
    fees: +s.fees_usd.toFixed(3),
    il: +s.il_pct.toFixed(3),
  }))

  const hasPrice = snapshots.some(s => s.current_price)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Main chart: P&L + Fees */}
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
          <XAxis dataKey="t" tick={{ fill: '#8892a4', fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fill: '#8892a4', fontSize: 10 }} axisLine={false} tickLine={false} width={52} tickFormatter={v => `$${v}`} />
          <Tooltip
            contentStyle={{ background: '#1a1d27', border: '1px solid #2e3347', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#8892a4' }}
            formatter={(v: number, name: string) => [`$${v.toFixed(3)}`, name]}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
            formatter={(value) => <span style={{ color: 'var(--text2)' }}>{value}</span>}
          />
          <ReferenceLine y={0} stroke="#2e3347" strokeDasharray="3 3" />
          <Line type="monotone" dataKey="pnl" stroke="#3b82f6" dot={false} strokeWidth={2} name="P&L" />
          <Line type="monotone" dataKey="fees" stroke="#22c55e" dot={false} strokeWidth={2} name="Fees" />
        </LineChart>
      </ResponsiveContainer>

      {/* IL chart */}
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={data} margin={{ top: 0, right: 5, bottom: 0, left: 0 }}>
          <XAxis dataKey="t" hide />
          <YAxis tick={{ fill: '#8892a4', fontSize: 10 }} axisLine={false} tickLine={false} width={52} tickFormatter={v => `${v}%`} />
          <Tooltip
            contentStyle={{ background: '#1a1d27', border: '1px solid #2e3347', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#8892a4' }}
            formatter={(v: number) => [`${v.toFixed(3)}%`, 'IL']}
          />
          <ReferenceLine y={0} stroke="#2e3347" strokeDasharray="3 3" />
          <Line type="monotone" dataKey="il" stroke="#ef4444" dot={false} strokeWidth={1.5} name="IL%" />
        </LineChart>
      </ResponsiveContainer>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text2)', paddingLeft: 52 }}>
        <span>IL%</span>
        <span>{snapshots.length} snapshots</span>
      </div>
    </div>
  )
}
