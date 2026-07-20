// Watchlist lifecycle: sync from Stockfolio positions, promote discoveries,
// decay dead tickers. Both workers call getActiveTickers() each cycle.
const mongoose = require('mongoose')
const { WatchedTicker } = require('../models/WatchedTicker')
const { Article } = require('../models/Article')

const DISCOVERY_MIN_MENTIONS = Number(process.env.DISCOVERY_MIN_MENTIONS) || 5
const DECAY_DAYS = Number(process.env.WATCHLIST_DECAY_DAYS) || 30
const MAX_ACTIVE = Number(process.env.WATCHLIST_MAX) || 150 // Finnhub free-tier budget
const WATCHLISTS_COLLECTION = process.env.WATCHLISTS_COLLECTION || 'watchlists'

async function refreshWatchlist() {
  const now = new Date()

  // 1) portfolio tier — distinct tickers from the Stockfolio positions collection
  //    (same Atlas cluster; DB/collection/field configurable)
  try {
    const dbName = process.env.STOCKFOLIO_DB_NAME || 'stockfolio'
    const coll = process.env.POSITIONS_COLLECTION || 'positions'
    const field = process.env.POSITIONS_TICKER_FIELD || 'ticker'
    const positions = mongoose.connection.useDb(dbName, { useCache: true }).collection(coll)

    const held = await positions
      .aggregate([
        { $group: { _id: { $toUpper: `$${field}` }, holders: { $sum: 1 } } },
      ])
      .toArray()

    for (const h of held) {
      if (!h._id) continue
      await WatchedTicker.updateOne(
        { ticker: h._id },
        {
          $set: { tier: 'portfolio', active: true, holdersCount: h.holders, lastActiveAt: now },
          $unset: { deactivatedAt: '' },
        },
        { upsert: true }
      )
    }
    // portfolio tickers no longer held fall back to discovery; step 2 below
    // re-promotes to 'watchlist' if still tracked in the watchlists collection
    const heldSet = held.map((h) => h._id).filter(Boolean)
    await WatchedTicker.updateMany(
      { tier: 'portfolio', ticker: { $nin: heldSet } },
      { $set: { holdersCount: 0, tier: 'discovery' } }
    )
  } catch (e) {
    console.warn('[watchlist] positions sync skipped:', e.message)
  }

  // 2) watchlist tier — distinct tickers from the Stockfolio watchlists collection
  //    (tracked-but-not-held tickers; same Atlas cluster/DB as positions)
  try {
    const dbName = process.env.STOCKFOLIO_DB_NAME || 'stockfolio'
    const field = process.env.POSITIONS_TICKER_FIELD || 'ticker'
    const watchlists = mongoose.connection.useDb(dbName, { useCache: true }).collection(WATCHLISTS_COLLECTION)

    const watched = await watchlists
      .aggregate([
        { $group: { _id: { $toUpper: `$${field}` }, watchers: { $sum: 1 } } },
      ])
      .toArray()

    // look up existing tiers up front so upserts don't collide with the
    // ticker's unique index (a partial-filter upsert can't tell "no match
    // because tier differs" from "no document exists at all")
    const existingTiers = new Map(
      (await WatchedTicker.find({ ticker: { $in: watched.map((w) => w._id).filter(Boolean) } })
        .select('ticker tier')
        .lean()
      ).map((d) => [d.ticker, d.tier])
    )

    for (const w of watched) {
      if (!w._id) continue
      const currentTier = existingTiers.get(w._id)
      if (currentTier === 'portfolio' || currentTier === 'manual') {
        // higher tier already claims this ticker — just record watcher count
        await WatchedTicker.updateOne({ ticker: w._id }, { $set: { watchersCount: w.watchers } })
      } else {
        await WatchedTicker.updateOne(
          { ticker: w._id },
          {
            $set: { tier: 'watchlist', active: true, watchersCount: w.watchers, lastActiveAt: now },
            $unset: { deactivatedAt: '' },
          },
          { upsert: true }
        )
      }
    }
  } catch (e) {
    console.warn('[watchlist] watchlists sync skipped:', e.message)
  }

  // 4) manual tier — env pins survive everything
  for (const t of (process.env.WATCHLIST || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) {
    await WatchedTicker.updateOne(
      { ticker: t },
      { $set: { active: true, lastActiveAt: now }, $setOnInsert: { tier: 'manual' } },
      { upsert: true }
    )
  }

  // 5) discovery promotion — analyzer-found tickers with sustained coverage
  const since = new Date(Date.now() - 7 * 86_400_000)
  const mentioned = await Article.aggregate([
    { $match: { analyzed: true, publishedAt: { $gte: since } } },
    { $unwind: '$tickers' },
    { $group: { _id: '$tickers', n: { $sum: 1 } } },
    { $match: { n: { $gte: DISCOVERY_MIN_MENTIONS } } },
  ])
  for (const m of mentioned) {
    await WatchedTicker.updateOne(
      { ticker: m._id },
      {
        $set: { mentions7d: m.n, lastActiveAt: now, active: true },
        $setOnInsert: { tier: 'discovery' },
      },
      { upsert: true }
    )
  }

  // 6) decay — no holders, no recent mentions, quiet for DECAY_DAYS
  const cutoff = new Date(Date.now() - DECAY_DAYS * 86_400_000)
  await WatchedTicker.updateMany(
    { active: true, tier: 'discovery', holdersCount: 0, lastActiveAt: { $lt: cutoff } },
    { $set: { active: false, deactivatedAt: now } }
  )

  // 7) hard cap — protect API budget; portfolio > manual > watchlist > discovery
  const active = await WatchedTicker.find({ active: true }).lean()
  const rank = (t) =>
    (t.tier === 'portfolio' ? 4_000_000 : t.tier === 'manual' ? 3_000_000 : t.tier === 'watchlist' ? 2_000_000 : 0) +
    t.holdersCount * 1000 + t.watchersCount * 100 + t.mentions7d
  const sorted = [...active].sort((a, b) => rank(b) - rank(a))
  if (sorted.length > MAX_ACTIVE) {
    const evict = sorted.slice(MAX_ACTIVE).map((t) => t.ticker)
    await WatchedTicker.updateMany(
      { ticker: { $in: evict } },
      { $set: { active: false, deactivatedAt: now } }
    )
    console.warn(`[watchlist] capped at ${MAX_ACTIVE}, deactivated ${evict.length}`)
  }

  const count = await WatchedTicker.countDocuments({ active: true })
  return { active: count }
}

async function getActiveTickers() {
  const rows = await WatchedTicker.find({ active: true }).select('ticker').lean()
  if (rows.length) return rows.map((r) => r.ticker)
  // cold start fallback
  return (process.env.WATCHLIST || 'AAPL,MSFT,NVDA')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
}

module.exports = { refreshWatchlist, getActiveTickers }
