// Entry, stop, targets and size for the setup, priced the way the backtest fills them.
//
//   entry   triggered → the next bar's open (≈ the trigger candle's close)
//           armed     → one tick beyond the rejection candle's high (long) / low (short)
//           (stretched: no levels — the rejection candle isn't finished, so its high / low
//           isn't known and nothing is priced on a guess)
//   stop    beyond the excursion's swing low / high by max(0.2 × ATR, 2 ticks)
//   T1      the ∓1σ band, or halfway to VWAP if the entry is already past it
//   T2      VWAP (the mean-reversion objective; reward/risk is measured here)
//   T3      the opposite ±1σ band, only when the regime is balanced and the clock allows
//   qty     the most shares whose loss at the stop — move, stop slippage and every charge — is
//           within the risk per trade (backtest/costs.js sizeForRisk)
import { sizeForRisk } from "../backtest/costs.js";
import { netAt } from "../decision/sizing.js";
import { SQUARE_OFF_MIN } from "../lab/time.js";
import { roundTick } from "../decision/util.js";

export { resolveRisk } from "../decision/sizing.js";

export function tradeLevels(D, regimeScore) {
  const { S, i, setup, cfg, long, tick, atr, risk, intervalMin, nextMin } = D;
  const st = setup.state;
  if (st !== "triggered" && st !== "armed") return null;
  const T = cfg.targets;
  const c = S.bars[i];
  const vwap = S.vwap[i];
  const sigma = S.sigma[i];
  const a = atr.value;

  const approx = false;
  let trigger;
  let entry;
  if (st === "triggered") {
    trigger = roundTick(setup.triggerLevel, tick);
    entry = c.close; // fills at the next bar's open
  } else {
    trigger = long ? roundTick(setup.triggerLevel + tick, tick, "up") : roundTick(setup.triggerLevel - tick, tick, "down");
    entry = trigger;
  }
  const buffer = Math.max(cfg.risk.stopAtrBuffer * (a || 0), cfg.risk.stopMinTicks * tick);
  const stop = long ? roundTick(setup.extreme - buffer, tick, "down") : roundTick(setup.extreme + buffer, tick, "up");
  const t2 = long ? roundTick(vwap, tick, "down") : roundTick(vwap, tick, "up");
  const riskPerShare = Number(Math.abs(entry - stop).toFixed(4));

  let t1 = long ? vwap - sigma : vwap + sigma;
  if (!(long ? t1 >= entry + T.minT1R * riskPerShare : t1 <= entry - T.minT1R * riskPerShare)) t1 = (entry + vwap) / 2;
  t1 = long ? roundTick(t1, tick, "down") : roundTick(t1, tick, "up");

  // T3 only when the regime is balanced and there is time to get there.
  const barsLeft = Math.max(0, (SQUARE_OFF_MIN - nextMin) / intervalMin);
  const speed = cfg.session.reversionAtrPerBar * (a || 0);
  const t3raw = long ? vwap + sigma : vwap - sigma;
  const barsToT3 = speed > 0 ? Math.abs(t3raw - entry) / speed : Infinity;
  let t3 = null;
  let t3Note = "";
  if (regimeScore < T.t3MinRegime) t3Note = `not justified: regime ${regimeScore}/20 is below ${T.t3MinRegime}`;
  else if (barsLeft < barsToT3 * cfg.session.timeSafety) t3Note = "not justified: not enough time left before 15:15";
  else t3 = long ? roundTick(t3raw, tick, "down") : roundTick(t3raw, tick, "up");

  const slip = risk.slippagePct;
  const sideName = long ? "long" : "short";
  // Size and net reward / risk to T2 for an entry at e (slippage on the entry and the stop,
  // every charge both ways).
  const sized = (e) => {
    if (!(long ? stop < e && e < t2 : stop > e && e > t2)) return { valid: false, fill: e, size: { qty: 0, lossRs: null, charges: null }, netRR: null };
    const fill = long ? e * (1 + slip / 100) : e * (1 - slip / 100);
    const size = sizeForRisk(sideName, fill, stop, { riskRs: risk.riskRs, maxValue: risk.maxPositionValue, slippagePct: slip });
    const n2 = netAt(long, fill, t2, size.qty).net;
    return { valid: true, fill, size, netRR: size.qty > 0 && size.lossRs > 0 && n2 != null ? n2 / size.lossRs : null };
  };
  const here = sized(entry);
  const valid = here.valid;
  const entryFill = here.fill;
  const size = here.size;
  const qty = size.qty;
  // Capped = the position-value limit, not the risk budget, decided the size.
  const capped = qty > 0 && risk.maxPositionValue > 0 && sizeForRisk(sideName, entryFill, stop, { riskRs: risk.riskRs, maxValue: 0, slippagePct: slip }).qty > qty;
  const at = (x) => netAt(long, entryFill, x, qty);
  const atT1 = at(t1);
  const atT2 = at(t2);
  const atT3 = t3 != null ? at(t3) : { net: null, charges: null };
  const grossRR = valid && riskPerShare > 0 ? Math.abs(t2 - entry) / riskPerShare : null;
  const netRR = here.netRR;

  // Chase limit: the worst entry (highest for a long) that still clears the minimum net R:R.
  // Fills come at the open after the trigger candle closes, so a strong trigger candle can
  // carry the entry past this — then the setup no longer qualifies.
  let chaseLimit = null;
  const minRR = cfg.risk.minNetRR;
  const ok = (e) => (sized(e).netRR ?? -Infinity) >= minRR;
  if (ok(long ? stop + tick : stop - tick)) {
    // Net R:R falls as the entry moves toward T2. long: a passes, b fails · short: a fails, b passes.
    let a = long ? stop + tick : t2;
    let b = long ? t2 : stop - tick;
    for (let k = 0; k < 40 && Math.abs(b - a) > tick / 4; k++) {
      const mid = (a + b) / 2;
      if (ok(mid) === long) a = mid;
      else b = mid;
    }
    chaseLimit = long ? roundTick(a, tick, "down") : roundTick(b, tick, "up");
  }
  const grossReward = qty > 0 ? Math.abs(t2 - entry) * qty : null;
  const slipRs = qty > 0 ? Math.abs(entryFill - entry) * qty : null;
  const costDrag = grossReward > 0 ? (atT2.charges + slipRs) / grossReward : null;

  return {
    state: st,
    conditional: st !== "triggered",
    approx,
    trigger,
    triggerLevel: setup.triggerLevel,
    entry,
    entryFill,
    stop,
    t1,
    t2,
    t3,
    t3Note,
    buffer,
    riskPerShare,
    rewardPerShare: Number(Math.abs(t2 - entry).toFixed(4)),
    valid,
    qty,
    capped,
    exposure: qty * entryFill,
    maxLossRs: size.lossRs,
    lossCharges: size.charges,
    netAtT1: atT1.net,
    netAtT2: atT2.net,
    netAtT3: atT3.net,
    chargesAtT2: atT2.charges,
    grossRR,
    netRR,
    chaseLimit,
    costDrag,
    slippagePct: slip,
    barsLeft,
    barsToT2: speed > 0 ? Math.abs(t2 - entry) / speed : null,
  };
}
