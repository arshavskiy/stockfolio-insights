// Client-facing quote API. The UI reads from OUR store; anything missing/stale
// is listed so the client can fall back to Yahoo for just those symbols —
// they'll be in the watchlist and covered by the next poll cycle.
const { Router } = require('express')
const { TickerQuote } = require('../models/TickerQuote')
const { WatchedTicker } = require('../models/WatchedTicker')

const quotes = Router()

const STALE_SECONDS = Number(process.env.QUOTE_STALE_SECONDS) || 600

// Yahoo quotes TASE equities in agorot (currency ILA, 1/100 shekel) and we
// store what it returns. Convert at the API boundary so callers always get
// shekels, and report the currency as ILS to match. TASE *indices* come back
// as ILS already and must not be scaled.
function agorotFactor(q) {
  return q.currency === 'ILA' ? 100 : 1
}

const scaled = (value, f) => (value == null ? null : value / f)

// Normalize quote documents into the contract expected by the frontend.
function shape(q) {
  const age = q.quoteUpdatedAt
    ? Math.round((Date.now() - new Date(q.quoteUpdatedAt).getTime()) / 1000)
    : null
  const f = agorotFactor(q)
  return {
    ticker: q.ticker,
    name: q.name ?? null,
    price: scaled(q.price, f),
    change: scaled(q.change, f),
    changePct: q.changePct ?? null,
    previousClose: scaled(q.previousClose, f),
    dayHigh: scaled(q.dayHigh, f),
    dayLow: scaled(q.dayLow, f),
    volume: q.volume ?? null,
    marketState: q.marketState ?? null,
    currency: f === 100 ? 'ILS' : (q.currency ?? null),
    exchange: q.exchange ?? null,
    fiftyTwoWeekHigh: scaled(q.fiftyTwoWeekHigh, f),
    fiftyTwoWeekLow: scaled(q.fiftyTwoWeekLow, f),
    marketCap: q.marketCap ?? null,
    peRatio: q.peRatio ?? null,
    eps: q.eps ?? null,
    dividendYield: q.dividendYield ?? null,
    beta: q.beta ?? null,
    logo: q.logo ?? null,
    ageSeconds: age,
    stale: age === null || age > STALE_SECONDS,
  }
}

// GET /quotes?tickers=AAPL,MSFT,PLTR — batch for the Watchlist page
quotes.get('/', async (req, res) => {
  const requested = String(req.query.tickers || '')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  if (!requested.length) return res.status(400).json({ error: 'tickers query param required' })
  if (requested.length > 100) return res.status(400).json({ error: 'max 100 tickers per request' })

  const found = await TickerQuote.find({ ticker: { $in: requested } }).lean()
  const byTicker = new Map(found.map((q) => [q.ticker, q]))

  const results = requested.filter((t) => byTicker.has(t)).map((t) => shape(byTicker.get(t)))
  const missing = requested.filter((t) => !byTicker.has(t))

  // auto-subscribe unknown tickers so the poller covers them from now on
  for (const t of missing) {
    await WatchedTicker.updateOne(
      { ticker: t },
      { $set: { active: true, lastActiveAt: new Date() }, $setOnInsert: { tier: 'discovery' } },
      { upsert: true }
    )
  }

  res.json({ quotes: results, missing, staleAfterSeconds: STALE_SECONDS })
})

// GET /quotes/AAPL — single ticker for the Position page
quotes.get('/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase()
  const q = await TickerQuote.findOne({ ticker }).lean()
  if (!q) {
    await WatchedTicker.updateOne(
      { ticker },
      { $set: { active: true, lastActiveAt: new Date() }, $setOnInsert: { tier: 'discovery' } },
      { upsert: true }
    )
    return res.status(404).json({ ticker, error: 'not yet tracked — subscribed, retry shortly' })
  }
  res.json(shape(q))
})

module.exports.quotes = quotes
