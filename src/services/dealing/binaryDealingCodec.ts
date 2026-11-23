/**
 * Pure Binary TCP Dealing Wire Codec (Zero-JSON Little-Endian ArrayBuffer/DataView).
 *
 * Byte-for-byte parity with:
 *   - `services/gateway/internal/dealing/wire_codec.go`
 *   - `services/gateway/internal/dealing/types.go`
 *   - `DEALING_DESIGN/w1-api-contract/API_CONTRACT.md` §9
 *   - `DEALING_DESIGN/DECISIONS.md` D3, D4, D10, D12
 *
 * Intentionally imports nothing with module-level socket/session side effects.
 */

// ─── Wire Codec Version & Sizes ──────────────────────────────────────────────

export const WIRE_ORDER_CODEC_VERSION = 1;
export const WIRE_SYMBOL_MAX_BYTES = 16;
export const WIRE_CLIENT_ORDER_ID_MAX_BYTES = 40;
export const WIRE_ORDER_REQ_HEADER_SIZE = 128;
export const WIRE_ORDER_RESP_HEADER_SIZE = 136;

export const WIRE_RTO_MAX_PAYLOAD_BYTES = 65_535;
export const WIRE_ORDER_EXTRAS_MAX_BYTES = 512;
export const WIRE_ORDER_COMMENT_MAX_BYTES = 64;
export const WIRE_ORDER_MAGIC_BYTE_LEN = 8;
export const WIRE_ORDER_TRAILING_BYTE_LEN = 4;
export const WIRE_ORDER_TRAILING_MAX_POINTS = 100_000;
export const WIRE_ORDER_FILLING_MAX = 2;

// ─── 0x38 Wire Actions ───────────────────────────────────────────────────────

export const WIRE_ACTION_PLACE_MARKET = 1;
export const WIRE_ACTION_CLOSE_POSITION = 2;
export const WIRE_ACTION_MODIFY_POSITION = 3;
export const WIRE_ACTION_PLACE_PENDING = 4;
export const WIRE_ACTION_MODIFY_PENDING = 5;
export const WIRE_ACTION_CANCEL_PENDING = 6;
export const WIRE_ACTION_CLOSE_BULK = 7;
export const WIRE_ACTION_CLOSE_BY = 8;
/** Accept dealer/robot requote (0x38 Action 9, Ticket=0, Expiration=0, Price>0, TLVs 0x14+0x15). */
export const WIRE_ACTION_REQUOTE_ACCEPT = 9;
/** Decline dealer/robot requote (0x38 Action 10, Ticket=0, Expiration=0, Price=0, TLVs 0x14+0x15). */
export const WIRE_ACTION_REQUOTE_DECLINE = 10;
/** Dealing capability probe + client-pulled pending state sync (0x38 Action 11, D18). */
export const WIRE_ACTION_DEALING_SYNC = 11;

// ─── 0x38 Flags & Extra TLV Tags ─────────────────────────────────────────────

export const WIRE_FLAG_HAS_EXTRAS = 0x0400;

export const WIRE_EXTRA_TAG_COMMENT = 0x01;
export const WIRE_EXTRA_TAG_MAGIC = 0x02;
export const WIRE_EXTRA_TAG_TRAILING_STOP = 0x03;
export const WIRE_EXTRA_TAG_TRAILING_STEP = 0x04;
export const WIRE_EXTRA_TAG_ACTIVATION_FLAGS = 0x05;
export const WIRE_EXTRA_TAG_REASON = 0x06;
export const WIRE_EXTRA_TAG_FILLING = 0x07;
export const WIRE_EXTRA_TAG_PRICE_DEVIATION = 0x13;
/** Raw 16-byte dealing request UUID v4. */
export const WIRE_EXTRA_TAG_DEALING_REQUEST_UUID = 0x14;
/** Raw 16-byte dealing requote UUID v4. */
export const WIRE_EXTRA_TAG_DEALING_REQUOTE_UUID = 0x15;
/** Client capability bitset (4-byte uint32 LE). Sent on EVERY order by upgraded terminals (D4). */
export const WIRE_EXTRA_TAG_CLIENT_CAPS = 0x16;

export const CLIENT_CAP_DEALING_V1 = 0x0000_0001;

// ─── Order Origin Reasons (TLV 0x06, D10) ────────────────────────────────────

export const ORDER_REASON_CLIENT = 0;
export const ORDER_REASON_EXPERT = 1;

// ─── Side & DealingKind Enums ────────────────────────────────────────────────

export const WIRE_SIDE_NONE = 0;
export const WIRE_SIDE_BUY = 1;
export const WIRE_SIDE_SELL = 2;

export const DEALING_KIND_OPEN = 1;
export const DEALING_KIND_CLOSE = 2;
export const DEALING_KIND_MODIFY = 3;

// ─── 0x39 Status & MT5 Retcodes ──────────────────────────────────────────────

export const WIRE_STATUS_OK = 200;
export const WIRE_STATUS_ACCEPTED = 202;
export const WIRE_STATUS_BAD_REQUEST = 400;
export const WIRE_STATUS_UNAUTHORIZED = 401;
export const WIRE_STATUS_FORBIDDEN = 403;
export const WIRE_STATUS_NOT_FOUND = 404;
export const WIRE_STATUS_CONFLICT = 409;
export const WIRE_STATUS_REJECTED = 422;
export const WIRE_STATUS_INTERNAL_ERR = 500;

export const MT_RET_REQUEST_REQUOTE = 10004;
export const MT_RET_REQUEST_REJECTED = 10006;
export const MT_RET_REQUEST_CANCEL = 10007;
export const MT_RET_REQUEST_PLACED = 10008;
export const MT_RET_REQUEST_DONE = 10009;
export const MT_RET_REQUEST_INVALID_PRICE = 10015;
export const MT_RET_REQUEST_NO_MONEY = 10019;
export const MT_RET_REQUEST_INVALID_EXP = 10022;

// ─── 0x39 Trailing ExecWire TLV Tags ─────────────────────────────────────────

export const WIRE_RESP_TAG_RETCODE = 0x20;
export const WIRE_RESP_TAG_QUOTED_REQ_ID = 0x21;
export const WIRE_RESP_TAG_DEALER_BID = 0x22;
export const WIRE_RESP_TAG_DEALER_ASK = 0x23;
export const WIRE_RESP_TAG_REQUEST_UUID = 0x24;
export const WIRE_RESP_TAG_EXPIRES_AT_MS = 0x25;
export const WIRE_RESP_TAG_SERVER_NOW_MS = 0x26;
export const WIRE_RESP_TAG_DEALING_KIND = 0x27;
export const WIRE_RESP_TAG_REQUOTE_UUID = 0x28;
export const WIRE_RESP_TAG_DIGITS = 0x29;
/** Action 11 capability probe reply flag (`1` byte: `1` = dealing enabled, DECISIONS.md D18). */
export const WIRE_RESP_TAG_DEALING_ENABLED = 0x2a;
export const WIRE_EXEC_WIRE_LEGACY_LEN = (2 + 4) + (2 + 8) + (2 + 8) + (2 + 8); // 36 bytes

// ─── 0x3A EventKind=7 & 0x3B Sizes ───────────────────────────────────────────

export const WIRE_TRADE_EVENT_VERSION = 1;
export const WIRE_TRADE_EVENT_KIND_POSITIONS = 1;
export const WIRE_TRADE_EVENT_KIND_ORDERS = 2;
export const WIRE_TRADE_EVENT_KIND_ACCOUNT = 3;
export const WIRE_TRADE_EVENT_KIND_METRICS = 4;
export const WIRE_TRADE_EVENT_KIND_DEALS = 5;
export const WIRE_TRADE_EVENT_KIND_STATE = 6;
export const WIRE_TRADE_EVENT_KIND_DEALING = 7;

export const WIRE_ACCOUNT_SUB_HEADER_SIZE = 10;
export const WIRE_TRADE_EVENT_MIN_HEADER_SIZE = 22;
export const WIRE_TRADE_EVENT_MAX_BYTES = 65_000;

export const WIRE_DEALING_EVENT_SUB_VERSION = 1;
export const WIRE_DEALING_EVENT_HEADER_SIZE = 216;
export const WIRE_DEALING_EVENT_MIN_SIZE = 218;
export const MAX_REASON_TEXT_BYTES = 200;

export const WIRE_DEALING_STATUS_IN_DEALING = 1;
export const WIRE_DEALING_STATUS_REQUOTED = 2;
export const WIRE_DEALING_STATUS_FILLED = 3;
export const WIRE_DEALING_STATUS_REJECTED = 4;
export const WIRE_DEALING_STATUS_EXPIRED = 5;
export const WIRE_DEALING_STATUS_CANCELLED = 6;

// ─── Timing Constants (API_CONTRACT §3.7, §5, DECISIONS D13) ─────────────────

export const DEFAULT_HUMAN_TIMEOUT_MS = 10_000;
export const DEFAULT_REQUOTE_WINDOW_SEC = 5;
export const MIN_REQUOTE_WINDOW_SEC = 1;
export const MAX_REQUOTE_WINDOW_SEC = 30;
export const DEFAULT_REQUOTE_WINDOW_MS = DEFAULT_REQUOTE_WINDOW_SEC * 1_000;

// ─── Error Type ──────────────────────────────────────────────────────────────

export type DealingWireErrorCode =
  | 'TRUNCATED_WIRE_FRAME'
  | 'UNSUPPORTED_WIRE_VERSION'
  | 'INVALID_WIRE_FRAME'
  | 'WIRE_FRAME_TOO_LARGE';

export class DealingWireCodecError extends Error {
  readonly code: DealingWireErrorCode;

  constructor(code: DealingWireErrorCode, message: string) {
    super(message);
    this.name = 'DealingWireCodecError';
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
  }
}

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface WireReqExtrasInput {
  comment?: string;
  magic?: number | bigint;
  trailingStop?: number;
  hasTrailingStop?: boolean;
  trailingStep?: number;
  hasTrailingStep?: boolean;
  reason?: number;
  hasReason?: boolean;
  filling?: number;
  hasFilling?: boolean;
  priceDeviation?: number | bigint;
  hasPriceDeviation?: boolean;
  dealingRequestUuid?: string;
  dealingRequoteUuid?: string;
  clientCaps?: number;
  hasClientCaps?: boolean;
}

export interface DecodedWireReqExtras {
  comment: string;
  magic: number;
  trailingStop: number;
  hasTrailingStop: boolean;
  trailingStep: number;
  hasTrailingStep: boolean;
  reason: number;
  hasReason: boolean;
  filling: number;
  hasFilling: boolean;
  priceDeviation: number;
  hasPriceDeviation: boolean;
  dealingRequestUuid: string;
  hasDealingRequest: boolean;
  dealingRequoteUuid: string;
  hasDealingRequote: boolean;
  clientCaps: number;
  hasClientCaps: boolean;
  hasDealingCap: boolean;
  isExpert: boolean;
}

export interface WireRequoteActionReqInput {
  action: typeof WIRE_ACTION_REQUOTE_ACCEPT | typeof WIRE_ACTION_REQUOTE_DECLINE;
  side?: number;
  orderSubType?: number;
  flags?: number;
  accountLogin: number;
  ticket?: number;
  volume?: number;
  price?: number;
  expiration?: number;
  symbol?: string;
  clientOrderId?: string;
  authToken?: string;
  requestId: string;
  requoteId: string;
  reason?: number;
  clientCaps?: number;
  extras?: WireReqExtrasInput;
}

