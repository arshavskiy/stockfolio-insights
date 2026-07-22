// FRED (Federal Reserve Economic Data) — free with registration. Live values
// for the macro series MacroEvent only has dates for. Latest observation per
// series, upserted daily — not a historical backfill.
const { MacroDataPoint } = require('../models/MacroDataPoint')

const BASE = 'https://api.stlouisfed.org/fred/series/observations'

const key = () => {
  const k = process.env.FRED_API_KEY
  if (!k) throw new Error('FRED_API_KEY is not set')
  return k
}

// series id -> { unit, yoy: compute year-over-year % change from a 13-point index instead of raw level }
const SERIES = {
  FEDFUNDS: { unit: 'percent' },
  CPIAUCSL: { unit: 'yoy_pct', yoy: true },
  PCEPILFE: { unit: 'yoy_pct', yoy: true },
  UNRATE: { unit: 'percent' },
  DGS10: { unit: 'percent' },
}

async function fetchObservations(seriesId, limit) {
  const url = `${BASE}?series_id=${seriesId}&api_key=${key()}&file_type=json&sort_order=desc&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fred ${res.status} for ${seriesId}`)
  const data = await res.json()
  return (data.observations || []).filter((o) => o.value !== '.') // '.' = missing reading
}

async function fetchMacroSeries() {
  let upserted = 0
  for (const [seriesId, cfg] of Object.entries(SERIES)) {
    try {
      // Fetch a few extra months of buffer for YoY series — an occasional
      // missing reading (e.g. a reporting gap) would otherwise shrink the
      // post-filter array below the 12-back index we need.
      const obs = await fetchObservations(seriesId, cfg.yoy ? 15 : 1)
      if (!obs.length) continue

      const latest = obs[0]
      let value = Number(latest.value)
      if (cfg.yoy) {
        const yearAgo = obs[12] // 12 valid monthly observations back from latest
        if (!yearAgo) continue
        value = ((Number(latest.value) - Number(yearAgo.value)) / Number(yearAgo.value)) * 100
      }

      const r = await MacroDataPoint.updateOne(
        { series: seriesId, date: latest.date },
        { $set: { value, unit: cfg.unit, source: 'fred' } },
        { upsert: true }
      )
      if (r.upsertedCount) upserted++
    } catch (e) {
      console.error(`[fred] ${seriesId} failed:`, e.message)
    }
  }
  return upserted
}

module.exports = { fetchMacroSeries }
