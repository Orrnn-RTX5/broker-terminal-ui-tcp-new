/**
 * Pure state model and reducer for client-side Terminal Dealing lifecycle.
 *
 * Kept dependency-free from Zustand store instances so both `useDealingStore.ts`
 * and `dealingEvents.ts` share a single acyclic source of truth.
 */

import {
  DEFAULT_REQUOTE_WINDOW_MS,
  WIRE_DEALING_STATUS_CANCELLED,
  WIRE_DEALING_STATUS_EXPIRED,
  WIRE_DEALING_STATUS_FILLED,
  WIRE_DEALING_STATUS_IN_DEALING,
  WIRE_DEALING_STATUS_REQUOTED,
  WIRE_DEALING_STATUS_REJECTED,
  WIRE_SIDE_BUY,
  WIRE_SIDE_NONE,
  WIRE_SIDE_SELL,
  dealingKindToString,
  dealingSideToString,
} from './binaryDealingCodec';
import { formatDealingReasonMessage, sanitizeDealingReasonText } from './dealingReasonMessages';

export type DealingPhase =
  | 'in_dealing'
  | 'requoted'
  | 'accepting'
  | 'declining'
  | 'filled'
  | 'rejected'
  | 'expired'
  | 'cancelled';

export type DealingTerminalPhase = 'filled' | 'rejected' | 'expired' | 'cancelled';

export type DealingOrderKind = 'open' | 'close' | 'modify';
export type DealingOrderSide = 'buy' | 'sell' | 'any';

export interface DealingRequoteOffer {
  requoteId: string;
  bid: number;
  ask: number;
  offeredPrice: number;
  receivedAtMs: number;
  expiresAtMs: number;
  serverNowMs: number;
  windowMs: number;
}

export interface DealingRequestRecord {
  requestId: string;
  clientOrderId: string;
  accountLogin: number;
  kind: DealingOrderKind;
  symbol: string;
  side: DealingOrderSide;
  wireSide: number;
  digits: number;
  volume: number;
  requestedPrice: number;
  fillPrice: number;
  bid: number;
  ask: number;
  sl: number;
  tp: number;
  profit: number;
  commission: number;
  orderTicket: number;
  positionTicket: number;
  dealTicket: number;
  retcode: number;
  seq: number;
  isExpert: boolean;
  /** True when expired client-side by safety timer awaiting server reconciliation (M2). */
  synthetic: boolean;
  phase: DealingPhase;
  reasonCode: string;
  reasonText: string;
  reasonMessage: string;
  requote: DealingRequoteOffer | null;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  serverNowMs: number;
  serverClockOffsetMs: number;
  terminalAtMs: number | null;
}

export interface DealingStatusEvent {
  requestId: string;
  clientOrderId?: string;
  accountLogin?: number;
  kind?: DealingOrderKind;
  symbol?: string;
  side?: DealingOrderSide;
  wireSide?: number;
  digits?: number;
  volume?: number;
  price?: number;
  bid?: number;
  ask?: number;
  sl?: number;
  tp?: number;
  profit?: number;
  commission?: number;
  orderTicket?: number;
  positionTicket?: number;
  dealTicket?: number;
  retcode?: number;
  seq?: number;
  isExpert?: boolean;
  /** Client-synthesised safety expiry (non-authoritative; overridden by any server terminal). */
  synthetic?: boolean;
  /**
   * Wire origin used to apply API_CONTRACT.md §9.2/§9.4 multi-round requote rules:
   * `0x39` ExecWire replies carry `RequestUUID` (`0x24`) + `RequoteUUID` (`0x28`) without `Seq`.
   */
  source?: 'trade_event_0x3a' | 'order_resp_0x39';
  phase: Exclude<DealingPhase, 'accepting' | 'declining'>;
  requoteId?: string;
  expiresAtMs?: number;
  serverNowMs?: number;
  reasonCode?: string;
  reasonText?: string;
}

export const DEALING_TOMBSTONE_TTL_MS = 120_000;
export const DEALING_TOMBSTONE_MAX_ENTRIES = 512;
export const MAX_RETAINED_TERMINAL_RECORDS = 512;

