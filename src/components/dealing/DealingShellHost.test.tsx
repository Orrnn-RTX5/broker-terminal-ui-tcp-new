import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionChangeReason } from '../../services/brokerSession';

const hostHarness = vi.hoisted(() => ({
  token: 'test-jwt-token',
  login: 200001,
  binaryEnabled: true,
  bindAccountSubCalls: [] as Array<{ login: number; token: string | null | undefined }>,
  streamListeners: new Set<(connected: boolean) => void>(),
  sessionListeners: new Set<(reason: SessionChangeReason) => void>(),
}));

vi.mock('../../services/binaryTcpOrderClient', () => ({
  BINARY_ORDER_ENDPOINT: '/__rtx5_binary_order',
  isBinaryTcpOrderEnabled: () => hostHarness.binaryEnabled,
  resolveBinaryOrderEndpoint: () => '/__rtx5_binary_order',
  bindBinaryTcpAccountSub: vi.fn(async (login: number, token?: string | null) => {
    hostHarness.bindAccountSubCalls.push({ login, token });
  }),
  getBinaryOrderRawFrameTransport: () => ({
    isEnabled: () => hostHarness.binaryEnabled,
    getAccessToken: () => hostHarness.token,
    getOpenWebSocket: () => null,
    ensureWebSocket: () => null,
    allocateWsReqId: () => 1,
    acquireActiveSlot: () => () => {},
    resolveHttpEndpoint: () => '/__rtx5_binary_order',
    fallbackHttpEndpoint: '/__rtx5_binary_order',
    markFastEndpointUnreachable: () => {},
    defaultTimeoutMs: 20_000,
    createOrderError: (
      message: string,
      opts: {
        status: number;
        code?: string;
        retryable?: boolean;
        clientOrderId?: string;
        execMicros?: number;
        action?: number;
        backendMessage?: string;
      },
    ) => Object.assign(new Error(message), opts),
  }),
}));

vi.mock('../../services/brokerSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/brokerSession')>();
  return {
    ...actual,
    getAccessToken: () => hostHarness.token,
    getAccountLogin: () => hostHarness.login,
    onSessionChange: (cb: (reason: SessionChangeReason) => void) => {
      hostHarness.sessionListeners.add(cb);
      return () => {
        hostHarness.sessionListeners.delete(cb);
      };
    },
  };
});

vi.mock('../../services/binaryTcpMarketStream', () => ({
  binaryTcpMarketStream: {
    onStateChange: (cb: (connected: boolean) => void) => {
      hostHarness.streamListeners.add(cb);
      cb(true);
      return () => {
        hostHarness.streamListeners.delete(cb);
      };
    },
  },
}));

import {
  MT_RET_REQUEST_CANCEL,
  MT_RET_REQUEST_DONE,
  WIRE_ACTION_DEALING_SYNC,
  WIRE_ACTION_REQUOTE_ACCEPT,
  WIRE_ACTION_REQUOTE_DECLINE,
  WIRE_STATUS_OK,
  decodeDealingSyncFrame,
  decodeRequoteActionFrame,
  encodeDealingSyncRespFrame,
  encodeOrderRespFrame,
} from '../../services/dealing/binaryDealingCodec';
import { ingestDealingEvent } from '../../services/dealing/dealingEvents';
import { DEALING_REASON_UI_STRINGS, DEALING_UI_STRINGS } from '../../services/dealing/dealingI18n';
import { createMockDealingUuid } from '../../services/dealing/dealingMock';
import { resetDealingSyncProbeState } from '../../services/dealing/dealingOrderClient';
import {
  __setDealingTransportSupportedForTests,
  isDealingWireGateOpen,
  notifyDealingAccountSubscribedHook,
  notifyDealingStreamDisconnectedHook,
  resetDealingCapabilityState,
  setDealingServerAdvertised,
} from '../../services/dealing/dealingRuntimeHooks';
import { DEALING_DECISION_SAFETY_GRACE_MS } from '../../hooks/useDealingRequest';
import { useAppStore } from '../../store/useAppStore';
import {
  DEALING_REPLAY_DEBOUNCE_MS,
  REQUOTE_SWEEP_HEAD_GRACE_MS,
  STALE_NON_TERMINAL_PRUNE_AFTER_MS,
  useDealingStore,
} from '../../store/useDealingStore';
import { useNotificationStore } from '../../store/useNotificationStore';
import { DealingShellHost } from './DealingShellHost';

