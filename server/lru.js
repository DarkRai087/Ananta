// The one in-memory cache type: a Map that drops its least recently used entries once their
// total cost passes `max`. cost(value) weighs an entry (default 1, i.e. count entries); with
// ttlMs > 0 an entry also expires that long after it was stored.
export function lru({ max, ttlMs = 0, cost = () => 1 }) {
  const map = new Map();
  let used = 0;
  const drop = (k, e) => {
    map.delete(k);
    used -= e.c;
  };
  const c = {
    get(k) {
      const e = map.get(k);
      if (!e) return undefined;
      if (ttlMs && Date.now() - e.at > ttlMs) return void drop(k, e);
      map.delete(k); // most recently used goes last
      map.set(k, e);
      return e.v;
    },
    set(k, v) {
      const old = map.get(k);
      if (old) drop(k, old);
      const e = { v, c: cost(v), at: Date.now() };
      map.set(k, e);
      used += e.c;
      for (const [k2, e2] of map) {
        if (used <= max || map.size === 1) break;
        drop(k2, e2);
      }
      return v;
    },
    // The cached value, or fn()'s on a miss (stored; a promise is stored as-is).
    use: (k, fn) => {
      const v = c.get(k);
      return v !== undefined ? v : c.set(k, fn());
    },
    delete: (k) => map.has(k) && drop(k, map.get(k)),
    clear: () => {
      map.clear();
      used = 0;
    },
    get size() {
      return map.size;
    },
  };
  return c;
}
