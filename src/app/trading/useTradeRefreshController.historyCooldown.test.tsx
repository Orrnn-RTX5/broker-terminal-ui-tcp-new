import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../services/api';
import { useAppStore, type Position } from '../../store/useAppStore';
import { fetchOrderHistory } from './orderHistoryRefresh';
import { HISTORY_REFRESH_MIN_INTERVAL_MS, POST_TRADE_REFRESH_MAX_WAIT_MS, useTradeRefreshController } from './useTradeRefreshController';

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

const LOGIN = 123;

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

const dispatchHistoryRequest = () => {
  act(() => {
    window.dispatchEvent(new CustomEvent('rtx:refresh-trade-history-requested', { detail: { login: LOGIN } }));
  });
};

describe('history refresh cooldown', () => {
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

  it('50 close requests inside 1 s run one history read per 2 s window plus a trailing read', async () => {
    const { unmount } = mountController();
    for (let i = 0; i < 50; i += 1) {
      dispatchHistoryRequest();
      await advance(20);
    }
    // First read runs after the post-trade quiet window; nothing else yet.
    await advance(POST_TRADE_REFRESH_MAX_WAIT_MS);
    expect(fetchOrderHistory).toHaveBeenCalledTimes(1);

    // Later bursts inside the window are held back (the first read ran at ~500 ms).
    await advance(600);
    expect(fetchOrderHistory).toHaveBeenCalledTimes(1);

    // Trailing read lands once the 2 s window ends, and only one.
    await advance(1000);
    expect(fetchOrderHistory).toHaveBeenCalledTimes(2);
    await advance(10_000);
    expect(fetchOrderHistory).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('keeps successive history reads at least 2 s apart', async () => {
    mountController();
    const startedAt: number[] = [];
    vi.mocked(fetchOrderHistory).mockImplementation(async () => {
      startedAt.push(Date.now());
      return { trades: [], warning: null };
    });
    for (let i = 0; i < 100; i += 1) {
      dispatchHistoryRequest();
      await advance(100);
    }
    await advance(5000);
    expect(startedAt.length).toBeGreaterThan(1);
    for (let i = 1; i < startedAt.length; i += 1) {
      expect(startedAt[i] - startedAt[i - 1]).toBeGreaterThanOrEqual(HISTORY_REFRESH_MIN_INTERVAL_MS);
    }
  });

  it('does not read history when only positions are refreshed (market opens)', async () => {
    const { result } = mountController();
    for (let i = 0; i < 100; i += 1) {
      act(() => {
        void result.current.postTradeRefresh.refreshPositions(LOGIN, { allowWsCommit: true });
      });
      await advance(10);
    }
    await advance(5000);
    expect(fetchOrderHistory).not.toHaveBeenCalled();
  });
});
