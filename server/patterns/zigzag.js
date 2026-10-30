// Causal zigzag swing points for ONE session.
// A swing high is confirmed only once price has fallen `pct`% from it (and vice versa),
// so each pivot carries `confirmedAt`: the bar where it became known. Pivots never move
// after confirmation, so "pivots known at bar i" = pivots with confirmedAt <= i.
const cache = new WeakMap();

export function zigzag(cs, pct) {
  let byPct = cache.get(cs);
  if (byPct?.has(pct)) return byPct.get(pct);

  const th = pct / 100;
  const piv = [];
  const n = cs.length;
  let dir = 0; // 0 = no pivot yet, 1 = tracking a high (last pivot L), -1 = tracking a low (last pivot H)
  let hi = 0;
  let lo = 0;
  let ext = 0;

  for (let i = 0; i < n; i++) {
    const b = cs[i];
    if (dir === 0) {
      if (b.high > cs[hi].high) hi = i;
      if (b.low < cs[lo].low) lo = i;
      if (hi < i && (cs[hi].high - b.low) / cs[hi].high >= th) {
        piv.push({ index: hi, price: cs[hi].high, type: "H", confirmedAt: i });
        dir = -1;
        ext = hi + 1;
        for (let k = hi + 1; k <= i; k++) if (cs[k].low < cs[ext].low) ext = k;
      } else if (lo < i && (b.high - cs[lo].low) / cs[lo].low >= th) {
        piv.push({ index: lo, price: cs[lo].low, type: "L", confirmedAt: i });
        dir = 1;
        ext = lo + 1;
        for (let k = lo + 1; k <= i; k++) if (cs[k].high > cs[ext].high) ext = k;
      }
    } else if (dir === 1) {
      if (b.high > cs[ext].high) ext = i;
      else if ((cs[ext].high - b.low) / cs[ext].high >= th) {
        piv.push({ index: ext, price: cs[ext].high, type: "H", confirmedAt: i });
        dir = -1;
        ext = i;
      }
    } else {
      if (b.low < cs[ext].low) ext = i;
      else if ((b.high - cs[ext].low) / cs[ext].low >= th) {
        piv.push({ index: ext, price: cs[ext].low, type: "L", confirmedAt: i });
        dir = 1;
        ext = i;
      }
    }
  }

  if (!byPct) cache.set(cs, (byPct = new Map()));
  byPct.set(pct, piv);
  return piv;
}

// Pivots known at the close of bar i.
export function pivotsAt(cs, i, pct) {
  const all = zigzag(cs, pct);
  const out = [];
  for (const p of all) {
    if (p.confirmedAt > i) break; // confirmations are in order
    out.push(p);
  }
  return out;
}
