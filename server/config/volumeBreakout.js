// Volume Breakout v2 config. The symbol-level lists are applied where symbols are CHOSEN (the
// report/audit scripts and the Lab universe), not inside onBar — a strategy never sees its symbol.
//
// Live ASM/GSM lists and circuit bands aren't cleanly free, so this is a hand-maintained exclude
// set (PHASE 1 decision). disabledCombos switches off "SYMBOL|LEVELTYPE" pairs that proved
// net-negative out-of-sample (PHASE 2 §8); the report script reads it.
export const VOLUME_BREAKOUT = {
  excludeSymbols: [], // ASM/GSM / near-circuit names to skip entirely
  disabledCombos: [], // e.g. "SBIN|VWAP" — stock×level-type combos to drop (negative OOS expectancy)
};

export const isExcluded = (symbol) => VOLUME_BREAKOUT.excludeSymbols.includes(String(symbol).toUpperCase());
export const isDisabledCombo = (symbol, levelType) => VOLUME_BREAKOUT.disabledCombos.includes(`${String(symbol).toUpperCase()}|${levelType}`);
