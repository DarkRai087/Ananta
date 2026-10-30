// NSE downloads. NSE rejects requests without a browser-like User-Agent.
export const NSE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// One CSV line → trimmed fields (quoted fields may hold commas and "" quotes).
export function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

// An NSE archives CSV → [{ HEADER: value }], headers upper-cased.
export async function fetchNseCsv(url) {
  const res = await fetch(url, { headers: { "User-Agent": NSE_UA, Accept: "text/csv,*/*" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`NSE returned HTTP ${res.status}`);
  const [head = "", ...lines] = (await res.text()).split(/\r?\n/).filter(Boolean);
  const keys = parseCsvLine(head).map((h) => h.toUpperCase());
  return lines.map((l) => Object.fromEntries(parseCsvLine(l).map((v, k) => [keys[k], v])));
}
