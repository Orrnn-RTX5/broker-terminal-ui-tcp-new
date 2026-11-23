/**
 * Isolated, non-persisted Zustand store for Terminal Dealing requests.
 *
 * Keyed strictly by `requestId` (UUID v4, API_CONTRACT.md §2.1, §3.1) with:
 *  - O(1) keyed mutations & incremental active-request / per-symbol indexes (zero O(N^2) spreads).
 *  - ONE shared earliest-deadline lifecycle timer (replaces per-request timer maps).
 *  - Targeted selectors so unrelated dealing traffic never triggers whole-map re-renders.
 */

import { create } from 'zustand';
import { DEFAULT_REQUOTE_WINDOW_MS } from '../services/dealing/binaryDealingCodec';
import { syncDealingCountdownTickerNow } from '../services/dealing/dealingCountdownTicker';
import { DEALING_UI_STRINGS } from '../services/dealing/dealingI18n';
import {
  applyDealingEventToStore,
  clampTimeoutDelayMs,
  clearDealingStoreIndexes,
  createDealingStoreIndexes,
  createInitialDealingState,
  isAuthoritativeTerminalDealingRecord,
  isRequoteOfferExpired,
  isTerminalDealingPhase,
  isValidDealingExpiresAtMs,
  pickActiveRequoteId,
  recordDealingTombstones,
  syncRecordInStoreIndexes,
  type DealingPhase,
  type DealingRequestRecord,
  type DealingStatusEvent,
  type DealingStoreData,
} from '../services/dealing/dealingReducer';
import { formatDealingReasonMessage } from '../services/dealing/dealingReasonMessages';

export const TERMINAL_PRUNE_DELAY_MS = 10_000;
export const STALE_NON_TERMINAL_PRUNE_AFTER_MS = 5 * 60_000;
export const DEALING_REPLAY_DEBOUNCE_MS = 2_000;
export const DEALING_REPLAY_MAX_WAIT_MS = 5_000;
export const REQUOTE_SWEEP_HEAD_GRACE_MS = 1_000;

export interface DealingUnreconciledNotice {
  status: 'unknown';
  requestId: string;
  clientOrderId: string;
  accountLogin: number;
  symbol: string;
  messageKey: typeof DEALING_UI_STRINGS.statusUnknownCheckHistory;
  record: DealingRequestRecord;
}

export interface DealingReplayTriggerContext {
  requestId: string;
  accountLogin: number;
  reason: 'synthetic_expiry' | 'synthetic_prune' | 'stale_prune';
  /** All distinct coalesced trigger contexts flushed in this debounced wave. */
  batch?: readonly DealingReplayTriggerContext[];
}

export type DealingSweepDeclineHandler = (record: DealingRequestRecord) => Promise<void> | void;

export interface DealingStoreActions {
  applyEvent: (event: DealingStatusEvent, nowMs?: number) => DealingRequestRecord | null;
  markAccepting: (requestId: string, requoteId?: string) => boolean;
  markDeclining: (requestId: string, requoteId?: string) => boolean;
  revertRequotePending: (requestId: string, requoteId?: string) => void;
  dismissRequote: (requestId: string, reasonCode?: string) => void;
  removeRequest: (requestId: string, nowMs?: number) => void;
  sweepExpiredRequotes: (nowMs?: number, headGraceMs?: number) => string[];
  pruneExpiredTerminals: (cutoffNowMs?: number, graceMs?: number) => void;
  pruneStaleRequests: (cutoffNowMs?: number, staleAfterMs?: number) => void;
  clearAccount: (accountLogin: number) => void;
  reset: () => void;
}

export type DealingStoreState = DealingStoreData & DealingStoreActions;

const storeIndexes = createDealingStoreIndexes();
const unreconciledListeners = new Set<(notice: DealingUnreconciledNotice) => void>();
const replayTriggers = new Set<(ctx: DealingReplayTriggerContext) => void>();
const notifiedUnreconciledIds = new Set<string>();
const pendingReplayContexts = new Map<string, DealingReplayTriggerContext>();
const MAX_UNRECONCILED_NOTICE_CACHE = 512;
let replayDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let replayMaxWaitTimer: ReturnType<typeof setTimeout> | null = null;
let sweepDeclineHandler: DealingSweepDeclineHandler | null = null;

