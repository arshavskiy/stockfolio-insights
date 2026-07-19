// Seeds MacroEvent from data/macro-2026.json (official OMB/BLS/Fed calendar).
// Idempotent — safe to run every day.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MacroEvent } from '../models/MacroEvent'

const LABELS: Record<string, string> = {
  fomc: 'FOMC rate decision',
  cpi: 'CPI inflation report',
  ppi: 'PPI report',
  nfp: 'Jobs report (Employment Situation)',
  gdp: 'GDP estimate',
  pce: 'PCE inflation (Fed target)',
}

export async function seedMacroCalendar(): Promise<number> {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'macro-2026.json'), 'utf-8')
  )

  let upserted = 0
  for (const [type, cfg] of Object.entries<any>(raw)) {
    if (type === 'comment' || !cfg?.dates) continue
    const sep: Set<string> = new Set(cfg.sepDates || [])
    for (const d of cfg.dates as string[]) {
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
