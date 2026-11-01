import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px } from "./planKit.js";
import { roundTick, tickFor } from "../decision/util.js";
import { OPEN_MIN } from "../lab/time.js";

// Volume Breakout v2. Everything v1 lacked, each filter toggleable (all on by default; the PHASE 3
// ablation turns them off one at a time). Signals on CLOSED bars only; the shared engine fills at
// the next bar's open and applies costs, slippage and sizing. v1 stays as `volumeBreakout`.
//
//  • RVOL = closed-bar volume ÷ the same 5-min slot's average over the last N sessions (ctx.ref.profile),
//    not a trailing bar-count average — the one real signal bug from the audit.
//  • Breakout levels are typed (PDH/PDL, opening range, multi-day consolidation, VWAP reclaim) and
//    scored; the trade's reason carries "level=TYPE score=.." so the report can stat by level type.
//  • 52-week level and live ASM/GSM / delivery data are out (need a data path / paid-ish source).

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// Session ATR on the chart interval; the yardstick for buffers, bodies and stop distances.
const atrOf = (ctx) => ctx.ind("atr", [ctx.params.atrPeriod]) ?? null;

// Same-slot relative volume from prior sessions' profiles: curVol ÷ the average volume at this IST
// slot over the last `days` sessions (causal — profiles are earlier sessions only). Pure, exported
// for the RVOL time-slot unit test.
export function rvolFromProfile(profiles, slot, curVol, days) {
  const vols = profiles.slice(-days).map((pr) => pr.vol[slot]).filter((v) => v != null);
  const avg = vols.length ? mean(vols) : null;
  return avg > 0 ? { rvol: curVol / avg, n: vols.length } : { rvol: null, n: vols.length };
}
const rvolOf = (ctx, days) => rvolFromProfile(ctx.ref.profile, ctx.minute(), ctx.bar().volume || 0, days);

// Contraction: the current ATR sits below its own recent average (a coiled range before the break).
function contracted(ctx, maxRatio, bars = 20) {
  const now = atrOf(ctx);
  if (now == null) return { pass: false, ratio: null };
  const xs = [];
  for (let k = 0; k < bars; k++) {
    const v = ctx.ind("atr", [ctx.params.atrPeriod], k);
    if (v != null) xs.push(v);
  }
  if (!xs.length) return { pass: false, ratio: null };
  const ratio = now / mean(xs);
  return { pass: ratio < maxRatio, ratio };
}

// Candidate breakout levels on `side`, each { type, price, range } (range = measured-move height).
function levelsFor(ctx, side, p, atr) {
  const long = side === "long";
  const out = [];
  if (p.usePdLevels && ctx.ref.pdh != null && ctx.ref.pdl != null) {
    out.push({ type: "PDH_PDL", price: long ? ctx.ref.pdh : ctx.ref.pdl, range: ctx.ref.pdh - ctx.ref.pdl, touches: 1 });
  }
  if (p.useOpeningRange) {
    const or = ctx.openingRange(p.orMinutes);
    if (or) out.push({ type: "OR", price: long ? or.high : or.low, range: or.high - or.low, touches: 1 });
  }
  if (p.useConsolidation) {
    const daily = ctx.ref.daily.slice(-p.consolDays);
    if (daily.length >= p.consolDays) {
      const hi = Math.max(...daily.map((d) => d.high));
      const lo = Math.min(...daily.map((d) => d.low));
      const range = hi - lo;
      // Touches: days whose extreme sits within 15% of the range from the edge being broken.
      const tol = range * 0.15;
      const touches = long ? daily.filter((d) => hi - d.high <= tol).length : daily.filter((d) => d.low - lo <= tol).length;
      if (touches >= p.consolMinTouches) out.push({ type: "CONSOL", price: long ? hi : lo, range, touches });
    }
  }
  if (p.useVwapReclaim && atr) {
    const v = ctx.ind("vwap");
    const vPrev = ctx.ind("vwap", [], 1);
    const cPrev = ctx.bar(ctx.i - 1)?.close;
    // A reclaim: the previous bar was on the far side of VWAP, so this close crosses back through it.
    if (v != null && vPrev != null && cPrev != null && (long ? cPrev < vPrev : cPrev > vPrev)) {
      out.push({ type: "VWAP", price: v, range: 2 * atr, touches: 1 });
    }
  }
  return out;
}

// Level score: more touches and a tighter prior range (range ÷ ATR) score higher.
export const scoreLevel = (lvl, atr) => lvl.touches + (atr > 0 ? 1 / Math.max(lvl.range / atr, 0.25) : 0);

