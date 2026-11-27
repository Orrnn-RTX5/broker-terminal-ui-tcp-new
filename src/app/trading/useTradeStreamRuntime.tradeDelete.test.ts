// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitBrokerAccountSessionScope } from '../../services/brokerSession';
import { TRADE_OVERLAY_CLOSE_STATE_EVENT } from '../../services/tradeOverlayHistory';
import * as terminalHistory from '../../services/terminalHistory';
import { beginPositionsRead, useAppStore, type Order, type Position } from '../../store/useAppStore';
import { useNotificationStore } from '../../store/useNotificationStore';
import { HISTORY_PURGE_COALESCE_MS, HISTORY_PURGE_LEAD_MS } from './tradeHistoryFreshness';
import { useTradeStreamRuntime } from './useTradeStreamRuntime';

const LOGIN = 200036;
const POSITIONS_CHANNEL = `positions.${LOGIN}`;
const ORDERS_CHANNEL = `orders.${LOGIN}`;
const STATE_CHANNEL = `state.${LOGIN}`;

const openPosition = (id = 12065, overrides: Partial<Position> = {}): Position => ({
  id,
  symbol: 'EURUSD',
  side: 'BUY',
  volume: 0.1,
  openPrice: 1.085,
  currentPrice: 1.086,
  openTime: '2026-10-22T08:34:55.000Z',
  sl: 1.08,
  tp: 1.095,
  swap: 0,
  commission: -0.5,
  unrealizedPnL: 10,
  state_version: '2',
  ...overrides,
} as Position);

