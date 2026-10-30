// IST time helpers. All candle times are unix seconds (UTC); IST = UTC + 5:30, no DST.
import { MARKET } from "../config/market.js";

const OFF = MARKET.istOffsetSec;

export const hhmmToMin = (s) => {
  const [h, m] = String(s).split(":").map(Number);
  return h * 60 + m;
};

export const minToHHMM = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// "YYYY-MM-DD" of the IST calendar day.
export const istDate = (t) => new Date((t + OFF) * 1000).toISOString().slice(0, 10);

// Minutes since IST midnight.
export const istMinute = (t) => Math.floor((((t + OFF) % 86400) + 86400) % 86400 / 60);

export const istHHMM = (t) => minToHHMM(istMinute(t));

// Unix seconds for an IST date + time.
export const istEpoch = (date, hhmm = "00:00") => Date.parse(`${date}T${hhmm}:00Z`) / 1000 - OFF;

export function istNow(nowMs = Date.now()) {
  const t = Math.floor(nowMs / 1000);
  return { t, date: istDate(t), minute: istMinute(t), weekday: new Date((t + OFF) * 1000).getUTCDay() };
}

export const OPEN_MIN = hhmmToMin(MARKET.open);
export const CLOSE_MIN = hhmmToMin(MARKET.close);
export const SQUARE_OFF_MIN = hhmmToMin(MARKET.squareOff);
export const FWD_CAP_MIN = hhmmToMin(MARKET.forwardReturnCap);

const BUCKETS = MARKET.timeBuckets.map((b) => ({ ...b, s: hhmmToMin(b.start), e: hhmmToMin(b.end) }));

// Which time-of-day bucket a minute falls in (null after 15:15 or before 9:15).
export function timeBucket(minute) {
  for (const b of BUCKETS) if (minute >= b.s && minute < b.e) return b.id;
  return null;
}

export const TIME_BUCKETS = MARKET.timeBuckets;
