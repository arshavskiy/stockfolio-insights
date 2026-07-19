import mongoose, { Schema } from 'mongoose'

// Investor typology per ticker. Free sources cover insider activity;
// institutional/fund fields are schema-ready for a paid source (FMP/Finnhub premium).
const OwnershipSnapshotSchema = new Schema(
  {
    ticker: { type: String, required: true, index: true },
    asOf: { type: Date, required: true },
    // typology breakdown (percentages of float where known)
    insiderPct: { type: Number },
    institutionalPct: { type: Number },
    retailPctEstimate: { type: Number },                 // 100 - insider - institutional
    topHolders: [
      {
        name: String,
        type: { type: String, enum: ['institution', 'fund', 'insider', 'other'] },
        shares: Number,
        pct: Number,
        changePct: Number,
      },
    ],
    // rolling insider activity from free Finnhub endpoint
    insiderNet3m: { type: Number },                      // net shares bought(+)/sold(-) trailing 3m
    insiderTxCount3m: { type: Number },
    source: { type: String, required: true },
  },
  { timestamps: true }
)

OwnershipSnapshotSchema.index({ ticker: 1, asOf: 1 }, { unique: true })

export const OwnershipSnapshot = mongoose.model('OwnershipSnapshot', OwnershipSnapshotSchema)