// Single shared earliest-deadline lifecycle timer across all records.
let lifecycleTimer: ReturnType<typeof setTimeout> | null = null;
let nextLifecycleDueMs = Infinity;

// Cached immutable snapshot of active request IDs rebuilt only on membership change.
let cachedActiveIdsVersion = -1;
let cachedActiveIds: readonly string[] = [];

/**
 * Subscribe to the single neutral notice emitted when a client-synthesised safety
 * expiry is pruned after 5 minutes without a reconciling server terminal event.
 */
export function subscribeDealingUnreconciled(
  listener: (notice: DealingUnreconciledNotice) => void,
): () => void {
  unreconciledListeners.add(listener);
  return () => {
    unreconciledListeners.delete(listener);
  };
}

/**
 * Register a Phase-B callback (e.g., `sendDealingSyncProbe`) invoked (debounced by
 * `DEALING_REPLAY_DEBOUNCE_MS`) when a synthetic safety expiry occurs or an
 * unreconciled non-terminal/synthetic record prunes.
 */
export function registerDealingReplayTrigger(
  trigger: (ctx: DealingReplayTriggerContext) => void,
): () => void {
  replayTriggers.add(trigger);
  return () => {
    replayTriggers.delete(trigger);
  };
}

/**
 * MANDATORY Phase-B hook invoked when the store sweeps an expired requote (handles both expired
 * non-head requotes and expired head requotes while the tab is hidden/backgrounded) so an
 * Action 10 Decline binary frame is always transmitted onto the wire.
 */
export function registerDealingSweepDecline(
  handler: DealingSweepDeclineHandler | null,
): () => void {
  sweepDeclineHandler = handler;
  return () => {
    if (sweepDeclineHandler === handler) {
      sweepDeclineHandler = null;
    }
  };
}

function clearReplayDebounceTimer(): void {
  if (replayDebounceTimer !== null) {
    clearTimeout(replayDebounceTimer);
    replayDebounceTimer = null;
  }
  if (replayMaxWaitTimer !== null) {
    clearTimeout(replayMaxWaitTimer);
    replayMaxWaitTimer = null;
  }
  pendingReplayContexts.clear();
}

function flushReplayTrigger(): void {
  if (replayDebounceTimer !== null) {
    clearTimeout(replayDebounceTimer);
    replayDebounceTimer = null;
  }
  if (replayMaxWaitTimer !== null) {
    clearTimeout(replayMaxWaitTimer);
    replayMaxWaitTimer = null;
  }
  if (pendingReplayContexts.size === 0) return;
  const entries = Array.from(pendingReplayContexts.values());
  pendingReplayContexts.clear();

  const byAccount = new Map<number, DealingReplayTriggerContext[]>();
  for (const entry of entries) {
    const group = byAccount.get(entry.accountLogin);
    if (group) {
      group.push(entry);
    } else {
      byAccount.set(entry.accountLogin, [entry]);
    }
  }

  for (const group of byAccount.values()) {
    const latest = group[group.length - 1];
    const payload: DealingReplayTriggerContext = {
      requestId: latest.requestId,
      accountLogin: latest.accountLogin,
      reason: latest.reason,
      batch: group,
    };
    for (const trigger of replayTriggers) {
      try {
        trigger(payload);
      } catch {
        // m2: Never let a throwing replay trigger crash store timers or callers.
      }
    }
  }
}

function emitReplayTrigger(ctx: DealingReplayTriggerContext): void {
  if (replayTriggers.size === 0) return;
  pendingReplayContexts.set(`${ctx.requestId}:${ctx.reason}`, ctx);
  if (replayDebounceTimer !== null) {
    clearTimeout(replayDebounceTimer);
  }
  const debounceMs = Math.max(1, clampTimeoutDelayMs(DEALING_REPLAY_DEBOUNCE_MS));
  replayDebounceTimer = setTimeout(() => {
    try {
      flushReplayTrigger();
    } catch {
      // m2: Defensive timer guard.
    }
  }, debounceMs);

  if (replayMaxWaitTimer === null) {
    const maxWaitMs = Math.max(1, clampTimeoutDelayMs(DEALING_REPLAY_MAX_WAIT_MS));
    replayMaxWaitTimer = setTimeout(() => {
      try {
        flushReplayTrigger();
      } catch {
        // m2: Defensive timer guard.
      }
    }, maxWaitMs);
  }
}

