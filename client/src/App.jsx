import { useEffect, useState } from "react";
import TodayPage from "./pages/TodayPage.jsx";
import LabPage from "./pages/LabPage.jsx";
import { useLabMeta } from "./hooks.js";
import { store } from "./format.js";

export default function App() {
  const { meta, error } = useLabMeta();
  const [page, setPage] = useState(() => store.get("nse.page", "today"));
  const [symbol, setSymbol] = useState(() => store.get("nse.symbol", "NIFTY50"));

  useEffect(() => store.set("nse.page", page), [page]);
  useEffect(() => store.set("nse.symbol", symbol), [symbol]);

  return (
    <div className="app">
      <nav className="nav">
        <span className="brand">NSE Intraday Lab</span>
        <button className={page === "today" ? "active" : ""} onClick={() => setPage("today")}>
          Today
        </button>
        <button className={page === "lab" ? "active" : ""} onClick={() => setPage("lab")}>
          Lab
        </button>
        <span className="spacer" />
        {meta && (
          <span className={`badge ${meta.provider.id === "smartapi" && meta.provider.smartapiConfigured ? "pos" : "warn"}`} title="Intraday data source">
            {meta.provider.id !== "smartapi"
              ? "Yahoo fallback (add SmartAPI keys for full history)"
              : meta.provider.smartapiConfigured
                ? "SmartAPI"
                : "SmartAPI keys missing — cached data only"}
          </span>
        )}
        <span className="small muted">Research only · no orders</span>
      </nav>
      {error && <div className="banner error">{error}</div>}
      {!meta && !error && <div className="small muted pad">Loading…</div>}
      {meta && page === "today" && <TodayPage meta={meta} symbol={symbol} setSymbol={setSymbol} />}
      {meta && page === "lab" && <LabPage meta={meta} symbol={symbol} setSymbol={setSymbol} />}
    </div>
  );
}
