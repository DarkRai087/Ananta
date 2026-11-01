// Session-leak guard: patterns and strategies may not use a previous session's price candles.
// The only prior-day information allowed is the daily bars (reference levels + ctx.ref.daily, the
// daily OHLCV of up to LAB.historyDays earlier sessions) and ctx.ref.profile (the per-slot volume /
// range summary, used for same-time-of-day relative volume — e.g. Volume Breakout v2's RVOL).
//
// Method: build two histories whose day 1 candles have a completely different PRICE shape but the
// SAME daily high / low / close AND the same per-slot volume (so the allowed summaries match).
// Everything computed for day 2 must be identical; anything reading day 1's price candles differs.
import { describe, it, expect } from "vitest";
import { STRATEGIES } from "../strategies/index.js";
import { detectSession } from "../patterns/index.js";
import { buildSessions } from "../lab/sessions.js";
import { SessionData, BarContext } from "../lab/sessionData.js";
import { runSession } from "../backtest/engine.js";
import { LAB } from "../config/lab.js";
import { makeCandles, randomSessions } from "./helpers.js";

const [d1a, d2] = randomSessions(2, 21);

// A different day 1 with the same high, low and last close as d1a.
function sameRefsDifferentCandles(bars) {
  const hi = Math.max(...bars.map((b) => b[1]));
  const lo = Math.min(...bars.map((b) => b[2]));
  const close = bars[bars.length - 1][3];
  const mid = (hi + lo) / 2;
  const vol = (k) => bars[k][4] ?? 1000; // keep each slot's volume so ctx.ref.profile matches
  const out = bars.map((_, k) => {
    const p = mid + Math.sin(k / 3) * (hi - lo) * 0.3;
    return [p, p + 0.05, p - 0.05, p + 0.01, vol(k)];
  });
  out[5] = [mid, hi, mid - 0.1, mid, vol(5)];
  out[9] = [mid, mid + 0.1, lo, mid, vol(9)];
  out[out.length - 1] = [close, close + 0.01, close - 0.01, close, vol(out.length - 1)];
  return out;
}

const histA = buildSessions([...makeCandles(d1a.date, d1a.bars), ...makeCandles(d2.date, d2.bars)]);
const histB = buildSessions([...makeCandles(d1a.date, sameRefsDifferentCandles(d1a.bars)), ...makeCandles(d2.date, d2.bars)]);

describe("session leak", () => {
  it("setup: day 1 differs but the prior-day reference levels are equal", () => {
    expect(histA[0].candles).not.toEqual(histB[0].candles);
    expect(histA[1].prev.high).toBeCloseTo(histB[1].prev.high, 9);
    expect(histA[1].prev.low).toBeCloseTo(histB[1].prev.low, 9);
    expect(histA[1].prev.close).toBeCloseTo(histB[1].prev.close, 9);
  });

  it("patterns on day 2 don't depend on day 1 candles (swing points reset each day)", () => {
    expect(detectSession(histA[1].candles)).toEqual(detectSession(histB[1].candles));
  });

  it("indicators on day 2 restart at 09:15", () => {
    const a = new SessionData(histA[1], 5);
    const b = new SessionData(histB[1], 5);
    for (const [name, args] of [["ema", [9]], ["vwap", []], ["atr", [14]], ["rsi", [14]], ["supertrend", [10, 3]], ["bb", [20, 2]]]) {
      expect(a.get(name, ...args)).toEqual(b.get(name, ...args));
    }
  });

  it.each(STRATEGIES.map((s) => [s.name, s]))("%s: same signals and trades on day 2", (_n, strategy) => {
    // testParams: a strict strategy can loosen thresholds so its entry path runs on random data.
    const params = { ...strategy.params, ...(strategy.testParams || {}) };
    const sigs = (sess) => {
      const ctx = new BarContext(new SessionData(sess, 5), params);
      return sess.candles.map((_, i) => {
        ctx.i = i;
        return strategy.onBar(ctx);
      });
    };
    expect(sigs(histA[1])).toEqual(sigs(histB[1]));
    const bt = (sess) =>
      runSession({ session: sess, symbol: "X", strategy, params, settings: LAB.backtest, intervalMin: 5 }).trades;
    expect(bt(histA[1])).toEqual(bt(histB[1]));
  });

  it("strategies only receive the current session's candles", () => {
    const sd = new SessionData(histA[1], 5);
    expect(sd.candles.every((c) => c.time >= histA[1].candles[0].time)).toBe(true);
    const ctx = new BarContext(sd, {});
    expect(Object.keys(ctx.ref).sort()).toEqual(["atrDaily", "daily", "gapPct", "open", "pdVwap", "pdc", "pdh", "pdl", "profile"]);
    // Earlier days arrive only as daily bars, never as intraday candles or today's bar.
    for (const d of ctx.ref.daily) {
      expect(Object.keys(d).sort()).toEqual(["close", "date", "high", "low", "open", "volume"]);
      expect(d.date < histA[1].date).toBe(true);
    }
  });
});
