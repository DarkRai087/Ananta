import { useCallback, useEffect, useMemo, useState } from "react";
import Chart from "../components/Chart.jsx";
import SymbolSearch from "../components/SymbolSearch.jsx";
import OverlayBar from "../components/OverlayBar.jsx";
import Top3Panel from "../components/Top3Panel.jsx";
import Scoreboard from "../components/Scoreboard.jsx";
import OutlookPanel from "../components/OutlookPanel.jsx";
import AccountBar, { DEFAULT_ACCOUNT } from "../components/AccountBar.jsx";
import MarketLink from "../components/MarketLink.jsx";
import TradePlans, { planLevels } from "../components/TradePlans.jsx";
import { fetchCandles, fetchPlans, fetchPrediction, fetchIndexLink } from "../api.js";
import { useToday, useLiveData } from "../hooks.js";
import { fmtPrice, fmtTime, isMarketOpen, store } from "../format.js";

const INTERVALS = [
  { id: "1d", label: "1D" },
  { id: "1w", label: "1W" },
  { id: "1mo", label: "1M" },
  { id: "1h", label: "1H", gap: true },
  { id: "15m", label: "15m", gap: true, lab: true },
  { id: "5m", label: "5m", lab: true },
  { id: "3m", label: "3m", lab: true },
  { id: "1m", label: "1m", lab: true },
];
const LAB_IVS = INTERVALS.filter((i) => i.lab).map((i) => i.id);

const LIVE_POLL_MS = 15_000;

const LEVEL_COLORS = {
  orHigh: "#ffd54f", orLow: "#ffd54f", vwap: "#f0a030", pdh: "#bdbdbd", pdl: "#bdbdbd", pdc: "#e0e0e0",
  vwapUpper: "#f0a030", vwapLower: "#f0a030", h3: "#ef9a9a", h4: "#ef5350", l3: "#a5d6a7", l4: "#26a69a",
  buy: "#26a69a", sell: "#ef5350", stop: "#ff9800", target: "#42a5f5", orMid: "#ffd54f",
};

export const abbrev = (name) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

