// Per-session indicator cache + the guarded context strategies see.
import * as I from "./indicators.js";
import { istMinute } from "./time.js";

// ── Indicator cache (per symbol / interval / session) ───────────────────────
const MAX_ENTRIES = 50_000;
const cache = new Map();

function cached(key, compute) {
  if (cache.has(key)) {
    const v = cache.get(key);
    cache.delete(key); // refresh LRU position
    cache.set(key, v);
    return v;
  }
  const v = compute();
  cache.set(key, v);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return v;
}

export function clearIndicatorCache() {
  cache.clear();
}

// Indicator name → (candles, intervalMin, ...args) => array | object of arrays | object
const COMPUTE = {
  close: (cs) => I.closes(cs),
  ema: (cs, _iv, period) => I.ema(I.closes(cs), period),
  sma: (cs, _iv, period) => I.sma(I.closes(cs), period),
  volSma: (cs, _iv, period) => I.sma(I.volumes(cs), period),
  atr: (cs, _iv, period) => I.atr(cs, period),
  rsi: (cs, _iv, period) => I.rsi(I.closes(cs), period),
  bb: (cs, _iv, period, mult) => I.bollinger(I.closes(cs), period, mult),
  vwap: (cs) => I.vwap(cs),
  vwapBands: (cs, _iv, mult) => I.vwapBands(cs, mult),
  keltner: (cs, _iv, period, mult) => I.keltner(cs, period, mult),
  adx: (cs, _iv, period) => I.adx(cs, period),
  er: (cs, _iv, n) => I.efficiencyRatio(I.closes(cs), n),
  macd: (cs, _iv, fast, slow, signal) => I.macd(I.closes(cs), fast, slow, signal),
  supertrend: (cs, _iv, period, mult) => I.supertrend(cs, period, mult),
  or: (cs, iv, minutes) => I.openingRange(cs, minutes, iv),
};

/**
 * Wraps one session. `key` identifies symbol|interval|date; the candle count and last time
 * are added so a growing (live) session never reuses stale values.
 */
export class SessionData {
  constructor(session, intervalMin, key = null) {
    this.session = session;
    this.candles = session.candles;
    this.intervalMin = intervalMin;
    const n = this.candles.length;
    this.key = key ? `${key}|${n}|${n ? this.candles[n - 1].time : 0}` : null;
    this.local = new Map();
    this.minutes = this.candles.map((c) => istMinute(c.time));
    this.pivots = I.pivots(session.prev);
  }

  get(name, ...args) {
    const sub = `${name}(${args.join(",")})`;
    if (this.local.has(sub)) return this.local.get(sub);
    const compute = () => COMPUTE[name](this.candles, this.intervalMin, ...args);
    const v = this.key ? cached(`${this.key}|${sub}`, compute) : compute();
    this.local.set(sub, v);
    return v;
  }
}

export class LookaheadError extends Error {
  constructor(k, i) {
    super(`Lookahead: read bar ${k} while at bar ${i}`);
    this.name = "LookaheadError";
  }
}

/**
 * What a strategy's onBar() receives. Everything is limited to bars 0..i of the CURRENT
 * session, plus prior-day reference levels. Reading k > i throws LookaheadError.
 */
export class BarContext {
  constructor(sd, params) {
    this.sd = sd;
    this.params = params;
    this.i = 0;
    this.position = null;
    this.state = {};
    this.tradesToday = 0;
    this.maxRead = -1; // highest bar index read (used by tests)
    const prev = sd.session.prev;
    const first = sd.candles[0];
    this.ref = {
      pdh: prev?.high ?? null,
      pdl: prev?.low ?? null,
      pdc: prev?.close ?? null,
      open: first ? first.open : null, // today's 09:15 open (known at the first bar)
      gapPct: prev && first ? ((first.open - prev.close) / prev.close) * 100 : null,
      // Daily bars of earlier regular sessions, oldest first (last = previous day). Never today.
      daily: sd.session.history ?? [],
      // Opening profiles of earlier regular sessions (lab/sessions.js sessionProfile), oldest first.
      profile: sd.session.profile ?? [],
    };
    this.ref.atrDaily = I.dailyAtr(this.ref.daily, 14);
    this.pivots = sd.pivots; // from prior-day H/L/C
    this.intervalMin = sd.intervalMin;
  }

  _check(k) {
    if (k > this.i) throw new LookaheadError(k, this.i);
    if (k > this.maxRead) this.maxRead = k;
  }

  // Candle at k (default: current bar). Undefined for k < 0.
  bar(k = this.i) {
    this._check(k);
    return k < 0 ? undefined : this.sd.candles[k];
  }

  // IST minute-of-day of bar k.
  minute(k = this.i) {
    this._check(k);
    return this.sd.minutes[k];
  }

  /**
   * Indicator value `ago` bars back. e.g. ind("ema", [9]) or ind("ema", [9], 1) for the previous bar.
   * Object indicators (bb, supertrend) return an object of values, e.g. { mid, upper, lower }.
   */
  ind(name, args = [], ago = 0) {
    const k = this.i - ago;
    this._check(k);
    if (k < 0) return null;
    const v = this.sd.get(name, ...args);
    if (Array.isArray(v)) return v[k];
    const out = {};
    for (const f of Object.keys(v)) out[f] = v[f][k];
    return out;
  }

  // Opening range, or null until it has completed at/before the current bar.
  openingRange(minutes) {
    const or = this.sd.get("or", minutes);
    if (!or || or.completeIndex > this.i) return null;
    return { high: or.high, low: or.low, completeIndex: or.completeIndex };
  }

  /**
   * An index bar lined up with bar k = i − ago of this session (attached by
   * market/marketData.js): the latest index bar that STARTED at or before bar k, so it
   * closed by the time bar k closed. role: "nifty" | "sector".
   * Returns { id, name, time, open, high, low, close, vwap, prevClose, dayOpen } or null.
   */
  market(role, ago = 0) {
    const k = this.i - ago;
    this._check(k);
    const m = this.sd.session.market?.[role];
    if (!m || k < 0) return null;
    const j = m.map[k];
    if (j == null || j < 0) return null;
    const b = m.bars[j];
    return { id: m.id, name: m.name, time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, vwap: m.vwap[j], prevClose: m.prevClose, dayOpen: m.bars[0].open };
  }

  highest(n, field = "high", ago = 1) {
    const to = this.i - ago;
    if (to - n + 1 < 0) return null;
    this._check(to);
    return I.highest(this.sd.candles, to - n + 1, to, field);
  }

  lowest(n, field = "low", ago = 1) {
    const to = this.i - ago;
    if (to - n + 1 < 0) return null;
    this._check(to);
    return I.lowest(this.sd.candles, to - n + 1, to, field);
  }
}
