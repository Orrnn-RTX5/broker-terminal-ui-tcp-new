/**
 * Dev & Test Dealing Scenario Driver (no side effects on import; tree-shaken in prod).
 */

import {
  DEFAULT_HUMAN_TIMEOUT_MS,
  DEFAULT_REQUOTE_WINDOW_MS,
  MT_RET_REQUEST_CANCEL,
  MT_RET_REQUEST_DONE,
  MT_RET_REQUEST_INVALID_EXP,
  MT_RET_REQUEST_PLACED,
  MT_RET_REQUEST_REJECTED,
  MT_RET_REQUEST_REQUOTE,
  WIRE_ACTION_PLACE_MARKET,
  WIRE_DEALING_STATUS_CANCELLED,
  WIRE_DEALING_STATUS_EXPIRED,
  WIRE_DEALING_STATUS_FILLED,
  WIRE_DEALING_STATUS_IN_DEALING,
  WIRE_DEALING_STATUS_REJECTED,
  WIRE_DEALING_STATUS_REQUOTED,
  WIRE_SIDE_BUY,
  WIRE_STATUS_ACCEPTED,
  WIRE_STATUS_CONFLICT,
  DEALING_KIND_OPEN,
  encodeOrderRespFrame,
  encodeTradeEventKind7Envelope,
  type BinaryDealingStatusEventInput,
} from './binaryDealingCodec';
import {
  ingestBinaryDealingEnvelope,
  ingestBinaryOrderRespDealing,
  ingestDealingEvent,
  type BinaryDealingMeta,
  type DealingRequestRecord,
  type DealingStatusEvent,
} from './dealingEvents';
import { useDealingStore } from '../../store/useDealingStore';

export function createMockDealingUuid(seedByte: number): string {
  const hex = (seedByte & 0xff).toString(16).padStart(2, '0');
  return `10203040-5060-4780-8090-a0b0c0d0e0${hex}`;
}

export function emitMockDealingEvent(
  event: DealingStatusEvent,
  nowMs = Date.now(),
): DealingRequestRecord | null {
  return ingestDealingEvent(event, nowMs);
}

export function buildMockKind7Frame(
  accountLogin: number,
  ev: BinaryDealingStatusEventInput,
  timestampMs = Date.now(),
): Uint8Array {
  return encodeTradeEventKind7Envelope(accountLogin, timestampMs, `dealing.${accountLogin}`, ev);
}

export interface DealingMockDriver {
  inDealingToFilled: (opts?: {
    requestId?: string;
    clientOrderId?: string;
    symbol?: string;
    volume?: number;
    fillPrice?: number;
  }) => void;
  inDealingToRequote: (opts?: {
    requestId?: string;
    requoteId?: string;
    clientOrderId?: string;
    symbol?: string;
    side?: 1 | 2;
    volume?: number;
    digits?: number;
    requestedPrice?: number;
    bid?: number;
    ask?: number;
    windowMs?: number;
    nowMs?: number;
    isExpert?: boolean;
  }) => { requestId: string; requoteId: string };
  completeRequoteFill: (requestId: string, fillPrice?: number, nowMs?: number) => void;
  completeRequoteReject: (requestId: string, reasonCode?: string, reasonText?: string, nowMs?: number) => void;
  completeRequoteExpired: (requestId: string, nowMs?: number) => void;
  completeRequoteDeclined: (requestId: string, nowMs?: number) => void;
  expertRequote409: (opts?: {
    requestId?: string;
    clientOrderId?: string;
    symbol?: string;
  }) => DealingRequestRecord | null;
  replayVia0x3B: (accountLogin: number, ev: BinaryDealingStatusEventInput, meta?: BinaryDealingMeta) => DealingRequestRecord | null;
  dispose: () => void;
}

