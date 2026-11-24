// @vitest-environment jsdom

import React, { Profiler } from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import {
  resetAccountSpreadMarkupForTests,
  setAccountSpreadMarkups,
} from '../../services/accountSpreadMarkup';
import type { DecodedBinaryDepth } from '../../services/binaryTcpMarketStream';
import { emitSessionChange } from '../../services/brokerSession';
import { useAppStore } from '../../store/useAppStore';
import { buildSpreadMarkupMap } from '../../utils/spreadMarkup';
import { normalizeOrderBook } from './marketDataNormalization';
import type { LiveOrderBook } from './marketDataTypes';
import { useLiveOrderBook } from './useLiveOrderBook';

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

const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

type BinaryDepthCb = (decoded: DecodedBinaryDepth) => void;
type WsDepthCb = (message: unknown) => void;

const mocks = vi.hoisted(() => {
  const fetchMarketDataJson = vi.fn();
  const binarySupported = { value: false };
  const binaryLatestDepths = new Map<string, DecodedBinaryDepth>();
  const binaryActiveListeners = new Map<string, Set<BinaryDepthCb>>();
  const binaryCapturedListeners: Array<{ symbol: string; cb: BinaryDepthCb; unsub: ReturnType<typeof vi.fn> }> = [];
  const wsActiveListeners = new Map<string, Set<WsDepthCb>>();
  const wsCapturedListeners: Array<{ channel: string; cb: WsDepthCb; unsub: ReturnType<typeof vi.fn> }> = [];
  const wsConnect = vi.fn();

  return {
    fetchMarketDataJson,
    binarySupported,
    binaryLatestDepths,
    binaryActiveListeners,
    binaryCapturedListeners,
    wsActiveListeners,
    wsCapturedListeners,
    wsConnect,
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
    getLatestDepth: (symbol: string) => mocks.binaryLatestDepths.get(symbol.trim().toUpperCase()) ?? null,
    onDepth: (symbol: string, cb: BinaryDepthCb) => {
      const normalized = symbol.trim().toUpperCase();
      let set = mocks.binaryActiveListeners.get(normalized);
      if (!set) {
        set = new Set();
        mocks.binaryActiveListeners.set(normalized, set);
      }
      set.add(cb);
      const unsub = vi.fn(() => {
        set?.delete(cb);
      });
      mocks.binaryCapturedListeners.push({ symbol: normalized, cb, unsub });
      return unsub;
    },
  },
}));

