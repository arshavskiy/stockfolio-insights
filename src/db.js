// Shared MongoDB bootstrap for the API and workers.
const mongoose = require('mongoose')

async function connectDB() {
  // Every worker and route depends on a single connection pool.
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI is not set')
  await mongoose.connect(uri)
  console.log('[db] connected')
}

module.exports = { connectDB }
