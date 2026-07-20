const mongoose = require('mongoose')
const { Schema } = mongoose

// Dynamic watchlist. Tiers:
//   portfolio — held by at least one Stockfolio user (deep coverage)
//   watchlist — tracked (not held) by at least one Stockfolio user's watchlist
//   discovery — surfaced repeatedly by the news analyzer (promoted)
//   manual    — pinned via env/ops
const WatchedTickerSchema = new Schema(
  {
    ticker: { type: String, required: true, unique: true },
    tier: { type: String, enum: ['portfolio', 'watchlist', 'discovery', 'manual'], required: true },
    active: { type: Boolean, default: true, index: true },
    holdersCount: { type: Number, default: 0 },
    watchersCount: { type: Number, default: 0 },
    mentions7d: { type: Number, default: 0 },
    lastActiveAt: { type: Date, default: Date.now },
    deactivatedAt: { type: Date },
  },
  { timestamps: true }
)

module.exports.WatchedTicker = mongoose.model('WatchedTicker', WatchedTickerSchema)
