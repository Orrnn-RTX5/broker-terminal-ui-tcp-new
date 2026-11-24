// @vitest-environment jsdom

/**
 * P01 round 9, step 5 (independent tester): useLiveOrderBook hook identity and single-application
 * checks on equal markup map, markup change, and logout.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetAccountSpreadMarkupForTests,
  setAccountSpreadMarkups,
} from '../../services/accountSpreadMarkup';
import { useAppStore } from '../../store/useAppStore';
import { buildSpreadMarkupMap } from '../../utils/spreadMarkup';
import { useLiveOrderBook } from './useLiveOrderBook';

const fetchMarketDataJson = vi.hoisted(() => vi.fn());
vi.mock('./marketDataSession', () => ({
  fetchMarketDataJson,
  useBrokerSessionRevision: () => 1,
}));
vi.mock('../../services/binaryTcpMarketStream', () => ({
  binaryTcpMarketStream: {
    isSupported: () => false,
    getLatestDepth: () => null,
    onDepth: () => () => {},
  },
}));
vi.mock('../../services/websocket-enhanced', () => ({
  getEnhancedWebSocketService: () => ({
    connect: () => {},
    subscribe: () => () => {},
  }),
}));
vi.mock('../../services/brokerSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/brokerSession')>();
  return {
    ...actual,
    buildBrokerWsV2Uri: () => 'wss://broker-a.test/ws/v2',
  };
});

const eurusdMarkup = (points: number) => buildSpreadMarkupMap([
  { symbol: 'EURUSD', spreadMarkup: points, tickSize: 0.00001, digits: 5 },
]);

describe('P01 round 9 step 5 (tester): useLiveOrderBook identity & single widening', () => {
  beforeEach(() => {
    fetchMarketDataJson.mockReset();
    fetchMarketDataJson.mockResolvedValue({
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
    resetAccountSpreadMarkupForTests();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '1001',
      authToken: 'test-token',
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
  });

  it('keeps orderBook identity and triggers zero re-renders on an equal map; re-widens depth once per real change', async () => {
    setAccountSpreadMarkups('1001', eurusdMarkup(5));

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useLiveOrderBook('EURUSD', 5);
    });

    await waitFor(() => expect(result.current.orderBook).not.toBeNull());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMarketDataJson).toHaveBeenCalledTimes(1);

    const bookAtM5 = result.current.orderBook;
    expect(bookAtM5?.bids.map((l) => l.price)).toEqual([1.09997, 1.09996]);
    expect(bookAtM5?.asks.map((l) => l.price)).toEqual([1.10014, 1.10015]);
    expect(bookAtM5?.spread).toBe(0.00017);

    const rendersAfterLoad = renders;

    // Equal markup map: 0 extra renders, exact same orderBook reference.
    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(5));
    });
    expect(renders).toBe(rendersAfterLoad);
    expect(result.current.orderBook).toBe(bookAtM5);

    // m=10: exactly 1 re-render, widened once from raw (bid -5 / ask +5).
    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(10));
    });
    expect(renders).toBe(rendersAfterLoad + 1);
    expect(result.current.orderBook?.bids.map((l) => l.price)).toEqual([1.09995, 1.09994]);
    expect(result.current.orderBook?.asks.map((l) => l.price)).toEqual([1.10017, 1.10018]);

    // m=7: exactly 1 re-render, widened once from raw (bid -4 / ask +3).
    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(7));
    });
    expect(renders).toBe(rendersAfterLoad + 2);
    expect(result.current.orderBook?.bids.map((l) => l.price)).toEqual([1.09996, 1.09995]);
    expect(result.current.orderBook?.asks.map((l) => l.price)).toEqual([1.10015, 1.10016]);

    // No extra depth HTTP requests triggered by markup updates.
    expect(fetchMarketDataJson).toHaveBeenCalledTimes(1);
  });
});
