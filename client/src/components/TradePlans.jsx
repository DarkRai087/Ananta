import { Fragment, useMemo, useState } from "react";
import { fmtPrice, fmtR, fmtRs, fmtHHMM, fmtSignedPct, store } from "../format.js";
import WinRate, { exitsText } from "./WinRate.jsx";

const STATUS = {
  exit: { text: "EXIT NOW", cls: "hot" },
  signal: { text: "SIGNAL NOW", cls: "hot" },
  in_trade: { text: "In trade", cls: "live" },
  armed: { text: "Armed", cls: "armed" },
  watching: { text: "Watching", cls: "watch" },
  waiting: { text: "Waiting", cls: "wait" },
  off: { text: "Not today", cls: "off" },
  done: { text: "Done today", cls: "off" },
};
const ACTIVE = new Set(["exit", "signal", "in_trade", "armed", "watching", "waiting"]);
const BIAS = {
  bullish: { text: "▲ Bullish", cls: "up" },
  bearish: { text: "▼ Bearish", cls: "down" },
  "two-way": { text: "⇅ Either way", cls: "muted" },
  neutral: { text: "—", cls: "muted" },
};
const COLOR = { buy: "#26a69a", sell: "#ef5350", stop: "#ff9800", target: "#42a5f5" };

// Entry / stop / target lines for the chart.
export function planLevels(p) {
  if (!p) return [];
  if (p.position) {
    const x = p.position;
    const long = x.side === "long";
    return [
      { price: x.entry, label: `${long ? "LONG" : "SHORT"} entry`, color: long ? COLOR.buy : COLOR.sell },
      { price: x.stop, label: "SL", color: COLOR.stop },
      x.target != null && { price: x.target, label: "Target", color: COLOR.target },
    ].filter(Boolean);
  }
  const out = [];
  for (const side of ["long", "short"]) {
    const s = p.setups.find((x) => x.side === side && !x.invalid && !x.blocked);
    if (!s) continue;
    const long = side === "long";
    out.push({ price: s.entry, label: `${s.action} ${fmtPrice(s.entry)}`, color: long ? COLOR.buy : COLOR.sell });
    if (s.stop != null) out.push({ price: s.stop, label: `${s.action} SL`, color: COLOR.stop });
    if (s.target != null) out.push({ price: s.target, label: `${s.action} target`, color: COLOR.target });
  }
  return out;
}

function Setup({ s, more }) {
  if (!s) return <span className="muted">—</span>;
  const long = s.side === "long";
  return (
    <div className={`setup ${s.invalid || s.blocked ? "invalid" : ""}`}>
      <div className="setup-main">
        <b className={long ? "up" : "down"}>
          {s.action} {s.atMarket ? "now ≈ " : ""}
          {fmtPrice(s.entry)}
        </b>
        {s.approx && <span className="muted" title="Estimated: the exact level depends on the trigger candle">≈</span>}
        <span className="dist" title="Distance from the current price">
          {fmtSignedPct(s.distancePct)}
        </span>
      </div>
      <div className="setup-when">{s.when}</div>
      <div className="setup-levels">
        SL <b>{fmtPrice(s.stop)}</b> · Target <b>{s.target != null ? fmtPrice(s.target) : "—"}</b>
        {s.rr ? ` · 1:${s.rr.toFixed(1)}` : ""}
      </div>
      {s.qty > 0 && (
        <div className="setup-money">
          qty <b>{s.qty.toLocaleString("en-IN")}</b> ({fmtRs(s.value)}) · lose <b className="down">{fmtRs(s.lossRs)}</b>
          <span className="muted" title="Brokerage, STT, exchange, SEBI, GST and stamp duty on the round trip (the loss also includes slippage on the stop fill)">
            {" "}
            (incl. {fmtRs(s.lossCharges)} charges)
          </span>
          {s.profitRs != null && (
            <>
              {" "}
              · make <b className="up">{fmtRs(s.profitRs)}</b>
              <span className="muted"> (after {fmtRs(s.profitCharges)} charges)</span>
            </>
          )}
        </div>
      )}
      {s.targetNote && <div className="small muted">{s.targetNote}</div>}
      {s.extended && <div className="small warning">Price is already past this level — it has to come back and cross again.</div>}
      {s.invalid && <div className="small down">{s.invalid}</div>}
      {s.blocked && <div className="small warning">⛔ {s.blocked}</div>}
      {more > 0 && <div className="small muted">+{more} more level{more > 1 ? "s" : ""} (click the row)</div>}
    </div>
  );
}

