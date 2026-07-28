# CLAUDE.md — stockfolio-insights

News-driven market insights **data-aggregation pipeline** for **Stockfolio** (Pavel's Vue 3 stock
portfolio app). This repo is workers-only in practice — see "Actual deployment shape" below.

## Actual deployment shape (confirmed 2026-07-22 — read this before touching src/index.js or routes/)
- This repo's **workers are the only thing that runs**, typically local/manual, purely to populate
  the shared MongoDB Atlas cluster (`stockfolio-insights` DB). `npm run worker:all` (or the
  individual `worker`/`worker:calendar`/`worker:quotes` scripts) is the actual product surface.
- This repo's **own Express API server is dead code today** — `src/index.js` and every route under
  `src/routes/` (`/insights/*`, `/events/*`, `/typology/*`, `/quotes/*`, `/enrich/:ticker`) are not
  deployed and have no caller. **All real API traffic is served by the Portfolio backend instead**
  (`Portfolio/server/routes/enrich.js` → `controllers/enrichController.js` →
  `services/stockfolioInsightsService.js`), which reads this DB **directly via Mongoose**
  (`mongoose.connection.useDb('stockfolio-insights')`, see `Portfolio/server/models/insightsModels.js`)
  rather than calling this service's HTTP API at all.
- Practical implications: don't add new REST endpoints here expecting a client to call them — add
  the read logic to `Portfolio/server/services/stockfolioInsightsService.js` instead, mirroring the
  schema this repo's workers write. Don't worry about hardening `src/index.js`/`src/routes/*` for
  production traffic (auth, rate limits, uptime) — nothing depends on that process staying up. Keep
  the routes only if useful for local debugging/manual querying; they're not on the critical path.
- **Read/write separation still fully applies** — this repo is the sole *writer* of every
  collection below. Portfolio is a read-only consumer of the same DB, never writes to it.

## Stack & conventions
- **Node.js** (18+) runtime, Express (unused in practice — see above), CommonJS JavaScript
  (`require`/`module.exports`, no TypeScript), Mongoose on MongoDB Atlas
