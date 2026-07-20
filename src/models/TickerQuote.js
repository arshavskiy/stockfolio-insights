const mongoose = require('mongoose')
const { Schema } = mongoose

// Our own per-ticker quote store — the UI's primary data source.
// Fast fields refresh every poll cycle; profile fields refresh daily.
const TickerQuoteSchema = new Schema(
  {
    ticker: { type: String, required: true, unique: true },
    // --- fast fields (quote poller, every few minutes) ---
    price: Number,
    previousClose: Number,
    change: Number,
    changePct: Number,
    dayHigh: Number,
    dayLow: Number,
    volume: Number,
    marketState: String,               // PRE | REGULAR | POST | CLOSED
    quoteUpdatedAt: Date,
    // --- slow fields (daily) ---
    name: String,
    exchange: String,
    currency: String,
    fiftyTwoWeekHigh: Number,
    fiftyTwoWeekLow: Number,
    marketCap: Number,
    peRatio: Number,
    eps: Number,
    dividendYield: Number,
    beta: Number,
    logo: String,
    profileUpdatedAt: Date,
    // consecutive fetch failures — used to skip dead symbols
    failCount: { type: Number, default: 0 },
  },
  { timestamps: true }
)

module.exports.TickerQuote = mongoose.model('TickerQuote', TickerQuoteSchema)
