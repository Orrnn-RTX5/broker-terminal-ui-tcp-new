/**
 * P01 step 3 (independent tester): the closed-market Market Watch fallback must show the account
 * spread markup exactly once, split the way the engine fills (spec Part A item 4).
 *
 * Quote used throughout: EURUSD raw bid 1.10000 (1.1), raw ask 1.10012, digits 5, tick = point = 0.00001.
 * Account markup m = 5 points, split as the backend does (spread_markup.go:41-47):
 *   ask gets floor(5 / 2) = 2 points, bid gets 5 - 2 = 3 points.
 *   shown bid = 1.10000 - 3 * 0.00001 = 1.09997
 *   shown ask = 1.10012 + 2 * 0.00001 = 1.10014
 *   shown spread = 0.00017 (raw 12 points + 5 markup points)
 * Wrong values this file guards against:
 *   full markup on both sides (HEAD, 2x widening):            1.09995 / 1.10017
 *   markup applied a second time to an already shown quote:   1.09994 / 1.10016
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAccountSpreadMarkups,
  resetAccountSpreadMarkupForTests,
  setAccountSpreadMarkups,
} from '../services/accountSpreadMarkup';
import {
  commitBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScopeKey,
} from '../services/brokerSession';
import { enqueueLiveTick, flushLiveTicks, resetLiveTickDispatcherForTests } from '../services/liveTickDispatcher';
import {
  flushMarketWatchQuoteCache,
  readMarketWatchQuotes,
  readMarketWatchRawQuotes,
  rememberMarketWatchQuote,
  resetMarketWatchQuoteCacheForTests,
} from '../services/marketWatchQuoteCache';
import { useAppStore } from '../store/useAppStore';
import { useMarketDataStore } from '../store/useMarketDataStore';
import { buildSpreadMarkupMap } from '../utils/spreadMarkup';
import { hydrateLastMarketWatchQuotes, useLastMarketWatchQuotes } from './useLastMarketWatchQuotes';

const apiGet = vi.hoisted(() => vi.fn());
const broker = vi.hoisted(() => ({ serverUrl: 'https://broker-a.test' }));
vi.mock('../services/aggregationWorkerManager', () => ({
  cancelPendingAggregations: vi.fn(),
  getWorkerManager: () => ({ aggregateMultipleTimeframes: vi.fn(), aggregateSymbols: vi.fn() }),
}));
vi.mock('../services/marketWatchDailyChangeCache', () => ({
  flushMarketWatchDailyChangeCache: vi.fn(),
  rememberCurrentMarketWatchDailyChange: vi.fn(),
}));
vi.mock('../services/brokerSession', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/brokerSession')>();
  return { ...actual, getServerUrl: () => broker.serverUrl };
});
vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, apiClient: { ...actual.apiClient, get: apiGet } };
});

const NOW = Date.now();
const SCOPE = 'scope-markup';

const eurusdMarkup = (points: number) => buildSpreadMarkupMap([
  { symbol: 'EURUSD', spreadMarkup: points, tickSize: 0.00001, digits: 5 },
]);

const signIn = (accountId = '1001') => {
  useAppStore.setState({ isAuthenticated: true, accountId });
};

const committedScopeKey = () => getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope());

describe('Market Watch closed-market fallback and the account spread markup (P01 Part A)', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    apiGet.mockReset();
    apiGet.mockResolvedValue([]);
    resetMarketWatchQuoteCacheForTests();
    resetLiveTickDispatcherForTests();
    resetAccountSpreadMarkupForTests();
    window.rtxTickCache = new Map();
    useMarketDataStore.getState().clearAllData();
    useAppStore.setState({
      ticks: {}, tickLookup: {}, authToken: null, refreshToken: null, isAuthenticated: false, accountId: null,
    });
    commitBrokerAccountSessionScope({ authenticated: false, brokerId: 'broker-a', serverUrl: broker.serverUrl });
  });

  afterEach(() => {
    cleanup();
    resetLiveTickDispatcherForTests();
    resetAccountSpreadMarkupForTests();
    resetMarketWatchQuoteCacheForTests();
    useAppStore.setState({ isAuthenticated: false, accountId: null });
    commitBrokerAccountSessionScope({ authenticated: false, brokerId: '', serverUrl: '' });
    vi.unstubAllGlobals();
  });

  it('widens a raw /ticks history quote once and keeps the stored pair raw', async () => {
    signIn();
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    apiGet.mockImplementation((path: string) => Promise.resolve(
      path === '/ticks/EURUSD' ? [{ bid: 1.1, ask: 1.10012, time: NOW - 60_000 }] : [],
    ));
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey: SCOPE, symbols: ['EURUSD'], candleSymbols: [],
    }));
    await waitFor(() => expect(result.current.get('EURUSD')?.kind).toBe('quote'));
    // Split once: bid 1.10000 - 3 points = 1.09997 ; ask 1.10012 + 2 points = 1.10014
    expect(result.current.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.09997, ask: 1.10014, asOf: NOW - 60_000 });
    // The cache keeps the raw broker pair.
    expect(readMarketWatchQuotes(SCOPE, ['EURUSD']).EURUSD).toEqual({ bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
  });

  it('widens a raw stored quote once with the split, not the full markup on both sides', () => {
    rememberMarketWatchQuote(SCOPE, 'EURUSD', { bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
    signIn();
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey: SCOPE, symbols: ['EURUSD'], candleSymbols: [],
    }));
    // Full markup on both sides would give 1.09995 / 1.10017 (HEAD).
    expect(result.current.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.09997, ask: 1.10014, asOf: NOW - 60_000 });
    expect(readMarketWatchQuotes(SCOPE, ['EURUSD']).EURUSD).toEqual({ bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
  });

  it('returns the raw stored pair when no account markup is registered', () => {
    rememberMarketWatchQuote(SCOPE, 'EURUSD', { bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey: SCOPE, symbols: ['EURUSD'], candleSymbols: [],
    }));
    expect(result.current.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
  });

  it('shows raw closed-market quotes again once the markup is cleared at logout', () => {
    rememberMarketWatchQuote(SCOPE, 'EURUSD', { bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
    signIn();
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey: SCOPE, symbols: ['EURUSD'], candleSymbols: [],
    }));
    expect(result.current.get('EURUSD')).toMatchObject({ kind: 'quote', bid: 1.09997, ask: 1.10014 });
    act(() => {
      clearAccountSpreadMarkups();
    });
    expect(result.current.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
    expect(readMarketWatchQuotes(SCOPE, ['EURUSD']).EURUSD).toEqual({ bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
  });

  it('does not apply the markup a second time to a quote the live funnel already stored', () => {
    commitBrokerAccountSessionScope({
      authenticated: true, accountId: '1001', brokerId: 'broker-a', serverUrl: broker.serverUrl,
    });
    const scopeKey = committedScopeKey();
    signIn('1001');
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    // The live funnel widens the tick once (src/services/liveTickDispatcher.ts:346) and then stores
    // the SHOWN bid/ask in the Market Watch cache (liveTickDispatcher.ts:458-462).
    enqueueLiveTick('EURUSD', {
      symbol: 'EURUSD', bid: 1.1, ask: 1.10012, spread: 0.00012, timestamp: NOW - 60_000, sourceTimestamp: NOW - 60_000,
    });
    flushLiveTicks();
    expect(readMarketWatchQuotes(scopeKey, ['EURUSD']).EURUSD)
      .toEqual({ bid: 1.09997, ask: 1.10014, asOf: NOW - 60_000 });
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey, symbols: ['EURUSD'], candleSymbols: [],
    }));
    // Expected: the same shown pair as the live tick (markup applied once).
    // Current code applies the split again on read: 1.09994 / 1.10016.
    expect(result.current.get('EURUSD')).toMatchObject({ kind: 'quote', bid: 1.09997, ask: 1.10014 });
  });

  it('stores the broker pair for a live tick; the fallback shows the markup once, also after a re-render', () => {
    commitBrokerAccountSessionScope({ authenticated: true, accountId: '1001', brokerId: 'broker-a', serverUrl: broker.serverUrl });
    const scopeKey = committedScopeKey();
    signIn('1001');
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    enqueueLiveTick('EURUSD', {
      symbol: 'EURUSD', bid: 1.1, ask: 1.10012, spread: 0.00012, timestamp: NOW - 60_000, sourceTimestamp: NOW - 60_000,
    });
    flushLiveTicks();
    // Cache: broker pair 1.10000 / 1.10012 (rawBid/rawAsk); shown pair 1.09997 / 1.10014 (bid/ask).
    expect(readMarketWatchRawQuotes(scopeKey, ['EURUSD']).EURUSD).toEqual({ bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
    const { result, rerender } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey, symbols: ['EURUSD'], candleSymbols: [],
    }));
    expect(result.current.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.09997, ask: 1.10014, asOf: NOW - 60_000 });
    rerender();
    // A double application would show 1.09994 / 1.10016 here.
    expect(result.current.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.09997, ask: 1.10014, asOf: NOW - 60_000 });
  });

  it('a markup change with no new tick re-prices the live fallback from the broker pair (m 5 -> 10 -> 7)', () => {
    commitBrokerAccountSessionScope({ authenticated: true, accountId: '1001', brokerId: 'broker-a', serverUrl: broker.serverUrl });
    const scopeKey = committedScopeKey();
    signIn('1001');
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    enqueueLiveTick('EURUSD', {
      symbol: 'EURUSD', bid: 1.1, ask: 1.10012, spread: 0.00012, timestamp: NOW - 60_000, sourceTimestamp: NOW - 60_000,
    });
    flushLiveTicks();
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey, symbols: ['EURUSD'], candleSymbols: [],
    }));
    expect(result.current.get('EURUSD')).toMatchObject({ bid: 1.09997, ask: 1.10014 });
    // m=10 from the broker pair: bid 1.10000 - 5 points = 1.09995 ; ask 1.10012 + 5 points = 1.10017
    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(10));
    });
    expect(result.current.get('EURUSD')).toMatchObject({ bid: 1.09995, ask: 1.10017 });
    // m=7: bid 1.10000 - 4 points = 1.09996 ; ask 1.10012 + 3 points = 1.10015 (computed from the broker pair, no compounding)
    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(7));
    });
    expect(result.current.get('EURUSD')).toMatchObject({ bid: 1.09996, ask: 1.10015 });
  });

  it('re-prices a raw stored quote from the broker pair on a markup change (m 5 -> 10)', () => {
    rememberMarketWatchQuote(SCOPE, 'EURUSD', { bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
    signIn();
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey: SCOPE, symbols: ['EURUSD'], candleSymbols: [],
    }));
    expect(result.current.get('EURUSD')).toMatchObject({ bid: 1.09997, ask: 1.10014 });
    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(10));
    });
    expect(result.current.get('EURUSD')).toMatchObject({ bid: 1.09995, ask: 1.10017 });
  });

  it('an account switch drops the markup, so the next account sees the raw closed-market quote', () => {
    rememberMarketWatchQuote(SCOPE, 'EURUSD', { bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
    signIn('1001');
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey: SCOPE, symbols: ['EURUSD'], candleSymbols: [],
    }));
    expect(result.current.get('EURUSD')).toMatchObject({ bid: 1.09997, ask: 1.10014 });
    act(() => {
      useAppStore.setState({ accountId: '2002' });
    });
    expect(result.current.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
  });

  it('never shows or widens a payload the old code wrote under the retired v1 key', () => {
    // The old build stored the full markup on both sides (1.09995 / 1.10017) under the v1 key.
    localStorage.setItem('rtx5_market_watch_quotes_v1', JSON.stringify({
      version: 1,
      entries: [{ scopeKey: SCOPE, symbol: 'EURUSD', bid: 1.09995, ask: 1.10017, asOf: NOW - 60_000, savedAt: NOW - 60_000 }],
    }));
    resetMarketWatchQuoteCacheForTests({ clearStorage: false });
    signIn();
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey: SCOPE, symbols: ['EURUSD'], candleSymbols: [],
    }));
    expect(result.current.get('EURUSD')).toBeUndefined();
    expect(localStorage.getItem('rtx5_market_watch_quotes_v1')).toBeNull();
  });

  it('the export hydrate path returns the once-widened pair for a stored raw quote, and the raw pair with no markup', async () => {
    commitBrokerAccountSessionScope({ authenticated: true, accountId: '1001', brokerId: 'broker-a', serverUrl: broker.serverUrl });
    const scopeKey = committedScopeKey();
    signIn('1001');
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    rememberMarketWatchQuote(scopeKey, 'EURUSD', { bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
    const exported = await hydrateLastMarketWatchQuotes({ scopeKey, symbols: ['EURUSD'], candleSymbols: [] });
    expect(exported.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.09997, ask: 1.10014, asOf: NOW - 60_000 });
    clearAccountSpreadMarkups();
    const raw = await hydrateLastMarketWatchQuotes({ scopeKey, symbols: ['EURUSD'], candleSymbols: [] });
    expect(raw.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
  });

  it('the export hydrate path shows a live-funnel quote once (broker pair from the cache)', async () => {
    commitBrokerAccountSessionScope({ authenticated: true, accountId: '1001', brokerId: 'broker-a', serverUrl: broker.serverUrl });
    const scopeKey = committedScopeKey();
    signIn('1001');
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    enqueueLiveTick('EURUSD', {
      symbol: 'EURUSD', bid: 1.1, ask: 1.10012, spread: 0.00012, timestamp: NOW - 30_000, sourceTimestamp: NOW - 30_000,
    });
    flushLiveTicks();
    const exported = await hydrateLastMarketWatchQuotes({ scopeKey, symbols: ['EURUSD'], candleSymbols: [] });
    expect(exported.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.09997, ask: 1.10014, asOf: NOW - 30_000 });
  });

  it('a real logout clears the markup: the live-funnel fallback then shows the broker pair, not the stored shown pair', () => {
    commitBrokerAccountSessionScope({ authenticated: true, accountId: '1001', brokerId: 'broker-a', serverUrl: broker.serverUrl });
    const scopeKey = committedScopeKey();
    signIn('1001');
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    enqueueLiveTick('EURUSD', {
      symbol: 'EURUSD', bid: 1.1, ask: 1.10012, spread: 0.00012, timestamp: NOW - 60_000, sourceTimestamp: NOW - 60_000,
    });
    flushLiveTicks();
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey, symbols: ['EURUSD'], candleSymbols: [],
    }));
    // Markup on: the stored shown pair 1.09997 / 1.10014 (the broker pair 1.10000 / 1.10012 widened by 3 / 2 points).
    expect(result.current.get('EURUSD')).toMatchObject({ bid: 1.09997, ask: 1.10014 });
    // Logout clears the authentication; the markup owner drops the map on that store change (accountSpreadMarkup.ts).
    act(() => {
      useAppStore.setState({ isAuthenticated: false, accountId: null });
    });
    // Markup off: the broker pair, never the stored shown pair.
    expect(result.current.get('EURUSD')).toMatchObject({ bid: 1.1, ask: 1.10012 });
  });

  it('with no markup registered, a live-funnel entry reads as its broker pair, never as the stored shown pair', () => {
    commitBrokerAccountSessionScope({ authenticated: true, accountId: '1001', brokerId: 'broker-a', serverUrl: broker.serverUrl });
    const scopeKey = committedScopeKey();
    signIn('1001');
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    enqueueLiveTick('EURUSD', {
      symbol: 'EURUSD', bid: 1.1, ask: 1.10012, spread: 0.00012, timestamp: NOW - 60_000, sourceTimestamp: NOW - 60_000,
    });
    flushLiveTicks();
    act(() => {
      clearAccountSpreadMarkups();
    });
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey, symbols: ['EURUSD'], candleSymbols: [],
    }));
    // No markup: the stored broker pair 1.10000 / 1.10012 (not the stored shown pair 1.09997 / 1.10014).
    expect(result.current.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
  });

  it('after a reload the stored broker pair is re-priced under the current markup (m 5 -> 10), not the stored shown pair', () => {
    commitBrokerAccountSessionScope({ authenticated: true, accountId: '1001', brokerId: 'broker-a', serverUrl: broker.serverUrl });
    const scopeKey = committedScopeKey();
    signIn('1001');
    setAccountSpreadMarkups('1001', eurusdMarkup(5));
    enqueueLiveTick('EURUSD', {
      symbol: 'EURUSD', bid: 1.1, ask: 1.10012, spread: 0.00012, timestamp: NOW - 60_000, sourceTimestamp: NOW - 60_000,
    });
    flushLiveTicks();
    // The coalesced write reaches localStorage; then a reload: memory cleared, storage kept.
    expect(flushMarketWatchQuoteCache()).toBe(true);
    resetMarketWatchQuoteCacheForTests({ clearStorage: false });
    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(10));
    });
    const { result } = renderHook(() => useLastMarketWatchQuotes({
      enabled: true, scopeKey, symbols: ['EURUSD'], candleSymbols: [],
    }));
    // m=10 from the broker pair 1.10000 / 1.10012: bid 1.10000 - 5 points = 1.09995 ; ask 1.10012 + 5 points = 1.10017
    expect(result.current.get('EURUSD')).toMatchObject({ bid: 1.09995, ask: 1.10017 });
  });
});
