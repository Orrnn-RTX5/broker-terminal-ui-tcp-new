import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  BINARY_ORDER_ACTION_CLOSE_POSITION,
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_CODEC_VERSION,
  type BinaryTcpOrderParams,
  type DecodedBinaryOrderResp,
} from './binaryTcpOrderClient';

const mocks = vi.hoisted(() => ({
  isBinaryTcpOrderEnabled: vi.fn<() => boolean>(),
  sendBinaryTcpOrder: vi.fn<(params: BinaryTcpOrderParams) => Promise<DecodedBinaryOrderResp>>(),
  restPlaceOrder: vi.fn(),
  restGetOrderCommand: vi.fn(),
}));

vi.mock('./binaryTcpOrderClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./binaryTcpOrderClient')>();
  return {
    ...actual,
    isBinaryTcpOrderEnabled: mocks.isBinaryTcpOrderEnabled,
    sendBinaryTcpOrder: mocks.sendBinaryTcpOrder,
  };
});

vi.mock('../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/endpoints')>();
  return {
    ...actual,
    tradingApi: {
      ...actual.tradingApi,
      placeOrder: mocks.restPlaceOrder,
      getOrderCommand: mocks.restGetOrderCommand,
    },
  };
});

import { api } from './api';
// Importing the order client installs the dealing order hooks, as the lazy dealing chunk does at runtime.
import './dealing/dealingOrderClient';
import { ingestDealingEvent } from './dealing/dealingEvents';
import { DEALING_OUTCOME_PENDING_CODE } from './dealing/dealingRuntimeHooks';
import { createMockDealingUuid } from './dealing/dealingMock';
import { useDealingStore } from '../store/useDealingStore';
import { formatOrderError } from '../utils/orderError';
import { clearTradeOrderLatencySamples, getTradeOrderLatencySamples } from './orderLatencyTelemetry';

const COID = '123e4567-e89b-42d3-a456-426614174000';
const COID_2 = '223e4567-e89b-42d3-a456-426614174001';
const REQ = createMockDealingUuid(0x41);
const RQ = createMockDealingUuid(0x42);
const LOGIN = 200002;

const inputOrder = { login: LOGIN, symbol: 'BTCUSD', side: 'sell' as const, volume: 0.01, price_sl: 0, price_tp: 0 };

function resp(overrides?: Partial<DecodedBinaryOrderResp>): DecodedBinaryOrderResp {
  return {
    version: BINARY_ORDER_CODEC_VERSION,
    action: BINARY_ORDER_ACTION_PLACE_MARKET,
    status: 200,
    ok: true,
    execMicros: 195,
    orderTicket: 880001,
    positionTicket: 990001,
    dealTicket: 770001,
    fillPrice: 65321.45,
    volume: 0.01,
    profit: 0,
    commission: -0.25,
    sl: 0,
    tp: 0,
    symbol: 'BTCUSD',
    clientOrderId: COID,
    errorCode: '',
    message: '',
    ...overrides,
  };
}

/** Simulates what `ingestOrderResp` does on a dealing 202: the IN_DEALING record lands in the store. */
function seedInDealing(opts: { coid?: string; timeoutMs?: number } = {}): void {
  const now = Date.now();
  ingestDealingEvent({
    requestId: REQ,
    clientOrderId: opts.coid ?? COID,
    accountLogin: LOGIN,
    kind: 'open',
    symbol: 'BTCUSD',
    side: 'sell',
    volume: 0.01,
    seq: 1,
    source: 'order_resp_0x39',
    phase: 'in_dealing',
    expiresAtMs: now + (opts.timeoutMs ?? 30_000),
    serverNowMs: now,
  }, now);
}

function fillEvent(coid: string, seq = 9): void {
  ingestDealingEvent({
    requestId: REQ,
    clientOrderId: coid,
    accountLogin: LOGIN,
    symbol: 'BTCUSD',
    volume: 0.01,
    seq,
    source: 'trade_event_0x3a',
    phase: 'filled',
    orderTicket: 6881787,
    positionTicket: 6881787,
    dealTicket: 6881788,
    price: 61377,
  }, Date.now());
}

