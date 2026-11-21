import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../services/api';
import { useAppStore, type Position } from '../../store/useAppStore';
import { fetchOrderHistory } from './orderHistoryRefresh';
import { applyOpenPositionSnapshot } from './positionRuntime';
import { HISTORY_REFRESH_MIN_INTERVAL_MS, POST_TRADE_REFRESH_COALESCE_MS, POST_TRADE_REFRESH_MAX_WAIT_MS, useTradeRefreshController } from './useTradeRefreshController';

vi.mock('../../services/api', () => ({
  api: {
    account: { getAccountMetrics: vi.fn() },
    positions: { getPositions: vi.fn() },
    orders: { getPendingOrders: vi.fn() },
  },
}));

vi.mock('../../services/terminalHistory', () => ({
  beginTradeHistoryRefresh: vi.fn(),
  invalidateTerminalHistory: vi.fn(),
  isHistoryTabMounted: vi.fn(() => false),
}));

vi.mock('../../services/tradePositionStream', () => ({
  decodePositionStreamMessage: vi.fn(() => null),
  applyPositionStreamUpdate: vi.fn(),
}));

vi.mock('./orderHistoryRefresh', () => ({
  fetchOrderHistory: vi.fn(async () => ({ trades: [], warning: null })),
  getErrorMessage: vi.fn((error: unknown, fallback: string) => (
    error instanceof Error ? error.message : fallback
  )),
}));

vi.mock('./positionRuntime', () => ({
  applyOpenPositionSnapshot: vi.fn(),
  normalizeAccountSummary: vi.fn((raw: unknown) => raw),
  normalizePositions: vi.fn((positions: Position[]) => positions),
}));

vi.setConfig({ testTimeout: 30_000 });

const LOGIN = 123;

