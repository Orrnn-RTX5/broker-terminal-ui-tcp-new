// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountSpreadMarkupForTests } from '../services/accountSpreadMarkup';
import { useAppStore } from '../store/useAppStore';
import { OrderPanelDialog } from './OrderPanelDialog';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const createDeferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const mocks = vi.hoisted(() => ({
  fetchMarketDataJson: vi.fn(),
  wsListeners: new Map<string, Set<(msg: unknown) => void>>(),
}));

vi.mock('../hooks/useSymbolMarketStatus', () => ({
  useSymbolMarketStatus: () => ({
    symbol: 'XAUUSD',
    status: 'open',
    isOpen: true,
    isTradeBlocked: false,
    label: 'Market Open',
    loading: false,
    error: null,
    refreshedAt: 1,
  }),
}));

vi.mock('../features/market-data/marketDataSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/market-data/marketDataSession')>();
  return {
    ...actual,
    fetchMarketDataJson: mocks.fetchMarketDataJson,
  };
});

vi.mock('../services/binaryTcpMarketStream', () => ({
  binaryTcpMarketStream: {
    isSupported: () => false,
    getLatestDepth: () => null,
    onDepth: () => () => {},
  },
}));

vi.mock('../services/websocket-enhanced', () => ({
  getEnhancedWebSocketService: () => ({
    connect: () => {},
    subscribe: (channel: string, cb: (msg: unknown) => void) => {
      let set = mocks.wsListeners.get(channel);
      if (!set) {
        set = new Set();
        mocks.wsListeners.set(channel, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
      };
    },
  }),
}));

vi.mock('../services/brokerSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/brokerSession')>();
  return {
    ...actual,
    buildBrokerWsV2Uri: () => 'wss://broker-a.test/ws/v2',
  };
});

