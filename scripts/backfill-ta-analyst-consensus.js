// Backfill analyst consensus for active TASE symbols.
// Usage:
//   node --env-file-if-exists=.env scripts/backfill-ta-analyst-consensus.js --dry-run
//   node --env-file-if-exists=.env scripts/backfill-ta-analyst-consensus.js --refresh-watchlist
const mongoose = require('mongoose')
const { connectDB } = require('../src/db')
const { refreshWatchlist, getActiveTickers } = require('../src/services/watchlist')
const { fetchAnalystTrends } = require('../src/services/fundamentals')
const { AnalystTrend } = require('../src/models/AnalystTrend')

const args = new Set(process.argv.slice(2))

function usage() {
  console.log([
    'Usage: node --env-file-if-exists=.env scripts/backfill-ta-analyst-consensus.js [--dry-run] [--refresh-watchlist] [--tickers=POLI.TA,LUMI.TA]',
    '',
    'Options:',
    '  --dry-run            List target .TA tickers without fetching/writing analyst data.',
    '  --refresh-watchlist  Sync active tickers from Stockfolio before selecting .TA targets.',
    '  --tickers=...        Override DB watchlist and process only these comma-separated tickers.',
  ].join('\n'))
}

function tickersArg() {
  const raw = process.argv.find((a) => a.startsWith('--tickers='))?.slice('--tickers='.length)
  if (!raw) return null
  return raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
}

async function currentCount(ticker) {
  return AnalystTrend.countDocuments({ ticker })
}

async function run() {
  if (args.has('--help') || args.has('-h')) {
    usage()
    return
  }

  const dryRun = args.has('--dry-run')
  await connectDB()

  if (args.has('--refresh-watchlist')) {
    const result = await refreshWatchlist()
    console.log(`[backfill:ta-analyst] watchlist refreshed: ${result.active} active`)
  }

  const allTickers = tickersArg() || await getActiveTickers()
  const tickers = [...new Set(allTickers)]
    .map((t) => t.toUpperCase())
    .filter((t) => t.endsWith('.TA'))
    .sort()

  console.log(`[backfill:ta-analyst] target .TA tickers: ${tickers.length}`)
  if (tickers.length) console.log(`[backfill:ta-analyst] ${tickers.join(', ')}`)
  if (dryRun) return

  let changed = 0
  let skipped = 0
  let failed = 0

  for (const ticker of tickers) {
    try {
      const before = await currentCount(ticker)
      const result = await fetchAnalystTrends(ticker)
      const after = await currentCount(ticker)
      const didChange = result > 0 || after > before
      if (didChange) changed++
      else skipped++
      console.log(`[backfill:ta-analyst] ${ticker}: ${didChange ? 'updated' : 'no data'} (${result})`)
    } catch (e) {
      failed++
      console.error(`[backfill:ta-analyst] ${ticker}: failed: ${e.message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  console.log(`[backfill:ta-analyst] done: ${changed} updated, ${skipped} no data, ${failed} failed`)
}

run()
  .catch((e) => {
    console.error('[backfill:ta-analyst] fatal:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await mongoose.disconnect()
  })
