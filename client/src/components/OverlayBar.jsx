import { useEffect, useRef, useState } from "react";

// Overlay toggles (all off by default) + a pattern-marker menu.
export default function OverlayBar({ meta, overlays, setOverlays, patterns, setPatterns, orMinutes, setOrMinutes, enabled }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const onDown = (e) => menuRef.current && !menuRef.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  if (!meta) return null;
  const toggle = (list, set, id) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className={`overlay-bar ${enabled ? "" : "disabled"}`} title={enabled ? "" : "Overlays work on intraday intervals (15m, 5m, 3m, 1m)"}>
      {meta.overlays.map((o) => (
        <button key={o.id} className={overlays.includes(o.id) ? "on" : ""} onClick={() => toggle(overlays, setOverlays, o.id)} disabled={!enabled}>
          {o.label}
        </button>
      ))}
      {overlays.includes("or") && (
        <select value={orMinutes} onChange={(e) => setOrMinutes(Number(e.target.value))} disabled={!enabled}>
          {[5, 15, 30].map((m) => (
            <option key={m} value={m}>
              OR {m}m
            </option>
          ))}
        </select>
      )}
      <div className="menu" ref={menuRef}>
        <button className={patterns.length ? "on" : ""} onClick={() => setOpen((v) => !v)} disabled={!enabled}>
          Patterns{patterns.length ? ` (${patterns.length})` : ""} ▾
        </button>
        {open && (
          <div className="menu-list">
            <div className="menu-actions">
              <button className="link" onClick={() => setPatterns(meta.patterns.map((p) => p.id))}>
                All
              </button>
              <button className="link" onClick={() => setPatterns([])}>
                None
              </button>
            </div>
            {meta.patterns.map((p) => (
              <label key={p.id}>
                <input type="checkbox" checked={patterns.includes(p.id)} onChange={() => toggle(patterns, setPatterns, p.id)} />
                {p.names.join(" / ")}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
