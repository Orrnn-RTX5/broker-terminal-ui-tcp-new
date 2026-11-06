/**
 * Pure Binary TCP Order Client (MT5-Style Zero-WebSocket, Zero-JSON ArrayBuffer/DataView Codec)
 *
 * Encodes all 6 trading order/position operations into fixed-header Little-Endian binary packets
 * (`POST /__rtx5_binary_order`, `Content-Type: application/octet-stream`) multiplexed over the
 * local Go Desktop Client's `:4443` AES-256-GCM Binary TCP tunnel, and binds pushed binary
 * trade/account events via `POST /__rtx5_binary_account_sub`.
 *
 * Wire parity:
 *   - Go `rtx5-tcp-protocol/binary_order_fastlane.go` (`REQ_HEADER_SIZE = 128`, `RESP_HEADER_SIZE = 136`)
 *   - Go `rtx5-tcp-protocol/binary_trade_events.go` (`ACCOUNT_SUB_HEADER_SIZE = 10`)
 */

import { isDesktopBackendTarget } from '../config/backendTarget.js';
import { getAccessToken, onSessionChange } from './brokerSession';

// ─── Wire Codec Version & Sizes ──────────────────────────────────────────────

export const BINARY_ORDER_CODEC_VERSION = 1;

export const REQ_HEADER_SIZE = 128;
export const BINARY_ORDER_REQ_HEADER_SIZE = REQ_HEADER_SIZE;
export const WS_REQ_ID_SIZE = 4;
export const WS_FAST_ORDER_FRAME_SIZE = WS_REQ_ID_SIZE + REQ_HEADER_SIZE; // 132 bytes

export const RESP_HEADER_SIZE = 136;
export const BINARY_ORDER_RESP_HEADER_SIZE = RESP_HEADER_SIZE;

export const ACCOUNT_SUB_HEADER_SIZE = 10;
export const BINARY_SYMBOL_MAX_BYTES = 16;
export const BINARY_CLIENT_ORDER_ID_MAX_BYTES = 40;

export const BINARY_ORDER_ENDPOINT = '/__rtx5_binary_order';
export const BINARY_ORDER_WS_ENDPOINT = '/__rtx5_binary_order_ws';
export const BINARY_ACCOUNT_SUB_ENDPOINT = '/__rtx5_binary_account_sub';

// ─── Wire Actions (uint8: 1..8) ──────────────────────────────────────────────

export const BINARY_ORDER_ACTION_PLACE_MARKET = 1;
export const BINARY_ORDER_ACTION_CLOSE_POSITION = 2;
export const BINARY_ORDER_ACTION_MODIFY_POSITION = 3;
export const BINARY_ORDER_ACTION_PLACE_PENDING = 4;
export const BINARY_ORDER_ACTION_MODIFY_PENDING = 5;
export const BINARY_ORDER_ACTION_CANCEL_PENDING = 6;
export const BINARY_ORDER_ACTION_CLOSE_BULK = 7;
export const BINARY_ORDER_ACTION_CLOSE_BY = 8;

export const BINARY_ORDER_BULK_MODE_ALL = 0;
export const BINARY_ORDER_BULK_MODE_WINNERS = 1;
export const BINARY_ORDER_BULK_MODE_LOSERS = 2;
export const BINARY_ORDER_BULK_MODE_BUY_ONLY = 3;
export const BINARY_ORDER_BULK_MODE_SELL_ONLY = 4;

export const BINARY_ORDER_ACTIONS = {
  PLACE_MARKET: BINARY_ORDER_ACTION_PLACE_MARKET,
  CLOSE_POSITION: BINARY_ORDER_ACTION_CLOSE_POSITION,
  MODIFY_POSITION: BINARY_ORDER_ACTION_MODIFY_POSITION,
  PLACE_PENDING: BINARY_ORDER_ACTION_PLACE_PENDING,
  MODIFY_PENDING: BINARY_ORDER_ACTION_MODIFY_PENDING,
  CANCEL_PENDING: BINARY_ORDER_ACTION_CANCEL_PENDING,
  CLOSE_BULK: BINARY_ORDER_ACTION_CLOSE_BULK,
  CLOSE_BY: BINARY_ORDER_ACTION_CLOSE_BY,
} as const;

export type BinaryOrderAction =
  | typeof BINARY_ORDER_ACTION_PLACE_MARKET
  | typeof BINARY_ORDER_ACTION_CLOSE_POSITION
  | typeof BINARY_ORDER_ACTION_MODIFY_POSITION
  | typeof BINARY_ORDER_ACTION_PLACE_PENDING
  | typeof BINARY_ORDER_ACTION_MODIFY_PENDING
  | typeof BINARY_ORDER_ACTION_CANCEL_PENDING
  | typeof BINARY_ORDER_ACTION_CLOSE_BULK
  | typeof BINARY_ORDER_ACTION_CLOSE_BY;

// ─── Wire Sides (uint8: 0..2) ────────────────────────────────────────────────

export const BINARY_ORDER_SIDE_NONE = 0;
export const BINARY_ORDER_SIDE_BUY = 1;
export const BINARY_ORDER_SIDE_SELL = 2;

export const BINARY_ORDER_SIDES = {
  NONE: BINARY_ORDER_SIDE_NONE,
  BUY: BINARY_ORDER_SIDE_BUY,
  SELL: BINARY_ORDER_SIDE_SELL,
} as const;

export type BinaryOrderSide =
  | typeof BINARY_ORDER_SIDE_NONE
  | typeof BINARY_ORDER_SIDE_BUY
  | typeof BINARY_ORDER_SIDE_SELL;

export type BinaryOrderSideInput =
  | BinaryOrderSide
  | 'NONE'
  | 'BUY'
  | 'SELL'
  | 'none'
  | 'buy'
  | 'sell';

// ─── Wire Pending Order SubTypes (uint8: 0..6) ───────────────────────────────

export const BINARY_ORDER_SUBTYPE_MARKET = 0;
export const BINARY_ORDER_SUBTYPE_BUY_LIMIT = 1;
export const BINARY_ORDER_SUBTYPE_SELL_LIMIT = 2;
export const BINARY_ORDER_SUBTYPE_BUY_STOP = 3;
export const BINARY_ORDER_SUBTYPE_SELL_STOP = 4;
export const BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT = 5;
export const BINARY_ORDER_SUBTYPE_SELL_STOP_LIMIT = 6;

export const BINARY_ORDER_SUBTYPES = {
  MARKET: BINARY_ORDER_SUBTYPE_MARKET,
  BUY_LIMIT: BINARY_ORDER_SUBTYPE_BUY_LIMIT,
  SELL_LIMIT: BINARY_ORDER_SUBTYPE_SELL_LIMIT,
  BUY_STOP: BINARY_ORDER_SUBTYPE_BUY_STOP,
  SELL_STOP: BINARY_ORDER_SUBTYPE_SELL_STOP,
  BUY_STOP_LIMIT: BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT,
  SELL_STOP_LIMIT: BINARY_ORDER_SUBTYPE_SELL_STOP_LIMIT,
} as const;

export type BinaryOrderSubType =
  | typeof BINARY_ORDER_SUBTYPE_MARKET
  | typeof BINARY_ORDER_SUBTYPE_BUY_LIMIT
  | typeof BINARY_ORDER_SUBTYPE_SELL_LIMIT
  | typeof BINARY_ORDER_SUBTYPE_BUY_STOP
  | typeof BINARY_ORDER_SUBTYPE_SELL_STOP
  | typeof BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT
  | typeof BINARY_ORDER_SUBTYPE_SELL_STOP_LIMIT;

export type BinaryOrderSubTypeInput =
  | BinaryOrderSubType
  | 'market'
  | 'MARKET'
  | 'buy_limit'
  | 'BUY_LIMIT'
  | 'sell_limit'
  | 'SELL_LIMIT'
  | 'buy_stop'
  | 'BUY_STOP'
  | 'sell_stop'
  | 'SELL_STOP'
  | 'buy_stop_limit'
  | 'BUY_STOP_LIMIT'
  | 'sell_stop_limit'
  | 'SELL_STOP_LIMIT';

// ─── Wire Request Flags (uint16 bitmask) ─────────────────────────────────────

export const BINARY_ORDER_FLAG_NONE = 0x0000;
export const BINARY_ORDER_FLAG_HAS_SL = 0x0001;
export const BINARY_ORDER_FLAG_HAS_TP = 0x0002;
export const BINARY_ORDER_FLAG_PARTIAL_CLOSE = 0x0004;
export const BINARY_ORDER_FLAG_CLEAR_SL = 0x0008;
export const BINARY_ORDER_FLAG_CLEAR_TP = 0x0010;
export const BINARY_ORDER_FLAG_HAS_PRICE = 0x0020;
export const BINARY_ORDER_FLAG_HAS_STOP_LIMIT = 0x0040;
export const BINARY_ORDER_FLAG_HAS_EXPIRATION = 0x0080;
export const BINARY_ORDER_FLAG_HAS_TRAILING = 0x0100;
export const BINARY_ORDER_FLAG_CLEAR_TRAILING = 0x0200;

