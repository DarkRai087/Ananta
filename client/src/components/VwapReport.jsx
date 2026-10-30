import { fmtPrice, fmtRs, fmtNum, fmtSignedPct, fmtHHMM } from "../format.js";
import { Row, List, Gates, Scorecard, Missing } from "./decision/parts.jsx";

// VWAP σ-band reversion decision report body (GET /api/lab/decision-report?strategy=vwapBands):
// sections A–F of its spec. The decision line is DecisionHeader (decision/parts.jsx).

const dir = (d) => (d === "Up" ? "up" : d === "Down" ? "down" : "muted");
const n1 = (x) => fmtNum(x, 1);
const n2 = (x) => fmtNum(x, 2);
const rr = (x) => (x == null || !Number.isFinite(x) ? "—" : `${x.toFixed(2)} : 1`);

function SectionA({ A, symbol }) {
  const ix = (x) =>
    x ? (
      <span>
        <b className={dir(x.dir)}>{x.dir}</b> {fmtSignedPct(x.dayPct)} · {x.aboveVwap ? "above" : "below"} VWAP · last 3 bars {fmtSignedPct(x.momPct)}
      </span>
    ) : (
      <span className="muted">unavailable</span>
    );
  return (
    <table className="grid vr-kv">
      <thead>
        <tr>
          <th colSpan={2}>A. Market analysis</th>
        </tr>
      </thead>
      <tbody>
        <Row k="Stock" v={<b>{symbol}</b>} />
        <Row k="Current price" v={<b>{fmtPrice(A.price)}</b>} sub={A.priceSource} />
        <Row k="Market regime" v={A.regime} sub={`bias ${A.bias}`} />
        <Row k="ADX (14)" v={A.adx != null ? `${n1(A.adx)}  (+DI ${n1(A.plusDI)} / −DI ${n1(A.minusDI)})` : <span className="muted">not ready{A.er != null ? ` — efficiency ratio ${n2(A.er)}` : ""}</span>} />
        <Row k="RSI (5)" v={A.rsi5 != null ? n1(A.rsi5) : <span className="muted">not ready</span>} />
        <Row k="RSI (14)" v={A.rsi14 != null ? n1(A.rsi14) : <span className="muted">not ready</span>} />
        <Row k="ATR" v={fmtPrice(A.atr)} sub={A.atrSource} />
        <Row k="VWAP slope" v={A.vwapSlope != null ? `${A.vwapSlope >= 0 ? "+" : ""}${fmtNum(A.vwapSlope, 3)} ATR / bar` : "—"} />
        <Row k="Relative volume" v={A.rvol != null ? `${n2(A.rvol)}×` : "—"} sub={A.rvol != null ? `${(A.volume ?? 0).toLocaleString("en-IN")} vs ${Math.round(A.avgVolume ?? 0).toLocaleString("en-IN")} avg of the previous ${A.rvolBars}` : null} />
        <Row k="NIFTY 50" v={ix(A.nifty)} />
        <Row k={A.sector?.name || "Sector index"} v={ix(A.sector)} />
        <Row k="Market session" v={`${A.session?.phase} · ${A.session?.time} IST`} sub={`${A.session?.sinceOpenMin} min since open · ${A.session?.toSquareOffMin} min to the 15:15 square-off · window ${A.session?.window}`} />
      </tbody>
    </table>
  );
}