function emitUnreconciledNotices(records: readonly DealingRequestRecord[]): void {
  for (const rec of records) {
    if (!notifiedUnreconciledIds.has(rec.requestId)) {
      if (notifiedUnreconciledIds.size >= MAX_UNRECONCILED_NOTICE_CACHE) {
        const oldest = notifiedUnreconciledIds.values().next().value;
        if (oldest !== undefined) {
          notifiedUnreconciledIds.delete(oldest);
        }
      }
      notifiedUnreconciledIds.add(rec.requestId);

      const notice: DealingUnreconciledNotice = {
        status: 'unknown',
        requestId: rec.requestId,
        clientOrderId: rec.clientOrderId,
        accountLogin: rec.accountLogin,
        symbol: rec.symbol,
        messageKey: DEALING_UI_STRINGS.statusUnknownCheckHistory,
        record: rec,
      };
      for (const listener of unreconciledListeners) {
        try {
          listener(notice);
        } catch {
          // m2: Isolate listener error so healthy subscribers still run.
        }
      }
    }
    emitReplayTrigger({
      requestId: rec.requestId,
      accountLogin: rec.accountLogin,
      reason: rec.synthetic ? 'synthetic_prune' : 'stale_prune',
    });
  }
}

function clearLifecycleTimer(): void {
  if (lifecycleTimer !== null) {
    clearTimeout(lifecycleTimer);
    lifecycleTimer = null;
  }
  nextLifecycleDueMs = Infinity;
}

function rebuildByClientOrderId(requests: Record<string, DealingRequestRecord>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [reqId, rec] of Object.entries(requests)) {
    if (rec.clientOrderId) {
      next[rec.clientOrderId] = reqId;
    }
  }
  return next;
}

function resolveEffectiveExpiryMs(rec: DealingRequestRecord, refNowMs: number): number {
  const rqExp = rec.requote?.expiresAtMs ?? 0;
  const validRq = isValidDealingExpiresAtMs(rqExp, refNowMs) ? rqExp : 0;
  const validRec = isValidDealingExpiresAtMs(rec.expiresAtMs, refNowMs) ? rec.expiresAtMs : 0;
  if (validRq > 0 && validRec > 0) {
    return Math.max(validRq, validRec);
  }
  return validRq > 0 ? validRq : validRec;
}

function isNonTerminalRecordStale(
  rec: DealingRequestRecord,
  cutoffNowMs: number,
  staleAfterMs: number,
): boolean {
  if (isAuthoritativeTerminalDealingRecord(rec)) return false;
  if (rec.synthetic || rec.phase === 'accepting' || rec.phase === 'declining') {
    return cutoffNowMs - rec.updatedAtMs >= staleAfterMs;
  }
  const refNow = rec.serverNowMs > 0 ? cutoffNowMs + rec.serverClockOffsetMs : cutoffNowMs;
  const effectiveExpiry = resolveEffectiveExpiryMs(rec, refNow);
  if (effectiveExpiry > 0) {
    return refNow - effectiveExpiry >= staleAfterMs;
  }
  return cutoffNowMs - rec.updatedAtMs >= staleAfterMs;
}

function isLiveRequoteQueueEntry(rec: DealingRequestRecord | undefined): rec is DealingRequestRecord {
  return Boolean(
    rec
    && !rec.isExpert
    && rec.requote
    && (rec.phase === 'requoted' || rec.phase === 'accepting' || rec.phase === 'declining'),
  );
}

function findFirstLiveRequoteId(
  requests: Readonly<Record<string, DealingRequestRecord>>,
  requoteQueue: readonly string[],
): string | null {
  for (let i = 0; i < requoteQueue.length; i++) {
    const id = requoteQueue[i];
    if (isLiveRequoteQueueEntry(requests[id])) {
      return id;
    }
  }
  return null;
}