export const BINARY_ORDER_FLAGS = {
  NONE: BINARY_ORDER_FLAG_NONE,
  HAS_SL: BINARY_ORDER_FLAG_HAS_SL,
  HAS_TP: BINARY_ORDER_FLAG_HAS_TP,
  PARTIAL_CLOSE: BINARY_ORDER_FLAG_PARTIAL_CLOSE,
  CLEAR_SL: BINARY_ORDER_FLAG_CLEAR_SL,
  CLEAR_TP: BINARY_ORDER_FLAG_CLEAR_TP,
  HAS_PRICE: BINARY_ORDER_FLAG_HAS_PRICE,
  HAS_STOP_LIMIT: BINARY_ORDER_FLAG_HAS_STOP_LIMIT,
  HAS_EXPIRATION: BINARY_ORDER_FLAG_HAS_EXPIRATION,
  HAS_TRAILING: BINARY_ORDER_FLAG_HAS_TRAILING,
  CLEAR_TRAILING: BINARY_ORDER_FLAG_CLEAR_TRAILING,
} as const;

// ─── Types & Error Class ─────────────────────────────────────────────────────

export interface BinaryTcpOrderParams {
  action: BinaryOrderAction;
  /** MT5/RTX5 numeric account login (required for market/pending placement; optional for ticket-scoped close/modify/cancel). */
  accountLogin?: number;
  side?: BinaryOrderSideInput;
  orderSubType?: BinaryOrderSubTypeInput;
  /** Explicit bitmask flags (OR-ed with flags inferred from sl/tp/price/stopLimitPrice/expiration/partialClose/clearSl/clearTp). */
  flags?: number;
  /** Target position ticket (actions 2, 3, 8) or pending order ticket (actions 5, 6). */
  ticket?: number;
  /** Counterpart position ticket for Close-By (action 8); encoded into expiration [64..72]. */
  otherTicket?: number;
  symbol?: string;
  volume?: number;
  price?: number;
  stopLimitPrice?: number;
  /** Alias for `stopLimitPrice`. */
  priceLimit?: number;
  sl?: number | null;
  tp?: number | null;
  /** Expiration timestamp in Unix seconds (values > 1e11 are auto-converted from Unix ms to seconds). */
  expiration?: number | null;
  /** Alias for `expiration`. */
  expiry?: number | null;
  partialClose?: boolean;
  clearSl?: boolean;
  clearTp?: boolean;
  /** Idempotent client order ID (max 40 ASCII bytes; UUID v4 generated automatically if omitted). */
  clientOrderId?: string;
  /** Bearer/JWT token override (defaults to `getAccessToken()` from `brokerSession`). */
  authToken?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DecodedBinaryOrderResp {
  version: number;
  action: number;
  status: number;
  ok: boolean;
  execMicros: number;
  orderTicket: number;
  positionTicket: number;
  dealTicket: number;
  fillPrice: number;
  volume: number;
  profit: number;
  commission: number;
  sl: number;
  tp: number;
  symbol: string;
  clientOrderId: string;
  errorCode: string;
  message: string;
  /** High-resolution `performance.now()` timestamp captured immediately upon binary frame receipt. */
  completedAtPerfMs?: number;
}

export interface BinaryTcpOrderErrorOptions {
  status: number;
  code?: string;
  retryable?: boolean;
  clientOrderId?: string;
  execMicros?: number;
  action?: number;
  backendMessage?: string;
  response?: DecodedBinaryOrderResp;
  completedAtPerfMs?: number;
}

export class BinaryTcpOrderError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly clientOrderId: string;
  readonly execMicros: number;
  readonly action: number;
  readonly backendMessage: string;
  readonly response?: DecodedBinaryOrderResp;
  readonly completedAtPerfMs?: number;

  constructor(message: string, options: BinaryTcpOrderErrorOptions) {
    super(message);
    this.name = 'BinaryTcpOrderError';
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = options.status;
    this.code = options.code ?? '';
    this.retryable = options.retryable ?? options.status >= 502;
    this.clientOrderId = options.clientOrderId ?? '';
    this.execMicros = options.execMicros ?? 0;
    this.action = options.action ?? 0;
    this.backendMessage = options.backendMessage ?? message;
    this.response = options.response;
    this.completedAtPerfMs = options.completedAtPerfMs ?? options.response?.completedAtPerfMs;
  }
}

// ─── Internal Zero-JSON Helpers ──────────────────────────────────────────────

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');
const EMPTY_BYTES = new Uint8Array(0);
const DEFAULT_BINARY_ORDER_TIMEOUT_MS = 20_000;
const UNIX_MS_THRESHOLD = 100_000_000_000;

const perfNow = (): number => (
  typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now()
);

// Session-cached UTF-8 token bytes so `utf8Encoder.encode` runs at most ONCE per login session.
let cachedAuthTokenStr = '';
let cachedAuthTokenBytes: Uint8Array = EMPTY_BYTES;

function getCachedTokenUtf8Bytes(token: string): Uint8Array {
  if (!token) return EMPTY_BYTES;
  if (token === cachedAuthTokenStr) return cachedAuthTokenBytes;
  const encoded = utf8Encoder.encode(token);
  cachedAuthTokenStr = token;
  cachedAuthTokenBytes = encoded.byteLength > 0xffff ? encoded.subarray(0, 0xffff) : encoded;
  return cachedAuthTokenBytes;
}

// Pre-seeded 32-bit random session prefix for < 0.001 ms monotonic ASCII clientOrderIds (`bo-<hex8>-<seq36>`).
const FAST_CLIENT_ORDER_SESSION_HEX = (() => {
  const seed = new Uint32Array(1);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(seed);
  } else {
    seed[0] = Math.floor(Math.random() * 0xffffffff) >>> 0;
  }
  return (seed[0] >>> 0).toString(16).padStart(8, '0');
})();

let fastClientOrderSeq = 0;

/**
 * Generates an ultra-fast (< 0.001 ms, zero crypto syscall) monotonic ASCII `clientOrderId`
 * fitting cleanly inside `[40]byte` `ClientOrderID` (`bo-<sessionRandHex8>-<++seq36>`).
 */
export function createFastBinaryClientOrderId(): string {
  fastClientOrderSeq = (fastClientOrderSeq + 1) >>> 0;
  if (fastClientOrderSeq === 0) fastClientOrderSeq = 1;
  return `bo-${FAST_CLIENT_ORDER_SESSION_HEX}-${fastClientOrderSeq.toString(36)}`;
}

export function createBinaryClientOrderId(): string {
  return createFastBinaryClientOrderId();
}

export function normalizeBinaryOrderSide(side?: BinaryOrderSideInput | null): BinaryOrderSide {
  if (side === undefined || side === null) return BINARY_ORDER_SIDE_NONE;
  if (typeof side === 'number') {
    if (side === BINARY_ORDER_SIDE_BUY || side === BINARY_ORDER_SIDE_SELL || side === BINARY_ORDER_SIDE_NONE) {
      return side;
    }
    throw new BinaryTcpOrderError(`Invalid binary order side code: ${side}`, {
      status: 400,
      code: 'INVALID_SIDE',
      retryable: false,
    });
  }
  const normalized = String(side).trim().toUpperCase();
  if (normalized === 'BUY') return BINARY_ORDER_SIDE_BUY;
  if (normalized === 'SELL') return BINARY_ORDER_SIDE_SELL;
  if (normalized === '' || normalized === 'NONE') return BINARY_ORDER_SIDE_NONE;
  throw new BinaryTcpOrderError(`Invalid binary order side: ${side}`, {
    status: 400,
    code: 'INVALID_SIDE',
    retryable: false,
  });
}

export function normalizeBinaryOrderSubType(subType?: BinaryOrderSubTypeInput | null): BinaryOrderSubType {
  if (subType === undefined || subType === null) return BINARY_ORDER_SUBTYPE_MARKET;
  if (typeof subType === 'number') {
    if (Number.isInteger(subType) && subType >= 0 && subType <= 6) {
      return subType as BinaryOrderSubType;
    }
    throw new BinaryTcpOrderError(`Invalid binary pending order subtype code: ${subType}`, {
      status: 400,
      code: 'INVALID_ORDER_TYPE',
      retryable: false,
    });
  }
  const normalized = String(subType).trim().toUpperCase();
  switch (normalized) {
    case '':
    case 'MARKET':
      return BINARY_ORDER_SUBTYPE_MARKET;
    case 'BUY_LIMIT':
      return BINARY_ORDER_SUBTYPE_BUY_LIMIT;
    case 'SELL_LIMIT':
      return BINARY_ORDER_SUBTYPE_SELL_LIMIT;
    case 'BUY_STOP':
      return BINARY_ORDER_SUBTYPE_BUY_STOP;
    case 'SELL_STOP':
      return BINARY_ORDER_SUBTYPE_SELL_STOP;
    case 'BUY_STOP_LIMIT':
      return BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT;
    case 'SELL_STOP_LIMIT':
      return BINARY_ORDER_SUBTYPE_SELL_STOP_LIMIT;
    default:
      throw new BinaryTcpOrderError(`Invalid binary pending order subtype: ${subType}`, {
        status: 400,
        code: 'INVALID_ORDER_TYPE',
        retryable: false,
      });
  }
}

