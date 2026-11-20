// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { selectTickCount, useAppStore, type Tick } from './useAppStore';

const tick = (symbol: string, timestamp: number): Tick => ({
  symbol, bid: 1.1, ask: 1.2, spread: 0.1, timestamp,
});

const exact = () => Object.keys(useAppStore.getState().ticks).length;
const counter = () => useAppStore.getState().tickCount;

describe('tick count counter', () => {
  beforeEach(() => {
    useAppStore.setState({ ticks: {}, tickLookup: {} });
  });

  it('matches the number of tick keys across add, update, batch, replace and clear', () => {
    const store = useAppStore.getState();
    expect(selectTickCount(useAppStore.getState())).toBe(0);

    store.setTick('AAA', tick('AAA', 1));
    expect(counter()).toBe(1);
    store.setTick('AAA', tick('AAA', 2));
    expect(counter()).toBe(1);
    expect(useAppStore.getState().ticks.AAA.timestamp).toBe(2);

    store.setTicksBatch([['BBB', tick('BBB', 1)], ['CCC', tick('CCC', 1)], ['AAA', tick('AAA', 3)]]);
    expect(counter()).toBe(3);
    expect(selectTickCount(useAppStore.getState())).toBe(exact());

    // stale frame for existing symbol and duplicate entries in one batch
    store.setTicksBatch([['BBB', tick('BBB', 0)], ['DDD', tick('DDD', 1)], ['DDD', tick('DDD', 2)]]);
    expect(counter()).toBe(4);
    expect(counter()).toBe(exact());

    store.setTicks({ X: tick('X', 1), Y: tick('Y', 1) });
    expect(counter()).toBe(2);
    store.setTick('Z', tick('Z', 1));
    expect(counter()).toBe(3);
    expect(counter()).toBe(exact());

    store.setTicks({});
    expect(counter()).toBe(0);
    expect(selectTickCount(useAppStore.getState())).toBe(0);
  });

  it('stays exact when ticks is replaced directly through setState', () => {
    useAppStore.getState().setTick('AAA', tick('AAA', 1));
    useAppStore.setState({ ticks: { P: tick('P', 1), Q: tick('Q', 1), R: tick('R', 1) } });
    expect(selectTickCount(useAppStore.getState())).toBe(3);
    useAppStore.getState().setTick('S', tick('S', 1));
    expect(selectTickCount(useAppStore.getState())).toBe(4);
    expect(counter()).toBe(exact());
    useAppStore.setState({ ticks: {} });
    expect(selectTickCount(useAppStore.getState())).toBe(0);
  });

  it('matches exactly on randomized write sequences', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const store = useAppStore.getState();
    let ts = 1;
    for (let step = 0; step < 300; step += 1) {
      const roll = rnd();
      if (roll < 0.05) store.setTicks(Object.fromEntries(Array.from({ length: Math.floor(rnd() * 5) }, (_, i) => [`R${i}`, tick(`R${i}`, ts)])));
      else if (roll < 0.1) useAppStore.setState({ ticks: {} });
      else {
        const batch: Array<[string, Tick]> = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => {
          const s = `S${Math.floor(rnd() * 40)}`;
          ts += rnd() < 0.8 ? 1 : -1;
          return [s, tick(s, ts)];
        });
        store.setTicksBatch(batch);
      }
      expect(selectTickCount(useAppStore.getState())).toBe(exact());
    }
  });
});
