import mongoose, { Schema } from 'mongoose'

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
    // filing-specific
    accessionNo: { type: String },
    filingUrl: { type: String },
    source: { type: String, required: true },            // 'finnhub' | 'sec-edgar' | 'maya'
  },
  { timestamps: true }
)

CorporateEventSchema.index({ ticker: 1, type: 1, date: 1 }, { unique: true })

export const CorporateEvent = mongoose.model('CorporateEvent', CorporateEventSchema)
