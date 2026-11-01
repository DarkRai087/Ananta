// 9/21 EMA Crossover: the STEP 2 filters gate (never add trades, an impossible threshold removes
// them all, market-VWAP degrades gracefully offline), the HTF filter never looks ahead, and the
// EMA trailing stop only tightens.
import { describe, it, expect } from "vitest";
import { runSession } from "../backtest/engine.js";
import { settingsWithDefaults } from "../backtest/run.js";
import { getStrategy, resolveParams } from "../strategies/index.js";
import { SessionData, BarContext } from "../lab/sessionData.js";
import { buildSessions } from "../lab/sessions.js";
import { makeCandles, randomSessions } from "./helpers.js";

const ema = getStrategy("emaCross");
const settings = settingsWithDefaults({});
const sessions = buildSessions(randomSessions(60, 7).flatMap((d) => makeCandles(d.date, d.bars))).filter((s) => !s.special).slice(1);

const tradesFor = (params) => {
  let trades = [];
  for (const s of sessions) {
    const sd = new SessionData(s, 5, `T|5m|${s.date}`);
    const r = runSession({ session: s, symbol: "T", strategy: ema, params: resolveParams(ema, params), settings, intervalMin: 5, sd });
    trades = trades.concat(r.trades);
  }
  return trades;
};

describe("emaCross filters", () => {
  const base = tradesFor({}).length;

  it("the base strategy fires (sanity)", () => expect(base).toBeGreaterThan(0));

  it("each filter only ever removes trades, never adds them", () => {
    for (const p of [{ useRegime: true }, { useHtf: true }, { useRelVol: true }, { useMarketVwap: true }]) {
      expect(tradesFor(p).length).toBeLessThanOrEqual(base);
    }
  });

  it("an impossible regime threshold blocks every entry", () => {
    expect(tradesFor({ useRegime: true, adxMin: 1000 }).length).toBe(0);
  });

  it("market-VWAP passes when no index is attached (offline backtest still runs)", () => {
    // Sessions here have no .market, so the filter can't judge and must not block.
    expect(tradesFor({ useMarketVwap: true }).length).toBe(base);
  });
});

describe("emaCross HTF filter has no lookahead", () => {
  it("decides the same with or without the future bars of the session", () => {
    const params = resolveParams(ema, { useHtf: true });
    for (const s of sessions.slice(0, 15)) {
      for (let i = 0; i < s.candles.length; i++) {
        const full = new BarContext(new SessionData(s, 5), params);
        const cut = new BarContext(new SessionData({ ...s, candles: s.candles.slice(0, i + 1) }, 5), params);
        full.i = cut.i = i;
        expect(ema.onBar(full)).toEqual(ema.onBar(cut));
        expect(full.maxRead).toBeLessThanOrEqual(i);
      }
    }
  });
});

describe("EMA trailing stop", () => {
  it("only tightens: a trailed long exits above its initial stop", () => {
    let checked = 0;
    for (const s of sessions) {
      const sd = new SessionData(s, 5, `T|5m|${s.date}`);
      const r = runSession({ session: s, symbol: "T", strategy: ema, params: resolveParams(ema, { trailType: "ema", trailEmaPeriod: 21 }), settings, intervalMin: 5, sd });
      for (const t of r.trades.filter((t) => t.reason === "trail")) {
        if (t.side === "long") expect(t.stop).toBeGreaterThan(t.initialStop);
        else expect(t.stop).toBeLessThan(t.initialStop);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
