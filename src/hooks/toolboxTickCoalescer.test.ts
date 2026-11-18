import { describe, expect, it, vi } from 'vitest';
import { createTickPositionCoalescer, overlayRelevantPositionsChanged } from './toolboxTickCoalescer';

type Pos = { id: number; symbol: string; currentPrice: number; profit: number; sl?: number; tp?: number; openPrice?: number };

const makeFrameScheduler = () => {
  const queue: Array<() => void> = [];
  const schedule = vi.fn((run: () => void) => {
    queue.push(run);
    return () => { const i = queue.indexOf(run); if (i >= 0) queue.splice(i, 1); };
  });
  const frame = () => { const pending = queue.splice(0); pending.forEach((run) => run()); };
  return { schedule, frame, pending: () => queue.length };
};

const patch = (positions: Pos[], tick: { symbol: string; bid: number }): Pos[] => {
  let changed = false;
  const next = positions.map((position) => {
    if (position.symbol !== tick.symbol || position.currentPrice === tick.bid) return position;
    changed = true;
    return { ...position, currentPrice: tick.bid, profit: tick.bid * 10 };
  });
  return changed ? next : positions;
};

describe('createTickPositionCoalescer', () => {
  it('commits at most once per frame no matter how many ticks arrive, using the latest per symbol', () => {
    let positions: Pos[] = [
      { id: 1, symbol: 'EURUSD', currentPrice: 1, profit: 0 },
      { id: 2, symbol: 'GBPUSD', currentPrice: 2, profit: 0 },
    ];
    const commit = vi.fn((next: Pos[]) => { positions = next; });
    const { schedule, frame, pending } = makeFrameScheduler();
    const coalescer = createTickPositionCoalescer({ getPositions: () => positions, patch, commit, schedule });

    for (let i = 1; i <= 200; i += 1) coalescer.push({ symbol: 'EURUSD', bid: 1 + i / 1000 });
    coalescer.push({ symbol: 'GBPUSD', bid: 2.5 });
    expect(commit).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(pending()).toBe(1);

    frame();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(positions[0].currentPrice).toBeCloseTo(1.2, 6);
    expect(positions[1].currentPrice).toBe(2.5);
    expect(positions[0].profit).toBeCloseTo(12, 6);

    // Next frame: a new tick schedules a new single commit.
    coalescer.push({ symbol: 'EURUSD', bid: 1.5 });
    frame();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('applies patches to the positions read at flush time and skips no-op frames', () => {
    let positions: Pos[] = [{ id: 1, symbol: 'EURUSD', currentPrice: 1, profit: 0 }];
    const commit = vi.fn((next: Pos[]) => { positions = next; });
    const { schedule, frame } = makeFrameScheduler();
    const coalescer = createTickPositionCoalescer({ getPositions: () => positions, patch, commit, schedule });

    coalescer.push({ symbol: 'EURUSD', bid: 1.1 });
    // A snapshot replaces the positions between the tick and the frame: it must not be overwritten.
    positions = [{ id: 1, symbol: 'EURUSD', currentPrice: 1, profit: 0, sl: 0.9 }, { id: 3, symbol: 'EURUSD', currentPrice: 1, profit: 0 }];
    frame();
    expect(positions.map((p) => p.id)).toEqual([1, 3]);
    expect(positions[0].sl).toBe(0.9);
    expect(positions[0].currentPrice).toBe(1.1);

    commit.mockClear();
    coalescer.push({ symbol: 'EURUSD', bid: 1.1 });
    frame();
    expect(commit).not.toHaveBeenCalled();
  });

  it('drops pending work on dispose', () => {
    const commit = vi.fn();
    const { schedule, frame, pending } = makeFrameScheduler();
    const coalescer = createTickPositionCoalescer({ getPositions: () => [] as Pos[], patch, commit, schedule });
    coalescer.push({ symbol: 'EURUSD', bid: 1 });
    coalescer.dispose();
    expect(pending()).toBe(0);
    frame();
    coalescer.push({ symbol: 'EURUSD', bid: 2 });
    frame();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('overlayRelevantPositionsChanged', () => {
  const base: Pos = { id: 1, symbol: 'EURUSD', currentPrice: 1, profit: 0, sl: 0.9, tp: 1.2, openPrice: 1.05 };

  it('ignores pure current-price / profit changes', () => {
    expect(overlayRelevantPositionsChanged([base], [{ ...base, currentPrice: 1.01, profit: 5 }])).toBe(false);
  });

  it('flags added/removed rows and SL / TP / open price changes', () => {
    expect(overlayRelevantPositionsChanged([base], [base, { ...base, id: 2 }])).toBe(true);
    expect(overlayRelevantPositionsChanged([base], [])).toBe(true);
    expect(overlayRelevantPositionsChanged([base], [{ ...base, sl: 0.8 }])).toBe(true);
    expect(overlayRelevantPositionsChanged([base], [{ ...base, tp: 1.3 }])).toBe(true);
    expect(overlayRelevantPositionsChanged([base], [{ ...base, openPrice: 1.06 }])).toBe(true);
  });

  it('flags alias-only changes (price_open, price_sl, price_tp)', () => {
    const aliased = { ...base, price_open: 1.05, price_sl: 0.9, price_tp: 1.2 };
    expect(overlayRelevantPositionsChanged([aliased], [{ ...aliased, price_open: 1.07 }])).toBe(true);
    expect(overlayRelevantPositionsChanged([aliased], [{ ...aliased, price_sl: 0.85 }])).toBe(true);
    expect(overlayRelevantPositionsChanged([aliased], [{ ...aliased, price_tp: 1.25 }])).toBe(true);
    expect(overlayRelevantPositionsChanged([aliased], [{ ...aliased, currentPrice: 2 }])).toBe(false);
  });
});
