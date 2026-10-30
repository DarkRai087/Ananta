import { useState } from "react";
import { fmtR, fmtRs, fmtPrice, fmtHHMM } from "../format.js";
import JobProgress from "./JobProgress.jsx";
import WinRate from "./WinRate.jsx";

const MODE_CLASS = { live: "live", frozen: "frozen", waiting: "waiting", premarket: "premarket" };

function ContextChips({ ctx }) {
  if (!ctx?.ready) return null;
  return (
    <span className="chips">
      <span className="chip">
        gap {ctx.gapPct >= 0 ? "+" : ""}
        {ctx.gapPct.toFixed(2)}% · {ctx.gap}
      </span>
      <span className="chip">OR {ctx.orRatio != null ? `${ctx.orRatio.toFixed(2)}× ATR` : "vs ATR n/a"} · {ctx.or}</span>
      <span className="chip">{ctx.pos === "abovePDH" ? "above PDH" : ctx.pos === "belowPDL" ? "below PDL" : "inside prior range"}</span>
    </span>
  );
}

function Method({ r }) {
  const m = r.method;
  return (
    <ol className="method">
      <li>
        Backtest all strategies (default params, after charges) over the last {m.windowSessions} sessions{m.windowFrom ? ` (data from ${m.windowFrom})` : ""}. The last{" "}
        {m.oosSessions} sessions{m.oosFrom ? ` (from ${m.oosFrom})` : ""} are out-of-sample.
      </li>
      <li>
        Classify today when the opening range completes: gap % vs previous close (±0.5% = flat), opening-range width ÷ 14-day ATR (narrow &lt; 0.25, wide &gt; 0.5), price vs PDH/PDL. Match on: {m.match.join(", ")}.
      </li>
      <li>Keep only out-of-sample trades from past sessions with the same context (before today's context exists: all out-of-sample trades).</li>
      {r.index?.choice && r.index.choice !== "off" && (
        <li>
          Trading with the index is on: a BUY only counts while {r.index.refs.map((x) => x.name).join(" / ")} is up (above its VWAP and yesterday's close), a SELL only while it's down.
        </li>
      )}
      <li>
        Rank by net expectancy in ₹ (then R). Needs ≥{m.minTrades} matching trades; only positive expectancy is shown. Refreshes every {m.refreshMinutes} min until {m.freezeAt}, then frozen for the day.
      </li>
    </ol>
  );
}

export default function Top3Panel({ today, selectedId, onSelect, controls }) {
  const { result: r, progress, error, warnings, loading, refresh } = today;
  const [showMethod, setShowMethod] = useState(false);

  return (
    <section className="top3">
      <div className="top3-head">
        <h2>Today's Top 3</h2>
        {controls}
        {r && (
          <span className={`mode ${MODE_CLASS[r.mode]}`} title={`as of ${fmtHHMM(r.asOf)} IST`}>
            {r.label}
          </span>
        )}
        {r?.context && <ContextChips ctx={r.context} />}
        <span className="spacer" />
        {r && (
          <button className="link" onClick={() => setShowMethod((v) => !v)}>
            {showMethod ? "Hide method" : "How it's ranked"}
          </button>
        )}
        <button className="link" onClick={refresh} disabled={loading}>
          {loading ? "Updating…" : "Refresh"}
        </button>
      </div>

      {loading && progress && <JobProgress progress={progress} />}
      {error && <div className="banner error">{error}</div>}
      {r && showMethod && <Method r={r} />}

      {r && r.noEdge && (
        <div className="banner sitout">
          <strong>No edge today — sit out.</strong> {r.noEdgeReason}
        </div>
      )}

      {r && !r.noEdge && (
        <div className="cards">
          {r.top3.map((c) => (
            <button key={c.id} className={`card ${selectedId === c.id ? "selected" : ""}`} onClick={() => onSelect(selectedId === c.id ? null : c)}>
              <div className="card-top">
                <span className="rank">#{c.rank}</span>
                <span className="card-name">{c.name}</span>
              </div>
              <div className="why">{c.why}</div>
              <div className="card-stats">
                <span>
                  <WinRate m={c} />
                </span>
                <span>
                  <b className={c.expectancyRs > 0 ? "up" : "down"}>{fmtRs(c.expectancyRs)}</b> / {fmtR(c.expectancyR)} per trade
                </span>
                <span>{c.trades} matching trades</span>
              </div>
              {c.levels.length > 0 && (
                <div className="levels">
                  {c.levels.map((l) => (
                    <span key={l.key}>
                      {l.label} <b>{fmtPrice(l.price)}</b>
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {r && r.notEnough.length > 0 && (
        <div className="small muted">
          Not enough data: {r.notEnough.map((n) => `${n.name} (${n.trades}/${r.method.minTrades})`).join(" · ")}
        </div>
      )}
      {warnings?.length > 0 && (
        <details className="small muted">
          <summary>{warnings.length} data warning(s)</summary>
          {warnings.slice(0, 50).map((w) => (
            <div key={w}>{w}</div>
          ))}
        </details>
      )}
    </section>
  );
}
