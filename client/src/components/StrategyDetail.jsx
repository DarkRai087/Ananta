import { useEffect, useState } from "react";
import { fetchDecisionReport } from "../api.js";
import { useLiveData } from "../hooks.js";
import { fmtPrice, fmtPct, fmtR, fmtRs } from "../format.js";
import { DecisionHeader } from "./decision/parts.jsx";
import OrbBody from "./OrbReport.jsx";
import VwapBody from "./VwapReport.jsx";

// The dropdown under a scoreboard row. Strategies with a decision engine show their full live
// analysis for the chart symbol, in the view their report names (server: strategy.decision.report);
// the rest show their description, today's plan and the backtest breakdown behind the row.
const REPORT = { orb: OrbBody, vwap: VwapBody };
export const hasEngine = (meta) => Boolean(REPORT[meta?.report]);

const STATUS = { exit: "EXIT NOW", signal: "SIGNAL NOW", in_trade: "In trade", armed: "Armed", watching: "Watching", waiting: "Waiting", off: "Not today", done: "Done today" };

function EngineDetail({ id, kind, symbol, interval, account, onChartLevels }) {
  const accountKey = JSON.stringify(account || {});
  const rep = useLiveData((signal) => fetchDecisionReport(id, symbol, interval, account, signal), `${id}|${symbol}|${interval}|${accountKey}`, { everyMs: 20_000 });
  const [onChart, setOnChart] = useState(false);
  useEffect(() => {
    onChartLevels?.(onChart && rep.data?.chart?.length ? rep.data.chart : null);
  }, [onChart, rep.data, onChartLevels]);
  useEffect(() => () => onChartLevels?.(null), [onChartLevels]);

  if (rep.loading && !rep.data) return <div className="small muted">Analysing {symbol}…</div>;
  if (rep.error) return <div className="small down">{rep.error}</div>;
  const r = rep.data;
  if (!r) return null;
  const Body = REPORT[r.report] || REPORT[kind];
  return (
    <div className="sd">
      <div className="small muted">
        Live analysis of <b>{symbol}</b> on {interval} — the chart symbol. Analyse → validate → score → calculate → decide; trade numbers appear only when the decision allows them.
      </div>
      <DecisionHeader r={r} showOnChart={onChart} setShowOnChart={setOnChart} />
      <Body r={r} symbol={symbol} />
    </div>
  );
}

function BasicDetail({ meta, m, plan }) {
  const s = meta;
  const longSetup = plan?.setups?.find((x) => x.side === "long");
  const shortSetup = plan?.setups?.find((x) => x.side === "short");
  const setupText = (x) => (x ? `${x.action} ${fmtPrice(x.entry)} · SL ${fmtPrice(x.stop)} · target ${x.target != null ? fmtPrice(x.target) : "—"} — ${x.when}` : null);
  return (
    <div className="sd">
      {s?.description && <div className="small">{s.description}</div>}
      {plan && (
        <div className="small">
          <b>Today:</b> {STATUS[plan.status] || plan.status}
          {plan.note ? ` — ${plan.note}` : ""}
          {[setupText(longSetup), setupText(shortSetup)].filter(Boolean).map((t, k) => (
            <div key={k} className="muted">
              {t}
            </div>
          ))}
        </div>
      )}
      {m?.trades > 0 && (
        <div className="sd-grid">
          <table className="grid vr-kv">
            <thead>
              <tr>
                <th colSpan={2}>How the backtested trades ended</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="muted">Trades</td>
                <td>
                  {m.trades} · {m.wins} won after charges ({fmtPct(m.winPct, 1)}; breaks even at {fmtPct(m.breakEvenWinPct, 1)})
                </td>
              </tr>
              <tr>
                <td className="muted">Average win / loss</td>
                <td>
                  {fmtR(m.avgWinR)} ({fmtRs(m.avgWinRs)}) / {fmtR(m.avgLossR)} ({fmtRs(m.avgLossRs)})
                </td>
              </tr>
              <tr>
                <td className="muted">Exits</td>
                <td>{Object.entries(m.exits || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${fmtPct(v, 0)}`).join(" · ") || "—"}</td>
              </tr>
              <tr>
                <td className="muted">Charges paid</td>
                <td>
                  {fmtRs(m.totalCosts)} on {fmtRs(m.grossPnl)} gross → {fmtRs(m.netPnl)} net
                </td>
              </tr>
            </tbody>
          </table>
          {m.byBucket && (
            <table className="grid">
              <thead>
                <tr>
                  <th>Entry time</th>
                  <th className="num">Trades</th>
                  <th className="num">Win %</th>
                  <th className="num">Avg R</th>
                  <th className="num">Net ₹</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(m.byBucket).map(([id, b]) => (
                  <tr key={id} className={!b.trades ? "empty" : b.expectancyR > 0 ? "pos" : "neg"}>
                    <td>{b.label}</td>
                    <td className="num">{b.trades}</td>
                    <td className="num">{fmtPct(b.winPct, 1)}</td>
                    <td className="num">{fmtR(b.expectancyR)}</td>
                    <td className="num">{fmtRs(b.netPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div className="small muted">A full multi-factor decision analysis is built for Opening Range Breakout and VWAP σ-Band Reversion so far.</div>
    </div>
  );
}

/** row: scoreboard row · m: its metrics · meta: { description, … } · plan: today's plan row for the chart symbol */
export default function StrategyDetail({ row, m, meta, plan, symbol, interval, account, onChartLevels }) {
  if (hasEngine(meta)) return <EngineDetail id={row.id} kind={meta.report} symbol={symbol} interval={interval} account={account} onChartLevels={onChartLevels} />;
  return <BasicDetail meta={meta} m={m} plan={plan} />;
}