function computeRecordDueDelayMs(
  rec: DealingRequestRecord,
  nowMs: number,
  firstLiveRequoteId: string | null,
): number {
  if (isAuthoritativeTerminalDealingRecord(rec)) {
    const targetMs = (rec.terminalAtMs ?? rec.updatedAtMs) + TERMINAL_PRUNE_DELAY_MS;
    return clampTimeoutDelayMs(Math.max(1, targetMs - nowMs), TERMINAL_PRUNE_DELAY_MS);
  }

  let staleRawDelayMs: number;
  if (rec.synthetic || rec.phase === 'accepting' || rec.phase === 'declining') {
    staleRawDelayMs = rec.updatedAtMs + STALE_NON_TERMINAL_PRUNE_AFTER_MS - nowMs;
  } else {
    const refNow = rec.serverNowMs > 0 ? nowMs + rec.serverClockOffsetMs : nowMs;
    const effectiveExpiry = resolveEffectiveExpiryMs(rec, refNow);
    const targetDeadlineMs = effectiveExpiry > 0
      ? effectiveExpiry + STALE_NON_TERMINAL_PRUNE_AFTER_MS
      : rec.updatedAtMs + STALE_NON_TERMINAL_PRUNE_AFTER_MS;
    staleRawDelayMs = effectiveExpiry > 0
      ? targetDeadlineMs - refNow
      : targetDeadlineMs - nowMs;
  }
  let bestDelay = clampTimeoutDelayMs(Math.max(1, staleRawDelayMs), STALE_NON_TERMINAL_PRUNE_AFTER_MS);

  if (rec.phase === 'requoted' && !rec.isExpert && rec.requote) {
    const refNow = rec.serverNowMs > 0 ? nowMs + rec.serverClockOffsetMs : nowMs;
    const expiresAtMs = rec.requote.expiresAtMs;
    if (isValidDealingExpiresAtMs(expiresAtMs, refNow)) {
      const graceMs = firstLiveRequoteId === rec.requestId ? REQUOTE_SWEEP_HEAD_GRACE_MS : 0;
      const sweepDelay = clampTimeoutDelayMs(Math.max(1, expiresAtMs + graceMs - refNow), DEFAULT_REQUOTE_WINDOW_MS);
      if (sweepDelay < bestDelay) {
        bestDelay = sweepDelay;
      }
    }
  }
  return bestDelay;
}

function armSingleLifecycleTimer(delayMs: number, nowMs: number, getState: () => DealingStoreState): void {
  const clamped = Math.max(1, clampTimeoutDelayMs(delayMs, TERMINAL_PRUNE_DELAY_MS));
  clearLifecycleTimer();
  nextLifecycleDueMs = nowMs + clamped;
  lifecycleTimer = setTimeout(() => {
    lifecycleTimer = null;
    nextLifecycleDueMs = Infinity;
    try {
      const fireNowMs = Date.now();
      const state = getState();
      state.sweepExpiredRequotes(fireNowMs, REQUOTE_SWEEP_HEAD_GRACE_MS);
      state.pruneExpiredTerminals(fireNowMs);
      state.pruneStaleRequests(fireNowMs);
      rescheduleLifecycleTimer(fireNowMs, getState);
    } catch {
      // m2: Never throw out of lifecycle timer callback.
    }
  }, clamped);
}

function scheduleRecordLifecycle(
  rec: DealingRequestRecord,
  nowMs: number,
  getState: () => DealingStoreState,
): void {
  const snap = getState();
  const firstLive = snap.requoteQueue.length > 0
    ? findFirstLiveRequoteId(snap.requests, snap.requoteQueue)
    : null;
  const delayMs = computeRecordDueDelayMs(rec, nowMs, firstLive);
  const dueAtMs = nowMs + delayMs;
  if (lifecycleTimer === null || dueAtMs < nextLifecycleDueMs) {
    armSingleLifecycleTimer(delayMs, nowMs, getState);
  }
}

function rescheduleLifecycleTimer(nowMs: number, getState: () => DealingStoreState): void {
  const snap = getState();
  const firstLive = snap.requoteQueue.length > 0
    ? findFirstLiveRequoteId(snap.requests, snap.requoteQueue)
    : null;
  let minDelay = Infinity;
  for (const id of Object.keys(snap.requests)) {
    const rec = snap.requests[id];
    if (!rec) continue;
    const delay = computeRecordDueDelayMs(rec, nowMs, firstLive);
    if (delay < minDelay) {
      minDelay = delay;
    }
  }
  if (Number.isFinite(minDelay)) {
    armSingleLifecycleTimer(minDelay, nowMs, getState);
  } else {
    clearLifecycleTimer();
  }
}

