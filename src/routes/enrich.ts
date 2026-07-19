// Composed enrichment endpoint — everything the Position page needs in ONE call.
// Cached in-memory (5 min TTL): position pages are read-heavy, data changes slowly.
import { Router } from 'express'
import { Article } from '../models/Article'
import { TickerInsight } from '../models/TickerInsight'
import { CorporateEvent } from '../models/CorporateEvent'
import { OwnershipSnapshot } from '../models/OwnershipSnapshot'
import { AnalystTrend } from '../models/AnalystTrend'
import { ShortInterest } from '../models/ShortInterest'
import { MacroEvent } from '../models/MacroEvent'
import { PriceStat } from '../models/PriceStat'

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

  const [series, articles, nextEvent, recentEvents, ownership, surprises, recTrends, shortInt, nextMacro, priceStats] = await Promise.all([
    TickerInsight.find({ ticker }).sort({ date: 1 }).limit(14).lean(),
    Article.find({ tickers: ticker, analyzed: true, publishedAt: { $gte: since7d } })
      .sort({ publishedAt: -1 })
      .limit(5)
      .select('headline url publishedAt sentiment themes llmSummary')
      .lean(),
    CorporateEvent.findOne({ ticker, date: { $gte: new Date() } }).sort({ date: 1 }).lean(),
    CorporateEvent.find({ ticker, date: { $lt: new Date() } }).sort({ date: -1 }).limit(3).lean(),
    OwnershipSnapshot.findOne({ ticker }).sort({ asOf: -1 }).lean(),
    CorporateEvent.find({ ticker, type: 'earnings', epsActual: { $ne: null }, surprisePct: { $exists: true } })
      .sort({ date: -1 }).limit(8).select('date period epsActual epsEstimate surprisePct').lean(),
    AnalystTrend.find({ ticker }).sort({ period: -1 }).limit(3).lean(),
    ShortInterest.findOne({ ticker }).sort({ settlementDate: -1 }).lean(),
    MacroEvent.findOne({ date: { $gte: new Date() }, impact: 'high' }).sort({ date: 1 }).lean(),
    PriceStat.find({ ticker }).sort({ date: -1 }).limit(30).lean(),
  ])

  const latestPrice = priceStats[0] ?? null

  // beat rate over last up-to-8 reported quarters
  const beats = surprises.filter((s) => (s.surprisePct ?? 0) > 0).length
  // analyst delta: bullish count now vs previous month
  const bullish = (t: any) => (t?.strongBuy || 0) + (t?.buy || 0)
  const analystDelta = recTrends.length >= 2 ? bullish(recTrends[0]) - bullish(recTrends[1]) : null

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
      beatRate: surprises.length ? { beats, of: surprises.length } : null,
      analystDelta,                                    // change in buy+strongBuy vs prior month
      daysToCover: shortInt?.daysToCover ?? null,
      shortInterestChangePct: shortInt?.changePct ?? null,
      volumeRatio: latestPrice?.volumeRatio ?? null,
      unusualVolume: latestPrice?.unusualVolume ?? false,
      lastChangePct: latestPrice?.changePct ?? null,
      nextMacro: nextMacro
        ? { label: nextMacro.label, date: nextMacro.date, note: nextMacro.note ?? null }
        : null,
    },
    priceSeries: priceStats.slice().reverse().map((p) => ({
      date: p.date, close: p.close, volume: p.volume, volumeRatio: p.volumeRatio,
    })),
    surpriseHistory: surprises,
    analystTrends: recTrends,
    shortInterest: shortInt,
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
