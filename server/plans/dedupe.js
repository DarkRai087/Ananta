// Cross-strategy signal dedupe. buildPlans is per-symbol, so two strategies (e.g. PDH/PDL v2 and
// Volume Breakout v2) proposing the SAME side at the SAME price are one trade, not two. We keep the
// first (plans arrive sorted by priority) as primary and tag the rest's setups `duplicateOf: <id>`
// so the "top strategies" UI can show one combined signal instead of double-counting. Pure.
const LIVE = new Set(["in_trade", "signal", "armed", "watching"]);

export function markDuplicateSignals(strategies, { tolPct = 0.1 } = {}) {
  const primaries = []; // { id, side, price }
  for (const s of strategies) {
    if (!LIVE.has(s.status)) continue;
    for (const setup of s.setups || []) {
      const price = setup.entry ?? setup.trigger;
      if (price == null || !Number.isFinite(price) || setup.invalid) continue;
      const hit = primaries.find((q) => q.side === setup.side && Math.abs(q.price - price) / price * 100 <= tolPct);
      if (hit) {
        setup.duplicateOf = hit.id;
        s.hasDuplicate = true;
      } else {
        primaries.push({ id: s.id, side: setup.side, price });
      }
    }
  }
  return strategies;
}
