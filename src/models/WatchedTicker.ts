import mongoose, { Schema } from 'mongoose'

// Dynamic watchlist. Tiers:
//   portfolio — held by at least one Stockfolio user (deep coverage)
//   discovery — surfaced repeatedly by the news analyzer (promoted)
//   manual    — pinned via env/ops
const WatchedTickerSchema = new Schema(
  {
    ticker: { type: String, required: true, unique: true },
    tier: { type: String, enum: ['portfolio', 'discovery', 'manual'], required: true },
    active: { type: Boolean, default: true, index: true },
    holdersCount: { type: Number, default: 0 },
    mentions7d: { type: Number, default: 0 },
    lastActiveAt: { type: Date, default: Date.now },
    deactivatedAt: { type: Date },
  },
  { timestamps: true }
)

export const WatchedTicker = mongoose.model('WatchedTicker', WatchedTickerSchema)