export function createDealingMockDriver(): DealingMockDriver {
  return {
    inDealingToFilled(opts = {}) {
      const requestId = opts.requestId ?? createMockDealingUuid(0x11);
      const clientOrderId = opts.clientOrderId ?? 'bo-mock-fill-1';
      const symbol = opts.symbol ?? 'EURUSD';
      const volume = opts.volume ?? 1.0;
      const now = Date.now();

      const resp0x39 = encodeOrderRespFrame({
        action: WIRE_ACTION_PLACE_MARKET,
        status: WIRE_STATUS_ACCEPTED,
        symbol,
        clientOrderId,
        volume,
        errorCode: 'IN_DEALING',
        message: 'Request placed in dealing queue',
        execWire: {
          retcode: MT_RET_REQUEST_PLACED,
          quotedReqId: 0,
          dealerBid: 1.0845,
          dealerAsk: 1.0846,
          requestId,
          expiresAtMs: now + DEFAULT_HUMAN_TIMEOUT_MS,
          serverNowMs: now,
          dealingKind: DEALING_KIND_OPEN,
          digits: 5,
          hasDigits: true,
        },
      });
      ingestBinaryOrderRespDealing(resp0x39, { side: 'buy', requestedPrice: 1.0846 }, now);

      const env0x3A = buildMockKind7Frame(100042, {
        status: WIRE_DEALING_STATUS_FILLED,
        kind: DEALING_KIND_OPEN,
        side: WIRE_SIDE_BUY,
        digits: 5,
        retcode: MT_RET_REQUEST_DONE,
        seq: 2,
        orderTicket: 900101,
        positionTicket: 900101,
        dealTicket: 900201,
        volume,
        price: opts.fillPrice ?? 1.08462,
        requestId,
        symbol,
        clientOrderId,
      }, now + 150);
      ingestBinaryDealingEnvelope(env0x3A, undefined, now + 150);
    },

    inDealingToRequote(opts = {}) {
      const requestId = opts.requestId ?? createMockDealingUuid(0x21);
      const requoteId = opts.requoteId ?? createMockDealingUuid(0x22);
      const clientOrderId = opts.clientOrderId ?? 'bo-mock-rq-1';
      const symbol = opts.symbol ?? 'EURUSD';
      const side = opts.side ?? WIRE_SIDE_BUY;
      const digits = opts.digits ?? 5;
      const volume = opts.volume ?? 2.0;
      const bid = opts.bid ?? 1.08480;
      const ask = opts.ask ?? 1.08495;
      const now = opts.nowMs ?? Date.now();
      const windowMs = opts.windowMs ?? DEFAULT_REQUOTE_WINDOW_MS;

      const meta: BinaryDealingMeta = {
        accountLogin: 100042,
        wireSide: side,
        requestedPrice: opts.requestedPrice ?? 1.08452,
        isExpert: opts.isExpert ?? false,
      };

      const queuedEnv = buildMockKind7Frame(100042, {
        status: WIRE_DEALING_STATUS_IN_DEALING,
        kind: DEALING_KIND_OPEN,
        side,
        digits,
        retcode: MT_RET_REQUEST_PLACED,
        seq: 1,
        volume,
        price: opts.requestedPrice ?? 1.08452,
        expiresAtMs: now + DEFAULT_HUMAN_TIMEOUT_MS,
        serverNowMs: now,
        requestId,
        symbol,
        clientOrderId,
      }, now);
      ingestBinaryDealingEnvelope(queuedEnv, meta, now);

      const rqEnv = buildMockKind7Frame(100042, {
        status: WIRE_DEALING_STATUS_REQUOTED,
        kind: DEALING_KIND_OPEN,
        side,
        digits,
        retcode: MT_RET_REQUEST_REQUOTE,
        seq: 2,
        volume,
        price: opts.requestedPrice ?? 1.08452,
        bid,
        ask,
        expiresAtMs: now + windowMs,
        serverNowMs: now,
        requestId,
        requoteId,
        symbol,
        clientOrderId,
      }, now);
      ingestBinaryDealingEnvelope(rqEnv, meta, now);

      return { requestId, requoteId };
    },

    completeRequoteFill(requestId, fillPrice = 1.08495, nowMs = Date.now()) {
      const rec = useDealingStore.getState().requests[requestId];
      const env = buildMockKind7Frame(rec?.accountLogin || 100042, {
        status: WIRE_DEALING_STATUS_FILLED,
        kind: DEALING_KIND_OPEN,
        side: rec?.wireSide || WIRE_SIDE_BUY,
        digits: rec?.digits ?? 5,
        retcode: MT_RET_REQUEST_DONE,
        seq: (rec?.seq ?? 2) + 1,
        orderTicket: 910001,
        positionTicket: 910001,
        dealTicket: 910002,
        volume: rec?.volume ?? 1.0,
        price: fillPrice,
        requestId,
        requoteId: rec?.requote?.requoteId,
        symbol: rec?.symbol ?? 'EURUSD',
        clientOrderId: rec?.clientOrderId ?? '',
      }, nowMs);
      ingestBinaryDealingEnvelope(env, undefined, nowMs);
    },

    completeRequoteReject(
      requestId,
      reasonCode = 'OFF_QUOTES',
      reasonText = 'Off quotes — market price unavailable',
      nowMs = Date.now(),
    ) {
      const rec = useDealingStore.getState().requests[requestId];
      const env = buildMockKind7Frame(rec?.accountLogin || 100042, {
        status: WIRE_DEALING_STATUS_REJECTED,
        kind: DEALING_KIND_OPEN,
        side: rec?.wireSide || WIRE_SIDE_BUY,
        digits: rec?.digits ?? 5,
        retcode: MT_RET_REQUEST_REJECTED,
        seq: (rec?.seq ?? 2) + 1,
        volume: rec?.volume ?? 1.0,
        requestId,
        requoteId: rec?.requote?.requoteId,
        symbol: rec?.symbol ?? 'EURUSD',
        clientOrderId: rec?.clientOrderId ?? '',
        reasonCode,
        reasonText,
      }, nowMs);
      ingestBinaryDealingEnvelope(env, undefined, nowMs);
    },

    completeRequoteExpired(requestId, nowMs = Date.now()) {
      const rec = useDealingStore.getState().requests[requestId];
      const env = buildMockKind7Frame(rec?.accountLogin || 100042, {
        status: WIRE_DEALING_STATUS_EXPIRED,
        kind: DEALING_KIND_OPEN,
        side: rec?.wireSide || WIRE_SIDE_BUY,
        digits: rec?.digits ?? 5,
        retcode: MT_RET_REQUEST_INVALID_EXP,
        seq: (rec?.seq ?? 2) + 1,
        volume: rec?.volume ?? 1.0,
        requestId,
        requoteId: rec?.requote?.requoteId,
        symbol: rec?.symbol ?? 'EURUSD',
        clientOrderId: rec?.clientOrderId ?? '',
        reasonCode: 'REQUOTE_EXPIRED',
        reasonText: 'Requote window expired',
      }, nowMs);
      ingestBinaryDealingEnvelope(env, undefined, nowMs);
    },

    completeRequoteDeclined(requestId, nowMs = Date.now()) {
      const rec = useDealingStore.getState().requests[requestId];
      const env = buildMockKind7Frame(rec?.accountLogin || 100042, {
        status: WIRE_DEALING_STATUS_CANCELLED,
        kind: DEALING_KIND_OPEN,
        side: rec?.wireSide || WIRE_SIDE_BUY,
        digits: rec?.digits ?? 5,
        retcode: MT_RET_REQUEST_CANCEL,
        seq: (rec?.seq ?? 2) + 1,
        volume: rec?.volume ?? 1.0,
        requestId,
        requoteId: rec?.requote?.requoteId,
        symbol: rec?.symbol ?? 'EURUSD',
        clientOrderId: rec?.clientOrderId ?? '',
        reasonCode: 'CLIENT_DECLINED',
        reasonText: 'Requote declined by client',
      }, nowMs);
      ingestBinaryDealingEnvelope(env, undefined, nowMs);
    },

    expertRequote409(opts = {}) {
      const requestId = opts.requestId ?? createMockDealingUuid(0x31);
      const clientOrderId = opts.clientOrderId ?? 'bo-ea-409';
      const symbol = opts.symbol ?? 'EURUSD';
      const resp = encodeOrderRespFrame({
        action: WIRE_ACTION_PLACE_MARKET,
        status: WIRE_STATUS_CONFLICT,
        symbol,
        clientOrderId,
        volume: 0.5,
        errorCode: 'REQUOTE',
        message: 'Requote on expert order',
        execWire: {
          retcode: MT_RET_REQUEST_REQUOTE,
          quotedReqId: 0,
          dealerBid: 1.0848,
          dealerAsk: 1.0849,
          requestId,
        },
      });
      return ingestBinaryOrderRespDealing(resp, { isExpert: true, side: 'buy' });
    },

    replayVia0x3B(accountLogin, ev, meta) {
      const env = buildMockKind7Frame(accountLogin, ev);
      return ingestBinaryDealingEnvelope(env, meta);
    },

    dispose() {
      useDealingStore.getState().reset();
    },
  };
}
