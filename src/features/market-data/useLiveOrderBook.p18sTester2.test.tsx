// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { resetAccountSpreadMarkupForTests } from '../../services/accountSpreadMarkup';
import type { DecodedBinaryDepth } from '../../services/binaryTcpMarketStream';
import { emitSessionChange } from '../../services/brokerSession';
import { useAppStore } from '../../store/useAppStore';
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

interface OpenRestEntry {
  id: number;
  requestedSymbol: string;
  payloadSymbol: string;
  deferred: Deferred<unknown>;
  settled: boolean;
}

interface BinarySubEntry {
  id: number;
  symbol: string;
  cb: BinaryDepthCb;
  active: boolean;
}

interface WsSubEntry {
  id: number;
  channel: string;
  requestedSymbol: string;
  cb: WsDepthCb;
  active: boolean;
}

const mocks = vi.hoisted(() => {
  const fetchMarketDataJson = vi.fn();
  const binarySupported = { value: false };
  const binaryLatestDepths = new Map<string, DecodedBinaryDepth>();
  const binarySubs: BinarySubEntry[] = [];
  const wsSubs: WsSubEntry[] = [];
  const wsConnect = vi.fn();
  const openRests: OpenRestEntry[] = [];
  let nextRestId = 1;
  let nextSubId = 1;

  return {
    fetchMarketDataJson,
    binarySupported,
    binaryLatestDepths,
    binarySubs,
    wsSubs,
    wsConnect,
    openRests,
    nextRestId: () => nextRestId++,
    nextSubId: () => nextSubId++,
    resetCounters: () => {
      nextRestId = 1;
      nextSubId = 1;
    },
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
      const entry: BinarySubEntry = {
        id: mocks.nextSubId(),
        symbol: normalized,
        cb,
        active: true,
      };
      mocks.binarySubs.push(entry);
      return () => {
        entry.active = false;
      };
    },
  },
}));

