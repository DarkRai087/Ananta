// Spec 8.3 checkpoints, 9.4 sessions, 9.5 plan, 9.6–9.8 Monte Carlo, 9.13 performance and purity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTimeMachine } from "../src/index.js";
import { runHistory } from "../src/history.js";
import { findEntry } from "../src/strategies/orb.js";
import { verdict } from "../src/verdict.js";
import { constSessions, FLAT, UP, DOWN, BOTH, GAP, MORNING_UP, G } from "./fixtures.js";

const START = "2026-09-01";
const PLAN = { symbol: "TEST", date: "2026-10-01", entry: 100, stop: 99, target: 101, entryTime: "10:15", until: "15:15" };
const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-6, `${what}: ${a} vs ${b}`);
const COUNTS = new Set(["target", "stop", "neither", "green", "gapStops", "bars"]);

// Every run in this file also checks T34: target + stop + neither = replays.
function run(sessions, plan = {}, options) {
  const r = runTimeMachine({ ...PLAN, ...plan }, sessions, options);
  assert.equal(r.mc.target + r.mc.stop + r.mc.neither, r.mc.replays, "T34");
  return r;
}
function check(r, want, lines) {
  for (const [k, v] of Object.entries(want)) {
    const got = k === "bars" ? r.plan.bars : r.mc[k];
    COUNTS.has(k) ? assert.equal(got, v, k) : near(got, v, k);
  }
  if (lines) assert.deepEqual(r.verdict, lines);
}

test("fixture G checkpoints", () => {
  assert.equal(G[0].bars[0].o, 1000);
  near(G[0].bars[0].h, 1000.0619582575745, "h");
  near(G[0].bars[0].l, 997.0718194572476, "l");
  near(G[0].bars[0].c, 998.0468190126121, "c");
  near(G[0].bars[74].c, 1011.6633316657153, "G[0] close");
  near(G[29].bars[74].c, 1002.2609872602095, "G[29] close");
  assert.equal(G[29].date, "2026-10-12");
});

// ── 9.4 Session validation and lookahead ──
test("T9 19 valid sessions are refused", () => assert.throws(() => run(constSessions(19, START, FLAT)), { code: "INSUFFICIENT_SESSIONS" }));
test("T10 a 74-bar session is excluded and counted", () => {
  const s = constSessions(21, START, FLAT);
  s[20].bars.pop();
  const r = run(s);
  assert.equal(r.pool.sessions, 20);
  assert.equal(r.pool.excludedSessions, 1);
});
test("T11 a bar with h < max(o, c) excludes its session", () => {
  const s = constSessions(20, START, UP);
  s[5].bars[10].h = s[5].bars[10].c - 0.01;
  assert.throws(() => run(s), { code: "INSUFFICIENT_SESSIONS" });
});
test("T12 a missing 11:00 bar or a duplicated timestamp excludes the session", () => {
  const s = constSessions(22, START, FLAT);
  s[3].bars.splice(s[3].bars.findIndex((b) => b.t === "11:00"), 1);
  s[7].bars[20].t = s[7].bars[19].t;
  const r = run(s);
  assert.equal(r.pool.sessions, 20);
  assert.equal(r.pool.excludedSessions, 2);
});
test("T13 sessions on or after the plan date change nothing", () => {
  const plan = { date: "2026-10-13", entry: 1000, stop: 995, target: 1005 };
  assert.deepEqual(run([...G, ...constSessions(5, "2026-10-13", BOTH, 1000)], plan), run(G, plan));
});
test("T14 a session dated the plan date is excluded", () => {
  const s = constSessions(21, START, FLAT);
  const r = run(s, { date: s[20].date });
  assert.equal(r.pool.sessions, 20);
  assert.equal(r.pool.lastDate, s[19].date);
});

// ── 9.5 Plan validation ──
const S20 = constSessions(20, START, FLAT);
test("T15 broken prices are INVALID_PLAN", () => {
  for (const p of [{ stop: 100 }, { stop: 100.5 }, { target: 100 }, { target: 99.5 }, { entry: -100 }, { stop: -1 }, { entry: NaN }, { target: NaN }])
    assert.throws(() => run(S20, p), { code: "INVALID_PLAN" }, JSON.stringify(p));
});
test("T16 entry at the flat-by time", () => assert.throws(() => run(S20, { entryTime: "15:15" }), { code: "ENTRY_AFTER_UNTIL" }));
test("T17 entry bar closing 09:15", () => assert.throws(() => run(S20, { entryTime: "09:15" }), { code: "INVALID_PLAN" }));
test("T18 bars simulated", () => {
  assert.equal(run(S20).plan.bars, 60);
  assert.equal(run(S20, { until: "15:30" }).plan.bars, 63);
});

