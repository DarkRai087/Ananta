// Numeric rules for every pattern detector. Ratios are fractions of the bar's range
// unless noted; *Pct values are percent of price.
export const PATTERNS = {
  minRangePct: 0.05, // ignore bars whose high-low is under 0.05% of price (no real move)
  trendBars: 3, // bars before the pattern used to judge the prior trend
  requireTrend: true, // reversal candles need a prior move against them

  engulfing: { minBodyRatio: 1.0 }, // current body ≥ previous body × ratio
  hammer: { maxBodyPct: 0.35, minLowerWickToBody: 2, maxUpperWickPct: 0.15 },
  invertedHammer: { maxBodyPct: 0.35, minUpperWickToBody: 2, maxLowerWickPct: 0.15 },
  shootingStar: { maxBodyPct: 0.35, minUpperWickToBody: 2, maxLowerWickPct: 0.15 },
  marubozu: { minBodyPct: 0.9, minRangePct: 0.2 },
  doji: { maxBodyPct: 0.1 },
  gravestone: { maxBodyPct: 0.1, maxLowerWickPct: 0.1, minUpperWickPct: 0.7 },
  dragonfly: { maxBodyPct: 0.1, maxUpperWickPct: 0.1, minLowerWickPct: 0.7 },
  star: { minFirstBodyPct: 0.5, maxMiddleBodyRatio: 0.3, minPenetration: 0.5 },
  insideBar: { minMotherRangePct: 0.1 },

  // Chart patterns use same-session zigzag swing points.
  zigzagPct: 0.3, // a swing is confirmed after a 0.3% reversal from the extreme
  doubleTop: { tolerancePct: 0.15, minBarsBetween: 3 },
  triangle: { flatTolerancePct: 0.1, minSlopePct: 0.1 },
  flag: { minPolePct: 0.8, maxPoleBars: 10, maxRetracePct: 50, minFlagBars: 2, maxFlagBars: 12 },
};