export interface DealingTombstoneEntry {
  seq: number;
  prunedAtMs: number;
}

export interface DealingStoreData {
  requests: Record<string, DealingRequestRecord>;
  byClientOrderId: Record<string, string>;
  requoteQueue: string[];
  activeRequoteId: string | null;
  tombstones: Record<string, DealingTombstoneEntry>;
  /** Increments only when non-authoritative-terminal active request membership changes. */
  activeRequestIdsVersion: number;
}

export interface DealingStoreIndexes {
  activeRequestIds: Set<string>;
  activeBySymbol: Map<string, Set<string>>;
  terminalRequestIds: Set<string>;
}

export function createDealingStoreIndexes(): DealingStoreIndexes {
  return {
    activeRequestIds: new Set(),
    activeBySymbol: new Map(),
    terminalRequestIds: new Set(),
  };
}

export function clearDealingStoreIndexes(indexes: DealingStoreIndexes): void {
  indexes.activeRequestIds.clear();
  indexes.activeBySymbol.clear();
  indexes.terminalRequestIds.clear();
}

export function createInitialDealingState(): DealingStoreData {
  return {
    requests: {},
    byClientOrderId: {},
    requoteQueue: [],
    activeRequoteId: null,
    tombstones: {},
    activeRequestIdsVersion: 0,
  };
}

function dealingPhaseRank(phase: DealingPhase): number {
  switch (phase) {
    case 'in_dealing':
      return 1;
    case 'requoted':
      return 2;
    case 'accepting':
    case 'declining':
      return 3;
    case 'filled':
    case 'rejected':
    case 'expired':
    case 'cancelled':
      return 4;
  }
}

export function recordDealingTombstones(
  existing: Record<string, DealingTombstoneEntry>,
  entries: ReadonlyArray<{ requestId: string; seq: number }>,
  nowMs = Date.now(),
): Record<string, DealingTombstoneEntry> {
  if (entries.length === 0) return existing;
  const next: Record<string, DealingTombstoneEntry> = {};

  for (const [id, entry] of Object.entries(existing)) {
    if (nowMs - entry.prunedAtMs < DEALING_TOMBSTONE_TTL_MS) {
      next[id] = entry;
    }
  }
  for (const { requestId, seq } of entries) {
    const id = requestId.trim();
    if (!id) continue;
    const prev = next[id];
    next[id] = {
      seq: prev ? Math.max(prev.seq, seq) : seq,
      prunedAtMs: nowMs,
    };
  }

  const keys = Object.keys(next);
  if (keys.length > DEALING_TOMBSTONE_MAX_ENTRIES) {
    keys.sort((a, b) => next[a].prunedAtMs - next[b].prunedAtMs);
    const excess = keys.length - DEALING_TOMBSTONE_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) {
      delete next[keys[i]];
    }
  }
  return next;
}

export function isTerminalDealingPhase(phase: DealingPhase): phase is DealingTerminalPhase {
  return (
    phase === 'filled'
    || phase === 'rejected'
    || phase === 'expired'
    || phase === 'cancelled'
  );
}

/** True only for server-authoritative terminal records (never client safety-timer expiry). */
export function isAuthoritativeTerminalDealingRecord(record: DealingRequestRecord): boolean {
  return isTerminalDealingPhase(record.phase) && !record.synthetic;
}

export function dealingPhaseFromBinaryStatus(
  status: number,
): Exclude<DealingPhase, 'accepting' | 'declining'> | null {
  switch (status) {
    case WIRE_DEALING_STATUS_IN_DEALING:
      return 'in_dealing';
    case WIRE_DEALING_STATUS_REQUOTED:
      return 'requoted';
    case WIRE_DEALING_STATUS_FILLED:
      return 'filled';
    case WIRE_DEALING_STATUS_REJECTED:
      return 'rejected';
    case WIRE_DEALING_STATUS_EXPIRED:
      return 'expired';
    case WIRE_DEALING_STATUS_CANCELLED:
      return 'cancelled';
    default:
      return null;
  }
}

