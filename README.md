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
