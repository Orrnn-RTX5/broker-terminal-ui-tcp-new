// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../services/api';
import { invalidateTerminalHistory } from '../../services/terminalHistory';
import { useAppStore, type Position, type Trade } from '../../store/useAppStore';
import { fetchOrderHistory } from './orderHistoryRefresh';
import {
  HISTORY_REFRESH_MIN_INTERVAL_MS,
  POST_TRADE_REFRESH_COALESCE_MS,
  useTradeRefreshController,
} from './useTradeRefreshController';

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

const LOGIN = 200036;

const makeTrade = (id: number, profit = 10): Trade => ({
  id,
  symbol: 'EURUSD',
  type: 'closed',
  side: 'BUY',
  volume: 0.1,
  openPrice: 1.08,
  closePrice: 1.09,
  openTime: '2026-10-20T08:00:00.000Z',
  closeTime: '2026-10-20T09:00:00.000Z',
  profit,
  commission: 0,
  swap: 0,
  status: 'closed',
  positionId: id,
  historySource: 'deal',
});

const mountController = () => {
  const accountIdRef = { current: String(LOGIN) };
  const isAuthenticatedRef = { current: true };
  return renderHook(() => useTradeRefreshController({
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
};

const advance = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

describe('useTradeRefreshController history purge (full replacement)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAppStore.getState().reset();
    useAppStore.setState({
      accountId: String(LOGIN),
      authToken: 'session-token',
      isAuthenticated: true,
      positions: [],
      orders: [],
      trades: [makeTrade(101, 25), makeTrade(102, -10)],
    });
    vi.mocked(api.positions.getPositions).mockResolvedValue([] as never);
    vi.mocked(api.orders.getPendingOrders).mockResolvedValue([] as never);
    vi.mocked(api.account.getAccountMetrics).mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('postTradeRefresh.refreshOrdersAndHistory(login, { full: true }) invalidates cache and replaces store.trades so deleted trades disappear', async () => {
    vi.mocked(fetchOrderHistory).mockResolvedValue({
      trades: [makeTrade(102, -10)],
      warning: null,
    });
    const { result, unmount } = mountController();

    act(() => {
      void result.current.postTradeRefresh.refreshOrdersAndHistory(LOGIN, { full: true });
    });
    expect(invalidateTerminalHistory).toHaveBeenCalled();

    await advance(POST_TRADE_REFRESH_COALESCE_MS + 10);

    // Unlimited read (no { limit: 100 }) so setTrades replaces instead of mergeTrades
    expect(fetchOrderHistory).toHaveBeenCalledTimes(1);
    expect(fetchOrderHistory).toHaveBeenCalledWith(LOGIN);
    expect(useAppStore.getState().trades.map((t) => t.id)).toEqual([102]);
    unmount();
  });

  it('replaces store.trades on direct rtx:state-changed for entity "history" and ignores already-scheduled events', async () => {
    vi.mocked(fetchOrderHistory).mockResolvedValue({
      trades: [makeTrade(102, -10)],
      warning: null,
    });
    const { unmount } = mountController();

    // Events already handled by useTradeStreamRuntime purge coalescer must not duplicate reads
    act(() => {
      window.dispatchEvent(new CustomEvent('rtx:state-changed', {
        detail: { entities: ['history'], login: LOGIN, historyPurgeScheduled: true },
      }));
    });
    await advance(POST_TRADE_REFRESH_COALESCE_MS + 50);
    expect(fetchOrderHistory).not.toHaveBeenCalled();

    // Direct rtx:state-changed (e.g. from external state invalidation) purges and replaces rows
    act(() => {
      window.dispatchEvent(new CustomEvent('rtx:state-changed', {
        detail: { entities: ['history'] },
      }));
    });
    expect(invalidateTerminalHistory).toHaveBeenCalled();
    await advance(POST_TRADE_REFRESH_COALESCE_MS + 10);

    expect(fetchOrderHistory).toHaveBeenCalledTimes(1);
    expect(fetchOrderHistory).toHaveBeenCalledWith(LOGIN);
    expect(useAppStore.getState().trades.map((t) => t.id)).toEqual([102]);
    unmount();
  });

  it('coalesces a burst of rtx:state-changed(history) events into at most one reload per burst window', async () => {
    vi.mocked(fetchOrderHistory).mockResolvedValue({ trades: [], warning: null });
    const { unmount } = mountController();

    for (let i = 0; i < 10; i += 1) {
      act(() => {
        window.dispatchEvent(new CustomEvent('rtx:state-changed', {
          detail: { entities: ['history'], login: LOGIN },
        }));
      });
      await advance(25);
    }

    await advance(POST_TRADE_REFRESH_COALESCE_MS + 50);
    expect(fetchOrderHistory).toHaveBeenCalledTimes(1);
    expect(fetchOrderHistory).toHaveBeenLastCalledWith(LOGIN);

    // No extra read while inside cooldown; after cooldown at most one trailing read if more arrived
    await advance(HISTORY_REFRESH_MIN_INTERVAL_MS * 2);
    expect(fetchOrderHistory).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().trades).toEqual([]);
    unmount();
  });
});
