// Trade plans: the engine's live mode, the shared stop/target rules, and every strategy's
// plan() hook (no lookahead, sane output, and agreement with onBar for a simple breakout).
import { describe, it, expect } from "vitest";
import { STRATEGIES, getStrategy } from "../strategies/index.js";
import { runSession, bracket } from "../backtest/engine.js";
import { SessionData, BarContext } from "../lab/sessionData.js";
import { buildSessions } from "../lab/sessions.js";
import { LAB } from "../config/lab.js";
import { makeCandles, makeSession, randomSessions, flat } from "./helpers.js";

const settings = { ...LAB.backtest, slippagePct: 0, maxDailyLoss: 0 };
const params = { allowLong: true, allowShort: true, entryStart: "09:15", entryEnd: "14:45", stopType: "structure", atrPeriod: 14, atrMult: 1.5, stopPct: 0.5, targetR: 2 };
const scripted = (signals) => ({ id: "test", warmup: () => 0, onBar: (ctx) => signals[ctx.i] ?? null });

describe("engine live mode", () => {
  const run = (bars, signals, live) =>
    runSession({ session: makeSession("2025-01-06", bars), symbol: "T", strategy: scripted(signals), params, settings, intervalMin: 5, live });

  it("returns an open position instead of closing it at the last bar", () => {
    const bars = [...flat(3), ...flat(5, 100.5)];
    const r = run(bars, { 2: { side: "long", stop: 99 } }, true);
    expect(r.trades).toHaveLength(0);
    expect(r.open).toMatchObject({ side: "long", entry: 100.5, stop: 99, target: 103.5 });
  });

  it("returns a signal on the last completed bar as pending", () => {
    const r = run(flat(5), { 4: { side: "short", stop: 101, reason: "x" } }, true);
    expect(r.pending).toMatchObject({ type: "entry", sig: { side: "short", stop: 101 } });
  });

  it("backtest mode still drops the last-bar signal and force-closes", () => {
    const r = run(flat(5), { 2: { side: "long", stop: 99 }, 4: { side: "short", stop: 101 } }, false);
    expect(r.pending).toBeNull();
    expect(r.open).toBeNull();
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].outcome).toBe("forced");
  });
});

describe("bracket() — the backtest's stop/target rules", () => {
  it("structure stop with an R target", () => {
    expect(bracket("long", 100, { stop: 98 }, { ...params, targetR: 2 }, null)).toEqual({ stop: 98, target: 104, riskPerShare: 2 });
  });
  it("strategy target when targetR = 0, ignored if on the wrong side", () => {
    expect(bracket("short", 100, { stop: 101, target: 97 }, { ...params, targetR: 0 }, null).target).toBe(97);
    expect(bracket("short", 100, { stop: 101, target: 103 }, { ...params, targetR: 0 }, null).target).toBeNull();
  });
  it("ATR and percent stops", () => {
    expect(bracket("long", 100, {}, { ...params, stopType: "atr", atrMult: 2 }, 1.5).stop).toBe(97);
    expect(bracket("short", 100, {}, { ...params, stopType: "percent", stopPct: 1 }, null).stop).toBe(101);
  });
  it("no trade when the stop is on the wrong side", () => {
    expect(bracket("long", 100, { stop: 100.5 }, params, null)).toBeNull();
  });
});

const days = randomSessions(25, 5);
const sessions = buildSessions(days.flatMap((d) => makeCandles(d.date, d.bars))).slice(1);

function planAt(strategy, session, i) {
  const sd = new SessionData(session, 5);
  const ctx = new BarContext(sd, strategy.params);
  ctx.i = i;
  const plan = strategy.plan(ctx);
  return { plan, maxRead: ctx.maxRead };
}

describe.each(STRATEGIES.map((s) => [s.name, s]))("plan() of %s", (_name, strategy) => {
  it("exists, never reads ahead, and gives finite prices", () => {
    expect(typeof strategy.plan).toBe("function");
    const statuses = new Set();
    for (const s of sessions.slice(0, 12)) {
      for (let i = -1; i < s.candles.length; i += 3) {
        const cut = { ...s, candles: s.candles.slice(0, i + 1) };
        const a = planAt(strategy, cut, i);
        const b = planAt(strategy, s, i);
        expect(b.maxRead).toBeLessThanOrEqual(i);
        expect(b.plan).toEqual(a.plan);
        statuses.add(a.plan.status);
        expect(["watching", "armed", "waiting", "off"]).toContain(a.plan.status);
        for (const x of a.plan.setups) {
          expect(["long", "short"]).toContain(x.side);
          expect(Number.isFinite(x.trigger)).toBe(true);
          if (x.stop != null) expect(Number.isFinite(x.stop)).toBe(true);
          expect(typeof x.when).toBe("string");
        }
      }
    }
    expect(statuses.size).toBeGreaterThan(0);
  });
});

