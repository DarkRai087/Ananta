// Regime arbiter (spec §12). Labels a stock-day NARROW / NORMAL / WIDE by CPR width, then resolves
// OPPOSITE live signals on the same stock: NARROW favours continuation (PDH/PDL, Volume Breakout),
// WIDE favours mean-reversion (CPR Reversal). The regime-favoured signal is kept; the other is tagged
// `suppressedBy` and `s.suppressed` so the UI can show it was stood down (not silently dropped).
// NORMAL suppresses nothing. Pure — shares regimeOf with the CPR strategy, no duplicate width math.
import { regimeOf } from "../strategies/cprReversalV2.js";

const CONTINUATION = ["pdhPdl", "pdhPdlV2", "pdhPdlFade", "volumeBreakout", "volumeBreakoutV2"];
const REVERSAL = ["cprReversal", "cprReversalV2", "camarilla", "narrowCpr"];
const FAVOUR = { NARROW: { prefer: CONTINUATION, over: REVERSAL }, WIDE: { prefer: REVERSAL, over: CONTINUATION } };

const REGIME_PARAMS = { widePct: 0.6, narrowPct: 0.3, regimeMinDays: 10 };
export const cprRegime = (todayWidth, dailyBars) => regimeOf(todayWidth, dailyBars, REGIME_PARAMS);

const LIVE = new Set(["in_trade", "signal", "armed"]);
const TREND_FAMILY = ["supertrend", "supertrendV2", "emaCross"];
const GAP_GO = ["gapAndGo", "gapAndGoV2"];
const PDH = ["pdhPdl", "pdhPdlV2", "pdhPdlFade"];
const CPR_FADE = ["cprReversal", "cprReversalV2", "camarilla", "narrowCpr"];

// A GAP day: |open − prevClose| ≥ minGapAtr daily ATR. side = the gap direction.
export function gapLabel(open, prevClose, atrDaily, minGapAtr = 0.5) {
  if (open == null || prevClose == null || !(atrDaily > 0)) return { gap: false, side: null, gapAtr: null };
  const gapAtr = (open - prevClose) / atrDaily;
  if (Math.abs(gapAtr) < minGapAtr) return { gap: false, side: null, gapAtr };
  return { gap: true, side: gapAtr > 0 ? "long" : "short", gapAtr };
}

/**
 * Spec §12: on a GAP day route it to Gap and Go. When a gapAndGo* plan is live in the gap direction,
 * stand down (a) PDH/PDL* signals on the SAME side (duplicate gap route) and (b) CPR-family fades on
 * the OPPOSITE side (fading an active gap-and-go). Mutates losers; returns the conflicts added.
 */
export function markGapRouting(strategies, gap) {
  const conflicts = [];
  if (!gap?.gap) return conflicts;
  const live = strategies.filter((s) => LIVE.has(s.status) && sideOf(s));
  const go = live.find((s) => GAP_GO.includes(s.id) && sideOf(s) === gap.side);
  if (!go) return conflicts;
  for (const s of live) {
    if (s === go || s.suppressed) continue;
    const dupPdh = PDH.includes(s.id) && sideOf(s) === gap.side;
    const fadeCpr = CPR_FADE.includes(s.id) && sideOf(s) !== gap.side;
    if (dupPdh || fadeCpr) {
      s.suppressed = { by: go.id, regime: "GAP" };
      for (const setup of s.setups || []) setup.suppressedBy = go.id;
      conflicts.push({ kept: go.id, suppressed: s.id, keptSide: gap.side, regime: "GAP" });
    }
  }
  return conflicts;
}

// The one side a plan is proposing right now, or null (no live signal, or two-way = ambiguous).
export function sideOf(s) {
  if (s.position) return s.position.side;
  const sides = new Set((s.setups || []).filter((x) => !x.invalid && !x.blocked).map((x) => x.side));
  return sides.size === 1 ? [...sides][0] : null;
}

// TREND family (Supertrend, Supertrend v2, 9/21 EMA): same stock + same direction = one combined
// signal, not double risk. Keeps the first live one, tags the rest duplicateOf (same convention as
// the price dedupe). Returns the number collapsed.
export function markTrendFamily(strategies) {
  const live = strategies.filter((s) => LIVE.has(s.status) && TREND_FAMILY.includes(s.id) && sideOf(s));
  let collapsed = 0;
  for (const side of ["long", "short"]) {
    const same = live.filter((s) => sideOf(s) === side);
    for (let i = 1; i < same.length; i++) {
      same[i].trendDuplicateOf = same[0].id;
      for (const setup of same[i].setups || []) setup.duplicateOf = setup.duplicateOf ?? same[0].id;
      collapsed++;
    }
  }
  return collapsed;
}

/**
 * Mark opposite-signal conflicts under `regimeTag`. Mutates the losing plan (s.suppressed + each
 * setup.suppressedBy) and returns { regime, conflicts: [{ kept, suppressed, keptSide }] }.
 */
export function markRegimeConflicts(strategies, regimeTag) {
  const fav = FAVOUR[regimeTag];
  const conflicts = [];
  if (!fav) return { regime: regimeTag, conflicts };
  const live = strategies.filter((s) => LIVE.has(s.status) && sideOf(s));
  for (const win of live) {
    if (!fav.prefer.includes(win.id)) continue;
    for (const lose of live) {
      if (!fav.over.includes(lose.id) || lose.suppressed) continue;
      if (sideOf(win) === sideOf(lose)) continue; // only OPPOSITE sides conflict
      lose.suppressed = { by: win.id, regime: regimeTag };
      for (const setup of lose.setups || []) setup.suppressedBy = win.id;
      conflicts.push({ kept: win.id, suppressed: lose.id, keptSide: sideOf(win), regime: regimeTag });
    }
  }
  return { regime: regimeTag, conflicts };
}
