// Read-only typology endpoints for overview maps and per-ticker labels.
const { Router } = require('express')
const { TickerTypology } = require('../models/TickerTypology')

const typology = Router()

// GET /typology/map?group=primaryIndustry — grouped overview for treemap/heatmap UI.
// group options: primaryIndustry | style | marketCapClass | volatilityClass
const GROUPS = new Set(['primaryIndustry', 'style', 'marketCapClass', 'volatilityClass'])

typology.get('/map', async (req, res) => {
  const group = String(req.query.group || 'primaryIndustry')
  if (!GROUPS.has(group)) return res.status(400).json({ error: `group must be one of ${[...GROUPS]}` })

  const rows = await TickerTypology.aggregate([
    {
      $group: {
        _id: { $ifNull: [`$${group}`, 'unknown'] },
        count: { $sum: 1 },
        tickers: {
          $push: {
            ticker: '$ticker',
            style: '$style',
            marketCapClass: '$marketCapClass',
            newsProfile: '$newsProfile',
            tags: '$tags',
          },
        },
      },
    },
    { $sort: { count: -1 } },
  ])
  res.json({ groupBy: group, groups: rows.map((r) => ({ key: r._id, count: r.count, tickers: r.tickers })) })
})

// GET /typology/tags/insider-buying — filter tickers by tag (chip navigation)
typology.get('/tags/:tag', async (req, res) => {
  const rows = await TickerTypology.find({ tags: req.params.tag })
    .select('ticker tags primaryIndustry marketCapClass style computedAt')
    .lean()
  res.json({ tag: req.params.tag, count: rows.length, tickers: rows })
})

// GET /typology/:ticker — full archetype with the raw inputs behind each label
typology.get('/:ticker', async (req, res) => {
  const row = await TickerTypology.findOne({ ticker: req.params.ticker.toUpperCase() }).lean()
  if (!row) return res.status(404).json({ error: 'no typology computed yet' })
  res.json(row)
})

module.exports.typology = typology
