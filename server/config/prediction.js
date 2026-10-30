// Prediction (bullish / bearish outlook) settings. Tune these as research moves on;
// models read their own params from `models` below (merged over each model's defaults).
export const PREDICTION = {
  // |score| below this = neutral (no call). Scores are in [-1, +1].
  neutralBand: 0.2,

  // A model "has an edge" only if its hit rate beats the baseline (always calling the more
  // common direction over the same days) by this many standard errors.
  significanceZ: 1.65,

  daily: {
    // Forward horizons in trading days.
    horizons: [
      { id: "1d", days: 1, label: "Next session" },
      { id: "5d", days: 5, label: "Next week" },
      { id: "20d", days: 20, label: "Next month" },
    ],
    evalDays: 750, // walk-forward test window (~3 years of daily bars)
    minCalls: 60, // fewer non-neutral calls → "not enough data"
  },

  intraday: {
    horizonLabel: "Rest of today",
    evalSessions: 120, // past sessions tested at the same time of day
    minCalls: 40,
    earliest: "09:20", // no intraday call before this (first bars are noise)
    latest: "15:15", // nothing left to predict after this
  },

  // Combined call = weighted average of model scores; 0 leaves a model out. Daily weights are
  // per horizon and set from known effects, NOT fitted to the test data (that would make the
  // test meaningless): short-term reversal is a 1–5 day effect, trend and momentum work over
  // weeks to months.
  ensemble: {
    daily: {
      "1d": { meanReversion: 1, trend: 0.5, indexTrend: 0.5 },
      "5d": { meanReversion: 0.5, momentum: 1, breakout: 1, trend: 0.5, indexTrend: 1 },
      "20d": { trend: 1, momentum: 1, breakout: 0.5, indexTrend: 1 },
    },
    intraday: { vwapTrend: 1, dayMomentum: 1, openingRange: 1, indexTrend: 1 },
  },

  // Per-model parameter overrides, e.g. trend: { fast: 20, slow: 50 }.
  models: {},
};
