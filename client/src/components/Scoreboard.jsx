import { Fragment, useEffect, useMemo, useState } from "react";
import { fmtPct, fmtR, fmtRs, fmtNum } from "../format.js";
import { winTitle } from "./WinRate.jsx";
import StrategyDetail, { hasEngine } from "./StrategyDetail.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";

const COLS = [
  { key: "name", label: "Strategy", get: (r) => r.name, text: true },
  { key: "trades", label: "Trades", get: (_r, m) => m.trades },
  {
    key: "winPct",
    label: "Win %",
    get: (_r, m) => m.winPct,
    cell: (m) =>
      m.trades ? (
        <span title={winTitle(m)}>
          <b className={m.breakEvenWinPct == null ? "" : m.winPct >= m.breakEvenWinPct ? "up" : "down"}>{fmtPct(m.winPct, 1)}</b>
          <div className="muted wr-detail">
            {m.wins}/{m.trades} · {fmtPct(m.winLow, 0)}–{fmtPct(m.winHigh, 0)}
          </div>
        </span>
      ) : (
        "—"
      ),
  },
  { key: "breakEvenWinPct", label: "Need %", get: (_r, m) => m.breakEvenWinPct, fmt: (v) => fmtPct(v, 1) },
  { key: "exitTarget", label: "Hit target %", get: (_r, m) => m.exits?.target, fmt: (v) => fmtPct(v, 1) },
  { key: "exitStop", label: "Hit stop %", get: (_r, m) => (m.exits ? (m.exits.stop || 0) + (m.exits.trail || 0) : null), fmt: (v) => fmtPct(v, 1) },
  { key: "forcedPct", label: "15:15 %", get: (_r, m) => m.forcedPct, fmt: (v) => fmtPct(v, 1) },
  { key: "avgWinR", label: "Avg win", get: (_r, m) => m.avgWinR, fmt: fmtR },
  { key: "avgLossR", label: "Avg loss", get: (_r, m) => m.avgLossR, fmt: fmtR },
  { key: "expectancyRs", label: "Net exp ₹", get: (_r, m) => m.expectancyRs, fmt: (v) => fmtRs(v) },
  { key: "expectancyR", label: "Net exp R", get: (_r, m) => m.expectancyR, fmt: fmtR },
  { key: "profitFactor", label: "Profit factor", get: (_r, m) => m.profitFactor, fmt: (v) => fmtNum(v) },
  { key: "maxDrawdown", label: "Max DD ₹", get: (_r, m) => m.maxDrawdown, fmt: (v) => fmtRs(v) },
];

/**
 * All strategies, backtested. Click a row (▸) for its detail dropdown; click again (▾) to close.
 * symbol / account: the chart symbol and your trade settings, for the live analysis.
 * metaStrategies: [{ id, description, … }] · plans: today's plans · onChartLevels(levels | null).
 */
