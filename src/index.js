const express = require('express')
const { connectDB } = require('./db')
const { insights } = require('./routes/insights')
const { events } = require('./routes/events')
const { enrich } = require('./routes/enrich')
const { quotes } = require('./routes/quotes')
const { typology } = require('./routes/typology')

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true, service: 'stockfolio-insights' }))
app.use('/insights', insights)
app.use('/events', events)
app.use('/enrich', enrich)
app.use('/quotes', quotes)
app.use('/typology', typology)

const port = Number(process.env.PORT) || 4100

;(async () => {
  await connectDB()
  app.listen(port, () => console.log(`[api] listening on :${port}`))
})()
