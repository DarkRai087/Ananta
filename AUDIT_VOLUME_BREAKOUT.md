# AUDIT — Volume Breakout (v1)

PHASE 1, read-only. Baseline numbers in [baseline_metrics.json](baseline_metrics.json).

## a) What the strategy does, step by step

Source: [volumeBreakout.js](server/strategies/volumeBreakout.js), registered in [strategies/index.js](server/strategies/index.js). It's a `defineStrategy` with an `onBar` (backtest/live decisions) and a `plan` (display only).

Per closed bar `i` (`onBar`), on one session's 5m candles:
1. **Warm-up gate** — skip until `i ≥ max(volPeriod, lookback) + 1` (= 21 bars with defaults). On 5m that is ~10:55, so no signal can fire before late morning.
2. **Volume spike** — `avg = volSma(volPeriod)` at bar `i−1` (trailing 20-bar simple average, *excluding* the current bar; [sessionData.js COMPUTE.volSma](server/lab/sessionData.js) → `sma(volumes)`). Require `bar.volume ≥ volMult × avg` (≥ 2×).
3. **Breakout** — `hh/ll = highest/lowest(lookback)` over the prior `lookback` bars ([BarContext.highest/lowest](server/lab/sessionData.js)). Long if `close > hh` **and** green (`close > open`); short if `close < ll` **and** red.
4. **Signal** — returns `{ side, stop, reason }`. Stop = the breakout bar's **other end** (`c.low` for long, `c.high` for short). No target.
5. **Fill / exit / sizing / costs** are the shared engine's job ([engine.js runSession](server/backtest/engine.js)): entry at the **next** bar's open, stop/target bracket via `bracket()`, size via `sizeForRisk()` ([costs.js](server/backtest/costs.js)), square-off at `settings.squareOff` (15:15). Every trade is **net of costs** (`tradeCosts`) + slippage.
6. `plan(ctx)` draws a "watch" with long/short triggers at the current `lookback` high/low and an *estimated* stop (`hh − barAtr`), for the UI only — the backtest never calls it.

Exits actually available come entirely from `COMMON_DEFAULTS` ([common.js](server/strategies/common.js)): `targetR` (default 2R), `stopType` (structure), optional breakeven/trailing — all engine-side, none set by the strategy.

## b) Current parameters and where they live

