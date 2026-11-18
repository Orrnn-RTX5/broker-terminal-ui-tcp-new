// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capRecentHistoryTrades,
  hashString32,
  MAX_HISTORY_OVERLAY_TRADES,
  reconcileHistoryOverlayNodes,
  type HistoryOverlayEntries,
} from './tradeHistoryOverlayReconcile';
import type { OverlayNodeData } from './tradeRuntimeContracts';

afterEach(() => { document.body.innerHTML = ''; });

type Trade = { key: string; content: string };

const setup = () => {
  const nodesRef = { current: [] as HTMLElement[] };
  const dataRef = { current: [] as OverlayNodeData[] };
  const entries: HistoryOverlayEntries = new Map();
  const create = vi.fn((trade: Trade) => {
    // line + 2 markers + 2 hover targets, like the real history renderer
    for (let i = 0; i < 5; i += 1) {
      const el = document.createElement('div');
      el.dataset.tradeKey = trade.key;
      document.body.append(el);
      nodesRef.current.push(el);
      dataRef.current.push({ kind: i === 0 ? 'segment' : 'marker' });
    }
  });
  const run = (trades: Trade[]) => reconcileHistoryOverlayNodes({
    desired: trades.map((trade) => ({ key: trade.key, contentKey: trade.content, item: trade })),
    entries, nodesRef, dataRef, create,
  });
  return { nodesRef, dataRef, entries, create, run };
};

const makeTrades = (count: number): Trade[] => Array.from({ length: count }, (_, i) => ({
  key: `trade:${1000 + i}`, content: `c${i}`,
}));

describe('reconcileHistoryOverlayNodes', () => {
  it('adding one closed trade to 300 creates one trade worth of nodes and removes none', () => {
    const { nodesRef, dataRef, create, run } = setup();
    const trades = makeTrades(300);
    expect(run(trades)).toEqual({ created: 300, removed: 0, kept: 0 });
    expect(nodesRef.current).toHaveLength(1500);
    const before = new Set(nodesRef.current);
    const removeSpies = nodesRef.current.slice(0, 50).map((el) => vi.spyOn(el, 'remove'));
    create.mockClear();

    const added: Trade = { key: 'trade:5000', content: 'new' };
    expect(run([...trades, added])).toEqual({ created: 1, removed: 0, kept: 300 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(added);
    expect(nodesRef.current).toHaveLength(1505);
    expect(dataRef.current).toHaveLength(1505);
    // Every pre-existing node is the very same element (never recreated or detached).
    expect(nodesRef.current.slice(0, 1500).every((el) => before.has(el))).toBe(true);
    removeSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    expect(document.body.querySelectorAll('[data-trade-key]')).toHaveLength(1505);
  });

  it('removes only the gone trade and recreates only a trade whose content changed', () => {
    const { nodesRef, dataRef, create, run } = setup();
    const trades = makeTrades(10);
    run(trades);
    create.mockClear();

    const next = trades.filter((trade) => trade.key !== 'trade:1003').map((trade) => (
      trade.key === 'trade:1005' ? { ...trade, content: 'changed' } : trade
    ));
    expect(run(next)).toEqual({ created: 1, removed: 2, kept: 8 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(nodesRef.current).toHaveLength(45);
    expect(dataRef.current).toHaveLength(45);
    expect(document.body.querySelectorAll('[data-trade-key="trade:1003"]')).toHaveLength(0);
    expect(document.body.querySelectorAll('[data-trade-key="trade:1005"]')).toHaveLength(5);
  });

  it('does nothing when the set is unchanged', () => {
    const { create, run } = setup();
    const trades = makeTrades(20);
    run(trades);
    create.mockClear();
    expect(run(trades)).toEqual({ created: 0, removed: 0, kept: 20 });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('history overlay cap and signature helpers', () => {
  it('keeps only the most recent trades above the cap', () => {
    const trades = Array.from({ length: MAX_HISTORY_OVERLAY_TRADES + 40 }, (_, i) => ({
      key: `trade:${i}`, entryTime: 1000 + i, exitTime: 1001 + i,
    }));
    const capped = capRecentHistoryTrades(trades);
    expect(capped).toHaveLength(MAX_HISTORY_OVERLAY_TRADES);
    expect(capped.some((trade) => trade.key === 'trade:0')).toBe(false);
    expect(capped.some((trade) => trade.key === `trade:${MAX_HISTORY_OVERLAY_TRADES + 39}`)).toBe(true);
    const small = trades.slice(0, 5);
    expect(capRecentHistoryTrades(small)).toBe(small);
  });

  it('hashes deterministically and distinguishes different content', () => {
    expect(hashString32('abc')).toBe(hashString32('abc'));
    expect(hashString32('abc')).not.toBe(hashString32('abd'));
  });
});
