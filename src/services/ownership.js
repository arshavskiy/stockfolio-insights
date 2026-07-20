// Investor typology. Free coverage today: insider transactions (Finnhub free).
// Institutional/top-holder fields fill in when you plug a paid source
// (Finnhub premium /stock/ownership or FMP institutional-holders).
const { OwnershipSnapshot } = require('../models/OwnershipSnapshot')

const BASE = 'https://finnhub.io/api/v1'

async function refreshOwnership(ticker) {
  const key = process.env.FINNHUB_API_KEY
  if (!key) throw new Error('FINNHUB_API_KEY is not set')

  const from = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
  const res = await fetch(
    `${BASE}/stock/insider-transactions?symbol=${ticker}&from=${from}&token=${key}`
  )
  if (!res.ok) throw new Error(`finnhub insider ${res.status} for ${ticker}`)
  const data = await res.json()

  const txs = data.data || []
  const net = txs.reduce((s, t) => s + (t.change || 0), 0)

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  await OwnershipSnapshot.updateOne(
    { ticker: ticker.toUpperCase(), asOf: today },
    {
      $set: {
        insiderNet3m: net,
        insiderTxCount3m: txs.length,
        source: 'finnhub-free',
        // institutionalPct / topHolders intentionally left unset until a
        // paid data source is configured (see OWNERSHIP_PROVIDER in .env)
      },
    },
    { upsert: true }
  )
}

module.exports = { refreshOwnership }