function Position({ p }) {
  const x = p.position;
  const long = x.side === "long";
  return (
    <div className="position">
      <div>
        <b className={long ? "up" : "down"}>
          {long ? "LONG" : "SHORT"} {x.qty.toLocaleString("en-IN")} @ {fmtPrice(x.entry)}
        </b>{" "}
        since {fmtHHMM(x.entryTime)} · now {fmtPrice(x.lastPrice)}{" "}
        <b className={x.pnlR >= 0 ? "up" : "down"}>
          {fmtR(x.pnlR)} ({fmtRs(x.pnlRs)} after charges)
        </b>
      </div>
      <div className="setup-levels">
        SL <b>{fmtPrice(x.stop)}</b>
        {x.stop !== x.initialStop ? " (trailed)" : ""} · Target <b>{x.target != null ? fmtPrice(x.target) : "exit signal / 15:15"}</b>
      </div>
      <div className="setup-money">
        at SL <b className={x.lossRs >= 0 ? "up" : "down"}>{fmtRs(x.lossRs)}</b>
        {x.profitRs != null && (
          <>
            {" "}
            · at target <b className="up">{fmtRs(x.profitRs)}</b>
          </>
        )}{" "}
        (after charges)
      </div>
      {p.status === "exit" && <div className="hot-text">Exit signal — {long ? "SELL" : "BUY back"} now at market</div>}
    </div>
  );
}

