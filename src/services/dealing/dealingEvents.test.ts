import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEALING_KIND_OPEN,
  MT_RET_REQUEST_NO_MONEY,
  MT_RET_REQUEST_PLACED,
  MT_RET_REQUEST_REJECTED,
  MT_RET_REQUEST_REQUOTE,
  WIRE_ACTION_PLACE_MARKET,
  WIRE_ACTION_REQUOTE_ACCEPT,
  WIRE_ACTION_REQUOTE_DECLINE,
  WIRE_DEALING_STATUS_EXPIRED,
  WIRE_DEALING_STATUS_FILLED,
  WIRE_DEALING_STATUS_IN_DEALING,
  WIRE_DEALING_STATUS_REJECTED,
  WIRE_DEALING_STATUS_REQUOTED,
  WIRE_SIDE_BUY,
  WIRE_STATUS_ACCEPTED,
  WIRE_STATUS_CONFLICT,
  encodeOrderRespFrame,
  encodeTradeEventKind7Envelope,
} from './binaryDealingCodec';
import {
  DEALING_TOMBSTONE_MAX_ENTRIES,
  DEALING_TOMBSTONE_TTL_MS,
  MAX_TIMEOUT_DELAY_MS,
  MAX_VALID_DEALING_WINDOW_MS,
  clampTimeoutDelayMs,
  isValidDealingExpiresAtMs,
  kindFromWireCode,
  roundDealingPrice,
} from './dealingReducer';
import { DEALING_REASON_UI_STRINGS, DEALING_UI_STRINGS } from './dealingI18n';
import {
  applyDealingEvent,
  createDealingReconnectReplayController,
  createInitialDealingState,
  ingestBinaryDealingEnvelope,
  ingestBinaryOrderRespDealing,
  ingestDealingEvent,
  registerDealingReplayTrigger,
  subscribeDealingTerminal,
  subscribeDealingUnreconciled,
} from './dealingEvents';
import { createDealingMockDriver, createMockDealingUuid } from './dealingMock';
import {
  DEALING_REPLAY_DEBOUNCE_MS,
  STALE_NON_TERMINAL_PRUNE_AFTER_MS,
  TERMINAL_PRUNE_DELAY_MS,
  useDealingStore,
} from '../../store/useDealingStore';