export interface DecodedWireRequoteActionReq {
  version: number;
  action: number;
  side: number;
  orderSubType: number;
  flags: number;
  accountLogin: number;
  ticket: number;
  volume: number;
  price: number;
  stopLimitPrice: number;
  sl: number;
  tp: number;
  expiration: number;
  symbol: string;
  clientOrderId: string;
  authToken: string;
  extras: DecodedWireReqExtras;
}

export interface ExecWireResultInput {
  retcode: number;
  quotedReqId?: number;
  dealerBid?: number;
  dealerAsk?: number;
  requestId?: string;
  expiresAtMs?: number;
  serverNowMs?: number;
  dealingKind?: number;
  requoteId?: string;
  digits?: number;
  hasDigits?: boolean;
  dealingEnabled?: boolean;
  hasDealingEnabled?: boolean;
}

export interface DecodedExecWireResult {
  retcode: number;
  quotedReqId: number;
  dealerBid: number;
  dealerAsk: number;
  requestId: string;
  hasRequestUuid: boolean;
  expiresAtMs: number;
  hasExpiresAtMs: boolean;
  serverNowMs: number;
  hasServerNowMs: boolean;
  dealingKind: number;
  hasDealingKind: boolean;
  requoteId: string;
  hasRequoteUuid: boolean;
  digits: number;
  hasDigits: boolean;
  dealingEnabled: boolean;
  hasDealingEnabled: boolean;
}

export interface WireOrderRespFrameInput {
  action: number;
  status: number;
  execMicros?: number;
  orderTicket?: number;
  positionTicket?: number;
  dealTicket?: number;
  fillPrice?: number;
  volume?: number;
  profit?: number;
  commission?: number;
  sl?: number;
  tp?: number;
  symbol?: string;
  clientOrderId?: string;
  errorCode?: string;
  message?: string;
  execWire?: ExecWireResultInput | null;
}

export interface DecodedOrderRespWithExecWire {
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
  msgEndOffset: number;
  execWire: DecodedExecWireResult | null;
}

export interface BinaryDealingStatusEventInput {
  subVersion?: number;
  status: number;
  kind?: number;
  side?: number;
  digits?: number;
  retcode?: number;
  seq?: number;
  quotedReqId?: number;
  orderTicket?: number;
  positionTicket?: number;
  dealTicket?: number;
  volume?: number;
  price?: number;
  bid?: number;
  ask?: number;
  profit?: number;
  commission?: number;
  sl?: number;
  tp?: number;
  expiresAtMs?: number;
  serverNowMs?: number;
  requestId: string;
  requoteId?: string;
  symbol?: string;
  clientOrderId?: string;
  reasonCode?: string;
  reasonText?: string;
}

export interface DecodedBinaryDealingStatusEvent {
  subVersion: number;
  status: number;
  kind: number;
  side: number;
  digits: number;
  retcode: number;
  seq: number;
  quotedReqId: number;
  orderTicket: number;
  positionTicket: number;
  dealTicket: number;
  volume: number;
  price: number;
  bid: number;
  ask: number;
  profit: number;
  commission: number;
  sl: number;
  tp: number;
  expiresAtMs: number;
  serverNowMs: number;
  requestId: string;
  requoteId: string;
  hasRequoteId: boolean;
  symbol: string;
  clientOrderId: string;
  reasonCode: string;
  reasonText: string;
}

export interface DecodedTradeEventKind7Envelope {
  version: number;
  eventKind: number;
  accountLogin: number;
  timestampMs: number;
  channel: string;
  event: DecodedBinaryDealingStatusEvent;
}

// ─── Module-Scoped Zero-Alloc Scratch Buffers & Singletons ───────────────────

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8DecoderLenient = new TextDecoder('utf-8', { fatal: false });
const EMPTY_BYTES = new Uint8Array(0);

/** Pre-encoded 6-byte capability TLV 0x16 for CLIENT_CAP_DEALING_V1 (zero heap allocations). */
export const CLIENT_CAPS_DEALING_V1_TLV: Readonly<Uint8Array> = new Uint8Array([
  WIRE_EXTRA_TAG_CLIENT_CAPS,
  4,
  1,
  0,
  0,
  0,
]);

const HEX_PAIRS: readonly string[] = (() => {
  const table: string[] = new Array(256);
  for (let i = 0; i < 256; i++) {
    table[i] = i.toString(16).padStart(2, '0');
  }
  return table;
})();

// Reusable 256-bit duplicate-tag bitset & scratch buffers for single-threaded synchronous coding.
const seenTagsScratch = new Uint32Array(8);
const uuidBytesScratch = new Uint8Array(16);
const symbolWriteScratch = new Uint8Array(WIRE_SYMBOL_MAX_BYTES);
const symbolReadScratch = new Uint8Array(WIRE_SYMBOL_MAX_BYTES);
const coidWriteScratch = new Uint8Array(WIRE_CLIENT_ORDER_ID_MAX_BYTES);
const coidReadScratch = new Uint8Array(WIRE_CLIENT_ORDER_ID_MAX_BYTES);

function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 65 && code <= 70) return code - 55; // A-F
  if (code >= 97 && code <= 102) return code - 87; // a-f
  return -1;
}

function isTrimSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 13 || code === 10;
}

function trimAsciiBounds(value: string): [number, number] {
  let start = 0;
  let end = value.length;
  while (start < end && isTrimSpace(value.charCodeAt(start))) start++;
  while (end > start && isTrimSpace(value.charCodeAt(end - 1))) end--;
  return [start, end];
}

function resetExtras(out: DecodedWireReqExtras): void {
  out.comment = '';
  out.magic = 0;
  out.trailingStop = 0;
  out.hasTrailingStop = false;
  out.trailingStep = 0;
  out.hasTrailingStep = false;
  out.reason = 0;
  out.hasReason = false;
  out.filling = 0;
  out.hasFilling = false;
  out.priceDeviation = 0;
  out.hasPriceDeviation = false;
  out.dealingRequestUuid = '';
  out.hasDealingRequest = false;
  out.dealingRequoteUuid = '';
  out.hasDealingRequote = false;
  out.clientCaps = 0;
  out.hasClientCaps = false;
  out.hasDealingCap = false;
  out.isExpert = false;
}

export function createEmptyExtras(): DecodedWireReqExtras {
  const out = {} as DecodedWireReqExtras;
  resetExtras(out);
  return out;
}

function resetExecWire(out: DecodedExecWireResult): void {
  out.retcode = 0;
  out.quotedReqId = 0;
  out.dealerBid = 0;
  out.dealerAsk = 0;
  out.requestId = '';
  out.hasRequestUuid = false;
  out.expiresAtMs = 0;
  out.hasExpiresAtMs = false;
  out.serverNowMs = 0;
  out.hasServerNowMs = false;
  out.dealingKind = 0;
  out.hasDealingKind = false;
  out.requoteId = '';
  out.hasRequoteUuid = false;
  out.digits = 0;
  out.hasDigits = false;
  out.dealingEnabled = false;
  out.hasDealingEnabled = false;
}

export function createEmptyExecWire(): DecodedExecWireResult {
  const out = {} as DecodedExecWireResult;
  resetExecWire(out);
  return out;
}

function resetDealingStatusEvent(out: DecodedBinaryDealingStatusEvent): void {
  out.subVersion = 0;
  out.status = 0;
  out.kind = 0;
  out.side = 0;
  out.digits = 0;
  out.retcode = 0;
  out.seq = 0;
  out.quotedReqId = 0;
  out.orderTicket = 0;
  out.positionTicket = 0;
  out.dealTicket = 0;
  out.volume = 0;
  out.price = 0;
  out.bid = 0;
  out.ask = 0;
  out.profit = 0;
  out.commission = 0;
  out.sl = 0;
  out.tp = 0;
  out.expiresAtMs = 0;
  out.serverNowMs = 0;
  out.requestId = '';
  out.requoteId = '';
  out.hasRequoteId = false;
  out.symbol = '';
  out.clientOrderId = '';
  out.reasonCode = '';
  out.reasonText = '';
}

export function createEmptyDealingStatusEvent(): DecodedBinaryDealingStatusEvent {
  const out = {} as DecodedBinaryDealingStatusEvent;
  resetDealingStatusEvent(out);
  return out;
}

export function createEmptyTradeEventKind7Envelope(): DecodedTradeEventKind7Envelope {
  return {
    version: 0,
    eventKind: 0,
    accountLogin: 0,
    timestampMs: 0,
    channel: '',
    event: createEmptyDealingStatusEvent(),
  };
}

// ─── UUID, Symbol, ClientOrderID & Confirm-ID Helpers ────────────────────────

export function isZeroUuidBytes(src: Uint8Array, offset = 0): boolean {
  for (let i = 0; i < 16; i++) {
    if (src[offset + i] !== 0) return false;
  }
  return true;
}

export function formatUuidBytes(src: Uint8Array, offset = 0): string {
  if (offset + 16 > src.byteLength) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 16-byte UUID');
  }
  return (
    HEX_PAIRS[src[offset]]
    + HEX_PAIRS[src[offset + 1]]
    + HEX_PAIRS[src[offset + 2]]
    + HEX_PAIRS[src[offset + 3]]
    + '-'
    + HEX_PAIRS[src[offset + 4]]
    + HEX_PAIRS[src[offset + 5]]
    + '-'
    + HEX_PAIRS[src[offset + 6]]
    + HEX_PAIRS[src[offset + 7]]
    + '-'
    + HEX_PAIRS[src[offset + 8]]
    + HEX_PAIRS[src[offset + 9]]
    + '-'
    + HEX_PAIRS[src[offset + 10]]
    + HEX_PAIRS[src[offset + 11]]
    + HEX_PAIRS[src[offset + 12]]
    + HEX_PAIRS[src[offset + 13]]
    + HEX_PAIRS[src[offset + 14]]
    + HEX_PAIRS[src[offset + 15]]
  );
}

/**
 * Parses a canonical 36-char hyphenated UUID directly into `dst[offset..offset+16]`.
 * Zero heap allocations.
 */
export function parseUuidToBytesInto(uuid: string, dst: Uint8Array, offset = 0): void {
  if (
    typeof uuid !== 'string'
    || uuid.length !== 36
    || uuid.charCodeAt(8) !== 45
    || uuid.charCodeAt(13) !== 45
    || uuid.charCodeAt(18) !== 45
    || uuid.charCodeAt(23) !== 45
  ) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Invalid UUID format: "${String(uuid)}"`);
  }
  if (offset + 16 > dst.byteLength) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Destination buffer too small for UUID');
  }
  let sPos = 0;
  for (let b = 0; b < 16; b++) {
    if (sPos === 8 || sPos === 13 || sPos === 18 || sPos === 23) sPos++;
    const hi = hexNibble(uuid.charCodeAt(sPos));
    const lo = hexNibble(uuid.charCodeAt(sPos + 1));
    if (hi < 0 || lo < 0) {
      throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Invalid hex byte in UUID: "${uuid}"`);
    }
    dst[offset + b] = (hi << 4) | lo;
    sPos += 2;
  }
}