export default function TodayPage({ meta, symbol, setSymbol }) {
  const [interval, setIntervalId] = useState(() => store.get("nse.interval", "1d"));
  const [overlays, setOverlays] = useState(() => store.get("nse.overlays", []));
  const [patterns, setPatterns] = useState(() => store.get("nse.patterns", []));
  const [orMinutes, setOrMinutes] = useState(15);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [topTarget, setTopTarget] = useState(() => store.get("nse.topTarget", "SYMBOL"));
  const [topInterval, setTopInterval] = useState(() => store.get("nse.topInterval", meta.defaultInterval));
  const [oosSessions, setOosSessions] = useState(() => store.get("nse.oos", meta.ranking.oosSessions));
  const [selected, setSelected] = useState(null);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [account, setAccount] = useState(() => ({ ...DEFAULT_ACCOUNT, ...store.get("nse.account", {}) }));
  useEffect(() => store.set("nse.account", account), [account]);
  const accountKey = JSON.stringify(account);

  const isLab = LAB_IVS.includes(interval);
  const target = topTarget === "SYMBOL" ? symbol : topTarget;
  const today = useToday(target, topInterval, oosSessions, meta.ranking, account);

  // Every strategy's live trade plan, and the up/down outlook, for the chart symbol.
  const plans = useLiveData((signal) => fetchPlans(symbol, topInterval, account, signal), `${symbol}|${topInterval}|${accountKey}`, { everyMs: LIVE_POLL_MS });
  const pred = useLiveData((signal) => fetchPrediction(symbol, topInterval, signal), `${symbol}|${topInterval}`, { everyMs: 60_000 });
  const link = useLiveData((signal) => fetchIndexLink(symbol, topInterval, signal), `${symbol}|${topInterval}`, { everyMs: 30_000 });
  // Levels from an open scoreboard dropdown ("Show on chart" in a decision report).
  const [detailLevels, setDetailLevels] = useState(null);
  const onDetailLevels = useCallback((lv) => {
    setDetailLevels(lv);
    if (lv) setIntervalId((cur) => (LAB_IVS.includes(cur) ? cur : topInterval));
  }, [topInterval]);

  useEffect(() => store.set("nse.interval", interval), [interval]);
  useEffect(() => store.set("nse.overlays", overlays), [overlays]);
  useEffect(() => store.set("nse.patterns", patterns), [patterns]);
  useEffect(() => store.set("nse.topTarget", topTarget), [topTarget]);
  useEffect(() => store.set("nse.topInterval", topInterval), [topInterval]);
  useEffect(() => store.set("nse.oos", oosSessions), [oosSessions]);
  useEffect(() => setSelected(null), [target, topInterval]);
  useEffect(() => setSelectedPlan(null), [symbol, topInterval]);

  // Candles (+ overlays / pattern markers on intraday intervals).
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const opts = isLab ? { overlays, patterns, orMinutes } : {};
    fetchCandles(symbol, interval, opts, ctrl.signal)
      .then((d) => setData(d))
      .catch((err) => err.name !== "AbortError" && setError(err.message))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [symbol, interval, isLab, overlays, patterns, orMinutes]);

  // Live updates: re-fetch quietly while the market is open (weekdays 09:15–15:30 IST).
  // The server only asks the provider for bars newer than its cache, so this is cheap.
  useEffect(() => {
    let ctrl = null;
    const id = setInterval(() => {
      if (!isMarketOpen() || document.hidden || ctrl) return;
      ctrl = new AbortController();
      const opts = isLab ? { overlays, patterns, orMinutes } : {};
      fetchCandles(symbol, interval, opts, ctrl.signal)
        .then((d) => setData(d))
        .catch(() => {}) // keep showing the last good data; the next tick retries
        .finally(() => (ctrl = null));
    }, LIVE_POLL_MS);
    return () => {
      clearInterval(id);
      ctrl?.abort();
    };
  }, [symbol, interval, isLab, overlays, patterns, orMinutes]);

  const markers = useMemo(
    () => (data?.markers || []).map((m) => ({ ...m, text: patterns.length <= 6 ? abbrev(m.name) : "" })),
    [data, patterns.length]
  );

  // Key levels of the selected Top 3 card, plus entry / stop / target of the selected plan
  // (re-read from the latest poll so the lines follow live updates).
  const livePlan = selectedPlan && plans.data?.strategies.find((p) => p.id === selectedPlan.id);
  const levels = useMemo(
    () => [
      ...(selected?.levels || []).map((l) => ({ price: l.price, label: l.label, color: LEVEL_COLORS[l.key] || "#90caf9" })),
      ...planLevels(livePlan),
      ...(detailLevels || []).map((l) => ({ price: l.price, label: l.label, color: LEVEL_COLORS[l.key] || "#90caf9" })),
    ],
    [selected, livePlan, detailLevels]
  );

  // Backtest stats per strategy (out-of-sample, after charges) for the plan table.
  const planStats = useMemo(() => {
    const r = today.result;
    if (!r) return null;
    return Object.fromEntries(r.scoreboard.map((row) => [row.id, row.all.oos]));
  }, [today.result]);
  const onSelectPlan = (p) => {
    setSelectedPlan(p);
    if (p && !LAB_IVS.includes(interval)) setIntervalId(topInterval);
  };

  const onSelectCard = (card) => {
    setSelected(card);
    if (card && !LAB_IVS.includes(interval)) setIntervalId(topInterval);
  };

  const s = data?.stats;
  const up = (s?.change ?? 0) >= 0;
  const legend = useMemo(() => {
    const names = [...new Set((data?.markers || []).map((m) => m.name))];
    return names.length && patterns.length <= 6 ? names.map((n) => `${abbrev(n)} = ${n}`).join(" · ") : null;
  }, [data, patterns.length]);

  const topControls = (
    <span className="top-controls">
      <select value={topTarget} onChange={(e) => setTopTarget(e.target.value)}>
        <option value="SYMBOL">{symbol}</option>
        {meta.universes.map((u) => (
          <option key={u.id} value={u.id} disabled={!u.count}>
            {u.name} ({u.count})
          </option>
        ))}
      </select>
      <select value={topInterval} onChange={(e) => setTopInterval(e.target.value)}>
        {meta.provider.intervals.map((iv) => (
          <option key={iv}>{iv}</option>
        ))}
      </select>
      <label className="small muted">
        OOS sessions{" "}
        <input type="number" min={10} max={500} step={10} value={oosSessions} onChange={(e) => setOosSessions(Number(e.target.value) || meta.ranking.oosSessions)} />
      </label>
    </span>
  );

  return (
    <div className="today-page">
      <header className="header">
        <SymbolSearch onSelect={setSymbol} />
        {data && (
          <div className="quote">
            <span className="q-symbol">{data.symbol}</span>
            <span className="q-name">{data.name}</span>
            <span className="q-price">{fmtPrice(s.lastClose)}</span>
            {s.changePct != null && (
              <span className={up ? "q-change up" : "q-change down"}>
                {up ? "+" : ""}
                {fmtPrice(s.change)} ({up ? "+" : ""}
                {s.changePct.toFixed(2)}%)
              </span>
            )}
            <span className="q-range">
              {fmtTime(s.from, data.intraday)} → {fmtTime(s.to, data.intraday)} · {s.count.toLocaleString("en-IN")} bars
            </span>
          </div>
        )}
        <div className="intervals">
          {INTERVALS.map((i) => (
            <button
              key={i.id}
              className={`${i.id === interval ? "active" : ""} ${i.gap ? "gap" : ""}`}
              onClick={() => setIntervalId(i.id)}
              disabled={i.lab && !meta.provider.intervals.includes(i.id)}
            >
              {i.label}
            </button>
          ))}
        </div>
      </header>

      <AccountBar account={account} onChange={setAccount} />

      <MarketLink link={link.data} error={link.error} symbol={symbol} />

      <OutlookPanel pred={pred.data} loading={pred.loading} error={pred.error} symbol={symbol} />

      <Top3Panel today={today} selectedId={selected?.id} onSelect={onSelectCard} controls={topControls} />

      <OverlayBar
        meta={meta}
        overlays={overlays}
        setOverlays={setOverlays}
        patterns={patterns}
        setPatterns={setPatterns}
        orMinutes={orMinutes}
        setOrMinutes={setOrMinutes}
        enabled={isLab}
      />

      {(error || data?.warning || data?.note || loading || legend || livePlan) && (
        <div className="notice">
          {loading && <span className="loading">Loading {symbol}…</span>}
          {error && <span className="error">{error}</span>}
          {!error && data?.warning && <span className="warning">{data.warning}</span>}
          {!error && !loading && data?.note && <span className="note">{data.note}</span>}
          {legend && <span className="note">{legend}</span>}
          {selected && <span className="note">Showing {selected.name} levels</span>}
          {livePlan && <span className="note">Showing {livePlan.name} entry / stop / target</span>}
        </div>
      )}

      <main className="chart-wrap main-chart">
        <Chart data={data} fitKey={data ? `${data.symbol}|${data.interval}` : null} overlays={isLab ? data?.overlays : null} markers={isLab ? markers : null} levels={levels} />
      </main>

      <TradePlans
        plans={plans.data}
        loading={plans.loading}
        error={plans.error}
        stats={planStats}
        statsLabel={today.result ? `Backtest (${today.result.targetName}, OOS)` : "Backtest"}
        noEdge={Boolean(today.result?.noEdge)}
        selectedId={selectedPlan?.id}
        onSelect={onSelectPlan}
      />

      <Scoreboard result={today.result} symbol={symbol} account={account} metaStrategies={meta.strategies} plans={plans.data} onChartLevels={onDetailLevels} />
    </div>
  );
}
