import { useEffect, useState } from "react";
import { fmtRs, fmtPct } from "../format.js";

export const DEFAULT_ACCOUNT = { capital: 100000, riskPct: 1, profitPct: 2, leverage: 1, indexFilter: "off" };

const INDEX_FILTER = [
  { v: "off", label: "Off" },
  { v: "sector", label: "Its sector index" },
  { v: "market", label: "NIFTY 50" },
];

const LEVERAGE = [
  { v: 1, label: "1× (cash)" },
  { v: 2, label: "2×" },
  { v: 3, label: "3×" },
  { v: 4, label: "4×" },
  { v: 5, label: "5× (MIS)" },
];

const n = (v) => (v === "" || v == null ? null : Number(v));

// Valid account for the server, or null while the inputs are incomplete.
export function cleanAccount(d) {
  const capital = n(d.capital);
  const riskPct = n(d.riskPct);
  const profitPct = n(d.profitPct);
  if (!(capital >= 1000) || !(riskPct > 0) || riskPct > 20) return null;
  if (profitPct != null && (profitPct < 0 || profitPct > 100)) return null;
  return { capital, riskPct, profitPct: profitPct || 0, leverage: n(d.leverage) || 1, indexFilter: d.indexFilter || "off" };
}

/**
 * The trader's money settings. Every strategy plan, position size and backtest ₹ figure on
 * the page follows them. onChange(account) fires (debounced) with a valid account.
 */
export default function AccountBar({ account, onChange }) {
  const [draft, setDraft] = useState(account);
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  useEffect(() => {
    const t = setTimeout(() => {
      const a = cleanAccount(draft);
      if (a && JSON.stringify(a) !== JSON.stringify(account)) onChange(a);
    }, 700);
    return () => clearTimeout(t);
  }, [draft, account, onChange]);

  const a = cleanAccount(draft);
  const riskRs = a ? (a.capital * a.riskPct) / 100 : null;
  const profitRs = a?.profitPct ? (a.capital * a.profitPct) / 100 : null;
  const rr = riskRs && profitRs ? profitRs / riskRs : null;
  const breakEven = rr ? 100 / (1 + rr) : null;

  return (
    <section className="account">
      <h2>Your trade</h2>
      <label>
        <span>Amount to trade ₹</span>
        <input type="number" min={1000} step={10000} value={draft.capital} onChange={set("capital")} />
      </label>
      <label title="The most you lose if a trade hits its stop: brokerage, STT, exchange, SEBI, GST, stamp duty and slippage on the stop all included. Position sizes are set so this holds.">
        <span>Max loss per trade %</span>
        <input type="number" min={0.1} max={20} step={0.1} value={draft.riskPct} onChange={set("riskPct")} />
        <b className="down">{riskRs ? fmtRs(riskRs) : "—"}</b>
        {riskRs && <span className="muted">incl. charges</span>}
      </label>
      <label title="Profit in hand when the target is hit, after all charges. Leave empty to use each strategy's own target.">
        <span>Net profit per trade %</span>
        <input type="number" min={0} max={100} step={0.1} value={draft.profitPct} placeholder="strategy's" onChange={set("profitPct")} />
        <b className="up">{profitRs ? fmtRs(profitRs) : "strategy's own target"}</b>
        {profitRs && <span className="muted">after charges{rr ? ` (${rr.toFixed(1)}× the loss)` : ""}</span>}
      </label>
      <label>
        <span>Leverage</span>
        <select value={draft.leverage} onChange={set("leverage")}>
          {LEVERAGE.map((l) => (
            <option key={l.v} value={l.v}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label title="Only BUY while the index is up (above its VWAP and yesterday's close); only SELL while it's down">
        <span>Trade with the index</span>
        <select value={draft.indexFilter || "off"} onChange={set("indexFilter")}>
          {INDEX_FILTER.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <span className="account-sum small muted">
        {a ? (
          <>
            Max position {fmtRs(a.capital * a.leverage)} · stop for the day after {fmtRs(3 * riskRs)} lost
            {breakEven != null && (
              <>
                {" "}
                · need to win <b>{fmtPct(breakEven, 1)}</b> of trades to break even (after charges, if trades end at the stop or the target)
              </>
            )}
            {a.riskPct > 3 && <span className="warning"> · risking over 3% per trade is aggressive</span>}
          </>
        ) : (
          <span className="warning">Enter an amount (≥ ₹1,000) and a risk % (0.1–20).</span>
        )}
      </span>
    </section>
  );
}
