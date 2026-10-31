import { useEffect, useState } from "react";
import SymbolSearch from "../components/SymbolSearch.jsx";
import { fetchPlans, runTimeMachine } from "../api.js";
import { fmtPct, fmtPrice, fmtR, istNow, isMarketOpen, store } from "../format.js";

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const price = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : "");
const PLAN_FIELDS = [
  ["entry", "Entry ₹", "number"],
  ["stop", "Stop ₹", "number"],
  ["target", "Target ₹", "number"],
  ["entryTime", "Entry bar closes", "time"],
  ["until", "Flat by", "time"],
  ["date", "Plan date", "date"],
];
const OPTION_FIELDS = [
  ["sessions", "Past sessions"],
  ["replays", "Replays"],
  ["seed", "Seed"],
  ["window", "Window ± bars"],
];
const MOVES = ["Below −1%", "−1% to −0.5%", "−0.5% to 0", "0 to +0.5%", "+0.5% to +1%", "+1% or more"];

// Starting plan: ORB's long levels from the front page's trade plans when it has them, else the
// last price with a 0.5% stop and a 1R target. Entry: the last closed 5m bar while the market
// is open, else 10:15.
function startPlan(plans) {
  const orb = plans.strategies?.find((s) => s.id === "orb");
  const x = orb?.position?.side === "long" ? orb.position : orb?.setups?.find((s) => s.side === "long" && s.stop != null && s.target != null && !s.invalid);
  const entry = x?.entry ?? plans.lastPrice;
  const now = istNow();
  const m = Math.floor(now.minute / 5) * 5;
  return {
    entry: price(entry),
    stop: price(x?.stop ?? entry * 0.995),
    target: price(x?.target ?? entry * 1.005),
    entryTime: isMarketOpen() && m >= 560 && m <= 910 ? hhmm(m) : "10:15",
    until: "15:15",
    date: now.date,
    from: x ? "the ORB plan" : "the last price ± 0.5%",
  };
}

