import dotenv from 'dotenv'
dotenv.config()

import { app } from './api'
import { paperEngine } from './paper-engine'

const PORT = process.env['PORT'] ?? 3001

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`)
  paperEngine.start()
})
