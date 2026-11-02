// Pattern Scanner — detect-and-report only; it never places an order.
// For a symbol it scans the most recent COMPLETED candle on each timeframe, reports which of the
// 20 patterns formed, tags the context, and attaches how that pattern has historically played out
// on THIS stock (hit rate vs a same-direction baseline, with a 95% Wilson interval). Detected
// patterns with a real edge (n ≥ 30, positive edge) are ranked; the results are written to JSON so
// the Time Machine and the strategy panel can read them.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SCANNER as CFG } from "../config/scanner.js";
import { LAB } from "../config/lab.js";
import { loadIntraday } from "../data/intraday.js";
import { buildSessions } from "../lab/sessions.js";
import { istHHMM } from "../lab/time.js";
import { sessionContext } from "./geometry.js";
import { detectAt } from "./detectors.js";
import { levelContext, tagBar } from "./levels.js";
import { collect, summarize } from "./stats.js";
import { CATALOG } from "./detectors.js";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));

// Index of the latest candle that has fully closed at/before `asOfSec` (the still-forming bar is
// ignored). −1 before the first bar closes.
export function latestCompletedIndex(cs, intervalMin, asOfSec) {
  const now = asOfSec ?? Math.floor(Date.now() / 1000);
  for (let k = cs.length - 1; k >= 0; k--) if (cs[k].time + intervalMin * 60 <= now) return k;
  return -1;
}

function barrierLabel() {
  const b = CFG.stats.barrier;
  return b.mode === "atr" ? `+${b.atrMult}×ATR before −${b.atrMult}×ATR` : `+${b.pct}% before −${b.pct}%`;
}

// The context clause, e.g. "at VWAP, Round ₹2500, volume 1.8×".
function contextWords(tag) {
  const parts = [...tag.levels];
  if (tag.volumeRatio != null) parts.push(`volume ${tag.volumeRatio.toFixed(1)}×`);
  return parts.length ? parts.join(", ") : "no notable level";
}

// One plain-English line, worded as history and never as a promise.
function phrase({ symbol, timeframe, hhmm, name, tag, direction, chosenKey, block, lookback, primaryHorizon }) {
  const head = `${name} on ${symbol} ${timeframe} at ${hhmm}, ${contextWords(tag)}.`;
  const ctx = chosenKey === "atLevel" ? " in similar context (at a level)" : "";
  if (!block || block.n === 0) return `${head} No past occurrences on this stock in the last ${lookback} sessions yet.`;
  if (!block.sufficient) return `${head} Only ${block.n} past occurrence(s) on this stock in the last ${lookback} sessions (need ${CFG.stats.minCount}) — insufficient history to judge the edge.`;
  if (direction === "neutral") {
    return `${head} On this stock over the last ${lookback} sessions, the average move within ${primaryHorizon} bars after this${ctx} was ±${Math.abs(block.avgReturn).toFixed(2)}% (n=${block.n}).`;
  }
  const pct = (block.hitRate * 100).toFixed(0);
  const base = (block.baseline * 100).toFixed(0);
  return `${head} On this stock over the last ${lookback} sessions, this setup${ctx} reached ${barrierLabel()} within ${primaryHorizon} bars ${pct}% of the time (n=${block.n}, baseline ${base}%).`;
}

function buildDetection(h, cs, i, lc, timeframe, symbol, byName, baseline, lookback) {
  const tag = tagBar(cs, i, lc);
  const group = byName.get(h.name);
  const stats = group ? summarize(group, baseline) : null;
  const primaryHorizon = CFG.stats.primaryHorizon;
  const primary = stats?.horizons[primaryHorizon] ?? null;
  // Use the at-level subset only when the detection is at a level AND that subset has enough data;
  // otherwise fall back to the overall history.
  const chosenKey = tag.atLevel && primary?.atLevel?.sufficient ? "atLevel" : "overall";
  const block = primary?.[chosenKey] ?? null;
  const hasEdge = Boolean(block && block.sufficient && block.edge != null && block.edge > 0 && h.direction !== "neutral");
  return {
    timeframe,
    id: h.id,
    name: h.name,
    direction: h.direction,
    time: cs[i].time,
    hhmm: istHHMM(cs[i].time),
    index: i,
    price: cs[i].close,
    context: { levels: tag.levels, atLevel: tag.atLevel, volumeRatio: tag.volumeRatio, highVolume: tag.highVolume, bucket: tag.bucket },
    stats: stats ? { primaryHorizon, chosen: chosenKey, block, horizons: stats.horizons, occurrences: stats.occurrences } : null,
    hasEdge,
    edge: hasEdge ? block.edge : null,
    n: block?.n ?? 0,
    line: phrase({ symbol, timeframe, hhmm: istHHMM(cs[i].time), name: h.name, tag, direction: h.direction, chosenKey, block, lookback, primaryHorizon }),
  };
}

