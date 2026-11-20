import { describe, expect, it } from 'vitest';

import { sortMarketWatchSymbols } from './marketWatchView';

type Row = { dailyChange?: unknown; volume?: unknown; dailyChangePrice?: unknown };

// Verbatim copy of the pre-optimisation comparator (per-comparison resolution).
const readSortableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const legacySort = (
  symbols: readonly string[],
  mode: string,
  getTick: (symbol: string) => Row | undefined,
): string[] => {
  const originalOrder = new Map(symbols.map((symbol, index) => [symbol, index] as const));
  const stableFallback = (l: string, r: string) => (originalOrder.get(l) ?? 0) - (originalOrder.get(r) ?? 0);
  return [...symbols].sort((left, right) => {
    const field = mode === 'volume' ? 'volume' : mode === 'change-asc' || mode === 'change-desc' ? 'dailyChangePrice' : 'dailyChange';
    const lv = readSortableNumber(getTick(left)?.[field]);
    const rv = readSortableNumber(getTick(right)?.[field]);
    if (lv === null && rv !== null) return 1;
    if (lv !== null && rv === null) return -1;
    if (lv !== null && rv !== null && lv !== rv) {
      return mode === 'losers' || mode === 'change-asc' ? lv - rv : rv - lv;
    }
    return stableFallback(left, right);
  });
};

describe('sortMarketWatchSymbols numeric modes keep the legacy order', () => {
  const modes = ['gainers', 'losers', 'change-asc', 'change-desc', 'volume'] as const;
  const oddValues: unknown[] = [undefined, null, '', '  ', 'abc', NaN, Infinity, -Infinity, true, 0, -0, '5', ' 7 ', 3, 3, -3, 1e308, -1e308];

  it('gives identical order on randomized data with ties, duplicates and missing values', () => {
    let seed = 987654321;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let round = 0; round < 300; round += 1) {
      const size = Math.floor(rnd() * 60);
      const symbols = Array.from({ length: size }, () => `S${Math.floor(rnd() * 45)}`); // duplicates likely
      const table = new Map<string, Row>();
      symbols.forEach((symbol) => {
        const pick = () => (rnd() < 0.5 ? oddValues[Math.floor(rnd() * oddValues.length)] : Math.floor(rnd() * 7) - 3);
        if (rnd() < 0.15) return; // no tick at all
        table.set(symbol, { dailyChange: pick(), volume: pick(), dailyChangePrice: pick() });
      });
      const getTick = (symbol: string) => table.get(symbol);
      modes.forEach((mode) => {
        expect(sortMarketWatchSymbols(symbols, mode, getTick, new Map())).toEqual(legacySort(symbols, mode, getTick));
      });
    }
  });

  it('calls getTick once per symbol per pass and does not mutate the input', () => {
    const symbols = ['A', 'B', 'C', 'D'];
    let calls = 0;
    const result = sortMarketWatchSymbols(symbols, 'gainers', (s) => { calls += 1; return { dailyChange: s === 'C' ? 2 : 1 }; }, new Map());
    expect(calls).toBe(symbols.length);
    expect(result).toEqual(['C', 'A', 'B', 'D']);
    expect(symbols).toEqual(['A', 'B', 'C', 'D']);
  });
});