describe("plan agrees with onBar", () => {
  it("ORB: a bare close above the range is not a trade — the plan shows the range, no prices", () => {
    const orb = getStrategy("orb");
    // 09:15–09:25 build a 99–101 range, then one bar closes above it (no acceptance, retest,
    // momentum volume or score yet). The full ORB engine is tested in orbEngine.test.js.
    const bars = [[100, 101, 99, 100], [100, 100.8, 99.5, 100.2], [100.2, 100.9, 99.8, 100.4], [100.4, 101.3, 100.3, 101.2]];
    const session = makeSession("2025-01-06", bars, { high: 102, low: 98, close: 100 });
    const ctx = new BarContext(new SessionData(session, 5), orb.params);
    ctx.i = 2;
    const plan = orb.plan(ctx);
    expect(plan.status).toBe("watching");
    expect(plan.setups).toEqual([]);
    expect(plan.note).toMatch(/OR 99\.00–101\.00/);
    ctx.i = 3;
    expect(orb.onBar(ctx)).toBeNull();
  });

  it("EMA cross: closing exactly past the planned price makes the EMAs cross", () => {
    const ema = getStrategy("emaCross");
    const rnd = randomSessions(3, 9)[2];
    const session = makeSession("2025-01-08", rnd.bars.slice(0, 40), { high: 1, low: 1, close: 1 });
    const sd = new SessionData(session, 5);
    const ctx = new BarContext(sd, ema.params);
    ctx.i = 38;
    const [s] = ema.plan(ctx).setups;
    // Rebuild bar 39 so it closes 0.01% beyond the planned trigger.
    const c = s.trigger * (s.side === "long" ? 1.0001 : 0.9999);
    const bars2 = [...rnd.bars.slice(0, 39), [c, Math.max(c, rnd.bars[38][3]), Math.min(c, rnd.bars[38][3]), c]];
    const s2 = makeSession("2025-01-08", bars2, session.prev);
    const ctx2 = new BarContext(new SessionData(s2, 5), ema.params);
    ctx2.i = 39;
    expect(ema.onBar(ctx2)).toMatchObject({ side: s.side });
  });
});

describe("account sizing", async () => {
  const { accountSettings } = await import("../backtest/account.js");
  const { targetForProfit } = await import("../backtest/engine.js");
  const { tradeCosts } = await import("../backtest/costs.js");

  it("turns capital / risk % / profit % into settings", () => {
    const { account, settings } = accountSettings({ capital: 200000, riskPct: 1, profitPct: 3, leverage: 2 });
    expect(settings).toEqual({ riskPerTrade: 2000, maxPositionValue: 400000, maxDailyLoss: 6000, profitTarget: 6000, indexFilter: "off" });
    expect(account.targetR).toBeCloseTo(3);
  });

  it("no capital or risk → backtest defaults", () => {
    expect(accountSettings({ capital: "", riskPct: 1 }).settings).toEqual({});
  });

  it.each([["long"], ["short"]])("targetForProfit leaves exactly the profit after costs (%s)", (side) => {
    const entry = 1500;
    const qty = 40;
    const t = targetForProfit(side, entry, qty, 2500);
    const long = side === "long";
    const gross = (long ? t - entry : entry - t) * qty;
    const costs = long ? tradeCosts(entry * qty, t * qty).total : tradeCosts(t * qty, entry * qty).total;
    expect(gross - costs).toBeCloseTo(2500, 1);
  });

  it("the engine exits at the profit target when one is set", () => {
    // Long at 100 (stop 99, risk ₹1,000 → 1,000 shares), then a bar runs to 103.
    const bars = [...flat(3), [100, 100.2, 99.9, 100.1], [100.1, 103, 100, 102.5], ...flat(5, 102)];
    const r = runSession({
      session: makeSession("2025-01-06", bars),
      symbol: "T",
      strategy: scripted({ 2: { side: "long", stop: 99 } }),
      params,
      settings: { ...settings, profitTarget: 1500 },
      intervalMin: 5,
    });
    expect(r.trades[0].reason).toBe("target");
    expect(r.trades[0].net).toBeCloseTo(1500, 0);
  });
});
