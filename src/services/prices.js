// Daily candles from Stooq — free, no API key, plain CSV.
// US tickers use the '.us' suffix (aapl.us). Computes 30d volume baseline
// and flags unusual-volume days (>= 2x average).
const { PriceStat } = require('../models/PriceStat')

const UNUSUAL_RATIO = 2

async function fetchDailyCandles(ticker, days = 60) {
  const symbol = `${ticker.toLowerCase()}.us`
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '')
  const from = fmt(new Date(Date.now() - days * 86_400_000))
  const to = fmt(new Date())

  const res = await fetch(
    `https://stooq.com/q/d/l/?s=${symbol}&d1=${from}&d2=${to}&i=d`
  )
  if (!res.ok) throw new Error(`stooq ${res.status} for ${ticker}`)
  const csv = await res.text()
  if (!csv.startsWith('Date,')) {
    console.warn(`[prices] no data for ${ticker} (non-US or unknown symbol)`)
    return 0
  }

  const candles = csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [date, open, high, low, close, volume] = line.split(',')
      return {
        date,
        open: +open, high: +high, low: +low, close: +close,
        volume: +volume || 0,
      }
    })
    .filter((c) => c.date && !Number.isNaN(c.close))

  let upserted = 0
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const window = candles.slice(Math.max(0, i - 30), i)
    const avgVol = window.length
      ? window.reduce((s, x) => s + x.volume, 0) / window.length
      : null
    const prev = candles[i - 1]
    const ratio = avgVol && avgVol > 0 ? +(c.volume / avgVol).toFixed(2) : null

    await PriceStat.updateOne(
      { ticker: ticker.toUpperCase(), date: c.date },
      {
        $set: {
          open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
          changePct: prev ? +(((c.close - prev.close) / prev.close) * 100).toFixed(2) : undefined,
          avgVolume30d: avgVol ? Math.round(avgVol) : undefined,
          volumeRatio: ratio ?? undefined,
          unusualVolume: ratio !== null && ratio >= UNUSUAL_RATIO,
        },
      },
      { upsert: true }
    ).then((r) => { if (r.upsertedCount) upserted++ })
  }
  return upserted
}

module.exports = { fetchDailyCandles }
