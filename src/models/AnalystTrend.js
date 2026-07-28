const mongoose = require('mongoose')
const { Schema } = mongoose

// Monthly analyst recommendation counts.
// The signal is the month-over-month CHANGE, not the absolute level.
const AnalystTrendSchema = new Schema(
  {
    ticker: { type: String, required: true, index: true },
    period: { type: String, required: true },            // YYYY-MM-01
    strongBuy: Number,
    buy: Number,
    hold: Number,
    sell: Number,
    strongSell: Number,
    analystCount: Number,
    targetPriceAvg: Number,
    targetPriceHigh: Number,
    targetPriceLow: Number,
    currency: String,
    source: { type: String, default: 'finnhub' },
    sourceUrl: String,
  },
  { timestamps: true }
)

AnalystTrendSchema.index({ ticker: 1, period: 1 }, { unique: true })

module.exports.AnalystTrend = mongoose.model('AnalystTrend', AnalystTrendSchema)
