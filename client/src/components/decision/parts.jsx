import { Fragment, useState } from "react";
import { fmtPrice, fmtHHMM } from "../../format.js";

// Building blocks shared by the decision reports (ORB, VWAP σ reversion).

export const DECISION_CLS = { LONG: "up", SHORT: "down", WATCHLIST: "warn", "NO TRADE": "muted" };
const STATUS_TXT = { missing: "missing", substitute: "stand-in", na: "n/a" };

export function Row({ k, v, sub }) {
  return (
    <tr>
      <td className="muted">{k}</td>
      <td>
        {v}
        {sub && <div className="small muted">{sub}</div>}
      </td>
    </tr>
  );
}

export function List({ title, items, cls = "" }) {
  if (!items?.length) return null;
  return (
    <div className="vr-list">
      <b>{title}</b>
      <ul className={cls}>
        {items.map((x, k) => (
          <li key={k}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

// Mandatory conditions as PASS / FAIL / WAIT chips (hover for the reason).
export function Gates({ gates }) {
  if (!gates?.length) return null;
  return (
    <div className="vr-gates">
      {gates.map((g) => (
        <span key={g.id} className={`vr-gate ${g.pass ? "pass" : g.hard ? "fail" : "wait"}`} title={g.reason}>
          {g.pass ? "✓" : g.hard ? "✗" : "…"} {g.label}
        </span>
      ))}
    </div>
  );
}

// The factor scorecard; click a factor for its sub-scores.
export function Scorecard({ title, factors, score }) {
  const [open, setOpen] = useState(null);
  return (
    <table className="grid vr-score">
      <thead>
        <tr>
          <th>{title}</th>
          <th className="num">Score</th>
          <th className="num">Max</th>
          <th>Observation</th>
        </tr>
      </thead>
      <tbody>
        {factors.map((f) => (
          <Fragment key={f.id}>
            <tr className="vr-frow" onClick={() => setOpen(open === f.id ? null : f.id)} title="Click for the sub-scores">
              <td>
                <span className="arrow">{open === f.id ? "▾" : "▸"}</span> {f.name}
              </td>
              <td className="num">
                <b>{f.score}</b>
              </td>
              <td className="num">
                {f.max}
                {f.maxAvailable < f.max && <span className="muted" title="Points that need data this evaluation doesn't have"> ({f.maxAvailable} with data)</span>}
              </td>
              <td className="why-cell">{f.observation}</td>
            </tr>
            {open === f.id &&
              f.lines.map((l) => (
                <tr key={l.key} className={`vr-line st-${l.status}`}>
                  <td>
                    {l.label}
                    {STATUS_TXT[l.status] && <span className={`badge ${l.status === "missing" ? "neg" : "muted"}`}>{STATUS_TXT[l.status]}</span>}
                  </td>
                  <td className="num">{l.points}</td>
                  <td className="num">{l.max}</td>
                  <td className="why-cell">
                    {l.value ?? "—"}
                    {l.note && <span className="muted"> — {l.note}</span>}
                  </td>
                </tr>
              ))}
          </Fragment>
        ))}
        <tr className="vr-total">
          <td>Total</td>
          <td className="num">
            <b>{score}</b>
          </td>
          <td className="num">100</td>
          <td className="small muted">Setup quality, not a win probability. Missing data scores 0.</td>
        </tr>
      </tbody>
    </table>
  );
}

// Decision line: LONG / SHORT / WATCHLIST / NO TRADE, the score, why, and the trade the engine
// already took (or skipped) today.
export function DecisionHeader({ r, showOnChart, setShowOnChart }) {
  const cls = DECISION_CLS[r.decision] || "muted";
  return (
    <div className="vr-dh">
      <div className="vr-head">
        <span className={`vr-decision ${cls}`}>{r.decision}</span>
        {r.classification && (
          <span className="small">
            Score <b>{r.score}</b>/100 · {r.classification.label} · <span className="muted">{r.classification.action}</span>
            {r.scoreWithoutLive != null && r.scoreWithoutLive !== r.score && <span className="muted"> · {r.scoreWithoutLive} without live quote / VIX / breadth (what the backtest sees)</span>}
          </span>
        )}
        <span className={`mode ${r.phase === "live" ? "live" : "waiting"}`}>{r.label}</span>
        <span className="spacer" />
        {r.chart?.length > 0 && setShowOnChart && (
          <label className="check small" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={showOnChart} onChange={(e) => setShowOnChart(e.target.checked)} /> Show on chart
          </label>
        )}
      </div>
      <div className={`vr-why small ${cls}`}>
        {r.why}
        {r.side && r.state && (
          <span className="muted">
            {" "}
            · {r.side} side, setup {r.state}
          </span>
        )}
      </div>
      {r.atTrigger && (
        <div className="small">
          <b>At the {r.atTrigger.time} trigger:</b> {r.atTrigger.decision}, score {r.atTrigger.score} ({r.atTrigger.classification}){r.atTrigger.model ? `, model ${r.atTrigger.model}` : ""} — {r.atTrigger.taken ? "taken by the engine." : r.atTrigger.why}
        </div>
      )}
      {r.position && (
        <div className="position small">
          <b className={r.position.side === "long" ? "up" : "down"}>
            In trade: {r.position.side === "long" ? "LONG" : "SHORT"} {r.position.qty} @ {fmtPrice(r.position.entry)}
          </b>{" "}
          since {fmtHHMM(r.position.entryTime)} · SL {fmtPrice(r.position.stop)} · target {fmtPrice(r.position.target)}
          {r.position.entryDecision && (
            <span className="muted">
              {" "}
              · entered on {r.position.entryDecision.decision} at the {r.position.entryDecision.time} candle, score {r.position.entryDecision.score}
            </span>
          )}
          <span className="muted"> · simulated by the backtest engine — this app places no orders</span>
        </div>
      )}
      {r.warnings?.length > 0 && <div className="small warning">{r.warnings.join(" · ")}</div>}
    </div>
  );
}

export function Missing({ r }) {
  return (
    <>
      {r.cautions?.length > 0 && <List title="Cautions" items={r.cautions} cls="warn-list" />}
      <List title="Missing data (scored 0, never counted as confirmation)" items={r.missing} cls="muted-list" />
    </>
  );
}
