import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Chart from "../components/Chart.jsx";
import SymbolSearch from "../components/SymbolSearch.jsx";
import ParamsForm from "../components/ParamsForm.jsx";
import EquityCurve from "../components/EquityCurve.jsx";
import JobProgress from "../components/JobProgress.jsx";
import { startJob, waitForJob, labSessions, labSession, getWatchlist, saveWatchlist } from "../api.js";
import { fmtPct, fmtR, fmtRs, fmtNum, fmtPrice, fmtHHMM, isoDaysAgo, store } from "../format.js";
import { abbrev } from "./TodayPage.jsx";
import { exitsText } from "../components/WinRate.jsx";

const SETTINGS_SPEC = [
  { key: "riskPerTrade", label: "Max loss per trade ₹ (incl. charges)", type: "number", step: 100 },
  { key: "slippagePct", label: "Slippage %", type: "number", step: 0.01 },
  { key: "maxTradesPerDay", label: "Max trades / day", type: "number", step: 1 },
  { key: "maxDailyLoss", label: "Daily max loss ₹ (0 = off)", type: "number", step: 500 },
  { key: "maxPositionValue", label: "Max position value ₹", type: "number", step: 50000 },
  { key: "profitTarget", label: "Profit target ₹ after charges (0 = strategy's)", type: "number", step: 500 },
  { key: "entryCutoff", label: "No entries after", type: "time" },
  { key: "squareOff", label: "Square-off", type: "time" },
];

const METRIC_ROWS = [
  ["Trades", (m) => m.trades],
  ["Win % (made money after charges)", (m) => (m.trades ? `${fmtPct(m.winPct, 1)} (${m.wins}/${m.trades})` : "—")],
  ["Likely win range (95%)", (m) => (m.winLow != null ? `${fmtPct(m.winLow, 1)} – ${fmtPct(m.winHigh, 1)}` : "—")],
  ["Win % needed to break even", (m) => fmtPct(m.breakEvenWinPct, 1)],
  ["How trades ended", (m) => exitsText(m.exits) || "—"],
  ["Avg win", (m) => `${fmtR(m.avgWinR)} · ${fmtRs(m.avgWinRs)}`],
  ["Avg loss", (m) => `${fmtR(m.avgLossR)} · ${fmtRs(m.avgLossRs)}`],
  ["Expectancy (net)", (m) => `${fmtR(m.expectancyR)} · ${fmtRs(m.expectancyRs)}`],
  ["Expectancy (gross)", (m) => fmtR(m.grossExpectancyR)],
  ["Gross P&L", (m) => fmtRs(m.grossPnl)],
  ["Costs", (m) => fmtRs(m.totalCosts)],
  ["Net P&L", (m) => fmtRs(m.netPnl)],
  ["Profit factor", (m) => fmtNum(m.profitFactor)],
  ["Max drawdown", (m) => fmtRs(m.maxDrawdown)],
];

