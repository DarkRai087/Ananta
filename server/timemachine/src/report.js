// The plain-text reports the CLI prints. Rounding happens here and nowhere else.
const f = (x) => x.toFixed(2);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const DISCLAIMER = "Simulation from recent sessions, not a prediction. Results days, RBI policy, F&O expiry, news and circuit limits can do things these sessions never did.";
const MOVES = ["Below -1%", "-1% to -0.5%", "-0.5% to 0", "0 to +0.5%", "+0.5% to +1%", "+1% or more"];

export function report({ plan: p, pool, mc, history: h, verdict, forecast: fc, conditioning: c }) {
  const row = (label, n) => `  ${label.padEnd(18)}${String(n).padStart(6)}  ${pct(n / mc.replays).padStart(6)}`;
  const col = (label, fn) => `  ${label.padEnd(14)}${fc.horizons.map((x) => fn(x).padStart(19)).join("")}`;
  const decided = mc ? mc.target + mc.stop : 0;
  return [
    mc
      ? `${p.symbol ?? ""} ${p.date} · long ${f(p.entry)} · stop ${f(p.stop)} · target ${f(p.target)} (${f(p.targetR)}R) · entry bar closes ${p.entryTime} · flat by ${p.until}`.trim()
      : `${p.symbol ?? ""} ${p.date} · forecast from ${f(p.entry)} · entry bar closes ${p.entryTime} · flat by ${p.until}`.trim(),
    `${fc.replays} replays · ${p.bars} bars · seed ${fc.seed} · window ±${fc.window} · ${pool.sessions} sessions ${pool.firstDate} → ${pool.lastDate}${pool.excludedSessions ? ` (${pool.excludedSessions} excluded)` : ""}`,
    ...(c
      ? [`Analog days on ${c.used.join(", ") || "event tags only"} · ESS ${c.ess.toFixed(1)} · bandwidth ${c.bandwidth}${c.fellBack ? " (fell back to uniform)" : ""} · heaviest: ${c.top.map((t) => `${t.date} ${t.w.toFixed(2)}`).join(", ")}`]
      : []),
    ...(mc
      ? [
          row("Target first", mc.target),
          row("Stop first", mc.stop),
          row(`Neither by ${p.until}`, mc.neither),
          row(`Green at ${p.until}`, mc.green),
          `  Target share of decided ${decided ? pct(mc.target / decided) : "—"} vs break-even ${pct(1 / (1 + p.targetR))}`,
          `  Gap stops ${mc.gapStops} (booked at -1R; a real fill would be worse) · average R ${f(mc.avgR)}`,
          `Price at ${p.until}: median ${f(mc.median)} · 5–95% ${f(mc.p5)} – ${f(mc.p95)}`,
        ]
      : []),
    `Forecast from ${f(fc.ref)}:`,
    col("At", (x) => x.time),
    col("Up", (x) => pct(x.pUp)),
    col("Down", (x) => pct(x.pDown)),
    col("Median", (x) => f(x.median)),
    col("Middle 50%", (x) => `${f(x.p25)} – ${f(x.p75)}`),
    col("Middle 90%", (x) => `${f(x.p5)} – ${f(x.p95)}`),
    ...MOVES.map((label, b) => col(label, (x) => pct(x.buckets[b] / fc.replays))),
    ...(mc
      ? [
          `History (ORB, same ${h.sessions} sessions): fired ${h.fired} · target ${h.target} · stop ${h.stop} · neither ${h.neither} · win rate ${h.winRate == null ? "—" : pct(h.winRate)} · average R ${f(h.avgR)}`,
          ...verdict,
        ]
      : []),
    DISCLAIMER,
  ].join("\n");
}

export function walkForwardReport(r) {
  const n4 = (x) => (x == null ? "—" : x.toFixed(4));
  const n3 = (x) => (x == null ? "—" : x.toFixed(3));
  const cells = (...xs) => xs.map(([s, w]) => String(s).padStart(w)).join("");
  const chosen = r.variants.find((v) => v.name === r.chosen);
  const uniform = r.variants.find((v) => v.name === "uniform");
  return [
    `Walk-forward · decision ${r.decisionTime} → ${r.until} · lookback ${r.lookback} sessions · ${r.replays} replays · seed ${r.seed} · train ≤ ${r.trainEnd}`,
    `  ${"variant".padEnd(12)}${"split".padEnd(6)}${cells(["n", 4], ["Brier", 9], ["skill", 9], ["cov90", 8], ["meanP", 8], ["upRate", 8])}`,
    ...r.variants.flatMap((v) =>
      ["train", "test"].map((k) => `  ${v.name.padEnd(12)}${k.padEnd(6)}${cells([v[k].n, 4], [n4(v[k].brier), 9], [n4(v[k].skill), 9], [n3(v[k].coverage90), 8], [n3(v[k].meanP), 8], [n3(v[k].upRate), 8])}`),
    ),
    `Calibration of ${chosen.name} on test (p bucket: days, mean p, share that ended up):`,
    ...chosen.test.calibration.map((b) => `  ${(b.bucket / 10).toFixed(1)}–${((b.bucket + 1) / 10).toFixed(1)}${cells([b.n, 5], [n3(b.meanP), 8], [n3(b.upRate), 8])}`),
    `Chosen on train: ${r.chosen} · accepted: ${r.accepted ? "yes" : "no"}${uniform && chosen !== uniform ? ` (test Brier ${n4(chosen.test.brier)} vs uniform ${n4(uniform.test.brier)})` : ""}`,
    "Choose on train, judge on test. A variant that only wins on test is luck.",
  ].join("\n");
}