- Match existing style: no semicolons debate — follow file as-is; 2-space indent
- No type-checking step — plain JS, review by reading. (Prior versions ran on Bun + TypeScript; migrated to Node + CommonJS to match the sibling Portfolio server's conventions.)
- Deploy target: workers only, run locally/manually today (not on Railway yet — revisit if this needs to become a scheduled/always-on process rather than something Pavel runs by hand)

## Architecture (write/read strictly separated)
```
WORKERS (write-only, run locally)             COLLECTIONS                 READ SIDE
worker:ingest   */20min  news(Finnhub+Yahoo)  Article, TickerInsight      Portfolio backend reads
                         →LLM→aggregate                                   these collections directly
worker:calendar daily    events/fundamentals  CorporateEvent, Analyst-    via Mongoose useDb() —
                         prices, typology,    Trend, ShortInterest,       see stockfolioInsightsService.js
                         macro values, XBRL   PriceStat, MacroEvent,      in the Portfolio repo.
                         financials           MacroDataPoint,             This repo's own /insights,
                                              OwnershipSnapshot,          /events, /typology, /quotes,
                                              TickerTypology,             /enrich routes are NOT used.
                                              FinancialFact
worker:quotes   */5min   Yahoo v8 quotes      TickerQuote
                                              WatchedTicker
```
- All workers start with `refreshWatchlist()` then loop `getActiveTickers()` (src/services/watchlist.js)
- Watchlist tiers: **portfolio** (synced from Stockfolio `positions` collection for owners whose `users.userType !== 'regular'`) > **manual** (env) > **watchlist** (synced from Stockfolio `watchlists` collection for non-regular owners, tracked-not-held) > **discovery** (news-mentioned ≥5x/7d, opt-in with `WATCHLIST_DISCOVERY_ENABLED=true`); 30d decay applies to discovery only; cap 150 (API budget)
- `npm run worker:all` (via `concurrently`, added 2026-07-22) runs all three workers together in one terminal, color-coded/prefixed output, single Ctrl+C stops all three. This is the standard way to run this repo day-to-day

## Data sources & WHY (decisions made — don't relitigate)
- **Finnhub free**: company news, earnings calendar+surprises, analyst recs, insider tx, profile/metrics. Rate: 60/min → workers pace with sleeps
- **Yahoo `v1/finance/search`** (`fetchYahooNews` in yahoo.js): second, keyless news source — noticeably higher volume than Finnhub's company-news free tier, and covers tickers Finnhub 403s on (e.g. TASE `.TA` symbols). Runs alongside Finnhub in `worker:ingest`, same `Article` collection, `source:'yahoo'`, deduped by `(source, sourceId)`/`url` like every other source. Seeds `tickers` from the item's `relatedTickers` only — **not** the ticker searched by (fixed 2026-07-22, see item 8 below); Yahoo's search results merely match the query, they aren't necessarily about it
- **SEC EDGAR** (free, no key): 10-K/10-Q/8-K dates; 8-K item codes come FREE in submissions JSON (`recent.items`) → mapped to labels in secFilings.ts, NO LLM needed
- **Stooq** for daily candles (free, keyless, `.us` suffix) — chosen because Finnhub candles went premium
- **Yahoo v8 chart** for live quotes — keyless; v7/quote needs cookie/crumb, avoid it. Unofficial API: if it breaks, swap inside `refreshQuote()` only
- **FINRA** short interest — needs free registration (FINRA_CLIENT_ID/SECRET), degrades to skip
- **Dividends** (Finnhub): 403-safe skip — endpoint tier keeps changing
- **Macro calendar**: seeded from `data/macro-2026.json` — official 2026 FOMC/CPI/PPI/NFP/GDP/PCE dates, verified against federalreserve.gov + OMB schedule. Update yearly, don't fetch/scrape
- **FRED** (free, registration required — `FRED_API_KEY`): live macro *values* — Fed funds rate, CPI/core PCE YoY, unemployment, 10Y yield — into `MacroDataPoint`. Complements `MacroEvent` (dates only) with the actual readings. `fetchMacroSeries()` in `fred.js`, latest observation per series only, not a historical backfill
- **SEC EDGAR XBRL company facts** (free, no key, reuses `secFilings.js`'s CIK map via `loadCikMap()`): latest annual (10-K) + latest quarterly (10-Q) value for ~8 core financial-statement concepts (revenue, net income, diluted EPS, assets/liabilities, equity, operating cash flow, long-term debt) → `FinancialFact`. Fills the fundamentals gap without needing a paid provider (FMP/EODHD); full historical series deliberately out of scope — latest values only, matching the lightweight snapshot style of `PriceStat`/`AnalystTrend`
- **13F institutional holdings: DEFERRED deliberately** — requires inverting thousands of institution filings, 45d stale. `OwnershipSnapshot.topHolders` schema is ready for a paid provider. Do not build an EDGAR 13F parser unless explicitly asked
- **LLM analysis**: OpenAI `gpt-4o-mini` (JSON mode), batched 20 articles/call, JSON-only prompt in analyzer.js. Switched from Claude Haiku since Pavel already has a working `OPENAI_API_KEY` (shared with the Portfolio app's AI features) and no Anthropic key on hand. Parse-failure → mark analyzed anyway (no retry loops)

## Product principles
- **Insight aggregation, NOT prediction.** `momentum` = sentiment velocity, never a buy signal. No investment-advice framing anywhere (Israeli regulatory context). Keep disclaimers.
- Typology labels always ship with raw `inputs` snapshot (show WHY a label applies)
- Client quote contract: UI reads `/quotes` (our store); hits Yahoo directly ONLY for `missing`/`stale`; missing tickers auto-subscribe

## Known gaps / next up (in priority order)
1. **RESOLVED — Portfolio-side consumption is fully built**, contrary to what this item used to say.
   Confirmed 2026-07-22: `Portfolio/server/services/stockfolioInsightsService.js` +
   `models/insightsModels.js` read this repo's collections directly from MongoDB
   (`mongoose.connection.useDb()`), exposed via `Portfolio/server/routes/enrich.js`
   (`/enrich/:ticker`, `/enrich/typology-map`, `/enrich/related/:ticker`). Client side: `TickerInsightCard.vue`
   (sentiment/typology/insider/earnings-beat card) and `TickerRelationGraph.vue` (co-mentioned-ticker
   force graph, driven by `getRelatedTickers` — articles where the LLM tagged two tickers in the same
   story) are both mounted on `PositionDetailView.vue` (mobile) and `DesktopPositionPanel.vue`
   (desktop) per the mobile/desktop-parity convention. `TypologyMapView.vue` (treemap, grouped by
   style/marketCapClass/volatilityClass/primaryIndustry) is routed at `/typology-map`. All wired into
   router + i18n. Nothing left to build here — future work in this area is refinement, not scaffolding.
2. **TASE/Maya source**: Maya announcements → CorporateEvent (`source:'maya'`) + Hebrew RSS (Globes/TheMarker) → Article. Pavel has prior Maya API code in his TASE Dividend Scanner project. EDGAR/Stooq skip TASE tickers gracefully — this fills that hole
3. Pre-earnings anomaly endpoint (news volume spike × earnings within Nd)
4. Redis swap for the in-memory caches when running multiple Railway instances — **N/A unless this repo's API server gets deployed** (see "Actual deployment shape" above); today Portfolio's own read path has no shared-cache-across-instances problem to solve here
5. **Stooq now blocks non-browser requests** (`fetchDailyCandles` in `prices.js`) with a JS proof-of-work challenge page instead of returning CSV — discovered on first live run (2026-07-19). Pipeline degrades gracefully (empty `priceSeries`/`volumeRatio`, no crash) but daily candles/volume-anomaly detection are currently non-functional. `refreshQuote` (Yahoo v8 chart, live quotes) is unaffected. Candidate fix: Yahoo v8 chart also supports historical ranges (`range=3mo&interval=1d`) and could replace Stooq without a new dependency — not yet implemented
6. **RESOLVED (2026-07-20): `earnings.js` watchlist filter bug** — `fetchEarningsCalendar()` was filtering Finnhub's earnings calendar against the static env `WATCHLIST` (4 manual-tier tickers) instead of the DB-backed active watchlist, so with 150 real active tickers almost everything was silently discarded (`earnings upserted: 0`). Fixed to filter against `getActiveTickers()` like every other calendar step. Verified live: 0 → 33 upserted
7. **RESOLVED (2026-07-22): OPENAI_API_KEY was shadowed by a stale Machine-scope Windows env var**, not actually invalid — see `env_openai_key_shadowed` memory. Node's `--env-file-if-exists` never overrides an already-set process env var, and a Windows **Machine (system-wide)** environment variable is inherited by every process, so it silently beat `.env`'s correct key. Symptom was a 401 crash in `analyzer.js` that took down the whole `worker:ingest` process. Root-cause fixed 2026-07-22 by correcting the Machine-level var itself (`[Environment]::SetEnvironmentVariable('OPENAI_API_KEY', '<correct key>', 'Machine')` from an elevated PowerShell) — the earlier `env -u OPENAI_API_KEY` prefix workaround is no longer needed. Also hardened `runPipeline()` in `ingest.js` so analyzer/aggregation failures are caught and logged instead of crashing the long-running worker process — a bad key or OpenAI outage should degrade sentiment data, not kill news fetching. Note: this shadow can still exist in already-open shells (Machine-scope env var changes only apply to new processes) — if a correct-looking `.env` key still 401s, check `env | grep OPENAI_API_KEY` in that specific shell before assuming the key rotated again
8. **RESOLVED (2026-07-22): `Article.tickers` cross-contamination bug** — both `fetchYahooNews()` and `fetchCompanyNews()` seed `tickers` with a pre-analysis guess before the LLM reads the article, and `analyzePendingArticles()` used to `union` that seed with the LLM's own output instead of replacing it — so a wrong seed tag (most visibly: Yahoo's search endpoint force-tagging the *searched-for* ticker onto results that merely matched the query, not articles actually about it) could survive forever, even after the LLM correctly determined the article was unrelated. Verified live: a Finnhub-sourced "Meta in talks with Anthropic" article was permanently tagged `SPCX`, polluting that ticker's sentiment rollup, headlines feed, and the Portfolio client's related-tickers graph. Fixed: `analyzer.js` now replaces `tickers` with the LLM's output (authoritative — it read the actual text); `yahoo.js` no longer force-seeds the searched-for ticker, only Yahoo's own `relatedTickers`. One-time backfill (`scripts/backfill-yahoo-ticker-tags.js` + `scripts/run-analyzer-backlog.js`) re-ran ~6,600 previously-analyzed articles through the corrected logic. See `docs/ENRICHMENT_DATA.md` §7.1 for full detail

## Testing reality
- No test suite yet. External APIs were NOT live-tested (built in a sandboxed env) — expect field-name surprises on first real run, especially FINRA response shape and Finnhub metric keys. First task on a real machine: `cp .env.example .env`, fill keys, `bun run worker:calendar` once, fix what breaks.