function StrategyResults({ r, onPickTrade }) {
  const [limit, setLimit] = useState(200);
  const flagClass = { holds: "pos", "is-only": "neg", "oos-only": "warn", none: "neg", insufficient: "muted" }[r.flag.id];
  return (
    <div className="res">
      <div className="res-head">
        <h3>{r.strategy.name}</h3>
        <span className={`badge ${flagClass}`}>{r.flag.label}</span>
        <span className="small muted">
          {r.symbolsWithData.length} symbol(s) · {r.interval} · {r.from} → {r.to} · {r.sessions} sessions · out-of-sample from {r.splitDate ?? "—"} · {r.skipped} signals skipped (bad stop / qty 0)
        </span>
      </div>
      <div className="res-grid">
        <table className="grid metrics">
          <thead>
            <tr>
              <th></th>
              <th className="num">All</th>
              <th className="num">In-sample (70%)</th>
              <th className="num">Out-of-sample (30%)</th>
            </tr>
          </thead>
          <tbody>
            {METRIC_ROWS.map(([label, f]) => (
              <tr key={label}>
                <td>{label}</td>
                <td className="num">{f(r.all)}</td>
                <td className="num">{f(r.is)}</td>
                <td className="num">{f(r.oos)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <div className="small muted">Net equity after charges (₹)</div>
          <EquityCurve equity={r.all.equity} splitTime={r.oos.equity?.[0]?.time} />
          <table className="grid">
            <thead>
              <tr>
                <th>Entry time</th>
                <th className="num">Trades</th>
                <th className="num">Win %</th>
                <th className="num">Expectancy</th>
                <th className="num">Net P&L</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(r.all.byBucket).map(([id, b]) => (
                <tr key={id}>
                  <td>{b.label}</td>
                  <td className="num">{b.trades}</td>
                  <td className="num">{fmtPct(b.winPct, 1)}</td>
                  <td className="num">{fmtR(b.expectancyR)}</td>
                  <td className="num">{fmtRs(b.netPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h4>
        Trades {r.tradesTruncated ? "(last 20,000)" : ""} — click one to view it on the chart
      </h4>
      <div className="table-wrap trades">
        <table className="grid">
          <thead>
            <tr>
              <th>Date</th>
              <th>Symbol</th>
              <th>Side</th>
              <th>In</th>
              <th>Out</th>
              <th className="num">Entry</th>
              <th className="num">Exit</th>
              <th className="num">Qty</th>
              <th>Exit reason</th>
              <th className="num">Gross</th>
              <th className="num">Costs</th>
              <th className="num">Net</th>
              <th className="num">R</th>
            </tr>
          </thead>
          <tbody>
            {r.trades.slice(0, limit).map((t, k) => (
              <tr key={k} className={t.outcome === "win" ? "pos" : t.outcome === "loss" ? "neg" : "forced"} onClick={() => onPickTrade(t)}>
                <td>{t.date}</td>
                <td>{t.symbol}</td>
                <td>{t.side}</td>
                <td>{fmtHHMM(t.entryTime)}</td>
                <td>{fmtHHMM(t.exitTime)}</td>
                <td className="num">{fmtPrice(t.entry)}</td>
                <td className="num">{fmtPrice(t.exit)}</td>
                <td className="num">{t.qty}</td>
                <td>{t.reason}</td>
                <td className="num">{fmtRs(t.gross)}</td>
                <td className="num">{fmtRs(t.costs)}</td>
                <td className="num">{fmtRs(t.net)}</td>
                <td className="num">{fmtR(t.rNet)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.trades.length > limit && (
        <button className="link" onClick={() => setLimit((l) => l + 500)}>
          Show more ({r.trades.length - limit} left)
        </button>
      )}
    </div>
  );
}

function PatternResults({ r }) {
  const [open, setOpen] = useState(null);
  const H = r.horizons;
  const cell = (s) =>
    s ? (
      <>
        <span className={s.avgMove > s.baseAvgMove ? "up" : "down"}>{fmtNum(s.avgMove, 3)}%</span>
        <span className="muted"> vs {fmtNum(s.baseAvgMove, 3)}%</span>
        {s.winRate != null && (
          <div className="small">
            win {fmtPct(s.winRate)} <span className="muted">vs {fmtPct(s.baseWinRate)}</span>
          </div>
        )}
      </>
    ) : (
      "—"
    );
  return (
    <div className="res">
      <div className="res-head">
        <h3>Pattern stats</h3>
        <span className="small muted">
          {r.symbols.length} symbol(s) · {r.interval} · {r.from} → {r.to} · {r.sessions} sessions · {r.measure}; forward window stops at 15:15 the same day; baseline = random bars from
          the same sessions. Click a row for time-of-day buckets.
        </span>
      </div>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Pattern</th>
              <th>Dir</th>
              <th className="num">Count</th>
              {H.map((n) => (
                <th key={n} className="num">
                  +{n} bars
                </th>
              ))}
              <th className="num">t (+{r.primaryHorizon})</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {r.patterns.map((p) => (
              <Fragment key={p.name}>
                <tr onClick={() => setOpen(open === p.name ? null : p.name)} className={p.label === "edge" ? "pos" : p.label === "no edge" ? "neg" : ""}>
                  <td>{p.name}</td>
                  <td>{p.direction}</td>
                  <td className="num">{p.count}</td>
                  {H.map((n) => (
                    <td key={n} className="num">
                      {cell(p.horizons[n])}
                    </td>
                  ))}
                  <td className="num">{fmtNum(p.horizons[r.primaryHorizon]?.t)}</td>
                  <td>
                    <span className={`badge ${p.label === "edge" ? "pos" : p.label === "weak edge" ? "warn" : p.label === "no edge" ? "neg" : "muted"}`}>{p.label}</span>
                  </td>
                </tr>
                {open === p.name &&
                  Object.entries(p.buckets).map(([id, b]) => (
                    <tr key={p.name + id} className="sub">
                      <td colSpan={2}>↳ {id === "open" ? "09:15–10:30" : id === "morning" ? "10:30–11:30" : id === "midday" ? "11:30–13:30" : "13:30–15:15"}</td>
                      <td className="num">{b.count}</td>
                      {H.map((n) => (
                        <td key={n} className="num">
                          {cell(b.h[n])}
                        </td>
                      ))}
                      <td className="num">{fmtNum(b.h[r.primaryHorizon]?.t)}</td>
                      <td>{b.h[r.primaryHorizon]?.label}</td>
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function LabPage({ meta, symbol, setSymbol }) {
  const p = meta.provider;
  const [targetKind, setTargetKind] = useState(() => store.get("lab.targetKind", "SYMBOL"));
  const [interval, setIntervalId] = useState(() => store.get("lab.interval", meta.defaultInterval));
  const maxDays = p.limits[interval];
  const [from, setFrom] = useState(() => isoDaysAgo(maxDays ? maxDays - 1 : 365));
  const [to, setTo] = useState(() => isoDaysAgo(0));
  const [mode, setMode] = useState(() => store.get("lab.mode", "strategy"));
  const [strategyId, setStrategyId] = useState(() => store.get("lab.strategy", meta.strategies[0].id));
  const [paramsById, setParamsById] = useState(() => store.get("lab.params", {}));
  const [settings, setSettings] = useState(() => ({ ...meta.backtest, ...store.get("lab.settings", {}) }));
  const [patternIds, setPatternIds] = useState(meta.patterns.map((x) => x.id));
  const [horizons, setHorizons] = useState(meta.patternStats.horizons.join(","));
  const [watchText, setWatchText] = useState("");

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [result, setResult] = useState(null);
  const ctrlRef = useRef(null);

  // Session viewer
  const [viewSymbol, setViewSymbol] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [viewDate, setViewDate] = useState(null);
  const [session, setSession] = useState(null);
  const [pickedTrade, setPickedTrade] = useState(null);

  const strategy = meta.strategies.find((s) => s.id === strategyId) || meta.strategies[0];
  const params = { ...strategy.params, ...(paramsById[strategy.id] || {}) };

  useEffect(() => store.set("lab.targetKind", targetKind), [targetKind]);
  useEffect(() => store.set("lab.interval", interval), [interval]);
  useEffect(() => store.set("lab.mode", mode), [mode]);
  useEffect(() => store.set("lab.strategy", strategyId), [strategyId]);
  useEffect(() => store.set("lab.params", paramsById), [paramsById]);
  useEffect(() => store.set("lab.settings", settings), [settings]);
  useEffect(() => {
    if (targetKind === "WATCHLIST") getWatchlist().then((w) => setWatchText(w.join(", "))).catch(() => {});
  }, [targetKind]);

  const target = targetKind === "SYMBOL" ? symbol : targetKind;

  const run = async () => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setRunning(true);
    setError(null);
    setWarnings([]);
    setResult(null);
    setProgress({ phase: "data", done: 0, total: 1, message: "Starting" });
    try {
      const body =
        mode === "strategy"
          ? { kind: "backtest", target, interval, from, to, strategy: strategy.id, params, settings }
          : { kind: "patterns", target, interval, from, to, patternIds, horizons: horizons.split(",").map(Number).filter((n) => n > 0) };
      const job = await startJob(body);
      const done = await waitForJob(job.id, { signal: ctrl.signal, onProgress: (j) => setProgress(j.progress) });
      setResult(done.result);
      setWarnings(done.warnings || []);
      const syms = done.result.kind === "backtest" ? done.result.symbolsWithData : done.result.symbols;
      setViewSymbol(syms[0] || null);
      setPickedTrade(null);
    } catch (e) {
      if (e.name !== "AbortError") {
        setError(e.message);
        setWarnings(e.warnings || []);
      }
    } finally {
      if (!ctrl.signal.aborted) {
        setRunning(false);
        setProgress(null);
      }
    }
  };

  // Sessions available for the viewed symbol.
  useEffect(() => {
    if (!viewSymbol || !result) return;
    const ctrl = new AbortController();
    labSessions(viewSymbol, result.interval, result.from, result.to, ctrl.signal)
      .then((list) => {
        const regular = list.filter((s) => !s.special);
        setSessions(regular);
        setViewDate((d) => (pickedTrade?.symbol === viewSymbol ? pickedTrade.date : regular.some((s) => s.date === d) ? d : regular[regular.length - 1]?.date ?? null));
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [viewSymbol, result, pickedTrade]);

  // One session's candles (+ pattern markers).
  useEffect(() => {
    if (!viewSymbol || !viewDate || !result) return;
    const ctrl = new AbortController();
    const opts = result.kind === "patterns" ? { patterns: patternIds } : {};
    labSession(viewSymbol, result.interval, viewDate, opts, ctrl.signal)
      .then(setSession)
      .catch((e) => e.name !== "AbortError" && setSession(null));
    return () => ctrl.abort();
  }, [viewSymbol, viewDate, result, patternIds]);

  const chartData = useMemo(() => (session ? { candles: session.candles, intraday: true } : null), [session]);

  const dayTrades = useMemo(
    () => (result?.kind === "backtest" ? result.trades.filter((t) => t.symbol === viewSymbol && t.date === viewDate) : []),
    [result, viewSymbol, viewDate]
  );

  const markers = useMemo(() => {
    if (!session) return [];
    if (result?.kind === "patterns") return session.markers.map((m) => ({ ...m, text: abbrev(m.name) }));
    const out = [];
    for (const t of dayTrades) {
      const long = t.side === "long";
      out.push({ time: t.entryTime, position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown", color: "#4fc3f7", text: long ? "BUY" : "SELL" });
      out.push({
        time: t.exitTime,
        position: long ? "aboveBar" : "belowBar",
        shape: "circle",
        color: t.outcome === "win" ? "#26a69a" : t.outcome === "loss" ? "#ef5350" : "#bdbdbd",
        text: `${t.reason} ${fmtR(t.rNet)}`,
      });
    }
    return out;
  }, [session, dayTrades, result]);

  const levels = useMemo(() => {
    const t = pickedTrade && pickedTrade.symbol === viewSymbol && pickedTrade.date === viewDate ? pickedTrade : dayTrades[0];
    if (!t) return [];
    const lv = [
      { price: t.entry, label: "entry", color: "#4fc3f7" },
      { price: t.stop, label: "stop", color: "#ef5350" },
    ];
    // Breakeven / trailing moved the stop: also show where it started.
    if (t.initialStop != null && t.initialStop !== t.stop) lv.push({ price: t.initialStop, label: "initial stop", color: "#ef9a9a" });
    if (t.target != null) lv.push({ price: t.target, label: "target", color: "#26a69a" });
    return lv;
  }, [pickedTrade, dayTrades, viewSymbol, viewDate]);

  const idx = sessions.findIndex((s) => s.date === viewDate);
  const symbolsForView = result ? (result.kind === "backtest" ? result.symbolsWithData : result.symbols) : [];

  return (
    <div className="lab-page">
      <section className="lab-form">
        <div className="row">
          <label>
            <span>Symbol / universe</span>
            <select value={targetKind} onChange={(e) => setTargetKind(e.target.value)}>
              <option value="SYMBOL">Symbol: {symbol}</option>
              {meta.universes.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.count})
                </option>
              ))}
            </select>
          </label>
          {targetKind === "SYMBOL" && (
            <label>
              <span>Change symbol</span>
              <SymbolSearch onSelect={setSymbol} />
            </label>
          )}
          {targetKind === "WATCHLIST" && (
            <label className="grow">
              <span>Watchlist (comma separated)</span>
              <span className="inline">
                <input value={watchText} onChange={(e) => setWatchText(e.target.value)} placeholder="RELIANCE, TCS, INFY" />
                <button onClick={() => saveWatchlist(watchText.split(/[\s,]+/).filter(Boolean)).then((w) => setWatchText(w.join(", ")))}>Save</button>
              </span>
            </label>
          )}
          <label>
            <span>Interval</span>
            <select value={interval} onChange={(e) => setIntervalId(e.target.value)}>
              {p.intervals.map((iv) => (
                <option key={iv}>{iv}</option>
              ))}
            </select>
          </label>
          <label>
            <span>From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span>To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <div className="seg">
            <button className={mode === "strategy" ? "active" : ""} onClick={() => setMode("strategy")}>
              Strategy
            </button>
            <button className={mode === "patterns" ? "active" : ""} onClick={() => setMode("patterns")}>
              Patterns
            </button>
          </div>
          <button className="primary" onClick={run} disabled={running || !target}>
            {running ? "Running…" : "Run"}
          </button>
        </div>
        {maxDays && (
          <div className="small warning">
            {p.name} only has ~{maxDays} days of {interval} data. Add SmartAPI keys to server/.env for years of history.
          </div>
        )}

        {mode === "strategy" ? (
          <>
            <div className="row">
              <label>
                <span>Strategy</span>
                <select value={strategy.id} onChange={(e) => setStrategyId(e.target.value)}>
                  {meta.strategies.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <span className="small muted grow">{strategy.description}</span>
              <button className="link" onClick={() => setParamsById((x) => ({ ...x, [strategy.id]: {} }))}>
                Reset params
              </button>
            </div>
            <ParamsForm spec={strategy.spec} values={params} onChange={(v) => setParamsById((x) => ({ ...x, [strategy.id]: v }))} />
            <details>
              <summary className="small">Backtest settings (risk, slippage, limits)</summary>
              <ParamsForm spec={SETTINGS_SPEC} values={settings} onChange={setSettings} />
              <div className="small muted">
                Costs (server/config/costs.js): brokerage ₹{meta.costs.brokeragePerOrder}/order · STT {meta.costs.sttSellPct}% sell · NSE txn {meta.costs.exchangeTxnPct}% · SEBI ₹
                {meta.costs.sebiPerCrore}/cr · stamp {meta.costs.stampBuyPct}% buy · GST {meta.costs.gstPct}% on {meta.costs.gstOn.join(" + ")}.
              </div>
            </details>
          </>
        ) : (
          <div className="row wrap">
            <label>
              <span>Forward bars</span>
              <input value={horizons} onChange={(e) => setHorizons(e.target.value)} style={{ width: 90 }} />
            </label>
            <span className="small">
              <button className="link" onClick={() => setPatternIds(meta.patterns.map((x) => x.id))}>
                all
              </button>{" "}
              /{" "}
              <button className="link" onClick={() => setPatternIds([])}>
                none
              </button>
            </span>
            {meta.patterns.map((x) => (
              <label key={x.id} className="check">
                <input
                  type="checkbox"
                  checked={patternIds.includes(x.id)}
                  onChange={() => setPatternIds((ids) => (ids.includes(x.id) ? ids.filter((i) => i !== x.id) : [...ids, x.id]))}
                />
                {x.names.join(" / ")}
              </label>
            ))}
          </div>
        )}
        {running && <JobProgress progress={progress} />}
        {error && <div className="banner error">{error}</div>}
        {warnings.length > 0 && (
          <details className="small muted">
            <summary>{warnings.length} data warning(s)</summary>
            {warnings.slice(0, 100).map((w) => (
              <div key={w}>{w}</div>
            ))}
          </details>
        )}
      </section>

      {result && (
        <section className="viewer">
          <div className="row">
            {symbolsForView.length > 1 && (
              <select value={viewSymbol || ""} onChange={(e) => setViewSymbol(e.target.value)}>
                {symbolsForView.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            )}
            <button onClick={() => idx > 0 && setViewDate(sessions[idx - 1].date)} disabled={idx <= 0}>
              ◀ Prev day
            </button>
            <select value={viewDate || ""} onChange={(e) => setViewDate(e.target.value)}>
              {sessions.map((s) => (
                <option key={s.date} value={s.date}>
                  {s.date}
                </option>
              ))}
            </select>
            <button onClick={() => idx < sessions.length - 1 && setViewDate(sessions[idx + 1].date)} disabled={idx < 0 || idx >= sessions.length - 1}>
              Next day ▶
            </button>
            <span className="small muted">
              {viewSymbol} · {viewDate} · {result.kind === "backtest" ? `${dayTrades.length} trade(s) this day` : `${session?.markers?.length ?? 0} pattern(s) this day`}
              {session?.prev ? ` · PDH ${fmtPrice(session.prev.high)} · PDL ${fmtPrice(session.prev.low)} · PDC ${fmtPrice(session.prev.close)}` : ""}
            </span>
          </div>
          <div className="chart-wrap lab-chart">
            <Chart data={chartData} markers={markers} levels={levels} />
          </div>
        </section>
      )}

      {result?.kind === "backtest" && (
        <StrategyResults
          r={result}
          onPickTrade={(t) => {
            setPickedTrade(t);
            setViewSymbol(t.symbol);
            setViewDate(t.date);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      )}
      {result?.kind === "patterns" && <PatternResults r={result} />}
    </div>
  );
}
