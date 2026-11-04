import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetBinaryOrderWsForTests,
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_CODEC_VERSION,
  BINARY_ORDER_ENDPOINT,
  BINARY_ORDER_WS_ENDPOINT,
  ensureBinaryOrderWebSocket,
  RESP_HEADER_SIZE,
  sendBinaryTcpOrder,
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
