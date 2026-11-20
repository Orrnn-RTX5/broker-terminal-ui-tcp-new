import { describe, expect, it } from 'vitest';
import { TickTimestampGuard, FUTURE_TICK_TOLERANCE_MS, JUMP_CONFIRM_WINDOW_MS } from './tickTimestampGuard';
import { upsertFreshestTick } from './liveTickSemantics';

const T0 = 1_760_000_000_000;

const makeGuard = (clientOffsetMs = 0) => {
  const clock = { server: T0 };
  const guard = new TickTimestampGuard(() => clock.server + clientOffsetMs);
  return { guard, clock };
};

describe('TickTimestampGuard', () => {
  it('returns normal ticks untouched, including out-of-order ones', () => {
    const { guard } = makeGuard();
    expect(guard.resolve('EURUSD', T0)).toBe(T0);
    expect(guard.resolve('EURUSD', T0 + 500)).toBe(T0 + 500);
    expect(guard.resolve('EURUSD', T0 + 400)).toBe(T0 + 400);
    expect(guard.resolve('EURUSD', T0 + 400 + FUTURE_TICK_TOLERANCE_MS)).toBe(T0 + 400 + FUTURE_TICK_TOLERANCE_MS);
  });

  it('clamps one future-dated tick so later normal ticks are still fresher than the stored one', () => {
    const { guard, clock } = makeGuard();
    const store = new Map<string, { timestamp: number; bid: number }>();
    const feed = (rawTs: number, bid: number) => {
      const timestamp = guard.resolve('EURUSD', rawTs);
      return upsertFreshestTick(store, 'EURUSD', { timestamp, bid });
    };
    expect(feed(T0, 1.1)).toBe(true);
    clock.server = T0 + 1000;
    expect(feed(T0 + 1000, 1.2)).toBe(true);
    // Wrong server clock: +1 day. The price is still delivered as an equal-time update.
    expect(feed(T0 + 86_400_000, 9.9)).toBe(true);
    expect(store.get('EURUSD')?.timestamp).toBe(T0 + 1000);
    clock.server = T0 + 2000;
    expect(feed(T0 + 2000, 1.3)).toBe(true);
    expect(store.get('EURUSD')).toEqual({ timestamp: T0 + 2000, bid: 1.3 });
    clock.server = T0 + 3000;
    expect(feed(T0 + 3000, 1.4)).toBe(true);
    expect(store.get('EURUSD')?.bid).toBe(1.4);
  });

  it('without the guard the same sequence freezes the symbol (regression baseline)', () => {
    const store = new Map<string, { timestamp: number; bid: number }>();
    upsertFreshestTick(store, 'EURUSD', { timestamp: T0, bid: 1.1 });
    upsertFreshestTick(store, 'EURUSD', { timestamp: T0 + 86_400_000, bid: 9.9 });
    expect(upsertFreshestTick(store, 'EURUSD', { timestamp: T0 + 2000, bid: 1.3 })).toBe(false);
  });

  it('does not treat a client clock minutes behind the server as future ticks', () => {
    const { guard, clock } = makeGuard(-5 * 60_000);
    for (let i = 0; i < 20; i++) {
      clock.server = T0 + i * 700;
      expect(guard.resolve('XAUUSD', clock.server)).toBe(clock.server);
    }
  });

  it('does not reject normal ticks when the client clock is ahead of the server', () => {
    const { guard, clock } = makeGuard(10 * 60_000);
    for (let i = 0; i < 20; i++) {
      clock.server = T0 + i * 700;
      expect(guard.resolve('XAUUSD', clock.server)).toBe(clock.server);
    }
  });

  it('with a client clock behind, a poison tick is still clamped and normal ticks continue', () => {
    const { guard, clock } = makeGuard(-5 * 60_000);
    expect(guard.resolve('EURUSD', T0)).toBe(T0);
    expect(guard.resolve('EURUSD', T0 + 3_600_000)).toBe(T0);
    clock.server = T0 + 1000;
    expect(guard.resolve('EURUSD', T0 + 1000)).toBe(T0 + 1000);
  });

  it('accepts a real jump once a second jump tick confirms it (market reopen / clock correction)', () => {
    const { guard } = makeGuard(-60_000);
    const reopen = T0 + 2 * 86_400_000;
    expect(guard.resolve('EURUSD', T0)).toBe(T0);
    expect(guard.resolve('EURUSD', reopen)).toBe(T0);
    expect(guard.resolve('EURUSD', reopen + 800)).toBe(reopen + 800);
    expect(guard.resolve('EURUSD', reopen + 1600)).toBe(reopen + 1600);
  });

  it('does not confirm two unrelated poison ticks separated by a normal tick', () => {
    const { guard } = makeGuard();
    guard.resolve('EURUSD', T0);
    expect(guard.resolve('EURUSD', T0 + 3_600_000)).toBe(T0);
    expect(guard.resolve('EURUSD', T0 + 500)).toBe(T0 + 500);
    expect(guard.resolve('EURUSD', T0 + 3_600_000 + 1000)).toBe(T0 + 500);
  });

  it('does not confirm jump ticks further apart than the confirm window', () => {
    const { guard } = makeGuard();
    guard.resolve('EURUSD', T0);
    expect(guard.resolve('EURUSD', T0 + 1_000_000)).toBe(T0);
    expect(guard.resolve('EURUSD', T0 + 1_000_000 + JUMP_CONFIRM_WINDOW_MS + 1)).toBe(T0);
  });

  it('uses the newest timestamp of other symbols as reference for a new symbol; first-ever tick is accepted', () => {
    const fresh = makeGuard();
    expect(fresh.guard.resolve('EURUSD', T0)).toBe(T0);
    expect(fresh.guard.resolve('USDJPY', T0 + 3_600_000)).toBe(T0);
    const first = makeGuard();
    expect(first.guard.resolve('EURUSD', T0 + 9_000_000)).toBe(T0 + 9_000_000);
  });

  it('clear() resets references', () => {
    const { guard } = makeGuard();
    guard.resolve('EURUSD', T0);
    guard.clear();
    expect(guard.resolve('EURUSD', T0 + 3_600_000)).toBe(T0 + 3_600_000);
  });

  describe('sparse ticks and clock skew', () => {
    // real = true time; server stamps ticks with real + serverSkew; client reads real + clientSkew.
    const harness = (clientSkew: number, serverSkew = 0) => {
      const h = { real: T0, clientSkew, serverSkew };
      const guard = new TickTimestampGuard(() => h.real + h.clientSkew);
      const tick = (dt: number, symbol = 'EURUSD') => {
        h.real += dt;
        const raw = h.real + h.serverSkew;
        return { raw, out: guard.resolve(symbol, raw) };
      };
      return { h, guard, tick };
    };
    const gaps = [3000, 10_000, 30_000, 4000, 12_000, 25_000, 3000, 10_000];

    it.each([-5 * 60_000, 10 * 60_000, 0])('3-30 s gaps pass untouched with client skew %i ms', (skew) => {
      const { tick } = harness(skew);
      tick(0);
      for (let r = 0; r < 20; r++) {
        for (const g of gaps) {
          const { raw, out } = tick(g);
          expect(out).toBe(raw);
        }
      }
    });

    it('weekend gap consistent with the learned offset passes (client behind and ahead)', () => {
      for (const skew of [-5 * 60_000, 10 * 60_000]) {
        const { tick } = harness(skew);
        tick(0);
        tick(5000);
        const { raw, out } = tick(2 * 86_400_000);
        expect(out).toBe(raw);
        const next = tick(3000);
        expect(next.out).toBe(next.raw);
      }
    });

    it('hours-ahead tick is clamped regardless of client skew, then normal ticks continue', () => {
      for (const skew of [-5 * 60_000, 10 * 60_000]) {
        const { h, guard, tick } = harness(skew);
        tick(0);
        const last = tick(5000).raw;
        h.real += 4000;
        expect(guard.resolve('EURUSD', h.real + 3 * 3_600_000)).toBe(last);
        const next = tick(4000);
        expect(next.out).toBe(next.raw);
      }
    });

    it('source switch with a clock off by minutes: second tick confirms, then sparse ticks pass', () => {
      const { h, tick } = harness(-60_000);
      tick(0);
      for (let i = 0; i < 5; i++) tick(5000);
      const lastOld = h.real;
      h.serverSkew = 3 * 60_000;
      const first = tick(5000);
      expect(first.out).toBe(lastOld);
      const second = tick(5000);
      expect(second.out).toBe(second.raw);
      for (let i = 0; i < 40; i++) {
        const t = tick(5000);
        expect(t.out).toBe(t.raw);
      }
    });

    it('client clock stepped backward (NTP) re-bases after one clamped tick', () => {
      const { h, tick } = harness(0);
      tick(0);
      for (let i = 0; i < 6; i++) tick(5000);
      h.clientSkew = -5 * 60_000;
      tick(5000);
      const second = tick(5000);
      expect(second.out).toBe(second.raw);
      for (let i = 0; i < 20; i++) {
        const t = tick(5000);
        expect(t.out).toBe(t.raw);
      }
    });

    it('client clock stepped forward (NTP) never delays normal ticks', () => {
      const { h, tick } = harness(-5 * 60_000);
      tick(0);
      for (let i = 0; i < 6; i++) tick(5000);
      h.clientSkew = 0;
      for (let i = 0; i < 40; i++) {
        const t = tick(5000);
        expect(t.out).toBe(t.raw);
      }
    });

    it('first tick of the stream is accepted, even far from the client clock', () => {
      const { guard } = makeGuard(-5 * 60_000);
      expect(guard.resolve('EURUSD', T0 + 10 * 3_600_000)).toBe(T0 + 10 * 3_600_000);
    });
  });
});
