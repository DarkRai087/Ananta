// Index link: bar alignment (no lookahead), the engine's index filter, and relation stats.
import { describe, it, expect } from "vitest";
import { attachIndex, indexDirs, blockReason, indexState } from "../market/indexLink.js";
import { dailyRelation } from "../market/relation.js";
import { runSession } from "../backtest/engine.js";
import { LAB } from "../config/lab.js";
import { makeSession, flat } from "./helpers.js";

const prev = { high: 101, low: 99, close: 100 };

describe("index direction", () => {
  it("up only when above both VWAP and yesterday's close (rule 'both')", () => {
    const ix = makeSession("2025-01-06", [[100, 101, 100, 101], [101, 102, 101, 102], [102, 102, 99, 99.5]], prev);
    expect(indexDirs(ix, "both")).toEqual([1, 1, -1]);
    expect(indexDirs(ix, "dayChange")).toEqual([1, 1, -1]);
  });

  it("each stock bar gets the index bar that closed with it, never a later one", () => {
    const ix = makeSession("2025-01-06", [[100, 101, 100, 101], [101, 101, 98, 98.5], [98.5, 99, 98, 98.2]], prev);
    const stock = makeSession("2025-01-06", flat(3), prev);
    attachIndex([stock], [ix], { indexId: "NIFTY50" });
    const full = [...stock.indexDir];
    // Remove the index's later bars: earlier directions must not change.
    const cut = { ...ix, candles: ix.candles.slice(0, 2) };
    const stock2 = makeSession("2025-01-06", flat(3), prev);
    attachIndex([stock2], [cut], { indexId: "NIFTY50" });
    expect(stock2.indexDir.slice(0, 2)).toEqual(full.slice(0, 2));
    expect(full[0]).toBe(1);
    expect(full[1]).toBe(-1);
  });

  it("no index data that day → no direction", () => {
    const stock = makeSession("2025-01-07", flat(3), prev);
    attachIndex([stock], [], { indexId: "NIFTY50" });
    expect(stock.indexDir).toBeNull();
  });

  it("explains a blocked side", () => {
    const ix = makeSession("2025-01-06", [[100, 100, 98, 98.5]], prev);
    const st = indexState(ix, "NIFTY50");
    expect(st.allows).toBe("short");
    expect(blockReason("short", st)).toBeNull();
    expect(blockReason("long", st)).toMatch(/NIFTY 50 is down/);
  });
});

describe("engine index filter", () => {
  const settings = { ...LAB.backtest, slippagePct: 0, maxDailyLoss: 0 };
  const params = { allowLong: true, allowShort: true, entryStart: "09:15", entryEnd: "14:45", stopType: "structure", atrPeriod: 14, atrMult: 1.5, stopPct: 0.5, targetR: 2 };
  const strategy = { id: "t", warmup: () => 0, onBar: (ctx) => (ctx.i === 2 ? { side: "long", stop: 99 } : null) };
  const run = (dir, indexFilter) => {
    const session = makeSession("2025-01-06", flat(10), prev);
    session.indexDir = new Array(10).fill(dir);
    return runSession({ session, symbol: "T", strategy, params, settings: { ...settings, indexFilter }, intervalMin: 5 });
  };
  it("blocks a long while the index is down", () => {
    expect(run(-1, "sector").trades).toHaveLength(0);
    expect(run(-1, "sector").filtered).toBe(1);
  });
  it("allows it while the index is up, or with the filter off", () => {
    expect(run(1, "sector").trades).toHaveLength(1);
    expect(run(-1, "off").trades).toHaveLength(1);
  });
});

describe("daily relation", () => {
  it("a share that moves exactly with the index: corr 1, beta 1, same direction every day", () => {
    const ix = Array.from({ length: 60 }, (_, k) => ({ time: k * 86400, close: 100 * (1 + 0.01 * Math.sin(k)) }));
    const r = dailyRelation(ix.map((b) => ({ ...b })), ix);
    expect(r.corr).toBeCloseTo(1);
    expect(r.beta).toBeCloseTo(1);
    expect(r.downWhenDown).toBe(1);
    expect(r.upWhenUp).toBe(1);
  });
});
