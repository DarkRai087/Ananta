// Chart overlays, computed per session with the same indicator code the strategies use.
// Each series is [{ time, value }] with a gap (value: null) at every session start so lines
// never connect one day to the next.
import { SessionData } from "./sessionData.js";
import { detectSession } from "../patterns/index.js";

export const OVERLAYS = [
  { id: "vwap", label: "VWAP" },
  { id: "ema", label: "EMA 9/21" },
  { id: "pdhl", label: "PDH / PDL" },
  { id: "or", label: "Opening range" },
  { id: "cpr", label: "CPR + pivots" },
  { id: "supertrend", label: "Supertrend 10,3" },
  { id: "bb", label: "Bollinger 20,2" },
  { id: "rsi", label: "RSI 14" },
];

/**
 * sessions: from buildSessions(); ids: overlay ids; opts: { intervalMin, orMinutes, symbol, interval }
 * Returns { [seriesName]: [{ time, value }] }
 */
export function computeOverlays(sessions, ids, { intervalMin, orMinutes = 15, symbol = "", interval = "" }) {
  const want = new Set(ids);
  const out = {};
  const push = (name, time, value) => (out[name] ||= []).push(value == null || !Number.isFinite(value) ? { time } : { time, value });

  for (const s of sessions) {
    const cs = s.candles;
    if (!cs.length) continue;
    const sd = new SessionData(s, intervalMin, `${symbol}|${interval}|${s.date}`);
    const series = (name, arr) => cs.forEach((c, k) => push(name, c.time, k === 0 ? null : arr[k]));
    const flat = (name, value, fromIdx = 1) => cs.forEach((c, k) => push(name, c.time, k < Math.max(fromIdx, 1) ? null : value));

    if (want.has("vwap")) series("vwap", sd.get("vwap"));
    if (want.has("ema")) {
      series("ema9", sd.get("ema", 9));
      series("ema21", sd.get("ema", 21));
    }
    if (want.has("pdhl")) {
      flat("pdh", s.prev?.high);
      flat("pdl", s.prev?.low);
    }
    if (want.has("or")) {
      const or = sd.get("or", orMinutes);
      const ok = or && Number.isFinite(or.completeIndex);
      flat("orHigh", ok ? or.high : null, ok ? or.completeIndex : 1);
      flat("orLow", ok ? or.low : null, ok ? or.completeIndex : 1);
    }
    if (want.has("cpr")) {
      const p = sd.pivots;
      for (const k of ["pivot", "bc", "tc", "r1", "s1", "r2", "s2"]) flat(k, p?.[k]);
    }
    if (want.has("supertrend")) {
      const st = sd.get("supertrend", 10, 3);
      series("stUp", st.value.map((v, k) => (st.dir[k] === 1 ? v : null)));
      series("stDown", st.value.map((v, k) => (st.dir[k] === -1 ? v : null)));
    }
    if (want.has("bb")) {
      const bb = sd.get("bb", 20, 2);
      series("bbUpper", bb.upper);
      series("bbMid", bb.mid);
      series("bbLower", bb.lower);
    }
    if (want.has("rsi")) series("rsi", sd.get("rsi", 14));
  }
  return out;
}

// Pattern markers for the chosen detector ids.
export function patternMarkers(sessions, ids) {
  const markers = [];
  for (const s of sessions) {
    for (const h of detectSession(s.candles, ids)) {
      const c = s.candles[h.index];
      markers.push({
        time: c.time,
        id: h.id,
        name: h.name,
        direction: h.direction,
        position: h.direction === "short" ? "aboveBar" : "belowBar",
        shape: h.direction === "long" ? "arrowUp" : h.direction === "short" ? "arrowDown" : "circle",
      });
    }
  }
  return markers;
}
