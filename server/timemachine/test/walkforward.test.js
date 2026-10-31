// Add-on (v2) A22–A25, A28: walk-forward validation. Choose on train, judge on test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { walkForward } from "../src/walkforward.js";
import { W, N60, P } from "./fixtures.js";

const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-6, `${what}: ${a} vs ${b}`);
const variant = (r, name) => r.variants.find((v) => v.name === name);

let wf;
let wfMs;
const noise = () => {
  if (!wf) {
    const t0 = performance.now();
    wf = walkForward(W, { index: N60, trainEnd: "2026-07-24" });
    wfMs = performance.now() - t0;
  }
  return wf;
};

test("A22 noise must not fool it (fixture W)", () => {
  const r = noise();
  const want = {
    uniform: [0.24500098750000002, 0.9, 0.252956025, 0.85],
    analog: [0.25084991250000005, 0.9, 0.2240207125, 0.85],
    "analog+vol": [0.2502128625, 0.9, 0.22329278749999998, 0.9],
  };
  for (const [name, [trB, trC, teB, teC]] of Object.entries(want)) {
    const v = variant(r, name);
    near(v.train.brier, trB, `${name} train brier`);
    near(v.train.coverage90, trC, `${name} train cov90`);
    near(v.test.brier, teB, `${name} test brier`);
    near(v.test.coverage90, teC, `${name} test cov90`);
    assert.deepEqual([v.train.n, v.test.n], [20, 20]);
    near(v.train.upRate, 0.35, "train upRate");
    near(v.test.upRate, 0.4, "test upRate");
  }
  assert.equal(r.chosen, "uniform");
  assert.equal(r.accepted, false);
  assert.deepEqual(variant(r, "uniform").records[0], { date: "2026-06-29", p: 0.549, y: 0, inBand: 0 });
  assert.deepEqual(variant(r, "analog").records[0], { date: "2026-06-29", p: 0.4905, y: 0, inBand: 1 });
});

test("A23 a real signal must be found (fixture P)", () => {
  const r = walkForward(P, { trainEnd: "2026-08-07" });
  const want = {
    uniform: [0.33121504999999996, 0.29422634999999997, -0.17690539999999988, 0.06666666666666667],
    analog: [0.029814666666666663, 0.04837990000000001, 0.8064804, 0.3],
    "analog+vol": [0.030934991666666675, 0.05575811666666666, 0.7769675333333333, 0.36666666666666664],
  };
  for (const [name, [trB, teB, teSkill, teC]] of Object.entries(want)) {
    const v = variant(r, name);
    near(v.train.brier, trB, `${name} train brier`);
    near(v.test.brier, teB, `${name} test brier`);
    near(v.test.skill, teSkill, `${name} test skill`);
    near(v.test.coverage90, teC, `${name} test cov90`);
    assert.deepEqual([v.train.n, v.test.n], [30, 30]);
  }
  assert.equal(r.chosen, "analog");
  assert.equal(r.accepted, true);
  assert.deepEqual([variant(r, "uniform").records[0].p, variant(r, "uniform").records[0].y], [0.0655, 1]);
  assert.deepEqual([variant(r, "analog").records[0].p, variant(r, "analog").records[0].y], [0.8085, 1]);
  const cal = variant(r, "analog").test.calibration.filter((b) => b.n);
  const wantCal = [[0, 19, 0.013, 0], [3, 1, 0.305, 1], [4, 1, 0.411, 1], [5, 1, 0.5005, 0], [6, 3, 0.6786666666666666, 1], [7, 1, 0.7945, 1], [9, 4, 0.9745, 1]];
  assert.equal(cal.length, wantCal.length);
  cal.forEach((b, i) => {
    assert.deepEqual([b.bucket, b.n], wantCal[i].slice(0, 2));
    near(b.meanP, wantCal[i][2], `bucket ${b.bucket} meanP`);
    near(b.upRate, wantCal[i][3], `bucket ${b.bucket} upRate`);
  });
});

// A smaller run for the leak and determinism checks.
const QUICK = { index: N60, trainEnd: "2026-07-24", replays: 300, variants: [{ name: "analog+vol", conditioning: { enabled: true, volScale: true } }] };
const bump = (s, from) => ({ ...s, bars: s.bars.map((b, k) => (k >= from ? { ...b, o: b.o * 1.03, h: b.h * 1.03, l: b.l * 1.03, c: b.c * 1.03, v: b.v * 2 } : b)) });

test("A24 strict past: a day's forecast never sees its own afternoon or any later day", () => {
  const D = 30;
  const date = W[D].date;
  const records = (sessions, index = N60) => walkForward(sessions, { ...QUICK, index }).variants[0].records;
  const base = records(W);
  const upTo = (rs) => rs.filter((x) => x.date <= date);
  // D's own bars from slot e = 12 on: only y and inBand may change for D.
  const own = records(W.map((s, i) => (i === D ? bump(s, 12) : s)));
  assert.deepEqual(upTo(own).map((x) => x.p), upTo(base).map((x) => x.p));
  assert.deepEqual(upTo(own).slice(0, -1), upTo(base).slice(0, -1));
  // Any later session (stock and index): nothing changes up to D.
  const later = records(W.map((s, i) => (i > D ? bump(s, 0) : s)), N60.map((s, i) => (i > D ? bump(s, 0) : s)));
  assert.deepEqual(upTo(later), upTo(base));
});

test("A25 two walk-forward runs are deep-equal", () => assert.deepEqual(walkForward(W, QUICK), walkForward(W, QUICK)));

test("A28 walk-forward on W with 3 variants under 20 s", () => {
  noise();
  assert.ok(wfMs < 20_000, `${wfMs} ms`);
});
