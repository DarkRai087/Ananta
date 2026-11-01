import orb from "./orb.js";
import vwapPullback from "./vwapPullback.js";
import emaCross from "./emaCross.js";
import volumeBreakout from "./volumeBreakout.js";
import volumeBreakoutV2 from "./volumeBreakoutV2.js";
import pdhPdl from "./pdhPdlBreakout.js";
import pdhPdlV2 from "./pdhPdlV2.js";
import pdhPdlFade from "./pdhPdlFade.js";
import cprReversal from "./cprReversal.js";
import gapAndGo from "./gapAndGo.js";
import gapFade from "./gapFade.js";
import supertrend from "./supertrendTrend.js";
import meanReversion from "./meanReversion.js";
import orbFakeout from "./orbFakeout.js";
import openHighLow from "./openHighLow.js";
import camarilla from "./camarilla.js";
import narrowCpr from "./narrowCpr.js";
import vwapBands from "./vwapBands.js";
import bbSqueeze from "./bbSqueeze.js";
import afternoonMomentum from "./afternoonMomentum.js";
import nr7Orb from "./nr7Orb.js";
import atrExhaustion from "./atrExhaustion.js";

export const STRATEGIES = [
  orb, vwapPullback, emaCross, volumeBreakout, volumeBreakoutV2, pdhPdl, pdhPdlV2, pdhPdlFade, cprReversal, gapAndGo, gapFade, supertrend, meanReversion,
  orbFakeout, openHighLow, camarilla, narrowCpr, vwapBands, bbSqueeze, afternoonMomentum, nr7Orb, atrExhaustion,
];

// Benched 2026-11-01 after the OOS context audit (scripts/strategyAudit.js, NIFTY50 5m, OOS
// 2026-07→10): net-negative after costs in every adequate-sample context. Still registered, so
// the Lab and the research scripts can study them; only the Top 3 / scoreboard ranker skips
// them (RANKED_STRATEGIES). Re-audit after more backfill before clearing an id from here.
const BENCHED = new Set([
  "emaCross", "volumeBreakout", "volumeBreakoutV2", "pdhPdl", "pdhPdlV2", "pdhPdlFade", "cprReversal", "meanReversion",
  "orbFakeout", "openHighLow", "bbSqueeze", "nr7Orb", "atrExhaustion", "vwapPullback",
]);

// What the Top 3 and the scoreboard rank: the gated survivors, plus orb/vwapBands (whose
// decision engines scored 0 backtest trades at minScore 85, so the audit can't judge them —
// kept for live, not benched).
export const RANKED_STRATEGIES = STRATEGIES.filter((s) => !BENCHED.has(s.id));

export const STRATEGY_BY_ID = Object.fromEntries(STRATEGIES.map((s) => [s.id, s]));

// Strategies with a decision engine (a full live report).
export const DECISION_STRATEGIES = STRATEGIES.filter((s) => s.decision).map((s) => s.id);

export function getStrategy(id) {
  const s = STRATEGY_BY_ID[id];
  if (!s) throw new Error(`Unknown strategy "${id}"`);
  return s;
}

// Defaults + user overrides, coerced to the default's type (a number that isn't one keeps the default).
export function resolveParams(strategy, overrides = {}) {
  const out = { ...strategy.params };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!(k in out) || v === undefined || v === null || v === "") continue;
    const d = out[k];
    if (typeof d === "number") out[k] = Number.isFinite(Number(v)) ? Number(v) : d;
    else if (typeof d === "boolean") out[k] = v === true || v === "true";
    else out[k] = String(v);
  }
  return out;
}

export function strategyList() {
  return STRATEGIES.map((s) => ({ id: s.id, name: s.name, description: s.description, params: s.params, spec: s.spec, report: s.decision?.report ?? null }));
}
