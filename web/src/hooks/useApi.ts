import { useState, useEffect, useCallback } from 'react'

const API = 'http://localhost:3001'

export function useApi<T>(path: string, refreshMs = 30_000) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(`${API}${path}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [path])

  useEffect(() => {
    fetch_()
    const t = setInterval(fetch_, refreshMs)
    return () => clearInterval(t)
  }, [fetch_, refreshMs])

  return { data, loading, error, refetch: fetch_ }
}

export async function apiPost(path: string, body: object) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}
