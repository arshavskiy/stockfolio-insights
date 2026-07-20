// Classifies tickers into archetypes from already-collected data.
// All thresholds are heuristics — documented, adjustable, and stored alongside
// the raw inputs so the UI can always show WHY a ticker got a label.
const { TickerQuote } = require('../models/TickerQuote')
const { ShortInterest } = require('../models/ShortInterest')
const { OwnershipSnapshot } = require('../models/OwnershipSnapshot')
const { TickerInsight } = require('../models/TickerInsight')
const { Article } = require('../models/Article')
const { TickerTypology } = require('../models/TickerTypology')

const B = 1e9

function capClass(mc) {
  if (mc == null) return 'unknown'
  if (mc >= 200 * B) return 'mega'
  if (mc >= 10 * B) return 'large'
  if (mc >= 2 * B) return 'mid'
  if (mc >= 0.3 * B) return 'small'
  return 'micro'
}

function styleClass(pe, eps) {
  if (pe == null && eps == null) return 'unknown'
  if ((eps != null && eps < 0) || pe == null || pe <= 0) return 'speculative' // unprofitable / no meaningful P/E
  if (pe >= 35) return 'growth'
  if (pe <= 15) return 'value'
  return 'blend'
}

function volClass(beta) {
  if (beta == null) return 'unknown'
  if (beta < 0.8) return 'low'
  if (beta <= 1.3) return 'medium'
  return 'high'
}

function divProfile(y) {
  if (y == null) return 'unknown'
  if (y <= 0.01) return 'none'
  if (y >= 4) return 'high-yield'
  return 'payer'
}

function newsProfile(count7d) {
  if (count7d === 0) return 'quiet'
  if (count7d >= 15) return 'hot'
  return 'covered'
}

function insiderSignal(net) {
  if (net == null) return 'unknown'
  if (net > 0) return 'buying'
  if (net < 0) return 'selling'
  return 'neutral'
}

function squeezeRisk(dtc) {
  if (dtc == null) return 'unknown'
  if (dtc >= 8) return 'high'
  if (dtc >= 4) return 'elevated'
  return 'low'
}

async function computeTypology(ticker) {
  const since7d = new Date(Date.now() - 7 * 86_400_000)

  const [quote, shortInt, ownership, insights, industryAgg] = await Promise.all([
    TickerQuote.findOne({ ticker }).lean(),
    ShortInterest.findOne({ ticker }).sort({ settlementDate: -1 }).lean(),
    OwnershipSnapshot.findOne({ ticker }).sort({ asOf: -1 }).lean(),
    TickerInsight.find({ ticker }).sort({ date: -1 }).limit(7).lean(),
    Article.aggregate([
      { $match: { tickers: ticker, analyzed: true, publishedAt: { $gte: since7d } } },
      { $unwind: '$industries' },
      { $group: { _id: '$industries', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 5 },
    ]),
  ])

  const articleCount7d = insights.reduce((s, r) => s + (r.articleCount || 0), 0)
  const industries = industryAgg.map((r) => r._id)

  const dims = {
    marketCapClass: capClass(quote?.marketCap),
    style: styleClass(quote?.peRatio, quote?.eps),
    volatilityClass: volClass(quote?.beta),
    dividendProfile: divProfile(quote?.dividendYield),
    newsProfile: newsProfile(articleCount7d),
    insiderSignal: insiderSignal(ownership?.insiderNet3m),
    squeezeRisk: squeezeRisk(shortInt?.daysToCover),
  }

  const tags = [
    dims.marketCapClass !== 'unknown' && `${dims.marketCapClass}-cap`,
    dims.style !== 'unknown' && dims.style,
    dims.volatilityClass === 'high' && 'high-beta',
    dims.volatilityClass === 'low' && 'defensive',
    dims.dividendProfile === 'high-yield' && 'high-yield',
    dims.dividendProfile === 'payer' && 'dividend-payer',
    dims.newsProfile === 'hot' && 'hot-coverage',
    dims.insiderSignal === 'buying' && 'insider-buying',
    dims.squeezeRisk !== 'low' && dims.squeezeRisk !== 'unknown' && 'squeeze-watch',
  ].filter(Boolean)

  await TickerTypology.updateOne(
    { ticker },
    {
      $set: {
        ...dims,
        primaryIndustry: industries[0],
        industries,
        tags,
        inputs: {
          marketCap: quote?.marketCap ?? undefined,
          peRatio: quote?.peRatio ?? undefined,
          beta: quote?.beta ?? undefined,
          dividendYield: quote?.dividendYield ?? undefined,
          daysToCover: shortInt?.daysToCover ?? undefined,
          articleCount7d,
          insiderNet3m: ownership?.insiderNet3m ?? undefined,
        },
        computedAt: new Date(),
      },
    },
    { upsert: true }
  )
}

module.exports = { computeTypology }
