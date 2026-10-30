// Factor 3 — price action and reversal confirmation (20). No entry before the trigger.
//
//   rejection candle   6   rejection wick ÷ range (4) + where it closed in its range (2)
//   reversal pattern   4   engulfing / hammer / shooting star / morning or evening star (4),
//                          dragonfly or gravestone doji (2) — the lab's own detectors
//   failed breakdown   3   took out the day's earlier low / PDL (high / PDH) and reclaimed it (3);
//                          pierced the band and closed back inside (1)
//   close back inside  3   a completed candle closed back inside the ±2σ band
//   trigger            4   a completed candle closed beyond the rejection candle's high (long)
//                          or low (short): strong body 4, weak 2, not yet 0
import * as engulfing from "../../patterns/detectors/engulfing.js";
import * as hammer from "../../patterns/detectors/hammer.js";
import * as shootingStar from "../../patterns/detectors/shootingStar.js";
import * as morningStar from "../../patterns/detectors/morningStar.js";
import * as eveningStar from "../../patterns/detectors/eveningStar.js";
import * as dragonfly from "../../patterns/detectors/dragonflyDoji.js";
import * as gravestone from "../../patterns/detectors/gravestoneDoji.js";
import { line, factor, gate, fmt, rs } from "../../decision/util.js";
import { candleMetrics } from "../../decision/candle.js";
import { bandAt } from "../setup.js";

export { candleMetrics };

function findPattern(bars, setup, i, long) {
  const strong = long ? [hammer, engulfing, morningStar] : [shootingStar, engulfing, eveningStar];
  const doji = long ? dragonfly : gravestone;
  const want = long ? "long" : "short";
  for (let k = setup.t; k <= i; k++) {
    for (const det of strong) {
      // Single-candle shapes only count on the rejection candle itself.
      if ((det === hammer || det === shootingStar) && k !== setup.t) continue;
      const h = det.detect(bars, k);
      if (h && h.direction === want) return { name: h.name, index: k, strong: true };
    }
  }
  const h = doji.detect(bars, setup.t);
  return h ? { name: h.name, index: setup.t, strong: false } : null;
}

