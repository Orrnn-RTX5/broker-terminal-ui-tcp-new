import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMocks = vi.hoisted(() => ({
  token: 'test-jwt-token',
}));

vi.mock('../../config/backendTarget.js', () => ({
  isDesktopBackendTarget: () => true,
}));

vi.mock('../brokerSession', () => ({
  getAccessToken: () => sessionMocks.token,
  onSessionChange: () => () => {},
}));

import * as binaryTcpOrderClientModule from '../binaryTcpOrderClient';
import {
  __resetBinaryOrderWsForTests,
  BINARY_ORDER_ACTION_CANCEL_PENDING,
  BINARY_ORDER_ACTION_CLOSE_BULK,
  BINARY_ORDER_ACTION_CLOSE_BY,
  BINARY_ORDER_ACTION_CLOSE_POSITION,
  BINARY_ORDER_ACTION_MODIFY_PENDING,
  BINARY_ORDER_ACTION_MODIFY_POSITION,
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_ACTION_PLACE_PENDING,
  BINARY_ORDER_ACTION_REQUOTE_ACCEPT,
  BINARY_ORDER_ACTION_REQUOTE_DECLINE,
  BINARY_ORDER_CLIENT_CAP_DEALING_V1,
  BINARY_ORDER_CODEC_VERSION,
  BINARY_ORDER_ENDPOINT,
  BINARY_ORDER_EXTRA_TAG_CLIENT_CAPS,
  BINARY_ORDER_EXTRA_TAG_COMMENT,
  BINARY_ORDER_EXTRA_TAG_MAGIC,
  BINARY_ORDER_EXTRA_TAG_TRAILING_STEP,
  BINARY_ORDER_EXTRA_TAG_TRAILING_STOP,
  BINARY_ORDER_FLAG_HAS_EXTRAS,
  BINARY_ORDER_SUBTYPE_BUY_LIMIT,
  BinaryTcpOrderError,
  REQ_HEADER_SIZE,
  RESP_HEADER_SIZE,
  WS_FAST_ORDER_FRAME_SIZE,
  WS_REQ_ID_SIZE,
  encodeBinaryOrderReq,
  encodeBinaryOrderWsModeAFrame,
  encodeBinaryOrderWsModeBFrame,
  ensureBinaryOrderWebSocket,
  getActiveBinaryTcpOrderCount,
  sendBinaryTcpOrder,
  syncBinaryOrderAuthToken,
  type BinaryTcpOrderParams,
} from '../binaryTcpOrderClient';
import {
  CLIENT_CAP_DEALING_V1,
  DEALING_KIND_OPEN,
  MT_RET_REQUEST_CANCEL,
  MT_RET_REQUEST_DONE,
  MT_RET_REQUEST_INVALID_EXP,
  MT_RET_REQUEST_NO_MONEY,
  MT_RET_REQUEST_PLACED,
  MT_RET_REQUEST_REQUOTE,
  ORDER_REASON_EXPERT,
  WIRE_ACTION_DEALING_SYNC,
  WIRE_ACTION_PLACE_MARKET,
  WIRE_EXTRA_TAG_REASON,
  WIRE_SIDE_BUY,
  WIRE_STATUS_ACCEPTED,
  WIRE_STATUS_CONFLICT,
  WIRE_STATUS_OK,
  WIRE_STATUS_REJECTED,
  decodeDealingSyncFrame,
  decodeReqExtrasBlock,
  decodeRequoteActionFrame,
  encodeDealingSyncRespFrame,
  encodeOrderRespFrame,
} from './binaryDealingCodec';
import { registerDealingSweepDecline } from './dealingEvents';
import {
  DEALING_SYNC_MIN_INTERVAL_MS,
  WS_FAST_ORDER_WITH_DEALING_CAPS_SIZE,
  createDealingSweepDeclineTransport,
  ingestBinaryOrderRespForDealingIfPresent,
  installDealingOrderClientHooks,
  resetDealingSyncProbeState,
  sendDealingRequoteFrame,
  sendDealingSyncProbe,
  sendRequoteAccept,
  sendRequoteDecline,
} from './dealingOrderClient';
import {
  dealingOrderHooks,
  isDealingServerAdvertised,
  isDealingTransportSupported,
  isDealingWireGateOpen,
  refreshDealingWireGate,
  resetDealingCapabilityState,
  setDealingServerAdvertised,
} from './dealingRuntimeHooks';
import { DealingStatusChip } from '../../components/dealing/DealingStatusChip';
import { RequoteDialog } from '../../components/dealing/RequoteDialog';
import { isDealingTransportTimeoutError } from '../../hooks/useDealingRequest';
import { useDealingStore } from '../../store/useDealingStore';

const FIXED_CLIENT_ORDER_ID = '123e4567-e89b-42d3-a456-426614174000';
const REQ_UUID = '10203040-5060-4780-8090-a0b0c0d0e001';
const RQ_UUID = '10203040-5060-4780-8090-a0b0c0d0e002';
const CAPS_TLV = [BINARY_ORDER_EXTRA_TAG_CLIENT_CAPS, 4, 1, 0, 0, 0] as const;

const BINARY_ORDER_CLIENT_EXPORTS = binaryTcpOrderClientModule as Record<string, unknown>;
// In releases without the client reason TLV (0x06), D10 in the web terminal relies on D4: only
// clients that advertise 0x16 are ever queued, and the desktop bridge never sends 0x16 (D18).
// The wire-level EA check (it.skipIf below) re-activates automatically once the reason TLV is on main.
const HAS_CLIENT_REASON_TLV_SUPPORT =
  typeof BINARY_ORDER_CLIENT_EXPORTS.ORDER_REASON_EXPERT === 'number'
  && typeof BINARY_ORDER_CLIENT_EXPORTS.BINARY_ORDER_EXTRA_TAG_REASON === 'number';

type BinaryTcpOrderParamsWithOptionalReason = BinaryTcpOrderParams & { reason?: number };

function withOptionalExpertReason(
  params: BinaryTcpOrderParams,
): BinaryTcpOrderParamsWithOptionalReason {
  return HAS_CLIENT_REASON_TLV_SUPPORT ? { ...params, reason: ORDER_REASON_EXPERT } : params;
}

type FrameTransportMode = 'ws-mode-a' | 'ws-mode-b' | 'http';

/**
 * Strips ONLY the trailing 6-byte capability TLV `0x16` (`[0x16, 4, 1, 0, 0, 0]`) from an order
 * frame produced by `sendBinaryTcpOrder` so we can assert byte-for-byte identity with pre-0x16 frames.
 */
