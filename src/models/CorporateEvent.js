const mongoose = require('mongoose')
const { Schema } = mongoose

// Market-moving calendar events per ticker: earnings, SEC filings, dividends.
const CorporateEventSchema = new Schema(
  {
    ticker: { type: String, required: true, index: true },
    type: {
      type: String,
      required: true,
      enum: ['earnings', '10-K', '10-Q', '8-K', '20-F', '6-K', 'dividend', 'split', 'other-filing'],
      index: true,
    },
    date: { type: Date, required: true, index: true },   // event/filing date
    period: { type: String },                            // e.g. '2026-Q2', 'FY2025'
    // earnings-specific
    epsEstimate: { type: Number },
    epsActual: { type: Number },
    revenueEstimate: { type: Number },
    revenueActual: { type: Number },
    hour: { type: String },                              // 'bmo' (before open) | 'amc' (after close)
    surprisePct: { type: Number },                       // (actual-estimate)/|estimate| for earnings
    // dividend-specific (date = ex-dividend date)
    amount: { type: Number },
    currency: { type: String },
    payDate: { type: Date },
    recordDate: { type: Date },
    // filing-specific
    accessionNo: { type: String },
    items: { type: [String], default: undefined },       // 8-K item codes e.g. ['5.02','9.01']
    itemLabels: { type: [String], default: undefined },  // human-readable classification
    filingUrl: { type: String },
    source: { type: String, required: true },            // 'finnhub' | 'sec-edgar' | 'maya'
  },
  { timestamps: true }
)

CorporateEventSchema.index({ ticker: 1, type: 1, date: 1 }, { unique: true })

module.exports.CorporateEvent = mongoose.model('CorporateEvent', CorporateEventSchema)
