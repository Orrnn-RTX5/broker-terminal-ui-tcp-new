// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enrichTradesWithCachedLevels,
  flushTradeHistoryLevelCache,
  rememberTradeHistoryPositionLevels,
  resetTradeHistoryLevelCacheForTests,
  TRADE_HISTORY_LEVEL_CACHE_FLUSH_MS,
} from './tradeHistoryLevelCache';

describe('tradeHistoryLevelCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    resetTradeHistoryLevelCacheForTests();
  });

  afterEach(() => {
    resetTradeHistoryLevelCacheForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('coalesces 100 rapid trade writes into a single localStorage write and serves reads from memory', () => {
    const getSpy = vi.spyOn(Storage.prototype, 'getItem');
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');

    for (let i = 1; i <= 100; i++) {
      rememberTradeHistoryPositionLevels([
        { id: 1000 + i, symbol: 'EURUSD', side: 'BUY', volume: 0.1, openPrice: 1.08, sl: 1.07, tp: 1.09 },
      ], 200001);
    }

    // Hydrated once on first call, zero synchronous localStorage writes during burst.
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(0);

    // Enriching reads directly from the in-memory map without touching localStorage again.
    const enriched = enrichTradesWithCachedLevels([{ id: 1050, symbol: 'EURUSD', sl: 0, tp: 0 }], 200001);
    expect(enriched[0]).toMatchObject({ sl: 1.07, tp: 1.09 });
    expect(getSpy).toHaveBeenCalledTimes(1);

    // After the 500ms coalesced window, a single write persists all 100 trades.
    vi.advanceTimersByTime(TRADE_HISTORY_LEVEL_CACHE_FLUSH_MS);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  it('flushes immediately on pagehide and via flushTradeHistoryLevelCache', () => {
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');

    rememberTradeHistoryPositionLevels([
      { id: 5001, symbol: 'XAUUSD', side: 'SELL', volume: 0.2, openPrice: 2650, sl: 2660, tp: 2630 },
    ], 200001);
    expect(setSpy).toHaveBeenCalledTimes(0);

    window.dispatchEvent(new Event('pagehide'));
    expect(setSpy).toHaveBeenCalledTimes(1);

    rememberTradeHistoryPositionLevels([
      { id: 5002, symbol: 'XAUUSD', side: 'BUY', volume: 0.2, openPrice: 2651, sl: 2640, tp: 2670 },
    ], 200001);
    flushTradeHistoryLevelCache();
    expect(setSpy).toHaveBeenCalledTimes(2);
  });
});
