/**
 * Terminal Binary TCP Order Client Dealing Wiring (`dealingOrderClient.ts`).
 *
 * Isolates all dealing-specific order-client logic from `binaryTcpOrderClient.ts`:
 *  1. Gated capability TLV `0x16` (`CLIENT_CAP_DEALING_V1 = 1`) with zero-alloc
 *     140-byte WS Mode A scratch buffer (`4B reqId + 128B hdr + 8B extras`) when enabled.
 *  2. Zero-alloc-on-normal-path `0x39` dealing reply ingestion.
 *  3. Action `11` (`DealingSync`) D18 capability probe + rate-limited pull sync.
 *  4. Unified `0x38` Action `9` (Accept) and Action `10` (Decline) Binary TCP senders
 *     over `/__rtx5_binary_order_ws` fast-lane + HTTP fallback (and unload `keepalive`).
 */

import { getBinaryOrderRawFrameTransport } from '../binaryTcpOrderClient';
import type { RequoteDecisionTransport } from '../../hooks/useDealingRequest';
import { useDealingStore } from '../../store/useDealingStore';
import {
  CLIENT_CAP_DEALING_V1,
  CLIENT_CAPS_DEALING_V1_TLV,
  ORDER_REASON_EXPERT,
  WIRE_ACTION_CLOSE_BULK,
  WIRE_ACTION_CLOSE_BY,
  WIRE_ACTION_CLOSE_POSITION,
  WIRE_ACTION_DEALING_SYNC,
  WIRE_ACTION_MODIFY_PENDING,
  WIRE_ACTION_MODIFY_POSITION,
  WIRE_ACTION_PLACE_MARKET,
  WIRE_ACTION_PLACE_PENDING,
  WIRE_ACTION_REQUOTE_ACCEPT,
  WIRE_ACTION_REQUOTE_DECLINE,
  WIRE_EXTRA_TAG_CLIENT_CAPS,
  WIRE_EXTRA_TAG_REASON,
  WIRE_FLAG_HAS_EXTRAS,
  WIRE_ORDER_CODEC_VERSION,
  WIRE_ORDER_REQ_HEADER_SIZE,
  WIRE_ORDER_RESP_HEADER_SIZE,
  WIRE_STATUS_ACCEPTED,
  WIRE_STATUS_OK,
  appendClientCapsToExtrasTlv,
  decodeOrderRespWithExecWire,
  encodeDealingSyncFrame,
  encodeRequoteActionFrame,
  readNormalizedClientOrderId40,
  readNormalizedSymbol16,
  type DecodedOrderRespWithExecWire,
} from './binaryDealingCodec';
import {
  ingestBinaryOrderRespDealing,
  type DealingOrderKind,
  type DealingRequestRecord,
  type DealingSweepDeclineHandler,
} from './dealingEvents';
import {
  isDealingServerAdvertised,
  isDealingTransportSupported,
  isDealingWireGateOpen,
  registerDealingOrderClientHooks,
  setDealingServerAdvertised,
  type DealingRawFrameTransport,
} from './dealingRuntimeHooks';

// ─── Zero-Alloc WS Mode A Scratch Buffer With Capability TLV 0x16 ────────────

export const WS_REQ_ID_PREFIX_SIZE = 4;
/** `[u32 reqId][128B 0x38 header][u16 extrasLen=6][0x16, 0x04, 0x01, 0x00, 0x00, 0x00]` = 140 bytes. */
export const WS_FAST_ORDER_WITH_DEALING_CAPS_SIZE =
  WS_REQ_ID_PREFIX_SIZE + WIRE_ORDER_REQ_HEADER_SIZE + 2 + CLIENT_CAPS_DEALING_V1_TLV.byteLength;

/** Per-login client-side Action 11 DealingSync probe cooldown (DECISIONS.md D18). */
export const DEALING_SYNC_MIN_INTERVAL_MS = 2_000;

const fastWsDealingCapsBuffer = new ArrayBuffer(WS_FAST_ORDER_WITH_DEALING_CAPS_SIZE);
const fastWsDealingCapsPacket = new Uint8Array(fastWsDealingCapsBuffer);
const fastWsDealingCapsView = new DataView(fastWsDealingCapsBuffer);

// Pre-populate trailing `[u16 extrasLen=6][TLV 0x16]` once at module load (0 allocs per order).
fastWsDealingCapsView.setUint16(
  WS_REQ_ID_PREFIX_SIZE + WIRE_ORDER_REQ_HEADER_SIZE,
  CLIENT_CAPS_DEALING_V1_TLV.byteLength,
  true,
);
fastWsDealingCapsPacket.set(
  CLIENT_CAPS_DEALING_V1_TLV,
  WS_REQ_ID_PREFIX_SIZE + WIRE_ORDER_REQ_HEADER_SIZE + 2,
);

/**
 * Attaches TLV `0x16` (`CLIENT_CAP_DEALING_V1 = 1`) after all existing TLVs on a validated
 * order request and sets `WIRE_FLAG_HAS_EXTRAS`. Wrapped in `try/catch` so an unexpected
 * TLV error logs a warning and still sends the order rather than dropping order placement.
 */
export function applyDealingClientCapsToValidated(validated: {
  flags: number;
  extrasBytes: Uint8Array;
}): void {
  try {
    const withCaps = appendClientCapsToExtrasTlv(validated.extrasBytes, CLIENT_CAP_DEALING_V1);
    validated.extrasBytes = withCaps;
    validated.flags = (validated.flags | WIRE_FLAG_HAS_EXTRAS) & 0xffff;
  } catch {
    // Best-effort capability TLV attachment: leave existing extras intact on unexpected encode errors.
  }
}