function SectionB({ B, price }) {
  return (
    <table className="grid vr-kv">
      <thead>
        <tr>
          <th>B. VWAP σ bands</th>
          <th className="num">Price (₹)</th>
        </tr>
      </thead>
      <tbody>
        {B.bands.map((b) => (
          <tr key={b.label} className={b.label === "VWAP" ? "vr-vwap" : ""}>
            <td>{b.label}</td>
            <td className="num">{fmtPrice(b.price)}</td>
          </tr>
        ))}
        <tr>
          <td className="muted">Current z-score</td>
          <td className="num">
            <b>{n2(B.z)}σ</b> ({B.trend})
          </td>
        </tr>
        <tr>
          <td className="muted">Distance from VWAP</td>
          <td className="num">
            {fmtPrice(B.distance)} ({fmtSignedPct(B.distancePct)})
          </td>
        </tr>
        <tr>
          <td className="muted">Nearest band</td>
          <td className="num">
            {B.nearest?.label} {fmtPrice(B.nearest?.price)} ({fmtPrice(price - B.nearest?.price)})
          </td>
        </tr>
        <tr>
          <td colSpan={2} className="small">
            <b>{B.classification}</b>
            <div className="muted">
              σ {fmtPrice(B.sigma)} ({n2(B.bandAtr)} ATR to ±2σ) · σ ×{n2(B.sigmaRatio)} vs 6 bars ago · stretch extreme {n2(B.peakZ)}σ · {B.outside} close{B.outside === 1 ? "" : "s"} outside ±2σ this excursion ({B.timeOutsideMin} min), {B.sessionOutside} today
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function SectionD({ D }) {
  const long = D.side === "long";
  const r = (k, v, sub) => <Row k={k} v={v} sub={sub} />;
  return (
    <table className="grid vr-kv vr-trade">
      <thead>
        <tr>
          <th colSpan={2}>
            D. {D.action} plan <span className={`badge ${D.status === "ACTIVE" ? "pos" : "warn"}`}>{D.status}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {r("Entry trigger", <b>{fmtPrice(D.trigger)}</b>, D.triggerText)}
        {r("Expected entry", <b className={long ? "up" : "down"}>{fmtPrice(D.expectedEntry)}</b>, D.entryNote)}
        {D.chaseLimit != null && r("Don't chase beyond", fmtPrice(D.chaseLimit), `an entry ${long ? "above" : "below"} this falls under the minimum net reward/risk`)}
        {r("Stop-loss", <b className="down">{fmtPrice(D.stop)}</b>)}
        {r("Target 1", fmtPrice(D.t1), D.netAtT1 != null ? `${fmtRs(D.netAtT1)} net` : null)}
        {r("Target 2 (VWAP)", <b className="up">{fmtPrice(D.t2)}</b>, D.netAtT2 != null ? `${fmtRs(D.netAtT2)} net after ${fmtRs(D.chargesAtT2)} charges` : null)}
        {r("Target 3", D.t3 != null ? fmtPrice(D.t3) : <span className="muted">—</span>, D.t3 != null ? (D.netAtT3 != null ? `${fmtRs(D.netAtT3)} net` : null) : D.t3Note)}
        {r("Risk per share", fmtPrice(D.riskPerShare))}
        {r("Quantity", <b>{D.qty?.toLocaleString("en-IN") ?? "—"}</b>, `risk ${fmtRs(D.risk.riskRs)} = ${D.risk.riskPct}% of ${fmtRs(D.risk.capital)}`)}
        {r("Capital exposure", fmtRs(D.exposure), `max position ${fmtRs(D.risk.maxPositionValue)}`)}
        {r("Maximum risk", <b className="down">{fmtRs(D.maxRisk)}</b>, `incl. ${fmtRs(D.lossCharges)} charges and ${D.slippagePct}% stop slippage (${D.slippageSource})`)}
        {r("Gross reward / risk", rr(D.grossRR))}
        {r("Net reward / risk", <b>{rr(D.netRR)}</b>, "to T2, after every charge and slippage")}
        {r("Total setup score", <b>{D.score} / 100</b>)}
        {D.risk.notes?.length > 0 && (
          <tr>
            <td colSpan={2} className="small warning">
              {D.risk.notes.join(" · ")}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function SectionE({ E }) {
  return (
    <div className="vr-box">
      <h4>E. Decision explanation</h4>
      <div className="small">
        <b>1. Why it qualifies:</b> {E.qualifies}
      </div>
      <List title="2. Confirming" items={E.confirms} cls="up-list" />
      <List title="3. Against" items={E.opposes} cls="down-list" />
      <div className="small">
        <b>4. Invalidation:</b> {E.invalidation}
      </div>
      <div className="small">
        <b>5. Cancel the entry if:</b> {E.cancel}
      </div>
      <div className="small">
        <b>6. Primary exit:</b> {E.primaryExit}
      </div>
      <div className="small">
        <b>7. Eligible now:</b> {E.eligibleNow}
      </div>
    </div>
  );
}

export function NoTrade({ F, title = "F. No-trade explanation" }) {
  return (
    <div className="vr-box">
      <h4>{title}</h4>
      <div className="small">
        Score <b>{F.score}</b> / 100 · regime <b>{F.regime}</b>
      </div>
      <List title="Failed / pending conditions" items={F.failed} cls="down-list" />
      <List title="What has to change before the next evaluation" items={F.needs} />
    </div>
  );
}

/** r: the VWAP decision report. */
export default function VwapBody({ r, symbol }) {
  if (!r.A) return r.F ? <NoTrade F={r.F} /> : null;
  return (
    <>
      <Gates gates={r.gates} />
      <div className="vr-grid">
        <div className="vr-col">
          <SectionA A={r.A} symbol={symbol} />
          <SectionB B={r.B} price={r.A.price} />
        </div>
        <div className="vr-col">
          {r.D && <SectionD D={r.D} />}
          {r.E && <SectionE E={r.E} />}
          {r.F && <NoTrade F={r.F} />}
          <Missing r={r} />
          {r.live && (
            <div className="small muted">
              Live quote: {r.live.quote?.fresh ? `bid ${fmtPrice(r.live.quote.bid)} / ask ${fmtPrice(r.live.quote.ask)}, ${fmtHHMM(r.live.quote.time)}` : r.live.quoteError || "not fresh"} · Breadth:{" "}
              {r.live.breadth ? `${r.live.breadth.advances} up / ${r.live.breadth.declines} down of ${r.live.breadth.total}` : "unavailable"}
            </div>
          )}
        </div>
      </div>
      <Scorecard title="C. Factor" factors={r.C} score={r.score} />
    </>
  );
}