export function parseUuidBytes(uuid: string): Uint8Array {
  const out = new Uint8Array(16);
  parseUuidToBytesInto(uuid, out, 0);
  return out;
}

export function isNonZeroUuid(uuid: string | undefined | null): boolean {
  if (!uuid) return false;
  try {
    parseUuidToBytesInto(uuid.trim(), uuidBytesScratch, 0);
    return !isZeroUuidBytes(uuidBytesScratch, 0);
  } catch {
    return false;
  }
}

/** Deterministic Gateway confirm ClientOrderID (`dl-<request_id>`, 39 bytes <= 40, D3). */
export function formatConfirmClientOrderId(requestUuid: string): string {
  const normalized = requestUuid.trim().toLowerCase();
  parseUuidToBytesInto(normalized, uuidBytesScratch, 0);
  return `dl-${normalized}`;
}

function hasNonAsciiChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) >= 0x80) return true;
  }
  return false;
}

function encodeFixedUtf8FieldInto(
  dst: Uint8Array,
  offset: number,
  maxBytes: number,
  scratch: Uint8Array,
  value: string,
  uppercaseAscii: boolean,
  rejectNonAsciiOverflow: boolean,
): void {
  const [start, end] = trimAsciiBounds(value);
  if (end <= start) {
    dst.fill(0, offset, offset + maxBytes);
    return;
  }
  const trimmed = start === 0 && end === value.length ? value : value.slice(start, end);
  const { read, written } = utf8Encoder.encodeInto(trimmed, scratch);
  if (rejectNonAsciiOverflow && read < trimmed.length && hasNonAsciiChar(trimmed)) {
    throw new DealingWireCodecError(
      'INVALID_WIRE_FRAME',
      `Non-ASCII symbol exceeds ${maxBytes} UTF-8 bytes`,
    );
  }
  let zeroFill = false;
  for (let i = 0; i < maxBytes; i++) {
    if (zeroFill || i >= written) {
      dst[offset + i] = 0;
      continue;
    }
    let c = scratch[i];
    if (c === 0) {
      zeroFill = true;
      dst[offset + i] = 0;
      continue;
    }
    if (uppercaseAscii && c >= 97 && c <= 122) c -= 32; // a-z -> A-Z
    dst[offset + i] = c;
  }
}

function readFixedUtf8Field(
  src: Uint8Array,
  offset: number,
  maxBytes: number,
  scratch: Uint8Array,
  uppercaseAscii: boolean,
): string {
  let end = 0;
  let hasNonAscii = false;
  while (end < maxBytes) {
    const b = src[offset + end];
    if (b === 0) break;
    if (b >= 0x80) hasNonAscii = true;
    end++;
  }
  if (end === 0) return '';
  if (!hasNonAscii) {
    let out = '';
    for (let i = 0; i < end; i++) {
      let c = src[offset + i];
      if (uppercaseAscii && c >= 97 && c <= 122) c -= 32;
      out += String.fromCharCode(c);
    }
    return out;
  }
  for (let i = 0; i < end; i++) {
    let c = src[offset + i];
    if (uppercaseAscii && c >= 97 && c <= 122) c -= 32;
    scratch[i] = c;
  }
  return utf8DecoderLenient.decode(scratch.subarray(0, end));
}

/**
 * Encodes a symbol into a null-padded 16-byte slot with ASCII uppercase folding.
 *
 * Parity note vs Go `PackSymbol` (`wire_req.go:128`): Go copies raw bytes up to 16 bytes
 * blindly, which can slice mid-codepoint on multi-byte UTF-8. TypeScript uses
 * `TextEncoder.encodeInto` (code-point safe): ASCII symbols >16 bytes truncate identically
 * to Go, non-ASCII symbols <=16 UTF-8 bytes match Go byte-for-byte, and non-ASCII symbols
 * exceeding 16 UTF-8 bytes are rejected explicitly (real trading symbols are ASCII).
 */
export function writeNormalizedSymbol16(dst: Uint8Array, offset: number, symbol: string): void {
  encodeFixedUtf8FieldInto(
    dst,
    offset,
    WIRE_SYMBOL_MAX_BYTES,
    symbolWriteScratch,
    symbol,
    true,
    true,
  );
}

export function readNormalizedSymbol16(src: Uint8Array, offset: number): string {
  return readFixedUtf8Field(src, offset, WIRE_SYMBOL_MAX_BYTES, symbolReadScratch, true);
}

export function writeNormalizedClientOrderId40(dst: Uint8Array, offset: number, clientOrderId: string): void {
  encodeFixedUtf8FieldInto(
    dst,
    offset,
    WIRE_CLIENT_ORDER_ID_MAX_BYTES,
    coidWriteScratch,
    clientOrderId,
    false,
    false,
  );
}

export function readNormalizedClientOrderId40(src: Uint8Array, offset: number): string {
  return readFixedUtf8Field(src, offset, WIRE_CLIENT_ORDER_ID_MAX_BYTES, coidReadScratch, false);
}

export function dealingKindToString(kind: number): 'open' | 'close' | 'modify' | '' {
  if (kind === DEALING_KIND_OPEN) return 'open';
  if (kind === DEALING_KIND_CLOSE) return 'close';
  if (kind === DEALING_KIND_MODIFY) return 'modify';
  return '';
}

export function dealingSideToString(side: number): 'buy' | 'sell' | 'any' {
  if (side === WIRE_SIDE_BUY) return 'buy';
  if (side === WIRE_SIDE_SELL) return 'sell';
  return 'any';
}

export function dealingStatusToString(
  status: number,
): 'in_dealing' | 'requoted' | 'filled' | 'rejected' | 'expired' | 'cancelled' | '' {
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
      return '';
  }
}

// ─── Capability TLV 0x16 & 0x38 Extras Block ─────────────────────────────────

/**
 * Writes `[0x16][0x04][u32 LE caps]` into `dst` at `offset` (zero allocations).
 */
export function encodeClientCapsTlvInto(
  dst: Uint8Array,
  offset = 0,
  caps = CLIENT_CAP_DEALING_V1,
): number {
  if (offset + 6 > dst.byteLength) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Destination too small for TLV 0x16');
  }
  dst[offset] = WIRE_EXTRA_TAG_CLIENT_CAPS;
  dst[offset + 1] = 4;
  const view = new DataView(dst.buffer, dst.byteOffset + offset + 2, 4);
  view.setUint32(0, caps >>> 0, true);
  return 6;
}

/**
 * Returns the 6-byte TLV `0x16` entry (returns frozen zero-alloc singleton for `CLIENT_CAP_DEALING_V1`).
 */
export function encodeClientCapsTlv(caps = CLIENT_CAP_DEALING_V1): Uint8Array {
  if ((caps >>> 0) === CLIENT_CAP_DEALING_V1) {
    return CLIENT_CAPS_DEALING_V1_TLV;
  }
  const out = new Uint8Array(6);
  encodeClientCapsTlvInto(out, 0, caps);
  return out;
}

/**
 * Helper for Phase-B `binaryTcpOrderClient.ts` to ensure EVERY outgoing order carries TLV `0x16`.
 * - If `existingTlv` is empty, returns the zero-alloc `CLIENT_CAPS_DEALING_V1_TLV` singleton.
 * - If `existingTlv` already contains `0x16` with the same value, returns `existingTlv` unchanged.
 * - Otherwise returns `[existingTlv][0x16][4][caps u32 LE]` within `WIRE_ORDER_EXTRAS_MAX_BYTES`.
 */
export function appendClientCapsToExtrasTlv(
  existingTlv?: Uint8Array | null,
  caps = CLIENT_CAP_DEALING_V1,
): Uint8Array {
  const normalizedCaps = caps >>> 0;
  if (!existingTlv || existingTlv.byteLength === 0) {
    return encodeClientCapsTlv(normalizedCaps);
  }

  let pos = 0;
  let existingCapOffset = -1;
  while (pos < existingTlv.byteLength) {
    if (pos + 2 > existingTlv.byteLength) {
      throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated TLV header in extras');
    }
    const tag = existingTlv[pos];
    const len = existingTlv[pos + 1];
    pos += 2;
    if (pos + len > existingTlv.byteLength) {
      throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated TLV value in extras');
    }
    if (tag === WIRE_EXTRA_TAG_CLIENT_CAPS) {
      if (len !== 4) {
        throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid TLV 0x16 length');
      }
      if (existingCapOffset >= 0) {
        throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Duplicate TLV 0x16 in extras');
      }
      existingCapOffset = pos;
    }
    pos += len;
  }

  if (existingCapOffset >= 0) {
    const view = new DataView(existingTlv.buffer, existingTlv.byteOffset + existingCapOffset, 4);
    if (view.getUint32(0, true) === normalizedCaps) {
      return existingTlv;
    }
    const copy = new Uint8Array(existingTlv.byteLength);
    copy.set(existingTlv);
    new DataView(copy.buffer, copy.byteOffset + existingCapOffset, 4).setUint32(0, normalizedCaps, true);
    return copy;
  }

  const totalLen = existingTlv.byteLength + 6;
  if (totalLen > WIRE_ORDER_EXTRAS_MAX_BYTES) {
    throw new DealingWireCodecError(
      'WIRE_FRAME_TOO_LARGE',
      `Order extras TLV (${totalLen}) exceeds ${WIRE_ORDER_EXTRAS_MAX_BYTES} bytes`,
    );
  }

  const out = new Uint8Array(totalLen);
  out.set(existingTlv, 0);
  encodeClientCapsTlvInto(out, existingTlv.byteLength, normalizedCaps);
  return out;
}

interface ComputedReqExtrasLayout {
  commentBytes: Uint8Array;
  hasMagic: boolean;
  magicBig: bigint;
  hasTrailingStop: boolean;
  trailingStop: number;
  hasTrailingStep: boolean;
  trailingStep: number;
  hasReason: boolean;
  reason: number;
  hasFilling: boolean;
  filling: number;
  hasPriceDeviation: boolean;
  priceDeviationBig: bigint;
  hasRequestUuid: boolean;
  requestUuid: string;
  hasRequoteUuid: boolean;
  requoteUuid: string;
  hasClientCaps: boolean;
  clientCaps: number;
  payloadLen: number;
}

