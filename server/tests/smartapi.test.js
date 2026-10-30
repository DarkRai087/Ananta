import { describe, it, expect } from "vitest";
import { splitRange, parseRows, fmt } from "../data/providers/smartapi/index.js";
import { RateLimiter } from "../data/providers/smartapi/client.js";
import { SMARTAPI } from "../config/smartapi.js";
import { istEpoch } from "../lab/time.js";

describe("SmartAPI request chunking", () => {
  it("splits a range into chunks no longer than maxDaysPerRequest", () => {
    const from = istEpoch("2024-01-01", "09:15");
    const to = istEpoch("2024-12-31", "15:30");
    for (const [iv, cfg] of Object.entries(SMARTAPI.intervals)) {
      const chunks = splitRange(from, to, cfg.maxDaysPerRequest);
      expect(chunks[0].from).toBe(from);
      expect(chunks[chunks.length - 1].to).toBe(to);
      for (const c of chunks) expect(c.to - c.from).toBeLessThanOrEqual(cfg.maxDaysPerRequest * 86400);
      for (let k = 1; k < chunks.length; k++) expect(chunks[k].from).toBeGreaterThan(chunks[k - 1].to);
      expect(chunks.length, iv).toBe(Math.ceil((to - from) / (cfg.maxDaysPerRequest * 86400)));
    }
  });
  it("uses the documented limits", () => {
    expect(SMARTAPI.intervals["1m"].maxDaysPerRequest).toBe(30);
    expect(SMARTAPI.intervals["3m"].maxDaysPerRequest).toBe(60);
    expect(SMARTAPI.intervals["5m"].maxDaysPerRequest).toBe(100);
    expect(SMARTAPI.intervals["15m"].maxDaysPerRequest).toBe(200);
    expect(SMARTAPI.rateLimits.candles).toEqual({ perSecond: 2, perMinute: 80, perHour: 5000 });
  });
  it("formats dates as yyyy-MM-dd HH:mm in IST", () => {
    expect(fmt(istEpoch("2024-03-05", "09:15"))).toBe("2024-03-05 09:15");
  });
  it("parses candle rows", () => {
    const rows = parseRows([["2023-09-06T11:15:00+05:30", 19571.2, 19573.35, 19534.4, 19552.05, 0]]);
    expect(rows).toEqual([{ time: istEpoch("2023-09-06", "11:15"), open: 19571.2, high: 19573.35, low: 19534.4, close: 19552.05, volume: 0 }]);
  });
});

describe("rate limiter", () => {
  it("waits once the per-second / per-minute window is full", () => {
    let now = 0;
    const rl = new RateLimiter({ perSecond: 2, perMinute: 3 }, () => now);
    expect(rl.waitMs()).toBe(0);
    rl.stamps.push(0, 10);
    expect(rl.waitMs()).toBeGreaterThan(900); // 2 in the last second
    now = 1500;
    rl.stamps.push(1500);
    expect(rl.waitMs()).toBeGreaterThan(55_000); // 3 in the last minute
    now = 60_100;
    expect(rl.waitMs()).toBe(0);
  });
  it("keeps requests at least minGapMs apart", () => {
    let now = 0;
    const rl = new RateLimiter({ perSecond: 2, minGapMs: 600 }, () => now);
    rl.stamps.push(0);
    expect(rl.waitMs()).toBe(600); // a 2nd request in the same second is allowed, but not this soon
    now = 600;
    expect(rl.waitMs()).toBe(0);
    rl.stamps.push(600);
    now = 700;
    expect(rl.waitMs()).toBe(500); // the gap, which here is longer than the per-second wait (305)
  });
  it("adds a safety gap on candle requests", () => {
    expect(SMARTAPI.candleSafety.minGapMs).toBeGreaterThanOrEqual(500);
    expect(SMARTAPI.candleSafety.spareMinute).toBeGreaterThan(0);
  });
});
