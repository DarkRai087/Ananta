// Opening range, relative volume, and the breakout state machine — from bars 0..i only.
//
// LONG (SHORT is the mirror image). After the opening range completes:
//   breakout   the first completed candle that closes above ORH (+ buffer)
//   model C    momentum: that breakout candle itself is strong (big body, close near the high,
//              relative volume ≥ 1.5) → enter at the next open
//   model A    close + acceptance: the next candle(s) also close above ORH → enter at the next open
//   model B    retest: price comes back to ORH, holds it, prints a bullish rejection candle, and a
//              later candle closes above that candle's high → enter at the next open
//   failed     a close back inside the range (beyond a small tolerance) before any entry
//   chasing    an A / C entry more than 1 ATR beyond ORH is skipped; a later retest (B) can still qualify
//
// Every check at bar k uses only bars ≤ k (ATR and relative volume at k), so a trigger found at
// bar k is found again, unchanged, at every later bar — no duplicate or moving signals.
import { candleMetrics } from "../decision/candle.js";
import { PROFILE_OR_MINUTES } from "../lab/sessions.js";

// A failed or expired breakout outranks a side that never broke out: it is the news to report.
export const STATE_RANK = { triggered: 7, broken: 6, fired: 5, failed: 4, expired: 3, inside: 2, forming: 1 };

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// Opening range and how it compares with earlier sessions (ctx.ref.profile).
export function orStats(ctx, minutes, cfg) {
  const or = ctx.openingRange(minutes);
  if (!or) return null;
  const R = cfg.range;
  const c = or.completeIndex;
  const open = ctx.ref.open;
  const width = or.high - or.low;
  let vol = 0;
  for (let k = 0; k <= c; k++) vol += ctx.bar(k).volume || 0;
  const hist = PROFILE_OR_MINUTES.includes(Number(minutes)) ? ctx.ref.profile.map((p) => p.or?.[minutes]).filter((x) => x && x.open > 0) : [];
  const enough = hist.length >= R.minProfile;
  const pcts = hist.map((x) => (x.width / x.open) * 100);
  const widthPct = (width / open) * 100;
  const percentile = enough ? (pcts.filter((p) => p < widthPct).length / pcts.length) * 100 : null;
  const histVols = hist.map((x) => x.volume).filter((v) => v > 0);
  const avgVol = enough && histVols.length >= R.minProfile ? mean(histVols) : null;
  const orClose = ctx.bar(c).close;
  return {
    minutes: Number(minutes),
    high: or.high,
    low: or.low,
    mid: (or.high + or.low) / 2,
    width,
    widthPct,
    atrDaily: ctx.ref.atrDaily ?? null,
    atrRatio: ctx.ref.atrDaily ? width / ctx.ref.atrDaily : null,
    completeIndex: c,
    open,
    close: orClose,
    formation: width > 0 ? (orClose - open) / width : 0, // −1 … +1: where the OR drove
    volume: vol,
    avgVolume: avgVol,
    volRatio: avgVol > 0 && vol > 0 ? vol / avgVol : null,
    percentile,
    historyN: hist.length,
    medianWidthPct: enough ? [...pcts].sort((a, b) => a - b)[Math.floor(pcts.length / 2)] : null,
  };
}

/**
 * Relative volume of bar k: volume ÷ the average volume of the bar at the same time of day over
 * earlier sessions (ctx.ref.profile). Without enough history, volume ÷ the average of this
 * session's earlier bars, marked as a substitute. { value, expected, source, n } or null.
 */
export function makeRvol(ctx, cfg) {
  const V = cfg.volume;
  const need = cfg.range.minProfile;
  const sd = ctx.sd;
  // Once per session: bar k's value uses only bars ≤ k, and earlier sessions' profiles.
  const memo = sd.memo(`rvol|${need}|${V.fallbackBars}`, () => new Map());
  const tod = sd.memo(`todVol|${need}`, () => new Map()); // minute → { expected, n } | null
  return (k) => {
    ctx.bar(k); // lookahead guard
    if (memo.has(k)) return memo.get(k);
    const bar = sd.candles[k];
    let out = null;
    if (bar && bar.volume > 0) {
      const m = sd.minutes[k];
      let t = tod.get(m);
      if (t === undefined) {
        const vals = ctx.ref.profile.map((p) => p.vol?.[m]).filter((v) => v != null && v > 0);
        tod.set(m, (t = vals.length >= need ? { expected: mean(vals), n: vals.length } : null));
      }
      if (t) {
        out = { value: bar.volume / t.expected, expected: t.expected, source: "time-of-day", n: t.n };
      } else {
        const from = Math.max(0, k - V.fallbackBars);
        const prev = [];
        for (let j = from; j < k; j++) prev.push(sd.candles[j].volume || 0);
        const avg = mean(prev.filter((v) => v > 0));
        if (prev.length >= 3 && avg > 0) out = { value: bar.volume / avg, expected: avg, source: "session", n: prev.length };
      }
    }
    memo.set(k, out);
    return out;
  };
}

