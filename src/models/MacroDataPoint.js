const mongoose = require('mongoose')
const { Schema } = mongoose

// Live macro series values (FRED, free with registration). Complements
// MacroEvent (release dates only) with the actual readings.
const MacroDataPointSchema = new Schema(
  {
    series: { type: String, required: true, index: true },  // 'FEDFUNDS', 'CPIAUCSL', ...
    date: { type: String, required: true },                 // YYYY-MM-DD, observation date
    value: Number,
    unit: String,                                           // 'percent', 'yoy_pct'
    source: { type: String, default: 'fred' },
  },
  { timestamps: true }
)

MacroDataPointSchema.index({ series: 1, date: 1 }, { unique: true })

module.exports.MacroDataPoint = mongoose.model('MacroDataPoint', MacroDataPointSchema)
