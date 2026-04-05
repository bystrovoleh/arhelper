import dotenv from 'dotenv'
dotenv.config()

import { app } from './api'
import { paperEngine } from './paper-engine'

const PORT = process.env['PORT'] ?? 3001

const server = app.listen(PORT, () => {
  console.log(`[Server] API running on http://localhost:${PORT}`)
  paperEngine.start()
})

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`\n[Server] ${signal} received — shutting down gracefully...`)
  paperEngine.stop()
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