function measureReqExtras(ex: WireReqExtrasInput): ComputedReqExtrasLayout {
  let payloadLen = 0;

  let commentBytes: Uint8Array = EMPTY_BYTES;
  if (ex.comment && ex.comment.length > 0) {
    commentBytes = utf8Encoder.encode(ex.comment);
    if (commentBytes.byteLength > WIRE_ORDER_COMMENT_MAX_BYTES) {
      throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Comment exceeds 64 UTF-8 bytes');
    }
    for (let i = 0; i < commentBytes.byteLength; i++) {
      if (commentBytes[i] === 0) {
        throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Comment must not contain NUL bytes');
      }
    }
    payloadLen += 2 + commentBytes.byteLength;
  }

  let hasMagic = false;
  let magicBig = 0n;
  if (ex.magic !== undefined && ex.magic !== 0 && ex.magic !== 0n) {
    magicBig = typeof ex.magic === 'bigint' ? ex.magic : BigInt(Math.trunc(ex.magic));
    hasMagic = true;
    payloadLen += 2 + WIRE_ORDER_MAGIC_BYTE_LEN;
  }

  const hasTrailingStop = Boolean(ex.hasTrailingStop);
  const trailingStop = ex.trailingStop ?? 0;
  if (hasTrailingStop) {
    if (!Number.isInteger(trailingStop) || trailingStop < 0 || trailingStop > WIRE_ORDER_TRAILING_MAX_POINTS) {
      throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid trailing stop points');
    }
    payloadLen += 6;
  }

  const hasTrailingStep = Boolean(ex.hasTrailingStep);
  const trailingStep = ex.trailingStep ?? 0;
  if (hasTrailingStep) {
    if (!Number.isInteger(trailingStep) || trailingStep < 0 || trailingStep > WIRE_ORDER_TRAILING_MAX_POINTS) {
      throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid trailing step points');
    }
    payloadLen += 6;
  }

  const hasReason = Boolean(ex.hasReason);
  const reason = ex.reason ?? 0;
  if (hasReason) {
    if (!Number.isInteger(reason) || reason < 0 || reason > 255) {
      throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid reason code');
    }
    payloadLen += 3;
  }

  const hasFilling = Boolean(ex.hasFilling);
  const filling = ex.filling ?? 0;
  if (hasFilling) {
    if (!Number.isInteger(filling) || filling < 0 || filling > WIRE_ORDER_FILLING_MAX) {
      throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid filling mode');
    }
    payloadLen += 3;
  }

  const hasPriceDeviation = Boolean(ex.hasPriceDeviation);
  const priceDeviationBig = hasPriceDeviation
    ? (typeof ex.priceDeviation === 'bigint' ? ex.priceDeviation : BigInt(Math.trunc(ex.priceDeviation ?? 0)))
    : 0n;
  if (hasPriceDeviation) {
    payloadLen += 10;
  }

  const requestUuid = ex.dealingRequestUuid?.trim() ?? '';
  const hasRequestUuid = requestUuid.length > 0;
  if (hasRequestUuid) {
    parseUuidToBytesInto(requestUuid, uuidBytesScratch, 0);
    if (!isZeroUuidBytes(uuidBytesScratch, 0)) {
      payloadLen += 18;
    } else {
      throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'DealingRequestUUID cannot be all-zero');
    }
  }

  const requoteUuid = ex.dealingRequoteUuid?.trim() ?? '';
  const hasRequoteUuid = requoteUuid.length > 0;
  if (hasRequoteUuid) {
    parseUuidToBytesInto(requoteUuid, uuidBytesScratch, 0);
    if (!isZeroUuidBytes(uuidBytesScratch, 0)) {
      payloadLen += 18;
    } else {
      throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'DealingRequoteUUID cannot be all-zero');
    }
  }

  const clientCaps = (ex.clientCaps ?? 0) >>> 0;
  const hasClientCaps = Boolean(ex.hasClientCaps) || clientCaps !== 0;
  if (hasClientCaps) {
    payloadLen += 6;
  }

  if (payloadLen === 0 || payloadLen > WIRE_ORDER_EXTRAS_MAX_BYTES) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Extras payload length out of bounds: ${payloadLen}`);
  }

  return {
    commentBytes,
    hasMagic,
    magicBig,
    hasTrailingStop,
    trailingStop,
    hasTrailingStep,
    trailingStep,
    hasReason,
    reason,
    hasFilling,
    filling,
    hasPriceDeviation,
    priceDeviationBig,
    hasRequestUuid,
    requestUuid,
    hasRequoteUuid,
    requoteUuid,
    hasClientCaps,
    clientCaps,
    payloadLen,
  };
}

function writeReqExtrasMeasured(dst: Uint8Array, offset: number, layout: ComputedReqExtrasLayout): number {
  const totalBytes = 2 + layout.payloadLen;
  if (offset + totalBytes > dst.byteLength) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Destination buffer too small for extras block');
  }
  const view = new DataView(dst.buffer, dst.byteOffset + offset, totalBytes);
  view.setUint16(0, layout.payloadLen, true);
  let pos = 2;

  if (layout.commentBytes.byteLength > 0) {
    dst[offset + pos] = WIRE_EXTRA_TAG_COMMENT;
    dst[offset + pos + 1] = layout.commentBytes.byteLength;
    dst.set(layout.commentBytes, offset + pos + 2);
    pos += 2 + layout.commentBytes.byteLength;
  }
  if (layout.hasMagic) {
    dst[offset + pos] = WIRE_EXTRA_TAG_MAGIC;
    dst[offset + pos + 1] = WIRE_ORDER_MAGIC_BYTE_LEN;
    view.setBigInt64(pos + 2, layout.magicBig, true);
    pos += 10;
  }
  if (layout.hasTrailingStop) {
    dst[offset + pos] = WIRE_EXTRA_TAG_TRAILING_STOP;
    dst[offset + pos + 1] = 4;
    view.setUint32(pos + 2, layout.trailingStop >>> 0, true);
    pos += 6;
  }
  if (layout.hasTrailingStep) {
    dst[offset + pos] = WIRE_EXTRA_TAG_TRAILING_STEP;
    dst[offset + pos + 1] = 4;
    view.setUint32(pos + 2, layout.trailingStep >>> 0, true);
    pos += 6;
  }
  if (layout.hasReason) {
    dst[offset + pos] = WIRE_EXTRA_TAG_REASON;
    dst[offset + pos + 1] = 1;
    dst[offset + pos + 2] = layout.reason & 0xff;
    pos += 3;
  }
  if (layout.hasFilling) {
    dst[offset + pos] = WIRE_EXTRA_TAG_FILLING;
    dst[offset + pos + 1] = 1;
    dst[offset + pos + 2] = layout.filling & 0xff;
    pos += 3;
  }
  if (layout.hasPriceDeviation) {
    dst[offset + pos] = WIRE_EXTRA_TAG_PRICE_DEVIATION;
    dst[offset + pos + 1] = 8;
    view.setBigUint64(pos + 2, layout.priceDeviationBig, true);
    pos += 10;
  }
  if (layout.hasRequestUuid) {
    dst[offset + pos] = WIRE_EXTRA_TAG_DEALING_REQUEST_UUID;
    dst[offset + pos + 1] = 16;
    parseUuidToBytesInto(layout.requestUuid, dst, offset + pos + 2);
    pos += 18;
  }
  if (layout.hasRequoteUuid) {
    dst[offset + pos] = WIRE_EXTRA_TAG_DEALING_REQUOTE_UUID;
    dst[offset + pos + 1] = 16;
    parseUuidToBytesInto(layout.requoteUuid, dst, offset + pos + 2);
    pos += 18;
  }
  if (layout.hasClientCaps) {
    dst[offset + pos] = WIRE_EXTRA_TAG_CLIENT_CAPS;
    dst[offset + pos + 1] = 4;
    view.setUint32(pos + 2, layout.clientCaps >>> 0, true);
  }
  return totalBytes;
}

export function encodeReqExtrasBlockInto(dst: Uint8Array, offset: number, ex: WireReqExtrasInput): number {
  const layout = measureReqExtras(ex);
  return writeReqExtrasMeasured(dst, offset, layout);
}

export function encodeReqExtrasBlock(ex: WireReqExtrasInput): Uint8Array {
  const layout = measureReqExtras(ex);
  const out = new Uint8Array(2 + layout.payloadLen);
  writeReqExtrasMeasured(out, 0, layout);
  return out;
}

/**
 * Decodes `[u16 LE extrasLen][TLV entries]` into `out`, skipping unknown TLV tags
 * and rejecting truncated frames or duplicate tags (`wire_codec.go:436-563`).
 */
export function decodeReqExtrasBlockInto(
  block: Uint8Array,
  out: DecodedWireReqExtras,
  offset = 0,
): number {
  resetExtras(out);
  const available = block.byteLength - offset;
  if (available < 2) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated extras block header');
  }
  const blockView = new DataView(block.buffer, block.byteOffset + offset, available);
  const extrasLen = blockView.getUint16(0, true);
  if (extrasLen <= 0 || extrasLen > WIRE_ORDER_EXTRAS_MAX_BYTES) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Invalid extras block length: ${extrasLen}`);
  }
  const totalBytes = 2 + extrasLen;
  if (available < totalBytes) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated extras TLV payload');
  }

  seenTagsScratch.fill(0);
  let pos = 2;
  while (pos < totalBytes) {
    if (pos + 2 > totalBytes) {
      throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated TLV tag header');
    }
    const tag = block[offset + pos];
    const valLen = block[offset + pos + 1];
    pos += 2;
    if (pos + valLen > totalBytes) {
      throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated TLV tag value');
    }
    const word = tag >>> 5;
    const bit = 1 << (tag & 31);
    if ((seenTagsScratch[word] & bit) !== 0) {
      throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Duplicate TLV tag 0x${tag.toString(16)}`);
    }
    seenTagsScratch[word] |= bit;

    const valStart = offset + pos;
    pos += valLen;

    switch (tag) {
      case WIRE_EXTRA_TAG_COMMENT: {
        if (valLen < 1 || valLen > WIRE_ORDER_COMMENT_MAX_BYTES) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid comment TLV length');
        }
        for (let i = 0; i < valLen; i++) {
          if (block[valStart + i] === 0) {
            throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Comment TLV contains NUL byte');
          }
        }
        try {
          out.comment = utf8Decoder.decode(block.subarray(valStart, valStart + valLen));
        } catch {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Comment TLV contains invalid UTF-8');
        }
        break;
      }
      case WIRE_EXTRA_TAG_MAGIC: {
        if (valLen !== WIRE_ORDER_MAGIC_BYTE_LEN) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid magic TLV length');
        }
        const m = Number(blockView.getBigInt64(valStart - offset, true));
        if (m === 0) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Magic TLV must be non-zero');
        }
        out.magic = m;
        break;
      }
      case WIRE_EXTRA_TAG_TRAILING_STOP: {
        if (valLen !== 4) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid trailing stop TLV length');
        }
        const v = blockView.getUint32(valStart - offset, true);
        if (v > WIRE_ORDER_TRAILING_MAX_POINTS) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Trailing stop exceeds max points');
        }
        out.trailingStop = v;
        out.hasTrailingStop = true;
        break;
      }
      case WIRE_EXTRA_TAG_TRAILING_STEP: {
        if (valLen !== 4) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid trailing step TLV length');
        }
        const v = blockView.getUint32(valStart - offset, true);
        if (v > WIRE_ORDER_TRAILING_MAX_POINTS) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Trailing step exceeds max points');
        }
        out.trailingStep = v;
        out.hasTrailingStep = true;
        break;
      }
      case WIRE_EXTRA_TAG_ACTIVATION_FLAGS: {
        if (valLen !== 4 || blockView.getUint32(valStart - offset, true) !== 0) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid activation flags TLV');
        }
        break;
      }
      case WIRE_EXTRA_TAG_REASON: {
        if (valLen !== 1) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid reason TLV length');
        }
        out.reason = block[valStart];
        out.hasReason = true;
        out.isExpert = out.reason === ORDER_REASON_EXPERT;
        break;
      }
      case WIRE_EXTRA_TAG_FILLING: {
        if (valLen !== 1 || block[valStart] > WIRE_ORDER_FILLING_MAX) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid filling TLV');
        }
        out.filling = block[valStart];
        out.hasFilling = true;
        break;
      }
      case WIRE_EXTRA_TAG_PRICE_DEVIATION: {
        if (valLen !== 8) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid price deviation TLV length');
        }
        out.priceDeviation = Number(blockView.getBigUint64(valStart - offset, true));
        out.hasPriceDeviation = true;
        break;
      }
      case WIRE_EXTRA_TAG_DEALING_REQUEST_UUID: {
        if (valLen !== 16) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid dealing request UUID length');
        }
        out.dealingRequestUuid = formatUuidBytes(block, valStart);
        out.hasDealingRequest = true;
        break;
      }
      case WIRE_EXTRA_TAG_DEALING_REQUOTE_UUID: {
        if (valLen !== 16) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid dealing requote UUID length');
        }
        out.dealingRequoteUuid = formatUuidBytes(block, valStart);
        out.hasDealingRequote = true;
        break;
      }
      case WIRE_EXTRA_TAG_CLIENT_CAPS: {
        if (valLen !== 4) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid client caps TLV length');
        }
        out.clientCaps = blockView.getUint32(valStart - offset, true);
        out.hasClientCaps = true;
        out.hasDealingCap = (out.clientCaps & CLIENT_CAP_DEALING_V1) !== 0;
        break;
      }
      default:
        // Forward-compatible skip for unknown TLV tags.
        break;
    }
  }
  return totalBytes;
}

export function decodeReqExtrasBlock(
  block: Uint8Array,
  offset = 0,
): { extras: DecodedWireReqExtras; bytesRead: number } {
  const extras = createEmptyExtras();
  const bytesRead = decodeReqExtrasBlockInto(block, extras, offset);
  return { extras, bytesRead };
}

// ─── 0x38 Requote Actions 9 & 10 Codec (D4, §9.4) ───────────────────────────

export function validateRequoteActionReq(req: WireRequoteActionReqInput): void {
  if (req.action !== WIRE_ACTION_REQUOTE_ACCEPT && req.action !== WIRE_ACTION_REQUOTE_DECLINE) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Unsupported requote action: ${req.action}`);
  }
  const side = req.side ?? WIRE_SIDE_NONE;
  if (!Number.isInteger(side) || side < WIRE_SIDE_NONE || side > WIRE_SIDE_SELL) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Invalid side: ${side}`);
  }
  const login = req.accountLogin;
  if (!Number.isSafeInteger(login) || login <= 0) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'AccountLogin must be a positive integer');
  }
  if ((req.ticket ?? 0) !== 0 || (req.expiration ?? 0) !== 0) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Ticket and Expiration must both be 0 on Actions 9/10');
  }
  const volume = req.volume ?? 0;
  if (!Number.isFinite(volume) || volume < 0) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Volume must be finite and >= 0');
  }
  const price = req.price ?? 0;
  if (!Number.isFinite(price) || price < 0) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Price must be finite and >= 0');
  }
  if (req.action === WIRE_ACTION_REQUOTE_ACCEPT) {
    if (!(price > 0)) {
      throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Action 9 (Accept) requires Price > 0');
    }
  } else if (price !== 0) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Action 10 (Decline) requires Price === 0');
  }
  if (!isNonZeroUuid(req.requestId)) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Valid non-zero RequestUUID (TLV 0x14) is required');
  }
  if (!isNonZeroUuid(req.requoteId)) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Valid non-zero RequoteUUID (TLV 0x15) is required');
  }
}

function buildRequoteExtrasInput(req: WireRequoteActionReqInput): WireReqExtrasInput {
  const merged: WireReqExtrasInput = {
    ...(req.extras ?? {}),
    dealingRequestUuid: req.requestId,
    dealingRequoteUuid: req.requoteId,
  };
  if (req.reason !== undefined) {
    merged.reason = req.reason;
    merged.hasReason = true;
  }
  if (req.clientCaps !== undefined) {
    merged.clientCaps = req.clientCaps;
    merged.hasClientCaps = true;
  } else if (!merged.hasClientCaps && merged.clientCaps === undefined) {
    merged.clientCaps = CLIENT_CAP_DEALING_V1;
    merged.hasClientCaps = true;
  }
  return merged;
}

/**
 * Encodes a 0x38 Action 9 (Accept) or Action 10 (Decline) frame (`[128B Header][u16 tokenLen][token][u16 extrasLen][TLVs]`).
 * Exact byte parity with Go `AppendRequoteActionFrame` (`wire_codec.go:613-657`).
 */
export function encodeRequoteActionFrameInto(
  dst: Uint8Array,
  offset: number,
  req: WireRequoteActionReqInput,
): number {
  validateRequoteActionReq(req);
  const extrasLayout = measureReqExtras(buildRequoteExtrasInput(req));
  const tokenStr = req.authToken ?? '';
  const tokenBytes = tokenStr.length > 0 ? utf8Encoder.encode(tokenStr) : EMPTY_BYTES;
  if (tokenBytes.byteLength > WIRE_RTO_MAX_PAYLOAD_BYTES) {
    throw new DealingWireCodecError('WIRE_FRAME_TOO_LARGE', 'AuthToken exceeds 65535 bytes');
  }
  const totalBytes = WIRE_ORDER_REQ_HEADER_SIZE + 2 + tokenBytes.byteLength + 2 + extrasLayout.payloadLen;
  if (offset + totalBytes > dst.byteLength) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Destination buffer too small for 0x38 frame');
  }

  dst.fill(0, offset, offset + WIRE_ORDER_REQ_HEADER_SIZE);
  const view = new DataView(dst.buffer, dst.byteOffset + offset, totalBytes);
  dst[offset + 0] = WIRE_ORDER_CODEC_VERSION;
  dst[offset + 1] = req.action & 0xff;
  dst[offset + 2] = (req.side ?? WIRE_SIDE_NONE) & 0xff;
  dst[offset + 3] = (req.orderSubType ?? 0) & 0xff;
  view.setUint16(4, ((req.flags ?? 0) | WIRE_FLAG_HAS_EXTRAS) & 0xffff, true);
  view.setUint16(6, 0, true);
  view.setBigInt64(8, BigInt(Math.trunc(req.accountLogin)), true);
  view.setBigInt64(16, 0n, true); // Ticket MUST be 0 (D4)
  view.setFloat64(24, req.volume ?? 0, true);
  view.setFloat64(32, req.price ?? 0, true);
  view.setFloat64(40, 0, true); // StopLimitPrice
  view.setFloat64(48, 0, true); // SL
  view.setFloat64(56, 0, true); // TP
  view.setBigInt64(64, 0n, true); // Expiration MUST be 0 (D4)
  writeNormalizedSymbol16(dst, offset + 72, req.symbol ?? '');
  writeNormalizedClientOrderId40(dst, offset + 88, req.clientOrderId ?? '');

  view.setUint16(128, tokenBytes.byteLength, true);
  if (tokenBytes.byteLength > 0) {
    dst.set(tokenBytes, offset + 130);
  }
  writeReqExtrasMeasured(dst, offset + 130 + tokenBytes.byteLength, extrasLayout);
  return totalBytes;
}

export function encodeRequoteActionFrame(req: WireRequoteActionReqInput): Uint8Array {
  validateRequoteActionReq(req);
  const extrasLayout = measureReqExtras(buildRequoteExtrasInput(req));
  const tokenStr = req.authToken ?? '';
  const tokenBytes = tokenStr.length > 0 ? utf8Encoder.encode(tokenStr) : EMPTY_BYTES;
  if (tokenBytes.byteLength > WIRE_RTO_MAX_PAYLOAD_BYTES) {
    throw new DealingWireCodecError('WIRE_FRAME_TOO_LARGE', 'AuthToken exceeds 65535 bytes');
  }
  const totalBytes = WIRE_ORDER_REQ_HEADER_SIZE + 2 + tokenBytes.byteLength + 2 + extrasLayout.payloadLen;
  const out = new Uint8Array(totalBytes);
  encodeRequoteActionFrameInto(out, 0, req);
  return out;
}

export function decodeRequoteActionFrameInto(
  payload: Uint8Array,
  out: DecodedWireRequoteActionReq,
): void {
  if (payload.byteLength < WIRE_ORDER_REQ_HEADER_SIZE + 2) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x38 requote action header');
  }
  const version = payload[0];
  if (version !== WIRE_ORDER_CODEC_VERSION) {
    throw new DealingWireCodecError('UNSUPPORTED_WIRE_VERSION', `Unsupported 0x38 version: ${version}`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const tokenLen = view.getUint16(128, true);
  const afterToken = WIRE_ORDER_REQ_HEADER_SIZE + 2 + tokenLen;
  if (payload.byteLength < afterToken) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x38 authToken');
  }

  out.version = version;
  out.action = payload[1];
  out.side = payload[2];
  out.orderSubType = payload[3];
  out.flags = view.getUint16(4, true);
  out.accountLogin = Number(view.getBigInt64(8, true));
  out.ticket = Number(view.getBigInt64(16, true));
  out.volume = view.getFloat64(24, true);
  out.price = view.getFloat64(32, true);
  out.stopLimitPrice = view.getFloat64(40, true);
  out.sl = view.getFloat64(48, true);
  out.tp = view.getFloat64(56, true);
  out.expiration = Number(view.getBigInt64(64, true));
  out.symbol = readNormalizedSymbol16(payload, 72);
  out.clientOrderId = readNormalizedClientOrderId40(payload, 88);
  out.authToken = tokenLen > 0 ? utf8Decoder.decode(payload.subarray(130, afterToken)) : '';

  if ((out.flags & WIRE_FLAG_HAS_EXTRAS) === 0) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Action 9/10 requires WIRE_FLAG_HAS_EXTRAS');
  }
  const consumed = decodeReqExtrasBlockInto(payload, out.extras, afterToken);
  if (afterToken + consumed !== payload.byteLength) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Trailing garbage after 0x38 extras block');
  }

  validateRequoteActionReq({
    action: out.action as typeof WIRE_ACTION_REQUOTE_ACCEPT | typeof WIRE_ACTION_REQUOTE_DECLINE,
    side: out.side,
    orderSubType: out.orderSubType,
    flags: out.flags,
    accountLogin: out.accountLogin,
    ticket: out.ticket,
    volume: out.volume,
    price: out.price,
    expiration: out.expiration,
    requestId: out.extras.hasDealingRequest ? out.extras.dealingRequestUuid : '',
    requoteId: out.extras.hasDealingRequote ? out.extras.dealingRequoteUuid : '',
  });
}

export function decodeRequoteActionFrame(payload: Uint8Array): DecodedWireRequoteActionReq {
  const out: DecodedWireRequoteActionReq = {
    version: 0,
    action: 0,
    side: 0,
    orderSubType: 0,
    flags: 0,
    accountLogin: 0,
    ticket: 0,
    volume: 0,
    price: 0,
    stopLimitPrice: 0,
    sl: 0,
    tp: 0,
    expiration: 0,
    symbol: '',
    clientOrderId: '',
    authToken: '',
    extras: createEmptyExtras(),
  };
  decodeRequoteActionFrameInto(payload, out);
  return out;
}

// ─── 0x39 Trailing ExecWire TLV Codec (0x20..0x29) ────────────────────────────

export function execWireTlvByteLength(w: ExecWireResultInput | null | undefined): number {
  if (!w) return 0;
  let n = WIRE_EXEC_WIRE_LEGACY_LEN; // 0x20(6) + 0x21(10) + 0x22(10) + 0x23(10) = 36
  if (isNonZeroUuid(w.requestId)) n += 18;
  if (w.expiresAtMs !== undefined && w.expiresAtMs !== 0) n += 10;
  if (w.serverNowMs !== undefined && w.serverNowMs !== 0) n += 10;
  if (w.dealingKind !== undefined && w.dealingKind !== 0) n += 3;
  if (isNonZeroUuid(w.requoteId)) n += 18;
  if (w.hasDigits || (w.digits !== undefined && w.digits > 0)) n += 3;
  if (w.hasDealingEnabled || w.dealingEnabled !== undefined) n += 3;
  return n;
}

export function encodeExecWireTlvInto(
  dst: Uint8Array,
  offset: number,
  w: ExecWireResultInput | null | undefined,
): number {
  if (!w) return 0;
  const needed = execWireTlvByteLength(w);
  if (offset + needed > dst.byteLength) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Destination too small for ExecWire TLVs');
  }
  const view = new DataView(dst.buffer, dst.byteOffset + offset, needed);
  let pos = 0;

  dst[offset + pos] = WIRE_RESP_TAG_RETCODE;
  dst[offset + pos + 1] = 4;
  view.setUint32(pos + 2, w.retcode >>> 0, true);
  pos += 6;

  dst[offset + pos] = WIRE_RESP_TAG_QUOTED_REQ_ID;
  dst[offset + pos + 1] = 8;
  view.setBigUint64(pos + 2, BigInt(Math.max(0, Math.trunc(w.quotedReqId ?? 0))), true);
  pos += 10;

  dst[offset + pos] = WIRE_RESP_TAG_DEALER_BID;
  dst[offset + pos + 1] = 8;
  view.setFloat64(pos + 2, w.dealerBid ?? 0, true);
  pos += 10;

  dst[offset + pos] = WIRE_RESP_TAG_DEALER_ASK;
  dst[offset + pos + 1] = 8;
  view.setFloat64(pos + 2, w.dealerAsk ?? 0, true);
  pos += 10;

  if (w.requestId && isNonZeroUuid(w.requestId)) {
    dst[offset + pos] = WIRE_RESP_TAG_REQUEST_UUID;
    dst[offset + pos + 1] = 16;
    parseUuidToBytesInto(w.requestId.trim(), dst, offset + pos + 2);
    pos += 18;
  }
  if (w.expiresAtMs !== undefined && w.expiresAtMs !== 0) {
    dst[offset + pos] = WIRE_RESP_TAG_EXPIRES_AT_MS;
    dst[offset + pos + 1] = 8;
    view.setBigInt64(pos + 2, BigInt(Math.trunc(w.expiresAtMs)), true);
    pos += 10;
  }
  if (w.serverNowMs !== undefined && w.serverNowMs !== 0) {
    dst[offset + pos] = WIRE_RESP_TAG_SERVER_NOW_MS;
    dst[offset + pos + 1] = 8;
    view.setBigInt64(pos + 2, BigInt(Math.trunc(w.serverNowMs)), true);
    pos += 10;
  }
  if (w.dealingKind !== undefined && w.dealingKind !== 0) {
    dst[offset + pos] = WIRE_RESP_TAG_DEALING_KIND;
    dst[offset + pos + 1] = 1;
    dst[offset + pos + 2] = w.dealingKind & 0xff;
    pos += 3;
  }
  if (w.requoteId && isNonZeroUuid(w.requoteId)) {
    dst[offset + pos] = WIRE_RESP_TAG_REQUOTE_UUID;
    dst[offset + pos + 1] = 16;
    parseUuidToBytesInto(w.requoteId.trim(), dst, offset + pos + 2);
    pos += 18;
  }
  if (w.hasDigits || (w.digits !== undefined && w.digits > 0)) {
    dst[offset + pos] = WIRE_RESP_TAG_DIGITS;
    dst[offset + pos + 1] = 1;
    dst[offset + pos + 2] = (w.digits ?? 0) & 0xff;
    pos += 3;
  }
  if (w.hasDealingEnabled || w.dealingEnabled !== undefined) {
    dst[offset + pos] = WIRE_RESP_TAG_DEALING_ENABLED;
    dst[offset + pos + 1] = 1;
    dst[offset + pos + 2] = w.dealingEnabled ? 1 : 0;
    pos += 3;
  }
  return pos;
}

export function encodeExecWireTlv(w: ExecWireResultInput | null | undefined): Uint8Array {
  const needed = execWireTlvByteLength(w);
  if (needed === 0) return EMPTY_BYTES;
  const out = new Uint8Array(needed);
  encodeExecWireTlvInto(out, 0, w);
  return out;
}

/**
 * Parses trailing 0x39 ExecWire TLVs (0x20..0x29) into `out`, skipping unknown tags.
 * Exact parity with Go `DecodeExecWireTLVInto` (`wire_codec.go:852-943`).
 */
export function decodeExecWireTlvInto(
  tail: Uint8Array,
  out: DecodedExecWireResult,
  offset = 0,
): void {
  resetExecWire(out);
  const len = tail.byteLength - offset;
  if (len <= 0) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Empty 0x39 ExecWire TLV tail');
  }
  const view = new DataView(tail.buffer, tail.byteOffset + offset, len);
  seenTagsScratch.fill(0);
  let pos = 0;

  while (pos < len) {
    if (pos + 2 > len) {
      throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x39 TLV header');
    }
    const tag = tail[offset + pos];
    const valLen = tail[offset + pos + 1];
    pos += 2;
    if (pos + valLen > len) {
      throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x39 TLV value');
    }
    const word = tag >>> 5;
    const bit = 1 << (tag & 31);
    if ((seenTagsScratch[word] & bit) !== 0) {
      throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Duplicate 0x39 TLV tag 0x${tag.toString(16)}`);
    }
    seenTagsScratch[word] |= bit;

    const valPos = pos;
    pos += valLen;

    switch (tag) {
      case WIRE_RESP_TAG_RETCODE: {
        if (valLen !== 4) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid ExecWire 0x20 length');
        }
        out.retcode = view.getUint32(valPos, true);
        break;
      }
      case WIRE_RESP_TAG_QUOTED_REQ_ID: {
        if (valLen !== 8) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid ExecWire 0x21 length');
        }
        out.quotedReqId = Number(view.getBigUint64(valPos, true));
        break;
      }
      case WIRE_RESP_TAG_DEALER_BID: {
        if (valLen !== 8) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid ExecWire 0x22 length');
        }
        out.dealerBid = view.getFloat64(valPos, true);
        break;
      }
      case WIRE_RESP_TAG_DEALER_ASK: {
        if (valLen !== 8) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid ExecWire 0x23 length');
        }
        out.dealerAsk = view.getFloat64(valPos, true);
        break;
      }
      case WIRE_RESP_TAG_REQUEST_UUID: {
        if (valLen !== 16) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid ExecWire 0x24 length');
        }
        out.requestId = formatUuidBytes(tail, offset + valPos);
        out.hasRequestUuid = true;
        break;
      }
      case WIRE_RESP_TAG_EXPIRES_AT_MS: {
        if (valLen !== 8) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid ExecWire 0x25 length');
        }
        out.expiresAtMs = Number(view.getBigInt64(valPos, true));
        out.hasExpiresAtMs = true;
        break;
      }
      case WIRE_RESP_TAG_SERVER_NOW_MS: {
        if (valLen !== 8) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid ExecWire 0x26 length');
        }
        out.serverNowMs = Number(view.getBigInt64(valPos, true));
        out.hasServerNowMs = true;
        break;
      }
      case WIRE_RESP_TAG_DEALING_KIND: {
        if (valLen !== 1) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid ExecWire 0x27 length');
        }
        out.dealingKind = tail[offset + valPos];
        out.hasDealingKind = true;
        break;
      }
      case WIRE_RESP_TAG_REQUOTE_UUID: {
        if (valLen !== 16) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid ExecWire 0x28 length');
        }
        out.requoteId = formatUuidBytes(tail, offset + valPos);
        out.hasRequoteUuid = true;
        break;
      }
      case WIRE_RESP_TAG_DIGITS: {
        if (valLen !== 1) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid ExecWire 0x29 length');
        }
        out.digits = tail[offset + valPos];
        out.hasDigits = true;
        break;
      }
      case WIRE_RESP_TAG_DEALING_ENABLED: {
        if (valLen !== 1) {
          throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid ExecWire 0x2A length');
        }
        out.dealingEnabled = tail[offset + valPos] === 1;
        out.hasDealingEnabled = true;
        break;
      }
      default:
        // Forward-compatible skip for unknown trailing TLV tags.
        break;
    }
  }
}