// Scan one timeframe. Reads candles from the cache only (no network); the caller tops them up.
function scanTimeframe(symbol, timeframe, lookback, asOfSec) {
  const intervalMin = LAB.intervals[timeframe];
  const rows = loadIntraday(symbol, timeframe, { toSec: asOfSec ?? 4e9 });
  const all = buildSessions(rows);
  if (!all.length) return { timeframe, available: false, reason: `No cached ${timeframe} data`, detections: [] };
  const window = all.slice(-lookback);
  const current = window[window.length - 1];
  const lastIdx = latestCompletedIndex(current.candles, intervalMin, asOfSec);
  if (lastIdx < 0) return { timeframe, available: false, reason: "No completed candle yet today", detections: [], sessionsInWindow: window.length, lastDate: current.date };

  // Truncate today's session to completed bars so no future bar leaks into the stats.
  const completedCur = { ...current, candles: current.candles.slice(0, lastIdx + 1) };
  const statsWindow = window.map((s, k) => (k === window.length - 1 ? completedCur : s));
  const { byName, baseline } = collect(statsWindow, intervalMin);

  const cs = completedCur.candles;
  const ctx = sessionContext(cs);
  const lc = levelContext(completedCur, intervalMin);
  const hits = detectAt(cs, lastIdx, ctx);
  const detections = hits.map((h) => buildDetection(h, cs, lastIdx, lc, timeframe, symbol, byName, baseline, lookback));
  return {
    timeframe,
    available: true,
    sessionsInWindow: window.length,
    lastDate: current.date,
    lastBar: { time: cs[lastIdx].time, hhmm: istHHMM(cs[lastIdx].time), index: lastIdx, open: cs[lastIdx].open, high: cs[lastIdx].high, low: cs[lastIdx].low, close: cs[lastIdx].close, volume: cs[lastIdx].volume ?? null },
    detections,
  };
}

// Rank detected patterns: only those with n ≥ minCount and a positive edge; by edge, then larger n.
function rank(detections) {
  const qualifying = detections.filter((d) => d.hasEdge).sort((a, b) => b.edge - a.edge || b.n - a.n);
  return {
    ranked: qualifying,
    best: qualifying[0] || null,
    message: qualifying.length ? null : "No pattern with a historical edge right now.",
  };
}

/**
 * runScan({ symbol, timeframes?, lookback?, asOfSec?, write? })
 * Returns the full scan object (also written to JSON unless write === false).
 */
export function runScan({ symbol, timeframes = CFG.timeframes, lookback = CFG.lookbackSessions, asOfSec = null, write = true }) {
  const frames = timeframes.map((tf) => scanTimeframe(symbol, tf, lookback, asOfSec));
  const detections = frames.flatMap((f) => f.detections);
  const ranking = rank(detections);
  const out = {
    module: "pattern-scanner",
    symbol,
    generatedAt: Math.floor(Date.now() / 1000),
    asOf: asOfSec ?? Math.floor(Date.now() / 1000),
    lookbackSessions: lookback,
    barrier: { label: barrierLabel(), ...CFG.stats.barrier },
    primaryHorizon: CFG.stats.primaryHorizon,
    horizons: CFG.stats.horizons,
    minCount: CFG.stats.minCount,
    timeframes: frames.map((f) => ({ timeframe: f.timeframe, available: f.available, reason: f.reason ?? null, sessionsInWindow: f.sessionsInWindow ?? 0, lastDate: f.lastDate ?? null, lastBar: f.lastBar ?? null })),
    detections,
    ranking: { best: ranking.best?.name ? { name: ranking.best.name, timeframe: ranking.best.timeframe, edge: ranking.best.edge, n: ranking.best.n } : null, order: ranking.ranked.map((d) => ({ name: d.name, timeframe: d.timeframe, edge: d.edge, n: d.n })), message: ranking.message },
  };
  if (write) writeOutput(out);
  return out;
}

export function writeOutput(out) {
  try {
    const dir = path.resolve(SERVER_DIR, CFG.output.dir);
    mkdirSync(dir, { recursive: true });
    const safe = String(out.symbol).replace(/[^A-Za-z0-9._-]/g, "_");
    writeFileSync(path.join(dir, `${safe}.json`), JSON.stringify(out, null, 2));
    writeFileSync(path.join(dir, CFG.output.latest), JSON.stringify(out, null, 2));
    return dir;
  } catch (err) {
    // Output is a convenience for other modules; a write failure must not break the scan.
    return null;
  }
}

export function scannerMeta() {
  return { catalog: CATALOG, timeframes: CFG.timeframes, lookbackSessions: CFG.lookbackSessions, horizons: CFG.stats.horizons, primaryHorizon: CFG.stats.primaryHorizon, minCount: CFG.stats.minCount, barrier: { label: barrierLabel(), ...CFG.stats.barrier } };
}
