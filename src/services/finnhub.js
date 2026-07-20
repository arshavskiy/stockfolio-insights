// Finnhub company-news ingestion. Free tier: 60 calls/min.
const { Article } = require('../models/Article')

const BASE = 'https://finnhub.io/api/v1'

async function fetchCompanyNews(ticker, days = 2) {
  const key = process.env.FINNHUB_API_KEY
  if (!key) throw new Error('FINNHUB_API_KEY is not set')

  const to = new Date()
  const from = new Date(to.getTime() - days * 86_400_000)
  const fmt = (d) => d.toISOString().slice(0, 10)

  const res = await fetch(
    `${BASE}/company-news?symbol=${ticker}&from=${fmt(from)}&to=${fmt(to)}&token=${key}`
  )
  if (!res.ok) throw new Error(`finnhub ${res.status} for ${ticker}`)
  const items = await res.json()

  let inserted = 0
  for (const item of items) {
    try {
      await Article.updateOne(
        { source: 'finnhub', sourceId: String(item.id) },
        {
          $setOnInsert: {
            url: item.url,
            headline: item.headline,
            summary: item.summary?.slice(0, 2000),
            publishedAt: new Date(item.datetime * 1000),
            // seed the ticker we searched by; analyzer may add more
            tickers: [ticker],
          },
        },
        { upsert: true }
      ).then((r) => { if (r.upsertedCount) inserted++ })
    } catch (e) {
      if (e?.code !== 11000) console.error('[finnhub] upsert error', e?.message)
    }
  }
  return inserted
}

module.exports = { fetchCompanyNews }
