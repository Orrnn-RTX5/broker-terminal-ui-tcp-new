// @vitest-environment jsdom

/**
 * P01 round 9, step 4 (independent tester): additional useMarketWatchTickHistory tests
 * covering symbol change (including in-flight abort), first-load failure, unmount during
 * load, equal-map identity preservation, and logout restoration to raw quotes.
 *
 * Hand-worked values:
 *   EURUSD (d=5, t=0.00001): raw 1.10000 / 1.10012
 *     m=5 -> ask +floor(5/2)=+2 -> 1.10014, bid -(5-2)=-3 -> 1.09997
 *     m=10 -> ask +5 -> 1.10017, bid -5 -> 1.09995
 *   USDJPY (d=3, t=0.001): raw 150.123 / 150.135
 *     m=5 -> ask +2 -> 150.137, bid -3 -> 150.120 (150.12)
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

const makeMarkup = (points: number) => buildSpreadMarkupMap([
  { symbol: 'EURUSD', spreadMarkup: points, tickSize: 0.00001, digits: 5 },
  { symbol: 'USDJPY', spreadMarkup: points, tickSize: 0.001, digits: 3 },
]);

describe('P01 round 9 step 4 (tester): useMarketWatchTickHistory edge cases & identity', () => {
  beforeEach(() => {
    apiGet.mockReset();
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
    vi.restoreAllMocks();
    resetAccountSpreadMarkupForTests();
    useAppStore.setState({
      isAuthenticated: false,
      accountId: null,
      authToken: null,
      refreshToken: null,
    });
  });

  it('clears previous symbol points immediately on symbol change, aborts in-flight load, and widens new symbol once', async () => {
    setAccountSpreadMarkups('1001', makeMarkup(5));

    let resolveJpy!: (v: unknown) => void;
    apiGet
      .mockResolvedValueOnce([{ symbol: 'EURUSD', bid: 1.1, ask: 1.10012, time: 1_790_000_000 }])
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveJpy = resolve;
      }));

    const { result, rerender } = renderHook(
      ({ sym }) => useMarketWatchTickHistory(sym, 'scope-1'),
      { initialProps: { sym: 'EURUSD' } },
    );

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({ bid: 1.09997, ask: 1.10014 });

    rerender({ sym: 'USDJPY' });
    // Immediately empty while USDJPY is loading (no stale EURUSD points shown).
    expect(result.current).toEqual([]);
    expect(apiGet).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveJpy([{ symbol: 'USDJPY', bid: 150.123, ask: 150.135, time: 1_790_000_010 }]);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({ bid: 150.12, ask: 150.137 });
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight symbol load when switching symbols so late response cannot overwrite the new symbol', async () => {
    setAccountSpreadMarkups('1001', makeMarkup(5));

    let resolveFirst!: (v: unknown) => void;
    let firstSignal: AbortSignal | undefined;
    apiGet
      .mockImplementationOnce((_path: string, opts?: { signal?: AbortSignal }) => {
        firstSignal = opts?.signal;
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockResolvedValueOnce([{ symbol: 'USDJPY', bid: 150.123, ask: 150.135, time: 1_790_000_020 }]);

    const { result, rerender } = renderHook(
      ({ sym }) => useMarketWatchTickHistory(sym, 'scope-1'),
      { initialProps: { sym: 'EURUSD' } },
    );

    expect(firstSignal?.aborted).toBe(false);
    rerender({ sym: 'USDJPY' });
    expect(firstSignal?.aborted).toBe(true);

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({ bid: 150.12, ask: 150.137 });

    await act(async () => {
      resolveFirst([{ symbol: 'EURUSD', bid: 1.1, ask: 1.10012, time: 1_790_000_000 }]);
      await Promise.resolve();
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ bid: 150.12, ask: 150.137 });
  });

  it('stays empty when the first load fails and makes zero requests on later markup changes', async () => {
    setAccountSpreadMarkups('1001', makeMarkup(5));
    apiGet.mockRejectedValueOnce(new Error('ticks endpoint unavailable'));

    const { result } = renderHook(() => useMarketWatchTickHistory('EURUSD', 'scope-1'));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual([]);

    act(() => {
      setAccountSpreadMarkups('1001', makeMarkup(10));
    });
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual([]);
  });

  it('aborts the request on unmount during load and performs no state update if it resolves later', async () => {
    setAccountSpreadMarkups('1001', makeMarkup(5));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let resolvePending!: (v: unknown) => void;
    let capturedSignal: AbortSignal | undefined;
    apiGet.mockImplementationOnce((_path: string, opts?: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal;
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    });

    const { unmount } = renderHook(() => useMarketWatchTickHistory('EURUSD', 'scope-1'));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);

    await act(async () => {
      resolvePending([{ symbol: 'EURUSD', bid: 1.1, ask: 1.10012, time: 1_790_000_000 }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps array identity on an equal markup map and restores raw quotes on logout without fetching', async () => {
    setAccountSpreadMarkups('1001', makeMarkup(5));
    apiGet.mockResolvedValueOnce([{ symbol: 'EURUSD', bid: 1.1, ask: 1.10012, time: 1_790_000_000 }]);

    const { result } = renderHook(() => useMarketWatchTickHistory('EURUSD', 'scope-1'));
    await waitFor(() => expect(result.current).toHaveLength(1));

    const refBefore = result.current;
    expect(refBefore[0]).toMatchObject({ bid: 1.09997, ask: 1.10014 });

    act(() => {
      setAccountSpreadMarkups('1001', makeMarkup(5));
    });
    expect(result.current).toBe(refBefore);
    expect(apiGet).toHaveBeenCalledTimes(1);

    act(() => {
      useAppStore.setState({ isAuthenticated: false });
    });
    expect(result.current[0]).toMatchObject({ bid: 1.1, ask: 1.10012 });
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});
