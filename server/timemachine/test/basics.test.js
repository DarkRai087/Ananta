// Spec 9.1 RNG, 9.2 time grid, 9.3 candidates, 9.10 verdict, 9.11 percentile, 9.12 Kite adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32 } from "../src/rng.js";
import { slotOf, slotTime } from "../src/time.js";
import { candidateSlots } from "../src/simulate.js";
import { percentile } from "../src/stats.js";
import { verdict } from "../src/verdict.js";
import { fromKite } from "../src/kite.js";
import { runTimeMachine } from "../src/index.js";
import { constSessions, FLAT } from "./fixtures.js";

const draws = (seed, n) => Array.from({ length: n }, mulberry32(seed));

test("T1 mulberry32(19)", () => assert.deepEqual(draws(19, 3), [0.05854421923868358, 0.32688822830095887, 0.4525164095684886]));
test("T2 mulberry32(0)", () => assert.deepEqual(draws(0, 3), [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197]));
test("T3 every draw is in [0, 1)", () => {
  const r = mulberry32(19);
  for (let i = 0; i < 1_000_000; i++) {
    const x = r();
    if (!(x >= 0 && x < 1)) assert.fail(`draw ${i} = ${x}`);
  }
});

test("T4 slotOf", () => {
  for (const [t, k] of [["09:15", 0], ["09:30", 3], ["10:15", 12], ["14:00", 57], ["15:15", 72], ["15:30", 75]]) assert.equal(slotOf(t), k, t);
});
test("T5 off-grid time", () => assert.throws(() => slotOf("10:17"), { code: "ENTRY_NOT_ON_GRID" }));
test("T6 slotTime", () => {
  assert.equal(slotTime(0), "09:15");
  assert.equal(slotTime(11), "10:10");
  assert.equal(slotTime(74), "15:25");
});

test("T7 candidate slots, window 2", () => {
  assert.deepEqual(candidateSlots(0, 2), [0, 1, 2]);
  assert.deepEqual(candidateSlots(1, 2), [0, 1, 2, 3]);
  assert.deepEqual(candidateSlots(40, 2), [38, 39, 40, 41, 42]);
  assert.deepEqual(candidateSlots(74, 2), [72, 73, 74]);
});
test("T8 candidate slots, window 0", () => assert.deepEqual(candidateSlots(40, 0), [40]));

const COIN = "Close to a coin flip.";
const OPEN = "More than 40% of replays were still open at 15:15: the plan often runs out of time.";
const VERDICTS = [
  [5250, 4750, 0, 0.05, 1, [COIN]],
  [5500, 4500, 0, 0.1, 1, ["Leans toward the target."]],
  [5499, 4501, 0, 0.1, 1, [COIN]],
  [6500, 3500, 0, 0.3, 1, ["Strongly toward the target."]],
  [3500, 6500, 0, -0.3, 1, ["Strongly toward the stop."]],
  [3833, 6167, 0, 0, 2, ["Close to break-even."]],
  [2833, 7167, 0, -0.1, 2, ["Leans toward the stop."]],
  [1833, 8167, 0, -0.4, 2, ["Strongly toward the stop."]],
  [7000, 3000, 0, 0.05, 0.5, ["Close to break-even."]],
  [2000, 2000, 6000, 0, 1, [COIN, OPEN]],
  [3000, 3000, 4000, 0, 1, [COIN]],
  [3000, 3000, 4001, 0, 1, [COIN, OPEN]],
  [6000, 4000, 0, -0.1, 1, ["Leans toward the target.", "Average R is -0.10, against the lean."]],
  [0, 0, 10000, 0.2, 1, ["No replay reached the stop or the target: not enough movement to judge."]],
];
for (const [target, stop, neither, avgR, targetR, lines] of VERDICTS)
  test(`verdict ${target}/${stop}/${neither} R${targetR}`, () =>
    assert.deepEqual(verdict({ target, stop, neither, avgR, targetR, replays: target + stop + neither, until: "15:15" }), lines));

test("T39 percentile", () => {
  const v = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  assert.equal(percentile(v, 0.5), 5);
  assert.equal(percentile(v, 0.05), 1);
  assert.equal(percentile(v, 0.95), 9);
  assert.deepEqual(v, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

const IST = (date, t) => `${date}T${t}:00+0530`;
test("A26 (replaces T40) Kite candles: date and time by string slicing, volume kept as v", () => {
  const s = fromKite([
    [IST("2026-10-19", "00:10"), 1, 2, 0.5, 1.5, 999], // UTC is still 2026-10-18: must stay on the 19th
    { date: IST("2026-10-20", "09:15"), open: 3, high: 4, low: 2, close: 3.5, volume: 5 },
  ]);
  assert.deepEqual(s, [
    { date: "2026-10-19", bars: [{ t: "00:10", o: 1, h: 2, l: 0.5, c: 1.5, v: 999 }] },
    { date: "2026-10-20", bars: [{ t: "09:15", o: 3, h: 4, l: 2, c: 3.5, v: 5 }] },
  ]);
});

const toKite = (sessions) => sessions.flatMap((s) => s.bars.map((b) => [IST(s.date, b.t), b.o, b.h, b.l, b.c, 100]));
test("T41 a short day becomes a session that validation excludes", () => {
  const candles = toKite(constSessions(21, "2026-09-01", FLAT));
  candles.pop();
  const s = fromKite(candles);
  assert.equal(s[20].bars.length, 74);
  const r = runTimeMachine({ date: "2026-10-01", entry: 100, stop: 99, target: 101, entryTime: "10:15" }, s);
  assert.equal(r.pool.sessions, 20);
  assert.equal(r.pool.excludedSessions, 1);
});
test("T42 candles out of order are sorted within each day", () => {
  const sessions = constSessions(2, "2026-09-01", FLAT);
  const s = fromKite(toKite(sessions).reverse());
  assert.deepEqual(s, sessions.map((x) => ({ date: x.date, bars: x.bars.map((b) => ({ ...b, v: 100 })) }))); // toKite adds volume 100
});
