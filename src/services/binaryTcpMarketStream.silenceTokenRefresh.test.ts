import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  token: '',
  calls: [] as string[],
  refreshImpl: async () => null as string | null,
}));

vi.mock('../config/backendTarget.js', () => ({ isDesktopBackendTarget: () => true }));
vi.mock('./binaryTcpOrderClient', () => ({
  getActiveBinaryTcpOrderCount: () => 0,
  getBinaryTcpOrderActiveDurationMs: () => 0,
  onBinaryTcpOrdersIdle: () => undefined,
  prewarmBinaryOrderSocket: () => undefined,
  syncBinaryOrderAuthToken: () => undefined,
}));
vi.mock('./brokerSession', () => ({
  getAccessToken: () => harness.token,
  getAccountLogin: () => 0,
  onSessionChange: () => undefined,
}));
vi.mock('../api/brokerApi', () => ({
  brokerApi: {
    refreshTokenAhead: () => {
      harness.calls.push('refresh');
      return harness.refreshImpl();
    },
  },
}));

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
// Fake, unsigned test JWT (never a real credential).
const fakeJwt = (expSec: number) => `${b64url({ alg: 'none' })}.${b64url({ account_login: 200001, exp: expSec })}.sig`;

type StreamModule = typeof import('./binaryTcpMarketStream');

describe('silence reconnect refreshes a stale access token before re-binding the account subscription', () => {
  let mod: StreamModule;
  let streamCalls = 0;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    harness.calls = [];
    harness.token = '';
    harness.refreshImpl = async () => null;
    streamCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/__rtx5_binary_stream') {
        streamCalls += 1;
        const signal = init!.signal as AbortSignal;
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              // Silent stream: never delivers a byte, so the watchdog fires.
              read: () => new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
              }),
            }),
          },
        };
      }
      if (url === '/__rtx5_binary_account_sub') {
        harness.calls.push('account_sub');
        return { ok: true, status: 200 };
      }
      return { ok: true, status: 200 };
    }));
    mod = await import('./binaryTcpMarketStream');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const runThroughOneSilenceReconnect = async () => {
    const off = mod.binaryTcpMarketStream.onStateChange(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(streamCalls).toBe(1);
    // Silence limit + check interval + reconnect backoff.
    await vi.advanceTimersByTimeAsync(mod.STREAM_SILENCE_RECONNECT_MS + 12_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(streamCalls).toBeGreaterThanOrEqual(2);
    return off;
  };

  it('expired JWT: refresh is called before the account-sub POST on the reconnected stream', async () => {
    harness.token = fakeJwt(Math.floor(Date.now() / 1000) - 600);
    let resolveRefresh: (value: string | null) => void = () => undefined;
    harness.refreshImpl = () => new Promise<string | null>((resolve) => { resolveRefresh = resolve; });

    const off = await runThroughOneSilenceReconnect();
    try {
      // First stream bound the (expired) token immediately; the reconnected stream asks for the refresh FIRST.
      expect(harness.calls[0]).toBe('account_sub');
      expect(harness.calls[1]).toBe('refresh');

      // The refresh hangs: the re-bind still happens after the bounded wait, never before the refresh started.
      await vi.advanceTimersByTimeAsync(mod.STREAM_TOKEN_REFRESH_WAIT_MS);
      expect(harness.calls.slice(1)).toEqual(['refresh', 'account_sub']);

      harness.token = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
      resolveRefresh(harness.token);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls.filter((call) => call === 'refresh')).toHaveLength(1);
    } finally {
      off();
    }
  });

  it('JWT near expiry (< 60 s left) is refreshed as well', async () => {
    harness.token = fakeJwt(Math.floor(Date.now() / 1000) + 20 + 60 * 0);
    const off = await runThroughOneSilenceReconnect();
    try {
      expect(harness.calls).toContain('refresh');
      expect(harness.calls.indexOf('refresh')).toBeLessThan(harness.calls.lastIndexOf('account_sub'));
    } finally {
      off();
    }
  });

  it('valid JWT: no refresh, account subscription re-bound on the new stream', async () => {
    harness.token = fakeJwt(Math.floor(Date.now() / 1000) + 3 * 3600);
    const off = await runThroughOneSilenceReconnect();
    try {
      expect(harness.calls).not.toContain('refresh');
      expect(harness.calls.filter((call) => call === 'account_sub').length).toBeGreaterThanOrEqual(2);
    } finally {
      off();
    }
  });

  it('refresh failure keeps today\'s behaviour: re-binds with the stored token and does not loop', async () => {
    harness.token = fakeJwt(Math.floor(Date.now() / 1000) - 600);
    harness.refreshImpl = async () => { throw new Error('refresh failed'); };
    const off = await runThroughOneSilenceReconnect();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.calls.filter((call) => call === 'refresh')).toHaveLength(1);
      expect(harness.calls.filter((call) => call === 'account_sub').length).toBeGreaterThanOrEqual(2);
    } finally {
      off();
    }
  });

  it('is single-flight: concurrent stale checks share one refresh call', async () => {
    harness.token = fakeJwt(Math.floor(Date.now() / 1000) - 600);
    let resolveRefresh: (value: string | null) => void = () => undefined;
    harness.refreshImpl = () => new Promise<string | null>((resolve) => { resolveRefresh = resolve; });
    const stream = mod.binaryTcpMarketStream as unknown as { refreshTokenIfStale(token: string): Promise<void> };
    const first = stream.refreshTokenIfStale(harness.token);
    const second = stream.refreshTokenIfStale(harness.token);
    await vi.advanceTimersByTimeAsync(0);
    resolveRefresh(null);
    await Promise.all([first, second]);
    expect(harness.calls.filter((call) => call === 'refresh')).toHaveLength(1);
  });
});