export function resolveWireSide(side?: DealingOrderSide, wireSide?: number): number {
  if (wireSide === WIRE_SIDE_BUY || wireSide === WIRE_SIDE_SELL || wireSide === WIRE_SIDE_NONE) {
    return wireSide;
  }
  if (side === 'buy') return WIRE_SIDE_BUY;
  if (side === 'sell') return WIRE_SIDE_SELL;
  return WIRE_SIDE_NONE;
}

export function roundDealingPrice(value: number, digits: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const safeDigits = Number.isInteger(digits) && digits >= 0 && digits <= 12 ? digits : 5;
  return Number(value.toFixed(safeDigits));
}

export function computeOfferedRequotePrice(
  wireSide: number,
  bid: number,
  ask: number,
  digits?: number,
): number {
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0) {
    return 0;
  }
  const raw = wireSide === WIRE_SIDE_SELL ? bid : ask;
  return digits !== undefined ? roundDealingPrice(raw, digits) : raw;
}

export const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;
export const MAX_VALID_DEALING_WINDOW_MS = 24 * 60 * 60 * 1_000;

export function clampTimeoutDelayMs(delayMs: number, fallbackMs = 0): number {
  if (!Number.isFinite(delayMs)) {
    return Math.min(MAX_TIMEOUT_DELAY_MS, Math.max(0, Math.trunc(fallbackMs)));
  }
  if (delayMs <= 0) return 0;
  return Math.min(MAX_TIMEOUT_DELAY_MS, Math.trunc(delayMs));
}

export function isValidDealingExpiresAtMs(
  expiresAtMs: unknown,
  refServerNowMs: number,
): expiresAtMs is number {
  if (
    typeof expiresAtMs !== 'number'
    || !Number.isFinite(expiresAtMs)
    || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= 0
  ) {
    return false;
  }
  if (Number.isFinite(refServerNowMs) && refServerNowMs > 0) {
    return expiresAtMs <= refServerNowMs + MAX_VALID_DEALING_WINDOW_MS;
  }
  return true;
}

export function isRequoteOfferExpired(
  record: DealingRequestRecord | undefined | null,
  nowMs = Date.now(),
  graceMs = 0,
): boolean {
  if (!record || record.phase !== 'requoted' || !record.requote) return false;
  const exp = record.requote.expiresAtMs;
  if (!(exp > 0)) return false;
  const refServerNow = nowMs + record.serverClockOffsetMs;
  return exp + graceMs <= refServerNow;
}

export function pickActiveRequoteId(
  requests: Readonly<Record<string, DealingRequestRecord>>,
  requoteQueue: readonly string[],
  nowMs = Date.now(),
  expiredGraceMs = 0,
): string | null {
  for (let i = 0; i < requoteQueue.length; i++) {
    const id = requoteQueue[i];
    const rec = requests[id];
    if (!rec || rec.isExpert || !rec.requote) continue;
    if (rec.phase === 'accepting' || rec.phase === 'declining') {
      return id;
    }
    if (rec.phase === 'requoted' && !isRequoteOfferExpired(rec, nowMs, expiredGraceMs)) {
      return id;
    }
  }
  return null;
}

function enqueueRequote(queue: string[], requestId: string): string[] {
  if (queue.includes(requestId)) return queue;
  return [...queue, requestId];
}

function dequeueRequote(queue: string[], requestId: string): string[] {
  if (!queue.includes(requestId)) return queue;
  return queue.filter((id) => id !== requestId);
}

function resolveDealingKind(kind?: DealingOrderKind, fallback?: DealingOrderKind): DealingOrderKind {
  if (kind === 'open' || kind === 'close' || kind === 'modify') return kind;
  if (fallback === 'open' || fallback === 'close' || fallback === 'modify') return fallback;
  return 'open';
}

export function kindFromWireCode(kindCode: number): DealingOrderKind | undefined {
  const mapped = dealingKindToString(kindCode);
  return mapped === '' ? undefined : mapped;
}

