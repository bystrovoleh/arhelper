interface Event {
  id: number
  occurred_at: number
  type: string
  message: string
  pool_address?: string
  token_id?: string
}

const TYPE_COLORS: Record<string, string> = {
  POSITION_OPENED: '#22c55e',
  POSITION_CLOSED: '#8892a4',
  REBALANCE: '#3b82f6',
  SIGNAL: '#f59e0b',
  ERROR: '#ef4444',
  INFO: '#8892a4',
}

export function EventLog({ events }: { events: Event[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 400, overflowY: 'auto' }}>
      {events.length === 0 && (
        <div style={{ color: 'var(--text2)', padding: '20px', textAlign: 'center' }}>No events yet</div>
      )}
      {events.map(ev => (
        <div key={ev.id} style={{
          display: 'flex', gap: 12, padding: '8px 12px',
          borderRadius: 6, background: 'var(--bg3)',
          alignItems: 'flex-start',
        }}>
          <div style={{
            fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
            color: TYPE_COLORS[ev.type] ?? '#8892a4',
            background: `${TYPE_COLORS[ev.type] ?? '#8892a4'}18`,
            whiteSpace: 'nowrap', marginTop: 1,
          }}>
            {ev.type}
          </div>
          <div style={{ flex: 1, color: 'var(--text)', fontSize: 12, lineHeight: 1.5 }}>
            {ev.message}
          </div>
          <div style={{ color: 'var(--text2)', fontSize: 11, whiteSpace: 'nowrap' }}>
            {new Date(ev.occurred_at).toLocaleTimeString()}
          </div>
        </div>
      ))}
    </div>
  )
}