/**
 * True when `extrasBytes` contains only the default 6-byte dealing capability TLV `0x16`
 * (`CLIENT_CAP_DEALING_V1 = 1`), allowing zero-alloc transmission via the 140-byte scratch buffer.
 */
export function isOnlyDefaultDealingCapsTlv(extrasBytes: Uint8Array): boolean {
  if (extrasBytes === CLIENT_CAPS_DEALING_V1_TLV) return true;
  return (
    extrasBytes.byteLength === 6
    && extrasBytes[0] === WIRE_EXTRA_TAG_CLIENT_CAPS
    && extrasBytes[1] === 4
    && extrasBytes[2] === 1
    && extrasBytes[3] === 0
    && extrasBytes[4] === 0
    && extrasBytes[5] === 0
  );
}

/**
 * Zeroes the `[0..132)` prefix of the pre-allocated 140-byte WS Mode A scratch buffer
 * (preserving the pre-populated `[132..140)` TLV `0x16` suffix) and writes `reqId`.
 */
export function prepareFastWsModeAWithDealingCapsScratch(reqId: number): {
  packet: Uint8Array<ArrayBuffer>;
  view: DataView;
} {
  fastWsDealingCapsPacket.fill(0, 0, WS_REQ_ID_PREFIX_SIZE + WIRE_ORDER_REQ_HEADER_SIZE);
  fastWsDealingCapsView.setUint32(0, reqId >>> 0, true);
  return {
    packet: fastWsDealingCapsPacket,
    view: fastWsDealingCapsView,
  };
}

export function tryPrepareFastWsModeAWithCaps(
  reqId: number,
  extrasBytes: Uint8Array,
): { packet: Uint8Array<ArrayBuffer>; view: DataView } | null {
  if (!isOnlyDefaultDealingCapsTlv(extrasBytes)) return null;
  return prepareFastWsModeAWithDealingCapsScratch(reqId);
}

// ─── 0x39 Dealing Response Detection & Store Ingestion ───────────────────────

/** Reads TLV `0x06` (`Reason`) from an encoded extras block without heap allocations. */
export function extractOrderReasonFromExtrasTlv(extrasBytes: Uint8Array): number {
  let pos = 0;
  while (pos + 2 <= extrasBytes.byteLength) {
    const tag = extrasBytes[pos];
    const len = extrasBytes[pos + 1];
    pos += 2;
    if (pos + len > extrasBytes.byteLength) break;
    if (tag === WIRE_EXTRA_TAG_REASON && len === 1) {
      return extrasBytes[pos];
    }
    pos += len;
  }
  return 0;
}

function dealingOrderKindFromAction(action: number): DealingOrderKind | undefined {
  switch (action) {
    case WIRE_ACTION_PLACE_MARKET:
    case WIRE_ACTION_PLACE_PENDING:
      return 'open';
    case WIRE_ACTION_CLOSE_POSITION:
    case WIRE_ACTION_CLOSE_BULK:
    case WIRE_ACTION_CLOSE_BY:
      return 'close';
    case WIRE_ACTION_MODIFY_POSITION:
    case WIRE_ACTION_MODIFY_PENDING:
      return 'modify';
    default:
      return undefined;
  }
}

