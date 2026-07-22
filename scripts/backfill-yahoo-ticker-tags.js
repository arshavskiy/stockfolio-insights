// One-time backfill for the yahoo.js/finnhub.js/analyzer.js ticker-tagging bug
// fixed 2026-07-22. Both fetchYahooNews() and fetchCompanyNews() seed
// Article.tickers with the searched-for ticker regardless of whether the
// article is actually about it (verified live: a Finnhub-sourced "Meta in
// talks with Anthropic" article was tagged SPCX purely because it was fetched
// while searching Finnhub's company-news for SPCX). analyzePendingArticles()
// used to union that seed with the LLM's own ticker list instead of replacing
// it, so any article analyzed before the fix can carry a wrong ticker tag
// that never self-corrects (analyzer only re-processes analyzed:false rows).
//
// This resets analyzed:false on ALL analyzed articles (both sources) so the
// normal analyzer loop re-tags them with the corrected (LLM-authoritative)
// logic. Re-analyzing an already-correct article is a harmless no-op cost.
// Safe to interrupt/re-run — articles already reset stay reset until
// worker:ingest's analyzer step (or scripts/run-analyzer-backlog.js) picks
// them up.
//
// Usage: node --env-file-if-exists=.env scripts/backfill-yahoo-ticker-tags.js
const { connectDB } = require('../src/db')
const { Article } = require('../src/models/Article')

async function main() {
  await connectDB()
  const filter = { analyzed: true }
  const count = await Article.countDocuments(filter)
  if (count === 0) {
    console.log('[backfill] no analyzed articles found — nothing to do')
    process.exit(0)
  }
  console.log(`[backfill] resetting analyzed:false on ${count} articles for re-tagging`)
  const result = await Article.updateMany(filter, { $set: { analyzed: false } })
  console.log(`[backfill] done — matched ${result.matchedCount}, modified ${result.modifiedCount}`)
  console.log('[backfill] run worker:ingest (or just its analyzer step) to re-process them')
  process.exit(0)
}

main().catch((err) => {
  console.error('[backfill] failed:', err)
  process.exit(1)
})
