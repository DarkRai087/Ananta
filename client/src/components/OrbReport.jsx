import { fmtPrice, fmtRs, fmtNum, fmtSignedPct, fmtPct } from "../format.js";
import { Row, List, Gates, Scorecard, Missing } from "./decision/parts.jsx";
import { NoTrade } from "./VwapReport.jsx";

// Opening Range Breakout decision dashboard (GET /api/lab/decision-report?strategy=orb):
// A market overview · B opening range · C breakout analysis · D technical confirmation ·
// E scorecard · F final trading parameters (only when the decision allows numbers) ·
// the decision explanation, or why there is no trade.

const dir = (d) => (d === "Up" ? "up" : d === "Down" ? "down" : "muted");
const n1 = (x) => fmtNum(x, 1);
const n2 = (x) => fmtNum(x, 2);
const pct0 = (x) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);
const rr = (x) => (x == null || !Number.isFinite(x) ? "—" : `${x.toFixed(2)} : 1`);
const na = <span className="muted">not ready</span>;

function Overview({ A }) {
  const ix = (x) =>
    x ? (
      <span>
        <b className={dir(x.dir)}>{x.dir}</b> {fmtSignedPct(x.dayPct)} · {x.aboveVwap ? "above" : "below"} VWAP
      </span>
    ) : (
      <span className="muted">unavailable</span>
    );
  return (
    <table className="grid vr-kv">
      <thead>
        <tr>
          <th colSpan={2}>A. Market overview</th>
        </tr>
      </thead>
      <tbody>
        <Row k="Stock" v={<b>{A.symbol}</b>} />
        <Row k="Current price" v={<b>{fmtPrice(A.price)}</b>} sub={A.priceSource} />
        <Row k="Previous close" v={fmtPrice(A.prevClose)} />
        <Row k="Opening price" v={fmtPrice(A.open)} />
        <Row k="Gap" v={fmtSignedPct(A.gapPct)} sub={A.gapAtr != null ? `${n2(A.gapAtr)} × daily ATR` : null} />
        <Row k="NIFTY 50" v={ix(A.nifty)} />
        <Row k={A.sector?.name || "Sector index"} v={ix(A.sector)} />
        <Row k="Market regime" v={A.regime} />
        <Row k="India VIX" v={A.vix ? `${n2(A.vix.ltp)} (${fmtSignedPct(A.vix.changePct)})` : <span className="muted">live only</span>} />
        <Row k="NIFTY 50 breadth" v={A.breadth ? `${A.breadth.advances} up / ${A.breadth.declines} down` : <span className="muted">live only</span>} />
        <Row k="Current time" v={`${A.time} IST · ${A.session?.phase}`} sub={`entry window ${A.session?.window} · ${A.session?.toSquareOffMin} min to the 15:15 square-off`} />
      </tbody>
    </table>
  );
}

function OpeningRange({ B }) {
  return (
    <table className="grid vr-kv">
      <thead>
        <tr>
          <th colSpan={2}>B. Opening range</th>
        </tr>
      </thead>
      <tbody>
        <Row k="OR duration" v={`${B.minutes} minutes`} />
        <Row k="ORH" v={<b className="up">{fmtPrice(B.high)}</b>} />
        <Row k="ORL" v={<b className="down">{fmtPrice(B.low)}</b>} />
        <Row k="ORM" v={fmtPrice(B.mid)} />
        <Row k="OR width" v={fmtPrice(B.width)} />
        <Row k="OR width %" v={fmtPct(B.widthPct, 2)} sub={B.medianWidthPct != null ? `typical ${fmtPct(B.medianWidthPct, 2)}` : null} />
        <Row k="ORW / ATR" v={B.atrRatio != null ? n2(B.atrRatio) : "—"} sub={B.atrDaily != null ? `14-day daily ATR ${fmtPrice(B.atrDaily)}` : null} />
        <Row k="Historical percentile" v={B.percentile != null ? `${B.percentile.toFixed(0)}th` : <span className="muted">needs 10 sessions</span>} sub={`${B.historyN} earlier sessions`} />
        <Row k="Range classification" v={<b>{B.classification}</b>} sub={`volume ${B.volRatio != null ? `${n2(B.volRatio)}× usual` : "n/a"} · formation ${(B.formation * 100).toFixed(0)}% of the range from the open`} />
      </tbody>
    </table>
  );
}

