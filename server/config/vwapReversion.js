// VWAP σ-Band Mean Reversion: the eight-factor decision engine (server/vwapReversion/).
//
// Every number the engine uses is here. The backtest (strategies/vwapBands.js), the trade-plan
// row and the decision report all read these values, so one change applies everywhere.
//
// Scores measure SETUP QUALITY, not the chance of a win. Missing data scores 0: it is listed
// in the report and never counts as confirmation.
import { EVENTS } from "./events.js";

export const VWAP_REVERSION = {
  // ── Final classification (section 3 of the spec) ──────────────────────────
  classes: [
    { min: 85, id: "high", label: "High quality", action: "ELIGIBLE FOR EXECUTION" },
    { min: 75, id: "qualified", label: "Qualified", action: "WAIT FOR CONFIRMATION" },
    { min: 65, id: "moderate", label: "Moderate", action: "WATCHLIST" },
    { min: 50, id: "weak", label: "Weak", action: "NO TRADE" },
    { min: 0, id: "poor", label: "Poor", action: "NO TRADE" },
  ],
  executeAt: 85, // LONG / SHORT needs at least this (strategy param minScore overrides it)
  watchAt: 65, // WATCHLIST needs at least this

  // ── The setup itself ───────────────────────────────────────────────────────
  setup: {
    band: 2, // the stretch band, in σ (volume-weighted σ of typical price around session VWAP)
    minBars: 6, // bands are ignored for the first N bars of the session (σ is noise until then)
    lookback: 8, // bars back to look for the band test (the rejection candle)
    maxBarsToConfirm: 6, // the trigger must come within N bars of the rejection candle, else stale
  },

  // ── Factor 1: market regime (20) ───────────────────────────────────────────
  regime: {
    adxPeriod: 14,
    // Trend strength (6): ADX(14) when it is ready. Each row: [ADX at or below, points].
    adxPoints: [[18, 6], [22, 5], [26, 3], [30, 1]],
    // Until ADX is ready (2 × 14 bars after 09:15), the efficiency ratio stands in, worth less.
    erBars: 12,
    erPoints: [[0.2, 4], [0.3, 3], [0.45, 1]],
    // +DI / −DI balance (3): |+DI − −DI| at or below this = balanced.
    diBalanced: 5,
    diAgainstMax: 12, // pressure against the trade above this = 0 points
    // VWAP slope (4): VWAP change over slopeBars, in ATRs per bar.
    slopeBars: 6,
    slopeFlat: 0.04,
    slopeSteep: 0.1,
    // EMA 20 / 50 structure (3). Gap in ATRs.
    emaFast: 20,
    emaSlow: 50,
    emaFlatGap: 0.5,
    emaAgainstMax: 1.5,
    ema20SlopeBars: 5,
    ema20FlatSlope: 0.05,
    // Swing structure (2): fractal swing points, `swingSide` bars on each side.
    swingSide: 2,
    // Volatility (2): ATR now vs volBars ago.
    volBars: 6,
    volStable: 1.1,
    volExpanding: 1.3,
    // Hard gate: never fade a strong trend that is riding the outer band.
    strongAdx: 30,
    strongEr: 0.55,
    ridingBars: 6, // look at the last N closes…
    ridingMin: 3, // …N or more of them beyond the ±2σ band on the trend side = riding the band
  },

  // ── Factor 2: VWAP and standard deviation (15) ─────────────────────────────
  deviation: {
    // Depth of the stretch at its extreme (5). Rows: [|z| below, points]. Deeper is NOT
    // always better: beyond 3.5σ it is more often repricing (news) than a stretch.
    depthPoints: [[2.5, 3], [3.0, 5], [3.5, 4], [Infinity, 2]],
    minBandAtr: 1.0, // the 2σ distance must be at least this many ATRs, else the "stretch" is one bar of noise (depth = 0)
    // Closes beyond the band in this excursion (4). Rows: [closes at or below, points].
    durationPoints: [[1, 4], [2, 3], [4, 1]],
    trendDayCloses: 8, // this many closes beyond the band on the same side today = trend day, 0 points
    sigmaBars: 6, // σ expansion: σ now ÷ σ N bars ago
    sigmaStable: 1.1,
    sigmaExpanding: 1.25,
    // Room left to VWAP at the expected entry, in σ (3). Rows: [|z| at or above, points].
    roomPoints: [[1.5, 3], [1.0, 2], [0.6, 1]],
  },

  // ── Factor 3: price action and reversal confirmation (20) ─────────────────
  priceAction: {
    strongWick: 0.5, // rejection wick ÷ range
    fairWick: 0.33,
    strongClose: 0.6, // close position in the range (long: from the low; short: from the high)
    fairClose: 0.4,
    confirmBody: 0.5, // trigger candle body ÷ range for full points
  },

  // ── Factor 4: volume and order flow (15) ──────────────────────────────────
  volume: {
    avgBars: 20, // relative volume = volume ÷ average of the previous 20 candles
    minAvgBars: 5, // fewer earlier bars than this = relative volume unavailable
    climaxRvol: 1.5,
    normalRvol: 0.8,
    confirmRvol: 1.2,
    weakRvol: 0.5,
    pressureStrong: 0.3, // volume-weighted close position since the rejection, in [−1, 1]
    pressureFair: 0.1,
    fadeBars: 3, // volume of the last N bars into the extreme vs the N before
    fadeDry: 0.8,
    fadeRising: 1.2,
    bookStrong: 1.2, // live order book: total buy qty ÷ total sell qty (long; inverse for short)
    bookFair: 0.9,
  },

  // ── Factor 5: market and sector (10) ──────────────────────────────────────
  market: {
    momentumBars: 3, // index "turning" = its return over the last N bars
    rsBars: 3, // stock vs index return over the last N bars (relative strength now)
    divergencePct: 1, // |stock day % − index day %| above this is called a divergence
    breadthStrong: 1.2, // NIFTY 50 advances ÷ declines (long; inverse for short)
    breadthFair: 0.8,
    breadthMinCoverage: 0.8, // share of NIFTY 50 members with a live quote, else breadth unavailable
  },

  // ── Factor 6: liquidity and execution (10) ────────────────────────────────
  liquidity: {
    valueBars: 20, // traded value averaged over the last N bars
    valuePerMinPoints: [[1_000_000, 3], [200_000, 2], [50_000, 1]], // ₹ traded per minute
    minValuePerMin: 50_000, // hard gate
    minDailyValue: 5e7, // hard gate: 20-day average daily traded value (₹5 crore)
    participationPoints: [[0.01, 2], [0.05, 1]], // our qty ÷ average bar volume
    maxParticipation: 0.1, // hard gate
    costDragPoints: [[0.1, 2], [0.25, 1]], // charges + slippage ÷ gross reward at target 2
    spreadPoints: [[0.05, 2], [0.1, 1]], // live bid-ask spread, % of mid
    maxSpreadPct: 0.25, // hard gate (live only)
    depthCover: 3, // top-5 depth on the side we trade into ≥ N × our qty = +1 point
    circuitBufferPct: 1.5, // hard gate: price within this % of a circuit limit
    quoteMaxAgeSec: 120, // an older live quote is treated as unavailable
  },

  // ── Factor 7: risk-reward and position sizing (10) ────────────────────────
  risk: {
    capital: 200_000, // used when no account is given (0.5% of it = ₹1,000, the lab's default risk)
    riskPct: 0.5, // % of capital lost at the stop, charges and stop slippage included
    minRiskPct: 0.25, // the spec's range is 0.25–0.5%: a larger account setting is capped at maxRiskPct
    maxRiskPct: 0.5,
    maxDailyLossPct: 1,
    maxTradesPerDay: 3,
    minNetRR: 1.5, // hard gate, net of every charge and slippage, to target 2
    netRRPoints: [[3, 6], [2.5, 5], [2, 4], [1.5, 2]],
    stopAtrGood: [0.5, 2.0], // stop distance in ATRs: inside = 2 points
    stopAtrOk: [0.3, 3.0], // inside = 1 point
    stopAtrBuffer: 0.2, // stop = rejection swing ± this × ATR (the volatility buffer)…
    stopMinTicks: 2, // …and at least this many ticks
    leverage: 5, // max position = capital × leverage when no account is given
  },

  // ── Targets ───────────────────────────────────────────────────────────────
  targets: {
    // T1 = the ∓1σ band (or halfway to VWAP if the entry is already past it), T2 = VWAP,
    // T3 = the opposite ±1σ band, shown only when the regime is balanced and time allows.
    t3MinRegime: 15, // regime score needed for T3
    minT1R: 0.5, // T1 must be at least this many R from the entry, else halfway to VWAP is used
  },

  // ── Factor 8: time, news and session (mandatory filter, not scored) ────────
  session: {
    // The entry window is the strategy's entryStart / entryEnd (Lab params): 10:00–14:30 by
    // default, which keeps out the opening volatility and the closing auction run-up.
    lunch: ["12:30", "13:30"], // thin liquidity: a caution, not a block
    reversionAtrPerBar: 0.35, // assumed net speed back to VWAP, in ATRs per bar
    timeSafety: 1.5, // bars left to 15:15 must be ≥ this × the bars VWAP is expected to need
    shockBars: 6, // a bar in the last N with range ≥ shockAtr × ATR = sudden news-like move
    shockAtr: 3.5,
    abnormalDayAtr: 2.0, // today's range ≥ this × the 14-day daily ATR = abnormal day
    gapBlockPct: 3, // |opening gap| at or above this = news-driven open, no trades
    gapCautionPct: 1.5,
  },

  // Scheduled events: config/events.js (shared with the ORB engine).
  events: EVENTS,

};
