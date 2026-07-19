// Daily worker: earnings calendar + SEC filings + ownership snapshots.
// These change slowly — no need for the 20-minute news cadence.
import cron from 'node-cron'
import { connectDB } from '../db'
import { refreshWatchlist, getActiveTickers } from '../services/watchlist'
import { fetchEarningsCalendar } from '../services/earnings'
import { fetchSecFilings } from '../services/secFilings'
import { refreshOwnership } from '../services/ownership'
import { fetchEarningsSurprises, fetchAnalystTrends, fetchDividends } from '../services/fundamentals'
import { fetchShortInterest } from '../services/shortInterestSvc'
import { seedMacroCalendar } from '../services/macro'
import { fetchDailyCandles } from '../services/prices'
import { refreshProfile } from '../services/yahoo'


export async function runCalendarPipeline() {
  await refreshWatchlist()
  const tickers = await getActiveTickers()
  console.log(`[calendar] start — ${tickers.length} tickers`)
  try {
    const macro = await seedMacroCalendar()
    if (macro) console.log(`[calendar] macro events seeded: ${macro}`)
  } catch (e: any) {
    console.error('[calendar] macro seed failed:', e.message)
  }
  try {
    const earnings = await fetchEarningsCalendar()
    console.log(`[calendar] earnings upserted: ${earnings}`)
  } catch (e: any) {
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
      console.log(`[calendar] ${t}: ${filings} filings + fundamentals refreshed`)
      await new Promise((r) => setTimeout(r, 2200)) // ~5 Finnhub calls per ticker; stay under 60/min
    } catch (e: any) {
      console.error(`[calendar] ${t} failed:`, e.message)
    }
  }
  console.log('[calendar] done')
}

if (import.meta.main) {
  await connectDB()
  await runCalendarPipeline()
  cron.schedule(process.env.CALENDAR_CRON || '0 6 * * *', runCalendarPipeline) // daily 06:00 UTC
  console.log('[calendar] scheduled:', process.env.CALENDAR_CRON || '0 6 * * *')
}
