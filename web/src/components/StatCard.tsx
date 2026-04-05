interface Props {
  label: string
  value: string | number
  sub?: string
  color?: 'green' | 'red' | 'yellow' | 'blue' | 'default'
}

const colors = {
  green: '#22c55e',
  red: '#ef4444',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  default: '#e2e8f0',
}

export function StatCard({ label, value, sub, color = 'default' }: Props) {
  return (
    <div style={{
      background: 'var(--bg2)',
      border: '1px solid var(--border)',
      borderRadius: 12,
      padding: '20px 24px',
    }}>
      <div style={{ color: 'var(--text2)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 600, color: colors[color], lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ color: 'var(--text2)', fontSize: 12, marginTop: 6 }}>{sub}</div>}
    </div>
  )
}
