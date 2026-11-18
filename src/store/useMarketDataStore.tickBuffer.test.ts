// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workerMocks = vi.hoisted(() => ({
  aggregateSymbols: vi.fn(),
}));
vi.mock('../services/aggregationWorkerManager', () => ({
  cancelPendingAggregations: vi.fn(),
  getWorkerManager: () => workerMocks,
}));

import {
  appendBoundedTick,
  MARKET_TICK_BUFFER_LIMIT,
  pushBoundedTickInPlace,
  useMarketDataStore,
  type Tick,
} from './useMarketDataStore';

const BASE = 1_800_000_000_000;

const tick = (offset: number, overrides: Partial<Tick> = {}): Tick => ({
  symbol: 'XAUUSD',
  bid: 2_500 + offset / 1_000_000,
  ask: 2_500.2 + offset / 1_000_000,
  spread: 0.2,
  timestamp: BASE + offset,
  sourceTimestamp: BASE + offset,
  lp: 'test',
  volume: 1,
  ...overrides,
});

const push = (offset: number, overrides: Partial<Tick> = {}) => {
  useMarketDataStore.getState().updateTick('XAUUSD', tick(offset, overrides), { syncAppStore: false });
};

const buffer = () => useMarketDataStore.getState().symbolData.XAUUSD.tickBuffer;

