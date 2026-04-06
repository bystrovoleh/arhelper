import dotenv from 'dotenv'
dotenv.config()

import { app } from './api'
import { paperEngine } from './paper-engine'
import { liveEngine } from './live-engine'

const PORT = process.env['PORT'] ?? 3001
const LIVE = process.env['LIVE'] === 'true'

const server = app.listen(PORT, () => {
  console.log(`[Server] API running on http://localhost:${PORT}`)
  if (LIVE) {
    console.log('[Server] ⚠️  LIVE MODE — real transactions enabled')
    liveEngine.start()
  } else {
    paperEngine.start()
  }
})

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`\n[Server] ${signal} received — shutting down gracefully...`)
  if (LIVE) liveEngine.stop(); else paperEngine.stop()
  server.close(() => {
    console.log('[Server] HTTP server closed.')
    process.exit(0)
  })
  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => {
    console.error('[Server] Forced exit after timeout.')
    process.exit(1)
  }, 5_000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// ── Catch uncaught errors — log and keep running ──────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err)
  // Don't crash — paper engine should keep running
})

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason)
})