export function decodeDealingOrderRespBytes(bytes: Uint8Array): DecodedOrderRespWithExecWire {
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
 * Feeds `useDealingStore` when a `0x39` binary order reply carries dealing context
 * (`202` `10008 IN_DEALING`, `202` `10004` robot requote, Action `9`/`10`, or dealing `409`/`422`).
 * Fast-exits with ZERO allocations on normal `200 OK` and non-dealing error replies.
 */
export function ingestBinaryOrderRespForDealingIfPresent(
  rawBuffer: ArrayBuffer,
  byteOffset: number,
  decoded: { action: number; status: number; clientOrderId: string },
  validated: {
    action: number;
    side: number;
    login: number;
    volume: number;
    price: number;
    sl: number;
    tp: number;
    extrasBytes: Uint8Array;
  },
  effectiveClientOrderId: string,
  msgEndOffset?: number,
): DealingRequestRecord | null {
  const payloadLen = rawBuffer.byteLength - byteOffset;
  const isRequoteAction =
    decoded.action === WIRE_ACTION_REQUOTE_ACCEPT || decoded.action === WIRE_ACTION_REQUOTE_DECLINE;

  if (payloadLen < WIRE_ORDER_RESP_HEADER_SIZE) {
    return null;
  }
  if (
    msgEndOffset !== undefined
    && msgEndOffset >= payloadLen
    && decoded.status !== WIRE_STATUS_ACCEPTED
    && !isRequoteAction
  ) {
    return null;
  }
  if (payloadLen <= WIRE_ORDER_RESP_HEADER_SIZE + 4 && decoded.status !== WIRE_STATUS_ACCEPTED && !isRequoteAction) {
    return null;
  }

  const bytes = new Uint8Array(rawBuffer, byteOffset, payloadLen);
  if (payloadLen >= WIRE_ORDER_RESP_HEADER_SIZE + 4) {
    const errCodeLen = bytes[136] | (bytes[137] << 8);
    const msgLenOff = 138 + errCodeLen;
    if (payloadLen < msgLenOff + 2) {
      return null;
    }
    const msgLen = bytes[msgLenOff] | (bytes[msgLenOff + 1] << 8);
    const msgEnd = msgLenOff + 2 + msgLen;
    if (msgEnd >= payloadLen && decoded.status !== WIRE_STATUS_ACCEPTED && !isRequoteAction) {
      return null;
    }
  } else if (decoded.status !== WIRE_STATUS_ACCEPTED && !isRequoteAction) {
    return null;
  }

  try {
    const parsed = decodeDealingOrderRespBytes(bytes);
    if (!parsed.clientOrderId && effectiveClientOrderId) {
      parsed.clientOrderId = effectiveClientOrderId;
    }
    const isExpert = extractOrderReasonFromExtrasTlv(validated.extrasBytes) === ORDER_REASON_EXPERT;
    return ingestBinaryOrderRespDealing(parsed, {
      accountLogin: validated.login > 0 ? validated.login : undefined,
      wireSide: validated.side,
      kind: dealingOrderKindFromAction(validated.action),
      volume: validated.volume > 0 ? validated.volume : undefined,
      requestedPrice: validated.price > 0 ? validated.price : undefined,
      sl: validated.sl,
      tp: validated.tp,
      isExpert,
    });
  } catch {
    return null;
  }
}

// ─── Raw 0x38 Transport, Action 11 Probe & Requote Action 9 / 10 Senders ──────

interface PendingRawWsDealingEntry {
  readonly reqId: number;
  readonly clientOrderId: string;
  readonly action: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanupAbort: () => void;
  readonly releaseActiveSlot: () => void;
  readonly resolve: (respBytes: Uint8Array) => void;
  readonly reject: (err: Error) => void;
  readonly createOrderError: DealingRawFrameTransport['createOrderError'];
}

const WS_OPEN_STATE = 1;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');
const inFlightDealingRawWsOrders = new Map<number, PendingRawWsDealingEntry>();
const lastDealingSyncAtByLogin = new Map<number, number>();
const inFlightDealingSyncByLogin = new Map<number, Promise<DealingSyncProbeResult>>();

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * Completes an in-flight raw `0x38` WebSocket request (e.g. Action 9/10/11)
 * when `ensureBinaryOrderWebSocket().onmessage` receives a matching `reqId`.
 */
export function resolveInFlightDealingRawWsOrder(reqId: number, raw: ArrayBuffer): boolean {
  const pending = inFlightDealingRawWsOrders.get(reqId);
  if (!pending) return false;
  inFlightDealingRawWsOrders.delete(reqId);
  clearTimeout(pending.timer);
  pending.cleanupAbort();
  pending.releaseActiveSlot();
  pending.resolve(new Uint8Array(raw, WS_REQ_ID_PREFIX_SIZE).slice());
  return true;
}

/** Rejects all pending raw dealing WebSocket frames on socket close/reset. */
export function failAllInFlightDealingRawWsOrders(reason: string): void {
  if (inFlightDealingRawWsOrders.size === 0) return;
  const entries = Array.from(inFlightDealingRawWsOrders.values());
  inFlightDealingRawWsOrders.clear();
  for (const entry of entries) {
    clearTimeout(entry.timer);
    entry.cleanupAbort();
    entry.releaseActiveSlot();
    entry.reject(
      entry.createOrderError(reason, {
        status: 503,
        code: 'BINARY_TRANSPORT_UNREACHABLE',
        retryable: true,
        clientOrderId: entry.clientOrderId,
        action: entry.action,
      }),
    );
  }
}

/** Installs dealing callbacks onto `dealingRuntimeHooks.ts`. */
export function installDealingOrderClientHooks(): () => void {
  return registerDealingOrderClientHooks({
    applyClientCaps: applyDealingClientCapsToValidated,
    tryPrepareFastWsModeAWithCaps,
    ingestOrderResp: ingestBinaryOrderRespForDealingIfPresent,
    resolveRawWsOrder: resolveInFlightDealingRawWsOrder,
    failAllRawWsOrders: failAllInFlightDealingRawWsOrders,
  });
}

// Register immediately whenever dealingOrderClient is loaded in lazy chunk or unit tests.
installDealingOrderClientHooks();

/**
 * Ensures an encoded `0x38` frame (`[128B header][u16 tokenLen][token]...`)
 * carries `fallbackToken` when `tokenLen === 0`, preserving trailing bytes verbatim.
 */
export function hydrateRawFrame0x38AuthToken(frame0x38: Uint8Array, fallbackToken: string): Uint8Array {
  if (frame0x38.byteLength < WIRE_ORDER_REQ_HEADER_SIZE + 2) {
    return frame0x38;
  }
  const trimmed = fallbackToken.trim();
  if (!trimmed) return frame0x38;

  const view = new DataView(frame0x38.buffer, frame0x38.byteOffset, frame0x38.byteLength);
  const existingTokenLen = view.getUint16(WIRE_ORDER_REQ_HEADER_SIZE, true);
  if (existingTokenLen > 0) {
    return frame0x38;
  }

  const tokenBytes = utf8Encoder.encode(trimmed);
  const tokenLen = Math.min(tokenBytes.byteLength, 0xffff);
  if (tokenLen === 0) return frame0x38;

  const tailOffset = WIRE_ORDER_REQ_HEADER_SIZE + 2;
  const tailLen = frame0x38.byteLength - tailOffset;
  const out = new Uint8Array(WIRE_ORDER_REQ_HEADER_SIZE + 2 + tokenLen + tailLen);
  out.set(frame0x38.subarray(0, WIRE_ORDER_REQ_HEADER_SIZE), 0);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint16(
    WIRE_ORDER_REQ_HEADER_SIZE,
    tokenLen,
    true,
  );
  out.set(tokenBytes.subarray(0, tokenLen), WIRE_ORDER_REQ_HEADER_SIZE + 2);
  if (tailLen > 0) {
    out.set(frame0x38.subarray(tailOffset), WIRE_ORDER_REQ_HEADER_SIZE + 2 + tokenLen);
  }
  return out;
}

function sendRawFrameOverOpenWs(
  transport: DealingRawFrameTransport,
  socket: WebSocket,
  frame0x38: Uint8Array,
  action: number,
  clientOrderId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> | null {
  const reqId = transport.allocateWsReqId();
  let txSyncFailed = false;

  const promise = new Promise<Uint8Array>((resolve, reject) => {
    const releaseActiveSlot = transport.acquireActiveSlot();
    let abortAttached = false;
    const cleanupAbort = (): void => {
      if (abortAttached && signal) {
        signal.removeEventListener('abort', onCallerAbort);
        abortAttached = false;
      }
    };

    const timer = setTimeout(() => {
      if (!inFlightDealingRawWsOrders.delete(reqId)) return;
      cleanupAbort();
      releaseActiveSlot();
      reject(
        transport.createOrderError('Binary TCP requote WebSocket request timed out', {
          status: 504,
          code: 'GATEWAY_TIMEOUT',
          retryable: true,
          clientOrderId,
          action,
        }),
      );
    }, timeoutMs);

    const onCallerAbort = (): void => {
      if (!inFlightDealingRawWsOrders.delete(reqId)) return;
      clearTimeout(timer);
      cleanupAbort();
      releaseActiveSlot();
      reject(
        transport.createOrderError('Requote request aborted', {
          status: 0,
          code: 'REQUEST_ABORTED',
          retryable: false,
          clientOrderId,
          action,
        }),
      );
    };

    if (signal) {
      signal.addEventListener('abort', onCallerAbort, { once: true });
      abortAttached = true;
    }

    inFlightDealingRawWsOrders.set(reqId, {
      reqId,
      clientOrderId,
      action,
      timer,
      cleanupAbort,
      releaseActiveSlot,
      resolve,
      reject,
      createOrderError: transport.createOrderError,
    });

    try {
      const wsBuffer = new ArrayBuffer(WS_REQ_ID_PREFIX_SIZE + frame0x38.byteLength);
      const wsFrame = new Uint8Array(wsBuffer);
      new DataView(wsBuffer).setUint32(0, reqId >>> 0, true);
      wsFrame.set(frame0x38, WS_REQ_ID_PREFIX_SIZE);
      socket.send(wsFrame);
    } catch {
      inFlightDealingRawWsOrders.delete(reqId);
      clearTimeout(timer);
      cleanupAbort();
      releaseActiveSlot();
      txSyncFailed = true;
      resolve(new Uint8Array(0));
    }
  });

  if (txSyncFailed) {
    transport.ensureWebSocket();
    return null;
  }

  return promise;
}

async function sendRawFrameViaHttp(
  transport: DealingRawFrameTransport,
  frame0x38: Uint8Array,
  action: number,
  clientOrderId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  keepalive?: boolean,
): Promise<Uint8Array> {
  const endpoint = transport.resolveHttpEndpoint();
  const bodyBuffer = toExactArrayBuffer(frame0x38);

  if (keepalive) {
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Accept: 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
        body: bodyBuffer,
        cache: 'no-store',
        keepalive: true,
      });
    } catch {
      // Best-effort fire-and-forget on pagehide/beforeunload.
    }
    return new Uint8Array(0);
  }

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => {
    controller.abort(signal?.reason);
  };
  if (signal) {
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const releaseActiveSlot = transport.acquireActiveSlot();

  let response: Response;
  let responseBuffer: ArrayBuffer;
  try {
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Accept: 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
        body: bodyBuffer,
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (firstErr) {
      if (signal?.aborted || timedOut || endpoint === transport.fallbackHttpEndpoint) {
        throw firstErr;
      }
      transport.markFastEndpointUnreachable();
      transport.ensureWebSocket();
      response = await fetch(transport.fallbackHttpEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Accept: 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
        body: bodyBuffer,
        signal: controller.signal,
        cache: 'no-store',
      });
    }
    responseBuffer = await response.arrayBuffer();
  } catch (error) {
    if (signal?.aborted) {
      throw transport.createOrderError('Requote request aborted', {
        status: 0,
        code: 'REQUEST_ABORTED',
        retryable: false,
        clientOrderId,
        action,
      });
    }
    if (timedOut) {
      throw transport.createOrderError('Binary TCP requote request timed out', {
        status: 504,
        code: 'GATEWAY_TIMEOUT',
        retryable: true,
        clientOrderId,
        action,
      });
    }
    const detail = error instanceof Error ? error.message : 'Binary TCP requote transport failed';
    throw transport.createOrderError(detail || 'Binary TCP requote transport failed', {
      status: 503,
      code: 'BINARY_TRANSPORT_UNREACHABLE',
      retryable: true,
      clientOrderId,
      action,
    });
  } finally {
    releaseActiveSlot();
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', onCallerAbort);
    }
  }

  const bytes = new Uint8Array(responseBuffer);
  if (bytes.byteLength >= WIRE_ORDER_RESP_HEADER_SIZE && bytes[0] === WIRE_ORDER_CODEC_VERSION) {
    return bytes;
  }

  if (response.status === 404 || response.status === 501) {
    setDealingServerAdvertised(false);
    if (action === WIRE_ACTION_REQUOTE_DECLINE) {
      return new Uint8Array(0);
    }
    throw transport.createOrderError('Dealing is not enabled on this server', {
      status: response.status,
      code: 'DEALING_NOT_ENABLED',
      retryable: false,
      clientOrderId,
      action,
    });
  }

  if (response.status < 400) {
    throw transport.createOrderError(
      `Invalid binary TCP 0x39 requote response (HTTP ${response.status}, ${bytes.byteLength}B)`,
      {
        status: 502,
        code: 'TRUNCATED_BINARY_ORDER_RESP',
        retryable: true,
        clientOrderId,
        action,
      },
    );
  }

  const rawText = bytes.byteLength > 0 ? utf8Decoder.decode(bytes).trim() : '';
  const httpStatus = response.status >= 400 ? response.status : 502;
  throw transport.createOrderError(
    rawText || `Binary TCP requote endpoint returned HTTP ${response.status}`,
    {
      status: httpStatus,
      code: httpStatus >= 502 ? 'BINARY_TUNNEL_UNAVAILABLE' : 'BINARY_ORDER_HTTP_ERROR',
      retryable: httpStatus >= 502,
      clientOrderId,
      action,
    },
  );
}