function rebuildStoreIndexesFromRequests(requests: Record<string, DealingRequestRecord>): void {
  clearDealingStoreIndexes(storeIndexes);
  for (const id of Object.keys(requests)) {
    syncRecordInStoreIndexes(storeIndexes, undefined, requests[id], id);
  }
}

export const useDealingStore = create<DealingStoreState>((set, get) => ({
  ...createInitialDealingState(),

  applyEvent: (event, nowMs = Date.now()) => {
    const requestId = event.requestId?.trim();
    if (!requestId) return null;

    let resultingRecord: DealingRequestRecord | null = null;
    let stateChanged = false;
    let prevWasSynthetic = false;
    set((state) => {
      prevWasSynthetic = Boolean(state.requests[requestId]?.synthetic);
      const nextState = applyDealingEventToStore(state, event, nowMs, storeIndexes);
      resultingRecord = nextState.requests[requestId] ?? null;
      if (nextState === state) return state;
      stateChanged = true;
      return nextState;
    });

    if (stateChanged && resultingRecord) {
      const rec = resultingRecord as DealingRequestRecord;
      scheduleRecordLifecycle(rec, nowMs, get);
      if (rec.synthetic && !prevWasSynthetic) {
        emitReplayTrigger({
          requestId: rec.requestId,
          accountLogin: rec.accountLogin,
          reason: 'synthetic_expiry',
        });
      }
    }

    return resultingRecord;
  },

  markAccepting: (requestId, requoteId) => {
    let accepted = false;
    let updatedRec: DealingRequestRecord | null = null;
    const now = Date.now();
    set((state) => {
      const existing = state.requests[requestId];
      if (!existing || existing.phase !== 'requoted') return state;
      if (requoteId && existing.requote?.requoteId && existing.requote.requoteId !== requoteId) {
        return state;
      }
      accepted = true;
      updatedRec = {
        ...existing,
        phase: 'accepting',
        updatedAtMs: now,
      };
      state.requests[requestId] = updatedRec;
      return {
        ...state,
        requests: state.requests,
      };
    });
    if (accepted && updatedRec) {
      rescheduleLifecycleTimer(now, get);
    }
    return accepted;
  },

  markDeclining: (requestId, requoteId) => {
    let declining = false;
    let updatedRec: DealingRequestRecord | null = null;
    const now = Date.now();
    set((state) => {
      const existing = state.requests[requestId];
      if (!existing || existing.phase !== 'requoted') {
        return state;
      }
      if (requoteId && existing.requote?.requoteId && existing.requote.requoteId !== requoteId) {
        return state;
      }
      declining = true;
      updatedRec = {
        ...existing,
        phase: 'declining',
        updatedAtMs: now,
      };
      state.requests[requestId] = updatedRec;
      return {
        ...state,
        requests: state.requests,
      };
    });
    if (declining && updatedRec) {
      rescheduleLifecycleTimer(now, get);
    }
    return declining;
  },

  revertRequotePending: (requestId, requoteId) => {
    let revertedRec: DealingRequestRecord | null = null;
    const now = Date.now();
    set((state) => {
      const existing = state.requests[requestId];
      if (!existing || (existing.phase !== 'accepting' && existing.phase !== 'declining')) {
        return state;
      }
      if (requoteId && existing.requote?.requoteId && existing.requote.requoteId !== requoteId) {
        return state;
      }
      revertedRec = {
        ...existing,
        phase: 'requoted' as const,
        updatedAtMs: now,
      };
      state.requests[requestId] = revertedRec;
      const nextQueue = existing.isExpert || state.requoteQueue.includes(requestId)
        ? state.requoteQueue
        : [...state.requoteQueue, requestId];
      return {
        ...state,
        requests: state.requests,
        requoteQueue: nextQueue,
        activeRequoteId: pickActiveRequoteId(state.requests, nextQueue, now),
      };
    });
    if (revertedRec) {
      rescheduleLifecycleTimer(now, get);
    }
  },

  dismissRequote: (requestId, reasonCode = 'CLIENT_DECLINED') => {
    const now = Date.now();
    let becameTerminal = false;
    const resolvedReasonCode = (reasonCode || 'CLIENT_DECLINED').trim().toUpperCase() || 'CLIENT_DECLINED';
    set((state) => {
      const existing = state.requests[requestId];
      const nextQueue = state.requoteQueue.filter((id) => id !== requestId);
      const nextActive = pickActiveRequoteId(state.requests, nextQueue, now);
      if (!existing) {
        if (nextQueue.length === state.requoteQueue.length) return state;
        return {
          ...state,
          requoteQueue: nextQueue,
          activeRequoteId: nextActive,
        };
      }
      if (isTerminalDealingPhase(existing.phase)) {
        return {
          ...state,
          requoteQueue: nextQueue,
          activeRequoteId: nextActive,
        };
      }
      becameTerminal = true;
      const nextRec: DealingRequestRecord = {
        ...existing,
        phase: 'cancelled',
        synthetic: false,
        reasonCode: resolvedReasonCode,
        reasonText: '',
        reasonMessage: formatDealingReasonMessage(resolvedReasonCode, ''),
        updatedAtMs: now,
        terminalAtMs: now,
      };
      state.requests[requestId] = nextRec;
      const membershipChanged = syncRecordInStoreIndexes(storeIndexes, existing, nextRec, requestId);
      return {
        ...state,
        requests: state.requests,
        requoteQueue: nextQueue,
        activeRequoteId: nextActive,
        activeRequestIdsVersion: membershipChanged
          ? state.activeRequestIdsVersion + 1
          : state.activeRequestIdsVersion,
      };
    });
    if (becameTerminal) {
      rescheduleLifecycleTimer(now, get);
    }
  },

  removeRequest: (requestId, nowMs = Date.now()) => {
    let removed = false;
    set((state) => {
      const existing = state.requests[requestId];
      if (!existing) return state;
      removed = true;
      delete state.requests[requestId];
      if (existing.clientOrderId && state.byClientOrderId[existing.clientOrderId] === requestId) {
        delete state.byClientOrderId[existing.clientOrderId];
      }
      const membershipChanged = syncRecordInStoreIndexes(storeIndexes, existing, undefined, requestId);
      const nextQueue = state.requoteQueue.filter((id) => id !== requestId);
      return {
        ...state,
        requests: state.requests,
        byClientOrderId: state.byClientOrderId,
        requoteQueue: nextQueue,
        activeRequoteId: nextQueue.length > 0 ? pickActiveRequoteId(state.requests, nextQueue, nowMs) : null,
        activeRequestIdsVersion: membershipChanged
          ? state.activeRequestIdsVersion + 1
          : state.activeRequestIdsVersion,
        // N1: Never tombstone synthetic safety-expired records so late server settlement still reconciles.
        tombstones: existing.synthetic
          ? state.tombstones
          : recordDealingTombstones(
              state.tombstones,
              [{ requestId, seq: existing.seq }],
              nowMs,
            ),
      };
    });
    if (removed) {
      rescheduleLifecycleTimer(nowMs, get);
    }
  },

  sweepExpiredRequotes: (nowMs = Date.now(), headGraceMs = REQUOTE_SWEEP_HEAD_GRACE_MS) => {
    const sweptRecords: DealingRequestRecord[] = [];
    set((state) => {
      if (state.requoteQueue.length === 0) return state;
      let changed = false;
      const nextQueue: string[] = [];
      let sawFirstLive = false;

      for (const id of state.requoteQueue) {
        const rec = state.requests[id];
        if (!isLiveRequoteQueueEntry(rec)) {
          changed = true;
          continue;
        }
        const entryGraceMs = !sawFirstLive ? headGraceMs : 0;
        sawFirstLive = true;
        if (rec.phase === 'requoted' && isRequoteOfferExpired(rec, nowMs, entryGraceMs)) {
          const sweptRec: DealingRequestRecord = {
            ...rec,
            phase: 'expired',
            synthetic: true,
            reasonCode: '',
            reasonText: '',
            reasonMessage: '',
            updatedAtMs: nowMs,
            terminalAtMs: null,
          };
          state.requests[id] = sweptRec;
          syncRecordInStoreIndexes(storeIndexes, rec, sweptRec, id);
          sweptRecords.push(sweptRec);
          changed = true;
          continue;
        }
        nextQueue.push(id);
      }

      const nextActive = nextQueue.length > 0 ? pickActiveRequoteId(state.requests, nextQueue, nowMs) : null;
      if (!changed && nextActive === state.activeRequoteId) return state;

      return {
        ...state,
        requests: state.requests,
        requoteQueue: nextQueue,
        activeRequoteId: nextActive,
      };
    });

    if (sweptRecords.length > 0) {
      rescheduleLifecycleTimer(nowMs, get);
      for (const sweptRec of sweptRecords) {
        if (sweepDeclineHandler) {
          try {
            void Promise.resolve(sweepDeclineHandler(sweptRec)).catch(() => {});
          } catch {
            // m2: Never throw out of sweep handler.
          }
        }
        emitReplayTrigger({
          requestId: sweptRec.requestId,
          accountLogin: sweptRec.accountLogin,
          reason: 'synthetic_expiry',
        });
      }
    }
    return sweptRecords.map((rec) => rec.requestId);
  },

  pruneExpiredTerminals: (cutoffNowMs = Date.now(), graceMs = TERMINAL_PRUNE_DELAY_MS) => {
    set((state) => {
      let changed = false;
      const pruned: Array<{ requestId: string; seq: number }> = [];
      for (const id of Object.keys(state.requests)) {
        const rec = state.requests[id];
        if (
          rec
          && isAuthoritativeTerminalDealingRecord(rec)
          && rec.terminalAtMs !== null
          && cutoffNowMs - rec.terminalAtMs >= graceMs
        ) {
          delete state.requests[id];
          if (rec.clientOrderId && state.byClientOrderId[rec.clientOrderId] === id) {
            delete state.byClientOrderId[rec.clientOrderId];
          }
          syncRecordInStoreIndexes(storeIndexes, rec, undefined, id);
          pruned.push({ requestId: id, seq: rec.seq });
          changed = true;
        }
      }
      if (!changed) return state;
      const nextQueue = state.requoteQueue.filter((id) => Boolean(state.requests[id]));
      return {
        ...state,
        requests: state.requests,
        byClientOrderId: state.byClientOrderId,
        requoteQueue: nextQueue,
        activeRequoteId: nextQueue.length > 0 ? pickActiveRequoteId(state.requests, nextQueue, cutoffNowMs) : null,
        tombstones: recordDealingTombstones(state.tombstones, pruned, cutoffNowMs),
      };
    });
  },

  pruneStaleRequests: (cutoffNowMs = Date.now(), staleAfterMs = STALE_NON_TERMINAL_PRUNE_AFTER_MS) => {
    const prunedUnreconciled: DealingRequestRecord[] = [];
    set((state) => {
      let changed = false;
      let membershipChanged = false;
      for (const id of Object.keys(state.requests)) {
        const rec = state.requests[id];
        if (rec && isNonTerminalRecordStale(rec, cutoffNowMs, staleAfterMs)) {
          delete state.requests[id];
          if (rec.clientOrderId && state.byClientOrderId[rec.clientOrderId] === id) {
            delete state.byClientOrderId[rec.clientOrderId];
          }
          if (syncRecordInStoreIndexes(storeIndexes, rec, undefined, id)) {
            membershipChanged = true;
          }
          prunedUnreconciled.push(rec);
          changed = true;
        }
      }
      if (!changed) return state;
      const nextQueue = state.requoteQueue.filter((id) => Boolean(state.requests[id]));
      return {
        ...state,
        requests: state.requests,
        byClientOrderId: state.byClientOrderId,
        requoteQueue: nextQueue,
        activeRequoteId: nextQueue.length > 0 ? pickActiveRequoteId(state.requests, nextQueue, cutoffNowMs) : null,
        activeRequestIdsVersion: membershipChanged
          ? state.activeRequestIdsVersion + 1
          : state.activeRequestIdsVersion,
      };
    });
    if (prunedUnreconciled.length > 0) {
      rescheduleLifecycleTimer(cutoffNowMs, get);
      emitUnreconciledNotices(prunedUnreconciled);
    }
  },

  clearAccount: (accountLogin) => {
    const nowMs = Date.now();
    let clearedAny = false;
    set((state) => {
      let changed = false;
      let membershipChanged = false;
      const cleared: Array<{ requestId: string; seq: number }> = [];
      for (const id of Object.keys(state.requests)) {
        const rec = state.requests[id];
        if (rec && (rec.accountLogin === accountLogin || rec.accountLogin <= 0)) {
          delete state.requests[id];
          if (rec.clientOrderId && state.byClientOrderId[rec.clientOrderId] === id) {
            delete state.byClientOrderId[rec.clientOrderId];
          }
          if (syncRecordInStoreIndexes(storeIndexes, rec, undefined, id)) {
            membershipChanged = true;
          }
          if (!rec.synthetic) {
            cleared.push({ requestId: id, seq: rec.seq });
          }
          changed = true;
        }
      }
      if (!changed) return state;
      clearedAny = true;
      const nextQueue = state.requoteQueue.filter((id) => Boolean(state.requests[id]));
      return {
        ...state,
        requests: state.requests,
        byClientOrderId: rebuildByClientOrderId(state.requests),
        requoteQueue: nextQueue,
        activeRequoteId: nextQueue.length > 0 ? pickActiveRequoteId(state.requests, nextQueue, nowMs) : null,
        activeRequestIdsVersion: membershipChanged
          ? state.activeRequestIdsVersion + 1
          : state.activeRequestIdsVersion,
        tombstones: cleared.length > 0
          ? recordDealingTombstones(state.tombstones, cleared, nowMs)
          : state.tombstones,
      };
    });
    if (clearedAny) {
      rescheduleLifecycleTimer(nowMs, get);
    }
  },

  /** Full teardown for logout and account switch (PHASE-B). */
  reset: () => {
    clearLifecycleTimer();
    clearReplayDebounceTimer();
    clearDealingStoreIndexes(storeIndexes);
    cachedActiveIdsVersion = -1;
    cachedActiveIds = [];
    notifiedUnreconciledIds.clear();
    syncDealingCountdownTickerNow();
    set(createInitialDealingState());
  },
}));

