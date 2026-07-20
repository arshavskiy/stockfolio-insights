// Finnhub earnings calendar (free tier). Pulls upcoming + recent earnings dates
// with EPS estimates/actuals for the watchlist.
const { CorporateEvent } = require('../models/CorporateEvent')
const { getActiveTickers } = require('./watchlist')

const BASE = 'https://finnhub.io/api/v1'

async function fetchEarningsCalendar(daysBack = 30, daysAhead = 90) {
  const key = process.env.FINNHUB_API_KEY
  if (!key) throw new Error('FINNHUB_API_KEY is not set')

  const fmt = (d) => d.toISOString().slice(0, 10)
  const from = fmt(new Date(Date.now() - daysBack * 86_400_000))
  const to = fmt(new Date(Date.now() + daysAhead * 86_400_000))

  const res = await fetch(`${BASE}/calendar/earnings?from=${from}&to=${to}&token=${key}`)
  if (!res.ok) throw new Error(`finnhub earnings ${res.status}`)
  const data = await res.json()

  const watchlist = new Set(await getActiveTickers())

  let upserted = 0
  for (const e of data.earningsCalendar || []) {
    if (watchlist.size && !watchlist.has(e.symbol)) continue
    await CorporateEvent.updateOne(
      { ticker: e.symbol, type: 'earnings', date: new Date(e.date) },
      {
        $set: {
          period: `${e.year}-Q${e.quarter}`,
          epsEstimate: e.epsEstimate ?? undefined,
          epsActual: e.epsActual ?? undefined,
          revenueEstimate: e.revenueEstimate ?? undefined,
          revenueActual: e.revenueActual ?? undefined,
          hour: e.hour || undefined,
          source: 'finnhub',
        },
      },
      { upsert: true }
    ).then((r) => { if (r.upsertedCount) upserted++ })
  }
  return upserted
}

module.exports = { fetchEarningsCalendar }
