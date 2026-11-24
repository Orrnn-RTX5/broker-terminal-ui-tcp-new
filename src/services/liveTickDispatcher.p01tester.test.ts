// @vitest-environment jsdom

/**
 * P01 round 9, step 5 (independent tester): single-application and identity checks across
 * liveTickDispatcher, marketWatchQuoteCache, useAppStore, and useMarketDataStore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workerMocks = vi.hoisted(() => ({
  aggregateMultipleTimeframes: vi.fn(),
  aggregateSymbols: vi.fn(),
}));
vi.mock('./aggregationWorkerManager', () => ({
  cancelPendingAggregations: vi.fn(),
  getWorkerManager: () => workerMocks,
}));
vi.mock('./marketWatchDailyChangeCache', () => ({
  flushMarketWatchDailyChangeCache: vi.fn(),
  rememberCurrentMarketWatchDailyChange: vi.fn(),
}));
// Pass-through spy: the real cache runs, and each call's result says whether it wrote an entry (returned true).
vi.mock('./marketWatchQuoteCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./marketWatchQuoteCache')>();
  return {
    ...actual,
    rememberCurrentMarketWatchQuote: vi.fn(actual.rememberCurrentMarketWatchQuote),
  };
});

import { useAppStore } from '../store/useAppStore';
import { useMarketDataStore } from '../store/useMarketDataStore';
import { buildSpreadMarkupMap } from '../utils/spreadMarkup';
import { resetAccountSpreadMarkupForTests, setAccountSpreadMarkups } from './accountSpreadMarkup';
import {
  commitBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScopeKey,
} from './brokerSession';
import {
  enqueueLiveTick,
  flushLiveTicks,
  resetLiveTickDispatcherForTests,
} from './liveTickDispatcher';
import {
  readMarketWatchQuotes,
  readMarketWatchRawQuotes,
  rememberCurrentMarketWatchQuote,
  resetMarketWatchQuoteCacheForTests,
} from './marketWatchQuoteCache';

const TS = Date.now() - 60_000;
const eurusdMarkup = (points: number) => buildSpreadMarkupMap([
  { symbol: 'EURUSD', spreadMarkup: points, tickSize: 0.00001, digits: 5 },
]);

const makeRawTick = () => ({
  symbol: 'EURUSD',
  bid: 1.1,
  ask: 1.10012,
  spread: 0.00012,
  timestamp: TS,
  sourceTimestamp: TS,
});

describe('P01 round 9 step 5 (tester): liveTickDispatcher single widening and identity', () => {
  let scopeKey = '';

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    resetLiveTickDispatcherForTests();
    resetAccountSpreadMarkupForTests();
    resetMarketWatchQuoteCacheForTests();
    window.rtxTickCache = new Map();
    useMarketDataStore.getState().clearAllData();
    useAppStore.setState({ ticks: {}, tickLookup: {}, isAuthenticated: true, accountId: '1001' });
    commitBrokerAccountSessionScope({
      authenticated: true,
      accountId: '1001',
      brokerId: 'broker-a',
      serverUrl: 'https://broker-a.test',
    });
    scopeKey = getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope());
  });

  afterEach(() => {
    resetLiveTickDispatcherForTests();
    resetAccountSpreadMarkupForTests();
    resetMarketWatchQuoteCacheForTests();
    commitBrokerAccountSessionScope({ authenticated: false, accountId: null });
    useAppStore.setState({ ticks: {}, tickLookup: {}, isAuthenticated: false, accountId: null });
    vi.unstubAllGlobals();
  });

  it('unchanged tick and equal markup map preserve store tick object identity with zero store updates', () => {
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    enqueueLiveTick('EURUSD', makeRawTick());
    flushLiveTicks();

    const firstAppTick = useAppStore.getState().ticks.EURUSD;
    const firstMarketTick = useMarketDataStore.getState().symbolData.EURUSD?.currentTick;
    expect(firstAppTick).toMatchObject({ bid: 1.09997, ask: 1.10014, rawBid: 1.1, rawAsk: 1.10012 });

    const appListener = vi.fn();
    const marketListener = vi.fn();
    const unsubApp = useAppStore.subscribe(appListener);
    const unsubMarket = useMarketDataStore.subscribe(marketListener);

    // Identical raw tick replay: 0 store notifications and same tick reference.
    enqueueLiveTick('EURUSD', makeRawTick());
    flushLiveTicks();
    expect(appListener).not.toHaveBeenCalled();
    expect(marketListener).not.toHaveBeenCalled();
    expect(useAppStore.getState().ticks.EURUSD).toBe(firstAppTick);
    expect(useMarketDataStore.getState().symbolData.EURUSD?.currentTick).toBe(firstMarketTick);

    // Equal markup map: 0 store notifications and same tick reference.
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    flushLiveTicks();
    expect(appListener).not.toHaveBeenCalled();
    expect(marketListener).not.toHaveBeenCalled();
    expect(useAppStore.getState().ticks.EURUSD).toBe(firstAppTick);
    expect(useMarketDataStore.getState().symbolData.EURUSD?.currentTick).toBe(firstMarketTick);

    unsubApp();
    unsubMarket();
  });

  it('markup changes re-widen live stores and Market Watch cache exactly once each from raw (m=5 -> 10 -> 7 -> logout; the logout store writes are counted after its setState)', () => {
    const appWrites = vi.fn();
    const marketWrites = vi.fn();
    const unsubApp = useAppStore.subscribe(appWrites);
    const unsubMarket = useMarketDataStore.subscribe(marketWrites);
    const cacheWrite = vi.mocked(rememberCurrentMarketWatchQuote);
    // A Market Watch cache write is a call that returned true (it stored an entry).
    const cacheWrites = () => cacheWrite.mock.results
      .filter((result) => result.type === 'return' && result.value === true).length;
    cacheWrite.mockClear();
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    enqueueLiveTick('EURUSD', makeRawTick());
    flushLiveTicks();
    // The first delivery: exactly one write to each store and one to the Market Watch cache.
    expect(appWrites).toHaveBeenCalledTimes(1);
    expect(marketWrites).toHaveBeenCalledTimes(1);
    expect(cacheWrites()).toBe(1);

    const verifyShown = (bid: number, ask: number, expectRawTag: boolean) => {
      const appTick = useAppStore.getState().ticks.EURUSD as unknown as Record<string, unknown>;
      const marketTick = useMarketDataStore.getState().symbolData.EURUSD?.currentTick as unknown as Record<string, unknown>;
      expect(appTick.bid).toBe(bid);
      expect(appTick.ask).toBe(ask);
      expect(marketTick.bid).toBe(bid);
      expect(marketTick.ask).toBe(ask);
      if (expectRawTag) {
        expect(appTick.rawBid).toBe(1.1);
        expect(appTick.rawAsk).toBe(1.10012);
      } else {
        expect(appTick.rawBid).toBeUndefined();
        expect(appTick.rawAsk).toBeUndefined();
      }
      expect(readMarketWatchQuotes(scopeKey, ['EURUSD']).EURUSD).toEqual({ bid, ask, asOf: TS });
      expect(readMarketWatchRawQuotes(scopeKey, ['EURUSD']).EURUSD).toEqual({ bid: 1.1, ask: 1.10012, asOf: TS });
    };

    verifyShown(1.09997, 1.10014, true);

    // Each markup change: exactly one write to each store and to the Market Watch cache, re-widened from raw.
    appWrites.mockClear();
    marketWrites.mockClear();
    cacheWrite.mockClear();
    setAccountSpreadMarkups('1001', eurusdMarkup(10));
    flushLiveTicks();
    expect(appWrites).toHaveBeenCalledTimes(1);
    expect(marketWrites).toHaveBeenCalledTimes(1);
    expect(cacheWrites()).toBe(1);
    verifyShown(1.09995, 1.10017, true);

    appWrites.mockClear();
    marketWrites.mockClear();
    cacheWrite.mockClear();
    setAccountSpreadMarkups('1001', eurusdMarkup(7));
    flushLiveTicks();
    expect(appWrites).toHaveBeenCalledTimes(1);
    expect(marketWrites).toHaveBeenCalledTimes(1);
    expect(cacheWrites()).toBe(1);
    verifyShown(1.09996, 1.10015, true);

    // Logout: the isAuthenticated write itself is cleared from the store count, so only the flush's store writes are counted.
    // The cache is counted from before this setState: the logout clears the markup, which re-ingests the quote synchronously.
    cacheWrite.mockClear();
    useAppStore.setState({ isAuthenticated: false });
    appWrites.mockClear();
    marketWrites.mockClear();
    flushLiveTicks();
    expect(appWrites).toHaveBeenCalledTimes(1);
    expect(marketWrites).toHaveBeenCalledTimes(1);
    expect(cacheWrites()).toBe(1);
    verifyShown(1.1, 1.10012, false);

    unsubApp();
    unsubMarket();
  });
});
