import { scheduler } from './scheduler'

process.on('SIGINT', () => {
  scheduler.stop()
  process.exit(0)
})

process.on('SIGTERM', () => {
  scheduler.stop()
  process.exit(0)
})

scheduler.start()
