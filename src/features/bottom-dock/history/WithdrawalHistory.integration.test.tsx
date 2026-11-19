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

describe('HistoryTab Withdrawal History sub-tab & real-time updates', () => {
  const socketHandlers = new Set<(message: unknown) => void>();

  beforeEach(() => {
    localStorage.clear();
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
    vi.restoreAllMocks();
  });

  it('switches between History and Withdrawal History, filters by period, and renders withdrawal details', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = Math.floor(Date.parse('2020-02-01T10:00:00Z') / 1000);
    vi.spyOn(tradeGatewayApi, 'getBalanceHistory').mockResolvedValue([
      { id: 10, account_login: 200010, type: 'deposit', amount: 10_000, comment: 'Initial funding', time: oldSec },
      { id: 11, account_login: 200010, type: 'withdrawal', amount: 250, method: 'Bank Wire', comment: 'Old payout', status: 'completed', balance_after: 9_750, time: oldSec + 60 },
      { id: 12, account_login: 200010, type: 'withdrawal', amount: 500, comment: 'USDT TRC20', status: 'pending', balance_after: 9_250, time: nowSec - 120 },
    ]);

    render(<HistoryTab formatMoney={formatMoney} accountBalance={9_500} />);

    const historyBtn = screen.getByRole('button', { name: 'History' });
    const withdrawalBtn = await screen.findByRole('button', { name: 'Withdrawal History (2)' });
    expect(historyBtn).toHaveAttribute('aria-pressed', 'true');
    expect(withdrawalBtn).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(withdrawalBtn);
    expect(withdrawalBtn).toHaveAttribute('aria-pressed', 'true');
    expect(historyBtn).toHaveAttribute('aria-pressed', 'false');

    const tableRegion = screen.getByLabelText('Withdrawal history records');
    const cols = tableRegion.querySelectorAll('colgroup col');
    expect(cols).toHaveLength(7);
    const firstColWidth = cols[0]?.getAttribute('style');
    cols.forEach((col) => expect(col.getAttribute('style')).toBe(firstColWidth));
    expect(within(tableRegion).getByText('USDT TRC20')).toBeInTheDocument();
    expect(within(tableRegion).getByText('Bank Wire — Old payout')).toBeInTheDocument();
    expect(within(tableRegion).queryByText('Initial funding')).toBeNull();
    expect(within(tableRegion).getByText('Pending')).toBeInTheDocument();
    expect(within(tableRegion).getByText('Completed')).toBeInTheDocument();

    const summary = screen.getByRole('group', { name: 'Withdrawal history summary' });
    expect(tableRegion.contains(summary)).toBe(false);
    expect(summary.closest('.rtx-withdrawal-summary-bar')).not.toBeNull();
    expect(summary).toHaveTextContent('Withdrawals: 2');
    expect(summary).toHaveTextContent('Withdrawal: -750.00');
    expect(summary).toHaveTextContent('Balance: 9 500.00');
    expect(summary).not.toHaveTextContent('Real-time');

    fireEvent.click(screen.getByRole('button', { name: 'Last 30 Days' }));
    expect(within(tableRegion).getByText('USDT TRC20')).toBeInTheDocument();
    expect(within(tableRegion).queryByText('Bank Wire — Old payout')).toBeNull();
    expect(screen.getByRole('button', { name: 'Withdrawal History (1)' })).toBeInTheDocument();
    expect(summary).toHaveTextContent('Withdrawals: 1');
    expect(summary).toHaveTextContent('Withdrawal: -500.00');
  });

  it('updates Withdrawal History in real time from WebSocket events and account balance changes', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let ledgerRows: Record<string, unknown>[] = [
      { id: 101, account_login: 200010, type: 'withdrawal', amount: 100, comment: 'Initial payout', status: 'completed', time: nowSec - 600 },
    ];
    vi.spyOn(tradeGatewayApi, 'getBalanceHistory').mockImplementation(async () => ledgerRows);

    render(<HistoryTab formatMoney={formatMoney} accountBalance={9_500} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Withdrawal History (1)' }));
    const tableRegion = screen.getByLabelText('Withdrawal history records');
    expect(within(tableRegion).getByText('Initial payout')).toBeInTheDocument();

    // 1. Live WebSocket push immediately surfaces a new withdrawal before/alongside REST reconciliation
    ledgerRows = [
      ...ledgerRows,
      { id: 102, account_login: 200010, type: 'withdrawal', amount: 300, comment: 'WS express payout', status: 'pending', time: nowSec },
    ];
    act(() => {
      socketHandlers.forEach((handler) => {
        handler({
          channel: 'deals.200010',
          account_login: 200010,
          data: ledgerRows[1],
        });
      });
    });

    await waitFor(() => expect(within(tableRegion).getByText('WS express payout')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Withdrawal History (2)' })).toBeInTheDocument();

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

    await waitFor(() => expect(within(tableRegion).getByText('Balance sync payout')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Withdrawal History (3)' })).toBeInTheDocument();
  });

  it('refreshes Withdrawal History on rtx:state-changed withdrawal notifications', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let ledgerRows: Record<string, unknown>[] = [];
    vi.spyOn(tradeGatewayApi, 'getBalanceHistory').mockImplementation(async () => ledgerRows);

    render(<HistoryTab formatMoney={formatMoney} accountBalance={9_500} />);
    fireEvent.click(screen.getByRole('button', { name: 'Withdrawal History' }));

    await waitFor(() => expect(screen.getByText('No withdrawal history for the selected period')).toBeInTheDocument());

    ledgerRows = [
      { id: 201, account_login: 200010, type: 'withdrawal', amount: 120, comment: 'Event payout', status: 'completed', time: nowSec },
    ];
    act(() => {
      window.dispatchEvent(new CustomEvent('rtx:state-changed', { detail: { entities: ['withdrawals'] } }));
    });

    await waitFor(() => expect(screen.getByText('Event payout')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Withdrawal History (1)' })).toBeInTheDocument();
  });

  it('opens the History action menu when right-clicking blank space on Withdrawal History and suppresses browser Inspect', async () => {
    vi.spyOn(tradeGatewayApi, 'getBalanceHistory').mockResolvedValue([]);
    render(<HistoryTab formatMoney={formatMoney} accountBalance={9_500} />);

    fireEvent.click(screen.getByRole('button', { name: 'Withdrawal History' }));
    const blankSurface = await screen.findByLabelText('Withdrawal history records');

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

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Positions' }));
    expect(screen.getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true');
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
