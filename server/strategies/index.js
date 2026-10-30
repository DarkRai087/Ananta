import orb from "./orb.js";
import vwapPullback from "./vwapPullback.js";
import emaCross from "./emaCross.js";
import volumeBreakout from "./volumeBreakout.js";
import pdhPdl from "./pdhPdlBreakout.js";
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
  orb, vwapPullback, emaCross, volumeBreakout, pdhPdl, cprReversal, gapAndGo, gapFade, supertrend, meanReversion,
  orbFakeout, openHighLow, camarilla, narrowCpr, vwapBands, bbSqueeze, afternoonMomentum, nr7Orb, atrExhaustion,
];

export const STRATEGY_BY_ID = Object.fromEntries(STRATEGIES.map((s) => [s.id, s]));

export function getStrategy(id) {
  const s = STRATEGY_BY_ID[id];
  if (!s) throw new Error(`Unknown strategy "${id}"`);
  return s;
}

// Defaults + user overrides, coerced to the default's type.
export function resolveParams(strategy, overrides = {}) {
  const out = { ...strategy.params };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!(k in out) || v === undefined || v === null || v === "") continue;
    const d = out[k];
    if (typeof d === "number") out[k] = Number(v);
    else if (typeof d === "boolean") out[k] = v === true || v === "true";
    else out[k] = String(v);
  }
  return out;
}

export function strategyList() {
  return STRATEGIES.map((s) => ({ id: s.id, name: s.name, description: s.description, params: s.params, spec: s.spec }));
}