// Breakout-candle quality for `side` at the current bar.
function candleOk(ctx, side, p, atr) {
  if (!p.useCandleQuality) return true;
  const c = ctx.bar();
  const range = c.high - c.low;
  if (range <= 0 || atr == null) return false;
  const body = Math.abs(c.close - c.open);
  if (body < p.minBodyAtr * atr) return false;
  const loc = (c.close - c.low) / range; // 1 = closed at the high
  if (side === "long") {
    if (loc < 1 - p.closeLocation) return false; // not in the top closeLocation of the range
    if (p.rejectWick && c.high - Math.max(c.open, c.close) > body) return false; // upper wick > body = selling into it
  } else {
    if (loc > p.closeLocation) return false;
    if (p.rejectWick && Math.min(c.open, c.close) - c.low > body) return false;
  }
  return true;
}

// Context filters (NIFTY vs its VWAP, relative strength, optional sector). Degrade to pass when the
// index isn't attached, so an offline backtest still runs. Returns { pass, notes[] }.
function contextOk(ctx, side, p) {
  const long = side === "long";
  const notes = [];
  if (p.useMarketVwap) {
    const m = ctx.market("nifty");
    if (m && m.vwap != null) {
      if (long ? !(m.close > m.vwap) : !(m.close < m.vwap)) return { pass: false, notes };
      notes.push(`NIFTY ${m.close > m.vwap ? ">" : "<"}VWAP`);
    }
  }
  if (p.useRelStrength) {
    const m = ctx.market("nifty");
    const open = ctx.ref.open;
    if (m && open) {
      const stock = (ctx.bar().close - open) / open;
      const idx = (m.close - m.dayOpen) / m.dayOpen;
      if (long ? !(stock > idx) : !(stock < idx)) return { pass: false, notes };
      notes.push("RS✓");
    }
  }
  if (p.useSector) {
    const s = ctx.market("sector");
    if (s && s.vwap != null) {
      if (long ? !(s.close > s.vwap) : !(s.close < s.vwap)) return { pass: false, notes };
      notes.push("sector✓");
    }
  }
  return { pass: true, notes };
}

// Stop for a long: tighter of the breakout-candle low and (level − x·ATR), floored to a min ATR
// distance from the entry proxy, rounded DOWN to the tick (UP, for a short).
export function stopFor(side, level, bar, atr, p) {
  const tk = tickFor(bar.close);
  if (side === "long") {
    let stop = Math.max(bar.low, level - p.stopAtrMult * atr); // tighter = closer to price = higher
    if (bar.close - stop < p.minStopAtr * atr) stop = bar.close - p.minStopAtr * atr;
    return roundTick(stop, tk, "down");
  }
  let stop = Math.min(bar.high, level + p.stopAtrMult * atr);
  if (stop - bar.close < p.minStopAtr * atr) stop = bar.close + p.minStopAtr * atr;
  return roundTick(stop, tk, "up");
}

export const measuredTarget = (side, level, range) => (side === "long" ? level + range : level - range);

// The best breakout on `side` right now, or null. Checks RVOL/contraction/quality/context, then the
// highest-scored level the close clears by the ATR buffer.
function signalFor(ctx, side, p, atr, rvol) {
  if (side === "long" ? !p.allowLong : !p.allowShort) return null;
  if (!candleOk(ctx, side, p, atr)) return null;
  const cx = contextOk(ctx, side, p);
  if (!cx.pass) return null;
  const c = ctx.bar();
  const buf = p.atrBuffer * atr;
  const broken = levelsFor(ctx, side, p, atr)
    .filter((l) => (side === "long" ? c.close > l.price + buf : c.close < l.price - buf))
    .map((l) => ({ ...l, score: scoreLevel(l, atr) }))
    .sort((a, b) => b.score - a.score);
  if (!broken.length) return null;
  const lvl = broken[0];
  const stop = stopFor(side, lvl.price, c, atr, p);
  if (stop == null || (side === "long" ? stop >= c.close : stop <= c.close)) return null;
  const target = roundTick(measuredTarget(side, lvl.price, lvl.range), tickFor(c.close), side === "long" ? "down" : "up");
  return {
    side,
    stop,
    target,
    level: lvl,
    reason: `RVOL ${rvol.rvol.toFixed(1)}× ${side === "long" ? "up" : "down"}-break level=${lvl.type} score=${lvl.score.toFixed(1)}${cx.notes.length ? ` ${cx.notes.join(" ")}` : ""}`,
  };
}