function Breakout({ C }) {
  return (
    <table className="grid vr-kv">
      <thead>
        <tr>
          <th colSpan={2}>C. Breakout analysis</th>
        </tr>
      </thead>
      <tbody>
        <Row k="Breakout direction" v={<b>{C.direction}</b>} />
        <Row k="Breakout level" v={fmtPrice(C.level)} sub={`a close must clear ${fmtPrice(C.breakLevel)}`} />
        <Row k="Breakout candle close" v={C.candleClose != null ? `${fmtPrice(C.candleClose)} (${C.candleTime})` : "—"} sub={C.candleClass ? `${C.candleClass} candle, ${n2(C.candleAtr)} ATR` : null} />
        <Row k="Candle body ratio" v={pct0(C.bodyRatio)} />
        <Row k="Closing position" v={pct0(C.closePos)} sub={C.againstWick != null ? `rejection wick ${pct0(C.againstWick)}` : null} />
        <Row k="Breakout distance" v={C.distance != null ? `${fmtPrice(C.distance)} (${n2(C.distanceAtr)} ATR)` : "—"} />
        <Row k="Relative volume" v={C.rvol != null ? `${n2(C.rvol)}× · ${C.participation}` : "—"} sub={C.rvolSource === "session" ? "vs the session average (no time-of-day history yet)" : C.rvol != null ? "vs the same time of day" : null} />
        <Row k="Breakout confirmation" v={<b>{C.confirmation}</b>} sub={C.model ? `model ${C.model}` : null} />
        <Row k="Retest confirmation" v={C.retest} />
        <Row k="False breakout risk" v={<b className={/High/.test(C.falseRisk) ? "down" : C.falseRisk === "Low" ? "up" : "warning"}>{C.falseRisk}</b>} sub={C.flags?.length ? C.flags.join(" · ") : C.wickBreaks ? `${C.wickBreaks} wick(s) through the level before the close` : null} />
      </tbody>
    </table>
  );
}

function Technical({ D }) {
  return (
    <table className="grid vr-kv">
      <thead>
        <tr>
          <th>D. Technical confirmation</th>
          <th className="num">Value</th>
        </tr>
      </thead>
      <tbody>
        <Row k="VWAP" v={fmtPrice(D.vwap)} sub={D.vwapDistAtr != null ? `price ${n2(D.vwapDistAtr)} ATR ${D.vwapDistance >= 0 ? "above" : "below"}` : null} />
        <Row k="VWAP slope" v={D.vwapSlope != null ? `${D.vwapSlope >= 0 ? "+" : ""}${fmtNum(D.vwapSlope, 3)} ATR / bar` : na} />
        <Row k="EMA 9" v={D.ema9 != null ? fmtPrice(D.ema9) : na} />
        <Row k="EMA 20" v={D.ema20 != null ? fmtPrice(D.ema20) : na} />
        <Row k="EMA 50" v={D.ema50 != null ? fmtPrice(D.ema50) : na} sub={D.ema50 == null ? "needs 50 bars from 09:15" : null} />
        <Row k="RSI (5)" v={D.rsi5 != null ? n1(D.rsi5) : na} />
        <Row k="RSI (14)" v={D.rsi14 != null ? n1(D.rsi14) : na} />
        <Row k="ADX (14)" v={D.adx != null ? `${n1(D.adx)} (+DI ${n1(D.plusDI)} / −DI ${n1(D.minusDI)})` : na} />
        <Row k="ATR" v={fmtPrice(D.atr)} sub={D.atrSource} />
        <Row k="MACD" v={D.macdStatus} />
        <Row k="Relative strength" v={`${fmtSignedPct(D.rsNifty)} vs NIFTY${D.rsSector != null ? ` · ${fmtSignedPct(D.rsSector)} vs sector` : ""}`} sub={`since the open · liquidity ${D.liquidity?.toLowerCase()}`} />
      </tbody>
    </table>
  );
}

