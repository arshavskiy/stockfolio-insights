# Enrichment Data & Flow — for the Stockfolio Client

This is the field-by-field reference for everything `stockfolio-insights` produces and how it
gets from a raw API call into the payload the Stockfolio frontend renders. It complements
`CLAUDE.md` (which covers *why* decisions were made); this doc covers *what fields exist and
what they mean*.

> **Not investment advice.** `momentum` is sentiment velocity, not a price signal. Every
> derived label (typology tags, insider signal, squeeze risk) ships next to its raw `inputs` so
> the UI can show *why*, never just a verdict.

---

## 1. High-level flow

```
                         ┌─────────────────────────────────────────────┐
                         │              MongoDB Atlas (shared)          │
                         │        stockfolio-insights DB, collections   │
                         └─────────────────────────────────────────────┘
                                   ▲              ▲              ▲
        WORKERS (write-only)      │              │              │        API (read-only)
   ─────────────────────────      │              │              │      ──────────────────
   worker:ingest   */20min ───────┘              │              │      GET /insights/*
     Finnhub + Yahoo news → LLM tag → aggregate   │              │      GET /events/*
                                                   │              │      GET /typology/*
   worker:calendar daily ────────────────────────┘              │      GET /quotes/*
     earnings, filings, ownership, analyst,                     │      GET /enrich/:ticker
     short interest, macro, prices, typology                    │        (composed, cached)
                                                                  │
   worker:quotes    */5min ───────────────────────────────────────┘
     Yahoo v8 chart quotes + daily Finnhub profile
```

All three workers start from the **same dynamic watchlist** (`getActiveTickers()` —
`src/services/watchlist.js`): portfolio tier (synced from Stockfolio `positions`) > manual
(env-pinned) > watchlist tier (synced from Stockfolio `watchlists`) > discovery
(news-mentioned ≥5×/7d, 30-day decay, cap 150 tickers total for API budget).

The Stockfolio backend reads this service's data **two ways**:
1. **`GET /enrich/:ticker`** over HTTP — the composed Position-page payload (see §4).
2. **Direct MongoDB read** of individual collections via `mongoose.connection.useDb()` on the
   same Atlas cluster — no dependency on this service's API process being up. See
   `Portfolio/server/services/stockfolioInsightsService.js`.

---

## 2. Collections (source of truth)

Each collection is written by exactly one worker and never written by the API layer
(read/write strictly separated).

| Collection | Written by | Refresh | Purpose |
|---|---|---|---|
| `Article` | worker:ingest | ~20 min | Raw + LLM-tagged news, one doc per article |
| `TickerInsight` | worker:ingest | ~20 min | Daily rollup per ticker: sentiment, momentum, themes |
| `CorporateEvent` | worker:calendar | daily | Earnings, SEC filings (10-K/10-Q/8-K), dividends |
| `AnalystTrend` | worker:calendar | daily | Monthly buy/hold/sell recommendation counts |
| `OwnershipSnapshot` | worker:calendar | daily | Insider net buy/sell + (future) institutional holders |
| `ShortInterest` | worker:calendar | twice-monthly (FINRA cadence) | Short interest, days-to-cover |
| `MacroEvent` | seed data, static | yearly | FOMC/CPI/PPI/NFP/GDP/PCE calendar (dates only, no values) |
| `MacroDataPoint` | worker:calendar | daily (mostly monthly no-ops) | Live macro *values* — fed funds rate, CPI/core PCE YoY, unemployment, 10Y yield |
| `PriceStat` | worker:calendar | daily | OHLCV + volume-anomaly detection |
| `TickerTypology` | worker:calendar | daily | Derived archetype (no external calls — pure classification) |
| `FinancialFact` | worker:calendar | daily | Latest annual+quarterly fundamentals (revenue, net income, EPS, assets/liabilities, equity, operating cash flow, long-term debt) |
| `TickerQuote` | worker:quotes | ~5 min (fast) / daily (profile) | Live-ish price quote + slow profile fields |
| `WatchedTicker` | all workers (via watchlist service) | continuous | The dynamic watchlist itself |

---

## 3. Data sources — where every field actually comes from

Every number in this service traces back to one of these external providers (or is derived
purely from our own collected data, with zero external calls). Listed here once so the client
doesn't have to hunt through §6 field-by-field to find provenance.

