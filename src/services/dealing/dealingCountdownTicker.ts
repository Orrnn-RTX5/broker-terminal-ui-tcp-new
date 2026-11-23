/**
 * Shared 100 ms dealing countdown ticker.
 *
 * Maintains a single interval across all mounted `useDealingRequest` instances,
 * pauses automatically while the document tab is hidden, and immediately syncs
 * on visibility restoration.
 */

export const DEALING_COUNTDOWN_TICK_MS = 100;

type TickListener = () => void;

const listeners = new Set<TickListener>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let visibilityBound = false;
let snapshotNowMs = Date.now();

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function stopInterval(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function emitTick(nowMs: number): void {
  snapshotNowMs = nowMs;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // m2: Never let a throwing subscriber break the shared 100 ms interval.
    }
  }
}

function startIntervalIfNeeded(): void {
  if (intervalHandle !== null || listeners.size === 0 || isDocumentHidden()) {
    return;
  }
  intervalHandle = setInterval(() => {
    emitTick(Date.now());
  }, DEALING_COUNTDOWN_TICK_MS);
}

function handleVisibilityChange(): void {
  if (listeners.size === 0) return;
  if (isDocumentHidden()) {
    stopInterval();
  } else {
    emitTick(Date.now());
    startIntervalIfNeeded();
  }
}

function bindVisibilityListener(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  visibilityBound = true;
}

function unbindVisibilityListener(): void {
  if (!visibilityBound || typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  visibilityBound = false;
}

/**
 * Subscribe a UI consumer (typically via `useSyncExternalStore`) to the shared
 * 100 ms countdown ticker.
 */
export function subscribeDealingCountdownTick(listener: TickListener): () => void {
  const wasEmpty = listeners.size === 0;
  listeners.add(listener);
  if (wasEmpty) {
    snapshotNowMs = Date.now();
    bindVisibilityListener();
  }
  startIntervalIfNeeded();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopInterval();
      unbindVisibilityListener();
    }
  };
}

/** Returns the current ticker timestamp snapshot in epoch milliseconds. */
export function getDealingCountdownTickNowMs(): number {
  if (listeners.size === 0) {
    const now = Date.now();
    if (Math.abs(now - snapshotNowMs) >= DEALING_COUNTDOWN_TICK_MS) {
      snapshotNowMs = now;
    }
  }
  return snapshotNowMs;
}

/** Syncs the ticker baseline to `Date.now()` (used on store reset / fake-timer setup). */
export function syncDealingCountdownTickerNow(): void {
  snapshotNowMs = Date.now();
  if (listeners.size > 0) {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // m2: Isolate listener error during baseline sync.
      }
    }
  }
}

/** Exposed strictly for deterministic unit tests. */
export function getDealingCountdownTickerStats(): {
  listenerCount: number;
  intervalActive: boolean;
} {
  return {
    listenerCount: listeners.size,
    intervalActive: intervalHandle !== null,
  };
}

/** Stops timers and clears listeners (used in test teardown / store reset). */
export function resetDealingCountdownTicker(): void {
  stopInterval();
  unbindVisibilityListener();
  listeners.clear();
  snapshotNowMs = Date.now();
}
