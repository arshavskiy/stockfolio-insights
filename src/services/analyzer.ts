// Batched LLM analysis: tickers, industries, sentiment, themes per article.
// Uses Claude Haiku for cost; swap model via env if needed.
import { Article } from '../models/Article'

const MODEL = process.env.ANALYZER_MODEL || 'claude-haiku-4-5-20251001'
const BATCH_SIZE = 20

interface AnalysisResult {
  index: number
  tickers: string[]
  industries: string[]
  sentiment: number
  themes: string[]
  summary: string
}

export async function analyzePendingArticles(): Promise<number> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set')

  const pending = await Article.find({ analyzed: false })
    .sort({ publishedAt: -1 })
    .limit(BATCH_SIZE)
    .lean()

  if (pending.length === 0) return 0

  const payload = pending.map((a, i) => ({
    index: i,
    headline: a.headline,
    summary: a.summary || '',
  }))

  const prompt = `You are a financial news tagger. For each article below, return a JSON array only (no prose, no markdown fences). Each element:
{"index": n, "tickers": ["AAPL"], "industries": ["semiconductors"], "sentiment": -1..1, "themes": ["short-kebab-tags"], "summary": "one line"}

Rules:
- tickers: US/TASE symbols explicitly relevant; empty array if none.
- industries: lowercase, from broad sectors (semiconductors, banking, energy, defense, healthcare, real-estate, software, retail, automotive, telecom, other).
- sentiment: market-relevant tone for the tagged tickers, -1 bearish to 1 bullish, 0 neutral.
- This is descriptive tagging, not investment advice.

Articles:
${JSON.stringify(payload)}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as any
  const text: string = data.content?.map((b: any) => b.text || '').join('') || '[]'

  let results: AnalysisResult[]
  try {
    results = JSON.parse(text.replace(/```json|```/g, '').trim())
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
              tickers: [...new Set([...(pending[i].tickers || []), ...r.tickers])],
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