function stripClientCaps0x16FromOrderFrame(
  frame: Uint8Array,
  mode: FrameTransportMode,
): Uint8Array {
  const headerStart = mode === 'http' ? 0 : WS_REQ_ID_SIZE;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const flags = view.getUint16(headerStart + 4, true);
  expect(flags & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(BINARY_ORDER_FLAG_HAS_EXTRAS);

  let extrasOffset = headerStart + REQ_HEADER_SIZE;
  if (mode !== 'ws-mode-a') {
    const tokenLen = view.getUint16(extrasOffset, true);
    extrasOffset += 2 + tokenLen;
  }

  const extrasLen = view.getUint16(extrasOffset, true);
  expect(frame.byteLength).toBe(extrasOffset + 2 + extrasLen);
  expect(Array.from(frame.subarray(frame.byteLength - 6))).toEqual([...CAPS_TLV]);

  if (extrasLen === 6) {
    const stripped = new Uint8Array(extrasOffset);
    stripped.set(frame.subarray(0, extrasOffset));
    new DataView(stripped.buffer, stripped.byteOffset, stripped.byteLength).setUint16(
      headerStart + 4,
      flags & ~BINARY_ORDER_FLAG_HAS_EXTRAS,
      true,
    );
    return stripped;
  }

  const stripped = new Uint8Array(frame.byteLength - 6);
  stripped.set(frame.subarray(0, frame.byteLength - 6));
  new DataView(stripped.buffer, stripped.byteOffset, stripped.byteLength).setUint16(
    extrasOffset,
    extrasLen - 6,
    true,
  );
  return stripped;
}

function buildOkRespBytes(action: number, clientOrderId = FIXED_CLIENT_ORDER_ID): Uint8Array {
  const buf = new ArrayBuffer(RESP_HEADER_SIZE);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes[0] = BINARY_ORDER_CODEC_VERSION;
  bytes[1] = action;
  view.setUint16(2, 200, true);
  view.setUint32(4, 180, true);
  view.setBigInt64(8, 5001n, true);
  view.setBigInt64(16, 7001n, true);
  view.setBigInt64(24, 9001n, true);
  view.setFloat64(32, 1.0845, true);
  view.setFloat64(40, 0.1, true);
  const coidBytes = new TextEncoder().encode(clientOrderId);
  bytes.set(coidBytes.subarray(0, 40), 96);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function wrapWsResp(reqId: number, respBytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(WS_REQ_ID_SIZE + respBytes.byteLength);
  const out = new Uint8Array(buf);
  new DataView(buf).setUint32(0, reqId >>> 0, true);
  out.set(respBytes, WS_REQ_ID_SIZE);
  return buf;
}

class MockOrderWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockOrderWebSocket.OPEN;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sentFrames: Uint8Array[] = [];
  private responder: (reqId: number, frame: Uint8Array, ws: MockOrderWebSocket) => void;

  constructor(
    public url: string,
    responder?: (reqId: number, frame: Uint8Array, ws: MockOrderWebSocket) => void,
  ) {
    this.responder = responder ?? ((reqId, frame, ws) => {
      if (reqId === 0) return;
      ws.onmessage?.({ data: wrapWsResp(reqId, buildOkRespBytes(frame[5])) });
    });
  }

  send = vi.fn((raw: Uint8Array | ArrayBuffer) => {
    const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const copy = src.slice();
    this.sentFrames.push(copy);
    const reqId = new DataView(copy.buffer, copy.byteOffset, copy.byteLength).getUint32(0, true);
    if (reqId === 0) return;
    this.responder(reqId, copy, this);
  });

  close = vi.fn(() => {
    this.readyState = MockOrderWebSocket.CLOSED;
  });
}

describe('dealingOrderClient (0x16 capability, 0x39 dealing replies, Actions 9/10)', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    sessionMocks.token = 'test-jwt-token';
    installDealingOrderClientHooks();
    resetDealingSyncProbeState();
    __resetBinaryOrderWsForTests();
    useDealingStore.getState().reset();
    delete (window as unknown as Record<string, unknown>).rtx5Electron;
    delete (window as unknown as Record<string, unknown>).electronAPI;
    delete (window as unknown as Record<string, unknown>).electron;
    (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = {
      BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
    };
  });

  afterEach(() => {
    resetDealingSyncProbeState();
    resetDealingCapabilityState();
    __resetBinaryOrderWsForTests();
    useDealingStore.getState().reset();
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    delete (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__;
    delete (window as unknown as Record<string, unknown>).rtx5Electron;
    delete (window as unknown as Record<string, unknown>).electronAPI;
    delete (window as unknown as Record<string, unknown>).electron;
    vi.restoreAllMocks();
  });

  function enableDealingGateForTest(): void {
    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'web-tcp' };
    (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = {
      BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
      DEALING_BRIDGE_V1: true,
    };
    setDealingServerAdvertised(true);
  }

  it('sends 132B byte-identical pre-dealing frames when gate is off, and appends TLV 0x16 across WS/HTTP only when gate is open', async () => {
    const cases: Array<{ name: string; params: BinaryTcpOrderParamsWithOptionalReason }> = [
      {
        name: 'action 1 plain market',
        params: {
          action: BINARY_ORDER_ACTION_PLACE_MARKET,
          accountLogin: 100042,
          symbol: 'EURUSD',
          side: 'BUY',
          volume: 0.25,
          clientOrderId: FIXED_CLIENT_ORDER_ID,
          authToken: 'test-jwt-token',
        },
      },
      {
        name: 'action 1 market with comment+magic+trailing+EA reason',
        params: withOptionalExpertReason({
          action: BINARY_ORDER_ACTION_PLACE_MARKET,
          accountLogin: 100042,
          symbol: 'EURUSD',
          side: 'SELL',
          volume: 0.5,
          comment: 'bot-v2',
          magic: 77,
          trailingStop: 40,
          trailingStep: 5,
          clientOrderId: FIXED_CLIENT_ORDER_ID,
          authToken: 'test-jwt-token',
        }),
      },
      {
        name: 'action 2 close position with EA reason',
        params: withOptionalExpertReason({
          action: BINARY_ORDER_ACTION_CLOSE_POSITION,
          accountLogin: 100042,
          ticket: 77001,
          volume: 0.1,
          clientOrderId: FIXED_CLIENT_ORDER_ID,
          authToken: 'test-jwt-token',
        }),
      },
      {
        name: 'action 3 modify position trailing',
        params: {
          action: BINARY_ORDER_ACTION_MODIFY_POSITION,
          accountLogin: 100042,
          ticket: 77001,
          sl: 1.08,
          tp: 1.1,
          trailingStop: 25,
          clientOrderId: FIXED_CLIENT_ORDER_ID,
          authToken: 'test-jwt-token',
        },
      },
      {
        name: 'action 4 place pending with comment',
        params: {
          action: BINARY_ORDER_ACTION_PLACE_PENDING,
          accountLogin: 100042,
          symbol: 'XAUUSD',
          orderSubType: BINARY_ORDER_SUBTYPE_BUY_LIMIT,
          volume: 0.2,
          price: 2300.5,
          comment: 'pending-note',
          clientOrderId: FIXED_CLIENT_ORDER_ID,
          authToken: 'test-jwt-token',
        },
      },
      {
        name: 'action 5 modify pending',
        params: {
          action: BINARY_ORDER_ACTION_MODIFY_PENDING,
          accountLogin: 100042,
          ticket: 88001,
          price: 2305.0,
          magic: 99,
          clientOrderId: FIXED_CLIENT_ORDER_ID,
          authToken: 'test-jwt-token',
        },
      },
      {
        name: 'action 6 cancel pending',
        params: {
          action: BINARY_ORDER_ACTION_CANCEL_PENDING,
          accountLogin: 100042,
          ticket: 88001,
          clientOrderId: FIXED_CLIENT_ORDER_ID,
          authToken: 'test-jwt-token',
        },
      },
      {
        name: 'action 7 close bulk',
        params: {
          action: BINARY_ORDER_ACTION_CLOSE_BULK,
          accountLogin: 100042,
          orderSubType: 0,
          clientOrderId: FIXED_CLIENT_ORDER_ID,
          authToken: 'test-jwt-token',
        },
      },
      {
        name: 'action 8 close by',
        params: {
          action: BINARY_ORDER_ACTION_CLOSE_BY,
          accountLogin: 100042,
          ticket: 77001,
          otherTicket: 77002,
          clientOrderId: FIXED_CLIENT_ORDER_ID,
          authToken: 'test-jwt-token',
        },
      },
    ];

    // 0. Gate OFF (including desktop clientcore bridge): frames are byte-identical to pre-dealing HEAD
    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'win32' };
    refreshDealingWireGate();
    expect(isDealingTransportSupported()).toBe(false);
    expect(isDealingWireGateOpen()).toBe(false);

    globalThis.WebSocket = MockOrderWebSocket as unknown as typeof WebSocket;

    let activeWs = ensureBinaryOrderWebSocket() as unknown as MockOrderWebSocket;
    syncBinaryOrderAuthToken('test-jwt-token');

    for (const tc of cases) {
      activeWs.sentFrames.length = 0;
      await sendBinaryTcpOrder(tc.params);
      const sent = activeWs.sentFrames.find((f) => new DataView(f.buffer, f.byteOffset, 4).getUint32(0, true) !== 0)!;
      const reqId = new DataView(sent.buffer, sent.byteOffset, 4).getUint32(0, true);
      const baseline = encodeBinaryOrderWsModeAFrame(reqId, tc.params);
      expect(Array.from(sent), `gate-off ws-mode-a: ${tc.name}`).toEqual(Array.from(baseline));
      if (!tc.params.comment && !tc.params.magic && !tc.params.trailingStop && !tc.params.reason) {
        expect(sent.byteLength, `gate-off 132B: ${tc.name}`).toBe(WS_FAST_ORDER_FRAME_SIZE);
      }
    }

    // 1. Gate ON (web-tcp + DEALING_BRIDGE_V1 + server 0x2A=1): WS Mode A appends TLV 0x16
    enableDealingGateForTest();
    expect(isDealingWireGateOpen()).toBe(true);
    __resetBinaryOrderWsForTests();
    enableDealingGateForTest();
    activeWs = ensureBinaryOrderWebSocket() as unknown as MockOrderWebSocket;
    syncBinaryOrderAuthToken('test-jwt-token');

    for (const tc of cases) {
      activeWs.sentFrames.length = 0;
      await sendBinaryTcpOrder(tc.params);
      const orderFrames = activeWs.sentFrames.filter((f) => new DataView(f.buffer, f.byteOffset, 4).getUint32(0, true) !== 0);
      expect(orderFrames, tc.name).toHaveLength(1);
      const sent = orderFrames[0];
      const reqId = new DataView(sent.buffer, sent.byteOffset, 4).getUint32(0, true);

      const { extras } = decodeReqExtrasBlock(sent, WS_FAST_ORDER_FRAME_SIZE);
      expect(extras.hasClientCaps, tc.name).toBe(true);
      expect(extras.clientCaps, tc.name).toBe(BINARY_ORDER_CLIENT_CAP_DEALING_V1);
      expect(extras.clientCaps, tc.name).toBe(CLIENT_CAP_DEALING_V1);
      expect(extras.hasDealingCap, tc.name).toBe(true);
      if (HAS_CLIENT_REASON_TLV_SUPPORT && tc.params.reason === ORDER_REASON_EXPERT) {
        expect(extras.isExpert, tc.name).toBe(true);
      }

      if (!tc.params.comment && !tc.params.magic && !tc.params.trailingStop && !tc.params.reason) {
        expect(sent.byteLength, tc.name).toBe(WS_FAST_ORDER_WITH_DEALING_CAPS_SIZE);
        expect(Array.from(sent.subarray(132)), tc.name).toEqual([6, 0, ...CAPS_TLV]);
      }

      const stripped = stripClientCaps0x16FromOrderFrame(sent, 'ws-mode-a');
      const baseline = encodeBinaryOrderWsModeAFrame(reqId, tc.params);
      expect(Array.from(stripped), `ws-mode-a strip-compare: ${tc.name}`).toEqual(Array.from(baseline));
    }

    // 2. WS Mode B (inline token, before auth prebind)
    for (const [idx, tc] of cases.entries()) {
      __resetBinaryOrderWsForTests();
      enableDealingGateForTest();
      activeWs = ensureBinaryOrderWebSocket() as unknown as MockOrderWebSocket;
      activeWs.sentFrames.length = 0;
      const modeBParams: BinaryTcpOrderParams = { ...tc.params, authToken: `inline-tok-${idx}` };
      await sendBinaryTcpOrder(modeBParams);
      const sent = activeWs.sentFrames.find((f) => new DataView(f.buffer, f.byteOffset, 4).getUint32(0, true) !== 0)!;
      const reqId = new DataView(sent.buffer, sent.byteOffset, 4).getUint32(0, true);
      const tokenLen = new DataView(sent.buffer, sent.byteOffset, sent.byteLength).getUint16(WS_FAST_ORDER_FRAME_SIZE, true);
      const { extras } = decodeReqExtrasBlock(sent, WS_FAST_ORDER_FRAME_SIZE + 2 + tokenLen);
      expect(extras.hasDealingCap, `ws-mode-b ${tc.name}`).toBe(true);

      const stripped = stripClientCaps0x16FromOrderFrame(sent, 'ws-mode-b');
      const baseline = encodeBinaryOrderWsModeBFrame(reqId, modeBParams);
      expect(Array.from(stripped), `ws-mode-b strip-compare: ${tc.name}`).toEqual(Array.from(baseline));
    }

    // 3. HTTP POST fallback (WS closed)
    __resetBinaryOrderWsForTests();
    enableDealingGateForTest();
    globalThis.WebSocket = class ClosedWs {
      readyState = 3;
      binaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();
    } as unknown as typeof WebSocket;

    for (const tc of cases) {
      let capturedBody!: Uint8Array;
      globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = new Uint8Array(init?.body as ArrayBuffer).slice();
        return new Response(toArrayBuffer(buildOkRespBytes(tc.params.action)), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }) as unknown as typeof fetch;

      await sendBinaryTcpOrder(tc.params);
      const tokenLen = new DataView(capturedBody.buffer).getUint16(REQ_HEADER_SIZE, true);
      const { extras } = decodeReqExtrasBlock(capturedBody, REQ_HEADER_SIZE + 2 + tokenLen);
      expect(extras.hasDealingCap, `http ${tc.name}`).toBe(true);

      // Verify exact TLV tag order: 0x01, 0x02, 0x03, 0x04[, 0x06], 0x16 (0x16 strictly last)
      if (tc.params.comment && tc.params.magic && tc.params.trailingStop && tc.params.trailingStep) {
        const extrasStart = REQ_HEADER_SIZE + 2 + tokenLen + 2;
        const tags: number[] = [];
        let p = extrasStart;
        while (p < capturedBody.byteLength) {
          tags.push(capturedBody[p]);
          p += 2 + capturedBody[p + 1];
        }
        const expectedTags = HAS_CLIENT_REASON_TLV_SUPPORT
          ? [
              BINARY_ORDER_EXTRA_TAG_COMMENT,
              BINARY_ORDER_EXTRA_TAG_MAGIC,
              BINARY_ORDER_EXTRA_TAG_TRAILING_STOP,
              BINARY_ORDER_EXTRA_TAG_TRAILING_STEP,
              WIRE_EXTRA_TAG_REASON,
              BINARY_ORDER_EXTRA_TAG_CLIENT_CAPS,
            ]
          : [
              BINARY_ORDER_EXTRA_TAG_COMMENT,
              BINARY_ORDER_EXTRA_TAG_MAGIC,
              BINARY_ORDER_EXTRA_TAG_TRAILING_STOP,
              BINARY_ORDER_EXTRA_TAG_TRAILING_STEP,
              BINARY_ORDER_EXTRA_TAG_CLIENT_CAPS,
            ];
        expect(tags).toEqual(expectedTags);
      }

      const stripped = stripClientCaps0x16FromOrderFrame(capturedBody, 'http');
      const baseline = encodeBinaryOrderReq(tc.params).packet;
      expect(Array.from(stripped), `http strip-compare: ${tc.name}`).toEqual(Array.from(baseline));
    }
  });

  it('preserves TLV 0x16 on WS AUTH_TOKEN_REQUIRED inline-token retry', async () => {
    enableDealingGateForTest();
    let attempt = 0;
    const retryBodies: Uint8Array[] = [];

    globalThis.WebSocket = class extends MockOrderWebSocket {
      constructor(url: string) {
        super(url, (reqId, frame, ws) => {
          attempt++;
          retryBodies.push(frame);
          if (attempt === 1) {
            const resp = encodeOrderRespFrame({
              action: BINARY_ORDER_ACTION_PLACE_MARKET,
              status: 401,
              errorCode: 'AUTH_TOKEN_REQUIRED',
              message: 'Bind token first',
              clientOrderId: FIXED_CLIENT_ORDER_ID,
            });
            ws.onmessage?.({ data: wrapWsResp(reqId, resp) });
            return;
          }
          ws.onmessage?.({ data: wrapWsResp(reqId, buildOkRespBytes(BINARY_ORDER_ACTION_PLACE_MARKET)) });
        });
      }
    } as unknown as typeof WebSocket;

    const wsInstance = ensureBinaryOrderWebSocket();
    syncBinaryOrderAuthToken('test-jwt-token');
    expect(wsInstance).not.toBeNull();

    const resp = await sendBinaryTcpOrder({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.1,
      clientOrderId: FIXED_CLIENT_ORDER_ID,
    });
    expect(resp.ok).toBe(true);
    expect(attempt).toBe(2);
    expect(retryBodies[0].byteLength).toBe(WS_FAST_ORDER_WITH_DEALING_CAPS_SIZE);

    const retryFrame = retryBodies[1];
    const tokenLen = new DataView(retryFrame.buffer).getUint16(WS_FAST_ORDER_FRAME_SIZE, true);
    const { extras } = decodeReqExtrasBlock(retryFrame, WS_FAST_ORDER_FRAME_SIZE + 2 + tokenLen);
    expect(extras.hasDealingCap).toBe(true);
  });

  it('handles 0x39 dealing replies (10008 IN_DEALING, 10004 robot requote, EA suppression, 409/422 dealing errors) and ignores normal 200/422', async () => {
    const now = 1_795_180_995_000;
    let nextReply!: Uint8Array;

    globalThis.WebSocket = class extends MockOrderWebSocket {
      constructor(url: string) {
        super(url, (reqId, _frame, ws) => {
          ws.onmessage?.({ data: wrapWsResp(reqId, nextReply) });
        });
      }
    } as unknown as typeof WebSocket;

    ensureBinaryOrderWebSocket();
    syncBinaryOrderAuthToken('test-jwt-token');

    // 1. Normal 200 OK -> leaves useDealingStore empty (0 dealing records)
    nextReply = buildOkRespBytes(BINARY_ORDER_ACTION_PLACE_MARKET, 'bo-plain-ok');
    const okResp = await sendBinaryTcpOrder({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.1,
      clientOrderId: 'bo-plain-ok',
    });
    expect(okResp.status).toBe(200);
    expect(Object.keys(useDealingStore.getState().requests)).toHaveLength(0);

    // 2. Ordinary 422 NO_MONEY without dealing UUID -> throws BinaryTcpOrderError & leaves store empty
    nextReply = encodeOrderRespFrame({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      status: WIRE_STATUS_REJECTED,
      symbol: 'EURUSD',
      clientOrderId: 'bo-plain-422',
      errorCode: 'NO_MONEY',
      message: 'Insufficient margin',
      execWire: { retcode: MT_RET_REQUEST_NO_MONEY, quotedReqId: 0 },
    });
    await expect(
      sendBinaryTcpOrder({
        action: BINARY_ORDER_ACTION_PLACE_MARKET,
        accountLogin: 100042,
        symbol: 'EURUSD',
        side: 'BUY',
        volume: 50,
        clientOrderId: 'bo-plain-422',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'NO_MONEY' });
    expect(Object.keys(useDealingStore.getState().requests)).toHaveLength(0);

    // 3. 202 + 10008 IN_DEALING -> resolves with 202 AND feeds useDealingStore + <DealingStatusChip />
    nextReply = encodeOrderRespFrame({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      status: WIRE_STATUS_ACCEPTED,
      symbol: 'EURUSD',
      clientOrderId: 'bo-dealing-10008',
      volume: 0.5,
      errorCode: 'IN_DEALING',
      message: 'Request placed in dealing queue',
      execWire: {
        retcode: MT_RET_REQUEST_PLACED,
        quotedReqId: 0,
        dealerBid: 1.0845,
        dealerAsk: 1.0846,
        requestId: REQ_UUID,
        expiresAtMs: now + 10_000,
        serverNowMs: now,
        dealingKind: DEALING_KIND_OPEN,
        digits: 5,
        hasDigits: true,
      },
    });
    const acceptedResp = await sendBinaryTcpOrder({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.5,
      clientOrderId: 'bo-dealing-10008',
    });
    expect(acceptedResp.status).toBe(202);
    expect(acceptedResp.orderTicket).toBe(0);

    const rec10008 = useDealingStore.getState().requests[REQ_UUID];
    expect(rec10008).toBeDefined();
    expect(rec10008.phase).toBe('in_dealing');
    expect(rec10008.retcode).toBe(MT_RET_REQUEST_PLACED);
    expect(rec10008.digits).toBe(5);
    expect(useDealingStore.getState().byClientOrderId['bo-dealing-10008']).toBe(REQ_UUID);

    const { unmount: unmountChip } = render(<DealingStatusChip clientOrderId="bo-dealing-10008" />);
    expect(screen.getByText('Request sent to dealer…').textContent).toBe('Request sent to dealer…');
    unmountChip();

    // 4. 202 + 10004 Robot Requote for EA order (TLV 0x06 ORDER_REASON_EXPERT) -> D10 suppresses modal
    const eaReqId = '10203040-5060-4780-8090-a0b0c0d0e009';
    const eaRqId = '10203040-5060-4780-8090-a0b0c0d0e00a';
    const eaReply = encodeOrderRespFrame({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      status: WIRE_STATUS_ACCEPTED,
      symbol: 'GBPUSD',
      clientOrderId: 'bo-ea-requote',
      volume: 0.3,
      errorCode: 'DEALER_REQUOTE',
      message: 'Robot requote',
      execWire: {
        retcode: MT_RET_REQUEST_REQUOTE,
        quotedReqId: 0,
        dealerBid: 1.254,
        dealerAsk: 1.2543,
        requestId: eaReqId,
        requoteId: eaRqId,
        expiresAtMs: Date.now() + 5_000,
        serverNowMs: Date.now(),
        dealingKind: DEALING_KIND_OPEN,
        digits: 5,
        hasDigits: true,
      },
    });
    ingestBinaryOrderRespForDealingIfPresent(
      toArrayBuffer(eaReply),
      0,
      { action: WIRE_ACTION_PLACE_MARKET, status: WIRE_STATUS_ACCEPTED, clientOrderId: 'bo-ea-requote' },
      {
        action: WIRE_ACTION_PLACE_MARKET,
        side: WIRE_SIDE_BUY,
        login: 100042,
        volume: 0.3,
        price: 0,
        sl: 0,
        tp: 0,
        extrasBytes: new Uint8Array([WIRE_EXTRA_TAG_REASON, 1, ORDER_REASON_EXPERT]),
      },
      'bo-ea-requote',
    );
    expect(useDealingStore.getState().requests[eaReqId].isExpert).toBe(true);
    expect(useDealingStore.getState().activeRequoteId).toBeNull();

    // 5. Dealing 409 REQUOTE_EXPIRED via HTTP fallback updates store AND rejects promise
    __resetBinaryOrderWsForTests();
    enableDealingGateForTest();
    globalThis.WebSocket = class ClosedWs {
      readyState = 3;
      send = vi.fn();
      close = vi.fn();
    } as unknown as typeof WebSocket;

    const expReqId = '10203040-5060-4780-8090-a0b0c0d0e00b';
    const httpExpired = encodeOrderRespFrame({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      status: WIRE_STATUS_CONFLICT,
      symbol: 'USDJPY',
      clientOrderId: 'bo-http-409',
      errorCode: 'REQUOTE_EXPIRED',
      message: 'Requote window expired',
      execWire: {
        retcode: MT_RET_REQUEST_INVALID_EXP,
        quotedReqId: 0,
        requestId: expReqId,
      },
    });
    globalThis.fetch = vi.fn(async () => new Response(toArrayBuffer(httpExpired), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })) as unknown as typeof fetch;

    await expect(
      sendBinaryTcpOrder({
        action: BINARY_ORDER_ACTION_PLACE_MARKET,
        accountLogin: 100042,
        symbol: 'USDJPY',
        side: 'BUY',
        volume: 0.1,
        clientOrderId: 'bo-http-409',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'REQUOTE_EXPIRED' });
    expect(useDealingStore.getState().requests[expReqId]?.phase).toBe('expired');
  });

  it.skipIf(!HAS_CLIENT_REASON_TLV_SUPPORT)(
    'D10 wire path: EA reason TLV 0x06 is sent and suppresses the dealing modal (skipped until the client reason TLV ships)',
    async () => {
      const eaReqIdWs = '10203040-5060-4780-8090-a0b0c0d0e00c';
      const eaRqIdWs = '10203040-5060-4780-8090-a0b0c0d0e00d';
      const nextReply = encodeOrderRespFrame({
        action: BINARY_ORDER_ACTION_PLACE_MARKET,
        status: WIRE_STATUS_ACCEPTED,
        symbol: 'GBPUSD',
        clientOrderId: 'bo-ea-requote-ws',
        volume: 0.3,
        errorCode: 'DEALER_REQUOTE',
        message: 'Robot requote',
        execWire: {
          retcode: MT_RET_REQUEST_REQUOTE,
          quotedReqId: 0,
          dealerBid: 1.254,
          dealerAsk: 1.2543,
          requestId: eaReqIdWs,
          requoteId: eaRqIdWs,
          expiresAtMs: Date.now() + 5_000,
          serverNowMs: Date.now(),
          dealingKind: DEALING_KIND_OPEN,
          digits: 5,
          hasDigits: true,
        },
      });
      globalThis.WebSocket = class extends MockOrderWebSocket {
        constructor(url: string) {
          super(url, (reqId, _frame, ws) => {
            ws.onmessage?.({ data: wrapWsResp(reqId, nextReply) });
          });
        }
      } as unknown as typeof WebSocket;

      ensureBinaryOrderWebSocket();
      syncBinaryOrderAuthToken('test-jwt-token');

      const eaWsParams: BinaryTcpOrderParamsWithOptionalReason = {
        action: BINARY_ORDER_ACTION_PLACE_MARKET,
        accountLogin: 100042,
        symbol: 'GBPUSD',
        side: 'BUY',
        volume: 0.3,
        reason: ORDER_REASON_EXPERT,
        clientOrderId: 'bo-ea-requote-ws',
      };
      await sendBinaryTcpOrder(eaWsParams);
      expect(useDealingStore.getState().requests[eaReqIdWs].isExpert).toBe(true);
      expect(useDealingStore.getState().activeRequoteId).toBeNull();
    },
  );

  it('exports Action 9/10 senders and integrates cleanly with <RequoteDialog /> and registerDealingSweepDecline', async () => {
    enableDealingGateForTest();
    const user = userEvent.setup();
    const now = Date.now();
    let wsHandler!: (reqId: number, frame: Uint8Array, ws: MockOrderWebSocket) => void;

    globalThis.WebSocket = class extends MockOrderWebSocket {
      constructor(url: string) {
        super(url, (reqId, frame, ws) => wsHandler(reqId, frame, ws));
      }
    } as unknown as typeof WebSocket;

    sessionMocks.token = 'jwt-requote-test';
    ensureBinaryOrderWebSocket();
    syncBinaryOrderAuthToken('jwt-requote-test');

    // A. Seed requoted entry -> render <RequoteDialog sendRequoteFrame={sendDealingRequoteFrame} /> -> click Accept
    useDealingStore.getState().applyEvent({
      requestId: REQ_UUID,
      clientOrderId: 'bo-dlg-accept',
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      wireSide: WIRE_SIDE_BUY,
      digits: 5,
      volume: 1.5,
      bid: 1.0845,
      ask: 1.08465,
      seq: 2,
      phase: 'requoted',
      requoteId: RQ_UUID,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    let capturedAcceptFrame: Uint8Array | null = null;
    wsHandler = (reqId, frame, ws) => {
      capturedAcceptFrame = frame;
      const resp = encodeOrderRespFrame({
        action: BINARY_ORDER_ACTION_REQUOTE_ACCEPT,
        status: WIRE_STATUS_OK,
        orderTicket: 99001,
        positionTicket: 99001,
        dealTicket: 99002,
        fillPrice: 1.08465,
        volume: 1.5,
        symbol: 'EURUSD',
        clientOrderId: 'bo-dlg-accept',
        execWire: {
          retcode: MT_RET_REQUEST_DONE,
          quotedReqId: 0,
          requestId: REQ_UUID,
          requoteId: RQ_UUID,
        },
      });
      ws.onmessage?.({ data: wrapWsResp(reqId, resp) });
    };

    const { unmount } = render(<RequoteDialog sendRequoteFrame={sendDealingRequoteFrame} />);
    await user.click(screen.getByRole('button', { name: /Accept @ 1\.08465/ }));

    expect(capturedAcceptFrame).not.toBeNull();
    const decodedAccept = decodeRequoteActionFrame(capturedAcceptFrame!.subarray(WS_REQ_ID_SIZE));
    expect(decodedAccept.action).toBe(BINARY_ORDER_ACTION_REQUOTE_ACCEPT);
    expect(decodedAccept.ticket).toBe(0);
    expect(decodedAccept.expiration).toBe(0);
    expect(decodedAccept.price).toBe(1.08465);
    expect(decodedAccept.authToken).toBe('jwt-requote-test');
    expect(decodedAccept.extras.dealingRequestUuid).toBe(REQ_UUID);
    expect(decodedAccept.extras.dealingRequoteUuid).toBe(RQ_UUID);
    expect(decodedAccept.extras.hasDealingCap).toBe(true);
    expect(useDealingStore.getState().requests[REQ_UUID]?.phase).toBe('filled');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    unmount();

    // B. Direct sendRequoteAccept / sendRequoteDecline over WS and HTTP fallback (422 MARGIN_RECHECK_FAILED + 200 CLIENT_DECLINED)
    const req2 = '10203040-5060-4780-8090-a0b0c0d0e011';
    const rq2 = '10203040-5060-4780-8090-a0b0c0d0e012';
    useDealingStore.getState().applyEvent({
      requestId: req2,
      clientOrderId: 'bo-direct-acc',
      accountLogin: 100042,
      symbol: 'XAUUSD',
      side: 'buy',
      wireSide: WIRE_SIDE_BUY,
      digits: 2,
      volume: 10,
      bid: 2350.0,
      ask: 2350.5,
      seq: 2,
      phase: 'requoted',
      requoteId: rq2,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    wsHandler = (reqId, _frame, ws) => {
      ws.onmessage?.({
        data: wrapWsResp(
          reqId,
          encodeOrderRespFrame({
            action: BINARY_ORDER_ACTION_REQUOTE_ACCEPT,
            status: WIRE_STATUS_REJECTED,
            symbol: 'XAUUSD',
            clientOrderId: 'bo-direct-acc',
            errorCode: 'MARGIN_RECHECK_FAILED',
            message: 'Insufficient free margin',
            execWire: { retcode: MT_RET_REQUEST_NO_MONEY, requestId: req2, requoteId: rq2 },
          }),
        ),
      });
    };

    const marginResp = await sendRequoteAccept({
      accountLogin: 100042,
      side: WIRE_SIDE_BUY,
      volume: 10,
      price: 2350.5,
      symbol: 'XAUUSD',
      clientOrderId: 'bo-direct-acc',
      requestId: req2,
      requoteId: rq2,
    });
    expect(marginResp.status).toBe(422);
    expect(marginResp.errorCode).toBe('MARGIN_RECHECK_FAILED');
    expect(useDealingStore.getState().requests[req2]?.phase).toBe('rejected');

    // C. HTTP fallback for sendRequoteDecline + registerDealingSweepDecline
    __resetBinaryOrderWsForTests();
    enableDealingGateForTest();
    globalThis.WebSocket = class ClosedWs {
      readyState = 3;
      send = vi.fn();
      close = vi.fn();
    } as unknown as typeof WebSocket;

    const req3 = '10203040-5060-4780-8090-a0b0c0d0e013';
    const rq3 = '10203040-5060-4780-8090-a0b0c0d0e014';
    useDealingStore.getState().applyEvent({
      requestId: req3,
      clientOrderId: 'bo-direct-dec',
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      wireSide: WIRE_SIDE_BUY,
      digits: 5,
      volume: 1,
      bid: 1.084,
      ask: 1.0842,
      seq: 2,
      phase: 'requoted',
      requoteId: rq3,
      expiresAtMs: now + 5_000,
      serverNowMs: now,
    }, now);

    const httpFrames: Uint8Array[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(BINARY_ORDER_ENDPOINT);
      httpFrames.push(new Uint8Array(init?.body as ArrayBuffer).slice());
      const decoded = decodeRequoteActionFrame(httpFrames[httpFrames.length - 1]);
      return new Response(
        toArrayBuffer(
          encodeOrderRespFrame({
            action: BINARY_ORDER_ACTION_REQUOTE_DECLINE,
            status: WIRE_STATUS_OK,
            symbol: decoded.symbol,
            clientOrderId: decoded.clientOrderId,
            errorCode: 'CLIENT_DECLINED',
            execWire: {
              retcode: MT_RET_REQUEST_CANCEL,
              requestId: decoded.extras.dealingRequestUuid,
              requoteId: decoded.extras.dealingRequoteUuid,
            },
          }),
        ),
        { status: 200, headers: { 'Content-Type': 'application/octet-stream' } },
      );
    }) as unknown as typeof fetch;

    const declineResp = await sendRequoteDecline({
      accountLogin: 100042,
      side: WIRE_SIDE_BUY,
      volume: 1,
      symbol: 'EURUSD',
      clientOrderId: 'bo-direct-dec',
      requestId: req3,
      requoteId: rq3,
    });
    expect(declineResp.ok).toBe(true);
    expect(useDealingStore.getState().requests[req3]?.phase).toBe('cancelled');
    const decodedHttpDec = decodeRequoteActionFrame(httpFrames[0]);
    expect(decodedHttpDec.action).toBe(BINARY_ORDER_ACTION_REQUOTE_DECLINE);
    expect(decodedHttpDec.price).toBe(0);
    expect(decodedHttpDec.ticket).toBe(0);
    expect(decodedHttpDec.expiration).toBe(0);
    expect(decodedHttpDec.extras.dealingRequestUuid).toBe(req3);
    expect(decodedHttpDec.extras.dealingRequoteUuid).toBe(rq3);

    // D. Sweep-decline transport integration
    const req4 = '10203040-5060-4780-8090-a0b0c0d0e015';
    const rq4 = '10203040-5060-4780-8090-a0b0c0d0e016';
    const unregSweep = registerDealingSweepDecline(createDealingSweepDeclineTransport(() => 100042));
    try {
      useDealingStore.getState().applyEvent({
        requestId: req4,
        clientOrderId: 'bo-sweep-dec',
        accountLogin: 0, // tests getAccountLogin fallback
        symbol: 'EURUSD',
        side: 'buy',
        wireSide: WIRE_SIDE_BUY,
        digits: 5,
        volume: 1,
        bid: 1.084,
        ask: 1.0842,
        seq: 2,
        phase: 'requoted',
        requoteId: rq4,
        expiresAtMs: now + 5_000,
        serverNowMs: now,
      }, now);

      const swept = useDealingStore.getState().sweepExpiredRequotes(now + 6_500);
      expect(swept).toEqual([req4]);
      await vi.waitFor(() => {
        expect(httpFrames).toHaveLength(2);
      });
      const decodedSweep = decodeRequoteActionFrame(httpFrames[1]);
      expect(decodedSweep.action).toBe(BINARY_ORDER_ACTION_REQUOTE_DECLINE);
      expect(decodedSweep.accountLogin).toBe(100042);
      expect(decodedSweep.extras.dealingRequestUuid).toBe(req4);
      expect(decodedSweep.extras.dealingRequoteUuid).toBe(rq4);
    } finally {
      unregSweep();
    }
  });

  it('recognizes timeout (504) via isDealingTransportTimeoutError and rejects in-flight WS Action 9/10 cleanly on socket close', async () => {
    vi.useFakeTimers();
    enableDealingGateForTest();
    globalThis.WebSocket = class extends MockOrderWebSocket {
      constructor(url: string) {
        super(url, () => {
          // Intentionally do not reply so timeout / close paths fire.
        });
      }
    } as unknown as typeof WebSocket;

    const activeSocket = ensureBinaryOrderWebSocket() as unknown as MockOrderWebSocket;
    syncBinaryOrderAuthToken('jwt-timeout-test');

    // 1. Timeout path -> BinaryTcpOrderError(504) satisfies isDealingTransportTimeoutError
    const timeoutPromise = sendRequoteAccept({
      accountLogin: 100042,
      side: WIRE_SIDE_BUY,
      volume: 1,
      price: 1.0845,
      symbol: 'EURUSD',
      requestId: REQ_UUID,
      requoteId: RQ_UUID,
      timeoutMs: 500,
    }).catch((err: unknown) => err);

    expect(getActiveBinaryTcpOrderCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(501);
    const timeoutErr = await timeoutPromise;
    expect(timeoutErr).toBeInstanceOf(BinaryTcpOrderError);
    expect((timeoutErr as BinaryTcpOrderError).status).toBe(504);
    expect(isDealingTransportTimeoutError(timeoutErr)).toBe(true);
    expect(getActiveBinaryTcpOrderCount()).toBe(0);

    // 2. Socket close cleans up in-flight raw WS request
    const closePromise = sendRequoteDecline({
      accountLogin: 100042,
      side: WIRE_SIDE_BUY,
      volume: 1,
      symbol: 'EURUSD',
      requestId: REQ_UUID,
      requoteId: RQ_UUID,
      timeoutMs: 10_000,
    }).catch((err: unknown) => err);

    expect(getActiveBinaryTcpOrderCount()).toBe(1);
    activeSocket.readyState = MockOrderWebSocket.CLOSED;
    activeSocket.onclose?.();
    const closeErr = await closePromise;
    expect(closeErr).toBeInstanceOf(BinaryTcpOrderError);
    expect((closeErr as BinaryTcpOrderError).status).toBe(503);
    expect(getActiveBinaryTcpOrderCount()).toBe(0);
  });

  it('F19: with WEB_TERMINAL_DEALING_BRIDGE_ENABLED on, web-tcp needs DealingSync 0x2A=1 before 0x16 is sent; desktop clientcore never opens', async () => {
    const orderParams: BinaryTcpOrderParams = {
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.25,
      clientOrderId: FIXED_CLIENT_ORDER_ID,
      authToken: 'test-jwt-token',
    };
    globalThis.WebSocket = class extends MockOrderWebSocket {
      constructor(url: string) {
        super(url, (reqId, frame, ws) => {
          const body = frame.subarray(WS_REQ_ID_SIZE);
          if (body[1] === WIRE_ACTION_DEALING_SYNC) {
            ws.onmessage?.({
              data: wrapWsResp(reqId, encodeDealingSyncRespFrame({ status: WIRE_STATUS_OK, dealingEnabled: true })),
            });
            return;
          }
          ws.onmessage?.({ data: wrapWsResp(reqId, buildOkRespBytes(body[1])) });
        });
      }
    } as unknown as typeof WebSocket;
    const ws = ensureBinaryOrderWebSocket() as unknown as MockOrderWebSocket;
    syncBinaryOrderAuthToken('test-jwt-token');

    const sendOrderFrame = async (): Promise<Uint8Array> => {
      ws.sentFrames.length = 0;
      await sendBinaryTcpOrder(orderParams);
      const orderFrames = ws.sentFrames.filter(
        (f) => new DataView(f.buffer, f.byteOffset, 4).getUint32(0, true) !== 0,
      );
      expect(orderFrames).toHaveLength(1);
      return orderFrames[0];
    };

    // (a) web-tcp, NO DEALING_BRIDGE_V1 runtime config, NO DealingSync advertisement:
    //     transport supported (flag on) but the gate is closed -> pre-dealing 132B frame, no 0x16.
    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'web-tcp' };
    refreshDealingWireGate();
    expect(isDealingTransportSupported()).toBe(true);
    expect(isDealingServerAdvertised()).toBe(false);
    expect(isDealingWireGateOpen()).toBe(false);
    const closedFrame = await sendOrderFrame();
    const closedReqId = new DataView(closedFrame.buffer, closedFrame.byteOffset, 4).getUint32(0, true);
    expect(Array.from(closedFrame)).toEqual(Array.from(encodeBinaryOrderWsModeAFrame(closedReqId, orderParams)));
    expect(closedFrame.byteLength).toBe(WS_FAST_ORDER_FRAME_SIZE);

    // (b) server answers DealingSync (Action 11) with TLV 0x2A=1 -> gate opens, frame carries 0x16.
    const probe = await sendDealingSyncProbe({ accountLogin: 100042 });
    expect(probe).toEqual({ sent: true, enabled: true, rateLimited: false, status: 200 });
    expect(isDealingWireGateOpen()).toBe(true);
    const openFrame = await sendOrderFrame();
    expect(Array.from(openFrame.subarray(openFrame.byteLength - 6))).toEqual([...CAPS_TLV]);
    const { extras } = decodeReqExtrasBlock(openFrame, WS_FAST_ORDER_FRAME_SIZE);
    expect(extras.hasClientCaps).toBe(true);
    expect(extras.clientCaps).toBe(BINARY_ORDER_CLIENT_CAP_DEALING_V1);

    // (c) desktop clientcore runtime: even with the server advertisement set, the gate stays closed
    //     and the order frame is the pre-dealing frame (no 0x16).
    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'win32' };
    expect(setDealingServerAdvertised(true)).toBe(false);
    expect(isDealingServerAdvertised()).toBe(true);
    expect(isDealingTransportSupported()).toBe(false);
    expect(isDealingWireGateOpen()).toBe(false);
    const desktopFrame = await sendOrderFrame();
    const desktopReqId = new DataView(desktopFrame.buffer, desktopFrame.byteOffset, 4).getUint32(0, true);
    expect(Array.from(desktopFrame)).toEqual(Array.from(encodeBinaryOrderWsModeAFrame(desktopReqId, orderParams)));
  });

  it('D18: enforces desktop/web-tcp bridge gates, opens only on Action 11 + TLV 0x2A=1, rate-limits 1/2s, and skips non-dealing >140B replies with zero ingest', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    let syncReplyBytes: Uint8Array = encodeDealingSyncRespFrame({ status: WIRE_STATUS_OK, dealingEnabled: true });
    let wsSyncRequests = 0;

    globalThis.WebSocket = class extends MockOrderWebSocket {
      constructor(url: string) {
        super(url, (reqId, frame, ws) => {
          const body = frame.subarray(WS_REQ_ID_SIZE);
          if (body[1] === WIRE_ACTION_DEALING_SYNC) {
            wsSyncRequests++;
            const decoded = decodeDealingSyncFrame(body);
            expect(decoded.accountLogin).toBe(100042);
            ws.onmessage?.({ data: wrapWsResp(reqId, syncReplyBytes) });
            return;
          }
          ws.onmessage?.({ data: wrapWsResp(reqId, buildOkRespBytes(body[1])) });
        });
      }
    } as unknown as typeof WebSocket;

    ensureBinaryOrderWebSocket();
    syncBinaryOrderAuthToken('test-jwt-token');

    // 1. Desktop clientcore bridge (platform='win32') -> Action 11 never sends, gate stays closed, Action 9 blocked
    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'win32' };
    refreshDealingWireGate();
    const desktopProbe = await sendDealingSyncProbe({ accountLogin: 100042 });
    expect(desktopProbe).toEqual({ sent: false, enabled: false, rateLimited: false, status: 0 });
    expect(wsSyncRequests).toBe(0);
    expect(isDealingWireGateOpen()).toBe(false);
    await expect(
      sendRequoteAccept({ accountLogin: 100042, requestId: REQ_UUID, requoteId: RQ_UUID, price: 1.1 }),
    ).rejects.toMatchObject({ code: 'DEALING_NOT_ENABLED' });
    const declineOff = await sendRequoteDecline({ accountLogin: 100042, requestId: REQ_UUID, requoteId: RQ_UUID });
    expect(declineOff.errorCode).toBe('DEALING_NOT_ENABLED');

    // 2. web-tcp (WEB_TERMINAL_DEALING_BRIDGE_ENABLED=true) without DEALING_BRIDGE_V1 runtime config
    //    -> Action 11 sends, 200 + 0x2A=1 opens gate; rate-limited for 2s
    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'web-tcp' };
    refreshDealingWireGate();
    expect(isDealingTransportSupported()).toBe(true);
    expect(isDealingWireGateOpen()).toBe(false);
    const enabledProbe = await sendDealingSyncProbe({ accountLogin: 100042 });
    expect(enabledProbe).toEqual({ sent: true, enabled: true, rateLimited: false, status: 200 });
    expect(isDealingServerAdvertised()).toBe(true);
    expect(isDealingWireGateOpen()).toBe(true);
    expect(wsSyncRequests).toBe(1);

    const rateLimitedProbe = await sendDealingSyncProbe({ accountLogin: 100042 });
    expect(rateLimitedProbe.rateLimited).toBe(true);
    expect(wsSyncRequests).toBe(1);

    // 4. After 2s cooldown, 400/501 reply closes gate cleanly
    vi.advanceTimersByTime(DEALING_SYNC_MIN_INTERVAL_MS);
    syncReplyBytes = encodeDealingSyncRespFrame({
      status: 501,
      errorCode: 'DEALING_NOT_ENABLED',
      message: 'disabled',
    });
    const disabledProbe = await sendDealingSyncProbe({ accountLogin: 100042 });
    expect(disabledProbe).toEqual({ sent: true, enabled: false, rateLimited: false, status: 501 });
    expect(isDealingWireGateOpen()).toBe(false);

    // 5. R1 MINOR-3: >140B non-dealing error reply skips dealing ingest completely
    const ingestSpy = vi.spyOn(dealingOrderHooks, 'ingestOrderResp');
    globalThis.WebSocket = class extends MockOrderWebSocket {
      constructor(url: string) {
        super(url, (reqId, _frame, ws) => {
          const nonDealingErr = encodeOrderRespFrame({
            action: WIRE_ACTION_DEALING_SYNC - 10,
            status: WIRE_STATUS_REJECTED,
            symbol: 'EURUSD',
            clientOrderId: 'bo-err-plain',
            errorCode: 'INVALID_STOPS',
            message: 'Invalid stop loss or take profit distance',
          });
          ws.onmessage?.({ data: wrapWsResp(reqId, nonDealingErr) });
        });
      }
    } as unknown as typeof WebSocket;
    __resetBinaryOrderWsForTests();
    ensureBinaryOrderWebSocket();
    syncBinaryOrderAuthToken('test-jwt-token');
    await expect(
      sendBinaryTcpOrder({
        action: BINARY_ORDER_ACTION_PLACE_MARKET,
        accountLogin: 100042,
        symbol: 'EURUSD',
        side: 'BUY',
        volume: 0.1,
        clientOrderId: 'bo-err-plain',
      }),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_STOPS' });
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('MAJOR-2: throws typed errors on binary 0x39 400/401/403/500/501/503/504 for Action 9, closes gate on 501, and resolves Decline cleanly', async () => {
    enableDealingGateForTest();
    let replyBytes!: Uint8Array;

    globalThis.WebSocket = class extends MockOrderWebSocket {
      constructor(url: string) {
        super(url, (reqId, _frame, ws) => {
          ws.onmessage?.({ data: wrapWsResp(reqId, replyBytes) });
        });
      }
    } as unknown as typeof WebSocket;

    ensureBinaryOrderWebSocket();
    syncBinaryOrderAuthToken('jwt-err-test');

    // 1. Binary 0x39 501 closes advertised gate and throws DEALING_NOT_ENABLED for Action 9
    replyBytes = encodeOrderRespFrame({
      action: BINARY_ORDER_ACTION_REQUOTE_ACCEPT,
      status: 501,
      symbol: 'EURUSD',
      errorCode: 'DEALING_NOT_ENABLED',
      message: 'dealing not enabled',
      execWire: { retcode: 10006, requestId: REQ_UUID, requoteId: RQ_UUID },
    });
    await expect(
      sendRequoteAccept({
        accountLogin: 100042,
        side: WIRE_SIDE_BUY,
        volume: 1,
        price: 1.0845,
        symbol: 'EURUSD',
        requestId: REQ_UUID,
        requoteId: RQ_UUID,
      }),
    ).rejects.toMatchObject({ status: 501, code: 'DEALING_NOT_ENABLED' });
    expect(isDealingServerAdvertised()).toBe(false);
    expect(isDealingWireGateOpen()).toBe(false);

    // 2. Binary 0x39 504 throws retryable timeout satisfying isDealingTransportTimeoutError
    enableDealingGateForTest();
    replyBytes = encodeOrderRespFrame({
      action: BINARY_ORDER_ACTION_REQUOTE_ACCEPT,
      status: 504,
      symbol: 'EURUSD',
      errorCode: 'BINARY_TCP_TIMEOUT',
      message: 'context deadline exceeded',
      execWire: { retcode: 0, requestId: REQ_UUID, requoteId: RQ_UUID },
    });
    const err504 = await sendRequoteAccept({
      accountLogin: 100042,
      side: WIRE_SIDE_BUY,
      volume: 1,
      price: 1.0845,
      symbol: 'EURUSD',
      requestId: REQ_UUID,
      requoteId: RQ_UUID,
    }).catch((err: unknown) => err);
    expect(err504).toBeInstanceOf(BinaryTcpOrderError);
    expect((err504 as BinaryTcpOrderError).status).toBe(504);
    expect(isDealingTransportTimeoutError(err504)).toBe(true);

    // 3. Binary 0x39 400 / 401 / 403 / 500 / 503 throw typed BinaryTcpOrderError
    for (const tc of [
      { status: 400, code: 'INVALID_BINARY_ORDER' },
      { status: 401, code: 'UNAUTHORIZED' },
      { status: 403, code: 'ACCOUNT_MISMATCH' },
      { status: 500, code: 'INTERNAL_ERROR' },
      { status: 503, code: 'SERVICE_UNAVAILABLE' },
    ]) {
      replyBytes = encodeOrderRespFrame({
        action: BINARY_ORDER_ACTION_REQUOTE_ACCEPT,
        status: tc.status,
        symbol: 'EURUSD',
        errorCode: tc.code,
        message: `err ${tc.status}`,
        execWire: { retcode: 0, requestId: REQ_UUID, requoteId: RQ_UUID },
      });
      await expect(
        sendRequoteAccept({
          accountLogin: 100042,
          side: WIRE_SIDE_BUY,
          volume: 1,
          price: 1.0845,
          symbol: 'EURUSD',
          requestId: REQ_UUID,
          requoteId: RQ_UUID,
        }),
      ).rejects.toMatchObject({ status: tc.status, code: tc.code });
    }

    // 4. Binary 0x39 501 on Action 10 Decline closes gate and resolves store entry to cancelled
    useDealingStore.getState().applyEvent({
      requestId: REQ_UUID,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      digits: 5,
      bid: 1.084,
      ask: 1.0842,
      phase: 'requoted',
      requoteId: RQ_UUID,
      expiresAtMs: Date.now() + 5_000,
      serverNowMs: Date.now(),
    });
    replyBytes = encodeOrderRespFrame({
      action: BINARY_ORDER_ACTION_REQUOTE_DECLINE,
      status: 501,
      symbol: 'EURUSD',
      errorCode: 'DEALING_NOT_ENABLED',
      message: 'dealing not enabled',
      execWire: { retcode: 10006, requestId: REQ_UUID, requoteId: RQ_UUID },
    });
    const dec501 = await sendRequoteDecline({
      accountLogin: 100042,
      side: WIRE_SIDE_BUY,
      volume: 1,
      symbol: 'EURUSD',
      requestId: REQ_UUID,
      requoteId: RQ_UUID,
    });
    expect(dec501.errorCode).toBe('DEALING_NOT_ENABLED');
    expect(isDealingWireGateOpen()).toBe(false);
    expect(useDealingStore.getState().requests[REQ_UUID]?.phase).toBe('cancelled');
  });

  it('MAJOR-1: keeps wireGateOpen and TLV 0x16 intact on binary 0x39 404 (DEALING_REQUEST_NOT_FOUND / close-fill 404)', async () => {
    enableDealingGateForTest();
    let replyBytes!: Uint8Array;
    const sentFrames: Uint8Array[] = [];

    globalThis.WebSocket = class extends MockOrderWebSocket {
      constructor(url: string) {
        super(url, (reqId, frame, ws) => {
          sentFrames.push(frame);
          const body = frame.subarray(WS_REQ_ID_SIZE);
          if (body[1] === BINARY_ORDER_ACTION_PLACE_MARKET) {
            ws.onmessage?.({ data: wrapWsResp(reqId, buildOkRespBytes(body[1], 'bo-after-404')) });
            return;
          }
          ws.onmessage?.({ data: wrapWsResp(reqId, replyBytes) });
        });
      }
    } as unknown as typeof WebSocket;

    ensureBinaryOrderWebSocket();
    syncBinaryOrderAuthToken('test-jwt-token');

    // 1. Action 9 Accept receives binary 0x39 404 DEALING_REQUEST_NOT_FOUND -> throws 404, gate stays OPEN
    replyBytes = encodeOrderRespFrame({
      action: BINARY_ORDER_ACTION_REQUOTE_ACCEPT,
      status: 404,
      symbol: 'EURUSD',
      errorCode: 'DEALING_REQUEST_NOT_FOUND',
      message: 'Dealing request not found',
      execWire: { retcode: 10006, requestId: REQ_UUID, requoteId: RQ_UUID },
    });
    await expect(
      sendRequoteAccept({
        accountLogin: 100042,
        side: WIRE_SIDE_BUY,
        volume: 1,
        price: 1.0845,
        symbol: 'EURUSD',
        requestId: REQ_UUID,
        requoteId: RQ_UUID,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'DEALING_REQUEST_NOT_FOUND', retryable: false });
    expect(isDealingServerAdvertised()).toBe(true);
    expect(isDealingWireGateOpen()).toBe(true);

    // 2. Action 10 Decline receives binary 0x39 404 DEALING_REQUEST_NOT_FOUND -> throws 404, gate stays OPEN
    replyBytes = encodeOrderRespFrame({
      action: BINARY_ORDER_ACTION_REQUOTE_DECLINE,
      status: 404,
      symbol: 'EURUSD',
      errorCode: 'DEALING_REQUEST_NOT_FOUND',
      message: 'Dealing request not found',
      execWire: { retcode: 10006, requestId: REQ_UUID, requoteId: RQ_UUID },
    });
    await expect(
      sendRequoteDecline({
        accountLogin: 100042,
        side: WIRE_SIDE_BUY,
        volume: 1,
        symbol: 'EURUSD',
        requestId: REQ_UUID,
        requoteId: RQ_UUID,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'DEALING_REQUEST_NOT_FOUND', retryable: false });
    expect(isDealingServerAdvertised()).toBe(true);
    expect(isDealingWireGateOpen()).toBe(true);

    // 3. Close-fill 404 carrying empty or position-missing errorCode preserves fallback / code and keeps gate OPEN
    replyBytes = encodeOrderRespFrame({
      action: BINARY_ORDER_ACTION_REQUOTE_ACCEPT,
      status: 404,
      symbol: 'EURUSD',
      errorCode: '',
      message: 'Position already closed',
      execWire: { retcode: 10006, requestId: REQ_UUID, requoteId: RQ_UUID },
    });
    await expect(
      sendRequoteAccept({
        accountLogin: 100042,
        side: WIRE_SIDE_BUY,
        volume: 1,
        price: 1.0845,
        symbol: 'EURUSD',
        requestId: REQ_UUID,
        requoteId: RQ_UUID,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'DEALING_REQUEST_NOT_FOUND', retryable: false });
    expect(isDealingWireGateOpen()).toBe(true);

    // 4. Subsequent normal order still attaches TLV 0x16 (140B Mode A scratch packet)
    await sendBinaryTcpOrder({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 100042,
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.1,
      clientOrderId: 'bo-after-404',
    });
    const orderFrame = sentFrames[sentFrames.length - 1];
    expect(orderFrame.byteLength).toBe(WS_FAST_ORDER_WITH_DEALING_CAPS_SIZE);
    expect(Array.from(orderFrame.subarray(orderFrame.byteLength - 6))).toEqual([...CAPS_TLV]);
  });

  it('MINOR-3: emits retryable TRUNCATED_BINARY_ORDER_RESP and BINARY_TUNNEL_UNAVAILABLE without closing wireGateOpen', async () => {
    enableDealingGateForTest();

    // 1. Malformed WS 0x39 reply (wrong codec version) -> TRUNCATED_BINARY_ORDER_RESP (502, retryable)
    const badVersionWsReply = new Uint8Array(RESP_HEADER_SIZE);
    badVersionWsReply[0] = 99;
    globalThis.WebSocket = class extends MockOrderWebSocket {
      constructor(url: string) {
        super(url, (reqId, _frame, ws) => {
          ws.onmessage?.({ data: wrapWsResp(reqId, badVersionWsReply) });
        });
      }
    } as unknown as typeof WebSocket;
    ensureBinaryOrderWebSocket();
    syncBinaryOrderAuthToken('test-jwt-token');

    await expect(
      sendRequoteAccept({
        accountLogin: 100042,
        side: WIRE_SIDE_BUY,
        volume: 1,
        price: 1.0845,
        symbol: 'EURUSD',
        requestId: REQ_UUID,
        requoteId: RQ_UUID,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'TRUNCATED_BINARY_ORDER_RESP', retryable: true });
    expect(isDealingWireGateOpen()).toBe(true);

    // 2. Truncated HTTP 200 OK (< 136B) -> TRUNCATED_BINARY_ORDER_RESP (502, retryable)
    __resetBinaryOrderWsForTests();
    enableDealingGateForTest();
    globalThis.WebSocket = undefined as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 9, 200, 0]).buffer,
    })) as unknown as typeof fetch;

    await expect(
      sendRequoteAccept({
        accountLogin: 100042,
        side: WIRE_SIDE_BUY,
        volume: 1,
        price: 1.0845,
        symbol: 'EURUSD',
        requestId: REQ_UUID,
        requoteId: RQ_UUID,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'TRUNCATED_BINARY_ORDER_RESP', retryable: true });
    expect(isDealingWireGateOpen()).toBe(true);

    // 3. Non-binary HTTP 502 -> BINARY_TUNNEL_UNAVAILABLE (502, retryable)
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      arrayBuffer: async () => new TextEncoder().encode('Bad Gateway').buffer,
    })) as unknown as typeof fetch;

    await expect(
      sendRequoteAccept({
        accountLogin: 100042,
        side: WIRE_SIDE_BUY,
        volume: 1,
        price: 1.0845,
        symbol: 'EURUSD',
        requestId: REQ_UUID,
        requoteId: RQ_UUID,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'BINARY_TUNNEL_UNAVAILABLE', retryable: true });
    expect(isDealingWireGateOpen()).toBe(true);
  });
});
