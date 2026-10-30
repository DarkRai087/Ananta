// Does a decision engine's score mean anything? Backtests every confirmed setup that passes the
// mandatory conditions (score threshold off), then groups the trades by setup score — and, for the
// ORB, by entry model, opening-range width and breakout time. A useful score shows better net
// results in the higher bands, out of sample too.
//
//   npm run orb-research  -- --symbols=NIFTY50 --interval=5m
//   npm run vwap-research -- --symbols=RELIANCE,SBIN --from=2025-11-01
//   npm run strategy-research -- --strategy=orb --orMinutes=30 --target=t1
//
// Any other --key=value is passed to the strategy as a Lab param (e.g. --models=retest).
// Reads cached candles only (backfill first). Same engine, costs, slippage and sizing as the Lab.
import "../env.js";
import { loadHolidays } from "../data/holidays.js";
import { resolveTarget } from "../data/universes.js";
import { loadSessions, runStrategies, splitDate } from "../backtest/run.js";
import { metrics } from "../backtest/metrics.js";
import { getStrategy } from "../strategies/index.js";
import { LAB } from "../config/lab.js";
import { MARKET } from "../config/market.js";

loadHolidays();
const args = Object.fromEntries(process.argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const strategy = args.strategy || "vwapBands";
const interval = args.interval || "5m";
const from = args.from || null;
const to = args.to || null;
const symbols = resolveTarget(args.symbols || "NIFTY50");
const def = getStrategy(strategy);
const params = { minScore: 0 };
for (const [k, v] of Object.entries(args)) if (!["strategy", "interval", "from", "to", "symbols"].includes(k) && k in def.params) params[k] = v;
const BANDS = [
  { id: "<50", lo: -Infinity, hi: 50 },
  { id: "50–64", lo: 50, hi: 65 },
  { id: "65–74", lo: 65, hi: 75 },
  { id: "75–84", lo: 75, hi: 85 },
  { id: "85+", lo: 85, hi: Infinity },
];

if (!symbols.length) {
  console.error("No symbols. Use --symbols=NIFTY50 or --symbols=RELIANCE,SBIN");
  process.exit(1);
}
console.log(`${def.name} — score study · ${symbols.length} symbol(s) · ${interval} · ${from ?? "all cached"} → ${to ?? "latest"} · params ${JSON.stringify(params)}`);

const t0 = Date.now();
const symbolSessions = symbols.map((symbol) => ({
  symbol,
  sessions: loadSessions(symbol, interval, { from, to }).filter((s) => !s.special && (!from || s.date >= from) && (!to || s.date <= to)),
}));
const { tradesByStrategy, dates } = runStrategies(symbolSessions, [{ id: strategy, params }], { interval, settings: {} });
const trades = tradesByStrategy[strategy];
for (const t of trades) {
  t.score = Number(/([\d.]+)\/100/.exec(t.signal)?.[1] ?? NaN);
  t.model = /model ([ABC])/.exec(t.signal)?.[1] ?? null;
  t.orClass = /OR (Extremely narrow|Narrow|Normal|Wide|Extremely wide|unknown)/.exec(t.signal)?.[1] ?? null;
}
const split = splitDate(dates);
console.log(`${dates.length} sessions, ${trades.length} trades, ${((Date.now() - t0) / 1000).toFixed(1)}s. In-sample before ${split}, out-of-sample from ${split}.\n`);

const pad = (s, n) => String(s).padStart(n);
const head = (label) => `${label.padEnd(18)}${pad("trades", 7)}${pad("win%", 8)}${pad("avg R", 9)}${pad("avg ₹", 10)}${pad("PF", 8)}${pad("net ₹", 11)}`;
const row = (label, m) =>
  m.trades
    ? `${label.padEnd(18)}${pad(m.trades, 7)}${pad(`${m.winPct.toFixed(1)}%`, 8)}${pad(m.expectancyR.toFixed(2), 9)}${pad(Math.round(m.expectancyRs), 10)}${pad(m.profitFactor == null ? "—" : Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞", 8)}${pad(Math.round(m.netPnl), 11)}`
    : `${label.padEnd(18)}${pad(0, 7)}`;
const table = (title, set, groups) => {
  console.log(head(title));
  for (const [label, pick] of groups) console.log(row(label, metrics(set.filter(pick))));
  console.log(row("total", metrics(set)));
  console.log("");
};
const samples = [
  ["ALL", trades],
  ["OUT-OF-SAMPLE", trades.filter((t) => t.date >= split)],
];
for (const [name, set] of samples) {
  console.log(`── ${name} ──`);
  table("score", set, BANDS.map((b) => [b.id, (t) => t.score >= b.lo && t.score < b.hi]));
  if (strategy === "orb") {
    table("entry model", set, [["A close+accept", (t) => t.model === "A"], ["B retest", (t) => t.model === "B"], ["C momentum", (t) => t.model === "C"]]);
    table("OR width", set, ["Extremely narrow", "Narrow", "Normal", "Wide", "Extremely wide"].map((c) => [c, (t) => t.orClass === c]));
  }
  table("entry time", set, MARKET.timeBuckets.map((b) => [b.label, (t) => t.bucket === b.id]));
}

// Rank correlation between score and net R: > 0 means higher scores did better.
function spearman(xs, ys) {
  const rank = (a) => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(a.length);
    for (let k = 0; k < idx.length; ) {
      let j = k;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[k][0]) j++;
      for (let m = k; m <= j; m++) r[idx[m][1]] = (k + j) / 2;
      k = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = 0; k < n; k++) {
    sxy += (rx[k] - mx) * (ry[k] - my);
    sxx += (rx[k] - mx) ** 2;
    syy += (ry[k] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
const ok = trades.filter((t) => Number.isFinite(t.score));
if (ok.length >= 10) {
  const rho = spearman(ok.map((t) => t.score), ok.map((t) => t.rNet));
  const se = 1 / Math.sqrt(ok.length - 1);
  console.log(`Score vs net R rank correlation: ${rho.toFixed(3)} (±${(1.96 * se).toFixed(3)} at 95%, n=${ok.length})`);
  console.log(
    rho > 1.96 * se
      ? "→ Higher scores did better: the score carries information on this data."
      : rho < -1.96 * se
        ? "→ Higher scores did WORSE: revisit the weights in the strategy's config."
        : "→ No measurable link between score and result on this data — don't read the score as an edge.",
  );
} else {
  console.log("Too few trades for a score study.");
}
console.log(`\nCosts: config/costs.js · slippage ${LAB.backtest.slippagePct}% · risk ₹${LAB.backtest.riskPerTrade}/trade · max ${LAB.backtest.maxTradesPerDay} trades/day/symbol.`);
console.log("Backtests have no live quote, India VIX or breadth: those points are never earned here, so 85+ is rare by design.");