function TradeParams({ F }) {
  const long = F.side === "long";
  const r = (k, v, sub) => <Row k={k} v={v} sub={sub} />;
  return (
    <table className="grid vr-kv vr-trade">
      <thead>
        <tr>
          <th colSpan={2}>
            F. Final trading parameters <span className={`badge ${F.status === "ACTIVE" ? "pos" : "warn"}`}>{F.status}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {r("Signal", <b className={long ? "up" : "down"}>{F.signal}</b>, `model ${F.model}`)}
        {r("Setup score", <b>{F.score} / 100</b>)}
        {r("Entry trigger", <b>{fmtPrice(F.trigger)}</b>, F.triggerText)}
        {r("Expected entry", <b className={long ? "up" : "down"}>{fmtPrice(F.expectedEntry)}</b>, F.entryNote)}
        {F.chaseLimit != null && r("Don't chase beyond", fmtPrice(F.chaseLimit), `an entry ${long ? "above" : "below"} this falls under the minimum net reward/risk or 1 ATR beyond the level`)}
        {r("Stop-loss", <b className="down">{fmtPrice(F.stop)}</b>, `${F.stopBasis}${F.stopNote ? ` — ${F.stopNote}` : ""}`)}
        {r("Target 1", fmtPrice(F.t1), `${F.t1Why}${F.netAtT1 != null ? ` · ${fmtRs(F.netAtT1)} net` : ""}`)}
        {r("Target 2", F.t2 != null ? fmtPrice(F.t2) : <span className="muted">—</span>, `${F.t2Why}${F.netAtT2 != null ? ` · ${fmtRs(F.netAtT2)} net` : ""}`)}
        {r("Target 3", F.t3 != null ? fmtPrice(F.t3) : <span className="muted">—</span>, F.t3 != null ? `${F.t3Why}${F.netAtT3 != null ? ` · ${fmtRs(F.netAtT3)} net` : ""}` : F.t3Note)}
        {r("Risk per share", fmtPrice(F.riskPerShare))}
        {r("Trading capital", fmtRs(F.capital))}
        {r("Risk percentage", `${F.riskPct}%`)}
        {r("Risk amount", fmtRs(F.riskRs))}
        {r("Quantity", <b>{F.qty?.toLocaleString("en-IN") ?? "—"}</b>)}
        {r("Total exposure", fmtRs(F.exposure), F.utilizationPct != null ? `${F.utilizationPct.toFixed(0)}% of capital` : null)}
        {r("Maximum loss", <b className="down">{fmtRs(F.maxLoss)}</b>, `incl. ${fmtRs(F.lossCharges)} charges and ${F.slippagePct}% stop slippage (${F.slippageSource})`)}
        {r("Estimated charges", fmtRs(F.chargesAtTarget), `round trip at ${F.primaryName}`)}
        {r("Net reward / risk", <b>{rr(F.netRR)}</b>, `to ${F.primaryName}, after every charge and slippage (gross ${rr(F.grossRR)})`)}
        {r("Execution status", <b>{F.executionStatus}</b>, "potential setup → trigger activated → confirmed signal; this app never submits orders")}
        {F.riskNotes?.length > 0 && (
          <tr>
            <td colSpan={2} className="small warning">
              {F.riskNotes.join(" · ")}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Explanation({ G }) {
  const item = (n, t, v) => (
    <div className="small">
      <b>
        {n}. {t}:
      </b>{" "}
      {v}
    </div>
  );
  return (
    <div className="vr-box">
      <h4>Decision explanation</h4>
      {item(1, "Why the breakout qualifies", G.qualifies)}
      <List title="2. Confirming" items={G.confirms} cls="up-list" />
      <List title="3. Against" items={G.opposes} cls="down-list" />
      {item(4, "Opening range", G.range)}
      {item(5, "Relative volume", G.volume)}
      {item(6, "Breakout candle", G.candle)}
      {item(7, "Acceptance beyond the level", G.acceptance)}
      {item(8, "VWAP and momentum", G.momentum)}
      {item(9, "Reward vs risk", G.reward)}
      {item(10, "What invalidates it", G.invalidation)}
      {item(11, "What could make it a false breakout", G.falseBreakout)}
      {item(12, "Execute or wait", G.action)}
    </div>
  );
}

/** r: the ORB decision report. */
export default function OrbBody({ r }) {
  if (!r.A) return r.F ? <NoTrade F={r.F} title="No trade" /> : null;
  return (
    <>
      <Gates gates={r.gates} />
      <div className="vr-grid">
        <div className="vr-col">
          <Overview A={r.A} />
          <OpeningRange B={r.B} />
          <Technical D={r.D} />
        </div>
        <div className="vr-col">
          <Breakout C={r.C} />
          {r.F && <TradeParams F={r.F} />}
          {r.G && <Explanation G={r.G} />}
          {r.H && <NoTrade F={r.H} title="No-trade explanation" />}
          <Missing r={r} />
        </div>
      </div>
      <Scorecard title="E. Eight-factor scorecard" factors={r.E} score={r.score} />
    </>
  );
}
