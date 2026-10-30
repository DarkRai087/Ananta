import { useState } from "react";
import { fmtPct, fmtSignedPct, fmtHHMM, store } from "../format.js";

const ARROW = { bullish: "▲", bearish: "▼", neutral: "●" };
const VERDICT = {
  edge: { cls: "pos", text: "Tested edge" },
  "no-edge": { cls: "warn", text: "No proven edge" },
  worse: { cls: "neg", text: "Worse than baseline" },
  insufficient: { cls: "muted", text: "Not enough data" },
};

function Call({ now, big }) {
  if (!now?.call) return <span className="muted">no call</span>;
  return (
    <span className={`call ${now.call} ${big ? "big" : ""}`}>
      {ARROW[now.call]} {now.call.toUpperCase()}
      <span className="strength"> {Math.round(Math.abs(now.score) * 100)}%</span>
    </span>
  );
}

function Verdict({ ev }) {
  if (!ev) return null;
  const v = VERDICT[ev.verdict] || VERDICT.insufficient;
  return <span className={`badge ${v.cls}`}>{v.text}</span>;
}

const track = (ev) => (ev?.hitRate != null ? `right ${fmtPct(ev.hitRate * 100)} vs ${fmtPct(ev.baseline * 100)} baseline · ${ev.calls} calls` : "no tested calls");

// One horizon's model table.
function ModelTable({ models, combined, evalOf }) {
  return (
    <div className="table-wrap">
      <table className="grid outlook-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Call now</th>
            <th>Why</th>
            <th className="num">Hit rate</th>
            <th className="num">Baseline</th>
            <th className="num">Calls</th>
            <th className="num">Avg move after ▲</th>
            <th className="num">Avg move after ▼</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {[...models.map((m) => ({ ...m, ev: evalOf(m) })), { id: "combined", name: "Combined", description: "Weighted average of the models above", now: combined.now, ev: combined.eval, weights: combined.weights }].map((m) => (
            <tr key={m.id} className={m.id === "combined" ? "combined" : ""} title={m.description}>
              <td>
                {m.name}
                {m.weights && (
                  <div className="small muted">
                    {Object.entries(m.weights)
                      .filter(([, w]) => w)
                      .map(([k, w]) => `${k} ×${w}`)
                      .join(" · ")}
                  </div>
                )}
              </td>
              <td>
                <Call now={m.now} />
              </td>
              <td className="why-cell">{m.now?.reasons?.join("; ")}</td>
              <td className="num">{m.ev?.hitRate != null ? fmtPct(m.ev.hitRate * 100, 1) : "—"}</td>
              <td className="num">{m.ev?.baseline != null ? fmtPct(m.ev.baseline * 100, 1) : "—"}</td>
              <td className="num">{m.ev?.calls ?? "—"}</td>
              <td className="num">{fmtSignedPct(m.ev?.avgBullPct)}</td>
              <td className="num">{fmtSignedPct(m.ev?.avgBearPct)}</td>
              <td>
                <Verdict ev={m.ev} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Bullish / bearish outlook at four horizons from the prediction module.
 * pred: GET /api/predict/:symbol
 */
export default function OutlookPanel({ pred, loading, error, symbol }) {
  const [open, setOpen] = useState(() => store.get("nse.outlookOpen", false));
  const [sel, setSel] = useState("today");
  const toggle = (key) => {
    const next = !(open && sel === key);
    setSel(key);
    setOpen(next);
    store.set("nse.outlookOpen", next);
  };

  const pills = [];
  if (pred) {
    const id = pred.intraday;
    pills.push({
      key: "today",
      label: id?.horizonLabel || "Rest of today",
      sub: id?.live ? `from ${id.checkpoint}` : null,
      now: id?.live ? id.combined.now : null,
      ev: id?.live ? id.combined.eval : null,
      note: id?.error || (!id?.live ? id?.note : null),
    });
    const d = pred.daily;
    for (const h of d?.horizons || []) {
      const c = d.combined[h.id];
      pills.push({ key: h.id, label: h.label, sub: `${h.days} day${h.days > 1 ? "s" : ""}`, now: c.now, ev: c.eval });
    }
    if (d?.error) pills.push({ key: "daily", label: "Next session / week / month", note: d.error });
  }
  const cur = pills.find((p) => p.key === sel);

  return (
    <section className="outlook">
      <div className="outlook-head">
        <h2>Outlook</h2>
        <span className="small muted">Will {symbol} go up or down? Each call shows how the same call did in the past.</span>
        {loading && !pred && <span className="small muted">Loading…</span>}
        {error && <span className="small down">{error}</span>}
        {pred && <span className="small muted">as of {fmtHHMM(pred.asOf)} IST</span>}
      </div>
      {pred && (
        <div className="ol-pills">
          {pills.map((p) => (
            <button key={p.key} className={`ol-pill ${open && sel === p.key ? "active" : ""}`} onClick={() => toggle(p.key)} disabled={!p.now && !p.note}>
              <div className="ol-label">
                {p.label} {p.sub && <span className="muted">· {p.sub}</span>}
              </div>
              {p.now ? <Call now={p.now} big /> : <div className="small muted">{p.note || "—"}</div>}
              {p.now && (
                <div className="ol-track">
                  <Verdict ev={p.ev} /> <span className="small muted">{track(p.ev)}</span>
                </div>
              )}
            </button>
          ))}
        </div>
      )}
      {pred && open && cur && (
        <div className="ol-detail">
          {cur.key === "today" && pred.intraday?.live && (
            <>
              <div className="small muted">
                Will the {pred.intraday.interval} close at 15:30 be above or below the price at {pred.intraday.checkpoint}? Tested on the last {pred.intraday.sessionsTested} sessions at the same time of day.
              </div>
              <ModelTable models={pred.intraday.models} combined={pred.intraday.combined} evalOf={(m) => m.eval} />
            </>
          )}
          {cur.key !== "today" && pred.daily?.horizons && (
            <>
              <div className="small muted">
                Will the close {pred.daily.horizons.find((h) => h.id === cur.key)?.days} trading day(s) from now be higher? Tested walk-forward on daily bars{" "}
                {pred.daily.testedFrom ? `from ${new Date(pred.daily.testedFrom * 1000).toISOString().slice(0, 10)}` : ""} — every past call used only data available that day.
              </div>
              <ModelTable models={pred.daily.models} combined={pred.daily.combined[cur.key]} evalOf={(m) => m.eval[cur.key]} />
            </>
          )}
          <div className="small muted">
            Baseline = always calling the more common direction (in a rising market, "always bullish"). A model only shows "Tested edge" when it beats that by a statistically meaningful margin. Strength = how strongly the
            models agree, not a probability.
          </div>
        </div>
      )}
    </section>
  );
}
