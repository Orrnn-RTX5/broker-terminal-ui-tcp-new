// @vitest-environment jsdom

import React, { Profiler } from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { resetAccountSpreadMarkupForTests } from '../../services/accountSpreadMarkup';
import type { DecodedBinaryDepth } from '../../services/binaryTcpMarketStream';
import { emitSessionChange } from '../../services/brokerSession';
import { useAppStore } from '../../store/useAppStore';
import { DepthOfMarket } from '../../components/DepthOfMarket';
import { OrderPanelDialog } from '../../components/OrderPanelDialog';
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
  const binaryCapturedListeners: Array<{ symbol: string; cb: BinaryDepthCb; unsub: ReturnType<typeof vi.fn> }> = [];
  const wsCapturedListeners: Array<{ channel: string; cb: WsDepthCb; unsub: ReturnType<typeof vi.fn> }> = [];
  const wsConnect = vi.fn();

  return {
    fetchMarketDataJson,
    binarySupported,
    binaryLatestDepths,
    binaryCapturedListeners,
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
      const unsub = vi.fn();
      mocks.binaryCapturedListeners.push({ symbol: normalized, cb, unsub });
      return unsub;
    },
  },
}));

vi.mock('../../services/websocket-enhanced', () => ({
  getEnhancedWebSocketService: () => ({
    connect: mocks.wsConnect,
    subscribe: (channel: string, cb: WsDepthCb) => {
      const unsub = vi.fn();
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

vi.mock('../../store/useMarketDataStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/useMarketDataStore')>();
  return {
    ...actual,
    useCurrentTick: () => null,
  };
});

vi.mock('../../hooks/useUiTranslation', () => ({
  useUiTranslation: () => (text: string) => text,
}));

vi.mock('../../hooks/useSymbolMarketStatus', () => ({
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

const makeRestBook = (symbol: string, bid: number, ask: number, volume = 10, levels = 2) => ({
  symbol,
  bids: Array.from({ length: levels }, (_, i) => ({
    price: Number((bid - i * 0.0001).toFixed(5)),
    volume: volume + i * 5,
  })),
  asks: Array.from({ length: levels }, (_, i) => ({
    price: Number((ask + i * 0.0001).toFixed(5)),
    volume: volume + i * 5,
  })),
  timestamp: 1_700_000_000_000,
});

const makeBinaryDepth = (
  symbol: string,
  bid: number,
  ask: number,
  sequence: number,
  volume = 10,
  levels = 2,
): DecodedBinaryDepth => ({
  symbol,
  timestamp: 1_700_000_000_000 + sequence,
  sequence,
  bids: Array.from({ length: levels }, (_, i) => ({
    price: Number((bid - i * 0.0001).toFixed(5)),
    volume: volume + i * 5,
    total: (volume + i * 5) * (i + 1),
  })),
  asks: Array.from({ length: levels }, (_, i) => ({
    price: Number((ask + i * 0.0001).toFixed(5)),
    volume: volume + i * 5,
    total: (volume + i * 5) * (i + 1),
  })),
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

function renderTrackedBook(initialSymbol: string, depth = 10, strictMode = false) {
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
    { initialProps: { sym: initialSymbol, d: depth }, reactStrictMode: strictMode },
  );
  return { ...hook, observations };
}

describe('P18S session reasons & token rotation ownership', () => {
  beforeEach(() => {
    mocks.fetchMarketDataJson.mockReset();
    mocks.wsConnect.mockReset();
    mocks.binarySupported.value = false;
    mocks.binaryLatestDepths.clear();
    mocks.binaryCapturedListeners.length = 0;
    mocks.wsCapturedListeners.length = 0;

    localStorage.clear();
    sessionStorage.clear();
    resetAccountSpreadMarkupForTests();
    useAppStore.getState().reset();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '1001',
      authToken: 'tok-1',
      refreshToken: 'ref-1',
    });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    resetAccountSpreadMarkupForTests();
    useAppStore.getState().reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('token rotation with loaded book (REST-only): never drops book or changes pre-effect loading/error, reloads and resubscribes as in baseline', async () => {
    const rest1 = createDeferred<unknown>();
    const rest2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(rest2.promise);

    const { result, observations } = renderTrackedBook('EURUSD');
    rest1.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const loadedBook = result.current.orderBook;
    expect(loadedBook).not.toBeNull();
    expect(loadedBook?.bids[0]?.price).toBe(1.1);
    const oldWs = mocks.wsCapturedListeners[0];
    expect(oldWs).toBeDefined();

    const obsBeforeRotation = observations.length;
    act(() => {
      useAppStore.getState().setAuthTokens('tok-2', 'ref-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();

    const afterRot = observations.slice(obsBeforeRotation);
    // Recorded baseline (Scenario A):
    // [3] pre-effect: book=book#1, loading=false, error=null
    // [4] post-effect: book=book#1, loading=true, error=null, rest=2, ws=2/unsub=1
    expect(afterRot.length).toBeGreaterThanOrEqual(2);
    expect(afterRot[0].orderBook).toBe(loadedBook);
    expect(afterRot[0].loading).toBe(false);
    expect(afterRot[0].error).toBeNull();
    for (const obs of afterRot) {
      expect(obs.orderBook).toBe(loadedBook);
      expect(obs.error).toBeNull();
    }
    expect(afterRot[afterRot.length - 1].loading).toBe(true);
    expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(2);
    expect(oldWs.unsub).toHaveBeenCalledTimes(1);
    expect(mocks.wsCapturedListeners).toHaveLength(2);
    expect(mocks.wsCapturedListeners[1].channel).toBe('depth.EURUSD');

    // Old pre-rotation WS callback is ignored
    act(() => {
      oldWs.cb(makeWsMessage('EURUSD', 1.05, 1.0502));
    });
    expect(result.current.orderBook).toBe(loadedBook);

    // New answer replaces the book
    rest2.resolve(makeRestBook('EURUSD', 1.2, 1.2002));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook).not.toBe(loadedBook);
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.2);
    expect(result.current.error).toBeNull();
  });

  it('token rotation with loaded book (binary-supported + cache): never renders null book, keeps loading=false and error=null, reloads and resubscribes', async () => {
    mocks.binarySupported.value = true;
    mocks.binaryLatestDepths.set('EURUSD', makeBinaryDepth('EURUSD', 1.11, 1.1102, 1, 10, 10));

    const rest1 = createDeferred<unknown>();
    const rest2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(rest2.promise);

    const { result, observations } = renderTrackedBook('EURUSD');
    rest1.resolve(makeRestBook('EURUSD', 1.12, 1.1202));
    await waitFor(() => expect(result.current.orderBook?.bids[0]?.price).toBe(1.12));
    expect(result.current.loading).toBe(false);

    const loadedBook = result.current.orderBook;
    const oldBin = mocks.binaryCapturedListeners[0];
    const oldWs = mocks.wsCapturedListeners[0];
    expect(oldBin).toBeDefined();
    expect(oldWs).toBeDefined();

    const obsBeforeRotation = observations.length;
    act(() => {
      useAppStore.getState().setAuthTokens('tok-2', 'ref-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();

    const afterRot = observations.slice(obsBeforeRotation);
    // Recorded baseline (Scenario B):
    // [3] pre-effect: book=book#2 (1.12), loading=false, error=null
    // [4] post-effect: warm cached book (1.11), loading=false, error=null, rest=2, bin=2/unsub=1, ws=2/unsub=1
    expect(afterRot.length).toBeGreaterThanOrEqual(2);
    expect(afterRot[0].orderBook).toBe(loadedBook);
    expect(afterRot[0].loading).toBe(false);
    expect(afterRot[0].error).toBeNull();
    for (const obs of afterRot) {
      expect(obs.orderBook).not.toBeNull();
      expect(obs.loading).toBe(false);
      expect(obs.error).toBeNull();
    }

    expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(2);
    expect(oldBin.unsub).toHaveBeenCalledTimes(1);
    expect(oldWs.unsub).toHaveBeenCalledTimes(1);
    expect(mocks.binaryCapturedListeners).toHaveLength(2);
    expect(mocks.wsCapturedListeners).toHaveLength(2);

    // Old callbacks ignored
    act(() => {
      oldBin.cb(makeBinaryDepth('EURUSD', 1.01, 1.0102, 2));
      oldWs.cb(makeWsMessage('EURUSD', 1.02, 1.0202));
    });
    expect(result.current.orderBook?.bids[0]?.price).not.toBe(1.01);
    expect(result.current.orderBook?.bids[0]?.price).not.toBe(1.02);

    // Post-rotation REST replaces book, and new binary stream updates it
    rest2.resolve(makeRestBook('EURUSD', 1.22, 1.2202));
    await waitFor(() => expect(result.current.orderBook?.bids[0]?.price).toBe(1.22));
    act(() => {
      mocks.binaryCapturedListeners[1].cb(makeBinaryDepth('EURUSD', 1.23, 1.2302, 3));
    });
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.23);
  });

  it('token rotation with WebSocket path delivering right after rotation: keeps loaded book until WS arrives, ignores old WS', async () => {
    const rest1 = createDeferred<unknown>();
    const rest2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(rest2.promise);

    const { result, observations } = renderTrackedBook('EURUSD');
    rest1.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const loadedBook = result.current.orderBook;
    const oldWs = mocks.wsCapturedListeners[0];
    const obsBeforeRotation = observations.length;

    act(() => {
      useAppStore.getState().setAuthTokens('tok-2', 'ref-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();

    for (const obs of observations.slice(obsBeforeRotation)) {
      expect(obs.orderBook).toBe(loadedBook);
      expect(obs.error).toBeNull();
    }

    // Deliver WS on the newly subscribed channel immediately after rotation while rest2 is pending
    const newWs = mocks.wsCapturedListeners[1];
    expect(newWs).toBeDefined();
    act(() => {
      newWs.cb(makeWsMessage('EURUSD', 1.15, 1.1502, 25));
    });
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.15);
    expect(result.current.loading).toBe(true);

    // Stale pre-rotation WS message is ignored
    act(() => {
      oldWs.cb(makeWsMessage('EURUSD', 1.05, 1.0502, 99));
    });
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.15);

    rest2.resolve(makeRestBook('EURUSD', 1.16, 1.1602));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.16);
  });

  it('token rotation while first request is still pending: loading stays true and latest post-rotation request wins over stale first request', async () => {
    const rest1 = createDeferred<unknown>();
    const rest2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(rest2.promise);

    const { result, observations } = renderTrackedBook('EURUSD');
    expect(result.current.loading).toBe(true);
    expect(result.current.orderBook).toBeNull();

    const obsBeforeRotation = observations.length;
    act(() => {
      useAppStore.getState().setAuthTokens('tok-2', 'ref-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();

    // Baseline Scenario C: loading stays true, book stays null, rest2 issued
    for (const obs of observations.slice(obsBeforeRotation)) {
      expect(obs.orderBook).toBeNull();
      expect(obs.loading).toBe(true);
      expect(obs.error).toBeNull();
    }
    expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(2);

    // Under S3 ("latest request for the same symbol wins"), rest1 is superseded by rest2
    rest1.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await flushMicrotasks();
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);

    rest2.resolve(makeRestBook('EURUSD', 1.2, 1.2002));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.2);
    expect(result.current.error).toBeNull();
  });

  it('several token rotations in a row never drop the loaded book and latest request wins', async () => {
    const rest1 = createDeferred<unknown>();
    const rest2 = createDeferred<unknown>();
    const rest3 = createDeferred<unknown>();
    const rest4 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(rest2.promise)
      .mockReturnValueOnce(rest3.promise)
      .mockReturnValueOnce(rest4.promise);

    const { result, observations } = renderTrackedBook('EURUSD');
    rest1.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const loadedBook = result.current.orderBook;
    const obsStart = observations.length;

    act(() => {
      useAppStore.getState().setAuthTokens('tok-2', 'ref-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();
    act(() => {
      useAppStore.getState().setAuthToken('tok-3');
    });
    await flushMicrotasks();
    act(() => {
      useAppStore.getState().setAuthenticated(true, '1001', 'tok-4', 'ref-4');
    });
    await flushMicrotasks();

    expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(4);
    for (const obs of observations.slice(obsStart)) {
      expect(obs.orderBook).toBe(loadedBook);
      expect(obs.error).toBeNull();
    }

    // Superseded rest2 and rest3 settle out of order without disturbing loadedBook or loading
    rest3.resolve(makeRestBook('EURUSD', 1.3, 1.3002));
    rest2.reject(new ApiError(500, 'stale rotation error'));
    await flushMicrotasks();
    expect(result.current.orderBook).toBe(loadedBook);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    // Latest rest4 replaces loadedBook
    rest4.resolve(makeRestBook('EURUSD', 1.4, 1.4002));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.4);
  });

  it('token rotation followed at once by a symbol switch clears immediately on the switch and ignores old symbol answers', async () => {
    const restEur1 = createDeferred<unknown>();
    const restEur2 = createDeferred<unknown>();
    const restGbp = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restEur1.promise)
      .mockReturnValueOnce(restEur2.promise)
      .mockReturnValueOnce(restGbp.promise);

    const { result, rerender, observations } = renderTrackedBook('EURUSD');
    restEur1.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      useAppStore.getState().setAuthTokens('tok-2', 'ref-2', Date.now() + 3600_000);
    });
    const obsAtSwitch = observations.length;
    rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();

    const gbpObs = observations.slice(obsAtSwitch);
    expect(gbpObs.length).toBeGreaterThanOrEqual(1);
    expect(gbpObs[0].orderBook).toBeNull();
    expect(gbpObs[0].loading).toBe(true);
    expect(gbpObs[0].error).toBeNull();
    for (const obs of gbpObs) {
      expect(obs.orderBook).toBeNull();
      expect(obs.error).toBeNull();
    }

    // Late EURUSD post-rotation answer is ignored
    restEur2.resolve(makeRestBook('EURUSD', 1.15, 1.1502));
    await flushMicrotasks();
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);

    restGbp.resolve(makeRestBook('GBPUSD', 1.27, 1.2702));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('GBPUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.27);
  });

  it('symbol switch followed at once by a token rotation still never shows old symbol book', async () => {
    const restEur = createDeferred<unknown>();
    const restGbp1 = createDeferred<unknown>();
    const restGbp2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restEur.promise)
      .mockReturnValueOnce(restGbp1.promise)
      .mockReturnValueOnce(restGbp2.promise);

    const { result, rerender, observations } = renderTrackedBook('EURUSD');
    restEur.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const obsAtSwitch = observations.length;
    rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();
    act(() => {
      useAppStore.getState().setAuthTokens('tok-2', 'ref-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();

    for (const obs of observations.slice(obsAtSwitch)) {
      expect(obs.orderBook).toBeNull();
      expect(obs.loading).toBe(true);
      expect(obs.error).toBeNull();
    }

    // Superseded pre-rotation GBPUSD REST is dropped; post-rotation GBPUSD REST wins
    restGbp1.resolve(makeRestBook('GBPUSD', 1.25, 1.2502));
    await flushMicrotasks();
    expect(result.current.orderBook).toBeNull();

    restGbp2.resolve(makeRestBook('GBPUSD', 1.28, 1.2802));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('GBPUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.28);
  });

  it.each(['broker_url_change', 'account_change', 'logout', 'login'] as const)(
    'non-rotation session change (%s) clears loaded book on the very next render and drops late old-session answers',
    async (reason) => {
      mocks.binarySupported.value = true;
      const rest1 = createDeferred<unknown>();
      const rest2 = createDeferred<unknown>();
      const rest3 = createDeferred<unknown>();
      mocks.fetchMarketDataJson
        .mockReturnValueOnce(rest1.promise)
        .mockReturnValueOnce(rest2.promise)
        .mockReturnValueOnce(rest3.promise);

      const { result, observations } = renderTrackedBook('EURUSD');
      rest1.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.bids[0]?.price).toBe(1.1);

      const oldBin = mocks.binaryCapturedListeners[0];
      const oldWs = mocks.wsCapturedListeners[0];

      // Start an in-flight old-session reload before the session change
      act(() => {
        void result.current.reload();
      });
      await flushMicrotasks();

      const obsBeforeChange = observations.length;
      act(() => {
        emitSessionChange(reason);
      });
      await flushMicrotasks();

      const afterChange = observations.slice(obsBeforeChange);
      expect(afterChange.length).toBeGreaterThanOrEqual(1);
      // Very next render clears the previous book
      expect(afterChange[0].orderBook).toBeNull();
      expect(afterChange[0].error).toBeNull();
      for (const obs of afterChange) {
        expect(obs.orderBook).toBeNull();
        expect(obs.error).toBeNull();
      }

      // Late old-session REST & callbacks never land
      rest2.resolve(makeRestBook('EURUSD', 1.19, 1.1902));
      await flushMicrotasks();
      act(() => {
        oldBin.cb(makeBinaryDepth('EURUSD', 1.18, 1.1802, 2));
        oldWs.cb(makeWsMessage('EURUSD', 1.17, 1.1702));
      });
      expect(result.current.orderBook).toBeNull();
      expect(result.current.loading).toBe(true);

      rest3.resolve(makeRestBook('EURUSD', 1.25, 1.2502));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.bids[0]?.price).toBe(1.25);
    },
  );

  it('store setActiveAccount and logout clear loaded book on the very next render and drop late old-account answers', async () => {
    const rest1 = createDeferred<unknown>();
    const rest2 = createDeferred<unknown>();
    const rest3 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(rest2.promise)
      .mockReturnValueOnce(rest3.promise);

    const { result, observations } = renderTrackedBook('EURUSD');
    rest1.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Pending reload on account 1001
    act(() => {
      void result.current.reload();
    });
    await flushMicrotasks();

    // Switch account via store -> emits 'account_change'
    const obsAtAccountSwitch = observations.length;
    act(() => {
      useAppStore.getState().setActiveAccount(2002);
    });
    await flushMicrotasks();

    expect(observations[obsAtAccountSwitch].orderBook).toBeNull();
    expect(observations[obsAtAccountSwitch].error).toBeNull();
    rest2.resolve(makeRestBook('EURUSD', 1.19, 1.1902));
    await flushMicrotasks();
    expect(result.current.orderBook).toBeNull();

    rest3.resolve(makeRestBook('EURUSD', 1.22, 1.2202));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.22);

    // Logout via store -> clears immediately on very next render
    const obsAtLogout = observations.length;
    act(() => {
      useAppStore.getState().logout();
    });
    await flushMicrotasks();
    expect(observations[obsAtLogout].orderBook).toBeNull();
    expect(observations[obsAtLogout].loading).toBe(false);
    expect(observations[obsAtLogout].error).toBeNull();
  });

  it('consumer DepthOfMarket: across a token rotation the rendered ladder rows never disappear or change at any commit', async () => {
    const rest1 = createDeferred<unknown>();
    const rest2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(rest2.promise);

    const onPlaceOrder = vi.fn();
    let captureCommits = false;
    const committedSnapshots: Array<{ levelCount: number; text: string }> = [];

    const view = render(
      <Profiler
        id="dom-token-rotation"
        onRender={() => {
          if (!captureCommits) return;
          committedSnapshots.push({
            levelCount: view.container.querySelectorAll('.rtx-dom-level').length,
            text: view.container.textContent ?? '',
          });
        }}
      >
        <DepthOfMarket symbol="EURUSD" onPlaceOrder={onPlaceOrder} />
      </Profiler>,
    );

    await act(async () => {
      rest1.resolve({
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
    const baselineCount = view.container.querySelectorAll('.rtx-dom-level').length;
    expect(view.container.textContent).toContain('12.50');
    expect(view.container.textContent).toContain('14.50');

    captureCommits = true;
    act(() => {
      useAppStore.getState().setAuthTokens('tok-2', 'ref-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();
    captureCommits = false;

    expect(committedSnapshots.length).toBeGreaterThanOrEqual(1);
    for (const snap of committedSnapshots) {
      expect(snap.levelCount).toBe(baselineCount);
      expect(snap.text).toContain('12.50');
      expect(snap.text).toContain('14.50');
      expect(snap.text).not.toContain('Waiting for EURUSD market depth...');
    }

    await act(async () => {
      rest2.resolve({
        symbol: 'EURUSD',
        bids: [{ price: 1.101, volume: 22.5 }],
        asks: [{ price: 1.1012, volume: 24.5 }],
        timestamp: 1_700_000_000_500,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.container.textContent).toContain('22.50');
      expect(view.container.textContent).toContain('24.50');
    });
  });

  it('consumer OrderPanelDialog DOM pane: across a token rotation the rendered ladder rows never disappear or blink to synthetic levels', async () => {
    const rest1 = createDeferred<unknown>();
    const rest2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(rest2.promise);

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

    let captureCommits = false;
    const domPaneSnapshots: Array<{ rowTexts: string[]; paneText: string }> = [];

    const readDomRows = (): string[] => {
      const pane = screen.queryByTestId('order-dom-pane');
      if (!pane) return [];
      return Array.from(pane.querySelectorAll('.rtx-order-dialog__dom-row')).map((row) => row.textContent ?? '');
    };

    render(
      <Profiler
        id="order-dialog-token-rotation"
        onRender={() => {
          if (!captureCommits) return;
          const pane = screen.queryByTestId('order-dom-pane');
          domPaneSnapshots.push({
            rowTexts: readDomRows(),
            paneText: pane?.textContent ?? '',
          });
        }}
      >
        <OrderPanelDialog
          isOpen
          onClose={vi.fn()}
          symbol="XAUUSD"
          currentPrice={{ bid: 0, ask: 0 }}
          onSubmitOrder={vi.fn()}
          symbols={['XAUUSD', 'EURUSD']}
          instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
        />
      </Profiler>,
    );

    await act(async () => {
      rest1.resolve({
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
    const beforeRotationRows = readDomRows();
    expect(beforeRotationRows.length).toBeGreaterThan(0);

    captureCommits = true;
    act(() => {
      useAppStore.getState().setAuthTokens('tok-2', 'ref-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();
    captureCommits = false;

    expect(domPaneSnapshots.length).toBeGreaterThanOrEqual(1);
    for (const snap of domPaneSnapshots) {
      expect(snap.rowTexts).toEqual(beforeRotationRows);
      expect(snap.paneText).toContain('777');
      expect(snap.paneText).toContain('888');
    }

    await act(async () => {
      rest2.resolve({
        symbol: 'XAUUSD',
        bids: [{ price: 4174.1, volume: 991 }],
        asks: [{ price: 4174.9, volume: 992 }],
        timestamp: 1_700_000_000_500,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(domPane.textContent).toContain('991');
      expect(domPane.textContent).toContain('992');
    });
  });

  it('React.StrictMode: symbol-switch core case clears immediately and drops stale pass/symbol REST', async () => {
    const mountPass1 = createDeferred<unknown>();
    const mountPass2 = createDeferred<unknown>();
    const gbpRest = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(mountPass1.promise)
      .mockReturnValueOnce(mountPass2.promise)
      .mockReturnValueOnce(gbpRest.promise);

    const { result, rerender, observations } = renderTrackedBook('EURUSD', 10, true);
    await flushMicrotasks();

    mountPass1.reject(new ApiError(500, 'strict first pass failure'));
    await flushMicrotasks();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);

    mountPass2.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.1);

    const obsAtSwitch = observations.length;
    rerender({ sym: 'GBPUSD', d: 10 });
    await flushMicrotasks();

    const gbpObs = observations.slice(obsAtSwitch);
    expect(gbpObs[0].orderBook).toBeNull();
    expect(gbpObs[0].loading).toBe(true);
    expect(gbpObs[0].error).toBeNull();

    gbpRest.resolve(makeRestBook('GBPUSD', 1.27, 1.2702));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('GBPUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.27);
  });

  it('React.StrictMode: token rotation with loaded book never produces a null book or changed pre-effect loading/error', async () => {
    const mountPass1 = createDeferred<unknown>();
    const mountPass2 = createDeferred<unknown>();
    const postRotRest = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(mountPass1.promise)
      .mockReturnValueOnce(mountPass2.promise)
      .mockReturnValueOnce(postRotRest.promise);

    const { result, observations } = renderTrackedBook('EURUSD', 10, true);
    await flushMicrotasks();

    mountPass2.resolve(makeRestBook('EURUSD', 1.1, 1.1002));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const loadedBook = result.current.orderBook;
    expect(loadedBook).not.toBeNull();

    const obsBeforeRot = observations.length;
    act(() => {
      useAppStore.getState().setAuthTokens('tok-2', 'ref-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();

    const afterRot = observations.slice(obsBeforeRot);
    expect(afterRot.length).toBeGreaterThanOrEqual(2);
    expect(afterRot[0].orderBook).toBe(loadedBook);
    expect(afterRot[0].loading).toBe(false);
    expect(afterRot[0].error).toBeNull();
    for (const obs of afterRot) {
      expect(obs.orderBook).toBe(loadedBook);
      expect(obs.error).toBeNull();
    }

    // Late mountPass1 still ignored; post-rotation REST replaces book
    mountPass1.resolve(makeRestBook('EURUSD', 1.05, 1.0502));
    await flushMicrotasks();
    expect(result.current.orderBook).toBe(loadedBook);

    postRotRest.resolve(makeRestBook('EURUSD', 1.2, 1.2002));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.2);
  });

  it('S5 PIN: changing requested depth (10 -> 20) on same symbol matches recorded baseline sequences in REST-only and binary-cache modes', async () => {
    // Part 1: REST-only mode (Baseline Scenario D)
    const rest10 = createDeferred<unknown>();
    const rest20 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest10.promise)
      .mockReturnValueOnce(rest20.promise);

    const h1 = renderTrackedBook('EURUSD', 10);
    rest10.resolve(makeRestBook('EURUSD', 1.1, 1.1002, 10, 10));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));
    const book10 = h1.result.current.orderBook;
    expect(book10?.bids.length).toBe(10);

    const obsBeforeDepth = h1.observations.length;
    h1.rerender({ sym: 'EURUSD', d: 20 });
    await flushMicrotasks();

    const afterDepth = h1.observations.slice(obsBeforeDepth);
    expect(afterDepth.length).toBeGreaterThanOrEqual(2);
    expect(afterDepth[0].orderBook).toBe(book10);
    expect(afterDepth[0].loading).toBe(false);
    expect(afterDepth[0].error).toBeNull();
    for (const obs of afterDepth) {
      expect(obs.orderBook).toBe(book10);
      expect(obs.error).toBeNull();
    }
    expect(afterDepth[afterDepth.length - 1].loading).toBe(true);
    expect(mocks.fetchMarketDataJson).toHaveBeenLastCalledWith('/api/v2/depth/EURUSD', { limit: 20, levels: 20 });

    rest20.resolve(makeRestBook('EURUSD', 1.2, 1.2002, 10, 20));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));
    expect(h1.result.current.orderBook?.bids.length).toBe(20);
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(1.2);
    h1.unmount();

    // Part 2: Binary-supported + cache mode (Baseline Scenario E)
    mocks.fetchMarketDataJson.mockReset();
    mocks.binarySupported.value = true;
    mocks.binaryLatestDepths.set('EURUSD', makeBinaryDepth('EURUSD', 1.11, 1.1102, 1, 10, 20));

    const binRest10 = createDeferred<unknown>();
    const binRest20 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(binRest10.promise)
      .mockReturnValueOnce(binRest20.promise);

    const h2 = renderTrackedBook('EURUSD', 10);
    binRest10.resolve(makeRestBook('EURUSD', 1.12, 1.1202, 10, 10));
    await waitFor(() => expect(h2.result.current.orderBook?.bids[0]?.price).toBe(1.12));
    expect(h2.result.current.loading).toBe(false);
    const binBook10 = h2.result.current.orderBook;

    const obsBeforeBinDepth = h2.observations.length;
    h2.rerender({ sym: 'EURUSD', d: 20 });
    await flushMicrotasks();

    const afterBinDepth = h2.observations.slice(obsBeforeBinDepth);
    expect(afterBinDepth.length).toBeGreaterThanOrEqual(2);
    expect(afterBinDepth[0].orderBook).toBe(binBook10);
    expect(afterBinDepth[0].loading).toBe(false);
    expect(afterBinDepth[0].error).toBeNull();
    for (const obs of afterBinDepth) {
      expect(obs.orderBook).not.toBeNull();
      expect(obs.loading).toBe(false);
      expect(obs.error).toBeNull();
    }
    expect(afterBinDepth[afterBinDepth.length - 1].orderBook?.bids.length).toBe(20);

    binRest20.resolve(makeRestBook('EURUSD', 1.22, 1.2202, 10, 20));
    await waitFor(() => expect(h2.result.current.orderBook?.bids[0]?.price).toBe(1.22));
    expect(h2.result.current.orderBook?.bids.length).toBe(20);
  });
});
