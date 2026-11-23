import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const streamHarness = vi.hoisted(() => ({
  activeOrders: 0,
  token: '',
  accountLogin: 0,
}));

vi.mock('../../config/backendTarget.js', () => ({ isDesktopBackendTarget: () => true }));
vi.mock('../binaryTcpOrderClient', () => ({
  bindBinaryTcpAccountSub: vi.fn(async () => undefined),
  getActiveBinaryTcpOrderCount: () => streamHarness.activeOrders,
  getBinaryTcpOrderActiveDurationMs: () => 0,
  getBinaryOrderRawFrameTransport: () => ({
    isEnabled: () => true,
    getAccessToken: () => streamHarness.token,
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
  onBinaryTcpOrdersIdle: () => undefined,
  prewarmBinaryOrderSocket: () => undefined,
  syncBinaryOrderAuthToken: () => undefined,
}));
vi.mock('../brokerSession', () => ({
  getAccessToken: () => streamHarness.token,
  getAccountLogin: () => streamHarness.accountLogin,
  onSessionChange: () => () => {},
}));

import {
  BINARY_TICK_RECORD_SIZE,
  FRAME_BINARY_TICK_BATCH,
  FRAME_BINARY_TRADE_EVENT,
  binaryTcpMarketStream,
  decodeBinaryTradeEvent,
} from '../binaryTcpMarketStream';
import { useDealingStore } from '../../store/useDealingStore';
import {
  DEALING_KIND_OPEN,
  MT_RET_REQUEST_CANCEL,
  MT_RET_REQUEST_DONE,
  MT_RET_REQUEST_PLACED,
  MT_RET_REQUEST_REQUOTE,
  WIRE_ACTION_DEALING_SYNC,
  WIRE_ACTION_REQUOTE_DECLINE,
  WIRE_DEALING_STATUS_FILLED,
  WIRE_DEALING_STATUS_IN_DEALING,
  WIRE_DEALING_STATUS_REQUOTED,
  WIRE_SIDE_BUY,
  WIRE_STATUS_OK,
  decodeRequoteActionFrame,
  encodeDealingSyncRespFrame,
  encodeOrderRespFrame,
  encodeTradeEventKind7Envelope,
} from './binaryDealingCodec';
import { ingestDealingEvent } from './dealingEvents';
import './dealingMarketStreamBridge';
import { resetDealingSyncProbeState } from './dealingOrderClient';
import {
  isDealingServerAdvertised,
  isDealingWireGateOpen,
  registerDealingAccountSubscribedHook,
  resetDealingCapabilityState,
  setDealingServerAdvertised,
} from './dealingRuntimeHooks';
import { installDealingShellRuntime } from './dealingShellRuntime';
import { createMockDealingUuid } from './dealingMock';

const b64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fakeJwt = (login: number) =>
  `${b64url({ alg: 'none' })}.${b64url({ account_login: login, exp: 4_102_444_800 })}.sig`;

const encoder = new TextEncoder();

function wrapFrame(frameType: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(out.buffer);
  out[0] = frameType;
  out[1] = 0;
  view.setUint16(2, payload.byteLength, true);
  out.set(payload, 4);
  return out;
}

function buildKind1Payload(channel: string, payload: unknown, login = 200001): Uint8Array {
  const chBytes = encoder.encode(channel);
  const dataBytes = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(22 + chBytes.byteLength + dataBytes.byteLength);
  const view = new DataView(out.buffer);
  out[0] = 1;
  out[1] = 1;
  view.setBigInt64(2, BigInt(login), true);
  view.setBigInt64(10, 1_700_000_000_000n, true);
  view.setUint16(18, chBytes.byteLength, true);
  out.set(chBytes, 20);
  view.setUint16(20 + chBytes.byteLength, dataBytes.byteLength, true);
  out.set(dataBytes, 22 + chBytes.byteLength);
  return out;
}

function buildTickFrame(symbol: string, bid: number, ask: number): Uint8Array {
  const payload = new Uint8Array(2 + BINARY_TICK_RECORD_SIZE);
  const view = new DataView(payload.buffer);
  view.setUint16(0, 1, true);
  for (let i = 0; i < symbol.length && i < 16; i++) {
    payload[2 + i] = symbol.charCodeAt(i);
  }
  view.setBigUint64(2 + 16, 1_700_000_000_000n, true);
  view.setFloat64(2 + 24, bid, true);
  view.setFloat64(2 + 32, ask, true);
  view.setBigUint64(2 + 40, 1n, true);
  return wrapFrame(FRAME_BINARY_TICK_BATCH, payload);
}

type StreamInternals = {
  consumeChunk(chunk: Uint8Array): void;
  accumLen: number;
  boundAccountKey: string | null;
  inFlightAccountKey: string | null;
};

const internals = binaryTcpMarketStream as unknown as StreamInternals;

describe('binaryTcpMarketStream 0x3A Kind 7 dealing bridge & 0x3B replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    useDealingStore.getState().reset();
    streamHarness.activeOrders = 0;
    streamHarness.accountLogin = 200001;
    streamHarness.token = fakeJwt(200001);
    internals.accumLen = 0;
    internals.boundAccountKey = null;
    internals.inFlightAccountKey = null;
  });

  afterEach(() => {
    internals.accumLen = 0;
    internals.boundAccountKey = null;
    internals.inFlightAccountKey = null;
    useDealingStore.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('routes 0x3A EventKind=7 to useDealingStore, skips tradeEventListeners even during in-flight orders, and preserves D10 isExpert', () => {
    const reqId = createMockDealingUuid(0x31);
    const rqId = createMockDealingUuid(0x32);
    const eaReqId = createMockDealingUuid(0x33);
    const eaRqId = createMockDealingUuid(0x34);
    const now = Date.now();

    const kind1Delivered: number[] = [];
    const off = binaryTcpMarketStream.subscribeTradeEvents((ev) => {
      kind1Delivered.push(ev.eventKind);
    });

    const envInDealing = encodeTradeEventKind7Envelope(200001, now, 'dealing.200001', {
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      digits: 5,
      retcode: MT_RET_REQUEST_PLACED,
      seq: 1,
      volume: 1.0,
      price: 1.0845,
      requestId: reqId,
      symbol: 'EURUSD',
      clientOrderId: 'bo-stream-1',
      expiresAtMs: now + 10_000,
      serverNowMs: now,
    });
    expect(decodeBinaryTradeEvent(envInDealing)).toBeNull();

    // Even when a binary order is in flight, 0x3A Kind 7 is routed immediately and never pushed to tradeEventListeners.
    streamHarness.activeOrders = 1;
    internals.consumeChunk(wrapFrame(FRAME_BINARY_TRADE_EVENT, envInDealing));
    expect(useDealingStore.getState().requests[reqId]?.phase).toBe('in_dealing');
    expect(kind1Delivered).toEqual([]);

    // Requoted + filled transitions advance cleanly.
    const envRequoted = encodeTradeEventKind7Envelope(200001, now + 500, 'dealing.200001', {
      status: WIRE_DEALING_STATUS_REQUOTED,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      digits: 5,
      retcode: MT_RET_REQUEST_REQUOTE,
      seq: 2,
      volume: 1.0,
      bid: 1.0848,
      ask: 1.085,
      expiresAtMs: now + 5_500,
      serverNowMs: now + 500,
      requestId: reqId,
      requoteId: rqId,
      symbol: 'EURUSD',
      clientOrderId: 'bo-stream-1',
    });
    internals.consumeChunk(wrapFrame(FRAME_BINARY_TRADE_EVENT, envRequoted));
    expect(useDealingStore.getState().requests[reqId]?.phase).toBe('requoted');
    expect(useDealingStore.getState().activeRequoteId).toBe(reqId);

    const envFilled = encodeTradeEventKind7Envelope(200001, now + 900, 'dealing.200001', {
      status: WIRE_DEALING_STATUS_FILLED,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      digits: 5,
      retcode: MT_RET_REQUEST_DONE,
      seq: 3,
      orderTicket: 7771,
      positionTicket: 7771,
      dealTicket: 7772,
      volume: 1.0,
      price: 1.085,
      requestId: reqId,
      requoteId: rqId,
      symbol: 'EURUSD',
      clientOrderId: 'bo-stream-1',
    });
    internals.consumeChunk(wrapFrame(FRAME_BINARY_TRADE_EVENT, envFilled));
    expect(useDealingStore.getState().requests[reqId]?.phase).toBe('filled');
    expect(useDealingStore.getState().activeRequoteId).toBeNull();

    // D10: An EA order initially marked isExpert=true remains suppressed when follow-up 0x3A Kind 7 arrives.
    ingestDealingEvent({
      requestId: eaReqId,
      clientOrderId: 'ea-stream-1',
      accountLogin: 200001,
      symbol: 'GBPUSD',
      side: 'buy',
      volume: 0.5,
      seq: 1,
      isExpert: true,
      phase: 'in_dealing',
    }, now);
    const eaRequoteEnv = encodeTradeEventKind7Envelope(200001, now + 200, 'dealing.200001', {
      status: WIRE_DEALING_STATUS_REQUOTED,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      digits: 5,
      retcode: MT_RET_REQUEST_REQUOTE,
      seq: 2,
      volume: 0.5,
      bid: 1.25,
      ask: 1.2503,
      expiresAtMs: now + 5_200,
      serverNowMs: now + 200,
      requestId: eaReqId,
      requoteId: eaRqId,
      symbol: 'GBPUSD',
      clientOrderId: 'ea-stream-1',
    });
    internals.consumeChunk(wrapFrame(FRAME_BINARY_TRADE_EVENT, eaRequoteEnv));
    expect(useDealingStore.getState().requests[eaReqId]?.isExpert).toBe(true);
    expect(useDealingStore.getState().requoteQueue).toEqual([]);
    expect(useDealingStore.getState().activeRequoteId).toBeNull();
    off();
  });

  it('drops cross-account or logged-out 0x3A Kind 7 frames and accepts in-flight 0x3B binds', () => {
    const reqOther = createMockDealingUuid(0x35);
    const reqLoggedOut = createMockDealingUuid(0x36);
    const reqInFlight = createMockDealingUuid(0x37);
    const now = Date.now();

    // Cross-account envelope (login 999999 != active 200001) is dropped
    const crossEnv = encodeTradeEventKind7Envelope(999999, now, 'dealing.999999', {
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      seq: 1,
      requestId: reqOther,
      symbol: 'EURUSD',
      clientOrderId: 'bo-other-login',
    });
    internals.consumeChunk(wrapFrame(FRAME_BINARY_TRADE_EVENT, crossEnv));
    expect(useDealingStore.getState().requests[reqOther]).toBeUndefined();

    // Logged out (empty token + no bound/inFlight key) drops Kind 7
    streamHarness.token = '';
    streamHarness.accountLogin = 0;
    const outEnv = encodeTradeEventKind7Envelope(200001, now, 'dealing.200001', {
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      seq: 1,
      requestId: reqLoggedOut,
      symbol: 'EURUSD',
      clientOrderId: 'bo-logged-out',
    });
    internals.consumeChunk(wrapFrame(FRAME_BINARY_TRADE_EVENT, outEnv));
    expect(useDealingStore.getState().requests[reqLoggedOut]).toBeUndefined();

    // In-flight 0x3B account sub key allows replayed Kind 7 to land cleanly while POST is still pending
    internals.inFlightAccountKey = '200001:inflight-jwt';
    const replayEnv = encodeTradeEventKind7Envelope(200001, now, 'dealing.200001', {
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      seq: 1,
      requestId: reqInFlight,
      symbol: 'EURUSD',
      clientOrderId: 'bo-inflight-replay',
    });
    internals.consumeChunk(wrapFrame(FRAME_BINARY_TRADE_EVENT, replayEnv));
    expect(useDealingStore.getState().requests[reqInFlight]?.phase).toBe('in_dealing');
  });

  it('survives malformed Kind 7 frames without breaking subsequent 0x21 ticks or 0x3A Kind 1 frames', () => {
    const badKind7 = new Uint8Array(30);
    badKind7[0] = 1;
    badKind7[1] = 7;
    new DataView(badKind7.buffer).setBigInt64(2, 200001n, true);

    const ticks: string[] = [];
    const trades: number[] = [];
    const offTick = binaryTcpMarketStream.onTick((t) => ticks.push(t.symbol));
    const offTrade = binaryTcpMarketStream.subscribeTradeEvents((e) => trades.push(e.eventKind));

    const combined = new Uint8Array([
      ...wrapFrame(FRAME_BINARY_TRADE_EVENT, badKind7),
      ...buildTickFrame('XAUUSD', 2350.1, 2350.4),
      ...wrapFrame(FRAME_BINARY_TRADE_EVENT, buildKind1Payload('positions.200001', { type: 'position_opened', ticket: 12 })),
    ]);

    expect(() => internals.consumeChunk(combined)).not.toThrow();
    expect(ticks).toEqual(['XAUUSD']);
    expect(trades).toEqual([1]);

    offTick();
    offTrade();
  });

  it('re-POSTs 0x3B account subscription on syncAccountSubscription and ingests replayed Kind 7 frames', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const reqReplay = createMockDealingUuid(0x38);
    const now = Date.now();

    binaryTcpMarketStream.syncAccountSubscription(200001, true);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledWith(
      '/__rtx5_binary_account_sub',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(internals.boundAccountKey).toBe(`200001:${streamHarness.token}`);

    const replayEnv = encodeTradeEventKind7Envelope(200001, now, 'dealing.200001', {
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      seq: 1,
      requestId: reqReplay,
      symbol: 'EURUSD',
      clientOrderId: 'bo-0x3b-replay',
    });
    internals.consumeChunk(wrapFrame(FRAME_BINARY_TRADE_EVENT, replayEnv));
    expect(useDealingStore.getState().requests[reqReplay]?.phase).toBe('in_dealing');
  });

  it('notifies post-subscribe dealing hook only on 0x3B ok and clears advertised capability on disconnect', async () => {
    resetDealingCapabilityState();
    const subscribed: Array<{ accountLogin: number; authToken: string }> = [];
    const unreg = registerDealingAccountSubscribedHook((info) => {
      subscribed.push({ accountLogin: info.accountLogin, authToken: info.authToken });
    });
    try {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
      binaryTcpMarketStream.syncAccountSubscription(200001, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(subscribed).toEqual([{ accountLogin: 200001, authToken: streamHarness.token }]);

      setDealingServerAdvertised(true);
      expect(isDealingServerAdvertised()).toBe(true);
      (binaryTcpMarketStream as unknown as { setConnected: (v: boolean) => void }).setConnected(true);
      (binaryTcpMarketStream as unknown as { setConnected: (v: boolean) => void }).setConnected(false);
      expect(isDealingServerAdvertised()).toBe(false);
    } finally {
      unreg();
      resetDealingCapabilityState();
    }
  });

  it('MAJOR-1: transmits Action 10 sweep-decline over real BinaryTcpMarketStream.setConnected(false) BEFORE closing the wire gate', async () => {
    resetDealingCapabilityState();
    resetDealingSyncProbeState();
    const sentOrders: Uint8Array[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? new Uint8Array(init.body as ArrayBuffer).slice() : new Uint8Array(0);
      if (url === '/__rtx5_binary_order') {
        if (body[1] === WIRE_ACTION_DEALING_SYNC) {
          const syncResp = encodeDealingSyncRespFrame({ dealingEnabled: true });
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => syncResp.buffer.slice(syncResp.byteOffset, syncResp.byteOffset + syncResp.byteLength),
          };
        }
        sentOrders.push(body);
        const decoded = decodeRequoteActionFrame(body);
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
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    });
    vi.stubGlobal('fetch', fetchMock);

    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'web-tcp' };
    (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = { DEALING_BRIDGE_V1: true };
    const streamCtrl = binaryTcpMarketStream as unknown as { setConnected: (v: boolean) => void };
    streamCtrl.setConnected(true);
    setDealingServerAdvertised(true);
    expect(isDealingWireGateOpen()).toBe(true);

    const teardown = installDealingShellRuntime({
      getAccountLogin: () => 200001,
    });
    try {
      const reqId = createMockDealingUuid(0x71);
      const rqId = createMockDealingUuid(0x72);
      const now = Date.now();
      ingestDealingEvent({
        requestId: reqId,
        clientOrderId: 'bo-dc-sweep-1',
        accountLogin: 200001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1.0,
        digits: 5,
        phase: 'requoted',
        requoteId: rqId,
        bid: 1.084,
        ask: 1.0842,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);

      streamCtrl.setConnected(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(isDealingWireGateOpen()).toBe(false);
      expect(sentOrders).toHaveLength(1);
      const decoded = decodeRequoteActionFrame(sentOrders[0]);
      expect(decoded.action).toBe(WIRE_ACTION_REQUOTE_DECLINE);
      expect(decoded.extras.dealingRequestUuid).toBe(reqId);
      expect(decoded.extras.dealingRequoteUuid).toBe(rqId);
      expect(useDealingStore.getState().requests[reqId]?.phase).toBe('cancelled');
    } finally {
      teardown();
      streamCtrl.setConnected(false);
      resetDealingSyncProbeState();
      resetDealingCapabilityState();
      delete (window as unknown as Record<string, unknown>).rtx5Electron;
      delete (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__;
    }
  });

  it('MINOR-2: deduplicates Action 11 on auth:token-updated within the same connectionEpoch and probes again on reconnect', async () => {
    resetDealingCapabilityState();
    resetDealingSyncProbeState();
    let syncCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/__rtx5_binary_order') {
        syncCalls++;
        const syncResp = encodeDealingSyncRespFrame({ dealingEnabled: true });
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => syncResp.buffer.slice(syncResp.byteOffset, syncResp.byteOffset + syncResp.byteLength),
        };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    });
    vi.stubGlobal('fetch', fetchMock);

    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'web-tcp' };
    (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = { DEALING_BRIDGE_V1: true };
    const streamCtrl = binaryTcpMarketStream as unknown as { setConnected: (v: boolean) => void };
    const teardown = installDealingShellRuntime({
      getAccountLogin: () => 200001,
    });
    try {
      streamCtrl.setConnected(true);
      binaryTcpMarketStream.syncAccountSubscription(200001, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(syncCalls).toBe(1);

      // Periodic JWT refresh triggers auth:token-updated -> 0x3B re-POSTs, Action 11 stays deduplicated
      streamHarness.token = `${b64url({ alg: 'none' })}.${b64url({ account_login: 200001, exp: 4_102_445_000 })}.sig`;
      await vi.advanceTimersByTimeAsync(3_000);
      window.dispatchEvent(new Event('auth:token-updated'));
      await vi.advanceTimersByTimeAsync(0);
      expect(syncCalls).toBe(1);

      // Real disconnect + reconnect bumps connectionEpoch -> next 0x3B probes Action 11 once
      streamCtrl.setConnected(false);
      await vi.advanceTimersByTimeAsync(0);
      streamCtrl.setConnected(true);
      binaryTcpMarketStream.syncAccountSubscription(200001, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(syncCalls).toBe(2);
    } finally {
      teardown();
      streamCtrl.setConnected(false);
      resetDealingSyncProbeState();
      resetDealingCapabilityState();
      delete (window as unknown as Record<string, unknown>).rtx5Electron;
      delete (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__;
    }
  });
});
