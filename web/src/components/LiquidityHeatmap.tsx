interface Bucket {
  tickLower: number
  tickUpper: number
  priceLower: number
  priceUpper: number
  share: number
}

interface Props {
  buckets: Bucket[]
  currentPrice: number
  positionPriceLower?: number
  positionPriceUpper?: number
}

export function LiquidityHeatmap({ buckets, currentPrice, positionPriceLower, positionPriceUpper }: Props) {
  if (!buckets || buckets.length === 0) {
    return (
      <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)' }}>
        Loading liquidity data…
      </div>
    )
  }

  const maxShare = Math.max(...buckets.map(b => b.share), 0.001)

  return (
    <div>
      {/* Price labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text2)', marginBottom: 4 }}>
        <span>${buckets[0]?.priceLower.toFixed(0)}</span>
        <span style={{ color: 'var(--blue)', fontWeight: 600 }}>Current: ${currentPrice.toFixed(2)}</span>
        <span>${buckets[buckets.length - 1]?.priceUpper.toFixed(0)}</span>
      </div>

      {/* Heatmap bars */}
      <div style={{ display: 'flex', height: 80, alignItems: 'flex-end', gap: 1, position: 'relative' }}>
        {buckets.map((b, i) => {
          const isCurrentPrice = currentPrice >= b.priceLower && currentPrice < b.priceUpper
          const isInPosition = positionPriceLower && positionPriceUpper
            && b.priceLower >= positionPriceLower && b.priceUpper <= positionPriceUpper
          const height = Math.max(4, (b.share / maxShare) * 76)

          let color = 'rgba(59,130,246,0.4)'
          if (isInPosition) color = 'rgba(34,197,94,0.6)'
          if (isCurrentPrice) color = '#3b82f6'

          return (
            <div
              key={i}
              title={`$${b.priceLower.toFixed(2)}–$${b.priceUpper.toFixed(2)}\nLiquidity: ${(b.share * 100).toFixed(1)}%`}
              style={{
                flex: 1,
                height,
                background: color,
                borderRadius: '2px 2px 0 0',
                transition: 'height 0.3s',
                cursor: 'default',
              }}
            />
          )
        })}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: 'var(--text2)' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#3b82f6', marginRight: 4 }} />Current price</span>
        {positionPriceLower && <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'rgba(34,197,94,0.6)', marginRight: 4 }} />Your range</span>}
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'rgba(59,130,246,0.4)', marginRight: 4 }} />Other LPs</span>
      </div>
    </div>
  )
}