describe('DealingShellHost & App.tsx shell integration', () => {
  beforeEach(() => {
    resetDealingCapabilityState();
    resetDealingSyncProbeState();
    useDealingStore.getState().reset();
    useNotificationStore.getState().clearAll();
    useAppStore.setState({ isAuthenticated: true, accountId: '200001' });
    hostHarness.token = 'test-jwt-token';
    hostHarness.login = 200001;
    hostHarness.binaryEnabled = true;
    hostHarness.bindAccountSubCalls = [];
    hostHarness.streamListeners.clear();
    hostHarness.sessionListeners.clear();
  });

  afterEach(() => {
    resetDealingCapabilityState();
    resetDealingSyncProbeState();
    useDealingStore.getState().reset();
    useNotificationStore.getState().clearAll();
    if (typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>).rtx5Electron;
      delete (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const emitStreamState = (connected: boolean) => {
    for (const cb of hostHarness.streamListeners) {
      cb(connected);
    }
  };

  const emitSessionReason = (reason: SessionChangeReason) => {
    for (const cb of hostHarness.sessionListeners) {
      cb(reason);
    }
  };

  it('mounts DealingStatusChip during in_dealing and RequoteDialog on requoted, sending 0x38 Action 9 over Binary TCP', async () => {
    const user = userEvent.setup();
    __setDealingTransportSupportedForTests(true);
    setDealingServerAdvertised(true);
    const reqId = createMockDealingUuid(0x01);
    const rqId = createMockDealingUuid(0x02);
    const now = Date.now();
    const sentFrames: Uint8Array[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const bytes = new Uint8Array(init?.body as ArrayBuffer);
        sentFrames.push(bytes);
        const resp = encodeOrderRespFrame({
          action: WIRE_ACTION_REQUOTE_ACCEPT,
          status: WIRE_STATUS_OK,
          orderTicket: 5001,
          fillPrice: 1.08495,
          symbol: 'EURUSD',
          clientOrderId: 'bo-host-1',
          execWire: { retcode: MT_RET_REQUEST_DONE, requestId: reqId, requoteId: rqId },
        });
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => resp.buffer.slice(resp.byteOffset, resp.byteOffset + resp.byteLength),
        };
      }),
    );

    render(<DealingShellHost accountId="200001" getAccountLogin={() => 200001} />);

    act(() => {
      ingestDealingEvent({
        requestId: reqId,
        clientOrderId: 'bo-host-1',
        accountLogin: 200001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1.0,
        digits: 5,
        price: 1.0845,
        phase: 'in_dealing',
        expiresAtMs: now + 10_000,
        serverNowMs: now,
      }, now);
    });

    const chip = screen.getByRole('status');
    expect(chip).toHaveTextContent(DEALING_UI_STRINGS.requestSentToDealer);

    act(() => {
      ingestDealingEvent({
        requestId: reqId,
        seq: 2,
        phase: 'requoted',
        requoteId: rqId,
        bid: 1.0848,
        ask: 1.08495,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
    });

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    const acceptBtn = screen.getByRole('button', { name: /Accept @ 1\.08495/ });
    await user.click(acceptBtn);

    expect(sentFrames).toHaveLength(1);
    const decoded = decodeRequoteActionFrame(sentFrames[0]);
    expect(decoded.action).toBe(WIRE_ACTION_REQUOTE_ACCEPT);
    expect(decoded.authToken).toBe('test-jwt-token');
    expect(decoded.extras.dealingRequestUuid).toBe(reqId);
    expect(decoded.extras.dealingRequoteUuid).toBe(rqId);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByTestId('dealing-status-tray')).toBeNull();
  });

  it('keeps DealingStatusChip visible with awaitingConfirmation after safety expiry and sends Action 10 on sweep, disconnect, and unload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    __setDealingTransportSupportedForTests(true);
    setDealingServerAdvertised(true);
    const now = Date.now();
    const sentActions: Array<{ action: number; requestId: string; keepalive: boolean }> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const bytes = new Uint8Array(init?.body as ArrayBuffer);
        if (bytes[1] === WIRE_ACTION_DEALING_SYNC) {
          const syncReq = decodeDealingSyncFrame(bytes);
          sentActions.push({
            action: syncReq.action,
            requestId: '',
            keepalive: Boolean(init?.keepalive),
          });
          const resp = encodeDealingSyncRespFrame({ dealingEnabled: true });
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => resp.buffer.slice(resp.byteOffset, resp.byteOffset + resp.byteLength),
          };
        }
        const decoded = decodeRequoteActionFrame(bytes);
        sentActions.push({
          action: decoded.action,
          requestId: decoded.extras.dealingRequestUuid,
          keepalive: Boolean(init?.keepalive),
        });
        const resp = encodeOrderRespFrame({
          action: decoded.action,
          status: WIRE_STATUS_OK,
          symbol: decoded.symbol,
          errorCode: 'CLIENT_DECLINED',
          execWire: {
            retcode: MT_RET_REQUEST_CANCEL,
            requestId: decoded.extras.dealingRequestUuid,
            requoteId: decoded.extras.dealingRequoteUuid,
          },
        });
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => resp.buffer.slice(resp.byteOffset, resp.byteOffset + resp.byteLength),
        };
      }),
    );

    render(<DealingShellHost accountId="200001" getAccountLogin={() => 200001} />);

    // 1. Background/non-head sweep sends Action 10 via registerDealingSweepDecline
    const reqHead = createMockDealingUuid(0x11);
    const reqTail = createMockDealingUuid(0x12);
    act(() => {
      ingestDealingEvent({
        requestId: reqHead,
        accountLogin: 200001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        digits: 5,
        phase: 'requoted',
        requoteId: createMockDealingUuid(0xa1),
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: now + 20_000,
        serverNowMs: now,
      }, now);
      ingestDealingEvent({
        requestId: reqTail,
        accountLogin: 200001,
        symbol: 'GBPUSD',
        side: 'sell',
        volume: 1,
        digits: 5,
        phase: 'requoted',
        requoteId: createMockDealingUuid(0xa2),
        bid: 1.254,
        ask: 1.2542,
        expiresAtMs: now + 2_000,
        serverNowMs: now,
      }, now);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000 + REQUOTE_SWEEP_HEAD_GRACE_MS);
    });
    expect(sentActions.some((s) => s.requestId === reqTail && s.action === WIRE_ACTION_REQUOTE_DECLINE)).toBe(true);

    // 2. Stream disconnect sends Action 10 for pending requote, closes RequoteDialog, and suppresses offline replay (R1 MINOR-4)
    act(() => {
      emitStreamState(false);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sentActions.some((s) => s.requestId === reqHead && s.action === WIRE_ACTION_REQUOTE_DECLINE)).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // 3. Offline debounce does NOT fire replay while disconnected; reconnect + 0x3B subscribe triggers Action 11 DealingSync
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEALING_REPLAY_DEBOUNCE_MS);
    });
    expect(hostHarness.bindAccountSubCalls).toHaveLength(0);
    expect(sentActions.some((s) => s.action === WIRE_ACTION_DEALING_SYNC)).toBe(false);

    await act(async () => {
      emitStreamState(true);
      notifyDealingAccountSubscribedHook(200001, 'test-jwt-token');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sentActions.some((s) => s.action === WIRE_ACTION_DEALING_SYNC)).toBe(true);
    expect(isDealingWireGateOpen()).toBe(true);

    // 4. Safety-timer synthetic expiry on hung Accepting closes modal and shows DealingStatusChip awaiting confirmation
    const reqHung = createMockDealingUuid(0x13);
    const rqHung = createMockDealingUuid(0x14);
    const tHung = Date.now();
    act(() => {
      ingestDealingEvent({
        requestId: reqHung,
        accountLogin: 200001,
        symbol: 'XAUUSD',
        side: 'buy',
        volume: 0.5,
        digits: 2,
        phase: 'requoted',
        requoteId: rqHung,
        bid: 2350.1,
        ask: 2350.5,
        expiresAtMs: tHung + 5_000,
        serverNowMs: tHung,
      }, tHung);
    });
    act(() => {
      useDealingStore.getState().markAccepting(reqHung, rqHung);
      ingestDealingEvent({
        requestId: reqHung,
        seq: 1,
        phase: 'expired',
        synthetic: true,
      }, tHung + 5_000 + DEALING_DECISION_SAFETY_GRACE_MS);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('dealing-status-tray')).toHaveTextContent(
      DEALING_UI_STRINGS.awaitingConfirmation,
    );

    // 5. pagehide + beforeunload fire keepalive Action 10 ONCE (deduplicated) for any queued requote
    const reqUnload = createMockDealingUuid(0x15);
    const tUnload = Date.now();
    act(() => {
      ingestDealingEvent({
        requestId: reqUnload,
        accountLogin: 200001,
        symbol: 'USDJPY',
        side: 'buy',
        volume: 1,
        digits: 3,
        phase: 'requoted',
        requoteId: createMockDealingUuid(0xa5),
        bid: 154.1,
        ask: 154.15,
        expiresAtMs: tUnload + 5_000,
        serverNowMs: tUnload,
      }, tUnload);
    });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('beforeunload'));
      await Promise.resolve();
    });
    const unloadDeclines = sentActions.filter((s) => s.requestId === reqUnload && s.keepalive);
    expect(unloadDeclines).toHaveLength(1);
    expect(unloadDeclines[0].action).toBe(WIRE_ACTION_REQUOTE_DECLINE);
  });

  it('shows ONE neutral unreconciled banner on 5m prune without duplicate toast and resets cleanly on logout / account switch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const now = Date.now();
    const reqId = createMockDealingUuid(0x21);

    const { rerender } = render(<DealingShellHost accountId="200001" getAccountLogin={() => 200001} />);

    act(() => {
      ingestDealingEvent({
        requestId: reqId,
        accountLogin: 200001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        phase: 'in_dealing',
        expiresAtMs: now + 10_000,
        serverNowMs: now,
      }, now);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000 + STALE_NON_TERMINAL_PRUNE_AFTER_MS);
    });

    expect(screen.getByTestId('dealing-unreconciled-banner')).toHaveTextContent(
      DEALING_UI_STRINGS.statusUnknownCheckHistory,
    );
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    act(() => {
      dismissBtn.click();
    });
    expect(screen.queryByTestId('dealing-unreconciled-banner')).toBeNull();

    // Account switch resets dealing store
    act(() => {
      ingestDealingEvent({
        requestId: createMockDealingUuid(0x22),
        accountLogin: 200001,
        symbol: 'GBPUSD',
        phase: 'in_dealing',
      });
    });
    rerender(<DealingShellHost accountId="200002" getAccountLogin={() => 200002} />);
    expect(Object.keys(useDealingStore.getState().requests)).toHaveLength(0);

    // Logout event resets dealing store
    act(() => {
      ingestDealingEvent({
        requestId: createMockDealingUuid(0x23),
        accountLogin: 200002,
        symbol: 'EURUSD',
        phase: 'in_dealing',
      });
      emitSessionReason('logout');
    });
    expect(Object.keys(useDealingStore.getState().requests)).toHaveLength(0);
  });

  it('handles HTTP 404/501 and gate-closed Decline cleanly without freezing RequoteDialog', async () => {
    const user = userEvent.setup();
    __setDealingTransportSupportedForTests(true);
    setDealingServerAdvertised(true);
    const reqId = createMockDealingUuid(0x41);
    const rqId = createMockDealingUuid(0x42);
    const reqId2 = createMockDealingUuid(0x43);
    const rqId2 = createMockDealingUuid(0x44);
    const now = Date.now();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 501,
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    render(<DealingShellHost accountId="200001" getAccountLogin={() => 200001} />);

    act(() => {
      ingestDealingEvent({
        requestId: reqId,
        accountLogin: 200001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        digits: 5,
        phase: 'requoted',
        requoteId: rqId,
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
    });

    await user.click(screen.getByRole('button', { name: /Accept @ 1\.08420/ }));
    expect(isDealingWireGateOpen()).toBe(false);
    expect(useDealingStore.getState().requests[reqId].phase).toBe('rejected');
    expect(useDealingStore.getState().requests[reqId].reasonCode).toBe('DEALING_NOT_ENABLED');
    expect(useDealingStore.getState().requests[reqId].reasonMessage).toBe(
      DEALING_REASON_UI_STRINGS.DEALING_NOT_ENABLED,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Gate-closed Decline must resolve cleanly to cancelled instead of freezing in declining
    act(() => {
      ingestDealingEvent({
        requestId: reqId2,
        accountLogin: 200001,
        symbol: 'GBPUSD',
        side: 'buy',
        volume: 1,
        digits: 5,
        phase: 'requoted',
        requoteId: rqId2,
        bid: 1.254,
        ask: 1.2542,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(useDealingStore.getState().requests[reqId2].phase).toBe('cancelled');
    expect(useDealingStore.getState().requests[reqId2].reasonCode).toBe('CLIENT_DECLINED');
    expect(useDealingStore.getState().requests[reqId2].reasonMessage).toBe(
      DEALING_REASON_UI_STRINGS.CLIENT_DECLINED,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('MAJOR-2: resolves binary 0x39 error replies (400/401/403/500/501/503/504) cleanly without freezing RequoteDialog', async () => {
    const user = userEvent.setup();
    const now = Date.now();
    let nextResp!: Uint8Array;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => nextResp.buffer.slice(nextResp.byteOffset, nextResp.byteOffset + nextResp.byteLength),
      })),
    );

    render(<DealingShellHost accountId="200001" getAccountLogin={() => 200001} />);

    // 1. Binary 0x39 501 DEALING_NOT_ENABLED on Accept -> closes gate, resolves rejected with i18n message, closes dialog
    __setDealingTransportSupportedForTests(true);
    setDealingServerAdvertised(true);
    const req501Acc = createMockDealingUuid(0x51);
    const rq501Acc = createMockDealingUuid(0x52);
    nextResp = encodeOrderRespFrame({
      action: WIRE_ACTION_REQUOTE_ACCEPT,
      status: 501,
      symbol: 'EURUSD',
      errorCode: 'DEALING_NOT_ENABLED',
      message: 'dealing not enabled',
      execWire: { retcode: 10006, requestId: req501Acc, requoteId: rq501Acc },
    });
    act(() => {
      ingestDealingEvent({
        requestId: req501Acc,
        accountLogin: 200001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        digits: 5,
        phase: 'requoted',
        requoteId: rq501Acc,
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
    });
    await user.click(screen.getByRole('button', { name: /Accept @ 1\.08420/ }));
    expect(isDealingWireGateOpen()).toBe(false);
    expect(useDealingStore.getState().requests[req501Acc].phase).toBe('rejected');
    expect(useDealingStore.getState().requests[req501Acc].reasonCode).toBe('DEALING_NOT_ENABLED');
    expect(useDealingStore.getState().requests[req501Acc].reasonMessage).toBe(
      DEALING_REASON_UI_STRINGS.DEALING_NOT_ENABLED,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // 2. Binary 0x39 501 on Decline (if invoked before gate closed) -> closes gate, resolves cancelled
    setDealingServerAdvertised(true);
    const req501Dec = createMockDealingUuid(0x53);
    const rq501Dec = createMockDealingUuid(0x54);
    nextResp = encodeOrderRespFrame({
      action: WIRE_ACTION_REQUOTE_DECLINE,
      status: 501,
      symbol: 'EURUSD',
      errorCode: 'DEALING_NOT_ENABLED',
      message: 'dealing not enabled',
      execWire: { retcode: 10006, requestId: req501Dec, requoteId: rq501Dec },
    });
    act(() => {
      ingestDealingEvent({
        requestId: req501Dec,
        accountLogin: 200001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        digits: 5,
        phase: 'requoted',
        requoteId: rq501Dec,
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
    });
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(isDealingWireGateOpen()).toBe(false);
    expect(useDealingStore.getState().requests[req501Dec].phase).toBe('cancelled');
    expect(useDealingStore.getState().requests[req501Dec].reasonCode).toBe('CLIENT_DECLINED');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // 3. Binary 0x39 504 BINARY_TCP_TIMEOUT -> closes modal & shows awaitingConfirmation chip
    setDealingServerAdvertised(true);
    const req504 = createMockDealingUuid(0x55);
    const rq504 = createMockDealingUuid(0x56);
    nextResp = encodeOrderRespFrame({
      action: WIRE_ACTION_REQUOTE_ACCEPT,
      status: 504,
      symbol: 'XAUUSD',
      errorCode: 'BINARY_TCP_TIMEOUT',
      message: 'context deadline exceeded',
      execWire: { retcode: 0, requestId: req504, requoteId: rq504 },
    });
    act(() => {
      ingestDealingEvent({
        requestId: req504,
        accountLogin: 200001,
        symbol: 'XAUUSD',
        side: 'buy',
        volume: 0.5,
        digits: 2,
        phase: 'requoted',
        requoteId: rq504,
        bid: 2350.1,
        ask: 2350.5,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
    });
    await user.click(screen.getByRole('button', { name: /Accept @ 2350\.50/ }));
    expect(useDealingStore.getState().requests[req504].phase).toBe('expired');
    expect(useDealingStore.getState().requests[req504].synthetic).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('dealing-status-tray')).toHaveTextContent(
      DEALING_UI_STRINGS.awaitingConfirmation,
    );
    act(() => {
      useDealingStore.getState().removeRequest(req504, now + 100);
    });

    // 4. Binary 0x39 400 / 401 / 403 / 500 / 503 all resolve cleanly on Accept & Decline
    const errCases = [
      { status: 400, code: 'INVALID_BINARY_ORDER', msg: 'bad frame' },
      { status: 401, code: 'UNAUTHORIZED', msg: 'expired jwt' },
      { status: 403, code: 'ACCOUNT_MISMATCH', msg: 'forbidden login' },
      { status: 500, code: 'INTERNAL_ERROR', msg: 'internal failure' },
      { status: 503, code: 'SERVICE_UNAVAILABLE', msg: 'backend unavailable' },
    ];
    for (let i = 0; i < errCases.length; i++) {
      const tc = errCases[i];
      const accReq = createMockDealingUuid(0x60 + i * 2);
      const accRq = createMockDealingUuid(0x70 + i * 2);
      nextResp = encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: tc.status,
        symbol: 'EURUSD',
        errorCode: tc.code,
        message: tc.msg,
        execWire: { retcode: 0, requestId: accReq, requoteId: accRq },
      });
      act(() => {
        ingestDealingEvent({
          requestId: accReq,
          accountLogin: 200001,
          symbol: 'EURUSD',
          side: 'buy',
          volume: 1,
          digits: 5,
          phase: 'requoted',
          requoteId: accRq,
          bid: 1.084,
          ask: 1.0842,
          expiresAtMs: now + 5_000,
          serverNowMs: now,
        }, now);
      });
      await user.click(screen.getByRole('button', { name: /Accept @ 1\.08420/ }));
      expect(useDealingStore.getState().requests[accReq].phase).toBe('rejected');
      expect(useDealingStore.getState().requests[accReq].reasonMessage).toBe(
        DEALING_REASON_UI_STRINGS.DEALER_REJECTED,
      );
      expect(screen.queryByRole('alertdialog')).toBeNull();

      const decReq = createMockDealingUuid(0x61 + i * 2);
      const decRq = createMockDealingUuid(0x71 + i * 2);
      nextResp = encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_DECLINE,
        status: tc.status,
        symbol: 'EURUSD',
        errorCode: tc.code,
        message: tc.msg,
        execWire: { retcode: 0, requestId: decReq, requoteId: decRq },
      });
      act(() => {
        ingestDealingEvent({
          requestId: decReq,
          accountLogin: 200001,
          symbol: 'EURUSD',
          side: 'buy',
          volume: 1,
          digits: 5,
          phase: 'requoted',
          requoteId: decRq,
          bid: 1.084,
          ask: 1.0842,
          expiresAtMs: now + 5_000,
          serverNowMs: now,
        }, now);
      });
      await user.click(screen.getByRole('button', { name: 'Decline' }));
      expect(useDealingStore.getState().requests[decReq].phase).toBe('cancelled');
      expect(useDealingStore.getState().requests[decReq].reasonMessage).toBe(
        DEALING_REASON_UI_STRINGS.CLIENT_DECLINED,
      );
      expect(screen.queryByRole('alertdialog')).toBeNull();
    }
  });

  it('MINOR-2: deduplicates Action 11 DealingSync per (connectionEpoch, accountLogin), allows retry after 401, and re-probes on reconnect', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    let syncStatus = 401;
    let syncCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        syncCalls++;
        const resp = syncStatus === 200
          ? encodeDealingSyncRespFrame({ status: WIRE_STATUS_OK, dealingEnabled: true })
          : encodeDealingSyncRespFrame({ status: syncStatus, errorCode: 'UNAUTHORIZED', message: 'expired' });
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => resp.buffer.slice(resp.byteOffset, resp.byteOffset + resp.byteLength),
        };
      }),
    );

    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'web-tcp' };
    (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = { DEALING_BRIDGE_V1: true };
    render(<DealingShellHost accountId="200001" getAccountLogin={() => 200001} />);

    // 1. First sub returns 401 -> dedupe key cleared so token refresh retry is allowed
    await act(async () => {
      notifyDealingAccountSubscribedHook(200001, 'expired-jwt');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(syncCalls).toBe(1);
    expect(isDealingWireGateOpen()).toBe(false);

    // Advance past 2s cooldown and refresh token on SAME connectionEpoch -> retries once and succeeds
    syncStatus = 200;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
      notifyDealingAccountSubscribedHook(200001, 'fresh-jwt-1');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(syncCalls).toBe(2);
    expect(isDealingWireGateOpen()).toBe(true);

    // 2. Periodic auth:token-updated re-bind on SAME connectionEpoch does NOT re-send Action 11
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      notifyDealingAccountSubscribedHook(200001, 'fresh-jwt-2');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(syncCalls).toBe(2);

    // 3. Disconnect + reconnect bumps connectionEpoch -> Action 11 sends once on new epoch
    await act(async () => {
      notifyDealingStreamDisconnectedHook();
      emitStreamState(false);
      await Promise.resolve();
    });
    expect(isDealingWireGateOpen()).toBe(false);

    await act(async () => {
      emitStreamState(true);
      notifyDealingAccountSubscribedHook(200001, 'fresh-jwt-2');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(syncCalls).toBe(3);
    expect(isDealingWireGateOpen()).toBe(true);
  });

  it('enforces D18 bridge policy: blocks desktop clientcore, and gates Action 11 DealingSync + TLV 0x2A behind web-tcp + DEALING_BRIDGE_V1', async () => {
    const sentSyncFrames: Uint8Array[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentSyncFrames.push(new Uint8Array(init?.body as ArrayBuffer));
      const resp = encodeDealingSyncRespFrame({ dealingEnabled: true });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => resp.buffer.slice(resp.byteOffset, resp.byteOffset + resp.byteLength),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    // 1. Desktop clientcore runtime must NEVER probe Action 11 or open the gate
    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'win32' };
    (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = { DEALING_BRIDGE_V1: true };
    render(<DealingShellHost accountId="200001" getAccountLogin={() => 200001} />);

    await act(async () => {
      notifyDealingAccountSubscribedHook(200001, 'test-jwt-token');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isDealingWireGateOpen()).toBe(false);

    // 2. Patched web-tcp bridge probes Action 11 after 0x3B subscribe and opens gate on TLV 0x2A = 1
    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'web-tcp' };
    await act(async () => {
      notifyDealingAccountSubscribedHook(200001, 'test-jwt-token');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sentSyncFrames).toHaveLength(1);
    const decodedSync = decodeDealingSyncFrame(sentSyncFrames[0]);
    expect(decodedSync.action).toBe(WIRE_ACTION_DEALING_SYNC);
    expect(decodedSync.accountLogin).toBe(200001);
    expect(decodedSync.authToken).toBe('test-jwt-token');
    expect(isDealingWireGateOpen()).toBe(true);
  });

  it('mounts DealingShellHost lazily in App.tsx with dealing markers and zero eager dialog imports', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(appSource).toContain('// dealing begin');
    expect(appSource).toContain("import('./components/dealing/DealingShellHost')");
    expect(appSource).toContain('{/* dealing begin */}');
    expect(appSource).toContain('<LazyDealingShellHost');
    expect(appSource).not.toContain("from './components/dealing/RequoteDialog'");
    expect(appSource).not.toContain("from './components/dealing/DealingStatusChip'");
  });

  it('MAJOR-1 & MINOR-3: handles binary 0x39 404 and local 502 tunnel/truncation errors without closing wireGateOpen', async () => {
    const user = userEvent.setup();
    const now = Date.now();
    type MockFetchReply = { ok: boolean; status: number; bytes: Uint8Array };
    let nextReply!: MockFetchReply;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: nextReply.ok,
        status: nextReply.status,
        arrayBuffer: async () =>
          nextReply.bytes.buffer.slice(nextReply.bytes.byteOffset, nextReply.bytes.byteOffset + nextReply.bytes.byteLength),
      })),
    );

    __setDealingTransportSupportedForTests(true);
    setDealingServerAdvertised(true);
    render(<DealingShellHost accountId="200001" getAccountLogin={() => 200001} />);

    // 1. Binary 0x39 404 DEALING_REQUEST_NOT_FOUND on Accept -> settles cancelled, closes modal, gate remains OPEN
    const req404Acc = createMockDealingUuid(0x81);
    const rq404Acc = createMockDealingUuid(0x82);
    nextReply = {
      ok: true,
      status: 200,
      bytes: encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: 404,
        symbol: 'EURUSD',
        errorCode: 'DEALING_REQUEST_NOT_FOUND',
        message: 'Dealing request not found',
        execWire: { retcode: 0, requestId: req404Acc, requoteId: rq404Acc },
      }),
    };
    act(() => {
      ingestDealingEvent({
        requestId: req404Acc,
        accountLogin: 200001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        digits: 5,
        phase: 'requoted',
        requoteId: rq404Acc,
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
    });
    await user.click(screen.getByRole('button', { name: /Accept @ 1\.08420/ }));
    expect(isDealingWireGateOpen()).toBe(true);
    expect(useDealingStore.getState().requests[req404Acc].phase).toBe('cancelled');
    expect(useDealingStore.getState().requests[req404Acc].reasonCode).toBe('DEALING_ALREADY_RESOLVED');
    expect(useDealingStore.getState().requests[req404Acc].reasonMessage).toBe(
      DEALING_REASON_UI_STRINGS.DEALING_ALREADY_RESOLVED,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // 2. Binary 0x39 404 DEALING_REQUEST_NOT_FOUND on Decline -> settles cancelled / CLIENT_DECLINED, gate remains OPEN
    const req404Dec = createMockDealingUuid(0x83);
    const rq404Dec = createMockDealingUuid(0x84);
    nextReply = {
      ok: true,
      status: 200,
      bytes: encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_DECLINE,
        status: 404,
        symbol: 'GBPUSD',
        errorCode: 'DEALING_REQUEST_NOT_FOUND',
        message: 'Dealing request not found',
        execWire: { retcode: 0, requestId: req404Dec, requoteId: rq404Dec },
      }),
    };
    act(() => {
      ingestDealingEvent({
        requestId: req404Dec,
        accountLogin: 200001,
        symbol: 'GBPUSD',
        side: 'buy',
        volume: 1,
        digits: 5,
        phase: 'requoted',
        requoteId: rq404Dec,
        bid: 1.254,
        ask: 1.2542,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
    });
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(isDealingWireGateOpen()).toBe(true);
    expect(useDealingStore.getState().requests[req404Dec].phase).toBe('cancelled');
    expect(useDealingStore.getState().requests[req404Dec].reasonCode).toBe('CLIENT_DECLINED');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // 3. Close-fill binary 0x39 404 MARGIN_RECHECK_FAILED -> settles rejected with MARGIN_RECHECK_FAILED, gate remains OPEN
    const req404Margin = createMockDealingUuid(0x85);
    const rq404Margin = createMockDealingUuid(0x86);
    nextReply = {
      ok: true,
      status: 200,
      bytes: encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: 404,
        symbol: 'EURUSD',
        errorCode: 'MARGIN_RECHECK_FAILED',
        message: 'Insufficient free margin',
        execWire: { retcode: 10019, requestId: req404Margin, requoteId: rq404Margin },
      }),
    };
    act(() => {
      ingestDealingEvent({
        requestId: req404Margin,
        accountLogin: 200001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        digits: 5,
        phase: 'requoted',
        requoteId: rq404Margin,
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
    });
    await user.click(screen.getByRole('button', { name: /Accept @ 1\.08420/ }));
    expect(isDealingWireGateOpen()).toBe(true);
    expect(useDealingStore.getState().requests[req404Margin].phase).toBe('rejected');
    expect(useDealingStore.getState().requests[req404Margin].reasonCode).toBe('MARGIN_RECHECK_FAILED');
    expect(useDealingStore.getState().requests[req404Margin].reasonMessage).toBe(
      DEALING_REASON_UI_STRINGS.MARGIN_RECHECK_FAILED,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // 4. Truncated HTTP 200 reply (< 136B) -> settles as synthetic unknown awaitingConfirmation, reconciled by late filled
    const reqTrunc = createMockDealingUuid(0x87);
    const rqTrunc = createMockDealingUuid(0x88);
    nextReply = {
      ok: true,
      status: 200,
      bytes: new Uint8Array([1, WIRE_ACTION_REQUOTE_ACCEPT, 200, 0]),
    };
    act(() => {
      ingestDealingEvent({
        requestId: reqTrunc,
        accountLogin: 200001,
        symbol: 'XAUUSD',
        side: 'buy',
        volume: 0.5,
        digits: 2,
        phase: 'requoted',
        requoteId: rqTrunc,
        bid: 2350.1,
        ask: 2350.5,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
    });
    await user.click(screen.getByRole('button', { name: /Accept @ 2350\.50/ }));
    expect(isDealingWireGateOpen()).toBe(true);
    expect(useDealingStore.getState().requests[reqTrunc].phase).toBe('expired');
    expect(useDealingStore.getState().requests[reqTrunc].synthetic).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('dealing-status-tray')).toHaveTextContent(
      DEALING_UI_STRINGS.awaitingConfirmation,
    );
    act(() => {
      ingestDealingEvent({
        requestId: reqTrunc,
        seq: 3,
        phase: 'filled',
        orderTicket: 8899,
        price: 2350.5,
      });
    });
    expect(useDealingStore.getState().requests[reqTrunc].phase).toBe('filled');
    expect(useDealingStore.getState().requests[reqTrunc].synthetic).toBe(false);

    // 5. Non-binary HTTP 502 (BINARY_TUNNEL_UNAVAILABLE) -> reverts to requoted for retry (not rejected), gate stays OPEN
    const req502 = createMockDealingUuid(0x89);
    const rq502 = createMockDealingUuid(0x8a);
    nextReply = {
      ok: false,
      status: 502,
      bytes: new TextEncoder().encode('Bad Gateway'),
    };
    act(() => {
      ingestDealingEvent({
        requestId: req502,
        accountLogin: 200001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        digits: 5,
        phase: 'requoted',
        requoteId: rq502,
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
    });
    await user.click(screen.getByRole('button', { name: /Accept @ 1\.08420/ }));
    expect(isDealingWireGateOpen()).toBe(true);
    expect(useDealingStore.getState().requests[req502].phase).toBe('requoted');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accept @ 1\.08420/ })).toBeEnabled();
  });
});
