import mongoose, { Schema } from 'mongoose'

// High-impact US macro releases that move the whole market.
// Seeded from the official OMB/BLS/Fed 2026 release calendar.
const MacroEventSchema = new Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['fomc', 'cpi', 'ppi', 'nfp', 'gdp', 'pce'],
      index: true,
    },
    date: { type: Date, required: true, index: true },
    label: { type: String, required: true },
    impact: { type: String, enum: ['high', 'medium'], default: 'high' },
    timeET: { type: String },                            // '08:30' | '14:00'
    note: { type: String },                              // e.g. 'includes SEP/dot plot'
    source: { type: String, default: 'seed-official-2026' },
  },
  { timestamps: true }
)

MacroEventSchema.index({ type: 1, date: 1 }, { unique: true })

export const MacroEvent = mongoose.model('MacroEvent', MacroEventSchema)
