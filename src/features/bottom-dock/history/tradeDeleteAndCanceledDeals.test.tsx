// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildClosedPositionHistory,
  clearTradeHistoryRequestCache,
  normalizeDeal,
  tradeGatewayApi,
  type TradeHistoryDataSet,
} from '../../../api/tradeGateway';
import { getTradeWebSocketClient } from '../../../api/tradeSocket';
import { resetTerminalHistorySession } from '../../../services/terminalHistory';
import { useAppStore, type Trade } from '../../../store/useAppStore';
import { calculateHistoryFinancialSummary } from './historyFinancialSummary';
import {
  isCanceledDeal,
  resolveHistoryRowProfit,
  resolveHistoryRowStatus,
  resolveHistoryRowTypeLabel,
} from './historyTabModel';
import { TRADE_HISTORY_REFRESH_COMPLETED_EVENT } from '../../../contracts/terminalEvents';
import { HistoryTab } from './HistoryTab';

const formatMoney = (value: number | undefined | null): string => {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return '0.00';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num).replace(/,/g, ' ');
};

describe('canceled deal normalization, model labels, and footer totals', () => {
  it('normalizes canceled buy and sell deals with profit 0 and canceled metadata', () => {
    const buyCanceled = normalizeDeal({
      ticket: 5001,
      symbol: 'EURUSD',
      action: 'buy',
      entry: 'out',
      volume: 0.25,
      price: 1.0912,
      profit: 145.75,
      commission: -1.5,
      swap: -0.25,
      time: 1790000100,
      canceled: true,
      canceled_at: 1790000500,
    });
    expect(buyCanceled).toMatchObject({
      id: 5001,
      side: 'BUY',
      dealType: 'buy_canceled',
      profit: 0,
      canceled: true,
      canceledAt: 1790000500,
    });
    expect(isCanceledDeal(buyCanceled)).toBe(true);
    expect(resolveHistoryRowTypeLabel(buyCanceled)).toBe('Canceled Buy');
    expect(resolveHistoryRowProfit(buyCanceled)).toBe(0);
    expect(resolveHistoryRowStatus(buyCanceled)).toBe('CANCELLED');

    const sellCanceled = normalizeDeal({
      ticket: 5002,
      symbol: 'GBPUSD',
      action: 'sell',
      entry: 'out',
      volume: 0.5,
      price: 1.265,
      profit: -92.3,
      time: 1790000200,
      canceled: true,
      canceled_at: 1790000600,
    });
    expect(sellCanceled).toMatchObject({
      id: 5002,
      side: 'SELL',
      dealType: 'sell_canceled',
      profit: 0,
      canceled: true,
      canceledAt: 1790000600,
    });
    expect(resolveHistoryRowTypeLabel(sellCanceled)).toBe('Canceled Sell');
    expect(resolveHistoryRowProfit(sellCanceled)).toBe(0);

    const normalDeal = normalizeDeal({
      ticket: 5003,
      symbol: 'EURUSD',
      action: 'buy',
      entry: 'out',
      volume: 0.1,
      price: 1.092,
      profit: 33.4,
      time: 1790000300,
    });
    expect(normalDeal.profit).toBe(33.4);
    expect(normalDeal.canceled).toBeUndefined();
    expect(isCanceledDeal(normalDeal)).toBe(false);
    expect(resolveHistoryRowTypeLabel(normalDeal)).toBe('buy');
    expect(resolveHistoryRowProfit(normalDeal)).toBe(33.4);
  });

  it('zeros stored profit for canceled deals in historyTabModel, collapsed positions, and footer financial totals', () => {
    const rawCanceledBuy: Trade = {
      id: 6001,
      dealTicket: 6001,
      positionId: 6000,
      symbol: 'EURUSD',
      type: 'entry_out',
      side: 'BUY',
      dealType: 'buy',
      entry: 'out',
      volume: 0.1,
      openPrice: 1.09,
      closePrice: 1.09,
      openTime: '2026-10-20T09:00:00Z',
      closeTime: '2026-10-20T09:00:00Z',
      profit: 88.5,
      commission: -2,
      swap: -0.5,
      canceled: true,
      historySource: 'deal',
    };
    const openingSell: Trade = {
      id: 5999,
      dealTicket: 5999,
      positionId: 6000,
      symbol: 'EURUSD',
      type: 'entry_in',
      side: 'SELL',
      dealType: 'sell',
      entry: 'in',
      volume: 0.1,
      openPrice: 1.1,
      closePrice: 1.1,
      openTime: '2026-10-20T08:00:00Z',
      closeTime: '2026-10-20T08:00:00Z',
      profit: 0,
      commission: 0,
      swap: 0,
      historySource: 'deal',
    };
    const activeSell: Trade = {
      id: 6002,
      dealTicket: 6002,
      symbol: 'EURUSD',
      type: 'entry_out',
      side: 'SELL',
      dealType: 'sell',
      entry: 'out',
      volume: 0.1,
      openPrice: 1.095,
      closePrice: 1.095,
      openTime: '2026-10-20T10:00:00Z',
      closeTime: '2026-10-20T10:00:00Z',
      profit: 25,
      commission: -1,
      swap: 0,
      historySource: 'deal',
    };

    expect(resolveHistoryRowTypeLabel(rawCanceledBuy)).toBe('Canceled Buy');
    expect(resolveHistoryRowProfit(rawCanceledBuy)).toBe(0);

    const collapsed = buildClosedPositionHistory([], [openingSell, rawCanceledBuy], 200010);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].profit).toBe(0);

    // Footer totals use 0 for canceled deals (even if raw stored profit/commission/swap is non-zero)
    const totals = calculateHistoryFinancialSummary([rawCanceledBuy, activeSell], []);
    expect(totals).toMatchObject({
      profit: 24,
      grossProfit: 25,
      commission: -1,
      swap: 0,
    });
  });
});