export function decodeExecWireTlv(tail: Uint8Array, offset = 0): DecodedExecWireResult {
  const out = createEmptyExecWire();
  decodeExecWireTlvInto(tail, out, offset);
  return out;
}

export function encodeOrderRespFrame(resp: WireOrderRespFrameInput): Uint8Array {
  const errCodeBytes = resp.errorCode ? utf8Encoder.encode(resp.errorCode) : EMPTY_BYTES;
  const msgBytes = resp.message ? utf8Encoder.encode(resp.message) : EMPTY_BYTES;
  const execLen = execWireTlvByteLength(resp.execWire);
  const total = WIRE_ORDER_RESP_HEADER_SIZE + 4 + errCodeBytes.byteLength + msgBytes.byteLength + execLen;
  if (total > WIRE_RTO_MAX_PAYLOAD_BYTES) {
    throw new DealingWireCodecError('WIRE_FRAME_TOO_LARGE', '0x39 response exceeds 65535 bytes');
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out[0] = WIRE_ORDER_CODEC_VERSION;
  out[1] = resp.action & 0xff;
  view.setUint16(2, resp.status & 0xffff, true);
  view.setUint32(4, (resp.execMicros ?? 0) >>> 0, true);
  view.setBigInt64(8, BigInt(Math.trunc(resp.orderTicket ?? 0)), true);
  view.setBigInt64(16, BigInt(Math.trunc(resp.positionTicket ?? 0)), true);
  view.setBigInt64(24, BigInt(Math.trunc(resp.dealTicket ?? 0)), true);
  view.setFloat64(32, resp.fillPrice ?? 0, true);
  view.setFloat64(40, resp.volume ?? 0, true);
  view.setFloat64(48, resp.profit ?? 0, true);
  view.setFloat64(56, resp.commission ?? 0, true);
  view.setFloat64(64, resp.sl ?? 0, true);
  view.setFloat64(72, resp.tp ?? 0, true);
  writeNormalizedSymbol16(out, 80, resp.symbol ?? '');
  writeNormalizedClientOrderId40(out, 96, resp.clientOrderId ?? '');

  view.setUint16(136, errCodeBytes.byteLength, true);
  if (errCodeBytes.byteLength > 0) {
    out.set(errCodeBytes, 138);
  }
  const msgLenOff = 138 + errCodeBytes.byteLength;
  view.setUint16(msgLenOff, msgBytes.byteLength, true);
  if (msgBytes.byteLength > 0) {
    out.set(msgBytes, msgLenOff + 2);
  }
  const msgEnd = msgLenOff + 2 + msgBytes.byteLength;
  if (execLen > 0 && resp.execWire) {
    encodeExecWireTlvInto(out, msgEnd, resp.execWire);
  }
  return out;
}

export function decodeOrderRespWithExecWire(input: ArrayBuffer | Uint8Array): DecodedOrderRespWithExecWire {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < WIRE_ORDER_RESP_HEADER_SIZE + 4) {
    throw new DealingWireCodecError(
      'TRUNCATED_WIRE_FRAME',
      `Truncated 0x39 response (${bytes.byteLength} < ${WIRE_ORDER_RESP_HEADER_SIZE + 4})`,
    );
  }
  if (bytes[0] !== WIRE_ORDER_CODEC_VERSION) {
    throw new DealingWireCodecError('UNSUPPORTED_WIRE_VERSION', `Unsupported 0x39 version: ${bytes[0]}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const errCodeLen = view.getUint16(136, true);
  if (bytes.byteLength < WIRE_ORDER_RESP_HEADER_SIZE + 4 + errCodeLen) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x39 errorCode');
  }
  const msgLenOff = 138 + errCodeLen;
  const msgLen = view.getUint16(msgLenOff, true);
  const msgEnd = msgLenOff + 2 + msgLen;
  if (bytes.byteLength < msgEnd) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x39 message');
  }

  const status = view.getUint16(2, true);
  let execWire: DecodedExecWireResult | null = null;
  if (msgEnd < bytes.byteLength) {
    execWire = createEmptyExecWire();
    decodeExecWireTlvInto(bytes, execWire, msgEnd);
  }

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
    errorCode: errCodeLen > 0 ? utf8Decoder.decode(bytes.subarray(138, 138 + errCodeLen)) : '',
    message: msgLen > 0 ? utf8Decoder.decode(bytes.subarray(msgLenOff + 2, msgEnd)) : '',
    msgEndOffset: msgEnd,
    execWire,
  };
}

/**
 * Helper for Phase-B `binaryTcpOrderClient.ts`: extracts optional trailing ExecWire TLVs
 * after `msgEnd` from an existing 0x39 packet, returning `null` if none are present.
 */
export function decodeOrderRespTrailingExecWire(
  input: ArrayBuffer | Uint8Array,
): DecodedExecWireResult | null {
  return decodeOrderRespWithExecWire(input).execWire;
}

// ─── 0x3A EventKind=7 BinaryDealingStatusEvent (216B Header + Strings) ───────

export function encodeDealingStatusEventInto(
  dst: Uint8Array,
  offset: number,
  ev: BinaryDealingStatusEventInput,
): number {
  const subVersion = ev.subVersion ?? WIRE_DEALING_EVENT_SUB_VERSION;
  if (subVersion === 0 || subVersion !== WIRE_DEALING_EVENT_SUB_VERSION) {
    throw new DealingWireCodecError('UNSUPPORTED_WIRE_VERSION', `Unsupported 0x3A Kind 7 subVersion: ${subVersion}`);
  }
  const side = ev.side ?? WIRE_SIDE_NONE;
  if (!Number.isInteger(side) || side < WIRE_SIDE_NONE || side > WIRE_SIDE_SELL) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Invalid 0x3A Kind 7 side: ${side}`);
  }
  const rcBytes = ev.reasonCode ? utf8Encoder.encode(ev.reasonCode) : EMPTY_BYTES;
  const rtBytes = ev.reasonText ? utf8Encoder.encode(ev.reasonText) : EMPTY_BYTES;
  if (rcBytes.byteLength > 255 || rtBytes.byteLength > MAX_REASON_TEXT_BYTES) {
    throw new DealingWireCodecError('WIRE_FRAME_TOO_LARGE', 'ReasonCode/ReasonText exceeds length cap');
  }
  const needed = WIRE_DEALING_EVENT_MIN_SIZE + rcBytes.byteLength + rtBytes.byteLength;
  if (needed > WIRE_TRADE_EVENT_MAX_BYTES) {
    throw new DealingWireCodecError('WIRE_FRAME_TOO_LARGE', 'DealingStatusEvent exceeds 65000 bytes');
  }
  if (offset + needed > dst.byteLength) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Destination buffer too small for DealingStatusEvent');
  }

  const view = new DataView(dst.buffer, dst.byteOffset + offset, needed);
  dst[offset + 0] = subVersion;
  dst[offset + 1] = ev.status & 0xff;
  dst[offset + 2] = (ev.kind ?? 0) & 0xff;
  dst[offset + 3] = side & 0xff;
  dst[offset + 4] = (ev.digits ?? 0) & 0xff;
  dst[offset + 5] = 0;
  dst[offset + 6] = 0;
  dst[offset + 7] = 0;
  view.setUint32(8, (ev.retcode ?? 0) >>> 0, true);
  view.setUint32(12, (ev.seq ?? 0) >>> 0, true);
  view.setBigUint64(16, BigInt(Math.max(0, Math.trunc(ev.quotedReqId ?? 0))), true);
  view.setBigInt64(24, BigInt(Math.trunc(ev.orderTicket ?? 0)), true);
  view.setBigInt64(32, BigInt(Math.trunc(ev.positionTicket ?? 0)), true);
  view.setBigInt64(40, BigInt(Math.trunc(ev.dealTicket ?? 0)), true);
  view.setFloat64(48, ev.volume ?? 0, true);
  view.setFloat64(56, ev.price ?? 0, true);
  view.setFloat64(64, ev.bid ?? 0, true);
  view.setFloat64(72, ev.ask ?? 0, true);
  view.setFloat64(80, ev.profit ?? 0, true);
  view.setFloat64(88, ev.commission ?? 0, true);
  view.setFloat64(96, ev.sl ?? 0, true);
  view.setFloat64(104, ev.tp ?? 0, true);
  view.setBigInt64(112, BigInt(Math.trunc(ev.expiresAtMs ?? 0)), true);
  view.setBigInt64(120, BigInt(Math.trunc(ev.serverNowMs ?? 0)), true);

  parseUuidToBytesInto(ev.requestId.trim(), dst, offset + 128);
  if (ev.requoteId && ev.requoteId.trim().length > 0) {
    parseUuidToBytesInto(ev.requoteId.trim(), dst, offset + 144);
  } else {
    dst.fill(0, offset + 144, offset + 160);
  }
  writeNormalizedSymbol16(dst, offset + 160, ev.symbol ?? '');
  writeNormalizedClientOrderId40(dst, offset + 176, ev.clientOrderId ?? '');

  dst[offset + 216] = rcBytes.byteLength;
  let pos = 217;
  if (rcBytes.byteLength > 0) {
    dst.set(rcBytes, offset + pos);
    pos += rcBytes.byteLength;
  }
  dst[offset + pos] = rtBytes.byteLength;
  pos += 1;
  if (rtBytes.byteLength > 0) {
    dst.set(rtBytes, offset + pos);
  }
  return needed;
}

