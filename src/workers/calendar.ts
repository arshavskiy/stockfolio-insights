// Daily worker: earnings calendar + SEC filings + ownership snapshots.
// These change slowly — no need for the 20-minute news cadence.
import cron from 'node-cron'
import { connectDB } from '../db'
import { fetchEarningsCalendar } from '../services/earnings'
import { fetchSecFilings } from '../services/secFilings'
import { refreshOwnership } from '../services/ownership'
import { fetchEarningsSurprises, fetchAnalystTrends, fetchDividends } from '../services/fundamentals'
import { fetchShortInterest } from '../services/shortInterestSvc'

const watchlist = (process.env.WATCHLIST || 'AAPL,MSFT,NVDA')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)

export async function runCalendarPipeline() {
  console.log('[calendar] start')
  try {
    const earnings = await fetchEarningsCalendar()
    console.log(`[calendar] earnings upserted: ${earnings}`)
  } catch (e: any) {
    console.error('[calendar] earnings failed:', e.message)
  }
  for (const t of watchlist) {
    try {
      const filings = await fetchSecFilings(t)
      await refreshOwnership(t)
      await fetchEarningsSurprises(t)
      await fetchAnalystTrends(t)
      await fetchDividends(t)
      await fetchShortInterest(t)
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
