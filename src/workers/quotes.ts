// Quote poller — keeps TickerQuote fresh for every active watchlist ticker.
// Runs every few minutes; skips symbols with repeated failures.
import cron from 'node-cron'
import { connectDB } from '../db'
import { refreshWatchlist, getActiveTickers } from '../services/watchlist'
import { refreshQuote } from '../services/yahoo'
import { TickerQuote } from '../models/TickerQuote'

const CONCURRENCY = 5
const MAX_FAILS = 10

export async function runQuotePoll() {
  const tickers = await getActiveTickers()
  const dead = new Set(
    (await TickerQuote.find({ failCount: { $gte: MAX_FAILS } }).select('ticker').lean())
      .map((d) => d.ticker)
  )
  const queue = tickers.filter((t) => !dead.has(t))

  let ok = 0
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map((t) => refreshQuote(t)))
    ok += results.filter((r) => r.status === 'fulfilled' && r.value).length
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`[quotes] refreshed ${ok}/${queue.length} (${dead.size} skipped as dead)`)
}

if (import.meta.main) {
  await connectDB()
  await refreshWatchlist()
  await runQuotePoll()
  cron.schedule(process.env.QUOTES_CRON || '*/5 * * * *', runQuotePoll)
  cron.schedule('*/30 * * * *', async () => {
    const { active } = await refreshWatchlist()
    console.log(`[watchlist] refreshed — ${active} active tickers`)
  })
  console.log('[quotes] scheduled:', process.env.QUOTES_CRON || '*/5 * * * *')
}