function removeFromSymbolIndex(
  indexes: DealingStoreIndexes,
  symbol: string,
  requestId: string,
): void {
  if (!symbol) return;
  const bucket = indexes.activeBySymbol.get(symbol);
  if (!bucket) return;
  bucket.delete(requestId);
  if (bucket.size === 0) {
    indexes.activeBySymbol.delete(symbol);
  }
}

export function syncRecordInStoreIndexes(
  indexes: DealingStoreIndexes,
  prev: DealingRequestRecord | undefined,
  next: DealingRequestRecord | undefined,
  requestId: string,
): boolean {
  const wasActive = indexes.activeRequestIds.has(requestId);
  const isNowActive = Boolean(next && !isAuthoritativeTerminalDealingRecord(next));

  if (prev && (!next || prev.symbol !== next.symbol || !isNowActive)) {
    removeFromSymbolIndex(indexes, prev.symbol, requestId);
  }

  if (next && isNowActive) {
    indexes.activeRequestIds.add(requestId);
    if (next.symbol) {
      let bucket = indexes.activeBySymbol.get(next.symbol);
      if (!bucket) {
        bucket = new Set();
        indexes.activeBySymbol.set(next.symbol, bucket);
      }
      bucket.add(requestId);
    }
    indexes.terminalRequestIds.delete(requestId);
  } else {
    indexes.activeRequestIds.delete(requestId);
    if (next && isAuthoritativeTerminalDealingRecord(next)) {
      indexes.terminalRequestIds.add(requestId);
    } else {
      indexes.terminalRequestIds.delete(requestId);
    }
  }

  return wasActive !== isNowActive;
}

interface ComputedTransition {
  requestId: string;
  existing: DealingRequestRecord | undefined;
  nextRecord: DealingRequestRecord;
  nextQueue: string[];
  clientOrderId: string;
}