export function encodeDealingStatusEvent(ev: BinaryDealingStatusEventInput): Uint8Array {
  const rcLen = ev.reasonCode ? utf8Encoder.encode(ev.reasonCode).byteLength : 0;
  const rtLen = ev.reasonText ? utf8Encoder.encode(ev.reasonText).byteLength : 0;
  if (rcLen > 255 || rtLen > MAX_REASON_TEXT_BYTES) {
    throw new DealingWireCodecError('WIRE_FRAME_TOO_LARGE', 'ReasonCode/ReasonText exceeds length cap');
  }
  const out = new Uint8Array(WIRE_DEALING_EVENT_MIN_SIZE + rcLen + rtLen);
  encodeDealingStatusEventInto(out, 0, ev);
  return out;
}

/**
 * Decodes `BinaryDealingStatusEvent` (`216`-byte LE header + `[u8 rcLen][rc][u8 rtLen][rt]`).
 * Exact parity with Go `DecodeDealingStatusEventZeroAlloc` (`wire_codec.go:1158-1218`).
 */
export function decodeDealingStatusEventInto(
  src: Uint8Array,
  out: DecodedBinaryDealingStatusEvent,
  offset = 0,
  length = src.byteLength - offset,
): void {
  resetDealingStatusEvent(out);
  if (offset < 0 || length < 0 || offset + length > src.byteLength || length < WIRE_DEALING_EVENT_MIN_SIZE) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x3A Kind 7 payload');
  }
  const subVersion = src[offset];
  if (subVersion !== WIRE_DEALING_EVENT_SUB_VERSION) {
    throw new DealingWireCodecError('UNSUPPORTED_WIRE_VERSION', `Unsupported 0x3A Kind 7 subVersion: ${subVersion}`);
  }
  const side = src[offset + 3];
  if (side > WIRE_SIDE_SELL) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Invalid 0x3A Kind 7 side: ${side}`);
  }
  const rcLen = src[offset + 216];
  if (length < WIRE_DEALING_EVENT_MIN_SIZE + rcLen) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x3A Kind 7 ReasonCode');
  }
  const rtLenOff = 217 + rcLen;
  const rtLen = src[offset + rtLenOff];
  if (rtLen > MAX_REASON_TEXT_BYTES) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', `ReasonText exceeds ${MAX_REASON_TEXT_BYTES} bytes: ${rtLen}`);
  }
  const total = rtLenOff + 1 + rtLen;
  if (length < total) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x3A Kind 7 ReasonText');
  }

  const view = new DataView(src.buffer, src.byteOffset + offset, length);
  out.subVersion = subVersion;
  out.status = src[offset + 1];
  out.kind = src[offset + 2];
  out.side = side;
  out.digits = src[offset + 4];
  out.retcode = view.getUint32(8, true);
  out.seq = view.getUint32(12, true);
  out.quotedReqId = Number(view.getBigUint64(16, true));
  out.orderTicket = Number(view.getBigInt64(24, true));
  out.positionTicket = Number(view.getBigInt64(32, true));
  out.dealTicket = Number(view.getBigInt64(40, true));
  out.volume = view.getFloat64(48, true);
  out.price = view.getFloat64(56, true);
  out.bid = view.getFloat64(64, true);
  out.ask = view.getFloat64(72, true);
  out.profit = view.getFloat64(80, true);
  out.commission = view.getFloat64(88, true);
  out.sl = view.getFloat64(96, true);
  out.tp = view.getFloat64(104, true);
  out.expiresAtMs = Number(view.getBigInt64(112, true));
  out.serverNowMs = Number(view.getBigInt64(120, true));
  out.requestId = formatUuidBytes(src, offset + 128);
  out.hasRequoteId = !isZeroUuidBytes(src, offset + 144);
  out.requoteId = out.hasRequoteId ? formatUuidBytes(src, offset + 144) : '';
  out.symbol = readNormalizedSymbol16(src, offset + 160);
  out.clientOrderId = readNormalizedClientOrderId40(src, offset + 176);
  out.reasonCode = rcLen > 0 ? utf8Decoder.decode(src.subarray(offset + 217, offset + 217 + rcLen)) : '';
  out.reasonText = rtLen > 0 ? utf8Decoder.decode(src.subarray(offset + rtLenOff + 1, offset + total)) : '';
}

export function decodeDealingStatusEvent(
  src: Uint8Array,
  offset = 0,
  length = src.byteLength - offset,
): DecodedBinaryDealingStatusEvent {
  const out = createEmptyDealingStatusEvent();
  decodeDealingStatusEventInto(src, out, offset, length);
  return out;
}

// ─── 0x3A Envelope Codec (EventKind = 7) ─────────────────────────────────────

export function encodeTradeEventKind7Envelope(
  accountLogin: number,
  timestampMs: number,
  channel: string,
  ev: BinaryDealingStatusEventInput,
): Uint8Array {
  const chBytes = channel.length > 0 ? utf8Encoder.encode(channel) : EMPTY_BYTES;
  const evBytes = encodeDealingStatusEvent(ev);
  const totalLen = WIRE_TRADE_EVENT_MIN_HEADER_SIZE + chBytes.byteLength + evBytes.byteLength;
  if (
    chBytes.byteLength > WIRE_TRADE_EVENT_MAX_BYTES
    || evBytes.byteLength > WIRE_TRADE_EVENT_MAX_BYTES
    || totalLen > WIRE_TRADE_EVENT_MAX_BYTES
  ) {
    throw new DealingWireCodecError('WIRE_FRAME_TOO_LARGE', '0x3A envelope exceeds 65000 bytes');
  }

  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = WIRE_TRADE_EVENT_VERSION;
  out[1] = WIRE_TRADE_EVENT_KIND_DEALING;
  view.setBigInt64(2, BigInt(Math.trunc(accountLogin)), true);
  view.setBigInt64(10, BigInt(Math.trunc(timestampMs)), true);
  view.setUint16(18, chBytes.byteLength, true);
  if (chBytes.byteLength > 0) {
    out.set(chBytes, 20);
  }
  const dataLenOff = 20 + chBytes.byteLength;
  view.setUint16(dataLenOff, evBytes.byteLength, true);
  out.set(evBytes, dataLenOff + 2);
  return out;
}

export function decodeTradeEventKind7EnvelopeIntoRange(
  src: Uint8Array,
  offset: number,
  length: number,
  out: DecodedTradeEventKind7Envelope,
): void {
  out.version = 0;
  out.eventKind = 0;
  out.accountLogin = 0;
  out.timestampMs = 0;
  out.channel = '';

  if (offset < 0 || length < 0 || offset + length > src.byteLength || length < WIRE_TRADE_EVENT_MIN_HEADER_SIZE) {
    resetDealingStatusEvent(out.event);
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x3A envelope header');
  }
  const version = src[offset];
  if (version !== WIRE_TRADE_EVENT_VERSION) {
    resetDealingStatusEvent(out.event);
    throw new DealingWireCodecError('UNSUPPORTED_WIRE_VERSION', `Unsupported 0x3A version: ${version}`);
  }
  const eventKind = src[offset + 1];
  if (eventKind !== WIRE_TRADE_EVENT_KIND_DEALING) {
    resetDealingStatusEvent(out.event);
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Expected 0x3A EventKind=7, got ${eventKind}`);
  }
  const view = new DataView(src.buffer, src.byteOffset + offset, length);
  const accountLogin = Number(view.getBigInt64(2, true));
  const timestampMs = Number(view.getBigInt64(10, true));
  const chLen = view.getUint16(18, true);
  if (length < WIRE_TRADE_EVENT_MIN_HEADER_SIZE + chLen) {
    resetDealingStatusEvent(out.event);
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x3A channel');
  }
  const channel = chLen > 0 ? utf8Decoder.decode(src.subarray(offset + 20, offset + 20 + chLen)) : '';
  const dataLen = view.getUint16(20 + chLen, true);
  const dataOff = 22 + chLen;
  if (length < dataOff + dataLen) {
    resetDealingStatusEvent(out.event);
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x3A Kind 7 data payload');
  }

  decodeDealingStatusEventInto(src, out.event, offset + dataOff, dataLen);
  out.version = version;
  out.eventKind = eventKind;
  out.accountLogin = accountLogin;
  out.timestampMs = timestampMs;
  out.channel = channel;
}