Strategy params ([volumeBreakout.js:10](server/strategies/volumeBreakout.js#L10)): `volMult 2`, `volPeriod 20`, `lookback 10`, `entryStart "09:30"`, `entryEnd "14:30"`.
Shared defaults ([common.js](server/strategies/common.js) `COMMON_DEFAULTS`): `allowLong/allowShort`, `stopType "structure"`, `atrPeriod 14`, `atrMult 1.5`, `targetR 2`, breakeven/trail options.
Account/run settings ([config/lab.js](server/config/lab.js) `LAB.backtest`): `riskPerTrade 1000`, `slippagePct 0.05`, `maxTradesPerDay 2`, `maxDailyLoss 3000`, `maxPositionValue 500000`, `squareOff 15:15`, `entryCutoff`.
Costs ([config/costs.js](server/config/costs.js)): STT, brokerage, exchange, SEBI, stamp, GST.

## c) Bugs and biases (the six specific checks)

| Check | Verdict | Detail |
|---|---|---|
| Incomplete/live candle volume used for signals | **OK** | The forming bar is dropped before the live plan runs ([plans/index.js:260](server/plans/index.js#L260) `c.time + intervalMin*60 <= now.t`); backtest reads only closed bar `i`. No bug. |
| Look-ahead (signal + fill same bar) | **OK** | Signal at close `i`, fill at **next** bar open (engine `pending`→next bar). Enforced for every strategy by [lookahead.test.js](server/tests/lookahead.test.js) + [sessionLeak.test.js](server/tests/sessionLeak.test.js). No bug. |
| Raw / simple N-bar average instead of time-of-day RVOL | **BUG (main one)** | Uses `volSma(20)` — a trailing *bar-count* average. It is time-of-day blind: an 09:35 bar is measured against bars that include the high-volume open, so the ratio is biased low mid-morning and the real RVOL edge is diluted. The app already stores true time-of-day volume (`ctx.ref.profile[].vol[slot]`, [sessions.js sessionProfile](server/lab/sessions.js)) over 60 prior sessions — v1 ignores it. |
| 09:15 auction-inflated bar triggers false signals | **Partial** | `entryStart 09:30` blocks the 09:15–09:25 bars as *entries*, and warm-up pushes the first signal to ~10:55 anyway — so no false 09:15 entry. **But** the auction bar's volume still sits inside the trailing `volSma(20)` window, inflating the denominator and *suppressing* later legitimate signals. The warm-up itself is a bias: it discards the highest-RVOL part of the day. |
| Missing bars / gaps from the free source | **Latent risk** | `volSma`, `highest/lowest(lookback)` and the warm-up are all **bar-count** windows, so a missing 5m bar silently shifts them in clock time and changes which "20 bars" / "10 bars" are used. Time-of-day RVOL (keyed by IST minute) is robust to this; bar-count windows are not. Candles are stored as received ([data/intraday.js]); no gap-fill. |
| No costs / slippage in P&L | **OK** | `tradeCosts()` (all six charges) + `slippagePct` are applied on every fill, and `sizeForRisk()` includes charges. All metrics are net. No bug. |

**Additional findings**
- **Stop has no minimum distance.** Stop = breakout bar's high/low. A small breakout candle → tiny risk-per-share → `sizeForRisk` returns a large qty capped only by `maxPositionValue`; noise then stops it instantly. (Spec PHASE 2 §7 adds a min-ATR floor.)
- **No target, no time stop.** Relies on the generic `targetR` (2R) or square-off; there is no measured-move target and no "exit if not +0.5R in N bars".
- **One breakout level only** (recent `lookback` high/low). No PDH/PDL, opening range, multi-day consolidation, 52-week, or VWAP-reclaim; no level typing or scoring.
- **No candle-quality or context filters** (close location in range, body size, wick rejection, NIFTF-vs-VWAP, relative strength, sector, circuit/ASM exclusion).
- **Benched.** v1 is in `BENCHED` ([strategies/index.js:30](server/strategies/index.js#L30)) — the Nov-1 OOS audit found it net-negative. The baseline below confirms it (expectancy −₹365/trade). As with the EMA work, the problem is **edge, not a coding defect** — the one real signal bug is the RVOL definition.

## d) Missing components vs the PHASE 2 target spec

Already present (reuse, don't rebuild): next-bar fills, no-lookahead, full costs/slippage, risk-based sizing + capital cap, metrics (win%, avg R, expectancy, PF net, max DD, avg hold), walk-forward split, Time Machine plan feed, `ctx.market("nifty").vwap`, time-of-day volume profile, tick helpers (`roundTick`/`tickFor`).

Missing, to build in v2:
1. **True RVOL** from `ctx.ref.profile` (same-slot, 20 sessions) + ignore the 09:15–09:20 bar (configurable).
2. **Level library + scoring**: PDH/PDL, OR, multi-day consolidation (≥2 touches), 52-week, VWAP reclaim; score by touches + prior tightness. *(52-week needs long daily history; `ctx.ref.daily` is 20 days — see risks.)*
3. **Contraction filter**: ATR(14) < its 20-period average, or range/ATR, or daily NR7.
4. **Breakout-candle quality**: ATR buffer beyond level, close in top/bottom 30%, body ≥ 0.5 ATR, reject long if upper wick > body.
5. **Context filters**: NIFTY-vs-VWAP, relative strength vs NIFTY, optional sector agreement, circuit-proximity + ASM/GSM exclude list, optional delivery-% boost from NSE bhavcopy.
6. **Entry modes**: "close" and "retest".
7. **Exits/sizing**: range-back/candle-low stop with min-ATR floor, measured-move or R target, time stop (+0.5R in N bars), no entries after 14:45, flat by 15:12, tick rounding.
8. **Stats**: follow-through + expectancy per stock and per level type; disable negative-OOS stock/level combos.
9. **Integration**: v2 plan → Time Machine; UI shows RVOL, level type, score, filters passed, expectancy + PF next to win%.

## Baseline (last 60 sessions × 10 liquid stocks)

[baseline_metrics.json](baseline_metrics.json) — v1, 5m, 2026-08-05 → 2026-10-30, RELIANCE/TCS/SBIN/INFY/ITC/LT/AXISBANK/KOTAKBANK/SUNPHARMA/TITAN, LAB defaults.

| | v1 |
|---|---|
| Trades | 555 |
| Win % | 29.0 |
| Avg R | −0.37 |
| Expectancy | −₹365/trade |
| Profit factor (net) | 0.45 |
| Max drawdown | ₹204,076 |
| Avg hold | 60 min |
| Net P&L | −₹202,396 |

PHASE 3 will re-run v2 on this exact window + symbol set (recorded in the JSON) and add a walk-forward OOS split.
