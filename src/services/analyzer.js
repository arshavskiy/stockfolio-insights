// Batched LLM analysis: tickers, industries, sentiment, themes per article.
// Uses OpenAI (gpt-4o-mini by default) for cost; swap model via env if needed.
const { Article } = require('../models/Article')

const MODEL = process.env.ANALYZER_MODEL || 'gpt-4o-mini'
const BATCH_SIZE = 20

async function analyzePendingArticles() {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY is not set')

  const pending = await Article.find({ analyzed: false })
    .sort({ publishedAt: -1 })
    .limit(BATCH_SIZE)
    .lean()

  if (pending.length === 0) return 0

  const payload = pending.map((a, i) => ({
    index: i,
    headline: a.headline,
    summary: a.summary || '',
    tickerHints: a.tickers || [],
  }))

  const prompt = `You are a financial news tagger. For each article below, return ONLY a JSON object of the form {"results": [...]} (no prose, no markdown fences). Each element of "results":
{"index": n, "tickers": ["AAPL"], "industries": ["semiconductors"], "sentiment": -1..1, "themes": ["short-kebab-tags"], "summary": "one line"}

Rules:
- tickers: US/TASE symbols explicitly relevant; empty array if none.
- tickerHints: provider/scraper hints, especially for Hebrew/TASE articles. Use them when the headline/summary is actually about that company; drop them when irrelevant.
- industries: lowercase, from broad sectors (semiconductors, banking, energy, defense, healthcare, real-estate, software, retail, automotive, telecom, other).
- sentiment: market-relevant tone for the tagged tickers, -1 bearish to 1 bullish, 0 neutral.
- This is descriptive tagging, not investment advice.

Articles:
${JSON.stringify(payload)}`

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content || '{"results":[]}'

  let results
  try {
    results = JSON.parse(text).results || []
  } catch {
    console.error('[analyzer] failed to parse LLM output, marking batch analyzed to avoid loop')
    results = []
  }

  const byIndex = new Map(results.map((r) => [r.index, r]))
  let updated = 0
  for (let i = 0; i < pending.length; i++) {
    const r = byIndex.get(i)
    await Article.updateOne(
      { _id: pending[i]._id },
      r
        ? {
            $set: {
              analyzed: true,
              // Authoritative: the LLM read the actual headline/summary text.
              // Previously unioned with the pre-analysis seed (Yahoo relatedTickers
              // / Finnhub company-news ticker), which let an irrelevant seed tag
              // survive analysis forever — e.g. a search-query ticker force-added
              // pre-LLM would never get removed even though the LLM correctly
              // saw the article wasn't about it. Replacing avoids that; a
              // ticker the LLM misses (not named in headline/summary) is a much
              // smaller cost than a wrong ticker polluting another company's
              // sentiment/news feed indefinitely.
              tickers: [...new Set(r.tickers)],
              industries: r.industries,
              sentiment: Math.max(-1, Math.min(1, r.sentiment)),
              themes: r.themes,
              llmSummary: r.summary,
            },
          }
        : { $set: { analyzed: true } } // don't retry forever on parse failure
    )
    updated++
  }
  return updated
}

module.exports = { analyzePendingArticles }
