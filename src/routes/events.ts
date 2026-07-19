import { Router } from 'express'
import { CorporateEvent } from '../models/CorporateEvent'
import { OwnershipSnapshot } from '../models/OwnershipSnapshot'
import { MacroEvent } from '../models/MacroEvent'

export const events = Router()

// GET /events/upcoming?days=30 — next earnings/filings across watchlist (calendar view)
events.get('/upcoming', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 120)
  const now = new Date()
  const until = new Date(now.getTime() + days * 86_400_000)
  const rows = await CorporateEvent.find({ date: { $gte: now, $lte: until } })
    .sort({ date: 1 })
    .limit(200)
    .lean()
  res.json({ from: now, to: until, events: rows })
})

// GET /events/ticker/AAPL — full event history + next event for a ticker
events.get('/ticker/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase()
  const [history, next] = await Promise.all([
    CorporateEvent.find({ ticker }).sort({ date: -1 }).limit(50).lean(),
    CorporateEvent.findOne({ ticker, date: { $gte: new Date() } }).sort({ date: 1 }).lean(),
  ])
  res.json({ ticker, nextEvent: next, history })
})

// GET /events/ownership/AAPL — latest investor typology snapshot
events.get('/ownership/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase()
  const snapshot = await OwnershipSnapshot.findOne({ ticker }).sort({ asOf: -1 }).lean()
  res.json({ ticker, snapshot })
})
