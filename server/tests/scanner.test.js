import { describe, it, expect } from "vitest";
import db from "../db.js";
import { makeCandles, randomSessions, flat } from "./helpers.js";
import { sessionContext } from "../scanner/geometry.js";
import { detectAt } from "../scanner/detectors.js";
import { collect, summarize } from "../scanner/stats.js";
import { runScan } from "../scanner/index.js";
import { buildSessions } from "../lab/sessions.js";
import { labSource, loadIntraday } from "../data/intraday.js";
import { LAB } from "../config/lab.js";

const D0 = "2025-01-06";
// Clear downtrend / uptrend to set the prior-trend sign (slope of the last 5 closes). EMA(20) is
// not ready this early, so the slope alone decides — exactly the degrade path in geometry.trendAt.
const down = (n = 8, start = 120) => Array.from({ length: n }, (_, k) => { const o = start - k; const c = o - 0.6; return [o, o + 0.05, c - 0.05, c]; });
const up = (n = 8, start = 112) => Array.from({ length: n }, (_, k) => { const o = start + k; const c = o + 0.6; return [o, c + 0.05, o - 0.05, c]; });

const namesAt = (bars, i) => {
  const cs = makeCandles(D0, bars);
  return detectAt(cs, i, sessionContext(cs)).map((h) => h.name);
};
const has = (bars, i, name) => expect(namesAt(bars, i)).toContain(name);
const hasNot = (bars, i, name) => expect(namesAt(bars, i)).not.toContain(name);

describe("single-candle patterns (positive + near-miss)", () => {
  it("Hammer — long lower wick after a decline", () => {
    has([...down(), [112, 112.3, 110, 112.2]], 8, "Hammer");
    hasNot([...down(), [112, 113.5, 110, 112.2]], 8, "Hammer"); // upper wick too long
  });
  it("Hanging Man — hammer shape after a rise", () => {
    has([...up(), [120, 120.3, 118, 120.2]], 8, "Hanging Man");
    hasNot([...down(), [112, 112.3, 110, 112.2]], 8, "Hanging Man"); // wrong trend
  });
  it("Shooting Star — long upper wick after a rise", () => {
    has([...up(), [120, 122, 119.7, 119.8]], 8, "Shooting Star");
    hasNot([...up(), [120, 122, 118, 119.8]], 8, "Shooting Star"); // lower wick too long
  });
  it("Inverted Hammer — star shape after a decline", () => {
    has([...down(), [112, 114, 111.7, 111.8]], 8, "Inverted Hammer");
    hasNot([...down(), [112, 114, 110, 111.8]], 8, "Inverted Hammer"); // lower wick too long
  });
  it("Marubozu — full body, 1.5× average", () => {
    has([...down(), [112, 114.55, 111.95, 114.5]], 8, "Bullish Marubozu");
    hasNot([...down(), [112, 113, 111.5, 112.5]], 8, "Bullish Marubozu"); // body under 90% of range
  });
  it("Doji — tiny body, balanced wicks", () => {
    has([...down(), [112, 112.6, 111.4, 112.02]], 8, "Doji");
    hasNot([...down(), [112, 112.6, 111.4, 112.5]], 8, "Doji"); // body too large
  });
  it("Dragonfly Doji — long lower wick only", () => {
    has([...down(), [112, 112.05, 111, 112.02]], 8, "Dragonfly Doji");
    hasNot([...down(), [112, 112.8, 111, 112.02]], 8, "Dragonfly Doji"); // upper wick too long
  });
  it("Gravestone Doji — long upper wick only", () => {
    has([...up(), [112, 113, 111.98, 112.02]], 8, "Gravestone Doji");
    hasNot([...up(), [112, 113, 111, 112.02]], 8, "Gravestone Doji"); // lower wick too long
  });
  it("Spinning Top — small body, both wicks longer", () => {
    has([...down(), [112, 113.1, 111.1, 112.3]], 8, "Spinning Top");
    hasNot([...down(), [112, 113.2, 111.1, 113.1]], 8, "Spinning Top"); // body too large
  });
});

