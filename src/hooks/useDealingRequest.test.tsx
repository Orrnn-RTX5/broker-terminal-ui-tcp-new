import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MT_RET_REQUEST_CANCEL,
  MT_RET_REQUEST_DONE,
  MT_RET_REQUEST_INVALID_EXP,
  MT_RET_REQUEST_NO_MONEY,
  WIRE_ACTION_REQUOTE_ACCEPT,
  WIRE_ACTION_REQUOTE_DECLINE,
  WIRE_SIDE_BUY,
  WIRE_STATUS_CONFLICT,
  WIRE_STATUS_OK,
  WIRE_STATUS_REJECTED,
  decodeRequoteActionFrame,
  encodeOrderRespFrame,
} from '../services/dealing/binaryDealingCodec';
import {
  getDealingCountdownTickerStats,
} from '../services/dealing/dealingCountdownTicker';
import {
  ingestDealingEvent,
  subscribeDealingTerminal,
  subscribeDealingUnreconciled,
} from '../services/dealing/dealingEvents';
import { DEALING_REASON_UI_STRINGS } from '../services/dealing/dealingI18n';
import { createMockDealingUuid } from '../services/dealing/dealingMock';
import {
  __setDealingTransportSupportedForTests,
  isDealingServerAdvertised,
  isDealingWireGateOpen,
  resetDealingCapabilityState,
  setDealingServerAdvertised,
} from '../services/dealing/dealingRuntimeHooks';
import { useDealingStore } from '../store/useDealingStore';
import {
  AUTO_DECLINE_HEAD_GRACE_MS,
  AUTO_DECLINE_RETRY_DELAY_MS,
  DEALING_DECISION_SAFETY_GRACE_MS,
  isDealingTransportTimeoutError,
  useActiveRequoteId,
  useDealingRequest,
  type RequoteDecisionTransport,
} from './useDealingRequest';