export function decodeTradeEventKind7EnvelopeInto(
  src: Uint8Array,
  out: DecodedTradeEventKind7Envelope,
): void {
  decodeTradeEventKind7EnvelopeIntoRange(src, 0, src.byteLength, out);
}

export function decodeTradeEventKind7Envelope(src: Uint8Array): DecodedTradeEventKind7Envelope {
  const out = createEmptyTradeEventKind7Envelope();
  decodeTradeEventKind7EnvelopeInto(src, out);
  return out;
}

// ─── 0x38 Action 11 DealingSync & 0x39 TLV 0x2A Helpers (D18) ────────────────

export interface DealingSyncFrameInput {
  accountLogin: number;
  authToken?: string | null;
  clientOrderId?: string;
}

export interface DecodedDealingSyncFrame {
  version: number;
  action: number;
  accountLogin: number;
  clientOrderId: string;
  authToken: string;
}

/**
 * Encodes a `0x38` Action 11 (`DealingSync`) capability probe + pull-sync frame (DECISIONS.md D18).
 * Carries only `AccountLogin` (plus optional `ClientOrderID` and auth token); zero symbol/volume/extras.
 */
export function encodeDealingSyncFrame(input: DealingSyncFrameInput): Uint8Array {
  const login = input.accountLogin;
  if (!Number.isSafeInteger(login) || login <= 0) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Action 11 (DealingSync) requires positive AccountLogin');
  }
  const tokStr = input.authToken ? input.authToken.trim() : '';
  const tokBytes = tokStr.length > 0 ? utf8Encoder.encode(tokStr) : EMPTY_BYTES;
  if (tokBytes.byteLength > WIRE_RTO_MAX_PAYLOAD_BYTES) {
    throw new DealingWireCodecError('WIRE_FRAME_TOO_LARGE', 'AuthToken exceeds 65535 bytes');
  }
  const totalBytes = WIRE_ORDER_REQ_HEADER_SIZE + 2 + tokBytes.byteLength;
  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = WIRE_ORDER_CODEC_VERSION;
  out[1] = WIRE_ACTION_DEALING_SYNC;
  view.setBigInt64(8, BigInt(login), true);
  if (input.clientOrderId) {
    writeNormalizedClientOrderId40(out, 88, input.clientOrderId);
  }
  view.setUint16(128, tokBytes.byteLength, true);
  if (tokBytes.byteLength > 0) {
    out.set(tokBytes, 130);
  }
  return out;
}