describe('market tick buffer (in-place append)', () => {
  beforeEach(() => {
    workerMocks.aggregateSymbols.mockReset();
    useMarketDataStore.getState().clearAllData();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushBoundedTickInPlace keeps order, mutates in place and never exceeds the limit', () => {
    const ticks: Tick[] = [];
    for (let index = 0; index < 25_000; index += 1) {
      const returned = pushBoundedTickInPlace(ticks, tick(index));
      expect(returned).toBe(ticks);
      expect(ticks.length).toBeLessThanOrEqual(MARKET_TICK_BUFFER_LIMIT);
    }
    expect(ticks).toHaveLength(MARKET_TICK_BUFFER_LIMIT);
    expect(ticks[0].timestamp).toBe(BASE + 15_000);
    expect(ticks.at(-1)?.timestamp).toBe(BASE + 24_999);
    expect(ticks.every((item, index) => index === 0 || item.timestamp > ticks[index - 1].timestamp)).toBe(true);
  });

  it('pushBoundedTickInPlace matches the pure appendBoundedTick for small limits', () => {
    for (const limit of [0, 1, 2, 3, 5]) {
      let pure: Tick[] = [];
      const inPlace: Tick[] = [];
      for (let index = 0; index < 12; index += 1) {
        pure = appendBoundedTick(pure, tick(index), limit);
        pushBoundedTickInPlace(inPlace, tick(index), limit);
        expect(inPlace.map(item => item.timestamp)).toEqual(pure.map(item => item.timestamp));
      }
    }
  });

  it('keeps exactly the last 10_000 ticks, oldest to newest, after 25_000 store updates', () => {
    for (let index = 0; index < 25_000; index += 1) push(index);

    const ticks = buffer();
    expect(ticks).toHaveLength(MARKET_TICK_BUFFER_LIMIT);
    expect(ticks[0].timestamp).toBe(BASE + 15_000);
    expect(ticks.at(-1)?.timestamp).toBe(BASE + 24_999);
    expect(useMarketDataStore.getState().symbolData.XAUUSD.currentTick?.timestamp).toBe(BASE + 24_999);
    expect(useMarketDataStore.getState().symbolData.XAUUSD.tickBufferRevision).toBe(25_000);
  });

  it('appends without copying: the buffer array identity is stable across live ticks', () => {
    push(0);
    const first = buffer();
    push(1);
    push(2);
    expect(buffer()).toBe(first);
    expect(first.map(item => item.timestamp)).toEqual([BASE, BASE + 1, BASE + 2]);
  });

  it('notifies selector subscribers through the revision on every appended tick', () => {
    const seen: number[] = [];
    const unsubscribe = useMarketDataStore.subscribe(
      state => state.symbolData.XAUUSD?.tickBufferRevision ?? 0,
      revision => { seen.push(revision); },
    );
    push(0);
    push(1);
    push(2);
    unsubscribe();
    expect(seen).toEqual([1, 2, 3]);
  });

  it('bumps the revision and replaces the buffer on clearTickBuffer', () => {
    push(0);
    push(1);
    const before = useMarketDataStore.getState().symbolData.XAUUSD;
    useMarketDataStore.getState().clearTickBuffer('XAUUSD');
    const after = useMarketDataStore.getState().symbolData.XAUUSD;
    expect(after.tickBuffer).toHaveLength(0);
    expect(after.tickBuffer).not.toBe(before.tickBuffer);
    expect(after.tickBufferRevision).toBe((before.tickBufferRevision ?? 0) + 1);
  });

  it('keeps the same-timestamp correction path correct on a full buffer', () => {
    for (let index = 0; index < MARKET_TICK_BUFFER_LIMIT + 50; index += 1) push(index);
    const lastOffset = MARKET_TICK_BUFFER_LIMIT + 49;
    const revisionBefore = useMarketDataStore.getState().symbolData.XAUUSD.tickBufferRevision ?? 0;

    push(lastOffset, { bid: 1, ask: 1.2, lp: 'fixed' });

    const data = useMarketDataStore.getState().symbolData.XAUUSD;
    expect(data.tickBuffer).toHaveLength(MARKET_TICK_BUFFER_LIMIT);
    expect(data.tickBuffer.at(-1)).toMatchObject({ bid: 1, lp: 'fixed', timestamp: BASE + lastOffset });
    expect(data.tickBuffer.at(-2)?.timestamp).toBe(BASE + lastOffset - 1);
    expect(data.currentTick).toMatchObject({ bid: 1, lp: 'fixed' });
    expect(data.previousTick?.timestamp).toBe(BASE + lastOffset - 1);
    expect(data.tickBufferRevision).toBe(revisionBefore + 1);
  });

  it('computes 24h stats over exactly the retained last 10_000 ticks', () => {
    const recent = Date.now() - 60_000;
    for (let index = 0; index < MARKET_TICK_BUFFER_LIMIT + 2_000; index += 1) {
      push(0, { timestamp: recent + index, sourceTimestamp: recent + index, volume: 1 });
    }
    // A same-timestamp correction forces a stats recalculation on the live buffer.
    const lastTimestamp = recent + MARKET_TICK_BUFFER_LIMIT + 1_999;
    push(0, { timestamp: lastTimestamp, sourceTimestamp: lastTimestamp, volume: 1, bid: 2_500.5, ask: 2_500.7 });

    const stats = useMarketDataStore.getState().symbolData.XAUUSD.stats;
    expect(stats?.volume24h).toBe(MARKET_TICK_BUFFER_LIMIT);
  });

  it('posts an immutable snapshot of the last 10_000 ticks to the aggregation worker', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BASE);
    push(0);
    expect(workerMocks.aggregateSymbols).toHaveBeenCalledTimes(1);
    const firstPayload = workerMocks.aggregateSymbols.mock.calls[0][0][0].tickBuffer as Tick[];
    expect(firstPayload).toHaveLength(1);
    expect(firstPayload).not.toBe(buffer());

    for (let index = 1; index < 12_000; index += 1) push(index);
    // Later in-place appends never leak into the earlier snapshot.
    expect(firstPayload).toHaveLength(1);
    expect(workerMocks.aggregateSymbols).toHaveBeenCalledTimes(1);

    vi.setSystemTime(BASE + 61_000);
    push(12_000);
    expect(workerMocks.aggregateSymbols).toHaveBeenCalledTimes(2);
    const payload = workerMocks.aggregateSymbols.mock.calls[1][0][0].tickBuffer as Tick[];
    expect(payload).toHaveLength(MARKET_TICK_BUFFER_LIMIT);
    expect(payload[0].timestamp).toBe(BASE + 2_001);
    expect(payload.at(-1)?.timestamp).toBe(BASE + 12_000);
    expect(payload).not.toBe(buffer());
  });
});
