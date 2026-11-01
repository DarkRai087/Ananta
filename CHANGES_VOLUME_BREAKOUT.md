# CHANGES — Volume Breakout v1 → v2

Same window as the baseline: 5m, **2026-08-05 → 2026-10-30, 60 sessions**, 10 liquid stocks (RELIANCE, TCS, SBIN, INFY, ITC, LT, AXISBANK, KOTAKBANK, SUNPHARMA, TITAN). Walk-forward split at **2026-10-06** (70% in-sample / 30% out). Raw numbers: [baseline_metrics.json](baseline_metrics.json), [phase3_metrics.json](phase3_metrics.json). v1 stays registered as `volumeBreakout`; v2 is `volumeBreakoutV2`.

## a) What was there

v1 ([volumeBreakout.js](server/strategies/volumeBreakout.js)): a bar with `volume ≥ 2× trailing volSma(20)` closing beyond the last 10-bar high/low (green/red), stop at the breakout bar's other end, next-bar-open fill through the shared engine. Bugs/limits from the audit ([AUDIT_VOLUME_BREAKOUT.md](AUDIT_VOLUME_BREAKOUT.md)):
- **Volume measure is time-of-day blind** — a trailing bar-count average, not same-slot relative volume (the one real signal defect).
- **Warm-up + trailing window** discard the high-RVOL open and are bar-count (gap-sensitive).
- **No min-stop-distance floor** (tiny breakout candle → oversized position), **no target**, **no time stop**, **one level type**, **no quality or context filters**.
- No incomplete-candle or look-ahead bug; costs/slippage already applied.

## b) What changed (and why), files touched

All in [volumeBreakoutV2.js](server/strategies/volumeBreakoutV2.js) unless noted; every filter is a toggle in the one params object.

| Change | Why | 
|---|---|
| **True RVOL** = bar volume ÷ same 5-min slot average over 20 prior sessions (`ctx.ref.profile`) | Fixes the audit's main defect; time-of-day aware, gap-robust |
| **Typed, scored levels**: PDH/PDL, opening range, multi-day consolidation (≥2 touches), VWAP reclaim | Breakout stats per level type; score = touches + range tightness |
| **Contraction filter** (ATR < its own recent average) | Only break out of a coiled range |
| **Candle-quality filter** (ATR buffer, close in top/bottom 30%, body ≥ 0.5 ATR, reject wick > body) | Avoid weak / selling-into-strength breakouts |
| **Context filters**: NIFTY vs VWAP, relative strength vs NIFTY, optional sector | Trade with the tape |
| **Entry modes** `close` / `retest` | Retest = wait N bars for a pullback that holds |
| **Exits**: min-ATR stop floor, measured-move target, time stop (no +0.5R in 6 bars) | Fixes the thin-stop / no-target / no-time-stop gaps |
| **Tick rounding** of stop/target (`roundTick`/`tickFor`) | Real, placeable prices |
| Config exclude / disabled-combo lists | [config/volumeBreakout.js](server/config/volumeBreakout.js) — symbol-level, applied where symbols are chosen |
| Registered v2 | [strategies/index.js](server/strategies/index.js) |
| Tests | [volumeBreakoutV2.test.js](server/tests/volumeBreakoutV2.test.js) — RVOL slot math, stop floor + tick, measured target, level detection, net-of-cost sizing |
| Session-leak test refined | [sessionLeak.test.js](server/tests/sessionLeak.test.js) — holds the *per-slot volume profile* equal (an allowed `ctx.ref` summary, which v2's RVOL legitimately uses) while still varying prior-day price shape |

Reused unchanged: engine fills/costs/sizing, metrics, walk-forward, Time Machine plan feed, `ctx.market`, tick helpers. UI already shows expectancy + PF next to win% ([StrategyDetail.jsx](client/src/components/StrategyDetail.jsx)); v2's plan note carries RVOL, level type, score and which context notes passed.

## c) v1 vs v2 (net of all costs)

| | v1 all | v1 IS | v1 OOS | v2 all | v2 IS | v2 OOS |
|---|--:|--:|--:|--:|--:|--:|
| Trades | 555 | 397 | 158 | 197 | 136 | 61 |
| Win % | 29.0 | 28.0 | 31.7 | 19.3 | 18.4 | 21.3 |
| Avg R | −0.37 | −0.37 | −0.36 | −0.42 | −0.44 | −0.39 |
| Expectancy ₹/trade | −365 | −366 | −360 | −423 | −440 | −387 |
| Profit factor | 0.45 | 0.44 | 0.48 | 0.17 | 0.18 | 0.15 |
| Max drawdown ₹ | 204,076 | 150,791 | 58,591 | 84,055 | 60,191 | 23,865 |
| Avg hold (min) | 60 | 63 | 54 | 31 | 29 | 35 |
| Net ₹ | −202,396 | −145,497 | −56,898 | −83,413 | −59,817 | −23,597 |

**Honest read:** v2 is far more selective — ~⅓ the trades, ~⅖ the drawdown, half the hold time, and it loses less in absolute ₹. But it is **still net-negative, and worse per trade** (PF 0.15 vs 0.48): the measured-move targets rarely fill (target-exit rate 0–21% by level), so most trades drift to the time stop or square-off as small losses. On this universe/window the breakout premise itself has no edge — the extra machinery cleans up the behaviour without manufacturing an edge that isn't there. (Setting `targetR: 2` makes v2 use v1's R-target exit instead of the measured move, if you want to isolate that.)

