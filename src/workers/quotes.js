// Quote poller — keeps TickerQuote fresh for every active watchlist ticker.
// Runs every few minutes; skips symbols with repeated failures.
const cron = require('node-cron')
const { connectDB } = require('../db')
const { refreshWatchlist, getActiveTickers } = require('../services/watchlist')
const { refreshQuote } = require('../services/yahoo')
const { TickerQuote } = require('../models/TickerQuote')

const CONCURRENCY = 5
const MAX_FAILS = 10

async function runQuotePoll() {
  // Poll the current active watchlist and skip symbols that have failed too often.
  const tickers = await getActiveTickers()
  const dead = new Set(
    (await TickerQuote.find({ failCount: { $gte: MAX_FAILS } }).select('ticker').lean())
      .map((d) => d.ticker)
  )
  const queue = tickers.filter((t) => !dead.has(t))
  console.log(`[quotes] start — ${queue.length} tickers (${dead.size} skipped as dead)`)

  let ok = 0
  const totalBatches = Math.ceil(queue.length / CONCURRENCY)
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map((t) => refreshQuote(t)))
    const batchOk = results.filter((r) => r.status === 'fulfilled' && r.value).length
    ok += batchOk
    console.log(`[quotes] batch ${i / CONCURRENCY + 1}/${totalBatches}: ${batch.join(',')} — ${batchOk}/${batch.length} ok`)
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`[quotes] done — refreshed ${ok}/${queue.length}`)
}

if (require.main === module) {
  ;(async () => {
    await connectDB()
    await refreshWatchlist()
    await runQuotePoll()
    cron.schedule(process.env.QUOTES_CRON || '*/5 * * * *', runQuotePoll)
    cron.schedule('*/30 * * * *', async () => {
      const { active } = await refreshWatchlist()
      console.log(`[watchlist] refreshed — ${active} active tickers`)
    })
    console.log('[quotes] scheduled:', process.env.QUOTES_CRON || '*/5 * * * *')
  })()
}

module.exports = { runQuotePoll }
