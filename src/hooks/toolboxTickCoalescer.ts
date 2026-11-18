/**
 * Coalesces per-tick position patches into at most one commit per animation frame.
 * The latest tick per symbol wins; every pending tick is applied to the positions read at flush
 * time, so a concurrent snapshot/refresh write is never overwritten by a stale patch.
 */
export interface TickCoalescer<Tick> {
  push: (tick: Tick) => void;
  dispose: () => void;
}

type Schedule = (run: () => void) => () => void;

// requestAnimationFrame, with a short timer fallback so a hidden/throttled tab still commits.
const defaultSchedule: Schedule = (run) => {
  let raf: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    if (timer !== null) clearTimeout(timer);
    raf = null;
    timer = null;
    run();
  };
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(fire);
  timer = setTimeout(fire, 100);
  return () => {
    if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    if (timer !== null) clearTimeout(timer);
    raf = null;
    timer = null;
  };
};

export const createTickPositionCoalescer = <Position, Tick extends { symbol?: unknown }>({
  getPositions,
  patch,
  commit,
  schedule = defaultSchedule,
}: {
  getPositions: () => Position[];
  patch: (positions: Position[], tick: Tick) => Position[];
  commit: (positions: Position[]) => void;
  schedule?: Schedule;
}): TickCoalescer<Tick> => {
  const pending = new Map<string, Tick>();
  let cancelScheduled: (() => void) | null = null;
  let disposed = false;

  const flush = () => {
    cancelScheduled = null;
    if (disposed || pending.size === 0) return;
    const start = getPositions();
    let next = start;
    for (const tick of pending.values()) next = patch(next, tick);
    pending.clear();
    if (next !== start) commit(next);
  };

  return {
    push: (tick) => {
      if (disposed) return;
      pending.set(String(tick.symbol ?? '').toUpperCase(), tick);
      if (cancelScheduled === null) cancelScheduled = schedule(flush);
    },
    dispose: () => {
      disposed = true;
      pending.clear();
      cancelScheduled?.();
      cancelScheduled = null;
    },
  };
};

/**
 * True when something the chart trade overlay draws changed (positions added/removed, side, volume,
 * open price/time, SL/TP). Pure current-price / profit changes return false.
 */
export const overlayRelevantPositionsChanged = (
  previous: readonly Record<string, unknown>[],
  next: readonly Record<string, unknown>[],
): boolean => {
  if (previous === next) return false;
  if (previous.length !== next.length) return true;
  for (let i = 0; i < next.length; i += 1) {
    const a = previous[i];
    const b = next[i];
    if (a === b) continue;
    if (
      a.id !== b.id
      || a.symbol !== b.symbol
      || a.side !== b.side
      || a.volume !== b.volume
      || a.openPrice !== b.openPrice
      || a.price_open !== b.price_open
      || a.sl !== b.sl
      || a.tp !== b.tp
      || a.price_sl !== b.price_sl
      || a.price_tp !== b.price_tp
      || a.openTime !== b.openTime
      || a.time_create !== b.time_create
      || a.chartEntryPrice !== b.chartEntryPrice
      || a.chartEntryTime !== b.chartEntryTime
      || a.placementState !== b.placementState
    ) return true;
  }
  return false;
};
