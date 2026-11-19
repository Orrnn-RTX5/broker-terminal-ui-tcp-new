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

import { binaryTcpMarketStream, STREAM_SILENCE_RECONNECT_MS } from './binaryTcpMarketStream';

type StreamMode = 'silent' | 'keepalive';

// A stream body whose reader either never delivers a byte (a stalled proxy/socket) or delivers one FramePing
// keepalive every 10 s like the Go stream servers. Both end with an AbortError when the request is aborted.
function streamBody(mode: StreamMode, signal: AbortSignal) {
  return {
    getReader: () => ({
      read: () => new Promise<{ value?: Uint8Array; done: boolean }>((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        if (mode === 'keepalive') {
          setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve({ value: new Uint8Array([0x01, 0x00, 0x00, 0x00]), done: false });
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
        const mode = modes[streamCalls] ?? 'keepalive';
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

  it('reconnects a stream that delivers nothing, and keeps a stream that delivers keepalives', async () => {
    modes.push('silent', 'keepalive');
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

      // The new stream delivers a keepalive every 10 s: it is never treated as stalled.
      await vi.advanceTimersByTimeAsync(STREAM_SILENCE_RECONNECT_MS * 3);
      expect(streamCalls).toBe(2);
      expect(binaryTcpMarketStream.isConnected()).toBe(true);
    } finally {
      off();
    }
  });
});
