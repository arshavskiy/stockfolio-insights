// SEC EDGAR XBRL company facts — free, no key, reuses secFilings.js's CIK map.
// Latest annual (10-K) + latest quarterly (10-Q) value per concept — not a
// full historical series.
const { FinancialFact } = require('../models/FinancialFact')
const { loadCikMap } = require('./secFilings')

const UA = process.env.SEC_USER_AGENT || 'StockfolioInsights research contact@example.com'

// Normalized concept name -> { unit, tags: [candidate us-gaap tag names].
// Revenue in particular has two live tags across different filers (some
// still use generic `Revenues`, others moved to the ASC-606 contract-revenue
// tag) and which one a given company currently updates isn't predictable
// from list order — resolveEntries() below picks whichever has the newest
// filed entry, per ticker.
const CONCEPTS = {
  Revenues: { unit: 'USD', tags: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'] },
  NetIncomeLoss: { unit: 'USD', tags: ['NetIncomeLoss'] },
  EarningsPerShareDiluted: { unit: 'USD/shares', tags: ['EarningsPerShareDiluted'] },
  Assets: { unit: 'USD', tags: ['Assets'] },
  Liabilities: { unit: 'USD', tags: ['Liabilities'] },
  StockholdersEquity: { unit: 'USD', tags: ['StockholdersEquity'] },
  NetCashProvidedByUsedInOperatingActivities: { unit: 'USD', tags: ['NetCashProvidedByUsedInOperatingActivities'] },
  LongTermDebtNoncurrent: { unit: 'USD', tags: ['LongTermDebtNoncurrent'] },
}

function latestByForm(entries, form) {
  const matches = entries.filter((e) => e.form === form)
  if (!matches.length) return null
  return matches.reduce((a, b) => (new Date(b.end) > new Date(a.end) ? b : a))
}

// Some concepts have more than one candidate XBRL tag (e.g. revenue: older
// filers still use the generic `Revenues`, others migrated to
// `RevenueFromContractWithCustomerExcludingAssessedTax` after ASC 606) —
// and which one is "current" for a given company isn't fixed: a filer can
// stop updating either tag while continuing the other. Picking by list
// order caused a real bug (NVDA's abandoned contract-revenue tag looked
// "found" while its actual current filings use `Revenues`, silently
// pairing FY2022 revenue with FY2026 net income). Instead, evaluate every
// candidate tag and keep whichever one's most recent entry is newest.
function resolveEntries(gaap, tags, unitKey) {
  let best = null
  let bestDate = null
  for (const tag of tags) {
    const entries = gaap[tag]?.units?.[unitKey]
    if (!entries || !entries.length) continue
    const latest = entries.reduce((a, b) => (new Date(b.end) > new Date(a.end) ? b : a))
    const latestDate = new Date(latest.end)
    if (!bestDate || latestDate > bestDate) {
      best = entries
      bestDate = latestDate
    }
  }
  return best
}

async function fetchXbrlFacts(ticker) {
  const ciks = await loadCikMap()
  const cik = ciks.get(ticker.toUpperCase())
  if (!cik) return 0 // non-US listing — same graceful skip as secFilings.js

  const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
    headers: { 'User-Agent': UA },
  })
  if (res.status === 404) return 0 // no XBRL facts filed for this CIK
  if (!res.ok) throw new Error(`sec companyfacts ${res.status} for ${ticker}`)
  const data = await res.json()

  const gaap = data.facts?.['us-gaap']
  if (!gaap) return 0

  let upserted = 0
  for (const [concept, { unit: unitKey, tags }] of Object.entries(CONCEPTS)) {
    try {
      const entries = resolveEntries(gaap, tags, unitKey)
      if (!entries) continue

      const annual = latestByForm(entries, '10-K')
      const quarterly = latestByForm(entries, '10-Q')

      const rows = []
      if (annual) rows.push({ fact: annual, period: `FY${annual.fy}`, fiscalPeriodType: 'annual' })
      if (quarterly) rows.push({ fact: quarterly, period: `${quarterly.fy}-${quarterly.fp}`, fiscalPeriodType: 'quarterly' })

      for (const { fact, period, fiscalPeriodType } of rows) {
        const r = await FinancialFact.updateOne(
          { ticker: ticker.toUpperCase(), concept, period },
          {
            $set: {
              fiscalPeriodType,
              value: fact.val,
              unit: unitKey === 'USD/shares' ? 'USD/shares' : 'USD',
              filed: fact.filed ? new Date(fact.filed) : undefined,
              source: 'sec-xbrl',
            },
          },
          { upsert: true }
        )
        if (r.upsertedCount) upserted++
      }
    } catch (e) {
      console.error(`[xbrlFacts] ${ticker}.${concept} failed:`, e.message)
    }
  }
  return upserted
}

module.exports = { fetchXbrlFacts }
