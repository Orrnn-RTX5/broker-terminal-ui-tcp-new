import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEALING_UI_STRINGS } from '../services/dealing/dealingI18n';
import { DEALING_TOMBSTONE_TTL_MS, MAX_TIMEOUT_DELAY_MS } from '../services/dealing/dealingReducer';
import { createMockDealingUuid } from '../services/dealing/dealingMock';
import {
  DEALING_REPLAY_DEBOUNCE_MS,
  DEALING_REPLAY_MAX_WAIT_MS,
  REQUOTE_SWEEP_HEAD_GRACE_MS,
  STALE_NON_TERMINAL_PRUNE_AFTER_MS,
  TERMINAL_PRUNE_DELAY_MS,
  registerDealingReplayTrigger,
  registerDealingSweepDecline,
  selectActiveDealingRequestIdForSymbol,
  selectActiveRequoteId,
  selectDealingPhaseById,
  selectDealingRequestIdByClientOrderId,
  subscribeDealingUnreconciled,
  type DealingReplayTriggerContext,
  useDealingStore,
} from './useDealingStore';

describe('useDealingStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    useDealingStore.getState().reset();
  });

  afterEach(() => {
    useDealingStore.getState().reset();
    vi.useRealTimers();
  });

  it('indexes requests by requestId and clientOrderId and maintains FIFO requote queue', () => {
    const id1 = createMockDealingUuid(0x01);
    const id2 = createMockDealingUuid(0x02);
    const rq1 = createMockDealingUuid(0xa1);
    const rq2 = createMockDealingUuid(0xa2);

    const store = useDealingStore.getState();
    store.applyEvent({
      requestId: id1,
      clientOrderId: 'bo-1',
      accountLogin: 1001,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1.0,
      phase: 'requoted',
      requoteId: rq1,
      bid: 1.08,
      ask: 1.0802,
      expiresAtMs: Date.now() + 5000,
      serverNowMs: Date.now(),
    });
    store.applyEvent({
      requestId: id2,
      clientOrderId: 'bo-2',
      accountLogin: 1001,
      symbol: 'GBPUSD',
      side: 'sell',
      volume: 2.0,
      phase: 'requoted',
      requoteId: rq2,
      bid: 1.25,
      ask: 1.2502,
      expiresAtMs: Date.now() + 5000,
      serverNowMs: Date.now(),
    });

    const snapshot = useDealingStore.getState();
    expect(selectActiveRequoteId(snapshot)).toBe(id1);
    expect(selectDealingPhaseById(id1)(snapshot)).toBe('requoted');
    expect(selectDealingRequestIdByClientOrderId('bo-2')(snapshot)).toBe(id2);
    expect(selectActiveDealingRequestIdForSymbol('gbpusd')(snapshot)).toBe(id2);

    // Optimistic accepting blocks decline until reverted or settled; revert returns to requoted
    expect(store.markAccepting(id1, rq1)).toBe(true);
    expect(selectDealingPhaseById(id1)(useDealingStore.getState())).toBe('accepting');
    expect(store.markDeclining(id1, rq1)).toBe(false);
    expect(selectDealingPhaseById(id1)(useDealingStore.getState())).toBe('accepting');
    store.revertRequotePending(id1, rq1);
    expect(selectDealingPhaseById(id1)(useDealingStore.getState())).toBe('requoted');

    // Fill id1 -> advances activeRequoteId to id2
    store.applyEvent({
      requestId: id1,
      phase: 'filled',
      orderTicket: 444,
    });
    expect(selectActiveRequoteId(useDealingStore.getState())).toBe(id2);
  });

  it('prunes terminal records after 10 s grace delay and clears account cleanly', () => {
    const id1 = createMockDealingUuid(0x11);
    const id2 = createMockDealingUuid(0x12);
    const store = useDealingStore.getState();

    store.applyEvent({
      requestId: id1,
      clientOrderId: 'bo-prune-1',
      accountLogin: 1001,
      symbol: 'EURUSD',
      phase: 'in_dealing',
    });
    store.applyEvent({
      requestId: id1,
      phase: 'rejected',
      reasonCode: 'OFF_QUOTES',
    });

    expect(useDealingStore.getState().requests[id1]).toBeDefined();
    vi.advanceTimersByTime(TERMINAL_PRUNE_DELAY_MS - 1);
    expect(useDealingStore.getState().requests[id1]).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(useDealingStore.getState().requests[id1]).toBeUndefined();
    expect(useDealingStore.getState().byClientOrderId['bo-prune-1']).toBeUndefined();

    // Tombstone blocks replay immediately after prune and expires cleanly after 2 minutes
    expect(store.applyEvent({ requestId: id1, symbol: 'EURUSD', phase: 'rejected', seq: 2 })).toBeNull();
    expect(useDealingStore.getState().requests[id1]).toBeUndefined();
    vi.advanceTimersByTime(DEALING_TOMBSTONE_TTL_MS);

    // Dropped replay on active terminal record (nextState === state) must NOT reset the 10s prune timer (m1)
    const idPrune = createMockDealingUuid(0x13);
    store.applyEvent({ requestId: idPrune, accountLogin: 1001, symbol: 'EURUSD', phase: 'rejected', seq: 2 });
    vi.advanceTimersByTime(TERMINAL_PRUNE_DELAY_MS - 1_000);
    store.applyEvent({ requestId: idPrune, accountLogin: 1001, symbol: 'EURUSD', phase: 'in_dealing', seq: 1 });
    vi.advanceTimersByTime(1_000);
    expect(useDealingStore.getState().requests[idPrune]).toBeUndefined();
    vi.advanceTimersByTime(DEALING_TOMBSTONE_TTL_MS);

    // Account cleanup removes matching-login AND login-0 entries while preserving other logins (m2)
    const idLogin0 = createMockDealingUuid(0x14);
    store.applyEvent({ requestId: id1, accountLogin: 1001, symbol: 'EURUSD', phase: 'in_dealing', clientOrderId: 'acc-1' });
    store.applyEvent({ requestId: idLogin0, accountLogin: 0, symbol: 'GBPUSD', phase: 'in_dealing', clientOrderId: 'acc-0' });
    store.applyEvent({ requestId: id2, accountLogin: 2002, symbol: 'XAUUSD', phase: 'in_dealing', clientOrderId: 'acc-2' });
    store.clearAccount(1001);
    expect(useDealingStore.getState().requests[id1]).toBeUndefined();
    expect(useDealingStore.getState().requests[idLogin0]).toBeUndefined();
    expect(useDealingStore.getState().byClientOrderId['acc-1']).toBeUndefined();
    expect(useDealingStore.getState().byClientOrderId['acc-0']).toBeUndefined();
    expect(useDealingStore.getState().requests[id2]).toBeDefined();

    store.reset();
    expect(Object.keys(useDealingStore.getState().requests)).toHaveLength(0);
    expect(Object.keys(useDealingStore.getState().byClientOrderId)).toHaveLength(0);
    expect(useDealingStore.getState().requoteQueue).toEqual([]);
    expect(useDealingStore.getState().activeRequoteId).toBeNull();
    expect(Object.keys(useDealingStore.getState().tombstones)).toHaveLength(0);
  });

  it('m1: prunes hung non-terminal records 5 minutes after expiresAtMs WITHOUT tombstone and emits ONE neutral notice so late fill reconciles', () => {
    const staleId = createMockDealingUuid(0x21);
    const now = Date.now();
    const store = useDealingStore.getState();
    const notices: string[] = [];
    const replayReasons: string[] = [];
    const unsubNotice = subscribeDealingUnreconciled((n) => notices.push(`${n.requestId}:${n.messageKey}`));
    const unsubReplay = registerDealingReplayTrigger((ctx) => replayReasons.push(`${ctx.requestId}:${ctx.reason}`));

    store.applyEvent({
      requestId: staleId,
      clientOrderId: 'bo-stale-nonterm',
      accountLogin: 1001,
      symbol: 'EURUSD',
      side: 'buy',
      phase: 'in_dealing',
      expiresAtMs: now + 60_000,
      serverNowMs: now,
    }, now);

    expect(useDealingStore.getState().requests[staleId]).toBeDefined();
    // 59s after expiresAtMs is < 5 min -> still present
    vi.advanceTimersByTime(60_000 + STALE_NON_TERMINAL_PRUNE_AFTER_MS - 1);
    expect(useDealingStore.getState().requests[staleId]).toBeDefined();

    // Exact 5 min after expiresAtMs -> pruned WITHOUT tombstone, emits ONE neutral notice
    vi.advanceTimersByTime(1);
    expect(useDealingStore.getState().requests[staleId]).toBeUndefined();
    expect(useDealingStore.getState().byClientOrderId['bo-stale-nonterm']).toBeUndefined();
    expect(useDealingStore.getState().tombstones[staleId]).toBeUndefined();
    expect(notices).toEqual([`${staleId}:${DEALING_UI_STRINGS.statusUnknownCheckHistory}`]);

    // Repeat prune emits no duplicate neutral notice; replay triggers after 2s debounce
    store.pruneStaleRequests(Date.now());
    expect(notices).toHaveLength(1);
    vi.advanceTimersByTime(DEALING_REPLAY_DEBOUNCE_MS);
    expect(replayReasons).toEqual([`${staleId}:stale_prune`]);

    // Late authoritative FILLED still creates/reconciles the record because m1 never tombstones stale non-terminal prunes
    const lateFill = store.applyEvent({
      requestId: staleId,
      clientOrderId: 'bo-stale-nonterm',
      accountLogin: 1001,
      symbol: 'EURUSD',
      phase: 'filled',
      orderTicket: 8181,
      price: 1.086,
      seq: 3,
    }, Date.now());
    expect(lateFill?.phase).toBe('filled');
    expect(useDealingStore.getState().requests[staleId]?.orderTicket).toBe(8181);
    unsubNotice();
    unsubReplay();
  });

  it('N3/N5/N6: skips expired requote heads in selectActiveRequoteId, clamps setTimeout <= 2^31-1, and reschedules early stale-prune timers', () => {
    const store = useDealingStore.getState();
    const baseNow = Date.now();

    // N3: Expired head must not block a valid later queued requote (accounting for serverClockOffsetMs)
    const expId = createMockDealingUuid(0x31);
    const validId = createMockDealingUuid(0x32);
    store.applyEvent({
      requestId: expId,
      accountLogin: 1001,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0xb1),
      bid: 1.08,
      ask: 1.0802,
      expiresAtMs: baseNow + 2_000,
      serverNowMs: baseNow,
    }, baseNow);
    store.applyEvent({
      requestId: validId,
      accountLogin: 1001,
      symbol: 'GBPUSD',
      side: 'sell',
      volume: 1,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0xb2),
      bid: 1.25,
      ask: 1.2502,
      expiresAtMs: baseNow + 10_000,
      serverNowMs: baseNow,
    }, baseNow);
    expect(selectActiveRequoteId(useDealingStore.getState())).toBe(expId);

    // Advance past expId's expiry -> selector skips expId cleanly to validId
    vi.advanceTimersByTime(2_500);
    expect(selectActiveRequoteId(useDealingStore.getState())).toBe(validId);

    // N5: Extreme expiresAtMs never schedules setTimeout > MAX_TIMEOUT_DELAY_MS
    store.reset();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const hugeRecId = createMockDealingUuid(0x33);
    store.applyEvent({
      requestId: hugeRecId,
      accountLogin: 1001,
      symbol: 'EURUSD',
      phase: 'in_dealing',
      expiresAtMs: baseNow + 365 * 24 * 60 * 60 * 1_000,
      serverNowMs: baseNow,
    }, baseNow);
    for (const call of setTimeoutSpy.mock.calls) {
      const delay = typeof call[1] === 'number' ? call[1] : 0;
      expect(delay).toBeLessThanOrEqual(MAX_TIMEOUT_DELAY_MS);
    }
    setTimeoutSpy.mockRestore();

    // N6: Early stale-prune timer reschedule (e.g. clock moved back before timer fires)
    store.reset();
    const reschedId = createMockDealingUuid(0x34);
    const t0 = Date.now();
    store.applyEvent({
      requestId: reschedId,
      accountLogin: 1001,
      symbol: 'XAUUSD',
      phase: 'in_dealing',
      expiresAtMs: t0 + 10_000,
      serverNowMs: t0,
    }, t0);
    // Advance 150s, then simulate OS/clock shifting backward by 200s
    vi.advanceTimersByTime(150_000);
    vi.setSystemTime(t0 - 50_000);
    // Remaining 160s drains the first 310s timer -> server/local delta is only 100s < 300s -> NOT pruned, reschedules for +200s
    vi.advanceTimersByTime(160_000);
    expect(useDealingStore.getState().requests[reschedId]).toBeDefined();

    // Advancing the rescheduled 200s timer completes staleness and prunes the record
    vi.advanceTimersByTime(200_000);
    expect(useDealingStore.getState().requests[reschedId]).toBeUndefined();
  });

  it('M1/M2/m2/m3: measures synthetic staleness from updatedAtMs, sweeps expired non-head requotes, isolates listener errors, and debounces replay triggers', () => {
    const store = useDealingStore.getState();
    const notices: string[] = [];
    const replayCalls: string[] = [];
    const sweepDeclines: string[] = [];

    const badNoticeUnsub = subscribeDealingUnreconciled(() => {
      throw new Error('notice listener fail');
    });
    const goodNoticeUnsub = subscribeDealingUnreconciled((n) => notices.push(`${n.requestId}:${n.messageKey}`));
    const badReplayUnsub = registerDealingReplayTrigger(() => {
      throw new Error('replay trigger fail');
    });
    const replayBatches: Array<readonly DealingReplayTriggerContext[] | undefined> = [];
    const goodReplayUnsub = registerDealingReplayTrigger((ctx) => {
      replayCalls.push(`${ctx.requestId}:${ctx.reason}`);
      replayBatches.push(ctx.batch);
    });
    const sweepDeclineUnsub = registerDealingSweepDecline((rec) => {
      sweepDeclines.push(rec.requestId);
      throw new Error('sweep decline fail');
    });

    // M1: Requote expired 6 min ago, but becomes synthetic NOW -> stays alive for a full 5 min from updatedAtMs
    const t0 = Date.now();
    const lateSynId = createMockDealingUuid(0x41);
    store.applyEvent({
      requestId: lateSynId,
      accountLogin: 1001,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0xc1),
      bid: 1.08,
      ask: 1.0802,
      expiresAtMs: t0 + 5_000,
      serverNowMs: t0,
    }, t0);

    // Tab wakes 6 minutes after expiry and goes synthetic
    const wakeNow = t0 + 6 * 60_000;
    vi.setSystemTime(wakeNow);
    store.applyEvent({
      requestId: lateSynId,
      phase: 'expired',
      synthetic: true,
    }, wakeNow);

    // Calling pruneStaleRequests immediately at wakeNow must NOT prune the brand-new synthetic record
    store.pruneStaleRequests(wakeNow);
    expect(useDealingStore.getState().requests[lateSynId]?.synthetic).toBe(true);
    expect(notices).toEqual([]);

    // 4m59s later it is STILL present; at 5m00s it prunes without tombstone and emits 1 notice
    vi.advanceTimersByTime(STALE_NON_TERMINAL_PRUNE_AFTER_MS - 1);
    expect(useDealingStore.getState().requests[lateSynId]).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(useDealingStore.getState().requests[lateSynId]).toBeUndefined();
    expect(useDealingStore.getState().tombstones[lateSynId]).toBeUndefined();
    expect(notices).toEqual([`${lateSynId}:${DEALING_UI_STRINGS.statusUnknownCheckHistory}`]);

    // Both distinct lifecycle points (> 2s apart) fire; now test m3 burst debouncing within < 2s
    vi.advanceTimersByTime(DEALING_REPLAY_DEBOUNCE_MS);
    expect(replayCalls).toEqual([
      `${lateSynId}:synthetic_expiry`,
      `${lateSynId}:synthetic_prune`,
    ]);

    replayCalls.length = 0;
    replayBatches.length = 0;
    const burst1 = createMockDealingUuid(0x44);
    const burst2 = createMockDealingUuid(0x45);
    const burst3 = createMockDealingUuid(0x46);
    store.applyEvent({ requestId: burst1, accountLogin: 1001, symbol: 'EURUSD', phase: 'expired', synthetic: true });
    vi.advanceTimersByTime(400);
    store.applyEvent({ requestId: burst2, accountLogin: 1001, symbol: 'GBPUSD', phase: 'expired', synthetic: true });
    vi.advanceTimersByTime(400);
    store.applyEvent({ requestId: burst3, accountLogin: 1001, symbol: 'USDJPY', phase: 'expired', synthetic: true });
    expect(replayCalls).toEqual([]);
    vi.advanceTimersByTime(DEALING_REPLAY_DEBOUNCE_MS - 1);
    expect(replayCalls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(replayCalls).toEqual([`${burst3}:synthetic_expiry`]);
    expect(replayBatches[0]?.map((c) => c.requestId)).toEqual([burst1, burst2, burst3]);

    // Item 2 max-wait cap: continuous stream every 1.5s cannot postpone replay past DEALING_REPLAY_MAX_WAIT_MS (5s)
    replayCalls.length = 0;
    replayBatches.length = 0;
    const mw1 = createMockDealingUuid(0x47);
    const mw2 = createMockDealingUuid(0x48);
    const mw3 = createMockDealingUuid(0x49);
    const mw4 = createMockDealingUuid(0x4a);
    store.applyEvent({ requestId: mw1, accountLogin: 1001, symbol: 'EURUSD', phase: 'expired', synthetic: true });
    vi.advanceTimersByTime(1_500);
    store.applyEvent({ requestId: mw2, accountLogin: 1001, symbol: 'EURUSD', phase: 'expired', synthetic: true });
    vi.advanceTimersByTime(1_500);
    store.applyEvent({ requestId: mw3, accountLogin: 1001, symbol: 'EURUSD', phase: 'expired', synthetic: true });
    vi.advanceTimersByTime(1_500);
    store.applyEvent({ requestId: mw4, accountLogin: 1001, symbol: 'EURUSD', phase: 'expired', synthetic: true });
    expect(replayCalls).toEqual([]);
    vi.advanceTimersByTime(DEALING_REPLAY_MAX_WAIT_MS - 4_500);
    expect(replayCalls).toEqual([`${mw4}:synthetic_expiry`]);
    expect(replayBatches[0]?.map((c) => c.requestId)).toEqual([mw1, mw2, mw3, mw4]);

    // M2: Expired NON-head requote is swept automatically without dropping healthy head
    store.reset();
    notices.length = 0;
    replayCalls.length = 0;
    const base = Date.now();
    const headId = createMockDealingUuid(0x42);
    const nonHeadId = createMockDealingUuid(0x43);
    store.applyEvent({
      requestId: headId,
      accountLogin: 1001,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0xc2),
      bid: 1.08,
      ask: 1.0802,
      expiresAtMs: base + 15_000,
      serverNowMs: base,
    }, base);
    store.applyEvent({
      requestId: nonHeadId,
      accountLogin: 1001,
      symbol: 'GBPUSD',
      side: 'sell',
      volume: 1,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0xc3),
      bid: 1.25,
      ask: 1.2502,
      expiresAtMs: base + 2_000,
      serverNowMs: base,
    }, base);

    // At +2s, nonHeadId sweeps cleanly out of requoteQueue to synthetic expired while headId remains requoted
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
    expect(useDealingStore.getState().requests[headId]?.phase).toBe('requoted');
    expect(useDealingStore.getState().requests[nonHeadId]?.phase).toBe('expired');
    expect(useDealingStore.getState().requests[nonHeadId]?.synthetic).toBe(true);
    expect(useDealingStore.getState().requoteQueue).toEqual([headId]);
    expect(sweepDeclines).toEqual([nonHeadId]);

    // Head expires at +15s and sweeps after REQUOTE_SWEEP_HEAD_GRACE_MS (1s); both sweeps trigger replay after debounce
    vi.advanceTimersByTime(13_000 + REQUOTE_SWEEP_HEAD_GRACE_MS);
    expect(useDealingStore.getState().requests[headId]?.synthetic).toBe(true);
    expect(useDealingStore.getState().requoteQueue).toEqual([]);
    vi.advanceTimersByTime(DEALING_REPLAY_DEBOUNCE_MS);
    expect(replayCalls).toEqual([
      `${nonHeadId}:synthetic_expiry`,
      `${headId}:synthetic_expiry`,
    ]);

    // Swept non-head synthetic record lost its server terminal -> prunes at 5m with 1 notice, no tombstone, late fill reconciles
    vi.advanceTimersByTime(STALE_NON_TERMINAL_PRUNE_AFTER_MS);
    expect(useDealingStore.getState().requests[nonHeadId]).toBeUndefined();
    expect(useDealingStore.getState().tombstones[nonHeadId]).toBeUndefined();
    expect(notices).toContain(`${nonHeadId}:${DEALING_UI_STRINGS.statusUnknownCheckHistory}`);
    const reconciled = store.applyEvent({
      requestId: nonHeadId,
      accountLogin: 1001,
      symbol: 'GBPUSD',
      phase: 'filled',
      orderTicket: 9012,
      seq: 4,
    }, Date.now());
    expect(reconciled?.phase).toBe('filled');

    badNoticeUnsub();
    goodNoticeUnsub();
    badReplayUnsub();
    goodReplayUnsub();
    sweepDeclineUnsub();
  });

  it('Item 7: applies REQUOTE_SWEEP_HEAD_GRACE_MS to the first NON-dead queue entry rather than index 0', () => {
    const store = useDealingStore.getState();
    const now = Date.now();
    const deadTerminalId = createMockDealingUuid(0x51);
    const missingDeadId = createMockDealingUuid(0x52);
    const liveHeadId = createMockDealingUuid(0x53);
    const liveTailId = createMockDealingUuid(0x54);

    store.applyEvent({
      requestId: deadTerminalId,
      accountLogin: 1001,
      symbol: 'EURUSD',
      phase: 'filled',
      orderTicket: 1111,
      seq: 2,
    }, now);
    store.applyEvent({
      requestId: liveHeadId,
      accountLogin: 1001,
      symbol: 'GBPUSD',
      side: 'buy',
      volume: 1,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0xd3),
      bid: 1.25,
      ask: 1.2502,
      expiresAtMs: now + 2_000,
      serverNowMs: now,
    }, now);
    store.applyEvent({
      requestId: liveTailId,
      accountLogin: 1001,
      symbol: 'USDJPY',
      side: 'sell',
      volume: 1,
      digits: 3,
      phase: 'requoted',
      requoteId: createMockDealingUuid(0xd4),
      bid: 154.1,
      ask: 154.15,
      expiresAtMs: now + 2_000,
      serverNowMs: now,
    }, now);

    // Prepend dead/missing entries ahead of liveHeadId in the raw queue
    useDealingStore.setState({
      requoteQueue: [missingDeadId, deadTerminalId, liveHeadId, liveTailId],
    });

    // Advance 500 ms past expiry -> inside 1_000 ms grace for first live entry (liveHeadId),
    // but expired immediately with 0 grace for non-head liveTailId
    const sweepAt = now + 2_500;
    vi.setSystemTime(sweepAt);
    const swept1 = useDealingStore.getState().sweepExpiredRequotes(sweepAt, REQUOTE_SWEEP_HEAD_GRACE_MS);

    expect(swept1).toEqual([liveTailId]);
    expect(useDealingStore.getState().requoteQueue).toEqual([liveHeadId]);
    expect(useDealingStore.getState().requests[liveHeadId]?.phase).toBe('requoted');
    expect(useDealingStore.getState().requests[liveTailId]?.phase).toBe('expired');
    expect(useDealingStore.getState().requests[liveTailId]?.synthetic).toBe(true);

    // After the 1_000 ms head grace expires, liveHeadId sweeps cleanly too
    const sweepAt2 = now + 2_000 + REQUOTE_SWEEP_HEAD_GRACE_MS;
    vi.setSystemTime(sweepAt2);
    const swept2 = useDealingStore.getState().sweepExpiredRequotes(sweepAt2, REQUOTE_SWEEP_HEAD_GRACE_MS);
    expect(swept2).toEqual([liveHeadId]);
    expect(useDealingStore.getState().requoteQueue).toEqual([]);
  });

  it('manages 200 concurrent dealing requests with only ONE shared lifecycle timer (R1 MAJOR-1)', () => {
    const store = useDealingStore.getState();
    const baseNow = Date.now();
    for (let i = 0; i < 100; i++) {
      store.applyEvent(
        {
          requestId: createMockDealingUuid(i + 1),
          clientOrderId: `bo-deal-${i}`,
          accountLogin: 1001,
          symbol: i % 2 === 0 ? 'EURUSD' : 'GBPUSD',
          side: 'buy',
          volume: 0.1,
          phase: 'in_dealing',
          expiresAtMs: baseNow + 10_000 + i * 50,
          serverNowMs: baseNow,
        },
        baseNow,
      );
      store.applyEvent(
        {
          requestId: createMockDealingUuid(101 + i),
          clientOrderId: `bo-rq-${i}`,
          accountLogin: 1001,
          symbol: 'USDJPY',
          side: 'sell',
          volume: 0.2,
          phase: 'requoted',
          requoteId: createMockDealingUuid(201 + i),
          bid: 150.1,
          ask: 150.15,
          expiresAtMs: baseNow + 5_000 + i * 25,
          serverNowMs: baseNow,
        },
        baseNow,
      );
    }
    expect(Object.keys(useDealingStore.getState().requests)).toHaveLength(200);
    expect(vi.getTimerCount()).toBe(1);
  });
});