describe('HistoryTab canceled deals display and state-changed history purge', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetTerminalHistorySession();
    clearTradeHistoryRequestCache();
    useAppStore.getState().reset();
    useAppStore.setState({
      accountId: '200010',
      account: {
        balance: 10_000,
        equity: 10_000,
        margin: 0,
        freeMargin: 10_000,
        unrealizedPL: 0,
        marginLevel: 0,
        currency: 'USD',
        leverage: 100,
        hasBackendBalance: true,
      },
    });
    vi.spyOn(tradeGatewayApi, 'getBalanceHistory').mockResolvedValue([]);
    vi.spyOn(getTradeWebSocketClient(), 'subscribe').mockImplementation(() => () => undefined);
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().reset();
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('displays Canceled Buy / Canceled Sell with profit 0.00 and uses 0 in footer totals', async () => {
    sessionStorage.setItem('rtx5_session_history_view', 'deals');
    const nowSec = Math.floor(Date.now() / 1000);
    const canceledBuy = normalizeDeal({
      ticket: 7001,
      symbol: 'EURUSD',
      action: 'buy',
      entry: 'out',
      volume: 0.2,
      price: 1.09,
      profit: 120,
      time: nowSec - 120,
      canceled: true,
      canceled_at: nowSec - 60,
    });
    const canceledSell = normalizeDeal({
      ticket: 7002,
      symbol: 'GBPUSD',
      action: 'sell',
      entry: 'out',
      volume: 0.3,
      price: 1.27,
      profit: -55,
      time: nowSec - 90,
      canceled: true,
      canceled_at: nowSec - 30,
    });
    const normalDeal = normalizeDeal({
      ticket: 7003,
      symbol: 'USDJPY',
      action: 'sell',
      entry: 'out',
      volume: 0.1,
      price: 150.5,
      profit: 42.5,
      time: nowSec - 60,
    });

    vi.spyOn(tradeGatewayApi, 'getHistoryDataSet').mockResolvedValue({
      positions: [],
      deals: [canceledBuy, canceledSell, normalDeal],
      orders: [],
      errors: { positions: null, deals: null, orders: null },
    });

    render(<HistoryTab formatMoney={formatMoney} accountBalance={10_000} />);

    const tableRegion = screen.getByLabelText('History records');
    await waitFor(() => expect(within(tableRegion).getByTitle('Ticket: 7001')).toBeInTheDocument());

    expect(within(tableRegion).getByText('Canceled Buy')).toBeInTheDocument();
    expect(within(tableRegion).getByText('Canceled Sell')).toBeInTheDocument();

    const buyRow = within(tableRegion).getByTitle('Ticket: 7001').closest('tr')!;
    const sellRow = within(tableRegion).getByTitle('Ticket: 7002').closest('tr')!;
    expect(within(buyRow).getByTitle('Profit: 0.00')).toBeInTheDocument();
    expect(within(sellRow).getByTitle('Profit: 0.00')).toBeInTheDocument();

    // Footer summary uses 0 for both canceled deals -> total profit equals only normalDeal (42.50)
    const summaryGroup = screen.getByRole('group', { name: 'History financial summary' });
    expect(within(summaryGroup).getByText('42.50')).toBeInTheDocument();
    expect(screen.getByLabelText('Total gross profit')).toHaveTextContent('42.50');
  });

  it('refetches trade History on rtx:state-changed for history/deals/orders/positions so deleted trades disappear without reload, coalescing bursts to <= 1 per 1 s', async () => {
    vi.useFakeTimers();
    const nowIso = new Date().toISOString();
    let currentData: TradeHistoryDataSet = {
      positions: [
        {
          id: 8001,
          symbol: 'EURUSD',
          type: 'closed',
          side: 'BUY',
          volume: 0.1,
          openPrice: 1.08,
          closePrice: 1.09,
          openTime: nowIso,
          closeTime: nowIso,
          profit: 10,
          commission: 0,
          swap: 0,
          status: 'closed',
          historySource: 'deal',
        },
        {
          id: 8002,
          symbol: 'GBPUSD',
          type: 'closed',
          side: 'SELL',
          volume: 0.2,
          openPrice: 1.27,
          closePrice: 1.26,
          openTime: nowIso,
          closeTime: nowIso,
          profit: 20,
          commission: 0,
          swap: 0,
          status: 'closed',
          historySource: 'deal',
        },
      ],
      deals: [],
      orders: [],
      errors: { positions: null, deals: null, orders: null },
    };

    const getHistorySpy = vi.spyOn(tradeGatewayApi, 'getHistoryDataSet').mockImplementation(async () => currentData);

    render(<HistoryTab formatMoney={formatMoney} accountBalance={10_000} />);

    // Flush initial mount fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const tableRegion = screen.getByLabelText('History records');
    expect(within(tableRegion).getByTitle('Ticket: 8001')).toBeInTheDocument();
    expect(within(tableRegion).getByTitle('Ticket: 8002')).toBeInTheDocument();
    const initialCalls = getHistorySpy.mock.calls.length;

    // Manager deletes trade 8001 -> server omits 8001; burst of 8 state_changed events within 200 ms
    currentData = {
      ...currentData,
      positions: [currentData.positions[1]],
    };
    const entitiesList = ['history', 'deals', 'orders', 'positions'];
    for (let i = 0; i < 8; i += 1) {
      act(() => {
        window.dispatchEvent(new CustomEvent('rtx:state-changed', {
          detail: { entities: [entitiesList[i % entitiesList.length]] },
        }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25);
      });
    }

    // At +200 ms: leading reload fired once at +150 ms; trailing reload for the remaining events waits until +1150 ms
    expect(getHistorySpy.mock.calls.length - initialCalls).toBe(1);
    expect(within(tableRegion).queryByTitle('Ticket: 8001')).toBeNull();
    expect(within(tableRegion).getByTitle('Ticket: 8002')).toBeInTheDocument();

    // Advance past 1 s coalesce window: at most one trailing reload runs for the post-fire events
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(getHistorySpy.mock.calls.length - initialCalls).toBe(2);

    // No further reloads once burst stops
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(getHistorySpy.mock.calls.length - initialCalls).toBe(2);
  });

  it('reloads History once for a purge-scheduled invalidation, via the completed full read and not a second tab timer', async () => {
    vi.useFakeTimers();
    const nowIso = new Date().toISOString();
    const kept = {
      id: 8102,
      symbol: 'GBPUSD',
      type: 'closed',
      side: 'SELL',
      volume: 0.2,
      openPrice: 1.27,
      closePrice: 1.26,
      openTime: nowIso,
      closeTime: nowIso,
      profit: 20,
      commission: 0,
      swap: 0,
      status: 'closed',
      historySource: 'deal' as const,
    };
    let currentData: TradeHistoryDataSet = {
      positions: [
        {
          id: 8101,
          symbol: 'EURUSD',
          type: 'closed',
          side: 'BUY',
          volume: 0.1,
          openPrice: 1.08,
          closePrice: 1.09,
          openTime: nowIso,
          closeTime: nowIso,
          profit: 10,
          commission: 0,
          swap: 0,
          status: 'closed',
          historySource: 'deal',
        },
        kept,
      ],
      deals: [],
      orders: [],
      errors: { positions: null, deals: null, orders: null },
    };

    const getHistorySpy = vi.spyOn(tradeGatewayApi, 'getHistoryDataSet').mockImplementation(async () => currentData);

    render(<HistoryTab formatMoney={formatMoney} accountBalance={10_000} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const tableRegion = screen.getByLabelText('History records');
    expect(within(tableRegion).getByTitle('Ticket: 8101')).toBeInTheDocument();
    const initialCalls = getHistorySpy.mock.calls.length;

    currentData = {
      ...currentData,
      positions: [kept],
    };

    // One stream invalidation flushed as a burst. The flag means the full read
    // is already in flight, so the tab must not arm its own 150 ms reload.
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        window.dispatchEvent(new CustomEvent('rtx:state-changed', {
          detail: { entities: ['history'], login: 200010, historyPurgeScheduled: true },
        }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(getHistorySpy.mock.calls.length - initialCalls).toBe(0);
    expect(within(tableRegion).getByTitle('Ticket: 8101')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent(TRADE_HISTORY_REFRESH_COMPLETED_EVENT, {
        detail: { login: 200010, ok: true, message: null },
      }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(getHistorySpy.mock.calls.length - initialCalls).toBe(1);
    expect(within(tableRegion).queryByTitle('Ticket: 8101')).toBeNull();
    expect(within(tableRegion).getByTitle('Ticket: 8102')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(getHistorySpy.mock.calls.length - initialCalls).toBe(1);
  });
});
