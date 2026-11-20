import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitBrokerAccountSessionScope } from './brokerSession';
import {
  LIVE_QUOTES_WATCHDOG_MS,
  clearLiveQuotes,
  getLiveQuote,
  getLiveQuotesCount,
  getLiveQuotesVersion,
  invalidateLiveQuote,
  pruneLiveQuotes,
  resetLiveQuotesForTests,
  setLiveQuote,
  subscribeLiveQuotes,
} from './liveQuotes';
import { useAppStore } from '../store/useAppStore';
import { replaceToolboxPositions } from '../hooks/useToolboxTradeData';

// Rows enter the store already normalised (as the Trade hook commits them).
const rowOf = (raw: Record<string, unknown>) => replaceToolboxPositions([], [raw])[0];

const quote = (symbol: string, bid: number, ask = bid + 0.0002) => ({ symbol, bid, ask, timestamp: 1_800_000_000_000 });

describe('liveQuotes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLiveQuotesForTests();
    commitBrokerAccountSessionScope({ authenticated: true, accountId: '200003', brokerId: 'test', serverUrl: 'https://broker.invalid' });
    useAppStore.setState({ isAuthenticated: true, accountId: '200003', authToken: 'test-token', positions: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stores the latest quote per normalized symbol in O(1) without touching the position store', () => {
    const before = useAppStore.getState().positions;
    setLiveQuote(quote(' eurusd ', 1.08));
    setLiveQuote(quote('EURUSD', 1.09));
    expect(getLiveQuote('EurUsd')?.bid).toBe(1.09);
    expect(getLiveQuotesCount()).toBe(1);
    expect(useAppStore.getState().positions).toBe(before);
  });

  it('does not drop a tick whose source timestamp is older than the stored one (last arrival wins)', () => {
    setLiveQuote({ symbol: 'EURUSD', bid: 1.2, ask: 1.2002, timestamp: 2_000_000_000_000 });
    setLiveQuote({ symbol: 'EURUSD', bid: 1.1, ask: 1.1002, timestamp: 1_000_000_000_000 });
    expect(getLiveQuote('EURUSD')?.bid).toBe(1.1);
  });

  it('coalesces a burst of ticks into one subscriber notification per frame', () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const listener = vi.fn();
    const unsubscribe = subscribeLiveQuotes(listener);
    for (let i = 0; i < 50; i += 1) setLiveQuote(quote('EURUSD', 1.08 + i / 10000));
    expect(listener).not.toHaveBeenCalled();
    frames.forEach((cb) => cb());
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('flushes through the 100 ms timer fallback when requestAnimationFrame is paused (hidden tab)', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1); // never fires
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const listener = vi.fn();
    const unsubscribe = subscribeLiveQuotes(listener);
    const versionBefore = getLiveQuotesVersion();
    setLiveQuote(quote('EURUSD', 1.08));
    vi.advanceTimersByTime(LIVE_QUOTES_WATCHDOG_MS - 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLiveQuotesVersion()).toBe(versionBefore + 1);
    unsubscribe();
  });

  it('prunes symbols that no open position holds', () => {
    setLiveQuote(quote('EURUSD', 1.08));
    setLiveQuote(quote('GBPUSD', 1.27));
    setLiveQuote(quote('USDJPY', 150));
    pruneLiveQuotes(new Set(['GBPUSD']));
    expect(getLiveQuote('EURUSD')).toBeUndefined();
    expect(getLiveQuote('USDJPY')).toBeUndefined();
    expect(getLiveQuote('GBPUSD')?.bid).toBe(1.27);
  });

  it('prunes through the position store when the last position of a symbol closes', () => {
    const position = (id: number, symbol: string) => rowOf({
      id, ticket: id, symbol, side: 'BUY', volume: 0.1, price_open: 1, price_current: 1, profit: 0, time_create: '2026-10-09T10:00:00Z',
    }) as never;
    useAppStore.getState().setPositions([position(1, 'EURUSD'), position(2, 'GBPUSD')]);
    setLiveQuote(quote('EURUSD', 1.08));
    setLiveQuote(quote('GBPUSD', 1.27));
    useAppStore.getState().setPositions([position(2, 'GBPUSD')], { removedTickets: [1] });
    expect(getLiveQuote('EURUSD')).toBeUndefined();
    expect(getLiveQuote('GBPUSD')?.bid).toBe(1.27);
  });

  it('lets a newer backend position write win over the cached quote until the next tick', () => {
    const rawBase = {
      id: 7, ticket: 7, symbol: 'EURUSD', side: 'BUY', volume: 0.1, price_open: 1.08,
      price_current: 1.081, profit: 1, time_create: '2026-10-09T10:00:00Z',
    };
    const base = rowOf(rawBase);
    useAppStore.getState().setPositions([base as never]);
    setLiveQuote(quote('EURUSD', 1.085));
    // An echo with identical price/profit keeps the live quote.
    useAppStore.getState().setPositions([{ ...base } as never]);
    expect(getLiveQuote('EURUSD')?.bid).toBe(1.085);
    // A backend write with new price data is newer than the quote: it wins until the next tick.
    useAppStore.getState().setPositions([rowOf({ ...rawBase, price_current: 1.09, profit: 9 }) as never]);
    expect(getLiveQuote('EURUSD')).toBeUndefined();
    setLiveQuote(quote('EURUSD', 1.095));
    expect(getLiveQuote('EURUSD')?.bid).toBe(1.095);
  });

  it('invalidates a single symbol without notifying', () => {
    setLiveQuote(quote('EURUSD', 1.08));
    setLiveQuote(quote('GBPUSD', 1.27));
    invalidateLiveQuote('eurusd');
    expect(getLiveQuote('EURUSD')).toBeUndefined();
    expect(getLiveQuote('GBPUSD')).toBeDefined();
  });

  it('clears quotes on account switch, broker scope change, auth clear and logout', () => {
    setLiveQuote(quote('EURUSD', 1.08));
    useAppStore.getState().setActiveAccount(200004);
    expect(getLiveQuote('EURUSD')).toBeUndefined();

    setLiveQuote(quote('EURUSD', 1.09));
    commitBrokerAccountSessionScope({ authenticated: true, accountId: '200004', brokerId: 'other', serverUrl: 'https://other.invalid' });
    expect(getLiveQuote('EURUSD')).toBeUndefined();

    setLiveQuote(quote('EURUSD', 1.1));
    useAppStore.getState().clearAuth();
    expect(getLiveQuote('EURUSD')).toBeUndefined();

    setLiveQuote(quote('EURUSD', 1.11));
    useAppStore.getState().logout();
    expect(getLiveQuote('EURUSD')).toBeUndefined();
  });

  it('clearLiveQuotes cancels a pending flush so no stale notification fires afterwards', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const listener = vi.fn();
    const unsubscribe = subscribeLiveQuotes(listener);
    setLiveQuote(quote('EURUSD', 1.08));
    clearLiveQuotes();
    listener.mockClear();
    vi.advanceTimersByTime(LIVE_QUOTES_WATCHDOG_MS * 3);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
