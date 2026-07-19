import { Router } from 'express'
import { Article } from '../models/Article'
import { TickerInsight } from '../models/TickerInsight'

export const insights = Router()

// GET /insights/ticker/AAPL?days=7 — daily series + latest articles
insights.get('/ticker/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase()
  const days = Math.min(Number(req.query.days) || 7, 30)
  const since = new Date(Date.now() - days * 86_400_000)

  const [series, articles] = await Promise.all([
    TickerInsight.find({ ticker }).sort({ date: 1 }).limit(days).lean(),
    Article.find({ tickers: ticker, analyzed: true, publishedAt: { $gte: since } })
      .sort({ publishedAt: -1 })
      .limit(20)
      .select('headline url publishedAt sentiment themes llmSummary source')
      .lean(),
  ])
  res.json({ ticker, series, articles })
})

// GET /insights/industry/semiconductors?days=7 — industry-level roll-up
insights.get('/industry/:industry', async (req, res) => {
  const industry = req.params.industry.toLowerCase()
  const days = Math.min(Number(req.query.days) || 7, 30)
  const since = new Date(Date.now() - days * 86_400_000)

  const summary = await Article.aggregate([
    { $match: { analyzed: true, industries: industry, publishedAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$publishedAt' } },
        articleCount: { $sum: 1 },
        avgSentiment: { $avg: '$sentiment' },
        tickers: { $addToSet: '$tickers' },
      },
    },
    { $sort: { _id: 1 } },
  ])
  res.json({ industry, days, series: summary })
})

// GET /insights/trending — most-covered tickers today with momentum
insights.get('/trending', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const rows = await TickerInsight.find({ date: today })
    .sort({ articleCount: -1 })
    .limit(15)
    .lean()
  res.json({ date: today, trending: rows })
})
