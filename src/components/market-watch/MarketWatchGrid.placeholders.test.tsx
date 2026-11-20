import { render } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MARKET_WATCH_COLUMNS, DEFAULT_MARKET_WATCH_OPTIONS } from '../../utils/marketWatchView';
import { MarketWatchGrid } from './MarketWatchGrid';

const SYMBOLS = Array.from({ length: 40 }, (_, index) => `SYM${String(index).padStart(2, '0')}`);

const renderGrid = (fullRowSymbolSet: ReadonlySet<string> | null, selected = '') => {
  const rowRefs = new Map<string, HTMLTableRowElement | null>();
  const refCallbacks = new Map(SYMBOLS.map((symbol) => [
    symbol,
    (node: HTMLTableRowElement | null) => { rowRefs.set(symbol, node); },
  ] as const));
  const view = render(
    <MarketWatchGrid
      actionableSymbolSet={new Set(SYMBOLS)}
      chartOpenableSymbolSet={new Set(SYMBOLS)}
      closedDailyChanges={new Map()}
      columns={DEFAULT_MARKET_WATCH_COLUMNS}
      getContextMenuItems={() => []}
      isSymbolListLoading={false}
      lastPrices={new Map()}
      liveQuoteSymbolSet={new Set()}
      marketWatchOptions={DEFAULT_MARKET_WATCH_OPTIONS}
      fullRowSymbolSet={fullRowSymbolSet}
      marketWatchRowRefCallbacks={refCallbacks}
      marketWatchSelectionSymbol={selected}
      onContextSelect={() => {}}
      onShowAll={() => {}}
      onSymbolSelect={() => {}}
      quoteEligibleSymbols={SYMBOLS}
      rows={SYMBOLS}
      setMarketWatchViewportRef={() => {}}
      setSortMode={() => {}}
      sortMode="none"
      translate={(source) => source}
    />,
  );
  return { ...view, rowRefs };
};

describe('MarketWatchGrid placeholder rows', () => {
  beforeAll(() => {
    // jsdom has no ResizeObserver; the grid only uses it for responsive column widths.
    if (typeof globalThis.ResizeObserver === 'undefined') {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
  });

  it('draws every row in full when no visibility report exists yet', () => {
    const { container } = renderGrid(null);
    expect(container.querySelectorAll('tbody tr[data-rtx-market-watch-placeholder]')).toHaveLength(0);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(SYMBOLS.length);
  });

  it('draws only the visible band in full; other rows are same-height placeholders that keep their ref', () => {
    const drawn = new Set(SYMBOLS.slice(10, 20));
    const { container, rowRefs } = renderGrid(drawn, 'SYM35');
    const rows = Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody > tr'));
    // Row order and count are unchanged, so scroll height and positions stay the same.
    expect(rows).toHaveLength(SYMBOLS.length);
    const placeholders = rows.filter((row) => row.hasAttribute('data-rtx-market-watch-placeholder'));
    // 40 rows - 10 drawn - 1 selected (always drawn in full) = 29 placeholders.
    expect(placeholders).toHaveLength(29);
    placeholders.forEach((row) => {
      expect(row.style.height).toBe('20px');
      expect(row.getAttribute('aria-hidden')).toBe('true');
    });
    // Every row, placeholder or not, still hands its element to the ref callback
    // (visibility tracking and scrollIntoView depend on it).
    SYMBOLS.forEach((symbol) => expect(rowRefs.get(symbol)).toBeInstanceOf(HTMLTableRowElement));
    // The selected row is drawn in full even outside the visible band.
    expect(rowRefs.get('SYM35')?.hasAttribute('data-rtx-market-watch-placeholder')).toBe(false);
    expect(rowRefs.get('SYM15')?.hasAttribute('data-rtx-market-watch-placeholder')).toBe(false);
    expect(rowRefs.get('SYM00')?.hasAttribute('data-rtx-market-watch-placeholder')).toBe(true);
  });
});
