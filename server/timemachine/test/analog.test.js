// Add-on (v2) A1–A21, A27: backward compatibility, weighted pick, features and weights, conditioned
// simulation, forecast mode. A26 (adapter) is in basics.test.js; walk-forward in walkforward.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTimeMachine } from "../src/index.js";
import { analogWeights } from "../src/analog.js";
import { pickWeighted } from "../src/simulate.js";
import { G, GV, GV_TODAY, N, H, H_TODAY, P, randomWalkSessions } from "./fixtures.js";

const near = (a, b, what) => assert.ok(Math.abs(a - b) <= (Math.abs(b) < 1e-3 ? 1e-9 : 1e-6), `${what}: ${a} vs ${b}`);
const COUNTS = new Set(["target", "stop", "neither", "green", "gapStops", "slot", "time", "pUp", "pDown", "pFlat", "buckets", "used", "fellBack", "bandwidth"]);
// Counts, shares and labels exact; prices, R, weights and metrics within tolerance.
function check(obj, want, what = "") {
  for (const [k, v] of Object.entries(want)) COUNTS.has(k) || typeof v !== "number" ? assert.deepEqual(obj[k], v, `${what}${k}`) : near(obj[k], v, `${what}${k}`);
}
const ON = { enabled: true };
const GP = { symbol: "GV", date: "2026-10-13", entry: 1000, stop: 995, target: 1005, entryTime: "10:15" };
const HP = { symbol: "H", date: "2026-09-29", entry: 100, stop: 99, target: 101, entryTime: "10:15" };
const UNTIL = 2; // default horizons [6, 12, "until"]
const T27 = { target: 4705, stop: 5102, neither: 193, green: 4800, gapStops: 0, avgR: -0.039970594474676505, median: 999.3874648888617, p5: 985.496246212785, p95: 1013.8136204986349 };

test("v2 fixture checkpoints", () => {
  assert.deepEqual([GV[0].bars[0].v, GV[0].bars[1].v, GV[30].bars[11].v], [1011, 1029, 658]);
  check(N[0].bars[0], { o: 1000, h: 1000.625192261068, l: 998.324929456793, c: 998.6251806793734 }, "N ");
  assert.equal(P.filter((s) => s.bull).length, 33);
  assert.deepEqual(P.slice(0, 5).map((s) => s.bull), [false, false, false, true, false]);
  check(P[0].bars[0], { o: 1000, h: 1000.6554279906073, l: 999.6884105888894, c: 1000.5454865465873, v: 500 }, "P ");
  near(P[0].bars[74].c, 971.9369322782268, "P[0] close");
  for (let k = 0; k < 30; k++) assert.deepEqual(GV[k].bars.map((b) => b.c), G[k].bars.map((b) => b.c)); // prices = fixture G
});

// ── 9.2 Backward compatibility ──
test("A1 conditioning off reproduces T27, and the until horizon matches its percentiles", () => {
  const r = runTimeMachine(GP, G);
  check(r.mc, T27);
  check(r.forecast.horizons[UNTIL], { median: T27.median, p5: T27.p5, p95: T27.p95 });
  assert.equal(r.conditioning, null);
});
test("A2 conditioning on with no features is exactly v1", () => {
  const day = randomWalkSessions(31, "2026-09-01", 7)[30];
  const r = runTimeMachine(GP, G, { today: { date: day.date, bars: day.bars.slice(0, 12) }, conditioning: { enabled: true, features: [] } });
  assert.deepEqual(r.mc, runTimeMachine(GP, G).mc);
  check(r.mc, T27);
  check(r.conditioning, { used: [], ess: 30, bandwidth: 1, fellBack: false });
});

// ── 9.3 Weighted pick ──
test("A4 pickWeighted", () => {
  assert.deepEqual([0.1, 0.2, 0.25, 0.5, 0.99].map((u) => pickWeighted([1, 1, 4], u)), [0, 0, 2, 2, 2]);
  assert.equal(pickWeighted([1, 2, 3], 0.5), 1);
  assert.equal(pickWeighted([0, 0, 5], 0), 2);
});

