// Scheduled pipeline: fetch news -> analyze -> aggregate.
const cron = require('node-cron')
const { connectDB } = require('../db')
const { refreshWatchlist, getActiveTickers } = require('../services/watchlist')
const { fetchCompanyNews } = require('../services/finnhub')
const { fetchYahooNews } = require('../services/yahoo')
const { analyzePendingArticles } = require('../services/analyzer')
const { rebuildDailyAggregates } = require('../services/aggregate')

async function runPipeline() {
  // Refresh the watchlist first so ingestion always targets the current active universe.
  await refreshWatchlist()
  const tickers = await getActiveTickers()
  console.log(`[pipeline] start — ${tickers.length} tickers`)
  let fetched = 0
  for (const t of tickers) {
    let finnhubCount = 0
    let yahooCount = 0
    try {
      finnhubCount = await fetchCompanyNews(t)
      fetched += finnhubCount
      await new Promise((r) => setTimeout(r, 1100)) // stay under free-tier rate limit
    } catch (e) {
      console.error(`[pipeline] finnhub fetch failed for ${t}:`, e.message)
    }
    try {
      yahooCount = await fetchYahooNews(t)
      fetched += yahooCount
    } catch (e) {
      console.error(`[pipeline] yahoo fetch failed for ${t}:`, e.message)
    }
    console.log(`[pipeline] ${t}: +${finnhubCount} finnhub, +${yahooCount} yahoo`)
  }
  // analyze in batches until queue drained (cap loops as safety)
  let analyzed = 0
  try {
    for (let i = 0; i < 10; i++) {
      const n = await analyzePendingArticles()
      analyzed += n
      console.log(`[pipeline] analysis batch ${i + 1}: ${n} articles (total ${analyzed})`)
      if (n === 0) break
    }
  } catch (e) {
    console.error('[pipeline] analysis failed:', e.message)
  }
  let aggregated = 0
  try {
    aggregated = await rebuildDailyAggregates()
  } catch (e) {
    console.error('[pipeline] aggregation failed:', e.message)
  }
  console.log(`[pipeline] done — fetched ${fetched}, analyzed ${analyzed}, aggregated ${aggregated} rows`)
}

if (require.main === module) {
  ;(async () => {
    await connectDB()
    await runPipeline() // run once on boot
    cron.schedule(process.env.INGEST_CRON || '*/20 * * * *', runPipeline)
    console.log('[worker] scheduled:', process.env.INGEST_CRON || '*/20 * * * *')
  })()
}

module.exports = { runPipeline }
