// SEC EDGAR submissions API — completely free, no key. Gives real filing dates
// for 10-K / 10-Q / 8-K etc. SEC requires a descriptive User-Agent.
import { CorporateEvent } from '../models/CorporateEvent'

const UA = process.env.SEC_USER_AGENT || 'StockfolioInsights research contact@example.com'
const TRACKED_FORMS = new Set(['10-K', '10-Q', '8-K', '20-F', '6-K'])

// ticker -> CIK map (SEC publishes the full mapping)
let cikCache: Map<string, string> | null = null

async function loadCikMap(): Promise<Map<string, string>> {
  if (cikCache) return cikCache
  const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`sec cik map ${res.status}`)
  const data = (await res.json()) as Record<string, { cik_str: number; ticker: string }>
  cikCache = new Map(
    Object.values(data).map((v) => [v.ticker.toUpperCase(), String(v.cik_str).padStart(10, '0')])
  )
  return cikCache
}

export async function fetchSecFilings(ticker: string): Promise<number> {
  const ciks = await loadCikMap()
  const cik = ciks.get(ticker.toUpperCase())
  if (!cik) return 0 // non-US listing (e.g. TASE-only) — handled by Maya source later

  const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`sec submissions ${res.status} for ${ticker}`)
  const data = (await res.json()) as any

  const recent = data.filings?.recent
  if (!recent) return 0

  let upserted = 0
  const n = recent.form.length
  for (let i = 0; i < n; i++) {
    const form: string = recent.form[i]
    if (!TRACKED_FORMS.has(form)) continue
    const accession: string = recent.accessionNumber[i]
    const filingDate = new Date(recent.filingDate[i])
    const accessionPath = accession.replace(/-/g, '')

    await CorporateEvent.updateOne(
      { ticker: ticker.toUpperCase(), type: form, date: filingDate },
      {
        $set: {
          accessionNo: accession,
          filingUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPath}/${recent.primaryDocument[i]}`,
          period: recent.reportDate?.[i] || undefined,
          source: 'sec-edgar',
        },
      },
      { upsert: true }
    ).then((r) => { if (r.upsertedCount) upserted++ })
  }
  return upserted
}