## d) Filter ablation (out-of-sample, v2 with one filter removed)

| Variant | OOS trades | OOS exp ₹/trade | OOS net ₹ | Win % |
|---|--:|--:|--:|--:|
| v2 (all filters) | 61 | −387 | −23,597 | 21.3 |
| − contraction | 94 | −401 | −37,704 | 22.3 |
| − candle quality | 130 | −375 | −48,734 | 21.5 |
| − NIFTY vs VWAP | 97 | −424 | −41,111 | 20.6 |
| − relative strength | 93 | **−481** | −44,739 | 17.2 |
| − RVOL (mult 1.0) | 130 | −349 | −45,323 | 21.5 |
| retest entry | 3 | −894 | −2,683 | 0 |

**Which filters add value:** **relative strength** helps most (removing it is the worst per-trade, −481, and lowest win%); **NIFTY-vs-VWAP** and **contraction** also help per trade. **RVOL ≥ 2×** and **candle quality** mainly cut volume — per-trade expectancy barely moves (RVOL at 1.0 is even slightly less-bad per trade), so on this data their value is drawdown control, not edge. **Retest** is unusable here (almost never triggers in 60 sessions). By level type (all v2 trades): OR 115t/−399, CONSOL 37t/−376, VWAP 28t/−492, PDH_PDL 17t/−579 — all negative; none clears costs.

## e) Not implemented, and why

- **52-week-high level** — strategies see only ~20 days of daily history; supporting it needs a new daily-history data path (deferred, PHASE 1 decision).
- **NSE bhavcopy delivery-% boost & live ASM/GSM** — a new external source and schema; deferred for "no new paid/external services". Replaced by a hand-maintained [config/volumeBreakout.js](server/config/volumeBreakout.js) `excludeSymbols` list.
- **Circuit-proximity (within 2%)** — needs each instrument's circuit band, not in the free cache; folded into the static exclude list.
- **Flat-by 15:12** — square-off is a shared setting (`squareOff`, default 15:15); a per-strategy time would need an engine change. Set `squareOff: "15:12"` in settings to apply it globally.
- **Disabled stock×level combos** — the mechanism and config exist (`disabledCombos`); left empty (the per-level stats above would populate it once a bigger, more trustworthy sample justifies it).

## Verdict
v2 is the cleaner, safer, more selective strategy and the audit's real bug (RVOL) is fixed — but on 60 sessions × 10 large-caps it does **not** turn a profit, and the ablation says the breakout edge isn't hiding behind any single filter. Recommend keeping it **benched** alongside v1 until a wider universe / longer history (and perhaps the R-target exit) shows a positive out-of-sample context.
