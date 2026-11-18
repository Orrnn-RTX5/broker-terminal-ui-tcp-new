import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetBinaryOrderWsForTests,
  BINARY_ORDER_ACTION_CANCEL_PENDING,
  BINARY_ORDER_ACTION_CLOSE_POSITION,
  BINARY_ORDER_ACTION_MODIFY_PENDING,
  BINARY_ORDER_ACTION_MODIFY_POSITION,
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_ACTION_PLACE_PENDING,
  BINARY_ORDER_CODEC_VERSION,
  BINARY_ORDER_ENDPOINT,
  BINARY_ORDER_EXTRA_TAG_COMMENT,
  BINARY_ORDER_EXTRA_TAG_MAGIC,
  BINARY_ORDER_EXTRA_TAG_TRAILING_STEP,
  BINARY_ORDER_EXTRA_TAG_TRAILING_STOP,
  BINARY_ORDER_FLAG_CLEAR_TRAILING,
  BINARY_ORDER_FLAG_HAS_EXTRAS,
  BINARY_ORDER_FLAG_HAS_TRAILING,
  BINARY_ORDER_SUBTYPE_BUY_LIMIT,
  BINARY_ORDER_WS_ENDPOINT,
  encodeBinaryOrderReq,
  encodeBinaryOrderWsModeAFrame,
  encodeBinaryOrderWsModeBFrame,
  ensureBinaryOrderWebSocket,
  getActiveBinaryTcpOrderCount,
  REQ_HEADER_SIZE,
  RESP_HEADER_SIZE,
  sendBinaryTcpOrder,
  WS_FAST_ORDER_FRAME_SIZE,
} from '../binaryTcpOrderClient';

vi.mock('../../config/backendTarget.js', () => ({
  isDesktopBackendTarget: () => true,
}));

vi.mock('../brokerSession', () => ({
  getAccessToken: () => 'test-jwt-token',
  onSessionChange: () => () => {},
}));

function buildMockBinaryOrderRespBuffer(overrides?: {
  action?: number;
  status?: number;
  orderTicket?: number;
  positionTicket?: number;
  dealTicket?: number;
  fillPrice?: number;
  volume?: number;
}): ArrayBuffer {
  const buf = new ArrayBuffer(RESP_HEADER_SIZE);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes[0] = BINARY_ORDER_CODEC_VERSION;
  bytes[1] = overrides?.action ?? BINARY_ORDER_ACTION_PLACE_MARKET;
  view.setUint16(2, overrides?.status ?? 200, true);
  view.setUint32(4, 350, true); // execMicros
  view.setBigInt64(8, BigInt(overrides?.orderTicket ?? 5001), true);
  view.setBigInt64(16, BigInt(overrides?.positionTicket ?? 7001), true);
  view.setBigInt64(24, BigInt(overrides?.dealTicket ?? 9001), true);
  view.setFloat64(32, overrides?.fillPrice ?? 1.12345, true);
  view.setFloat64(40, overrides?.volume ?? 0.1, true);
  return buf;
}

