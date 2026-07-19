# Stockfolio Insights

News-driven market insights service for [Stockfolio]. Ingests financial news, tags articles with tickers/industries using an LLM, and exposes aggregated sentiment, themes, and coverage momentum via a REST API.

> **Not investment advice.** This service aggregates and describes news coverage. `momentum` is sentiment velocity (today vs trailing 7-day average), not a price prediction.

## Stack
Bun · Express · MongoDB (Mongoose) · node-cron · Finnhub API · Anthropic API (Haiku)

## Architecture
```
[cron worker] -> finnhub company-news -> Article (raw)
             -> Claude batch analysis -> Article (tickers/industries/sentiment/themes)
             -> daily aggregation     -> TickerInsight (per ticker per day + momentum)
[express api] -> /insights/ticker/:t | /insights/industry/:i | /insights/trending
```

## Setup
```bash
bun install
cp .env.example .env   # fill in keys
bun run worker         # ingestion pipeline (runs on boot, then per INGEST_CRON)
bun run dev            # API on :4100
```

## Endpoints
- `GET /insights/ticker/AAPL?days=7` — daily sentiment series + recent tagged articles
- `GET /insights/industry/semiconductors?days=7` — industry roll-up
- `GET /insights/trending` — most-covered tickers today

## Roadmap
- [ ] RSS sources (Globes/TheMarker/Maya) for TASE coverage
- [ ] Redis + BullMQ for queue-based analysis at scale
- [ ] Webhook/SSE push into Stockfolio frontend
- [ ] Per-user watchlists sourced from Stockfolio portfolios

## Corporate Events & Investor Typology

Second daily pipeline (`bun run worker:calendar`, 06:00 UTC):

- **Earnings calendar** (Finnhub, free) — upcoming + recent earnings dates with EPS/revenue estimates and actuals, `bmo`/`amc` timing
- **SEC EDGAR filings** (free, no key) — real 10-K / 10-Q / 8-K filing dates with direct document links
- **Ownership snapshots** — insider net buying/selling (trailing 3m) from Finnhub free tier; `institutionalPct`/`topHolders` fields are schema-ready for a paid provider (Finnhub premium or FMP)

### Endpoints
- `GET /events/upcoming?days=30` — cross-watchlist event calendar (frontend calendar view)
- `GET /events/ticker/AAPL` — next event + filing/earnings history
- `GET /events/ownership/AAPL` — latest investor typology snapshot

TASE tickers won't resolve in EDGAR — Maya report dates land in the same `CorporateEvent` collection via a future `maya` source.

## Position Page Enrichment

`GET /enrich/:ticker` — single composed payload for the Stockfolio Position page (5-min in-memory cache, `x-cache` header):

```jsonc
{
  "summary": {            // ready-made numbers for badges — no frontend math
    "sentiment": 0.31, "momentum": 0.12, "articleCount7d": 14,
    "topThemes": ["ai-demand", "guidance-raise"],
    "daysToNextEvent": 6, "insiderNet3m": -12400
  },
  "sentimentSeries": [],  // 14d sparkline data
  "headlines": [],        // 5 latest tagged articles
  "nextEvent": {},        // earnings/filing countdown
  "recentEvents": [],
  "ownership": {}
}
```

Integration pattern: the Stockfolio backend proxies this route (`/api/enrich/:ticker` → insights service), keeping auth and CORS in one place. All fields degrade to `null`/`[]` when data isn't available yet — the Vue component renders what exists.

## Fundamentals Layer (v0.3)

Added to the daily calendar pipeline (~5 Finnhub calls per ticker, rate-paced):

| Data | Source | Where it lands |
|---|---|---|
| Earnings surprise history (beat/miss %) | Finnhub free | `CorporateEvent.surprisePct` |
| Analyst rec trends (monthly buy/hold/sell) | Finnhub free | `AnalystTrend` |
| Dividend events (ex-date, pay date, amount) | Finnhub (403-safe skip if premium-gated) | `CorporateEvent` type `dividend` |
| Short interest + days-to-cover | FINRA Query API (free registration) | `ShortInterest` |
| 8-K item classification (executive-change, restatement, M&A...) | EDGAR submissions `items` field — no LLM needed | `CorporateEvent.itemLabels` |

`/enrich/:ticker` summary now includes: `beatRate` ({beats, of}), `analystDelta` (bullish count change MoM), `daysToCover`, `shortInterestChangePct` — plus full `surpriseHistory`, `analystTrends`, `shortInterest` blocks.

Badge example this enables: **"Earnings in 6d · AMC · beat 7/8 · +3 analyst upgrades · 4.2 days to cover"**

## Macro & Price Layer (v0.4)

- **Macro calendar** — `MacroEvent` seeded from `data/macro-2026.json`: official 2026 FOMC statement days (verified vs federalreserve.gov, SEP meetings flagged), CPI, PPI, jobs report, GDP, and PCE dates from the OMB federal indicators schedule. `GET /events/macro?days=14`. Update the JSON yearly.
- **Price/volume anomalies** — daily OHLCV from **Stooq** (free, keyless, `.us` suffix). Computes 30d volume baseline, `volumeRatio`, and flags `unusualVolume` (>= 2x). Closes the loop: sentiment spike + volume confirmation.
- `/enrich/:ticker` summary adds: `volumeRatio`, `unusualVolume`, `lastChangePct`, `nextMacro` — plus a 30d `priceSeries` block for charts.

**Deliberately deferred: 13F institutional holdings.** 13Fs are filed *by* institutions listing their positions — building "who holds ticker X" requires ingesting and inverting every institution's filing (thousands per quarter, 45 days stale). The `OwnershipSnapshot.topHolders` schema is ready; when needed, either a paid provider (FMP) or a dedicated EDGAR 13F batch job fills it. Not worth the complexity at current stage.

## Dynamic Watchlist + Quote Store (v0.5)

**Watchlist is now DB-driven** (`WatchedTicker`), refreshed automatically:
1. **portfolio tier** — distinct tickers from the Stockfolio `positions` collection (same Atlas cluster; configurable via `STOCKFOLIO_DB_NAME` / `POSITIONS_COLLECTION` / `POSITIONS_TICKER_FIELD`). Adding a position = subscribing.
2. **manual tier** — env `WATCHLIST` pins survive everything.
3. **discovery tier** — tickers the news analyzer surfaces ≥5 times/7d get promoted; quiet unheld tickers decay after 30d; hard cap `WATCHLIST_MAX=150` protects API budget (portfolio > manual > discovery priority).

All three workers (`ingest`, `calendar`, `quotes`) iterate `getActiveTickers()`.

**Quote store** (`TickerQuote`) — our DB is the UI's primary quote source:
- `worker:quotes` polls Yahoo v8 chart (keyless, no crumb) every 5 min for fast fields: price, change, day range, volume, market state, 52w range
- daily Finnhub profile fill: market cap, P/E, EPS, dividend yield, beta, logo
- symbols failing 10+ times are skipped automatically

**Client API:**
- `GET /quotes?tickers=AAPL,MSFT,PLTR` — batch (Watchlist page). Returns `quotes[]` with `ageSeconds`/`stale` per row + `missing[]`. **Fallback contract:** client fetches Yahoo directly ONLY for `missing` or `stale` symbols; missing tickers are auto-subscribed so the next poll covers them.
- `GET /quotes/:ticker` — single (Position page). 404 auto-subscribes and tells the client to retry.

```
UI ──> /quotes (our DB, ~ms)            ──> render
   └─> Yahoo, only for missing/stale    ──> render + self-heals next cycle
```
