// Finnhub free endpoints: earnings surprise history, analyst recommendation
// trends, dividend events. Dividends may be premium on some plans — degrades
// gracefully on 403 instead of failing the pipeline.
const { CorporateEvent } = require('../models/CorporateEvent')
const { AnalystTrend } = require('../models/AnalystTrend')
const { fetchInvestingConsensus } = require('./investingConsensus')

const BASE = 'https://finnhub.io/api/v1'
const key = () => {
  const k = process.env.FINNHUB_API_KEY
  if (!k) throw new Error('FINNHUB_API_KEY is not set')
  return k
}

// ---- Earnings surprise history (last quarters with actual vs estimate) ----
async function fetchEarningsSurprises(ticker) {
  const res = await fetch(`${BASE}/stock/earnings?symbol=${ticker}&token=${key()}`)
  if (!res.ok) throw new Error(`finnhub surprises ${res.status} for ${ticker}`)
  const rows = await res.json()

  let upserted = 0
  for (const s of rows || []) {
    if (!s.period) continue
    await CorporateEvent.updateOne(
      { ticker: ticker.toUpperCase(), type: 'earnings', date: new Date(s.period) },
      {
        $set: {
          period: `${s.year}-Q${s.quarter}`,
          epsActual: s.actual ?? undefined,
          epsEstimate: s.estimate ?? undefined,
          surprisePct: s.surprisePercent ?? undefined,
          source: 'finnhub',
        },
      },
      { upsert: true }
    ).then((r) => { if (r.upsertedCount) upserted++ })
  }
  return upserted
}

// ---- Analyst recommendation trends (monthly buy/hold/sell counts) ----
async function fetchAnalystTrends(ticker) {
  const symbol = ticker.toUpperCase()
  let rows = []
  try {
    const res = await fetch(`${BASE}/stock/recommendation?symbol=${ticker}&token=${key()}`)
    if (!res.ok) throw new Error(`finnhub recommendation ${res.status} for ${ticker}`)
    rows = await res.json()
  } catch (e) {
    if (!symbol.endsWith('.TA')) throw e
    console.warn(`[fundamentals] Finnhub recommendation unavailable for ${symbol}; trying Investing.com consensus`)
    return fetchInvestingConsensus(symbol)
  }

  let upserted = 0
  for (const r of (rows || []).slice(0, 12)) {          // keep a year of history
    await AnalystTrend.updateOne(
      { ticker: symbol, period: r.period },
      {
        $set: {
          strongBuy: r.strongBuy,
          buy: r.buy,
          hold: r.hold,
          sell: r.sell,
          strongSell: r.strongSell,
          analystCount: [r.strongBuy, r.buy, r.hold, r.sell, r.strongSell].reduce((sum, n) => sum + (n || 0), 0),
          source: 'finnhub',
        },
      },
      { upsert: true }
    ).then((x) => { if (x.upsertedCount) upserted++ })
  }
  if (upserted || !symbol.endsWith('.TA')) return upserted
  return fetchInvestingConsensus(symbol)
}

// ---- Dividend events (ex-date, pay date, amount) ----
async function fetchDividends(ticker) {
  const fmt = (d) => d.toISOString().slice(0, 10)
  const from = fmt(new Date(Date.now() - 365 * 86_400_000))
  const to = fmt(new Date(Date.now() + 120 * 86_400_000))

  const res = await fetch(
    `${BASE}/stock/dividend?symbol=${ticker}&from=${from}&to=${to}&token=${key()}`
  )
  if (res.status === 403) {
    console.warn(`[fundamentals] dividends premium-gated for this key — skipping ${ticker}`)
    return 0
  }
  if (!res.ok) throw new Error(`finnhub dividend ${res.status} for ${ticker}`)
  const rows = await res.json()

  let upserted = 0
  for (const d of rows || []) {
    if (!d.date) continue
    await CorporateEvent.updateOne(
      { ticker: ticker.toUpperCase(), type: 'dividend', date: new Date(d.date) },
      {
        $set: {
          amount: d.amount,
          currency: d.currency || 'USD',
          payDate: d.payDate ? new Date(d.payDate) : undefined,
          recordDate: d.recordDate ? new Date(d.recordDate) : undefined,
          source: 'finnhub',
        },
      },
      { upsert: true }
    ).then((r) => { if (r.upsertedCount) upserted++ })
  }
  return upserted
}

module.exports = { fetchEarningsSurprises, fetchAnalystTrends, fetchDividends }
