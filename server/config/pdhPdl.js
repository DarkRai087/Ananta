// PDH/PDL v2 config. Symbol-level lists are applied where symbols are CHOSEN (report/audit
// scripts, Lab universe), not inside onBar. Special/short reference days are already skipped by
// buildSessions via config/market.js specialSessions; add any extra short-session dates here if a
// provider mislabels one. Corporate-action adjustment: Yahoo is split/bonus adjusted; SmartAPI is
// not (documented limitation) — exclude a symbol around its split/bonus date here if needed.
export const PDH_PDL = {
  excludeSymbols: [], // ASM/GSM / near-circuit / known corporate-action dates to skip
  disabledCombos: [], // "SYMBOL|OPENTYPE" pairs (e.g. "SBIN|GAP_UP") with negative OOS expectancy
};

export const isExcluded = (symbol) => PDH_PDL.excludeSymbols.includes(String(symbol).toUpperCase());
export const isDisabledCombo = (symbol, openType) => PDH_PDL.disabledCombos.includes(`${String(symbol).toUpperCase()}|${openType}`);
