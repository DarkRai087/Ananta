// Renders a strategy's parameter spec: [{ key, label, type: number|bool|select|time, options, step }]
export default function ParamsForm({ spec, values, onChange }) {
  const set = (k, v) => onChange({ ...values, [k]: v });
  return (
    <div className="params">
      {spec.map((p) => (
        <label key={p.key} className={p.type === "bool" ? "check" : ""}>
          {p.type === "bool" ? (
            <>
              <input type="checkbox" checked={Boolean(values[p.key])} onChange={(e) => set(p.key, e.target.checked)} />
              {p.label}
            </>
          ) : (
            <>
              <span>{p.label}</span>
              {p.type === "select" ? (
                <select value={values[p.key]} onChange={(e) => set(p.key, typeof p.options[0] === "number" ? Number(e.target.value) : e.target.value)}>
                  {p.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : p.type === "time" ? (
                <input type="time" value={values[p.key]} min="09:15" max="15:30" onChange={(e) => set(p.key, e.target.value)} />
              ) : (
                <input type="number" step={p.step ?? "any"} value={values[p.key]} onChange={(e) => set(p.key, e.target.value === "" ? "" : Number(e.target.value))} />
              )}
            </>
          )}
        </label>
      ))}
    </div>
  );
}