export default function TimeMachinePage({ symbol, setSymbol }) {
  const [plan, setPlan] = useState(null);
  const [opts, setOpts] = useState(() => ({ sessions: 60, replays: 10000, seed: 19, window: 2, analog: false, ...store.get("tm.options", {}) }));
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => store.set("tm.options", opts), [opts]);

  // A fresh starting plan for each symbol.
  useEffect(() => {
    const ctrl = new AbortController();
    setPlan(null);
    setRes(null);
    setError(null);
    fetchPlans(symbol, "5m", null, ctrl.signal)
      .then((d) => setPlan(startPlan(d)))
      .catch((e) => e.name !== "AbortError" && setError(e.message));
    return () => ctrl.abort();
  }, [symbol]);

  // Runs 500 ms after the last edit (stop and target both set = trade, both blank = forecast).
  // The server checks the plan and says why it refuses one.
  useEffect(() => {
    if (!plan || (plan.stop === "") !== (plan.target === "")) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      runTimeMachine({ symbol, plan, ...opts }, ctrl.signal)
        .then((r) => (setRes(r), setError(null)))
        .catch((e) => e.name !== "AbortError" && (setRes(null), setError(e.message)))
        .finally(() => setLoading(false));
    }, 500);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [symbol, plan, opts]);

  const m = res?.mc;
  const h = res?.history;
  const fc = res?.forecast;
  const c = res?.conditioning;
  const u = res?.plan.until;
  const share = (n, of = fc.replays) => fmtPct((100 * n) / of, 1);
  const decided = m ? m.target + m.stop : 0;

  // Trade mode only: verdict, odds, break-even.
  const odds = m && (
    <>
      {res.verdict.map((line) => (
        <div key={line} className="tm-verdict">
          {line}
        </div>
      ))}
      <table className="grid tm-table">
        <thead>
          <tr>
            <th>Simulation</th>
            <th className="num">Replays</th>
            <th className="num">Share</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["Target first", m.target, "pos"],
            [`Stop first${m.gapStops ? ` (${m.gapStops} gapped through: a real fill is worse than −1R)` : ""}`, m.stop, "neg"],
            [`Still open at ${u}`, m.neither],
            [`Green at ${u}`, m.green],
          ].map(([label, n, cls]) => (
            <tr key={label} className={cls}>
              <td>{label}</td>
              <td className="num">{n.toLocaleString("en-IN")}</td>
              <td className="num">{share(n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="small">
        Target share of decided replays <b>{decided ? share(m.target, decided) : "—"}</b> vs break-even <b>{share(1, 1 + res.plan.targetR)}</b> · average{" "}
        <b>{fmtR(m.avgR)}</b>
      </div>
    </>
  );

  // Both modes: where the price is likely to be at each horizon.
  const forecast = fc && (
    <table className="grid tm-table">
      <thead>
        <tr>
          <th>Forecast from {fmtPrice(fc.ref)}</th>
          {fc.horizons.map((x, i) => (
            <th key={i} className="num">
              {x.time}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[
          ["Up", (x) => share(x.pUp, 1)],
          ["Down", (x) => share(x.pDown, 1)],
          ["Median", (x) => fmtPrice(x.median)],
          ["Middle 50%", (x) => `${fmtPrice(x.p25)} – ${fmtPrice(x.p75)}`],
          ["Middle 90%", (x) => `${fmtPrice(x.p5)} – ${fmtPrice(x.p95)}`],
          ...MOVES.map((label, b) => [label, (x) => share(x.buckets[b])]),
        ].map(([label, cell]) => (
          <tr key={label}>
            <td>{label}</td>
            {fc.horizons.map((x, i) => (
              <td key={i} className="num">
                {cell(x)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  // Trade mode only: the ORB rule on the same past sessions.
  const history = h && (
    <>
      <h4>History: the ORB rule on the same {h.sessions} sessions</h4>
      <div className="small">
        Fired {h.fired} · target {h.target} · stop {h.stop} · open at {u} {h.neither} · win rate {h.winRate == null ? "—" : fmtPct(100 * h.winRate, 1)} · average {fmtR(h.avgR)}
      </div>
      {h.trades.length > 0 && (
        <div className="table-wrap">
          <table className="grid tm-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Entry bar closes</th>
                <th className="num">Entry</th>
                <th className="num">Stop</th>
                <th className="num">Target</th>
                <th>Outcome</th>
                <th className="num">R</th>
              </tr>
            </thead>
            <tbody>
              {h.trades.map((t) => (
                <tr key={t.date} className={t.outcome === "target" ? "pos" : t.outcome === "stop" ? "neg" : ""}>
                  <td>{t.date}</td>
                  <td>{hhmm(555 + 5 * (t.slot + 1))}</td>
                  <td className="num">{fmtPrice(t.entry)}</td>
                  <td className="num">{fmtPrice(t.stop)}</td>
                  <td className="num">{fmtPrice(t.target)}</td>
                  <td>{t.outcome}</td>
                  <td className="num">{fmtR(t.R)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );

  return (
    <div className="lab-page">
      <section className="lab-form">
        <div className="row wrap">
          <label>
            <span>Symbol: {symbol}</span>
            <SymbolSearch onSelect={setSymbol} />
          </label>
          {plan &&
            PLAN_FIELDS.map(([k, label, type]) => (
              <label key={k}>
                <span>{label}</span>
                <input type={type} step={type === "time" ? 300 : type === "number" ? 0.05 : undefined} value={plan[k]} onChange={(e) => setPlan((p) => ({ ...p, [k]: e.target.value }))} />
              </label>
            ))}
          <label className="check" title="Weight past days whose morning looked like today's. Keep it off unless walk-forward accepted it for this stock.">
            <input type="checkbox" checked={opts.analog} onChange={(e) => setOpts((o) => ({ ...o, analog: e.target.checked }))} />
            Analog days
          </label>
          {loading && <span className="small muted">Replaying…</span>}
        </div>
        <details>
          <summary className="small">Simulation settings</summary>
          <div className="row wrap">
            {OPTION_FIELDS.map(([k, label]) => (
              <label key={k}>
                <span>{label}</span>
                <input type="number" value={opts[k]} onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.value }))} />
              </label>
            ))}
          </div>
        </details>
        <div className="small muted">
          {plan ? `Prefilled from ${plan.from}. ` : "Loading the plan… "}
          Long only; leave stop and target blank for a price forecast. Replays the rest of the day from {symbol}'s own 5-minute bars of past sessions only. It never places an order.
        </div>
        {error && <div className="banner error">{error}</div>}
      </section>

      {res && (
        <section className="res">
          <div className="res-head">
            <h3>
              {symbol} ·{" "}
              {m
                ? `long ${fmtPrice(res.plan.entry)} · stop ${fmtPrice(res.plan.stop)} · target ${fmtPrice(res.plan.target)} (${res.plan.targetR.toFixed(2)}R)`
                : `forecast from ${fmtPrice(fc.ref)} at ${res.plan.entryTime}`}
            </h3>
            <span className="small muted">
              {fc.replays.toLocaleString("en-IN")} replays × {res.plan.bars} bars ({res.plan.entryTime} → {u}) · seed {fc.seed} · window ±{fc.window} · {res.pool.sessions} sessions{" "}
              {res.pool.firstDate} → {res.pool.lastDate}
              {res.pool.excludedSessions ? ` · ${res.pool.excludedSessions} incomplete sessions skipped` : ""}
            </span>
          </div>
          {res.warning && <div className="small warning">{res.warning}</div>}
          {c && (
            <div className="small">
              Analog days on {c.used.join(", ") || "event tags only"} · effective sample {c.ess.toFixed(1)} days{c.fellBack ? " (fell back to uniform)" : ""} · heaviest:{" "}
              {c.top.map((t) => `${t.date} (${t.w.toFixed(2)})`).join(", ")}
            </div>
          )}
          {odds}
          {forecast}
          {history}
          <p className="small muted">
            Simulation from recent sessions, not a prediction. Results days, RBI policy, F&amp;O expiry, news and circuit limits can do things these sessions never did.
          </p>
        </section>
      )}
    </div>
  );
}
