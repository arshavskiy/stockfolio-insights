// Standalone Israeli business-news worker — fetch, analyze, aggregate.
// Split out from the main ingest pipeline so it can run as its own Railway
// service on its own schedule, independent of the US/TASE Finnhub+Yahoo loop.
const cron = require('node-cron')
const { connectDB } = require('../db')
const { fetchIsraeliBusinessNews } = require('../services/israeliNews')
const { analyzePendingArticles } = require('../services/analyzer')
const { rebuildDailyAggregates } = require('../services/aggregate')

async function runIsraeliNewsPipeline() {
  console.log('[israeli-news] start')
  let fetched = 0
  try {
    fetched = await fetchIsraeliBusinessNews()
    console.log(`[israeli-news] fetched: ${fetched}`)
  } catch (e) {
    console.error('[israeli-news] fetch failed:', e.message)
  }

  let analyzed = 0
  try {
    for (let i = 0; i < 10; i++) {
      const n = await analyzePendingArticles()
      analyzed += n
      console.log(`[israeli-news] analysis batch ${i + 1}: ${n} articles (total ${analyzed})`)
      if (n === 0) break
    }
  } catch (e) {
    console.error('[israeli-news] analysis failed:', e.message)
  }

  let aggregated = 0
  try {
    aggregated = await rebuildDailyAggregates()
  } catch (e) {
    console.error('[israeli-news] aggregation failed:', e.message)
  }

  console.log(`[israeli-news] done — fetched ${fetched}, analyzed ${analyzed}, aggregated ${aggregated} rows`)
}

if (require.main === module) {
  ;(async () => {
    await connectDB()
    await runIsraeliNewsPipeline()
    cron.schedule(process.env.ISRAELI_NEWS_CRON || '*/20 * * * *', runIsraeliNewsPipeline)
    console.log('[israeli-news] scheduled:', process.env.ISRAELI_NEWS_CRON || '*/20 * * * *')
  })()
}

module.exports = { runIsraeliNewsPipeline }
