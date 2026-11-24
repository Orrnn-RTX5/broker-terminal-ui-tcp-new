// @vitest-environment jsdom

/**
 * P01 round 10 close-out, ruling 4: the tick-history memo returns the loaded raw array itself while the open symbol has no
 * active markup entry (no per-point work), widens each point from raw once when the symbol has an entry, and returns the
 * raw array again on logout. Hand-worked values for EURUSD (d=5, t=0.00001) on raw 1.10000 / 1.10012 (the loaded tick is
 * bid 1.1, ask 1.10012): m=5 gives bid 1.1 - 3 ticks = 1.09997 and ask 1.10012 + 2 ticks = 1.10014; m=10 gives 1.09995 and
 * 1.10017.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetAccountSpreadMarkupForTests,
  setAccountSpreadMarkups,
} from '../../services/accountSpreadMarkup';
import { useAppStore } from '../../store/useAppStore';
import { buildSpreadMarkupMap } from '../../utils/spreadMarkup';
import { useMarketWatchTickHistory } from './useMarketWatchTickHistory';

const apiGet = vi.hoisted(() => vi.fn());
// Counts the per-point widenings the hook asks for: one call per point when the open symbol has an entry.
const widening = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, apiClient: { ...actual.apiClient, get: apiGet } };
});
vi.mock('../../services/brokerSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/brokerSession')>();
  return {
    ...actual,
    getServerUrl: () => 'https://broker-a.test',
    getAccessToken: () => 'test-token',
  };
});
vi.mock('../../utils/spreadMarkup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/spreadMarkup')>();
  return {
    ...actual,
    applySpreadMarkupToQuote: (...args: Parameters<typeof actual.applySpreadMarkupToQuote>) => {
      widening.calls += 1;
      return actual.applySpreadMarkupToQuote(...args);
    },
  };
});

interface MarkupRow {
  symbol: string;
  spreadMarkup: number;
  tickSize: number;
  digits: number;
}

const EUR = (points: number): MarkupRow => ({ symbol: 'EURUSD', spreadMarkup: points, tickSize: 0.00001, digits: 5 });
const JPY = (points: number): MarkupRow => ({ symbol: 'USDJPY', spreadMarkup: points, tickSize: 0.001, digits: 3 });
const markupOf = (...rows: MarkupRow[]) => buildSpreadMarkupMap(rows);

const EURUSD_TICK = { symbol: 'EURUSD', bid: 1.1, ask: 1.10012, time: 1_790_000_000 };

describe('P01 round 10 close-out ruling 4: useMarketWatchTickHistory keeps the raw array when the symbol has no entry', () => {
  beforeEach(() => {
    apiGet.mockReset();
    widening.calls = 0;
    resetAccountSpreadMarkupForTests();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '1001',
      authToken: 'test-token',
      refreshToken: null,
    });
  });

  afterEach(() => {
    cleanup();
    resetAccountSpreadMarkupForTests();
    useAppStore.setState({
      isAuthenticated: false,
      accountId: null,
      authToken: null,
      refreshToken: null,
    });
  });

  it('returns the loaded raw array itself across a markup change that does not concern the open symbol', async () => {
    setAccountSpreadMarkups('1001', markupOf(JPY(5)));
    apiGet.mockResolvedValueOnce([EURUSD_TICK]);

    const { result } = renderHook(() => useMarketWatchTickHistory('EURUSD', 'scope-1'));
    await waitFor(() => expect(result.current).toHaveLength(1));
    const raw = result.current;
    expect(raw[0]?.bid).toBe(1.1);
    expect(raw[0]?.ask).toBe(1.10012);

    widening.calls = 0;
    act(() => {
      setAccountSpreadMarkups('1001', markupOf(JPY(10)));
    });
    expect(result.current).toBe(raw);
    expect(widening.calls).toBe(0);
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('re-widens the points from raw exactly once when a markup change concerns the open symbol, and not again on an equal map', async () => {
    setAccountSpreadMarkups('1001', markupOf(JPY(5)));
    apiGet.mockResolvedValueOnce([EURUSD_TICK]);

    const { result } = renderHook(() => useMarketWatchTickHistory('EURUSD', 'scope-1'));
    await waitFor(() => expect(result.current).toHaveLength(1));
    const raw = result.current;

    widening.calls = 0;
    act(() => {
      setAccountSpreadMarkups('1001', markupOf(JPY(5), EUR(5)));
    });
    expect(result.current).not.toBe(raw);
    expect(result.current[0]?.bid).toBe(1.09997);
    expect(result.current[0]?.ask).toBe(1.10014);
    expect(widening.calls).toBe(1);

    const widened = result.current;
    act(() => {
      setAccountSpreadMarkups('1001', markupOf(JPY(5), EUR(5)));
    });
    expect(result.current).toBe(widened);
    expect(widening.calls).toBe(1);

    act(() => {
      setAccountSpreadMarkups('1001', markupOf(JPY(5), EUR(10)));
    });
    // Widened from the raw points, not compounded: m=10 gives 1.09995 and 1.10017.
    expect(result.current[0]?.bid).toBe(1.09995);
    expect(result.current[0]?.ask).toBe(1.10017);
    expect(widening.calls).toBe(2);
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('returns the loaded raw array again on logout, with no request', async () => {
    setAccountSpreadMarkups('1001', markupOf(JPY(5)));
    apiGet.mockResolvedValueOnce([EURUSD_TICK]);

    const { result } = renderHook(() => useMarketWatchTickHistory('EURUSD', 'scope-1'));
    await waitFor(() => expect(result.current).toHaveLength(1));
    const raw = result.current;

    act(() => {
      setAccountSpreadMarkups('1001', markupOf(JPY(5), EUR(5)));
    });
    expect(result.current).not.toBe(raw);
    expect(result.current[0]?.bid).toBe(1.09997);

    act(() => {
      useAppStore.setState({ isAuthenticated: false });
    });
    expect(result.current).toBe(raw);
    expect(result.current[0]?.bid).toBe(1.1);
    expect(result.current[0]?.ask).toBe(1.10012);
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});
