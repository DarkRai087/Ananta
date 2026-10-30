// NSE trading holidays (cash market), fetched from NSE and cached in SQLite.
// Holidays NSE marks with "*" (Diwali Laxmi Pujan) host Muhurat trading → special session.
import db, { getMeta, setMeta } from "../db.js";
import { MARKET } from "../config/market.js";
import { registerSpecialDate } from "../lab/sessions.js";
import { NSE_UA as UA } from "./nse.js";

const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

function toIso(d) {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(d || "");
  return m ? `${m[3]}-${MONTHS[m[2]]}-${m[1]}` : null;
}

async function download() {
  // NSE's API needs the cookies its home page sets.
  const home = await fetch("https://www.nseindia.com/", { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
  const cookie = (home.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const res = await fetch("https://www.nseindia.com/api/holiday-master?type=trading", {
    headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.nseindia.com/resources/exchange-communication-holidays", Cookie: cookie },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`NSE holidays HTTP ${res.status}`);
  const json = await res.json();
  return (json.CM || [])
    .map((h) => ({ date: toIso(h.tradingDate), description: h.description || "", special: /\*|muhurat/i.test(h.description || "") ? 1 : 0 }))
    .filter((h) => h.date);
}

// Register special (Muhurat) dates from the DB so session building knows about them.
export function loadHolidays() {
  for (const h of db.prepare("SELECT date, description FROM holidays WHERE special = 1").all()) {
    registerSpecialDate(h.date, "Muhurat trading");
  }
}

export async function ensureHolidays() {
  loadHolidays(); // cached special dates now, not after the download
  const count = db.prepare("SELECT COUNT(*) AS n FROM holidays").get().n;
  const at = Number(getMeta("holidays_loaded_at") || 0);
  if (count > 0 && Date.now() - at < 7 * 86400_000) return;
  try {
    const rows = await download();
    const ins = db.prepare("INSERT OR REPLACE INTO holidays (date, description, special) VALUES (@date, @description, @special)");
    db.transaction(() => rows.forEach((r) => ins.run(r)))();
    setMeta("holidays_loaded_at", Date.now());
    console.log(`[holidays] ${rows.length} NSE holidays loaded`);
  } catch (err) {
    if (!count) {
      const ins = db.prepare("INSERT OR IGNORE INTO holidays (date, description, special) VALUES (?, 'Holiday (fallback list)', 0)");
      for (const d of MARKET.fallbackHolidays) ins.run(d);
    }
    console.warn(`[holidays] NSE download failed (${err.message}); using ${count ? "cached" : "fallback"} list`);
  }
  loadHolidays();
}

// Regular holidays (no session), oldest first.
export const holidayDates = () => db.prepare("SELECT date FROM holidays WHERE special = 0 ORDER BY date").all().map((r) => r.date);

export function isHoliday(date) {
  return Boolean(db.prepare("SELECT 1 FROM holidays WHERE date = ? AND special = 0").get(date));
}

// Regular trading day: Mon–Fri and not a holiday.
export function isTradingDay(date) {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return wd >= 1 && wd <= 5 && !isHoliday(date);
}