export interface SendRawBinaryDealingOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  keepalive?: boolean;
}

/**
 * Transmits a pre-encoded `0x38` dealing frame (Actions `9`/`10`/`11`) over the persistent
 * `/__rtx5_binary_order_ws` fast-lane when open, falling back to `POST /__rtx5_binary_order`.
 */
export async function sendRawBinaryOrderFrameWithTransport(
  transport: DealingRawFrameTransport,
  encodedFrame0x38: Uint8Array,
  opts?: SendRawBinaryDealingOptions,
): Promise<Uint8Array> {
  if (!(encodedFrame0x38 instanceof Uint8Array) || encodedFrame0x38.byteLength < WIRE_ORDER_REQ_HEADER_SIZE + 2) {
    throw transport.createOrderError('Invalid raw 0x38 order frame length', {
      status: 400,
      code: 'INVALID_BINARY_ORDER',
      retryable: false,
    });
  }
  const action = encodedFrame0x38[1];
  const clientOrderId = readNormalizedClientOrderId40(encodedFrame0x38, 88);

  if (action === WIRE_ACTION_DEALING_SYNC) {
    if (!isDealingTransportSupported()) {
      throw transport.createOrderError('Dealing transport is not enabled on this bridge', {
        status: 501,
        code: 'DEALING_NOT_ENABLED',
        retryable: false,
        clientOrderId,
        action,
      });
    }
  } else if (action === WIRE_ACTION_REQUOTE_ACCEPT || action === WIRE_ACTION_REQUOTE_DECLINE) {
    if (!isDealingWireGateOpen()) {
      if (action === WIRE_ACTION_REQUOTE_DECLINE) {
        return new Uint8Array(0);
      }
      throw transport.createOrderError('Dealing is not enabled on this server', {
        status: 501,
        code: 'DEALING_NOT_ENABLED',
        retryable: false,
        clientOrderId,
        action,
      });
    }
  }

  const timeoutMs =
    opts?.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.trunc(opts.timeoutMs)
      : transport.defaultTimeoutMs;

  if (opts?.signal?.aborted) {
    throw transport.createOrderError('Requote request was aborted before transmission', {
      status: 0,
      code: 'REQUEST_ABORTED',
      retryable: false,
      clientOrderId,
      action,
    });
  }

  const hydratedFrame = hydrateRawFrame0x38AuthToken(encodedFrame0x38, transport.getAccessToken());

  if (opts?.keepalive) {
    return sendRawFrameViaHttp(
      transport,
      hydratedFrame,
      action,
      clientOrderId,
      timeoutMs,
      opts.signal,
      true,
    );
  }

  let respBytes: Uint8Array | null = null;
  if (transport.isEnabled() && typeof WebSocket === 'function') {
    const socket = transport.getOpenWebSocket();
    if (socket && socket.readyState === WS_OPEN_STATE) {
      const wsPromise = sendRawFrameOverOpenWs(
        transport,
        socket,
        hydratedFrame,
        action,
        clientOrderId,
        timeoutMs,
        opts?.signal,
      );
      if (wsPromise !== null) {
        respBytes = await wsPromise;
      }
    } else {
      transport.ensureWebSocket();
    }
  }

  if (respBytes === null) {
    respBytes = await sendRawFrameViaHttp(
      transport,
      hydratedFrame,
      action,
      clientOrderId,
      timeoutMs,
      opts?.signal,
      false,
    );
  }

  if (respBytes.byteLength === 0 && action === WIRE_ACTION_REQUOTE_DECLINE) {
    return respBytes;
  }

  if (respBytes.byteLength < WIRE_ORDER_RESP_HEADER_SIZE || respBytes[0] !== WIRE_ORDER_CODEC_VERSION) {
    throw transport.createOrderError('Invalid binary TCP 0x39 requote response', {
      status: 502,
      code: 'TRUNCATED_BINARY_ORDER_RESP',
      retryable: true,
      clientOrderId,
      action,
    });
  }

  if (action === WIRE_ACTION_REQUOTE_ACCEPT || action === WIRE_ACTION_REQUOTE_DECLINE) {
    const respStatus = new DataView(respBytes.buffer, respBytes.byteOffset, 4).getUint16(2, true);
    if (respStatus === 501) {
      setDealingServerAdvertised(false);
      if (action === WIRE_ACTION_REQUOTE_DECLINE) {
        return new Uint8Array(0);
      }
      const decoded = decodeDealingOrderRespBytes(respBytes);
      throw transport.createOrderError(decoded.message || 'Dealing is not enabled on this server', {
        status: respStatus,
        code: decoded.errorCode.trim().toUpperCase() || 'DEALING_NOT_ENABLED',
        retryable: false,
        clientOrderId: decoded.clientOrderId || clientOrderId,
        execMicros: decoded.execMicros,
        action,
        backendMessage: decoded.message || undefined,
      });
    }
    if (respStatus === 504) {
      const decoded = decodeDealingOrderRespBytes(respBytes);
      throw transport.createOrderError(decoded.message || 'Binary TCP requote request timed out', {
        status: 504,
        code: decoded.errorCode.trim().toUpperCase() || 'BINARY_TCP_TIMEOUT',
        retryable: true,
        clientOrderId: decoded.clientOrderId || clientOrderId,
        execMicros: decoded.execMicros,
        action,
        backendMessage: decoded.message || undefined,
      });
    }
    if (
      respStatus === 400
      || respStatus === 401
      || respStatus === 403
      || respStatus === 404
      || respStatus >= 500
    ) {
      const decoded = decodeDealingOrderRespBytes(respBytes);
      const fallbackCode =
        respStatus === 401
          ? 'UNAUTHORIZED'
          : respStatus === 403
            ? 'FORBIDDEN'
            : respStatus === 404
              ? 'DEALING_REQUEST_NOT_FOUND'
              : respStatus === 400
                ? 'INVALID_BINARY_ORDER'
                : respStatus === 503
                  ? 'SERVICE_UNAVAILABLE'
                  : respStatus === 502
                    ? 'BAD_GATEWAY'
                    : 'INTERNAL_ERROR';
      throw transport.createOrderError(
        decoded.message || `Binary TCP requote failed with status ${respStatus}`,
        {
          status: respStatus,
          code: decoded.errorCode.trim().toUpperCase() || fallbackCode,
          retryable: respStatus >= 502,
          clientOrderId: decoded.clientOrderId || clientOrderId,
          execMicros: decoded.execMicros,
          action,
          backendMessage: decoded.message || undefined,
        },
      );
    }
  }
  return respBytes;
}

