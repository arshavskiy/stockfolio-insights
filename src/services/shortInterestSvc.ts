// FINRA consolidated short interest (published twice monthly).
// FINRA's Query API needs free registration (https://developer.finra.org) —
// set FINRA_CLIENT_ID/SECRET in .env. Degrades to a skip if not configured.
import { ShortInterest } from '../models/ShortInterest'

const TOKEN_URL = 'https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token?grant_type=client_credentials'
const DATA_URL = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest'

let cachedToken: { token: string; exp: number } | null = null

async function getToken(): Promise<string | null> {
  const id = process.env.FINRA_CLIENT_ID
  const secret = process.env.FINRA_CLIENT_SECRET
  if (!id || !secret) return null
  if (cachedToken && Date.now() < cachedToken.exp) return cachedToken.token

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') },
  })
  if (!res.ok) throw new Error(`finra auth ${res.status}`)
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 }
  return cachedToken.token
}

export async function fetchShortInterest(ticker: string): Promise<number> {
  const token = await getToken()
  if (!token) {
    console.warn('[short-interest] FINRA credentials not configured — skipping')
    return 0
  }

  const res = await fetch(DATA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      limit: 6, // ~3 months of bi-monthly reports
      compareFilters: [{ compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: ticker.toUpperCase() }],
      sortFields: ['-settlementDate'],
    }),
  })
  if (!res.ok) throw new Error(`finra data ${res.status} for ${ticker}`)
  const rows = (await res.json()) as Array<{
    settlementDate: string
    currentShortPositionQuantity: number
    averageDailyVolumeQuantity: number
    daysToCoverQuantity: number
    changePercent: number
  }>

  let upserted = 0
  for (const r of rows || []) {
    await ShortInterest.updateOne(
      { ticker: ticker.toUpperCase(), settlementDate: new Date(r.settlementDate) },
      {
        $set: {
          shortInterest: r.currentShortPositionQuantity,
          avgDailyVolume: r.averageDailyVolumeQuantity,
          daysToCover: r.daysToCoverQuantity,
          changePct: r.changePercent,
        },
      },
      { upsert: true }
    ).then((x) => { if (x.upsertedCount) upserted++ })
  }
  return upserted
}