describe('dealingEvents & 0x3B reconnect replay', () => {
  beforeEach(() => {
    useDealingStore.getState().reset();
  });

  afterEach(() => {
    useDealingStore.getState().reset();
  });

  it('transitions in_dealing -> requoted -> filled idempotently and rejects stale out-of-order seq', () => {
    const reqId = createMockDealingUuid(0x01);
    const rqId = createMockDealingUuid(0x02);
    let state = createInitialDealingState();

    state = applyDealingEvent(state, {
      requestId: reqId,
      clientOrderId: 'bo-1',
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 2.0,
      price: 1.0845,
      digits: 5,
      seq: 1,
      phase: 'in_dealing',
      expiresAtMs: 20_000,
      serverNowMs: 10_000,
    }, 10_000);
    expect(state.requests[reqId].phase).toBe('in_dealing');
    expect(state.activeRequoteId).toBeNull();

    state = applyDealingEvent(state, {
      requestId: reqId,
      seq: 3,
      phase: 'requoted',
      requoteId: rqId,
      bid: 1.0848,
      ask: 1.08495,
      expiresAtMs: 16_000,
      serverNowMs: 11_000,
    }, 11_000);
    expect(state.requests[reqId].phase).toBe('requoted');
    expect(state.requests[reqId].requote?.offeredPrice).toBe(1.08495);
    expect(state.requests[reqId].requote?.windowMs).toBe(5_000);
    expect(state.activeRequoteId).toBe(reqId);

    // Out-of-order seq=2 event must be ignored
    const afterStale = applyDealingEvent(state, {
      requestId: reqId,
      seq: 2,
      phase: 'in_dealing',
    }, 11_500);
    expect(afterStale.requests[reqId].phase).toBe('requoted');
    expect(afterStale.requests[reqId].seq).toBe(3);

    // Final fill clears requoteQueue and cannot regress
    state = applyDealingEvent(afterStale, {
      requestId: reqId,
      seq: 4,
      phase: 'filled',
      orderTicket: 7001,
      positionTicket: 7001,
      dealTicket: 7002,
      price: 1.08495,
    }, 12_000);
    expect(state.requests[reqId].phase).toBe('filled');
    expect(state.requests[reqId].orderTicket).toBe(7001);
    expect(state.activeRequoteId).toBeNull();

    const afterRegression = applyDealingEvent(state, {
      requestId: reqId,
      seq: 5,
      phase: 'rejected',
      reasonCode: 'OFF_QUOTES',
    }, 12_500);
    expect(afterRegression.requests[reqId].phase).toBe('filled');
  });

  it('enforces phase rank guard, seq-0 202 protection, different requoteId seq rule, and strict requote bid/ask + freshness', () => {
    const reqId = createMockDealingUuid(0x91);
    const rq1 = createMockDealingUuid(0x92);
    const rq2 = createMockDealingUuid(0x93);
    let state = createInitialDealingState();

    // Missing bid/ask on initial requoted event is dropped (no fallback)
    state = applyDealingEvent(state, {
      requestId: reqId,
      clientOrderId: 'bo-guard-1',
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1.0,
      phase: 'requoted',
      requoteId: rq1,
      bid: 0,
      ask: 1.085,
      price: 1.085,
      expiresAtMs: 20_000,
      serverNowMs: 10_000,
    }, 10_000);
    expect(state.requests[reqId]).toBeUndefined();

    // Valid in_dealing with bid/ask -> subsequent requoted STILL must carry bid & ask on THAT event
    state = applyDealingEvent(state, {
      requestId: reqId,
      clientOrderId: 'bo-guard-1',
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1.0,
      seq: 1,
      bid: 1.084,
      ask: 1.0842,
      phase: 'in_dealing',
      expiresAtMs: 25_000,
      serverNowMs: 10_000,
    }, 10_000);
    const noFreshBidAsk = applyDealingEvent(state, {
      requestId: reqId,
      seq: 2,
      phase: 'requoted',
      requoteId: rq1,
      ask: 1.0849, // missing bid -> must NOT fall back to existing.bid
      expiresAtMs: 18_000,
      serverNowMs: 10_500,
    }, 10_500);
    expect(noFreshBidAsk.requests[reqId].phase).toBe('in_dealing');

    // Already-expired requote (expiresAtMs <= nowMs + serverClockOffsetMs) is dropped
    const alreadyExpired = applyDealingEvent(state, {
      requestId: reqId,
      seq: 2,
      phase: 'requoted',
      requoteId: rq1,
      bid: 1.0848,
      ask: 1.08495,
      expiresAtMs: 10_500,
      serverNowMs: 10_500,
    }, 10_500);
    expect(alreadyExpired.requests[reqId].phase).toBe('in_dealing');

    // Valid requoted (seq=2, rq1)
    state = applyDealingEvent(state, {
      requestId: reqId,
      seq: 2,
      phase: 'requoted',
      requoteId: rq1,
      bid: 1.0848,
      ask: 1.08495,
      expiresAtMs: 16_000,
      serverNowMs: 11_000,
    }, 11_000);
    expect(state.requests[reqId].phase).toBe('requoted');

    // Late seq-0 202 IN_DEALING must NEVER regress requoted back to in_dealing
    const afterSeq0InDealing = applyDealingEvent(state, {
      requestId: reqId,
      seq: 0,
      phase: 'in_dealing',
    }, 11_100);
    expect(afterSeq0InDealing.requests[reqId].phase).toBe('requoted');

    // Different requoteId with equal/lower seq (seq=2) is dropped; higher seq (seq=3) supersedes
    const diffRqSameSeq = applyDealingEvent(state, {
      requestId: reqId,
      seq: 2,
      phase: 'requoted',
      requoteId: rq2,
      bid: 1.085,
      ask: 1.0852,
      expiresAtMs: 18_000,
      serverNowMs: 11_200,
    }, 11_200);
    expect(diffRqSameSeq.requests[reqId].requote?.requoteId).toBe(rq1);

    const diffRqHigherSeq = applyDealingEvent(state, {
      requestId: reqId,
      seq: 3,
      phase: 'requoted',
      requoteId: rq2,
      bid: 1.0851,
      ask: 1.0853,
      expiresAtMs: 18_000,
      serverNowMs: 11_300,
    }, 11_300);
    // Equal-seq replay with the SAME requoteId is dropped (no quote change, exact reference preserved, m6)
    const sameRqEqualSeq = applyDealingEvent(diffRqHigherSeq, {
      requestId: reqId,
      seq: 3,
      phase: 'requoted',
      requoteId: rq2,
      bid: 1.09,
      ask: 1.0909,
      expiresAtMs: 25_000,
      serverNowMs: 11_400,
    }, 11_400);
    expect(sameRqEqualSeq).toBe(diffRqHigherSeq);
    expect(sameRqEqualSeq.requests[reqId].requote?.offeredPrice).toBe(1.0853);

    // M1: seq-0 record created from 0x39 keeps rank guard strictly even against seq>=1 in_dealing
    const seq0Id = createMockDealingUuid(0x96);
    const seq0RqId = createMockDealingUuid(0x97);
    const otherQueuedId = createMockDealingUuid(0x98);
    let seq0State = createInitialDealingState();
    seq0State = applyDealingEvent(seq0State, {
      requestId: seq0Id,
      clientOrderId: 'bo-seq0',
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1.0,
      seq: 0,
      phase: 'requoted',
      requoteId: seq0RqId,
      bid: 1.084,
      ask: 1.0842,
      expiresAtMs: 20_000,
      serverNowMs: 10_000,
    }, 10_000);
    expect(seq0State.requests[seq0Id].phase).toBe('requoted');
    const blockedLowerRank = applyDealingEvent(seq0State, {
      requestId: seq0Id,
      seq: 1,
      phase: 'in_dealing',
    }, 10_100);
    expect(blockedLowerRank.requests[seq0Id].phase).toBe('requoted');

    // M1: higher-seq non-terminal transition out of requoted dequeues so next queued requote becomes active
    seq0State = applyDealingEvent(diffRqHigherSeq, {
      requestId: otherQueuedId,
      clientOrderId: 'bo-other-q',
      accountLogin: 100042,
      symbol: 'GBPUSD',
      side: 'buy',
      volume: 1.0,
      seq: 1,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0x99),
      bid: 1.25,
      ask: 1.2502,
      expiresAtMs: 25_000,
      serverNowMs: 11_400,
    }, 11_400);
    expect(seq0State.activeRequoteId).toBe(reqId);
    const dequeuedOnMove = applyDealingEvent(seq0State, {
      requestId: reqId,
      seq: 4,
      phase: 'in_dealing',
    }, 11_500);
    expect(dequeuedOnMove.requests[reqId].phase).toBe('in_dealing');
    expect(dequeuedOnMove.requoteQueue).not.toContain(reqId);
    expect(dequeuedOnMove.activeRequoteId).toBe(otherQueuedId);
  });

  it('lets late server terminal (0x3B replay filled) override synthetic safety-timer expiry without wrong expired notice', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const reqId = createMockDealingUuid(0x9a);
      const rqId = createMockDealingUuid(0x9b);
      const now = Date.now();
      const notices: string[] = [];

      const unsub = subscribeDealingTerminal({ requestId: reqId }, (notice) => {
        notices.push(`${notice.phase}:${notice.orderTicket ?? 0}`);
      });

      ingestDealingEvent({
        requestId: reqId,
        clientOrderId: 'bo-synth-1',
        accountLogin: 100042,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1.0,
        seq: 2,
        phase: 'requoted',
        requoteId: rqId,
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
      useDealingStore.getState().markAccepting(reqId, rqId);

      // Client safety timer synthesises non-authoritative expiry
      ingestDealingEvent({
        requestId: reqId,
        seq: 2,
        phase: 'expired',
        synthetic: true,
      }, now + 7_000);

      expect(useDealingStore.getState().requests[reqId].phase).toBe('expired');
      expect(useDealingStore.getState().requests[reqId].synthetic).toBe(true);
      expect(notices).toEqual([]);

      // Wait >10 s -> NOT pruned/tombstoned because expiry was synthetic
      vi.advanceTimersByTime(TERMINAL_PRUNE_DELAY_MS + 5_000);
      expect(useDealingStore.getState().requests[reqId]).toBeDefined();
      expect(notices).toEqual([]);

      // Late 0x3B replay brings real server FILLED -> overrides synthetic expiry and emits filled once
      const fillEnv = encodeTradeEventKind7Envelope(100042, now + 20_000, 'dealing.100042', {
        status: WIRE_DEALING_STATUS_FILLED,
        kind: DEALING_KIND_OPEN,
        side: WIRE_SIDE_BUY,
        digits: 5,
        seq: 3,
        orderTicket: 88101,
        positionTicket: 88101,
        dealTicket: 88201,
        volume: 1.0,
        price: 1.0842,
        requestId: reqId,
        requoteId: rqId,
        symbol: 'EURUSD',
        clientOrderId: 'bo-synth-1',
      });
      ingestBinaryDealingEnvelope(fillEnv, undefined, now + 20_000);

      const finalRec = useDealingStore.getState().requests[reqId];
      expect(finalRec.phase).toBe('filled');
      expect(finalRec.synthetic).toBe(false);
      expect(finalRec.orderTicket).toBe(88101);
      expect(notices).toEqual(['filled:88101']);
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });

  it('N1/N4/N5: never tombstones synthetic records on 5m prune, emits one neutral notice & allows late filled, supports multi-round requote, and validates expiresAtMs', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const now = Date.now();

      // N1a: Unreconciled synthetic record -> emits ONE neutral notice, triggers replay hook, never tombstoned, late filled still yields record & 1 notice
      const synId = createMockDealingUuid(0x9c);
      const synRqId = createMockDealingUuid(0x9d);
      const unreconciledNotices: string[] = [];
      const replayReasons: string[] = [];
      const terminalNotices: string[] = [];

      const unsubUnrec = subscribeDealingUnreconciled((n) => {
        unreconciledNotices.push(`${n.requestId}:${n.messageKey}`);
      });
      const unsubReplay = registerDealingReplayTrigger((ctx) => {
        replayReasons.push(`${ctx.requestId}:${ctx.reason}`);
      });
      const unsubTerm = subscribeDealingTerminal({ requestId: synId }, (n) => {
        terminalNotices.push(`${n.phase}:${n.orderTicket ?? 0}`);
      });

      ingestDealingEvent({
        requestId: synId,
        clientOrderId: 'bo-unrec-1',
        accountLogin: 100042,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1.0,
        seq: 2,
        phase: 'requoted',
        requoteId: synRqId,
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
      useDealingStore.getState().markAccepting(synId, synRqId);
      ingestDealingEvent({ requestId: synId, seq: 2, phase: 'expired', synthetic: true }, now + 7_000);

      // m3: replay trigger debounces for DEALING_REPLAY_DEBOUNCE_MS (2s)
      expect(replayReasons).toEqual([]);
      vi.advanceTimersByTime(DEALING_REPLAY_DEBOUNCE_MS);
      expect(replayReasons).toEqual([`${synId}:synthetic_expiry`]);
      expect(terminalNotices).toEqual([]);

      // M1: Synthetic staleness measures from rec.updatedAtMs (now + 7s), NOT offer expiry (now + 5s).
      vi.advanceTimersByTime(STALE_NON_TERMINAL_PRUNE_AFTER_MS + 5_000 - DEALING_REPLAY_DEBOUNCE_MS);
      expect(useDealingStore.getState().requests[synId]).toBeDefined();

      // Advance past synthetic updatedAtMs + 5m -> pruned with ONE neutral notice & NO tombstone
      vi.advanceTimersByTime(2_000);
      expect(useDealingStore.getState().requests[synId]).toBeUndefined();
      expect(useDealingStore.getState().tombstones[synId]).toBeUndefined();
      expect(unreconciledNotices).toEqual([`${synId}:${DEALING_UI_STRINGS.statusUnknownCheckHistory}`]);
      vi.advanceTimersByTime(DEALING_REPLAY_DEBOUNCE_MS);
      expect(replayReasons).toEqual([`${synId}:synthetic_expiry`, `${synId}:synthetic_prune`]);
      expect(terminalNotices).toEqual([]);

      // Calling pruneStaleRequests again or re-pruning does not emit a duplicate neutral notice
      useDealingStore.getState().pruneStaleRequests(Date.now());
      expect(unreconciledNotices).toHaveLength(1);

      // Late server FILLED after synthetic prune STILL creates record and emits 1 real filled notice
      ingestDealingEvent({
        requestId: synId,
        clientOrderId: 'bo-unrec-1',
        accountLogin: 100042,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1.0,
        seq: 3,
        phase: 'filled',
        orderTicket: 99201,
        price: 1.0842,
      }, Date.now());
      expect(useDealingStore.getState().requests[synId]?.phase).toBe('filled');
      expect(useDealingStore.getState().requests[synId]?.synthetic).toBe(false);
      expect(terminalNotices).toEqual(['filled:99201']);

      unsubUnrec();
      unsubReplay();
      unsubTerm();

      // N4: Multi-round requote overrides from seq=0 (0x39) and with strictly higher seq (seq 2 -> seq 3)
      const multiId = createMockDealingUuid(0x9e);
      const r1 = createMockDealingUuid(0x9f);
      const r2 = createMockDealingUuid(0xa0);
      const r3 = createMockDealingUuid(0xa1);
      let st = createInitialDealingState();
      st = applyDealingEvent(st, {
        requestId: multiId,
        accountLogin: 100042,
        symbol: 'GBPUSD',
        side: 'buy',
        volume: 1,
        seq: 0,
        phase: 'requoted',
        requoteId: r1,
        bid: 1.25,
        ask: 1.2502,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);
      st = applyDealingEvent(st, {
        requestId: multiId,
        seq: 2,
        phase: 'requoted',
        requoteId: r2,
        bid: 1.2505,
        ask: 1.2508,
        expiresAtMs: now + 10_000,
        serverNowMs: now + 5_000,
      }, now + 5_000);
      expect(st.requests[multiId].requote?.requoteId).toBe(r2);
      expect(st.requests[multiId].requote?.offeredPrice).toBe(1.2508);

      st = applyDealingEvent(st, {
        requestId: multiId,
        seq: 3,
        phase: 'requoted',
        requoteId: r3,
        bid: 1.251,
        ask: 1.2513,
        expiresAtMs: now + 15_000,
        serverNowMs: now + 10_000,
      }, now + 10_000);
      expect(st.requests[multiId].requote?.requoteId).toBe(r3);
      expect(st.requests[multiId].requote?.offeredPrice).toBe(1.2513);

      // N5: Huge/invalid expiresAtMs rejected on requoted & clamped delay
      expect(clampTimeoutDelayMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMEOUT_DELAY_MS);
      const hugeExpRes = applyDealingEvent(st, {
        requestId: createMockDealingUuid(0xa2),
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        seq: 1,
        phase: 'requoted',
        requoteId: createMockDealingUuid(0xa3),
        bid: 1.1,
        ask: 1.1002,
        expiresAtMs: now + 365 * 24 * 60 * 60 * 1_000,
        serverNowMs: now,
      }, now);
      expect(hugeExpRes.requests[createMockDealingUuid(0xa2)]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents replay resurrection via bounded tombstones and emits no second terminal notice', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const reqId = createMockDealingUuid(0x94);
      const firstNoticeSpy = vi.fn();
      const unsub1 = subscribeDealingTerminal({ requestId: reqId }, firstNoticeSpy);

      ingestDealingEvent({
        requestId: reqId,
        clientOrderId: 'bo-tomb-1',
        accountLogin: 100042,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1.0,
        seq: 1,
        phase: 'in_dealing',
      });
      ingestDealingEvent({
        requestId: reqId,
        seq: 2,
        phase: 'filled',
        orderTicket: 9901,
        price: 1.085,
      });

      expect(firstNoticeSpy).toHaveBeenCalledTimes(1);
      unsub1();

      // Advance past 10s terminal prune -> record is pruned & tombstoned
      vi.advanceTimersByTime(TERMINAL_PRUNE_DELAY_MS);
      expect(useDealingStore.getState().requests[reqId]).toBeUndefined();
      expect(useDealingStore.getState().tombstones[reqId]?.seq).toBe(2);

      // Re-subscribe after prune and replay terminal event -> tombstoned id dropped, no 2nd notice
      const secondNoticeSpy = vi.fn();
      const unsub2 = subscribeDealingTerminal({ requestId: reqId }, secondNoticeSpy);
      const replayRes = ingestDealingEvent({
        requestId: reqId,
        clientOrderId: 'bo-tomb-1',
        symbol: 'EURUSD',
        seq: 2,
        phase: 'filled',
        orderTicket: 9901,
        price: 1.085,
      });
      expect(replayRes).toBeNull();
      expect(useDealingStore.getState().requests[reqId]).toBeUndefined();
      expect(secondNoticeSpy).not.toHaveBeenCalled();
      unsub2();

      // Bounded tombstone capacity check
      for (let i = 0; i < DEALING_TOMBSTONE_MAX_ENTRIES + 40; i++) {
        const hexSuffix = i.toString(16).padStart(4, '0');
        const id = `10203040-5060-4780-8090-a0b0c0d0${hexSuffix}`;
        ingestDealingEvent({ requestId: id, symbol: 'EURUSD', phase: 'in_dealing', seq: 1 });
        useDealingStore.getState().removeRequest(id, Date.now() + i);
      }
      expect(Object.keys(useDealingStore.getState().tombstones).length).toBeLessThanOrEqual(
        DEALING_TOMBSTONE_MAX_ENTRIES,
      );
      expect(DEALING_TOMBSTONE_TTL_MS).toBe(120_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores unknown dealing kind via kindFromWireCode meta fallback and skips non-dealing 0x39 rejects', () => {
    expect(kindFromWireCode(99)).toBeUndefined();

    const envUnknownKind = encodeTradeEventKind7Envelope(100042, 1000, 'dealing.100042', {
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: 99,
      side: WIRE_SIDE_BUY,
      seq: 1,
      requestId: createMockDealingUuid(0x95),
      symbol: 'EURUSD',
      clientOrderId: 'bo-kind-meta',
    });
    const parsedRec = ingestBinaryDealingEnvelope(envUnknownKind, { kind: 'close' }, 1000);
    expect(parsedRec?.kind).toBe('close');

    // Ordinary 422 NO_MONEY without dealing UUID or Action 9/10 must NOT create store records
    useDealingStore.getState().reset();
    const ordinaryReject = encodeOrderRespFrame({
      action: WIRE_ACTION_PLACE_MARKET,
      status: 422,
      symbol: 'EURUSD',
      clientOrderId: 'ord-plain-reject',
      errorCode: 'NO_MONEY',
      message: 'Insufficient free margin',
      execWire: {
        retcode: 10019,
        quotedReqId: 0,
      },
    });
    expect(ingestBinaryOrderRespDealing(ordinaryReject)).toBeNull();
    expect(Object.keys(useDealingStore.getState().requests)).toHaveLength(0);
    expect(useDealingStore.getState().byClientOrderId['ord-plain-reject']).toBeUndefined();
  });

  it('never opens interactive requote modal for EA orders (ORDER_REASON_EXPERT / 409 REQUOTE)', () => {
    const reqId = createMockDealingUuid(0x0a);
    const rqId = createMockDealingUuid(0x0b);

    // EA requote push is stored without enqueuing requoteQueue
    const rec = ingestDealingEvent({
      requestId: reqId,
      clientOrderId: 'ea-order-1',
      symbol: 'EURUSD',
      side: 'buy',
      volume: 0.5,
      isExpert: true,
      phase: 'requoted',
      requoteId: rqId,
      bid: 1.084,
      ask: 1.0842,
    });
    expect(rec?.phase).toBe('requoted');
    expect(useDealingStore.getState().activeRequoteId).toBeNull();
    expect(useDealingStore.getState().requoteQueue).toEqual([]);

    // 0x39 409 REQUOTE maps directly to rejected and never opens modal
    const resp409 = encodeOrderRespFrame({
      action: WIRE_ACTION_PLACE_MARKET,
      status: WIRE_STATUS_CONFLICT,
      symbol: 'GBPUSD',
      clientOrderId: 'ea-order-2',
      errorCode: 'REQUOTE',
      message: 'Market changed',
      execWire: {
        retcode: MT_RET_REQUEST_REQUOTE,
        quotedReqId: 0,
        dealerBid: 1.25,
        dealerAsk: 1.2503,
        requestId: createMockDealingUuid(0x0c),
      },
    });
    const rec409 = ingestBinaryOrderRespDealing(resp409, { isExpert: true });
    expect(rec409?.phase).toBe('rejected');
    expect(rec409?.reasonCode).toBe('REQUOTE');
    expect(useDealingStore.getState().activeRequoteId).toBeNull();
  });

  it('maps 0x39 202 (10008 / 10004) and notifies subscribeDealingTerminal once upon completion', () => {
    const reqId = createMockDealingUuid(0x21);
    const resp202 = encodeOrderRespFrame({
      action: WIRE_ACTION_PLACE_MARKET,
      status: WIRE_STATUS_ACCEPTED,
      symbol: 'XAUUSD',
      clientOrderId: 'bo-gold-1',
      volume: 0.5,
      errorCode: 'IN_DEALING',
      message: 'Request placed in dealing queue',
      execWire: {
        retcode: MT_RET_REQUEST_PLACED,
        quotedReqId: 0,
        dealerBid: 2350.1,
        dealerAsk: 2350.5,
        requestId: reqId,
        expiresAtMs: 1795181005000,
        serverNowMs: 1795180995000,
        dealingKind: DEALING_KIND_OPEN,
        digits: 2,
        hasDigits: true,
      },
    });

    const initial = ingestBinaryOrderRespDealing(resp202, { accountLogin: 100042, side: 'buy' });
    expect(initial?.phase).toBe('in_dealing');
    expect(initial?.digits).toBe(2);

    const terminalNotices: unknown[] = [];
    const unsub = subscribeDealingTerminal({ clientOrderId: 'bo-gold-1' }, (notice) => {
      terminalNotices.push(notice);
    });

    const rejectEnv = encodeTradeEventKind7Envelope(100042, 1795180998000, 'dealing.100042', {
      status: WIRE_DEALING_STATUS_REJECTED,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      digits: 2,
      retcode: MT_RET_REQUEST_REJECTED,
      seq: 2,
      requestId: reqId,
      symbol: 'XAUUSD',
      clientOrderId: 'bo-gold-1',
      reasonCode: 'RISK_LIMIT',
      reasonText: 'Order exceeds risk or exposure limits',
    });
    ingestBinaryDealingEnvelope(rejectEnv);

    expect(terminalNotices).toHaveLength(1);
    expect(terminalNotices[0]).toMatchObject({
      status: 'rejected',
      phase: 'rejected',
      terminal: true,
      requestId: reqId,
      clientOrderId: 'bo-gold-1',
      error: {
        code: 'RISK_LIMIT',
        message: 'Order exceeds risk or exposure limits',
      },
    });

    unsub();
  });

  it('replays active and terminal 0x3A Kind 7 frames strictly via 0x3B reconnect (no HTTP)', async () => {
    const sentFrames: Uint8Array[] = [];
    const replayed: string[] = [];

    const controller = createDealingReconnectReplayController({
      getAccountLogin: () => 100042,
      getAuthToken: () => 'jwt-reconnect-tok',
      sendAccountSub: async (_login, _token, frame) => {
        sentFrames.push(frame);
      },
      onReplayedRecord: (rec) => {
        replayed.push(`${rec.requestId}:${rec.phase}`);
      },
    });

    const pkt0x3B = await controller.onStreamReconnected();
    expect(pkt0x3B).not.toBeNull();
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0].byteLength).toBe(10 + 'jwt-reconnect-tok'.length);

    const activeId = createMockDealingUuid(0x71);
    const expiredId = createMockDealingUuid(0x72);
    const rqId = createMockDealingUuid(0x73);

    controller.handleReplayedEnvelope(
      encodeTradeEventKind7Envelope(100042, 10_000, 'dealing.100042', {
        status: WIRE_DEALING_STATUS_REQUOTED,
        kind: DEALING_KIND_OPEN,
        side: WIRE_SIDE_BUY,
        digits: 5,
        retcode: MT_RET_REQUEST_REQUOTE,
        seq: 2,
        volume: 1.0,
        bid: 1.1,
        ask: 1.1002,
        expiresAtMs: 15_000,
        serverNowMs: 10_000,
        requestId: activeId,
        requoteId: rqId,
        symbol: 'EURUSD',
        clientOrderId: 'bo-replay-active',
      }),
      undefined,
      10_000,
    );

    controller.handleReplayedEnvelope(
      encodeTradeEventKind7Envelope(100042, 10_000, 'dealing.100042', {
        status: WIRE_DEALING_STATUS_EXPIRED,
        kind: DEALING_KIND_OPEN,
        side: WIRE_SIDE_BUY,
        digits: 5,
        seq: 3,
        requestId: expiredId,
        symbol: 'GBPUSD',
        clientOrderId: 'bo-replay-expired',
        reasonCode: 'DEALER_TIMEOUT',
      }),
      undefined,
      10_000,
    );

    expect(replayed).toEqual([`${activeId}:requoted`, `${expiredId}:expired`]);
    expect(useDealingStore.getState().activeRequoteId).toBe(activeId);
    expect(useDealingStore.getState().requests[expiredId].phase).toBe('expired');
  });

  it('supports scripted mock driver scenarios end-to-end', () => {
    const driver = createDealingMockDriver();
    driver.inDealingToFilled({ symbol: 'EURUSD', fillPrice: 1.085 });
    const filledId = createMockDealingUuid(0x11);
    expect(useDealingStore.getState().requests[filledId].phase).toBe('filled');

    const { requestId } = driver.inDealingToRequote({ symbol: 'USDJPY', digits: 3 });
    expect(useDealingStore.getState().activeRequoteId).toBe(requestId);

    driver.completeRequoteFill(requestId, 154.123);
    expect(useDealingStore.getState().requests[requestId].phase).toBe('filled');
    expect(useDealingStore.getState().activeRequoteId).toBeNull();

    driver.dispose();
    expect(Object.keys(useDealingStore.getState().requests)).toHaveLength(0);
  });

  it('handles duplicate 0x3A in_dealing frame safely via vi mock timers check', () => {
    const reqId = createMockDealingUuid(0x88);
    const env = encodeTradeEventKind7Envelope(100042, 1000, 'dealing.100042', {
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      seq: 1,
      requestId: reqId,
      symbol: 'EURUSD',
      clientOrderId: 'bo-dup',
    });
    const spy = vi.fn();
    const unsub = useDealingStore.subscribe(spy);
    ingestBinaryDealingEnvelope(env, undefined, 1000);
    ingestBinaryDealingEnvelope(env, undefined, 1000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(useDealingStore.getState().requests[reqId].phase).toBe('in_dealing');
    unsub();
  });

  it('M3: allows a round-2 0x39 requote (seq 0) with new requoteId to override while seq > 0, preserves seq, and blocks stale 0x3A / declining', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const now = Date.now();
      const reqId = createMockDealingUuid(0xb1);
      const rq1 = createMockDealingUuid(0xb2);
      const rq2 = createMockDealingUuid(0xb3);
      const rqStale = createMockDealingUuid(0xb4);

      const envRound1 = encodeTradeEventKind7Envelope(100042, now, 'dealing.100042', {
        status: WIRE_DEALING_STATUS_REQUOTED,
        kind: DEALING_KIND_OPEN,
        side: WIRE_SIDE_BUY,
        digits: 5,
        retcode: MT_RET_REQUEST_REQUOTE,
        seq: 2,
        volume: 1.0,
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
        requestId: reqId,
        requoteId: rq1,
        symbol: 'EURUSD',
        clientOrderId: 'bo-m3-round',
      });
      ingestBinaryDealingEnvelope(envRound1, undefined, now);
      expect(useDealingStore.getState().markAccepting(reqId, rq1)).toBe(true);
      expect(useDealingStore.getState().requests[reqId].seq).toBe(2);

      // Server Action 9 reply carries a brand-new round-2 requote on 0x39 (seq = 0 in frame)
      const respRound2 = encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: WIRE_STATUS_ACCEPTED,
        symbol: 'EURUSD',
        clientOrderId: 'bo-m3-round',
        volume: 1.0,
        errorCode: 'DEALER_REQUOTE',
        execWire: {
          retcode: MT_RET_REQUEST_REQUOTE,
          dealerBid: 1.0845,
          dealerAsk: 1.0848,
          requestId: reqId,
          requoteId: rq2,
          expiresAtMs: now + 9_000,
          serverNowMs: now + 1_000,
          dealingKind: DEALING_KIND_OPEN,
          digits: 5,
          hasDigits: true,
        },
      });
      const recRound2 = ingestBinaryOrderRespDealing(respRound2, { accountLogin: 100042, side: 'buy' }, now + 1_000);
      expect(recRound2?.phase).toBe('requoted');
      expect(recRound2?.requote?.requoteId).toBe(rq2);
      expect(recRound2?.requote?.offeredPrice).toBe(1.0848);
      expect(recRound2?.seq).toBe(2);

      // Stale 0x3A with lower seq=1 MUST still be rejected
      const staleEnv = encodeTradeEventKind7Envelope(100042, now + 1_500, 'dealing.100042', {
        status: WIRE_DEALING_STATUS_REQUOTED,
        kind: DEALING_KIND_OPEN,
        side: WIRE_SIDE_BUY,
        digits: 5,
        retcode: MT_RET_REQUEST_REQUOTE,
        seq: 1,
        volume: 1.0,
        bid: 1.083,
        ask: 1.0832,
        expiresAtMs: now + 6_000,
        serverNowMs: now + 1_500,
        requestId: reqId,
        requoteId: rqStale,
        symbol: 'EURUSD',
        clientOrderId: 'bo-m3-round',
      });
      ingestBinaryDealingEnvelope(staleEnv, undefined, now + 1_500);
      expect(useDealingStore.getState().requests[reqId].requote?.requoteId).toBe(rq2);

      // Item 5: While live in `requoted` (`rq2`), another 0x39 with a different requoteId is NOT allowed to replace it
      const unsolicited0x39 = encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: WIRE_STATUS_ACCEPTED,
        symbol: 'EURUSD',
        clientOrderId: 'bo-m3-round',
        volume: 1.0,
        errorCode: 'DEALER_REQUOTE',
        execWire: {
          retcode: MT_RET_REQUEST_REQUOTE,
          dealerBid: 1.09,
          dealerAsk: 1.0903,
          requestId: reqId,
          requoteId: createMockDealingUuid(0xb5),
          expiresAtMs: now + 12_000,
          serverNowMs: now + 1_550,
          dealingKind: DEALING_KIND_OPEN,
          digits: 5,
          hasDigits: true,
        },
      });
      ingestBinaryOrderRespDealing(unsolicited0x39, { accountLogin: 100042, side: 'buy' }, now + 1_550);
      expect(useDealingStore.getState().requests[reqId].phase).toBe('requoted');
      expect(useDealingStore.getState().requests[reqId].requote?.requoteId).toBe(rq2);

      // 0x39 requoted does NOT override an explicit trader declining state
      expect(useDealingStore.getState().markDeclining(reqId, rq2)).toBe(true);
      ingestBinaryOrderRespDealing(respRound2, { accountLogin: 100042, side: 'buy' }, now + 1_600);
      expect(useDealingStore.getState().requests[reqId].phase).toBe('declining');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Item 4: rounds offered bid/ask prices to instrument digits at ingest', () => {
    const now = 1_700_000_000_000;
    const reqId = createMockDealingUuid(0xb6);
    const rqId = createMockDealingUuid(0xb7);
    expect(roundDealingPrice(1.0849567, 5)).toBe(1.08496);
    expect(roundDealingPrice(154.1234, 3)).toBe(154.123);

    const rec = ingestDealingEvent({
      requestId: reqId,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      seq: 1,
      phase: 'requoted',
      requoteId: rqId,
      bid: 1.0848123,
      ask: 1.0849567,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    expect(rec?.bid).toBe(1.08481);
    expect(rec?.ask).toBe(1.08496);
    expect(rec?.requote?.bid).toBe(1.08481);
    expect(rec?.requote?.ask).toBe(1.08496);
    expect(rec?.requote?.offeredPrice).toBe(1.08496);
    expect(rec?.requote?.offeredPrice.toFixed(5)).toBe('1.08496');
  });

  it('m2 & Re-test gap: isolates throwing terminal listener and validates isValidDealingExpiresAtMs edge inputs', () => {
    const now = 1_700_000_000_000;
    expect(isValidDealingExpiresAtMs(Number.NaN, now)).toBe(false);
    expect(isValidDealingExpiresAtMs(Number.POSITIVE_INFINITY, now)).toBe(false);
    expect(isValidDealingExpiresAtMs(Number.NEGATIVE_INFINITY, now)).toBe(false);
    expect(isValidDealingExpiresAtMs(now + 1234.5, now)).toBe(false);
    expect(isValidDealingExpiresAtMs(0, now)).toBe(false);
    expect(isValidDealingExpiresAtMs(-1, now)).toBe(false);
    expect(isValidDealingExpiresAtMs(-5_000, now)).toBe(false);
    expect(isValidDealingExpiresAtMs(now + MAX_VALID_DEALING_WINDOW_MS + 1, now)).toBe(false);
    expect(isValidDealingExpiresAtMs(now + 5_000, now)).toBe(true);

    const reqId = createMockDealingUuid(0xb9);
    const badSpy = vi.fn(() => {
      throw new Error('subscriber boom');
    });
    const unsub = subscribeDealingTerminal({ requestId: reqId }, badSpy);
    expect(() =>
      ingestDealingEvent({
        requestId: reqId,
        accountLogin: 100042,
        symbol: 'EURUSD',
        phase: 'filled',
        orderTicket: 551,
      }, now),
    ).not.toThrow();
    expect(badSpy).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('MAJOR-1: maps binary 0x39 404 (DEALING_REQUEST_NOT_FOUND / close-fill 404) without misreporting DEALING_NOT_ENABLED', () => {
    const now = 1_700_000_000_000;

    // 1. Accept + 404 DEALING_REQUEST_NOT_FOUND -> cancelled / DEALING_ALREADY_RESOLVED
    const reqAcceptNotFound = createMockDealingUuid(0xc1);
    const rqAcceptNotFound = createMockDealingUuid(0xc2);
    const recAcceptNotFound = ingestBinaryOrderRespDealing(
      encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: 404,
        symbol: 'EURUSD',
        errorCode: 'DEALING_REQUEST_NOT_FOUND',
        message: 'Dealing request not found',
        execWire: { retcode: MT_RET_REQUEST_REJECTED, requestId: reqAcceptNotFound, requoteId: rqAcceptNotFound },
      }),
      { accountLogin: 100042, side: 'buy' },
      now,
    );
    expect(recAcceptNotFound?.phase).toBe('cancelled');
    expect(recAcceptNotFound?.reasonCode).toBe('DEALING_ALREADY_RESOLVED');
    expect(recAcceptNotFound?.reasonMessage).toBe(DEALING_REASON_UI_STRINGS.DEALING_ALREADY_RESOLVED);

    // 2. Accept + close-fill 404 carrying known dealing reason -> rejected with that reason
    const reqCloseMargin = createMockDealingUuid(0xc3);
    const rqCloseMargin = createMockDealingUuid(0xc4);
    const recCloseMargin = ingestBinaryOrderRespDealing(
      encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: 404,
        symbol: 'EURUSD',
        errorCode: 'MARGIN_RECHECK_FAILED',
        message: 'Insufficient free margin',
        execWire: { retcode: MT_RET_REQUEST_NO_MONEY, requestId: reqCloseMargin, requoteId: rqCloseMargin },
      }),
      { accountLogin: 100042, side: 'buy' },
      now,
    );
    expect(recCloseMargin?.phase).toBe('rejected');
    expect(recCloseMargin?.reasonCode).toBe('MARGIN_RECHECK_FAILED');
    expect(recCloseMargin?.reasonMessage).toBe(DEALING_REASON_UI_STRINGS.MARGIN_RECHECK_FAILED);

    // 3. Accept + close-fill 404 with non-dealing unknown code (POSITION_NOT_FOUND) -> cancelled / DEALING_ALREADY_RESOLVED
    const reqPosMissing = createMockDealingUuid(0xc5);
    const rqPosMissing = createMockDealingUuid(0xc6);
    const recPosMissing = ingestBinaryOrderRespDealing(
      encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: 404,
        symbol: 'EURUSD',
        errorCode: 'POSITION_NOT_FOUND',
        message: 'Position already closed',
        execWire: { retcode: MT_RET_REQUEST_REJECTED, requestId: reqPosMissing, requoteId: rqPosMissing },
      }),
      { accountLogin: 100042, side: 'buy' },
      now,
    );
    expect(recPosMissing?.phase).toBe('cancelled');
    expect(recPosMissing?.reasonCode).toBe('DEALING_ALREADY_RESOLVED');
    expect(recPosMissing?.reasonMessage).toBe(DEALING_REASON_UI_STRINGS.DEALING_ALREADY_RESOLVED);

    // 4. Decline + 404 DEALING_REQUEST_NOT_FOUND -> cancelled / CLIENT_DECLINED
    const reqDecNotFound = createMockDealingUuid(0xc7);
    const rqDecNotFound = createMockDealingUuid(0xc8);
    const recDecNotFound = ingestBinaryOrderRespDealing(
      encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_DECLINE,
        status: 404,
        symbol: 'EURUSD',
        errorCode: 'DEALING_REQUEST_NOT_FOUND',
        message: 'Dealing request not found',
        execWire: { retcode: MT_RET_REQUEST_REJECTED, requestId: reqDecNotFound, requoteId: rqDecNotFound },
      }),
      { accountLogin: 100042, side: 'buy' },
      now,
    );
    expect(recDecNotFound?.phase).toBe('cancelled');
    expect(recDecNotFound?.reasonCode).toBe('CLIENT_DECLINED');
    expect(recDecNotFound?.reasonMessage).toBe(DEALING_REASON_UI_STRINGS.CLIENT_DECLINED);

    // 5. Accept + 501 DEALING_NOT_ENABLED still maps to DEALING_NOT_ENABLED
    const req501 = createMockDealingUuid(0xc9);
    const rq501 = createMockDealingUuid(0xca);
    const rec501 = ingestBinaryOrderRespDealing(
      encodeOrderRespFrame({
        action: WIRE_ACTION_REQUOTE_ACCEPT,
        status: 501,
        symbol: 'EURUSD',
        errorCode: 'DEALING_NOT_ENABLED',
        message: 'dealing not enabled',
        execWire: { retcode: MT_RET_REQUEST_REJECTED, requestId: req501, requoteId: rq501 },
      }),
      { accountLogin: 100042, side: 'buy' },
      now,
    );
    expect(rec501?.phase).toBe('rejected');
    expect(rec501?.reasonCode).toBe('DEALING_NOT_ENABLED');
    expect(rec501?.reasonMessage).toBe(DEALING_REASON_UI_STRINGS.DEALING_NOT_ENABLED);
  });
});