function computeNextDealingTransition(
  state: DealingStoreData,
  event: DealingStatusEvent,
  nowMs: number,
): ComputedTransition | null {
  const requestId = event.requestId?.trim();
  if (!requestId) return null;

  const tombstone = state.tombstones[requestId];
  if (tombstone && nowMs - tombstone.prunedAtMs < DEALING_TOMBSTONE_TTL_MS) {
    return null;
  }

  const existing = state.requests[requestId];
  const incomingSeq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : 0;
  const incomingRq = (event.requoteId ?? '').trim();
  const existingRq = existing?.requote?.requoteId ?? '';
  const isIncomingSynthetic = Boolean(event.synthetic);
  const overridingSynthetic = Boolean(
    existing?.synthetic && isTerminalDealingPhase(event.phase) && !isIncomingSynthetic,
  );

  if (existing) {
    if (isTerminalDealingPhase(existing.phase)) {
      if (existing.synthetic) {
        if (!isTerminalDealingPhase(event.phase) || isIncomingSynthetic) {
          return null;
        }
      } else {
        if (isIncomingSynthetic || existing.phase !== 'filled' || event.phase !== 'filled') {
          return null;
        }
        if (
          existing.orderTicket > 0
          && existing.positionTicket > 0
          && existing.dealTicket > 0
        ) {
          return null;
        }
      }
    } else if (!isTerminalDealingPhase(event.phase)) {
      if (incomingSeq > 0 && existing.seq > 0 && incomingSeq < existing.seq) {
        return null;
      }
      const existingRank = dealingPhaseRank(existing.phase);
      const incomingRank = dealingPhaseRank(event.phase);
      const isStrictlyHigherSeq = existing.seq > 0 && incomingSeq > existing.seq;
      const isOrderResp0x39RequoteOverride =
        event.source === 'order_resp_0x39'
        && event.phase === 'requoted'
        && Boolean(incomingRq)
        && Boolean(existingRq)
        && incomingRq !== existingRq
        && existing.phase === 'accepting';
      const canOverrideWithNewRequote =
        existing.seq === 0
        || (incomingSeq > 0 && incomingSeq > existing.seq)
        || isOrderResp0x39RequoteOverride;

      if (
        existing.phase === 'requoted'
        && event.phase === 'requoted'
        && (!incomingRq || !existingRq || incomingRq === existingRq)
        && incomingSeq <= existing.seq
      ) {
        return null;
      }

      if (
        (existing.phase === 'accepting' || existing.phase === 'declining')
        && event.phase === 'requoted'
      ) {
        if (existingRq && incomingRq && incomingRq !== existingRq) {
          if (!canOverrideWithNewRequote) return null;
        } else if (!isStrictlyHigherSeq) {
          return null;
        }
      } else if (incomingRank < existingRank && !isStrictlyHigherSeq) {
        return null;
      } else if (existingRq && incomingRq && incomingRq !== existingRq) {
        if (!(event.phase === 'requoted' && canOverrideWithNewRequote)) {
          return null;
        }
      }
    }
  }

  const wireSide = resolveWireSide(
    event.side ?? existing?.side,
    event.wireSide !== undefined ? event.wireSide : existing?.wireSide,
  );
  const side = dealingSideToString(wireSide);
  const kind = resolveDealingKind(event.kind, existing?.kind);
  const clientOrderId = (event.clientOrderId ?? existing?.clientOrderId ?? '').trim();
  const symbol = (event.symbol ?? existing?.symbol ?? '').trim().toUpperCase();
  const digits = event.digits !== undefined && event.digits >= 0 ? event.digits : (existing?.digits ?? 5);
  const accountLogin = event.accountLogin && event.accountLogin > 0
    ? event.accountLogin
    : (existing?.accountLogin ?? 0);
  const volume = event.volume !== undefined && event.volume > 0 ? event.volume : (existing?.volume ?? 0);
  const isExpert = Boolean(event.isExpert ?? existing?.isExpert);

  const serverNowMs = event.serverNowMs && event.serverNowMs > 0
    ? event.serverNowMs
    : (existing?.serverNowMs ?? 0);
  const serverClockOffsetMs = event.serverNowMs && event.serverNowMs > 0
    ? event.serverNowMs - nowMs
    : (existing?.serverClockOffsetMs ?? 0);

  const hasEventBid = event.bid !== undefined && Number.isFinite(event.bid) && event.bid > 0;
  const hasEventAsk = event.ask !== undefined && Number.isFinite(event.ask) && event.ask > 0;
  const bid = hasEventBid ? event.bid! : (existing?.bid ?? 0);
  const ask = hasEventAsk ? event.ask! : (existing?.ask ?? 0);
  const requestedPrice = existing
    ? existing.requestedPrice
    : (event.phase === 'in_dealing' && event.price && event.price > 0 ? event.price : 0);
  const fillPrice = event.phase === 'filled' && event.price && event.price > 0
    ? event.price
    : (existing?.fillPrice ?? 0);

  const reasonCode = isIncomingSynthetic
    ? ''
    : (event.reasonCode ?? (overridingSynthetic ? '' : existing?.reasonCode) ?? '').trim().toUpperCase();
  const reasonText = isIncomingSynthetic
    ? ''
    : sanitizeDealingReasonText(event.reasonText ?? (overridingSynthetic ? '' : existing?.reasonText) ?? '');
  const reasonMessage = isIncomingSynthetic
    ? ''
    : isTerminalDealingPhase(event.phase) && event.phase !== 'filled'
      ? formatDealingReasonMessage(reasonCode, reasonText)
      : (overridingSynthetic ? '' : (existing?.reasonMessage ?? ''));

  let nextPhase: DealingPhase = event.phase;
  if (
    existing
    && (existing.phase === 'accepting' || existing.phase === 'declining')
    && event.phase === 'requoted'
    && (!incomingRq || !existingRq || incomingRq === existingRq)
  ) {
    nextPhase = existing.phase;
  }

  let nextRequote: DealingRequoteOffer | null = existing?.requote ?? null;
  let nextBid = bid;
  let nextAsk = ask;
  const baseRefServerNow = nowMs + serverClockOffsetMs;
  const hasValidEventExpiry = isValidDealingExpiresAtMs(event.expiresAtMs, baseRefServerNow);
  let nextExpiresAtMs = hasValidEventExpiry
    ? event.expiresAtMs
    : (existing?.expiresAtMs ?? 0);

  if (event.phase === 'requoted') {
    if (!hasEventBid || !hasEventAsk) {
      return null;
    }
    const eventBid = roundDealingPrice(event.bid!, digits);
    const eventAsk = roundDealingPrice(event.ask!, digits);
    const offeredPrice = computeOfferedRequotePrice(wireSide, eventBid, eventAsk, digits);
    if (!(eventBid > 0) || !(eventAsk > 0) || !(offeredPrice > 0)) {
      return null;
    }

    const refServerNow = baseRefServerNow;
    if (
      event.expiresAtMs !== undefined
      && (!hasValidEventExpiry || event.expiresAtMs <= refServerNow)
    ) {
      return null;
    }

    const requoteId = (incomingRq || existingRq || requestId).trim();
    const isSameOffer = existing?.requote?.requoteId === requoteId && existing?.phase === nextPhase;
    const rqExpiresAt = hasValidEventExpiry
      ? event.expiresAtMs
      : (isSameOffer && existing?.requote && isValidDealingExpiresAtMs(existing.requote.expiresAtMs, refServerNow)
          ? existing.requote.expiresAtMs
          : refServerNow + DEFAULT_REQUOTE_WINDOW_MS);
    if (!isValidDealingExpiresAtMs(rqExpiresAt, refServerNow) || rqExpiresAt <= refServerNow) {
      return null;
    }
    const derivedWindowMs = rqExpiresAt > refServerNow
      ? rqExpiresAt - refServerNow
      : DEFAULT_REQUOTE_WINDOW_MS;

    nextBid = eventBid;
    nextAsk = eventAsk;
    nextExpiresAtMs = rqExpiresAt;
    nextRequote = {
      requoteId,
      bid: eventBid,
      ask: eventAsk,
      offeredPrice,
      receivedAtMs: isSameOffer && existing?.requote ? existing.requote.receivedAtMs : nowMs,
      expiresAtMs: rqExpiresAt,
      serverNowMs: refServerNow,
      windowMs: isSameOffer && existing?.requote ? existing.requote.windowMs : derivedWindowMs,
    };
  }

  const nextRecord: DealingRequestRecord = {
    requestId,
    clientOrderId,
    accountLogin,
    kind,
    symbol,
    side,
    wireSide,
    digits,
    volume,
    requestedPrice,
    fillPrice,
    bid: nextBid,
    ask: nextAsk,
    sl: event.sl !== undefined ? event.sl : (existing?.sl ?? 0),
    tp: event.tp !== undefined ? event.tp : (existing?.tp ?? 0),
    profit: event.profit !== undefined ? event.profit : (existing?.profit ?? 0),
    commission: event.commission !== undefined ? event.commission : (existing?.commission ?? 0),
    orderTicket: event.orderTicket && event.orderTicket > 0 ? event.orderTicket : (existing?.orderTicket ?? 0),
    positionTicket: event.positionTicket && event.positionTicket > 0
      ? event.positionTicket
      : (existing?.positionTicket ?? 0),
    dealTicket: event.dealTicket && event.dealTicket > 0 ? event.dealTicket : (existing?.dealTicket ?? 0),
    retcode: event.retcode && event.retcode > 0 ? event.retcode : (existing?.retcode ?? 0),
    seq: Math.max(incomingSeq, existing?.seq ?? 0),
    isExpert,
    synthetic: isIncomingSynthetic,
    phase: nextPhase,
    reasonCode,
    reasonText,
    reasonMessage,
    requote: nextRequote,
    createdAtMs: existing?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs,
    expiresAtMs: nextExpiresAtMs,
    serverNowMs,
    serverClockOffsetMs,
    terminalAtMs: isTerminalDealingPhase(nextPhase) && !isIncomingSynthetic
      ? (overridingSynthetic ? nowMs : (existing?.terminalAtMs ?? nowMs))
      : null,
  };

  let nextQueue = state.requoteQueue;
  if (isExpert) {
    nextQueue = dequeueRequote(nextQueue, requestId);
  } else if (nextPhase === 'requoted') {
    nextQueue = enqueueRequote(nextQueue, requestId);
  } else if (nextPhase !== 'accepting' && nextPhase !== 'declining') {
    nextQueue = dequeueRequote(nextQueue, requestId);
  }

  return {
    requestId,
    existing,
    nextRecord,
    nextQueue,
    clientOrderId,
  };
}

