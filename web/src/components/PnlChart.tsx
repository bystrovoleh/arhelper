import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'

interface Snapshot {
  recorded_at: number
  pnl_usd: number
  fees_usd: number
  il_pct: number
}

export function PnlChart({ snapshots }: { snapshots: Snapshot[] }) {
  if (snapshots.length < 2) {
    return (
      <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)' }}>
        Collecting data…
      </div>
    )
  }

  const data = snapshots.map(s => ({
    t: new Date(s.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    pnl: parseFloat(s.pnl_usd.toFixed(3)),
    fees: parseFloat(s.fees_usd.toFixed(3)),
  }))

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
        <XAxis dataKey="t" tick={{ fill: '#8892a4', fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: '#8892a4', fontSize: 11 }} axisLine={false} tickLine={false} width={50} tickFormatter={v => `$${v}`} />
        <Tooltip
          contentStyle={{ background: '#1a1d27', border: '1px solid #2e3347', borderRadius: 8 }}
          labelStyle={{ color: '#8892a4' }}
          formatter={(v: number, name: string) => [`$${v.toFixed(3)}`, name]}
        />
        <ReferenceLine y={0} stroke="#2e3347" strokeDasharray="3 3" />
        <Line type="monotone" dataKey="pnl" stroke="#3b82f6" dot={false} strokeWidth={2} name="P&L" />
        <Line type="monotone" dataKey="fees" stroke="#22c55e" dot={false} strokeWidth={2} name="Fees" />
      </LineChart>
    </ResponsiveContainer>
  )
}