// ─── D18 Action 11 DealingSync Probe ─────────────────────────────────────────

export interface DealingSyncProbeParams {
  accountLogin: number;
  authToken?: string | null;
  transport?: DealingRawFrameTransport;
  force?: boolean;
  timeoutMs?: number;
  nowMs?: number;
}

export interface DealingSyncProbeResult {
  sent: boolean;
  enabled: boolean;
  rateLimited: boolean;
  status: number;
}

export function resetDealingSyncProbeState(): void {
  lastDealingSyncAtByLogin.clear();
  inFlightDealingSyncByLogin.clear();
}

/**
 * Sends a `0x38` Action 11 (`DealingSync`) probe once after push subscription commits (DECISIONS.md D18).
 * - Never sends over desktop `clientcore` bridge or unpatched `web-tcp` bridge.
 * - Rate-limited per login to at most 1 probe per `DEALING_SYNC_MIN_INTERVAL_MS` (`2000` ms).
 * - Opens `isDealingWireGateOpen()` ONLY when the server replies `200 OK` with TLV `0x2A = 1`.
 */
export async function sendDealingSyncProbe(
  params: DealingSyncProbeParams,
): Promise<DealingSyncProbeResult> {
  const login = Number.isFinite(params.accountLogin) ? Math.trunc(params.accountLogin) : 0;
  if (!Number.isSafeInteger(login) || login <= 0) {
    return { sent: false, enabled: isDealingServerAdvertised(), rateLimited: false, status: 0 };
  }
  if (!isDealingTransportSupported()) {
    setDealingServerAdvertised(false);
    return { sent: false, enabled: false, rateLimited: false, status: 0 };
  }

  const existing = inFlightDealingSyncByLogin.get(login);
  if (existing) {
    return existing;
  }

  const nowMs = params.nowMs ?? Date.now();
  const lastAt = lastDealingSyncAtByLogin.get(login) ?? -Infinity;
  if (!params.force && nowMs - lastAt < DEALING_SYNC_MIN_INTERVAL_MS) {
    return {
      sent: false,
      enabled: isDealingServerAdvertised(),
      rateLimited: true,
      status: 0,
    };
  }

  lastDealingSyncAtByLogin.set(login, nowMs);
  const transport = params.transport ?? getBinaryOrderRawFrameTransport();
  const token =
    params.authToken !== undefined
      ? String(params.authToken ?? '').trim()
      : transport.getAccessToken();

  const run = (async (): Promise<DealingSyncProbeResult> => {
    try {
      const frame0x38 = encodeDealingSyncFrame({ accountLogin: login, authToken: token });
      const rawResp = await sendRawBinaryOrderFrameWithTransport(transport, frame0x38, {
        timeoutMs: params.timeoutMs ?? 5_000,
      });
      const decoded = decodeDealingOrderRespBytes(rawResp);
      const enabled = Boolean(
        decoded.status === WIRE_STATUS_OK
        && decoded.execWire?.hasDealingEnabled
        && decoded.execWire.dealingEnabled === true,
      );
      setDealingServerAdvertised(enabled);
      return { sent: true, enabled, rateLimited: false, status: decoded.status };
    } catch (err) {
      setDealingServerAdvertised(false);
      const status =
        err && typeof err === 'object' && 'status' in err && typeof (err as { status?: unknown }).status === 'number'
          ? ((err as { status: number }).status)
          : 0;
      return { sent: true, enabled: false, rateLimited: false, status };
    } finally {
      inFlightDealingSyncByLogin.delete(login);
    }
  })();

  inFlightDealingSyncByLogin.set(login, run);
  return run;
}

