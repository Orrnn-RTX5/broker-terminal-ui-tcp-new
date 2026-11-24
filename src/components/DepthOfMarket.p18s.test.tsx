// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
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

describe('P18S DepthOfMarket consumer isolation', () => {
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

  it('S1/S2: switching DepthOfMarket from loaded EURUSD to pending GBPUSD renders zero EURUSD rows or clickable trade buttons', async () => {
    const restA = createDeferred<unknown>();
    const restB = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA.promise)
      .mockReturnValueOnce(restB.promise);

    const onPlaceOrder = vi.fn();
    const view = render(<DepthOfMarket symbol="EURUSD" onPlaceOrder={onPlaceOrder} />);

    await act(async () => {
      restA.resolve({
        symbol: 'EURUSD',
        bids: [{ price: 1.1, volume: 12.5 }],
        asks: [{ price: 1.1002, volume: 14.5 }],
        timestamp: 1_700_000_000_000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.container.querySelectorAll('.rtx-dom-level').length).toBeGreaterThan(0);
    });
    expect(view.container.textContent).toContain('12.50');

    view.rerender(<DepthOfMarket symbol="GBPUSD" onPlaceOrder={onPlaceOrder} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.querySelectorAll('.rtx-dom-level').length).toBe(0);
    expect(view.container.querySelectorAll('.rtx-dom-trade-btn').length).toBe(0);
    expect(view.container.textContent).not.toContain('12.50');
    expect(view.container.textContent).not.toContain('14.50');
    expect(view.container.textContent).not.toContain('1.1000');
    expect(view.container.textContent).not.toContain('1.1002');
    expect(view.container.textContent).toContain('Waiting for GBPUSD market depth...');
  });

  it("S1' (iii): switching DepthOfMarket from loaded parent XAUUSD to pending derived XAUUSD.VIP renders zero XAUUSD rows or clickable trade buttons", async () => {
    const restParent = createDeferred<unknown>();
    const restDerived = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restParent.promise)
      .mockReturnValueOnce(restDerived.promise);

    const onPlaceOrder = vi.fn();
    const view = render(<DepthOfMarket symbol="XAUUSD" onPlaceOrder={onPlaceOrder} />);

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
    expect(view.container.textContent).toContain('11.25');
    expect(view.container.textContent).toContain('13.75');

    view.rerender(<DepthOfMarket symbol="XAUUSD.VIP" onPlaceOrder={onPlaceOrder} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.querySelectorAll('.rtx-dom-level').length).toBe(0);
    expect(view.container.querySelectorAll('.rtx-dom-trade-btn').length).toBe(0);
    expect(view.container.textContent).not.toContain('11.25');
    expect(view.container.textContent).not.toContain('13.75');
    expect(view.container.textContent).not.toContain('2601.1');
    expect(view.container.textContent).not.toContain('2601.4');
    expect(view.container.textContent).toContain('Waiting for XAUUSD.VIP market depth...');

    const wsDerived = Array.from(mocks.wsListeners.get('depth.XAUUSD.VIP') ?? []);
    expect(wsDerived.length).toBeGreaterThan(0);
    act(() => {
      for (const cb of wsDerived) {
        cb({
          symbol: 'XAUUSD',
          bids: [{ price: 2701.1, volume: 21.5 }],
          asks: [{ price: 2701.4, volume: 24.5 }],
          timestamp: 1_700_000_000_500,
        });
      }
    });

    await waitFor(() => {
      expect(view.container.querySelectorAll('.rtx-dom-level').length).toBeGreaterThan(0);
    });
    expect(view.container.textContent).toContain('21.50');
    expect(view.container.textContent).toContain('24.50');
    expect(view.container.textContent).not.toContain('11.25');
    expect(view.container.textContent).not.toContain('13.75');
  });
});
