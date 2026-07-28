// One-shot Israeli business-news ingestion for smoke tests/backfills.
const mongoose = require('mongoose')
const { connectDB } = require('../src/db')
const { fetchIsraeliBusinessNews } = require('../src/services/israeliNews')

;(async () => {
  await connectDB()
  const inserted = await fetchIsraeliBusinessNews()
  console.log(`[israeli-news] inserted ${inserted}`)
})()
  .catch((e) => {
    console.error('[israeli-news] fatal:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await mongoose.disconnect()
  })