const position = (id: number): Position => ({
  id,
  symbol: 'EURUSD',
  side: 'BUY',
  volume: 0.1,
  openPrice: 1.1,
  currentPrice: 1.11,
  openTime: '2026-09-28T00:00:00.000Z',
  sl: 0,
  tp: 0,
  swap: 0,
  commission: 0,
  unrealizedPnL: 1,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const mountController = () => {
  const accountIdRef = { current: String(LOGIN) };
  const isAuthenticatedRef = { current: true };
  const hook = renderHook(() => useTradeRefreshController({
    getLiveTradingLogin: () => Number(accountIdRef.current) || null,
    beginTradeRestRead: () => ({
      startedAt: Date.now(),
      startedVersion: 0,
      startedLocalMutationVersion: 0,
    }),
    isStaleTradeRestRead: () => false,
    reconcileOptimisticClosedPositions: (positions) => positions,
    accountIdRef,
    isAuthenticatedRef,
    positionsStreamVersionRef: { current: 0 },
  }));
  return { ...hook, accountIdRef };
};

const advance = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

// One trade action: the position refresh and the orders+history refresh that follow it.
const completeTrade = (result: ReturnType<typeof mountController>['result']) => {
  act(() => {
    void result.current.postTradeRefresh.refreshPositions(LOGIN, { allowWsCommit: true });
    void result.current.postTradeRefresh.refreshOrdersAndHistory(LOGIN);
  });
};

describe('post-trade refresh coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAppStore.setState({
      accountId: String(LOGIN),
      authToken: 'session-a',
      isAuthenticated: true,
      positions: [],
      orders: [],
      trades: [],
    });
    vi.mocked(api.positions.getPositions).mockResolvedValue([] as never);
    vi.mocked(api.orders.getPendingOrders).mockResolvedValue([] as never);
    vi.mocked(api.account.getAccountMetrics).mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('five trade completions within 100 ms run one positions, orders/history and metrics read each', async () => {
    const { result } = mountController();
    const requests: Promise<void>[] = [];

    for (let trade = 0; trade < 5; trade += 1) {
      act(() => {
        requests.push(result.current.postTradeRefresh.refreshPositions(LOGIN, { allowWsCommit: true }));
        requests.push(result.current.postTradeRefresh.refreshOrdersAndHistory(LOGIN));
      });
      if (trade < 4) await advance(25);
    }
    let settled = false;
    void Promise.all(requests).then(() => {
      settled = true;
    });

    // The last completion was at 100 ms, so the burst runs 150 ms of quiet later, at 250 ms.
    await advance(POST_TRADE_REFRESH_COALESCE_MS - 1);
    expect(api.positions.getPositions).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    await advance(1);
    expect(api.positions.getPositions).toHaveBeenCalledTimes(1);
    expect(api.positions.getPositions).toHaveBeenCalledWith(LOGIN);
    expect(api.orders.getPendingOrders).toHaveBeenCalledTimes(1);
    expect(fetchOrderHistory).toHaveBeenCalledTimes(1);
    expect(api.account.getAccountMetrics).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
  });

  it('nonstop trading still refreshes: a burst runs at most POST_TRADE_REFRESH_MAX_WAIT_MS after its first request', async () => {
    const { result } = mountController();
    // A trade every 100 ms for 1.2 s: never 150 ms of quiet.
    for (let elapsed = 0; elapsed <= 1200; elapsed += 100) {
      if (elapsed === POST_TRADE_REFRESH_MAX_WAIT_MS) {
        expect(api.positions.getPositions).toHaveBeenCalledTimes(1);
      }
      completeTrade(result);
      await advance(100);
    }
    // Bursts started at 0, 500 and 1000 ms ran at 500 and 1000 ms; the third is still open.
    expect(api.positions.getPositions).toHaveBeenCalledTimes(2);
    expect(api.orders.getPendingOrders).toHaveBeenCalledTimes(2);
    await advance(POST_TRADE_REFRESH_COALESCE_MS);
    expect(api.positions.getPositions).toHaveBeenCalledTimes(3);
  });

  it('a trade after the window opens a new burst and triggers one more refresh', async () => {
    const { result } = mountController();
    completeTrade(result);
    await advance(POST_TRADE_REFRESH_COALESCE_MS);
    expect(api.positions.getPositions).toHaveBeenCalledTimes(1);

    await advance(500);
    completeTrade(result);
    await advance(POST_TRADE_REFRESH_COALESCE_MS - 1);
    expect(api.positions.getPositions).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(api.positions.getPositions).toHaveBeenCalledTimes(2);
    expect(api.orders.getPendingOrders).toHaveBeenCalledTimes(2);
    // The history read of the second burst is inside the 2 s cooldown: it trails the first one.
    expect(fetchOrderHistory).toHaveBeenCalledTimes(1);
    await advance(HISTORY_REFRESH_MIN_INTERVAL_MS);
    expect(fetchOrderHistory).toHaveBeenCalledTimes(2);
    // The trailing history read also re-reads pending orders and metrics.
    expect(api.orders.getPendingOrders).toHaveBeenCalledTimes(3);
    expect(api.account.getAccountMetrics).toHaveBeenCalledTimes(3);
  });

  it('a trade that completes while a read is in flight waits for it: one read per kind at a time, and the last read stands', async () => {
    const { result } = mountController();
    const firstPositions = deferred<Position[]>();
    const firstOrders = deferred<unknown[]>();
    vi.mocked(api.positions.getPositions)
      .mockReturnValueOnce(firstPositions.promise as never)
      .mockResolvedValueOnce([position(2)] as never);
    vi.mocked(api.orders.getPendingOrders)
      .mockReturnValueOnce(firstOrders.promise as never)
      .mockResolvedValueOnce([{ id: '902', symbol: 'EURUSD' }] as never);

    completeTrade(result);
    await advance(POST_TRADE_REFRESH_COALESCE_MS);
    expect(api.positions.getPositions).toHaveBeenCalledTimes(1);
    expect(api.orders.getPendingOrders).toHaveBeenCalledTimes(1);

    completeTrade(result);
    await advance(POST_TRADE_REFRESH_COALESCE_MS);
    expect(api.positions.getPositions).toHaveBeenCalledTimes(1);
    expect(api.orders.getPendingOrders).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstPositions.resolve([position(1)]);
      firstOrders.resolve([{ id: '901', symbol: 'EURUSD' }]);
    });
    // Let every promise hop of the finished read settle before the rerun is asserted.
    for (let flush = 0; flush < 5; flush += 1) await advance(1);

    expect(api.positions.getPositions).toHaveBeenCalledTimes(2);
    expect(api.orders.getPendingOrders).toHaveBeenCalledTimes(2);
    expect(vi.mocked(applyOpenPositionSnapshot).mock.lastCall?.[0]).toEqual([position(2)]);
    expect(useAppStore.getState().orders).toEqual([{ id: '902', symbol: 'EURUSD' }]);
  });

  it('a burst for a login that is no longer live reads nothing', async () => {
    const { result, accountIdRef } = mountController();
    completeTrade(result);
    accountIdRef.current = '456';

    await advance(POST_TRADE_REFRESH_COALESCE_MS);
    expect(api.positions.getPositions).not.toHaveBeenCalled();
    expect(api.orders.getPendingOrders).not.toHaveBeenCalled();
    expect(api.account.getAccountMetrics).not.toHaveBeenCalled();
  });

  it('unmounting runs a pending burst rather than dropping its final refresh', () => {
    const { result, unmount } = mountController();
    completeTrade(result);
    expect(api.positions.getPositions).not.toHaveBeenCalled();

    unmount();
    expect(api.positions.getPositions).toHaveBeenCalledTimes(1);
    expect(api.orders.getPendingOrders).toHaveBeenCalledTimes(1);
  });

  it('force-refresh events from the trade surfaces join the same burst', async () => {
    mountController();
    for (let event = 0; event < 5; event += 1) {
      act(() => {
        window.dispatchEvent(new Event('rtx:force-refresh-positions'));
      });
      if (event < 4) await advance(25);
    }

    // The event listener debounces 100 ms after the last event, then the burst waits 150 ms.
    await advance(100 + POST_TRADE_REFRESH_COALESCE_MS);
    expect(api.positions.getPositions).toHaveBeenCalledTimes(1);
  });

  it('non-trade callers still read at once, so the safety net and stream recovery are not delayed', async () => {
    const { result } = mountController();
    for (let read = 0; read < 3; read += 1) {
      await act(async () => {
        await result.current.refreshPositions(LOGIN, { allowWsCommit: true });
        await result.current.refreshOrdersAndHistory(LOGIN);
      });
    }
    expect(api.positions.getPositions).toHaveBeenCalledTimes(3);
    expect(api.orders.getPendingOrders).toHaveBeenCalledTimes(3);
    expect(fetchOrderHistory).toHaveBeenCalledTimes(3);
  });
});
