import mongoose, { Schema } from 'mongoose'

// Daily OHLCV + volume anomaly stats per ticker (source: Stooq, free/keyless).
const PriceStatSchema = new Schema(
  {
    ticker: { type: String, required: true, index: true },
    date: { type: String, required: true },              // YYYY-MM-DD
    open: Number,
    high: Number,
    low: Number,
    close: Number,
    volume: Number,
    changePct: Number,                                   // close vs previous close
    avgVolume30d: Number,
    volumeRatio: Number,                                 // volume / avgVolume30d
    unusualVolume: { type: Boolean, default: false },    // ratio >= 2
  },
  { timestamps: true }
)

PriceStatSchema.index({ ticker: 1, date: 1 }, { unique: true })

export const PriceStat = mongoose.model('PriceStat', PriceStatSchema)
