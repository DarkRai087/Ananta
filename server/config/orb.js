// Opening Range Breakout: the multi-factor decision engine (server/orbEngine/).
//
// Every number the engine uses is here. The backtest (strategies/orb.js), the trade-plan row and
// the decision report read the same values. Thresholds are starting assumptions to be checked
// with `npm run orb-research`, not proven settings.
//
// Scores measure SETUP QUALITY, not the chance of a win. Missing data scores 0, is listed in the
// report, and never counts as confirmation.
import { EVENTS } from "./events.js";

export const ORB = {
  // ── Final classification ───────────────────────────────────────────────────
  classes: [
    { min: 85, id: "high", label: "High quality", action: "ELIGIBLE FOR EXECUTION" },
    { min: 75, id: "qualified", label: "Qualified", action: "WAIT FOR / VERIFY ENTRY" },
    { min: 65, id: "moderate", label: "Moderate", action: "WATCHLIST" },
    { min: 50, id: "weak", label: "Weak", action: "NO TRADE" },
    { min: 0, id: "poor", label: "Poor", action: "NO TRADE" },
  ],
  executeAt: 85, // LONG / SHORT needs at least this (strategy param minScore overrides it)
  watchAt: 65,

  // ── The breakout and the three entry models ────────────────────────────────
  setup: {
    bufferPct: 0.05, // a close must clear ORH / ORL by this % to count as a breakout close
    acceptanceBars: 1, // model A: completed candles after the breakout that must hold beyond the level
    // Model C (momentum): enter on the breakout candle itself when it is this strong.
    momentumBody: 0.6, // body ÷ range
    momentumClose: 0.75, // closing position (long: from the low)
    momentumRvol: 1.5, // same-time-of-day relative volume
    // Model B (retest): price comes back to the level and is rejected there.
    retestTolAtr: 0.25, // the retest low must come within this × ATR of ORH (long)
    holdTolAtr: 0.15, // a close more than this × ATR back inside the range = failed retest
    retestRejectClose: 0.5, // rejection candle closing position at least this
    retestMaxBars: 12, // the retest and its confirmation must come within N bars of the breakout
    reentryAfterFail: false, // after a failed breakout, that side stays off for the day
    maxExtensionAtr: 1.0, // entry more than this × ATR beyond the level = chasing (hard gate)
  },

  // ── Factor 1: opening range quality (15) ───────────────────────────────────
  range: {
    minProfile: 10, // earlier sessions needed for percentiles / time-of-day volume
    // Percentile of today's OR width among earlier sessions' (same duration). [below, label, points]
    percentileBands: [
      [10, "Extremely narrow", 1],
      [30, "Narrow", 4],
      [70, "Normal", 6],
      [90, "Wide", 3],
      [101, "Extremely wide", 0],
    ],
    // Until there is enough history: OR width ÷ 14-day daily ATR (worth less). [below, label, points]
    atrBands: [
      [0.15, "Extremely narrow", 1],
      [0.25, "Narrow", 3],
      [0.5, "Normal", 4],
      [0.8, "Wide", 2],
      [Infinity, "Extremely wide", 0],
    ],
    orVolPoints: [[1.2, 3], [0.8, 2], [0.5, 1]], // OR volume ÷ average OR volume (same duration)
    overheadClearOrw: 1.0, // no PDH / PDC (long) within this × ORW beyond the level = 3 points
    overheadTightOrw: 0.5, // closer than this = 0 points
    balancedFormation: 0.5, // |OR close − OR open| ÷ ORW at or below = two-sided (best)
    directionalFormation: 0.7,
  },

  // ── Factor 2: market regime and opening sentiment (15) ─────────────────────
  market: {
    momentumBars: 3,
    gapFlatPct: 0.3, // |gap| below this = flat open
    gapAlignedMaxAtr: 1.0, // a gap in the breakout direction up to this × daily ATR = 3 points
    vixCalm: 20, // India VIX at or below, and not up more than vixSpikePct on the day = 1 point
    vixSpikePct: 10,
    breadthStrong: 1.2,
    breadthFair: 0.8,
    breadthMinCoverage: 0.8,
    strongDayPct: 1.0, // NIFTY |day %| beyond this with direction = "strong directional momentum"
  },

  // ── Factor 3: relative volume (15) ─────────────────────────────────────────
  volume: {
    // Relative volume = this bar's volume ÷ the average volume of the bar at the same time of day
    // over earlier sessions. Classification: [below, label].
    classes: [[0.7, "Weak"], [1.0, "Below average"], [1.3, "Normal"], [1.5, "Good"], [2.0, "Strong"], [Infinity, "Exceptional"]],
    breakoutPoints: [[2.0, 6], [1.5, 5], [1.3, 4], [1.0, 3], [0.7, 2]], // [at or above, points]
    substituteMax: 4, // relative volume vs the session's earlier bars (no history yet) is worth at most this
    fallbackBars: 20,
    minRvol: 0.8, // hard gate: breakout candle relative volume below this
    expansionPoints: [[1.5, 3], [1.1, 2], [0.8, 1]], // breakout RVOL ÷ mean RVOL of the 3 bars before
    retestQuiet: 0.8, // retest volume at or below this RVOL = constructive (3 points)
    retestHeavy: 1.2,
    followMin: 0.8, // continuation bars should keep RVOL ≥ this
  },

  // ── Factor 4: breakout candle strength (15) ────────────────────────────────
  candle: {
    bodyPoints: [[0.6, 4], [0.45, 3], [0.3, 1]],
    closePoints: [[0.8, 4], [0.65, 3], [0.5, 1]],
    wickPoints: [[0.15, 3], [0.3, 2], [0.45, 1]], // rejection wick ÷ range, at or below
    sizeGoodAtr: [0.7, 2.0], // candle range in ATR: inside = 2 points
    sizeOkAtr: [0.4, 3.0], // inside = 1 point; outside both = feeble or climactic
    clearGoodAtr: [0.1, 0.6], // breakout distance (close beyond the level) in ATR: inside = 2 points
  },

  // ── Factor 6: VWAP and momentum (10) ───────────────────────────────────────
  momentum: {
    vwapNearAtr: 1.5, // distance from VWAP: within = +2, within vwapFarAtr = +1, beyond = 0 (extended)
    vwapFarAtr: 2.5,
    slopeBars: 6,
    slopeFlat: 0.04, // ATRs per bar
    adxPeriod: 14,
    adxTrend: 20,
  },

  // ── Factor 7: relative strength and liquidity (5) ──────────────────────────
  liquidity: {
    rsStrongPct: 0.3, // stock − NIFTY return since the open, in the trade's favour
    valuePerMin: 1_000_000, // ₹ traded per minute (last 20 bars) for the liquidity point
    minValuePerMin: 50_000, // hard gate
    minDailyValue: 5e7, // hard gate: 20-day average daily traded value (₹5 crore)
    maxParticipation: 0.1, // hard gate: our qty ÷ average bar volume
    spreadGood: 0.1, // live spread % for the spread point
    maxSpreadPct: 0.25, // hard gate (live)
    circuitBufferPct: 1.5, // hard gate (live)
  },

  // ── Factor 8: risk-reward and volatility (10) ──────────────────────────────
  risk: {
    capital: 200_000, // used when no account is given (0.5% of it = ₹1,000, the lab's default risk)
    riskPct: 0.5,
    minRiskPct: 0.25,
    maxRiskPct: 0.5,
    maxDailyLossPct: 1,
    maxTradesPerDay: 3,
    leverage: 5,
    minNetRR: 1.5, // hard gate, to the primary target, after charges and slippage
    netRRPoints: [[3, 5], [2.5, 4], [2, 3], [1.5, 2]],
    roomPoints: [[3, 3], [2, 2], [1, 1]], // room left in the typical daily range, in R
    stopAtrGood: [0.5, 2.0],
    stopAtrOk: [0.3, 3.0],
    stopBufferAtr: 0.1, // stop = structure ∓ max(this × ATR, 2 ticks)
    stopMinTicks: 2,
    minStopAtr: 0.3, // a structural stop closer than this × ATR is widened to it (noise floor)
    maxConsumed: 1.0, // hard gate: today's range ≥ this × the 14-day daily ATR = move already spent
  },

  // ── Targets ────────────────────────────────────────────────────────────────
  targets: {
    // A: range projection (entry ± 1 and 2 × ORW) · B: volatility cap (the day's low + one typical
    // daily range for a long) · C: structure (PDH / PDL / PDC / pivots) — the nearest wins.
    volCapAtr: 1.0, // the volatility cap is this × the 14-day daily ATR from the day's extreme
    minGapAtr: 0.25, // ignore structure levels closer than this × ATR to the entry
    t3MinAdx: 25, // T3 only with a trending tape (ADX) or a momentum entry
  },

  // ── Time, news and session (mandatory filter, not scored) ─────────────────
  session: {
    // The entry window is the strategy's entryEnd (Lab param): breakouts after it are skipped.
    speedAtrPerBar: 0.5, // assumed travel toward T1, in ATRs per bar
    timeSafety: 1.5, // bars left to 15:15 must be ≥ this × the bars T1 is expected to need
    shockBars: 6,
    shockAtr: 3.5,
    gapBlockPct: 3,
    gapCautionPct: 1.5,
    staleBars: 2, // live: the last completed bar older than this many bars = stale data
    gapBarsMax: 2, // a hole of more than this many missing bars in today's candles = incomplete data
  },

  events: EVENTS,
};
