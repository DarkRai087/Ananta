// Lookahead guard: no strategy or pattern may use bars after i.
//  1. The BarContext throws LookaheadError on any read beyond i (and records the max index read).
//  2. Truncation test: the decision at bar i must be identical whether or not the future bars
//     of the session exist. This also catches indirect leaks (e.g. an indicator that peeks ahead).
import { describe, it, expect } from "vitest";
import { STRATEGIES } from "../strategies/index.js";
import { DETECTORS } from "../patterns/index.js";
import { SessionData, BarContext, LookaheadError } from "../lab/sessionData.js";
import { buildSessions } from "../lab/sessions.js";
import { makeCandles, randomSessions } from "./helpers.js";

const days = randomSessions(30, 11);
const sessions = buildSessions(days.flatMap((d) => makeCandles(d.date, d.bars))).slice(1); // all have prev

// testParams: a strict strategy can loosen thresholds here so its entry path still runs on random data.
const paramsOf = (strategy) => ({ ...strategy.params, ...(strategy.testParams || {}) });

function decide(strategy, session, i, position = null) {
  const sd = new SessionData(session, 5);
  const ctx = new BarContext(sd, paramsOf(strategy));
  ctx.i = i;
  ctx.position = position;
  const sig = strategy.onBar(ctx);
  return { sig, maxRead: ctx.maxRead };
}

describe("BarContext blocks reads beyond the current bar", () => {
  const sd = new SessionData(sessions[0], 5);
  const ctx = new BarContext(sd, {});
  ctx.i = 10;
  it("bar(i+1) throws", () => expect(() => ctx.bar(11)).toThrow(LookaheadError));
  it("ind(…, ago < 0) throws", () => expect(() => ctx.ind("ema", [9], -1)).toThrow(LookaheadError));
  it("minute(i+1) throws", () => expect(() => ctx.minute(11)).toThrow(LookaheadError));
  it("opening range is hidden until it completes", () => {
    ctx.i = 1;
    expect(ctx.openingRange(15)).toBeNull();
    ctx.i = 2;
    expect(ctx.openingRange(15)).not.toBeNull();
  });
});

describe.each(STRATEGIES.map((s) => [s.name, s]))("strategy %s", (_name, strategy) => {
  it("never reads beyond bar i and decides the same without future bars", () => {
    let signals = 0;
    for (const s of sessions) {
      for (let i = 0; i < s.candles.length; i++) {
        const truncated = { ...s, candles: s.candles.slice(0, i + 1) };
        for (const position of [null, { side: "long", entry: s.candles[i].close, stop: 0, target: null, entryIndex: 0 }]) {
          const full = decide(strategy, s, i, position);
          const cut = decide(strategy, truncated, i, position);
          expect(full.maxRead).toBeLessThanOrEqual(i);
          expect(full.sig).toEqual(cut.sig);
          if (full.sig && !position) signals++;
        }
      }
    }
    // Make sure the test actually exercised the strategy.
    expect(signals).toBeGreaterThan(0);
  });
});

describe("patterns", () => {
  it.each(DETECTORS.map((d) => [d.id, d]))("%s gives the same answer at bar i with or without future bars", (_id, det) => {
    for (const s of sessions.slice(0, 10)) {
      for (let i = 0; i < s.candles.length; i++) {
        const a = det.detect(s.candles, i);
        const b = det.detect(s.candles.slice(0, i + 1), i);
        expect(a).toEqual(b);
      }
    }
  });
});

// The guards themselves must catch cheaters.
describe("the lookahead guards catch a cheating strategy", () => {
  const s = sessions[0];
  it("direct read of the next bar throws", () => {
    const cheat = { params: {}, onBar: (ctx) => (ctx.bar(ctx.i + 1)?.close > ctx.bar().close ? { side: "long" } : null) };
    expect(() => decide(cheat, s, 5)).toThrow(LookaheadError);
  });
  it("sneaking past the guard (ctx.sd.candles) is caught by the truncation test", () => {
    const cheat = {
      params: {},
      onBar: (ctx) => {
        const next = ctx.sd.candles[ctx.i + 1];
        return next && next.close > ctx.sd.candles[ctx.i].close ? { side: "long" } : null;
      },
    };
    let differs = false;
    for (let i = 0; i < s.candles.length - 1; i++) {
      const full = decide(cheat, s, i).sig;
      const cut = decide(cheat, { ...s, candles: s.candles.slice(0, i + 1) }, i).sig;
      if (JSON.stringify(full) !== JSON.stringify(cut)) differs = true;
    }
    expect(differs).toBe(true);
  });
});