function Detail({ p }) {
  return (
    <div className="plan-detail">
      <div>{p.description}</div>
      <div className="small muted">
        Entry window {p.entryWindow} · Stop: {p.stopRule} · Target: {p.targetRule}
      </div>
      {p.note && <div className="small">{p.note}</div>}
      {p.setups.length > 1 && (
        <div className="setups-all">
          {p.setups.map((s, k) => (
            <Setup key={k} s={s} />
          ))}
        </div>
      )}
      {p.trades.length > 0 && (
        <div className="small">
          <b>Trades this session:</b>
          {p.trades.map((t, k) => (
            <div key={k}>
              {t.side === "long" ? "LONG" : "SHORT"} {fmtHHMM(t.entryTime)} @ {fmtPrice(t.entry)} → {fmtHHMM(t.exitTime)} @ {fmtPrice(t.exit)} · {t.reason} ·{" "}
              <b className={t.net > 0 ? "up" : "down"}>
                {fmtR(t.rNet)} ({fmtRs(t.net)})
              </b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Backtest({ m }) {
  if (!m) return <span className="muted">—</span>;
  if (!m.trades) return <span className="muted">no trades</span>;
  return (
    <div className="bt-cell">
      <div title={`Average net result of ${m.trades} out-of-sample trades, after all charges`}>
        <b className={m.expectancyRs > 0 ? "up" : "down"}>{fmtRs(m.expectancyRs)}</b>
        <span className="muted">/trade</span>
      </div>
      <WinRate m={m} />
      {m.exits && <div className="muted wr-detail">{exitsText(m.exits)}</div>}
    </div>
  );
}

/**
 * Every strategy's plan for today: open positions, fresh signals, and the exact BUY / SELL
 * levels with stop, target and size. plans: GET /api/lab/plans. stats: { [id]: metrics }.
 */
export default function TradePlans({ plans, loading, error, stats, statsLabel, noEdge, selectedId, onSelect }) {
  const [showAll, setShowAll] = useState(() => store.get("nse.plansAll", false));
  const [expanded, setExpanded] = useState(null);

  const rows = useMemo(() => (plans?.strategies || []).filter((p) => showAll || ACTIVE.has(p.status)), [plans, showAll]);
  const counts = useMemo(() => {
    const c = {};
    for (const p of plans?.strategies || []) c[p.status] = (c[p.status] || 0) + 1;
    return c;
  }, [plans]);
  const hidden = (plans?.strategies.length || 0) - rows.length;

  const click = (p) => {
    const on = selectedId !== p.id;
    onSelect(on ? p : null);
    setExpanded(on ? p.id : null);
  };

  return (
    <section className="plans">
      <div className="sb-head">
        <h2>Trade plan — every strategy</h2>
        {plans && <span className={`mode ${plans.phase === "live" ? "live" : "waiting"}`}>{plans.label}</span>}
        {plans?.lastPrice != null && (
          <span className="small">
            Price <b>{fmtPrice(plans.lastPrice)}</b>
          </span>
        )}
        <span className="chips">
          {["exit", "signal", "in_trade", "armed", "watching", "waiting"]
            .filter((k) => counts[k])
            .map((k) => (
              <span key={k} className={`chip st-${STATUS[k].cls}`}>
                {counts[k]} {STATUS[k].text.toLowerCase()}
              </span>
            ))}
        </span>
        <span className="spacer" />
        {loading && <span className="small muted">Updating…</span>}
        <div className="seg">
          <button
            className={!showAll ? "active" : ""}
            onClick={() => {
              setShowAll(false);
              store.set("nse.plansAll", false);
            }}
          >
            Active
          </button>
          <button
            className={showAll ? "active" : ""}
            onClick={() => {
              setShowAll(true);
              store.set("nse.plansAll", true);
            }}
          >
            All {plans?.strategies.length ?? ""}
          </button>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      {plans?.warning && <div className="small warning">{plans.warning}</div>}
      {plans?.index?.now && (
        <div className="small index-line">
          {plans.index.name}{" "}
          <b className={plans.index.now.dir === 1 ? "up" : plans.index.now.dir === -1 ? "down" : "muted"}>
            {plans.index.now.dir === 1 ? "▲ up" : plans.index.now.dir === -1 ? "▼ down" : "● mixed"}
          </b>{" "}
          {fmtSignedPct(plans.index.now.changePct)} on the day, {plans.index.now.aboveVwap ? "above" : "below"} VWAP.{" "}
          {plans.index.choice !== "off" ? (
            <b>
              Trading with the index: {plans.index.now.allows === "long" ? "BUY setups only" : plans.index.now.allows === "short" ? "SELL setups only" : "no new trades until it picks a side"}.
            </b>
          ) : (
            <span className="muted">Index filter is off (turn it on in "Your trade").</span>
          )}
        </div>
      )}
      {plans?.regime && (plans.regime.tag !== "NORMAL" || plans.regime.gap?.gap) && (
        <div className="small index-line">
          {plans.regime.gap?.gap && (
            <>
              <b>GAP day</b> ({plans.regime.gap.side === "long" ? "up" : "down"}, {plans.regime.gap.gapAtr?.toFixed(1)}×ATR) — routed to Gap and Go.{" "}
            </>
          )}
          {plans.regime.tag !== "NORMAL" && (
            <>
              CPR-width regime: <b>{plans.regime.tag}</b>
              {plans.regime.pct != null ? ` (${Math.round(plans.regime.pct * 100)}th pct)` : ""} —{" "}
              {plans.regime.tag === "WIDE" ? "range-likely, favours mean-reversion (CPR Reversal)" : "trend-likely, favours continuation (PDH/PDL, Volume Breakout)"}.
            </>
          )}
          {plans.regime.conflicts?.length ? ` ${plans.regime.conflicts.length} signal${plans.regime.conflicts.length > 1 ? "s" : ""} stood down.` : ""}
        </div>
      )}
      {noEdge && (
        <div className="banner sitout small">
          <strong>Backtest warning:</strong> no strategy made money after charges on recent data. These are the levels where each strategy <i>would</i> trade — not a recommendation to trade them.
        </div>
      )}
      {plans && (
        <div className="small muted plan-legend">
          BUY / SELL = enter there (fills at the next bar's open after the trigger). SL = stop-loss. Sized to your trade: max loss {fmtRs(plans.settings?.riskPerTrade)} per trade including charges, max position{" "}
          {fmtRs(plans.settings?.maxPositionValue)}
          {plans.settings?.profitTarget > 0 ? `, target = ${fmtRs(plans.settings.profitTarget)} profit after charges` : ", target from each strategy's own rule"}. "lose" = net loss if the stop is hit: brokerage, STT, exchange, SEBI, GST, stamp duty and {plans.settings?.slippagePct}% stop slippage included — never more than your risk unless price gaps past the stop. "make" = net profit at the target after all charges. Win % = trades that made money after charges; "need" = the win % that breaks even. ≈ = estimated level.
          Square off by {plans.settings?.squareOff}. Click a row to draw its levels on the chart.
        </div>
      )}
      {plans && (
        <div className="table-wrap">
          <table className="grid plans-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Side</th>
                <th>BUY plan</th>
                <th>SELL plan</th>
                <th>{statsLabel || "Backtest"}</th>
                <th>Why / status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const st = STATUS[p.status] || STATUS.off;
                const longs = p.setups.filter((s) => s.side === "long");
                const shorts = p.setups.filter((s) => s.side === "short");
                const b = BIAS[p.bias] || BIAS.neutral;
                return (
                  <Fragment key={p.id}>
                    <tr className={`plan-row ${selectedId === p.id ? "selected" : ""} st-row-${st.cls}`} onClick={() => click(p)}>
                      <td>
                        <div className="plan-name">{p.name}</div>
                        <span className={`st-pill st-${st.cls}`}>{st.text}</span>
                      </td>
                      <td className={b.cls}>{b.text}</td>
                      {p.position ? (
                        <td colSpan={2}>
                          <Position p={p} />
                        </td>
                      ) : (
                        <>
                          <td>
                            <Setup s={longs[0]} more={longs.length - 1} />
                          </td>
                          <td>
                            <Setup s={shorts[0]} more={shorts.length - 1} />
                          </td>
                        </>
                      )}
                      <td>
                        <Backtest m={stats?.[p.id]} />
                      </td>
                      <td className="why-cell">
                        {p.note}
                        {p.suppressed && <div className="small warning">⤼ Stood down by {p.suppressed.by} ({p.suppressed.regime} CPR regime)</div>}
                      </td>
                    </tr>
                    {expanded === p.id && (
                      <tr className="sub">
                        <td colSpan={6}>
                          <Detail p={p} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {hidden > 0 && (
            <div className="small muted">
              {hidden} strateg{hidden > 1 ? "ies" : "y"} not active today hidden —{" "}
              <button className="link" onClick={() => setShowAll(true)}>
                show all
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
