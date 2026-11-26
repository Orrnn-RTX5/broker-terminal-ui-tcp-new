// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTradeHistoryRequestCache, tradeGatewayApi } from '../../../api/tradeGateway';
import { getTradeWebSocketClient } from '../../../api/tradeSocket';
import { resetTerminalHistorySession } from '../../../services/terminalHistory';
import { useAppStore } from '../../../store/useAppStore';
import { HistoryTab } from './HistoryTab';

const formatMoney = (value: number | undefined | null): string => {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num)) return '0.00';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num).replace(/,/g, ' ');
};

describe('HistoryTab inline Deposit & Withdrawal records and real-time updates', () => {
  const socketHandlers = new Set<(message: unknown) => void>();

  beforeEach(() => {
    localStorage.clear();
    // 7c10304f: period tabs persist in sessionStorage and must not leak across cases.
    sessionStorage.clear();
    resetTerminalHistorySession();
    clearTradeHistoryRequestCache();
    useAppStore.getState().reset();
    useAppStore.setState({
      accountId: '200010',
      account: {
        balance: 9_500,
        equity: 9_500,
        margin: 0,
        freeMargin: 9_500,
        unrealizedPL: 0,
        marginLevel: 0,
        currency: 'USD',
        leverage: 100,
        hasBackendBalance: true,
      },
    });
    vi.spyOn(tradeGatewayApi, 'getHistoryDataSet').mockResolvedValue({
      positions: [],
      deals: [],
      orders: [],
      errors: { positions: null, deals: null, orders: null },
    });
    vi.spyOn(getTradeWebSocketClient(), 'subscribe').mockImplementation((channel, handler) => {
      if (channel === '*' && handler) socketHandlers.add(handler);
      return () => {
        if (handler) socketHandlers.delete(handler);
      };
    });
  });

  afterEach(() => {
    socketHandlers.clear();
    cleanup();
    useAppStore.getState().reset();
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows deposits and withdrawals directly inside the History section with no separate section tabs and filters by period', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = Math.floor(Date.parse('2020-02-01T10:00:00Z') / 1000);
    vi.spyOn(tradeGatewayApi, 'getBalanceHistory').mockResolvedValue([
      { id: 10, account_login: 200010, type: 'deposit', amount: 10_000, method: 'Bank Wire', comment: 'Initial funding', status: 'completed', time: oldSec },
      { id: 11, account_login: 200010, type: 'withdrawal', amount: 250, method: 'Bank Wire', comment: 'Old payout', status: 'completed', balance_after: 9_750, time: oldSec + 60 },
      { id: 12, account_login: 200010, type: 'withdrawal', amount: 500, comment: 'USDT TRC20', status: 'pending', balance_after: 9_250, time: nowSec - 120 },
    ]);

    render(<HistoryTab formatMoney={formatMoney} accountBalance={9_500} />);

    // No separate Deposit History / Withdrawal History section tabs
    expect(screen.queryByRole('button', { name: /Deposit History/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Withdrawal History/i })).toBeNull();

    // 7c10304f: history time filters are a tablist, not a button group.
    const filterBox = screen.getByRole('tablist', { name: 'History time filters' });
    expect(filterBox).toHaveClass('rtx-history-toolbar', 'rtx-trade-view-bar');
    expect(within(filterBox).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Today',
      'Last Hour',
      'Last 24 Hours',
      '14 Days',
      '6 Months',
    ]);

    const tableRegion = screen.getByLabelText('History records');
    await waitFor(() => expect(screen.getByText('3 records')).toBeInTheDocument());
    expect(within(tableRegion).getByTitle('Ticket: 10')).toBeInTheDocument();
    expect(within(tableRegion).getByTitle('Ticket: 11')).toBeInTheDocument();
    expect(within(tableRegion).getByTitle('Ticket: 12')).toBeInTheDocument();
    expect(within(tableRegion).getByText('Deposit')).toBeInTheDocument();
    expect(within(tableRegion).getAllByText('Withdrawal')).toHaveLength(2);
    expect(within(tableRegion).getByText('(Pending)')).toBeInTheDocument();
    expect(within(tableRegion).getByText('10 000.00')).toBeInTheDocument();
    expect(within(tableRegion).getByText('-500.00')).toBeInTheDocument();

    const summary = screen.getByRole('group', { name: 'History financial summary' });
    expect(tableRegion.contains(summary)).toBe(false);
    expect(summary.closest('.rtx-history-summary-bar')).not.toBeNull();
    expect(summary).toHaveTextContent('Deposit: 10 000.00');
    expect(summary).toHaveTextContent('Withdrawal: -750.00');
    expect(summary).toHaveTextContent('Balance: 9 500.00');

    // Period filtering applies directly to inline deposits & withdrawals
    fireEvent.click(within(filterBox).getByRole('tab', { name: '14 Days' }));
    expect(screen.getByText('1 records')).toBeInTheDocument();
    expect(within(tableRegion).getByTitle('Ticket: 12')).toBeInTheDocument();
    expect(within(tableRegion).queryByTitle('Ticket: 10')).toBeNull();
    expect(within(tableRegion).queryByTitle('Ticket: 11')).toBeNull();
    expect(summary).toHaveTextContent('Deposit: 0.00');
    expect(summary).toHaveTextContent('Withdrawal: -500.00');
  });

  it('updates inline Deposit and Withdrawal records in real time from WebSocket events and account balance changes', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let ledgerRows: Record<string, unknown>[] = [
      { id: 101, account_login: 200010, type: 'withdrawal', amount: 100, comment: 'Initial payout', status: 'completed', time: nowSec - 600 },
    ];
    vi.spyOn(tradeGatewayApi, 'getBalanceHistory').mockImplementation(async () => ledgerRows);

    render(<HistoryTab formatMoney={formatMoney} accountBalance={9_500} />);

    const tableRegion = screen.getByLabelText('History records');
    await waitFor(() => expect(within(tableRegion).getByTitle('Ticket: 101')).toBeInTheDocument());

    // 1. Live WebSocket deposit push immediately appears in History
    const liveDeposit = { id: 102, account_login: 200010, type: 'deposit', amount: 500, comment: 'WS instant deposit', status: 'completed', time: nowSec };
    ledgerRows = [...ledgerRows, liveDeposit];
    act(() => {
      socketHandlers.forEach((handler) => {
        handler({
          channel: 'deals.200010',
          account_login: 200010,
          data: { deposit: liveDeposit },
        });
      });
    });

    await waitFor(() => expect(within(tableRegion).getByTitle('Ticket: 102')).toBeInTheDocument());
    expect(within(tableRegion).getByText('Deposit')).toBeInTheDocument();
    expect(screen.getByText('2 records')).toBeInTheDocument();

    // 2. Account balance update in store triggers real-time ledger refresh automatically
    ledgerRows = [
      ...ledgerRows,
      { id: 103, account_login: 200010, type: 'withdrawal', amount: 450, comment: 'Balance sync payout', status: 'completed', balance_after: 8_750, time: nowSec + 5 },
    ];
    act(() => {
      useAppStore.setState((state) => ({
        account: state.account ? { ...state.account, balance: 8_750 } : null,
      }));
    });

    await waitFor(() => expect(within(tableRegion).getByTitle('Ticket: 103')).toBeInTheDocument());
    expect(screen.getByText('3 records')).toBeInTheDocument();
  });

  it('refreshes History balance operations on rtx:state-changed notifications', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let ledgerRows: Record<string, unknown>[] = [];
    vi.spyOn(tradeGatewayApi, 'getBalanceHistory').mockImplementation(async () => ledgerRows);

    render(<HistoryTab formatMoney={formatMoney} accountBalance={9_500} />);

    await waitFor(() => expect(screen.getByText('No history records for the selected filters')).toBeInTheDocument());

    ledgerRows = [
      { id: 201, account_login: 200010, type: 'withdrawal', amount: 120, comment: 'Event payout', status: 'completed', time: nowSec },
    ];
    act(() => {
      window.dispatchEvent(new CustomEvent('rtx:state-changed', { detail: { entities: ['withdrawals'] } }));
    });

    const tableRegion = screen.getByLabelText('History records');
    await waitFor(() => expect(within(tableRegion).getByTitle('Ticket: 201')).toBeInTheDocument());
    expect(screen.getByText('1 records')).toBeInTheDocument();
  });

  it('opens the History action menu when right-clicking blank space and suppresses browser Inspect', async () => {
    vi.spyOn(tradeGatewayApi, 'getBalanceHistory').mockResolvedValue([]);
    render(<HistoryTab formatMoney={formatMoney} accountBalance={9_500} />);

    const blankSurface = await screen.findByLabelText('History records');

    const contextEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 160,
      clientY: 180,
    });
    act(() => {
      blankSurface.dispatchEvent(contextEvent);
    });

    expect(contextEvent.defaultPrevented).toBe(true);
    const menu = await screen.findByRole('menu', { name: 'Context menu' });
    expect(within(menu).getByRole('menuitem', { name: 'Positions' })).toBeInTheDocument();
  });

  it('keeps the History summary bar fixed outside the scroll container and syncs horizontal scroll', async () => {
    vi.spyOn(tradeGatewayApi, 'getBalanceHistory').mockResolvedValue([]);
    render(<HistoryTab formatMoney={formatMoney} accountBalance={9_500} />);

    const scroller = await screen.findByLabelText('History records');
    const summary = screen.getByRole('group', { name: 'History financial summary' });
    const summaryBar = summary.closest('.rtx-history-summary-bar') as HTMLDivElement;

    expect(summaryBar).not.toBeNull();
    expect(scroller.contains(summaryBar)).toBe(false);
    expect(scroller.nextElementSibling).toBe(summaryBar);
    expect(scroller.querySelector('tfoot')).toBeNull();

    scroller.scrollTop = 240;
    scroller.scrollLeft = 96;
    fireEvent.scroll(scroller);

    expect(summaryBar.scrollLeft).toBe(96);
    expect(scroller.contains(summaryBar)).toBe(false);
  });
});
