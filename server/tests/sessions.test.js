import { describe, it, expect } from "vitest";
import { buildSessions, aggregateMinutes, isSessionCandle, registerSpecialDate } from "../lab/sessions.js";
import { istEpoch, istHHMM, timeBucket, hhmmToMin } from "../lab/time.js";
import { makeCandles } from "./helpers.js";
import { LAB } from "../config/lab.js";

const bar = (date, hhmm, o, h, l, c) => ({ time: istEpoch(date, hhmm), open: o, high: h, low: l, close: c, volume: 10 });

describe("buildSessions", () => {
  const candles = [
    bar("2025-01-06", "09:00", 1, 1, 1, 1), // pre-open → dropped
    bar("2025-01-06", "09:15", 100, 105, 99, 104),
    bar("2025-01-06", "15:25", 104, 106, 98, 101),
    bar("2025-01-06", "15:30", 101, 101, 101, 101), // post-close → dropped
    bar("2025-01-07", "09:15", 102, 103, 101, 102),
  ];
  const s = buildSessions(candles);

  it("keeps only 09:15–15:30 candles, one session per IST day", () => {
    expect(s.map((x) => x.date)).toEqual(["2025-01-06", "2025-01-07"]);
    expect(s[0].candles.map((c) => istHHMM(c.time))).toEqual(["09:15", "15:25"]);
  });
  it("derives prior-day H/L/C from the previous session's intraday candles", () => {
    expect(s[0].prev).toBeNull();
    expect(s[1].prev).toMatchObject({ date: "2025-01-06", high: 106, low: 98, close: 101 });
  });
  it("treats special (Muhurat) sessions as separate days, excluded from prior-day levels", () => {
    // 2024-11-01 is configured as Muhurat 18:00–19:00.
    const more = [
      bar("2024-10-31", "09:15", 100, 110, 90, 105),
      bar("2024-11-01", "18:00", 200, 210, 190, 205),
      bar("2024-11-01", "09:15", 1, 1, 1, 1), // outside the special window → dropped
      bar("2024-11-04", "09:15", 106, 107, 104, 106),
    ];
    const ss = buildSessions(more);
    expect(ss.map((x) => [x.date, x.special])).toEqual([["2024-10-31", false], ["2024-11-01", true], ["2024-11-04", false]]);
    expect(ss[1].candles).toHaveLength(1);
    expect(ss[2].prev).toMatchObject({ date: "2024-10-31", high: 110 });
  });
  it("history holds earlier regular days only, oldest first, capped at LAB.historyDays", () => {
    expect(s[0].history).toEqual([]);
    expect(s[1].history).toEqual([s[1].prev]);
    const days = Array.from({ length: LAB.historyDays + 5 }, (_, k) => {
      const d = new Date(Date.UTC(2025, 1, 3 + k)).toISOString().slice(0, 10);
      return bar(d, "09:15", 100 + k, 101 + k, 99 + k, 100 + k);
    });
    const ss = buildSessions(days);
    const last = ss[ss.length - 1];
    expect(last.history).toHaveLength(LAB.historyDays);
    expect(last.history[last.history.length - 1]).toEqual(last.prev);
    expect(last.history.every((d, k) => k === 0 || d.date > last.history[k - 1].date)).toBe(true);
    expect(last.history.every((d) => d.date < last.date)).toBe(true);
  });
  it("registered special dates (NSE '*' holidays) keep the whole day", () => {
    registerSpecialDate("2030-11-03", "Muhurat");
    expect(isSessionCandle(istEpoch("2030-11-03", "18:30"))).toBe(true);
    expect(isSessionCandle(istEpoch("2030-11-04", "18:30"))).toBe(false);
  });
});

describe("aggregateMinutes", () => {
  it("builds 3m bars aligned to 09:15 from 1m bars", () => {
    const ones = makeCandles("2025-01-06", [[1, 2, 0.5, 1.5, 1], [1.5, 3, 1, 2, 1], [2, 2.5, 1.8, 2.2, 1], [2.2, 2.4, 2, 2.1, 1]], 1);
    const threes = aggregateMinutes(ones, 3);
    expect(threes).toHaveLength(2);
    expect(threes[0]).toMatchObject({ open: 1, high: 3, low: 0.5, close: 2.2, volume: 3 });
    expect(istHHMM(threes[1].time)).toBe("09:18");
  });
});

describe("time buckets", () => {
  it("maps minutes to the four intraday buckets", () => {
    expect(timeBucket(hhmmToMin("09:15"))).toBe("open");
    expect(timeBucket(hhmmToMin("10:30"))).toBe("morning");
    expect(timeBucket(hhmmToMin("12:00"))).toBe("midday");
    expect(timeBucket(hhmmToMin("15:10"))).toBe("late");
    expect(timeBucket(hhmmToMin("15:15"))).toBeNull();
  });
});