export function priceActionFactor(D) {
  const { S, i, setup, cfg, long, side, ctx, timeOf } = D;
  const P = cfg.priceAction;
  const m = cfg.setup.band;
  const bandWord = `${long ? "−" : "+"}${m}σ`;
  const lines = [];
  const gates = [];

  if (setup.t < 0 || setup.state === "failed") {
    for (const [key, label, max] of [["rejection", "Rejection candle", 6], ["pattern", "Reversal pattern", 4], ["failed", "Failed breakdown", 3], ["inside", "Close back inside ±2σ", 3], ["trigger", "Confirmation trigger", 4]]) {
      lines.push(line(key, label, 0, max, null, setup.state === "failed" ? setup.note : `no ${bandWord} test`, "na"));
    }
    return factor("priceAction", "Price action", 20, lines, setup.state === "failed" ? `No setup: ${setup.note}` : `No ${bandWord} band test in the last ${cfg.setup.lookback} bars`, {
      gates,
      details: { pattern: null, metrics: null, status: setup.state === "failed" ? "Failed" : "No setup", trigger: null },
    });
  }

  const r = S.bars[setup.t];
  const mt = candleMetrics(r, long);
  const q1 = mt.wickPct >= P.strongWick ? 4 : mt.wickPct >= P.fairWick ? 2 : 0;
  const q2 = mt.closePos >= P.strongClose ? 2 : mt.closePos >= P.fairClose ? 1 : 0;
  lines.push(line("rejection", "Rejection candle", q1 + q2, 6, `${timeOf(setup.t)}: wick ${fmt(mt.wickPct * 100, 0)}% · body ${fmt(mt.bodyPct * 100, 0)}% · closed ${fmt(mt.closePos * 100, 0)}% ${long ? "up" : "down"} its range`, q1 >= 4 ? `long ${long ? "lower" : "upper"} wick — rejected` : q1 === 0 ? "no rejection wick" : ""));

  const pat = findPattern(S.bars, setup, i, long);
  lines.push(line("pattern", "Reversal pattern", pat ? (pat.strong ? 4 : 2) : 0, 4, pat ? `${pat.name} (${timeOf(pat.index)})` : "none", pat ? "" : "no recognised reversal candle"));

  // Failed breakdown / breakout of a structural level.
  const ext = setup.extreme;
  const close = S.bars[i].close;
  let prior = null;
  for (let k = 0; k < setup.t0; k++) prior = prior == null ? (long ? S.bars[k].low : S.bars[k].high) : long ? Math.min(prior, S.bars[k].low) : Math.max(prior, S.bars[k].high);
  const pdx = long ? ctx.ref.pdl : ctx.ref.pdh;
  const broke = (lvl) => lvl != null && (long ? ext < lvl && close > lvl : ext > lvl && close < lvl);
  const word = long ? "breakdown" : "breakout";
  let fb = 0;
  let fbText = "no structural level taken out";
  if (broke(pdx)) {
    fb = 3;
    fbText = `failed ${word} of ${long ? "PDL" : "PDH"} ${rs(pdx)}`;
  } else if (broke(prior)) {
    fb = 3;
    fbText = `failed ${word} of the day's earlier ${long ? "low" : "high"} ${rs(prior)}`;
  } else if (setup.insideIdx >= 0 && setup.insideIdx > setup.t0) {
    fb = 1;
    fbText = `closed beyond ${bandWord}, then back inside`;
  } else if (setup.insideIdx >= 0) {
    fb = 1;
    fbText = `pierced ${bandWord} intrabar and closed back inside`;
  }
  lines.push(line("failed", `Failed ${word}`, fb, 3, fbText));

  const inside = setup.insideIdx >= 0;
  const bandNow = bandAt(S, i, m, side);
  lines.push(line("inside", "Close back inside ±2σ", inside ? 3 : 0, 3, inside ? `yes, the ${timeOf(setup.insideIdx)} candle` : `not yet — needs a close ${long ? "above" : "below"} ${rs(bandNow)}`));

  const fired = setup.state === "triggered" || setup.state === "fired";
  let trig = 0;
  let trigText = `needs a close ${long ? "above" : "below"} ${rs(setup.triggerLevel)} (rejection candle ${long ? "high" : "low"})`;
  if (fired) {
    const tm = candleMetrics(S.bars[setup.triggerIdx], long);
    const strongBody = (long ? tm.bull : tm.bear) && tm.bodyPct >= P.confirmBody;
    trig = strongBody ? 4 : 2;
    trigText = `the ${timeOf(setup.triggerIdx)} candle closed at ${rs(S.bars[setup.triggerIdx].close)}, ${long ? "above" : "below"} ${rs(setup.triggerLevel)}${strongBody ? "" : " (weak candle)"}`;
  }
  lines.push(line("trigger", "Confirmation trigger", trig, 4, trigText, fired ? "" : "pending"));

  // Entry conditions.
  const status = {
    triggered: "Triggered on this candle",
    fired: `Triggered earlier (${timeOf(setup.triggerIdx)}) — no fresh entry`,
    armed: "Armed — waiting for the trigger",
    stretched: `Stretched — waiting for a close back inside ${bandWord}`,
    stale: `Stale — no trigger within ${cfg.setup.maxBarsToConfirm} bars of the rejection candle`,
  }[setup.state];
  if (setup.state === "triggered") gates.push(gate("confirm", "Reversal confirmed", true, trigText));
  else if (setup.state === "armed" || setup.state === "stretched") gates.push(gate("confirm", "Reversal confirmed", false, status, { hard: false, pending: true }));
  else gates.push(gate("confirm", "Reversal confirmed", false, status));

  const observation = `${pat ? pat.name : "No pattern"}; wick ${fmt(mt.wickPct * 100, 0)}%; ${inside ? "back inside" : "still outside"}; ${status.toLowerCase()}`;
  return factor("priceAction", "Price action", 20, lines, observation, {
    gates,
    details: { pattern: pat?.name ?? null, metrics: mt, rejectionTime: timeOf(setup.t), status, trigger: setup.triggerLevel, failed: fbText },
  });
}
