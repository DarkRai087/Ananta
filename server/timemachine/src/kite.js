// Kite historical candles -> sessions. Accepts ["2026-10-19T09:15:00+0530", o, h, l, c, volume]
// or { date, open, high, low, close, volume }. Date and time come from slicing the string (never
// new Date()), so the machine's time zone can't move a bar into another day. Volume becomes v.
export function fromKite(candles) {
  const days = new Map();
  for (const x of candles) {
    const [ts, o, h, l, c, v] = Array.isArray(x) ? x : [x.date, x.open, x.high, x.low, x.close, x.volume];
    const date = ts.slice(0, 10);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push({ t: ts.slice(11, 16), o, h, l, c, v });
  }
  const byStr = (a, b) => (a > b) - (a < b);
  return [...days.keys()].sort(byStr).map((date) => ({ date, bars: days.get(date).sort((a, b) => byStr(a.t, b.t)) }));
}
