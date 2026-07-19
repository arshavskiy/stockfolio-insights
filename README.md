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
