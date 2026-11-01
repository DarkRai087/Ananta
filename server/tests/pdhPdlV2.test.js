// PDH/PDL v2 + fade + dedupe: previous TRADING day (not calendar), session VWAP reference, open
// classification, closed-candle one-trade-per-side-per-day, tick-rounded stops, net-of-cost sizing.
import { describe, it, expect } from "vitest";
import pdhV2 from "../strategies/pdhPdlV2.js";
import fade from "../strategies/pdhPdlFade.js";
import { markDuplicateSignals } from "../plans/dedupe.js";
import { runSession } from "../backtest/engine.js";
import { settingsWithDefaults } from "../backtest/run.js";
import { resolveParams } from "../strategies/index.js";
import { buildSessions, sessionVwap } from "../lab/sessions.js";
import { SessionData, BarContext } from "../lab/sessionData.js";
import { tickFor } from "../decision/util.js";
import { makeCandles, randomSessions, flat } from "./helpers.js";

const settings = settingsWithDefaults({});
const onTick = (x) => Math.abs(x / tickFor(x) - Math.round(x / tickFor(x))) < 1e-6;
const flatVol = (n, p) => flat(n, p).map((b) => [b[0], b[1], b[2], b[3], 1000]);

describe("previous trading day + session VWAP reference", () => {
  // Friday then Monday — the weekend has no candles, so Monday's 'previous day' is Friday.
  const fri = makeCandles("2025-01-10", flatVol(20, 100));
  const mon = makeCandles("2025-01-13", flatVol(20, 101));
  const sessions = buildSessions([...fri, ...mon]);
  it("prev is the previous NSE session, not the previous calendar day", () => {
    expect(sessions[1].prev.date).toBe("2025-01-10");
  });
  it("ctx.ref.pdVwap equals the prior session's VWAP", () => {
    const ctx = new BarContext(new SessionData(sessions[1], 5), {});
    expect(ctx.ref.pdVwap).toBeCloseTo(sessionVwap(sessions[0].candles), 6);
  });
});

describe("open classification", () => {
  // 15 flat prior days at 100 (PDH ≈ 100.01, daily ATR tiny), then a day that opens at 102 = gap up.
  const prior = Array.from({ length: 15 }, (_, k) => makeCandles(`2025-02-${String(3 + k).padStart(2, "0")}`, flatVol(20, 100))).flat();
  const gapUpToday = makeCandles("2025-02-24", Array.from({ length: 15 }, () => [102, 102.1, 101.9, 102, 1000]));
  const sessions = buildSessions([...prior, ...gapUpToday]);
  it("tags a gap-up open", () => {
    const ctx = new BarContext(new SessionData(sessions[sessions.length - 1], 5), resolveParams(pdhV2));
    ctx.i = 14;
    expect(pdhV2.plan(ctx).note).toContain("GAP_UP");
  });
});

describe("engine invariants + one-trade-per-side-per-day", () => {
  const sessions = buildSessions(randomSessions(60, 9).flatMap((d) => makeCandles(d.date, d.bars))).filter((s) => !s.special).slice(1);
  const params = resolveParams(pdhV2, { useRvol: false, useVwapSide: false, useMarketVwap: false, useAdrSkip: false, acceptance: "hold", holdBars: 0, bufferAtr: 0 });
  const byDay = {};
  let trades = [];
  for (const s of sessions) {
    const sd = new SessionData(s, 5, `T|5m|${s.date}`);
    const r = runSession({ session: s, symbol: "T", strategy: pdhV2, params, settings, intervalMin: 5, sd });
    byDay[s.date] = r.trades;
    trades = trades.concat(r.trades);
  }
  it("produces trades", () => expect(trades.length).toBeGreaterThan(0));
  it("at most one long and one short per day", () => {
    for (const [, ts] of Object.entries(byDay)) {
      expect(ts.filter((t) => t.side === "long").length).toBeLessThanOrEqual(1);
      expect(ts.filter((t) => t.side === "short").length).toBeLessThanOrEqual(1);
    }
  });
  it("net of costs, sized ≥ 1 share, tick-aligned stop", () => {
    for (const t of trades) {
      expect(t.costs).toBeGreaterThan(0);
      expect(t.net).toBeCloseTo(t.gross - t.costs, 6);
      expect(t.qty).toBeGreaterThanOrEqual(1);
      expect(onTick(t.initialStop)).toBe(true);
    }
  });
});

describe("fade fires on a single-bar failed breakout", () => {
  // Prior day high ≈ 100.01; today a bar pokes to 101 but closes back at 99.9 (failed PDH breakout).
  // Prior day: high 101, low 99, close 100 → PDH 101, prev close 100.
  const prior = [[100, 101, 99, 100, 1000], ...Array.from({ length: 19 }, () => [100, 100.01, 99.99, 100, 1000])];
  // Today drifts up toward PDH (VWAP ~100.4), then a bar pokes to 101.5 and closes back at 100.7.
  const today = Array.from({ length: 13 }, (_, k) => [100 + k * 0.06, 100 + k * 0.06 + 0.05, 100 + k * 0.06 - 0.05, 100 + k * 0.06 + 0.02, 1000]);
  today.push([100.74, 101.5, 100.6, 100.7, 3000]);
  const sessions = buildSessions([...makeCandles("2025-03-10", prior), ...makeCandles("2025-03-11", today)]);
  it("shorts the sweep", () => {
    const ctx = new BarContext(new SessionData(sessions[1], 5), resolveParams(fade, { rvolMult: 0, bufferAtr: 0.1 }));
    ctx.i = 13;
    const sig = fade.onBar(ctx);
    expect(sig?.side).toBe("short");
    expect(sig.stop).toBeGreaterThan(ctx.bar().close);
    expect(onTick(sig.stop)).toBe(true);
  });
});

describe("cross-strategy dedupe", () => {
  it("tags a second strategy's same-side/same-price setup as a duplicate", () => {
    const plans = [
      { id: "pdhPdlV2", status: "watching", setups: [{ side: "long", trigger: 100 }] },
      { id: "volumeBreakoutV2", status: "watching", setups: [{ side: "long", trigger: 100.05 }] },
      { id: "orb", status: "watching", setups: [{ side: "short", trigger: 100 }] },
    ];
    markDuplicateSignals(plans, { tolPct: 0.1 });
    expect(plans[1].setups[0].duplicateOf).toBe("pdhPdlV2");
    expect(plans[1].hasDuplicate).toBe(true);
    expect(plans[2].setups[0].duplicateOf).toBeUndefined(); // different side → not a duplicate
  });
});
