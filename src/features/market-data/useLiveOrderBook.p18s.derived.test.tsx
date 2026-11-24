// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { resetAccountSpreadMarkupForTests } from '../../services/accountSpreadMarkup';
import type { DecodedBinaryDepth } from '../../services/binaryTcpMarketStream';
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
    { price: Number((bid - 0.1).toFixed(2)), volume: volume + 5 },
  ],
  asks: [
    { price: ask, volume },
    { price: Number((ask + 0.1).toFixed(2)), volume: volume + 5 },
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
    { price: Number((bid - 0.1).toFixed(2)), volume: volume + 5, total: volume * 2 + 5 },
  ],
  asks: [
    { price: ask, volume, total: volume },
    { price: Number((ask + 0.1).toFixed(2)), volume: volume + 5, total: volume * 2 + 5 },
  ],
  spread: Number((ask - bid).toFixed(2)),
});

const makeWsMessage = (symbol: string, bid: number, ask: number, volume = 10, tsOffset = 1) => ({
  symbol,
  bids: [
    { price: bid, volume },
    { price: Number((bid - 0.1).toFixed(2)), volume: volume + 5 },
  ],
  asks: [
    { price: ask, volume },
    { price: Number((ask + 0.1).toFixed(2)), volume: volume + 5 },
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

describe("P18S S1' derived-symbol request ownership", () => {
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

  it("S1' (ii) [WS]: switching from WS-loaded derived XAUUSD.VIP (payload XAUUSD) to uncached EURUSD clears immediately on first EURUSD render", async () => {
    const restDerived = createDeferred<unknown>();
    const restEur = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restDerived.promise)
      .mockReturnValueOnce(restEur.promise);

    const { result, rerender, observations } = renderTrackedBook('XAUUSD.VIP');
    const wsDerived = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.XAUUSD.VIP');
    expect(wsDerived).toBeDefined();

    act(() => {
      wsDerived!.cb(makeWsMessage('XAUUSD', 2701.1, 2701.4, 21, 1));
    });
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2701.1);

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'EURUSD', d: 10 });
    await flushMicrotasks();

    const pendingObs = observations.slice(countBeforeSwitch);
    expect(pendingObs.length).toBeGreaterThanOrEqual(1);
    for (const obs of pendingObs) {
      expect(obs.orderBook).toBeNull();
      expect(obs.orderBook?.bids[0]?.price).not.toBe(2701.1);
      expect(obs.error).toBeNull();
    }
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    const wsEur = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.EURUSD');
    expect(wsEur).toBeDefined();
    act(() => {
      wsEur!.cb(makeWsMessage('EURUSD', 1.105, 1.1052, 31, 2));
    });

    expect(result.current.orderBook?.symbol).toBe('EURUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.105);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(31);
  });

  it("S1' (ii) [REST]: switching from REST-loaded derived XAUUSD.VIP (payload XAUUSD) to uncached EURUSD clears immediately on first EURUSD render", async () => {
    const restDerived = createDeferred<unknown>();
    const restEur = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restDerived.promise)
      .mockReturnValueOnce(restEur.promise);

    const { result, rerender, observations } = renderTrackedBook('XAUUSD.VIP');
    restDerived.resolve(makeRestBook('XAUUSD', 2702.1, 2702.4, 22));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2702.1);

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'EURUSD', d: 10 });
    await flushMicrotasks();

    const pendingObs = observations.slice(countBeforeSwitch);
    expect(pendingObs.length).toBeGreaterThanOrEqual(1);
    for (const obs of pendingObs) {
      expect(obs.orderBook).toBeNull();
      expect(obs.orderBook?.bids[0]?.price).not.toBe(2702.1);
      expect(obs.error).toBeNull();
    }
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    restEur.resolve(makeRestBook('EURUSD', 1.105, 1.1052, 31));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('EURUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(1.105);
  });

  it("S1' (iii) [WS]: switching from parent XAUUSD to derived XAUUSD.VIP clears at once and shows loading despite identical payload symbol XAUUSD", async () => {
    const restParent = createDeferred<unknown>();
    const restDerived = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restParent.promise)
      .mockReturnValueOnce(restDerived.promise);

    const { result, rerender, observations } = renderTrackedBook('XAUUSD');
    const wsParent = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.XAUUSD');
    expect(wsParent).toBeDefined();

    act(() => {
      wsParent!.cb(makeWsMessage('XAUUSD', 2601.1, 2601.4, 11, 1));
    });
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2601.1);

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'XAUUSD.VIP', d: 10 });
    await flushMicrotasks();

    const pendingObs = observations.slice(countBeforeSwitch);
    expect(pendingObs.length).toBeGreaterThanOrEqual(1);
    for (const obs of pendingObs) {
      expect(obs.orderBook).toBeNull();
      expect(obs.orderBook?.bids[0]?.price).not.toBe(2601.1);
      expect(obs.error).toBeNull();
    }
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    const wsDerived = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.XAUUSD.VIP');
    expect(wsDerived).toBeDefined();
    act(() => {
      wsDerived!.cb(makeWsMessage('XAUUSD', 2701.1, 2701.4, 21, 2));
    });

    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2701.1);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(21);

    for (const obs of observations.slice(countBeforeSwitch)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD'
          && obs.orderBook.bids[0]?.price === 2701.1
          && obs.orderBook.bids[0]?.volume === 21),
      ).toBe(true);
    }
  });

  it("S1' (iii) [WS]: switching from derived XAUUSD.VIP to parent XAUUSD clears at once and shows loading despite identical payload symbol XAUUSD", async () => {
    const restDerived = createDeferred<unknown>();
    const restParent = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restDerived.promise)
      .mockReturnValueOnce(restParent.promise);

    const { result, rerender, observations } = renderTrackedBook('XAUUSD.VIP');
    const wsDerived = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.XAUUSD.VIP');
    expect(wsDerived).toBeDefined();

    act(() => {
      wsDerived!.cb(makeWsMessage('XAUUSD', 2701.1, 2701.4, 21, 1));
    });
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2701.1);

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'XAUUSD', d: 10 });
    await flushMicrotasks();

    const pendingObs = observations.slice(countBeforeSwitch);
    expect(pendingObs.length).toBeGreaterThanOrEqual(1);
    for (const obs of pendingObs) {
      expect(obs.orderBook).toBeNull();
      expect(obs.orderBook?.bids[0]?.price).not.toBe(2701.1);
      expect(obs.error).toBeNull();
    }
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    const wsParent = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.XAUUSD');
    expect(wsParent).toBeDefined();
    act(() => {
      wsParent!.cb(makeWsMessage('XAUUSD', 2601.1, 2601.4, 11, 2));
    });

    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2601.1);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(11);

    for (const obs of observations.slice(countBeforeSwitch)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD'
          && obs.orderBook.bids[0]?.price === 2601.1
          && obs.orderBook.bids[0]?.volume === 11),
      ).toBe(true);
    }
  });

  it("S1' (iii) [REST]: switching from parent XAUUSD to derived XAUUSD.VIP clears at once and shows loading despite identical payload symbol XAUUSD", async () => {
    const restParent = createDeferred<unknown>();
    const restDerived = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restParent.promise)
      .mockReturnValueOnce(restDerived.promise);

    const { result, rerender, observations } = renderTrackedBook('XAUUSD');
    restParent.resolve(makeRestBook('XAUUSD', 2602.1, 2602.4, 12));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2602.1);

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'XAUUSD.VIP', d: 10 });
    await flushMicrotasks();

    const pendingObs = observations.slice(countBeforeSwitch);
    expect(pendingObs.length).toBeGreaterThanOrEqual(1);
    for (const obs of pendingObs) {
      expect(obs.orderBook).toBeNull();
      expect(obs.orderBook?.bids[0]?.price).not.toBe(2602.1);
      expect(obs.error).toBeNull();
    }
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    restDerived.resolve(makeRestBook('XAUUSD', 2702.1, 2702.4, 22));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2702.1);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(22);
    expect(result.current.error).toBeNull();

    for (const obs of observations.slice(countBeforeSwitch)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD' && obs.orderBook.bids[0]?.price === 2702.1),
      ).toBe(true);
    }
  });

  it("S1' (iii) [REST]: switching from derived XAUUSD.VIP to parent XAUUSD clears at once and shows loading despite identical payload symbol XAUUSD", async () => {
    const restDerived = createDeferred<unknown>();
    const restParent = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restDerived.promise)
      .mockReturnValueOnce(restParent.promise);

    const { result, rerender, observations } = renderTrackedBook('XAUUSD.VIP');
    restDerived.resolve(makeRestBook('XAUUSD', 2702.1, 2702.4, 22));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2702.1);

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'XAUUSD', d: 10 });
    await flushMicrotasks();

    const pendingObs = observations.slice(countBeforeSwitch);
    expect(pendingObs.length).toBeGreaterThanOrEqual(1);
    for (const obs of pendingObs) {
      expect(obs.orderBook).toBeNull();
      expect(obs.orderBook?.bids[0]?.price).not.toBe(2702.1);
      expect(obs.error).toBeNull();
    }
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    restParent.resolve(makeRestBook('XAUUSD', 2602.1, 2602.4, 12));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2602.1);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(12);
    expect(result.current.error).toBeNull();

    for (const obs of observations.slice(countBeforeSwitch)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD' && obs.orderBook.bids[0]?.price === 2602.1),
      ).toBe(true);
    }
  });

  it("S1' (iv) [WS]: late callback on depth.XAUUSD never lands while asked for XAUUSD.VIP", async () => {
    const restParent = createDeferred<unknown>();
    const restDerived = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restParent.promise)
      .mockReturnValueOnce(restDerived.promise);

    const { result, rerender, observations } = renderTrackedBook('XAUUSD');
    const wsParent = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.XAUUSD');
    expect(wsParent).toBeDefined();

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'XAUUSD.VIP', d: 10 });
    await flushMicrotasks();

    const wsDerived = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.XAUUSD.VIP');
    expect(wsDerived).toBeDefined();

    act(() => {
      wsParent!.cb(makeWsMessage('XAUUSD', 2609.1, 2609.4, 19, 1));
    });
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    act(() => {
      wsDerived!.cb(makeWsMessage('XAUUSD', 2701.1, 2701.4, 21, 2));
    });
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2701.1);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(21);

    act(() => {
      wsParent!.cb(makeWsMessage('XAUUSD', 2609.5, 2609.8, 19, 3));
    });
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2701.1);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(21);

    for (const obs of observations.slice(countBeforeSwitch)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD'
          && obs.orderBook.bids[0]?.price === 2701.1
          && obs.orderBook.bids[0]?.volume === 21),
      ).toBe(true);
    }
  });

  it("S1' (iv) [WS]: late callback on depth.XAUUSD.VIP never lands while asked for XAUUSD", async () => {
    const restDerived = createDeferred<unknown>();
    const restParent = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restDerived.promise)
      .mockReturnValueOnce(restParent.promise);

    const { result, rerender, observations } = renderTrackedBook('XAUUSD.VIP');
    const wsDerived = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.XAUUSD.VIP');
    expect(wsDerived).toBeDefined();

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'XAUUSD', d: 10 });
    await flushMicrotasks();

    const wsParent = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.XAUUSD');
    expect(wsParent).toBeDefined();

    act(() => {
      wsDerived!.cb(makeWsMessage('XAUUSD', 2709.1, 2709.4, 29, 1));
    });
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    act(() => {
      wsParent!.cb(makeWsMessage('XAUUSD', 2601.1, 2601.4, 11, 2));
    });
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2601.1);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(11);

    act(() => {
      wsDerived!.cb(makeWsMessage('XAUUSD', 2709.5, 2709.8, 29, 3));
    });
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2601.1);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(11);

    for (const obs of observations.slice(countBeforeSwitch)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD'
          && obs.orderBook.bids[0]?.price === 2601.1
          && obs.orderBook.bids[0]?.volume === 11),
      ).toBe(true);
    }
  });

  it("S1' (iv) [REST]: XAUUSD -> XAUUSD.VIP, late parent REST resolves or rejects while derived is pending without disturbing derived", async () => {
    const restParent1 = createDeferred<unknown>();
    const restDerived1 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restParent1.promise)
      .mockReturnValueOnce(restDerived1.promise);

    const h1 = renderTrackedBook('XAUUSD');
    const countBeforeSwitch1 = h1.observations.length;
    h1.rerender({ sym: 'XAUUSD.VIP', d: 10 });
    await flushMicrotasks();

    restParent1.resolve(makeRestBook('XAUUSD', 2609.1, 2609.4, 19));
    await flushMicrotasks();

    expect(h1.result.current.orderBook).toBeNull();
    expect(h1.result.current.loading).toBe(true);
    expect(h1.result.current.error).toBeNull();

    restDerived1.resolve(makeRestBook('XAUUSD', 2702.1, 2702.4, 22));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));
    expect(h1.result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(2702.1);
    expect(h1.result.current.orderBook?.bids[0]?.volume).toBe(22);
    expect(h1.result.current.error).toBeNull();

    for (const obs of h1.observations.slice(countBeforeSwitch1)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD' && obs.orderBook.bids[0]?.price === 2702.1),
      ).toBe(true);
    }
    h1.unmount();

    mocks.fetchMarketDataJson.mockReset();
    const restParent2 = createDeferred<unknown>();
    const restDerived2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restParent2.promise)
      .mockReturnValueOnce(restDerived2.promise);

    const h2 = renderTrackedBook('XAUUSD');
    const countBeforeSwitch2 = h2.observations.length;
    h2.rerender({ sym: 'XAUUSD.VIP', d: 10 });
    await flushMicrotasks();

    restParent2.reject(new ApiError(503, 'parent failed'));
    await flushMicrotasks();

    expect(h2.result.current.orderBook).toBeNull();
    expect(h2.result.current.loading).toBe(true);
    expect(h2.result.current.error).toBeNull();

    for (const obs of h2.observations.slice(countBeforeSwitch2)) {
      expect(obs.orderBook).toBeNull();
      expect(obs.error).toBeNull();
    }
  });

  it("S1' (iv) [REST]: XAUUSD -> XAUUSD.VIP, derived REST answers first then late parent REST resolves or rejects without disturbing derived", async () => {
    const restParent1 = createDeferred<unknown>();
    const restDerived1 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restParent1.promise)
      .mockReturnValueOnce(restDerived1.promise);

    const h1 = renderTrackedBook('XAUUSD');
    const countBeforeSwitch1 = h1.observations.length;
    h1.rerender({ sym: 'XAUUSD.VIP', d: 10 });
    await flushMicrotasks();

    restDerived1.resolve(makeRestBook('XAUUSD', 2702.1, 2702.4, 22));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));

    restParent1.resolve(makeRestBook('XAUUSD', 2609.1, 2609.4, 19));
    await flushMicrotasks();

    expect(h1.result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(2702.1);
    expect(h1.result.current.orderBook?.bids[0]?.volume).toBe(22);
    expect(h1.result.current.loading).toBe(false);
    expect(h1.result.current.error).toBeNull();

    for (const obs of h1.observations.slice(countBeforeSwitch1)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD' && obs.orderBook.bids[0]?.price === 2702.1),
      ).toBe(true);
    }
    h1.unmount();

    mocks.fetchMarketDataJson.mockReset();
    const restParent2 = createDeferred<unknown>();
    const restDerived2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restParent2.promise)
      .mockReturnValueOnce(restDerived2.promise);

    const h2 = renderTrackedBook('XAUUSD');
    const countBeforeSwitch2 = h2.observations.length;
    h2.rerender({ sym: 'XAUUSD.VIP', d: 10 });
    await flushMicrotasks();

    restDerived2.resolve(makeRestBook('XAUUSD', 2703.1, 2703.4, 23));
    await waitFor(() => expect(h2.result.current.loading).toBe(false));

    restParent2.reject(new ApiError(500, 'late parent error'));
    await flushMicrotasks();

    expect(h2.result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(h2.result.current.orderBook?.bids[0]?.price).toBe(2703.1);
    expect(h2.result.current.loading).toBe(false);
    expect(h2.result.current.error).toBeNull();

    for (const obs of h2.observations.slice(countBeforeSwitch2)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD' && obs.orderBook.bids[0]?.price === 2703.1),
      ).toBe(true);
    }
  });

  it("S1' (iv) [REST]: XAUUSD.VIP -> XAUUSD, late derived REST resolves or rejects while parent is pending without disturbing parent", async () => {
    const restDerived1 = createDeferred<unknown>();
    const restParent1 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restDerived1.promise)
      .mockReturnValueOnce(restParent1.promise);

    const h1 = renderTrackedBook('XAUUSD.VIP');
    const countBeforeSwitch1 = h1.observations.length;
    h1.rerender({ sym: 'XAUUSD', d: 10 });
    await flushMicrotasks();

    restDerived1.resolve(makeRestBook('XAUUSD', 2709.1, 2709.4, 29));
    await flushMicrotasks();

    expect(h1.result.current.orderBook).toBeNull();
    expect(h1.result.current.loading).toBe(true);
    expect(h1.result.current.error).toBeNull();

    restParent1.resolve(makeRestBook('XAUUSD', 2602.1, 2602.4, 12));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));
    expect(h1.result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(2602.1);
    expect(h1.result.current.orderBook?.bids[0]?.volume).toBe(12);

    for (const obs of h1.observations.slice(countBeforeSwitch1)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD' && obs.orderBook.bids[0]?.price === 2602.1),
      ).toBe(true);
    }
    h1.unmount();

    mocks.fetchMarketDataJson.mockReset();
    const restDerived2 = createDeferred<unknown>();
    const restParent2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restDerived2.promise)
      .mockReturnValueOnce(restParent2.promise);

    const h2 = renderTrackedBook('XAUUSD.VIP');
    const countBeforeSwitch2 = h2.observations.length;
    h2.rerender({ sym: 'XAUUSD', d: 10 });
    await flushMicrotasks();

    restDerived2.reject(new ApiError(501, 'DEPTH_UNSUPPORTED'));
    await flushMicrotasks();

    expect(h2.result.current.orderBook).toBeNull();
    expect(h2.result.current.loading).toBe(true);
    expect(h2.result.current.error).toBeNull();

    for (const obs of h2.observations.slice(countBeforeSwitch2)) {
      expect(obs.orderBook).toBeNull();
      expect(obs.error).toBeNull();
    }
  });

  it("S1' (iv) [REST]: XAUUSD.VIP -> XAUUSD, parent REST answers first then late derived REST resolves or rejects without disturbing parent", async () => {
    const restDerived1 = createDeferred<unknown>();
    const restParent1 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restDerived1.promise)
      .mockReturnValueOnce(restParent1.promise);

    const h1 = renderTrackedBook('XAUUSD.VIP');
    const countBeforeSwitch1 = h1.observations.length;
    h1.rerender({ sym: 'XAUUSD', d: 10 });
    await flushMicrotasks();

    restParent1.resolve(makeRestBook('XAUUSD', 2602.1, 2602.4, 12));
    await waitFor(() => expect(h1.result.current.loading).toBe(false));

    restDerived1.resolve(makeRestBook('XAUUSD', 2709.1, 2709.4, 29));
    await flushMicrotasks();

    expect(h1.result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(h1.result.current.orderBook?.bids[0]?.price).toBe(2602.1);
    expect(h1.result.current.loading).toBe(false);
    expect(h1.result.current.error).toBeNull();

    for (const obs of h1.observations.slice(countBeforeSwitch1)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD' && obs.orderBook.bids[0]?.price === 2602.1),
      ).toBe(true);
    }
    h1.unmount();

    mocks.fetchMarketDataJson.mockReset();
    const restDerived2 = createDeferred<unknown>();
    const restParent2 = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restDerived2.promise)
      .mockReturnValueOnce(restParent2.promise);

    const h2 = renderTrackedBook('XAUUSD.VIP');
    const countBeforeSwitch2 = h2.observations.length;
    h2.rerender({ sym: 'XAUUSD', d: 10 });
    await flushMicrotasks();

    restParent2.resolve(makeRestBook('XAUUSD', 2603.1, 2603.4, 13));
    await waitFor(() => expect(h2.result.current.loading).toBe(false));

    restDerived2.reject(new ApiError(501, 'DEPTH_UNSUPPORTED'));
    await flushMicrotasks();

    expect(h2.result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(h2.result.current.orderBook?.bids[0]?.price).toBe(2603.1);
    expect(h2.result.current.loading).toBe(false);
    expect(h2.result.current.error).toBeNull();

    for (const obs of h2.observations.slice(countBeforeSwitch2)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD' && obs.orderBook.bids[0]?.price === 2603.1),
      ).toBe(true);
    }
  });

  it("S1' (iii)/(iv) [Binary]: switching from binary-cached parent XAUUSD to uncached derived XAUUSD.VIP clears at once and ignores late parent binary callback and cache fallback", async () => {
    mocks.binarySupported.value = true;
    mocks.binaryLatestDepths.set('XAUUSD', makeBinaryDepth('XAUUSD', 2601.1, 2601.4, 1, 11));

    const restParent = createDeferred<unknown>();
    const restDerived = createDeferred<unknown>();
    mocks.fetchMarketDataJson
      .mockReturnValueOnce(restParent.promise)
      .mockReturnValueOnce(restDerived.promise);

    const { result, rerender, observations } = renderTrackedBook('XAUUSD');
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2601.1);

    const binParent = mocks.binaryCapturedListeners.find((entry) => entry.symbol === 'XAUUSD');
    expect(binParent).toBeDefined();

    const countBeforeSwitch = observations.length;
    rerender({ sym: 'XAUUSD.VIP', d: 10 });
    await flushMicrotasks();

    for (const obs of observations.slice(countBeforeSwitch)) {
      expect(obs.orderBook).toBeNull();
      expect(obs.error).toBeNull();
    }
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    act(() => {
      binParent!.cb(makeBinaryDepth('XAUUSD', 2609.1, 2609.4, 2, 19));
    });
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);

    restParent.reject(new ApiError(501, 'DEPTH_UNSUPPORTED'));
    await flushMicrotasks();
    expect(result.current.orderBook).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    const wsDerived = mocks.wsCapturedListeners.find((entry) => entry.channel === 'depth.XAUUSD.VIP');
    expect(wsDerived).toBeDefined();
    act(() => {
      wsDerived!.cb(makeWsMessage('XAUUSD', 2701.1, 2701.4, 21, 3));
    });
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2701.1);
    expect(result.current.orderBook?.bids[0]?.volume).toBe(21);

    act(() => {
      binParent!.cb(makeBinaryDepth('XAUUSD', 2609.5, 2609.8, 3, 19));
    });
    expect(result.current.orderBook?.symbol).toBe('XAUUSD');
    expect(result.current.orderBook?.bids[0]?.price).toBe(2701.1);

    for (const obs of observations.slice(countBeforeSwitch)) {
      expect(
        obs.orderBook === null
        || (obs.orderBook.symbol === 'XAUUSD'
          && obs.orderBook.bids[0]?.price === 2701.1
          && obs.orderBook.bids[0]?.volume === 21),
      ).toBe(true);
    }
  });

  it.each([
    ['P1', 'D', 'P2'],
    ['P1', 'P2', 'D'],
    ['D', 'P1', 'P2'],
    ['D', 'P2', 'P1'],
    ['P2', 'P1', 'D'],
    ['P2', 'D', 'P1'],
  ] as const)(
    "S1' (iii)/(iv) [REST]: rapid XAUUSD -> XAUUSD.VIP -> XAUUSD with settlement order [%s, %s, %s] never exposes wrong request book despite identical payload symbol and ends on P2",
    async (first, second, third) => {
      const requests = {
        P1: createDeferred<unknown>(),
        D: createDeferred<unknown>(),
        P2: createDeferred<unknown>(),
      };
      const payloads = {
        P1: makeRestBook('XAUUSD', 2600.01, 2600.31, 11),
        D: makeRestBook('XAUUSD', 2700.02, 2700.32, 22),
        P2: makeRestBook('XAUUSD', 2600.03, 2600.33, 33),
      };

      mocks.fetchMarketDataJson
        .mockReturnValueOnce(requests.P1.promise)
        .mockReturnValueOnce(requests.D.promise)
        .mockReturnValueOnce(requests.P2.promise);

      const { result, rerender, observations } = renderTrackedBook('XAUUSD');
      rerender({ sym: 'XAUUSD.VIP', d: 10 });
      rerender({ sym: 'XAUUSD', d: 10 });
      await flushMicrotasks();

      for (const key of [first, second, third]) {
        requests[key].resolve(payloads[key]);
        await flushMicrotasks();
      }

      for (const obs of observations) {
        if (obs.orderBook !== null) {
          expect(obs.orderBook.symbol).toBe('XAUUSD');
          const bid = obs.orderBook.bids[0]?.price;
          expect(obs.symbol === 'XAUUSD' ? bid === 2600.03 : bid === 2700.02).toBe(true);
        }
      }

      expect(result.current.orderBook?.symbol).toBe('XAUUSD');
      expect(result.current.orderBook?.bids[0]?.price).toBe(2600.03);
      expect(result.current.orderBook?.bids[0]?.volume).toBe(33);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    },
  );
});