// Keep incremental indexes in sync if tests call `useDealingStore.setState(...)` directly.
useDealingStore.subscribe((state, prevState) => {
  if (state.requests !== prevState.requests) {
    rebuildStoreIndexesFromRequests(state.requests);
  }
});

// ─── Targeted O(1) Selectors ─────────────────────────────────────────────────

export const selectDealingPhaseById =
  (requestId?: string | null) =>
  (state: DealingStoreState): DealingPhase | null =>
    (requestId ? state.requests[requestId]?.phase ?? null : null);

export const selectDealingRequestById =
  (requestId?: string | null) =>
  (state: DealingStoreState): DealingRequestRecord | null =>
    (requestId ? state.requests[requestId] ?? null : null);

export const selectDealingRequestIdByClientOrderId =
  (clientOrderId?: string | null) =>
  (state: DealingStoreState): string | null =>
    (clientOrderId ? state.byClientOrderId[clientOrderId] ?? null : null);

export const selectActiveDealingRequestIdForSymbol =
  (symbol?: string | null) =>
  (state: DealingStoreState): string | null => {
    if (!symbol) return null;
    const upper = symbol.trim().toUpperCase();
    if (!upper) return null;
    const bucket = storeIndexes.activeBySymbol.get(upper);
    if (!bucket || bucket.size === 0) return null;
    let bestId: string | null = null;
    let bestUpdated = -1;
    for (const id of bucket) {
      const rec = state.requests[id];
      if (rec && !isAuthoritativeTerminalDealingRecord(rec) && rec.updatedAtMs >= bestUpdated) {
        bestId = id;
        bestUpdated = rec.updatedAtMs;
      }
    }
    return bestId;
  };

export const selectActiveRequoteId = (state: DealingStoreState): string | null =>
  (state.requoteQueue.length > 0 ? pickActiveRequoteId(state.requests, state.requoteQueue) : null);

export const selectActiveDealingRequestIdsVersion = (state: DealingStoreState): number =>
  state.activeRequestIdsVersion;

export function getActiveDealingRequestIds(): readonly string[] {
  const version = useDealingStore.getState().activeRequestIdsVersion;
  if (cachedActiveIdsVersion !== version) {
    cachedActiveIdsVersion = version;
    cachedActiveIds = storeIndexes.activeRequestIds.size === 0
      ? []
      : Array.from(storeIndexes.activeRequestIds);
  }
  return cachedActiveIds;
}
