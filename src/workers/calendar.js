// Daily worker: earnings calendar + SEC filings + ownership snapshots.
// These change slowly — no need for the 20-minute news cadence.
const cron = require('node-cron')
const { connectDB } = require('../db')
const { refreshWatchlist, getActiveTickers } = require('../services/watchlist')
const { fetchEarningsCalendar } = require('../services/earnings')
const { fetchSecFilings } = require('../services/secFilings')
const { refreshOwnership } = require('../services/ownership')
const { fetchEarningsSurprises, fetchAnalystTrends, fetchDividends } = require('../services/fundamentals')
const { fetchShortInterest } = require('../services/shortInterestSvc')
const { seedMacroCalendar } = require('../services/macro')
const { fetchMacroSeries } = require('../services/fred')
const { fetchDailyCandles } = require('../services/prices')
const { refreshProfile } = require('../services/yahoo')
const { computeTypology } = require('../services/typology')
const { fetchXbrlFacts } = require('../services/xbrlFacts')

async function runCalendarPipeline() {
  // Rebuild the active watchlist first so the slow-moving calendar enrichments
  // are computed for the same universe as the news pipeline.
  await refreshWatchlist()
  const tickers = await getActiveTickers()
  console.log(`[calendar] start — ${tickers.length} tickers`)
  try {
    const macro = await seedMacroCalendar()
    if (macro) console.log(`[calendar] macro events seeded: ${macro}`)
  } catch (e) {
    console.error('[calendar] macro seed failed:', e.message)
  }
  try {
    const macroPoints = await fetchMacroSeries()
    console.log(`[calendar] FRED macro points upserted: ${macroPoints}`)
  } catch (e) {
    console.error('[calendar] FRED fetch failed:', e.message)
  }
  try {
    const earnings = await fetchEarningsCalendar()
    console.log(`[calendar] earnings upserted: ${earnings}`)
  } catch (e) {
    console.error('[calendar] earnings failed:', e.message)
  }
  for (const t of tickers) {
    const steps = [
      ['secFilings', () => fetchSecFilings(t)],
      ['ownership', () => refreshOwnership(t)],
      ['earningsSurprises', () => fetchEarningsSurprises(t)],
      ['analystTrends', () => fetchAnalystTrends(t)],
      ['dividends', () => fetchDividends(t)],
      ['shortInterest', () => fetchShortInterest(t)],
      ['dailyCandles', () => fetchDailyCandles(t)],
      ['profile', () => refreshProfile(t)],
      ['xbrlFacts', () => fetchXbrlFacts(t)],
      ['typology', () => computeTypology(t)],
    ]
    let filings = 0
    let okCount = 0
    for (const [name, run] of steps) {
      try {
        const result = await run()
        if (name === 'secFilings') filings = result
        okCount++
        console.log(`[calendar] ${t}.${name}: ok`)
      } catch (e) {
        console.error(`[calendar] ${t}.${name} failed:`, e.message)
      }
    }
    console.log(`[calendar] ${t}: ${filings} filings, ${okCount}/${steps.length} steps ok`)
    await new Promise((r) => setTimeout(r, 2200)) // ~5 Finnhub calls per ticker; stay under 60/min
  }
  console.log('[calendar] done')
}

if (require.main === module) {
  ;(async () => {
    await connectDB()
    await runCalendarPipeline()
    cron.schedule(process.env.CALENDAR_CRON || '0 6 * * *', runCalendarPipeline) // daily 06:00 UTC
    console.log('[calendar] scheduled:', process.env.CALENDAR_CRON || '0 6 * * *')
  })()
}

module.exports = { runCalendarPipeline }
