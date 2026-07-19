import express from 'express'
import { connectDB } from './db'
import { insights } from './routes/insights'

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true, service: 'stockfolio-insights' }))
app.use('/insights', insights)

const port = Number(process.env.PORT) || 4100
await connectDB()
app.listen(port, () => console.log(`[api] listening on :${port}`))
