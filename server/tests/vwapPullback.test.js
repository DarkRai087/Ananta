// VWAP Pullback: VWAP hand-calc + the long signal path + the gap filter.
import { describe, it, expect } from "vitest";
import { vwap } from "../lab/indicators.js";
import { SessionData, BarContext } from "../lab/sessionData.js";
import { makeSession } from "./helpers.js";
import strategy from "../strategies/vwapPullback.js";
import { tickFor } from "../decision/util.js";

describe("VWAP (typical-price, volume-weighted)", () => {
  it("matches a hand calculation", () => {
    // typical = (H+L+C)/3; VWAP[k] = Σ(typical·vol) / Σ(vol) over bars 0..k.
    const cs = [
      { high: 11, low: 9, close: 10, volume: 100 }, // tp 10
      { high: 13, low: 11, close: 12, volume: 300 }, // tp 12
      { high: 20, low: 16, close: 18, volume: 200 }, // tp 18
    ];
    const v = vwap(cs);
    expect(v[0]).toBeCloseTo(10, 10);
    expect(v[1]).toBeCloseTo((10 * 100 + 12 * 300) / 400, 10); // 11.5
    expect(v[2]).toBeCloseTo((10 * 100 + 12 * 300 + 18 * 200) / 600, 10); // 13.666…
  });
});

// A smooth green uptrend (closes above a rising VWAP), a low-volume dip to VWAP, then a reclaim
// bar that closes above the prior high and above VWAP. Loosen only the tolerances unrelated to the
// trend logic so the full slope / hold / crossing / touch / trigger / stop path runs end to end.
function trendSession(prevClose = 100) {
  const bars = [];
  for (let k = 0; k < 16; k++) {
    const c = 100 + k * 0.3;
    const o = c - 0.2;
    bars.push([o, c + 0.05, o - 0.05, c, 1000]); // green, tight range
  }
  bars.push([104.4, 104.5, 102.1, 102.3, 200]); // low-volume dip toward VWAP
  bars.push([102.4, 104.9, 102.3, 104.8, 1500]); // reclaim: close > prior high and > VWAP
  return makeSession("2026-02-02", bars, { high: prevClose + 1, low: prevClose - 1, close: prevClose });
}

const PARAMS = {
  ...strategy.params,
  requireMarket: false,
  touchAtrMult: 5,
  dipAtrMult: 5,
  volDryMult: 5,
  minStopPct: 0,
  maxStopAtrMult: 99,
};

function runBars(session, params) {
  const sd = new SessionData(session, 5);
  const ctx = new BarContext(sd, params);
  const out = [];
  for (let i = 0; i < session.candles.length; i++) {
    ctx.i = i;
    ctx.position = null;
    const sig = strategy.onBar(ctx);
    if (sig && sig.side) out.push({ i, sig });
  }
  return out;
}

describe("VWAP Pullback signal", () => {
  it("fires a long on the reclaim bar with a valid on-tick stop below entry", () => {
    const session = trendSession();
    const longs = runBars(session, PARAMS).filter((x) => x.sig.side === "long");
    expect(longs.length).toBeGreaterThan(0);

    const last = longs[longs.length - 1];
    const entry = session.candles[last.i].close;
    const { stop } = last.sig;
    expect(Number.isFinite(stop)).toBe(true);
    expect(stop).toBeLessThan(entry); // long stop is below price
    const tick = tickFor(entry);
    expect(Math.abs(stop / tick - Math.round(stop / tick))).toBeLessThan(1e-6); // on the NSE tick
    expect(last.sig.reason).toMatch(/VWAP/);
  });

  it("takes no trade when the opening gap exceeds maxGapPct", () => {
    // Same setup but a ~3% opening gap, with the default 2% gap cap.
    const firstOpen = 100 - 0.2;
    const gapped = trendSession(firstOpen / 1.03);
    const signals = runBars(gapped, { ...PARAMS, maxGapPct: 2 });
    expect(signals.length).toBe(0);
  });
});
