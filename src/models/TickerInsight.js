const mongoose = require('mongoose')
const { Schema } = mongoose

// Rolling aggregate per ticker per day — cheap to query from the Vue frontend.
const TickerInsightSchema = new Schema(
  {
    ticker: { type: String, required: true },
    date: { type: String, required: true },            // YYYY-MM-DD (UTC)
    articleCount: { type: Number, default: 0 },
    avgSentiment: { type: Number, default: 0 },
    // sentiment velocity = today's avg minus trailing 7d avg; NOT a buy signal
    momentum: { type: Number, default: 0 },
    topThemes: { type: [String], default: [] },
    industries: { type: [String], default: [] },
  },
  { timestamps: true }
)

TickerInsightSchema.index({ ticker: 1, date: 1 }, { unique: true })

module.exports.TickerInsight = mongoose.model('TickerInsight', TickerInsightSchema)
