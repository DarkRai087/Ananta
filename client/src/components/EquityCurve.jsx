import { fmtRs } from "../format.js";

// Net equity (₹, after charges) by trade, with the in-sample / out-of-sample split marked.
export default function EquityCurve({ equity, splitTime, height = 180 }) {
  if (!equity?.length) return <div className="small muted">No trades.</div>;
  const W = 800;
  const H = height;
  const pad = { l: 64, r: 10, t: 10, b: 18 };
  const vals = [0, ...equity.map((p) => p.value)];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (k) => pad.l + (k / Math.max(1, vals.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b);
  const path = vals.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const splitIdx = splitTime ? equity.findIndex((p) => p.time >= splitTime) : -1;
  const last = vals[vals.length - 1];

  return (
    <svg className="equity" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="zero" />
      {splitIdx > 0 && (
        <>
          <line x1={x(splitIdx + 1)} x2={x(splitIdx + 1)} y1={pad.t} y2={H - pad.b} className="split" />
          <text x={x(splitIdx + 1) + 4} y={pad.t + 10} className="lbl">
            out-of-sample →
          </text>
        </>
      )}
      <path d={path} className={last >= 0 ? "line pos" : "line neg"} />
      <text x={4} y={y(max) + 4} className="lbl">
        {fmtRs(max)}
      </text>
      <text x={4} y={y(min)} className="lbl">
        {fmtRs(min)}
      </text>
      <text x={pad.l} y={H - 4} className="lbl">
        trade 1
      </text>
      <text x={W - pad.r} y={H - 4} className="lbl" textAnchor="end">
        trade {equity.length}
      </text>
    </svg>
  );
}
