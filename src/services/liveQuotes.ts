// Latest (spread-widened) quote per held symbol.
//
// A market tick only writes here: O(1), no store write, no per-position work. Rows, the footer,
// the chart overlay and the other live consumers read the price at render time through
// livePositionMetrics.ts. Subscribers are notified at most once per animation frame, with a
// 100 ms timer fallback for hidden/throttled tabs where requestAnimationFrame is paused.
//
// Freshness rule (mirrors the previous patchPositionsFromTick behaviour): the most recently
// ARRIVED data wins, with no timestamp comparison, so a backend clock that differs from the tick
// clock can never switch live P/L off. A backend position write that carries new price/profit
// data calls invalidateLiveQuote(symbol), so that snapshot wins over the older quote until the
// next tick for the symbol arrives.
import {
  onCommittedBrokerAccountSessionScopeChange,
  onSessionChange,
} from './brokerSession';

export type LiveQuote = {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: unknown;
  seq: number;
};

const quotes = new Map<string, LiveQuote>();
const rawSymbolCache = new Map<string, string>();
const subs = new Set<() => void>();
export const LIVE_QUOTES_WATCHDOG_MS = 100;
let version = 0;
let quoteSeq = 0;
let scheduled = false;
let scheduledAt = 0;
let rafId: number | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

const normalizeSymbol = (raw: unknown): string => {
  if (typeof raw === 'string') {
    const cached = rawSymbolCache.get(raw);
    if (cached !== undefined) return cached;
    const norm = raw.trim().toUpperCase();
    if (rawSymbolCache.size < 4096) rawSymbolCache.set(raw, norm);
    return norm;
  }
  return String(raw ?? '').trim().toUpperCase();
};

const cancelRaf = (): void => {
  if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
  rafId = null;
};

const cancelPending = (): void => {
  cancelRaf();
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
};

const emitNotify = (): void => {
  version += 1;
  subs.forEach((fn) => {
    try {
      fn();
    } catch {
      // Isolate subscriber errors so the remaining live panels stay updated.
    }
  });
};

const fire = (): void => {
  if (!scheduled) return;
  scheduled = false;
  // A still-pending rAF is cancelled; an armed watchdog expires harmlessly (scheduled === false).
  cancelRaf();
  emitNotify();
};

const armWatchdog = (delayMs: number): void => {
  if (watchdogTimer !== null) return;
  watchdogTimer = setTimeout(onWatchdog, delayMs);
};

function onWatchdog(): void {
  watchdogTimer = null;
  if (!scheduled) return;
  const elapsed = Date.now() - scheduledAt;
  if (elapsed >= LIVE_QUOTES_WATCHDOG_MS) {
    fire();
    return;
  }
  armWatchdog(Math.max(1, LIVE_QUOTES_WATCHDOG_MS - elapsed));
}

const scheduleFlush = (): void => {
  if (scheduled) return;
  scheduled = true;
  scheduledAt = Date.now();
  if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(fire);
  // Hidden/throttled tabs pause requestAnimationFrame: a single lazy timer still flushes.
  armWatchdog(LIVE_QUOTES_WATCHDOG_MS);
};

/** O(1): store the latest quote and schedule one coalesced subscriber notification. */
export const setLiveQuote = (q: {
  symbol: string;
  bid: number;
  ask: number;
  timestamp?: unknown;
}): void => {
  const sym = normalizeSymbol(q.symbol);
  if (!sym) return;
  bindSessionHooks();
  quotes.set(sym, {
    symbol: sym,
    bid: q.bid,
    ask: q.ask,
    timestamp: q.timestamp ?? 0,
    seq: ++quoteSeq,
  });
  scheduleFlush();
};

export const getLiveQuote = (symbol: string): LiveQuote | undefined => {
  if (!symbol) return undefined;
  const sym = normalizeSymbol(symbol);
  return sym ? quotes.get(sym) : undefined;
};

/** Drop one symbol's quote (a newer backend snapshot wins until the next tick). No notify. */
export const invalidateLiveQuote = (symbol: string): void => {
  const sym = normalizeSymbol(symbol);
  if (sym) quotes.delete(sym);
};

export const getLiveQuotesVersion = (): number => version;

export const getLiveQuotesCount = (): number => quotes.size;

export const subscribeLiveQuotes = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};

export const clearLiveQuotes = (): void => {
  cancelPending();
  scheduled = false;
  if (quotes.size > 0) {
    quotes.clear();
    emitNotify();
  }
};

/** Drop quotes of symbols that no open position holds any more. */
export const pruneLiveQuotes = (heldSymbols: ReadonlySet<string>): void => {
  let removed = false;
  for (const key of quotes.keys()) {
    if (!heldSymbols.has(key)) {
      quotes.delete(key);
      removed = true;
    }
  }
  if (removed) emitNotify();
};

export const resetLiveQuotesForTests = (): void => {
  cancelPending();
  scheduled = false;
  quotes.clear();
  emitNotify();
};

// Session hooks are bound on the first stored quote, not at module load: there is nothing to
// clear before the first quote, and importing this module must stay side-effect free (tests and
// modules that mock brokerSession only partially load it transitively).
let sessionHooksBound = false;
function bindSessionHooks(): void {
  if (sessionHooksBound) return;
  sessionHooksBound = true;
  onSessionChange((reason) => {
    if (reason !== 'token_rotation') clearLiveQuotes();
  });
  onCommittedBrokerAccountSessionScopeChange(() => {
    clearLiveQuotes();
  });
}
