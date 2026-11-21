// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../store/useAppStore';
import { MarketWatchGrid } from './MarketWatchGrid';

describe('MarketWatchGrid Bid and Ask right alignment', () => {
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    useAppStore.getState().reset();
    useAppStore.setState({
      ticks: {
        EURUSD: { symbol: 'EURUSD', bid: 1.10234, ask: 1.10248, spread: 14, timestamp: Date.now(), digits: 5 },
      },
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().reset();
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('aligns Bid and Ask column headers right directly above right-aligned quote cells', () => {
    const { container } = render(
      <MarketWatchGrid
        actionableSymbolSet={new Set(['EURUSD'])}
        chartOpenableSymbolSet={new Set(['EURUSD'])}
        catalogPriceDigits={new Map([['EURUSD', 5]])}
        closedDailyChanges={new Map()}
        columns={['symbol', 'bid', 'ask', 'dailyChange']}
        getContextMenuItems={() => []}
        isSymbolListLoading={false}
        lastPrices={new Map()}
        liveQuoteSymbolSet={new Set(['EURUSD'])}
        marketWatchOptions={{
          showGrid: true,
          autoArrange: true,
          showMilliseconds: false,
          columns: {
            spread: false,
            highLow: false,
            time: false,
            last: false,
            volume: false,
            dailyChange: true,
            dailyChangePrice: false,
            source: false,
          },
        }}
        marketWatchRowRefCallbacks={new Map()}
        marketWatchSelectionSymbol="EURUSD"
        onContextSelect={vi.fn()}
        onShowAll={vi.fn()}
        onSymbolSelect={vi.fn()}
        quoteEligibleSymbols={['EURUSD']}
        rows={['EURUSD']}
        setMarketWatchViewportRef={vi.fn()}
        setSortMode={vi.fn()}
        sortMode="default"
        translate={(value) => value}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'Symbol' }).style.textAlign).toBe('left');
    expect(screen.getByRole('columnheader', { name: 'Bid' }).style.textAlign).toBe('right');
    expect(screen.getByRole('columnheader', { name: 'Ask' }).style.textAlign).toBe('right');

    const bidCell = container.querySelector('.rtx-market-watch__price--bid')?.closest('td') as HTMLTableCellElement | null;
    const askCell = container.querySelector('.rtx-market-watch__price--ask')?.closest('td') as HTMLTableCellElement | null;
    expect(bidCell?.style.textAlign).toBe('right');
    expect(askCell?.style.textAlign).toBe('right');

    const desktopCss = readFileSync(resolve(process.cwd(), 'src/components/market-watch/market-watch-desktop.css'), 'utf8');
    expect(desktopCss).toMatch(
      /\.rtx-market-watch__grid th:is\(\.rtx-market-watch__column-heading--bid, \.rtx-market-watch__column-heading--ask\)\s*\{[\s\S]*?text-align: right !important;/,
    );
  });
});
