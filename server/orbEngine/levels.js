// Entry, stop, targets and size for an ORB setup, priced the way the backtest fills them.
//
//   entry    triggered → the next candle's open (≈ the trigger candle's close)
//            broken    → conditional: a close beyond the retest candle (model B), or the next candle
//                        holding beyond the level (model A); entry ≈ the current price
//            (inside — no breakout close yet: no levels. The breakout candle, and so the stop,
//            isn't known, and nothing is priced or scored on a guess.)
//   stop     structural invalidation ∓ max(0.1 ATR, 2 ticks): the retest low (model B), else the
//            tighter of the breakout candle's low and the range midpoint. Never closer than 0.3 ATR
//            (the noise floor). Before a breakout it is the midpoint — the worst case.
//   targets  A: range projection (entry ± 1 / 2 × ORW) · B: volatility cap (the day's extreme ±
//            one typical daily range) · C: structure (PDH / PDL / PDC / pivots). Each target is
//            the NEAREST of the candidates, so a resistance or a spent day caps it. T3 only with
//            a trending tape or a momentum entry, when the cap leaves room.
//   size     decision/sizing.js: the most shares whose loss at the stop, charges and slippage
//            included, stays inside the risk budget
import { SQUARE_OFF_MIN } from "../lab/time.js";
import { roundTick, num } from "../decision/util.js";
import { sizeAt, netAt, chaseLimit } from "../decision/sizing.js";

