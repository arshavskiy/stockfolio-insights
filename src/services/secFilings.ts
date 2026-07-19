// SEC EDGAR submissions API — completely free, no key. Gives real filing dates
// for 10-K / 10-Q / 8-K etc. SEC requires a descriptive User-Agent.
import { CorporateEvent } from '../models/CorporateEvent'

const UA = process.env.SEC_USER_AGENT || 'StockfolioInsights research contact@example.com'

// SEC 8-K item codes -> human-readable classification. No LLM needed:
// EDGAR's submissions JSON already lists the item codes per filing.
const ITEM_LABELS: Record<string, string> = {
  '1.01': 'material-agreement',
  '1.02': 'agreement-termination',
  '1.03': 'bankruptcy',
  '2.01': 'acquisition-or-disposal',
  '2.02': 'results-of-operations',
  '2.03': 'new-financial-obligation',
  '2.05': 'exit-or-disposal-costs',
  '2.06': 'material-impairment',
  '3.01': 'delisting-notice',
  '4.01': 'auditor-change',
  '4.02': 'financials-non-reliance',   // restatement — high impact
  '5.01': 'change-in-control',
  '5.02': 'executive-change',           // CEO/CFO/director departure or appointment
  '5.03': 'charter-bylaw-amendment',
  '5.07': 'shareholder-vote',
  '7.01': 'reg-fd-disclosure',
  '8.01': 'other-events',
  '9.01': 'exhibits',
}

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

    // 8-K filings list their item codes in the submissions payload
    const rawItems: string = form === '8-K' ? recent.items?.[i] || '' : ''
    const itemCodes = rawItems.split(',').map((x: string) => x.trim()).filter(Boolean)

    await CorporateEvent.updateOne(
      { ticker: ticker.toUpperCase(), type: form, date: filingDate },
      {
        $set: {
          accessionNo: accession,
          ...(itemCodes.length && {
            items: itemCodes,
            itemLabels: itemCodes.map((c: string) => ITEM_LABELS[c] || c),
          }),
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