describe('useTradeStreamRuntime trade delete handling and history purge coalescing', () => {
  let handler: ((data: unknown) => void) | undefined;
  let liveLogin: number | null;
  let refreshOrdersAndHistory: ReturnType<typeof vi.fn<(login?: number, options?: { skipHistory?: boolean; full?: boolean }) => Promise<void>>>;
  let unmount: (() => void) | undefined;

  const subscribe = vi.fn((_channel: string, callback: (data: unknown) => void) => {
    handler = callback;
    return () => {
      handler = undefined;
    };
  });

  const deliver = (channel: string, data: unknown) => {
    handler?.({ channel, data });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    commitBrokerAccountSessionScope({ brokerId: 'test-broker', login: LOGIN });
    useAppStore.getState().reset();
    useNotificationStore.setState({ notifications: [] });
    useAppStore.setState({ accountId: String(LOGIN), isAuthenticated: true });
    handler = undefined;
    liveLogin = LOGIN;
    subscribe.mockClear();
    refreshOrdersAndHistory = vi.fn(() => Promise.resolve());
    const rendered = renderHook(() => useTradeStreamRuntime({
      isAuthenticated: true,
      subscribe,
      isSessionActive: () => true,
      getAcceptedChannelLogin: (channel?: string) => (
        channel === `positions.${LOGIN}`
        || channel === `orders.${LOGIN}`
        || channel === `deals.${LOGIN}`
        || channel === `state.${LOGIN}`
          ? LOGIN
          : null
      ),
      getLiveTradingLogin: () => liveLogin,
      incrementPositionsStreamVersion: vi.fn(),
      hasServerClosedTicket: () => false,
      markServerClosedTickets: vi.fn(),
      markTradeWsMessage: vi.fn(),
      reconcileOptimisticClosedPositions: (positions) => positions,
      refreshOrdersAndHistory,
      reloadMarketSymbols: vi.fn(),
    }));
    unmount = rendered.unmount;
    useAppStore.getState().setPositions([openPosition()], { readStartedAt: beginPositionsRead() });
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('removes a deleted open position immediately, plays no sound/toast, invalidates terminalHistory, and triggers a full history reload', () => {
    const invalidateSpy = vi.spyOn(terminalHistory, 'invalidateTerminalHistory');
    const audioCtorSpy = vi.fn();
    vi.stubGlobal('Audio', audioCtorSpy);
    const feedbackEvents: CustomEvent[] = [];
    const overlayEvents: CustomEvent[] = [];
    const onFeedback = (e: Event) => feedbackEvents.push(e as CustomEvent);
    const onOverlay = (e: Event) => overlayEvents.push(e as CustomEvent);
    window.addEventListener('rtx:order-feedback', onFeedback);
    window.addEventListener(TRADE_OVERLAY_CLOSE_STATE_EVENT, onOverlay);

    try {
      deliver(POSITIONS_CHANNEL, {
        type: 'position_closed',
        data: {
          ticket: 12065,
          position_id: 12065,
          symbol: 'EURUSD',
          side: 'buy',
          status: 'closed',
          close_reason: 'deleted',
          deleted: true,
          broker_id: 'test-broker',
          account_login: LOGIN,
          state_version: '3',
        },
      });

      // Removed immediately from open positions
      expect(useAppStore.getState().positions).toEqual([]);
      // Overlay close state marks deleted so no phantom closed arrow is drawn
      expect(overlayEvents).toHaveLength(1);
      expect(overlayEvents[0].detail).toMatchObject({
        status: 'confirmed',
        ticketIds: ['12065'],
        deleted: true,
      });
      // No close sound and no close toast / notification
      expect(audioCtorSpy).not.toHaveBeenCalled();
      expect(feedbackEvents).toHaveLength(0);
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
      // Cache invalidated immediately
      expect(invalidateSpy).toHaveBeenCalled();

      vi.advanceTimersByTime(HISTORY_PURGE_LEAD_MS);
      expect(refreshOrdersAndHistory).toHaveBeenCalledTimes(1);
      expect(refreshOrdersAndHistory).toHaveBeenCalledWith(LOGIN, { full: true });

      // No extra fallback or trailing reload after a single delete
      vi.advanceTimersByTime(HISTORY_PURGE_COALESCE_MS * 3);
      expect(refreshOrdersAndHistory).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('rtx:order-feedback', onFeedback);
      window.removeEventListener(TRADE_OVERLAY_CLOSE_STATE_EVENT, onOverlay);
    }
  });

  it('handles close_reason "deleted" without deleted flag and type "position_deleted" identically', () => {
    useAppStore.getState().setPositions(
      [openPosition(20001), openPosition(20002)],
      { readStartedAt: beginPositionsRead() },
    );

    deliver(POSITIONS_CHANNEL, {
      type: 'position_closed',
      data: {
        ticket: 20001,
        symbol: 'EURUSD',
        side: 'buy',
        close_reason: 'deleted',
        broker_id: 'test-broker',
        account_login: LOGIN,
        state_version: '3',
      },
    });
    expect(useAppStore.getState().positions.map((p) => p.id)).toEqual([20002]);

    deliver(POSITIONS_CHANNEL, {
      type: 'position_deleted',
      data: {
        ticket: 20002,
        symbol: 'EURUSD',
        side: 'buy',
        broker_id: 'test-broker',
        account_login: LOGIN,
        state_version: '3',
      },
    });
    expect(useAppStore.getState().positions).toEqual([]);

    vi.advanceTimersByTime(HISTORY_PURGE_LEAD_MS);
    expect(refreshOrdersAndHistory).toHaveBeenCalledTimes(1);
    expect(refreshOrdersAndHistory).toHaveBeenCalledWith(LOGIN, { full: true });
  });

  it('removes a pending order on pending_cancelled with deleted:true, suppresses toast/sound, and triggers full history purge', () => {
    const invalidateSpy = vi.spyOn(terminalHistory, 'invalidateTerminalHistory');
    const audioCtorSpy = vi.fn();
    vi.stubGlobal('Audio', audioCtorSpy);
    const feedbackEvents: CustomEvent[] = [];
    const onFeedback = (e: Event) => feedbackEvents.push(e as CustomEvent);
    window.addEventListener('rtx:order-feedback', onFeedback);

    try {
      useAppStore.setState({
        orders: [{
          id: 901001,
          ticket: 901001,
          symbol: 'EURUSD',
          type: 'buy_limit',
          side: 'BUY',
          volume: 0.1,
          price: 1.075,
          status: 'PENDING',
        } as unknown as Order],
      });

      deliver(`rtx5.pending_orders.${LOGIN}`, {
        type: 'pending_cancelled',
        deleted: true,
        data: {
          ticket: 901001,
          symbol: 'EURUSD',
          status: 'cancelled',
          deleted: true,
        },
      });

      expect(useAppStore.getState().orders).toEqual([]);
      expect(audioCtorSpy).not.toHaveBeenCalled();
      expect(feedbackEvents).toHaveLength(0);
      expect(invalidateSpy).toHaveBeenCalled();

      vi.advanceTimersByTime(HISTORY_PURGE_LEAD_MS);
      expect(refreshOrdersAndHistory).toHaveBeenCalledTimes(1);
      expect(refreshOrdersAndHistory).toHaveBeenCalledWith(LOGIN, { full: true });
    } finally {
      window.removeEventListener('rtx:order-feedback', onFeedback);
    }
  });

  it('keeps normal pending_cancelled (without deleted:true) on the orders-only skipHistory path', () => {
    deliver(ORDERS_CHANNEL, {
      type: 'pending_cancelled',
      data: {
        ticket: 901002,
        symbol: 'EURUSD',
        status: 'cancelled',
      },
    });

    vi.advanceTimersByTime(HISTORY_PURGE_LEAD_MS);
    expect(refreshOrdersAndHistory).toHaveBeenCalledTimes(1);
    expect(refreshOrdersAndHistory).toHaveBeenCalledWith(LOGIN, { skipHistory: true });
  });

  it('purges history on state_changed with entity "history" (state.<login> and rtx5.state.<broker>.<login>) without duplicate stream-recovered churn', () => {
    const invalidateSpy = vi.spyOn(terminalHistory, 'invalidateTerminalHistory');
    const stateEvents: CustomEvent[] = [];
    const recoveredEvents: Event[] = [];
    const onState = (e: Event) => stateEvents.push(e as CustomEvent);
    const onRecovered = (e: Event) => recoveredEvents.push(e);
    window.addEventListener('rtx:state-changed', onState);
    window.addEventListener('rtx:trade-stream-recovered', onRecovered);

    try {
      deliver(STATE_CHANNEL, {
        type: 'state_changed',
        entity: 'history',
        operation: 'DELETE',
        login: LOGIN,
        tickets: [5001],
      });
      // Bridged synthetic deals.<login> frame (as emitted by websocket-enhanced for state.<login>)
      deliver(`deals.${LOGIN}`, {
        type: 'state_changed',
        entity: 'history',
        operation: 'DELETE',
        login: LOGIN,
        tickets: [5001],
      });
      // Also test rtx5.state.<broker>.<login> form inside the same lead window
      deliver(`rtx5.state.test-broker.${LOGIN}`, {
        type: 'state_changed',
        data: { entity: 'history', operation: 'CANCEL', login: LOGIN, tickets: [5002] },
      });

      expect(invalidateSpy).toHaveBeenCalled();

      vi.advanceTimersByTime(HISTORY_PURGE_LEAD_MS);
      expect(refreshOrdersAndHistory).toHaveBeenCalledTimes(1);
      expect(refreshOrdersAndHistory).toHaveBeenCalledWith(LOGIN, { full: true });
      expect(recoveredEvents).toHaveLength(0);
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].detail).toMatchObject({
        entities: ['history'],
        login: LOGIN,
        historyPurgeScheduled: true,
      });
    } finally {
      window.removeEventListener('rtx:state-changed', onState);
      window.removeEventListener('rtx:trade-stream-recovered', onRecovered);
    }
  });

  it('coalesces a 1 s burst of delete and history invalidation events into at most one full history reload per 1 s', () => {
    const callTimes: number[] = [];
    refreshOrdersAndHistory.mockImplementation(async () => {
      callTimes.push(Date.now());
    });

    // 12 rapid history delete / state_changed frames over 300 ms
    for (let i = 0; i < 12; i += 1) {
      deliver(STATE_CHANNEL, {
        type: 'state_changed',
        entity: 'history',
        operation: 'DELETE',
        login: LOGIN,
        tickets: [6000 + i],
      });
      vi.advanceTimersByTime(25);
    }

    // First reload fired at +50 ms; all subsequent triggers inside the 1 s cooldown collapse into one trailing reload
    expect(callTimes).toHaveLength(1);

    vi.advanceTimersByTime(HISTORY_PURGE_COALESCE_MS + 100);
    expect(callTimes).toHaveLength(2);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(HISTORY_PURGE_COALESCE_MS);

    // No further reloads once burst ends
    vi.advanceTimersByTime(HISTORY_PURGE_COALESCE_MS * 3);
    expect(callTimes).toHaveLength(2);
  });
});
