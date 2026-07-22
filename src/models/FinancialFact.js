const mongoose = require('mongoose')
const { Schema } = mongoose

// Latest-value fundamentals snapshot (SEC EDGAR XBRL company facts, free/keyless).
// Only the most recent annual + most recent quarterly value per concept —
// not a full historical series.
const FinancialFactSchema = new Schema(
  {
    ticker: { type: String, required: true, index: true },
    concept: { type: String, required: true },            // 'Revenues', 'NetIncomeLoss', ...
    period: { type: String, required: true },              // 'FY2025' or '2025-Q4'
    fiscalPeriodType: { type: String, enum: ['annual', 'quarterly'] },
    value: Number,
    unit: { type: String, default: 'USD' },
    filed: Date,                                           // filing date this value came from
    source: { type: String, default: 'sec-xbrl' },
  },
  { timestamps: true }
)

FinancialFactSchema.index({ ticker: 1, concept: 1, period: 1 }, { unique: true })

module.exports.FinancialFact = mongoose.model('FinancialFact', FinancialFactSchema)
