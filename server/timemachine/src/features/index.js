// Morning features for analog days, read at decision slot e from bars 0..e−1 only.
// A feature is { name, available(rows, ctx), value(row, ctx) }. To add one (open interest,
// delivery %…), append it here; the engine needs no change.
//   row = { date, bars, prevClose }   prevClose: slot-74 close of the previous valid session, or null
//   ctx = { e, pool: rows of the pool sessions, index: Map(date -> index bars) | null }
const total = (row, e, f) => {
  let s = 0;
  for (let k = 0; k < e; k++) s += f(row.bars[k], k);
  return s;
};
const cumVol = (row, e) => total(row, e, (b) => b.v);
const meanCumVol = (ctx) => (ctx.meanCumVol ??= ctx.pool.reduce((a, r) => a + cumVol(r, ctx.e), 0) / ctx.pool.length);
const indexBars = (row, ctx) => {
  const b = ctx.index?.get(row.date);
  return b?.length >= ctx.e ? b : null;
};
const always = () => true;

export const FEATURES = [
  {
    name: "relVol", // volume so far vs the pool's average volume so far
    available: (rows, ctx) => rows.every((r) => r.bars.slice(0, ctx.e).every((b) => Number.isFinite(b.v))) && meanCumVol(ctx) > 0,
    value: (row, ctx) => cumVol(row, ctx.e) / meanCumVol(ctx),
  },
  {
    name: "rvol", // realized volatility per bar so far
    available: always,
    value: (row, { e }) => Math.sqrt((1 / e) * total(row, e, (b, k) => Math.log(b.c / (k ? row.bars[k - 1].c : b.o)) ** 2)),
  },
  {
    name: "gap", // opening gap from the previous session's close
    available: always,
    value: (row) => (row.prevClose == null ? 0 : Math.log(row.bars[0].o / row.prevClose)),
  },
  {
    name: "moveSoFar", // the stock's move since the open
    available: always,
    value: (row, { e }) => Math.log(row.bars[e - 1].c / row.bars[0].o),
  },
  {
    name: "niftyMove", // Nifty 50's move since the open, same date
    available: (rows, ctx) => rows.every((r) => indexBars(r, ctx)),
    value: (row, ctx) => {
      const b = indexBars(row, ctx);
      return Math.log(b[ctx.e - 1].c / b[0].o);
    },
  },
];
