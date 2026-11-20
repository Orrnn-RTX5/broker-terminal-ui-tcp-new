import { fireEvent, render } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MARKET_WATCH_COLUMNS, DEFAULT_MARKET_WATCH_OPTIONS } from '../../utils/marketWatchView';

// Row renders call useUiTranslation exactly once per render, so this counts row renders.
const rowRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../hooks/useUiTranslation', () => ({
  useUiTranslation: () => {
    rowRenders.count += 1;
    return (source: string) => source;
  },
}));

import { MarketWatchGrid } from './MarketWatchGrid';

const SYMBOLS = ['AAA', 'BBB', 'CCC'];
const ACTIONABLE = new Set(['AAA', 'CCC']);
const CHART_OPENABLE = new Set(SYMBOLS);
const CLOSED_DAILY = new Map<string, number>();
const LAST_PRICES = new Map();
const LIVE = new Set<string>();
const CATALOG_DIGITS = new Map<string, number>();
const REF_CALLBACKS = new Map(SYMBOLS.map((symbol) => [symbol, () => {}] as const));

describe('MarketWatchGrid row memoization', () => {
  beforeAll(() => {
    if (typeof globalThis.ResizeObserver === 'undefined') {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
  });

  beforeEach(() => {
    rowRenders.count = 0;
  });

  // Fresh handler closures on every call, like a parent that does not memoize them.
  const buildGrid = (handlers: {
    getContextMenuItems: (symbol: string) => never[];
    onContextSelect: (symbol: string) => void;
    onSymbolSelect: (symbol: string) => void;
  }, selection = '') => (
    <MarketWatchGrid
      actionableSymbolSet={ACTIONABLE}
      chartOpenableSymbolSet={CHART_OPENABLE}
      catalogPriceDigits={CATALOG_DIGITS}
      closedDailyChanges={CLOSED_DAILY}
      columns={DEFAULT_MARKET_WATCH_COLUMNS}
      getContextMenuItems={(symbol) => handlers.getContextMenuItems(symbol)}
      isSymbolListLoading={false}
      lastPrices={LAST_PRICES}
      liveQuoteSymbolSet={LIVE}
      marketWatchOptions={DEFAULT_MARKET_WATCH_OPTIONS}
      marketWatchRowRefCallbacks={REF_CALLBACKS}
      marketWatchSelectionSymbol={selection}
      onContextSelect={(symbol) => handlers.onContextSelect(symbol)}
      onShowAll={() => {}}
      onSymbolSelect={(symbol) => handlers.onSymbolSelect(symbol)}
      quoteEligibleSymbols={SYMBOLS}
      rows={SYMBOLS}
      setMarketWatchViewportRef={() => {}}
      setSortMode={() => {}}
      sortMode="none"
      translate={(source) => source}
    />
  );

  const makeHandlers = () => ({
    getContextMenuItems: vi.fn((_symbol: string): never[] => []),
    onContextSelect: vi.fn(),
    onSymbolSelect: vi.fn(),
  });

  it('does not re-render unchanged rows when the grid re-renders with new closures', () => {
    const handlers = makeHandlers();
    const { rerender } = render(buildGrid(handlers));
    expect(rowRenders.count).toBeGreaterThanOrEqual(SYMBOLS.length);
    const afterMount = rowRenders.count;

    rerender(buildGrid(handlers));
    rerender(buildGrid(handlers));
    expect(rowRenders.count).toBe(afterMount);
  });

  it('re-renders only the rows whose own props change (selection moves between two rows)', () => {
    const handlers = makeHandlers();
    const { rerender } = render(buildGrid(handlers, 'AAA'));
    const afterMount = rowRenders.count;

    rerender(buildGrid(handlers, 'BBB'));
    // AAA loses selection, BBB gains it; CCC is untouched.
    expect(rowRenders.count - afterMount).toBe(2);
  });

  it('builds context menu items only when a row context menu opens', () => {
    const handlers = makeHandlers();
    const { container } = render(buildGrid(handlers));
    expect(handlers.getContextMenuItems).not.toHaveBeenCalled();

    const rows = container.querySelectorAll<HTMLTableRowElement>('tbody > tr');
    fireEvent.contextMenu(rows[1]);
    expect(handlers.getContextMenuItems).toHaveBeenCalledTimes(1);
    expect(handlers.getContextMenuItems).toHaveBeenCalledWith('BBB');
    expect(handlers.onContextSelect).toHaveBeenCalledTimes(1);
    expect(handlers.onContextSelect).toHaveBeenCalledWith('BBB');
  });

  it('click, context and double-click call the handlers with the row symbol', () => {
    const handlers = makeHandlers();
    const opened: string[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent<{ symbol: string }>).detail.symbol);
    window.addEventListener('openOrderDialog', listener);
    try {
      const { container, rerender } = render(buildGrid(handlers));
      // Handlers must read the latest props, not the ones from the first render.
      const next = makeHandlers();
      rerender(buildGrid(next));
      const rows = container.querySelectorAll<HTMLTableRowElement>('tbody > tr');

      fireEvent.click(rows[2]);
      expect(next.onSymbolSelect).toHaveBeenCalledWith('CCC');
      expect(handlers.onSymbolSelect).not.toHaveBeenCalled();

      fireEvent.contextMenu(rows[0]);
      expect(next.onContextSelect).toHaveBeenCalledWith('AAA');

      // Actionable symbol opens the order dialog; non-actionable (BBB) does not.
      fireEvent.doubleClick(rows[0]);
      fireEvent.doubleClick(rows[1]);
      expect(opened).toEqual(['AAA']);
    } finally {
      window.removeEventListener('openOrderDialog', listener);
    }
  });
});
