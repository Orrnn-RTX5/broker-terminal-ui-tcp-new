// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountSpreadMarkupForTests } from '../services/accountSpreadMarkup';
import { useAppStore } from '../store/useAppStore';
import { DepthOfMarket } from './DepthOfMarket';

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

vi.mock('../store/useMarketDataStore', () => ({
  useCurrentTick: () => null,
}));

vi.mock('../hooks/useUiTranslation', () => ({
  useUiTranslation: () => (text: string) => text,
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

describe('P18S Step 3(d): DepthOfMarket DOM & click-handler isolation', () => {
  beforeEach(() => {
    mocks.fetchMarketDataJson.mockReset();
    mocks.wsListeners.clear();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    resetAccountSpreadMarkupForTests();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '1001',
      authToken: 'test-token',
    });
  });

  afterEach(() => {
    cleanup();
    resetAccountSpreadMarkupForTests();
    useAppStore.setState({
      isAuthenticated: false,
      accountId: null,
      authToken: null,
    });
    vi.unstubAllGlobals();
  });

  it('prevents previous symbol prices from rendering or being sent on click during switch, then routes new symbol prices', async () => {
    const restA1 = createDeferred<unknown>();
    const restA2 = createDeferred<unknown>();
    const restB = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA1.promise)
      .mockReturnValueOnce(restB.promise)
      .mockReturnValueOnce(restA2.promise);

    const onPlaceOrder = vi.fn();
    const view = render(<DepthOfMarket symbol="EURUSD" onPlaceOrder={onPlaceOrder} />);
    const wsEurBeforeSwitch = Array.from(mocks.wsListeners.get('depth.EURUSD') ?? []);

    await act(async () => {
      restA1.resolve({
        symbol: 'EURUSD',
        bids: [{ price: 1.1122, volume: 12.5 }],
        asks: [{ price: 1.1124, volume: 14.5 }],
        timestamp: 1_700_000_000_000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.container.querySelectorAll('.rtx-dom-level').length).toBeGreaterThan(0);
    });
    const eurBuyBtn = view.container.querySelector('.rtx-dom-trade-btn--buy') as HTMLButtonElement | null;
    expect(eurBuyBtn).not.toBeNull();
    fireEvent.click(eurBuyBtn!);
    expect(onPlaceOrder).toHaveBeenCalledTimes(1);
    expect(onPlaceOrder.mock.calls[0][0].price).toBe(1.1122);
    onPlaceOrder.mockClear();

    // Switch to GBPUSD while GBPUSD REST is pending
    view.rerender(<DepthOfMarket symbol="GBPUSD" onPlaceOrder={onPlaceOrder} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Late EURUSD WS callback must not leak rows or clickable buttons
    act(() => {
      for (const cb of wsEurBeforeSwitch) {
        cb({
          symbol: 'EURUSD',
          bids: [{ price: 1.1999, volume: 99.1 }],
          asks: [{ price: 1.2001, volume: 99.2 }],
          timestamp: 1_700_000_000_100,
        });
      }
    });

    expect(view.container.querySelectorAll('.rtx-dom-level').length).toBe(0);
    expect(view.container.querySelectorAll('.rtx-dom-trade-btn').length).toBe(0);
    expect(view.container.textContent).toContain('Waiting for GBPUSD market depth...');
    expect(onPlaceOrder).not.toHaveBeenCalled();

    // Resolve GBPUSD and verify new prices render and click sends GBPUSD price
    await act(async () => {
      restB.resolve({
        symbol: 'GBPUSD',
        bids: [{ price: 1.2731, volume: 33.25 }],
        asks: [{ price: 1.2735, volume: 44.75 }],
        timestamp: 1_700_000_000_200,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain('33.25');
      expect(view.container.textContent).toContain('44.75');
    });
    expect(view.container.textContent).not.toContain('12.50');
    expect(view.container.textContent).not.toContain('1.1122');

    const gbpBuyBtn = view.container.querySelector('.rtx-dom-trade-btn--buy') as HTMLButtonElement | null;
    expect(gbpBuyBtn).not.toBeNull();
    fireEvent.click(gbpBuyBtn!);
    expect(onPlaceOrder).toHaveBeenCalledTimes(1);
    expect(onPlaceOrder.mock.calls[0][0].price).toBe(1.2731);
  });

  it('switches parent XAUUSD -> derived XAUUSD.VIP with zero parent clickability while pending, then sends derived price', async () => {
    const restParent = createDeferred<unknown>();
    const restDerived = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restParent.promise)
      .mockReturnValueOnce(restDerived.promise);

    const onPlaceOrder = vi.fn();
    const view = render(<DepthOfMarket symbol="XAUUSD" onPlaceOrder={onPlaceOrder} />);
    const wsParent = Array.from(mocks.wsListeners.get('depth.XAUUSD') ?? []);

    await act(async () => {
      restParent.resolve({
        symbol: 'XAUUSD',
        bids: [{ price: 2601.1, volume: 11.25 }],
        asks: [{ price: 2601.4, volume: 13.75 }],
        timestamp: 1_700_000_000_000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.container.querySelectorAll('.rtx-dom-level').length).toBeGreaterThan(0);
    });

    view.rerender(<DepthOfMarket symbol="XAUUSD.VIP" onPlaceOrder={onPlaceOrder} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Late parent WS callback must be dropped
    act(() => {
      for (const cb of wsParent) {
        cb({
          symbol: 'XAUUSD',
          bids: [{ price: 2609.1, volume: 55.5 }],
          asks: [{ price: 2609.4, volume: 66.6 }],
          timestamp: 1_700_000_000_100,
        });
      }
    });

    expect(view.container.querySelectorAll('.rtx-dom-level').length).toBe(0);
    expect(view.container.querySelectorAll('.rtx-dom-trade-btn').length).toBe(0);
    expect(view.container.textContent).toContain('Waiting for XAUUSD.VIP market depth...');

    // Derived WS channel delivers payload naming parent XAUUSD
    const wsDerived = Array.from(mocks.wsListeners.get('depth.XAUUSD.VIP') ?? []);
    act(() => {
      for (const cb of wsDerived) {
        cb({
          symbol: 'XAUUSD',
          bids: [{ price: 2701.1, volume: 21.5 }],
          asks: [{ price: 2701.4, volume: 24.5 }],
          timestamp: 1_700_000_000_300,
        });
      }
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain('21.50');
      expect(view.container.textContent).toContain('24.50');
    });

    const derivedSellBtn = view.container.querySelector('.rtx-dom-trade-btn--sell') as HTMLButtonElement | null;
    expect(derivedSellBtn).not.toBeNull();
    fireEvent.click(derivedSellBtn!);
    expect(onPlaceOrder).toHaveBeenCalledTimes(1);
    expect(onPlaceOrder.mock.calls[0][0].price).toBe(2701.4);
  });
});
