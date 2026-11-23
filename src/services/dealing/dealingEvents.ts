/**
 * Event mapper and ingestion bridge between decoded Binary TCP dealing frames
 * (0x39 ExecWire TLVs, 0x3A EventKind=7, 0x3B reconnect replay) and `useDealingStore`.
 *
 * Per `DECISIONS.md` D12: zero HTTP pending endpoint and zero `/ws/v2` JSON fallback.
 */

import {
  MT_RET_REQUEST_CANCEL,
  MT_RET_REQUEST_DONE,
  MT_RET_REQUEST_INVALID_EXP,
  MT_RET_REQUEST_NO_MONEY,
  MT_RET_REQUEST_PLACED,
  MT_RET_REQUEST_REJECTED,
  MT_RET_REQUEST_REQUOTE,
  WIRE_ACTION_REQUOTE_ACCEPT,
  WIRE_ACTION_REQUOTE_DECLINE,
  WIRE_ORDER_CODEC_VERSION,
  WIRE_ORDER_RESP_HEADER_SIZE,
  WIRE_STATUS_ACCEPTED,
  WIRE_STATUS_CONFLICT,
  WIRE_STATUS_OK,
  WIRE_STATUS_REJECTED,
  decodeDealingStatusEvent,
  decodeOrderRespWithExecWire,
  decodeTradeEventKind7Envelope,
  encodeAccountSubFrame0x3B,
  readNormalizedClientOrderId40,
  readNormalizedSymbol16,
  type DecodedBinaryDealingStatusEvent,
  type DecodedOrderRespWithExecWire,
} from './binaryDealingCodec';
import {
  dealingPhaseFromBinaryStatus,
  isAuthoritativeTerminalDealingRecord,
  isTerminalDealingPhase,
  kindFromWireCode,
  type DealingOrderKind,
  type DealingOrderSide,
  type DealingRequestRecord,
  type DealingStatusEvent,
} from './dealingReducer';
import { formatDealingReasonMessage, isKnownDealingReasonCode } from './dealingReasonMessages';
import {
  DEALING_REPLAY_DEBOUNCE_MS,
  DEALING_REPLAY_MAX_WAIT_MS,
  REQUOTE_SWEEP_HEAD_GRACE_MS,
  registerDealingReplayTrigger,
  registerDealingSweepDecline,
  subscribeDealingUnreconciled,
  useDealingStore,
  type DealingReplayTriggerContext,
  type DealingSweepDeclineHandler,
  type DealingUnreconciledNotice,
} from '../../store/useDealingStore';

export {
  MAX_TIMEOUT_DELAY_MS,
  MAX_VALID_DEALING_WINDOW_MS,
  applyDealingEvent,
  clampTimeoutDelayMs,
  computeOfferedRequotePrice,
  createInitialDealingState,
  dealingPhaseFromBinaryStatus,
  isAuthoritativeTerminalDealingRecord,
  isRequoteOfferExpired,
  isTerminalDealingPhase,
  isValidDealingExpiresAtMs,
  kindFromWireCode,
  pickActiveRequoteId,
  roundDealingPrice,
} from './dealingReducer';

export {
  DEALING_REPLAY_DEBOUNCE_MS,
  DEALING_REPLAY_MAX_WAIT_MS,
  REQUOTE_SWEEP_HEAD_GRACE_MS,
  registerDealingReplayTrigger,
  registerDealingSweepDecline,
  subscribeDealingUnreconciled,
  type DealingReplayTriggerContext,
  type DealingSweepDeclineHandler,
  type DealingUnreconciledNotice,
};

export type {
  DealingOrderKind,
  DealingOrderSide,
  DealingPhase,
  DealingRequestRecord,
  DealingRequoteOffer,
  DealingStatusEvent,
  DealingStoreData,
  DealingTerminalPhase,
} from './dealingReducer';

export interface BinaryDealingMeta {
  accountLogin?: number;
  side?: DealingOrderSide;
  wireSide?: number;
  kind?: DealingOrderKind;
  digits?: number;
  volume?: number;
  requestedPrice?: number;
  sl?: number;
  tp?: number;
  /**
   * MUST be provided by Phase-B callers for EA orders (`ORDER_REASON_EXPERT`).
   * Guarantees interactive requote modals never open for EA traffic (D10).
   */
  isExpert?: boolean;
  requestId?: string;
}