export default function Scoreboard({ result, symbol, account, metaStrategies, plans, onChartLevels }) {
  const [openId, setOpenId] = useState(null);
  const [scope, setScope] = useState("all"); // all | like
  const [sample, setSample] = useState("oos"); // oos | is
  const [sort, setSort] = useState({ key: "expectancyRs", dir: -1 });
  const ix = result?.index;
  const [idxMode, setIdxMode] = useState("off"); // off | on — which backtest to show
  useEffect(() => setIdxMode(ix?.choice && ix.choice !== "off" ? "on" : "off"), [ix?.choice]);

  const canLike = Boolean(result?.contextsReady);
  const effScope = scope === "like" && canLike ? "like" : "all";

  const rows = useMemo(() => {
    if (!result) return [];
    const col = COLS.find((c) => c.key === sort.key);
    return result.scoreboard
      .map((r) => ({ r, m: (r.cmp ? r.cmp[idxMode][effScope] : r[effScope])?.[sample] ?? r[effScope][sample] }))
      .sort((a, b) => {
        const va = col.get(a.r, a.m);
        const vb = col.get(b.r, b.m);
        if (col.text) return String(va).localeCompare(String(vb)) * sort.dir;
        const na = va == null || !Number.isFinite(va) ? (va === Infinity ? 1e18 : -1e18) : va;
        const nb = vb == null || !Number.isFinite(vb) ? (vb === Infinity ? 1e18 : -1e18) : vb;
        return (na - nb) * sort.dir;
      });
  }, [result, effScope, sample, sort, idxMode]);

  if (!result) return null;

  return (
    <section className="scoreboard">
      <div className="sb-head">
        <h2>All strategies</h2>
        <div className="seg">
          <button className={effScope === "all" ? "active" : ""} onClick={() => setScope("all")}>
            All sessions
          </button>
          <button className={effScope === "like" ? "active" : ""} onClick={() => setScope("like")} disabled={!canLike} title={canLike ? "" : "Today's context isn't known yet"}>
            Sessions like today
          </button>
        </div>
        <div className="seg">
          <button className={sample === "oos" ? "active" : ""} onClick={() => setSample("oos")}>
            Out-of-sample
          </button>
          <button className={sample === "is" ? "active" : ""} onClick={() => setSample("is")}>
            In-sample
          </button>
        </div>
        {ix?.refs?.length > 0 && (
          <div className="seg" title={`Trade with the index: only BUY while ${ix.refs.map((r) => r.name).join(" / ")} is up, only SELL while it's down`}>
            <button className={idxMode === "off" ? "active" : ""} onClick={() => setIdxMode("off")}>
              Without index filter
            </button>
            <button className={idxMode === "on" ? "active" : ""} onClick={() => setIdxMode("on")}>
              With {ix.refs.length === 1 ? ix.refs[0].name : "index"} filter
            </button>
          </div>
        )}
        <span className="small muted">
          {result.targetName} · {result.interval} · {sample === "oos" ? `from ${result.method.oosFrom ?? "—"}` : `${result.method.windowFrom ?? "—"} → ${result.method.oosFrom ?? "—"}`} · after charges
          {result.sizing && ` · ₹ at your sizing: max loss ${fmtRs(result.sizing.riskPerTrade)}/trade incl. charges${result.sizing.profitTarget > 0 ? `, net target ${fmtRs(result.sizing.profitTarget)}` : ""}`}
        </span>
      </div>
      {ix?.compared > 0 && (
        <div className="small index-verdict">
          <b>Trading with {ix.refs.map((r) => r.name).join(" / ")}</b> (out-of-sample): lost less or made more in <b>{ix.improved} of {ix.compared}</b> strategies — total{" "}
          {fmtRs(ix.netOff)} → <b className={ix.netOn > ix.netOff ? "up" : "down"}>{fmtRs(ix.netOn)}</b>, but from {ix.tradesOff} trades down to {ix.tradesOn}. The average trade got better in{" "}
          <b>
            {ix.betterPerTrade} of {ix.comparedPerTrade}
          </b>{" "}
          strategies with 10+ trades both ways.{" "}
          <span className="muted">Fewer trades means less lost while a strategy is losing; it only adds an edge if the average trade improves.</span>
        </div>
      )}
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  className={c.text ? "" : "num"}
                  onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : c.text ? 1 : -1 }))}
                >
                  {c.label}
                  {sort.key === c.key ? (sort.dir > 0 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ r, m }) => {
              const open = openId === r.id;
              return (
                <Fragment key={r.id}>
                  <tr
                    className={`sb-row ${open ? "open" : ""} ${!m.trades ? "empty" : m.expectancyRs > 0 ? "pos" : "neg"}`}
                    onClick={() => setOpenId(open ? null : r.id)}
                    title={open ? "Click to close the details" : "Click for the details"}
                  >
                    {COLS.map((c) => {
                      const v = c.get(r, m);
                      return (
                        <td key={c.key} className={c.text ? "" : "num"}>
                          {c.key === "name" ? (
                            <>
                              <span className="arrow">{open ? "▾" : "▸"}</span> {r.name}
                              {hasEngine(metaStrategies?.find((x) => x.id === r.id)) && <span className="badge pos sb-tag" title="Full multi-factor decision engine">decision engine</span>}
                            </>
                          ) : c.cell ? (
                            c.cell(m)
                          ) : c.fmt ? (
                            c.fmt(v)
                          ) : (
                            (v ?? "—")
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  {open && (
                    <tr className="sub sb-detail">
                      <td colSpan={COLS.length}>
                        <ErrorBoundary name="The strategy details" resetKey={`${r.id}|${symbol}`}>
                          <StrategyDetail
                            row={r}
                            m={m}
                            meta={metaStrategies?.find((x) => x.id === r.id)}
                            plan={plans?.strategies?.find((x) => x.id === r.id)}
                            symbol={symbol}
                            interval={result.interval}
                            account={account}
                            onChartLevels={onChartLevels}
                          />
                        </ErrorBoundary>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="small muted">
        Click a strategy (▸) for its details, again (▾) to close. Win % = trades that made money after all charges, whatever the exit. Under it: wins/trades and the likely range (95%) — the fewer the trades, the wider. Need % = the win % that breaks even
        with the strategy's average win and loss: a green win % beats it, a red one doesn't. Hit target / hit stop (incl. trailing) / 15:15 = how trades ended; the rest closed on an exit signal.
      </div>
    </section>
  );
}
