// Indices the app knows: live/intraday feed (Angel One token), daily history (Yahoo ticker)
// and the NSE constituents list. To add one: one line here (token from Angel One's scrip
// master, instrumenttype AMXIDX). `kind: "sector"` makes it a candidate "own index" for its
// member stocks; the first sector index (in this order) a stock belongs to is its sector.
const NSE = "https://nsearchives.nseindia.com/content/indices/";

export const INDICES = {
  NIFTY50: { name: "NIFTY 50", kind: "market", smartapi: "99926000", yahoo: "^NSEI", members: `${NSE}ind_nifty50list.csv` },
  BANKNIFTY: { name: "NIFTY BANK", kind: "sector", smartapi: "99926009", yahoo: "^NSEBANK", members: `${NSE}ind_niftybanklist.csv` },
  NIFTYPSUBANK: { name: "NIFTY PSU BANK", kind: "sector", smartapi: "99926025", yahoo: "^CNXPSUBANK", members: `${NSE}ind_niftypsubanklist.csv` },
  NIFTYIT: { name: "NIFTY IT", kind: "sector", smartapi: "99926008", yahoo: "^CNXIT", members: `${NSE}ind_niftyitlist.csv` },
  NIFTYAUTO: { name: "NIFTY AUTO", kind: "sector", smartapi: "99926029", yahoo: "^CNXAUTO", members: `${NSE}ind_niftyautolist.csv` },
  NIFTYPHARMA: { name: "NIFTY PHARMA", kind: "sector", smartapi: "99926023", yahoo: "^CNXPHARMA", members: `${NSE}ind_niftypharmalist.csv` },
  NIFTYFMCG: { name: "NIFTY FMCG", kind: "sector", smartapi: "99926021", yahoo: "^CNXFMCG", members: `${NSE}ind_niftyfmcglist.csv` },
  NIFTYMETAL: { name: "NIFTY METAL", kind: "sector", smartapi: "99926030", yahoo: "^CNXMETAL", members: `${NSE}ind_niftymetallist.csv` },
  NIFTYENERGY: { name: "NIFTY ENERGY", kind: "sector", smartapi: "99926020", yahoo: "^CNXENERGY", members: `${NSE}ind_niftyenergylist.csv` },
  NIFTYREALTY: { name: "NIFTY REALTY", kind: "sector", smartapi: "99926018", yahoo: "^CNXREALTY", members: `${NSE}ind_niftyrealtylist.csv` },
  // Financial services overlaps heavily with banks; listed after them so banks get NIFTY BANK.
  FINNIFTY: { name: "NIFTY FIN SERVICE", kind: "sector", smartapi: "99926037", yahoo: "NIFTY_FIN_SERVICE.NS", members: `${NSE}ind_niftyfinancelist.csv` },
};

export const MARKET_INDEX = "NIFTY50";
export const isIndexSymbol = (s) => Object.prototype.hasOwnProperty.call(INDICES, String(s || "").toUpperCase());

// "Trade with the index" rules. The index's direction at a bar (known at that bar's close):
//   vwap       up = index above its session VWAP, down = below
//   dayChange  up = index above yesterday's close, down = below
//   both       up only when both say up, down only when both say down (else: no trades)
export const INDEX_FILTER = {
  rule: "both",
};