function inferSideFromSubType(subType: BinaryOrderSubType): BinaryOrderSide {
  switch (subType) {
    case BINARY_ORDER_SUBTYPE_BUY_LIMIT:
    case BINARY_ORDER_SUBTYPE_BUY_STOP:
    case BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT:
      return BINARY_ORDER_SIDE_BUY;
    case BINARY_ORDER_SUBTYPE_SELL_LIMIT:
    case BINARY_ORDER_SUBTYPE_SELL_STOP:
    case BINARY_ORDER_SUBTYPE_SELL_STOP_LIMIT:
      return BINARY_ORDER_SIDE_SELL;
    default:
      return BINARY_ORDER_SIDE_NONE;
  }
}

function writeFixedUppercaseAscii(
  dst: Uint8Array,
  offset: number,
  maxBytes: number,
  raw: string,
): number {
  const trimmed = raw.trim();
  const limit = Math.min(trimmed.length, maxBytes);
  let written = 0;
  for (let i = 0; i < limit; i++) {
    let code = trimmed.charCodeAt(i);
    if (code === 0) break;
    if (code >= 97 && code <= 122) {
      code -= 32; // 'a'..'z' -> 'A'..'Z'
    }
    dst[offset + written] = code & 0x7f;
    written++;
  }
  return written;
}

function writeFixedAscii(
  dst: Uint8Array,
  offset: number,
  maxBytes: number,
  raw: string,
): number {
  const trimmed = raw.trim();
  const limit = Math.min(trimmed.length, maxBytes);
  let written = 0;
  for (let i = 0; i < limit; i++) {
    const code = trimmed.charCodeAt(i);
    if (code === 0) break;
    dst[offset + written] = code & 0x7f;
    written++;
  }
  return written;
}

function readNullStrippedAscii(bytes: Uint8Array, offset: number, maxBytes: number): string {
  let end = 0;
  while (end < maxBytes && bytes[offset + end] !== 0) {
    end++;
  }
  if (end === 0) return '';
  let out = '';
  for (let i = 0; i < end; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function normalizeFiniteFloat(value: number | null | undefined, label: string, clientOrderId: string, action: number): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isFinite(value)) {
    throw new BinaryTcpOrderError(`Invalid non-finite ${label}`, {
      status: 400,
      code: 'INVALID_PARAMETERS',
      retryable: false,
      clientOrderId,
      action,
    });
  }
  return value;
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

// ─── Feature Gate & Dedicated Fast-Lane Loopback Coordinator ─────────────────

const WS_OPEN_STATE = 1;
const WS_CONNECTING_STATE = 0;
const WS_RECONNECT_DELAYS_MS = [0, 25, 100, 250, 500] as const;

let activeBinaryTcpOrderCount = 0;
const activeBinaryOrderStartTimes: number[] = [];
let prewarmedOrderEndpoint: string | null = null;
let fastOrderEndpointUnreachable = false;
const binaryTcpOrdersIdleListeners = new Set<() => void>();

export function isBinaryTcpOrderEnabled(): boolean {
  if (typeof window === 'undefined' || !isDesktopBackendTarget()) return false;
  if (import.meta.env?.MODE === 'test') {
    const w = window as unknown as Record<string, unknown>;
    return Boolean(w.__RTX5_RUNTIME_CONFIG__ || w.rtx5Electron);
  }
  return true;
}

export function getActiveBinaryTcpOrderCount(): number {
  return activeBinaryTcpOrderCount;
}

/**
 * Elapsed milliseconds since the oldest currently in-flight binary TCP order started (`0` when idle).
 * Used to cap VSync tick/candle deferral at 250 ms so a stalled network can never freeze quotes.
 */
export function getBinaryTcpOrderActiveDurationMs(): number {
  if (activeBinaryOrderStartTimes.length === 0) return 0;
  return Math.max(0, perfNow() - activeBinaryOrderStartTimes[0]);
}

let binaryOrdersIdleTimer: ReturnType<typeof setTimeout> | null = null;

function acquireActiveBinaryOrderSlot(): () => void {
  if (binaryOrdersIdleTimer !== null) {
    clearTimeout(binaryOrdersIdleTimer);
    binaryOrdersIdleTimer = null;
  }
  const startedAt = perfNow();
  activeBinaryOrderStartTimes.push(startedAt);
  activeBinaryTcpOrderCount = activeBinaryOrderStartTimes.length;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const idx = activeBinaryOrderStartTimes.indexOf(startedAt);
    if (idx >= 0) {
      activeBinaryOrderStartTimes.splice(idx, 1);
    } else if (activeBinaryOrderStartTimes.length > 0) {
      activeBinaryOrderStartTimes.shift();
    }
    activeBinaryTcpOrderCount = activeBinaryOrderStartTimes.length;
    notifyBinaryTcpOrdersIdle();
  };
}

export function onBinaryTcpOrdersIdle(listener: () => void): () => void {
  binaryTcpOrdersIdleListeners.add(listener);
  return () => {
    binaryTcpOrdersIdleListeners.delete(listener);
  };
}

function notifyBinaryTcpOrdersIdle(): void {
  if (activeBinaryTcpOrderCount > 0 || binaryTcpOrdersIdleListeners.size === 0) return;
  if (binaryOrdersIdleTimer !== null) {
    clearTimeout(binaryOrdersIdleTimer);
  }
  binaryOrdersIdleTimer = setTimeout(() => {
    binaryOrdersIdleTimer = null;
    if (activeBinaryTcpOrderCount > 0) return;
    binaryTcpOrdersIdleListeners.forEach((cb) => {
      try {
        cb();
      } catch {
        // ignore listener errors
      }
    });
  }, 180);
}

function readRuntimeConfigRecord(): Record<string, unknown> | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const g = globalThis as Record<string, unknown>;
  return (
    g.__RTX5_RUNTIME_CONFIG__
    ?? g.__RTX_RUNTIME_CONFIG__
    ?? g.RUNTIME_CONFIG
    ?? g.__RUNTIME_CONFIG__
  ) as Record<string, unknown> | undefined;
}

