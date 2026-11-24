// @vitest-environment jsdom

/**
 * P01 round 9, step 5 (independent tester): useLastMarketWatchQuotes keeps Map identity and
 * avoids re-renders on an equal markup map, and re-widens cached quotes once on markup change.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetAccountSpreadMarkupForTests,
  setAccountSpreadMarkups,
} from '../services/accountSpreadMarkup';
import {
  rememberMarketWatchQuote,
  resetMarketWatchQuoteCacheForTests,
} from '../services/marketWatchQuoteCache';
import { useAppStore } from '../store/useAppStore';
import { buildSpreadMarkupMap } from '../utils/spreadMarkup';
import { useLastMarketWatchQuotes } from './useLastMarketWatchQuotes';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('../services/aggregationWorkerManager', () => ({
  cancelPendingAggregations: vi.fn(),
  getWorkerManager: () => ({ aggregateMultipleTimeframes: vi.fn(), aggregateSymbols: vi.fn() }),
}));
vi.mock('../services/marketWatchDailyChangeCache', () => ({
  flushMarketWatchDailyChangeCache: vi.fn(),
  rememberCurrentMarketWatchDailyChange: vi.fn(),
}));
vi.mock('../services/brokerSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/brokerSession')>();
  return { ...actual, getServerUrl: () => 'https://broker-a.test' };
});
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, apiClient: { ...actual.apiClient, get: apiGet } };
});

const NOW = Date.now();
const SCOPE = 'scope-identity';
const eurusdMarkup = (points: number) => buildSpreadMarkupMap([
  { symbol: 'EURUSD', spreadMarkup: points, tickSize: 0.00001, digits: 5 },
]);

describe('P01 round 9 step 5 (tester): useLastMarketWatchQuotes identity on equal markup map', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue([]);
    resetMarketWatchQuoteCacheForTests();
    resetAccountSpreadMarkupForTests();
    useAppStore.setState({ isAuthenticated: true, accountId: '1001' });
  });

  afterEach(() => {
    cleanup();
    resetAccountSpreadMarkupForTests();
    resetMarketWatchQuoteCacheForTests();
    useAppStore.setState({ isAuthenticated: false, accountId: null });
  });

  it('preserves returned Map identity and avoids re-render on equal markup map; re-widens once on change', () => {
    rememberMarketWatchQuote(SCOPE, 'EURUSD', { bid: 1.1, ask: 1.10012, asOf: NOW - 60_000 });
    setAccountSpreadMarkups('1001', eurusdMarkup(5));

    let renders = 0;
    const symbols = ['EURUSD'];
    const candleSymbols: string[] = [];
    const { result } = renderHook(() => {
      renders += 1;
      return useLastMarketWatchQuotes({ enabled: true, scopeKey: SCOPE, symbols, candleSymbols });
    });

    const refAtM5 = result.current;
    expect(refAtM5.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.09997, ask: 1.10014, asOf: NOW - 60_000 });
    const rendersBeforeEqual = renders;

    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(5));
    });
    expect(renders).toBe(rendersBeforeEqual);
    expect(result.current).toBe(refAtM5);

    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(10));
    });
    expect(renders).toBe(rendersBeforeEqual + 1);
    expect(result.current.get('EURUSD')).toEqual({ kind: 'quote', bid: 1.09995, ask: 1.10017, asOf: NOW - 60_000 });
  });
});
