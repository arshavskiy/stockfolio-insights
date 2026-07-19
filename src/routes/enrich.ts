// Composed enrichment endpoint — everything the Position page needs in ONE call.
// Cached in-memory (5 min TTL): position pages are read-heavy, data changes slowly.
import { Router } from 'express'
import { Article } from '../models/Article'
import { TickerInsight } from '../models/TickerInsight'
import { CorporateEvent } from '../models/CorporateEvent'
import { OwnershipSnapshot } from '../models/OwnershipSnapshot'

export const enrich = Router()

const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; body: unknown }>()

enrich.get('/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase()

  const hit = cache.get(ticker)
  if (hit && Date.now() - hit.at < TTL_MS) {
    res.setHeader('x-cache', 'hit')
    return res.json(hit.body)
  }

  const since7d = new Date(Date.now() - 7 * 86_400_000)

  const [series, articles, nextEvent, recentEvents, ownership] = await Promise.all([
    TickerInsight.find({ ticker }).sort({ date: 1 }).limit(14).lean(),
    Article.find({ tickers: ticker, analyzed: true, publishedAt: { $gte: since7d } })
      .sort({ publishedAt: -1 })
      .limit(5)
      .select('headline url publishedAt sentiment themes llmSummary')
      .lean(),
    CorporateEvent.findOne({ ticker, date: { $gte: new Date() } }).sort({ date: 1 }).lean(),
    CorporateEvent.find({ ticker, date: { $lt: new Date() } }).sort({ date: -1 }).limit(3).lean(),
    OwnershipSnapshot.findOne({ ticker }).sort({ asOf: -1 }).lean(),
  ])

  const latest = series.at(-1)
  const body = {
    ticker,
    generatedAt: new Date().toISOString(),
    // headline numbers for badges/chips — frontend shouldn't recompute these
    summary: {
      sentiment: latest?.avgSentiment ?? null,
      momentum: latest?.momentum ?? null,
      articleCount7d: series.slice(-7).reduce((s, r) => s + r.articleCount, 0),
      topThemes: latest?.topThemes ?? [],
      daysToNextEvent: nextEvent
        ? Math.ceil((new Date(nextEvent.date).getTime() - Date.now()) / 86_400_000)
        : null,
      insiderNet3m: ownership?.insiderNet3m ?? null,
    },
    sentimentSeries: series.map((r) => ({
      date: r.date,
      sentiment: r.avgSentiment,
      articles: r.articleCount,
    })),
    headlines: articles,
    nextEvent,
    recentEvents,
    ownership,
  }

  cache.set(ticker, { at: Date.now(), body })
  res.setHeader('x-cache', 'miss')
  res.json(body)
})