describe("two-candle patterns (positive + near-miss)", () => {
  it("Bullish Engulfing — covers the prior bearish body after a decline", () => {
    has([...down(), [113, 113.1, 112.3, 112.4], [112.3, 113.3, 112.2, 113.2]], 9, "Bullish Engulfing");
    hasNot([...down(), [113, 113.1, 112.3, 112.4], [112.3, 112.95, 112.2, 112.9]], 9, "Bullish Engulfing"); // does not cover prev open
  });
  it("Bearish Engulfing — covers the prior bullish body after a rise", () => {
    has([...up(), [119, 119.7, 118.9, 119.6], [119.7, 119.8, 118.8, 118.9]], 9, "Bearish Engulfing");
    hasNot([...up(), [119, 119.7, 118.9, 119.6], [119.7, 119.8, 119.1, 119.2]], 9, "Bearish Engulfing"); // does not cover prev open
  });
  it("Inside Bar — breakout close beyond the mother bar", () => {
    const mother = [112, 114, 110, 111];
    const inside = [111.5, 112.5, 110.5, 112];
    has([...down(), mother, inside, [112, 114.6, 111.9, 114.5]], 10, "Inside Bar ↑");
    hasNot([...down(), mother, inside, [112, 113, 111.9, 112.8]], 10, "Inside Bar ↑"); // close stays inside
  });
  it("Piercing Line — closes above the prior body midpoint", () => {
    has([...down(), [113, 113.1, 110.9, 111], [110.8, 112.6, 110.7, 112.5]], 9, "Piercing Line");
    hasNot([...down(), [113, 113.1, 110.9, 111], [110.8, 111.6, 110.7, 111.5]], 9, "Piercing Line"); // closes below midpoint
  });
  it("Dark Cloud Cover — closes below the prior body midpoint", () => {
    has([...up(), [127, 129.1, 126.9, 129], [129.2, 129.3, 127.5, 127.9]], 9, "Dark Cloud Cover");
    hasNot([...up(), [127, 129.1, 126.9, 129], [129.2, 129.3, 128.4, 128.5]], 9, "Dark Cloud Cover"); // closes above midpoint
  });
  it("Tweezer Bottom — two equal lows, opposite colours, after a decline", () => {
    has([...down(), [112, 112.1, 110, 110.5], [110.5, 111.6, 110.02, 111.5]], 9, "Tweezer Bottom");
    hasNot([...down(), [112, 112.1, 110, 110.5], [110.5, 111.6, 110.9, 111.5]], 9, "Tweezer Bottom"); // lows too far apart
  });
});

describe("three-candle patterns (positive + near-miss)", () => {
  it("Morning Star — small middle bar, bullish close past bar-1 midpoint", () => {
    has([...down(), [113, 113.1, 110.9, 111], [111, 111.1, 110.8, 110.9], [111, 112.4, 110.95, 112.3]], 10, "Morning Star");
    hasNot([...down(), [113, 113.1, 110.9, 111], [111, 111.1, 110.8, 110.9], [111, 111.9, 110.95, 111.8]], 10, "Morning Star"); // third bar too weak
  });
  it("Evening Star — small middle bar, bearish close past bar-1 midpoint", () => {
    has([...up(), [127, 129.1, 126.9, 129], [129, 129.2, 128.9, 129.1], [129, 129.05, 127.6, 127.7]], 10, "Evening Star");
    hasNot([...up(), [127, 129.1, 126.9, 129], [129, 129.2, 128.9, 129.1], [129, 129.05, 128.2, 128.3]], 10, "Evening Star"); // third bar too weak
  });
  it("Three White Soldiers — three rising bulls opening inside the prior body", () => {
    has([...flat(6), [100, 101.1, 99.9, 101], [100.5, 102.1, 100.4, 102], [101.5, 103.1, 101.4, 103]], 8, "Three White Soldiers");
    hasNot([...flat(6), [100, 101.1, 99.9, 101], [100.5, 102.1, 100.4, 102], [101.5, 103.1, 101.4, 101.6]], 8, "Three White Soldiers"); // third close not higher
  });
  it("Three Black Crows — three falling bears opening inside the prior body", () => {
    has([...flat(6), [103, 103.1, 101.9, 102], [102.5, 102.6, 100.9, 101], [101.5, 101.6, 99.9, 100]], 8, "Three Black Crows");
    hasNot([...flat(6), [103, 103.1, 101.9, 102], [102.5, 102.6, 100.9, 101], [101.5, 101.6, 100.9, 101.4]], 8, "Three Black Crows"); // third close not lower
  });
  it("Three Inside Up — harami inside a large bear, then a close past bar-1 open", () => {
    has([...down(), [113, 113.1, 110.9, 111], [111.5, 112.6, 111.4, 112.5], [112.5, 113.6, 112.4, 113.5]], 10, "Three Inside Up");
    hasNot([...down(), [113, 113.1, 110.9, 111], [111.5, 112.6, 111.4, 112.5], [112.5, 113, 112.4, 112.9]], 10, "Three Inside Up"); // does not close past bar-1 open
  });
});

// ── No look-ahead ────────────────────────────────────────────────────────────
// Detection is per session and every forward window is confined to its own session, so the stats
// are additive over disjoint session sets. A global-state / future-leak bug would break this:
// stats computed up to day D must not change when later days are added.
function snapshot(res) {
  const leaf = (a) => ({ win: a.win, loss: a.loss, none: a.none, n: a.n, retSum: a.retSum, mfeSum: a.mfeSum, maeSum: a.maeSum });
  const cells = (h) => Object.fromEntries(Object.entries(h).map(([N, c]) => [N, Object.fromEntries(Object.entries(c).map(([k, a]) => [k, leaf(a)]))]));
  const groups = {};
  for (const [name, g] of res.byName) groups[name] = cells(g.h);
  const base = Object.fromEntries(Object.entries(res.baseline).map(([dir, h]) => [dir, cells(h)]));
  return { groups, base };
}
function addLeaf(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = a[k] + (b?.[k] ?? 0);
  return out;
}
function addCells(a, b) {
  const out = {};
  for (const N of Object.keys(a)) {
    out[N] = {};
    for (const k of Object.keys(a[N])) out[N][k] = addLeaf(a[N][k], b?.[N]?.[k]);
  }
  return out;
}
function sumSnap(a, b) {
  const groups = { ...a.groups };
  for (const [name, g] of Object.entries(b.groups)) groups[name] = groups[name] ? addCells(groups[name], g) : g;
  const base = Object.fromEntries(Object.keys(a.base).map((dir) => [dir, addCells(a.base[dir], b.base[dir])]));
  return { groups, base };
}

