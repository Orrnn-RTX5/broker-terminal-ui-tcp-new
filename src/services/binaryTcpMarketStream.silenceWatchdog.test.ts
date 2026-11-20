import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/backendTarget.js', () => ({ isDesktopBackendTarget: () => true }));
vi.mock('./binaryTcpOrderClient', () => ({
  getActiveBinaryTcpOrderCount: () => 0,
  getBinaryTcpOrderActiveDurationMs: () => 0,
  onBinaryTcpOrdersIdle: () => undefined,
  prewarmBinaryOrderSocket: () => undefined,
  syncBinaryOrderAuthToken: () => undefined,
}));
vi.mock('./brokerSession', () => ({
  getAccessToken: () => '',
  getAccountLogin: () => 0,
  onSessionChange: () => undefined,
}));

import { binaryTcpMarketStream, FRAME_BINARY_TICK_BATCH, STREAM_SILENCE_RECONNECT_MS } from './binaryTcpMarketStream';

type StreamMode = 'silent' | 'ping-only' | 'market-data';

// Minimal valid 0x21 tick-batch frame (header 4 bytes + count u16=0 -> payloadLen=2).
const MARKET_DATA_FRAME = new Uint8Array([FRAME_BINARY_TICK_BATCH, 0x00, 0x02, 0x00, 0x00, 0x00]);
// 0x05 keepalive ping frame (must NOT reset market-data silence watchdog).
const PING_FRAME = new Uint8Array([0x05, 0x00, 0x00, 0x00]);

// A stream body whose reader either never delivers a byte (a stalled proxy/socket), delivers only 0x05
// keepalive pings every 10 s (dead upstream tick feed), or delivers 0x21 market-data frames every 10 s.
function streamBody(mode: StreamMode, signal: AbortSignal) {
  return {
    getReader: () => ({
      read: () => new Promise<{ value?: Uint8Array; done: boolean }>((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        if (mode === 'ping-only' || mode === 'market-data') {
          setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve({
              value: mode === 'market-data' ? MARKET_DATA_FRAME : PING_FRAME,
              done: false,
            });
          }, 10_000);
        }
      }),
    }),
  };
}

describe('BinaryTcpMarketStream silence watchdog', () => {
  const modes: StreamMode[] = [];
  let streamCalls = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    streamCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/__rtx5_binary_stream') {
        const mode = modes[streamCalls] ?? 'market-data';
        streamCalls++;
        return { ok: true, status: 200, body: streamBody(mode, init!.signal as AbortSignal) };
      }
      return { ok: true, status: 200 };
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects silent and ping-only streams, and keeps a stream delivering market-data frames', async () => {
    modes.push('silent', 'ping-only', 'market-data');
    const states: boolean[] = [];
    const off = binaryTcpMarketStream.onStateChange((connected) => { states.push(connected); });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(streamCalls).toBe(1);
      expect(binaryTcpMarketStream.isConnected()).toBe(true);

      // Not yet: silence shorter than the limit keeps the stream.
      await vi.advanceTimersByTimeAsync(STREAM_SILENCE_RECONNECT_MS - 6_000);
      expect(streamCalls).toBe(1);

      // Past the limit (plus one check interval and the reconnect backoff): the stalled stream is replaced.
      await vi.advanceTimersByTimeAsync(12_000);
      expect(streamCalls).toBe(2);
      expect(states).toContain(false);
      expect(binaryTcpMarketStream.isConnected()).toBe(true);

      // Stream 2 only sends 0x05 keepalive pings every 10s (dead upstream tick feed):
      // pings must NOT reset the silence watchdog, so it reconnects cleanly after 30s.
      await vi.advanceTimersByTimeAsync(STREAM_SILENCE_RECONNECT_MS + 6_000);
      expect(streamCalls).toBe(3);
      expect(binaryTcpMarketStream.isConnected()).toBe(true);

      // Stream 3 delivers actual 0x21 market-data frames every 10 s: never treated as stalled.
      await vi.advanceTimersByTimeAsync(STREAM_SILENCE_RECONNECT_MS * 3);
      expect(streamCalls).toBe(3);
      expect(binaryTcpMarketStream.isConnected()).toBe(true);
    } finally {
      off();
    }
  });
});
