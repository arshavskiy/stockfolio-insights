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
const { fetchDailyCandles } = require('../services/prices')
const { refreshProfile } = require('../services/yahoo')
const { computeTypology } = require('../services/typology')

async function runCalendarPipeline() {
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
    const earnings = await fetchEarningsCalendar()
    console.log(`[calendar] earnings upserted: ${earnings}`)
  } catch (e) {
    console.error('[calendar] earnings failed:', e.message)
  }
  for (const t of tickers) {
    try {
      const filings = await fetchSecFilings(t)
      await refreshOwnership(t)
      await fetchEarningsSurprises(t)
      await fetchAnalystTrends(t)
      await fetchDividends(t)
      await fetchShortInterest(t)
      await fetchDailyCandles(t)
      await refreshProfile(t)
      await computeTypology(t)
      console.log(`[calendar] ${t}: ${filings} filings + fundamentals refreshed`)
      await new Promise((r) => setTimeout(r, 2200)) // ~5 Finnhub calls per ticker; stay under 60/min
    } catch (e) {
      console.error(`[calendar] ${t} failed:`, e.message)
    }
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
