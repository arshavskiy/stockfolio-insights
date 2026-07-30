// TASE-scoped calendar worker — same enrichment steps as workers/calendar.js
// (analyst trends, earnings, dividends, ownership, short interest, candles,
// profile, typology) but filtered to .TA tickers only, on its own schedule.
// SEC filings / XBRL facts are skipped — EDGAR has no Israeli filings, so
// those steps would only ever fail for TASE symbols.
const cron = require("node-cron");
const { connectDB } = require("../db");
const { refreshWatchlist, getActiveTickers } = require("../services/watchlist");
const { refreshOwnership } = require("../services/ownership");
const {
  fetchEarningsSurprises,
  fetchAnalystTrends,
  fetchDividends,
} = require("../services/fundamentals");
const { fetchShortInterest } = require("../services/shortInterestSvc");
const { fetchDailyCandles } = require("../services/prices");
const { refreshProfile } = require("../services/yahoo");
const { computeTypology } = require("../services/typology");

async function runTaseCalendarPipeline() {
  await refreshWatchlist();
  const tickers = (await getActiveTickers()).filter((t) =>
    t.toUpperCase().endsWith(".TA"),
  );
  console.log(`[tase-calendar] start — ${tickers.length} tickers`);

  for (const t of tickers) {
    const steps = [
      ["ownership", () => refreshOwnership(t)],
      ["earningsSurprises", () => fetchEarningsSurprises(t)],
      ["analystTrends", () => fetchAnalystTrends(t)],
      ["dividends", () => fetchDividends(t)],
      ["shortInterest", () => fetchShortInterest(t)],
      ["dailyCandles", () => fetchDailyCandles(t)],
      ["profile", () => refreshProfile(t)],
      ["typology", () => computeTypology(t)],
    ];
    let okCount = 0;
    for (const [name, run] of steps) {
      try {
        await run();
        okCount++;
        console.log(`[tase-calendar] ${t}.${name}: ok`);
      } catch (e) {
        console.error(`[tase-calendar] ${t}.${name} failed:`, e.message);
      }
    }
    console.log(`[tase-calendar] ${t}: ${okCount}/${steps.length} steps ok`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log("[tase-calendar] done");
}

if (require.main === module) {
  (async () => {
    await connectDB();
    await runTaseCalendarPipeline();
    cron.schedule(
      process.env.TASE_CALENDAR_CRON || "0 7 * * *",
      runTaseCalendarPipeline,
    ); // daily 07:00 UTC, after the US calendar run
    console.log(
      "[tase-calendar] scheduled:",
      process.env.TASE_CALENDAR_CRON || "0 7 * * *",
    );
  })();
}

module.exports = { runTaseCalendarPipeline };