export default defineStrategy({
  id: "volumeBreakoutV2",
  levels: ["pdh", "pdl", "orHigh", "orLow", "vwap"],
  name: "Volume Breakout v2",
  description: "RVOL (same-slot vs 20 sessions) breakout of a typed, scored level (PDH/PDL, opening range, multi-day consolidation, VWAP reclaim), with contraction, candle-quality and NIFTY/relative-strength filters. Measured-move target, min-ATR stop, time stop. Indices have no volume, so no trades there.",
  defaultInterval: "5m",
  needsMarket: true, // NIFTY VWAP + relative-strength filters; they pass when the index isn't attached
  params: {
    // v2 uses its own target (measured move) → no R target by default; set targetR > 0 to switch.
    targetR: 0,
    // §1 RVOL
    rvolMult: 2.0, rvolDays: 20, skipOpenBars: 1,
    // §2 levels
    usePdLevels: true, useOpeningRange: true, orMinutes: 15, useConsolidation: true, consolDays: 5, consolMinTouches: 2, useVwapReclaim: true,
    // §3 contraction
    useContraction: true, contractionMaxRatio: 1.0,
    // §4 candle quality
    useCandleQuality: true, atrBuffer: 0.15, closeLocation: 0.3, minBodyAtr: 0.5, rejectWick: true,
    // §5 context
    useMarketVwap: true, useRelStrength: true, useSector: false,
    // §6 entry mode
    entryMode: "close", retestBars: 3,
    // §7 exits
    stopAtrMult: 1.0, minStopAtr: 0.5, timeStopBars: 6, timeStopMinR: 0.5,
    entryStart: "09:30", entryEnd: "14:45",
  },
  spec: [
    { key: "rvolMult", label: "Min RVOL (× slot avg)", type: "number", step: 0.1 },
    { key: "rvolDays", label: "RVOL lookback (sessions)", type: "number", step: 1 },
    { key: "skipOpenBars", label: "Skip first N bars", type: "number", step: 1 },
    { key: "usePdLevels", label: "Level: PDH / PDL", type: "bool" },
    { key: "useOpeningRange", label: "Level: opening range", type: "bool" },
    { key: "orMinutes", label: "Opening-range minutes", type: "number", step: 5 },
    { key: "useConsolidation", label: "Level: multi-day consolidation", type: "bool" },
    { key: "consolDays", label: "Consolidation days", type: "number", step: 1 },
    { key: "consolMinTouches", label: "Consolidation min touches", type: "number", step: 1 },
    { key: "useVwapReclaim", label: "Level: VWAP reclaim", type: "bool" },
    { key: "useContraction", label: "Filter: prior contraction", type: "bool" },
    { key: "contractionMaxRatio", label: "Max ATR ÷ avg ATR", type: "number", step: 0.1 },
    { key: "useCandleQuality", label: "Filter: breakout-candle quality", type: "bool" },
    { key: "atrBuffer", label: "Buffer beyond level (× ATR)", type: "number", step: 0.05 },
    { key: "closeLocation", label: "Close in top/bottom fraction", type: "number", step: 0.05 },
    { key: "minBodyAtr", label: "Min body (× ATR)", type: "number", step: 0.1 },
    { key: "rejectWick", label: "Reject wick > body", type: "bool" },
    { key: "useMarketVwap", label: "Filter: NIFTY vs VWAP", type: "bool" },
    { key: "useRelStrength", label: "Filter: relative strength vs NIFTY", type: "bool" },
    { key: "useSector", label: "Filter: sector index agrees", type: "bool" },
    { key: "entryMode", label: "Entry mode", type: "select", options: ["close", "retest"] },
    { key: "retestBars", label: "Retest wait (bars)", type: "number", step: 1 },
    { key: "stopAtrMult", label: "Stop: level − N × ATR", type: "number", step: 0.1 },
    { key: "minStopAtr", label: "Min stop distance (× ATR)", type: "number", step: 0.1 },
    { key: "timeStopBars", label: "Time stop after N bars", type: "number", step: 1 },
    { key: "timeStopMinR", label: "Time stop needs ≥ R", type: "number", step: 0.1 },
  ],
  // Loosened only for the random-data lookahead/leak tests, so the entry path actually runs.
  testParams: { rvolMult: 1.0, useContraction: false, useCandleQuality: false, useMarketVwap: false, useRelStrength: false, useSector: false, consolMinTouches: 1 },
  warmup: (p) => p.skipOpenBars + 1,
  onBar(ctx) {
    const p = ctx.params;
    const atr = atrOf(ctx);

    // In a position: the only strategy-side exit is the time stop (no +minR within N bars).
    if (ctx.position) {
      const pos = ctx.position;
      if (ctx.state.heldIndex !== pos.entryIndex) {
        ctx.state.heldIndex = pos.entryIndex;
        ctx.state.entryRisk = Math.abs(pos.entry - pos.stop);
      }
      if (p.timeStopBars > 0 && ctx.state.entryRisk > 0) {
        const held = ctx.i - pos.entryIndex;
        const favR = (pos.side === "long" ? ctx.bar().close - pos.entry : pos.entry - ctx.bar().close) / ctx.state.entryRisk;
        if (held >= p.timeStopBars && favR < p.timeStopMinR) return { exit: true, reason: `No ${p.timeStopMinR}R in ${p.timeStopBars} bars` };
      }
      return null;
    }

    if (ctx.i < p.skipOpenBars || atr == null) return null;
    if (ctx.minute() < OPEN_MIN + p.skipOpenBars * ctx.intervalMin) return null;

    // "retest" mode: once armed by a breakout, wait up to retestBars for a pullback to the level
    // that holds, then enter. Stored in ctx.state (stable across bars within the session).
    const armed = ctx.state.armed;
    if (armed) {
      if (ctx.i - armed.bar > p.retestBars) {
        ctx.state.armed = null;
      } else {
        const c = ctx.bar();
        const touched = armed.side === "long" ? c.low <= armed.price : c.high >= armed.price;
        const held = armed.side === "long" ? c.close >= armed.price : c.close <= armed.price;
        if (touched && held) {
          ctx.state.armed = null;
          const stop = stopFor(armed.side, armed.price, c, atr, p);
          if (stop != null && (armed.side === "long" ? stop < c.close : stop > c.close)) {
            return { side: armed.side, stop, target: armed.target, reason: `${armed.reason} (retest)` };
          }
        }
        return null;
      }
    }

    const rvol = rvolOf(ctx, p.rvolDays);
    if (rvol.rvol == null || rvol.rvol < p.rvolMult) return null;
    if (p.useContraction && !contracted(ctx, p.contractionMaxRatio).pass) return null;

    for (const side of ["long", "short"]) {
      const sig = signalFor(ctx, side, p, atr, rvol);
      if (!sig) continue;
      if (p.entryMode === "retest") {
        ctx.state.armed = { side, price: sig.level.price, target: sig.target, bar: ctx.i, reason: sig.reason };
        return null;
      }
      return sig;
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const last = ctx.ref.daily[ctx.ref.daily.length - 1];
    if (last && !(last.volume > 0)) return off("No volume data (indices have none) — this strategy can't trade it.");
    const atr = atrOf(ctx);
    if (ctx.i < p.skipOpenBars || atr == null) return waiting("Warming up (ATR / opening bars).");
    const rvol = rvolOf(ctx, p.rvolDays);
    const rvolNote = rvol.rvol != null ? `RVOL ${rvol.rvol.toFixed(1)}× (need ${p.rvolMult}×, ${rvol.n}d)` : `RVOL n/a (${rvol.n}d history)`;
    const setups = [];
    for (const side of ["long", "short"]) {
      if (side === "long" ? !p.allowLong : !p.allowShort) continue;
      const lvls = levelsFor(ctx, side, p, atr).map((l) => ({ ...l, score: scoreLevel(l, atr) })).sort((a, b) => b.score - a.score);
      if (!lvls.length) continue;
      const l = lvls[0];
      const tk = tickFor(l.price);
      const trigger = roundTick(side === "long" ? l.price + p.atrBuffer * atr : l.price - p.atrBuffer * atr, tk, side === "long" ? "up" : "down");
      setups.push({ side, trigger, when: `${tf(ctx)} close beyond ${l.type} ${px(l.price)} with RVOL ≥ ${p.rvolMult}× (score ${l.score.toFixed(1)})`, stop: roundTick(side === "long" ? l.price - p.stopAtrMult * atr : l.price + p.stopAtrMult * atr, tk, side === "long" ? "down" : "up"), target: roundTick(measuredTarget(side, l.price, l.range), tk, side === "long" ? "down" : "up"), approx: true });
    }
    if (!setups.length) return waiting(`No levels yet. ${rvolNote}.`);
    return watch(setups, `${rvolNote}. Best level per side shown; measured-move target, ${p.stopAtrMult}×ATR/min-${p.minStopAtr}×ATR stop, time stop ${p.timeStopMinR}R/${p.timeStopBars} bars.`);
  },
});
