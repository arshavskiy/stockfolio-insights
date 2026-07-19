# CLAUDE.md — stockfolio-insights

News-driven market insights microservice for **Stockfolio** (Pavel's Vue 3 stock portfolio app).
This service is the data platform; the Stockfolio frontend/backend are separate repos.

## Stack & conventions
- **Bun** runtime, Express, TypeScript ESM (`type: module`), Mongoose on MongoDB Atlas
- Match existing style: no semicolons debate — follow file as-is; 2-space indent
- Typecheck gate: `npx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 src/index.ts src/workers/*.ts`
- Deploy target: Railway (workers + API), same Atlas cluster as Stockfolio main app

## Architecture (write/read strictly separated)
```
WORKERS (write-only)                          COLLECTIONS                 API (read-only)
worker:ingest   */20min  news→LLM→aggregate   Article, TickerInsight      /insights/*
worker:calendar daily    events/fundamentals  CorporateEvent, Analyst-    /events/*
                         prices, typology     Trend, ShortInterest,       /typology/*
                                              PriceStat, MacroEvent,
                                              OwnershipSnapshot,
                                              TickerTypology
worker:quotes   */5min   Yahoo v8 quotes      TickerQuote                 /quotes/*
                                              WatchedTicker               /enrich/:ticker (composed)
```
- All workers start with `refreshWatchlist()` then loop `getActiveTickers()` (src/services/watchlist.ts)
- Watchlist tiers: **portfolio** (synced from Stockfolio `positions` collection) > **manual** (env) > **discovery** (news-mentioned ≥5x/7d); 30d decay; cap 150 (API budget)
- `/enrich/:ticker` = the Position page payload: 5-min in-memory TTL cache, badge-ready `summary` block, all fields degrade to null/[]

## Data sources & WHY (decisions made — don't relitigate)
- **Finnhub free**: company news, earnings calendar+surprises, analyst recs, insider tx, profile/metrics. Rate: 60/min → workers pace with sleeps
- **SEC EDGAR** (free, no key): 10-K/10-Q/8-K dates; 8-K item codes come FREE in submissions JSON (`recent.items`) → mapped to labels in secFilings.ts, NO LLM needed
- **Stooq** for daily candles (free, keyless, `.us` suffix) — chosen because Finnhub candles went premium
- **Yahoo v8 chart** for live quotes — keyless; v7/quote needs cookie/crumb, avoid it. Unofficial API: if it breaks, swap inside `refreshQuote()` only
- **FINRA** short interest — needs free registration (FINRA_CLIENT_ID/SECRET), degrades to skip
- **Dividends** (Finnhub): 403-safe skip — endpoint tier keeps changing
- **Macro calendar**: seeded from `data/macro-2026.json` — official 2026 FOMC/CPI/PPI/NFP/GDP/PCE dates, verified against federalreserve.gov + OMB schedule. Update yearly, don't fetch/scrape
- **13F institutional holdings: DEFERRED deliberately** — requires inverting thousands of institution filings, 45d stale. `OwnershipSnapshot.topHolders` schema is ready for a paid provider. Do not build an EDGAR 13F parser unless explicitly asked
- **LLM analysis**: Claude Haiku, batched 20 articles/call, JSON-only prompt in analyzer.ts. Parse-failure → mark analyzed anyway (no retry loops)

## Product principles
- **Insight aggregation, NOT prediction.** `momentum` = sentiment velocity, never a buy signal. No investment-advice framing anywhere (Israeli regulatory context). Keep disclaimers.
- Typology labels always ship with raw `inputs` snapshot (show WHY a label applies)
- Client quote contract: UI reads `/quotes` (our store); hits Yahoo directly ONLY for `missing`/`stale`; missing tickers auto-subscribe

## Known gaps / next up (in priority order)
1. **Vue frontend components** (separate Stockfolio repo, Naive UI + Pinia + VueUse):
   - Position page card consuming `/enrich/:ticker` (sentiment sparkline, earnings countdown badge "in 6d · AMC · beat 7/8", insider chip, typology chips, headlines)
   - Watchlist grid on `/quotes` with missing/stale Yahoo fallback composable
   - Typology treemap on `/typology/map?group=...`
   - Stockfolio backend proxies this service (`/api/enrich/*`) — auth stays there, no direct browser→service calls
2. **TASE/Maya source**: Maya announcements → CorporateEvent (`source:'maya'`) + Hebrew RSS (Globes/TheMarker) → Article. Pavel has prior Maya API code in his TASE Dividend Scanner project. EDGAR/Stooq skip TASE tickers gracefully — this fills that hole
3. Pre-earnings anomaly endpoint (news volume spike × earnings within Nd)
4. Redis swap for the in-memory caches when running multiple Railway instances

## Testing reality
- No test suite yet. External APIs were NOT live-tested (built in a sandboxed env) — expect field-name surprises on first real run, especially FINRA response shape and Finnhub metric keys. First task on a real machine: `cp .env.example .env`, fill keys, `bun run worker:calendar` once, fix what breaks.
