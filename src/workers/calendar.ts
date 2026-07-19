// Daily worker: earnings calendar + SEC filings + ownership snapshots.
// These change slowly — no need for the 20-minute news cadence.
import cron from 'node-cron'
import { connectDB } from '../db'
import { fetchEarningsCalendar } from '../services/earnings'
import { fetchSecFilings } from '../services/secFilings'
import { refreshOwnership } from '../services/ownership'

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
      console.log(`[calendar] ${t}: ${filings} filings`)
      await new Promise((r) => setTimeout(r, 1100)) // SEC asks max 10 req/s; Finnhub 60/min
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