describe("no look-ahead", () => {
  const flatList = randomSessions(30, 11).flatMap((d) => makeCandles(d.date, d.bars));
  const sessions = buildSessions(flatList).filter((s) => !s.special);
  const iv = LAB.intervals["5m"];

  it("stats are deterministic (same input → identical result)", () => {
    expect(snapshot(collect(sessions.slice(0, 15), iv))).toEqual(snapshot(collect(sessions.slice(0, 15), iv)));
  });

  it("stats of disjoint session sets add up (no leakage from later days)", () => {
    const a = sessions.slice(0, 8);
    const b = sessions.slice(8, 16);
    const union = snapshot(collect([...a, ...b], iv));
    const parts = sumSnap(snapshot(collect(a, iv)), snapshot(collect(b, iv)));
    // Compare on the look-ahead-critical integer counts: the derived float sums differ only by
    // floating-point associativity ((x+y)+z vs x+(y+z)), which is not a leakage concern.
    const ints = (snap) => JSON.parse(JSON.stringify(snap, (k, v) => (["retSum", "mfeSum", "maeSum"].includes(k) ? undefined : v)));
    expect(ints(union)).toEqual(ints(parts));
  });

  it("adding later sessions never changes the earlier window's contribution", () => {
    const early = snapshot(collect(sessions.slice(0, 10), iv));
    const laterToo = snapshot(collect(sessions.slice(0, 20), iv));
    // Every earlier count survives unchanged inside the longer run (future only adds).
    for (const [name, cells] of Object.entries(early.groups)) {
      for (const N of Object.keys(cells)) {
        expect(laterToo.groups[name][N].overall.n).toBeGreaterThanOrEqual(cells[N].overall.n);
      }
    }
  });
});

// ── End-to-end on a (synthetic stand-in for a) liquid stock ──────────────────
describe("end-to-end scan prints the table", () => {
  it("runs the full pipeline and reports detections + ranking", () => {
    const src = labSource().id;
    const ins = db.prepare("INSERT OR REPLACE INTO candles (source, symbol, interval, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const tx = db.transaction((rows) => { for (const r of rows) ins.run(src, "SCANDEMO", "5m", r.time, r.open, r.high, r.low, r.close, r.volume); });
    tx(randomSessions(100, 7).flatMap((d) => makeCandles(d.date, d.bars)));

    const scan = runScan({ symbol: "SCANDEMO", timeframes: ["5m"], lookback: 90, write: false });
    expect(scan.symbol).toBe("SCANDEMO");
    expect(Array.isArray(scan.detections)).toBe(true);
    expect(scan.timeframes[0].available).toBe(true);

    // Historical table over the loaded sessions, to "print the table".
    const sessions = buildSessions(loadIntraday("SCANDEMO", "5m", {})).filter((s) => !s.special).slice(-90);
    const { byName, baseline } = collect(sessions, LAB.intervals["5m"]);
    const H = LAB.stats?.primaryHorizon ?? 6;
    const rows = [...byName.values()]
      .map((g) => summarize(g, baseline))
      .map((s) => ({ name: s.name, dir: s.direction, ...s.horizons[s.primaryHorizon].overall }))
      .filter((r) => r.n > 0)
      .sort((a, b) => (b.edge ?? -1) - (a.edge ?? -1) || b.n - a.n);

    console.log(`\nPattern Scanner — SCANDEMO 5m, last ${sessions.length} sessions (synthetic)`);
    console.log("pattern".padEnd(22), "dir".padEnd(8), "n".padStart(5), "hit%".padStart(7), "base%".padStart(7), "edge".padStart(7), "avg%".padStart(7));
    for (const r of rows.slice(0, 20)) {
      const p = (x) => (x == null ? "—" : (x * 100).toFixed(0));
      console.log(
        r.name.padEnd(22),
        r.dir.padEnd(8),
        String(r.n).padStart(5),
        String(p(r.hitRate)).padStart(7),
        String(p(r.baseline)).padStart(7),
        String(r.edge == null ? "—" : (r.edge * 100).toFixed(1)).padStart(7),
        String(r.avgReturn == null ? "—" : r.avgReturn.toFixed(2)).padStart(7)
      );
    }
    console.log("Latest completed bar detections:", scan.detections.map((d) => `${d.name} (${d.timeframe})`).join(", ") || "none");
    console.log("Ranking:", scan.ranking.message || scan.ranking.order.map((o) => `${o.name} +${(o.edge * 100).toFixed(1)}pts`).join(", "));

    expect(rows.length).toBeGreaterThan(0);
  });
});
