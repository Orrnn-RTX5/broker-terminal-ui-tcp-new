import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WIRE_DEALING_STATUS_FILLED,
  WIRE_DEALING_STATUS_IN_DEALING,
  WIRE_SIDE_BUY,
  WIRE_SIDE_SELL,
} from './binaryDealingCodec';
import {
  buildMockKind7Frame,
  createDealingMockDriver,
  createMockDealingUuid,
  emitMockDealingEvent,
} from './dealingMock';
import { decodeTradeEventKind7Envelope } from './binaryDealingCodec';
import { useDealingStore } from '../../store/useDealingStore';

describe('dealingMock scenario driver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    useDealingStore.getState().reset();
  });

  afterEach(() => {
    useDealingStore.getState().reset();
    vi.useRealTimers();
  });

  it('generates deterministic UUID v4 mock identifiers and mock Kind 7 frames', () => {
    const id = createMockDealingUuid(0xab);
    expect(id).toBe('10203040-5060-4780-8090-a0b0c0d0e0ab');

    const now = Date.now();
    const emitted = emitMockDealingEvent({
      requestId: id,
      clientOrderId: 'mock-emit-1',
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1.0,
      phase: 'in_dealing',
      expiresAtMs: now + 10_000,
      serverNowMs: now,
    }, now);
    expect(emitted?.phase).toBe('in_dealing');

    const frame = buildMockKind7Frame(100042, {
      status: WIRE_DEALING_STATUS_FILLED,
      side: WIRE_SIDE_BUY,
      seq: 2,
      orderTicket: 5001,
      volume: 1.0,
      price: 1.085,
      requestId: id,
      symbol: 'EURUSD',
      clientOrderId: 'mock-emit-1',
    }, now + 200);
    const decoded = decodeTradeEventKind7Envelope(frame);
    expect(decoded.accountLogin).toBe(100042);
    expect(decoded.channel).toBe('dealing.100042');
    expect(decoded.event.status).toBe(WIRE_DEALING_STATUS_FILLED);
  });

  it('drives requote -> fill/reject/expired/declined, EA 409 suppression, 0x3B replay, and dispose', () => {
    const driver = createDealingMockDriver();
    const now = Date.now();

    // 1. in_dealing -> filled
    driver.inDealingToFilled({ symbol: 'EURUSD', fillPrice: 1.08462 });
    const filledId = createMockDealingUuid(0x11);
    expect(useDealingStore.getState().requests[filledId].phase).toBe('filled');

    // 2. in_dealing -> requote -> fill
    const rqFill = driver.inDealingToRequote({
      requestId: createMockDealingUuid(0x51),
      requoteId: createMockDealingUuid(0x52),
      symbol: 'USDJPY',
      digits: 3,
      nowMs: now,
    });
    expect(useDealingStore.getState().activeRequoteId).toBe(rqFill.requestId);
    driver.completeRequoteFill(rqFill.requestId, 154.123, now + 300);
    expect(useDealingStore.getState().requests[rqFill.requestId].phase).toBe('filled');
    expect(useDealingStore.getState().activeRequoteId).toBeNull();

    // 3. requote -> reject
    const rqReject = driver.inDealingToRequote({
      requestId: createMockDealingUuid(0x53),
      requoteId: createMockDealingUuid(0x54),
      symbol: 'GBPUSD',
      side: WIRE_SIDE_SELL,
      bid: 1.254,
      ask: 1.2542,
      nowMs: now,
    });
    driver.completeRequoteReject(rqReject.requestId, 'RISK_LIMIT', 'Limit reached', now + 300);
    expect(useDealingStore.getState().requests[rqReject.requestId].phase).toBe('rejected');
    expect(useDealingStore.getState().requests[rqReject.requestId].reasonCode).toBe('RISK_LIMIT');

    // 4. requote -> expired
    const rqExp = driver.inDealingToRequote({
      requestId: createMockDealingUuid(0x55),
      requoteId: createMockDealingUuid(0x56),
      symbol: 'XAUUSD',
      digits: 2,
      bid: 2350.1,
      ask: 2350.5,
      nowMs: now,
    });
    driver.completeRequoteExpired(rqExp.requestId, now + 5000);
    expect(useDealingStore.getState().requests[rqExp.requestId].phase).toBe('expired');
    expect(useDealingStore.getState().requests[rqExp.requestId].reasonCode).toBe('REQUOTE_EXPIRED');

    // 5. requote -> declined
    const rqDec = driver.inDealingToRequote({
      requestId: createMockDealingUuid(0x57),
      requoteId: createMockDealingUuid(0x58),
      symbol: 'EURUSD',
      nowMs: now,
    });
    driver.completeRequoteDeclined(rqDec.requestId, now + 400);
    expect(useDealingStore.getState().requests[rqDec.requestId].phase).toBe('cancelled');
    expect(useDealingStore.getState().requests[rqDec.requestId].reasonCode).toBe('CLIENT_DECLINED');

    // 6. EA 409 never opens requote modal
    const eaRec = driver.expertRequote409({ symbol: 'EURUSD', clientOrderId: 'ea-mock-409' });
    expect(eaRec?.phase).toBe('rejected');
    expect(eaRec?.isExpert).toBe(true);
    expect(useDealingStore.getState().activeRequoteId).toBeNull();

    // 7. Replay via 0x3B
    const replayId = createMockDealingUuid(0x59);
    const replayed = driver.replayVia0x3B(100042, {
      status: WIRE_DEALING_STATUS_IN_DEALING,
      side: WIRE_SIDE_BUY,
      seq: 1,
      requestId: replayId,
      symbol: 'AUDUSD',
      clientOrderId: 'mock-replay-1',
    });
    expect(replayed?.phase).toBe('in_dealing');
    expect(useDealingStore.getState().requests[replayId].symbol).toBe('AUDUSD');

    // 8. dispose resets all state
    driver.dispose();
    expect(Object.keys(useDealingStore.getState().requests)).toHaveLength(0);
    expect(useDealingStore.getState().activeRequoteId).toBeNull();
  });
});