describe('useDealingRequest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    useDealingStore.getState().reset();
  });

  afterEach(() => {
    useDealingStore.getState().reset();
    vi.useRealTimers();
  });

  it('sends valid 0x38 Action 9 binary frame on accept() and settles on 200 response', async () => {
    const reqId = createMockDealingUuid(0x01);
    const rqId = createMockDealingUuid(0x02);
    const now = Date.now();

    ingestDealingEvent({
      requestId: reqId,
      clientOrderId: 'bo-hook-1',
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      wireSide: WIRE_SIDE_BUY,
      volume: 2.5,
      digits: 5,
      bid: 1.0845,
      ask: 1.08465,
      phase: 'requoted',
      requoteId: rqId,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    const transport = vi.fn<RequoteDecisionTransport>((frame) => {
      const decoded = decodeRequoteActionFrame(frame);
      expect(decoded.action).toBe(WIRE_ACTION_REQUOTE_ACCEPT);
      expect(decoded.ticket).toBe(0);
      expect(decoded.expiration).toBe(0);
      expect(decoded.price).toBe(1.08465);
      expect(decoded.extras.dealingRequestUuid).toBe(reqId);
      expect(decoded.extras.dealingRequoteUuid).toBe(rqId);
      expect(decoded.extras.hasDealingCap).toBe(true);

      return encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: WIRE_STATUS_OK,
        orderTicket: 8801,
        positionTicket: 8801,
        dealTicket: 8802,
        fillPrice: 1.08465,
        volume: 2.5,
        symbol: 'EURUSD',
        clientOrderId: 'bo-hook-1',
        execWire: {
          retcode: MT_RET_REQUEST_DONE,
          quotedReqId: 0,
          requestId: reqId,
          requoteId: rqId,
        },
      });
    });

    const { result } = renderHook(() =>
      useDealingRequest({
        clientOrderId: 'bo-hook-1',
        sendRequoteFrame: transport,
        authToken: 'jwt-test',
      }),
    );

    expect(result.current.isRequoted).toBe(true);
    expect(result.current.remainingSeconds).toBe(5);

    await act(async () => {
      const ok = await result.current.accept({ requoteId: rqId, price: 1.08465 });
      expect(ok).toBe(true);
    });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('filled');
    expect(result.current.isTerminal).toBe(true);
    expect(result.current.request?.orderTicket).toBe(8801);
  });

  it('tracks server-clock-skewed countdown and auto-declines once at 0 via Action 10', async () => {
    const reqId = createMockDealingUuid(0x03);
    const rqId = createMockDealingUuid(0x04);
    const localNow = Date.now();
    // Server clock is +60s ahead of device clock; window is still 5s!
    const serverNow = localNow + 60_000;

    ingestDealingEvent({
      requestId: reqId,
      clientOrderId: 'bo-skew',
      accountLogin: 100042,
      symbol: 'GBPUSD',
      side: 'sell',
      volume: 1.0,
      digits: 5,
      bid: 1.254,
      ask: 1.2542,
      phase: 'requoted',
      requoteId: rqId,
      expiresAtMs: serverNow + 5_000,
      serverNowMs: serverNow,
    }, localNow);

    const transport = vi.fn<RequoteDecisionTransport>((frame) => {
      const decoded = decodeRequoteActionFrame(frame);
      expect(decoded.action).toBe(WIRE_ACTION_REQUOTE_DECLINE);
      expect(decoded.price).toBe(0);
      expect(decoded.ticket).toBe(0);
      expect(decoded.expiration).toBe(0);

      return encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_DECLINE,
        status: WIRE_STATUS_OK,
        symbol: 'GBPUSD',
        clientOrderId: 'bo-skew',
        errorCode: 'CLIENT_DECLINED',
        execWire: {
          retcode: MT_RET_REQUEST_CANCEL,
          requestId: reqId,
          requoteId: rqId,
        },
      });
    });

    const { result } = renderHook(() =>
      useDealingRequest({
        symbol: 'GBPUSD',
        sendRequoteFrame: transport,
      }),
    );

    expect(result.current.remainingSeconds).toBe(5);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.remainingSeconds).toBe(2);
    expect(transport).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(useDealingStore.getState().requests[reqId].phase).toBe('cancelled');
    // Symbol-based active lookup clears automatically once the order reaches terminal state.
    expect(result.current.phase).toBeNull();
  });

  it('handles 409 REQUOTE_EXPIRED and 422 MARGIN_RECHECK_FAILED 0x39 replies cleanly', async () => {
    const req1 = createMockDealingUuid(0x05);
    const rq1 = createMockDealingUuid(0x06);
    const req2 = createMockDealingUuid(0x07);
    const rq2 = createMockDealingUuid(0x08);
    const now = Date.now();

    ingestDealingEvent({
      requestId: req1,
      accountLogin: 1001,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      bid: 1.1,
      ask: 1.1002,
      phase: 'requoted',
      requoteId: rq1,
      expiresAtMs: now + 5000,
      serverNowMs: now,
    }, now);

    const expiredReply = encodeOrderRespFrame({
      action: WIRE_ACTION_REQUOTE_ACCEPT,
      status: WIRE_STATUS_CONFLICT,
      symbol: 'EURUSD',
      errorCode: 'REQUOTE_EXPIRED',
      message: 'Requote window expired',
      execWire: { retcode: MT_RET_REQUEST_INVALID_EXP, requestId: req1, requoteId: rq1 },
    });

    const { result: r1 } = renderHook(() =>
      useDealingRequest({
        requestId: req1,
        sendRequoteFrame: () => expiredReply,
      }),
    );

    await act(async () => {
      await r1.current.accept({ requoteId: rq1, price: 1.1002 });
    });
    expect(r1.current.phase).toBe('expired');
    expect(r1.current.isCountdownExpired).toBe(true);
    expect(r1.current.request?.reasonCode).toBe('REQUOTE_EXPIRED');

    ingestDealingEvent({
      requestId: req2,
      accountLogin: 1001,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 50,
      bid: 1.1,
      ask: 1.1002,
      phase: 'requoted',
      requoteId: rq2,
      expiresAtMs: now + 5000,
      serverNowMs: now,
    }, now);

    const noMoneyReply = encodeOrderRespFrame({
      action: WIRE_ACTION_REQUOTE_ACCEPT,
      status: WIRE_STATUS_REJECTED,
      symbol: 'EURUSD',
      errorCode: 'MARGIN_RECHECK_FAILED',
      message: 'Insufficient free margin at execution confirmation',
      execWire: { retcode: MT_RET_REQUEST_NO_MONEY, requestId: req2, requoteId: rq2 },
    });

    const { result: r2 } = renderHook(() =>
      useDealingRequest({
        requestId: req2,
        sendRequoteFrame: () => noMoneyReply,
      }),
    );

    await act(async () => {
      await r2.current.accept({ requoteId: rq2, price: 1.1002 });
    });
    expect(r2.current.phase).toBe('rejected');
    expect(r2.current.request?.reasonCode).toBe('MARGIN_RECHECK_FAILED');
  });

  it('guards accept() against missing transport/accountLogin, uses injected getAccountLogin, blocks decline() while accepting, and triggers +2s safety timer', async () => {
    const reqNoTx = createMockDealingUuid(0x09);
    const rqNoTx = createMockDealingUuid(0x0a);
    const now = Date.now();

    ingestDealingEvent({
      requestId: reqNoTx,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      bid: 1.1,
      ask: 1.1003,
      phase: 'requoted',
      requoteId: rqNoTx,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    // 1. No sendRequoteFrame -> accept() returns false BEFORE markAccepting
    const { result: noTxHook, unmount: unmountNoTx } = renderHook(() =>
      useDealingRequest({ requestId: reqNoTx, autoDeclineOnExpire: false }),
    );
    await act(async () => {
      expect(await noTxHook.current.accept({ requoteId: rqNoTx, price: 1.1003 })).toBe(false);
    });
    expect(noTxHook.current.phase).toBe('requoted');
    unmountNoTx();

    // 2. Missing accountLogin (<= 0) without session getter -> returns false BEFORE markAccepting
    const reqNoLogin = createMockDealingUuid(0x0b);
    const rqNoLogin = createMockDealingUuid(0x0c);
    ingestDealingEvent({
      requestId: reqNoLogin,
      accountLogin: 0,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      bid: 1.1,
      ask: 1.1003,
      phase: 'requoted',
      requoteId: rqNoLogin,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    const noLoginTx = vi.fn<RequoteDecisionTransport>();
    const { result: noLoginHook, unmount: unmountNoLogin } = renderHook(() =>
      useDealingRequest({
        requestId: reqNoLogin,
        sendRequoteFrame: noLoginTx,
        autoDeclineOnExpire: false,
      }),
    );
    await act(async () => {
      expect(await noLoginHook.current.accept({ requoteId: rqNoLogin, price: 1.1003 })).toBe(false);
    });
    expect(noLoginTx).not.toHaveBeenCalled();
    expect(noLoginHook.current.phase).toBe('requoted');
    unmountNoLogin();
    act(() => {
      useDealingStore.getState().dismissRequote(reqNoTx);
    });

    // 3. Injected getAccountLogin() resolves login, scalar override is rejected, decline() is blocked during accepting, and +2s safety timer expires stuck accept
    const hungTx = vi.fn<RequoteDecisionTransport>((frame) => {
      const decoded = decodeRequoteActionFrame(frame);
      expect(decoded.accountLogin).toBe(555777);
      expect(decoded.price).toBe(1.1003);
      return new Promise<void>(() => {});
    });
    const { result: injectedHook } = renderHook(() =>
      useDealingRequest({
        requestId: reqNoLogin,
        sendRequoteFrame: hungTx,
        getAccountLogin: () => 555777,
        autoDeclineOnExpire: false,
      }),
    );

    let acceptPromise!: Promise<boolean>;
    await act(async () => {
      expect(await (injectedHook.current.accept as unknown as (p?: number) => Promise<boolean>)(9.999)).toBe(false);
      expect(hungTx).not.toHaveBeenCalled();
      acceptPromise = injectedHook.current.accept({ requoteId: rqNoLogin, price: 1.1003 });
      await Promise.resolve();
    });
    expect(injectedHook.current.phase).toBe('accepting');
    expect(hungTx).toHaveBeenCalledTimes(1);

    // Calling decline while accepting is blocked cleanly
    await act(async () => {
      expect(await injectedHook.current.decline()).toBe(false);
    });
    expect(hungTx).toHaveBeenCalledTimes(1);

    // Advance to expiresAtMs -> still waiting during 2s safety grace
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(injectedHook.current.phase).toBe('accepting');

    const terminalNotices: unknown[] = [];
    const unsub = subscribeDealingTerminal({ requestId: reqNoLogin }, (notice) => {
      terminalNotices.push(notice);
    });

    // Advance +2s safety grace -> marks client-synthesised expiry (no terminal notice) and closes requote queue
    await act(async () => {
      vi.advanceTimersByTime(DEALING_DECISION_SAFETY_GRACE_MS);
      await Promise.resolve();
    });
    expect(injectedHook.current.phase).toBe('expired');
    expect(injectedHook.current.request?.synthetic).toBe(true);
    expect(injectedHook.current.isSyntheticExpiry).toBe(true);
    expect(injectedHook.current.isTerminal).toBe(false);
    expect(useDealingStore.getState().activeRequoteId).toBeNull();
    expect(terminalNotices).toHaveLength(0);

    // Late authoritative filled overrides synthetic expiry and emits real terminal notice (M2)
    await act(async () => {
      ingestDealingEvent({
        requestId: reqNoLogin,
        seq: 3,
        phase: 'filled',
        orderTicket: 7788,
        positionTicket: 7788,
        dealTicket: 7789,
        price: 1.1003,
      });
      await Promise.resolve();
    });
    expect(injectedHook.current.phase).toBe('filled');
    expect(injectedHook.current.request?.synthetic).toBe(false);
    expect(injectedHook.current.isSyntheticExpiry).toBe(false);
    expect(injectedHook.current.isTerminal).toBe(true);
    expect(terminalNotices).toHaveLength(1);
    unsub();
    void acceptPromise;
  });

  it('uses a single shared countdown ticker across multiple hooks and pauses while document is hidden', () => {
    const now = Date.now();
    const id1 = createMockDealingUuid(0x0d);
    const id2 = createMockDealingUuid(0x0e);

    ingestDealingEvent({
      requestId: id1,
      accountLogin: 1001,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      phase: 'in_dealing',
      expiresAtMs: now + 10_000,
      serverNowMs: now,
    }, now);
    ingestDealingEvent({
      requestId: id2,
      accountLogin: 1001,
      symbol: 'GBPUSD',
      side: 'sell',
      volume: 1,
      phase: 'in_dealing',
      expiresAtMs: now + 8_000,
      serverNowMs: now,
    }, now);

    const h1 = renderHook(() => useDealingRequest({ requestId: id1 }));
    const timersAfterOne = vi.getTimerCount();
    const h2 = renderHook(() => useDealingRequest({ requestId: id2 }));
    const h3 = renderHook(() => useDealingRequest({ requestId: id2 }));

    expect(getDealingCountdownTickerStats()).toEqual({
      listenerCount: 3,
      intervalActive: true,
    });
    // Additional hooks add zero extra interval timers
    expect(vi.getTimerCount()).toBe(timersAfterOne);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(h1.result.current.remainingSeconds).toBe(8);
    expect(h2.result.current.remainingSeconds).toBe(6);

    // Simulate background tab visibility pause & restore
    const visSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(getDealingCountdownTickerStats().intervalActive).toBe(false);

    visSpy.mockReturnValue('visible');
    act(() => {
      vi.advanceTimersByTime(2_000);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(getDealingCountdownTickerStats().intervalActive).toBe(true);
    expect(h1.result.current.remainingSeconds).toBe(6);
    expect(h3.result.current.remainingSeconds).toBe(4);
    visSpy.mockRestore();
  });

  it('N3: retries auto-decline once after AUTO_DECLINE_RETRY_DELAY_MS and marks expired synthetic if retry fails', async () => {
    const req1 = createMockDealingUuid(0x81);
    const rq1 = createMockDealingUuid(0x82);
    const now1 = Date.now();

    ingestDealingEvent({
      requestId: req1,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rq1,
      expiresAtMs: now1 + 3_000,
      serverNowMs: now1,
    }, now1);

    const retryOkTx = vi
      .fn<RequoteDecisionTransport>()
      .mockRejectedValueOnce(new Error('transient socket err'))
      .mockResolvedValueOnce(
        encodeOrderRespFrame({
          action: WIRE_ACTION_REQUOTE_DECLINE,
          status: WIRE_STATUS_OK,
          symbol: 'EURUSD',
          errorCode: 'CLIENT_DECLINED',
          execWire: {
            retcode: MT_RET_REQUEST_CANCEL,
            requestId: req1,
            requoteId: rq1,
          },
        }),
      );

    const { unmount } = renderHook(() =>
      useDealingRequest({
        requestId: req1,
        autoDeclineOnExpire: true,
        sendRequoteFrame: retryOkTx,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_050);
    });
    expect(retryOkTx).toHaveBeenCalledTimes(1);
    expect(useDealingStore.getState().requests[req1]?.phase).toBe('requoted');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_DECLINE_RETRY_DELAY_MS + 10);
    });
    expect(retryOkTx).toHaveBeenCalledTimes(2);
    expect(useDealingStore.getState().requests[req1]?.phase).toBe('cancelled');
    expect(useDealingStore.getState().requests[req1]?.synthetic).toBe(false);
    unmount();

    useDealingStore.getState().reset();
    const req2 = createMockDealingUuid(0x83);
    const rq2 = createMockDealingUuid(0x84);
    const now2 = Date.now();
    ingestDealingEvent({
      requestId: req2,
      accountLogin: 100042,
      symbol: 'GBPUSD',
      side: 'sell',
      volume: 1,
      digits: 5,
      bid: 1.254,
      ask: 1.2542,
      phase: 'requoted',
      requoteId: rq2,
      expiresAtMs: now2 + 3_000,
      serverNowMs: now2,
    }, now2);

    const alwaysFailTx = vi
      .fn<RequoteDecisionTransport>()
      .mockRejectedValue(new Error('persistent socket err'));

    renderHook(() =>
      useDealingRequest({
        requestId: req2,
        autoDeclineOnExpire: true,
        sendRequoteFrame: alwaysFailTx,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_050);
    });
    expect(alwaysFailTx).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_DECLINE_RETRY_DELAY_MS + 10);
    });
    expect(alwaysFailTx).toHaveBeenCalledTimes(2);
    expect(useDealingStore.getState().requests[req2]?.phase).toBe('expired');
    expect(useDealingStore.getState().requests[req2]?.synthetic).toBe(true);
  });

  it('N3: useActiveRequoteId skips expired head past grace period so queued requotes unblock', () => {
    const req1 = createMockDealingUuid(0x85);
    const rq1 = createMockDealingUuid(0x86);
    const req2 = createMockDealingUuid(0x87);
    const rq2 = createMockDealingUuid(0x88);
    const now = Date.now();

    ingestDealingEvent({
      requestId: req1,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rq1,
      expiresAtMs: now + 2_000,
      serverNowMs: now,
    }, now);
    ingestDealingEvent({
      requestId: req2,
      accountLogin: 100042,
      symbol: 'USDJPY',
      side: 'sell',
      volume: 1,
      digits: 3,
      bid: 154.1,
      ask: 154.2,
      phase: 'requoted',
      requoteId: rq2,
      expiresAtMs: now + 15_000,
      serverNowMs: now,
    }, now);

    const { result } = renderHook(() =>
      useActiveRequoteId({ autoDeclineGraceMs: AUTO_DECLINE_HEAD_GRACE_MS }),
    );
    expect(result.current).toBe(req1);

    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    expect(result.current).toBe(req1);

    act(() => {
      vi.advanceTimersByTime(AUTO_DECLINE_HEAD_GRACE_MS);
    });
    expect(result.current).toBe(req2);
  });

  it('M1/m8: enforces 2s safety floor from NOW on tab wake 6 min after expiry so late reply yields exactly ONE notice', async () => {
    const reqId = createMockDealingUuid(0x91);
    const rqId = createMockDealingUuid(0x92);
    const t0 = Date.now();

    const terminalNotices: string[] = [];
    const unreconciledNotices: string[] = [];
    const unsubTerm = subscribeDealingTerminal({ requestId: reqId }, (n) => terminalNotices.push(n.phase));
    const unsubUnrec = subscribeDealingUnreconciled((n) => unreconciledNotices.push(n.requestId));

    const visSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    ingestDealingEvent({
      requestId: reqId,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqId,
      expiresAtMs: t0 + 5_000,
      serverNowMs: t0,
    }, t0);

    let resolveDeclineReply!: (v: ReturnType<typeof encodeOrderRespFrame>) => void;
    const declineTx = vi.fn<RequoteDecisionTransport>(
      () => new Promise<ReturnType<typeof encodeOrderRespFrame>>((resolve) => {
        resolveDeclineReply = resolve;
      }),
    );

    renderHook(() =>
      useDealingRequest({
        requestId: reqId,
        autoDeclineOnExpire: true,
        sendRequoteFrame: declineTx,
      }),
    );

    // Tab sleeps 6 minutes past expiry, then wakes up -> auto-decline fires immediately
    visSpy.mockReturnValue('visible');
    const wakeMs = t0 + 6 * 60_000 + 5_000;
    await act(async () => {
      vi.setSystemTime(wakeMs);
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(declineTx).toHaveBeenCalledTimes(1);
    expect(useDealingStore.getState().requests[reqId]?.phase).toBe('declining');

    // Before 2s floor elapses (at +1,500 ms), safety timer has NOT flipped the record to synthetic
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(useDealingStore.getState().requests[reqId]?.phase).toBe('declining');
    expect(useDealingStore.getState().requests[reqId]?.synthetic).toBe(false);

    // Server reply arrives inside the 2s floor -> settles cancelled, ZERO unreconciled notices, ONE total notice
    await act(async () => {
      resolveDeclineReply(
        encodeOrderRespFrame({
          action: WIRE_ACTION_REQUOTE_DECLINE,
          status: WIRE_STATUS_OK,
          symbol: 'EURUSD',
          errorCode: 'CLIENT_DECLINED',
          execWire: { retcode: MT_RET_REQUEST_CANCEL, requestId: reqId, requoteId: rqId },
        }),
      );
      await Promise.resolve();
    });
    expect(useDealingStore.getState().requests[reqId]?.phase).toBe('cancelled');
    expect(terminalNotices).toEqual(['cancelled']);
    expect(unreconciledNotices).toEqual([]);

    visSpy.mockRestore();
    unsubTerm();
    unsubUnrec();
  });

  it('M2: stops the 100 ms countdown ticker in useActiveRequoteId once all queued requotes expire', () => {
    const reqId = createMockDealingUuid(0x93);
    const rqId = createMockDealingUuid(0x94);
    const now = Date.now();

    ingestDealingEvent({
      requestId: reqId,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqId,
      expiresAtMs: now + 2_000,
      serverNowMs: now,
    }, now);

    const { result, unmount } = renderHook(() => useActiveRequoteId({ autoDeclineGraceMs: 0 }));
    expect(result.current).toBe(reqId);
    expect(getDealingCountdownTickerStats().intervalActive).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    expect(result.current).toBeNull();
    expect(getDealingCountdownTickerStats().intervalActive).toBe(false);
    expect(getDealingCountdownTickerStats().listenerCount).toBe(0);
    unmount();
  });

  it('m4: accept(expectedOffer) refuses mismatched requoteId/price or expired offer at send time', async () => {
    const reqId = createMockDealingUuid(0x95);
    const rqId = createMockDealingUuid(0x96);
    const wrongRqId = createMockDealingUuid(0x97);
    const now = Date.now();

    ingestDealingEvent({
      requestId: reqId,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqId,
      expiresAtMs: now + 3_000,
      serverNowMs: now,
    }, now);

    const acceptTx = vi.fn<RequoteDecisionTransport>((frame) => {
      const decoded = decodeRequoteActionFrame(frame);
      return encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: WIRE_STATUS_OK,
        orderTicket: 9931,
        fillPrice: decoded.price,
        symbol: 'EURUSD',
        execWire: { retcode: MT_RET_REQUEST_DONE, requestId: reqId, requoteId: rqId },
      });
    });

    const { result } = renderHook(() =>
      useDealingRequest({
        requestId: reqId,
        autoDeclineOnExpire: false,
        sendRequoteFrame: acceptTx,
      }),
    );

    await act(async () => {
      expect(await (result.current.accept as unknown as () => Promise<boolean>)()).toBe(false);
      expect(await result.current.accept({ requoteId: wrongRqId, price: 1.0842 })).toBe(false);
      expect(await result.current.accept({ requoteId: rqId, price: 1.0899 })).toBe(false);
    });
    expect(acceptTx).not.toHaveBeenCalled();

    // Advance just past expiresAtMs BEFORE ticker updates component, expect send-time expiry guard to refuse
    vi.setSystemTime(now + 3_005);
    await act(async () => {
      expect(await result.current.accept({ requoteId: rqId, price: 1.0842 })).toBe(false);
    });
    expect(acceptTx).not.toHaveBeenCalled();

    // Fresh non-expired matching offer succeeds and sends exact requoteId + price
    vi.setSystemTime(now + 3_100);
    const rq2 = createMockDealingUuid(0x98);
    ingestDealingEvent({
      requestId: reqId,
      seq: 3,
      phase: 'requoted',
      requoteId: rq2,
      bid: 1.085,
      ask: 1.0853,
      expiresAtMs: now + 8_100,
      serverNowMs: now + 3_100,
    }, now + 3_100);

    await act(async () => {
      expect(await result.current.accept({ requoteId: rq2, price: 1.0853 })).toBe(true);
    });
    expect(acceptTx).toHaveBeenCalledTimes(1);
    const sent = decodeRequoteActionFrame(acceptTx.mock.calls[0][0]);
    expect(sent.extras.dealingRequoteUuid).toBe(rq2);
    expect(sent.price).toBe(1.0853);
  });

  it('Item 6: keeps awaiting-confirmation state on timeout error while reverting non-timeout errors to allow idempotent retry', async () => {
    const reqTimeout = createMockDealingUuid(0xa1);
    const rqTimeout = createMockDealingUuid(0xa2);
    const now = Date.now();

    ingestDealingEvent({
      requestId: reqTimeout,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqTimeout,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    // Non-timeout error reverts cleanly so Accept is re-enabled for the same requoteId (contract §9.4),
    // whereas timeout error keeps synthetic awaiting-confirmation state (Accept disabled).
    const timeoutErr = Object.assign(new Error('Order request timed out'), { name: 'TimeoutError' });
    const flakeyTx = vi
      .fn<RequoteDecisionTransport>()
      .mockRejectedValueOnce(new Error('socket write reset'))
      .mockRejectedValueOnce(timeoutErr);

    const { result } = renderHook(() =>
      useDealingRequest({
        requestId: reqTimeout,
        autoDeclineOnExpire: false,
        sendRequoteFrame: flakeyTx,
      }),
    );

    // 1. Non-timeout throw -> reverts back to `requoted` so Accept can retry same requoteId
    await act(async () => {
      await expect(
        result.current.accept({ requoteId: rqTimeout, price: 1.0842 }),
      ).rejects.toThrow('socket write reset');
    });
    expect(result.current.phase).toBe('requoted');
    expect(result.current.isSyntheticExpiry).toBe(false);

    // 2. Timeout throw on retry -> transitions to synthetic awaiting-confirmation, NOT `requoted`
    await act(async () => {
      await expect(
        result.current.accept({ requoteId: rqTimeout, price: 1.0842 }),
      ).rejects.toThrow('Order request timed out');
    });
    expect(result.current.phase).toBe('expired');
    expect(result.current.isSyntheticExpiry).toBe(true);
    expect(useDealingStore.getState().requests[reqTimeout]?.synthetic).toBe(true);

    // Accept cannot fire again once in synthetic awaiting-confirmation
    await act(async () => {
      expect(await result.current.accept({ requoteId: rqTimeout, price: 1.0842 })).toBe(false);
    });
    expect(flakeyTx).toHaveBeenCalledTimes(2);

    // Late authoritative server filled reconciles over synthetic state cleanly
    act(() => {
      ingestDealingEvent({
        requestId: reqTimeout,
        seq: 3,
        phase: 'filled',
        orderTicket: 9944,
        price: 1.0842,
      });
    });
    expect(useDealingStore.getState().requests[reqTimeout]?.phase).toBe('filled');
    expect(useDealingStore.getState().requests[reqTimeout]?.synthetic).toBe(false);
  });

  it('does not re-render useActiveRequoteId subscribers when 50 unrelated in_dealing requests update (R1 MAJOR-1)', () => {
    let renderCount = 0;
    const Probe = () => {
      renderCount++;
      const activeId = useActiveRequoteId();
      return <div data-testid="probe">{activeId ?? 'none'}</div>;
    };

    const reqHead = createMockDealingUuid(0x10);
    act(() => {
      ingestDealingEvent({
        requestId: reqHead,
        clientOrderId: 'bo-head',
        accountLogin: 1001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 0.1,
        phase: 'requoted',
        requoteId: createMockDealingUuid(0x11),
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: Date.now() + 10_000,
        serverNowMs: Date.now(),
      });
    });

    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe(reqHead);
    const baselineRenders = renderCount;

    act(() => {
      for (let i = 0; i < 50; i++) {
        ingestDealingEvent({
          requestId: createMockDealingUuid(0x30 + i),
          clientOrderId: `bo-bg-${i}`,
          accountLogin: 1001,
          symbol: 'GBPUSD',
          side: 'buy',
          volume: 0.1,
          phase: 'in_dealing',
          expiresAtMs: Date.now() + 10_000,
          serverNowMs: Date.now(),
        });
      }
    });

    expect(renderCount).toBe(baselineRenders);
  });

  it('MAJOR-2: resolves undefined Decline, 0x39 error statuses (400/401/403/500/501/503/504), and server error throws cleanly with i18n messages', async () => {
    resetDealingCapabilityState();
    __setDealingTransportSupportedForTests(true);
    setDealingServerAdvertised(true);
    const now = Date.now();

    // 1. Timeout detector recognizes status=504, BINARY_TCP_TIMEOUT, GATEWAY_TIMEOUT, and context deadline exceeded
    expect(isDealingTransportTimeoutError({ status: 504, code: 'BINARY_TCP_TIMEOUT' })).toBe(true);
    expect(isDealingTransportTimeoutError({ code: 'GATEWAY_TIMEOUT' })).toBe(true);
    expect(isDealingTransportTimeoutError(new Error('context deadline exceeded'))).toBe(true);
    expect(isDealingTransportTimeoutError({ status: 503, code: 'BINARY_TRANSPORT_UNREACHABLE' })).toBe(false);

    // 2. Gate-closed / void Decline resolves cleanly to cancelled (never stuck in 'declining')
    const reqVoidDec = createMockDealingUuid(0xb0);
    const rqVoidDec = createMockDealingUuid(0xb1);
    ingestDealingEvent({
      requestId: reqVoidDec,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqVoidDec,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    const voidHook = renderHook(() =>
      useDealingRequest({
        requestId: reqVoidDec,
        autoDeclineOnExpire: false,
        sendRequoteFrame: async () => undefined,
      }),
    );
    await act(async () => {
      expect(await voidHook.result.current.decline()).toBe(true);
    });
    expect(voidHook.result.current.phase).toBe('cancelled');
    expect(useDealingStore.getState().requests[reqVoidDec]?.reasonCode).toBe('CLIENT_DECLINED');
    expect(useDealingStore.getState().requests[reqVoidDec]?.reasonMessage).toBe(
      DEALING_REASON_UI_STRINGS.CLIENT_DECLINED,
    );
    voidHook.unmount();

    // 3. Raw 0x39 error frames returned directly from custom sendRequoteFrame (400/401/403/500/501/503/504)
    const rawCases: Array<{
      status: number;
      code: string;
      msg: string;
      expectedPhase: 'rejected' | 'expired';
      expectedSyn: boolean;
      expectedMsg: string;
    }> = [
      {
        status: 400,
        code: 'INVALID_BINARY_ORDER',
        msg: 'bad raw req',
        expectedPhase: 'rejected',
        expectedSyn: false,
        expectedMsg: DEALING_REASON_UI_STRINGS.DEALER_REJECTED,
      },
      {
        status: 401,
        code: 'UNAUTHORIZED',
        msg: 'jwt expired',
        expectedPhase: 'rejected',
        expectedSyn: false,
        expectedMsg: DEALING_REASON_UI_STRINGS.DEALER_REJECTED,
      },
      {
        status: 403,
        code: 'ACCOUNT_MISMATCH',
        msg: 'account mismatch',
        expectedPhase: 'rejected',
        expectedSyn: false,
        expectedMsg: DEALING_REASON_UI_STRINGS.DEALER_REJECTED,
      },
      {
        status: 500,
        code: 'INTERNAL_ERROR',
        msg: 'panic',
        expectedPhase: 'rejected',
        expectedSyn: false,
        expectedMsg: DEALING_REASON_UI_STRINGS.DEALER_REJECTED,
      },
      {
        status: 501,
        code: 'DEALING_NOT_ENABLED',
        msg: 'dealing not enabled',
        expectedPhase: 'rejected',
        expectedSyn: false,
        expectedMsg: DEALING_REASON_UI_STRINGS.DEALING_NOT_ENABLED,
      },
      {
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        msg: 'gateway busy',
        expectedPhase: 'rejected',
        expectedSyn: false,
        expectedMsg: DEALING_REASON_UI_STRINGS.DEALER_REJECTED,
      },
      {
        status: 504,
        code: 'BINARY_TCP_TIMEOUT',
        msg: 'context deadline exceeded',
        expectedPhase: 'expired',
        expectedSyn: true,
        expectedMsg: '',
      },
    ];

    for (let i = 0; i < rawCases.length; i++) {
      const tc = rawCases[i];
      setDealingServerAdvertised(true);
      const reqId = createMockDealingUuid(0xc0 + i * 2);
      const rqId = createMockDealingUuid(0xd0 + i * 2);
      ingestDealingEvent({
        requestId: reqId,
        accountLogin: 100042,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        digits: 5,
        bid: 1.084,
        ask: 1.0842,
        phase: 'requoted',
        requoteId: rqId,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
      const replyBytes = encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: tc.status,
        symbol: 'EURUSD',
        errorCode: tc.code,
        message: tc.msg,
        execWire: { retcode: tc.status === 501 ? 10006 : 0, requestId: reqId, requoteId: rqId },
      });
      const h = renderHook(() =>
        useDealingRequest({
          requestId: reqId,
          autoDeclineOnExpire: false,
          sendRequoteFrame: () => replyBytes,
        }),
      );
      await act(async () => {
        await h.result.current.accept({ requoteId: rqId, price: 1.0842 });
      });
      const stored = useDealingStore.getState().requests[reqId];
      expect(stored?.phase).toBe(tc.expectedPhase);
      expect(stored?.synthetic).toBe(tc.expectedSyn);
      expect(stored?.reasonMessage).toBe(tc.expectedMsg);
      if (tc.status === 501) {
        expect(isDealingServerAdvertised()).toBe(false);
      }
      h.unmount();
    }

    // 4. Thrown server HTTP/0x39 errors (401/501) resolve cleanly while local BINARY_TRANSPORT_UNREACHABLE reverts
    setDealingServerAdvertised(true);
    const reqErrThrow = createMockDealingUuid(0xe1);
    const rqErrThrow = createMockDealingUuid(0xe2);
    ingestDealingEvent({
      requestId: reqErrThrow,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqErrThrow,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    const errTx = vi
      .fn<RequoteDecisionTransport>()
      .mockRejectedValueOnce(
        Object.assign(new Error('socket closed'), { status: 503, code: 'BINARY_TRANSPORT_UNREACHABLE' }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('expired jwt'), { status: 401, code: 'UNAUTHORIZED' }),
      );
    const errHook = renderHook(() =>
      useDealingRequest({
        requestId: reqErrThrow,
        autoDeclineOnExpire: false,
        sendRequoteFrame: errTx,
      }),
    );

    await act(async () => {
      await expect(errHook.result.current.accept({ requoteId: rqErrThrow, price: 1.0842 })).rejects.toThrow(
        'socket closed',
      );
    });
    expect(errHook.result.current.phase).toBe('requoted');

    await act(async () => {
      await expect(errHook.result.current.accept({ requoteId: rqErrThrow, price: 1.0842 })).rejects.toThrow(
        'expired jwt',
      );
    });
    expect(errHook.result.current.phase).toBe('rejected');
    expect(useDealingStore.getState().requests[reqErrThrow]?.reasonMessage).toBe(
      DEALING_REASON_UI_STRINGS.DEALER_REJECTED,
    );
    errHook.unmount();
    resetDealingCapabilityState();
  });

  it('MAJOR-1: keeps dealing gate open on 404 DEALING_REQUEST_NOT_FOUND / close-fill 404 while non-binary HTTP 404 DEALING_NOT_ENABLED still closes it', async () => {
    resetDealingCapabilityState();
    __setDealingTransportSupportedForTests(true);
    setDealingServerAdvertised(true);
    const now = Date.now();

    // 1. Raw binary 0x39 404 DEALING_REQUEST_NOT_FOUND on Accept -> settles cancelled, gate remains open
    const reqRaw404Acc = createMockDealingUuid(0xe3);
    const rqRaw404Acc = createMockDealingUuid(0xe4);
    ingestDealingEvent({
      requestId: reqRaw404Acc,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqRaw404Acc,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);
    const raw404AccBytes = encodeOrderRespFrame({
      action: WIRE_ACTION_REQUOTE_ACCEPT,
      status: 404,
      symbol: 'EURUSD',
      errorCode: 'DEALING_REQUEST_NOT_FOUND',
      message: 'Dealing request not found',
      execWire: { retcode: 10006, requestId: reqRaw404Acc, requoteId: rqRaw404Acc },
    });
    const raw404AccHook = renderHook(() =>
      useDealingRequest({
        requestId: reqRaw404Acc,
        autoDeclineOnExpire: false,
        sendRequoteFrame: () => raw404AccBytes,
      }),
    );
    await act(async () => {
      await raw404AccHook.result.current.accept({ requoteId: rqRaw404Acc, price: 1.0842 });
    });
    expect(useDealingStore.getState().requests[reqRaw404Acc]?.phase).toBe('cancelled');
    expect(useDealingStore.getState().requests[reqRaw404Acc]?.reasonCode).toBe('DEALING_ALREADY_RESOLVED');
    expect(isDealingServerAdvertised()).toBe(true);
    expect(isDealingWireGateOpen()).toBe(true);
    raw404AccHook.unmount();

    // 2. Raw binary 0x39 404 DEALING_REQUEST_NOT_FOUND on Decline -> settles cancelled / CLIENT_DECLINED, gate remains open
    const reqRaw404Dec = createMockDealingUuid(0xe5);
    const rqRaw404Dec = createMockDealingUuid(0xe6);
    ingestDealingEvent({
      requestId: reqRaw404Dec,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqRaw404Dec,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);
    const raw404DecBytes = encodeOrderRespFrame({
      action: WIRE_ACTION_REQUOTE_DECLINE,
      status: 404,
      symbol: 'EURUSD',
      errorCode: 'DEALING_REQUEST_NOT_FOUND',
      message: 'Dealing request not found',
      execWire: { retcode: 10006, requestId: reqRaw404Dec, requoteId: rqRaw404Dec },
    });
    const raw404DecHook = renderHook(() =>
      useDealingRequest({
        requestId: reqRaw404Dec,
        autoDeclineOnExpire: false,
        sendRequoteFrame: () => raw404DecBytes,
      }),
    );
    await act(async () => {
      await raw404DecHook.result.current.decline();
    });
    expect(useDealingStore.getState().requests[reqRaw404Dec]?.phase).toBe('cancelled');
    expect(useDealingStore.getState().requests[reqRaw404Dec]?.reasonCode).toBe('CLIENT_DECLINED');
    expect(isDealingServerAdvertised()).toBe(true);
    expect(isDealingWireGateOpen()).toBe(true);
    raw404DecHook.unmount();

    // 3. Thrown 404 DEALING_REQUEST_NOT_FOUND & close-fill 404 MARGIN_RECHECK_FAILED keep gate open
    const reqThrow404 = createMockDealingUuid(0xe7);
    const rqThrow404 = createMockDealingUuid(0xe8);
    ingestDealingEvent({
      requestId: reqThrow404,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqThrow404,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);
    const throw404Hook = renderHook(() =>
      useDealingRequest({
        requestId: reqThrow404,
        autoDeclineOnExpire: false,
        sendRequoteFrame: async () => {
          throw Object.assign(new Error('Dealing request not found'), {
            status: 404,
            code: 'DEALING_REQUEST_NOT_FOUND',
          });
        },
      }),
    );
    await act(async () => {
      await expect(
        throw404Hook.result.current.accept({ requoteId: rqThrow404, price: 1.0842 }),
      ).rejects.toMatchObject({ status: 404 });
    });
    expect(useDealingStore.getState().requests[reqThrow404]?.phase).toBe('cancelled');
    expect(useDealingStore.getState().requests[reqThrow404]?.reasonCode).toBe('DEALING_ALREADY_RESOLVED');
    expect(isDealingServerAdvertised()).toBe(true);
    expect(isDealingWireGateOpen()).toBe(true);
    throw404Hook.unmount();

    const reqThrowCloseMargin = createMockDealingUuid(0xe9);
    const rqThrowCloseMargin = createMockDealingUuid(0xea);
    ingestDealingEvent({
      requestId: reqThrowCloseMargin,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqThrowCloseMargin,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);
    const closeMarginHook = renderHook(() =>
      useDealingRequest({
        requestId: reqThrowCloseMargin,
        autoDeclineOnExpire: false,
        sendRequoteFrame: async () => {
          throw Object.assign(new Error('Margin recheck failed'), {
            status: 404,
            code: 'MARGIN_RECHECK_FAILED',
          });
        },
      }),
    );
    await act(async () => {
      await expect(
        closeMarginHook.result.current.accept({ requoteId: rqThrowCloseMargin, price: 1.0842 }),
      ).rejects.toMatchObject({ status: 404, code: 'MARGIN_RECHECK_FAILED' });
    });
    expect(useDealingStore.getState().requests[reqThrowCloseMargin]?.phase).toBe('rejected');
    expect(useDealingStore.getState().requests[reqThrowCloseMargin]?.reasonCode).toBe('MARGIN_RECHECK_FAILED');
    expect(isDealingServerAdvertised()).toBe(true);
    expect(isDealingWireGateOpen()).toBe(true);
    closeMarginHook.unmount();

    // 4. Non-binary HTTP 404 carrying code=DEALING_NOT_ENABLED STILL closes the gate
    const reqHttp404 = createMockDealingUuid(0xeb);
    const rqHttp404 = createMockDealingUuid(0xec);
    ingestDealingEvent({
      requestId: reqHttp404,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqHttp404,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);
    const http404Hook = renderHook(() =>
      useDealingRequest({
        requestId: reqHttp404,
        autoDeclineOnExpire: false,
        sendRequoteFrame: async () => {
          throw Object.assign(new Error('Dealing is not enabled'), {
            status: 404,
            code: 'DEALING_NOT_ENABLED',
          });
        },
      }),
    );
    await act(async () => {
      await expect(
        http404Hook.result.current.accept({ requoteId: rqHttp404, price: 1.0842 }),
      ).rejects.toMatchObject({ status: 404, code: 'DEALING_NOT_ENABLED' });
    });
    expect(useDealingStore.getState().requests[reqHttp404]?.phase).toBe('rejected');
    expect(useDealingStore.getState().requests[reqHttp404]?.reasonCode).toBe('DEALING_NOT_ENABLED');
    expect(isDealingServerAdvertised()).toBe(false);
    expect(isDealingWireGateOpen()).toBe(false);
    http404Hook.unmount();
    resetDealingCapabilityState();
  });

  it('MINOR-3: settles TRUNCATED_BINARY_ORDER_RESP as synthetic unknown and BINARY_TUNNEL_UNAVAILABLE as retryable revert (never authoritative rejection)', async () => {
    resetDealingCapabilityState();
    __setDealingTransportSupportedForTests(true);
    setDealingServerAdvertised(true);
    const now = Date.now();

    // 1. TRUNCATED_BINARY_ORDER_RESP (502) -> synthetic expired awaiting server state; late 0x3A filled overrides cleanly
    const reqTrunc = createMockDealingUuid(0xed);
    const rqTrunc = createMockDealingUuid(0xee);
    ingestDealingEvent({
      requestId: reqTrunc,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqTrunc,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);
    const truncHook = renderHook(() =>
      useDealingRequest({
        requestId: reqTrunc,
        autoDeclineOnExpire: false,
        sendRequoteFrame: async () => {
          throw Object.assign(new Error('Invalid binary TCP 0x39 requote response'), {
            status: 502,
            code: 'TRUNCATED_BINARY_ORDER_RESP',
            retryable: true,
          });
        },
      }),
    );
    await act(async () => {
      await expect(
        truncHook.result.current.accept({ requoteId: rqTrunc, price: 1.0842 }),
      ).rejects.toMatchObject({ code: 'TRUNCATED_BINARY_ORDER_RESP' });
    });
    expect(useDealingStore.getState().requests[reqTrunc]?.phase).toBe('expired');
    expect(useDealingStore.getState().requests[reqTrunc]?.synthetic).toBe(true);
    expect(isDealingWireGateOpen()).toBe(true);

    act(() => {
      ingestDealingEvent({
        requestId: reqTrunc,
        seq: 3,
        phase: 'filled',
        orderTicket: 9955,
        price: 1.0842,
      });
    });
    expect(useDealingStore.getState().requests[reqTrunc]?.phase).toBe('filled');
    expect(useDealingStore.getState().requests[reqTrunc]?.synthetic).toBe(false);
    expect(useDealingStore.getState().requests[reqTrunc]?.orderTicket).toBe(9955);
    truncHook.unmount();

    // 2. BINARY_TUNNEL_UNAVAILABLE (502) -> reverts to requoted (retryable, never authoritative rejected); late 0x3A filled still overrides
    const reqTunnel = createMockDealingUuid(0xef);
    const rqTunnel = createMockDealingUuid(0xf0);
    ingestDealingEvent({
      requestId: reqTunnel,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: rqTunnel,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);
    const tunnelTx = vi
      .fn<RequoteDecisionTransport>()
      .mockRejectedValueOnce(
        Object.assign(new Error('Bad Gateway'), {
          status: 502,
          code: 'BINARY_TUNNEL_UNAVAILABLE',
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(
        encodeOrderRespFrame({
          action: WIRE_ACTION_REQUOTE_ACCEPT,
          status: WIRE_STATUS_OK,
          symbol: 'EURUSD',
          orderTicket: 9966,
          fillPrice: 1.0842,
          execWire: { retcode: MT_RET_REQUEST_DONE, requestId: reqTunnel, requoteId: rqTunnel },
        }),
      );
    const tunnelHook = renderHook(() =>
      useDealingRequest({
        requestId: reqTunnel,
        autoDeclineOnExpire: false,
        sendRequoteFrame: tunnelTx,
      }),
    );

    await act(async () => {
      await expect(
        tunnelHook.result.current.accept({ requoteId: rqTunnel, price: 1.0842 }),
      ).rejects.toMatchObject({ code: 'BINARY_TUNNEL_UNAVAILABLE' });
    });
    expect(tunnelHook.result.current.phase).toBe('requoted');
    expect(isDealingWireGateOpen()).toBe(true);

    // Retry succeeds cleanly with same requoteId
    await act(async () => {
      expect(await tunnelHook.result.current.accept({ requoteId: rqTunnel, price: 1.0842 })).toBe(true);
    });
    expect(useDealingStore.getState().requests[reqTunnel]?.phase).toBe('filled');
    expect(useDealingStore.getState().requests[reqTunnel]?.orderTicket).toBe(9966);
    tunnelHook.unmount();
    resetDealingCapabilityState();
  });
});
