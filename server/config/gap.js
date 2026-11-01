// Gap and Go v2 reference data that isn't in the candle feed. All optional — every map/list is
// empty by default and the strategy degrades gracefully (skips the check) when it has no data.
// Fill these from a free NSE source when a data path exists (see CHANGES_GAP_AND_GO.md "not implemented").
export const GAP = {
  // Corporate-action ex-dates per symbol: a gap on one of these is a price adjustment, not a real
  // gap — skip the day. "YYYY-MM-DD".
  exDates: {
    // RELIANCE: ["2026-08-14"],
  },

  // Stock-specific catalyst days (results, major news): a gap in the catalyst direction scores higher.
  catalysts: {
    // INFY: ["2026-07-16"],
  },

  // NSE price-band % per symbol (circuit limit). When set, v2 skips a gap with < circuitAtr ATR of
  // room to the band. No entry here = no band known = no check (spec §2).
  bandPct: {
    // Most NIFTY large-caps have no band / 20% — leave blank to skip the check.
  },

  // Symbols to exclude: non-EQ series (T2T/BE), non-MIS, or on ASM/GSM. v2 skips these entirely.
  exclude: new Set([]),

  // Per-stock × gap-bucket combos disabled after a negative out-of-sample read (spec §11). Key:
  // `${symbol}|${bucket}` e.g. "SBIN|LARGE". Left empty pending a trustworthy sample.
  disabledCombos: new Set([]),
};
