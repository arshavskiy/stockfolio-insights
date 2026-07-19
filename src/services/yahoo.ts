// Yahoo v8 chart endpoint — keyless, no crumb/cookie needed (unlike v7/quote).
// The `meta` block carries the fast quote fields the UI needs.
import { TickerQuote } from '../models/TickerQuote'

const UA = 'Mozilla/5.0 (compatible; StockfolioInsights/0.4)'

export async function refreshQuote(ticker: string): Promise<boolean> {
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
  const data = (await res.json()) as any
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
export async function refreshProfile(ticker: string): Promise<void> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return

  const [profRes, metricRes] = await Promise.all([
    fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${key}`),
    fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${key}`),
  ])

  const prof = profRes.ok ? ((await profRes.json()) as any) : {}
  const metric = metricRes.ok ? ((await metricRes.json()) as any)?.metric || {} : {}

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
