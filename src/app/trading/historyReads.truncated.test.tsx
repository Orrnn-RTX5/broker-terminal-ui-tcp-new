import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tradeGatewayApi } from '../../api/tradeGateway';
import { api } from '../../services/api';
import { loadTerminalHistory, registerHistoryTabMounted } from '../../services/terminalHistory';
import { beginPositionsRead, useAppStore, type Position, type Trade } from '../../store/useAppStore';
import { fetchOrderHistory } from './orderHistoryRefresh';
import { BACKGROUND_HISTORY_LIMIT, useTradeRefreshController } from './useTradeRefreshController';
import { useTradeStreamRuntime } from './useTradeStreamRuntime';

vi.mock('../../services/api', () => ({
  api: {
    account: { getAccountMetrics: vi.fn() },
    positions: { getPositions: vi.fn() },
    orders: { getPendingOrders: vi.fn() },
  },
}));
// Real collapse logic; only the network methods are replaced.
vi.mock('../../api/tradeGateway', async (importActual) => {
  const actual = await importActual<typeof import('../../api/tradeGateway')>();
  return {
    ...actual,
    tradeGatewayApi: {
      ...actual.tradeGatewayApi,
      getClosedPositions: vi.fn(async () => []),
      getDeals: vi.fn(async () => []),
      getHistoryDataSet: vi.fn(async () => ({
        positions: [], deals: [], orders: [], errors: { positions: null, deals: null, orders: null },
      })),
    },
  };
});

vi.setConfig({ testTimeout: 60_000 });

const LOGIN = 200036;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const minute = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();

const deal = (id: number, positionId: number, entry: 'in' | 'out', volume: number, at: number, openPrice: number): Trade => ({
  id, positionId, symbol: 'EURUSD', side: entry === 'in' ? 'BUY' : 'SELL', entry, type: 'deal',
  volume, openPrice, closePrice: openPrice, openTime: minute(at), closeTime: minute(at),
  profit: entry === 'out' ? 3 : 0, commission: -1, swap: 0,
} as unknown as Trade);

// Newest-first page cut off after `limit` rows: P1's entry deal (price 1.1000, minute 1) is missing.
const truncatedPage = (): Trade[] => [
  deal(105, 1, 'out', 1, 20, 1.2),                // P1 exit; its entry is outside the page
  deal(104, 2, 'out', 1, 19, 1.31),               // P2 complete
  deal(103, 2, 'in', 1, 18, 1.3),
  deal(102, 3, 'out', 1, 17, 1.41),               // P3: scale-in whose first entry is outside
  deal(101, 3, 'in', 0.5, 16, 1.4),
];

const mountController = () => {
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
  return controller;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(tradeGatewayApi.getClosedPositions).mockReset().mockResolvedValue([]);
  vi.mocked(tradeGatewayApi.getDeals).mockReset().mockResolvedValue([]);
  localStorage.clear();
  useAppStore.getState().reset();
  useAppStore.setState({ accountId: String(LOGIN), authToken: 'session-a', isAuthenticated: true });
  vi.mocked(api.positions.getPositions).mockResolvedValue([] as never);
  vi.mocked(api.orders.getPendingOrders).mockResolvedValue([] as never);
  vi.mocked(api.account.getAccountMetrics).mockResolvedValue({} as never);
});
afterEach(() => { vi.useRealTimers(); });

