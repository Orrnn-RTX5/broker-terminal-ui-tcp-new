import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tradeGatewayApi } from '../../api/tradeGateway';
import { api } from '../../services/api';
import { createTradeOperationContext } from '../../features/trading/session/tradeOperationContext';
import type { SymbolMarketStatusState } from '../../hooks/useSymbolMarketStatus';
import { beginPositionsRead, mergeTradeHistory, useAppStore, type Position, type Trade } from '../../store/useAppStore';
import {
  BACKGROUND_HISTORY_LIMIT,
  HISTORY_REFRESH_MIN_INTERVAL_MS,
  useTradeRefreshController,
} from './useTradeRefreshController';
import { useOrderExecution } from './useOrderExecution';
import { useTradeStreamRuntime } from './useTradeStreamRuntime';

vi.mock('../../services/tradingAuthGate', () => ({ requireTradingAuth: vi.fn(() => true) }));

vi.mock('../../services/api', () => ({
  api: {
    account: { getAccountMetrics: vi.fn() },
    positions: { getPositions: vi.fn() },
    orders: { getPendingOrders: vi.fn(), placeMarketOrder: vi.fn(), placePendingOrder: vi.fn() },
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
vi.mock('./positionRuntime', () => ({
  applyOpenPositionSnapshot: vi.fn(),
  normalizeAccountSummary: vi.fn((raw: unknown) => raw),
  normalizePositions: vi.fn(() => [{ id: 71, symbol: 'EURUSD', side: 'BUY' }]),
  getChartEntryPriceForSymbol: vi.fn(() => 1.1),
  upsertImmediatePosition: vi.fn(),
}));
vi.mock('../../api/tradeGateway', () => ({
  collapseDealHistory: (deals: unknown[]) => deals,
  collapseTruncatedDealWindow: (deals: unknown[]) => ({ safe: deals, unverified: [] }),
  tradeGatewayApi: {
    getClosedPositions: vi.fn(async () => []),
    getDeals: vi.fn(async () => []),
  },
}));

// 100-iteration loops are slow under a loaded full-suite run; the clock is faked so only wall time grows.
vi.setConfig({ testTimeout: 60_000 });

const LOGIN = 200036;
const openMarketStatus: SymbolMarketStatusState = {
  symbol: 'EURUSD', status: 'open', isOpen: true, isTradeBlocked: false,
  label: 'Market Open', loading: false, error: null, refreshedAt: Date.now(),
};
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const mountAll = () => {
  const accountIdRef = { current: String(LOGIN) };
  const isAuthenticatedRef = { current: true };
  const controller = renderHook(() => useTradeRefreshController({
    getLiveTradingLogin: () => LOGIN,
    beginTradeRestRead: () => ({ startedAt: Date.now(), startedVersion: 0, startedLocalMutationVersion: 0 }),
    isStaleTradeRestRead: () => false,
    reconcileOptimisticClosedPositions: (positions) => positions,
    accountIdRef,
    isAuthenticatedRef,
    positionsStreamVersionRef: { current: 0 },
  }));
  const context = createTradeOperationContext(`broker:${LOGIN}`, LOGIN, 4);
  const order = renderHook(() => useOrderExecution({
    selectedMarketStatus: openMarketStatus,
    selectedSymbol: 'EURUSD',
    volume: 0.1,
    setVolume: vi.fn(),
    domSymbol: 'EURUSD',
    orderPanelSymbol: 'EURUSD',
    getAllowedSymbol: (symbol) => String(symbol),
    getLiveTradingLogin: () => LOGIN,
    captureTradeOperationContext: () => context,
    isTradeOperationContextCurrent: () => true,
    refreshPositions: vi.fn().mockResolvedValue(undefined),
    refreshOrdersAndHistory: (login, options) => controller.result.current.postTradeRefresh.refreshOrdersAndHistory(login, options),
  }));
  let handler: ((message: unknown) => void) | undefined;
  const stream = renderHook(() => useTradeStreamRuntime({
    isAuthenticated: true,
    subscribe: (_channel: string, callback: (data: unknown) => void) => {
      handler = callback;
      return () => undefined;
    },
    isSessionActive: () => true,
    getAcceptedChannelLogin: (channel?: string) => (
      channel?.startsWith('positions.') || channel?.startsWith('orders.') || channel?.startsWith('deals.') ? LOGIN : null
    ),
    getLiveTradingLogin: () => LOGIN,
    incrementPositionsStreamVersion: vi.fn(),
    hasServerClosedTicket: () => false,
    markServerClosedTickets: vi.fn(),
    markTradeWsMessage: vi.fn(),
    reconcileOptimisticClosedPositions: (positions: Position[]) => positions,
    refreshOrdersAndHistory: (login, options) => controller.result.current.refreshOrdersAndHistory(login, options),
    reloadMarketSymbols: vi.fn(),
  } as never));
  const deliver = (channel: string, data: unknown) => handler?.({ channel, data });
  return {
    controller, order, stream, deliver,
    unmountAll: () => { stream.unmount(); order.unmount(); controller.unmount(); },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  useAppStore.getState().reset();
  useAppStore.setState({ accountId: String(LOGIN), authToken: 'session-a', isAuthenticated: true });
  // A loaded broker positions snapshot lets a fill be recognised as a pure open.
  useAppStore.getState().setPositions([], { readStartedAt: beginPositionsRead() });
  vi.mocked(api.positions.getPositions).mockResolvedValue([] as never);
  vi.mocked(api.orders.getPendingOrders).mockResolvedValue([] as never);
  vi.mocked(api.account.getAccountMetrics).mockResolvedValue({} as never);
  vi.mocked(api.orders.placeMarketOrder).mockResolvedValue({ ticket: 71 } as never);
  vi.mocked(api.orders.placePendingOrder).mockResolvedValue({} as never);
});
afterEach(() => { vi.useRealTimers(); });

describe('closed-history reads on opens', () => {
  it('100 rapid market opens through useOrderExecution read no closed history', async () => {
    const view = mountAll();
    for (let i = 0; i < 100; i += 1) {
      await act(() => view.order.result.current.placeOrder('BUY'));
      await advance(10);
    }
    await advance(10_000);
    expect(tradeGatewayApi.getClosedPositions).not.toHaveBeenCalled();
    expect(tradeGatewayApi.getDeals).not.toHaveBeenCalled();
    // Orders and metrics still refresh after the fills.
    expect(api.orders.getPendingOrders).toHaveBeenCalled();
    view.unmountAll();
  });

  it('a fill on a known ticket (netting reduce/close) still reads history', async () => {
    useAppStore.getState().setPositions([{
      id: 71, symbol: 'EURUSD', side: 'BUY', volume: 1, openPrice: 1, currentPrice: 1,
      openTime: '2026-10-01T00:00:00.000Z', sl: 0, tp: 0, swap: 0, commission: 0, unrealizedPnL: 0,
    } as Position], { readStartedAt: beginPositionsRead() });
    const view = mountAll();
    await act(() => view.order.result.current.placeOrder('SELL'));
    await advance(1000);
    expect(tradeGatewayApi.getClosedPositions).toHaveBeenCalledTimes(1);
    expect(tradeGatewayApi.getClosedPositions).toHaveBeenCalledWith(LOGIN, { limit: BACKGROUND_HISTORY_LIMIT });
    view.unmountAll();
  });

  it('100 rapid order frames and entry-in deal frames read no closed history', async () => {
    const view = mountAll();
    for (let i = 0; i < 100; i += 1) {
      view.deliver(`orders.${LOGIN}`, { type: 'order_update', data: { ticket: 1000 + i, symbol: 'EURUSD', status: 'placed', state_version: 2 } });
      view.deliver(`deals.${LOGIN}`, { type: 'deal_add', data: { ticket: 2000 + i, symbol: 'EURUSD', position_id: 71, entry: 'in' } });
      await advance(10);
    }
    await advance(10_000);
    expect(tradeGatewayApi.getClosedPositions).not.toHaveBeenCalled();
    expect(api.orders.getPendingOrders).toHaveBeenCalled();
    view.unmountAll();
  });

  it('an order frame with an unknown or missing status keeps the history refresh', async () => {
    const view = mountAll();
    view.deliver(`orders.${LOGIN}`, { type: 'order_update', data: { ticket: 9, symbol: 'EURUSD', state_version: 2 } });
    await advance(3000);
    expect(tradeGatewayApi.getClosedPositions).toHaveBeenCalled();
    view.unmountAll();
  });

  it('a deal frame without an entry kind keeps the history refresh', async () => {
    const view = mountAll();
    view.deliver(`deals.${LOGIN}`, { type: 'deal_add', data: { ticket: 1, symbol: 'EURUSD', position_id: 71 } });
    await advance(3000);
    expect(tradeGatewayApi.getClosedPositions).toHaveBeenCalled();
    view.unmountAll();
  });
});

describe('closed-history reads on closes', () => {
  it('50 close requests inside 1 s read at most once per 2 s window with limit 100', async () => {
    const view = mountAll();
    for (let i = 0; i < 50; i += 1) {
      act(() => {
        window.dispatchEvent(new CustomEvent('rtx:refresh-trade-history-requested', { detail: { login: LOGIN } }));
      });
      await advance(20);
    }
    await advance(10_000);
    const calls = vi.mocked(tradeGatewayApi.getClosedPositions).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(3);
    calls.forEach((call) => expect(call).toEqual([LOGIN, { limit: BACKGROUND_HISTORY_LIMIT }]));
    expect(vi.mocked(tradeGatewayApi.getDeals).mock.calls.every((call) => (call[1] as { limit?: number })?.limit === BACKGROUND_HISTORY_LIMIT)).toBe(true);
    view.unmountAll();
    expect(HISTORY_REFRESH_MIN_INTERVAL_MS).toBe(2000);
  });

  it('a direct full load (startup, recovery, History tab path) keeps the default read', async () => {
    const view = mountAll();
    await act(async () => { await view.controller.result.current.refreshOrdersAndHistory(LOGIN); });
    expect(tradeGatewayApi.getClosedPositions).toHaveBeenCalledWith(LOGIN, undefined);
    expect(tradeGatewayApi.getDeals).toHaveBeenCalledWith(LOGIN, undefined);
    view.unmountAll();
  });
});

describe('limited history merge', () => {
  const trade = (id: string, closeTime: string, profit = 0, openTime = '2026-01-01T00:00:00.000Z'): Trade => ({
    id, type: 'closed', symbol: 'EURUSD', openTime, closeTime, profit,
  } as unknown as Trade);

  it('keeps older loaded rows, lets incoming rows win (even the oldest one) and keeps newest-first order', () => {
    const existing = [trade('c', '2026-03-03T00:00:00.000Z'), trade('b', '2026-03-02T00:00:00.000Z'), trade('a', '2026-03-01T00:00:00.000Z')];
    const incoming = [trade('d', '2026-03-04T00:00:00.000Z'), trade('c', '2026-03-03T00:00:00.000Z', 5), trade('b', '2026-03-02T00:00:00.000Z', 9)];
    const { trades, needsFullRead } = mergeTradeHistory(existing, incoming);
    expect(trades.map((row) => String(row.id))).toEqual(['d', 'c', 'b', 'a']);
    expect(trades.find((row) => String(row.id) === 'c')?.profit).toBe(5);
    // Not truncated: the oldest incoming row is the final close and replaces the partial one.
    expect(trades.find((row) => String(row.id) === 'b')?.profit).toBe(9);
    expect(needsFullRead).toBe(false);
  });

  it('never duplicates a row and never drops one below the cap', () => {
    const existing = Array.from({ length: 40 }, (_, i) => trade(`r${i}`, `2026-02-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`));
    const incoming = existing.slice(0, 10).map((row) => ({ ...row, profit: 1 }));
    const { trades } = mergeTradeHistory(existing, incoming);
    expect(trades).toHaveLength(40);
    expect(new Set(trades.map((row) => `${row.type}:${row.id}`)).size).toBe(40);
  });

  it('an unverified exit is covered by a held position row that closed at or after it, otherwise asks for a full read', () => {
    const held = { ...trade('7', '2026-03-05T00:00:00.000Z', 2, '2026-02-01T00:00:00.000Z'), positionId: 7 } as unknown as Trade;
    const olderExit = { ...trade('9001', '2026-03-04T00:00:00.000Z'), type: 'sell', positionId: 7 } as unknown as Trade;
    const covered = mergeTradeHistory([held], [], { unverified: [olderExit] });
    expect(covered.needsFullRead).toBe(false);
    expect(covered.trades).toHaveLength(1);

    const newerExit = { ...olderExit, closeTime: '2026-03-06T00:00:00.000Z' } as unknown as Trade;
    const stale = mergeTradeHistory([held], [], { unverified: [newerExit] });
    expect(stale.needsFullRead).toBe(true);
    expect(stale.trades).toHaveLength(1);
    expect(stale.trades[0].profit).toBe(2);

    const unknown = mergeTradeHistory([held], [], { unverified: [{ ...olderExit, positionId: 99 } as unknown as Trade] });
    expect(unknown.needsFullRead).toBe(true);
    expect(unknown.trades).toHaveLength(1);
  });

  it('never keeps two rows for one position: a closed-position or deal row matching a held closed row is dropped', () => {
    const held = { ...trade('5', '2026-03-05T00:00:00.000Z'), positionId: 5 } as unknown as Trade;
    const sameTicket = { ...trade('5', '2026-03-05T00:00:00.000Z'), type: 'sl', historySource: 'closed-position' } as unknown as Trade;
    const dealRow = { ...trade('8001', '2026-03-05T00:00:00.000Z'), type: 'sell', positionId: 5 } as unknown as Trade;
    const other = { ...trade('6', '2026-03-06T00:00:00.000Z'), type: 'sl', historySource: 'closed-position' } as unknown as Trade;
    const { trades } = mergeTradeHistory([held], [sameTicket, dealRow, other]);
    expect(trades.map((row) => `${row.type}:${row.id}`)).toEqual(['sl:6', 'closed:5']);
  });

  it('drops a closed-position row already held once the deal-based closed row for that position arrives', () => {
    const heldSl = { ...trade('5', '2026-03-05T00:00:00.000Z'), type: 'sl', historySource: 'closed-position' } as unknown as Trade;
    const keep = { ...trade('4', '2026-03-04T00:00:00.000Z'), type: 'sl', historySource: 'closed-position' } as unknown as Trade;
    const closedRow = { ...trade('5', '2026-03-05T00:00:00.000Z', 3), positionId: 5, historySource: 'deal' } as unknown as Trade;
    const { trades } = mergeTradeHistory([heldSl, keep], [closedRow]);
    expect(trades.map((row) => `${row.type}:${row.id}`)).toEqual(['closed:5', 'sl:4']);
  });

  it('never drops a standalone deal row only because its deal ticket equals an unrelated position id', () => {
    const held = { ...trade('5', '2026-03-05T00:00:00.000Z'), positionId: 5 } as unknown as Trade;
    const unrelatedDeal = { ...trade('5', '2026-03-06T00:00:00.000Z'), type: 'sell', positionId: 77, historySource: 'deal' } as unknown as Trade;
    const { trades } = mergeTradeHistory([held], [unrelatedDeal]);
    expect(trades.map((row) => `${row.type}:${row.id}`)).toEqual(['sell:5', 'closed:5']);
  });

  it('returns the held array untouched when the merge changes nothing (no needless store update)', () => {
    const existing = [trade('b', '2026-03-02T00:00:00.000Z'), trade('a', '2026-03-01T00:00:00.000Z')];
    const same = existing.map((row) => ({ ...row }));
    const result = mergeTradeHistory(existing, same);
    expect(result.trades).toBe(existing);

    useAppStore.getState().setTrades(existing);
    let updates = 0;
    const unsubscribe = useAppStore.subscribe(() => { updates += 1; });
    expect(useAppStore.getState().mergeTrades(same)).toBe(false);
    expect(updates).toBe(0);
    expect(useAppStore.getState().trades).toBe(existing);
    unsubscribe();
  });

  it('preferExisting adds missing rows but never overwrites a held row', () => {
    const held = trade('x', '2026-03-05T00:00:00.000Z', 5);
    const { trades } = mergeTradeHistory([held], [trade('x', '2026-03-01T00:00:00.000Z', 1), trade('y', '2026-03-02T00:00:00.000Z')], { preferExisting: true });
    expect(trades.map((row) => String(row.id))).toEqual(['x', 'y']);
    expect(trades[0].profit).toBe(5);
  });

  it('the store merges limited rows while setTrades still replaces', () => {
    useAppStore.getState().setTrades([trade('a', '2026-03-01T00:00:00.000Z'), trade('b', '2026-03-02T00:00:00.000Z')]);
    expect(useAppStore.getState().mergeTrades([trade('c', '2026-03-03T00:00:00.000Z')])).toBe(false);
    expect(useAppStore.getState().trades.map((row) => String(row.id))).toEqual(['c', 'b', 'a']);
    useAppStore.getState().setTrades([trade('z', '2026-03-05T00:00:00.000Z')]);
    expect(useAppStore.getState().trades.map((row) => String(row.id))).toEqual(['z']);
  });
});
