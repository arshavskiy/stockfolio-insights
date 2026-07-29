// Recompute daily per-ticker aggregates + momentum (sentiment velocity).
const { Article } = require('../models/Article')
const { TickerInsight } = require('../models/TickerInsight')

const DAY = 86_400_000
const utcDate = (d) => d.toISOString().slice(0, 10)

async function rebuildDailyAggregates(daysBack = 8) {
  const since = new Date(Date.now() - daysBack * DAY)

  const rows = await Article.aggregate([
    { $match: { analyzed: true, publishedAt: { $gte: since }, tickers: { $ne: [] } } },
    { $unwind: '$tickers' },
    {
      $group: {
        _id: {
          ticker: '$tickers',
          date: { $dateToString: { format: '%Y-%m-%d', date: '$publishedAt' } },
        },
        articleCount: { $sum: 1 },
        avgSentiment: { $avg: '$sentiment' },
        themes: { $push: '$themes' },
        industries: { $addToSet: '$industries' },
      },
    },
  ])

  // theme frequency -> top 5
  const topThemes = (nested) => {
    const freq = new Map()
    for (const t of nested.flat().filter(Boolean)) freq.set(t, (freq.get(t) || 0) + 1)
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t)
  }

  for (const r of rows) {
    await TickerInsight.updateOne(
      { ticker: r._id.ticker, date: r._id.date },
      {
        $set: {
          articleCount: r.articleCount,
          avgSentiment: r.avgSentiment ?? 0,
          topThemes: topThemes(r.themes),
          industries: [...new Set(r.industries.flat(2))],
        },
      },
      { upsert: true }
    )
  }

  // Articles can lose a ticker tag after re-analysis (analyzer.js replaces
  // tags authoritatively each run), which can drop a (ticker, date) pair to
  // zero current articles. The loop above only touches pairs that still have
  // >=1 match, so a stale row from an earlier run would otherwise survive
  // forever — remove any row in this window with no matching fresh data.
  const freshKeys = new Set(rows.map((r) => `${r._id.ticker}|${r._id.date}`))
  const existingInWindow = await TickerInsight.find({ date: { $gte: utcDate(since) } })
    .select('ticker date')
    .lean()
  const staleIds = existingInWindow
    .filter((row) => !freshKeys.has(`${row.ticker}|${row.date}`))
    .map((row) => row._id)
  if (staleIds.length) await TickerInsight.deleteMany({ _id: { $in: staleIds } })

  // momentum: today's avg minus trailing 7d avg
  const today = utcDate(new Date())
  const todayRows = await TickerInsight.find({ date: today })
  for (const row of todayRows) {
    const trailing = await TickerInsight.aggregate([
      { $match: { ticker: row.ticker, date: { $lt: today } } },
      { $group: { _id: null, avg: { $avg: '$avgSentiment' } } },
    ])
    const base = trailing[0]?.avg ?? 0
    row.momentum = +(row.avgSentiment - base).toFixed(3)
    await row.save()
  }

  return rows.length
}

module.exports = { rebuildDailyAggregates }