describe('binaryTcpOrderClient fast-endpoint fallback & HTTP retry', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __resetBinaryOrderWsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetBinaryOrderWsForTests();
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    delete (globalThis as any).__RTX5_RUNTIME_CONFIG__;
  });

  it('switches immediately (0ms) to fixed-host WS endpoint when fast-port WS closes', () => {
    const createdUrls: string[] = [];
    const sockets: any[] = [];

    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      binaryType = 'blob';
      onopen: (() => void) | null = null;
      onmessage: ((ev: any) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(url: string) {
        this.url = url;
        createdUrls.push(url);
        sockets.push(this);
      }

      send = vi.fn();
      close = vi.fn(() => {
        this.readyState = MockWebSocket.CLOSED;
      });
    }

    globalThis.WebSocket = MockWebSocket as any;
    (globalThis as any).__RTX5_RUNTIME_CONFIG__ = {
      BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
    };

    const firstSocket = ensureBinaryOrderWebSocket();
    expect(firstSocket).not.toBeNull();
    expect(createdUrls).toEqual(['ws://127.0.0.1:18404/__rtx5_binary_order_ws']);

    // Simulate fast-port WS failing/closing
    sockets[0].readyState = MockWebSocket.CLOSED;
    sockets[0].onclose?.();

    // 0ms first reconnect delay should immediately open the fixed-host WS endpoint
    vi.advanceTimersByTime(0);

    expect(createdUrls.length).toBe(2);
    expect(createdUrls[1]).toContain(BINARY_ORDER_WS_ENDPOINT);
    expect(createdUrls[1]).not.toContain('18404');
  });

  it('retries HTTP order on fixed origin BINARY_ORDER_ENDPOINT when fast-port HTTP fetch throws network error', async () => {
    class ClosedWebSocket {
      readyState = 3;
      binaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onmessage: ((ev: any) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(public url: string) {}
      send = vi.fn();
      close = vi.fn();
    }
    globalThis.WebSocket = ClosedWebSocket as any;

    (globalThis as any).__RTX5_RUNTIME_CONFIG__ = {
      BINARY_ORDER_URL: 'http://127.0.0.1:18404/__rtx5_binary_order',
      BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
    };

    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes('18404')) {
        throw new TypeError('Failed to fetch');
      }
      return new Response(buildMockBinaryOrderRespBuffer({ positionTicket: 88001 }), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }) as any;

    const result = await sendBinaryTcpOrder({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 5058375,
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.1,
    });

    expect(result.ok).toBe(true);
    expect(result.positionTicket).toBe(88001);
    expect(fetchCalls).toEqual([
      'http://127.0.0.1:18404/__rtx5_binary_order',
      BINARY_ORDER_ENDPOINT,
    ]);
  });
});