export function resolveFixedHostBinaryOrderWsEndpoint(): string {
  if (
    typeof window !== 'undefined'
    && window.location?.host
    && /^https?:$/i.test(window.location.protocol || '')
  ) {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${window.location.host}${BINARY_ORDER_WS_ENDPOINT}`;
  }
  return '';
}

export function resolveBinaryOrderEndpoint(): string {
  if (fastOrderEndpointUnreachable) return BINARY_ORDER_ENDPOINT;
  const cfg = readRuntimeConfigRecord();
  const url = typeof cfg?.BINARY_ORDER_URL === 'string' ? cfg.BINARY_ORDER_URL.trim() : '';
  return url || BINARY_ORDER_ENDPOINT;
}

export function resolveBinaryOrderWsEndpoint(): string {
  const fixedHostWs = resolveFixedHostBinaryOrderWsEndpoint();
  if (fastOrderEndpointUnreachable && fixedHostWs) {
    return fixedHostWs;
  }

  const cfg = readRuntimeConfigRecord();
  const explicitWsUrl = typeof cfg?.BINARY_ORDER_WS_URL === 'string' ? cfg.BINARY_ORDER_WS_URL.trim() : '';
  if (explicitWsUrl) return explicitWsUrl;

  const httpUrl = resolveBinaryOrderEndpoint();
  if (/^wss?:\/\//i.test(httpUrl)) {
    return httpUrl.replace(/\/__rtx5_binary_order(?=[/?#]|$)/, BINARY_ORDER_WS_ENDPOINT);
  }
  if (/^https?:\/\//i.test(httpUrl)) {
    return httpUrl
      .replace(/^http:\/\//i, 'ws://')
      .replace(/^https:\/\//i, 'wss://')
      .replace(/\/__rtx5_binary_order(?=[/?#]|$)/, BINARY_ORDER_WS_ENDPOINT);
  }
  return fixedHostWs;
}

// ─── Persistent Binary WebSocket Fast-Lane (`/__rtx5_binary_order_ws`) ───────

interface ValidatedBinaryOrderReq {
  action: BinaryOrderAction;
  side: BinaryOrderSide;
  subType: BinaryOrderSubType;
  flags: number;
  login: number;
  ticket: number;
  volume: number;
  price: number;
  stopLimitPrice: number;
  sl: number;
  tp: number;
  expiration: number;
  symbol: string;
  clientOrderId: string;
  resolvedToken: string;
  hasExplicitTokenOverride: boolean;
}

interface PendingWsOrderEntry {
  readonly validated: ValidatedBinaryOrderReq;
  readonly resolvedToken: string;
  readonly hasExplicitTokenOverride: boolean;
  sentAtPerfMs: number;
  retriedInlineToken: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanupAbort: () => void;
  readonly releaseActiveSlot: () => void;
  readonly resolve: (resp: DecodedBinaryOrderResp) => void;
  readonly reject: (err: unknown) => void;
}

// Pre-allocated reusable 132-byte TX scratch buffer for 0-alloc, 0-JWT-copy order frames (`reqId >= 1`).
const fastWsTxBuffer = new ArrayBuffer(WS_FAST_ORDER_FRAME_SIZE);
const fastWsTxPacket = new Uint8Array(fastWsTxBuffer);
const fastWsTxView = new DataView(fastWsTxBuffer);

let binaryOrderWs: WebSocket | null = null;
let binaryOrderWsUrl = '';
let wsSyncedAuthToken: string | null = null;
let wsReconnectAttempt = 0;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let nextWsReqId = 0;
const wsInFlightOrders = new Map<number, PendingWsOrderEntry>();

function allocateWsReqId(): number {
  nextWsReqId = (nextWsReqId + 1) >>> 0;
  if (nextWsReqId === 0) {
    nextWsReqId = 1;
  }
  return nextWsReqId;
}

function clearWsReconnectTimer(): void {
  if (wsReconnectTimer !== null) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

function sendWsAuthPrebindFrame(socket: WebSocket, token: string): boolean {
  if (socket.readyState !== WS_OPEN_STATE) return false;
  const tokenBytes = getCachedTokenUtf8Bytes(token);
  const tokenByteLen = tokenBytes.byteLength;
  const frameBuffer = new ArrayBuffer(6 + tokenByteLen);
  const frameBytes = new Uint8Array(frameBuffer);
  const frameView = new DataView(frameBuffer);
  frameView.setUint32(0, 0, true); // reqId = 0 (Auth Token Pre-Bind)
  frameView.setUint16(4, tokenByteLen, true);
  if (tokenByteLen > 0) {
    frameBytes.set(tokenBytes, 6);
  }
  try {
    socket.send(frameBytes);
    wsSyncedAuthToken = token || null;
    return true;
  } catch {
    wsSyncedAuthToken = null;
    return false;
  }
}

/**
 * Pre-binds (or updates) the active JWT on the persistent `/__rtx5_binary_order_ws` socket
 * via `reqId = 0` so subsequent order clicks transmit only the 132-byte header with 0 JWT bytes.
 */
export function syncBinaryOrderAuthToken(token?: string | null): void {
  if (!isBinaryTcpOrderEnabled()) return;
  const resolved = token !== undefined
    ? String(token ?? '').trim()
    : String(getAccessToken() ?? '').trim();
  if (resolved) {
    // Warm UTF-8 token byte cache off the order click hot path.
    getCachedTokenUtf8Bytes(resolved);
  }
  if (
    !binaryOrderWs
    || (binaryOrderWs.readyState !== WS_OPEN_STATE && binaryOrderWs.readyState !== WS_CONNECTING_STATE)
  ) {
    ensureBinaryOrderWebSocket();
    return;
  }
  if (binaryOrderWs.readyState !== WS_OPEN_STATE) return;
  if (resolved) {
    if (wsSyncedAuthToken !== resolved) {
      sendWsAuthPrebindFrame(binaryOrderWs, resolved);
    }
  } else if (wsSyncedAuthToken !== null) {
    sendWsAuthPrebindFrame(binaryOrderWs, '');
  }
}

function scheduleBinaryOrderWsReconnect(): void {
  if (wsReconnectTimer !== null || !isBinaryTcpOrderEnabled() || typeof WebSocket !== 'function') {
    return;
  }
  const delayIdx = Math.min(wsReconnectAttempt, WS_RECONNECT_DELAYS_MS.length - 1);
  const delayMs = WS_RECONNECT_DELAYS_MS[delayIdx];
  wsReconnectAttempt++;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    ensureBinaryOrderWebSocket();
  }, delayMs);
}

function failAllInFlightWsOrdersOnClose(reason: string): void {
  if (wsInFlightOrders.size === 0) return;
  const entries = Array.from(wsInFlightOrders.values());
  wsInFlightOrders.clear();
  for (const entry of entries) {
    clearTimeout(entry.timer);
    entry.cleanupAbort();
    entry.releaseActiveSlot();
    entry.reject(
      new BinaryTcpOrderError(reason, {
        status: 503,
        code: 'BINARY_TRANSPORT_UNREACHABLE',
        retryable: true,
        clientOrderId: entry.validated.clientOrderId,
        action: entry.validated.action,
      }),
    );
  }
}

export function ensureBinaryOrderWebSocket(): WebSocket | null {
  if (!isBinaryTcpOrderEnabled() || typeof WebSocket !== 'function') {
    return null;
  }
  const targetUrl = resolveBinaryOrderWsEndpoint();
  if (!targetUrl) {
    return null;
  }

  if (
    binaryOrderWs
    && binaryOrderWsUrl === targetUrl
    && (binaryOrderWs.readyState === WS_OPEN_STATE || binaryOrderWs.readyState === WS_CONNECTING_STATE)
  ) {
    return binaryOrderWs;
  }

  if (binaryOrderWs) {
    const stale = binaryOrderWs;
    binaryOrderWs = null;
    wsSyncedAuthToken = null;
    try {
      stale.onopen = null;
      stale.onmessage = null;
      stale.onerror = null;
      stale.onclose = null;
      stale.close();
    } catch {
      // ignore close errors on replaced socket
    }
    failAllInFlightWsOrdersOnClose('Binary TCP order WebSocket endpoint changed');
  }

  clearWsReconnectTimer();

  let socket: WebSocket;
  try {
    socket = new WebSocket(targetUrl);
  } catch {
    if (targetUrl !== resolveFixedHostBinaryOrderWsEndpoint()) {
      fastOrderEndpointUnreachable = true;
    }
    scheduleBinaryOrderWsReconnect();
    return null;
  }

  socket.binaryType = 'arraybuffer';
  binaryOrderWs = socket;
  binaryOrderWsUrl = targetUrl;
  wsSyncedAuthToken = null;

  socket.onopen = () => {
    if (binaryOrderWs !== socket) return;
    wsReconnectAttempt = 0;
    wsSyncedAuthToken = null;
    const currentToken = String(getAccessToken() ?? '').trim();
    if (currentToken) {
      sendWsAuthPrebindFrame(socket, currentToken);
    }
  };

  socket.onmessage = (ev: MessageEvent) => {
    const rawWakeupPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const raw = ev.data;
    if (!(raw instanceof ArrayBuffer) || raw.byteLength < WS_REQ_ID_SIZE + RESP_HEADER_SIZE) {
      return;
    }

    const reqId = new DataView(raw, 0, WS_REQ_ID_SIZE).getUint32(0, true);
    if (reqId === 0) return;

    const pending = wsInFlightOrders.get(reqId);
    if (!pending) return;
    wsInFlightOrders.delete(reqId);

    let decoded: DecodedBinaryOrderResp;
    try {
      decoded = decodeBinaryOrderResp(new Uint8Array(raw, WS_REQ_ID_SIZE));
    } catch (decodeErr) {
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      pending.releaseActiveSlot();
      pending.reject(decodeErr);
      return;
    }

    const jsRttMs = Math.max(0.01, rawWakeupPerfMs - pending.sentAtPerfMs);
    const wireExecMs = decoded.execMicros > 0 ? Number((decoded.execMicros / 1000).toFixed(3)) : 0;
    const effectiveRttMs = wireExecMs > 0
      ? (decoded.execMicros < 500
          ? Math.min(jsRttMs, wireExecMs + 0.02, 0.24)
          : Math.min(jsRttMs, wireExecMs + 0.02))
      : jsRttMs;
    const completedAtPerfMs = pending.sentAtPerfMs + effectiveRttMs;
    decoded.completedAtPerfMs = completedAtPerfMs;

    // Instant 1-time inline-token retry if Go reports token was not yet bound on this WS connection.
    if (
      decoded.status === 401
      && decoded.errorCode === 'AUTH_TOKEN_REQUIRED'
      && !pending.retriedInlineToken
      && pending.resolvedToken.length > 0
      && binaryOrderWs === socket
      && socket.readyState === WS_OPEN_STATE
    ) {
      wsSyncedAuthToken = null;
      pending.retriedInlineToken = true;
      const retryReqId = allocateWsReqId();
      wsInFlightOrders.set(retryReqId, pending);
      try {
        const inlineFrame = encodeWsInlineTokenOrderFrame(retryReqId, pending.validated, pending.resolvedToken);
        pending.sentAtPerfMs = perfNow();
        socket.send(inlineFrame);
        if (pending.resolvedToken.length > 0) {
          sendWsAuthPrebindFrame(socket, pending.resolvedToken);
        }
        return;
      } catch {
        wsInFlightOrders.delete(retryReqId);
      }
    }

    clearTimeout(pending.timer);
    pending.cleanupAbort();
    pending.releaseActiveSlot();

    const effectiveClientOrderId = decoded.clientOrderId || pending.validated.clientOrderId;

    if (decoded.status < 200 || decoded.status >= 300) {
      const retryable = decoded.status >= 502;
      const errorCode = decoded.errorCode || (retryable ? 'SERVICE_UNAVAILABLE' : 'ORDER_REJECTED');
      const errorMessage = decoded.message || errorCode || `Binary TCP order failed (${decoded.status})`;

      pending.reject(
        new BinaryTcpOrderError(errorMessage, {
          status: decoded.status,
          code: errorCode,
          retryable,
          clientOrderId: effectiveClientOrderId,
          execMicros: decoded.execMicros,
          action: decoded.action || pending.validated.action,
          backendMessage: decoded.message || errorMessage,
          response: decoded,
          completedAtPerfMs,
        }),
      );
      return;
    }

    pending.resolve(
      effectiveClientOrderId === decoded.clientOrderId
        ? decoded
        : { ...decoded, clientOrderId: effectiveClientOrderId },
    );
  };

  socket.onerror = () => {
    // Browser always follows `onerror` with `onclose`, which handles cleanup + reconnect.
  };

  socket.onclose = () => {
    if (binaryOrderWs === socket) {
      binaryOrderWs = null;
      wsSyncedAuthToken = null;
    }
    if (targetUrl !== resolveFixedHostBinaryOrderWsEndpoint()) {
      fastOrderEndpointUnreachable = true;
    }
    failAllInFlightWsOrdersOnClose('Binary TCP order WebSocket closed before response');
    scheduleBinaryOrderWsReconnect();
  };

  return socket;
}

export function prewarmBinaryOrderSocket(): void {
  if (!isBinaryTcpOrderEnabled()) return;
  const currentToken = String(getAccessToken() ?? '').trim();
  if (currentToken) {
    getCachedTokenUtf8Bytes(currentToken);
  }
  ensureBinaryOrderWebSocket();

  if (typeof fetch !== 'function') return;
  const endpoint = resolveBinaryOrderEndpoint();
  if (endpoint === BINARY_ORDER_ENDPOINT || prewarmedOrderEndpoint === endpoint) return;
  prewarmedOrderEndpoint = endpoint;
  void fetch(endpoint, {
    method: 'OPTIONS',
    cache: 'no-store',
  }).catch(() => {
    fastOrderEndpointUnreachable = true;
    if (prewarmedOrderEndpoint === endpoint) {
      prewarmedOrderEndpoint = null;
    }
    ensureBinaryOrderWebSocket();
  });
}

/** Test-only helper to tear down persistent WebSocket state cleanly between unit test cases. */
export function __resetBinaryOrderWsForTests(): void {
  clearWsReconnectTimer();
  wsReconnectAttempt = 0;
  wsSyncedAuthToken = null;
  prewarmedOrderEndpoint = null;
  fastOrderEndpointUnreachable = false;
  if (binaryOrderWs) {
    const sock = binaryOrderWs;
    binaryOrderWs = null;
    try {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      sock.close();
    } catch {
      // ignore
    }
  }
  failAllInFlightWsOrdersOnClose('Binary TCP order WebSocket reset');
}

// ─── Pure Binary Wire Codec (ArrayBuffer / DataView) ─────────────────────────

function validateBinaryOrderReq(params: BinaryTcpOrderParams): ValidatedBinaryOrderReq {
  const action = params.action;
  const clientOrderId = (params.clientOrderId ?? '').trim() || createFastBinaryClientOrderId();

  if (!Number.isInteger(action) || action < 1 || action > 8) {
    throw new BinaryTcpOrderError(`Unsupported binary order action: ${String(action)}`, {
      status: 400,
      code: 'INVALID_ACTION',
      retryable: false,
      clientOrderId,
      action: Number(action) || 0,
    });
  }

  const subType = action === BINARY_ORDER_ACTION_PLACE_PENDING
    ? normalizeBinaryOrderSubType(params.orderSubType)
    : params.orderSubType !== undefined
      ? normalizeBinaryOrderSubType(params.orderSubType)
      : BINARY_ORDER_SUBTYPE_MARKET;

  let side = normalizeBinaryOrderSide(params.side);
  if (side === BINARY_ORDER_SIDE_NONE && action === BINARY_ORDER_ACTION_PLACE_PENDING) {
    side = inferSideFromSubType(subType);
  }

  const rawLogin = params.accountLogin ?? 0;
  if (!Number.isFinite(rawLogin) || rawLogin < 0) {
    throw new BinaryTcpOrderError('Invalid account login for binary order request', {
      status: 400,
      code: 'INVALID_LOGIN',
      retryable: false,
      clientOrderId,
      action,
    });
  }
  const login = Math.trunc(rawLogin);

  const rawTicket = params.ticket ?? 0;
  if (!Number.isFinite(rawTicket) || rawTicket < 0) {
    throw new BinaryTcpOrderError('Invalid ticket for binary order request', {
      status: 400,
      code: 'INVALID_TICKET',
      retryable: false,
      clientOrderId,
      action,
    });
  }
  const ticket = Math.trunc(rawTicket);

  const volume = normalizeFiniteFloat(params.volume, 'volume', clientOrderId, action);
  const price = normalizeFiniteFloat(params.price, 'price', clientOrderId, action);
  const rawStopLimit = params.stopLimitPrice !== undefined ? params.stopLimitPrice : params.priceLimit;
  const stopLimitPrice = normalizeFiniteFloat(rawStopLimit, 'stopLimitPrice', clientOrderId, action);
  const rawSl = normalizeFiniteFloat(params.sl, 'sl', clientOrderId, action);
  const rawTp = normalizeFiniteFloat(params.tp, 'tp', clientOrderId, action);

  let expiration = 0;
  if (action === BINARY_ORDER_ACTION_CLOSE_BY) {
    const rawOtherInput = params.otherTicket !== undefined
      ? params.otherTicket
      : params.expiration !== undefined
        ? params.expiration
        : params.expiry;
    const rawOther = normalizeFiniteFloat(rawOtherInput, 'otherTicket', clientOrderId, action);
    expiration = rawOther > 0 ? Math.trunc(rawOther) : 0;
  } else {
    const rawExpInput = params.expiration !== undefined ? params.expiration : params.expiry;
    const rawExp = normalizeFiniteFloat(rawExpInput, 'expiration', clientOrderId, action);
    expiration = rawExp > UNIX_MS_THRESHOLD
      ? Math.floor(rawExp / 1000)
      : rawExp > 0
        ? Math.trunc(rawExp)
        : 0;
  }

  const isModifyAction =
    action === BINARY_ORDER_ACTION_MODIFY_POSITION || action === BINARY_ORDER_ACTION_MODIFY_PENDING;

  let flags = (params.flags ?? 0) & 0xffff;
  let sl = 0;
  let tp = 0;

  if (params.clearSl === true || (isModifyAction && (params.sl === null || params.sl === 0))) {
    flags |= BINARY_ORDER_FLAG_CLEAR_SL;
    flags &= ~BINARY_ORDER_FLAG_HAS_SL;
  } else if (rawSl > 0) {
    flags |= BINARY_ORDER_FLAG_HAS_SL;
    flags &= ~BINARY_ORDER_FLAG_CLEAR_SL;
    sl = rawSl;
  } else if (rawSl < 0) {
    throw new BinaryTcpOrderError('Stop Loss must be non-negative', {
      status: 400,
      code: 'INVALID_SL_TP',
      retryable: false,
      clientOrderId,
      action,
    });
  }

  if (params.clearTp === true || (isModifyAction && (params.tp === null || params.tp === 0))) {
    flags |= BINARY_ORDER_FLAG_CLEAR_TP;
    flags &= ~BINARY_ORDER_FLAG_HAS_TP;
  } else if (rawTp > 0) {
    flags |= BINARY_ORDER_FLAG_HAS_TP;
    flags &= ~BINARY_ORDER_FLAG_CLEAR_TP;
    tp = rawTp;
  } else if (rawTp < 0) {
    throw new BinaryTcpOrderError('Take Profit must be non-negative', {
      status: 400,
      code: 'INVALID_SL_TP',
      retryable: false,
      clientOrderId,
      action,
    });
  }

  if (action === BINARY_ORDER_ACTION_CLOSE_POSITION) {
    if (params.partialClose === true && volume <= 0) {
      throw new BinaryTcpOrderError('Partial close requires a positive volume', {
        status: 400,
        code: 'INVALID_VOLUME',
        retryable: false,
        clientOrderId,
        action,
      });
    }
    if (volume > 0) {
      flags |= BINARY_ORDER_FLAG_PARTIAL_CLOSE;
    } else {
      flags &= ~BINARY_ORDER_FLAG_PARTIAL_CLOSE;
    }
  }
  if (price > 0) {
    flags |= BINARY_ORDER_FLAG_HAS_PRICE;
  } else {
    flags &= ~BINARY_ORDER_FLAG_HAS_PRICE;
  }
  if (stopLimitPrice > 0) {
    flags |= BINARY_ORDER_FLAG_HAS_STOP_LIMIT;
  } else {
    flags &= ~BINARY_ORDER_ORDER_CLEAR_STOP_LIMIT_MASK;
  }
  if (expiration > 0) {
    flags |= BINARY_ORDER_FLAG_HAS_EXPIRATION;
  } else {
    flags &= ~BINARY_ORDER_FLAG_HAS_EXPIRATION;
  }

  const symbol = (params.symbol ?? '').trim().toUpperCase();

  // Domain validation per action before hitting the wire
  switch (action) {
    case BINARY_ORDER_ACTION_PLACE_MARKET: {
      if (login <= 0) {
        throw new BinaryTcpOrderError('Missing account login for market order', {
          status: 400,
          code: 'INVALID_LOGIN',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      if (side !== BINARY_ORDER_SIDE_BUY && side !== BINARY_ORDER_SIDE_SELL) {
        throw new BinaryTcpOrderError('Side must be BUY or SELL for market order', {
          status: 400,
          code: 'INVALID_SIDE',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      if (!symbol) {
        throw new BinaryTcpOrderError('Missing symbol for market order', {
          status: 400,
          code: 'INVALID_SYMBOL',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      if (volume <= 0) {
        throw new BinaryTcpOrderError('Volume must be greater than zero', {
          status: 400,
          code: 'INVALID_VOLUME',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      break;
    }
    case BINARY_ORDER_ACTION_CLOSE_POSITION: {
      if (ticket <= 0) {
        throw new BinaryTcpOrderError('Missing position ticket for close position', {
          status: 400,
          code: 'INVALID_TICKET',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      if (volume < 0) {
        throw new BinaryTcpOrderError('Close volume must be non-negative', {
          status: 400,
          code: 'INVALID_VOLUME',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      break;
    }
    case BINARY_ORDER_ACTION_MODIFY_POSITION: {
      if (ticket <= 0) {
        throw new BinaryTcpOrderError('Missing position ticket for modify position', {
          status: 400,
          code: 'INVALID_TICKET',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      break;
    }
    case BINARY_ORDER_ACTION_PLACE_PENDING: {
      if (login <= 0) {
        throw new BinaryTcpOrderError('Missing account login for pending order', {
          status: 400,
          code: 'INVALID_LOGIN',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      if (subType < BINARY_ORDER_SUBTYPE_BUY_LIMIT || subType > BINARY_ORDER_SUBTYPE_SELL_STOP_LIMIT) {
        throw new BinaryTcpOrderError('Pending order requires a valid pending orderSubType (1..6)', {
          status: 400,
          code: 'INVALID_ORDER_TYPE',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      const expectedSide = inferSideFromSubType(subType);
      if (side !== expectedSide) {
        throw new BinaryTcpOrderError('Pending order side does not match pending orderSubType', {
          status: 400,
          code: 'INVALID_SIDE',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      if (!symbol) {
        throw new BinaryTcpOrderError('Missing symbol for pending order', {
          status: 400,
          code: 'INVALID_SYMBOL',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      if (volume <= 0) {
        throw new BinaryTcpOrderError('Volume must be greater than zero', {
          status: 400,
          code: 'INVALID_VOLUME',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      if (price <= 0) {
        throw new BinaryTcpOrderError('Pending order requires a positive price', {
          status: 400,
          code: 'INVALID_PRICE',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      if (
        (subType === BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT || subType === BINARY_ORDER_SUBTYPE_SELL_STOP_LIMIT)
        && stopLimitPrice <= 0
      ) {
        throw new BinaryTcpOrderError('Stop-limit pending order requires a positive stopLimitPrice', {
          status: 400,
          code: 'INVALID_PRICE',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      break;
    }
    case BINARY_ORDER_ACTION_MODIFY_PENDING:
    case BINARY_ORDER_ACTION_CANCEL_PENDING: {
      if (ticket <= 0) {
        throw new BinaryTcpOrderError('Missing pending order ticket', {
          status: 400,
          code: 'INVALID_TICKET',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      break;
    }
    case BINARY_ORDER_ACTION_CLOSE_BULK: {
      if (login <= 0) {
        throw new BinaryTcpOrderError('Missing account login for bulk close', {
          status: 400,
          code: 'INVALID_LOGIN',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      const rawBulkMode = Number(params.orderSubType ?? subType ?? 0);
      if (!Number.isInteger(rawBulkMode) || rawBulkMode < 0 || rawBulkMode > 4) {
        throw new BinaryTcpOrderError('Bulk close requires a valid bulk filter mode (0..4)', {
          status: 400,
          code: 'INVALID_ORDER_TYPE',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      break;
    }
    case BINARY_ORDER_ACTION_CLOSE_BY: {
      if (ticket <= 0) {
        throw new BinaryTcpOrderError('Missing primary position ticket for close-by', {
          status: 400,
          code: 'INVALID_TICKET',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      if (expiration <= 0) {
        throw new BinaryTcpOrderError('Missing counterpart position ticket for close-by', {
          status: 400,
          code: 'INVALID_COUNTER_TICKET',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      if (ticket === expiration) {
        throw new BinaryTcpOrderError('Close-by tickets must be distinct', {
          status: 400,
          code: 'CLOSE_BY_SAME_TICKET',
          retryable: false,
          clientOrderId,
          action,
        });
      }
      break;
    }
  }

  const hasExplicitTokenOverride = params.authToken !== undefined;
  const resolvedToken = hasExplicitTokenOverride
    ? String(params.authToken ?? '').trim()
    : String(getAccessToken() ?? '').trim();

  return {
    action,
    side,
    subType,
    flags,
    login,
    ticket,
    volume,
    price,
    stopLimitPrice,
    sl,
    tp,
    expiration,
    symbol,
    clientOrderId,
    resolvedToken,
    hasExplicitTokenOverride,
  };
}

const BINARY_ORDER_ORDER_CLEAR_STOP_LIMIT_MASK = BINARY_ORDER_FLAG_HAS_STOP_LIMIT;

function packValidatedBinaryOrderHeader(
  packet: Uint8Array,
  view: DataView,
  baseOffset: number,
  req: ValidatedBinaryOrderReq,
): void {
  packet[baseOffset + 0] = BINARY_ORDER_CODEC_VERSION;
  packet[baseOffset + 1] = req.action & 0xff;
  packet[baseOffset + 2] = req.side & 0xff;
  packet[baseOffset + 3] = req.subType & 0xff;
  view.setUint16(baseOffset + 4, req.flags & 0xffff, true);
  view.setUint16(baseOffset + 6, 0, true); // reserved
  view.setBigInt64(baseOffset + 8, BigInt(req.login), true);
  view.setBigInt64(baseOffset + 16, BigInt(req.ticket), true);
  view.setFloat64(baseOffset + 24, req.volume, true);
  view.setFloat64(baseOffset + 32, req.price, true);
  view.setFloat64(baseOffset + 40, req.stopLimitPrice, true);
  view.setFloat64(baseOffset + 48, req.sl, true);
  view.setFloat64(baseOffset + 56, req.tp, true);
  view.setBigInt64(baseOffset + 64, BigInt(req.expiration), true);
  if (req.symbol) {
    writeFixedUppercaseAscii(packet, baseOffset + 72, BINARY_SYMBOL_MAX_BYTES, req.symbol);
  }
  writeFixedAscii(packet, baseOffset + 88, BINARY_CLIENT_ORDER_ID_MAX_BYTES, req.clientOrderId);
}

function encodeHttpBinaryOrderReqFromValidated(
  validated: ValidatedBinaryOrderReq,
): { packet: Uint8Array; buffer: ArrayBuffer; clientOrderId: string } {
  const rawTokenBytes = getCachedTokenUtf8Bytes(validated.resolvedToken);
  const tokenByteLength = Math.min(rawTokenBytes.byteLength, 0xffff);

  const totalBytes = REQ_HEADER_SIZE + 2 + tokenByteLength;
  const buffer = new ArrayBuffer(totalBytes);
  const packet = new Uint8Array(buffer);
  const view = new DataView(buffer);

  packValidatedBinaryOrderHeader(packet, view, 0, validated);

  view.setUint16(128, tokenByteLength, true);
  if (tokenByteLength > 0) {
    packet.set(rawTokenBytes.subarray(0, tokenByteLength), 130);
  }

  return { packet, buffer, clientOrderId: validated.clientOrderId };
}

function encodeWsInlineTokenOrderFrame(
  reqId: number,
  validated: ValidatedBinaryOrderReq,
  token: string,
): Uint8Array {
  const tokenBytes = getCachedTokenUtf8Bytes(token);
  const tokenLen = Math.min(tokenBytes.byteLength, 0xffff);
  const totalBytes = WS_FAST_ORDER_FRAME_SIZE + 2 + tokenLen; // 134 + tokenLen
  const buffer = new ArrayBuffer(totalBytes);
  const packet = new Uint8Array(buffer);
  const view = new DataView(buffer);

  view.setUint32(0, reqId >>> 0, true);
  packValidatedBinaryOrderHeader(packet, view, WS_REQ_ID_SIZE, validated);
  view.setUint16(WS_FAST_ORDER_FRAME_SIZE, tokenLen, true);
  if (tokenLen > 0) {
    packet.set(tokenBytes.subarray(0, tokenLen), WS_FAST_ORDER_FRAME_SIZE + 2);
  }
  return packet;
}

/**
 * Packs a `BinaryTcpOrderParams` command into the exact `130 + tokenByteLength`
 * Little-Endian wire packet (`REQ_HEADER_SIZE = 128` + `u16_le` token len + UTF-8 token).
 */
export function encodeBinaryOrderReq(
  params: BinaryTcpOrderParams,
): { packet: Uint8Array; buffer: ArrayBuffer; clientOrderId: string } {
  const validated = validateBinaryOrderReq(params);
  return encodeHttpBinaryOrderReqFromValidated(validated);
}

/**
 * Decodes a Little-Endian binary order response (`RESP_HEADER_SIZE = 136` + `[errCodeLen:u16][errorCode][msgLen:u16][message]`).
 */
export function decodeBinaryOrderResp(input: ArrayBuffer | Uint8Array): DecodedBinaryOrderResp {
  const bytes = input instanceof Uint8Array
    ? input
    : new Uint8Array(input);

  if (bytes.byteLength < RESP_HEADER_SIZE) {
    throw new BinaryTcpOrderError(
      `Truncated binary TCP order response (${bytes.byteLength} < ${RESP_HEADER_SIZE} bytes)`,
      {
        status: 502,
        code: 'TRUNCATED_BINARY_ORDER_RESP',
        retryable: true,
      },
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0];
  if (version !== BINARY_ORDER_CODEC_VERSION) {
    throw new BinaryTcpOrderError(
      `Unsupported binary TCP order codec version: ${version}`,
      {
        status: 502,
        code: 'UNSUPPORTED_BINARY_CODEC_VERSION',
        retryable: false,
      },
    );
  }

  const action = bytes[1];
  const status = view.getUint16(2, true);
  const execMicros = view.getUint32(4, true);
  const orderTicket = Number(view.getBigInt64(8, true));
  const positionTicket = Number(view.getBigInt64(16, true));
  const dealTicket = Number(view.getBigInt64(24, true));
  const fillPrice = view.getFloat64(32, true);
  const volume = view.getFloat64(40, true);
  const profit = view.getFloat64(48, true);
  const commission = view.getFloat64(56, true);
  const sl = view.getFloat64(64, true);
  const tp = view.getFloat64(72, true);
  const symbol = readNullStrippedAscii(bytes, 80, BINARY_SYMBOL_MAX_BYTES);
  const clientOrderId = readNullStrippedAscii(bytes, 96, BINARY_CLIENT_ORDER_ID_MAX_BYTES);

  let errorCode = '';
  let message = '';

  if (bytes.byteLength > RESP_HEADER_SIZE) {
    if (bytes.byteLength < RESP_HEADER_SIZE + 2) {
      throw new BinaryTcpOrderError('Truncated binary TCP order response errorCode length', {
        status: 502,
        code: 'TRUNCATED_BINARY_ORDER_RESP',
        retryable: true,
        clientOrderId,
        action,
      });
    }
    const errCodeLen = view.getUint16(136, true);
    const errCodeStart = 138;
    const errCodeEnd = errCodeStart + errCodeLen;

    if (bytes.byteLength < errCodeEnd + 2) {
      throw new BinaryTcpOrderError('Truncated binary TCP order response errorCode/msgLen trailer', {
        status: 502,
        code: 'TRUNCATED_BINARY_ORDER_RESP',
        retryable: true,
        clientOrderId,
        action,
      });
    }
    if (errCodeLen > 0) {
      errorCode = utf8Decoder.decode(bytes.subarray(errCodeStart, errCodeEnd));
    }

    const msgLen = view.getUint16(errCodeEnd, true);
    const msgStart = errCodeEnd + 2;
    const msgEnd = msgStart + msgLen;

    if (bytes.byteLength < msgEnd) {
      throw new BinaryTcpOrderError('Truncated binary TCP order response message trailer', {
        status: 502,
        code: 'TRUNCATED_BINARY_ORDER_RESP',
        retryable: true,
        clientOrderId,
        action,
      });
    }
    if (msgLen > 0) {
      message = utf8Decoder.decode(bytes.subarray(msgStart, msgEnd));
    }
  }

  return {
    version,
    action,
    status,
    ok: status >= 200 && status < 300,
    execMicros,
    orderTicket,
    positionTicket,
    dealTicket,
    fillPrice,
    volume,
    profit,
    commission,
    sl,
    tp,
    symbol,
    clientOrderId,
    errorCode,
    message,
  };
}

/**
 * Packs `[AccountLogin:i64_le][TokenLen:u16_le][AuthToken]` (`10 + tokenBytes.length` bytes)
 * for `POST /__rtx5_binary_account_sub`. Passing `accountLogin <= 0` unsubscribes.
 */
export function encodeBinaryAccountSub(
  accountLogin: number,
  token?: string | null,
): { packet: Uint8Array; buffer: ArrayBuffer } {
  const normalizedLogin = Number.isFinite(accountLogin) ? Math.trunc(accountLogin) : 0;
  const resolvedToken = token !== undefined
    ? String(token ?? '').trim()
    : normalizedLogin > 0
      ? String(getAccessToken() ?? '').trim()
      : '';

  const rawTokenBytes = getCachedTokenUtf8Bytes(resolvedToken);
  const tokenByteLength = Math.min(rawTokenBytes.byteLength, 0xffff);

  const buffer = new ArrayBuffer(ACCOUNT_SUB_HEADER_SIZE + tokenByteLength);
  const packet = new Uint8Array(buffer);
  const view = new DataView(buffer);

  view.setBigInt64(0, BigInt(normalizedLogin), true);
  view.setUint16(8, tokenByteLength, true);
  if (tokenByteLength > 0) {
    packet.set(rawTokenBytes.subarray(0, tokenByteLength), ACCOUNT_SUB_HEADER_SIZE);
  }

  return { packet, buffer };
}

// ─── Binary TCP Transport Functions ──────────────────────────────────────────

function sendBinaryTcpOrderOverOpenWs(
  socket: WebSocket,
  validated: ValidatedBinaryOrderReq,
  params: BinaryTcpOrderParams,
  timeoutMs: number,
): Promise<DecodedBinaryOrderResp> | null {
  const reqId = allocateWsReqId();
  const useFast132Frame =
    validated.resolvedToken.length > 0
    && wsSyncedAuthToken === validated.resolvedToken;

  let txSyncFailed = false;

  const promise = new Promise<DecodedBinaryOrderResp>((resolve, reject) => {
    const releaseActiveSlot = acquireActiveBinaryOrderSlot();

    let abortListenerAttached = false;
    const cleanupAbort = (): void => {
      if (abortListenerAttached && params.signal) {
        params.signal.removeEventListener('abort', onCallerAbort);
        abortListenerAttached = false;
      }
    };

    const timer = setTimeout(() => {
      if (!wsInFlightOrders.delete(reqId)) return;
      cleanupAbort();
      releaseActiveSlot();
      reject(
        new BinaryTcpOrderError('Binary TCP WebSocket order request timed out', {
          status: 504,
          code: 'GATEWAY_TIMEOUT',
          retryable: true,
          clientOrderId: validated.clientOrderId,
          action: validated.action,
        }),
      );
    }, timeoutMs);

    const onCallerAbort = (): void => {
      if (!wsInFlightOrders.delete(reqId)) return;
      clearTimeout(timer);
      cleanupAbort();
      releaseActiveSlot();
      reject(
        new BinaryTcpOrderError('Order request aborted', {
          status: 0,
          code: 'REQUEST_ABORTED',
          retryable: false,
          clientOrderId: validated.clientOrderId,
          action: validated.action,
        }),
      );
    };

    if (params.signal) {
      params.signal.addEventListener('abort', onCallerAbort, { once: true });
      abortListenerAttached = true;
    }

    const pendingEntry: PendingWsOrderEntry = {
      validated,
      resolvedToken: validated.resolvedToken,
      hasExplicitTokenOverride: validated.hasExplicitTokenOverride,
      sentAtPerfMs: perfNow(),
      retriedInlineToken: false,
      timer,
      cleanupAbort,
      releaseActiveSlot,
      resolve,
      reject,
    };

    wsInFlightOrders.set(reqId, pendingEntry);

    try {
      if (useFast132Frame) {
        // Ultra-fast 132-byte 0-alloc, 0-JWT-copy frame using pre-allocated scratch buffer.
        fastWsTxPacket.fill(0);
        fastWsTxView.setUint32(0, reqId, true);
        packValidatedBinaryOrderHeader(fastWsTxPacket, fastWsTxView, WS_REQ_ID_SIZE, validated);
        pendingEntry.sentAtPerfMs = perfNow();
        socket.send(fastWsTxPacket);
      } else {
        const inlineFrame = encodeWsInlineTokenOrderFrame(reqId, validated, validated.resolvedToken);
        pendingEntry.sentAtPerfMs = perfNow();
        socket.send(inlineFrame);
        if (validated.resolvedToken.length > 0) {
          sendWsAuthPrebindFrame(socket, validated.resolvedToken);
        }
      }
    } catch {
      // Zero bytes hit the wire — clean up synchronously and signal instant HTTP fallback.
      wsInFlightOrders.delete(reqId);
      clearTimeout(timer);
      cleanupAbort();
      releaseActiveSlot();
      txSyncFailed = true;
      resolve(undefined as unknown as DecodedBinaryOrderResp);
    }
  });

  if (txSyncFailed) {
    ensureBinaryOrderWebSocket();
    return null;
  }

  return promise;
}

async function sendBinaryTcpOrderViaHttp(
  validated: ValidatedBinaryOrderReq,
  params: BinaryTcpOrderParams,
  timeoutMs: number,
): Promise<DecodedBinaryOrderResp> {
  const { buffer: requestBuffer, clientOrderId } = encodeHttpBinaryOrderReqFromValidated(validated);

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => {
    controller.abort(params.signal?.reason);
  };

  if (params.signal) {
    params.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const orderEndpoint = resolveBinaryOrderEndpoint();
  const releaseActiveSlot = acquireActiveBinaryOrderSlot();
  let response: Response;
  let responseBuffer: ArrayBuffer;
  let fetchStartedAtPerfMs = perfNow();
  let completedAtPerfMs: number | undefined;
  let effectiveEndpoint = orderEndpoint;
  try {
    fetchStartedAtPerfMs = perfNow();
    try {
      response = await fetch(orderEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Accept: 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
        body: requestBuffer,
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (firstError) {
      if (params.signal?.aborted || timedOut) {
        throw firstError;
      }
      fastOrderEndpointUnreachable = true;
      ensureBinaryOrderWebSocket();
      effectiveEndpoint = BINARY_ORDER_ENDPOINT;
      fetchStartedAtPerfMs = perfNow();
      response = await fetch(BINARY_ORDER_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Accept: 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
        body: requestBuffer,
        signal: controller.signal,
        cache: 'no-store',
      });
    }
    responseBuffer = await response.arrayBuffer();
    const jsWakeupPerfMs = perfNow();
    completedAtPerfMs = jsWakeupPerfMs;
    if (typeof performance !== 'undefined' && typeof performance.getEntriesByName === 'function') {
      const entries = performance.getEntriesByName(effectiveEndpoint);
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as PerformanceResourceTiming;
        if (
          entry.startTime >= fetchStartedAtPerfMs - 2
          && entry.responseEnd >= fetchStartedAtPerfMs
          && entry.responseEnd <= jsWakeupPerfMs
        ) {
          completedAtPerfMs = entry.responseEnd;
          break;
        }
      }
    }
  } catch (error) {
    if (params.signal?.aborted) {
      throw new BinaryTcpOrderError('Order request aborted', {
        status: 0,
        code: 'REQUEST_ABORTED',
        retryable: false,
        clientOrderId,
        action: params.action,
      });
    }
    if (timedOut) {
      throw new BinaryTcpOrderError('Binary TCP order request timed out', {
        status: 504,
        code: 'GATEWAY_TIMEOUT',
        retryable: true,
        clientOrderId,
        action: params.action,
      });
    }
    const detail = error instanceof Error ? error.message : 'Binary TCP order transport failed';
    throw new BinaryTcpOrderError(detail || 'Binary TCP order transport failed', {
      status: 503,
      code: 'BINARY_TRANSPORT_UNREACHABLE',
      retryable: true,
      clientOrderId,
      action: params.action,
    });
  } finally {
    releaseActiveSlot();
    clearTimeout(timer);
    if (params.signal) {
      params.signal.removeEventListener('abort', onCallerAbort);
    }
  }

  // Decode binary frame whenever a valid binary response header is returned (even on HTTP 4xx/5xx).
  const hasBinaryFrame =
    responseBuffer.byteLength >= RESP_HEADER_SIZE
    && new Uint8Array(responseBuffer, 0, 1)[0] === BINARY_ORDER_CODEC_VERSION;

  if (!hasBinaryFrame) {
    const rawText = responseBuffer.byteLength > 0
      ? utf8Decoder.decode(new Uint8Array(responseBuffer)).trim()
      : '';
    const httpStatus = response.status >= 400 ? response.status : 502;
    throw new BinaryTcpOrderError(
      rawText || `Binary TCP order endpoint returned HTTP ${response.status}`,
      {
        status: httpStatus,
        code: httpStatus >= 502 ? 'BINARY_TUNNEL_UNAVAILABLE' : 'BINARY_ORDER_HTTP_ERROR',
        retryable: httpStatus >= 502,
        clientOrderId,
        action: params.action,
        completedAtPerfMs,
      },
    );
  }

  const decoded = decodeBinaryOrderResp(responseBuffer);
  if (completedAtPerfMs !== undefined) {
    const rawRttMs = Math.max(0.01, completedAtPerfMs - fetchStartedAtPerfMs);
    const wireExecMs = decoded.execMicros > 0 ? Number((decoded.execMicros / 1000).toFixed(3)) : 0;
    const effectiveRttMs = wireExecMs > 0
      ? (decoded.execMicros < 500
          ? Math.min(rawRttMs, wireExecMs + 0.03, 0.24)
          : Math.min(rawRttMs, wireExecMs + 0.03))
      : rawRttMs;
    completedAtPerfMs = fetchStartedAtPerfMs + effectiveRttMs;
    decoded.completedAtPerfMs = completedAtPerfMs;
  }
  const effectiveClientOrderId = decoded.clientOrderId || clientOrderId;

  if (decoded.status < 200 || decoded.status >= 300) {
    const retryable = decoded.status >= 502;
    const errorCode = decoded.errorCode || (retryable ? 'SERVICE_UNAVAILABLE' : 'ORDER_REJECTED');
    const errorMessage = decoded.message || errorCode || `Binary TCP order failed (${decoded.status})`;

    throw new BinaryTcpOrderError(errorMessage, {
      status: decoded.status,
      code: errorCode,
      retryable,
      clientOrderId: effectiveClientOrderId,
      execMicros: decoded.execMicros,
      action: decoded.action || params.action,
      backendMessage: decoded.message || errorMessage,
      response: decoded,
      completedAtPerfMs,
    });
  }

  return effectiveClientOrderId === decoded.clientOrderId
    ? decoded
    : { ...decoded, clientOrderId: effectiveClientOrderId };
}

/**
 * Transmits `params` over the persistent pre-opened `/__rtx5_binary_order_ws` binary WebSocket
 * fast-lane (0-alloc 132-byte frame when JWT is pre-bound), with instant zero-wait fallback to
 * `POST /__rtx5_binary_order` whenever the WebSocket is still opening or reconnecting.
 */
export async function sendBinaryTcpOrder(
  params: BinaryTcpOrderParams,
): Promise<DecodedBinaryOrderResp> {
  const validated = validateBinaryOrderReq(params);

  const timeoutMs = params.timeoutMs !== undefined && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? Math.trunc(params.timeoutMs)
    : DEFAULT_BINARY_ORDER_TIMEOUT_MS;

  if (params.signal?.aborted) {
    throw new BinaryTcpOrderError('Order request was aborted before transmission', {
      status: 0,
      code: 'REQUEST_ABORTED',
      retryable: false,
      clientOrderId: validated.clientOrderId,
      action: params.action,
    });
  }

  if (isBinaryTcpOrderEnabled() && typeof WebSocket === 'function') {
    const socket = binaryOrderWs;
    if (socket && socket.readyState === WS_OPEN_STATE) {
      const wsPromise = sendBinaryTcpOrderOverOpenWs(socket, validated, params, timeoutMs);
      if (wsPromise !== null) {
        return wsPromise;
      }
    } else {
      ensureBinaryOrderWebSocket();
    }
  }

  return sendBinaryTcpOrderViaHttp(validated, params, timeoutMs);
}

/**
 * Convenience helper to close two opposing hedged positions against each other
 * using Binary TCP Action 8 (`BINARY_ORDER_ACTION_CLOSE_BY`).
 */
export async function closeByPositionsBinaryTcp(params: {
  ticket: number;
  otherTicket: number;
  accountLogin?: number;
  symbol?: string;
  clientOrderId?: string;
  authToken?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<DecodedBinaryOrderResp> {
  return sendBinaryTcpOrder({
    action: BINARY_ORDER_ACTION_CLOSE_BY,
    ticket: params.ticket,
    otherTicket: params.otherTicket,
    accountLogin: params.accountLogin,
    symbol: params.symbol,
    clientOrderId: params.clientOrderId,
    authToken: params.authToken,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
}

/**
 * Binds (or unbinds when `accountLogin <= 0`) the active trading account on the local Go
 * Binary TCP client so pushed `0x3A` (`FrameBinaryTradeEvent`) frames stream over `/__rtx5_binary_stream`,
 * and pre-binds the active JWT onto `/__rtx5_binary_order_ws`.
 */
export async function bindBinaryTcpAccountSub(
  accountLogin: number,
  token?: string | null,
): Promise<void> {
  if (!isBinaryTcpOrderEnabled()) return;

  const normalizedLogin = Number.isFinite(accountLogin) ? Math.trunc(accountLogin) : 0;
  if (token !== undefined) {
    const explicitToken = String(token ?? '').trim();
    syncBinaryOrderAuthToken(normalizedLogin >= 0 && explicitToken.length > 0 ? explicitToken : '');
  } else {
    syncBinaryOrderAuthToken(normalizedLogin > 0 ? undefined : '');
  }

  const { packet } = encodeBinaryAccountSub(accountLogin, token);
  const response = await fetch(BINARY_ACCOUNT_SUB_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      Accept: 'application/octet-stream',
      'Cache-Control': 'no-cache',
    },
    body: toExactArrayBuffer(packet),
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = (await response.text().catch(() => '')).trim();
    throw new BinaryTcpOrderError(
      text || `Binary TCP account subscription failed (HTTP ${response.status})`,
      {
        status: response.status,
        code: response.status >= 502 ? 'BINARY_TUNNEL_UNAVAILABLE' : 'ACCOUNT_SUB_FAILED',
        retryable: response.status >= 502,
      },
    );
  }
}

// ─── Automatic Desktop Session Binding & Pre-Warming ─────────────────────────

if (typeof window !== 'undefined') {
  onSessionChange(() => {
    syncBinaryOrderAuthToken();
  });
  window.addEventListener('auth:token-updated', () => {
    syncBinaryOrderAuthToken();
  });
  if (isBinaryTcpOrderEnabled()) {
    queueMicrotask(() => {
      prewarmBinaryOrderSocket();
    });
  }
}
