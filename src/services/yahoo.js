// Yahoo v8 chart endpoint — keyless, no crumb/cookie needed (unlike v7/quote).
// The `meta` block carries the fast quote fields the UI needs.
const { TickerQuote } = require('../models/TickerQuote')
const { Article } = require('../models/Article')

const UA = 'Mozilla/5.0 (compatible; StockfolioInsights/0.4)'

async function refreshQuote(ticker) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
    { headers: { 'User-Agent': UA } }
  )
  if (!res.ok) {
    await TickerQuote.updateOne(
      { ticker }, { $inc: { failCount: 1 } }, { upsert: true }
    )
    return false
  }
  const data = await res.json()
  const meta = data?.chart?.result?.[0]?.meta
  if (!meta?.regularMarketPrice) {
    await TickerQuote.updateOne({ ticker }, { $inc: { failCount: 1 } }, { upsert: true })
    return false
  }

  const price = meta.regularMarketPrice
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? null

  await TickerQuote.updateOne(
    { ticker },
    {
      $set: {
        price,
        previousClose: prev,
        change: prev != null ? +(price - prev).toFixed(4) : undefined,
        changePct: prev ? +(((price - prev) / prev) * 100).toFixed(2) : undefined,
        dayHigh: meta.regularMarketDayHigh,
        dayLow: meta.regularMarketDayLow,
        volume: meta.regularMarketVolume,
        marketState: meta.marketState || undefined,
        currency: meta.currency,
        exchange: meta.fullExchangeName || meta.exchangeName,
        name: meta.shortName || meta.longName || undefined,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        quoteUpdatedAt: new Date(),
        failCount: 0,
      },
    },
    { upsert: true }
  )
  return true
}

// Daily profile fill from Finnhub free /stock/profile2 + /stock/metric —
// market cap, PE, EPS, dividend yield, beta, logo.
async function refreshProfile(ticker) {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return

  const [profRes, metricRes] = await Promise.all([
    fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${key}`),
    fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${key}`),
  ])

  const prof = profRes.ok ? await profRes.json() : {}
  const metric = metricRes.ok ? (await metricRes.json())?.metric || {} : {}

  await TickerQuote.updateOne(
    { ticker },
    {
      $set: {
        ...(prof.name && { name: prof.name }),
        ...(prof.marketCapitalization && { marketCap: prof.marketCapitalization * 1e6 }),
        ...(prof.logo && { logo: prof.logo }),
        ...(metric.peTTM != null && { peRatio: metric.peTTM }),
        ...(metric.epsTTM != null && { eps: metric.epsTTM }),
        ...(metric.currentDividendYieldTTM != null && { dividendYield: metric.currentDividendYieldTTM }),
        ...(metric.beta != null && { beta: metric.beta }),
        profileUpdatedAt: new Date(),
      },
    },
    { upsert: true }
  )
}

// Yahoo finance search — keyless, returns a `news` array per query.
// Higher volume than Finnhub's company-news free tier, and covers tickers
// Finnhub doesn't (e.g. TASE .TA symbols 403 on Finnhub company-news).
// relatedTickers on each item is used to seed a broader ticker set than
// just the ticker we searched by.
async function fetchYahooNews(ticker, count = 20) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=${count}&quotesCount=0`,
    { headers: { 'User-Agent': UA } }
  )
  if (!res.ok) throw new Error(`yahoo search ${res.status} for ${ticker}`)
  const data = await res.json()
  const items = data?.news || []

  let inserted = 0
  for (const item of items) {
    if (!item.uuid || !item.link || !item.title) continue
    try {
      await Article.updateOne(
        { source: 'yahoo', sourceId: item.uuid },
        {
          $setOnInsert: {
            url: item.link,
            headline: item.title,
            publishedAt: new Date((item.providerPublishTime || 0) * 1000),
            tickers: (item.relatedTickers || []).includes(ticker)
              ? [ticker]
              : [ticker, ...(item.relatedTickers || [])],
          },
        },
        { upsert: true }
      ).then((r) => { if (r.upsertedCount) inserted++ })
    } catch (e) {
      if (e?.code !== 11000) console.error('[yahoo] upsert error', e?.message)
    }
  }
  return inserted
}

module.exports = { refreshQuote, refreshProfile, fetchYahooNews }