// ── 9.4 Features and weights (fixture H) ──
const hw = (cfg, pool = H, events) => analogWeights(pool, H_TODAY, { e: 12, events, conditioning: cfg });
const H_TODAY_X = { relVol: 1.6, rvol: 0.0009995003330834234, gap: 0.07503752501876429, moveSoFar: 0.011994003997001464 };
test("A5 features on fixture H", () => {
  const a = hw();
  assert.deepEqual(a.diag.used, ["relVol", "rvol", "gap", "moveSoFar"]);
  check(a.values.today, H_TODAY_X, "today ");
  check(a.values.pool[0], { ...H_TODAY_X, gap: 0 }, "pool[0] ");
  check(a.values.pool[1], { relVol: 0.4, rvol: 0.0010005003335835344, gap: -0.07496252498125733, moveSoFar: -0.012006004003002313 }, "pool[1] ");
  assert.deepEqual(a.values.pool[2], a.values.today);
});
test("A6 weights and ESS", () => {
  const a = hw();
  near(a.w[0], 0.589645535966617, "w0");
  a.w.forEach((w, i) => (i % 2 ? near(w, 0.0003002715022880832, `w${i}`) : i && assert.equal(w, 1, `w${i}`)));
  check(a.diag, { ess: 9.844033310991009, bandwidth: 1, fellBack: false });
});
test("A7 the bandwidth widens until ESS reaches minEss, then falls back to uniform", () => {
  check(hw({ minEss: 12 }).diag, { bandwidth: 2.25, ess: 13.895800363196654, fellBack: false });
  const a = hw({ minEss: 25 });
  check(a.diag, { fellBack: true, ess: 20, bandwidth: 57.6650390625 });
  assert.ok(a.w.every((w) => w === 1));
});
test("A8 one missing volume drops relVol", () => {
  const pool = structuredClone(H);
  delete pool[4].bars[3].v;
  assert.deepEqual(hw({}, pool).diag.used, ["rvol", "gap", "moveSoFar"]);
});
test("A9 event tags", () => {
  const a = hw({}, H, { "2026-09-29": ["expiry"], "2026-09-04": ["expiry"], "2026-09-08": ["expiry"] });
  a.w.forEach((w, i) =>
    near(w, i === 0 ? 0.0797998456192464 : i === 3 || i === 5 ? 0.0003002715022880832 : i % 2 ? 0.00004063732881004093 : 0.1353352832366127, `w${i}`),
  );
  near(a.diag.ess, 9.851899605175472, "ess");
});
test("A10 features read nothing from slot 12 on", () => {
  // Bars 12..73 of every session (bar 74's close is the next day's previous close, which it may know).
  const bump = (s, last) => ({ ...s, bars: s.bars.map((b, k) => (k >= 12 && k <= last ? { ...b, o: b.o * 1.05, h: b.h * 1.07, l: b.l * 1.03, c: b.c * 1.05, v: b.v * 3 } : b)) });
  const fullToday = { date: "2026-09-29", bars: [...H_TODAY.bars, ...H[2].bars.slice(12)] };
  const base = analogWeights(H, fullToday, { e: 12 });
  const moved = analogWeights(H.map((s) => bump(s, 73)), bump(fullToday, 74), { e: 12 });
  assert.deepEqual(moved.values, base.values);
  assert.deepEqual(moved.w, base.w);
});

// ── 9.5 Simulation with conditioning (fixture H) ──
test("A11 fixture H, conditioning off", () => {
  const r = runTimeMachine(HP, H);
  check(r.mc, { target: 1911, stop: 1542, neither: 6547, green: 4440, avgR: 0.0007954584516079834 });
  assert.equal(r.forecast.horizons[UNTIL].pUp, 0.4384);
});
test("A12 fixture H, conditioning on: only UP mornings teach it", () => {
  const r = runTimeMachine(HP, H, { today: H_TODAY, conditioning: ON });
  check(r.mc, { target: 10000, stop: 0, neither: 0, green: 10000, avgR: 1 });
  check(r.forecast.horizons[UNTIL], { pUp: 1, median: 106.18047131469584 });
  assert.deepEqual(r.conditioning.top, ["2026-09-03", "2026-09-07", "2026-09-09", "2026-09-11", "2026-09-15"].map((date) => ({ date, w: 1 })));
});

// ── 9.6 Forecast mode (fixture H) ──
const HF = { symbol: "H", date: "2026-09-29", entryTime: "10:15" };
test("A13 forecast mode, conditioning on", () => {
  const r = runTimeMachine(HF, H, { today: H_TODAY, conditioning: ON });
  assert.deepEqual([r.mc, r.history, r.verdict], [null, null, null]);
  near(r.forecast.ref, 101.2066220495792, "ref");
  const [a, b, c] = r.forecast.horizons;
  assert.deepEqual(r.forecast.horizons.map((x) => [x.slot, x.time]), [[18, "10:45"], [24, "11:15"], [72, "15:15"]]);
  check(a, { pUp: 1, pDown: 0, median: 101.8153819068585, mean: 101.81503608036668, buckets: [0, 0, 0, 17, 9983, 0] }, "18 ");
  check(b, { median: 102.42780346686368, buckets: [0, 0, 0, 0, 0, 10000] }, "24 ");
  check(c, { median: 107.46166829392602, mean: 107.45756740202803 }, "72 ");
});
test("A14 forecast mode, conditioning off", () => {
  const [a, , c] = runTimeMachine(HF, H, { today: H_TODAY }).forecast.horizons;
  check(a, { pUp: 0.3377, pDown: 0.6623, buckets: [0, 177, 6446, 3216, 161, 0] }, "18 ");
  check(c, { pUp: 0.4384, median: 101.20358589494185, p5: 99.9964000629989, p95: 102.42534522785009, buckets: [769, 1864, 2983, 1875, 1350, 1159] }, "72 ");
});
test("A15 refusals", () => {
  const no = (plan, opts, code) => assert.throws(() => runTimeMachine(plan, H, opts), { code }, `${JSON.stringify(plan)} → ${code}`);
  no({ ...HF, stop: 99 }, { today: H_TODAY }, "INVALID_PLAN");
  no({ ...HF, target: 101 }, { today: H_TODAY }, "INVALID_PLAN");
  no(HF, {}, "INVALID_PLAN");
  no(HP, { conditioning: ON }, "TODAY_REQUIRED");
  no(HP, { today: { ...H_TODAY, bars: H_TODAY.bars.slice(0, 11) }, conditioning: ON }, "BAD_TODAY");
});

