// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAccountSpreadMarkupForTests } from '../../services/accountSpreadMarkup';
import type { DecodedBinaryDepth } from '../../services/binaryTcpMarketStream';
import { useAppStore } from '../../store/useAppStore';
import { useLiveOrderBook } from './useLiveOrderBook';

type BinaryDepthCb = (decoded: DecodedBinaryDepth) => void;
type WsDepthCb = (message: unknown) => void;

const mocks = vi.hoisted(() => {
  const fetchMarketDataJson = vi.fn();
  const binarySupported = { value: false };
  const binaryListeners: BinaryDepthCb[] = [];
  const wsListeners: WsDepthCb[] = [];

  return {
    fetchMarketDataJson,
    binarySupported,
    binaryListeners,
    wsListeners,
  };
});

vi.mock('./marketDataSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./marketDataSession')>();
  return {
    ...actual,
    fetchMarketDataJson: mocks.fetchMarketDataJson,
  };
});

vi.mock('../../services/binaryTcpMarketStream', () => ({
  binaryTcpMarketStream: {
    isSupported: () => mocks.binarySupported.value,
    getLatestDepth: () => null,
    onDepth: (_symbol: string, cb: BinaryDepthCb) => {
      mocks.binaryListeners.push(cb);
      return () => {};
    },
  },
}));

vi.mock('../../services/websocket-enhanced', () => ({
  getEnhancedWebSocketService: () => ({
    connect: () => {},
    subscribe: (_channel: string, cb: WsDepthCb) => {
      mocks.wsListeners.push(cb);
      return () => {};
    },
  }),
}));

vi.mock('../../services/brokerSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/brokerSession')>();
  return {
    ...actual,
    buildBrokerWsV2Uri: () => 'wss://broker-a.test/ws/v2',
  };
});

describe('P18S useLiveOrderBook hot-path timing (report-only, never fails)', () => {
  beforeEach(() => {
    mocks.fetchMarketDataJson.mockReset();
    mocks.binarySupported.value = false;
    mocks.binaryListeners.length = 0;
    mocks.wsListeners.length = 0;
    resetAccountSpreadMarkupForTests();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '1001',
      authToken: 'bench-token',
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
  });

  it('measures 20,000 consecutive binary depth updates of the current symbol', async () => {
    mocks.binarySupported.value = true;
    mocks.fetchMarketDataJson.mockResolvedValueOnce({
      symbol: 'EURUSD',
      bids: [{ price: 1.1, volume: 10 }],
      asks: [{ price: 1.1002, volume: 10 }],
    });

    const { result } = renderHook(() => useLiveOrderBook('EURUSD', 10));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const binaryCb = mocks.binaryListeners[0];
    expect(binaryCb).toBeDefined();

    const count = 20_000;
    const frames: DecodedBinaryDepth[] = Array.from({ length: count }, (_, i) => ({
      symbol: 'EURUSD',
      timestamp: 1_700_000_000_000 + i,
      sequence: i + 1,
      bids: [{ price: 1.1 + (i % 100) * 0.00001, volume: 10 + (i % 5), total: 10 + (i % 5) }],
      asks: [{ price: 1.1002 + (i % 100) * 0.00001, volume: 10 + (i % 5), total: 10 + (i % 5) }],
      spread: 0.0002,
    }));

    const start = performance.now();
    act(() => {
      for (let i = 0; i < count; i += 1) {
        binaryCb(frames[i]);
      }
    });
    const totalMs = performance.now() - start;
    const usPerUpdate = (totalMs * 1000) / count;
    const lastPrice = result.current.orderBook?.bids[0]?.price ?? 0;

    console.log(
      `[P18S-BENCH][binary] updates=${count} totalMs=${totalMs.toFixed(3)} usPerUpdate=${usPerUpdate.toFixed(3)}`,
    );

    expect(totalMs).toBeGreaterThanOrEqual(0);
    expect(lastPrice).toBeGreaterThan(0);
  }, 60_000);

  it('measures 20,000 consecutive WebSocket depth updates of the current symbol', async () => {
    mocks.fetchMarketDataJson.mockResolvedValueOnce({
      symbol: 'EURUSD',
      bids: [{ price: 1.1, volume: 10 }],
      asks: [{ price: 1.1002, volume: 10 }],
    });

    const { result } = renderHook(() => useLiveOrderBook('EURUSD', 10));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const wsCb = mocks.wsListeners[0];
    expect(wsCb).toBeDefined();

    const count = 20_000;
    const messages = Array.from({ length: count }, (_, i) => ({
      symbol: 'EURUSD',
      bids: [{ price: 1.1 + (i % 100) * 0.00001, volume: 10 + (i % 5) }],
      asks: [{ price: 1.1002 + (i % 100) * 0.00001, volume: 10 + (i % 5) }],
      timestamp: 1_700_000_000_000 + i,
    }));

    const start = performance.now();
    act(() => {
      for (let i = 0; i < count; i += 1) {
        wsCb(messages[i]);
      }
    });
    const totalMs = performance.now() - start;
    const usPerUpdate = (totalMs * 1000) / count;
    const lastPrice = result.current.orderBook?.bids[0]?.price ?? 0;

    console.log(
      `[P18S-BENCH][ws] updates=${count} totalMs=${totalMs.toFixed(3)} usPerUpdate=${usPerUpdate.toFixed(3)}`,
    );

    expect(totalMs).toBeGreaterThanOrEqual(0);
    expect(lastPrice).toBeGreaterThan(0);
  }, 60_000);
});
