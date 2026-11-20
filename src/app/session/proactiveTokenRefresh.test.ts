import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROACTIVE_REFRESH_LEAD_MS,
  PROACTIVE_REFRESH_RETRY_MS,
  computeProactiveRefreshDelayMs,
  startProactiveTokenRefresh,
} from './proactiveTokenRefresh';

const H = 3_600_000;

describe('computeProactiveRefreshDelayMs', () => {
  it('24 h token renews at 80% of lifetime (earlier than 5 min before expiry)', () => {
    expect(computeProactiveRefreshDelayMs(24 * H, 0)).toBeCloseTo(0.8 * 24 * H, 3);
  });
  it('short token renews 5 minutes before expiry', () => {
    expect(computeProactiveRefreshDelayMs(10 * 60_000, 0)).toBe(10 * 60_000 - PROACTIVE_REFRESH_LEAD_MS);
  });
  it('never fires faster than half of / 60 s of the remaining lifetime (no refresh loop)', () => {
    expect(computeProactiveRefreshDelayMs(120_000, 0)).toBe(60_000);
    expect(computeProactiveRefreshDelayMs(20_000, 0)).toBe(10_000);
  });
  it('returns null when already expired', () => {
    expect(computeProactiveRefreshDelayMs(1000, 1000)).toBeNull();
    expect(computeProactiveRefreshDelayMs(500, 1000)).toBeNull();
  });
});

describe('startProactiveTokenRefresh', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  const make = (overrides: Partial<{ token: string | null; expiry: number | null }> = {}) => {
    const state: { token: string | null; expiry: number | null } = {
      token: 'tok-a',
      expiry: Date.now() + 24 * H,
      ...overrides,
    };
    const refresh = vi.fn(() => Promise.resolve('new'));
    const stop = startProactiveTokenRefresh({ getExpiryMs: () => state.expiry, getToken: () => state.token, refresh });
    return { state, refresh, stop };
  };

  it('fires before expiry, once', async () => {
    const { refresh } = make();
    await vi.advanceTimersByTimeAsync(0.8 * 24 * H - 1);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * H);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('is cleared on logout / account switch (stop)', async () => {
    const { refresh, stop } = make();
    stop();
    await vi.advanceTimersByTimeAsync(24 * H);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not refresh if the token changed meanwhile (session switch)', async () => {
    const { refresh, state } = make();
    state.token = 'tok-b';
    await vi.advanceTimersByTimeAsync(24 * H);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('retries after a failed refresh while still before expiry, and stops once stopped', async () => {
    const state = { token: 'tok-a', expiry: Date.now() + 24 * H };
    const refresh = vi.fn(() => Promise.reject(new Error('net')));
    const stop = startProactiveTokenRefresh({ getExpiryMs: () => state.expiry, getToken: () => state.token, refresh });
    await vi.advanceTimersByTimeAsync(0.8 * 24 * H + 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PROACTIVE_REFRESH_RETRY_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(10 * PROACTIVE_REFRESH_RETRY_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('schedules nothing without token or expiry, or when expired', async () => {
    const a = make({ token: null });
    const b = make({ expiry: null });
    const c = make({ expiry: Date.now() - 1 });
    await vi.advanceTimersByTimeAsync(24 * H);
    expect(a.refresh).not.toHaveBeenCalled();
    expect(b.refresh).not.toHaveBeenCalled();
    expect(c.refresh).not.toHaveBeenCalled();
  });
});
