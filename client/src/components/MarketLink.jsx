import { fmtPrice, fmtPct, fmtSignedPct } from "../format.js";

const pct = (x) => (x == null ? "—" : fmtPct(x * 100));

function Now({ now }) {
  if (!now) return <span className="muted">no data</span>;
  const cls = now.dir === 1 ? "up" : now.dir === -1 ? "down" : "muted";
  const word = now.dir === 1 ? "▲ UP" : now.dir === -1 ? "▼ DOWN" : "● MIXED";
  return (
    <span>
      <b className={cls}>{word}</b> {fmtPrice(now.price)} <span className={now.changePct >= 0 ? "up" : "down"}>{fmtSignedPct(now.changePct)}</span> · {now.aboveVwap ? "above" : "below"} VWAP{" "}
      <span className="muted">
        → {now.allows === "long" ? "only BUYS when trading with the index" : now.allows === "short" ? "only SELLS when trading with the index" : "no trades when trading with the index"}
      </span>
    </span>
  );
}

/**
 * Which index the share belongs to, how closely it follows it, and the index right now.
 * link: GET /api/market/index-link/:symbol
 */
export default function MarketLink({ link, error, symbol }) {
  if (error) return <section className="market-link small down">{error}</section>;
  if (!link) return null;
  return (
    <section className="market-link">
      <div className="ml-head">
        <h2>Index link</h2>
        <span className="small">
          {link.isIndex ? (
            <>{symbol} is an index — compared with NIFTY 50.</>
          ) : link.member.length ? (
            <>
              {symbol} is in <b>{link.member.map((m) => m.name).join(" · ")}</b>
              {link.sector ? (
                <>
                  {" "}
                  — its own sector index: <b>{link.sector.name}</b>
                </>
              ) : (
                " — no sector index, compared with NIFTY 50"
              )}
            </>
          ) : (
            <>{symbol} isn't in any index the app tracks — compared with NIFTY 50.</>
          )}
        </span>
      </div>
      <div className="ml-cards">
        {link.indices.map((ix) => {
          const d = ix.daily;
          const i = ix.intraday;
          return (
            <div key={ix.id} className="ml-card">
              <div className="ml-title">
                <b>{ix.name}</b> <span className="muted small">{ix.role === "sector" ? "own sector" : "whole market"}</span>
              </div>
              <div className="small">
                Now: <Now now={ix.now} />
              </div>
              {d?.corr != null && (
                <div className="small">
                  When {ix.name} <span className="down">fell</span>, {symbol} fell on <b>{pct(d.downWhenDown)}</b> of days; when it <span className="up">rose</span>, {symbol} rose on{" "}
                  <b>{pct(d.upWhenUp)}</b> <span className="muted">(last {d.n} days, same-day moves)</span>
                </div>
              )}
              <div className="small muted">
                Correlation {d?.corr != null ? d.corr.toFixed(2) : "—"} daily · {i?.corr != null ? i.corr.toFixed(2) : "—"} on 5-min bars · beta {d?.beta != null ? d.beta.toFixed(2) : "—"}
                {d?.beta != null && ` (moves ~${d.beta.toFixed(1)}% for each 1% of the index)`}
              </div>
            </div>
          );
        })}
      </div>
      <div className="small muted">
        These are moves on the <i>same day</i> — you only know them at the close. Whether the index's move <i>so far today</i> predicts this share's rest of day is tested in the Outlook ("Index direction"), and
        whether only trading with the index helps the strategies is shown in the scoreboard below.
      </div>
    </section>
  );
}
