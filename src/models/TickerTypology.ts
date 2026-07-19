import mongoose, { Schema } from 'mongoose'

// Derived ticker archetype — computed daily from our own collections.
// No external API calls; pure classification over collected data.
const TickerTypologySchema = new Schema(
  {
    ticker: { type: String, required: true, unique: true },
    // dimensions
    marketCapClass: { type: String, enum: ['mega', 'large', 'mid', 'small', 'micro', 'unknown'] },
    style: { type: String, enum: ['growth', 'value', 'blend', 'speculative', 'unknown'] },
    volatilityClass: { type: String, enum: ['low', 'medium', 'high', 'unknown'] },
    dividendProfile: { type: String, enum: ['none', 'payer', 'high-yield', 'unknown'] },
    newsProfile: { type: String, enum: ['quiet', 'covered', 'hot', 'unknown'] },
    insiderSignal: { type: String, enum: ['buying', 'selling', 'neutral', 'unknown'] },
    squeezeRisk: { type: String, enum: ['low', 'elevated', 'high', 'unknown'] },
    primaryIndustry: { type: String },
    industries: { type: [String], default: [] },
    // flat tag list for chips/filters, e.g. ['mega-cap','growth','high-beta','hot-coverage']
    tags: { type: [String], default: [], index: true },
    // raw inputs snapshot for transparency/debugging
    inputs: {
      marketCap: Number,
      peRatio: Number,
      beta: Number,
      dividendYield: Number,
      daysToCover: Number,
      articleCount7d: Number,
      insiderNet3m: Number,
    },
    computedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
)

export const TickerTypology = mongoose.model('TickerTypology', TickerTypologySchema)
