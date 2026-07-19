import mongoose, { Schema } from 'mongoose'

// Raw ingested news article. Deduped by (source, sourceId) or url.
const ArticleSchema = new Schema(
  {
    source: { type: String, required: true },          // 'finnhub' | 'rss:globes' | ...
    sourceId: { type: String },                        // provider's article id if available
    url: { type: String, required: true },
    headline: { type: String, required: true },
    summary: { type: String },
    publishedAt: { type: Date, required: true, index: true },
    // filled by the analyzer
    analyzed: { type: Boolean, default: false, index: true },
    tickers: { type: [String], default: [], index: true },
    industries: { type: [String], default: [], index: true },
    sentiment: { type: Number, min: -1, max: 1 },      // -1 bearish .. 1 bullish
    themes: { type: [String], default: [] },           // e.g. ['china-demand','antitrust']
    llmSummary: { type: String },
  },
  { timestamps: true }
)

ArticleSchema.index({ source: 1, sourceId: 1 }, { unique: true, sparse: true })
ArticleSchema.index({ url: 1 }, { unique: true })

export const Article = mongoose.model('Article', ArticleSchema)
