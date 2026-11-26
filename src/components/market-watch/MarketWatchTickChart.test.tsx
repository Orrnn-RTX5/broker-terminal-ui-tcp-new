// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../store/useAppStore';
import { useChartSettingsStore } from '../../store/useChartSettingsStore';
import { type Tick, useMarketDataStore } from '../../store/useMarketDataStore';
import { MarketWatchTickChart } from './MarketWatchTickChart';
import { MARKET_WATCH_TICK_CHART_LIMIT } from './tickChartGeometry';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ apiClient: { get: apiGet } }));

const setTickBuffer = (symbol: string, tickBuffer: Tick[]) => {
  useMarketDataStore.setState({
    symbolData: {
      [symbol]: {
        currentTick: tickBuffer.at(-1) ?? null,
        previousTick: tickBuffer.at(-2) ?? null,
        stats: null,
        ohlcv1m: [],
        ohlcv5m: [],
        ohlcv15m: [],
        ohlcv1h: [],
        tickBuffer,
        lastAggregation: 0,
      },
    },
  });
};

const tagLabel = (side: 'bid' | 'ask'): string | null | undefined => (
  screen.getByTestId(`market-tick-${side}-tag`).querySelector('text')?.textContent
);

describe('MarketWatchTickChart', () => {
  beforeEach(() => {
    localStorage.clear();
    apiGet.mockReset();
    apiGet.mockResolvedValue([]);
    useMarketDataStore.getState().clearAllData();
    useAppStore.getState().setTicks({});
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    useMarketDataStore.getState().clearAllData();
    useAppStore.getState().setTicks({});
    useChartSettingsStore.getState().resetToDefaults();
    useChartSettingsStore.setState({ symbolProperties: {}, activeColorSymbol: null });
    document.documentElement.classList.remove('rtx-advanced-view', 'rtx-skin-untitled-light', 'theme-light');
    document.documentElement.removeAttribute('data-rtx-theme-configured');
    document.documentElement.removeAttribute('data-rtx-theme-preset');
    document.documentElement.style.removeProperty('--rtx-theme-chart-bg');
    document.documentElement.style.removeProperty('--rtx-theme-chart-fg');
    document.documentElement.style.removeProperty('--rtx-theme-chart-grid');
  });

  it('shows an accessible empty state until the broker publishes ticks', () => {
    render(<MarketWatchTickChart symbol="EURUSD" />);

    expect(screen.getByRole('region', { name: 'EURUSD' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for live ticks');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('draws MT5 step lines for the newest ticks that fit the chart width', () => {
    const tickBuffer = Array.from({ length: MARKET_WATCH_TICK_CHART_LIMIT + 5 }, (_, index): Tick => ({
      symbol: 'EURUSD',
      bid: 1.1 + index / 100_000,
      ask: 1.1002 + index / 100_000,
      spread: 0.0002,
      timestamp: 1_700_000_000_000 + index * 25,
    }));
    setTickBuffer('EURUSD', tickBuffer);

    const { container } = render(
      <MarketWatchTickChart symbol="eurusd" instrumentSources={[{ symbol: 'EURUSD', digits: 5 }]} />,
    );
    const chart = container.querySelector('svg[data-tick-count]');
    const visibleCount = Number(chart?.getAttribute('data-tick-count'));

    expect(visibleCount).toBeGreaterThan(1);
    expect(visibleCount).toBeLessThan(MARKET_WATCH_TICK_CHART_LIMIT);
    expect(screen.getByTestId('market-tick-bid-line')).toHaveAttribute('d', expect.stringMatching(/^M[\d.]+ [\d.]+(H[\d.]+V[\d.]+)+H[\d.]+$/));
    expect(screen.getByTestId('market-tick-ask-line')).toHaveAttribute('d', expect.stringMatching(/^M[\d.]+ [\d.]+(H[\d.]+V[\d.]+)+H[\d.]+$/));
    expect(tagLabel('bid')).toBe('1.12004');
    expect(tagLabel('ask')).toBe('1.12024');
    expect(screen.getByRole('img', { name: new RegExp(`EURUSD live tick chart with ${visibleCount} recent broker quotes`) }))
      .toBeInTheDocument();
    expect(container.querySelector('.rtx-market-tick-chart__symbol')).toHaveTextContent('EURUSD');
    expect(container.querySelector('.rtx-market-tick-chart__axis')?.textContent).toMatch(/2023\.11\.14/);
  });

  it('formats prices with the backend digits, or as sent when the backend has none', () => {
    setTickBuffer('COCOA', [{
      symbol: 'COCOA',
      bid: 321.25,
      ask: 321.5,
      spread: 0.25,
      timestamp: 1_700_000_000_999,
      sourceTimestamp: 1_700_000_000_042,
    }]);

    const { rerender } = render(
      <MarketWatchTickChart symbol="COCOA" instrumentSources={[{ symbol: 'COCOA', digits: 2 }]} />,
    );
    expect(tagLabel('bid')).toBe('321.25');
    expect(tagLabel('ask')).toBe('321.50');

    rerender(<MarketWatchTickChart symbol="COCOA" instrumentSources={[{ symbol: 'COCOA' }]} />);
    expect(tagLabel('ask')).toBe('321.5');
  });

  it('re-renders when live ticks are appended in place to the store buffer', () => {
    const base = 1_800_000_000_000;
    const send = (index: number) => useMarketDataStore.getState().updateTick('EURUSD', {
      symbol: 'EURUSD',
      bid: 1.1 + index / 10_000,
      ask: 1.1002 + index / 10_000,
      spread: 0.0002,
      timestamp: base + index * 25,
    }, { syncAppStore: false });
    act(() => { send(0); send(1); });

    const { container } = render(
      <MarketWatchTickChart symbol="EURUSD" instrumentSources={[{ symbol: 'EURUSD', digits: 5 }]} />,
    );
    const count = () => Number(container.querySelector('svg[data-tick-count]')?.getAttribute('data-tick-count'));
    const bufferRef = useMarketDataStore.getState().symbolData.EURUSD.tickBuffer;
    expect(count()).toBe(2);

    act(() => { send(2); send(3); send(4); });

    expect(useMarketDataStore.getState().symbolData.EURUSD.tickBuffer).toBe(bufferRef);
    expect(count()).toBe(5);
  });

  it('ignores non-price rows instead of inventing chart values', () => {
    setTickBuffer('XAUUSD', [{
      symbol: 'XAUUSD',
      bid: 0,
      ask: Number.NaN,
      spread: 0,
      timestamp: Date.now(),
    }]);

    render(<MarketWatchTickChart symbol="XAUUSD" />);

    expect(screen.getByRole('status')).toHaveTextContent('Waiting for live ticks');
    expect(screen.queryByTestId('market-tick-bid-line')).not.toBeInTheDocument();
  });

  it('puts backend tick history before the live ticks of this session', async () => {
    apiGet.mockResolvedValue([
      { symbol: 'XAUUSD', bid: 4126.2, ask: 4126.6, time: 1_790_000_000 },
      { symbol: 'XAUUSD', bid: 4126.3, ask: 4126.7, time: 1_790_000_001 },
      // Overlaps the live buffer, which stays authoritative.
      { symbol: 'XAUUSD', bid: 9999, ask: 9999.4, time: 1_790_000_005 },
    ]);
    setTickBuffer('XAUUSD', [{
      symbol: 'XAUUSD',
      bid: 4127.43,
      ask: 4127.82,
      spread: 0.39,
      timestamp: 1_790_000_002_000,
    }]);

    const { container } = render(
      <MarketWatchTickChart
        symbol="XAUUSD"
        historyScopeKey="authenticated|1|broker|https://broker.test"
        instrumentSources={[{ symbol: 'XAUUSD', digits: 2 }]}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(apiGet).toHaveBeenCalledWith('/ticks/XAUUSD', expect.objectContaining({
      params: { limit: MARKET_WATCH_TICK_CHART_LIMIT },
      signal: expect.any(AbortSignal),
    }));
    expect(container.querySelector('svg[data-tick-count]')).toHaveAttribute('data-tick-count', '3');
    expect(tagLabel('bid')).toBe('4127.43');
    expect(tagLabel('ask')).toBe('4127.82');
    expect(container.querySelector('.rtx-market-tick-chart__axis')?.textContent).not.toMatch(/9999/);
  });

  it('renders MT5 crosshair lines, Bid / Ask quote pill, and axis tags on hover', () => {
    setTickBuffer('EURUSD', [
      {
        symbol: 'EURUSD',
        bid: 1.11915,
        ask: 1.11916,
        spread: 0.00001,
        timestamp: Date.UTC(2026, 9, 14, 13, 12, 20),
      },
      {
        symbol: 'EURUSD',
        bid: 1.11920,
        ask: 1.11921,
        spread: 0.00001,
        timestamp: Date.UTC(2026, 9, 14, 13, 12, 21),
      },
      {
        symbol: 'EURUSD',
        bid: 1.11925,
        ask: 1.11927,
        spread: 0.00002,
        timestamp: Date.UTC(2026, 9, 14, 13, 12, 22),
      },
    ]);

    const { container } = render(
      <MarketWatchTickChart symbol="EURUSD" instrumentSources={[{ symbol: 'EURUSD', digits: 5 }]} />,
    );
    const svg = container.querySelector('svg[data-tick-count]')!;
    expect(svg).toHaveAttribute('data-cursor', 'default');
    expect(screen.queryByTestId('market-tick-crosshair')).not.toBeInTheDocument();

    fireEvent.mouseMove(svg, { clientX: 120, clientY: 110 });
    expect(svg).toHaveAttribute('data-cursor', 'crosshair');
    expect(screen.getByTestId('market-tick-crosshair')).toBeInTheDocument();
    expect(screen.getByTestId('market-tick-crosshair-x')).toBeInTheDocument();
    expect(screen.getByTestId('market-tick-crosshair-y')).toBeInTheDocument();
    expect(screen.getByTestId('market-tick-crosshair-pill').textContent).toBe('1.11920 / 1.11921');
    expect(screen.getByTestId('market-tick-crosshair-price-tag').textContent).toMatch(/^1\.119\d\d$/);
    expect(screen.getByTestId('market-tick-crosshair-time-tag').textContent).toMatch(/^2026\.10\.14 \d{2}:\d{2}:21$/);

    // Moving onto the right price scale or bottom time scale clears crosshair and resets cursor to default
    fireEvent.mouseMove(svg, { clientX: 310, clientY: 110 });
    expect(svg).toHaveAttribute('data-cursor', 'default');
    expect(screen.queryByTestId('market-tick-crosshair')).not.toBeInTheDocument();

    fireEvent.mouseMove(svg, { clientX: 120, clientY: 110 });
    expect(svg).toHaveAttribute('data-cursor', 'crosshair');
    expect(screen.getByTestId('market-tick-crosshair')).toBeInTheDocument();

    fireEvent.mouseMove(svg, { clientX: 120, clientY: 235 });
    expect(svg).toHaveAttribute('data-cursor', 'default');
    expect(screen.queryByTestId('market-tick-crosshair')).not.toBeInTheDocument();

    fireEvent.mouseMove(svg, { clientX: 120, clientY: 110 });
    expect(svg).toHaveAttribute('data-cursor', 'crosshair');
    fireEvent.mouseLeave(screen.getByTestId('market-tick-plot'));
    expect(svg).toHaveAttribute('data-cursor', 'default');
    expect(screen.queryByTestId('market-tick-crosshair')).not.toBeInTheDocument();
  });

  it('opens the MT5 right-click context menu and executes New Order, Chart Window, and chart toggles', () => {
    const initialTicks: Tick[] = [
      {
        symbol: 'EURUSD',
        bid: 1.11915,
        ask: 1.11916,
        last: 1.11915,
        spread: 0.00001,
        timestamp: Date.UTC(2026, 9, 14, 13, 12, 20),
      },
      {
        symbol: 'EURUSD',
        bid: 1.11920,
        ask: 1.11921,
        last: 1.11920,
        spread: 0.00001,
        timestamp: Date.UTC(2026, 9, 14, 13, 12, 21),
      },
    ];
    setTickBuffer('EURUSD', initialTicks);

    const orderListener = vi.fn();
    const chartListener = vi.fn();
    window.addEventListener('openOrderDialog', orderListener);
    window.addEventListener('openChart', chartListener);

    try {
      const { container } = render(
        <MarketWatchTickChart symbol="EURUSD" instrumentSources={[{ symbol: 'EURUSD', digits: 5 }]} />,
      );
      const svg = container.querySelector('svg[data-tick-count]')!;

      fireEvent.contextMenu(svg, { clientX: 80, clientY: 80 });
      const menu = screen.getByRole('menu');
      expect(menu).toHaveTextContent('Pending Order');
      expect(menu).toHaveTextContent('Chart Window');
      expect(menu).toHaveTextContent('Auto Scroll');
      expect(menu).toHaveTextContent('Crosshair');
      expect(menu).toHaveTextContent('Bid Line');
      expect(menu).toHaveTextContent('Ask Line');
      expect(menu).toHaveTextContent('Last Line');
      expect(menu).toHaveTextContent('Grid');

      fireEvent.click(screen.getByRole('menuitem', { name: /Pending Order/i }));
      expect(orderListener).toHaveBeenCalledTimes(1);
      expect((orderListener.mock.calls[0][0] as CustomEvent).detail).toEqual({ symbol: 'EURUSD' });

      fireEvent.contextMenu(svg, { clientX: 80, clientY: 80 });
      fireEvent.click(screen.getByRole('menuitem', { name: /Chart Window/i }));
      expect(chartListener).toHaveBeenCalledTimes(1);
      expect((chartListener.mock.calls[0][0] as CustomEvent).detail).toEqual({ symbol: 'EURUSD', newWindow: true });

      // Bid Line toggle
      expect(screen.getByTestId('market-tick-bid-line')).toBeInTheDocument();
      expect(screen.getByTestId('market-tick-bid-tag')).toBeInTheDocument();
      fireEvent.contextMenu(svg, { clientX: 80, clientY: 80 });
      fireEvent.click(screen.getByRole('menuitem', { name: /Bid Line/i }));
      expect(screen.queryByTestId('market-tick-bid-line')).not.toBeInTheDocument();
      expect(screen.queryByTestId('market-tick-bid-tag')).not.toBeInTheDocument();

      // Ask Line toggle via shortcut 'A'
      expect(screen.getByTestId('market-tick-ask-line')).toBeInTheDocument();
      fireEvent.keyDown(svg, { key: 'a' });
      expect(screen.queryByTestId('market-tick-ask-line')).not.toBeInTheDocument();
      expect(screen.queryByTestId('market-tick-ask-tag')).not.toBeInTheDocument();

      // Re-enable Bid and Ask via shortcuts 'B' and 'A'
      fireEvent.keyDown(svg, { key: 'b' });
      fireEvent.keyDown(svg, { key: 'a' });
      expect(screen.getByTestId('market-tick-bid-line')).toBeInTheDocument();
      expect(screen.getByTestId('market-tick-ask-line')).toBeInTheDocument();

      // Last Line toggle via context menu
      expect(screen.getByTestId('market-tick-last-line')).toBeInTheDocument();
      expect(screen.getByTestId('market-tick-last-tag')).toBeInTheDocument();
      fireEvent.contextMenu(svg, { clientX: 80, clientY: 80 });
      fireEvent.click(screen.getByRole('menuitem', { name: /Last Line/i }));
      expect(screen.queryByTestId('market-tick-last-line')).not.toBeInTheDocument();
      expect(screen.queryByTestId('market-tick-last-tag')).not.toBeInTheDocument();

      // Grid toggle via context menu
      expect(screen.getByTestId('market-tick-grid')).toBeInTheDocument();
      fireEvent.contextMenu(svg, { clientX: 80, clientY: 80 });
      fireEvent.click(screen.getByRole('menuitem', { name: /Grid/i }));
      expect(screen.queryByTestId('market-tick-grid')).not.toBeInTheDocument();

      // Crosshair toggle via context menu
      fireEvent.mouseMove(svg, { clientX: 120, clientY: 110 });
      expect(screen.getByTestId('market-tick-crosshair')).toBeInTheDocument();
      fireEvent.contextMenu(svg, { clientX: 80, clientY: 80 });
      fireEvent.click(screen.getByRole('menuitem', { name: /Crosshair/i }));
      expect(screen.queryByTestId('market-tick-crosshair')).not.toBeInTheDocument();

      // Auto Scroll toggle freezes incoming ticks until re-enabled
      expect(tagLabel('bid')).toBe('1.11920');
      fireEvent.contextMenu(svg, { clientX: 80, clientY: 80 });
      fireEvent.click(screen.getByRole('menuitem', { name: /Auto Scroll/i }));
      act(() => {
        setTickBuffer('EURUSD', [
          ...initialTicks,
          {
            symbol: 'EURUSD',
            bid: 1.12500,
            ask: 1.12502,
            last: 1.12500,
            spread: 0.00002,
            timestamp: Date.UTC(2026, 9, 14, 13, 12, 25),
          },
        ]);
      });
      expect(tagLabel('bid')).toBe('1.11920');

      fireEvent.keyDown(svg, { key: 's' });
      expect(tagLabel('bid')).toBe('1.12500');
    } finally {
      window.removeEventListener('openOrderDialog', orderListener);
      window.removeEventListener('openChart', chartListener);
    }
  });

  it('always binds Market Watch tick graph bid/ask colors to the active chart candle colors', () => {
    useChartSettingsStore.getState().resetToDefaults();
    useChartSettingsStore.getState().updateSymbolColor('EURUSD', 'bullCandle', '#16a34a');
    useChartSettingsStore.getState().updateSymbolColor('EURUSD', 'bearCandle', '#e11d48');

    const { container } = render(<MarketWatchTickChart symbol="EURUSD" />);
    const section = container.querySelector('section.rtx-market-tick-chart') as HTMLElement;
    expect(section.style.getPropertyValue('--rtx-tick-chart-bid').toLowerCase()).toBe('#16a34a');
    expect(section.style.getPropertyValue('--rtx-tick-chart-ask').toLowerCase()).toBe('#e11d48');

    useChartSettingsStore.getState().resetToDefaults();
  });

  it('matches the main chart background and fine/square/scale grid styling', () => {
    setTickBuffer('BTCUSD', [
      { symbol: 'BTCUSD', bid: 61210, ask: 61225, spread: 15, timestamp: Date.UTC(2026, 10, 23, 9, 50, 0) },
      { symbol: 'BTCUSD', bid: 61220, ask: 61235, spread: 15, timestamp: Date.UTC(2026, 10, 23, 9, 51, 0) },
      { symbol: 'BTCUSD', bid: 61217.29, ask: 61232.29, spread: 15, timestamp: Date.UTC(2026, 10, 23, 9, 52, 49) },
    ]);

    const { container } = render(
      <MarketWatchTickChart symbol="BTCUSD" instrumentSources={[{ symbol: 'BTCUSD', digits: 2 }]} />,
    );
    const section = container.querySelector('section.rtx-market-tick-chart') as HTMLElement;
    const grid = screen.getByTestId('market-tick-grid');

    // Default dark chart uses #000000 background and 32px Fine ('mt5') dashed slate grid.
    expect(section.style.getPropertyValue('--rtx-tick-chart-plot').toLowerCase()).toBe('#000000');
    expect(grid).toHaveAttribute('data-grid-type', 'mt5');
    expect(grid).toHaveAttribute('data-grid-style', 'dashed');
    expect(grid).toHaveAttribute('stroke-width', '1');
    expect(grid).toHaveAttribute('stroke-opacity', '0.5');
    expect(grid).toHaveAttribute('stroke-dasharray', '1 2');
    expect(grid).toHaveAttribute('shape-rendering', 'crispEdges');

    const readPositions = (axis: 'horizontal' | 'vertical') => Array.from(
      grid.querySelectorAll(`line[data-axis="${axis}"]`),
    ).map((line) => Number(line.getAttribute(axis === 'horizontal' ? 'y1' : 'x1')));

    const fineHorz = readPositions('horizontal');
    const fineVert = readPositions('vertical');
    expect(fineHorz.length).toBeGreaterThan(2);
    expect(fineVert.length).toBeGreaterThan(2);
    expect(fineHorz[1] - fineHorz[0]).toBe(32);
    expect(fineVert[1] - fineVert[0]).toBe(32);
    expect(grid.querySelector('line[data-axis="horizontal"]')).toHaveAttribute('stroke', '#778899');
    expect(grid.querySelector('line[data-axis="vertical"]')).toHaveAttribute('stroke', '#778899');

    // Switching to Square solid grid updates spacing to 64px, crisp 1px width, and removes dashes.
    act(() => {
      useChartSettingsStore.getState().updateSymbolProperty('BTCUSD', 'gridType', 'square');
      useChartSettingsStore.getState().updateSymbolProperty('BTCUSD', 'gridLineStyle', 'solid');
    });
    expect(grid).toHaveAttribute('data-grid-type', 'square');
    expect(grid).toHaveAttribute('data-grid-style', 'solid');
    expect(grid).toHaveAttribute('stroke-width', '1');
    expect(grid).not.toHaveAttribute('stroke-opacity');
    expect(grid).not.toHaveAttribute('stroke-dasharray');
    expect(grid).toHaveAttribute('shape-rendering', 'auto');
    const squareHorz = readPositions('horizontal');
    const squareVert = readPositions('vertical');
    expect(squareHorz[1] - squareHorz[0]).toBe(64);
    expect(squareVert[1] - squareVert[0]).toBe(64);

    // Fine solid grid drops the dashed 0.5 opacity dim so solid lines keep full visibility.
    act(() => {
      useChartSettingsStore.getState().updateSymbolProperty('BTCUSD', 'gridType', 'mt5');
    });
    expect(grid).toHaveAttribute('data-grid-type', 'mt5');
    expect(grid).toHaveAttribute('data-grid-style', 'solid');
    expect(grid).not.toHaveAttribute('stroke-opacity');
    expect(grid).not.toHaveAttribute('stroke-dasharray');

    // Switching to Scale dashed grid uses 2 2 dash pattern aligned with axis ticks.
    act(() => {
      useChartSettingsStore.getState().updateSymbolProperty('BTCUSD', 'gridType', 'scale');
      useChartSettingsStore.getState().updateSymbolProperty('BTCUSD', 'gridLineStyle', 'dashed');
    });
    expect(grid).toHaveAttribute('data-grid-type', 'scale');
    expect(grid).toHaveAttribute('stroke-width', '1');
    expect(grid).toHaveAttribute('stroke-dasharray', '2 2');
    expect(grid).toHaveAttribute('shape-rendering', 'crispEdges');

    // Custom chart background and grid color propagate directly to the ticks chart.
    act(() => {
      useChartSettingsStore.getState().updateSymbolProperty('BTCUSD', 'gridType', 'mt5');
      useChartSettingsStore.getState().updateSymbolColor('BTCUSD', 'background', '#0b192c');
      useChartSettingsStore.getState().updateSymbolColor('BTCUSD', 'grid', '#38bdf8');
    });
    expect(section.style.getPropertyValue('--rtx-tick-chart-plot').toLowerCase()).toBe('#0b192c');
    expect(grid.querySelector('line[data-axis="horizontal"]')).toHaveAttribute('stroke', '#38bdf8');
    expect(grid.querySelector('line[data-axis="vertical"]')).toHaveAttribute('stroke', '#38bdf8');
  });

  it('syncs ticks background and grid colors with the light chart surface', () => {
    document.documentElement.classList.add('rtx-advanced-view', 'rtx-skin-untitled-light');
    setTickBuffer('BTCUSD', [
      { symbol: 'BTCUSD', bid: 61210, ask: 61225, spread: 15, timestamp: Date.UTC(2026, 10, 23, 9, 50, 0) },
      { symbol: 'BTCUSD', bid: 61220, ask: 61235, spread: 15, timestamp: Date.UTC(2026, 10, 23, 9, 51, 0) },
    ]);

    const { container } = render(
      <MarketWatchTickChart symbol="BTCUSD" instrumentSources={[{ symbol: 'BTCUSD', digits: 2 }]} />,
    );
    const section = container.querySelector('section.rtx-market-tick-chart') as HTMLElement;
    const grid = screen.getByTestId('market-tick-grid');

    expect(section.style.getPropertyValue('--rtx-tick-chart-plot').toLowerCase()).toBe('#fafbfc');
    expect(grid.querySelector('line[data-axis="horizontal"]')).toHaveAttribute('stroke', 'rgba(71, 85, 105, 0.6)');
    expect(grid.querySelector('line[data-axis="vertical"]')).toHaveAttribute('stroke', 'rgba(71, 85, 105, 0.6)');
  });
});

