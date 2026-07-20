const mongoose = require('mongoose')
const { Schema } = mongoose

// FINRA consolidated short interest — published twice monthly.
const ShortInterestSchema = new Schema(
  {
    ticker: { type: String, required: true, index: true },
    settlementDate: { type: Date, required: true },
    shortInterest: Number,          // shares
    avgDailyVolume: Number,
    daysToCover: Number,            // shortInterest / avgDailyVolume
    changePct: Number,              // vs previous report
    source: { type: String, default: 'finra' },
  },
  { timestamps: true }
)

ShortInterestSchema.index({ ticker: 1, settlementDate: 1 }, { unique: true })

module.exports.ShortInterest = mongoose.model('ShortInterest', ShortInterestSchema)
