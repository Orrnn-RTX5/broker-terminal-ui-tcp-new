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

describe('P18S OrderPanelDialog DOM pane consumer isolation', () => {
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

  it('S1/S2: changing OrderPanelDialog symbol from loaded XAUUSD to pending EURUSD renders zero XAUUSD DOM rows or clickable chevrons', async () => {
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
    expect(screen.getByTitle('Buy at 4173.77')).not.toBeNull();

    const symbolSelect = screen.getByLabelText('Symbol') as HTMLSelectElement;
    fireEvent.change(symbolSelect, { target: { value: 'EURUSD' } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(domPane.querySelectorAll('.rtx-order-dialog__dom-row').length).toBe(0);
    expect(domPane.querySelectorAll('.rtx-order-dialog__dom-chevron').length).toBe(0);
    expect(domPane.textContent).not.toContain('4173.23');
    expect(domPane.textContent).not.toContain('4173.77');
    expect(domPane.textContent).not.toContain('777');
    expect(domPane.textContent).not.toContain('888');
  });

  it("S1' (iii): changing OrderPanelDialog symbol from loaded parent XAUUSD to pending derived XAUUSD.VIP renders zero XAUUSD DOM rows or clickable chevrons", async () => {
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
    expect(screen.getByTitle('Buy at 4173.77')).not.toBeNull();

    const symbolSelect = screen.getByLabelText('Symbol') as HTMLSelectElement;
    fireEvent.change(symbolSelect, { target: { value: 'XAUUSD.VIP' } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(domPane.querySelectorAll('.rtx-order-dialog__dom-row').length).toBe(0);
    expect(domPane.querySelectorAll('.rtx-order-dialog__dom-chevron').length).toBe(0);
    expect(domPane.textContent).not.toContain('4173.23');
    expect(domPane.textContent).not.toContain('4173.77');
    expect(domPane.textContent).not.toContain('777');
    expect(domPane.textContent).not.toContain('888');

    const wsVip = Array.from(mocks.wsListeners.get('depth.XAUUSD.VIP') ?? []);
    expect(wsVip.length).toBeGreaterThan(0);
    act(() => {
      for (const cb of wsVip) {
        cb({
          symbol: 'XAUUSD',
          bids: [{ price: 4201.10, volume: 333 }],
          asks: [{ price: 4201.90, volume: 444 }],
          timestamp: 1_700_000_000_500,
        });
      }
    });

    await waitFor(() => {
      expect(domPane.textContent).toContain('333');
      expect(domPane.textContent).toContain('444');
    });
    expect(screen.getByTitle('Buy at 4201.90')).not.toBeNull();
    expect(domPane.textContent).not.toContain('777');
    expect(domPane.textContent).not.toContain('888');
    expect(domPane.textContent).not.toContain('4173.23');
    expect(domPane.textContent).not.toContain('4173.77');
  });
});