export interface DealingTerminalNotice {
  /** Mapped for direct compatibility with `orderCommandLifecycle.ts` `normalizeOrderCommand`. */
  status: 'filled' | 'rejected' | 'expired';
  phase: 'filled' | 'rejected' | 'expired' | 'cancelled';
  terminal: true;
  requestId: string;
  clientOrderId: string;
  orderTicket?: number;
  positionTicket?: number;
  dealTicket?: number;
  fillPrice?: number;
  volume?: number;
  profit?: number;
  commission?: number;
  sl?: number;
  tp?: number;
  retcode?: number;
  error?: { code: string; message: string };
  position?: {
    id: number;
    ticket: number;
    positionTicket: number;
    dealTicket: number;
    symbol: string;
    volume: number;
    openPrice: number;
    fillPrice: number;
    sl: number;
    tp: number;
    profit: number;
    commission: number;
  };
  record: DealingRequestRecord;
}

const DEALING_SPECIFIC_ERROR_CODES: ReadonlySet<string> = new Set([
  'IN_DEALING',
  'DEALER_REQUOTE',
  'MARGIN_RECHECK_FAILED',
  'REQUOTE_EXPIRED',
  'CLIENT_DECLINED',
  'REQUOTE_DECLINED',
  'DEALING_ALREADY_RESOLVED',
  'DEALER_REJECTED',
  'DEALER_TIMEOUT',
]);

/**
 * Maps a `0x3A` binary dealing payload into a `DealingStatusEvent`.
 * PHASE-B: pass `meta.isExpert` when forwarding EA orders (`ORDER_REASON_EXPERT`)
 * so interactive requote modals are never opened for expert orders (DECISIONS.md D10).
 */
export function dealingEventFromBinaryStatusEvent(
  ev: DecodedBinaryDealingStatusEvent,
  meta?: BinaryDealingMeta,
): DealingStatusEvent | null {
  const phase = dealingPhaseFromBinaryStatus(ev.status);
  if (!phase || !ev.requestId) return null;

  return {
    requestId: ev.requestId,
    clientOrderId: ev.clientOrderId || undefined,
    accountLogin: meta?.accountLogin,
    kind: kindFromWireCode(ev.kind) ?? meta?.kind,
    symbol: ev.symbol || undefined,
    wireSide: ev.side !== 0 ? ev.side : meta?.wireSide,
    side: ev.side === 0 ? meta?.side : undefined,
    digits: ev.digits > 0 ? ev.digits : meta?.digits,
    volume: ev.volume > 0 ? ev.volume : meta?.volume,
    price: ev.price > 0 ? ev.price : meta?.requestedPrice,
    bid: ev.bid > 0 ? ev.bid : undefined,
    ask: ev.ask > 0 ? ev.ask : undefined,
    sl: ev.sl,
    tp: ev.tp,
    profit: ev.profit,
    commission: ev.commission,
    orderTicket: ev.orderTicket,
    positionTicket: ev.positionTicket,
    dealTicket: ev.dealTicket,
    retcode: ev.retcode,
    seq: ev.seq,
    isExpert: meta?.isExpert,
    source: 'trade_event_0x3a',
    phase,
    requoteId: ev.hasRequoteId ? ev.requoteId : undefined,
    expiresAtMs: ev.expiresAtMs > 0 ? ev.expiresAtMs : undefined,
    serverNowMs: ev.serverNowMs > 0 ? ev.serverNowMs : undefined,
    reasonCode: ev.reasonCode || undefined,
    reasonText: ev.reasonText || undefined,
  };
}

/**
 * Maps a `0x39` binary order response (with optional trailing `ExecWire` TLVs `0x20..0x29`)
 * into a `DealingStatusEvent` when it carries dealing context (`202` `10008`/`10004`,
 * Action `9`/`10` completion, or `409`/`422` dealing outcome with dealing UUID/tags).
 * Ordinary non-dealing rejections return `null` and never create dealing store records.
 *
 * Contract assumption (`API_CONTRACT.md` §9.2 / §9.4): `0x39` replies carry `0x24 RequestUUID`
 * and `0x28 RequoteUUID` without a `Seq` field (`seq = 0`). ONLY when the request is `accepting`
 * and a `202` reply carries a new `RequoteUUID` (or `MT_RET_REQUEST_REQUOTE` / `DEALER_REQUOTE`)
 * does the reducer advance into the next requote round while preserving `existing.seq`; live
 * `requoted` offers are never replaced by a `0x39` reply carrying a different `requoteId`.
 *
 * PHASE-B: callers MUST pass `meta.isExpert` for EA orders (`ORDER_REASON_EXPERT`, D10).
 */
