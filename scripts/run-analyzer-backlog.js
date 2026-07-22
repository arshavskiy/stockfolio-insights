// Drains the analyzer backlog (analyzed:false articles) without running the
// rest of worker:ingest's pipeline (news fetching). Used after
// backfill-yahoo-ticker-tags.js resets a batch of articles for re-tagging.
// Safe to interrupt — analyzePendingArticles() commits each batch of 20
// immediately, so progress is never lost mid-run.
const { connectDB } = require('../src/db')
const { analyzePendingArticles } = require('../src/services/analyzer')

async function main() {
  await connectDB()
  let total = 0
  let batch
  do {
    batch = await analyzePendingArticles()
    total += batch
    if (batch > 0) console.log(`[backlog] analyzed ${batch} (total ${total})`)
  } while (batch > 0)
  console.log(`[backlog] done — ${total} articles re-analyzed`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[backlog] failed:', err)
  process.exit(1)
})
