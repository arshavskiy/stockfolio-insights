// Finnhub free endpoints: earnings surprise history, analyst recommendation
// trends, dividend events. Dividends may be premium on some plans — degrades
// gracefully on 403 instead of failing the pipeline.
import { CorporateEvent } from '../models/CorporateEvent'
import { AnalystTrend } from '../models/AnalystTrend'

const BASE = 'https://finnhub.io/api/v1'
const key = () => {
  const k = process.env.FINNHUB_API_KEY
  if (!k) throw new Error('FINNHUB_API_KEY is not set')
  return k
}

// ---- Earnings surprise history (last quarters with actual vs estimate) ----
interface Surprise {
  period: string   // YYYY-MM-DD
  quarter: number
  year: number
  actual: number | null
  estimate: number | null
  surprisePercent: number | null
}

export async function fetchEarningsSurprises(ticker: string): Promise<number> {
  const res = await fetch(`${BASE}/stock/earnings?symbol=${ticker}&token=${key()}`)
  if (!res.ok) throw new Error(`finnhub surprises ${res.status} for ${ticker}`)
  const rows = (await res.json()) as Surprise[]

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
interface RecRow {
  period: string
  strongBuy: number
  buy: number
  hold: number
  sell: number
  strongSell: number
}

export async function fetchAnalystTrends(ticker: string): Promise<number> {
  const res = await fetch(`${BASE}/stock/recommendation?symbol=${ticker}&token=${key()}`)
  if (!res.ok) throw new Error(`finnhub recommendation ${res.status} for ${ticker}`)
  const rows = (await res.json()) as RecRow[]

  let upserted = 0
  for (const r of (rows || []).slice(0, 12)) {          // keep a year of history
    await AnalystTrend.updateOne(
      { ticker: ticker.toUpperCase(), period: r.period },
      { $set: { strongBuy: r.strongBuy, buy: r.buy, hold: r.hold, sell: r.sell, strongSell: r.strongSell } },
      { upsert: true }
    ).then((x) => { if (x.upsertedCount) upserted++ })
  }
  return upserted
}

// ---- Dividend events (ex-date, pay date, amount) ----
interface Dividend {
  date: string          // ex-dividend date
  amount: number
  payDate: string
  recordDate: string
  currency: string
}

export async function fetchDividends(ticker: string): Promise<number> {
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
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
  const rows = (await res.json()) as Dividend[]

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