describe('binaryTcpOrderClient HAS_EXTRAS (0x0400) TLV encoding & validation', () => {
  const FIXED_UUID = '123e4567-e89b-42d3-a456-426614174000';

  it('encodes zero-extras market order as exact 132-byte Mode A, 134+tokenLen Mode B, and 130+tokenLen HTTP with HAS_EXTRAS clear', () => {
    const token = 'jwt-tok';
    const tokenBytes = new TextEncoder().encode(token);

    const modeA = encodeBinaryOrderWsModeAFrame(42, {
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 5058375,
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.1,
      clientOrderId: FIXED_UUID,
      authToken: token,
    });
    expect(modeA.byteLength).toBe(WS_FAST_ORDER_FRAME_SIZE); // 132
    const modeAView = new DataView(modeA.buffer, modeA.byteOffset, modeA.byteLength);
    expect(modeAView.getUint32(0, true)).toBe(42);
    expect(modeAView.getUint16(4 + 4, true) & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(0);

    const modeB = encodeBinaryOrderWsModeBFrame(42, {
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 5058375,
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.1,
      clientOrderId: FIXED_UUID,
      authToken: token,
    });
    expect(modeB.byteLength).toBe(4 + REQ_HEADER_SIZE + 2 + tokenBytes.byteLength);
    const modeBView = new DataView(modeB.buffer, modeB.byteOffset, modeB.byteLength);
    expect(modeBView.getUint16(4 + 4, true) & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(0);
    expect(modeBView.getUint16(4 + REQ_HEADER_SIZE, true)).toBe(tokenBytes.byteLength);

    const { packet: httpPacket, buffer: httpBuf } = encodeBinaryOrderReq({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 5058375,
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.1,
      clientOrderId: FIXED_UUID,
      authToken: token,
    });
    expect(httpPacket.byteLength).toBe(REQ_HEADER_SIZE + 2 + tokenBytes.byteLength);
    const httpView = new DataView(httpBuf);
    expect(httpView.getUint16(4, true) & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(0);
  });

  it('encodes golden bytes for COMMENT (0x01) and MAGIC (0x02) across WS Mode A, WS Mode B, and HTTP binary body', () => {
    const comment = 'bot-v2'; // 6 UTF-8 bytes: [0x62, 0x6f, 0x74, 0x2d, 0x76, 0x32]
    const magic = 0x0102030405060708n; // int64 LE: [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]
    const token = 'tok-xyz';
    const tokenBytes = Array.from(new TextEncoder().encode(token));

    // Expected TLV:
    // Tag 0x01, len 6, 'b','o','t','-','v','2' (8 bytes)
    // Tag 0x02, len 8, 8-byte int64 LE (10 bytes)
    // Total extrasLen = 18 (0x12, 0x00)
    const expectedExtrasBlock = [
      18, 0, // u16 LE extrasLen = 18
      BINARY_ORDER_EXTRA_TAG_COMMENT, 6, 0x62, 0x6f, 0x74, 0x2d, 0x76, 0x32,
      BINARY_ORDER_EXTRA_TAG_MAGIC, 8, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    ];

    // 1. WS Mode A: [u32 reqId][128 header][u16 LE extrasLen][TLV] (extras at byte 132)
    const modeA = encodeBinaryOrderWsModeAFrame(7, {
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 1001,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: 0.5,
      comment,
      magic,
      clientOrderId: FIXED_UUID,
      authToken: token,
    });
    expect(modeA.byteLength).toBe(132 + expectedExtrasBlock.length);
    const modeAView = new DataView(modeA.buffer, modeA.byteOffset, modeA.byteLength);
    expect(modeAView.getUint32(0, true)).toBe(7);
    expect(modeAView.getUint16(4 + 4, true) & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(BINARY_ORDER_FLAG_HAS_EXTRAS);
    expect(Array.from(modeA.subarray(132))).toEqual(expectedExtrasBlock);

    // 2. WS Mode B: [u32 reqId][128 header][u16 LE tokenLen][token][u16 LE extrasLen][TLV]
    const modeB = encodeBinaryOrderWsModeBFrame(7, {
      action: BINARY_ORDER_ACTION_PLACE_PENDING,
      accountLogin: 1001,
      symbol: 'XAUUSD',
      side: 'BUY',
      orderSubType: BINARY_ORDER_SUBTYPE_BUY_LIMIT,
      price: 2300.5,
      volume: 0.5,
      comment,
      magic,
      clientOrderId: FIXED_UUID,
      authToken: token,
    });
    const modeBTokenOffset = 4 + REQ_HEADER_SIZE;
    const modeBExtrasOffset = modeBTokenOffset + 2 + tokenBytes.length;
    expect(modeB.byteLength).toBe(modeBExtrasOffset + expectedExtrasBlock.length);
    const modeBView = new DataView(modeB.buffer, modeB.byteOffset, modeB.byteLength);
    expect(modeBView.getUint16(4 + 4, true) & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(BINARY_ORDER_FLAG_HAS_EXTRAS);
    expect(modeBView.getUint16(modeBTokenOffset, true)).toBe(tokenBytes.length);
    expect(Array.from(modeB.subarray(modeBTokenOffset + 2, modeBExtrasOffset))).toEqual(tokenBytes);
    expect(Array.from(modeB.subarray(modeBExtrasOffset))).toEqual(expectedExtrasBlock);

    // 3. HTTP binary body: [128 header][u16 LE tokenLen][token][u16 LE extrasLen][TLV]
    const { packet: httpBytes, buffer: httpBuf } = encodeBinaryOrderReq({
      action: BINARY_ORDER_ACTION_MODIFY_PENDING,
      accountLogin: 1001,
      ticket: 889900,
      price: 2305.0,
      comment,
      magic,
      clientOrderId: FIXED_UUID,
      authToken: token,
    });
    const httpTokenOffset = REQ_HEADER_SIZE;
    const httpExtrasOffset = httpTokenOffset + 2 + tokenBytes.length;
    expect(httpBytes.byteLength).toBe(httpExtrasOffset + expectedExtrasBlock.length);
    const httpView = new DataView(httpBuf);
    expect(httpView.getUint16(4, true) & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(BINARY_ORDER_FLAG_HAS_EXTRAS);
    expect(httpView.getUint16(httpTokenOffset, true)).toBe(tokenBytes.length);
    expect(Array.from(httpBytes.subarray(httpTokenOffset + 2, httpExtrasOffset))).toEqual(tokenBytes);
    expect(Array.from(httpBytes.subarray(httpExtrasOffset))).toEqual(expectedExtrasBlock);
  });

  it('omits empty/whitespace comment and zero magic and clears HAS_EXTRAS when both are empty', () => {
    const modeA = encodeBinaryOrderWsModeAFrame(1, {
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 1001,
      symbol: 'EURUSD',
      side: 'SELL',
      volume: 1,
      comment: '   ',
      magic: 0,
      clientOrderId: FIXED_UUID,
    });
    expect(modeA.byteLength).toBe(132);
    const view = new DataView(modeA.buffer, modeA.byteOffset, modeA.byteLength);
    expect(view.getUint16(4 + 4, true) & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(0);
  });

  it('ignores extras for close, modify-position, and cancel actions', () => {
    for (const actionParams of [
      { action: BINARY_ORDER_ACTION_CLOSE_POSITION, ticket: 101, volume: 0 },
      { action: BINARY_ORDER_ACTION_MODIFY_POSITION, ticket: 101, sl: 1.1 },
      { action: BINARY_ORDER_ACTION_CANCEL_PENDING, ticket: 101 },
    ] as const) {
      const frame = encodeBinaryOrderWsModeAFrame(5, {
        ...actionParams,
        accountLogin: 1001,
        comment: 'ignored-comment',
        magic: 12345,
        clientOrderId: FIXED_UUID,
      });
      expect(frame.byteLength).toBe(132);
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      expect(view.getUint16(4 + 4, true) & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(0);
    }
  });

  it('validates comment UTF-8 byte length <= 64 and rejects NUL bytes without silent truncation', () => {
    // Exact 64 ASCII bytes -> valid
    const exact64 = 'a'.repeat(64);
    const validFrame = encodeBinaryOrderWsModeAFrame(1, {
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 1001,
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.1,
      comment: exact64,
      clientOrderId: FIXED_UUID,
    });
    expect(validFrame.byteLength).toBe(132 + 2 + 2 + 64);

    // 65 ASCII bytes -> throws COMMENT_TOO_LONG
    expect(() =>
      encodeBinaryOrderWsModeAFrame(1, {
        action: BINARY_ORDER_ACTION_PLACE_MARKET,
        accountLogin: 1001,
        symbol: 'EURUSD',
        side: 'BUY',
        volume: 0.1,
        comment: 'a'.repeat(65),
        clientOrderId: FIXED_UUID,
      }),
    ).toThrow(/64 UTF-8 bytes/);

    // 22 Euro signs ('€') = 22 UTF-16 chars, 66 UTF-8 bytes -> throws COMMENT_TOO_LONG
    expect(() =>
      encodeBinaryOrderWsModeAFrame(1, {
        action: BINARY_ORDER_ACTION_PLACE_MARKET,
        accountLogin: 1001,
        symbol: 'EURUSD',
        side: 'BUY',
        volume: 0.1,
        comment: '€'.repeat(22),
        clientOrderId: FIXED_UUID,
      }),
    ).toThrow(/64 UTF-8 bytes/);

    // NUL byte inside comment -> throws INVALID_COMMENT
    expect(() =>
      encodeBinaryOrderWsModeAFrame(1, {
        action: BINARY_ORDER_ACTION_PLACE_MARKET,
        accountLogin: 1001,
        symbol: 'EURUSD',
        side: 'BUY',
        volume: 0.1,
        comment: 'abc\0def',
        clientOrderId: FIXED_UUID,
      }),
    ).toThrow(/NUL/);
  });

  it('encodes TRAILING_STOP (0x03) and TRAILING_STEP (0x04) TLV tags for market, pending, modify-position, and modify-pending', () => {
    // 1. Modify Position set trailingStop=55, trailingStep=10 -> flags HAS_TRAILING | HAS_EXTRAS
    const modSet = encodeBinaryOrderWsModeAFrame(9, {
      action: BINARY_ORDER_ACTION_MODIFY_POSITION,
      accountLogin: 1001,
      ticket: 77001,
      trailingStop: 55,
      trailingStep: 10,
      clientOrderId: FIXED_UUID,
    });
    const expectedTrailingBlock = [
      12, 0, // u16 LE extrasLen = 12 (2 * 6 bytes)
      BINARY_ORDER_EXTRA_TAG_TRAILING_STOP, 4, 55, 0, 0, 0,
      BINARY_ORDER_EXTRA_TAG_TRAILING_STEP, 4, 10, 0, 0, 0,
    ];
    expect(modSet.byteLength).toBe(132 + expectedTrailingBlock.length);
    const modSetView = new DataView(modSet.buffer, modSet.byteOffset, modSet.byteLength);
    const modSetFlags = modSetView.getUint16(4 + 4, true);
    expect(modSetFlags & BINARY_ORDER_FLAG_HAS_TRAILING).toBe(BINARY_ORDER_FLAG_HAS_TRAILING);
    expect(modSetFlags & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(BINARY_ORDER_FLAG_HAS_EXTRAS);
    expect(Array.from(modSet.subarray(132))).toEqual(expectedTrailingBlock);

    // 2. Modify Position clear trailingStop=0 -> flags CLEAR_TRAILING | HAS_EXTRAS and TLV 0x03=0
    const modClear = encodeBinaryOrderWsModeAFrame(10, {
      action: BINARY_ORDER_ACTION_MODIFY_POSITION,
      accountLogin: 1001,
      ticket: 77001,
      trailingStop: 0,
      clientOrderId: FIXED_UUID,
    });
    const modClearView = new DataView(modClear.buffer, modClear.byteOffset, modClear.byteLength);
    const modClearFlags = modClearView.getUint16(4 + 4, true);
    expect(modClearFlags & BINARY_ORDER_FLAG_CLEAR_TRAILING).toBe(BINARY_ORDER_FLAG_CLEAR_TRAILING);
    expect(modClearFlags & BINARY_ORDER_FLAG_HAS_TRAILING).toBe(0);
    expect(Array.from(modClear.subarray(132))).toEqual([
      6, 0,
      BINARY_ORDER_EXTRA_TAG_TRAILING_STOP, 4, 0, 0, 0, 0,
    ]);

    // 3. Reject conflicting HAS_TRAILING | CLEAR_TRAILING
    expect(() =>
      encodeBinaryOrderWsModeAFrame(11, {
        action: BINARY_ORDER_ACTION_MODIFY_POSITION,
        accountLogin: 1001,
        ticket: 77001,
        flags: BINARY_ORDER_FLAG_HAS_TRAILING | BINARY_ORDER_FLAG_CLEAR_TRAILING,
        clientOrderId: FIXED_UUID,
      }),
    ).toThrow(/HAS_TRAILING and CLEAR_TRAILING/);

    // 4. Reject trailingStep > 0 without trailingStop > 0
    expect(() =>
      encodeBinaryOrderWsModeAFrame(12, {
        action: BINARY_ORDER_ACTION_PLACE_MARKET,
        accountLogin: 1001,
        symbol: 'EURUSD',
        side: 'BUY',
        volume: 0.1,
        trailingStep: 10,
        clientOrderId: FIXED_UUID,
      }),
    ).toThrow(/trailing_step requires trailing_stop > 0/);
  });
});

describe('binaryTcpOrderClient AUTH_TOKEN_REQUIRED retry settles and releases the active-order slot', () => {
  const originalWebSocket = globalThis.WebSocket;

  class RetryMockWebSocket {
    static readonly OPEN = 1;
    static instances: RetryMockWebSocket[] = [];
    readyState = 1;
    binaryType = 'blob';
    onopen: (() => void) | null = null;
    onmessage: ((ev: any) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send = vi.fn();
    close = vi.fn();
    constructor(public url: string) { RetryMockWebSocket.instances.push(this); }
  }

  const authRequiredReply = (reqId: number): ArrayBuffer => {
    const code = new TextEncoder().encode('AUTH_TOKEN_REQUIRED');
    const header = new Uint8Array(buildMockBinaryOrderRespBuffer({ status: 401 }));
    const frame = new Uint8Array(4 + RESP_HEADER_SIZE + 2 + code.length + 2);
    const view = new DataView(frame.buffer);
    view.setUint32(0, reqId, true);
    frame.set(header, 4);
    view.setUint16(4 + RESP_HEADER_SIZE, code.length, true);
    frame.set(code, 4 + RESP_HEADER_SIZE + 2);
    view.setUint16(4 + RESP_HEADER_SIZE + 2 + code.length, 0, true);
    return frame.buffer;
  };

  const sendAndRetry = (extra: { timeoutMs?: number; signal?: AbortSignal }) => {
    const socket = ensureBinaryOrderWebSocket() as unknown as RetryMockWebSocket;
    socket.readyState = 1;
    const outcome = sendBinaryTcpOrder({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 5058375,
      symbol: 'EURUSD',
      side: 'BUY',
      volume: 0.1,
      ...extra,
    }).then(() => null, (err: any) => err);
    expect(getActiveBinaryTcpOrderCount()).toBe(1);
    const firstFrame = socket.send.mock.calls[0][0] as Uint8Array;
    const firstReqId = new DataView(firstFrame.buffer, firstFrame.byteOffset).getUint32(0, true);
    // Server says the token was not bound yet: the client retries under a NEW request id.
    socket.onmessage?.({ data: authRequiredReply(firstReqId) });
    const retryFrame = socket.send.mock.calls[1][0] as Uint8Array;
    const retryReqId = new DataView(retryFrame.buffer, retryFrame.byteOffset).getUint32(0, true);
    expect(retryReqId).not.toBe(firstReqId);
    // The retry reply is lost: still in flight.
    expect(getActiveBinaryTcpOrderCount()).toBe(1);
    return outcome;
  };

  beforeEach(() => {
    __resetBinaryOrderWsForTests();
    RetryMockWebSocket.instances = [];
    vi.useFakeTimers();
    globalThis.WebSocket = RetryMockWebSocket as any;
    (globalThis as any).__RTX5_RUNTIME_CONFIG__ = {
      BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
    };
  });

  afterEach(() => {
    __resetBinaryOrderWsForTests();
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    delete (globalThis as any).__RTX5_RUNTIME_CONFIG__;
  });

  it('times out by the CURRENT request id, rejects, and frees the slot when the retry reply is lost', async () => {
    const outcome = sendAndRetry({ timeoutMs: 1000 });
    vi.advanceTimersByTime(1001);
    const err = await outcome;
    expect(err?.code).toBe('GATEWAY_TIMEOUT');
    expect(getActiveBinaryTcpOrderCount()).toBe(0);
  });

  it('aborts by the CURRENT request id, rejects, and frees the slot when the retry reply is lost', async () => {
    const controller = new AbortController();
    const outcome = sendAndRetry({ timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    const err = await outcome;
    expect(err?.code).toBe('REQUEST_ABORTED');
    expect(getActiveBinaryTcpOrderCount()).toBe(0);
  });
});
