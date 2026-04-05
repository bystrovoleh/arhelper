interface Pool {
  address: string
  token0: { symbol: string }
  token1: { symbol: string }
  protocol: string
  network: string
  feeTier: number
  currentPrice: number
  volumeUsd24h: number
  tvlUsd: number
  apyBase: number
  estimatedConcentratedApy: number
}

export function PoolTable({ pools }: { pools: Pool[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {['Pool', 'Protocol', 'Price', 'TVL', 'Vol 24h', 'Base APY', 'Conc. APY est'].map(h => (
              <th key={h} style={{ padding: '10px 16px', textAlign: 'left', color: 'var(--text2)', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pools.map((pool, i) => (
            <tr key={pool.address} style={{
              borderBottom: '1px solid var(--border)',
              background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
            }}>
              <td style={{ padding: '12px 16px', fontWeight: 600 }}>
                {pool.token0.symbol}/{pool.token1.symbol}
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text2)' }}>
                  {pool.feeTier / 10000}%
                </span>
              </td>
              <td style={{ padding: '12px 16px', color: 'var(--text2)' }}>{pool.protocol}</td>
              <td style={{ padding: '12px 16px' }}>${pool.currentPrice.toFixed(2)}</td>
              <td style={{ padding: '12px 16px' }}>${(pool.tvlUsd / 1_000_000).toFixed(2)}M</td>
              <td style={{ padding: '12px 16px' }}>${(pool.volumeUsd24h / 1_000_000).toFixed(2)}M</td>
              <td style={{ padding: '12px 16px', color: 'var(--yellow)' }}>{pool.apyBase.toFixed(1)}%</td>
              <td style={{ padding: '12px 16px', color: 'var(--green)', fontWeight: 600 }}>
                {pool.estimatedConcentratedApy > 0 ? `${pool.estimatedConcentratedApy.toFixed(1)}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