vi.mock('../../services/websocket-enhanced', () => ({
  getEnhancedWebSocketService: () => ({
    connect: mocks.wsConnect,
    subscribe: (channel: string, cb: WsDepthCb) => {
      let set = mocks.wsActiveListeners.get(channel);
      if (!set) {
        set = new Set();
        mocks.wsActiveListeners.set(channel, set);
      }
      set.add(cb);
      const unsub = vi.fn(() => {
        set?.delete(cb);
      });
      mocks.wsCapturedListeners.push({ channel, cb, unsub });
      return unsub;
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

const makeRestBook = (symbol: string, bid: number, ask: number, volume = 10) => ({
  symbol,
  bids: [
    { price: bid, volume },
    { price: Number((bid - 0.0001).toFixed(5)), volume: volume + 5 },
  ],
  asks: [
    { price: ask, volume },
    { price: Number((ask + 0.0001).toFixed(5)), volume: volume + 5 },
  ],
  timestamp: 1_700_000_000_000,
});

const makeBinaryDepth = (
  symbol: string,
  bid: number,
  ask: number,
  sequence: number,
  volume = 10,
): DecodedBinaryDepth => ({
  symbol,
  timestamp: 1_700_000_000_000 + sequence,
  sequence,
  bids: [
    { price: bid, volume, total: volume },
    { price: Number((bid - 0.0001).toFixed(5)), volume: volume + 5, total: volume * 2 + 5 },
  ],
  asks: [
    { price: ask, volume, total: volume },
    { price: Number((ask + 0.0001).toFixed(5)), volume: volume + 5, total: volume * 2 + 5 },
  ],
  spread: Number((ask - bid).toFixed(5)),
});

const makeWsMessage = (symbol: string, bid: number, ask: number, volume = 10, tsOffset = 1) => ({
  symbol,
  bids: [
    { price: bid, volume },
    { price: Number((bid - 0.0001).toFixed(5)), volume: volume + 5 },
  ],
  asks: [
    { price: ask, volume },
    { price: Number((ask + 0.0001).toFixed(5)), volume: volume + 5 },
  ],
  timestamp: 1_700_000_000_000 + tsOffset,
});

interface RenderObservation {
  symbol: string;
  orderBook: LiveOrderBook | null;
  loading: boolean;
  error: string | null;
}

function renderTrackedBook(initialSymbol: string, depth = 10) {
  const observations: RenderObservation[] = [];
  const hook = renderHook(
    ({ sym, d }: { sym: string; d: number }) => {
      const value = useLiveOrderBook(sym, d);
      observations.push({
        symbol: sym.trim().toUpperCase(),
        orderBook: value.orderBook,
        loading: value.loading,
        error: value.error,
      });
      return value;
    },
    { initialProps: { sym: initialSymbol, d: depth } },
  );
  return { ...hook, observations };
}

describe('P18S useLiveOrderBook cross-symbol isolation & pins', () => {
  beforeEach(() => {
    mocks.fetchMarketDataJson.mockReset();
    mocks.wsConnect.mockReset();
    mocks.binarySupported.value = false;
    mocks.binaryLatestDepths.clear();
    mocks.binaryActiveListeners.clear();
    mocks.binaryCapturedListeners.length = 0;
    mocks.wsActiveListeners.clear();
    mocks.wsCapturedListeners.length = 0;

    resetAccountSpreadMarkupForTests();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '1001',
      authToken: 'test-token-1',
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
    vi.restoreAllMocks();
  });

  it('S1/S2: switching from loaded A to uncached B clears A book immediately on the first B render and keeps loading=true, error=null', async () => {
    const restA = createDeferred<unknown>();
    const restB = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA.promise)
      .mockReturnValueOnce(restB.promise);

    const { result, rerender, observations } = renderTrackedBook('EURUSD');
    restA.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('EURUSD');

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();

    const bObservations = observations.slice(countBeforeSwitch);
    expect(bObservations.length).toBeGreaterThanOrEqual(1);
    for (const obs of bObservations) {
      expect(obs.orderBook === null || obs.orderBook.symbol === 'GBPUSD').toBe(true);
      expect(obs.orderBook === null || obs.orderBook.bids[0]?.price !== 1.1).toBe(true);
      expect(obs.error).toBeNull();
    }

    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('S2: switching from errored A to uncached B clears A error immediately on the first B render', async () => {
    const restA = createDeferred<unknown>();
    const restB = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA.promise)
      .mockReturnValueOnce(restB.promise);

    const { result, rerender, observations } = renderTrackedBook('EURUSD');
    restA.reject(new ApiError(500, 'EURUSD depth failed'));
    await waitFor(() => expect(result.current.error).toBe('EURUSD depth failed'));

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();

    const bObservations = observations.slice(countBeforeSwitch);
    expect(bObservations.length).toBeGreaterThanOrEqual(1);
    for (const obs of bObservations) {
      expect(obs.error).toBeNull();
      expect(obs.orderBook === null || obs.orderBook.symbol === 'GBPUSD').toBe(true);
      expect(obs.orderBook).toBeNull();
    }

    expect(result.current.error).toBeNull();
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('S1/S2/S3: late REST answer for A while B is pending does not overwrite B state, then B answer succeeds', async () => {
    const restA = createDeferred<unknown>();
    const restB = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA.promise)
      .mockReturnValueOnce(restB.promise);

    const { result, rerender, observations } = renderTrackedBook('EURUSD');
    const countBeforeSwitch = observations.length;
    rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();

    restA.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await flushMicrotasks();

    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    restB.resolve(makeRestBook('GBPUSD', 1.27, 1.2702));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('GBPUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.27);
    expect(result.current.error).toBeNull();

    const bObservations = observations.slice(countBeforeSwitch);
    expect(bObservations.length).toBeGreaterThanOrEqual(1);
    for (const obs of bObservations) {
      expect(obs.orderBook === null || (obs.orderBook.symbol === 'GBPUSD' && obs.orderBook.bids[0]?.price === 1.27)).toBe(true);
      expect(obs.orderBook?.bids[0]?.price).not.toBe(1.1);
    }
  });

  it('S1/S2/S3: late REST rejection for A while B is pending does not set error or clear loading for B', async () => {
    const restA = createDeferred<unknown>();
    const restB = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA.promise)
      .mockReturnValueOnce(restB.promise);

    const { result, rerender } = renderTrackedBook('EURUSD');
    rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();

    restA.reject(new ApiError(503, 'EURUSD unavailable'));
    await flushMicrotasks();

    expect(result.current.orderBook).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('S1/S2/S3: late REST rejection for A when A has cached binary depth does not fall back to A cache under B', async () => {
    mocks.binarySupported.value = true;
    mocks.binaryLatestDepths.set('EURUSD', makeBinaryDepth('EURUSD', 1.1, 1.1002, 1));

    const restA = createDeferred<unknown>();
    const restB = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA.promise)
      .mockReturnValueOnce(restB.promise);

    const { result, rerender } = renderTrackedBook('EURUSD');
    expect(result.current.orderBook?.symbol).toBe('EURUSD');

    rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);

    restA.reject(new ApiError(501, 'DEPTH_UNSUPPORTED'));
    await flushMicrotasks();

    expect(result.current.orderBook).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('S1/S3: B answers first, then late A REST resolves or rejects without disturbing B', async () => {
    // Part 1: late A resolves after B resolved
    const restA1 = createDeferred<unknown>();
    const restB1 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA1.promise)
      .mockReturnValueOnce(restB1.promise);

    const h1 = renderTrackedBook('EURUSD');
    h1.rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();

    restB1.resolve(makeRestBook('GBPUSD', 1.27, 1.2702));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));
    expect(h1.result.current.orderBook?.symbol).toBe('GBPUSD');

    restA1.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await flushMicrotasks();

    expect(h1.result.current.orderBook?.symbol).toBe('GBPUSD');
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(1.27);
    expect(h1.result.current.error).toBeNull();
    expect(h1.result.current.loading).toBe(false);
    h1.unmount();

    // Part 2: late A rejects after B resolved
    mocks.fetchMarketDataJson.mockReset();
    const restA2 = createDeferred<unknown>();
    const restB2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA2.promise)
      .mockReturnValueOnce(restB2.promise);

    const h2 = renderTrackedBook('EURUSD');
    h2.rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();

    restB2.resolve(makeRestBook('GBPUSD', 1.28, 1.2802));
    await waitFor(() => expect(h2.result.current.loading).toBe(false));

    restA2.reject(new ApiError(500, 'late EURUSD failure'));
    await flushMicrotasks();

    expect(h2.result.current.orderBook?.symbol).toBe('GBPUSD');
    expect(h2.result.current.orderBook?.bids[0]?.price).toBe(1.28);
    expect(h2.result.current.error).toBeNull();
    expect(h2.result.current.loading).toBe(false);
  });

  it('S3: two reloads for the SAME symbol answered in reverse order: latest request wins and stale rejection/loading is ignored', async () => {
    const req1 = createDeferred<unknown>();
    const req2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(req1.promise)
      .mockReturnValueOnce(req2.promise);

    const { result } = renderTrackedBook('EURUSD');
    expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(1);

    let reloadPromise!: Promise<void>;
    act(() => {
      reloadPromise = result.current.reload();
    });
    expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(2);

    // Latest request settles first
    req2.resolve(makeRestBook('EURUSD', 1.2, 1.2002));
    await act(async () => {
      await reloadPromise;
    });
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.2);
    expect(result.current.loading).toBe(false);

    // Stale first request resolves late with older price
    req1.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await flushMicrotasks();

    expect(result.current.orderBook?.bids[0]?.price).toBe(1.2);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);

    // Also test stale rejection after newer success + stale settlement while newer is pending
    mocks.fetchMarketDataJson.mockReset();
    const req3 = createDeferred<unknown>();
    const req4 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(req3.promise)
      .mockReturnValueOnce(req4.promise);

    let reload3!: Promise<void>;
    let reload4!: Promise<void>;
    act(() => {
      reload3 = result.current.reload();
    });
    act(() => {
      reload4 = result.current.reload();
    });
    expect(result.current.loading).toBe(true);

    // Stale req3 rejects while req4 is still pending -> loading stays true, error stays null
    req3.reject(new ApiError(500, 'stale failure'));
    await act(async () => {
      await reload3;
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    req4.resolve(makeRestBook('EURUSD', 1.25, 1.2502));
    await act(async () => {
      await reload4;
    });
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.25);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('S1/S3: captured binary depth callback for A delivered after switch to B changes nothing', async () => {
    mocks.binarySupported.value = true;
    const restA = createDeferred<unknown>();
    const restB = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA.promise)
      .mockReturnValueOnce(restB.promise);

    const { result, rerender } = renderTrackedBook('EURUSD');
    const capturedA = mocks.binaryCapturedListeners.find((entry) => entry.symbol === 'EURUSD');
    expect(capturedA).toBeDefined();

    rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);

    // Deliver captured A callback while B is pending
    act(() => {
      capturedA!.cb(makeBinaryDepth('EURUSD', 1.11111, 1.11131, 10));
    });
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);

    // Resolve B, then deliver captured A callback again
    restB.resolve(makeRestBook('GBPUSD', 1.27, 1.2702));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      capturedA!.cb(makeBinaryDepth('EURUSD', 1.12222, 1.12242, 11));
    });
    expect(result.current.orderBook?.symbol).toBe('GBPUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.27);
  });

  it('S1/S3: captured WebSocket callback for depth.A delivered after switch to B changes nothing', async () => {
    const restA = createDeferred<unknown>();
    const restB = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA.promise)
      .mockReturnValueOnce(restB.promise);

    const { result, rerender } = renderTrackedBook('EURUSD');
    const capturedWsA = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.EURUSD');
    expect(capturedWsA).toBeDefined();

    rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();
    expect(result.current.orderBook).toBeNull();

    // Deliver captured WS callback for A while B is pending
    act(() => {
      capturedWsA!.cb(makeWsMessage('EURUSD', 1.11111, 1.11131));
    });
    expect(result.current.orderBook).toBeNull();

    // Resolve B, then deliver captured WS callback for A again
    restB.resolve(makeRestBook('GBPUSD', 1.27, 1.2702));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      capturedWsA!.cb(makeWsMessage('EURUSD', 1.12222, 1.12242));
    });
    expect(result.current.orderBook?.symbol).toBe('GBPUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.27);
  });

  it('PIN (normalization): normalizeOrderBook preserves payload.symbol when it differs from fallbackSymbol', () => {
    const normalized = normalizeOrderBook(
      makeWsMessage('EURUSD', 1.1, 1.1002),
      'GBPUSD',
    );
    expect(normalized?.symbol).toBe('EURUSD');
  });

  it("S1' PIN (i) [WS]: message on current WebSocket channel depth.XAUUSD.VIP whose payload names parent XAUUSD is shown with payload symbol preserved", async () => {
    const restDerived = createDeferred<unknown>();
    mocks.fetchMarketDataJson.mockReturnValueOnce(restDerived.promise);

    const { result } = renderTrackedBook('XAUUSD.VIP');
    const wsDerived = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.XAUUSD.VIP');
    expect(wsDerived).toBeDefined();

    act(() => {
      wsDerived!.cb(makeWsMessage('XAUUSD', 2650.5, 2650.8, 25, 1));
    });

    expect(result.current.orderBook).not.toBeNull();
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2650.5);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(25);
    expect(result.current.orderBook?.asks[0]?.price).toBe(2650.8);

    act(() => {
      wsDerived!.cb(makeWsMessage('XAUUSD', 2651.2, 2651.5, 28, 2));
    });

    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2651.2);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(28);
  });

  it("S1' PIN (i) [REST]: REST answer to current request for XAUUSD.VIP whose payload names parent XAUUSD is shown with payload symbol preserved", async () => {
    const restDerived = createDeferred<unknown>();
    mocks.fetchMarketDataJson.mockReturnValueOnce(restDerived.promise);

    const { result } = renderTrackedBook('XAUUSD.VIP');
    restDerived.resolve(makeRestBook('XAUUSD', 2660.1, 2660.4, 30));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.orderBook).not.toBeNull();
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2660.1);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(30);
    expect(result.current.orderBook?.asks[0]?.price).toBe(2660.4);
    expect(result.current.error).toBeNull();
  });

  it('S1/S2: warm cache switch A -> B never renders A under B and shows B cached book immediately after effects', async () => {
    mocks.binarySupported.value = true;
    mocks.binaryLatestDepths.set('EURUSD', makeBinaryDepth('EURUSD', 1.1, 1.1002, 1));
    mocks.binaryLatestDepths.set('GBPUSD', makeBinaryDepth('GBPUSD', 1.27, 1.2702, 2));

    const restA = createDeferred<unknown>();
    const restB = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA.promise)
      .mockReturnValueOnce(restB.promise);

    const { result, rerender, observations } = renderTrackedBook('EURUSD');
    restA.resolve(makeRestBook('EURUSD', 1.10005, 1.10025));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('EURUSD');

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();

    const bObservations = observations.slice(countBeforeSwitch);
    expect(bObservations.length).toBeGreaterThanOrEqual(1);
    for (const obs of bObservations) {
      expect(obs.orderBook === null || obs.orderBook.symbol === 'GBPUSD').toBe(true);
      expect(obs.orderBook === null || obs.orderBook.bids[0]?.price === 1.27).toBe(true);
    }

    expect(result.current.orderBook?.symbol).toBe('GBPUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.27);
    expect(result.current.error).toBeNull();
  });

  it.each([
    ['A1', 'B', 'A2'],
    ['A1', 'A2', 'B'],
    ['B', 'A1', 'A2'],
    ['B', 'A2', 'A1'],
    ['A2', 'A1', 'B'],
    ['A2', 'B', 'A1'],
  ] as const)(
    'S1/S3: rapid A -> B -> A with settlement order [%s, %s, %s] never exposes wrong symbol and ends on A2',
    async (first, second, third) => {
      const requests = {
        A1: createDeferred<unknown>(),
        B: createDeferred<unknown>(),
        A2: createDeferred<unknown>(),
      };
      const payloads = {
        A1: makeRestBook('EURUSD', 1.10001, 1.10021),
        B: makeRestBook('GBPUSD', 1.27002, 1.27022),
        A2: makeRestBook('EURUSD', 1.10003, 1.10023),
      };

      mocks.fetchMarketDataJson
        .mockReturnValueOnce(requests.A1.promise)
        .mockReturnValueOnce(requests.B.promise)
        .mockReturnValueOnce(requests.A2.promise);

      const { result, rerender, observations } = renderTrackedBook('EURUSD');
      rerender({ sym: 'GBPUSD', d: 10 });
      rerender({ sym: 'EURUSD', d: 10 });
      await flushMicrotasks();

      for (const key of [first, second, third]) {
        requests[key].resolve(payloads[key]);
        await flushMicrotasks();
      }

      for (const obs of observations) {
        expect(obs.orderBook === null || obs.orderBook.symbol === obs.symbol).toBe(true);
        if (obs.orderBook !== null) {
          const bid = obs.orderBook.bids[0]?.price;
          expect(obs.symbol === 'EURUSD' ? bid === 1.10003 : bid === 1.27002).toBe(true);
        }
      }

      expect(result.current.orderBook?.symbol).toBe('EURUSD');
      expect(result.current.orderBook?.bids[0]?.price).toBe(1.10003);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    },
  );

  it('S3: session change while REST is pending ignores old-session REST and callbacks', async () => {
    mocks.binarySupported.value = true;
    const rest1 = createDeferred<unknown>();
    const rest2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(rest2.promise);

    const { result } = renderTrackedBook('EURUSD');
    const oldBinary = mocks.binaryCapturedListeners[0];
    const oldWs = mocks.wsCapturedListeners[0];
    expect(oldBinary).toBeDefined();
    expect(oldWs).toBeDefined();

    act(() => {
      emitSessionChange('broker_url_change');
    });
    await flushMicrotasks();
    expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(2);

    // Settle old-session REST + callbacks
    rest1.resolve(makeRestBook('EURUSD', 1.10001, 1.10021));
    await flushMicrotasks();
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);

    act(() => {
      oldBinary.cb(makeBinaryDepth('EURUSD', 1.10002, 1.10022, 1));
      oldWs.cb(makeWsMessage('EURUSD', 1.10003, 1.10023));
    });
    expect(result.current.orderBook).toBeNull();

    // New-session REST settles
    rest2.resolve(makeRestBook('EURUSD', 1.105, 1.1052));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.105);
  });

  it('S3/S5: logout while REST is pending ignores late REST answer; re-login loads cleanly', async () => {
    const rest1 = createDeferred<unknown>();
    const rest2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(rest2.promise);

    const { result } = renderTrackedBook('EURUSD');
    expect(result.current.loading).toBe(true);

    act(() => {
      useAppStore.setState({ isAuthenticated: false, authToken: null });
    });
    await flushMicrotasks();
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    // Late REST answer from pre-logout session
    rest1.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await flushMicrotasks();
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    // Re-login
    act(() => {
      useAppStore.setState({ isAuthenticated: true, authToken: 'test-token-2' });
    });
    await flushMicrotasks();
    expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(2);

    rest2.resolve(makeRestBook('EURUSD', 1.11, 1.1102));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('EURUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.11);
  });

  it('S5 PIN: unmount while REST is pending unsubscribes listeners and emits no state update warnings on late settle', async () => {
    mocks.binarySupported.value = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const rest1 = createDeferred<unknown>();
    mocks.fetchMarketDataJson.mockReturnValueOnce(rest1.promise);
    const h1 = renderTrackedBook('EURUSD');
    const bin1 = mocks.binaryCapturedListeners[0];
    const ws1 = mocks.wsCapturedListeners[0];

    h1.unmount();
    expect(bin1.unsub).toHaveBeenCalledTimes(1);
    expect(ws1.unsub).toHaveBeenCalledTimes(1);

    rest1.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await flushMicrotasks();
    act(() => {
      bin1.cb(makeBinaryDepth('EURUSD', 1.101, 1.1012, 1));
      ws1.cb(makeWsMessage('EURUSD', 1.102, 1.1022));
    });

    // Also verify late rejection after unmount
    const rest2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson.mockReturnValueOnce(rest2.promise);
    const h2 = renderTrackedBook('GBPUSD');
    h2.unmount();
    rest2.reject(new ApiError(500, 'late error'));
    await flushMicrotasks();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('S4 PIN: 1,000 consecutive binary depth updates on current symbol match baseline renders, commits, and object identities', async () => {
    mocks.binarySupported.value = true;
    const restInit = createDeferred<unknown>();
    mocks.fetchMarketDataJson.mockReturnValueOnce(restInit.promise);

    let renders = 0;
    let commits = 0;
    let latestBook: LiveOrderBook | null = null;

    function Harness({ sym, tick }: { sym: string; tick: number }) {
      void tick;
      renders += 1;
      const value = useLiveOrderBook(sym, 10);
      latestBook = value.orderBook;
      return null;
    }

    const view = render(
      <Profiler
        id="binary-hot-path"
        onRender={() => {
          commits += 1;
        }}
      >
        <Harness sym="EURUSD" tick={0} />
      </Profiler>,
    );

    restInit.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await waitFor(() => expect(latestBook?.symbol).toBe('EURUSD'));

    const binaryCb = mocks.binaryCapturedListeners.find((entry) => entry.symbol === 'EURUSD')?.cb;
    expect(binaryCb).toBeDefined();

    const frames: DecodedBinaryDepth[] = Array.from({ length: 1000 }, (_, i) =>
      makeBinaryDepth('EURUSD', Number((1.1 + i * 0.00001).toFixed(5)), Number((1.1002 + i * 0.00001).toFixed(5)), i + 1),
    );

    renders = 0;
    commits = 0;
    const seenBookRefs = new Set<LiveOrderBook>();

    for (let i = 0; i < 1000; i += 1) {
      act(() => {
        binaryCb!(frames[i]);
      });
      if (latestBook) {
        seenBookRefs.add(latestBook);
      }
    }

    expect(renders).toBe(1000);
    expect(commits).toBe(1000);
    expect(seenBookRefs.size).toBe(1000);

    // No-op parent rerender preserves memoized orderBook identity
    const bookBeforeNoop = latestBook;
    view.rerender(
      <Profiler
        id="binary-hot-path"
        onRender={() => {
          commits += 1;
        }}
      >
        <Harness sym="EURUSD" tick={1} />
      </Profiler>,
    );
    expect(latestBook).toBe(bookBeforeNoop);
  }, 30_000);

  it('S4 PIN: 1,000 consecutive WebSocket depth updates on current symbol match baseline renders, commits, and object identities', async () => {
    const restInit = createDeferred<unknown>();
    mocks.fetchMarketDataJson.mockReturnValueOnce(restInit.promise);

    let renders = 0;
    let commits = 0;
    let latestBook: LiveOrderBook | null = null;

    function Harness({ sym, tick }: { sym: string; tick: number }) {
      void tick;
      renders += 1;
      const value = useLiveOrderBook(sym, 10);
      latestBook = value.orderBook;
      return null;
    }

    const view = render(
      <Profiler
        id="ws-hot-path"
        onRender={() => {
          commits += 1;
        }}
      >
        <Harness sym="EURUSD" tick={0} />
      </Profiler>,
    );

    restInit.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await waitFor(() => expect(latestBook?.symbol).toBe('EURUSD'));

    const wsCb = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.EURUSD')?.cb;
    expect(wsCb).toBeDefined();

    const messages = Array.from({ length: 1000 }, (_, i) =>
      makeWsMessage('EURUSD', Number((1.1 + i * 0.00001).toFixed(5)), Number((1.1002 + i * 0.00001).toFixed(5)), 10, i + 1),
    );

    renders = 0;
    commits = 0;
    const seenBookRefs = new Set<LiveOrderBook>();

    for (let i = 0; i < 1000; i += 1) {
      act(() => {
        wsCb!(messages[i]);
      });
      if (latestBook) {
        seenBookRefs.add(latestBook);
      }
    }

    expect(renders).toBe(1000);
    expect(commits).toBe(1000);
    expect(seenBookRefs.size).toBe(1000);

    const bookBeforeNoop = latestBook;
    view.rerender(
      <Profiler
        id="ws-hot-path"
        onRender={() => {
          commits += 1;
        }}
      >
        <Harness sym="EURUSD" tick={1} />
      </Profiler>,
    );
    expect(latestBook).toBe(bookBeforeNoop);
  }, 30_000);

  describe('S5 PINS: unchanged behavior for single-symbol lifecycle, P01 markup, errors, fallback, and empty symbol', () => {
    it('applies P01 spread markup to orderBook levels and spread', async () => {
      setAccountSpreadMarkups(
        '1001',
        buildSpreadMarkupMap([
          { symbol: 'EURUSD', spreadMarkup: 5, tickSize: 0.00001, digits: 5 },
        ]),
      );
      mocks.fetchMarketDataJson.mockResolvedValueOnce({
        symbol: 'EURUSD',
        bids: [
          { price: 1.1, volume: 1 },
          { price: 1.09999, volume: 2 },
        ],
        asks: [
          { price: 1.10012, volume: 1 },
          { price: 1.10013, volume: 3 },
        ],
      });

      const { result } = renderTrackedBook('EURUSD', 5);
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.orderBook?.bids.map((l) => l.price)).toEqual([1.09997, 1.09996]);
      expect(result.current.orderBook?.asks.map((l) => l.price)).toEqual([1.10014, 1.10015]);
      expect(result.current.orderBook?.spread).toBe(0.00017);
    });

    it('first load transitions from loading=true/book=null/error=null to loading=false/book/error=null', async () => {
      const rest = createDeferred<unknown>();
      mocks.fetchMarketDataJson.mockReturnValueOnce(rest.promise);

      const { result } = renderTrackedBook('EURUSD');
      expect(result.current.loading).toBe(true);
      expect(result.current.orderBook).toBeNull();
      expect(result.current.error).toBeNull();

      rest.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.symbol).toBe('EURUSD');
      expect(result.current.error).toBeNull();
    });

    it('REST error sets ApiError message or fallback message and clears orderBook', async () => {
      mocks.fetchMarketDataJson.mockRejectedValueOnce(new ApiError(502, 'Depth unavailable'));
      const h1 = renderTrackedBook('EURUSD');
      await waitFor(() => expect(h1.result.current.loading).toBe(false));
      expect(h1.result.current.orderBook).toBeNull();
      expect(h1.result.current.error).toBe('Depth unavailable');
      h1.unmount();

      mocks.fetchMarketDataJson.mockRejectedValueOnce(new Error('network boom'));
      const h2 = renderTrackedBook('EURUSD');
      await waitFor(() => expect(h2.result.current.loading).toBe(false));
      expect(h2.result.current.orderBook).toBeNull();
      expect(h2.result.current.error).toBe('Failed to load order book');
    });

    it('REST error falls back to cached binary depth for the same symbol with error=null', async () => {
      mocks.binarySupported.value = true;
      mocks.binaryLatestDepths.set('EURUSD', makeBinaryDepth('EURUSD', 1.1, 1.1002, 1));
      mocks.fetchMarketDataJson.mockRejectedValueOnce(new ApiError(501, 'DEPTH_UNSUPPORTED'));

      const { result } = renderTrackedBook('EURUSD');
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.orderBook?.symbol).toBe('EURUSD');
      expect(result.current.orderBook?.bids[0]?.price).toBe(1.1);
      expect(result.current.error).toBeNull();
    });

    it('empty or whitespace symbol returns null/false/null with zero REST calls and clears when switching from loaded symbol', async () => {
      const h1 = renderTrackedBook('   ');
      await flushMicrotasks();
      expect(h1.result.current.orderBook).toBeNull();
      expect(h1.result.current.loading).toBe(false);
      expect(h1.result.current.error).toBeNull();
      expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(0);
      h1.unmount();

      mocks.fetchMarketDataJson.mockResolvedValueOnce(makeRestBook('EURUSD', 1.1, 1.1002));
      const h2 = renderTrackedBook('EURUSD');
      await waitFor(() => expect(h2.result.current.loading).toBe(false));
      expect(h2.result.current.orderBook?.symbol).toBe('EURUSD');

      h2.rerender({ sym: '', d: 10 });
      await flushMicrotasks();
      expect(h2.result.current.orderBook).toBeNull();
      expect(h2.result.current.loading).toBe(false);
      expect(h2.result.current.error).toBeNull();
      expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(1);
    });
  });
});