function dealing202(): void {
  mocks.sendBinaryTcpOrder.mockImplementationOnce(async () => {
    seedInDealing();
    return resp({ status: 202, ok: true, orderTicket: 0, positionTicket: 0, dealTicket: 0, fillPrice: 0, errorCode: 'IN_DEALING' });
  });
}

describe('placeMarketOrder dealing-queued 202 awaits the dealer outcome', () => {
  let onNewTrade: Mock<(event: Event) => void>;
  let onForceRefresh: Mock<(event: Event) => void>;
  let onHistoryRefresh: Mock<(event: Event) => void>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.clearAllMocks();
    useDealingStore.getState().reset();
    mocks.isBinaryTcpOrderEnabled.mockReturnValue(true);
    // The plain order-command row stays non-terminal (a dealing-queued order has no terminal command row).
    mocks.restGetOrderCommand.mockResolvedValue({ status: 'processing', client_order_id: COID });
    clearTradeOrderLatencySamples();
    onNewTrade = vi.fn();
    onForceRefresh = vi.fn();
    onHistoryRefresh = vi.fn();
    window.addEventListener('rtx:new-trade-placed', onNewTrade);
    window.addEventListener('rtx:force-refresh-positions', onForceRefresh);
    window.addEventListener('rtx:refresh-trade-history-requested', onHistoryRefresh);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(performance.now());
      return 1;
    });
  });

  afterEach(() => {
    window.removeEventListener('rtx:new-trade-placed', onNewTrade);
    window.removeEventListener('rtx:force-refresh-positions', onForceRefresh);
    window.removeEventListener('rtx:refresh-trade-history-requested', onHistoryRefresh);
    useDealingStore.getState().reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('(a) 202 IN_DEALING then Filled at 32 s: success with real tickets, fill event, no ORDER_COMMAND_EXPIRED', async () => {
    dealing202();
    const p = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(32_000);
    expect(settled).toBe(false); // old code: expired at 30 s
    fillEvent(COID);
    const result = await p;

    expect(result).toMatchObject({ ticket: 6881787 });
    expect(mocks.restGetOrderCommand).not.toHaveBeenCalled();
    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
    expect(onNewTrade).toHaveBeenCalledTimes(1);
  });

  it('(b) dealer Confirm fill under the confirm coid (dl-<request_id>) is matched by request id', async () => {
    dealing202();
    const p = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    await vi.advanceTimersByTimeAsync(4_000);
    fillEvent(`dl-${REQ}`);
    await expect(p).resolves.toMatchObject({ ticket: 6881787 });
  });

  it('(c) Rejected: dealing reject code and the existing dealing message, never ORDER_COMMAND_EXPIRED', async () => {
    dealing202();
    const p = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2_000);
    ingestDealingEvent({
      requestId: REQ, clientOrderId: COID, accountLogin: LOGIN, symbol: 'BTCUSD', seq: 5,
      source: 'trade_event_0x3a', phase: 'rejected', reasonCode: 'DEALER_REJECTED',
    }, Date.now());
    const err = await p.then(() => null, (e: unknown) => e as { code?: string });
    expect(err?.code).toBe('DEALER_REJECTED');
    expect(formatOrderError(err)).toMatch(/rejected by dealer/i);
    expect(JSON.stringify(err)).not.toContain('ORDER_COMMAND_EXPIRED');
    expect(mocks.restGetOrderCommand).not.toHaveBeenCalled();
  });

  it('(d1) requote accepted: the requote window extends the deadline and the later fill succeeds', async () => {
    dealing202();
    const p = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    const now = Date.now();
    ingestDealingEvent({
      requestId: REQ, clientOrderId: COID, accountLogin: LOGIN, symbol: 'BTCUSD', side: 'sell', volume: 0.01, seq: 2,
      source: 'trade_event_0x3a', phase: 'requoted', requoteId: RQ, bid: 61300, ask: 61310,
      expiresAtMs: now + 60_000, serverNowMs: now,
    }, now);
    // Past original expiry (30 s) + margin (15 s) = 45 s, still inside requote window (65 s) + margin.
    await vi.advanceTimersByTimeAsync(50_000);
    useDealingStore.getState().markAccepting(REQ, RQ);
    await vi.advanceTimersByTimeAsync(1_000);
    fillEvent(COID, 12);
    await expect(p).resolves.toMatchObject({ ticket: 6881787 });
  });

  it('(d2) requote declined: dealing decline error', async () => {
    dealing202();
    const p = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(3_000);
    ingestDealingEvent({
      requestId: REQ, clientOrderId: COID, accountLogin: LOGIN, symbol: 'BTCUSD', seq: 7,
      source: 'trade_event_0x3a', phase: 'rejected', reasonCode: 'CLIENT_DECLINED',
    }, Date.now());
    const err = await p.then(() => null, (e: unknown) => e as { code?: string });
    expect(err?.code).toBe('CLIENT_DECLINED');
    expect(formatOrderError(err)).toMatch(/declined/i);
  });

  it('(e) timeout auto_fill at the human timeout (30 s) succeeds', async () => {
    dealing202();
    const p = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    await vi.advanceTimersByTimeAsync(30_400);
    fillEvent(`dl-${REQ}`);
    await expect(p).resolves.toMatchObject({ ticket: 6881787 });
  });

  it('(f) no event by expiry + 15 s: neutral pending error, positions/history refresh, no failure claim, no resubmit', async () => {
    dealing202();
    const p = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    const outcome = p.then(() => null, (e: unknown) => e as { code?: string; message?: string });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(onForceRefresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await outcome;
    expect(err?.code).toBe(DEALING_OUTCOME_PENDING_CODE);
    const text = formatOrderError(err);
    expect(text).toMatch(/still being processed by the dealer/i);
    expect(text).toMatch(/Positions/);
    expect(text).not.toMatch(/failed|expired|rejected/i);
    expect(onForceRefresh).toHaveBeenCalledTimes(1);
    expect(onHistoryRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
    expect(mocks.restPlaceOrder).not.toHaveBeenCalled();
    expect(mocks.restGetOrderCommand).not.toHaveBeenCalled();
  });

  it('(g) a NON-dealing 202 keeps the old order-command path and its 30 s ORDER_COMMAND_EXPIRED', async () => {
    mocks.sendBinaryTcpOrder.mockResolvedValueOnce(resp({ status: 202, orderTicket: 0, positionTicket: 0, dealTicket: 0 }));
    mocks.restGetOrderCommand.mockResolvedValue({ status: 'processing', client_order_id: COID });
    const p = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    const outcome = p.then(() => null, (e: unknown) => e as { code?: string; status?: number });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(mocks.restGetOrderCommand).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    const err = await outcome;
    expect(err?.code).toBe('ORDER_COMMAND_EXPIRED');
    expect(err?.status).toBe(504);
  });

  it('(h) a non-dealing 200 fill is unchanged', async () => {
    mocks.sendBinaryTcpOrder.mockResolvedValueOnce(resp());
    const result = await api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    expect(result).toMatchObject({ ticket: 990001 });
    expect(mocks.restGetOrderCommand).not.toHaveBeenCalled();
  });

  it('retry while IN_DEALING: the wait never resubmits; a new click is a new order with a new coid; same-coid dedupe is NOT asserted here (engine in-memory map, lost on gateway restart)', async () => {
    dealing202();
    const first = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    first.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    // Waiting alone: exactly one order on the wire.
    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);

    // Trader clicks again without a supplied id: the code sends a second order with a NEW client order id.
    mocks.sendBinaryTcpOrder.mockResolvedValueOnce(resp({ clientOrderId: COID_2, positionTicket: 990002 }));
    await api.orders.placeMarketOrder({ ...inputOrder }, { intentAtMs: performance.now() });
    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(2);
    const secondCoid = mocks.sendBinaryTcpOrder.mock.calls[1][0].clientOrderId;
    expect(secondCoid).not.toBe(COID);

    // A UI retry that re-sends the SAME client_order_id reaches the wire with the same id. This test only proves what
    // the client sends (mocked wire). The real server dedupe is the gateway engine's per-account in-memory idempotency
    // map (dealing_engine_hook.go acct.Idempotency), which is not durable (lost on a gateway restart); it is not
    // asserted here. The mocked 202 maps to the same dealing request, so both calls settle on the one outcome.
    mocks.sendBinaryTcpOrder.mockResolvedValueOnce(resp({ status: 202, orderTicket: 0, positionTicket: 0 }));
    const retry = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.sendBinaryTcpOrder.mock.calls[2][0].clientOrderId).toBe(COID);

    fillEvent(COID);
    await first;
    await retry;
  });

  it('(i) recovery_unverified (outcome unknown, a fill may exist): neutral pending + refresh, never a failure, not recorded as failed', async () => {
    dealing202();
    const p = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    const outcome = p.then(() => null, (e: unknown) => e as { code?: string; status?: number });
    await vi.advanceTimersByTimeAsync(3_000);
    ingestDealingEvent({
      requestId: REQ, clientOrderId: COID, accountLogin: LOGIN, symbol: 'BTCUSD', seq: 6,
      source: 'trade_event_0x3a', phase: 'expired', reasonCode: 'recovery_unverified',
      reasonText: 'Request expired: server restarted before confirmation, please resend',
    }, Date.now());
    const err = await outcome;
    expect(err?.code).toBe(DEALING_OUTCOME_PENDING_CODE);
    const text = formatOrderError(err);
    expect(text).toMatch(/still being processed by the dealer/i);
    expect(text).not.toMatch(/failed|expired|rejected|resend/i);
    expect(onForceRefresh).toHaveBeenCalledTimes(1);
    expect(onHistoryRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
    expect(mocks.restGetOrderCommand).not.toHaveBeenCalled();
    // The neutral outcome is not a terminal sample, so it can never be counted as a failure.
    expect(getTradeOrderLatencySamples().filter((x) => x.terminalStatus === 'failed')).toHaveLength(0);
  });

  it('(i2) a plain expired (requote window over, not recovery_unverified) is still the dealing timeout error', async () => {
    dealing202();
    const p = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    const outcome = p.then(() => null, (e: unknown) => e as { code?: string });
    await vi.advanceTimersByTimeAsync(2_000);
    ingestDealingEvent({
      requestId: REQ, clientOrderId: COID, accountLogin: LOGIN, symbol: 'BTCUSD', seq: 6,
      source: 'trade_event_0x3a', phase: 'expired', reasonCode: 'requote_expired',
    }, Date.now());
    const err = await outcome;
    expect(err?.code).not.toBe(DEALING_OUTCOME_PENDING_CODE);
  });

  it('(f2) the deadline pending outcome is not recorded as a failed placement sample', async () => {
    dealing202();
    const p = api.orders.placeMarketOrder({ ...inputOrder, client_order_id: COID }, { intentAtMs: performance.now() });
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(46_000);
    await p.then(() => null, () => null);
    expect(getTradeOrderLatencySamples().filter((x) => x.terminalStatus === 'failed')).toHaveLength(0);
  });
});

