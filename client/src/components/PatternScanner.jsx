import { useState } from "react";
import { fmtPrice, fmtSignedPct, store } from "../format.js";

const ARROW = { long: "▲", short: "▼", neutral: "●" };
const DIR_CLASS = { long: "up", short: "down", neutral: "muted" };

const pct = (x, d = 0) => (x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(d)}%`);
const pts = (x) => (x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(0)} pts`);

function ContextChips({ ctx }) {
  if (!ctx) return <span className="muted small">—</span>;
  return (
    <span className="chips">
      {ctx.levels.map((l) => (
        <span key={l} className="chip">{l}</span>
      ))}
      {ctx.volumeRatio != null && <span className={`chip ${ctx.highVolume ? "st-hot" : ""}`}>vol {ctx.volumeRatio.toFixed(1)}×</span>}
      {ctx.bucket && <span className="chip">{ctx.bucket.label}</span>}
      {!ctx.levels.length && ctx.volumeRatio == null && <span className="muted small">—</span>}
    </span>
  );
}

// The hit-rate / baseline / edge cell group for one detection's chosen (context) block.
function StatCells({ d }) {
  const b = d.stats?.block;
  if (!b) return <><td className="num muted" colSpan={4}>no history</td></>;
  if (d.direction === "neutral") {
    return (
      <>
        <td className="num muted" title="Neutral pattern — no directional hit rate">n/a</td>
        <td className="num muted">—</td>
        <td className="num muted">—</td>
        <td className="num">{b.n || "—"}</td>
      </>
    );
  }
  if (!b.sufficient) {
    return (
      <>
        <td className="num muted" title={`Need ${d.stats.block.n} ≥ minimum`}>insufficient</td>
        <td className="num muted">—</td>
        <td className="num muted">—</td>
        <td className="num">{b.n}</td>
      </>
    );
  }
  const w = b.wilson ? ` (95% CI ${pct(b.wilson[0])}–${pct(b.wilson[1])})` : "";
  return (
    <>
      <td className="num" title={`Wilson${w}`}>{pct(b.hitRate)}</td>
      <td className="num muted">{pct(b.baseline)}</td>
      <td className={`num ${b.edge > 0 ? "up" : "down"}`}>{pts(b.edge)}</td>
      <td className="num">{b.n}</td>
    </>
  );
}

/**
 * Pattern Scanner panel. Sits between the Outlook and Today's Top 3.
 * scan: GET /api/lab/scan — detections on the latest completed 5m / 15m candle, with this
 * stock's own history. Detect-and-report only; it never places an order.
 */
export default function PatternScanner({ scan, loading, error, symbol }) {
  const [open, setOpen] = useState(() => store.get("nse.scanOpen", true));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    store.set("nse.scanOpen", next);
  };

  const detections = scan?.detections || [];
  const best = scan?.ranking?.best || null;
  const frames = scan?.timeframes || [];
  // Best first, then by edge / n, then the rest by timeframe + time.
  const rows = [...detections].sort((a, b) => Number(b.hasEdge) - Number(a.hasEdge) || (b.edge ?? -1) - (a.edge ?? -1) || (b.n ?? 0) - (a.n ?? 0));

  return (
    <section className="scanner">
      <div className="scanner-head">
        <h2>Pattern Scanner</h2>
        <span className="small muted">
          What has formed on {symbol}'s latest completed candle — and how that setup has played out on this stock before. Detect-and-report only; no orders.
        </span>
        {loading && !scan && <span className="small muted">Scanning…</span>}
        {error && <span className="small down">{error}</span>}
        {scan && (
          <span className="small muted">
            {frames.map((f) => (f.available ? `${f.timeframe} @ ${f.lastBar?.hhmm ?? "—"}` : `${f.timeframe}: ${f.reason}`)).join(" · ")} · last {scan.lookbackSessions} sessions
          </span>
        )}
        <span className="spacer" />
        {detections.length > 0 && (
          <button className="link" onClick={toggle}>
            {open ? "Hide detail" : "Show detail"}
          </button>
        )}
      </div>

      {scan?.warning && <div className="small warning">{scan.warning}</div>}

      {best ? (
        <div className="banner scan-best">
          <strong>Best setup now:</strong> {best.name} ({best.timeframe}) — edge {pts(best.edge)} over baseline, n={best.n}.
        </div>
      ) : (
        scan && detections.length > 0 && <div className="banner sitout small">{scan.ranking?.message || "No pattern with a historical edge right now."}</div>
      )}

      {scan && detections.length === 0 && (
        <div className="small muted">No pattern detected on the latest completed {frames.filter((f) => f.available).map((f) => f.timeframe).join(" / ") || ""} candle.</div>
      )}

      {detections.length > 0 && (
        <div className="table-wrap">
          <table className="grid scan-table">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Dir</th>
                <th>TF</th>
                <th>Time</th>
                <th>Context</th>
                <th className="num">Hit rate</th>
                <th className="num">Baseline</th>
                <th className="num">Edge</th>
                <th className="num">n</th>
                <th className="num">Avg move</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const isBest = best && d.name === best.name && d.timeframe === best.timeframe;
                return (
                  <tr key={`${d.timeframe}|${d.name}`} className={isBest ? "pos" : ""}>
                    <td>
                      {isBest && <span className="rank">★</span>} {d.name}
                    </td>
                    <td className={DIR_CLASS[d.direction]}>{ARROW[d.direction]}</td>
                    <td>{d.timeframe}</td>
                    <td>{d.hhmm}</td>
                    <td>
                      <ContextChips ctx={d.context} />
                    </td>
                    <StatCells d={d} />
                    <td className="num">{fmtSignedPct(d.stats?.block?.avgReturn)}</td>
                    <td>
                      {d.hasEdge ? (
                        <span className="badge pos">Edge</span>
                      ) : d.direction === "neutral" ? (
                        <span className="badge muted">Neutral</span>
                      ) : d.stats?.block?.sufficient ? (
                        <span className="badge warn">No edge</span>
                      ) : (
                        <span className="badge muted">Low history</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && detections.length > 0 && (
        <ul className="scan-lines">
          {rows.map((d) => (
            <li key={`line-${d.timeframe}|${d.name}`} className={d.hasEdge ? "" : "muted"}>
              {d.line}
            </li>
          ))}
        </ul>
      )}

      {detections.length > 0 && (
        <div className="small muted">
          Entry is the next bar's open; "hit rate" is how often price reached {scan?.barrier?.label} within {scan?.primaryHorizon} bars before 15:15 IST, vs a same-direction random-bar baseline on this
          stock. n = past occurrences; a 95% Wilson interval is in the hit-rate tooltip. History, not a forecast.
        </div>
      )}
    </section>
  );
}