/**
 * Pure idempotent state transition function for dealing events (non-mutating; used by unit tests
 * and pure reducer consumers).
 */
export function applyDealingEvent(
  state: DealingStoreData,
  event: DealingStatusEvent,
  nowMs = Date.now(),
): DealingStoreData {
  const transition = computeNextDealingTransition(state, event, nowMs);
  if (!transition) return state;

  const { requestId, existing, nextRecord, nextQueue, clientOrderId } = transition;
  const nextByCoid = clientOrderId && state.byClientOrderId[clientOrderId] !== requestId
    ? { ...state.byClientOrderId, [clientOrderId]: requestId }
    : state.byClientOrderId;

  const nextRequests = {
    ...state.requests,
    [requestId]: nextRecord,
  };

  const wasActive = existing ? !isAuthoritativeTerminalDealingRecord(existing) : false;
  const isNowActive = !isAuthoritativeTerminalDealingRecord(nextRecord);
  const nextActiveVersion = wasActive !== isNowActive
    ? state.activeRequestIdsVersion + 1
    : state.activeRequestIdsVersion;

  return {
    requests: nextRequests,
    byClientOrderId: nextByCoid,
    requoteQueue: nextQueue,
    activeRequoteId: nextQueue.length > 0 ? pickActiveRequoteId(nextRequests, nextQueue, nowMs) : null,
    tombstones: state.tombstones,
    activeRequestIdsVersion: nextActiveVersion,
  };
}