describe('closePosition dealing-queued 202 awaits the dealer outcome', () => {
  const TICKET = 5550001;
  let onForceRefresh: Mock<(event: Event) => void>;
  let onClosed: Mock<(event: Event) => void>;

  function closeResp(overrides?: Partial<DecodedBinaryOrderResp>): DecodedBinaryOrderResp {
    return resp({
      action: BINARY_ORDER_ACTION_CLOSE_POSITION, status: 202, orderTicket: 0, positionTicket: 0, dealTicket: 0,
      fillPrice: 0, errorCode: 'IN_DEALING', ...overrides,
    });
  }

  function dealingClose202(): void {
    mocks.sendBinaryTcpOrder.mockImplementationOnce(async () => {
      const now = Date.now();
      ingestDealingEvent({
        requestId: REQ, clientOrderId: COID, accountLogin: LOGIN, kind: 'close', symbol: 'BTCUSD', side: 'buy',
        volume: 0.01, seq: 1, source: 'order_resp_0x39', phase: 'in_dealing', expiresAtMs: now + 30_000, serverNowMs: now,
      }, now);
      return closeResp();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.clearAllMocks();
    useDealingStore.getState().reset();
    mocks.isBinaryTcpOrderEnabled.mockReturnValue(true);
    mocks.restGetOrderCommand.mockResolvedValue({ status: 'processing', client_order_id: COID });
    clearTradeOrderLatencySamples();
    onForceRefresh = vi.fn();
    onClosed = vi.fn();
    window.addEventListener('rtx:force-refresh-positions', onForceRefresh);
    window.addEventListener('rtx:position-closed', onClosed);
  });

  afterEach(() => {
    window.removeEventListener('rtx:force-refresh-positions', onForceRefresh);
    window.removeEventListener('rtx:position-closed', onClosed);
    useDealingStore.getState().reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('(c1) dealing-queued close filled at 32 s: success with real tickets, no ORDER_COMMAND_EXPIRED, no order-command poll', async () => {
    dealingClose202();
    const p = api.positions.closePosition(TICKET, { client_order_id: COID, accountLogin: LOGIN });
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(32_000);
    expect(settled).toBe(false); // old code: ORDER_COMMAND_EXPIRED at 30 s
    fillEvent(COID);
    const result = await p;
    expect(result).toMatchObject({ deal_ticket: 6881788, order_ticket: 6881787, status: 'closed' });
    expect(mocks.restGetOrderCommand).not.toHaveBeenCalled();
    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('(c2) dealing-queued close rejected: dealing reject code, never ORDER_COMMAND_EXPIRED', async () => {
    dealingClose202();
    const p = api.positions.closePosition(TICKET, { client_order_id: COID, accountLogin: LOGIN });
    const outcome = p.then(() => null, (e: unknown) => e as { code?: string });
    await vi.advanceTimersByTimeAsync(2_000);
    ingestDealingEvent({
      requestId: REQ, clientOrderId: COID, accountLogin: LOGIN, symbol: 'BTCUSD', seq: 5,
      source: 'trade_event_0x3a', phase: 'rejected', reasonCode: 'DEALER_REJECTED',
    }, Date.now());
    const err = await outcome;
    expect(err?.code).toBe('DEALER_REJECTED');
    expect(JSON.stringify(err)).not.toContain('ORDER_COMMAND_EXPIRED');
    expect(mocks.restGetOrderCommand).not.toHaveBeenCalled();
  });

  it('(c3) dealing-queued close with no outcome by expiry + 15 s: neutral pending + refresh, no resubmit', async () => {
    dealingClose202();
    const p = api.positions.closePosition(TICKET, { client_order_id: COID, accountLogin: LOGIN });
    const outcome = p.then(() => null, (e: unknown) => e as { code?: string });
    await vi.advanceTimersByTimeAsync(46_000);
    const err = await outcome;
    expect(err?.code).toBe(DEALING_OUTCOME_PENDING_CODE);
    expect(onForceRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
    expect(mocks.restGetOrderCommand).not.toHaveBeenCalled();
  });

  it('(c4) a NON-dealing close 202 keeps the old order-command path and its ORDER_COMMAND_EXPIRED', async () => {
    mocks.sendBinaryTcpOrder.mockResolvedValueOnce(closeResp());
    const p = api.positions.closePosition(TICKET, { client_order_id: COID, accountLogin: LOGIN });
    const outcome = p.then(() => null, (e: unknown) => e as { code?: string; status?: number });
    await vi.advanceTimersByTimeAsync(32_000);
    const err = await outcome;
    expect(err?.code).toBe('ORDER_COMMAND_EXPIRED');
    expect(mocks.restGetOrderCommand).toHaveBeenCalled();
  });

  it('(c5) a non-dealing close 200 is unchanged', async () => {
    mocks.sendBinaryTcpOrder.mockResolvedValueOnce(closeResp({ status: 200, positionTicket: TICKET, dealTicket: 770009, orderTicket: 880009, fillPrice: 65000 }));
    const result = await api.positions.closePosition(TICKET, { client_order_id: COID, accountLogin: LOGIN });
    expect(result).toMatchObject({ deal_ticket: 770009, close_price: 65000 });
    expect(mocks.restGetOrderCommand).not.toHaveBeenCalled();
  });
});