// ── 9.6 Deterministic fixtures ──
const NO_MOVE = ["No replay reached the stop or the target: not enough movement to judge."];
const MS = { stop: 90, target: 110 };
const DET = [
  ["T19", FLAT, {}, { target: 0, stop: 0, neither: 10000, green: 0, gapStops: 0, avgR: 0, median: 100 }, NO_MOVE],
  ["T20", UP, {}, { target: 10000, stop: 0, neither: 0, green: 10000, gapStops: 0, avgR: 1, median: 106.18047131469584 }, ["Strongly toward the target."]],
  ["T21", DOWN, {}, { target: 0, stop: 10000, neither: 0, green: 0, gapStops: 0, avgR: -1, median: 94.17362622231688 }, ["Strongly toward the stop."]],
  ["T22", BOTH, {}, { target: 0, stop: 10000, neither: 0, green: 0, gapStops: 0, avgR: -1, median: 100 }, ["Strongly toward the stop."]],
  ["T23", GAP, {}, { target: 0, stop: 10000, neither: 0, green: 0, gapStops: 10000, avgR: -1, median: 29.75531426921206 }, ["Strongly toward the stop."]],
  ["T24", MORNING_UP, { ...MS, until: "11:00" }, { bars: 9, target: 0, stop: 0, neither: 10000, green: 10000, gapStops: 0, avgR: 0.09036084126125796, median: 100.90360841261253 }, NO_MOVE],
  ["T25", MORNING_UP, { ...MS, entryTime: "13:15", until: "14:00" }, { bars: 9, target: 0, stop: 0, neither: 10000, green: 0, gapStops: 0, avgR: -0.08964083874126881, median: 99.10359161258742 }, null],
];
for (const [id, ratios, plan, want, lines] of DET) test(`${id} deterministic fixture`, () => check(run(constSessions(20, START, ratios), plan), want, lines));

// ── 9.7 Seeded mixed-window test ──
test("T26 slots 36–38 mix UP and DOWN candidates", () =>
  check(run(constSessions(20, START, MORNING_UP), { ...MS, entryTime: "12:15", until: "12:30" }), {
    neither: 10000,
    green: 6549,
    avgR: 0.005939419743999113,
    median: 100.09989989999998,
    p5: 99.8999001,
    p95: 100.30030009999997,
  }));

// ── 9.8 Seeded goldens on fixture G ──
const GP = { date: "2026-10-13", entry: 1000, stop: 995, target: 1005 };
const PCT = { median: 999.3874648888617, p5: 985.496246212785, p95: 1013.8136204986349 };
const GOLD = [
  ["T27", {}, {}, { target: 4705, stop: 5102, neither: 193, green: 4800, gapStops: 0, avgR: -0.039970594474676505, ...PCT }, ["Close to a coin flip."]],
  ["T28", { target: 1010 }, {}, { target: 2133, stop: 6007, neither: 1860, green: 3547, avgR: -0.07865849299943801, ...PCT }, ["Leans toward the stop."]],
  ["T29", {}, { seed: 20 }, { target: 4655, stop: 5116, neither: 229, green: 4777, avgR: -0.04575296162433698, median: 999.6043424652864, p5: 985.2653121548278, p95: 1013.7167070902703 }],
  ["T30", {}, { window: 0 }, { target: 4530, stop: 5242, neither: 228, green: 4644, avgR: -0.07035101359847956, median: 999.2911887846096, p5: 985.0353885818447, p95: 1013.8019355024645 }],
  ["T31", {}, { replays: 1000 }, { target: 496, stop: 482, neither: 22, green: 506, avgR: 0.013754449037999102, median: 999.5741762433755, p5: 985.9415993124072, p95: 1013.5273256949504 }],
];
for (const [id, plan, options, want, lines] of GOLD) test(`${id} golden on fixture G`, () => check(run(G, { ...GP, ...plan }, options), want, lines));

test("T32 same input, same output", () => assert.deepEqual(run(G, GP), run(G, GP)));
test("T33 no gap stops on fixture G", () => assert.equal(run(G, GP).mc.gapStops, 0));

// ── 9.13 Performance and purity ──
test("T43 10,000 replays x 63 bars in under 1 s", () => {
  const t0 = performance.now();
  const r = run(G, { ...GP, until: "15:30" });
  assert.equal(r.plan.bars, 63);
  assert.ok(performance.now() - t0 < 1000);
});
test("T44 simulate, history and verdict never call Math.random", (t) => {
  t.mock.method(Math, "random", () => {
    throw new Error("Math.random called");
  });
  const r = run(G, GP);
  runHistory(G, findEntry, { targetR: 1 });
  verdict({ ...r.mc, targetR: 1, until: "15:15" });
});
