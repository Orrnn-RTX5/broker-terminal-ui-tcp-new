// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const orders = vi.hoisted(() => ({ placeMarketOrder: vi.fn() }));
vi.mock('../services/api', () => ({ default: { orders } }));
import { MT5_ONE_CLICK_STALE_MS, OneClickTrading } from './OneClickTrading';
import { useAppStore } from '../store/useAppStore';
import { useLastSymbolStore } from '../store/useLastSymbolStore';
import { useOneClickDisclaimerStore } from '../store/useOneClickDisclaimerStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { normalizeMarketStatus } from '../utils/marketStatus';
import { commitBrokerAccountSessionScope } from '../services/brokerSession';

const symbols = ['XAUUSD.raw', 'EURUSD.r', 'BTCUSD-pro', 'ADAUSD', 'USDJPY.r', 'GBPUSD', 'NAS100-F', 'ETHUSD'];
const frames = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'MN'];
const quote = (symbol: string, price: number) => ({ symbol, bid: price, ask: price + 0.01, spread: 0.01, digits: 2, timestamp: Date.now() });
const chart = (symbol: string, index: number) => <section key={index} data-testid={`panel-${index}`}><OneClickTrading
  symbol={symbol} timeframe={frames[index]} visible tradeAllowed marketStatus={normalizeMarketStatus({ symbol, status: 'open' })}
/></section>;
beforeEach(() => {
  useAppStore.getState().reset();
  useSettingsStore.getState().resetToDefaults();
  useSettingsStore.getState().updateTradeSettings({ oneClickTrading: true });
  useOneClickDisclaimerStore.getState().resetSessionAcceptance();
  useOneClickDisclaimerStore.getState().setAcceptedInSession(true);
  useAppStore.setState({ isAuthenticated: true, accountId: '900001', authToken: 'test-token' });
  useAppStore.getState().setTicks(Object.fromEntries(symbols.map((symbol, index) => [symbol, quote(symbol, 1200 + index)])));
  commitBrokerAccountSessionScope({ authenticated: true, accountId: '900001', brokerId: 'test', serverUrl: 'https://test.invalid' });
  orders.placeMarketOrder.mockReset().mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  useOneClickDisclaimerStore.getState().resetSessionAcceptance();
  useSettingsStore.getState().resetToDefaults();
  commitBrokerAccountSessionScope({ authenticated: false, brokerId: '', serverUrl: '' });
});