describe('truncated deal page', () => {
  it('keeps only provably complete positions and withholds exit-only and scale-in rows', async () => {
    vi.mocked(tradeGatewayApi.getDeals).mockResolvedValue(truncatedPage());
    const result = await fetchOrderHistory(LOGIN, { limit: 5 });
    expect(result.trades.map((row) => row.id)).toEqual([2]);
    expect(result.trades[0].openPrice).toBeCloseTo(1.3);
    const withheld = (result.unverified ?? []).map((row) => Number(row.id)).sort((a, b) => a - b);
    // P1: standalone exit row keyed by the exit deal (105); P3: in 0.5 vs out 1.
    expect(withheld).toEqual([3, 105]);
    // No row built from the exit deal alone reaches the stored list, so no duplicate of P1.
    expect(result.trades.some((row) => row.id === 105 || row.id === 1)).toBe(false);
  });

  it('a page below the limit is complete: everything is stored, nothing withheld', async () => {
    vi.mocked(tradeGatewayApi.getDeals).mockResolvedValue(truncatedPage().slice(0, 4));
    const result = await fetchOrderHistory(LOGIN, { limit: 100 });
    expect(result.unverified).toBeUndefined();
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it('a new close the page cannot verify stores no wrong row and triggers one full read through the gate', async () => {
    const goodP1: Trade = {
      id: 1, type: 'closed', symbol: 'EURUSD', side: 'BUY', volume: 1, openPrice: 1.1, closePrice: 1.2,
      openTime: minute(1), closeTime: minute(20), profit: 3,
    } as unknown as Trade;
    vi.mocked(tradeGatewayApi.getDeals).mockImplementation((async (_login: number, options?: { limit?: number }) => (
      options?.limit === undefined
        ? [deal(100, 1, 'in', 1, 1, 1.1), ...truncatedPage()]
        : truncatedPage()
    )) as never);
    const view = mountController();
    // BACKGROUND_HISTORY_LIMIT is 100 but the fixture page has 5 rows: shrink the page rule.
    vi.mocked(tradeGatewayApi.getDeals).mockImplementationOnce((async () => (
      Array.from({ length: BACKGROUND_HISTORY_LIMIT - 5 }, (_, i) => deal(1000 + i, 900 + i, 'in', 1, 30 + (i % 20), 1.5))
        .concat(truncatedPage())
    )) as never);

    act(() => {
      window.dispatchEvent(new CustomEvent('rtx:refresh-trade-history-requested', { detail: { login: LOGIN } }));
    });
    await advance(1000);
    const afterLimited = useAppStore.getState().trades;
    expect(afterLimited.some((row) => row.id === 105)).toBe(false);
    expect(afterLimited.some((row) => row.id === 1)).toBe(false);
    expect(vi.mocked(tradeGatewayApi.getDeals).mock.calls[0]).toEqual([LOGIN, { limit: BACKGROUND_HISTORY_LIMIT }]);

    // The full read runs once the 2 s window ends, without a limit.
    await advance(3000);
    const calls = vi.mocked(tradeGatewayApi.getDeals).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toBeUndefined();
    const full = useAppStore.getState().trades;
    expect(full.find((row) => row.id === 1)?.openPrice).toBeCloseTo(goodP1.openPrice as number);
    expect(full.filter((row) => row.id === 1)).toHaveLength(1);
    view.unmount();
  });
});

describe('History tab invalidation on opens', () => {
  it('an open invalidates the cached History data set so the next tab mount refetches', async () => {
    const view = mountController();
    await loadTerminalHistory(LOGIN, 'scope');
    await loadTerminalHistory(LOGIN, 'scope');
    expect(tradeGatewayApi.getHistoryDataSet).toHaveBeenCalledTimes(1);

    await act(async () => { await view.result.current.refreshOrdersAndHistory(LOGIN, { skipHistory: true }); });
    expect(tradeGatewayApi.getClosedPositions).not.toHaveBeenCalled();

    await loadTerminalHistory(LOGIN, 'scope');
    expect(tradeGatewayApi.getHistoryDataSet).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('with the History tab mounted, opens add no controller read and ask the tab for one refresh per window', async () => {
    const view = mountController();
    const completed: unknown[] = [];
    const onCompleted = (event: Event) => completed.push((event as CustomEvent).detail);
    window.addEventListener('rtx:trade-history-refresh-completed', onCompleted);
    const unregister = registerHistoryTabMounted();
    for (let i = 0; i < 100; i += 1) {
      await act(async () => { await view.result.current.refreshOrdersAndHistory(LOGIN, { skipHistory: true }); });
      await advance(10);
    }
    await advance(5000);
    expect(tradeGatewayApi.getClosedPositions).not.toHaveBeenCalled();
    expect(tradeGatewayApi.getDeals).not.toHaveBeenCalled();
    // The tab's own refresh is requested at most once per 2 s window (leading + trailing).
    expect(completed.length).toBeGreaterThanOrEqual(1);
    expect(completed.length).toBeLessThanOrEqual(3);
    unregister();
    window.removeEventListener('rtx:trade-history-refresh-completed', onCompleted);
    view.unmount();
  });

  it('with the History tab closed, an open does no history read and requests no tab refresh', async () => {
    const view = mountController();
    const completed: unknown[] = [];
    const onCompleted = (event: Event) => completed.push((event as CustomEvent).detail);
    window.addEventListener('rtx:trade-history-refresh-completed', onCompleted);
    await act(async () => { await view.result.current.refreshOrdersAndHistory(LOGIN, { skipHistory: true }); });
    await advance(5000);
    expect(tradeGatewayApi.getClosedPositions).not.toHaveBeenCalled();
    expect(completed).toHaveLength(0);
    window.removeEventListener('rtx:trade-history-refresh-completed', onCompleted);
    view.unmount();
  });
});

describe('in-flight reads survive invalidation', () => {
  const closedRow = (id: number, at: number): Trade => ({
    id, type: 'closed', symbol: 'EURUSD', side: 'BUY', volume: 1, openPrice: 1, closePrice: 1.1,
    openTime: minute(0), closeTime: minute(at), profit: id,
  } as unknown as Trade);

  it('an open during an in-flight limited read does not kill it: the close is still applied', async () => {
    let release!: (rows: Trade[]) => void;
    vi.mocked(tradeGatewayApi.getClosedPositions).mockImplementationOnce((() => new Promise<Trade[]>((resolve) => { release = resolve; })) as never);
    const view = mountController();
    act(() => {
      window.dispatchEvent(new CustomEvent('rtx:refresh-trade-history-requested', { detail: { login: LOGIN } }));
    });
    await advance(500);
    // An open lands while the read is in flight.
    // The open joins the in-flight read, so it is started without awaiting it.
    act(() => { void view.result.current.refreshOrdersAndHistory(LOGIN, { skipHistory: true }); });
    await act(async () => { release([closedRow(7, 40)]); });
    await advance(3000);
    expect(useAppStore.getState().trades.map((row) => row.id)).toEqual([7]);
    view.unmount();
  });

  it('an open during an in-flight full read does not kill it: the rows are applied', async () => {
    let release!: (rows: Trade[]) => void;
    vi.mocked(tradeGatewayApi.getClosedPositions).mockImplementationOnce((() => new Promise<Trade[]>((resolve) => { release = resolve; })) as never);
    const view = mountController();
    act(() => { void view.result.current.refreshOrdersAndHistory(LOGIN); });
    await advance(50);
    // The open joins the in-flight read, so it is started without awaiting it.
    act(() => { void view.result.current.refreshOrdersAndHistory(LOGIN, { skipHistory: true }); });
    await act(async () => { release([closedRow(8, 41)]); });
    await advance(3000);
    expect(useAppStore.getState().trades.map((row) => row.id)).toContain(8);
    view.unmount();
  });

  it('a failed gated read is retried once through the gate and then applied', async () => {
    vi.mocked(tradeGatewayApi.getDeals).mockRejectedValueOnce(new Error('network'));
    vi.mocked(tradeGatewayApi.getClosedPositions).mockResolvedValue([closedRow(9, 42)] as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = mountController();
    act(() => {
      window.dispatchEvent(new CustomEvent('rtx:refresh-trade-history-requested', { detail: { login: LOGIN } }));
    });
    await advance(1000);
    expect(useAppStore.getState().trades).toHaveLength(0);
    await advance(3000);
    expect(vi.mocked(tradeGatewayApi.getDeals)).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().trades.map((row) => row.id)).toEqual([9]);
    errorSpy.mockRestore();
    view.unmount();
  });
});

describe('covered exits do not repeat the full read', () => {
  it('repeated limited reads with an old out-of-window position run exactly one full read in total', async () => {
    vi.mocked(tradeGatewayApi.getDeals).mockImplementation((async (_login: number, options?: { limit?: number }) => (
      options?.limit === undefined
        ? [deal(100, 1, 'in', 1, 1, 1.1), ...truncatedPage()]
        : Array.from({ length: BACKGROUND_HISTORY_LIMIT - 5 }, (_, i) => deal(1000 + i, 900 + i, 'in', 1, 30 + (i % 20), 1.5))
          .concat(truncatedPage())
    )) as never);
    const view = mountController();
    for (let i = 0; i < 6; i += 1) {
      act(() => {
        window.dispatchEvent(new CustomEvent('rtx:refresh-trade-history-requested', { detail: { login: LOGIN } }));
      });
      await advance(3000);
    }
    const fullReads = vi.mocked(tradeGatewayApi.getDeals).mock.calls.filter((call) => call[1] === undefined);
    expect(fullReads).toHaveLength(1);
    expect(vi.mocked(tradeGatewayApi.getDeals).mock.calls.length).toBeGreaterThanOrEqual(6);
    view.unmount();
  });
});

describe('stop-out burst and read ordering', () => {
  // Same NATS close payload as useTradeStreamRuntime.closeFrames.test.ts, ticket swapped.
  const PAYLOAD_CLOSED = `{"data": {"lots": 0.010000000000000000, "side": "sell", "action": "closed", "status": "closed", "symbol": "ETHUSD", "ticket": 12065, "volume": 0.010000000000000000, "broker_id": "trivanta-markets", "price_open": 2399.320000000000000000, "time_create": 1792658095, "time_update": 1792658099, "update_kind": "snapshot", "account_login": 200036, "pnl_available": false, "state_version": "3", "position_ticket": 12065, "realized_profit": -0.090000000000000000, "volume_remaining": 0}, "type": "position_closed", "event_id": "c90d6484-034a-4605-a9c7-d363401b747b", "update_kind": "snapshot"}`;
  const closedPayload = (ticket: number) => PAYLOAD_CLOSED.replaceAll('12065', String(ticket));

  it('50 close frames inside 1 s read history at most once per 2 s window, always with limit 100', async () => {
    const view = mountController();
    let handler: ((message: unknown) => void) | undefined;
    const stream = renderHook(() => useTradeStreamRuntime({
      isAuthenticated: true,
      subscribe: (_channel: string, callback: (data: unknown) => void) => { handler = callback; return () => undefined; },
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
      refreshOrdersAndHistory: (login, options) => view.result.current.postTradeRefresh.refreshOrdersAndHistory(login, options),
      reloadMarketSymbols: vi.fn(),
    } as never));
    const positions = Array.from({ length: 50 }, (_, i) => ({
      id: 5000 + i, symbol: 'ETHUSD', side: 'SELL', volume: 0.01, openPrice: 2399.32, currentPrice: 2402.59,
      openTime: '2026-10-22T08:34:55.000Z', sl: 0, tp: 0, swap: 0, commission: 0, unrealizedPnL: -0.09, state_version: '2',
    } as Position));
    useAppStore.getState().setPositions(positions, { readStartedAt: beginPositionsRead() });

    for (let i = 0; i < 50; i += 1) {
      act(() => { handler?.({ channel: `positions.${LOGIN}`, data: JSON.parse(closedPayload(5000 + i)) }); });
      await advance(20);
    }
    await advance(12_000);
    const calls = vi.mocked(tradeGatewayApi.getClosedPositions).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(3);
    calls.forEach((call) => expect(call).toEqual([LOGIN, { limit: BACKGROUND_HISTORY_LIMIT }]));
    stream.unmount();
    view.unmount();
  });

  it('a slow full read never overwrites newer rows from the limited read that follows it', async () => {
    const closed = (id: number, at: number): Trade => ({
      id, type: 'closed', symbol: 'EURUSD', side: 'BUY', volume: 1, openPrice: 1, closePrice: 1.1,
      openTime: minute(0), closeTime: minute(at), profit: id,
    } as unknown as Trade);
    let releaseFull!: (rows: Trade[]) => void;
    const slowFull = new Promise<Trade[]>((resolve) => { releaseFull = resolve; });
    vi.mocked(tradeGatewayApi.getClosedPositions)
      .mockImplementationOnce((() => slowFull) as never)
      .mockImplementation((async () => [closed(3, 30), closed(2, 20)]) as never);
    const view = mountController();

    let fullDone = false;
    act(() => { void view.result.current.refreshOrdersAndHistory(LOGIN).then(() => { fullDone = true; }); });
    await advance(10);
    act(() => {
      window.dispatchEvent(new CustomEvent('rtx:refresh-trade-history-requested', { detail: { login: LOGIN } }));
    });
    await advance(1000);
    await act(async () => { releaseFull([closed(2, 20), closed(1, 10)]); });
    await advance(3000);
    expect(fullDone).toBe(true);
    const ids = useAppStore.getState().trades.map((row) => row.id);
    expect(ids).toEqual([3, 2, 1]);
    view.unmount();
  });
});

describe('stop-out pages and joined reads', () => {
  it('a stop-out page of 100 exits of older positions adds no duplicate rows and runs one gated full read', async () => {
    const ids = Array.from({ length: BACKGROUND_HISTORY_LIMIT }, (_, i) => 3000 + i);
    const exits = ids.map((id, i) => deal(id + 10_000, id, 'out', 1, 40 + (i % 15), 1.2));
    const fullDeals = ids.flatMap((id, i) => [deal(id + 20_000, id, 'in', 1, 1 + (i % 15), 1.1), deal(id + 10_000, id, 'out', 1, 40 + (i % 15), 1.2)]);
    const closedPositionRows = ids.map((id, i) => ({
      id, type: 'sl', symbol: 'EURUSD', side: 'BUY', volume: 1, openPrice: 1.1, closePrice: 1.2,
      openTime: minute(1), closeTime: minute(40 + (i % 15)), profit: 3,
    } as unknown as Trade));
    vi.mocked(tradeGatewayApi.getDeals).mockImplementation((async (_login: number, options?: { limit?: number }) => (
      options?.limit === undefined ? fullDeals : exits
    )) as never);
    vi.mocked(tradeGatewayApi.getClosedPositions).mockResolvedValue(closedPositionRows as never);
    const view = mountController();

    act(() => {
      window.dispatchEvent(new CustomEvent('rtx:refresh-trade-history-requested', { detail: { login: LOGIN } }));
    });
    await advance(1000);
    // The limited read stored nothing: no closed-position fallback rows beside deal-built ones.
    expect(useAppStore.getState().trades).toHaveLength(0);

    await advance(4000);
    const fullReads = vi.mocked(tradeGatewayApi.getDeals).mock.calls.filter((call) => call[1] === undefined);
    expect(fullReads).toHaveLength(1);
    const trades = useAppStore.getState().trades;
    expect(trades).toHaveLength(BACKGROUND_HISTORY_LIMIT);
    expect(new Set(trades.map((row) => Number(row.id))).size).toBe(BACKGROUND_HISTORY_LIMIT);
    expect(trades.every((row) => row.type === 'closed')).toBe(true);
    view.unmount();
  });

  it('a follow-up read that joined a startup read and fails once is retried and applied', async () => {
    const row = {
      id: 77, type: 'closed', symbol: 'EURUSD', side: 'BUY', volume: 1, openPrice: 1, closePrice: 1.1,
      openTime: minute(0), closeTime: minute(50), profit: 5,
    } as unknown as Trade;
    let releaseStartup!: (rows: Trade[]) => void;
    vi.mocked(tradeGatewayApi.getClosedPositions)
      .mockImplementationOnce((() => new Promise<Trade[]>((resolve) => { releaseStartup = resolve; })) as never)
      .mockResolvedValue([row] as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = mountController();

    // Startup full read in flight; queue the failure for the follow-up read's deals call.
    act(() => { void view.result.current.refreshOrdersAndHistory(LOGIN); });
    vi.mocked(tradeGatewayApi.getDeals).mockRejectedValueOnce(new Error('network'));
    act(() => {
      window.dispatchEvent(new CustomEvent('rtx:refresh-trade-history-requested', { detail: { login: LOGIN } }));
    });
    await advance(500);
    await act(async () => { releaseStartup([]); });
    await advance(5000);

    expect(useAppStore.getState().trades.map((r) => r.id)).toEqual([77]);
    // startup read, failed follow-up, retry through the gate.
    expect(vi.mocked(tradeGatewayApi.getDeals)).toHaveBeenCalledTimes(3);
    errorSpy.mockRestore();
    view.unmount();
  });
});
