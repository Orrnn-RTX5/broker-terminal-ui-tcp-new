import {
  WIRE_TRADE_EVENT_KIND_DEALING,
  WIRE_TRADE_EVENT_MIN_HEADER_SIZE,
  WIRE_TRADE_EVENT_VERSION,
  createEmptyTradeEventKind7Envelope,
  decodeTradeEventKind7EnvelopeIntoRange,
} from './binaryDealingCodec';
import {
  dealingPhaseFromBinaryStatus,
  kindFromWireCode,
  type DealingRequestRecord,
  type DealingStatusEvent,
} from './dealingReducer';
import type { BinaryDealingMeta } from './dealingEvents';
import { registerDealingTradeEventHook } from './dealingRuntimeHooks';
import { useDealingStore } from '../../store/useDealingStore';

export { WIRE_TRADE_EVENT_KIND_DEALING };

const envelopeScratch = createEmptyTradeEventKind7Envelope();

function readInt64LEAsSafeNumber(buf: Uint8Array, off: number): number {
  const lo = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
  const hi = buf[off + 4] | (buf[off + 5] << 8) | (buf[off + 6] << 16) | (buf[off + 7] << 24);
  return hi * 4_294_967_296 + (lo >>> 0);
}

/**
 * Decodes and routes an incoming `0x3A` `EventKind = 7` dealing envelope into `useDealingStore`
 * after verifying the envelope targets the active authenticated `accountLogin`.
 *
 * Uses zero-alloc range decoding into a module-scoped envelope scratch object and
 * registers into `dealingRuntimeHooks.ts` so `binaryTcpMarketStream.ts` carries zero static
 * imports of dealing codec/store modules.
 */
export function routeBinaryDealingTradeEvent(
  buf: Uint8Array,
  payloadOffset: number,
  payloadLen: number,
  activeAccountLogin: number,
  meta?: BinaryDealingMeta,
  nowMs = Date.now(),
): DealingRequestRecord | null {
  if (
    payloadLen < WIRE_TRADE_EVENT_MIN_HEADER_SIZE
    || payloadOffset < 0
    || payloadOffset + payloadLen > buf.byteLength
    || buf[payloadOffset] !== WIRE_TRADE_EVENT_VERSION
    || buf[payloadOffset + 1] !== WIRE_TRADE_EVENT_KIND_DEALING
  ) {
    return null;
  }

  if (!Number.isSafeInteger(activeAccountLogin) || activeAccountLogin <= 0) {
    return null;
  }

  const frameAccountLogin = readInt64LEAsSafeNumber(buf, payloadOffset + 2);
  if (!Number.isSafeInteger(frameAccountLogin) || frameAccountLogin !== activeAccountLogin) {
    return null;
  }

  try {
    decodeTradeEventKind7EnvelopeIntoRange(buf, payloadOffset, payloadLen, envelopeScratch);
    const ev = envelopeScratch.event;
    const phase = dealingPhaseFromBinaryStatus(ev.status);
    if (!phase || !ev.requestId) return null;

    const statusEvent: DealingStatusEvent = {
      requestId: ev.requestId,
      clientOrderId: ev.clientOrderId || undefined,
      accountLogin: activeAccountLogin,
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

    return useDealingStore.getState().applyEvent(statusEvent, nowMs);
  } catch {
    return null;
  }
}

export function installDealingMarketStreamBridge(): () => void {
  return registerDealingTradeEventHook(routeBinaryDealingTradeEvent);
}

// Register immediately whenever the bridge is loaded in lazy DealingShellHost or tests.
installDealingMarketStreamBridge();