vi.mock('../../services/websocket-enhanced', () => ({
  getEnhancedWebSocketService: () => ({
    connect: mocks.wsConnect,
    subscribe: (channel: string, cb: WsDepthCb) => {
      const requestedSymbol = channel.startsWith('depth.') ? channel.slice('depth.'.length) : channel;
      const entry: WsSubEntry = {
        id: mocks.nextSubId(),
        channel,
        requestedSymbol,
        cb,
        active: true,
      };
      mocks.wsSubs.push(entry);
      return () => {
        entry.active = false;
      };
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

const makeRestBook = (symbol: string, priceId: number, volume = 10) => ({
  symbol,
  bids: [{ price: priceId, volume }],
  asks: [{ price: priceId + 0.5, volume }],
  timestamp: 1_700_000_000_000 + priceId,
});

const makeBinaryDepth = (symbol: string, priceId: number, sequence: number, volume = 10): DecodedBinaryDepth => ({
  symbol,
  timestamp: 1_700_000_000_000 + priceId,
  sequence,
  bids: [{ price: priceId, volume, total: volume }],
  asks: [{ price: priceId + 0.5, volume, total: volume }],
  spread: 0.5,
});

const makeWsMessage = (symbol: string, priceId: number, volume = 10) => ({
  symbol,
  bids: [{ price: priceId, volume }],
  asks: [{ price: priceId + 0.5, volume }],
  timestamp: 1_700_000_000_000 + priceId,
});

const payloadSymbolFor = (requestedSymbol: string): string => {
  const norm = requestedSymbol.trim().toUpperCase();
  return norm === 'XAUUSD.VIP' ? 'XAUUSD' : norm;
};

const createMulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface RenderObservation {
  symbol: string;
  authenticated: boolean;
  session: number;
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
        authenticated: useAppStore.getState().isAuthenticated,
        session: 0,
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

describe('P18S independent tester2 adversarial & close-out verification', () => {
  beforeEach(() => {
    mocks.fetchMarketDataJson.mockReset();
    mocks.wsConnect.mockReset();
    mocks.binarySupported.value = false;
    mocks.binaryLatestDepths.clear();
    mocks.binarySubs.length = 0;
    mocks.wsSubs.length = 0;
    mocks.openRests.length = 0;
    mocks.resetCounters();

    localStorage.clear();
    sessionStorage.clear();
    resetAccountSpreadMarkupForTests();
    useAppStore.getState().reset();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '1001',
      authToken: 'tester2-tok-0',
      refreshToken: 'tester2-ref-0',
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    resetAccountSpreadMarkupForTests();
    useAppStore.getState().reset();
    vi.restoreAllMocks();
  });

  it('token_rotation followed by account_change in the same tick acts as a change of owner', async () => {
    mocks.binarySupported.value = true;
    const rest1 = createDeferred<unknown>();
    const restPending = createDeferred<unknown>();
    const restNext = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(restPending.promise)
      .mockReturnValueOnce(restNext.promise);

    const { result, observations } = renderTrackedBook('EURUSD');
    rest1.resolve(makeRestBook('EURUSD', 1.1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.1);

    const oldBin = mocks.binarySubs[0];
    const oldWs = mocks.wsSubs[0];

    act(() => {
      void result.current.reload();
    });
    await flushMicrotasks();

    const obsStart = observations.length;
    act(() => {
      emitSessionChange('token_rotation');
      emitSessionChange('account_change');
    });
    await flushMicrotasks();

    const afterEvents = observations.slice(obsStart);
    expect(afterEvents.length).toBeGreaterThanOrEqual(1);
    expect(afterEvents[0].orderBook).toBeNull();
    expect(afterEvents[0].error).toBeNull();
    expect(afterEvents[0].loading).toBe(true);
    for (const obs of afterEvents) {
      expect(obs.orderBook).toBeNull();
      expect(obs.error).toBeNull();
    }

    expect(oldBin.active).toBe(false);
    expect(oldWs.active).toBe(false);

    // Late old-owner REST and stream callbacks are dropped
    restPending.reject(new ApiError(500, 'stale pre-change error'));
    await flushMicrotasks();
    act(() => {
      oldBin.cb(makeBinaryDepth('EURUSD', 1.01, 99));
      oldWs.cb(makeWsMessage('EURUSD', 1.02));
    });
    expect(result.current.orderBook).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);

    restNext.resolve(makeRestBook('EURUSD', 1.25));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.25);
    expect(result.current.error).toBeNull();
  });

  it('account_change followed by token_rotation in the same tick acts as a change of owner', async () => {
    mocks.binarySupported.value = true;
    const rest1 = createDeferred<unknown>();
    const restPending = createDeferred<unknown>();
    const restNext = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(restPending.promise)
      .mockReturnValueOnce(restNext.promise);

    const { result, observations } = renderTrackedBook('EURUSD');
    rest1.resolve(makeRestBook('EURUSD', 1.1));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const oldBin = mocks.binarySubs[0];
    const oldWs = mocks.wsSubs[0];

    act(() => {
      void result.current.reload();
    });
    await flushMicrotasks();

    const obsStart = observations.length;
    act(() => {
      emitSessionChange('account_change');
      emitSessionChange('token_rotation');
    });
    await flushMicrotasks();

    const afterEvents = observations.slice(obsStart);
    expect(afterEvents.length).toBeGreaterThanOrEqual(1);
    expect(afterEvents[0].orderBook).toBeNull();
    expect(afterEvents[0].error).toBeNull();
    expect(afterEvents[0].loading).toBe(true);
    for (const obs of afterEvents) {
      expect(obs.orderBook).toBeNull();
      expect(obs.error).toBeNull();
    }

    restPending.resolve(makeRestBook('EURUSD', 1.19));
    await flushMicrotasks();
    act(() => {
      oldBin.cb(makeBinaryDepth('EURUSD', 1.03, 100));
      oldWs.cb(makeWsMessage('EURUSD', 1.04));
    });
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);

    restNext.resolve(makeRestBook('EURUSD', 1.28));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.28);
  });

  it('store setAuthTokens and setActiveAccount in the same tick (both orders) act as owner changes', async () => {
    // Order 1: setAuthTokens then setActiveAccount
    const restA1 = createDeferred<unknown>();
    const restA2 = createDeferred<unknown>();
    const restA3 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA1.promise)
      .mockReturnValueOnce(restA2.promise)
      .mockReturnValueOnce(restA3.promise);

    const h1 = renderTrackedBook('EURUSD');
    restA1.resolve(makeRestBook('EURUSD', 1.1));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));

    act(() => {
      void h1.result.current.reload();
    });
    await flushMicrotasks();

    const obsStart1 = h1.observations.length;
    act(() => {
      useAppStore.getState().setAuthTokens('tok-2', 'ref-2', Date.now() + 3600_000);
      useAppStore.getState().setActiveAccount(2002);
    });
    await flushMicrotasks();

    expect(h1.observations[obsStart1].orderBook).toBeNull();
    expect(h1.observations[obsStart1].error).toBeNull();
    restA2.resolve(makeRestBook('EURUSD', 1.15));
    await flushMicrotasks();
    expect(h1.result.current.orderBook).toBeNull();

    restA3.resolve(makeRestBook('EURUSD', 1.31));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(1.31);
    h1.unmount();

    // Order 2: setActiveAccount then setAuthTokens
    mocks.fetchMarketDataJson.mockReset();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '1001',
      authToken: 'tester2-tok-0b',
      refreshToken: 'tester2-ref-0b',
    });

    const restB1 = createDeferred<unknown>();
    const restB2 = createDeferred<unknown>();
    const restB3 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restB1.promise)
      .mockReturnValueOnce(restB2.promise)
      .mockReturnValueOnce(restB3.promise);

    const h2 = renderTrackedBook('EURUSD');
    restB1.resolve(makeRestBook('EURUSD', 1.2));
    await waitFor(() => expect(h2.result.current.loading).toBe(false));

    act(() => {
      void h2.result.current.reload();
    });
    await flushMicrotasks();

    const obsStart2 = h2.observations.length;
    act(() => {
      useAppStore.getState().setActiveAccount(2003);
      useAppStore.getState().setAuthTokens('tok-3', 'ref-3', Date.now() + 3600_000);
    });
    await flushMicrotasks();

    expect(h2.observations[obsStart2].orderBook).toBeNull();
    expect(h2.observations[obsStart2].error).toBeNull();
    restB2.resolve(makeRestBook('EURUSD', 1.25));
    await flushMicrotasks();
    expect(h2.result.current.orderBook).toBeNull();

    restB3.resolve(makeRestBook('EURUSD', 1.32));
    await waitFor(() => expect(h2.result.current.loading).toBe(false));
    expect(h2.result.current.orderBook?.bids[0]?.price).toBe(1.32);
  });

  it('two non-rotation session events in one tick clear immediately and drop stale work', async () => {
    // Sub-case A: broker_url_change + account_change
    const restA1 = createDeferred<unknown>();
    const restA2 = createDeferred<unknown>();
    const restA3 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA1.promise)
      .mockReturnValueOnce(restA2.promise)
      .mockReturnValueOnce(restA3.promise);

    const h1 = renderTrackedBook('EURUSD');
    restA1.resolve(makeRestBook('EURUSD', 1.1));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));
    const oldWs1 = mocks.wsSubs[0];

    act(() => {
      void h1.result.current.reload();
    });
    await flushMicrotasks();

    const obsStart1 = h1.observations.length;
    act(() => {
      emitSessionChange('broker_url_change');
      emitSessionChange('account_change');
    });
    await flushMicrotasks();

    expect(h1.observations[obsStart1].orderBook).toBeNull();
    expect(h1.observations[obsStart1].error).toBeNull();
    expect(h1.observations[obsStart1].loading).toBe(true);
    expect(oldWs1.active).toBe(false);

    restA2.resolve(makeRestBook('EURUSD', 1.18));
    await flushMicrotasks();
    act(() => {
      oldWs1.cb(makeWsMessage('EURUSD', 1.17));
    });
    expect(h1.result.current.orderBook).toBeNull();

    restA3.resolve(makeRestBook('EURUSD', 1.41));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(1.41);
    h1.unmount();

    // Sub-case B: logout + login in one tick
    mocks.fetchMarketDataJson.mockReset();
    mocks.wsSubs.length = 0;
    const restB1 = createDeferred<unknown>();
    const restB2 = createDeferred<unknown>();
    const restB3 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restB1.promise)
      .mockReturnValueOnce(restB2.promise)
      .mockReturnValueOnce(restB3.promise);

    const h2 = renderTrackedBook('GBPUSD');
    restB1.resolve(makeRestBook('GBPUSD', 1.25));
    await waitFor(() => expect(h2.result.current.loading).toBe(false));

    act(() => {
      void h2.result.current.reload();
    });
    await flushMicrotasks();

    const obsStart2 = h2.observations.length;
    act(() => {
      emitSessionChange('logout');
      emitSessionChange('login');
    });
    await flushMicrotasks();

    expect(h2.observations[obsStart2].orderBook).toBeNull();
    expect(h2.observations[obsStart2].error).toBeNull();
    expect(h2.observations[obsStart2].loading).toBe(true);

    restB2.reject(new ApiError(401, 'old logout/login error'));
    await flushMicrotasks();
    expect(h2.result.current.orderBook).toBeNull();
    expect(h2.result.current.error).toBeNull();
    expect(h2.result.current.loading).toBe(true);

    restB3.resolve(makeRestBook('GBPUSD', 1.29));
    await waitFor(() => expect(h2.result.current.loading).toBe(false));
    expect(h2.result.current.orderBook?.bids[0]?.price).toBe(1.29);
  });

  it('token rotation inside React.StrictMode while initial or manual reload request is pending', async () => {
    // Sub-case A: initial request pending under StrictMode
    const mountPass1 = createDeferred<unknown>();
    const mountPass2 = createDeferred<unknown>();
    const postRotRest = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(mountPass1.promise)
      .mockReturnValueOnce(mountPass2.promise)
      .mockReturnValueOnce(postRotRest.promise);

    const h1 = renderTrackedBook('EURUSD', 10, true);
    await flushMicrotasks();
    expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(2);
    expect(h1.result.current.loading).toBe(true);
    expect(h1.result.current.orderBook).toBeNull();

    const obsStartA = h1.observations.length;
    act(() => {
      useAppStore.getState().setAuthTokens('tok-strict-2', 'ref-strict-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();

    expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(3);
    for (const obs of h1.observations.slice(obsStartA)) {
      expect(obs.orderBook).toBeNull();
      expect(obs.loading).toBe(true);
      expect(obs.error).toBeNull();
    }

    // Both pre-rotation StrictMode requests settle late -> dropped
    mountPass1.reject(new ApiError(500, 'strict pass 1 err'));
    mountPass2.resolve(makeRestBook('EURUSD', 1.09));
    await flushMicrotasks();
    expect(h1.result.current.orderBook).toBeNull();
    expect(h1.result.current.loading).toBe(true);
    expect(h1.result.current.error).toBeNull();

    postRotRest.resolve(makeRestBook('EURUSD', 1.21));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(1.21);
    h1.unmount();

    // Sub-case B: loaded book + pending manual reload under StrictMode
    mocks.fetchMarketDataJson.mockReset();
    const initPass1 = createDeferred<unknown>();
    const initPass2 = createDeferred<unknown>();
    const manualReload = createDeferred<unknown>();
    const afterRotReload = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(initPass1.promise)
      .mockReturnValueOnce(initPass2.promise)
      .mockReturnValueOnce(manualReload.promise)
      .mockReturnValueOnce(afterRotReload.promise);

    const h2 = renderTrackedBook('EURUSD', 10, true);
    await flushMicrotasks();
    initPass2.resolve(makeRestBook('EURUSD', 1.1));
    await waitFor(() => expect(h2.result.current.loading).toBe(false));
    const loadedBook = h2.result.current.orderBook;
    expect(loadedBook).not.toBeNull();

    act(() => {
      void h2.result.current.reload();
    });
    await flushMicrotasks();
    expect(h2.result.current.loading).toBe(true);

    const obsStartB = h2.observations.length;
    act(() => {
      useAppStore.getState().setAuthTokens('tok-strict-3', 'ref-strict-3', Date.now() + 3600_000);
    });
    await flushMicrotasks();

    for (const obs of h2.observations.slice(obsStartB)) {
      expect(obs.orderBook).toBe(loadedBook);
      expect(obs.loading).toBe(true);
      expect(obs.error).toBeNull();
    }

    manualReload.resolve(makeRestBook('EURUSD', 1.15));
    await flushMicrotasks();
    expect(h2.result.current.orderBook).toBe(loadedBook);

    afterRotReload.resolve(makeRestBook('EURUSD', 1.26));
    await waitFor(() => expect(h2.result.current.loading).toBe(false));
    expect(h2.result.current.orderBook?.bids[0]?.price).toBe(1.26);
  });

  it('token rotation while WebSocket delivers in the same tick keeps non-null book; account_change masks old WS', async () => {
    // Sub-case A: WS message then token_rotation in the same act()
    const restA1 = createDeferred<unknown>();
    const restA2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restA1.promise)
      .mockReturnValueOnce(restA2.promise);

    const h1 = renderTrackedBook('EURUSD');
    restA1.resolve(makeRestBook('EURUSD', 1.1));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));
    const ws1 = mocks.wsSubs[0];

    const obsStartA = h1.observations.length;
    act(() => {
      ws1.cb(makeWsMessage('EURUSD', 1.15));
      useAppStore.getState().setAuthTokens('tok-ws-2', 'ref-ws-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();

    const afterA = h1.observations.slice(obsStartA);
    expect(afterA.length).toBeGreaterThanOrEqual(1);
    for (const obs of afterA) {
      expect(obs.orderBook).not.toBeNull();
      expect(obs.error).toBeNull();
    }
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(1.15);
    expect(ws1.active).toBe(false);
    expect(mocks.wsSubs).toHaveLength(2);

    // Late message on unsubscribed ws1 is dropped; ws2 + rest2 work
    act(() => {
      ws1.cb(makeWsMessage('EURUSD', 1.05));
    });
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(1.15);

    const ws2 = mocks.wsSubs[1];
    act(() => {
      ws2.cb(makeWsMessage('EURUSD', 1.16));
    });
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(1.16);

    restA2.resolve(makeRestBook('EURUSD', 1.17));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(1.17);
    h1.unmount();

    // Sub-case B: token_rotation then WS message on old ws in the same act()
    mocks.fetchMarketDataJson.mockReset();
    mocks.wsSubs.length = 0;
    const restB1 = createDeferred<unknown>();
    const restB2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restB1.promise)
      .mockReturnValueOnce(restB2.promise);

    const h2 = renderTrackedBook('EURUSD');
    restB1.resolve(makeRestBook('EURUSD', 1.2));
    await waitFor(() => expect(h2.result.current.loading).toBe(false));
    const oldWsB = mocks.wsSubs[0];

    const obsStartB = h2.observations.length;
    act(() => {
      useAppStore.getState().setAuthTokens('tok-ws-3', 'ref-ws-3', Date.now() + 3600_000);
      oldWsB.cb(makeWsMessage('EURUSD', 1.25));
    });
    await flushMicrotasks();

    for (const obs of h2.observations.slice(obsStartB)) {
      expect(obs.orderBook).not.toBeNull();
      expect(obs.error).toBeNull();
    }
    expect(h2.result.current.orderBook?.bids[0]?.price).toBe(1.25);
    expect(oldWsB.active).toBe(false);
    expect(mocks.wsSubs).toHaveLength(2);

    restB2.resolve(makeRestBook('EURUSD', 1.27));
    await waitFor(() => expect(h2.result.current.loading).toBe(false));
    expect(h2.result.current.orderBook?.bids[0]?.price).toBe(1.27);
    h2.unmount();

    // Sub-case C (contrast): account_change + old ws in same tick NEVER leaks old ws price
    mocks.fetchMarketDataJson.mockReset();
    mocks.wsSubs.length = 0;
    const restC1 = createDeferred<unknown>();
    const restC2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restC1.promise)
      .mockReturnValueOnce(restC2.promise);

    const h3 = renderTrackedBook('EURUSD');
    restC1.resolve(makeRestBook('EURUSD', 1.3));
    await waitFor(() => expect(h3.result.current.loading).toBe(false));
    const oldWsC = mocks.wsSubs[0];

    const obsStartC = h3.observations.length;
    act(() => {
      emitSessionChange('account_change');
      oldWsC.cb(makeWsMessage('EURUSD', 1.35));
    });
    await flushMicrotasks();

    for (const obs of h3.observations.slice(obsStartC)) {
      expect(obs.orderBook).toBeNull();
      expect(obs.error).toBeNull();
    }
    restC2.resolve(makeRestBook('EURUSD', 1.39));
    await waitFor(() => expect(h3.result.current.loading).toBe(false));
    expect(h3.result.current.orderBook?.bids[0]?.price).toBe(1.39);
  });

  it('rotation drops late answer/rejection of pre-rotation request and accepts post-rotation answer', async () => {
    // Sub-case A: binary cache present initially, deleted before rotation; late pre-rotation rejection is dropped
    mocks.binarySupported.value = true;
    mocks.binaryLatestDepths.set('EURUSD', makeBinaryDepth('EURUSD', 1.08, 1));

    const rest1 = createDeferred<unknown>();
    const preRotReload = createDeferred<unknown>();
    const postRotRest = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(preRotReload.promise)
      .mockReturnValueOnce(postRotRest.promise);

    const { result, observations } = renderTrackedBook('EURUSD');
    rest1.resolve(makeRestBook('EURUSD', 1.1));
    await waitFor(() => expect(result.current.orderBook?.bids[0]?.price).toBe(1.1));
    expect(result.current.loading).toBe(false);

    // Clear cache before manual reload so reload() keeps 1.1 while loading=true
    mocks.binaryLatestDepths.delete('EURUSD');

    act(() => {
      void result.current.reload();
    });
    await flushMicrotasks();
    expect(result.current.loading).toBe(true);
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.1);

    const obsBeforeRot = observations.length;
    act(() => {
      emitSessionChange('token_rotation');
    });
    await flushMicrotasks();

    for (const obs of observations.slice(obsBeforeRot)) {
      expect(obs.orderBook).not.toBeNull();
      expect(obs.error).toBeNull();
    }

    // Late pre-rotation rejection is ignored
    preRotReload.reject(new ApiError(503, 'pre-rotation timeout'));
    await flushMicrotasks();
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.1);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    // Post-rotation answer settles cleanly
    postRotRest.resolve(makeRestBook('EURUSD', 1.24));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.24);
    expect(result.current.error).toBeNull();

    // Sub-case B: late pre-rotation success answer (1.19) after rotation is dropped; post-rotation (1.35) accepted
    const preRotResolve = createDeferred<unknown>();
    const postRotResolve = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(preRotResolve.promise)
      .mockReturnValueOnce(postRotResolve.promise);

    act(() => {
      void result.current.reload();
    });
    await flushMicrotasks();
    expect(result.current.loading).toBe(true);

    act(() => {
      emitSessionChange('token_rotation');
    });
    await flushMicrotasks();

    preRotResolve.resolve(makeRestBook('EURUSD', 1.19));
    await flushMicrotasks();
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.24);
    expect(result.current.loading).toBe(true);

    postRotResolve.resolve(makeRestBook('EURUSD', 1.35));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.35);
  });

  it('unmount during a pending post-rotation request emits no state updates or React warnings', async () => {
    mocks.binarySupported.value = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Instance 1: loaded -> rotation -> unmount while postRotRest pending -> settle resolve + callbacks
    const rest1 = createDeferred<unknown>();
    const postRot1 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(rest1.promise)
      .mockReturnValueOnce(postRot1.promise);

    const h1 = renderTrackedBook('EURUSD');
    rest1.resolve(makeRestBook('EURUSD', 1.1));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));

    act(() => {
      useAppStore.getState().setAuthTokens('tok-unmount-1', 'ref-unmount-1', Date.now() + 3600_000);
    });
    await flushMicrotasks();
    const activeBin1 = mocks.binarySubs[mocks.binarySubs.length - 1];
    const activeWs1 = mocks.wsSubs[mocks.wsSubs.length - 1];
    expect(activeBin1.active).toBe(true);
    expect(activeWs1.active).toBe(true);

    h1.unmount();
    expect(activeBin1.active).toBe(false);
    expect(activeWs1.active).toBe(false);

    postRot1.resolve(makeRestBook('EURUSD', 1.2));
    await flushMicrotasks();
    act(() => {
      activeBin1.cb(makeBinaryDepth('EURUSD', 1.21, 5));
      activeWs1.cb(makeWsMessage('EURUSD', 1.22));
      emitSessionChange('token_rotation');
      emitSessionChange('account_change');
    });

    // Instance 2: pending initial -> rotation -> unmount -> reject both pre and post rotation requests
    const preRot2 = createDeferred<unknown>();
    const postRot2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(preRot2.promise)
      .mockReturnValueOnce(postRot2.promise);

    const h2 = renderTrackedBook('GBPUSD');
    act(() => {
      useAppStore.getState().setAuthTokens('tok-unmount-2', 'ref-unmount-2', Date.now() + 3600_000);
    });
    await flushMicrotasks();
    h2.unmount();

    postRot2.reject(new ApiError(500, 'post-rotation reject after unmount'));
    preRot2.reject(new ApiError(500, 'pre-rotation reject after unmount'));
    await flushMicrotasks();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('350 randomized sequences (seed 0x5018_5002) against independent reference model checking every render', async () => {
    const SEED = 0x5018_5002;
    const SEQUENCE_COUNT = 350;
    const rand = createMulberry32(SEED);
    const symbols = ['EURUSD', 'GBPUSD', 'XAUUSD', 'XAUUSD.VIP', ''] as const;
    const depths = [5, 10, 20] as const;
    let nextPriceId = 2000;
    const allocPriceId = () => nextPriceId++;

    interface ModelState {
      symbol: string;
      depth: number;
      authenticated: boolean;
      session: number;
      activeRestId: number | null;
      activeBinarySubId: number | null;
      activeWsSubId: number | null;
      allowedPriceIds: Set<number>;
      expectedPriceId: number | null;
      expectedPayloadSymbol: string | null;
      expectedLoading: boolean;
      expectedError: string | null;
      cachePriceBySym: Map<string, number>;
    }

    const ownerKeyOf = (sym: string, auth: boolean, sess: number) => `${sym}|${auth ? 1 : 0}|${sess}`;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let seq = 0; seq < SEQUENCE_COUNT; seq += 1) {
      mocks.fetchMarketDataJson.mockReset();
      mocks.binaryLatestDepths.clear();
      mocks.binarySubs.length = 0;
      mocks.wsSubs.length = 0;
      mocks.openRests.length = 0;
      mocks.binarySupported.value = seq % 2 === 1;

      let sessionCounter = 0;
      const initSym = symbols[Math.floor(rand() * 4)];
      const initDepth = depths[Math.floor(rand() * depths.length)];
      let currentAuth = true;
      let currentSession = 0;

      useAppStore.setState({
        isAuthenticated: true,
        accountId: '1001',
        authToken: `seq2-${seq}-tok-0`,
        refreshToken: `seq2-${seq}-ref-0`,
      });

      const model: ModelState = {
        symbol: initSym,
        depth: initDepth,
        authenticated: true,
        session: 0,
        activeRestId: null,
        activeBinarySubId: null,
        activeWsSubId: null,
        allowedPriceIds: new Set<number>(),
        expectedPriceId: null,
        expectedPayloadSymbol: null,
        expectedLoading: false,
        expectedError: null,
        cachePriceBySym: new Map(),
      };

      if (mocks.binarySupported.value && rand() < 0.35) {
        const cid = allocPriceId();
        model.cachePriceBySym.set(initSym, cid);
        mocks.binaryLatestDepths.set(initSym, makeBinaryDepth(payloadSymbolFor(initSym), cid, cid));
      }

      const ownerAllowedSets = new Map<string, Set<number>>();
      const getAllowedSet = (key: string) => {
        let set = ownerAllowedSets.get(key);
        if (!set) {
          set = new Set<number>();
          ownerAllowedSets.set(key, set);
        }
        return set;
      };

      mocks.fetchMarketDataJson.mockImplementation((url: string) => {
        const prefix = '/api/v2/depth/';
        const encodedSym = url.startsWith(prefix) ? url.slice(prefix.length) : url;
        const reqSym = decodeURIComponent(encodedSym).trim().toUpperCase();
        const deferred = createDeferred<unknown>();
        const id = mocks.nextRestId();
        mocks.openRests.push({
          id,
          requestedSymbol: reqSym,
          payloadSymbol: payloadSymbolFor(reqSym),
          deferred,
          settled: false,
        });
        return deferred.promise;
      });

      const observations: RenderObservation[] = [];

      const syncSubscriptionsToModel = (binaryCountBefore: number, wsCountBefore: number) => {
        if (model.authenticated && model.symbol) {
          if (mocks.binarySupported.value && mocks.binarySubs.length > binaryCountBefore) {
            model.activeBinarySubId = mocks.binarySubs[mocks.binarySubs.length - 1].id;
          }
          if (mocks.wsSubs.length > wsCountBefore) {
            model.activeWsSubId = mocks.wsSubs[mocks.wsSubs.length - 1].id;
          }
        } else {
          model.activeBinarySubId = null;
          model.activeWsSubId = null;
        }
      };

      const syncRestToModel = (restCountBefore: number) => {
        if (model.authenticated && model.symbol && mocks.openRests.length > restCountBefore) {
          model.activeRestId = mocks.openRests[mocks.openRests.length - 1].id;
        } else if (!model.authenticated || !model.symbol) {
          model.activeRestId = null;
        }
      };

      const initOwnerKey = ownerKeyOf(initSym, true, 0);
      model.allowedPriceIds = getAllowedSet(initOwnerKey);
      const initCacheId = mocks.binarySupported.value ? model.cachePriceBySym.get(initSym) : undefined;
      if (initCacheId !== undefined) {
        model.allowedPriceIds.add(initCacheId);
        model.expectedPriceId = initCacheId;
        model.expectedPayloadSymbol = payloadSymbolFor(initSym);
        model.expectedLoading = false;
        model.expectedError = null;
      } else {
        model.expectedPriceId = null;
        model.expectedPayloadSymbol = null;
        model.expectedLoading = true;
        model.expectedError = null;
      }

      const hookRef = renderHook(
        ({ sym, d }: { sym: string; d: number }) => {
          const value = useLiveOrderBook(sym, d);
          observations.push({
            symbol: sym.trim().toUpperCase(),
            authenticated: currentAuth,
            session: currentSession,
            orderBook: value.orderBook,
            loading: value.loading,
            error: value.error,
          });
          return value;
        },
        { initialProps: { sym: initSym, d: initDepth } },
      );

      syncRestToModel(0);
      syncSubscriptionsToModel(0, 0);

      const checkRenderObservations = (startIdx: number, context: string) => {
        for (let i = startIdx; i < observations.length; i += 1) {
          const obs = observations[i];
          const oKey = ownerKeyOf(obs.symbol, obs.authenticated, obs.session);
          const allowed = getAllowedSet(oKey);
          if (obs.orderBook !== null) {
            const bidPrice = obs.orderBook.bids[0]?.price;
            expect(
              allowed.has(bidPrice),
              `[seed=${SEED} seq=${seq} ${context}] render #${i} leaked price=${bidPrice} (${obs.orderBook.symbol}) under ${oKey}`,
            ).toBe(true);
            expect(obs.orderBook.symbol).toBe(payloadSymbolFor(obs.symbol));
          }
          if (!obs.authenticated || !obs.symbol) {
            expect(obs.orderBook, `[seq=${seq} ${context}] unauth/empty book must be null`).toBeNull();
            expect(obs.error, `[seq=${seq} ${context}] unauth/empty error must be null`).toBeNull();
            expect(obs.loading, `[seq=${seq} ${context}] unauth/empty loading must be false`).toBe(false);
          }
        }
      };

      const checkPostStepModel = (context: string) => {
        const cur = hookRef.result.current;
        if (model.expectedPriceId === null) {
          expect(cur.orderBook, `[seq=${seq} ${context}] expected null orderBook`).toBeNull();
        } else {
          expect(cur.orderBook, `[seq=${seq} ${context}] expected non-null orderBook`).not.toBeNull();
          expect(cur.orderBook?.bids[0]?.price, `[seq=${seq} ${context}] expected bid price`).toBe(model.expectedPriceId);
          expect(cur.orderBook?.symbol, `[seq=${seq} ${context}] expected payload symbol`).toBe(model.expectedPayloadSymbol);
        }
        expect(cur.loading, `[seq=${seq} ${context}] loading mismatch`).toBe(model.expectedLoading);
        expect(cur.error, `[seq=${seq} ${context}] error mismatch`).toBe(model.expectedError);
      };

      checkRenderObservations(0, 'mount');
      checkPostStepModel('mount');

      const stepsCount = 12 + Math.floor(rand() * 5);
      for (let step = 0; step < stepsCount; step += 1) {
        const obsStart = observations.length;
        const restBefore = mocks.openRests.length;
        const binBefore = mocks.binarySubs.length;
        const wsBefore = mocks.wsSubs.length;
        const pendingRests = mocks.openRests.filter((r) => !r.settled);
        const pick = rand();
        let stepLabel: string;

        if (pick < 0.20) {
          // Symbol switch
          const candidates = symbols.filter((s) => s !== model.symbol);
          const nextSym = candidates[Math.floor(rand() * candidates.length)];
          stepLabel = `switch(${model.symbol}->${nextSym})`;

          const nextOwnerKey = ownerKeyOf(nextSym, model.authenticated, model.session);
          const freshAllowed = new Set<number>();
          ownerAllowedSets.set(nextOwnerKey, freshAllowed);
          model.symbol = nextSym;
          model.allowedPriceIds = freshAllowed;
          model.activeRestId = null;
          model.activeBinarySubId = null;
          model.activeWsSubId = null;

          if (!model.authenticated || !nextSym) {
            model.expectedPriceId = null;
            model.expectedPayloadSymbol = null;
            model.expectedLoading = false;
            model.expectedError = null;
          } else {
            const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(nextSym) : undefined;
            if (cid !== undefined) {
              freshAllowed.add(cid);
              model.expectedPriceId = cid;
              model.expectedPayloadSymbol = payloadSymbolFor(nextSym);
              model.expectedLoading = false;
              model.expectedError = null;
            } else {
              model.expectedPriceId = null;
              model.expectedPayloadSymbol = null;
              model.expectedLoading = true;
              model.expectedError = null;
            }
          }

          hookRef.rerender({ sym: nextSym, d: model.depth });
          await flushMicrotasks();
          const firstRender = observations[obsStart];
          expect(firstRender.orderBook, `[seq=${seq} ${stepLabel}] first render must clear`).toBeNull();
          expect(firstRender.error, `[seq=${seq} ${stepLabel}] first render error must clear`).toBeNull();
          expect(firstRender.loading, `[seq=${seq} ${stepLabel}] first render loading`).toBe(
            Boolean(nextSym) && model.authenticated,
          );

          syncRestToModel(restBefore);
          syncSubscriptionsToModel(binBefore, wsBefore);
        } else if (pick < 0.34) {
          // Token rotation (same owner)
          stepLabel = 'token_rotation';
          const bookBeforeRotation = hookRef.result.current.orderBook;
          const loadingBeforeRotation = hookRef.result.current.loading;
          const errorBeforeRotation = hookRef.result.current.error;

          if (model.authenticated && model.symbol) {
            model.activeRestId = null;
            model.activeBinarySubId = null;
            model.activeWsSubId = null;
            const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
            if (cid !== undefined) {
              model.allowedPriceIds.add(cid);
              model.expectedPriceId = cid;
              model.expectedPayloadSymbol = payloadSymbolFor(model.symbol);
              model.expectedLoading = false;
              model.expectedError = null;
            } else {
              model.expectedError = null;
              model.expectedLoading = true;
            }
          }

          act(() => {
            if (rand() < 0.5) {
              emitSessionChange('token_rotation');
            } else {
              useAppStore.getState().setAuthTokens(`seq2-${seq}-rot-${step}`, 'ref', Date.now() + 3600_000);
            }
          });
          await flushMicrotasks();

          const afterRot = observations.slice(obsStart);
          expect(afterRot.length).toBeGreaterThanOrEqual(1);
          expect(afterRot[0].orderBook, `[seq=${seq} ${stepLabel}] pre-effect book`).toBe(bookBeforeRotation);
          expect(afterRot[0].loading, `[seq=${seq} ${stepLabel}] pre-effect loading`).toBe(loadingBeforeRotation);
          expect(afterRot[0].error, `[seq=${seq} ${stepLabel}] pre-effect error`).toBe(errorBeforeRotation);
          if (bookBeforeRotation !== null) {
            for (const obs of afterRot) {
              expect(obs.orderBook, `[seq=${seq} ${stepLabel}] loaded book must never be null`).not.toBeNull();
              if (!mocks.binarySupported.value || !model.cachePriceBySym.has(model.symbol)) {
                expect(obs.orderBook, `[seq=${seq} ${stepLabel}] same book ref`).toBe(bookBeforeRotation);
              }
            }
          }

          syncRestToModel(restBefore);
          syncSubscriptionsToModel(binBefore, wsBefore);
        } else if (pick < 0.44) {
          // Non-rotation session change OR same-tick compound owner change
          const nonRotReasons = ['login', 'logout', 'broker_url_change', 'account_change'] as const;
          const compoundKind = rand();
          let emitFn: () => void;

          if (compoundKind < 0.4) {
            const r = nonRotReasons[Math.floor(rand() * nonRotReasons.length)];
            stepLabel = `session_change(${r})`;
            emitFn = () => emitSessionChange(r);
          } else if (compoundKind < 0.7) {
            const rotFirst = rand() < 0.5;
            stepLabel = rotFirst ? 'same_tick(rot+acct)' : 'same_tick(acct+rot)';
            emitFn = () => {
              if (rotFirst) {
                emitSessionChange('token_rotation');
                emitSessionChange('account_change');
              } else {
                emitSessionChange('account_change');
                emitSessionChange('token_rotation');
              }
            };
          } else {
            const r1 = nonRotReasons[Math.floor(rand() * nonRotReasons.length)];
            const r2 = nonRotReasons[Math.floor(rand() * nonRotReasons.length)];
            stepLabel = `same_tick(${r1}+${r2})`;
            emitFn = () => {
              emitSessionChange(r1);
              emitSessionChange(r2);
            };
          }

          sessionCounter += 1;
          currentSession = sessionCounter;
          model.session = sessionCounter;
          const nextOwnerKey = ownerKeyOf(model.symbol, model.authenticated, model.session);
          const freshAllowed = new Set<number>();
          ownerAllowedSets.set(nextOwnerKey, freshAllowed);
          model.allowedPriceIds = freshAllowed;
          model.activeRestId = null;
          model.activeBinarySubId = null;
          model.activeWsSubId = null;

          if (!model.authenticated || !model.symbol) {
            model.expectedPriceId = null;
            model.expectedPayloadSymbol = null;
            model.expectedLoading = false;
            model.expectedError = null;
          } else {
            const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
            if (cid !== undefined) {
              freshAllowed.add(cid);
              model.expectedPriceId = cid;
              model.expectedPayloadSymbol = payloadSymbolFor(model.symbol);
              model.expectedLoading = false;
              model.expectedError = null;
            } else {
              model.expectedPriceId = null;
              model.expectedPayloadSymbol = null;
              model.expectedLoading = true;
              model.expectedError = null;
            }
          }

          act(emitFn);
          await flushMicrotasks();

          const firstRender = observations[obsStart];
          expect(firstRender.orderBook, `[seq=${seq} ${stepLabel}] first render must clear`).toBeNull();
          expect(firstRender.error, `[seq=${seq} ${stepLabel}] first render error must clear`).toBeNull();
          expect(firstRender.loading, `[seq=${seq} ${stepLabel}] first render loading`).toBe(
            Boolean(model.symbol) && model.authenticated,
          );

          syncRestToModel(restBefore);
          syncSubscriptionsToModel(binBefore, wsBefore);
        } else if (pick < 0.50 && model.activeWsSubId !== null) {
          // Same-tick token_rotation + active WS delivery
          const activeWs = mocks.wsSubs.find((s) => s.id === model.activeWsSubId);
          const pid = allocPriceId();
          const wsFirst = rand() < 0.5;
          stepLabel = wsFirst ? 'same_tick(ws+rot)' : 'same_tick(rot+ws)';
          const payloadSym = payloadSymbolFor(model.symbol);

          model.allowedPriceIds.add(pid);
          model.activeRestId = null;
          model.activeBinarySubId = null;
          model.activeWsSubId = null;

          const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
          if (cid !== undefined) {
            model.allowedPriceIds.add(cid);
            model.expectedPriceId = cid;
            model.expectedPayloadSymbol = payloadSym;
            model.expectedLoading = false;
            model.expectedError = null;
          } else {
            model.expectedPriceId = pid;
            model.expectedPayloadSymbol = payloadSym;
            model.expectedLoading = true;
            model.expectedError = null;
          }

          act(() => {
            if (wsFirst) {
              activeWs!.cb(makeWsMessage(payloadSym, pid));
              emitSessionChange('token_rotation');
            } else {
              emitSessionChange('token_rotation');
              activeWs!.cb(makeWsMessage(payloadSym, pid));
            }
          });
          await flushMicrotasks();

          for (const obs of observations.slice(obsStart)) {
            expect(obs.orderBook, `[seq=${seq} ${stepLabel}] must stay non-null`).not.toBeNull();
          }

          syncRestToModel(restBefore);
          syncSubscriptionsToModel(binBefore, wsBefore);
        } else if (pick < 0.65 && pendingRests.length > 0) {
          // REST resolve (active or stale)
          const chosen = pendingRests[Math.floor(rand() * pendingRests.length)];
          chosen.settled = true;
          const pid = allocPriceId();
          const isActive = chosen.id === model.activeRestId;
          stepLabel = `rest_resolve(id=${chosen.id},active=${isActive})`;

          if (isActive) {
            model.allowedPriceIds.add(pid);
            model.expectedPriceId = pid;
            model.expectedPayloadSymbol = chosen.payloadSymbol;
            model.expectedLoading = false;
          }

          chosen.deferred.resolve(makeRestBook(chosen.payloadSymbol, pid));
          await flushMicrotasks();
        } else if (pick < 0.76 && pendingRests.length > 0) {
          // REST reject (active or stale)
          const chosen = pendingRests[Math.floor(rand() * pendingRests.length)];
          chosen.settled = true;
          const isActive = chosen.id === model.activeRestId;
          const errMsg = `REST fail ${chosen.id}`;
          stepLabel = `rest_reject(id=${chosen.id},active=${isActive})`;

          if (isActive) {
            const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
            if (cid !== undefined) {
              model.allowedPriceIds.add(cid);
              model.expectedPriceId = cid;
              model.expectedPayloadSymbol = payloadSymbolFor(model.symbol);
              model.expectedError = null;
              model.expectedLoading = false;
            } else {
              model.expectedPriceId = null;
              model.expectedPayloadSymbol = null;
              model.expectedError = errMsg;
              model.expectedLoading = false;
            }
          }

          chosen.deferred.reject(new ApiError(501, errMsg));
          await flushMicrotasks();
        } else if (pick < 0.85 && mocks.wsSubs.length > 0) {
          // WS message on any sub ever created
          const sub = mocks.wsSubs[Math.floor(rand() * mocks.wsSubs.length)];
          const pid = allocPriceId();
          const isActive = sub.id === model.activeWsSubId;
          const payloadSym = payloadSymbolFor(sub.requestedSymbol);
          stepLabel = `ws(sub=${sub.id},active=${isActive})`;

          if (isActive) {
            model.allowedPriceIds.add(pid);
            model.expectedPriceId = pid;
            model.expectedPayloadSymbol = payloadSym;
          }

          act(() => {
            sub.cb(makeWsMessage(payloadSym, pid));
          });
        } else if (pick < 0.92 && mocks.binarySubs.length > 0) {
          // Binary depth update on any sub ever created
          const sub = mocks.binarySubs[Math.floor(rand() * mocks.binarySubs.length)];
          const pid = allocPriceId();
          const isActive = sub.id === model.activeBinarySubId;
          const payloadSym = payloadSymbolFor(sub.symbol);
          stepLabel = `binary(sub=${sub.id},active=${isActive})`;

          if (isActive) {
            model.allowedPriceIds.add(pid);
            model.expectedPriceId = pid;
            model.expectedPayloadSymbol = payloadSym;
            model.expectedError = null;
            model.expectedLoading = false;
          }

          act(() => {
            sub.cb(makeBinaryDepth(payloadSym, pid, pid));
          });
        } else if (pick < 0.96) {
          // Cache set or clear
          const targetSym = symbols[Math.floor(rand() * 4)];
          if (rand() < 0.7) {
            const cid = allocPriceId();
            stepLabel = `cache_set(${targetSym})`;
            model.cachePriceBySym.set(targetSym, cid);
            mocks.binaryLatestDepths.set(targetSym, makeBinaryDepth(payloadSymbolFor(targetSym), cid, cid));
          } else {
            stepLabel = `cache_clear(${targetSym})`;
            model.cachePriceBySym.delete(targetSym);
            mocks.binaryLatestDepths.delete(targetSym);
          }
        } else if (model.authenticated) {
          // Logout via store
          stepLabel = 'store_logout';
          currentAuth = false;
          model.authenticated = false;
          const nextOwnerKey = ownerKeyOf(model.symbol, false, model.session);
          const freshAllowed = new Set<number>();
          ownerAllowedSets.set(nextOwnerKey, freshAllowed);
          model.allowedPriceIds = freshAllowed;
          model.activeRestId = null;
          model.activeBinarySubId = null;
          model.activeWsSubId = null;
          model.expectedPriceId = null;
          model.expectedPayloadSymbol = null;
          model.expectedLoading = false;
          model.expectedError = null;

          act(() => {
            useAppStore.setState({ isAuthenticated: false, authToken: null });
          });
          await flushMicrotasks();
        } else {
          // Login via store
          stepLabel = 'store_login';
          currentAuth = true;
          model.authenticated = true;
          const nextOwnerKey = ownerKeyOf(model.symbol, true, model.session);
          const freshAllowed = new Set<number>();
          ownerAllowedSets.set(nextOwnerKey, freshAllowed);
          model.allowedPriceIds = freshAllowed;
          model.activeRestId = null;
          model.activeBinarySubId = null;
          model.activeWsSubId = null;

          if (!model.symbol) {
            model.expectedPriceId = null;
            model.expectedPayloadSymbol = null;
            model.expectedLoading = false;
            model.expectedError = null;
          } else {
            const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
            if (cid !== undefined) {
              freshAllowed.add(cid);
              model.expectedPriceId = cid;
              model.expectedPayloadSymbol = payloadSymbolFor(model.symbol);
              model.expectedLoading = false;
              model.expectedError = null;
            } else {
              model.expectedPriceId = null;
              model.expectedPayloadSymbol = null;
              model.expectedLoading = true;
              model.expectedError = null;
            }
          }

          act(() => {
            useAppStore.setState({ isAuthenticated: true, authToken: `seq2-${seq}-login-${step}` });
          });
          await flushMicrotasks();
          syncRestToModel(restBefore);
          syncSubscriptionsToModel(binBefore, wsBefore);
        }

        checkRenderObservations(obsStart, `step=${step} ${stepLabel}`);
        checkPostStepModel(`step=${step} ${stepLabel}`);
      }

      hookRef.unmount();
      const leftover = mocks.openRests.find((r) => !r.settled);
      if (leftover) {
        leftover.settled = true;
        leftover.deferred.resolve(makeRestBook(leftover.payloadSymbol, allocPriceId()));
        await flushMicrotasks();
      }
      const lastWs = mocks.wsSubs[mocks.wsSubs.length - 1];
      if (lastWs) {
        expect(lastWs.active).toBe(false);
        act(() => {
          lastWs.cb(makeWsMessage(payloadSymbolFor(lastWs.requestedSymbol), allocPriceId()));
        });
      }
      cleanup();
    }

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  }, 60_000);
});
