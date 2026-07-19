import express from 'express'
import { connectDB } from './db'
import { insights } from './routes/insights'
import { events } from './routes/events'
import { enrich } from './routes/enrich'
import { quotes } from './routes/quotes'
import { typology } from './routes/typology'

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true, service: 'stockfolio-insights' }))
app.use('/insights', insights)
app.use('/events', events)
app.use('/enrich', enrich)
app.use('/quotes', quotes)
app.use('/typology', typology)

const port = Number(process.env.PORT) || 4100
await connectDB()
app.listen(port, () => console.log(`[api] listening on :${port}`))