export const rvolClass = (x, cfg) => (x == null ? "unknown" : cfg.volume.classes.find(([below]) => x < below)?.[1] ?? "Exceptional");

/**
 * The breakout on one side at bar i. bars: bars 0..i, atr: per-bar typical range (decision/atr.js),
 * rvol: makeRvol(). models: "all" | "close" | "retest" | "momentum".
 * Returns { side, state, level, breakLevel, b, model, triggerIdx, wickBreaks, failIdx, failWhy,
 *           retest, extended, acceptCloses, note }
 */
export function findBreakout(bars, or, side, i, cfg, atr, rvol, models = "all") {
  const C = cfg.setup;
  const long = side === "long";
  const lvl = long ? or.high : or.low;
  const brk = long ? lvl * (1 + C.bufferPct / 100) : lvl * (1 - C.bufferPct / 100);
  const out = { side, state: "inside", level: lvl, breakLevel: brk, b: -1, model: null, triggerIdx: -1, wickBreaks: 0, failIdx: -1, failWhy: "", retest: null, extended: [], acceptCloses: 0, note: "" };
  const useA = models === "all" || models === "close";
  const useB = models === "all" || models === "retest";
  const useC = models === "all" || models === "momentum";
  const beyond = (k, x = lvl) => (long ? bars[k].close > x : bars[k].close < x);
  const dist = (k) => (long ? bars[k].close - lvl : lvl - bars[k].close) / atr[k];
  const extended = (k) => dist(k) > C.maxExtensionAtr;
  const momentum = (k) => {
    const m = candleMetrics(bars[k], long);
    const rv = rvol(k);
    return (long ? m.bull : m.bear) && m.bodyPct >= C.momentumBody && m.closePos >= C.momentumClose && rv != null && rv.value >= C.momentumRvol;
  };

  for (let k = or.completeIndex + 1; k <= i; k++) {
    if (out.b < 0) {
      if (beyond(k, brk)) {
        out.b = k;
        out.acceptCloses = 1;
        if (useC && momentum(k)) {
          if (!extended(k)) {
            out.model = "C";
            out.triggerIdx = k;
            break;
          }
          out.extended.push({ k, model: "C", atr: dist(k) });
        }
      } else if (long ? bars[k].high > lvl : bars[k].low < lvl) {
        out.wickBreaks++;
      }
      continue;
    }

    if (k - out.b > C.retestMaxBars) {
      out.state = "expired";
      out.note = `no entry within ${C.retestMaxBars} bars of the breakout`;
      break;
    }
    // Failure: a close meaningfully back inside the range.
    const failAt = long ? lvl - C.holdTolAtr * atr[k] : lvl + C.holdTolAtr * atr[k];
    if (!beyond(k, failAt)) {
      out.failIdx = k;
      out.failWhy = out.retest ? "the retest failed: closed back inside the range" : "closed back inside the range";
      break;
    }
    if (beyond(k) && out.acceptCloses === k - out.b) out.acceptCloses++;

    // Model A: the acceptance candle(s) held beyond the level.
    if (useA && k === out.b + C.acceptanceBars && out.acceptCloses === C.acceptanceBars + 1) {
      if (!extended(k)) {
        out.model = "A";
        out.triggerIdx = k;
        break;
      }
      out.extended.push({ k, model: "A", atr: dist(k) });
    }

    // Model B: a retest of the level, a rejection candle there, then a close beyond its high.
    if (useB) {
      const r = out.retest;
      if (r && k > r.r && beyond(k, long ? bars[r.r].high : bars[r.r].low)) {
        if (!extended(k)) {
          out.model = "B";
          out.triggerIdx = k;
          break;
        }
        out.extended.push({ k, model: "B", atr: dist(k) });
      }
      const near = long ? bars[k].low <= lvl + C.retestTolAtr * atr[k] : bars[k].high >= lvl - C.retestTolAtr * atr[k];
      const m = candleMetrics(bars[k], long);
      const rejection = near && m.closePos >= C.retestRejectClose && beyond(k);
      const deeper = !r || (long ? bars[k].low < r.low : bars[k].high > r.low);
      if (rejection && deeper) out.retest = { r: k, low: long ? bars[k].low : bars[k].high, depthAtr: (long ? lvl - bars[k].low : bars[k].high - lvl) / atr[k] };
    }
  }

  if (out.triggerIdx >= 0) out.state = out.triggerIdx === i ? "triggered" : "fired";
  else if (out.failIdx >= 0) out.state = "failed";
  else if (out.state !== "expired" && out.b >= 0) out.state = "broken";
  return out;
}

// The side to report: the more advanced setup; both still inside → the level nearer price.
export function primarySide(L, S, close) {
  const rl = STATE_RANK[L.state];
  const rs = STATE_RANK[S.state];
  if (rl !== rs) return rl > rs ? L : S;
  if (L.state === "inside") return Math.abs(L.level - close) <= Math.abs(close - S.level) ? L : S;
  return L.b >= S.b ? L : S;
}
