// @vitest-environment jsdom

/**
 * P01 round 9 (Review B, M-2): useMarketWatchTickHistory keeps raw tick history in state
 * and widens it in memory when the account markup map changes:
 *   - no network re-request on markup change, equal map, or logout;
 *   - no stale old-markup points on screen after a markup change;
 *   - nothing lost or left stale if the network is down after initial load.
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

const eurusdMarkup = (points: number) => buildSpreadMarkupMap([
  { symbol: 'EURUSD', spreadMarkup: points, tickSize: 0.00001, digits: 5 },
]);

describe('P01 round 9 (M-2): useMarketWatchTickHistory in-memory re-widening without re-fetch', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue([
      { symbol: 'EURUSD', bid: 1.1, ask: 1.10012, time: 1_790_000_000 },
    ]);
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

  it('widens in memory on markup change and logout with zero additional fetch calls', async () => {
    setAccountSpreadMarkups('1001', eurusdMarkup(5));

    const { result } = renderHook(() => useMarketWatchTickHistory('EURUSD', 'scope-1'));

    // Initial load: m=5 -> bid 1.09997 / ask 1.10014.
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toMatchObject({ bid: 1.09997, ask: 1.10014 });

    // Committing an equal map: 0 extra requests.
    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(5));
    });
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toMatchObject({ bid: 1.09997, ask: 1.10014 });

    // Committing a different markup (m=10): immediately widens in memory, still 1 fetch call total.
    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(10));
    });
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toMatchObject({ bid: 1.09995, ask: 1.10017 });

    // Clearing markup (logout): immediately restores raw 1.1 / 1.10012, still 1 fetch call total.
    act(() => {
      useAppStore.setState({ isAuthenticated: false });
    });
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toMatchObject({ bid: 1.1, ask: 1.10012 });
  });

  it('leaves zero old-markup points on screen immediately when catalogue markup arrives after initial empty-map load', async () => {
    const { result } = renderHook(() => useMarketWatchTickHistory('EURUSD', 'scope-1'));

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toMatchObject({ bid: 1.1, ask: 1.10012 });

    // Even if any subsequent network call were to stall forever, committing m=5 updates the points immediately.
    apiGet.mockImplementation(() => new Promise(() => {}));
    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(5));
    });
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toMatchObject({ bid: 1.09997, ask: 1.10014 });
  });

  it('never fails or keeps stale points if the network goes down after initial load', async () => {
    setAccountSpreadMarkups('1001', eurusdMarkup(5));

    const { result } = renderHook(() => useMarketWatchTickHistory('EURUSD', 'scope-1'));

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(result.current[0]).toMatchObject({ bid: 1.09997, ask: 1.10014 });

    // Simulate network outage after initial load; a markup change must not issue a failing fetch or keep m=5 points.
    apiGet.mockRejectedValue(new Error('network down'));
    act(() => {
      setAccountSpreadMarkups('1001', eurusdMarkup(10));
    });
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ bid: 1.09995, ask: 1.10017 });
  });
});
