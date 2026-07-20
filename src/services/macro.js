// Seeds MacroEvent from data/macro-2026.json (official OMB/BLS/Fed calendar).
// Idempotent — safe to run every day.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { MacroEvent } = require('../models/MacroEvent')

const LABELS = {
  fomc: 'FOMC rate decision',
  cpi: 'CPI inflation report',
  ppi: 'PPI report',
  nfp: 'Jobs report (Employment Situation)',
  gdp: 'GDP estimate',
  pce: 'PCE inflation (Fed target)',
}

async function seedMacroCalendar() {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'macro-2026.json'), 'utf-8')
  )

  let upserted = 0
  for (const [type, cfg] of Object.entries(raw)) {
    if (type === 'comment' || !cfg?.dates) continue
    const sep = new Set(cfg.sepDates || [])
    for (const d of cfg.dates) {
      await MacroEvent.updateOne(
        { type, date: new Date(d) },
        {
          $set: {
            label: LABELS[type] || type,
            impact: cfg.impact || 'high',
            timeET: cfg.timeET,
            note: sep.has(d) ? 'includes SEP / dot plot' : undefined,
          },
        },
        { upsert: true }
      ).then((r) => { if (r.upsertedCount) upserted++ })
    }
  }
  return upserted
}

module.exports = { seedMacroCalendar }