// ── 9.7 Realistic fixture GV ──
test("A16 features on fixture GV", () => {
  const a = analogWeights(GV.slice(0, 30), GV_TODAY, { e: 12, index: N });
  assert.deepEqual(a.diag.used, ["relVol", "rvol", "gap", "moveSoFar", "niftyMove"]);
  check(a.values.today, { relVol: 0.943643292427015, rvol: 0.0011863863300155342, gap: -0.002258435074762652, moveSoFar: 0.001338427119759777, niftyMove: 0.00028308720258870423 }, "today ");
  check(a.values.pool[0], { relVol: 1.0589756072993437, rvol: 0.001161085339102385, gap: 0, moveSoFar: 0.002588569559970751, niftyMove: -0.0031094285271462694 }, "pool[0] ");
});
const gv = (plan, conditioning) => runTimeMachine(plan, GV, { today: GV_TODAY, index: N, conditioning });
const A17_UNTIL = { pUp: 0.4663, buckets: [1400, 1678, 2259, 2121, 1487, 1055] };
test("A17 fixture GV, analog", () => {
  const r = gv(GP, ON);
  check(r.mc, { target: 5014, stop: 4725, neither: 261, green: 5133, avgR: 0.028365375065125112 });
  check(r.conditioning, { ess: 13.661022223145325, bandwidth: 1 });
  const top = [["2026-09-17", 0.47767217031411036], ["2026-09-08", 0.4098098736319587], ["2026-09-23", 0.3339970160460054], ["2026-09-09", 0.33294281413728843], ["2026-09-04", 0.32266797319076906]];
  r.conditioning.top.forEach((t, i) => (assert.equal(t.date, top[i][0]), near(t.w, top[i][1], t.date)));
  check(r.forecast.horizons[UNTIL], { ...A17_UNTIL, pDown: 0.5337, median: 999.2896422915186, p5: 985.0903736370212, p95: 1013.5836448840244 });
});
test("A18 fixture GV, analog + volatility scaling", () => {
  const r = gv(GP, { enabled: true, volScale: true });
  check(r.mc, { target: 5039, stop: 4734, neither: 227, green: 5143, avgR: 0.029898502534459498 });
  check(r.forecast.horizons[UNTIL], { pUp: 0.464, median: 999.2044480693, buckets: [1460, 1682, 2218, 2121, 1437, 1082] });
});
const GF = { symbol: "GV", date: "2026-10-13", entryTime: "10:15" };
test("A19 fixture GV, forecast mode, analog", () => {
  const r = gv(GF, ON);
  near(r.forecast.ref, 1001.3393232130779, "ref");
  const [a, b, c] = r.forecast.horizons;
  check(a, { pUp: 0.5372, median: 1001.5863138117537, buckets: [0, 316, 4312, 4928, 444, 0] }, "18 ");
  check(b, { pUp: 0.5465, buckets: [31, 764, 3740, 4324, 1098, 43] }, "24 ");
  check(c, { ...A17_UNTIL, median: 1000.6280141060279, p5: 986.4097280414132, p95: 1014.9411609880137 }, "72 ");
});
test("A20 fixture GV, forecast mode, uniform", () => {
  const [a, , c] = gv(GF).forecast.horizons;
  check(a, { pUp: 0.4384, buckets: [0, 465, 5151, 4117, 267, 0] }, "18 ");
  check(c, { pUp: 0.4735, median: 1000.7259677194465, buckets: [1364, 1733, 2168, 2078, 1533, 1124] }, "72 ");
});
test("A21 scale-free: the same odds and buckets from entry 1000 and from 1001.34", () => {
  const t = gv(GP, ON).forecast.horizons[UNTIL];
  const f = gv(GF, ON).forecast.horizons[UNTIL];
  assert.deepEqual([t.pUp, t.buckets], [f.pUp, f.buckets]);
});

// ── 9.10 Performance ──
test("A27 one conditioned run on GV (10,000 replays x 60 bars) under 1.5 s", () => {
  const t0 = performance.now();
  gv(GP, { enabled: true, volScale: true });
  assert.ok(performance.now() - t0 < 1500);
});
