# CLAUDE.md — stockfolio-insights

News-driven market insights microservice for **Stockfolio** (Pavel's Vue 3 stock portfolio app).
This service is the data platform; the Stockfolio frontend/backend are separate repos.

## Stack & conventions
- **Node.js** (18+) runtime, Express, CommonJS JavaScript (`require`/`module.exports`, no TypeScript), Mongoose on MongoDB Atlas
- Match existing style: no semicolons debate — follow file as-is; 2-space indent
- No type-checking step — plain JS, review by reading. (Prior versions ran on Bun + TypeScript; migrated to Node + CommonJS to match the sibling Portfolio server's conventions.)
- Deploy target: Railway (workers + API), same Atlas cluster as Stockfolio main app

## Architecture (write/read strictly separated)
```
WORKERS (write-only)                          COLLECTIONS                 API (read-only)
worker:ingest   */20min  news(Finnhub+Yahoo)  Article, TickerInsight      /insights/*
                         →LLM→aggregate
worker:calendar daily    events/fundamentals  CorporateEvent, Analyst-    /events/*
                         prices, typology     Trend, ShortInterest,       /typology/*
                                              PriceStat, MacroEvent,
                                              OwnershipSnapshot,
                                              TickerTypology
worker:quotes   */5min   Yahoo v8 quotes      TickerQuote                 /quotes/*
                                              WatchedTicker               /enrich/:ticker (composed)
```
- All workers start with `refreshWatchlist()` then loop `getActiveTickers()` (src/services/watchlist.ts)
- Watchlist tiers: **portfolio** (synced from Stockfolio `positions` collection) > **manual** (env) > **watchlist** (synced from Stockfolio `watchlists` collection, tracked-not-held) > **discovery** (news-mentioned ≥5x/7d); 30d decay applies to discovery only; cap 150 (API budget)
- `/enrich/:ticker` = the Position page payload: 5-min in-memory TTL cache, badge-ready `summary` block, all fields degrade to null/[]

## Data sources & WHY (decisions made — don't relitigate)
- **Finnhub free**: company news, earnings calendar+surprises, analyst recs, insider tx, profile/metrics. Rate: 60/min → workers pace with sleeps
- **Yahoo `v1/finance/search`** (`fetchYahooNews` in yahoo.js): second, keyless news source — noticeably higher volume than Finnhub's company-news free tier, and covers tickers Finnhub 403s on (e.g. TASE `.TA` symbols). Runs alongside Finnhub in `worker:ingest`, same `Article` collection, `source:'yahoo'`, deduped by `(source, sourceId)`/`url` like every other source. Seeds `tickers` from the item's `relatedTickers` (not just the ticker searched by) for broader downstream tagging
- **SEC EDGAR** (free, no key): 10-K/10-Q/8-K dates; 8-K item codes come FREE in submissions JSON (`recent.items`) → mapped to labels in secFilings.ts, NO LLM needed
- **Stooq** for daily candles (free, keyless, `.us` suffix) — chosen because Finnhub candles went premium
- **Yahoo v8 chart** for live quotes — keyless; v7/quote needs cookie/crumb, avoid it. Unofficial API: if it breaks, swap inside `refreshQuote()` only
- **FINRA** short interest — needs free registration (FINRA_CLIENT_ID/SECRET), degrades to skip
- **Dividends** (Finnhub): 403-safe skip — endpoint tier keeps changing
- **Macro calendar**: seeded from `data/macro-2026.json` — official 2026 FOMC/CPI/PPI/NFP/GDP/PCE dates, verified against federalreserve.gov + OMB schedule. Update yearly, don't fetch/scrape
- **13F institutional holdings: DEFERRED deliberately** — requires inverting thousands of institution filings, 45d stale. `OwnershipSnapshot.topHolders` schema is ready for a paid provider. Do not build an EDGAR 13F parser unless explicitly asked
- **LLM analysis**: OpenAI `gpt-4o-mini` (JSON mode), batched 20 articles/call, JSON-only prompt in analyzer.js. Switched from Claude Haiku since Pavel already has a working `OPENAI_API_KEY` (shared with the Portfolio app's AI features) and no Anthropic key on hand. Parse-failure → mark analyzed anyway (no retry loops)

## Product principles
- **Insight aggregation, NOT prediction.** `momentum` = sentiment velocity, never a buy signal. No investment-advice framing anywhere (Israeli regulatory context). Keep disclaimers.
- Typology labels always ship with raw `inputs` snapshot (show WHY a label applies)
- Client quote contract: UI reads `/quotes` (our store); hits Yahoo directly ONLY for `missing`/`stale`; missing tickers auto-subscribe

## Known gaps / next up (in priority order)
1. **Vue frontend components** (separate Stockfolio repo, Naive UI + Pinia + VueUse):
   - Position page card consuming `/enrich/:ticker` (sentiment sparkline, earnings countdown badge "in 6d · AMC · beat 7/8", insider chip, typology chips, headlines)
   - Watchlist grid on `/quotes` with missing/stale Yahoo fallback composable
   - Typology treemap on `/typology/map?group=...`
   - Stockfolio backend (`GET /api/enrich/:ticker`) reads this service's collections **directly from MongoDB** (same Atlas cluster, sibling `stockfolio-insights` DB, via `mongoose.connection.useDb()`) rather than an HTTP call — see `Portfolio/server/services/stockfolioInsightsService.js` + `models/insightsModels.js`. No network dependency on this service's API process being up; auth still stays in the Stockfolio backend, no direct browser→service calls
2. **TASE/Maya source**: Maya announcements → CorporateEvent (`source:'maya'`) + Hebrew RSS (Globes/TheMarker) → Article. Pavel has prior Maya API code in his TASE Dividend Scanner project. EDGAR/Stooq skip TASE tickers gracefully — this fills that hole
3. Pre-earnings anomaly endpoint (news volume spike × earnings within Nd)
4. Redis swap for the in-memory caches when running multiple Railway instances
5. **Stooq now blocks non-browser requests** (`fetchDailyCandles` in `prices.js`) with a JS proof-of-work challenge page instead of returning CSV — discovered on first live run (2026-07-19). Pipeline degrades gracefully (empty `priceSeries`/`volumeRatio`, no crash) but daily candles/volume-anomaly detection are currently non-functional. `refreshQuote` (Yahoo v8 chart, live quotes) is unaffected. Candidate fix: Yahoo v8 chart also supports historical ranges (`range=3mo&interval=1d`) and could replace Stooq without a new dependency — not yet implemented
6. **RESOLVED (2026-07-20): `earnings.js` watchlist filter bug** — `fetchEarningsCalendar()` was filtering Finnhub's earnings calendar against the static env `WATCHLIST` (4 manual-tier tickers) instead of the DB-backed active watchlist, so with 150 real active tickers almost everything was silently discarded (`earnings upserted: 0`). Fixed to filter against `getActiveTickers()` like every other calendar step. Verified live: 0 → 33 upserted
7. **RESOLVED (2026-07-20): OPENAI_API_KEY was shadowed at the OS/shell env level on this machine**, not actually invalid — see `env_openai_key_shadowed` memory. A stale system-level `OPENAI_API_KEY` overrides `.env` because Node's `--env-file-if-exists` never overrides an already-set process env var. Symptom was a 401 crash in `analyzer.js` that took down the whole `worker:ingest` process. Fix: run workers with `env -u OPENAI_API_KEY` prefixed so `.env`'s correct key loads. Also hardened `runPipeline()` in `ingest.js` so analyzer/aggregation failures are caught and logged instead of crashing the long-running worker process — a bad key or OpenAI outage should degrade sentiment data, not kill news fetching

## Testing reality
- No test suite yet. External APIs were NOT live-tested (built in a sandboxed env) — expect field-name surprises on first real run, especially FINRA response shape and Finnhub metric keys. First task on a real machine: `cp .env.example .env`, fill keys, `bun run worker:calendar` once, fix what breaks.