// ─── Unified Action 9 / Action 10 Senders ────────────────────────────────────

/**
 * Creates a `RequoteDecisionTransport` callback suitable for `<RequoteDialog sendRequoteFrame={...} />`
 * and `useDealingRequest({ sendRequoteFrame })`.
 */
export function createDealingRequoteFrameSender(
  transport: DealingRawFrameTransport,
  opts?: { keepalive?: boolean },
): RequoteDecisionTransport {
  return async (encodedFrame0x38) => {
    const resp = await sendRawBinaryOrderFrameWithTransport(transport, encodedFrame0x38, opts);
    return resp.byteLength > 0 ? resp : undefined;
  };
}

export interface DealingRequoteDecisionBaseParams {
  accountLogin: number;
  requestId: string;
  requoteId: string;
  side?: number;
  orderSubType?: number;
  flags?: number;
  volume?: number;
  symbol?: string;
  clientOrderId?: string;
  authToken?: string | null;
  reason?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DealingRequoteAcceptParams extends DealingRequoteDecisionBaseParams {
  /** Required offered price (> 0) for Action 9 Accept. */
  price: number;
}

export type DealingRequoteDeclineParams = DealingRequoteDecisionBaseParams;

function buildEmptyDeclineFallbackResp(
  params: DealingRequoteDecisionBaseParams,
): DecodedOrderRespWithExecWire {
  return {
    version: WIRE_ORDER_CODEC_VERSION,
    action: WIRE_ACTION_REQUOTE_DECLINE,
    status: 501,
    ok: false,
    execMicros: 0,
    orderTicket: 0,
    positionTicket: 0,
    dealTicket: 0,
    fillPrice: 0,
    volume: params.volume ?? 0,
    profit: 0,
    commission: 0,
    sl: 0,
    tp: 0,
    symbol: params.symbol ?? '',
    clientOrderId: params.clientOrderId ?? '',
    errorCode: 'DEALING_NOT_ENABLED',
    message: 'Dealing is not enabled on this server',
    msgEndOffset: WIRE_ORDER_RESP_HEADER_SIZE,
    execWire: null,
  };
}

async function sendRequoteDecisionWithTransport(
  transport: DealingRawFrameTransport,
  action: typeof WIRE_ACTION_REQUOTE_ACCEPT | typeof WIRE_ACTION_REQUOTE_DECLINE,
  params: DealingRequoteDecisionBaseParams & { price: number },
): Promise<DecodedOrderRespWithExecWire> {
  const token =
    params.authToken !== undefined
      ? String(params.authToken ?? '').trim()
      : transport.getAccessToken();

  const frame0x38 = encodeRequoteActionFrame({
    action,
    side: params.side,
    orderSubType: params.orderSubType,
    flags: params.flags,
    accountLogin: params.accountLogin,
    ticket: 0,
    volume: params.volume,
    price: params.price,
    expiration: 0,
    symbol: params.symbol,
    clientOrderId: params.clientOrderId,
    authToken: token,
    requestId: params.requestId,
    requoteId: params.requoteId,
    reason: params.reason,
    clientCaps: CLIENT_CAP_DEALING_V1,
  });

  const rawResp = await sendRawBinaryOrderFrameWithTransport(transport, frame0x38, {
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  if (rawResp.byteLength === 0 && action === WIRE_ACTION_REQUOTE_DECLINE) {
    if (params.requestId && useDealingStore.getState().requests[params.requestId]) {
      useDealingStore.getState().dismissRequote(params.requestId);
    }
    return buildEmptyDeclineFallbackResp(params);
  }
  const decoded = decodeDealingOrderRespBytes(rawResp);
  ingestBinaryOrderRespDealing(decoded, {
    accountLogin: params.accountLogin,
    wireSide: params.side,
    volume: params.volume,
    requestedPrice: params.price > 0 ? params.price : undefined,
    isExpert: params.reason === ORDER_REASON_EXPERT,
    requestId: params.requestId,
  });
  return decoded;
}

export function sendDealingRequoteAcceptWithTransport(
  transport: DealingRawFrameTransport,
  params: DealingRequoteAcceptParams,
): Promise<DecodedOrderRespWithExecWire> {
  return sendRequoteDecisionWithTransport(transport, WIRE_ACTION_REQUOTE_ACCEPT, {
    ...params,
    price: params.price,
  });
}

export function sendDealingRequoteDeclineWithTransport(
  transport: DealingRawFrameTransport,
  params: DealingRequoteDeclineParams,
): Promise<DecodedOrderRespWithExecWire> {
  return sendRequoteDecisionWithTransport(transport, WIRE_ACTION_REQUOTE_DECLINE, {
    ...params,
    price: 0,
  });
}

export function createDealingSweepDeclineHandlerWithTransport(
  transport: DealingRawFrameTransport,
  getAccountLogin?: () => number | null | undefined,
): DealingSweepDeclineHandler {
  return async (record) => {
    const requoteId = record.requote?.requoteId?.trim();
    if (!record.requestId || !requoteId) return;
    const rawLogin = record.accountLogin > 0 ? record.accountLogin : (getAccountLogin?.() ?? 0);
    if (!Number.isSafeInteger(rawLogin) || rawLogin <= 0) return;

    try {
      await sendDealingRequoteDeclineWithTransport(transport, {
        accountLogin: rawLogin,
        side: record.wireSide,
        volume: record.volume,
        symbol: record.symbol,
        clientOrderId: record.clientOrderId,
        requestId: record.requestId,
        requoteId,
      });
    } catch {
      // Swept record is already transitioned to synthetic expiry; ignore transient transport errors.
    }
  };
}

/** Transmits pre-encoded 0x38 Action 9/10 frames over the persistent binary fast-lane. */
export const sendDealingRequoteFrame: RequoteDecisionTransport = (encodedFrame0x38, meta) =>
  createDealingRequoteFrameSender(getBinaryOrderRawFrameTransport())(encodedFrame0x38, meta);

/** Best-effort HTTP `keepalive` beacon sender strictly for `pagehide` / `beforeunload`. */
export const sendDealingRequoteFrameKeepalive: RequoteDecisionTransport = (encodedFrame0x38, meta) =>
  createDealingRequoteFrameSender(getBinaryOrderRawFrameTransport(), { keepalive: true })(
    encodedFrame0x38,
    meta,
  );

/** Sends a `0x38` Action `9` (Requote Accept) binary frame and updates `useDealingStore`. */
export function sendRequoteAccept(
  params: DealingRequoteAcceptParams,
): Promise<DecodedOrderRespWithExecWire> {
  return sendDealingRequoteAcceptWithTransport(getBinaryOrderRawFrameTransport(), params);
}

/** Sends a `0x38` Action `10` (Requote Decline) binary frame and updates `useDealingStore`. */
export function sendRequoteDecline(
  params: DealingRequoteDeclineParams,
): Promise<DecodedOrderRespWithExecWire> {
  return sendDealingRequoteDeclineWithTransport(getBinaryOrderRawFrameTransport(), params);
}

/** Creates the `registerDealingSweepDecline` callback transmitting Action `10` on expired requote sweeps. */
export function createDealingSweepDeclineTransport(
  getAccountLogin?: () => number | null | undefined,
): DealingSweepDeclineHandler {
  return createDealingSweepDeclineHandlerWithTransport(getBinaryOrderRawFrameTransport(), getAccountLogin);
}

/**
 * Encodes and transmits an Action 10 (`Decline`) `0x38` frame for a requoted record
 * during sweep expiry, stream disconnect, or page unload.
 */
export async function sendDealingAction10DeclineForRecord(
  record: DealingRequestRecord,
  getAccountLogin?: () => number | null | undefined,
  options?: {
    keepalive?: boolean;
    sendFrame?: RequoteDecisionTransport;
  },
): Promise<Uint8Array | ArrayBuffer | DecodedOrderRespWithExecWire | null> {
  if (!options?.sendFrame && !isDealingWireGateOpen()) {
    return null;
  }
  const requoteId = record.requote?.requoteId?.trim() ?? '';
  if (!requoteId) return null;

  const fallbackLogin = Number(getAccountLogin?.() ?? 0);
  const accountLogin =
    record.accountLogin > 0
      ? record.accountLogin
      : (Number.isSafeInteger(fallbackLogin) && fallbackLogin > 0 ? fallbackLogin : 0);
  if (!Number.isSafeInteger(accountLogin) || accountLogin <= 0) {
    return null;
  }

  const transport = getBinaryOrderRawFrameTransport();
  const authToken = transport.getAccessToken();
  const wireSide = record.wireSide === 1 || record.wireSide === 2 ? record.wireSide : 0;
  const frame0x38 = encodeRequoteActionFrame({
    action: WIRE_ACTION_REQUOTE_DECLINE,
    side: wireSide,
    flags: WIRE_FLAG_HAS_EXTRAS,
    accountLogin,
    ticket: 0,
    volume: record.volume,
    price: 0,
    expiration: 0,
    symbol: record.symbol,
    clientOrderId: record.clientOrderId,
    authToken,
    requestId: record.requestId,
    requoteId,
    clientCaps: CLIENT_CAP_DEALING_V1,
  });

  const meta: Parameters<RequoteDecisionTransport>[1] = {
    action: WIRE_ACTION_REQUOTE_DECLINE,
    requestId: record.requestId,
    requoteId,
    accountLogin,
    symbol: record.symbol,
    price: 0,
  };

  try {
    const sender = options?.sendFrame
      ?? (options?.keepalive ? sendDealingRequoteFrameKeepalive : sendDealingRequoteFrame);
    const reply = await sender(frame0x38, meta);
    if (reply instanceof Uint8Array || reply instanceof ArrayBuffer) {
      return reply.byteLength > 0 ? reply : null;
    }
    if (reply && typeof reply === 'object') {
      return reply;
    }
  } catch {
    // Background decline failures leave synthetic/0x3B reconciliation intact without crashing callers.
  }
  return null;
}
