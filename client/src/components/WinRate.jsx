import { fmtPct } from "../format.js";

// A win = a trade that made money after all charges, whatever the exit (server: backtest/metrics.js).
const EXITS = [
  ["target", "target"],
  ["stop", "stop"],
  ["trail", "trailing stop"],
  ["signal", "exit signal"],
  ["forced", "15:15"],
];

// "target 31.2% · stop 52.0% · 15:15 16.8%"
export function exitsText(exits) {
  if (!exits) return "";
  return EXITS.filter(([k]) => exits[k] > 0)
    .map(([k, label]) => `${label} ${fmtPct(exits[k], 1)}`)
    .join(" · ");
}

export function winTitle(m) {
  if (!m?.trades) return "";
  return [
    `Won ${m.wins} of ${m.trades} trades = ${fmtPct(m.winPct, 1)} (made money after all charges, any exit).`,
    m.winLow != null && `Likely true win rate (95% range): ${fmtPct(m.winLow, 1)} – ${fmtPct(m.winHigh, 1)}. Fewer trades = wider range.`,
    m.breakEvenWinPct != null && `Needed to break even with its average win and loss: ${fmtPct(m.breakEvenWinPct, 1)}.`,
    m.exits && `How trades ended: ${exitsText(m.exits)}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Win % with how precise it is: wins / trades, the likely range, and the win % needed to break
 * even. Green when it wins more often than it needs to, red when less.
 */
export default function WinRate({ m, detail = true }) {
  if (!m?.trades) return <span className="muted">—</span>;
  const ok = m.breakEvenWinPct != null ? m.winPct >= m.breakEvenWinPct : null;
  return (
    <span className="winrate" title={winTitle(m)}>
      <b className={ok == null ? "" : ok ? "up" : "down"}>{fmtPct(m.winPct, 1)}</b> win{" "}
      <span className="muted">
        ({m.wins}/{m.trades})
      </span>
      {detail && (
        <span className="muted wr-detail">
          likely {fmtPct(m.winLow, 0)}–{fmtPct(m.winHigh, 0)} · need {fmtPct(m.breakEvenWinPct, 1)}
        </span>
      )}
    </span>
  );
}