export function dealingEventFromOrderResp(
  resp: DecodedOrderRespWithExecWire,
  meta?: BinaryDealingMeta,
): DealingStatusEvent | null {
  const ew = resp.execWire;
  const requestId = (ew?.hasRequestUuid ? ew.requestId : '') || meta?.requestId?.trim() || '';
  const errUpper = resp.errorCode.trim().toUpperCase();
  const retcode = ew?.retcode ?? 0;

  const isRequoteAction =
    resp.action === WIRE_ACTION_REQUOTE_ACCEPT || resp.action === WIRE_ACTION_REQUOTE_DECLINE;
  const hasDealingContext = Boolean(
    ew?.hasRequestUuid
    || ew?.hasRequoteUuid
    || ew?.hasDealingKind
    || meta?.requestId?.trim()
    || isRequoteAction
    || DEALING_SPECIFIC_ERROR_CODES.has(errUpper),
  );
  if (!hasDealingContext || !requestId) {
    return null;
  }

  let phase: DealingStatusEvent['phase'] | null = null;
  let reasonCode = errUpper;
  let synthetic = false;
  let suppressRawReasonText = false;

  if (resp.status === WIRE_STATUS_ACCEPTED) {
    if (
      retcode === MT_RET_REQUEST_REQUOTE
      || errUpper === 'DEALER_REQUOTE'
      || (resp.action === WIRE_ACTION_REQUOTE_ACCEPT && Boolean(ew?.hasRequoteUuid))
    ) {
      phase = 'requoted';
    } else if (retcode === MT_RET_REQUEST_REJECTED) {
      phase = 'rejected';
    } else {
      phase = 'in_dealing';
    }
  } else if (resp.status === WIRE_STATUS_OK && (resp.action === WIRE_ACTION_REQUOTE_ACCEPT || retcode === MT_RET_REQUEST_DONE)) {
    if (resp.action === WIRE_ACTION_REQUOTE_DECLINE || retcode === MT_RET_REQUEST_CANCEL || errUpper === 'CLIENT_DECLINED') {
      phase = 'cancelled';
      reasonCode = reasonCode || 'CLIENT_DECLINED';
    } else {
      phase = 'filled';
    }
  } else if (resp.status === WIRE_STATUS_OK && resp.action === WIRE_ACTION_REQUOTE_DECLINE) {
    phase = 'cancelled';
    reasonCode = reasonCode || 'CLIENT_DECLINED';
  } else if (resp.status === WIRE_STATUS_CONFLICT) {
    if (retcode === MT_RET_REQUEST_INVALID_EXP || errUpper === 'REQUOTE_EXPIRED') {
      phase = 'expired';
      reasonCode = reasonCode || 'REQUOTE_EXPIRED';
    } else if (retcode === MT_RET_REQUEST_REQUOTE || errUpper === 'REQUOTE') {
      // D4 / D10: Synchronous 409 REQUOTE (legacy or EA order) never enters interactive requote modal.
      phase = 'rejected';
      reasonCode = 'REQUOTE';
    } else if (retcode === MT_RET_REQUEST_CANCEL || errUpper === 'DEALING_ALREADY_RESOLVED') {
      phase = 'cancelled';
      reasonCode = reasonCode || 'DEALING_ALREADY_RESOLVED';
    } else if (isRequoteAction) {
      phase = 'cancelled';
      reasonCode = 'DEALING_ALREADY_RESOLVED';
      suppressRawReasonText = true;
    }
  } else if (resp.status === WIRE_STATUS_REJECTED) {
    if (
      retcode === MT_RET_REQUEST_REJECTED
      || retcode === MT_RET_REQUEST_NO_MONEY
      || errUpper === 'MARGIN_RECHECK_FAILED'
      || ew?.hasRequestUuid
      || isRequoteAction
    ) {
      phase = 'rejected';
      if (!reasonCode && retcode === MT_RET_REQUEST_NO_MONEY) {
        reasonCode = 'MARGIN_RECHECK_FAILED';
      }
    }
  } else if (isRequoteAction && (resp.status === 504 || errUpper === 'BINARY_TCP_TIMEOUT' || errUpper === 'GATEWAY_TIMEOUT')) {
    phase = 'expired';
    synthetic = true;
    reasonCode = '';
    suppressRawReasonText = true;
  } else if (isRequoteAction && (resp.status === 501 || errUpper === 'DEALING_NOT_ENABLED')) {
    if (resp.action === WIRE_ACTION_REQUOTE_DECLINE) {
      phase = 'cancelled';
      reasonCode = 'CLIENT_DECLINED';
    } else {
      phase = 'rejected';
      reasonCode = 'DEALING_NOT_ENABLED';
    }
    suppressRawReasonText = true;
  } else if (isRequoteAction && (resp.status === 404 || errUpper === 'DEALING_REQUEST_NOT_FOUND')) {
    if (resp.action === WIRE_ACTION_REQUOTE_DECLINE) {
      phase = 'cancelled';
      reasonCode = isKnownDealingReasonCode(errUpper) ? errUpper : 'CLIENT_DECLINED';
    } else if (isKnownDealingReasonCode(errUpper)) {
      phase = 'rejected';
      reasonCode = errUpper;
    } else {
      phase = 'cancelled';
      reasonCode = 'DEALING_ALREADY_RESOLVED';
    }
    suppressRawReasonText = true;
  } else if (isRequoteAction && resp.status >= 400) {
    if (resp.action === WIRE_ACTION_REQUOTE_DECLINE) {
      phase = 'cancelled';
      reasonCode = isKnownDealingReasonCode(errUpper) ? errUpper : 'CLIENT_DECLINED';
    } else {
      phase = 'rejected';
      reasonCode = isKnownDealingReasonCode(errUpper) ? errUpper : 'DEALER_REJECTED';
    }
    suppressRawReasonText = true;
  }

  if (!phase) return null;

  return {
    requestId,
    clientOrderId: resp.clientOrderId || undefined,
    accountLogin: meta?.accountLogin,
    kind: ew?.hasDealingKind ? (kindFromWireCode(ew.dealingKind) ?? meta?.kind) : meta?.kind,
    symbol: resp.symbol || undefined,
    side: meta?.side,
    wireSide: meta?.wireSide,
    digits: ew?.hasDigits ? ew.digits : meta?.digits,
    volume: resp.volume > 0 ? resp.volume : meta?.volume,
    price: resp.fillPrice > 0 ? resp.fillPrice : meta?.requestedPrice,
    bid: ew && ew.dealerBid > 0 ? ew.dealerBid : undefined,
    ask: ew && ew.dealerAsk > 0 ? ew.dealerAsk : undefined,
    sl: resp.sl,
    tp: resp.tp,
    profit: resp.profit,
    commission: resp.commission,
    orderTicket: resp.orderTicket,
    positionTicket: resp.positionTicket,
    dealTicket: resp.dealTicket,
    retcode: retcode || (phase === 'in_dealing' ? MT_RET_REQUEST_PLACED : 0),
    isExpert: meta?.isExpert,
    synthetic: synthetic || undefined,
    source: 'order_resp_0x39',
    phase,
    requoteId: ew?.hasRequoteUuid ? ew.requoteId : undefined,
    expiresAtMs: ew?.hasExpiresAtMs ? ew.expiresAtMs : undefined,
    serverNowMs: ew?.hasServerNowMs ? ew.serverNowMs : undefined,
    reasonCode: reasonCode || undefined,
    reasonText: suppressRawReasonText
      ? ''
      : (phase === 'filled' || phase === 'in_dealing' || phase === 'requoted'
          ? undefined
          : (resp.message || undefined)),
  };
}

