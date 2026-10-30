// Classifies a session by its opening context, using only what is known when the opening
// range completes (default 09:30):
//   gap: up / down / flat         (09:15 open vs previous close)
//   or:  narrow / normal / wide   (opening-range width ÷ 14-day ATR from prior sessions)
//   pos: abovePDH / belowPDL / inside (close of the last opening-range bar vs prior day H/L)
import { LAB } from "../config/lab.js";
import { openingRange, dailyAtr } from "./indicators.js";
import { dailyBar } from "./sessions.js";

const LABELS = {
  gap: { up: "gap-up", down: "gap-down", flat: "flat open" },
  or: { narrow: "narrow OR", normal: "normal OR", wide: "wide OR", unknown: "OR vs ATR unknown" },
  pos: { abovePDH: "above PDH", belowPDL: "below PDL", inside: "inside prior range" },
};

// Daily ATR over the `days` regular sessions before index idx.
const priorAtr = (daily, idx, days) => (idx < days ? null : dailyAtr(daily.slice(0, idx), days));

/**
 * Adds `context` to each regular session. Returns the same array.
 * context = { ready, gapPct, gap, orRatio, or, pos, key, label } ; ready=false until the OR completes.
 */
export function annotateContexts(sessions, intervalMin, cfg = LAB.context) {
  const regular = sessions.filter((s) => !s.special);
  const daily = regular.map((s) => dailyBar(s.date, s.candles));
  regular.forEach((s, idx) => {
    s.context = sessionContext(s, intervalMin, priorAtr(daily, idx, cfg.atrDays), cfg);
  });
  return sessions;
}

export function sessionContext(s, intervalMin, atr, cfg = LAB.context) {
  const cs = s.candles;
  const prev = s.prev;
  const or = openingRange(cs, cfg.orMinutes, intervalMin);
  if (!prev || !cs.length || !or || !Number.isFinite(or.completeIndex)) {
    return { ready: false, key: null, label: prev ? "Opening range not complete yet" : "No previous session" };
  }
  const gapPct = ((cs[0].open - prev.close) / prev.close) * 100;
  const gap = gapPct >= cfg.gapPct ? "up" : gapPct <= -cfg.gapPct ? "down" : "flat";
  const orRatio = atr ? (or.high - or.low) / atr : null;
  const orc = orRatio == null ? "unknown" : orRatio < cfg.orNarrow ? "narrow" : orRatio > cfg.orWide ? "wide" : "normal";
  const px = cs[or.completeIndex].close;
  const pos = px > prev.high ? "abovePDH" : px < prev.low ? "belowPDL" : "inside";
  const parts = { gap, or: orc, pos };
  return {
    ready: true,
    gapPct,
    gap,
    orRatio,
    or: orc,
    pos,
    orHigh: or.high,
    orLow: or.low,
    atr,
    key: contextKey(parts, cfg.match),
    label: cfg.match.map((d) => LABELS[d][parts[d]]).join(", "),
    parts,
  };
}

export function contextKey(parts, match = LAB.context.match) {
  return match.map((d) => `${d}:${parts[d]}`).join("|");
}