export function decodeDealingSyncFrame(payload: Uint8Array): DecodedDealingSyncFrame {
  if (payload.byteLength < WIRE_ORDER_REQ_HEADER_SIZE + 2) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x38 Action 11 frame');
  }
  if (payload[0] !== WIRE_ORDER_CODEC_VERSION) {
    throw new DealingWireCodecError('UNSUPPORTED_WIRE_VERSION', `Unsupported 0x38 version: ${payload[0]}`);
  }
  if (payload[1] !== WIRE_ACTION_DEALING_SYNC) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', `Expected Action 11, got ${payload[1]}`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const flags = view.getUint16(4, true);
  const accountLogin = Number(view.getBigInt64(8, true));
  const ticket = Number(view.getBigInt64(16, true));
  const volume = view.getFloat64(24, true);
  const symbol = readNormalizedSymbol16(payload, 72);
  if (flags !== 0 || !Number.isSafeInteger(accountLogin) || accountLogin <= 0 || ticket !== 0 || volume !== 0 || symbol !== '') {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Invalid Action 11 DealingSync header invariants');
  }
  const tokenLen = view.getUint16(128, true);
  const expectedLen = WIRE_ORDER_REQ_HEADER_SIZE + 2 + tokenLen;
  if (payload.byteLength < expectedLen) {
    throw new DealingWireCodecError('TRUNCATED_WIRE_FRAME', 'Truncated 0x38 Action 11 authToken');
  }
  if (payload.byteLength !== expectedLen) {
    throw new DealingWireCodecError('INVALID_WIRE_FRAME', 'Trailing bytes after Action 11 authToken');
  }
  return {
    version: payload[0],
    action: payload[1],
    accountLogin,
    clientOrderId: readNormalizedClientOrderId40(payload, 88),
    authToken: tokenLen > 0 ? utf8Decoder.decode(payload.subarray(130, expectedLen)) : '',
  };
}

/**
 * Encodes a minimal `0x39` Action 11 (`DealingSync`) server response carrying TLV `0x2A` (`[0x2A, 1, 1|0]`)
 * directly after `[errCode][message]` per `DECISIONS.md` D18.
 */
export function encodeDealingSyncRespFrame(opts: {
  status?: number;
  dealingEnabled?: boolean;
  errorCode?: string;
  message?: string;
  execMicros?: number;
} = {}): Uint8Array {
  const errBytes = opts.errorCode ? utf8Encoder.encode(opts.errorCode) : EMPTY_BYTES;
  const msgBytes = opts.message ? utf8Encoder.encode(opts.message) : EMPTY_BYTES;
  const hasFlag = opts.dealingEnabled !== undefined;
  const total = WIRE_ORDER_RESP_HEADER_SIZE + 4 + errBytes.byteLength + msgBytes.byteLength + (hasFlag ? 3 : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = WIRE_ORDER_CODEC_VERSION;
  out[1] = WIRE_ACTION_DEALING_SYNC;
  view.setUint16(2, (opts.status ?? WIRE_STATUS_OK) & 0xffff, true);
  view.setUint32(4, (opts.execMicros ?? 0) >>> 0, true);
  view.setUint16(136, errBytes.byteLength, true);
  if (errBytes.byteLength > 0) {
    out.set(errBytes, 138);
  }
  const msgLenOff = 138 + errBytes.byteLength;
  view.setUint16(msgLenOff, msgBytes.byteLength, true);
  if (msgBytes.byteLength > 0) {
    out.set(msgBytes, msgLenOff + 2);
  }
  if (hasFlag) {
    const tlvOff = msgLenOff + 2 + msgBytes.byteLength;
    out[tlvOff] = WIRE_RESP_TAG_DEALING_ENABLED;
    out[tlvOff + 1] = 1;
    out[tlvOff + 2] = opts.dealingEnabled ? 1 : 0;
  }
  return out;
}

// ─── 0x3B Account Subscription Frame Helper (D12 Reconnect Replay) ───────────

/**
 * Encodes `[AccountLogin:i64 LE][TokenLen:u16 LE][AuthToken UTF-8]` for `0x3B`
 * reconnect replay (D12: zero HTTP pending endpoint).
 */
export function encodeAccountSubFrame0x3B(accountLogin: number, authToken?: string | null): Uint8Array {
  const login = Number.isFinite(accountLogin) ? Math.trunc(accountLogin) : 0;
  const tok = authToken ? authToken.trim() : '';
  const tokBytes = tok.length > 0 ? utf8Encoder.encode(tok) : EMPTY_BYTES;
  const tokLen = Math.min(tokBytes.byteLength, 0xffff);
  const out = new Uint8Array(WIRE_ACCOUNT_SUB_HEADER_SIZE + tokLen);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setBigInt64(0, BigInt(login), true);
  view.setUint16(8, tokLen, true);
  if (tokLen > 0) {
    out.set(tokBytes.subarray(0, tokLen), WIRE_ACCOUNT_SUB_HEADER_SIZE);
  }
  return out;
}