| Provider | Auth | Cost | Feeds | Notes |
|---|---|---|---|---|
| **Finnhub** | API key (free tier) | Free, 60 calls/min | `Article` (company news), `CorporateEvent` (earnings calendar + surprises, dividends), `AnalystTrend`, `OwnershipSnapshot` (insider tx), `TickerQuote` (profile: market cap, P/E, EPS, dividend yield, beta, logo) | Primary paid-tier-free source for fundamentals. Workers pace calls with sleeps to stay under rate limit. Dividends endpoint 403-safe-skips if Finnhub gates it behind a paid tier |
| **Yahoo Finance** (unofficial, keyless) | None | Free | `Article` (`source:'yahoo'`, second news feed), `TickerQuote` (fast fields: price/change/volume via v8 chart) | `v1/finance/search` covers tickers Finnhub 403s on (e.g. TASE `.TA`); `v8/finance/chart` used for live quotes because `v7/quote` needs a cookie/crumb we don't want to depend on. Both are unofficial APIs — if they break, the fix is scoped to `yahoo.js` only |
| **SEC EDGAR** | None (public) | Free | `CorporateEvent` (10-K/10-Q/8-K filing dates + 8-K item codes) | 8-K item codes come directly in the free `submissions` JSON (`recent.items`) — mapped to human labels in `secFilings.js`, **no LLM involved**. Skips non-US tickers gracefully |
| **Stooq** | None | Free | `PriceStat` (daily OHLCV, volume-anomaly detection) | ⚠️ Currently blocked by a JS proof-of-work challenge page (since 2026-07-19) — see §7 gaps. Chosen originally because Finnhub's candle endpoint went premium |
| **FINRA Query API** | Free registration (client ID/secret) | Free | `ShortInterest` | Published twice monthly (FINRA's own cadence, not ours). Degrades to skip if credentials aren't configured |
| **OpenAI (`gpt-4o-mini`, JSON mode)** | API key | Paid, usage-based | `Article.sentiment`, `Article.themes`, `Article.llmSummary`, `Article.tickers`/`industries` (tagging pass) | Batched 20 articles/call. A parse failure marks the article analyzed anyway rather than retry-looping |
| **Static seed file** (`data/macro-2026.json`) | — | Free | `MacroEvent` | Hand-verified against federalreserve.gov (FOMC dates) + the OMB federal indicators schedule (CPI/PPI/NFP/GDP/PCE). Not fetched or scraped — updated once a year by hand |
| **FRED** (Federal Reserve Economic Data) | Free API key (registration) | Free | `MacroDataPoint` (fed funds rate, CPI YoY, core PCE YoY, unemployment rate, 10Y Treasury yield) | Complements `MacroEvent` — that collection only has release *dates*, this has the actual *readings*. Latest observation per series only (not historical backfill); CPI/core PCE stored as computed YoY %, not raw index level. Added 2026-07-22, `fred.js` |
| **SEC EDGAR XBRL company facts** | None (public), reuses the CIK map already built for filing dates | Free | `FinancialFact` (revenue, net income, diluted EPS, assets, liabilities, equity, operating cash flow, long-term debt) | Same free EDGAR API surface as the filing-dates source above, different endpoint (`data.sec.gov/api/xbrl/companyfacts/`). Latest annual (10-K) + latest quarterly (10-Q) value per concept only — not a historical series. Some large filers (e.g. Apple) stopped tagging the generic `Revenues` concept after adopting ASC 606; `xbrlFacts.js` falls back to `RevenueFromContractWithCustomerExcludingAssessedTax` when that happens. Skips non-US tickers gracefully (no CIK). Added 2026-07-22, `xbrlFacts.js` |
| **Stockfolio app itself** | Same MongoDB Atlas cluster | — | `WatchedTicker` (portfolio/watchlist tiers) | Synced from the Stockfolio `positions` and `watchlists` collections — not a third-party API at all |
| *(none — derived)* | — | — | `TickerTypology`, `TickerInsight.momentum` | Pure computation over data already sitting in our own collections — no external call, no added cost or rate-limit exposure |

Two data types are **deliberately not sourced yet**, not missing by accident:
- **13F institutional holdings** (`OwnershipSnapshot.topHolders`) — would require inverting
  thousands of institution filings from EDGAR (45-day-stale by the time they're usable), or a
  paid provider. Schema is ready; not built.
- **TASE/Maya announcements** — a planned Hebrew-market source (Maya API + Globes/TheMarker
  RSS) to fill the gap EDGAR/Stooq leave for `.TA` tickers. Not built yet.

---

## 4. `GET /enrich/:ticker` — the composed Position-page payload

Single call, 5-minute in-memory TTL cache (`x-cache: hit|miss` response header). Every field
degrades to `null`/`[]`/`false` if the underlying data isn't available yet — **the client should
never assume a field is present** and should render around gaps rather than erroring.

```jsonc
{
  "ticker": "AAPL",
  "generatedAt": "2026-07-21T12:00:00.000Z",
  "summary": { ... },        // §4.1 — precomputed badge/chip numbers
  "typology": { ... },       // §4.2 — archetype tags
  "priceSeries": [ ... ],    // §4.3 — 30d OHLCV+volume for a sparkline/chart
  "surpriseHistory": [ ... ],// §4.4 — up to 8 past earnings beats/misses
  "analystTrends": [ ... ],  // §4.5 — last 3 months of rec counts
  "shortInterest": { ... },  // §4.6 — latest FINRA snapshot
  "sentimentSeries": [ ... ],// §4.7 — 14d sentiment/article-count series
  "headlines": [ ... ],      // §4.8 — 5 latest tagged articles (7d window)
  "nextEvent": { ... },      // §4.9 — next upcoming CorporateEvent
  "recentEvents": [ ... ],   // §4.9 — last 3 past CorporateEvents
  "ownership": { ... }       // §4.10 — latest OwnershipSnapshot
}
```

### 4.1 `summary` — precomputed, badge-ready

The frontend should **not recompute any of these** — they're derived server-side specifically
so the Vue component stays dumb.

| Field | Type | Meaning | Null when |
|---|---|---|---|
| `sentiment` | number \| null | Latest day's avg article sentiment, −1 (bearish) … 1 (bullish) | No `TickerInsight` yet |
| `momentum` | number \| null | Sentiment velocity: today's avg minus trailing 7d avg. **Not a buy/sell signal.** | Same |
| `articleCount7d` | number | Sum of `articleCount` over the last 7 `TickerInsight` days | Always 0, never null |
| `topThemes` | string[] | Latest day's dominant themes (e.g. `["ai-demand","guidance-raise"]`) | `[]` |
| `daysToNextEvent` | number \| null | Calendar days until `nextEvent.date` | No upcoming event known |
| `insiderNet3m` | number \| null | Net shares bought(+)/sold(−) by insiders, trailing 3 months | No `OwnershipSnapshot` |
| `beatRate` | `{beats, of}` \| null | Earnings beats out of up-to-8 most recent reported quarters | No earnings with actuals |
| `analystDelta` | number \| null | Change in (strongBuy+buy) count vs. prior month | <2 months of `AnalystTrend` |
| `daysToCover` | number \| null | Short interest ÷ avg daily volume | No `ShortInterest` |
| `shortInterestChangePct` | number \| null | Change vs. previous FINRA report | Same |
| `volumeRatio` | number \| null | Today's volume ÷ 30d avg volume | No `PriceStat` |
| `unusualVolume` | boolean | `volumeRatio >= 2` | Defaults `false` |
| `lastChangePct` | number \| null | Daily close-over-close % change (from `PriceStat`, **not live** — see §6 for live price) | No `PriceStat` |
| `nextMacro` | `{label, date, note}` \| null | Next high-impact macro release (FOMC/CPI/NFP/GDP/PCE) | None scheduled |

### 4.2 `typology`
Subset of `TickerTypology`: `tags[]`, `primaryIndustry`, `marketCapClass`, `style`,
`volatilityClass`. Full dimension definitions in §7.

### 4.3 `priceSeries`
Last 30 `PriceStat` days, ascending by date: `{ date, close, volume, volumeRatio }`.

### 4.4 `surpriseHistory`
Up to 8 most recent reported-earnings `CorporateEvent` docs (type `earnings`, has `epsActual`):
`{ date, period, epsActual, epsEstimate, surprisePct }`.

### 4.5 `analystTrends`
Last 3 `AnalystTrend` docs, newest first: `{ period, strongBuy, buy, hold, sell, strongSell }`.
The signal is the **month-over-month change**, not the absolute counts — that's what
`summary.analystDelta` gives you pre-computed.

### 4.6 `shortInterest`
Latest `ShortInterest` doc in full: `{ settlementDate, shortInterest, avgDailyVolume,
daysToCover, changePct, source }`.

### 4.7 `sentimentSeries`
Last 14 `TickerInsight` days, ascending: `{ date, sentiment, articles }`. Feeds a sparkline.

### 4.8 `headlines`
Up to 5 most recent analyzed articles mentioning this ticker, within the last 7 days:
`{ headline, url, publishedAt, sentiment, themes, llmSummary }`.

### 4.9 `nextEvent` / `recentEvents`
Full `CorporateEvent` docs — see §7 field table. `nextEvent` is the single soonest future
event; `recentEvents` is up to 3 most recent past events.

### 4.10 `ownership`
Full latest `OwnershipSnapshot` doc — see §7. `topHolders` is currently always empty (13F
institutional data deliberately deferred — schema is ready, not populated; see CLAUDE.md).

---

## 5. Worked example — the "Ticker Insight" card

This maps the actual Position-page card the Stockfolio client renders to the exact
`/enrich/:ticker` fields behind each element. Useful as a quick lookup when a designer or the
frontend asks "where does this number come from."

Reference card (as of 2026-07-21): mega-cap / speculative / dividend payer chips, Momentum
0.00, earnings beat rate 3/4, analyst trend 0 buy-rated, insider activity −710.0K sh, and a
macro FOMC row.

| UI element | Field | Source |
|---|---|---|
| **"Ticker Insight" title + ⓘ** | — | Static label; the ⓘ opens a legend explaining momentum/typology are descriptive, not predictive (see disclaimer at top of this doc) |
| **"Momentum 0.00" pill** | `summary.momentum` | `TickerInsight.momentum` — today's avg sentiment minus trailing-7d avg. `0.00` means neutral velocity, **not** "no news" — check `summary.articleCount7d` separately to distinguish quiet vs. flat-sentiment |
| **`mega-cap` chip** | `typology.marketCapClass` → `mega` (rendered via `typology.tags`) | `TickerTypology.marketCapClass`, threshold ≥$200B, from `inputs.marketCap` |
| **`speculative` chip** | `typology.style` → `speculative` | `TickerTypology.style` — assigned when the company has no earnings (P/E undefined), from `inputs.peRatio`/EPS |
| **`dividend payer` chip** | `typology.dividendProfile` → `payer` | `TickerTypology.dividendProfile` — `payer` tier (below the ≥4% `high-yield` threshold) |
| **"Earnings beat rate" — 3/4 last quarters** | `summary.beatRate` → `{beats: 3, of: 4}` | Computed in `enrich.js` from `surpriseHistory` (up to 8 recent `CorporateEvent` earnings docs with `epsActual` set); green because `beats/of > 0.5` — that's a client-side render choice, not a server field |
| **"Analyst trend (mo. Δ)" — 0 buy-rated** | `summary.analystDelta` | Change in `(strongBuy + buy)` counts between the two most recent `AnalystTrend` months. `0` = no change in bullish analyst count MoM, not zero analysts covering the stock — full counts are in `analystTrends[]` if the card needs to show absolute coverage too |
| **"Insider activity (3mo)" — −710.0K sh (red)** | `summary.insiderNet3m` | `OwnershipSnapshot.insiderNet3m` — net shares bought(+)/sold(−) trailing 3 months. Negative = net insider selling, hence red; full detail (`insiderTxCount3m`) is in the `ownership` block |
| **Macro row — "FOMC rate decision · Jul 29"** | `summary.nextMacro` → `{label, date}` | Next high-impact `MacroEvent` (type `fomc`), from the static seeded 2026 calendar — not ticker-specific, same for every card |
| **"MARKET NEWS" headline feed below** | `headlines[]` | Latest analyzed `Article` docs (7-day window, max 5): headline, `publishedAt`, `sentiment`, `themes`, `llmSummary` |

Each ⓘ icon on a stat block (Earnings beat rate, Analyst trend, Insider activity) is the
client's own affordance for surfacing the *why* — pair it with the matching raw block
(`surpriseHistory`, `analystTrends`, `ownership`) rather than just re-showing the summary number.

---

## 6. `GET /quotes` and `GET /quotes/:ticker` — live-ish price data

**Separate from `/enrich`** — quotes refresh on their own 5-minute cycle and are the only
"live" numbers in this service. `/enrich`'s `summary.lastChangePct` is the prior **daily
close**, not the live quote — for a live price/change badge, the client must call `/quotes`.

- `GET /quotes?tickers=AAPL,MSFT,PLTR` — batch, up to 100 tickers (Watchlist grid)
- `GET /quotes/:ticker` — single (Position page live price)

Response shape (`shape()` in `src/routes/quotes.js`):

| Field | Notes |
|---|---|
| `price`, `change`, `changePct`, `previousClose`, `dayHigh`, `dayLow`, `volume` | Fast fields, refreshed every ~5 min from Yahoo v8 chart |
| `marketState` | `PRE` \| `REGULAR` \| `POST` \| `CLOSED` |
| `name`, `exchange`, `currency`, `fiftyTwoWeekHigh/Low`, `marketCap`, `peRatio`, `eps`, `dividendYield`, `beta`, `logo` | Slow fields, refreshed daily from Finnhub profile |
| `ageSeconds` | Seconds since `quoteUpdatedAt` |
| `stale` | `true` if `ageSeconds > 600` (configurable via `QUOTE_STALE_SECONDS`) or quote never fetched |

**Client fallback contract:** the UI reads `/quotes` as primary source. It should call Yahoo
directly **only** for tickers returned in the batch response's `missing[]` array, or any row
with `stale: true`. Fetching a missing/unknown ticker auto-subscribes it (`WatchedTicker` tier
`discovery`) so the next 5-min poll cycle picks it up going forward — the gap self-heals, it
doesn't need to be re-fetched from Yahoo forever.

---

## 7. Field reference by collection

Use this section when reading collections **directly from Mongo** (the Stockfolio backend's
`useDb()` path) rather than through `/enrich`.

### `TickerInsight` (daily sentiment rollup)
| Field | Type | Notes |
|---|---|---|
| `ticker` | string | |
| `date` | string `YYYY-MM-DD` (UTC) | |
| `articleCount` | number | Articles analyzed that day |
| `avgSentiment` | number | −1..1 |
| `momentum` | number | Today's avg minus trailing 7d avg — velocity, not a signal |
| `topThemes` | string[] | |
| `industries` | string[] | |

### `CorporateEvent` (earnings / filings / dividends)
| Field | Type | Notes |
|---|---|---|
| `ticker`, `type`, `date` | — | `type` ∈ earnings, 10-K, 10-Q, 8-K, 20-F, 6-K, dividend, split, other-filing |
| `period` | string | e.g. `'2026-Q2'`, `'FY2025'` |
| `epsEstimate`, `epsActual`, `revenueEstimate`, `revenueActual` | number | Earnings only |
| `hour` | string | `bmo` (before open) \| `amc` (after close) |
| `surprisePct` | number | `(actual - estimate) / abs(estimate)` |
| `amount`, `currency`, `payDate`, `recordDate` | — | Dividend only; `date` = ex-dividend date |
| `accessionNo`, `items`, `itemLabels`, `filingUrl` | — | Filing only; `items` = raw 8-K item codes (e.g. `['5.02','9.01']`), `itemLabels` = human-readable (from SEC's free `recent.items` field — no LLM used) |
| `source` | string | `finnhub` \| `sec-edgar` \| `maya` (future) |

### `OwnershipSnapshot`
| Field | Type | Notes |
|---|---|---|
| `insiderPct`, `institutionalPct`, `retailPctEstimate` | number | % of float; institutional currently unpopulated (deferred) |
| `topHolders[]` | array | `{name, type, shares, pct, changePct}` — schema-ready, empty until a paid 13F provider is wired in |
| `insiderNet3m` | number | Net shares bought(+)/sold(−), trailing 3 months, free Finnhub endpoint |
| `insiderTxCount3m` | number | |

### `AnalystTrend`
| Field | Type | Notes |
|---|---|---|
| `period` | string `YYYY-MM-01` | |
| `strongBuy`, `buy`, `hold`, `sell`, `strongSell` | number | Monthly counts. Read as MoM delta, not absolute level |

### `ShortInterest` (FINRA, twice-monthly)
| Field | Type | Notes |
|---|---|---|
| `settlementDate` | Date | |
| `shortInterest` | number | Shares |
| `avgDailyVolume` | number | |
| `daysToCover` | number | `shortInterest / avgDailyVolume` |
| `changePct` | number | vs. previous report |

### `MacroEvent`
| Field | Type | Notes |
|---|---|---|
| `type` | enum | fomc, cpi, ppi, nfp, gdp, pce |
| `date`, `label`, `impact` (`high`\|`medium`), `timeET`, `note` | — | Seeded from `data/macro-2026.json`, verified against federalreserve.gov + OMB schedule. Update yearly, not scraped |

### `MacroDataPoint` (FRED, live macro values — not ticker-specific)
| Field | Type | Notes |
|---|---|---|
| `series` | string | FRED series id: `FEDFUNDS`, `CPIAUCSL`, `PCEPILFE`, `UNRATE`, `DGS10` |
| `date` | string `YYYY-MM-DD` | Observation date reported by FRED |
| `value` | number | Raw level for `FEDFUNDS`/`UNRATE`/`DGS10` (percent); **computed year-over-year %** for `CPIAUCSL`/`PCEPILFE`, not the raw index |
| `unit` | string | `percent` or `yoy_pct` |
| `source` | string | always `fred` |

One document per `(series, date)` — a global macro snapshot, not scoped to any ticker. Fetched
once per `worker:calendar` run; since these series update monthly, most days upsert nothing new
(no-op, not a failure).

### `FinancialFact` (SEC EDGAR XBRL, latest fundamentals per ticker)
| Field | Type | Notes |
|---|---|---|
| `ticker` | string | |
| `concept` | string | Normalized name: `Revenues`, `NetIncomeLoss`, `EarningsPerShareDiluted`, `Assets`, `Liabilities`, `StockholdersEquity`, `NetCashProvidedByUsedInOperatingActivities`, `LongTermDebtNoncurrent` |
| `period` | string | `FY2025` (annual, from the latest 10-K) or `2026-Q2` (quarterly, from the latest 10-Q) |
| `fiscalPeriodType` | enum | `annual` \| `quarterly` |
| `value` | number | Raw reported value |
| `unit` | string | `USD` or `USD/shares` (EPS only) |
| `filed` | Date | Date the underlying filing was submitted to EDGAR |
| `source` | string | always `sec-xbrl` |

Two documents per ticker per concept (one annual, one quarterly) — **latest value only**, not a
historical time series. A ticker with no matching CIK (non-US listing) or that hasn't tagged a
given concept in XBRL simply has fewer/no `FinancialFact` docs for it — same graceful-skip
pattern as `CorporateEvent`'s SEC filings. No derived ratios (P/E, debt/equity, revenue growth)
are computed from this yet — it's raw reported line items only.

### `PriceStat` (Stooq daily OHLCV)
| Field | Type | Notes |
|---|---|---|
| `date` | string `YYYY-MM-DD` | |
| `open`, `high`, `low`, `close`, `volume` | number | |
| `changePct` | number | Close vs. previous close |
| `avgVolume30d`, `volumeRatio` | number | `volume / avgVolume30d` |
| `unusualVolume` | boolean | `volumeRatio >= 2` |

> ⚠️ **Currently degraded**: Stooq now blocks non-browser requests with a JS proof-of-work
> challenge (discovered 2026-07-19). `fetchDailyCandles` in `prices.js` degrades gracefully to
> empty `priceSeries`/`volumeRatio` rather than crashing, but daily candles and
> volume-anomaly detection are non-functional until this is fixed (candidate: swap to Yahoo v8
> chart's historical range). `TickerQuote` live quotes are unaffected — different source.

### `TickerTypology` (derived archetype, zero external calls)
| Dimension | Values | Derived from |
|---|---|---|
| `marketCapClass` | mega ≥$200B / large ≥$10B / mid ≥$2B / small / micro | Finnhub profile `marketCap` |
| `style` | growth (P/E≥35) / value (P/E≤15) / blend / speculative (no earnings) | P/E + EPS |
| `volatilityClass` | low (β<0.8) / medium / high (β>1.3) | beta |
| `dividendProfile` | none / payer / high-yield (≥4%) | dividend yield |
| `newsProfile` | quiet (0 articles) / covered / hot (≥15 articles/7d) | our own `Article` pipeline |
| `insiderSignal` | buying / selling / neutral | `insiderNet3m` |
| `squeezeRisk` | low / elevated (DTC≥4) / high (DTC≥8) | FINRA `daysToCover` |

Plus `primaryIndustry`, `industries[]`, flat `tags[]` (chip-ready: `mega-cap`, `growth`,
`high-beta`, `insider-buying`, `squeeze-watch`, `hot-coverage`, …), and `inputs` — the raw
numbers that produced every label above, so the UI can always show *why* a tag was assigned.

#### How `insiderNet3m` is actually computed (§4.10 / §7 `OwnershipSnapshot`)

Endpoint: Finnhub free tier, `GET /stock/insider-transactions?symbol=X&from=<90d ago>`
(`refreshOwnership()` in `src/services/ownership.js`), called once per active ticker, once a
day, from `worker:calendar`.

1. Finnhub returns every insider Form-4-derived transaction (officers, directors, 10%+
   holders) reported in the trailing 90 days for that ticker.
2. We sum each transaction's `change` field (positive = shares acquired, negative = shares
   disposed) across the whole batch → `insiderNet3m`. Transaction count is stored separately as
   `insiderTxCount3m`.
3. Both are upserted into `OwnershipSnapshot` keyed on `(ticker, asOf: today at UTC midnight)`
   — so it's a daily snapshot, not a running total; each day's document re-derives the sum from
   the last 90 days as of that day.
4. `computeTypology()` (`src/services/typology.js`) reads the latest snapshot and buckets it
   into `insiderSignal`: `buying` (net > 0), `selling` (net < 0), `neutral` (net = 0), `unknown`
   (no snapshot yet). `buying` also adds the `insider-buying` chip tag.

Nothing here requires an LLM or judgement call — it's a direct sum of Finnhub's reported
transactions. If `FINNHUB_API_KEY` is unset or the call errors, the ticker's insider fields
stay `unknown`/`null` rather than retrying — same degrade-gracefully pattern as everything
else in this service. There is currently no institutional (13F) counterpart — see §8.

#### How tickers get connected on the `/typology/map` — no graph, a shared label

`GET /typology/map?group=primaryIndustry` (or `style`/`marketCapClass`/`volatilityClass`,
`src/routes/typology.js`) is **not** a correlation, co-occurrence, or similarity graph. It's a
`$group` aggregation over `TickerTypology.primaryIndustry` — tickers only end up in the same
bucket because they were independently assigned the same industry string. The pipeline behind
that string:

1. **Per-article LLM tagging** (`worker:ingest`, `analyzePendingArticles()` in
   `src/services/analyzer.js`): every news article is sent to `gpt-4o-mini` in batches of 20.
   The prompt asks the model to read the headline/summary and return, per article, which
   tickers it's about and a lowercase `industries[]` guess from a suggested (not enforced) list
   — semiconductors, banking, energy, defense, healthcare, real-estate, software, retail,
   automotive, telecom, other. Stored on the `Article` doc.
2. **Per-ticker rollup** (`worker:calendar`, `computeTypology()` in `src/services/typology.js`):
   for a given ticker, aggregate the last 7 days of its analyzed articles, `$unwind` their
   `industries[]`, count frequency, take the top 5. The single most frequent becomes
   `primaryIndustry`; all 5 are kept as `industries[]`.
3. **The map groups on that field.** Two tickers appear "connected" on the map purely because
   the LLM tagged their respective recent news with the same industry word — there's no
   pairwise comparison between tickers, no embedding distance, no shared-ownership or
   sector-classification-provider data involved.

Practical implications for the client:
- The grouping can be noisy/inconsistent — the LLM isn't given a fixed enum, so near-synonyms
  (e.g. "software" vs "tech") could theoretically split a bucket. Worth normalizing server-side
  if this becomes visible in the UI.
- A ticker with no news in the last 7 days has `primaryIndustry: undefined` → falls into the
  `unknown` bucket (`$ifNull` in the aggregation), not omitted from the map.
- Switching `group=` to `style`/`marketCapClass`/`volatilityClass` uses deterministic
  numeric thresholds instead (see dimension table above) — those groupings are stable/reproducible,
  unlike `primaryIndustry` which can drift day to day as news volume and LLM tagging shift.

### `Article` (raw + LLM-tagged news)
| Field | Type | Notes |
|---|---|---|
| `source` | string | `finnhub` \| `yahoo` \| future `rss:globes` etc. |
| `sourceId`, `url` | — | Dedup key: `(source, sourceId)` or `url` |
| `headline`, `summary`, `publishedAt` | — | Raw |
| `analyzed` | boolean | Whether the LLM pass has run |
| `tickers[]`, `industries[]` | string[] | LLM-assigned and authoritative post-analysis (see §7.1 below) — pre-analysis, seeded from Finnhub's per-symbol company-news result or Yahoo's own `relatedTickers` |
| `sentiment` | number | −1..1, LLM-assigned |
| `themes[]` | string[] | e.g. `['china-demand','antitrust']` |
| `llmSummary` | string | Short LLM-generated summary |

#### 7.1 Ticker relevance — how a wrong tag used to survive forever (fixed 2026-07-22)

Both news sources seed `Article.tickers` with a pre-analysis guess *before* the LLM ever reads
the article — Finnhub's company-news result implies the ticker searched by is relevant; Yahoo's
search endpoint used to force-tag the searched-for ticker onto every result even when the
article was unrelated (Yahoo's `v1/finance/search?q=X` returns items merely *matching* the
query, not necessarily *about* X). The analyzer then used to `union` its own LLM-derived ticker
list with that seed instead of replacing it — so a wrong pre-analysis tag from either source
could never be corrected, even after the LLM correctly determined the article wasn't relevant.
Verified live: a Finnhub-sourced "Meta in talks with Anthropic over a $10B AI deal" article had
been permanently tagged `SPCX` purely because it showed up while fetching SpaceX's company news.

Fixed in two places:
- `analyzer.js` now **replaces** `Article.tickers` with the LLM's own output on every analysis
  pass — the LLM read the actual headline/summary and is authoritative. A ticker it misses (not
  named in the text) is a smaller cost than a wrong ticker polluting another company's sentiment
  rollup, headlines feed, and the Portfolio client's related-tickers graph indefinitely.
- `yahoo.js` no longer force-seeds the searched-for ticker; it seeds from Yahoo's own
  `relatedTickers` field only (a real, if imperfect, relevance signal) and lets the LLM pass
  correct it, same as every other source.

A one-time backfill (`scripts/backfill-yahoo-ticker-tags.js` + `scripts/run-analyzer-backlog.js`)
reset `analyzed:false` on all ~6,600 previously-analyzed articles and re-ran them through the
corrected analyzer so historical tags got fixed too, not just new ingestion going forward.

### `TickerQuote` — see §6 table (same fields, this is the raw doc `/quotes` shapes from)

### `WatchedTicker` (the dynamic watchlist)
| Field | Type | Notes |
|---|---|---|
| `tier` | enum | portfolio > manual > watchlist > discovery (priority order) |
| `active` | boolean | |
| `holdersCount`, `watchersCount` | number | From synced Stockfolio `positions`/`watchlists` |
| `mentions7d` | number | News-mention count driving discovery-tier promotion |
| `lastActiveAt`, `deactivatedAt` | Date | Drives 30-day decay for discovery tier only |

---

## 8. Gaps the client should design around today

These are known, not bugs to chase — see CLAUDE.md "Known gaps" for full detail:

1. **`ownership.topHolders` is always `[]`** — 13F institutional data deliberately deferred.
   Render insider-only ownership info; don't build UI expecting institutional breakdowns yet.
2. **`priceSeries`/`volumeRatio`/`unusualVolume` are currently empty/false for all tickers** —
   Stooq is blocking requests (since 2026-07-19). Don't treat an empty price chart as "no
   volume anomaly," treat it as "data temporarily unavailable."
3. **No TASE (`.TA`) events/filings** — EDGAR and Stooq both skip non-US tickers gracefully
   (null fields, no crash). A Maya-sourced `CorporateEvent`/`Article` path is planned but not
   built.
4. Every `summary.*` field can independently be `null` — badges should render conditionally
   per-field, not gate the whole card on one field being present.
5. **`MacroDataPoint` and `FinancialFact` are not yet in `/enrich/:ticker`** — both collections
   are populated by `worker:calendar` (see §2/§3/§7) but `getEnrichment()` in the Portfolio
   backend's `stockfolioInsightsService.js` doesn't query them yet, and nothing renders them in
   `TickerInsightCard.vue`. Data exists in MongoDB; the read/UI wiring is a follow-up.
6. **`MacroDataPoint` will be empty until `FRED_API_KEY` is set** — the fetch code is wired into
   `worker:calendar` and degrades gracefully (logs a per-series error, upserts 0) without a key,
   same pattern as FINRA short interest. Get a free key at
   `fred.stlouisfed.org/docs/api/api_key.html`.

---

## 9. Recent fixes on the Portfolio (client) side — 2026-07-22

These didn't change this repo's schemas or workers, but changed how the Portfolio app reads and
renders the data described above — noted here since they affect what the client actually shows.

- **Watchlist "Insider" sort mode**: new grouping mode (alongside Market/Change/Div/Industry)
  bucketing watchlist rows into Insider buying / Insider selling / No data, backed by a new
  bulk `getInsiderSnapshots()` lookup in `stockfolioInsightsService.js` (one aggregation query
  for the whole watchlist against `OwnershipSnapshot`, not N calls to `/enrich`). The sort and
  badge size the move as **insider $ traded ÷ market cap**, not raw share count — a small-cap's
  modest trade can now correctly outrank a mega-cap's larger-but-trivial one.
- **Ticker news consolidation**: the Position page used to show two separate, redundant "news
  for this ticker" lists — `TickerInsightCard`'s inline headlines (this repo's `Article`
  collection) and a second GNews-backed paginated section (Portfolio's own, unrelated
  `/stocks/news` pipeline). Consolidated to one list, backed by this repo's LLM-tagged data, now
  with its own pagination via a new `GET /enrich/news/:ticker` endpoint
  (`getTickerNews()` in `stockfolioInsightsService.js` — 90-day lookback, real `skip`/`limit`
  pagination, uncached since the `Article` collection is append-only once analyzed).
- **`TickerInsightCard` headline summaries were silently dropping** — the client-side mapping
  from this repo's `Article.llmSummary` field only carried `headline`/`url`/`publishedAt`
  through to the render, so every headline card showed a title with no summary text. Fixed to
  map `llmSummary` through too.
- **Related Tickers / Typology Map empty states rendered as unstyled plain text** on the
  Portfolio client — a CSS class both referenced was never actually defined. Not a data issue on
  this repo's side; purely a Portfolio client styling bug, now fixed.