export function orbLevels(D) {
  const { setup, or, S, i, atr, cfg, long, tick, risk, params, intervalMin, nextMin, ctx } = D;
  const st = setup.state;
  if (!or || (st !== "triggered" && st !== "broken")) return null;
  const R = cfg.risk;
  const T = cfg.targets;
  const a = atr[i];
  const lvl = setup.level;
  const dirn = long ? 1 : -1;
  const beyond = (x, ref) => (long ? x > ref : x < ref);

  // Entry.
  let entry;
  let trigger;
  let triggerText;
  if (st === "triggered") {
    entry = S[i].close;
    trigger = roundTick(setup.model === "B" ? (long ? S[setup.retest.r].high : S[setup.retest.r].low) : setup.breakLevel, tick);
    triggerText = setup.model === "B" ? `close ${long ? "above" : "below"} the retest candle's ${long ? "high" : "low"}` : `close ${long ? "above ORH" : "below ORL"}${setup.model === "A" ? ", held for the acceptance candle" : " on a momentum candle"}`;
  } else if (st === "broken" && setup.retest) {
    trigger = roundTick((long ? S[setup.retest.r].high : S[setup.retest.r].low) + dirn * tick, tick, long ? "up" : "down");
    entry = trigger;
    triggerText = `a ${D.interval} close ${long ? "above" : "below"} the ${D.timeOf(setup.retest.r)} retest candle's ${long ? "high" : "low"}`;
  } else {
    trigger = roundTick(lvl, tick);
    entry = S[i].close;
    triggerText = `the next ${D.interval} candle holds ${long ? "above ORH" : "below ORL"} (acceptance), or a retest of it is rejected`;
  }

  // Stop: structural invalidation.
  let struct;
  let stopBasis;
  if (setup.retest && (setup.model === "B" || st === "broken")) {
    struct = setup.retest.low;
    stopBasis = "the retest low";
  } else {
    const bl = long ? S[setup.b].low : S[setup.b].high;
    struct = long ? Math.max(bl, or.mid) : Math.min(bl, or.mid);
    stopBasis = struct === or.mid ? "the range midpoint" : `the breakout candle's ${long ? "low" : "high"}`;
  }
  const buffer = Math.max(R.stopBufferAtr * a, R.stopMinTicks * tick);
  const stopFor = (e) => {
    let s = struct - dirn * buffer;
    let note = "";
    if (Math.abs(e - s) < R.minStopAtr * a) {
      s = e - dirn * R.minStopAtr * a;
      note = `widened to the ${R.minStopAtr} ATR noise floor`;
    }
    return { stop: roundTick(s, tick, long ? "down" : "up"), note };
  };

  // Targets.
  let dayHi = -Infinity;
  let dayLo = Infinity;
  for (let k = 0; k <= i; k++) {
    dayHi = Math.max(dayHi, S[k].high);
    dayLo = Math.min(dayLo, S[k].low);
  }
  const atrD = ctx.ref.atrDaily;
  const volCap = atrD ? (long ? dayLo + T.volCapAtr * atrD : dayHi - T.volCapAtr * atrD) : null;
  const pv = ctx.pivots;
  const structure = [
    ["PDH", ctx.ref.pdh],
    ["PDL", ctx.ref.pdl],
    ["PDC", ctx.ref.pdc],
    ["Pivot", pv?.pivot],
    ["R1", pv?.r1],
    ["R2", pv?.r2],
    ["S1", pv?.s1],
    ["S2", pv?.s2],
  ].filter(([, x]) => num(x));
  const adx = ctx.ind("adx", [cfg.momentum.adxPeriod])?.adx;
  const targetsFor = (e) => {
    const gap = T.minGapAtr * a;
    const ahead = structure.filter(([, x]) => beyond(x, e + dirn * gap)).sort((p, q) => dirn * (p[1] - q[1]));
    const nearest = (cands) => cands.filter(Boolean).filter(([, x]) => beyond(x, e)).sort((p, q) => dirn * (p[1] - q[1]))[0] ?? null;
    const capOk = volCap != null && beyond(volCap, e);
    const t1 = nearest([["1 × range projection", e + dirn * or.width], ahead[0] ? [`${ahead[0][0]} (structure)`, ahead[0][1]] : null, capOk ? ["volatility cap", volCap] : null]);
    if (!t1 || (volCap != null && !capOk)) return { t1: null, t1Why: volCap != null && !capOk ? "the day's typical range is already used up" : "", t2: null, t2Why: "", t3: null, t3Note: "" };
    const next = ahead.find(([, x]) => beyond(x, t1[1] + dirn * gap));
    let t2 = nearest([["2 × range projection", e + 2 * dirn * or.width], capOk ? ["volatility cap", volCap] : null, next ? [`${next[0]} (structure)`, next[1]] : null]);
    if (t2 && !beyond(t2[1], t1[1] + dirn * tick)) t2 = null;
    const last = t2 ?? t1;
    let t3 = null;
    let t3Note = "";
    if (!capOk) t3Note = "no volatility cap (no daily ATR)";
    else if (!beyond(volCap, last[1] + dirn * 0.5 * or.width)) t3Note = "not justified: the typical daily range leaves no room beyond T2";
    else if (!(num(adx) && adx >= T.t3MinAdx) && setup.model !== "C") t3Note = `not justified: no trending tape (ADX ${num(adx) ? adx.toFixed(1) : "n/a"}) and not a momentum entry`;
    else t3 = ["volatility cap", volCap];
    return { t1: t1[1], t1Why: t1[0], t2: t2?.[1] ?? null, t2Why: t2?.[0] ?? (t1 ? "no room beyond T1 (structure / volatility cap)" : ""), t3: t3?.[1] ?? null, t3Why: t3?.[0] ?? "", t3Note };
  };
  const primaryOf = (tg) => (params.target === "t1" ? tg.t1 : (tg.t2 ?? tg.t1));
  const rnd = (x) => (x == null ? null : roundTick(x, tick, long ? "down" : "up"));

  const tg = targetsFor(entry);
  const { stop, note: stopNote } = stopFor(entry);
  const primary = rnd(primaryOf(tg));
  const sz = sizeAt(long, entry, stop, primary, risk);
  const rrOf = (e) => {
    const t = targetsFor(e);
    return sizeAt(long, e, stopFor(e).stop, rnd(primaryOf(t)), risk).netRR;
  };
  const worst = lvl + dirn * cfg.setup.maxExtensionAtr * a;
  const chase = chaseLimit(long, lvl + dirn * tick, worst, rrOf, R.minNetRR, tick, roundTick);
  const at = (x) => (x == null ? { net: null, charges: null } : netAt(long, sz.fill, x, sz.qty));
  const t1 = rnd(tg.t1);
  const t2 = rnd(tg.t2);
  const t3 = rnd(tg.t3);
  const riskPerShare = Number(Math.abs(entry - stop).toFixed(4));
  const speed = cfg.session.speedAtrPerBar * a;
  const grossReward = sz.qty > 0 && primary != null ? Math.abs(primary - entry) * sz.qty : null;

  return {
    state: st,
    conditional: st !== "triggered",
    model: setup.model,
    trigger,
    triggerText,
    entry,
    entryFill: sz.fill,
    stop,
    stopBasis,
    stopNote,
    buffer,
    t1,
    t1Why: tg.t1Why,
    t2,
    t2Why: tg.t2Why,
    t3,
    t3Why: tg.t3Why,
    t3Note: tg.t3Note,
    primary,
    primaryName: params.target === "t1" || tg.t2 == null ? "T1" : "T2",
    projections: { p1: entry + dirn * or.width, p2: entry + 2 * dirn * or.width },
    volCap,
    room: volCap != null ? dirn * (volCap - entry) : null,
    riskPerShare,
    rewardPerShare: primary != null ? Number(Math.abs(primary - entry).toFixed(4)) : null,
    valid: sz.valid,
    qty: sz.qty,
    capped: sz.capped,
    exposure: sz.qty * sz.fill,
    maxLossRs: sz.lossRs,
    lossCharges: sz.charges,
    netAtT1: at(t1).net,
    netAtT2: at(t2).net,
    netAtT3: at(t3).net,
    chargesAtPrimary: sz.chargesAtTarget,
    grossRR: sz.valid && riskPerShare > 0 ? Math.abs(primary - entry) / riskPerShare : null,
    netRR: sz.netRR,
    chaseLimit: chase,
    costDrag: grossReward > 0 ? (sz.chargesAtTarget + Math.abs(sz.fill - entry) * sz.qty) / grossReward : null,
    slippagePct: risk.slippagePct,
    barsLeft: Math.max(0, (SQUARE_OFF_MIN - nextMin) / intervalMin),
    barsToT1: speed > 0 && t1 != null ? Math.abs(t1 - entry) / speed : null,
  };
}
