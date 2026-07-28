// Israeli business-news ingestion. These sources feed the same Article queue as
// Finnhub/Yahoo; the analyzer decides which US/TASE tickers are truly relevant.
const crypto = require('crypto')
const { Article } = require('../models/Article')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const DEFAULT_SOURCES = [
  {
    source: 'rss:globes-capital-market',
    type: 'rss',
    url: 'https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=585',
  },
  {
    source: 'rss:globes-all',
    type: 'rss',
    url: 'https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=2',
  },
  {
    source: 'html:bizportal-analyst-tags',
    type: 'bizportal-list',
    url: 'https://www.bizportal.co.il/list/tags/47946',
  },
  {
    source: 'html:bizportal-capital-market',
    type: 'bizportal-list',
    url: 'https://www.bizportal.co.il/capitalmarket/news',
  },
]

function configuredSources() {
  if (!process.env.ISRAELI_NEWS_SOURCES) return DEFAULT_SOURCES
  try {
    const sources = JSON.parse(process.env.ISRAELI_NEWS_SOURCES)
    return Array.isArray(sources) && sources.length ? sources : DEFAULT_SOURCES
  } catch (e) {
    console.warn('[israeli-news] invalid ISRAELI_NEWS_SOURCES JSON:', e.message)
    return DEFAULT_SOURCES
  }
}

function decodeEntities(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([a-f0-9]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function stripHtml(value = '') {
  return decodeEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tagValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? decodeEntities(m[1]).trim() : ''
}

function absoluteUrl(url, base) {
  try {
    return new URL(decodeEntities(url), base).toString()
  } catch {
    return ''
  }
}

function stableId(url) {
  return crypto.createHash('sha1').update(url).digest('hex')
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} for ${url}`)
  return text
}

function parseRss(xml, source) {
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
  return items.map((m) => {
    const item = m[1]
    const url = tagValue(item, 'link') || tagValue(item, 'guid')
    const publishedAt = new Date(tagValue(item, 'pubDate') || Date.now())
    return {
      source: source.source,
      sourceId: tagValue(item, 'guid') || stableId(url),
      url,
      headline: stripHtml(tagValue(item, 'title')),
      summary: stripHtml(tagValue(item, 'description')).slice(0, 2000),
      publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
    }
  }).filter((a) => a.url && a.headline)
}

function parseBizportalList(html, source) {
  const found = new Map()
  const linkRe = /<a\b[^>]*href=["']([^"']*(?:\/(?:capitalmarket|global|general|realestates|energyandinfra|technology)\/news\/article\/\d+|\/list\/tags\/\d+\/article\/\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (const m of html.matchAll(linkRe)) {
    const url = absoluteUrl(m[1], source.url)
    const headline = stripHtml(m[2])
    if (!url || !headline || headline.length < 8) continue
    found.set(url, {
      source: source.source,
      sourceId: stableId(url),
      url,
      headline,
      summary: '',
      publishedAt: new Date(),
    })
  }

  return [...found.values()]
}

async function upsertArticles(articles) {
  let inserted = 0
  for (const article of articles) {
    try {
      await Article.updateOne(
        { source: article.source, sourceId: article.sourceId },
        { $setOnInsert: article },
        { upsert: true }
      ).then((r) => { if (r.upsertedCount) inserted++ })
    } catch (e) {
      if (e?.code !== 11000) console.error('[israeli-news] upsert error', e?.message)
    }
  }
  return inserted
}

async function fetchSource(source) {
  const text = await fetchText(source.url)
  const articles = source.type === 'rss'
    ? parseRss(text, source)
    : parseBizportalList(text, source)
  return upsertArticles(articles)
}

async function fetchIsraeliBusinessNews() {
  if (process.env.ISRAELI_NEWS_ENABLED === 'false') return 0

  let inserted = 0
  for (const source of configuredSources()) {
    try {
      const count = await fetchSource(source)
      inserted += count
      console.log(`[israeli-news] ${source.source}: +${count}`)
    } catch (e) {
      console.error(`[israeli-news] ${source.source} failed:`, e.message)
    }
  }
  return inserted
}

module.exports = {
  fetchIsraeliBusinessNews,
  parseRss,
  parseBizportalList,
}
