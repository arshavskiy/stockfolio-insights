// Unofficial Investing.com consensus scraper for TASE analyst coverage.
// Use only as a fallback when structured APIs don't cover the ticker.
const { AnalystTrend } = require('../models/AnalystTrend')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const DEFAULT_SLUGS = {
  'POLI.TA': 'bank-hapoalim',
  'LUMI.TA': 'bank-leumi',
  'TEVA.TA': 'teva-pharmaceutical-inds-ltd',
  'MZTF.TA': 'mizrahi-tefahot-bank',
  'NICE.TA': 'nice-ltd',
  'DSCT.TA': 'israel-discount-bank',
  'ICL.TA': 'israel-chemicals',
}

function configuredSlugs() {
  if (!process.env.INVESTING_EQUITY_SLUGS) return {}
  try {
    return JSON.parse(process.env.INVESTING_EQUITY_SLUGS)
  } catch (e) {
    console.warn('[investing] invalid INVESTING_EQUITY_SLUGS JSON:', e.message)
    return {}
  }
}

function slugForTicker(ticker) {
  const symbol = ticker.toUpperCase()
  return configuredSlugs()[symbol] || DEFAULT_SLUGS[symbol] || null
}

function stripHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function numberFromText(value) {
  if (!value) return null
  const n = Number(String(value).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

function currentPeriod() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

// Investing's TASE pages label values as ILS, but display equity prices in
// agorot-like units (POLI 7,376 means ₪73.76). Store shekels to match quote APIs.
function taseTarget(value) {
  return value == null ? null : +(value / 100).toFixed(4)
}

function parseHebrewConsensus(text) {
  const faq = text.match(/לפי תובנות מאת\s+(\d+)\s+אנליסטים.*?(\d+)\s+אנליסטים ממליצים לקנות.*?(\d+)\s+מציעים למכור.*?(\d+)\s+ממליצים להחזיק/)
  const analystCount = numberFromText(faq?.[1])
  const buy = numberFromText(faq?.[2])
  const sell = numberFromText(faq?.[3])
  const hold = numberFromText(faq?.[4])

  const target = text.match(/מחיר היעד הממוצע ל-12 חודשים.*?ILS\s?([\d,]+).*?גבוהה של ILS\s?([\d,]+).*?נמוכה של ILS\s?([\d,]+)/)
  const targetPriceAvg = numberFromText(target?.[1])
  const targetPriceHigh = numberFromText(target?.[2])
  const targetPriceLow = numberFromText(target?.[3])

  if (buy == null && hold == null && sell == null) return null
  return {
    analystCount,
    buy: buy || 0,
    hold: hold || 0,
    sell: sell || 0,
    strongBuy: 0,
    strongSell: 0,
    targetPriceAvg: taseTarget(targetPriceAvg),
    targetPriceHigh: taseTarget(targetPriceHigh),
    targetPriceLow: taseTarget(targetPriceLow),
    currency: 'ILS',
  }
}

function parseEnglishConsensus(text) {
  const faq = text.match(/based on (?:insights from|forecasts of)\s+(\d+)\s+analysts.*?(\d+)\s+analysts recommend buying.*?(\d+)\s+(?:suggest|recommend) selling.*?(\d+)\s+recommend holding/i)
  const analystCount = numberFromText(faq?.[1])
  const buy = numberFromText(faq?.[2])
  const sell = numberFromText(faq?.[3])
  const hold = numberFromText(faq?.[4])

  const target = text.match(/average 12-month price target.*?ILS\s?([\d,]+).*?high estimate of ILS\s?([\d,]+).*?low estimate of ILS\s?([\d,]+)/i)
  const targetPriceAvg = numberFromText(target?.[1])
  const targetPriceHigh = numberFromText(target?.[2])
  const targetPriceLow = numberFromText(target?.[3])

  if (buy == null && hold == null && sell == null) return null
  return {
    analystCount,
    buy: buy || 0,
    hold: hold || 0,
    sell: sell || 0,
    strongBuy: 0,
    strongSell: 0,
    targetPriceAvg: taseTarget(targetPriceAvg),
    targetPriceHigh: taseTarget(targetPriceHigh),
    targetPriceLow: taseTarget(targetPriceLow),
    currency: 'ILS',
  }
}

async function fetchInvestingConsensus(ticker) {
  const symbol = ticker.toUpperCase()
  const slug = slugForTicker(symbol)
  if (!slug) return 0

  const url = `https://il.investing.com/equities/${slug}-consensus-estimates`
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  })
  const html = await res.text()
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      console.warn(`[investing] blocked (${res.status}) for ${symbol}; skipping direct consensus scrape`)
      return 0
    }
    if (/cf_chl|Enable JavaScript and cookies|Just a moment/i.test(html)) {
      console.warn(`[investing] Cloudflare challenge for ${symbol}; skipping direct consensus scrape`)
      return 0
    }
    throw new Error(`investing consensus ${res.status} for ${symbol}`)
  }

  const text = stripHtml(html)
  const parsed = parseHebrewConsensus(text) || parseEnglishConsensus(text)
  if (!parsed) return 0

  const result = await AnalystTrend.updateOne(
    { ticker: symbol, period: currentPeriod() },
    {
      $set: {
        ...parsed,
        source: 'investing-consensus',
        sourceUrl: url,
      },
    },
    { upsert: true }
  )
  return result.upsertedCount || result.modifiedCount ? 1 : 0
}

module.exports = {
  fetchInvestingConsensus,
  parseHebrewConsensus,
  parseEnglishConsensus,
  slugForTicker,
}
