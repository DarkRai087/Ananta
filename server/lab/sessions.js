// Turns a flat list of intraday candles into trading sessions (one per IST day).
// This is where the session-bound rule starts: everything downstream receives one
// session's candles plus the prior-day reference levels (high / low / close), nothing else.
import { MARKET } from "../config/market.js";
import { LAB } from "../config/lab.js";
import { istDate, istMinute, hhmmToMin, OPEN_MIN, CLOSE_MIN } from "./time.js";

// Extra special dates learned at runtime (e.g. NSE holidays marked "*" = Muhurat).
const extraSpecial = new Map();
export function registerSpecialDate(date, label = "Special session") {
  if (!MARKET.specialSessions[date]) extraSpecial.set(date, label);
}

// The candle window for a date: { start, end, special, label } in IST minutes.
export function sessionWindow(date) {
  const cfg = MARKET.specialSessions[date];
  if (cfg) return { start: hhmmToMin(cfg.start), end: hhmmToMin(cfg.end), special: true, label: cfg.label };
  if (extraSpecial.has(date)) return { start: 0, end: 1440, special: true, label: extraSpecial.get(date) };
  return { start: OPEN_MIN, end: CLOSE_MIN, special: false, label: null };
}

// True if a candle (by start time) belongs to a session. Pre-open and post-close are dropped.
export function isSessionCandle(t) {
  const w = sessionWindow(istDate(t));
  const m = istMinute(t);
  return m >= w.start && m < w.end;
}

/**
 * candles: sorted [{ time, open, high, low, close, volume }]
 * returns [{ date, special, label, candles, prev, history }]
 *   prev = { date, high, low, close } from the previous regular session's candles, or null.
 *   history = daily bars of up to LAB.historyDays earlier regular sessions, oldest first
 *   (history[history.length - 1] is prev). Never includes the session itself.
 *   profile = opening profiles (sessionProfile) of up to LAB.profileDays earlier regular
 *   sessions, oldest first: summaries only, never candles. Never includes the session itself.
 */
export function buildSessions(candles) {
  const byDate = new Map();
  for (const c of candles) {
    if (!isSessionCandle(c.time)) continue;
    const d = istDate(c.time);
    let arr = byDate.get(d);
    if (!arr) byDate.set(d, (arr = []));
    arr.push(c);
  }
  const dates = [...byDate.keys()].sort();
  const sessions = [];
  let prevRegular = null;
  let prevVwap = null; // the previous regular session's VWAP (a scalar reference, like prev.close)
  let daily = []; // earlier regular sessions' daily bars, oldest first
  let profiles = []; // earlier regular sessions' opening profiles, oldest first
  for (const date of dates) {
    const cs = byDate.get(date).sort((a, b) => a.time - b.time);
    const w = sessionWindow(date);
    const s = { date, special: w.special, label: w.label, candles: cs, prev: null, prevVwap: null, history: [], profile: [] };
    if (!w.special) {
      s.prev = prevRegular;
      s.prevVwap = prevVwap;
      s.history = daily;
      s.profile = profiles;
      prevRegular = dailyBar(date, cs);
      prevVwap = sessionVwap(cs);
      daily = [...daily, prevRegular].slice(-LAB.historyDays);
      profiles = [...profiles, sessionProfile(date, cs)].slice(-LAB.profileDays);
    }
    sessions.push(s);
  }
  return sessions;
}

// What earlier sessions may pass on about their opening and their time-of-day rhythm (for
// opening-range percentiles and same-time-of-day relative volume). Summaries only:
//   or[m]    = { width, volume, open } of the first m minutes (5 / 15 / 30 / 60), by bar start time
//   vol[min] = volume of the bar starting at that IST minute; rng[min] = its high − low
export const PROFILE_OR_MINUTES = [5, 15, 30, 60];
export function sessionProfile(date, cs) {
  const or = {};
  for (const m of PROFILE_OR_MINUTES) {
    let hi = -Infinity;
    let lo = Infinity;
    let vol = 0;
    for (const c of cs) {
      if (istMinute(c.time) >= OPEN_MIN + m && c !== cs[0]) break;
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
      vol += c.volume || 0;
    }
    or[m] = { width: hi - lo, volume: vol, open: cs[0].open };
  }
  const vol = {};
  const rng = {};
  for (const c of cs) {
    const k = istMinute(c.time);
    vol[k] = c.volume || 0;
    rng[k] = c.high - c.low;
  }
  return { date, or, vol, rng };
}

// A session's VWAP as a single number (volume-weighted typical price; equal-weighted when there is
// no volume, like vwap()). A scalar reference for the next day, computed from this session's candles.
export function sessionVwap(cs) {
  let pv = 0;
  let vol = 0;
  let tp = 0;
  for (const c of cs) {
    const t = (c.high + c.low + c.close) / 3;
    pv += t * (c.volume || 0);
    vol += c.volume || 0;
    tp += t;
  }
  return vol > 0 ? pv / vol : cs.length ? tp / cs.length : null;
}

// Daily OHLC derived from a session's intraday candles.
export function dailyBar(date, cs) {
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  for (const c of cs) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    volume += c.volume || 0;
  }
  return { date, open: cs[0].open, high, low, close: cs[cs.length - 1].close, volume };
}

// Build N-minute bars from 1-minute bars, aligned to 09:15 (used when a provider has no 3m).
export function aggregateMinutes(candles, n) {
  const out = [];
  let cur = null;
  let curKey = null;
  for (const c of candles) {
    const d = istDate(c.time);
    const m = istMinute(c.time);
    const bucket = Math.floor((m - OPEN_MIN) / n);
    const key = `${d}|${bucket}`;
    if (key !== curKey) {
      const startMin = OPEN_MIN + bucket * n;
      cur = { time: c.time - (m - startMin) * 60, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
      out.push(cur);
      curKey = key;
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume || 0;
    }
  }
  return out;
}