/**
 * O(1) keyed store transition for `useDealingStore` (eliminates O(N^2) object spreads
 * across high-volume event streams while keeping per-record references immutable).
 */
export function applyDealingEventToStore(
  state: DealingStoreData,
  event: DealingStatusEvent,
  nowMs: number,
  indexes: DealingStoreIndexes,
): DealingStoreData {
  const transition = computeNextDealingTransition(state, event, nowMs);
  if (!transition) return state;

  const { requestId, existing, nextRecord, nextQueue, clientOrderId } = transition;
  state.requests[requestId] = nextRecord;
  if (clientOrderId) {
    state.byClientOrderId[clientOrderId] = requestId;
  }

  const membershipChanged = syncRecordInStoreIndexes(indexes, existing, nextRecord, requestId);

  let nextTombstones = state.tombstones;
  if (indexes.terminalRequestIds.size > MAX_RETAINED_TERMINAL_RECORDS) {
    const oldestId = indexes.terminalRequestIds.values().next().value;
    if (oldestId !== undefined) {
      const oldestRec = state.requests[oldestId];
      indexes.terminalRequestIds.delete(oldestId);
      delete state.requests[oldestId];
      if (oldestRec?.clientOrderId && state.byClientOrderId[oldestRec.clientOrderId] === oldestId) {
        delete state.byClientOrderId[oldestRec.clientOrderId];
      }
      if (oldestRec) {
        nextTombstones = recordDealingTombstones(
          nextTombstones,
          [{ requestId: oldestId, seq: oldestRec.seq }],
          nowMs,
        );
      }
    }
  }

  return {
    requests: state.requests,
    byClientOrderId: state.byClientOrderId,
    requoteQueue: nextQueue,
    activeRequoteId: nextQueue.length > 0 ? pickActiveRequoteId(state.requests, nextQueue, nowMs) : null,
    tombstones: nextTombstones,
    activeRequestIdsVersion: membershipChanged
      ? state.activeRequestIdsVersion + 1
      : state.activeRequestIdsVersion,
  };
}