export function ingestDealingEvent(
  event: DealingStatusEvent,
  nowMs = Date.now(),
): DealingRequestRecord | null {
  return useDealingStore.getState().applyEvent(event, nowMs);
}

export function ingestBinaryDealingPayload(
  payload: Uint8Array,
  meta?: BinaryDealingMeta,
  nowMs = Date.now(),
): DealingRequestRecord | null {
  const decoded = decodeDealingStatusEvent(payload);
  const mapped = dealingEventFromBinaryStatusEvent(decoded, meta);
  if (!mapped) return null;
  return ingestDealingEvent(mapped, nowMs);
}

export function ingestBinaryDealingEnvelope(
  frame: Uint8Array,
  meta?: BinaryDealingMeta,
  nowMs = Date.now(),
): DealingRequestRecord | null {
  const decodedEnv = decodeTradeEventKind7Envelope(frame);
  const mapped = dealingEventFromBinaryStatusEvent(decodedEnv.event, {
    ...meta,
    accountLogin: meta?.accountLogin ?? decodedEnv.accountLogin,
  });
  if (!mapped) return null;
  return ingestDealingEvent(mapped, nowMs);
}

function decodeOrderRespInput(
  input: ArrayBuffer | Uint8Array | DecodedOrderRespWithExecWire,
): DecodedOrderRespWithExecWire {
  if (!(input instanceof Uint8Array || input instanceof ArrayBuffer)) {
    return input;
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength >= WIRE_ORDER_RESP_HEADER_SIZE + 4) {
    return decodeOrderRespWithExecWire(bytes);
  }
  if (bytes.byteLength < WIRE_ORDER_RESP_HEADER_SIZE) {
    throw new Error(`Truncated 0x39 response (${bytes.byteLength} < ${WIRE_ORDER_RESP_HEADER_SIZE})`);
  }
  if (bytes[0] !== WIRE_ORDER_CODEC_VERSION) {
    throw new Error(`Unsupported 0x39 version: ${bytes[0]}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const status = view.getUint16(2, true);
  return {
    version: bytes[0],
    action: bytes[1],
    status,
    ok: status >= 200 && status < 300,
    execMicros: view.getUint32(4, true),
    orderTicket: Number(view.getBigInt64(8, true)),
    positionTicket: Number(view.getBigInt64(16, true)),
    dealTicket: Number(view.getBigInt64(24, true)),
    fillPrice: view.getFloat64(32, true),
    volume: view.getFloat64(40, true),
    profit: view.getFloat64(48, true),
    commission: view.getFloat64(56, true),
    sl: view.getFloat64(64, true),
    tp: view.getFloat64(72, true),
    symbol: readNormalizedSymbol16(bytes, 80),
    clientOrderId: readNormalizedClientOrderId40(bytes, 96),
    errorCode: '',
    message: '',
    msgEndOffset: WIRE_ORDER_RESP_HEADER_SIZE,
    execWire: null,
  };
}

/**
 * Ingests a decoded/raw `0x39` binary order response when it carries dealing context.
 * PHASE-B: callers MUST pass `meta.isExpert` for EA orders so D10 suppression holds.
 */
export function ingestBinaryOrderRespDealing(
  input: ArrayBuffer | Uint8Array | DecodedOrderRespWithExecWire,
  meta?: BinaryDealingMeta,
  nowMs = Date.now(),
): DealingRequestRecord | null {
  const decoded = decodeOrderRespInput(input);
  const isRequoteAction =
    decoded.action === WIRE_ACTION_REQUOTE_ACCEPT || decoded.action === WIRE_ACTION_REQUOTE_DECLINE;
  const storeReqId = isRequoteAction && decoded.clientOrderId
    ? useDealingStore.getState().byClientOrderId[decoded.clientOrderId]
    : undefined;
  const effectiveMeta = storeReqId && !meta?.requestId
    ? { ...meta, requestId: storeReqId }
    : meta;
  const mapped = dealingEventFromOrderResp(decoded, effectiveMeta);
  if (!mapped) return null;
  return ingestDealingEvent(mapped, nowMs);
}

export function toDealingTerminalNotice(record: DealingRequestRecord): DealingTerminalNotice | null {
  if (!isAuthoritativeTerminalDealingRecord(record) || !isTerminalDealingPhase(record.phase)) {
    return null;
  }

  const status: DealingTerminalNotice['status'] =
    record.phase === 'filled'
      ? 'filled'
      : record.phase === 'expired'
        ? 'expired'
        : 'rejected';

  const errorCode = record.phase !== 'filled'
    ? (record.reasonCode || (record.phase === 'expired' ? 'DEALER_TIMEOUT' : 'DEALER_REJECTED'))
    : '';
  const errorMessage = record.phase !== 'filled'
    ? (record.reasonMessage || formatDealingReasonMessage(errorCode, record.reasonText))
    : '';

  return {
    status,
    phase: record.phase,
    terminal: true,
    requestId: record.requestId,
    clientOrderId: record.clientOrderId,
    orderTicket: record.orderTicket || undefined,
    positionTicket: record.positionTicket || undefined,
    dealTicket: record.dealTicket || undefined,
    fillPrice: record.fillPrice || undefined,
    volume: record.volume || undefined,
    profit: record.profit,
    commission: record.commission,
    sl: record.sl,
    tp: record.tp,
    retcode: record.retcode || undefined,
    error: record.phase !== 'filled' ? { code: errorCode, message: errorMessage } : undefined,
    position: record.phase === 'filled'
      ? {
          id: record.positionTicket || record.orderTicket,
          ticket: record.orderTicket,
          positionTicket: record.positionTicket,
          dealTicket: record.dealTicket,
          symbol: record.symbol,
          volume: record.volume,
          openPrice: record.fillPrice,
          fillPrice: record.fillPrice,
          sl: record.sl,
          tp: record.tp,
          profit: record.profit,
          commission: record.commission,
        }
      : undefined,
    record,
  };
}

/**
 * Subscribes to terminal completion (`filled | rejected | expired | cancelled`) for a
 * dealing request identified by `requestId` and/or `clientOrderId`.
 * Compatible with `orderCommandLifecycle.ts` `subscribeTerminal` in Phase B.
 * Invokes `listener` at most once per subscription; combined with store tombstones
 * and sticky terminal states, replayed events never produce a second terminal notice.
 */
export function subscribeDealingTerminal(
  target: { requestId?: string; clientOrderId?: string },
  listener: (notice: DealingTerminalNotice) => void,
): () => void {
  let settled = false;
  let unsubscribe: (() => void) | null = null;

  const lookupRecord = (): DealingRequestRecord | null => {
    const state = useDealingStore.getState();
    if (target.requestId) {
      const byReq = state.requests[target.requestId];
      if (byReq) return byReq;
    }
    if (target.clientOrderId) {
      const reqId = state.byClientOrderId[target.clientOrderId];
      if (reqId) return state.requests[reqId] ?? null;
    }
    return null;
  };

  const tryEmit = (): boolean => {
    if (settled) return true;
    const rec = lookupRecord();
    if (!rec || !isAuthoritativeTerminalDealingRecord(rec)) return false;
    const notice = toDealingTerminalNotice(rec);
    if (!notice) return false;
    settled = true;
    unsubscribe?.();
    unsubscribe = null;
    try {
      listener(notice);
    } catch {
      // m2: Never throw out of store notification callbacks.
    }
    return true;
  };

  if (tryEmit()) {
    return () => {};
  }

  unsubscribe = useDealingStore.subscribe(() => {
    tryEmit();
  });

  return () => {
    settled = true;
    unsubscribe?.();
    unsubscribe = null;
  };
}

// ─── 0x3B Binary Reconnect Replay Controller (D12) ───────────────────────────

export interface DealingReconnectReplayOptions {
  /** Sends the encoded 0x3B `[AccountLogin:i64][TokenLen:u16][Token]` frame (e.g., `bindBinaryTcpAccountSub`). */
  sendAccountSub: (accountLogin: number, authToken: string, encodedFrame0x3B: Uint8Array) => Promise<void> | void;
  getAccountLogin: () => number;
  getAuthToken?: () => string | null | undefined;
  onReplayedRecord?: (record: DealingRequestRecord) => void;
}

export interface DealingReconnectReplayController {
  onStreamReconnected: () => Promise<Uint8Array | null>;
  handleReplayedEnvelope: (frame: Uint8Array, meta?: BinaryDealingMeta, nowMs?: number) => DealingRequestRecord | null;
}

/**
 * Coordinates stream reconnect replay strictly over Binary TCP `0x3B` -> `0x3A` `EventKind = 7`
 * (DECISIONS.md D12: zero HTTP pending endpoint and zero `/ws/v2` fallback).
 */
export function createDealingReconnectReplayController(
  options: DealingReconnectReplayOptions,
): DealingReconnectReplayController {
  return {
    async onStreamReconnected() {
      const login = options.getAccountLogin();
      if (!Number.isSafeInteger(login) || login <= 0) {
        return null;
      }
      const token = String(options.getAuthToken?.() ?? '').trim();
      const packet0x3B = encodeAccountSubFrame0x3B(login, token);
      await options.sendAccountSub(login, token, packet0x3B);
      return packet0x3B;
    },

    handleReplayedEnvelope(frame, meta, nowMs = Date.now()) {
      const rec = ingestBinaryDealingEnvelope(frame, meta, nowMs);
      if (rec) {
        try {
          options.onReplayedRecord?.(rec);
        } catch {
          // m2: Isolate replay callback errors.
        }
      }
      return rec;
    },
  };
}