describe('P18S Step 3(d): OrderPanelDialog DOM pane & price-fill isolation', () => {
  beforeEach(() => {
    mocks.fetchMarketDataJson.mockReset();
    mocks.wsListeners.clear();
    localStorage.setItem('lastLotSize', '0.01');
    resetAccountSpreadMarkupForTests();
    useAppStore.getState().reset();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '1001',
      authToken: 'test-token',
    });
    useAppStore.getState().setTicks({
      XAUUSD: {
        symbol: 'XAUUSD',
        bid: 4173.23,
        ask: 4173.77,
        spread: 0.54,
        timestamp: 1_700_000_000_000,
        digits: 2,
      },
    });
  });

  afterEach(() => {
    cleanup();
    resetAccountSpreadMarkupForTests();
    useAppStore.getState().reset();
  });

  it('clears XAUUSD rows and clickable price handlers while EURUSD is pending, then fills EURUSD price on click', async () => {
    const restXau = createDeferred<unknown>();
    const restEur = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restXau.promise)
      .mockReturnValueOnce(restEur.promise);

    render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 0, ask: 0 }}
        onSubmitOrder={vi.fn()}
        symbols={['XAUUSD', 'EURUSD']}
        instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
      />,
    );

    const wsXau = Array.from(mocks.wsListeners.get('depth.XAUUSD') ?? []);
    await act(async () => {
      restXau.resolve({
        symbol: 'XAUUSD',
        bids: [{ price: 4173.23, volume: 777 }],
        asks: [{ price: 4173.77, volume: 888 }],
        timestamp: 1_700_000_000_000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const domPane = screen.getByTestId('order-dom-pane');
    await waitFor(() => {
      expect(domPane.textContent).toContain('777');
      expect(domPane.textContent).toContain('888');
    });

    // Switch symbol to EURUSD (pending, no EURUSD tick)
    const symbolSelect = screen.getByLabelText('Symbol') as HTMLSelectElement;
    fireEvent.change(symbolSelect, { target: { value: 'EURUSD' } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Late XAUUSD WS callback must not populate DOM rows or clickable prices
    act(() => {
      for (const cb of wsXau) {
        cb({
          symbol: 'XAUUSD',
          bids: [{ price: 4188.11, volume: 999 }],
          asks: [{ price: 4188.99, volume: 998 }],
          timestamp: 1_700_000_000_100,
        });
      }
    });

    expect(domPane.querySelectorAll('.rtx-order-dialog__dom-row').length).toBe(0);
    expect(domPane.querySelectorAll('.rtx-order-dialog__dom-chevron').length).toBe(0);
    expect(domPane.querySelectorAll('.rtx-order-dialog__dom-price').length).toBe(0);
    expect(domPane.textContent).not.toContain('4173.23');
    expect(domPane.textContent).not.toContain('4188.11');

    // Resolve EURUSD -> rows appear and clicking Buy chevron fills EURUSD price (1.1238)
    await act(async () => {
      restEur.resolve({
        symbol: 'EURUSD',
        bids: [{ price: 1.1234, volume: 555 }],
        asks: [{ price: 1.1238, volume: 666 }],
        timestamp: 1_700_000_000_200,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(domPane.textContent).toContain('555');
      expect(domPane.textContent).toContain('666');
    });
    const buyChevron = screen.getByTitle('Buy at 1.1238');
    fireEvent.click(buyChevron);

    const priceInput = screen.getByLabelText('Price') as HTMLInputElement;
    expect(priceInput.value).toBe('1.1238');
  });

  it('clears parent XAUUSD rows while derived XAUUSD.VIP is pending, then fills derived price from depth.XAUUSD.VIP', async () => {
    const restXau = createDeferred<unknown>();
    const restVip = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restXau.promise)
      .mockReturnValueOnce(restVip.promise);

    render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 0, ask: 0 }}
        onSubmitOrder={vi.fn()}
        symbols={['XAUUSD', 'XAUUSD.VIP']}
        instruments={[
          { symbol: 'XAUUSD', digits: 2, contractSize: 100 },
          { symbol: 'XAUUSD.VIP', digits: 2, contractSize: 100 },
        ]}
      />,
    );

    const wsParent = Array.from(mocks.wsListeners.get('depth.XAUUSD') ?? []);
    await act(async () => {
      restXau.resolve({
        symbol: 'XAUUSD',
        bids: [{ price: 4173.23, volume: 777 }],
        asks: [{ price: 4173.77, volume: 888 }],
        timestamp: 1_700_000_000_000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const domPane = screen.getByTestId('order-dom-pane');
    await waitFor(() => {
      expect(domPane.textContent).toContain('777');
    });

    const symbolSelect = screen.getByLabelText('Symbol') as HTMLSelectElement;
    fireEvent.change(symbolSelect, { target: { value: 'XAUUSD.VIP' } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Late parent WS ignored
    act(() => {
      for (const cb of wsParent) {
        cb({
          symbol: 'XAUUSD',
          bids: [{ price: 4188.11, volume: 999 }],
          asks: [{ price: 4188.99, volume: 998 }],
          timestamp: 1_700_000_000_100,
        });
      }
    });

    expect(domPane.querySelectorAll('.rtx-order-dialog__dom-row').length).toBe(0);
    expect(domPane.querySelectorAll('.rtx-order-dialog__dom-chevron').length).toBe(0);

    // Derived WS channel delivers payload carrying parent symbol XAUUSD
    const wsVip = Array.from(mocks.wsListeners.get('depth.XAUUSD.VIP') ?? []);
    act(() => {
      for (const cb of wsVip) {
        cb({
          symbol: 'XAUUSD',
          bids: [{ price: 4201.10, volume: 333 }],
          asks: [{ price: 4201.90, volume: 444 }],
          timestamp: 1_700_000_000_300,
        });
      }
    });

    await waitFor(() => {
      expect(domPane.textContent).toContain('333');
      expect(domPane.textContent).toContain('444');
    });

    const buyDerived = screen.getByTitle('Buy at 4201.90');
    fireEvent.click(buyDerived);

    const priceInput = screen.getByLabelText('Price') as HTMLInputElement;
    expect(priceInput.value).toBe('4201.90');
  });
});
