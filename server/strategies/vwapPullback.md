# VWAP Pullback

## Hypothesis

Institutional VWAP execution algos work large orders *around* the session VWAP: on a trending
day they keep accumulating (longs) or distributing (shorts) near VWAP rather than chasing. So on
a confirmed trend day a **pullback to VWAP acts as support (longs) / resistance (shorts)**, and a
reclaim off that pullback continues the trend. We only trade *with* an established VWAP trend,
never a fresh guess at reversal.

This is a continuation setup, long and short mirrored. NSE cash intraday (MIS) only — signals and
analysis, never orders.

## Where it lives

- Strategy: [vwapPullback.js](./vwapPullback.js) — `onBar` (backtest signal) + `plan` (live scanner).
- It plugs into the existing lab: the backtest engine, cost model, sizing, IS/OOS walk-forward,
  metrics (incl. Wilson 95% CI), the chart VWAP/σ-band overlay and the Top-3 / Trade-Plans live
  scanner are all shared infrastructure — this file only produces the signal.

## Data

- Timeframe: **5-minute** (the only intraday interval stored; 1-minute history isn't available
  from the free providers). ~232 sessions × ~60 NIFTY names locally as of 2026-10-30.
- Session filtering (09:15–15:30 IST), NSE holidays and special/half sessions are handled upstream
  in `buildSessions`; special sessions are excluded from backtests by default.

## Rules (long; short is the mirror)

All thresholds are params on one config object (defaults in `vwapPullback.js`).

**Pre-trade filters**
- **Window**: entries only 09:45–14:30 (`entryStart`/`entryEnd`); forced flat 15:15 (engine `squareOff`).
- **Trend day**: VWAP slope over `slopeBars` (6) ≥ `minVwapSlopePct` (0.05%), **and** at least
  `holdBars` (6) consecutive closes on the trend side before the pullback, **and** VWAP crossed
  ≤ `maxVwapCrossings` (2) times today.
- **Market alignment** (`requireMarket`): NIFTY 50 must be on the trade's side of its own VWAP
  line (the index has no volume, so its VWAP is the equal-weight typical-price line). If no index
  data that day, the gate is skipped rather than blocking the trade.
- **Gap**: skip the stock today if |opening gap| > `maxGapPct` (2%).

**Setup (pullback)**
- Within the last `pullbackWindow` (3) bars, a bar's low came within `touchAtrMult`×ATR (0.1) of
  VWAP without its close dipping more than `dipAtrMult`×ATR (0.25) past VWAP.
- Pullback-leg average volume < `volDryMult` (0.8) × impulse-leg average volume (volume drying up).
  Skipped when there is no distinct pullback leg or no volume.

**Entry trigger**
- A bar closes above the previous bar's high **and** above VWAP (green). Fill at the **next bar's
  open** + slippage (engine).

**Stop**
- `min(pullback swing low, VWAP − stopAtrMult×ATR)`, rounded **down** to the NSE price tick
  (`tickFor`/`roundTick`). Reject if the stop is closer than `minStopPct` (0.15%) of price or wider
  than `maxStopAtrMult`×ATR (1.2).

**Target / exits**
- Target = `targetR` (2R, engine). Set `targetMode: "band"` with Target (R) = 0 to use the VWAP
  ±`bandMult`σ band instead.
- Exit on whichever is first: stop, target, 15:15, or (optional `exitOnVwapLoss`) two consecutive
  closes back through VWAP. Stop and target in the same bar → stop first (engine, conservative).
- One trade per stock per day (engine `maxTradesPerDay`).

**Sizing / risk** — engine: qty sized so a stop-out loses ≤ `riskPerTrade` after all charges;
position-value cap; daily max-loss kill switch.

## No lookahead

Every read is through `ctx` and bounded to bars ≤ i; the slope, crossing-count and consecutive-run
helpers are all prefix computations, so the signal at bar i is identical with or without later bars.
Enforced by `tests/lookahead.test.js` and `tests/sessionLeak.test.js`, plus a VWAP hand-calc and a
trend-helper unit test in `tests/vwapPullback.test.js`.

## Validation

Run a backtest from the Lab (or `runLabBacktest`). The result carries the 70/30 in-sample /
out-of-sample split with per-period metrics and a walk-forward flag. Read win % only next to its
expectancy and trade count, and prefer the out-of-sample column.
