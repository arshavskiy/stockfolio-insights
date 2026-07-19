// Scheduled pipeline: fetch news -> analyze -> aggregate.
import cron from 'node-cron'
import { connectDB } from '../db'
import { fetchCompanyNews } from '../services/finnhub'
import { analyzePendingArticles } from '../services/analyzer'
import { rebuildDailyAggregates } from '../services/aggregate'

const watchlist = (process.env.WATCHLIST || 'AAPL,MSFT,NVDA')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)

export async function runPipeline() {
  console.log(`[pipeline] start — ${watchlist.length} tickers`)
  let fetched = 0
  for (const t of watchlist) {
    try {
      fetched += await fetchCompanyNews(t)
      await new Promise((r) => setTimeout(r, 1100)) // stay under free-tier rate limit
    } catch (e: any) {
      console.error(`[pipeline] fetch failed for ${t}:`, e.message)
    }
  }
  // analyze in batches until queue drained (cap loops as safety)
  let analyzed = 0
  for (let i = 0; i < 10; i++) {
    const n = await analyzePendingArticles()
    analyzed += n
    if (n === 0) break
  }
  const aggregated = await rebuildDailyAggregates()
  console.log(`[pipeline] done — fetched ${fetched}, analyzed ${analyzed}, aggregated ${aggregated} rows`)
}

if (import.meta.main) {
  await connectDB()
  await runPipeline() // run once on boot
  cron.schedule(process.env.INGEST_CRON || '*/20 * * * *', runPipeline)
  console.log('[worker] scheduled:', process.env.INGEST_CRON || '*/20 * * * *')
}