describe('independent one-click chart trading', { timeout: 30000 }, () => {
  it.each(['TEST', 'achiever-financials'])('routes all eight panels with their own exact contract, quote and lot on %s', brokerId => {
    commitBrokerAccountSessionScope({ authenticated: true, accountId: '900001', brokerId, serverUrl: `https://${brokerId}.invalid` });
    render(<>{symbols.map(chart)}</>);
    symbols.forEach((symbol, index) => {
      const panel = within(screen.getByTestId(`panel-${index}`));
      const input = panel.getByRole('spinbutton', { name: 'Lot size' });
      fireEvent.change(input, { target: { value: (index + 1) / 10 } });
      const label = index % 2 ? 'SELL' : 'BUY';
      const button = panel.getByRole('button', { name: new RegExp(`^${label} `) });
      expect(button).toHaveTextContent(String(1200 + index));
      fireEvent.click(button);
      expect(orders.placeMarketOrder).toHaveBeenNthCalledWith(index + 1,
        { side: label.toLowerCase(), symbol, volume: (index + 1) / 10, login: 900001 }, { intentAtMs: expect.any(Number) });
      symbols.slice(index + 1).forEach((_, offset) => expect(within(screen.getByTestId(`panel-${index + offset + 1}`)).getByRole('spinbutton')).toHaveValue('0.01'));
    });
    expect(orders.placeMarketOrder).toHaveBeenCalledTimes(8);
  });

  it('updates only the changed panel and never aliases a suffixed quote to the base symbol', () => {
    const view = render(<>{symbols.map(chart)}</>);
    act(() => useAppStore.getState().setTicks({ ...useAppStore.getState().ticks,
      'xagusd.raw': quote('xagusd.raw', 42), XAGUSD: quote('XAGUSD', 999) }));
    const changed = [...symbols]; changed[3] = 'XAGUSD.RAW';
    view.rerender(<>{changed.map(chart)}</>);
    const panel = within(screen.getByTestId('panel-3'));
    const buy = panel.getByRole('button', { name: /^BUY XAGUSD.RAW/ });
    expect(buy).toHaveTextContent('42.01');
    fireEvent.click(buy);
    expect(orders.placeMarketOrder).toHaveBeenCalledWith({ side: 'buy', symbol: 'XAGUSD.RAW', volume: 0.01, login: 900001 }, { intentAtMs: expect.any(Number) });
    symbols.forEach((symbol, index) => {
      if (index !== 3) expect(within(screen.getByTestId(`panel-${index}`)).getByRole('button', { name: /^BUY / })).toHaveAttribute('aria-label', expect.stringContaining(symbol));
    });
  });

  it('ignores a late order acknowledgement after the broker/account owner changes', async () => {
    let complete: (value: unknown) => void = () => {};
    orders.placeMarketOrder.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const refresh = vi.fn(); window.addEventListener('rtx:force-refresh-positions', refresh);
    const previousLastSymbol = useLastSymbolStore.getState().lastSymbol;
    render(chart(symbols[0], 0));
    fireEvent.click(screen.getByRole('button', { name: /^BUY / }));
    act(() => {
      useAppStore.setState({ accountId: '900002', positions: [], authToken: 'test-token-2' });
      commitBrokerAccountSessionScope({ authenticated: true, accountId: '900002', brokerId: 'achiever', serverUrl: 'https://achiever.invalid' });
    });
    await act(async () => complete({ ticket: 123456, symbol: symbols[0], volume: 0.01, price_open: 1200.01 }));
    expect(useAppStore.getState().positions).toEqual([]);
    expect(useLastSymbolStore.getState().lastSymbol).toBe(previousLastSymbol);
    expect(refresh).not.toHaveBeenCalled();
    window.removeEventListener('rtx:force-refresh-positions', refresh);
  });

  it('stays in the normal horizontal row for 5+ chart panes (~340px) and uses compact single-row sizing only when very narrow', () => {
    let notify: ResizeObserverCallback = () => {};
    let observed: Element | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { notify = callback; }
      observe(target: Element) { observed = target; }
      disconnect = disconnect;
      unobserve() {}
    });
    const view = render(chart(symbols[0], 0));
    const outer = screen.getByTestId('one-click-trading-row').parentElement!;
    const resize = (width: number) => act(() => notify([{ target: observed, contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
    resize(340);
    expect(outer).toHaveAttribute('data-compact', 'false');
    expect(outer).toHaveStyle({ width: 'fit-content', maxWidth: 'calc(100% - 20px)' });
    resize(260);
    expect(outer).toHaveAttribute('data-compact', 'true');
    expect(outer).toHaveStyle({ width: 'fit-content', maxWidth: 'calc(100% - 20px)' });
    expect(screen.getByRole('button', { name: /^BUY / })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^SELL / })).toBeEnabled();
    resize(600);
    expect(outer).toHaveAttribute('data-compact', 'false');
    view.unmount(); expect(disconnect).toHaveBeenCalledOnce();
  });

  it('keeps identical BUY and SELL button dimensions, tabular-nums price alignment, and non-shifting error banners across sufficient balance, zero balance, and rejected orders', async () => {
    // 1. Sufficient balance state
    useAppStore.setState({
      account: {
        balance: 5000,
        equity: 5000,
        margin: 100,
        freeMargin: 4900,
        marginLevel: 5000,
        leverage: 100,
        currency: 'USD',
      },
    });
    render(chart(symbols[0], 0));
    const outer = screen.getByTestId('one-click-trading-row').parentElement!;
    expect(outer).toHaveAttribute('data-insufficient-margin', 'false');

    const sellBtn = screen.getByRole('button', { name: /^SELL / });
    const buyBtn = screen.getByRole('button', { name: /^BUY / });

    // BUY and SELL buttons share identical dimensions, padding, and alignment
    expect(sellBtn).toHaveStyle({
      width: 'auto',
      minWidth: '104px',
      height: '34px',
      padding: '5px 10px',
      justifyContent: 'center',
      fontVariantNumeric: 'tabular-nums',
    });
    expect(buyBtn).toHaveStyle({
      width: 'auto',
      minWidth: '104px',
      height: '34px',
      padding: '5px 10px',
      justifyContent: 'center',
      fontVariantNumeric: 'tabular-nums',
    });

    // Dynamic price change keeps consistent minWidth and height on both buttons
    act(() => {
      useAppStore.getState().setTicks({
        ...useAppStore.getState().ticks,
        [symbols[0]]: { symbol: symbols[0], bid: 99999.98765, ask: 100000.12345, spread: 0.1358, digits: 5, timestamp: Date.now() },
      });
    });
    expect(sellBtn).toHaveStyle({ minWidth: '104px', height: '34px', fontVariantNumeric: 'tabular-nums' });
    expect(buyBtn).toHaveStyle({ minWidth: '104px', height: '34px', fontVariantNumeric: 'tabular-nums' });

    // 2. Zero balance conditional state & rejected order (insufficient margin)
    act(() => {
      useAppStore.setState({
        account: {
          balance: 0,
          equity: 0,
          margin: 0,
          freeMargin: 0,
          marginLevel: 0,
          leverage: 100,
          currency: 'USD',
        },
      });
    });
    expect(outer).toHaveAttribute('data-insufficient-margin', 'true');

    orders.placeMarketOrder.mockRejectedValueOnce(Object.assign(new Error('INSUFFICIENT_MARGIN'), {
      preserveBackendOrderError: true,
      code: 'INSUFFICIENT_MARGIN',
      backendMessage: 'INSUFFICIENT_MARGIN',
    }));
    await act(async () => {
      fireEvent.click(buyBtn);
    });
    const alertBanner = screen.getByRole('alert');
    expect(alertBanner).toHaveTextContent('Order failed: not enough free margin to open this order.');
    expect(alertBanner).toHaveStyle({ width: '0px', minWidth: '100%', maxWidth: '100%' });
  });

  it('follows official MT5 tick-direction coloring (blue up, red down, gray after 15s unchanged) independently for Bid and Ask', () => {
    vi.useFakeTimers();
    try {
      render(chart(symbols[0], 0));
      const sellBtn = screen.getByRole('button', { name: /^SELL / });
      const buyBtn = screen.getByRole('button', { name: /^BUY / });

      // Initial state before any price change: gray (flat)
      expect(sellBtn).toHaveAttribute('data-dir', 'flat');
      expect(sellBtn).toHaveStyle({ background: '#6b7280' });
      expect(buyBtn).toHaveAttribute('data-dir', 'flat');
      expect(buyBtn).toHaveStyle({ background: '#6b7280' });

      // Both Bid and Ask rise -> both SELL and BUY turn blue (up)
      act(() => {
        useAppStore.getState().setTicks({
          ...useAppStore.getState().ticks,
          [symbols[0]]: quote(symbols[0], 1205),
        });
      });
      expect(sellBtn).toHaveAttribute('data-dir', 'up');
      expect(sellBtn).toHaveStyle({ background: '#4597ff' });
      expect(buyBtn).toHaveAttribute('data-dir', 'up');
      expect(buyBtn).toHaveStyle({ background: '#4597ff' });

      // Both Bid and Ask fall -> both SELL and BUY turn red (down)
      act(() => {
        useAppStore.getState().setTicks({
          ...useAppStore.getState().ticks,
          [symbols[0]]: quote(symbols[0], 1195),
        });
      });
      expect(sellBtn).toHaveAttribute('data-dir', 'down');
      expect(sellBtn).toHaveStyle({ background: '#ff5858' });
      expect(buyBtn).toHaveAttribute('data-dir', 'down');
      expect(buyBtn).toHaveStyle({ background: '#ff5858' });

      // Spread widens (Bid down, Ask up) -> SELL stays red, BUY turns blue independently
      act(() => {
        useAppStore.getState().setTicks({
          ...useAppStore.getState().ticks,
          [symbols[0]]: { symbol: symbols[0], bid: 1194, ask: 1196, spread: 2, digits: 2, timestamp: Date.now() },
        });
      });
      expect(sellBtn).toHaveAttribute('data-dir', 'down');
      expect(buyBtn).toHaveAttribute('data-dir', 'up');

      // After 15 seconds with no quote change -> both return to MT5 neutral gray
      act(() => {
        vi.advanceTimersByTime(MT5_ONE_CLICK_STALE_MS);
      });
      expect(sellBtn).toHaveAttribute('data-dir', 'flat');
      expect(sellBtn).toHaveStyle({ background: '#6b7280' });
      expect(buyBtn).toHaveAttribute('data-dir', 'flat');
      expect(buyBtn).toHaveStyle({ background: '#6b7280' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents price digit clipping in light and laptop themes by letting trade buttons expand and avoiding conflicting inner padding', () => {
    const octCss = readFileSync(resolve(process.cwd(), 'src/components/OneClickTrading.css'), 'utf8');
    const legacyLightCss = readFileSync(resolve(process.cwd(), 'src/styles/legacy-light-overrides.css'), 'utf8');
    const themeCss = readFileSync(resolve(process.cwd(), 'src/styles/theme.css'), 'utf8');

    expect(octCss).toMatch(
      /\.rtx-oct\[data-compact='false'\] \.rtx-oct-trade-button\s*\{[^}]*width: auto !important;[^}]*min-width: 98px !important;[^}]*max-width: none !important;[^}]*flex: 0 0 auto !important;/,
    );
    expect(octCss).not.toMatch(/\.rtx-oct\[data-compact='false'\] \.rtx-oct-trade-button\s*\{[^}]*max-width: 98px !important;/);
    expect(octCss).toMatch(
      /\.rtx-oct\[data-compact='true'\] \.rtx-oct-trade-button\s*\{[^}]*max-width: none !important;/,
    );
    expect(octCss).toMatch(
      /html:root body \.rtx-oct \.rtx-oct-price\s*\{[^}]*flex: 1 0 auto;[^}]*min-width: max-content;[^}]*overflow: visible;/,
    );

    expect(legacyLightCss).toMatch(
      /html\.rtx-advanced-view\.rtx-skin-untitled-light \.rtx-oct \.rtx-oct-trade-button \.rtx-oct-price\s*\{[^}]*padding: 0;/,
    );
    expect(legacyLightCss).toMatch(
      /html\.rtx-advanced-view\.rtx-skin-untitled-light \.rtx-oct \.rtx-oct-trade-button \.rtx-oct-side-label\s*\{[^}]*min-width: 0;[^}]*padding: 0;/,
    );
    expect(themeCss).toMatch(
      /\.theme-light \.rtx-oct \.rtx-oct-trade-button \.rtx-oct-price\s*\{[^}]*padding: 0;/,
    );
    expect(themeCss).toMatch(
      /\.theme-light \.rtx-oct \.rtx-oct-trade-button \.rtx-oct-side-label\s*\{[^}]*min-width: 0;[^}]*padding: 0;/,
    );
  });
});
