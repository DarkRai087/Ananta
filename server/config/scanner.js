// Pattern Scanner configuration. EVERY threshold the scanner uses lives here, so research
// can be re-tuned without touching detector or stats code. Ratios are fractions of a bar's
// range unless a name ends in Pct (percent of price) or the comment says otherwise.
//
// Geometry (shared language with the detectors):
//   body  = |close − open|
//   range = high − low
//   upper = high − max(open, close)      (upper wick)
//   lower = min(open, close) − low       (lower wick)
//   avgBody = mean body of the previous `avgBodyBars` bars
//   prior trend = close vs `trend.emaPeriod`-EMA AND slope of the last `trend.slopeBars` closes
export const SCANNER = {
  // ── What to scan ──────────────────────────────────────────────────────────
  timeframes: ["5m", "15m"], // scanned on the most recent COMPLETED candle of each
  defaultTimeframe: "5m",
  lookbackSessions: 90, // historical window for the "momentum %" stats
  minRangePct: 0.03, // ignore bars whose high−low is under this % of price (flat / illiquid print)

  // ── Prior-trend model ─────────────────────────────────────────────────────
  trend: {
    emaPeriod: 20, // close vs this session EMA
    slopeBars: 5, // sign of (close[r] − close[r − slopeBars]) over the last 5 closes
    requireEmaWhenReady: true, // once the EMA exists, close must also be on the trend's side
  },

  avgBodyBars: 10, // "mean body of last 10 bars"
  bodyFloorPct: 0.02, // wick-to-body tests floor the body at this × range (a doji's ~0 body
  //                     must not make "wick ≥ 2 × body" trivially true)

  // ── Single-candle patterns ────────────────────────────────────────────────
  hammer: { minLowerToBody: 2, maxUpperPct: 0.1, requireTrend: true }, // + prior downtrend
  shootingStar: { minUpperToBody: 2, maxLowerPct: 0.1, requireTrend: true }, // + prior uptrend
  // Inverted Hammer = Shooting-Star shape in a downtrend; Hanging Man = Hammer shape in an uptrend.
  marubozu: { minBodyPct: 0.9, minBodyToAvg: 1.5 }, // body ≥ 90% of range AND ≥ 1.5 × avgBody
  doji: { maxBodyPct: 0.1, excludeDragonflyGravestone: true },
  dragonflyDoji: { maxBodyPct: 0.1, minLowerPct: 0.6, maxUpperPct: 0.1 },
  gravestoneDoji: { maxBodyPct: 0.1, minUpperPct: 0.6, maxLowerPct: 0.1 },
  spinningTop: { minBodyPct: 0.1, maxBodyPct: 0.3 }, // body 10–30% of range, each wick > body

  // ── Two-candle patterns ───────────────────────────────────────────────────
  engulfing: { requireTrend: true }, // body fully covers the previous opposite-colour body
  insideBar: {
    maxBarsSinceMother: 6, // a close must break the mother bar's range within this many bars
    requireHarami: false, // true = the inside bar's BODY must sit inside the mother's body
  },
  piercing: { minPrevBodyToAvg: 1, requireTrend: true }, // prev bearish body ≥ 1 × avgBody
  darkCloud: { minPrevBodyToAvg: 1, requireTrend: true }, // mirror of piercing
  tweezer: { tolerancePct: 0.1, requireTrend: true }, // two equal lows/highs within 0.1% of price

  // ── Three-candle patterns (no gap required intraday) ──────────────────────
  star: { minFirstBodyToAvg: 1, maxMiddleBodyRatio: 0.3, minPenetration: 0.5, requireTrend: true },
  threeSoldiers: { maxWickPct: 0.25, requireTrend: false }, // small wick in the trend direction
  threeInside: { requireTrend: true },

  // ── Context tags ──────────────────────────────────────────────────────────
  levels: {
    orMinutes: 15, // opening range = 09:15–09:30 high/low
    tolerancePct: 0.15, // "at a level" when the signal close is within this % of a level
    roundStep: null, // round-number step in ₹; null = auto by price (see roundStepFor)
    roundTolerancePct: 0.1, // "at a round number" within this % of the nearest round price
  },
  volume: { lookback: 20, highMult: 1.5 }, // flag volume ≥ 1.5 × the 20-bar average
  // Time-of-day buckets for the scanner (IST, [start, end) minutes from HH:MM). Distinct from
  // the backtester's config/market.js buckets on purpose — the spec asks for these three.
  timeBuckets: [
    { id: "open", label: "09:15–10:00", start: "09:15", end: "10:00" },
    { id: "mid", label: "10:00–13:00", start: "10:00", end: "13:00" },
    { id: "late", label: "13:00–15:15", start: "13:00", end: "15:15" },
  ],

  // ── Historical stats ("momentum %") ───────────────────────────────────────
  stats: {
    horizons: [3, 6, 12], // bars measured forward from the entry (N)
    primaryHorizon: 6, // the horizon ranking and the headline line use
    barrier: {
      mode: "pct", // "pct" = fixed % move, "atr" = ATR multiple
      pct: 0.5, // +X / −X in percent of the entry price
      atrPeriod: 14, // session ATR used when mode = "atr"
      atrMult: 1, // X = atrMult × ATR / entry, as a fraction
      tieBreak: "adverse", // one bar touches both barriers → count the ADVERSE one (conservative)
    },
    minCount: 30, // n below this → "insufficient history" (no percentage shown)
    baselineSamplesPerSession: 12, // random same-direction bars per session for the baseline
    seed: 1337, // base RNG seed; per-session seed is derived from this + the date (look-ahead safe)
    confidence: 0.95, // Wilson interval confidence
  },

  // ── Output ────────────────────────────────────────────────────────────────
  // Results are written here as JSON so the Time Machine and the strategy panel can read them.
  output: { dir: "scanner/output", latest: "latest.json" }, // relative to the server/ folder
};
