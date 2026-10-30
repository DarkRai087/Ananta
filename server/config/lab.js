// Lab defaults. Everything here can be overridden per run from the UI.
import { MARKET } from "./market.js";
export const LAB = {
  intervals: { "1m": 1, "3m": 3, "5m": 5, "15m": 15 },
  defaultInterval: "5m",

  backtest: {
    riskPerTrade: 1000, // ₹ lost if the stop is hit, charges + stop slippage included (sizes qty)
    slippagePct: 0.05, // applied to market fills (entries, stops, forced and signal exits)
    maxTradesPerDay: 2, // per symbol per strategy
    maxDailyLoss: 3000, // ₹ net; trading halts for the rest of that day. 0 = off
    maxPositionValue: 500000, // ₹ cap on qty × price (MIS leverage sanity cap)
    profitTarget: 0, // ₹ net profit (after costs) to take on every trade; overrides strategy targets. 0 = off
    indexFilter: "off", // "off" | "sector" | "market": only buy when the stock's index is up, only sell when it's down
    entryCutoff: MARKET.entryCutoff, // session times live in config/market.js
    squareOff: MARKET.squareOff,
    includeSpecialSessions: false,
  },

  walkForward: { inSampleFraction: 0.7 },

  // Earlier daily bars a strategy can see (ctx.ref.daily), e.g. for NR7 or daily ATR.
  historyDays: 20,

  // Earlier sessions' opening profiles a strategy can see (ctx.ref.profile): opening-range widths
  // and volume by time of day, for OR percentiles and same-time relative volume (ORB engine).
  profileDays: 60,

  // Today's Top 3 and the scoreboard.
  ranking: {
    oosSessions: 60, // out-of-sample window; the backtest window is oosSessions / (1 − inSampleFraction)
    minTrades: 30, // fewer matching trades → "not enough data"
    refreshMinutes: 5,
    freezeAt: "10:30",
  },

  // How "today" is classified.
  context: {
    orMinutes: 15, // opening range used for context (complete at 09:30)
    atrDays: 14, // daily ATR from intraday-derived daily bars
    gapPct: 0.5, // |gap| below this = flat
    orNarrow: 0.25, // OR width / ATR below this = narrow
    orWide: 0.5, // above this = wide
    match: ["gap", "or", "pos"], // which dimensions must match (drop one for more samples)
  },

  patternStats: {
    horizons: [3, 6, 12],
    primaryHorizon: 6,
    baselineSamplesPerHit: 5,
    minCount: 30,
    seed: 42,
  },

  // How much intraday history the main chart shows (sessions) and fetches on first view.
  chartSessions: { "1m": 20, "3m": 40, "5m": 90, "15m": 250 },
  syncTtlSec: 10, // min seconds between "fetch newer candles" calls per symbol+interval (the chart polls every 15s)
  backfillYears: 2,
};

export const INTERVAL_MIN = LAB.intervals;
