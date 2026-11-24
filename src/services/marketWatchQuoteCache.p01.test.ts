/**
 * P01 round 2, step 3 (independent tester): the Market Watch quote cache keeps the broker (raw) pair beside the
 * shown pair, and the old v1 key is never read.
 *
 * Hand values used throughout: EURUSD raw bid 1.10000 (1.1), raw ask 1.10012, digits 5, tick = point = 0.00001.
 * Markup m = 5 (backend split, spread_markup.go:41-47): ask +floor(5/2) = +2 points, bid -(5 - 2) = -3 points.
 *   shown pair  = 1.09997 / 1.10014  (stored in bid/ask of a live-funnel entry)
 *   broker pair = 1.10000 / 1.10012  (stored in rawBid/rawAsk)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commitBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScopeKey,
} from './brokerSession';
import {
  MARKET_WATCH_QUOTE_CACHE_STORAGE_KEY,
  flushMarketWatchQuoteCache,
  readMarketWatchQuotes,
  readMarketWatchRawQuotes,
  rememberCurrentMarketWatchQuote,
  rememberMarketWatchQuote,
  resetMarketWatchQuoteCacheForTests,
} from './marketWatchQuoteCache';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const ASOF = NOW - 60_000;
const LEGACY_KEY = 'rtx5_market_watch_quotes_v1';
const scopeA = 'authenticated|1001|broker-a|https://broker-a.example';
const scopeB = 'authenticated|1002|broker-b|https://broker-b.example';
const SHOWN = { bid: 1.09997, ask: 1.10014 };
const RAW = { bid: 1.1, ask: 1.10012 };

describe('marketWatchQuoteCache keeps the broker pair beside the shown pair (P01 round 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMarketWatchQuoteCacheForTests();
    commitBrokerAccountSessionScope({ authenticated: false, accountId: null });
    localStorage.removeItem(LEGACY_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMarketWatchQuoteCacheForTests();
    commitBrokerAccountSessionScope({ authenticated: false, accountId: null });
    localStorage.removeItem(LEGACY_KEY);
    vi.useRealTimers();
  });

  it('keeps the shown pair in bid/ask and the broker pair in rawBid/rawAsk; the display reader never returns raw fields', () => {
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { ...SHOWN, asOf: ASOF, rawBid: RAW.bid, rawAsk: RAW.ask })).toBe(true);
    // display reader: shown pair only (1.09997 / 1.10014)
    expect(readMarketWatchQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...SHOWN, asOf: ASOF });
    expect(readMarketWatchQuotes(scopeA, ['EURUSD']).EURUSD).not.toHaveProperty('rawBid');
    // raw reader: broker pair (1.10000 / 1.10012)
    expect(readMarketWatchRawQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...RAW, asOf: ASOF });
  });

  it('a quote stored without raw sides reads the same pair from both readers', () => {
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { ...RAW, asOf: ASOF })).toBe(true);
    expect(readMarketWatchQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...RAW, asOf: ASOF });
    expect(readMarketWatchRawQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...RAW, asOf: ASOF });
  });

  it('raw sides come as a pair: a lone or non-positive raw side is refused and the good entry survives', () => {
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { ...SHOWN, asOf: ASOF, rawBid: RAW.bid, rawAsk: RAW.ask })).toBe(true);
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { ...SHOWN, asOf: ASOF + 1, rawBid: RAW.bid })).toBe(false);
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { ...SHOWN, asOf: ASOF + 1, rawBid: RAW.bid, rawAsk: 0 })).toBe(false);
    expect(readMarketWatchRawQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...RAW, asOf: ASOF });
  });

  it('the same asOf with the same two pairs is not stored again; a new shown pair at the same asOf (markup changed) is', () => {
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { ...SHOWN, asOf: ASOF, rawBid: RAW.bid, rawAsk: RAW.ask })).toBe(true);
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { ...SHOWN, asOf: ASOF, rawBid: RAW.bid, rawAsk: RAW.ask })).toBe(false);
    // m=10 on the same tick: shown 1.09995 / 1.10017 (bid -5 points, ask +5 points), broker pair unchanged
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { bid: 1.09995, ask: 1.10017, asOf: ASOF, rawBid: RAW.bid, rawAsk: RAW.ask })).toBe(true);
    expect(readMarketWatchQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ bid: 1.09995, ask: 1.10017, asOf: ASOF });
    expect(readMarketWatchRawQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...RAW, asOf: ASOF });
  });

  it('an older broker time is still refused (newest-wins rule unchanged)', () => {
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { ...SHOWN, asOf: ASOF, rawBid: RAW.bid, rawAsk: RAW.ask })).toBe(true);
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { bid: 1.09, ask: 1.1, asOf: ASOF - 1, rawBid: 1.09, rawAsk: 1.1 })).toBe(false);
    expect(readMarketWatchRawQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...RAW, asOf: ASOF });
  });

  it('a v1 payload written by the old code is retired on load and its values are never read', () => {
    // Old build: full markup on both sides (1.09995 / 1.10017) stored under the v1 key.
    localStorage.setItem(LEGACY_KEY, JSON.stringify({
      version: 1,
      entries: [{ scopeKey: scopeA, symbol: 'EURUSD', bid: 1.09995, ask: 1.10017, asOf: ASOF, savedAt: ASOF }],
    }));
    resetMarketWatchQuoteCacheForTests({ clearStorage: false });
    expect(readMarketWatchRawQuotes(scopeA, ['EURUSD'])).toEqual({});
    expect(readMarketWatchQuotes(scopeA, ['EURUSD'])).toEqual({});
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(MARKET_WATCH_QUOTE_CACHE_STORAGE_KEY)).toBeNull();
  });

  it('the v2 payload round-trips the broker pair through a flush and a reload', () => {
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { ...SHOWN, asOf: ASOF, rawBid: RAW.bid, rawAsk: RAW.ask })).toBe(true);
    expect(flushMarketWatchQuoteCache()).toBe(true);
    const stored = JSON.parse(localStorage.getItem(MARKET_WATCH_QUOTE_CACHE_STORAGE_KEY) ?? 'null');
    expect(stored.entries[0]).toMatchObject({ bid: 1.09997, ask: 1.10014, rawBid: 1.1, rawAsk: 1.10012 });
    resetMarketWatchQuoteCacheForTests({ clearStorage: false });
    expect(readMarketWatchRawQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...RAW, asOf: ASOF });
    expect(readMarketWatchQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...SHOWN, asOf: ASOF });
  });

  it('an entry saved without raw sides (earlier v2 build) reads as its stored pair', () => {
    localStorage.setItem(MARKET_WATCH_QUOTE_CACHE_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: [{ scopeKey: scopeA, symbol: 'EURUSD', bid: 1.1, ask: 1.10012, asOf: ASOF, savedAt: NOW - 1000 }],
    }));
    resetMarketWatchQuoteCacheForTests({ clearStorage: false });
    expect(readMarketWatchRawQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...RAW, asOf: ASOF });
  });

  it('rememberCurrentMarketWatchQuote stores the broker pair for the committed authenticated account only', () => {
    const tick = { ...SHOWN, asOf: ASOF, rawBid: RAW.bid, rawAsk: RAW.ask };
    expect(rememberCurrentMarketWatchQuote('EURUSD', tick)).toBe(false);
    commitBrokerAccountSessionScope({
      authenticated: true, accountId: '1001', brokerId: 'broker-a', serverUrl: 'https://broker-a.example',
    });
    const key = getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope());
    expect(rememberCurrentMarketWatchQuote('EURUSD', tick)).toBe(true);
    expect(readMarketWatchRawQuotes(key, ['EURUSD']).EURUSD).toEqual({ ...RAW, asOf: ASOF });
    // Another account never sees the broker pair of this one.
    commitBrokerAccountSessionScope({
      authenticated: true, accountId: '1002', brokerId: 'broker-a', serverUrl: 'https://broker-a.example',
    });
    expect(readMarketWatchRawQuotes(getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope()), ['EURUSD']))
      .toEqual({});
  });

  it('scopes stay isolated for the broker-pair reader', () => {
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', { ...SHOWN, asOf: ASOF, rawBid: RAW.bid, rawAsk: RAW.ask })).toBe(true);
    expect(readMarketWatchRawQuotes(scopeB, ['EURUSD'])).toEqual({});
    expect(readMarketWatchRawQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...RAW, asOf: ASOF });
  });

  it('a live write that comes before the first read after a reload wins over the stored copy of the same broker time', () => {
    // Stored by an earlier session at m=5 (shown 1.09997 / 1.10014), saved 1 s before "now".
    localStorage.setItem(MARKET_WATCH_QUOTE_CACHE_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: [{
        scopeKey: scopeA, symbol: 'EURUSD', ...SHOWN, asOf: ASOF, rawBid: RAW.bid, rawAsk: RAW.ask, savedAt: NOW - 1000,
      }],
    }));
    resetMarketWatchQuoteCacheForTests({ clearStorage: false });
    // First write after the reload (m=10, same broker time): shown 1.09995 / 1.10017, saved now (savedAt NOW).
    expect(rememberMarketWatchQuote(scopeA, 'EURUSD', {
      bid: 1.09995, ask: 1.10017, asOf: ASOF, rawBid: RAW.bid, rawAsk: RAW.ask,
    })).toBe(true);
    // The first read loads storage; the older stored entry (savedAt NOW-1000 < NOW) must not replace it.
    expect(readMarketWatchQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ bid: 1.09995, ask: 1.10017, asOf: ASOF });
    expect(readMarketWatchRawQuotes(scopeA, ['EURUSD']).EURUSD).toEqual({ ...RAW, asOf: ASOF });
  });
});
