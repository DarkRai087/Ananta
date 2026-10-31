// Spec 9.9: the ORB rule over real past sessions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTimeMachine } from "../src/index.js";
import { runHistory } from "../src/history.js";
import { findEntry } from "../src/strategies/orb.js";
import { slotTime } from "../src/time.js";
import { constSessions, UP, DOWN, G } from "./fixtures.js";

const PLAN = { date: "2026-10-01", entry: 100, stop: 99, target: 101, entryTime: "10:15" };
const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-6, `${what}: ${a} vs ${b}`);
const pick = (h, keys) => Object.fromEntries(keys.map((k) => [k, h[k]]));

test("T35 UP: every session fires and hits the target", () => {
  const h = runTimeMachine(PLAN, constSessions(20, "2026-09-01", UP)).history;
  assert.deepEqual(pick(h, ["fired", "target", "stop", "neither", "notFired", "avgR"]), { fired: 20, target: 20, stop: 0, neither: 0, notFired: 0, avgR: 1 });
  const t = h.trades[0];
  assert.equal(t.date, "2026-09-01");
  assert.equal(t.slot, 3);
  assert.equal(slotTime(t.slot + 1), "09:35");
  near(t.entry, 100.40060040009996, "entry");
  near(t.stop, 100.15015004999998, "stop");
  near(t.target, 100.65105075019994, "target");
  assert.equal(t.outcome, "target");
});

test("T36 DOWN: never fires", () => {
  const h = runTimeMachine(PLAN, constSessions(20, "2026-09-01", DOWN)).history;
  assert.deepEqual(pick(h, ["fired", "notFired", "winRate", "avgR"]), { fired: 0, notFired: 20, winRate: null, avgR: 0 });
});

const T37 = `
2026-09-01 09:40 stop      2026-09-15 11:15 target    2026-10-01 09:35 stop
2026-09-02 09:35 target    2026-09-16 14:00 stop      2026-10-02 10:15 stop
2026-09-03 09:40 stop      2026-09-17 12:30 target    2026-10-05 10:50 target
2026-09-04 09:35 target    2026-09-18 09:40 stop      2026-10-07 10:55 target
2026-09-07 11:35 target    2026-09-21 10:05 stop      2026-10-08 10:20 target
2026-09-08 10:05 stop      2026-09-22 09:35 stop      2026-10-12 10:35 stop
2026-09-09 09:50 stop      2026-09-24 11:40 stop
2026-09-10 09:35 stop      2026-09-25 09:35 target
2026-09-14 13:05 target`;
const expected = T37.match(/\S+ \S+ \S+/g).sort();

test("T37 fixture G, or-mid, 1R", () => {
  const h = runTimeMachine({ date: "2026-10-13", entry: 1000, stop: 995, target: 1005, entryTime: "10:15" }, G).history;
  assert.deepEqual(pick(h, ["sessions", "fired", "target", "stop", "neither", "notFired"]), { sessions: 30, fired: 23, target: 10, stop: 13, neither: 0, notFired: 7 });
  near(h.avgR, -0.13043478260869565, "avgR");
  assert.deepEqual(h.trades.map((t) => `${t.date} ${slotTime(t.slot + 1)} ${t.outcome}`), expected);
});

test("T38 fixture G, or-low, 2R", () => {
  const h = runHistory(G, findEntry, { stopRule: "or-low", targetR: 2 });
  assert.deepEqual(pick(h, ["fired", "target", "stop", "neither"]), { fired: 23, target: 4, stop: 17, neither: 2 });
  near(h.avgR, -0.2923293843285019, "avgR");
});
