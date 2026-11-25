import { RTX5_WS_URL, buildApiV2WsUrl } from '../config/api';
import { getRuntimeBrokerConfiguration, isConfiguredBrokerEndpoint, isDesktopBackendTarget } from '../config/backendTarget.js';
import { isLocalViteDevServer } from '../config/localDevProxy';
import {
  binaryTcpMarketStream,
  type DecodedBinaryCandle,
  type DecodedBinaryTick,
  type DecodedBinaryTradeEvent,
} from '../services/binaryTcpMarketStream';
import {
  BINARY_ORDER_ACTION_CANCEL_PENDING,
  BINARY_ORDER_ACTION_CLOSE_POSITION,
  BINARY_ORDER_ACTION_MODIFY_PENDING,
  BINARY_ORDER_ACTION_MODIFY_POSITION,
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_ACTION_PLACE_PENDING,
  BINARY_ORDER_FLAG_CLEAR_SL,
  BINARY_ORDER_FLAG_CLEAR_TP,
  BINARY_ORDER_FLAG_HAS_EXPIRATION,
  BINARY_ORDER_FLAG_HAS_PRICE,
  BINARY_ORDER_FLAG_HAS_SL,
  BINARY_ORDER_FLAG_HAS_STOP_LIMIT,
  BINARY_ORDER_FLAG_HAS_TP,
  BINARY_ORDER_FLAG_PARTIAL_CLOSE,
  BINARY_ORDER_REQ_HEADER_SIZE,
  BINARY_ORDER_SIDE_BUY,
  BINARY_ORDER_SIDE_SELL,
  BINARY_ORDER_SUBTYPE_BUY_LIMIT,
  BINARY_ORDER_SUBTYPE_BUY_STOP,
  BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT,
  BINARY_ORDER_SUBTYPE_MARKET,
  BINARY_ORDER_SUBTYPE_SELL_LIMIT,
  BINARY_ORDER_SUBTYPE_SELL_STOP,
  BINARY_ORDER_SUBTYPE_SELL_STOP_LIMIT,
  BinaryTcpOrderError,
  bindBinaryTcpAccountSub,
  resolveModifyPendingExpiryType,
  resolvePlacePendingExpiryType,
  sendBinaryTcpOrder,
  type BinaryOrderSubType,
  type BinaryTcpOrderParams,
  type DecodedBinaryOrderResp,
} from '../services/binaryTcpOrderClient';
import {
  getAccessToken,
  getCommittedBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScopeKey,
  onCommittedBrokerAccountSessionScopeChange,
  onSessionChange,
} from '../services/brokerSession';
import {
  recordTradeOrderLatency,
  toTradeOrderTraceId,
  tradeOrderNow,
  type TradeOrderLatencyPhase,
} from '../services/orderLatencyTelemetry';
import type { PendingOrderType, Timeframe, TradeSocketChannel, TradeSocketMessage } from '../types/api';
import { getAuthToken, isStoredTokenExpired } from './client';

export type TradeSocketState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';
export type TradeSocketHandler<T = unknown> = (message: TradeSocketMessage<T>) => void;

export interface TradeSocketOptions {
  url?: string;
  token?: string;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  orderTimeoutMs?: number;
  maxOrderBufferedAmount?: number;
}

export interface TradeSocketPlaceOrderPayload {
  account_login: number;
  symbol: string;
  side: 'buy' | 'sell';
  type?: 'market';
  volume: number;
  sl?: number;
  tp?: number;
  price_sl?: number;
  price_tp?: number;
}

export interface TradeSocketOrderFillData {
  order_ticket?: number;
  position_ticket?: number;
  ticket?: number;
  deal_ticket?: number;
  account_login?: number;
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  quantity?: number;
  price: number;
  price_open?: number;
  open_price?: number;
  price_sl?: number;
  price_tp?: number;
  sl?: number;
  tp?: number;
  commission?: number;
  profit?: number;
  exec_micros?: number;
  status?: string;
  [key: string]: unknown;
}

export interface TradeSocketOrderFilled {
  type: 'order_filled';
  status: 'filled';
  success: true;
  ack_required?: boolean;
  request_id: string;
  client_order_id: string;
  data: TradeSocketOrderFillData;
  [key: string]: unknown;
}

export interface TradeSocketClosePositionOptions {
  volume?: number;
  account_login?: number;
  accountLogin?: number;
  client_order_id?: string;
  clientOrderId?: string;
  authToken?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TradeSocketClosePositionResult {
  ticket: number;
  position_id: string;
  position_ticket: number;
  deal_ticket: number;
  order_ticket: number;
  order_id?: string;
  price: number;
  fill_price: number;
  close_price: number;
  profit: number;
  commission: number;
  closed_volume: number;
  volume: number;
  symbol: string;
  client_order_id: string;
  exec_ms: number;
  execMicros: number;
  status: 'closed' | 'partial_closed';
}

export interface TradeSocketModifyPositionPayload {
  price_sl?: number | null;
  price_tp?: number | null;
  sl?: number | null;
  tp?: number | null;
  account_login?: number;
  accountLogin?: number;
  symbol?: string;
  side?: 'buy' | 'sell';
  volume?: number;
  open_price?: number;
  price_open?: number;
  client_order_id?: string;
  clientOrderId?: string;
  authToken?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TradeSocketPositionResult {
  id: string;
  ticket: number;
  account_login: number;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  volume: number;
  open_price: number;
  price_open: number;
  price_sl: number | null;
  price_tp: number | null;
  sl: number;
  tp: number;
  commission?: number;
  profit?: number;
  time_create?: number;
}

export interface TradeSocketPlacePendingOrderPayload {
  login?: number;
  account_login?: number;
  accountLogin?: number;
  symbol: string;
  side?: 'buy' | 'sell' | 'BUY' | 'SELL';
  type: PendingOrderType | Uppercase<PendingOrderType>;
  volume?: number;
  quantity?: number;
  price: number;
  price_limit?: number;
  stopLimitPrice?: number;
  price_sl?: number | null;
  price_tp?: number | null;
  sl?: number | null;
  tp?: number | null;
  expiration?: number | null;
  expiry?: number | null;
  expiryType?: number | null;
  expiry_type?: number | null;
  client_order_id?: string;
  clientOrderId?: string;
  authToken?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TradeSocketModifyPendingOrderPayload {
  price?: number;
  price_limit?: number | null;
  stopLimitPrice?: number | null;
  price_sl?: number | null;
  price_tp?: number | null;
  sl?: number | null;
  tp?: number | null;
  time_in_force?: 'GTC' | 'DAY' | 'GTD';
  expiration?: number | null;
  expiry?: number | null;
  expiryType?: number | null;
  expiry_type?: number | null;
  account_login?: number;
  accountLogin?: number;
  symbol?: string;
  side?: 'buy' | 'sell';
  type?: PendingOrderType;
  volume?: number;
  client_order_id?: string;
  clientOrderId?: string;
  authToken?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TradeSocketCancelOrderOptions {
  account_login?: number;
  accountLogin?: number;
  client_order_id?: string;
  clientOrderId?: string;
  authToken?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TradeSocketOrderResult {
  id: string;
  ticket: number;
  account_login: number;
  symbol: string;
  type: PendingOrderType;
  side: 'buy' | 'sell';
  quantity: number;
  volume: number;
  price: number;
  price_limit?: number | null;
  price_sl: number | null;
  price_tp: number | null;
  sl: number;
  tp: number;
  status: 'pending';
  created_at: string;
  time_create: number;
  client_order_id?: string;
}

interface PendingOrderRequest {
  resolve: (message: TradeSocketOrderFilled) => void;
  reject: (error: Error) => void;
  clientOrderId: string;
  sessionScope: string;
  accountLogin: number;
  symbol: string;
  timer: ReturnType<typeof setTimeout> | null;
  recoveryAttempted: boolean;
  intentAtMs: number;
  apiStartedAtMs: number;
  sendCompletedAtMs: number;
  acceptedAtMs: number | null;
  statusRecoverySentAtMs: number | null;
  serializationMs: number;
  sendCallMs: number;
  payloadBytes: number;
  bufferedAmountBefore: number;
  bufferedAmountAfter: number;
}

export interface TradeSocketOrderTimingContext {
  intentAtMs?: number;
  apiStartedAtMs?: number;
  sessionScope?: string;
}

interface TradeSocketErrorDetails {
  code?: string;
  requestId?: string;
  clientOrderId?: string;
  orderWasSent?: boolean;
  status?: 'rejected' | 'expired';
}

export class TradeSocketOrderRejectedError extends Error {
  readonly code?: string;
  readonly requestId?: string;
  readonly clientOrderId?: string;
  readonly status: 'rejected' | 'expired';
  readonly retryable = false;

  constructor(message: string, details: TradeSocketErrorDetails = {}) {
    super(message);
    this.name = 'TradeSocketOrderRejectedError';
    this.code = details.code;
    this.requestId = details.requestId;
    this.clientOrderId = details.clientOrderId;
    this.status = details.status ?? 'rejected';
  }
}

export class TradeSocketTransportError extends Error {
  readonly code?: string;
  readonly requestId?: string;
  readonly clientOrderId?: string;
  readonly orderWasSent: boolean;
  readonly retryable: boolean;

  constructor(message: string, details: TradeSocketErrorDetails = {}) {
    super(message);
    this.name = 'TradeSocketTransportError';
    this.code = details.code;
    this.requestId = details.requestId;
    this.clientOrderId = details.clientOrderId;
    this.orderWasSent = details.orderWasSent === true;
    // A create request is safe to move to REST only when the WebSocket frame
    // was definitely never enqueued. Once send() succeeds, an error or timeout
    // means execution is uncertain and creating again could duplicate a trade.
    this.retryable = !this.orderWasSent;
  }
}

const DEFAULT_RECONNECT_DELAY = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY = 15_000;
export const TRADE_WS_STABLE_OPEN_MS = 10_000;
export const TRADE_WS_KEEPALIVE_INTERVAL_MS = 20_000;
const RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_ORDER_TIMEOUT = 10_000;
// The order socket is dedicated and normally has no queued bytes. Allow up to
// 128 KiB so rapid 1-click order bursts stay on /ws/v2 instead of needlessly
// bailing out to the REST fallback.
const DEFAULT_MAX_ORDER_BUFFERED_AMOUNT = 128 * 1024;
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;
const DESKTOP_BINARY_TRADE_URL = 'binary-tcp://127.0.0.1/__rtx5_binary_stream';

const PENDING_ORDER_SUBTYPE_BY_NAME: Record<PendingOrderType, BinaryOrderSubType> = {
  buy_limit: BINARY_ORDER_SUBTYPE_BUY_LIMIT,
  sell_limit: BINARY_ORDER_SUBTYPE_SELL_LIMIT,
  buy_stop: BINARY_ORDER_SUBTYPE_BUY_STOP,
  sell_stop: BINARY_ORDER_SUBTYPE_SELL_STOP,
  buy_stop_limit: BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT,
  sell_stop_limit: BINARY_ORDER_SUBTYPE_SELL_STOP_LIMIT,
};

const BINARY_TRADE_EVENT_KIND_PREFIX: Record<number, string> = {
  1: 'positions',
  2: 'orders',
  3: 'account',
  4: 'metrics',
  5: 'deals',
  6: 'state',
};

const ACCOUNT_SCOPED_CHANNEL_PREFIXES = new Set([
  'positions',
  'orders',
  'account',
  'metrics',
  'deals',
  'state',
]);

const tradeSocketTarget = (value: string): URL | null => {
  try {
    const url = new URL(value);
    const proxyPrefix = '/__broker_feed_ws/';
    if (isLocalViteDevServer()
      && url.origin.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:') === window.location.origin
      && url.pathname.startsWith(proxyPrefix)) {
      const path = url.pathname.slice(proxyPrefix.length);
      const slash = path.indexOf('/');
      if (slash < 0) return null;
      return new URL(`${decodeURIComponent(path.slice(0, slash))}${path.slice(slash)}${url.search}`);
    }
    return url;
  } catch { return null; }
};

// URL credentials and an auth frame must both belong to the current deployment
// session. Recheck this when a delayed socket opens and before each send.
const isTradeSocketAllowed = (url: string, token: string | undefined, brokerId?: string): boolean => {
  if (isDesktopBackendTarget()) return true;
  const configuration = getRuntimeBrokerConfiguration();
  const activeToken = getAccessToken();
  const target = tradeSocketTarget(url);
  if (!configuration.valid || !activeToken || token !== activeToken || !target
    || (brokerId !== undefined && brokerId !== configuration.brokerId)
    || target.pathname !== '/ws/v2' || target.hash
    || !isConfiguredBrokerEndpoint(target.toString(), 'ws')) return false;
  const queryTokens = target.searchParams.getAll('token');
  return queryTokens.length <= 1 && (queryTokens.length === 0 || queryTokens[0] === activeToken);
};

const addReconnectJitter = (delay: number, maximum: number): number => {
  const jitter = Math.floor(delay * RECONNECT_JITTER_RATIO * Math.random());
  return Math.min(maximum, delay + jitter);
};

const RETRYABLE_ORDER_ERROR_CODES = new Set([
  'SERVICE_UNAVAILABLE',
  'BROKER_UNAVAILABLE',
  'EXECUTION_SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT',
  'REQUEST_TIMEOUT',
  'TRANSPORT_ERROR',
  'CONNECTION_ERROR',
]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const readNonEmptyString = (value: unknown): string | undefined => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
};

const readCorrelationId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const toPositiveSafeInteger = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
};

const extractAccountLoginFromChannel = (channel: string): number | undefined => {
  const trimmed = channel.trim();
  const dotIndex = trimmed.indexOf('.');
  if (dotIndex <= 0) return undefined;
  const prefix = trimmed.slice(0, dotIndex).toLowerCase();
  if (!ACCOUNT_SCOPED_CHANNEL_PREFIXES.has(prefix)) return undefined;
  const suffix = trimmed.slice(dotIndex + 1).trim();
  const lastSegment = suffix.includes('.') ? suffix.slice(suffix.lastIndexOf('.') + 1).trim() : suffix;
  return toPositiveSafeInteger(lastSegment);
};

const normalizeBinaryTradeEventChannel = (ev: DecodedBinaryTradeEvent): string => {
  const rawChannel = typeof ev.channel === 'string' ? ev.channel.trim() : '';
  const loginSuffix = Number.isSafeInteger(ev.accountLogin) && ev.accountLogin > 0
    ? String(ev.accountLogin)
    : '';

  if (rawChannel) {
    const cleaned = rawChannel.startsWith('rtx5.') ? rawChannel.slice('rtx5.'.length) : rawChannel;
    const dotIndex = cleaned.indexOf('.');
    const prefix = (dotIndex >= 0 ? cleaned.slice(0, dotIndex) : cleaned).toLowerCase();
    const rest = dotIndex >= 0 ? cleaned.slice(dotIndex + 1).trim() : '';
    const lastSegment = rest.includes('.') ? rest.slice(rest.lastIndexOf('.') + 1).trim() : rest;
    const resolvedLogin = lastSegment || loginSuffix;

    if (prefix === 'positions' || prefix === 'position') {
      return resolvedLogin ? `positions.${resolvedLogin}` : 'positions';
    }
    if (prefix === 'orders' || prefix === 'order' || prefix === 'pending_orders' || prefix === 'pending_order') {
      return resolvedLogin ? `orders.${resolvedLogin}` : 'orders';
    }
    if (prefix === 'account' || prefix === 'accounts') {
      return resolvedLogin ? `account.${resolvedLogin}` : 'account';
    }
    if (prefix === 'metrics' || prefix === 'metric') {
      return resolvedLogin ? `metrics.${resolvedLogin}` : 'metrics';
    }
    if (prefix === 'deals' || prefix === 'deal') {
      return resolvedLogin ? `deals.${resolvedLogin}` : 'deals';
    }
    if (prefix === 'state' || prefix === 'trades' || prefix === 'trade') {
      return resolvedLogin ? `state.${resolvedLogin}` : 'state';
    }
    return cleaned;
  }

  const kindPrefix = BINARY_TRADE_EVENT_KIND_PREFIX[ev.eventKind];
  if (kindPrefix) {
    return loginSuffix ? `${kindPrefix}.${loginSuffix}` : kindPrefix;
  }
  return '';
};

const toBinaryTradeSocketMessage = (ev: DecodedBinaryTradeEvent): TradeSocketMessage | null => {
  const channel = normalizeBinaryTradeEventChannel(ev);
  const payloadRecord = asRecord(ev.payload);
  const channelLogin = channel ? extractAccountLoginFromChannel(channel) : undefined;
  const headerLogin = Number.isSafeInteger(ev.accountLogin) && ev.accountLogin > 0
    ? ev.accountLogin
    : undefined;
  const resolvedLogin = channelLogin ?? headerLogin;
  const timestampMs = Number.isFinite(ev.timestampMs) && ev.timestampMs > 0
    ? ev.timestampMs
    : undefined;

  // Preserve outer /ws/v2 envelopes verbatim if payload was already pre-wrapped
  // as `{ channel: "...", data: ... }`.
  if (
    payloadRecord
    && typeof payloadRecord.channel === 'string'
    && payloadRecord.channel.trim().length > 0
    && Object.prototype.hasOwnProperty.call(payloadRecord, 'data')
  ) {
    const normalizedChannel = channel || payloadRecord.channel.trim();
    return {
      ...(payloadRecord as TradeSocketMessage),
      channel: normalizedChannel,
      ...(timestampMs !== undefined && payloadRecord.time === undefined ? { time: timestampMs } : {}),
      ...(resolvedLogin !== undefined && payloadRecord.account_login === undefined
        ? { account_login: resolvedLogin }
        : {}),
    };
  }

  // Normalize state.<login> payloads so `asRecord(asRecord(msg.data)?.data)?.entity`
  // works whether the NATS body is `{ type: "state_changed", data: { entity } }`
  // or a flat `{ entity }`.
  let normalizedPayload: unknown = ev.payload;
  if (
    channel.startsWith('state.')
    && payloadRecord
    && payloadRecord.data === undefined
    && typeof payloadRecord.entity === 'string'
  ) {
    normalizedPayload = {
      type: typeof payloadRecord.type === 'string' ? payloadRecord.type : 'state_changed',
      ...payloadRecord,
      data: { entity: payloadRecord.entity },
    };
  }

  const normalizedRecord = asRecord(normalizedPayload);
  const payloadType = readNonEmptyString(normalizedRecord?.type);
  const payloadEvent = readNonEmptyString(normalizedRecord?.event);

  if (!channel && normalizedPayload === undefined) {
    return null;
  }

  return {
    ...(channel ? { channel } : {}),
    ...(payloadType ? { type: payloadType } : {}),
    ...(payloadEvent ? { event: payloadEvent } : {}),
    ...(resolvedLogin !== undefined ? { account_login: resolvedLogin } : {}),
    ...(timestampMs !== undefined ? { time: timestampMs } : {}),
    data: normalizedPayload,
  };
};

const isBinaryTcpOrderErrorInstance = (error: unknown): error is BinaryTcpOrderError => (
  error instanceof BinaryTcpOrderError
  || Boolean(
    error
    && typeof error === 'object'
    && (error as { name?: unknown }).name === 'BinaryTcpOrderError'
    && typeof (error as { status?: unknown }).status === 'number',
  )
);

const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

const getUtf8ByteLength = (value: string): number => (
  utf8Encoder ? utf8Encoder.encode(value).byteLength : value.length
);

const readBufferedAmount = (socket: WebSocket | null): number => {
  const amount = Number(socket?.bufferedAmount ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
};

const normalizeEarlierMonotonicTime = (value: unknown, fallback: number): number => {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= 0 && candidate <= fallback
    ? candidate
    : fallback;
};

const createUuidV4Fallback = (): string => {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const createTradeOrderUuid = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return createUuidV4Fallback();
};

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isTradeOrderUuidV4 = (value: unknown): value is string =>
  typeof value === 'string' && UUID_V4_PATTERN.test(value.trim());

const isRetryableOrderErrorCode = (value: unknown): boolean => {
  const code = String(value ?? '').trim().toUpperCase();
  return RETRYABLE_ORDER_ERROR_CODES.has(code) || code === '503';
};

const readOrderError = (message: TradeSocketMessage): { code?: string; message: string } => {
  const record = message as Record<string, unknown>;
  const error = asRecord(record.error);
  const code = readNonEmptyString(error?.code ?? record.code);
  const detail = readNonEmptyString(error?.message)
    ?? readNonEmptyString(record.message)
    ?? readNonEmptyString(record.error)
    ?? 'Order rejected';
  return { code, message: detail };
};

/** The same terminal rules apply before and during cross-transport recovery. */
export const isTerminalTradeOrderMessage = (message: TradeSocketMessage): boolean => {
  const record = message as Record<string, unknown>;
  const type = String(record.type ?? '').trim().toLowerCase();
  if (type === 'order_filled') return Boolean(asRecord(record.data));
  if (type !== 'order_rejected') return false;
  if (String(record.status ?? '').trim().toLowerCase() === 'expired') return true;
  return !isRetryableOrderErrorCode(readOrderError(message).code);
};

export class TradeWebSocketClient {
  private ws: WebSocket | null = null;
  private binaryModeConnected = false;
  private unsubBinaryTradeEvents: (() => void) | null = null;
  private readonly binaryMarketUnsubs = new Map<string, () => void>();
  private lastSyncedBinaryAccountLogin: number | null = null;
  private state: TradeSocketState = 'idle';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private stableOpenTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnectPendingWhileHidden = false;
  private activeToken: string | undefined;
  private activeUrl: string | undefined;
  private activeBrokerId: string | undefined;
  private authFrameSent = false;
  private readonly channels = new Set<string>();
  private readonly handlers = new Map<string, Set<TradeSocketHandler>>();
  private readonly anyHandlers = new Set<TradeSocketHandler>();
  private readonly stateHandlers = new Set<(state: TradeSocketState) => void>();
  private readonly pendingOrders = new Map<string, PendingOrderRequest>();
  private readonly options: Required<Pick<
    TradeSocketOptions,
    'reconnect' | 'reconnectDelayMs' | 'maxReconnectDelayMs' | 'orderTimeoutMs' | 'maxOrderBufferedAmount'
  >> & TradeSocketOptions;

  constructor(options: TradeSocketOptions = {}) {
    this.options = {
      reconnect: true,
      reconnectDelayMs: DEFAULT_RECONNECT_DELAY,
      maxReconnectDelayMs: DEFAULT_MAX_RECONNECT_DELAY,
      orderTimeoutMs: DEFAULT_ORDER_TIMEOUT,
      maxOrderBufferedAmount: DEFAULT_MAX_ORDER_BUFFERED_AMOUNT,
      ...options,
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  get readyState(): number | undefined {
    if (isDesktopBackendTarget() || this.binaryModeConnected) {
      if (this.binaryModeConnected && this.state === 'open') return WS_OPEN;
      if (this.state === 'closed') return WS_CLOSED;
      return undefined;
    }
    return this.ws?.readyState;
  }

  get connectionState(): TradeSocketState {
    return this.state;
  }

  isReady(): boolean {
    return this.isReadyForOrders();
  }

  isConnected(): boolean {
    return this.isReadyForOrders();
  }

  isReadyForOrders(): boolean {
    if (isDesktopBackendTarget() || this.binaryModeConnected) {
      return isDesktopBackendTarget()
        && this.binaryModeConnected
        && this.state === 'open'
        && Boolean(this.activeToken)
        && this.authFrameSent
        && this.hasCurrentDeploymentConnection();
    }
    return this.ws?.readyState === WS_OPEN
      && this.state === 'open'
      && Boolean(this.activeToken)
      && this.authFrameSent
      && this.hasCurrentDeploymentConnection();
  }

  usesConnection(token: string, url: string): boolean {
    return this.activeToken === token && this.activeUrl === url;
  }

  connect(token = this.options.token || getAuthToken() || undefined): void {
    // Pure Binary TCP Desktop Mode: NEVER instantiate `new WebSocket(...)`.
    if (isDesktopBackendTarget()) {
      const normalizedToken = readNonEmptyString(token);
      if (
        this.binaryModeConnected
        && this.state === 'open'
        && this.activeToken === normalizedToken
        && this.unsubBinaryTradeEvents !== null
      ) {
        binaryTcpMarketStream.start();
        const subscribedLogin = this.resolveSubscribedAccountLogin();
        if (subscribedLogin !== undefined && subscribedLogin !== this.lastSyncedBinaryAccountLogin) {
          this.lastSyncedBinaryAccountLogin = subscribedLogin;
          this.syncBinaryAccountBinding(subscribedLogin);
        }
        return;
      }

      this.clearReconnectTimer();
      this.clearKeepaliveTimer();
      this.clearStableOpenTimer();
      this.reconnectPendingWhileHidden = false;
      this.reconnectAttempts = 0;

      const straySocket = this.ws;
      this.ws = null;
      if (straySocket && typeof straySocket.close === 'function') {
        try { straySocket.close(); } catch { /* ignore */ }
      }

      this.activeToken = normalizedToken;
      this.activeBrokerId = getRuntimeBrokerConfiguration().brokerId;
      this.activeUrl = this.options.url || DESKTOP_BINARY_TRADE_URL;
      this.binaryModeConnected = true;
      this.authFrameSent = Boolean(normalizedToken);

      this.attachBinaryTradeEvents();
      this.syncBinaryMarketChannelSubscriptions();
      binaryTcpMarketStream.start();
      const explicitLogin = this.resolveSubscribedAccountLogin();
      this.lastSyncedBinaryAccountLogin = explicitLogin ?? null;
      this.syncBinaryAccountBinding(explicitLogin);
      this.setState('open');
      return;
    }

    if (this.ws && (this.ws.readyState === WS_CONNECTING || this.ws.readyState === WS_OPEN)) {
      return;
    }

    this.clearReconnectTimer();
    this.clearKeepaliveTimer();
    if (!isDesktopBackendTarget() && this.activeBrokerId !== undefined
      && this.activeBrokerId !== getRuntimeBrokerConfiguration().brokerId) {
      this.setState('error');
      return;
    }
    this.activeToken = token;
    this.activeBrokerId = getRuntimeBrokerConfiguration().brokerId;
    this.authFrameSent = false;
    let url: string;
    try {
      url = this.options.url || (token ? buildApiV2WsUrl(token) : RTX5_WS_URL);
    } catch {
      this.setState('error');
      return;
    }
    this.activeUrl = url;
    if (!isTradeSocketAllowed(url, token, this.activeBrokerId)) {
      this.setState('error');
      return;
    }
    this.setState('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.setState('error');
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      if (!this.hasCurrentDeploymentConnection()) {
        this.disconnect();
        return;
      }

      if (token) {
        this.authFrameSent = this.send({ action: 'auth', token });
        if (!this.authFrameSent) {
          this.setState('error');
          if (typeof socket.close === 'function') socket.close();
          return;
        }
      }

      this.setState('open');
      this.startKeepaliveTimer(socket);
      this.channels.forEach(channel => {
        if (channel !== '*') {
          this.send({ action: 'subscribe', channel, channels: [channel] });
        }
      });
      this.scheduleStableOpenReset(socket);
    };

    socket.onmessage = event => {
      if (this.ws !== socket) return;
      if (!this.hasCurrentDeploymentConnection()) {
        this.disconnect();
        return;
      }
      const message = this.parseMessage(event.data);
      if (this.isUncorrelatedPongMessage(message)) return;
      this.routePendingOrderMessage(message);
      this.dispatch(message);
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      this.clearKeepaliveTimer();
      this.setState('error');
      if (typeof socket.close === 'function') socket.close();
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.clearKeepaliveTimer();
      this.clearStableOpenTimer();
      this.ws = null;
      this.authFrameSent = false;
      this.setState('closed');
      this.rejectAllPendingOrders('Trade socket closed before the order completed');
      this.scheduleReconnect();
    };
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.clearKeepaliveTimer();
    this.clearStableOpenTimer();
    this.reconnectPendingWhileHidden = false;
    this.options.reconnect = false;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.detachBinarySubscriptions();
    this.binaryModeConnected = false;
    this.lastSyncedBinaryAccountLogin = null;
    this.rejectAllPendingOrders('Trade socket disconnected before the order completed');
    const socket = this.ws;
    this.ws = null;
    this.authFrameSent = false;
    if (socket && typeof socket.close === 'function') socket.close();
    this.setState('closed');
  }

  close(): void {
    this.disconnect();
  }

  subscribe<T = unknown>(channel: TradeSocketChannel | string, handler?: TradeSocketHandler<T>): () => void {
    const key = String(channel);
    this.channels.add(key);

    if (handler) {
      this.addHandler(key, handler as TradeSocketHandler);
    }

    if (isDesktopBackendTarget()) {
      if (this.binaryModeConnected && this.state === 'open') {
        this.attachBinaryMarketChannel(key);
        const channelLogin = extractAccountLoginFromChannel(key);
        if (channelLogin !== undefined && channelLogin !== this.lastSyncedBinaryAccountLogin) {
          this.lastSyncedBinaryAccountLogin = channelLogin;
          this.syncBinaryAccountBinding(channelLogin);
        }
      }
      return () => this.unsubscribe(key, handler as TradeSocketHandler | undefined);
    }

    if (key !== '*' && this.ws?.readyState === WS_OPEN) {
      this.send({ action: 'subscribe', channel: key, channels: [key] });
    }

    return () => this.unsubscribe(key, handler as TradeSocketHandler | undefined);
  }

  unsubscribe(channel: TradeSocketChannel | string, handler?: TradeSocketHandler): void {
    const key = String(channel);

    if (handler) {
      const handlers = this.handlers.get(key);
      handlers?.delete(handler);
      if (handlers?.size) return;
    }

    this.handlers.delete(key);
    this.channels.delete(key);

    const binaryUnsub = this.binaryMarketUnsubs.get(key);
    if (binaryUnsub) {
      this.binaryMarketUnsubs.delete(key);
      try { binaryUnsub(); } catch { /* ignore */ }
    }

    if (isDesktopBackendTarget()) {
      return;
    }

    if (key !== '*' && this.ws?.readyState === WS_OPEN) {
      this.send({ action: 'unsubscribe', channel: key, channels: [key] });
    }
  }

  onMessage(handler: TradeSocketHandler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  onStateChange(handler: (state: TradeSocketState) => void): () => void {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => this.stateHandlers.delete(handler);
  }

  send(message: TradeSocketMessage): boolean {
    if (isDesktopBackendTarget()) {
      if (!this.binaryModeConnected || this.state !== 'open') return false;
      const action = typeof message.action === 'string' ? message.action.trim().toLowerCase() : '';
      if (action === 'ping' || action === 'subscribe' || action === 'unsubscribe') {
        return true;
      }
      return false;
    }

    if (this.ws?.readyState !== WS_OPEN || !this.hasCurrentDeploymentConnection()) return false;

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  placeOrder(
    payload: TradeSocketPlaceOrderPayload,
    clientOrderId = createTradeOrderUuid(),
    timing: TradeSocketOrderTimingContext = {},
  ): Promise<TradeSocketOrderFilled> {
    const localStartedAtMs = tradeOrderNow();
    const intentAtMs = normalizeEarlierMonotonicTime(timing.intentAtMs, localStartedAtMs);
    const apiStartedAtMs = normalizeEarlierMonotonicTime(timing.apiStartedAtMs, localStartedAtMs);
    const requestedSessionScope = typeof timing.sessionScope === 'string'
      ? timing.sessionScope.trim()
      : '';
    const sessionScope = requestedSessionScope
      ? requestedSessionScope
      : getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope());
    const accountLogin = Number(payload.account_login);
    const volume = Number(payload.volume);
    const rawSl = payload.sl !== undefined ? payload.sl : payload.price_sl;
    const rawTp = payload.tp !== undefined ? payload.tp : payload.price_tp;
    const sl = rawSl === undefined ? 0 : rawSl;
    const tp = rawTp === undefined ? 0 : rawTp;
    const symbol = String(payload.symbol || '').trim().toUpperCase();
    const side = String(payload.side || '').trim().toLowerCase();
    const normalizedClientOrderId = String(clientOrderId || '').trim() || createTradeOrderUuid();
    const requestId = createTradeOrderUuid();

    if (!Number.isFinite(accountLogin) || accountLogin <= 0) {
      return Promise.reject(new Error('Missing account login for WebSocket order'));
    }
    if (!isTradeOrderUuidV4(normalizedClientOrderId)) {
      return Promise.reject(new Error('client_order_id must be a UUID v4'));
    }
    if (!symbol) return Promise.reject(new Error('Missing symbol for WebSocket order'));
    if (side !== 'buy' && side !== 'sell') {
      return Promise.reject(new Error('Side must be buy or sell'));
    }
    if (!Number.isFinite(volume) || volume <= 0) {
      return Promise.reject(new Error('Volume must be greater than zero'));
    }
    if (typeof sl !== 'number' || !Number.isFinite(sl) || sl < 0) {
      return Promise.reject(new Error('SL must be zero (disabled) or a positive finite number'));
    }
    if (typeof tp !== 'number' || !Number.isFinite(tp) || tp < 0) {
      return Promise.reject(new Error('TP must be zero (disabled) or a positive finite number'));
    }
    if (!this.isReadyForOrders()) {
      recordTradeOrderLatency({
        phase: 'ws_transport_error',
        transport: 'websocket',
        traceId: toTradeOrderTraceId(normalizedClientOrderId),
        sessionScope,
        symbol,
        reason: 'socket_not_ready',
        totalMs: tradeOrderNow() - apiStartedAtMs,
      });
      return Promise.reject(new TradeSocketTransportError('Trade socket is not authenticated and open', {
        code: 'WS_NOT_READY',
        requestId,
        clientOrderId: normalizedClientOrderId,
      }));
    }

    // Pure Binary TCP Desktop Fastlane: execute directly via 128-byte fixed binary
    // packet over `sendBinaryTcpOrder` with zero WebSockets and zero JSON.
    if (isDesktopBackendTarget()) {
      return this.executeBinaryPlaceMarketOrder({
        accountLogin,
        symbol,
        side,
        volume,
        sl,
        tp,
        requestId,
        clientOrderId: normalizedClientOrderId,
        sessionScope,
        intentAtMs,
        apiStartedAtMs,
      });
    }

    // Runtime compatibility for no-protection market orders:
    // the documented WS contract uses 0 as the "disabled" sentinel, but the
    // currently deployed /ws/v2 validator rejects a present zero as non-positive.
    // Omitting only inactive fields matches the already-working REST semantics;
    // real positive SL/TP values are still sent exactly and never fabricated.
    const orderMessage: TradeSocketMessage = {
      action: 'place_order',
      request_id: requestId,
      client_order_id: normalizedClientOrderId,
      account_login: accountLogin,
      symbol,
      side,
      type: 'market',
      volume,
    };
    // Assign optional protection fields without conditional object spreads.
    // This keeps the common no-SL/TP frame allocation-minimal while preserving
    // the deployed-validator compatibility behavior documented above.
    if (sl > 0) orderMessage.sl = sl;
    if (tp > 0) orderMessage.tp = tp;
    const serializationStartedAtMs = tradeOrderNow();
    const serializedOrder = JSON.stringify(orderMessage);
    const serializationMs = tradeOrderNow() - serializationStartedAtMs;
    const socket = this.ws;
    const bufferedAmountBefore = readBufferedAmount(socket);

    if (!socket || socket.readyState !== WS_OPEN || this.ws !== socket || !this.hasCurrentDeploymentConnection()) {
      recordTradeOrderLatency({
        phase: 'ws_transport_error',
        transport: 'websocket',
        traceId: toTradeOrderTraceId(normalizedClientOrderId),
        sessionScope,
        symbol,
        reason: 'socket_changed_before_send',
        serializationMs,
        totalMs: tradeOrderNow() - apiStartedAtMs,
        bufferedAmountBefore,
      });
      return Promise.reject(new TradeSocketTransportError('Trade socket changed before the order could be sent', {
        code: 'WS_NOT_READY',
        requestId,
        clientOrderId: normalizedClientOrderId,
      }));
    }

    if (bufferedAmountBefore > this.options.maxOrderBufferedAmount) {
      recordTradeOrderLatency({
        phase: 'ws_transport_error',
        transport: 'websocket',
        traceId: toTradeOrderTraceId(normalizedClientOrderId),
        sessionScope,
        symbol,
        reason: 'socket_backpressure',
        serializationMs,
        totalMs: tradeOrderNow() - apiStartedAtMs,
        bufferedAmountBefore,
      });
      return Promise.reject(new TradeSocketTransportError('Trade socket is backpressured; using the idempotent fallback', {
        code: 'WS_BACKPRESSURE',
        requestId,
        clientOrderId: normalizedClientOrderId,
      }));
    }

    return new Promise<TradeSocketOrderFilled>((resolve, reject) => {
      const pending: PendingOrderRequest = {
        resolve,
        reject,
        clientOrderId: normalizedClientOrderId,
        sessionScope,
        accountLogin,
        symbol,
        timer: null,
        recoveryAttempted: false,
        intentAtMs,
        apiStartedAtMs,
        sendCompletedAtMs: 0,
        acceptedAtMs: null,
        statusRecoverySentAtMs: null,
        serializationMs,
        sendCallMs: 0,
        payloadBytes: 0,
        bufferedAmountBefore,
        bufferedAmountAfter: bufferedAmountBefore,
      };
      this.pendingOrders.set(requestId, pending);

      // Nothing except strict validation/serialization runs between API entry
      // and this call. Timer setup and diagnostics happen only after enqueue.
      const sendStartedAtMs = tradeOrderNow();
      try {
        socket.send(serializedOrder);
      } catch {
        recordTradeOrderLatency({
          phase: 'ws_transport_error',
          transport: 'websocket',
          traceId: toTradeOrderTraceId(normalizedClientOrderId),
          sessionScope,
          symbol,
          reason: 'send_failed',
          serializationMs,
          sendCallMs: tradeOrderNow() - sendStartedAtMs,
          totalMs: tradeOrderNow() - apiStartedAtMs,
          bufferedAmountBefore,
          bufferedAmountAfter: readBufferedAmount(socket),
        });
        this.rejectPendingOrder(requestId, new TradeSocketTransportError('Failed to send the order over the trade socket', {
          code: 'WS_SEND_FAILED',
          requestId,
          clientOrderId: normalizedClientOrderId,
        }));
        return;
      }

      const sendCompletedAtMs = tradeOrderNow();
      pending.sendCompletedAtMs = sendCompletedAtMs;
      pending.sendCallMs = sendCompletedAtMs - sendStartedAtMs;
      pending.payloadBytes = getUtf8ByteLength(serializedOrder);
      pending.bufferedAmountAfter = readBufferedAmount(socket);

      recordTradeOrderLatency({
        phase: 'ws_enqueued',
        transport: 'websocket',
        // Trace formatting is diagnostics-only, so do it after send() returns.
        traceId: toTradeOrderTraceId(normalizedClientOrderId),
        sessionScope,
        symbol,
        payloadBytes: pending.payloadBytes,
        serializationMs,
        sendCallMs: pending.sendCallMs,
        intentToEnqueueMs: sendCompletedAtMs - intentAtMs,
        apiToEnqueueMs: sendCompletedAtMs - apiStartedAtMs,
        totalMs: sendCompletedAtMs - apiStartedAtMs,
        bufferedAmountBefore,
        bufferedAmountAfter: pending.bufferedAmountAfter,
      });
      this.armPendingOrderTimer(requestId, pending);
    });
  }

  async closePosition(
    positionId: number | string,
    volumeOrOptions?: number | TradeSocketClosePositionOptions,
    maybeOptions?: TradeSocketClosePositionOptions,
  ): Promise<TradeSocketClosePositionResult> {
    const requestId = createTradeOrderUuid();
    const ticket = toPositiveSafeInteger(positionId);
    if (ticket === undefined) {
      throw new Error('Invalid position ticket');
    }

    let opts: TradeSocketClosePositionOptions;
    let volumeInput: unknown;
    if (typeof volumeOrOptions === 'number') {
      opts = maybeOptions ?? {};
      volumeInput = volumeOrOptions;
    } else if (volumeOrOptions !== undefined && volumeOrOptions !== null && typeof volumeOrOptions === 'object') {
      opts = volumeOrOptions;
      volumeInput = opts.volume;
    } else if (volumeOrOptions === undefined) {
      opts = maybeOptions ?? {};
      volumeInput = opts.volume;
    } else {
      throw new Error('Close volume must be a finite non-negative number');
    }

    let partialVolume: number | undefined;
    if (volumeInput !== undefined && volumeInput !== null && volumeInput !== '') {
      const parsedVol = Number(volumeInput);
      if (!Number.isFinite(parsedVol) || parsedVol < 0) {
        throw new Error('Close volume must be a finite non-negative number');
      }
      if (parsedVol > 0) {
        partialVolume = parsedVol;
      }
    }

    const suppliedClientOrderId = String(opts.client_order_id ?? opts.clientOrderId ?? '').trim();
    if (suppliedClientOrderId && !isTradeOrderUuidV4(suppliedClientOrderId)) {
      throw new Error('client_order_id must be a UUID v4');
    }
    const clientOrderId = suppliedClientOrderId || createTradeOrderUuid();

    if (opts.account_login !== undefined && toPositiveSafeInteger(opts.account_login) === undefined) {
      throw new Error('Invalid account login for closePosition');
    }
    if (opts.accountLogin !== undefined && toPositiveSafeInteger(opts.accountLogin) === undefined) {
      throw new Error('Invalid account login for closePosition');
    }
    const explicitLogin = toPositiveSafeInteger(opts.account_login);
    const aliasLogin = toPositiveSafeInteger(opts.accountLogin);
    if (explicitLogin !== undefined && aliasLogin !== undefined && explicitLogin !== aliasLogin) {
      throw new Error('Conflicting account identity (account_login !== accountLogin)');
    }

    this.assertBinaryCommandReady(requestId, clientOrderId);

    const accountLogin = explicitLogin ?? aliasLogin ?? this.resolveSubscribedAccountLogin() ?? 0;
    const isPartial = partialVolume !== undefined && partialVolume > 0;
    try {
      const resp = await sendBinaryTcpOrder({
        action: BINARY_ORDER_ACTION_CLOSE_POSITION,
        accountLogin,
        ticket,
        volume: partialVolume ?? 0,
        partialClose: isPartial,
        flags: isPartial ? BINARY_ORDER_FLAG_PARTIAL_CLOSE : 0,
        clientOrderId,
        authToken: opts.authToken !== undefined ? opts.authToken : this.resolveActiveAuthToken(),
        ...(opts.signal ? { signal: opts.signal } : {}),
        timeoutMs: opts.timeoutMs ?? this.options.orderTimeoutMs,
      });

      const closedTicket = resp.positionTicket > 0 ? resp.positionTicket : ticket;
      const closedVolume = resp.volume > 0 ? resp.volume : (partialVolume ?? 0);
      const safeMicros = Number.isFinite(resp.execMicros) && resp.execMicros >= 0 ? resp.execMicros : 0;
      return {
        ticket: closedTicket,
        position_id: String(closedTicket),
        position_ticket: closedTicket,
        deal_ticket: resp.dealTicket,
        order_ticket: resp.orderTicket,
        ...(resp.orderTicket > 0 ? { order_id: String(resp.orderTicket) } : {}),
        price: resp.fillPrice,
        fill_price: resp.fillPrice,
        close_price: resp.fillPrice,
        profit: resp.profit,
        commission: resp.commission,
        closed_volume: closedVolume,
        volume: closedVolume,
        symbol: resp.symbol || '',
        client_order_id: resp.clientOrderId || clientOrderId,
        exec_ms: Number((safeMicros / 1000).toFixed(3)),
        execMicros: safeMicros,
        status: isPartial ? 'partial_closed' : 'closed',
      };
    } catch (error) {
      throw this.mapBinaryOrderError(error, requestId, clientOrderId);
    }
  }

  async modifyPosition(
    positionId: number | string,
    data: TradeSocketModifyPositionPayload,
  ): Promise<TradeSocketPositionResult> {
    const requestId = createTradeOrderUuid();
    const ticket = toPositiveSafeInteger(positionId);
    if (ticket === undefined) {
      throw new Error('Invalid position ticket');
    }

    const rawSl = data.price_sl !== undefined ? data.price_sl : data.sl;
    const rawTp = data.price_tp !== undefined ? data.price_tp : data.tp;
    if (rawSl === undefined && rawTp === undefined) {
      throw new Error('Modify position requires SL and/or TP update');
    }

    let flags = 0;
    let slParam: number | undefined;
    let tpParam: number | undefined;
    let clearSl = false;
    let clearTp = false;

    if (rawSl !== undefined) {
      if (rawSl === null || rawSl === 0) {
        flags |= BINARY_ORDER_FLAG_CLEAR_SL;
        clearSl = true;
        slParam = 0;
      } else {
        if (typeof rawSl !== 'number' || !Number.isFinite(rawSl) || rawSl < 0) {
          throw new Error('SL must be zero (disabled) or a positive finite number');
        }
        flags |= BINARY_ORDER_FLAG_HAS_SL;
        slParam = rawSl;
      }
    }

    if (rawTp !== undefined) {
      if (rawTp === null || rawTp === 0) {
        flags |= BINARY_ORDER_FLAG_CLEAR_TP;
        clearTp = true;
        tpParam = 0;
      } else {
        if (typeof rawTp !== 'number' || !Number.isFinite(rawTp) || rawTp < 0) {
          throw new Error('TP must be zero (disabled) or a positive finite number');
        }
        flags |= BINARY_ORDER_FLAG_HAS_TP;
        tpParam = rawTp;
      }
    }

    const suppliedClientOrderId = String(data.client_order_id ?? data.clientOrderId ?? '').trim();
    if (suppliedClientOrderId && !isTradeOrderUuidV4(suppliedClientOrderId)) {
      throw new Error('client_order_id must be a UUID v4');
    }
    const clientOrderId = suppliedClientOrderId || createTradeOrderUuid();

    if (data.account_login !== undefined && toPositiveSafeInteger(data.account_login) === undefined) {
      throw new Error('Invalid account login for modifyPosition');
    }
    if (data.accountLogin !== undefined && toPositiveSafeInteger(data.accountLogin) === undefined) {
      throw new Error('Invalid account login for modifyPosition');
    }
    const explicitLogin = toPositiveSafeInteger(data.account_login) ?? toPositiveSafeInteger(data.accountLogin);

    this.assertBinaryCommandReady(requestId, clientOrderId);

    const accountLogin = explicitLogin ?? this.resolveSubscribedAccountLogin() ?? 0;
    try {
      const resp = await sendBinaryTcpOrder({
        action: BINARY_ORDER_ACTION_MODIFY_POSITION,
        accountLogin,
        ticket,
        flags,
        ...(slParam !== undefined ? { sl: slParam } : {}),
        ...(tpParam !== undefined ? { tp: tpParam } : {}),
        clearSl,
        clearTp,
        clientOrderId,
        authToken: data.authToken !== undefined ? data.authToken : this.resolveActiveAuthToken(),
        ...(data.signal ? { signal: data.signal } : {}),
        timeoutMs: data.timeoutMs ?? this.options.orderTimeoutMs,
      });

      const resolvedTicket = resp.positionTicket > 0 ? resp.positionTicket : ticket;
      const resolvedSymbol = resp.symbol || String(data.symbol || '').trim().toUpperCase();
      const resolvedSide: 'buy' | 'sell' = String(data.side || '').trim().toLowerCase() === 'sell' ? 'sell' : 'buy';
      const resolvedVolume = resp.volume > 0 ? resp.volume : (Number(data.volume) > 0 ? Number(data.volume) : 0);
      const fallbackOpenPrice = Number(data.open_price ?? data.price_open ?? 0);
      const openPrice = resp.fillPrice > 0
        ? resp.fillPrice
        : (Number.isFinite(fallbackOpenPrice) && fallbackOpenPrice > 0 ? fallbackOpenPrice : 0);
      const nextSl = rawSl !== undefined
        ? (clearSl ? 0 : (resp.sl > 0 ? resp.sl : (slParam ?? 0)))
        : (resp.sl > 0 ? resp.sl : 0);
      const nextTp = rawTp !== undefined
        ? (clearTp ? 0 : (resp.tp > 0 ? resp.tp : (tpParam ?? 0)))
        : (resp.tp > 0 ? resp.tp : 0);

      return {
        id: String(resolvedTicket),
        ticket: resolvedTicket,
        account_login: accountLogin,
        symbol: resolvedSymbol,
        side: resolvedSide,
        quantity: resolvedVolume,
        volume: resolvedVolume,
        open_price: openPrice,
        price_open: openPrice,
        price_sl: nextSl,
        price_tp: nextTp,
        sl: nextSl,
        tp: nextTp,
        commission: resp.commission,
        profit: resp.profit,
      };
    } catch (error) {
      throw this.mapBinaryOrderError(error, requestId, clientOrderId);
    }
  }

  async placePendingOrder(
    payload: TradeSocketPlacePendingOrderPayload,
    explicitClientOrderId?: string,
  ): Promise<TradeSocketOrderResult> {
    const requestId = createTradeOrderUuid();
    const accountLogin = toPositiveSafeInteger(payload.account_login ?? payload.login ?? payload.accountLogin)
      ?? this.resolveSubscribedAccountLogin()
      ?? 0;
    if (accountLogin <= 0) {
      throw new Error('Missing account login for pending order');
    }

    const symbol = String(payload.symbol || '').trim().toUpperCase();
    if (!symbol) {
      throw new Error('Missing symbol for pending order');
    }

    const normalizedType = String(payload.type || '').trim().toLowerCase() as PendingOrderType;
    const orderSubType = PENDING_ORDER_SUBTYPE_BY_NAME[normalizedType];
    if (orderSubType === undefined) {
      throw new Error(`Unsupported pending order type: ${String(payload.type ?? '')}`);
    }

    const impliedSide: 'buy' | 'sell' = normalizedType.startsWith('sell_') ? 'sell' : 'buy';
    const rawSide = String(payload.side ?? '').trim().toLowerCase();
    if (rawSide && rawSide !== 'buy' && rawSide !== 'sell') {
      throw new Error('Side must be buy or sell');
    }
    if (rawSide && rawSide !== impliedSide) {
      throw new Error(`Pending order side ${rawSide} conflicts with type ${normalizedType}`);
    }
    const side: 'buy' | 'sell' = (rawSide as 'buy' | 'sell') || impliedSide;

    const volume = Number(payload.volume ?? payload.quantity);
    if (!Number.isFinite(volume) || volume <= 0) {
      throw new Error('Volume must be greater than zero');
    }

    const price = Number(payload.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('Pending order price must be greater than zero');
    }

    const isStopLimit = normalizedType === 'buy_stop_limit' || normalizedType === 'sell_stop_limit';
    const rawStopLimit = payload.price_limit !== undefined ? payload.price_limit : payload.stopLimitPrice;
    let stopLimitPrice: number | undefined;
    if (rawStopLimit !== undefined && rawStopLimit !== null) {
      const parsedLimit = Number(rawStopLimit);
      if (!Number.isFinite(parsedLimit) || parsedLimit < 0 || (isStopLimit && parsedLimit <= 0)) {
        throw new Error('Invalid stop-limit trigger price');
      }
      if (parsedLimit > 0) {
        stopLimitPrice = parsedLimit;
      }
    } else if (isStopLimit) {
      throw new Error('Stop-limit pending order requires price_limit > 0');
    }

    const rawSl = payload.price_sl !== undefined ? payload.price_sl : payload.sl;
    const sl = rawSl === undefined || rawSl === null ? 0 : Number(rawSl);
    if (!Number.isFinite(sl) || sl < 0) {
      throw new Error('SL must be zero (disabled) or a positive finite number');
    }

    const rawTp = payload.price_tp !== undefined ? payload.price_tp : payload.tp;
    const tp = rawTp === undefined || rawTp === null ? 0 : Number(rawTp);
    if (!Number.isFinite(tp) || tp < 0) {
      throw new Error('TP must be zero (disabled) or a positive finite number');
    }

    const rawExpiration = payload.expiration !== undefined ? payload.expiration : payload.expiry;
    const expiration = rawExpiration === undefined || rawExpiration === null ? 0 : Number(rawExpiration);
    if (!Number.isFinite(expiration) || expiration < 0) {
      throw new Error('Invalid pending order expiration');
    }

    const suppliedClientOrderId = String(
      explicitClientOrderId ?? payload.client_order_id ?? payload.clientOrderId ?? '',
    ).trim();
    if (suppliedClientOrderId && !isTradeOrderUuidV4(suppliedClientOrderId)) {
      throw new Error('client_order_id must be a UUID v4');
    }
    const clientOrderId = suppliedClientOrderId || createTradeOrderUuid();

    this.assertBinaryCommandReady(requestId, clientOrderId);

    let flags = BINARY_ORDER_FLAG_HAS_PRICE;
    if (stopLimitPrice !== undefined && stopLimitPrice > 0) flags |= BINARY_ORDER_FLAG_HAS_STOP_LIMIT;
    if (sl > 0) flags |= BINARY_ORDER_FLAG_HAS_SL;
    if (tp > 0) flags |= BINARY_ORDER_FLAG_HAS_TP;
    if (expiration > 0) flags |= BINARY_ORDER_FLAG_HAS_EXPIRATION;
    const expiryType = resolvePlacePendingExpiryType(payload.expiryType, payload.expiry_type);

    try {
      const resp = await sendBinaryTcpOrder({
        action: BINARY_ORDER_ACTION_PLACE_PENDING,
        accountLogin,
        symbol,
        side: side === 'sell' ? BINARY_ORDER_SIDE_SELL : BINARY_ORDER_SIDE_BUY,
        orderSubType,
        flags,
        volume,
        price,
        ...(stopLimitPrice !== undefined && stopLimitPrice > 0 ? { stopLimitPrice } : {}),
        ...(sl > 0 ? { sl } : {}),
        ...(tp > 0 ? { tp } : {}),
        ...(expiration > 0 ? { expiration } : {}),
        ...(expiryType !== undefined ? { expiryType } : {}),
        clientOrderId,
        authToken: payload.authToken !== undefined ? payload.authToken : this.resolveActiveAuthToken(),
        ...(payload.signal ? { signal: payload.signal } : {}),
        timeoutMs: payload.timeoutMs ?? this.options.orderTimeoutMs,
      });

      const orderTicket = resp.orderTicket > 0 ? resp.orderTicket : resp.positionTicket;
      const resolvedVolume = resp.volume > 0 ? resp.volume : volume;
      const resolvedPrice = resp.fillPrice > 0 ? resp.fillPrice : price;
      const resolvedSl = resp.sl > 0 ? resp.sl : sl;
      const resolvedTp = resp.tp > 0 ? resp.tp : tp;
      const nowMs = Date.now();

      return {
        id: String(orderTicket),
        ticket: orderTicket,
        account_login: accountLogin,
        symbol: resp.symbol || symbol,
        type: normalizedType,
        side,
        quantity: resolvedVolume,
        volume: resolvedVolume,
        price: resolvedPrice,
        ...(stopLimitPrice !== undefined ? { price_limit: stopLimitPrice } : {}),
        price_sl: resolvedSl,
        price_tp: resolvedTp,
        sl: resolvedSl,
        tp: resolvedTp,
        status: 'pending',
        created_at: new Date(nowMs).toISOString(),
        time_create: Math.floor(nowMs / 1000),
        client_order_id: resp.clientOrderId || clientOrderId,
      };
    } catch (error) {
      throw this.mapBinaryOrderError(error, requestId, clientOrderId);
    }
  }

  async modifyPendingOrder(
    orderId: number | string,
    data: TradeSocketModifyPendingOrderPayload,
  ): Promise<TradeSocketOrderResult> {
    const requestId = createTradeOrderUuid();
    const ticket = toPositiveSafeInteger(orderId);
    if (ticket === undefined) {
      throw new Error('Invalid pending order ticket');
    }

    const rawStopLimit = data.price_limit !== undefined ? data.price_limit : data.stopLimitPrice;
    const rawSl = data.price_sl !== undefined ? data.price_sl : data.sl;
    const rawTp = data.price_tp !== undefined ? data.price_tp : data.tp;
    const rawExpiration = data.expiration !== undefined ? data.expiration : data.expiry;

    if (
      data.price === undefined
      && rawStopLimit === undefined
      && rawSl === undefined
      && rawTp === undefined
      && rawExpiration === undefined
    ) {
      throw new Error('Modify pending order requires at least one updated parameter');
    }

    let flags = 0;
    let priceParam: number | undefined;
    let stopLimitParam: number | undefined;
    let slParam: number | undefined;
    let tpParam: number | undefined;
    let expirationParam: number | undefined;
    let clearSl = false;
    let clearTp = false;

    if (data.price !== undefined) {
      const parsedPrice = Number(data.price);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        throw new Error('Pending order price must be greater than zero');
      }
      flags |= BINARY_ORDER_FLAG_HAS_PRICE;
      priceParam = parsedPrice;
    }

    if (rawStopLimit !== undefined && rawStopLimit !== null) {
      const parsedLimit = Number(rawStopLimit);
      if (!Number.isFinite(parsedLimit) || parsedLimit < 0) {
        throw new Error('Pending order stop-limit price must be non-negative');
      }
      if (parsedLimit > 0) {
        flags |= BINARY_ORDER_FLAG_HAS_STOP_LIMIT;
      }
      stopLimitParam = parsedLimit;
    }

    if (rawSl !== undefined) {
      if (rawSl === null || rawSl === 0) {
        flags |= BINARY_ORDER_FLAG_CLEAR_SL;
        clearSl = true;
        slParam = 0;
      } else {
        if (typeof rawSl !== 'number' || !Number.isFinite(rawSl) || rawSl < 0) {
          throw new Error('SL must be zero (disabled) or a positive finite number');
        }
        flags |= BINARY_ORDER_FLAG_HAS_SL;
        slParam = rawSl;
      }
    }

    if (rawTp !== undefined) {
      if (rawTp === null || rawTp === 0) {
        flags |= BINARY_ORDER_FLAG_CLEAR_TP;
        clearTp = true;
        tpParam = 0;
      } else {
        if (typeof rawTp !== 'number' || !Number.isFinite(rawTp) || rawTp < 0) {
          throw new Error('TP must be zero (disabled) or a positive finite number');
        }
        flags |= BINARY_ORDER_FLAG_HAS_TP;
        tpParam = rawTp;
      }
    }

    if (rawExpiration !== undefined && rawExpiration !== null) {
      const parsedExp = Number(rawExpiration);
      if (!Number.isFinite(parsedExp) || parsedExp < 0) {
        throw new Error('Invalid pending order expiration');
      }
      if (parsedExp > 0) {
        flags |= BINARY_ORDER_FLAG_HAS_EXPIRATION;
        expirationParam = parsedExp;
      }
    }

    const suppliedClientOrderId = String(data.client_order_id ?? data.clientOrderId ?? '').trim();
    if (suppliedClientOrderId && !isTradeOrderUuidV4(suppliedClientOrderId)) {
      throw new Error('client_order_id must be a UUID v4');
    }
    const clientOrderId = suppliedClientOrderId || createTradeOrderUuid();

    if (data.account_login !== undefined && toPositiveSafeInteger(data.account_login) === undefined) {
      throw new Error('Invalid account login for modifyPendingOrder');
    }
    if (data.accountLogin !== undefined && toPositiveSafeInteger(data.accountLogin) === undefined) {
      throw new Error('Invalid account login for modifyPendingOrder');
    }
    const explicitLogin = toPositiveSafeInteger(data.account_login) ?? toPositiveSafeInteger(data.accountLogin);

    this.assertBinaryCommandReady(requestId, clientOrderId);

    const expiryType = resolveModifyPendingExpiryType(
      (flags & BINARY_ORDER_FLAG_HAS_EXPIRATION) !== 0,
      data.expiryType,
      data.expiry_type,
      data.time_in_force,
    );
    const accountLogin = explicitLogin ?? this.resolveSubscribedAccountLogin() ?? 0;
    try {
      const resp = await sendBinaryTcpOrder({
        action: BINARY_ORDER_ACTION_MODIFY_PENDING,
        accountLogin,
        ticket,
        flags,
        ...(priceParam !== undefined ? { price: priceParam } : {}),
        ...(stopLimitParam !== undefined && stopLimitParam > 0 ? { stopLimitPrice: stopLimitParam } : {}),
        ...(slParam !== undefined ? { sl: slParam } : {}),
        ...(tpParam !== undefined ? { tp: tpParam } : {}),
        ...(expirationParam !== undefined && expirationParam > 0 ? { expiration: expirationParam } : {}),
        ...(expiryType !== undefined ? { expiryType } : {}),
        clearSl,
        clearTp,
        clientOrderId,
        authToken: data.authToken !== undefined ? data.authToken : this.resolveActiveAuthToken(),
        ...(data.signal ? { signal: data.signal } : {}),
        timeoutMs: data.timeoutMs ?? this.options.orderTimeoutMs,
      });

      const resolvedTicket = resp.orderTicket > 0 ? resp.orderTicket : ticket;
      const resolvedSymbol = resp.symbol || String(data.symbol || '').trim().toUpperCase();
      const resolvedType: PendingOrderType = (
        data.type && PENDING_ORDER_SUBTYPE_BY_NAME[data.type] !== undefined
      ) ? data.type : 'buy_limit';
      const resolvedSide: 'buy' | 'sell' = String(data.side || '').trim().toLowerCase() === 'sell'
        || resolvedType.startsWith('sell_')
        ? 'sell'
        : 'buy';
      const resolvedVolume = resp.volume > 0 ? resp.volume : (Number(data.volume) > 0 ? Number(data.volume) : 0);
      const resolvedPrice = resp.fillPrice > 0 ? resp.fillPrice : (priceParam ?? 0);
      const nextSl = rawSl !== undefined
        ? (clearSl ? 0 : (resp.sl > 0 ? resp.sl : (slParam ?? 0)))
        : (resp.sl > 0 ? resp.sl : 0);
      const nextTp = rawTp !== undefined
        ? (clearTp ? 0 : (resp.tp > 0 ? resp.tp : (tpParam ?? 0)))
        : (resp.tp > 0 ? resp.tp : 0);
      const nowMs = Date.now();

      return {
        id: String(resolvedTicket),
        ticket: resolvedTicket,
        account_login: accountLogin,
        symbol: resolvedSymbol,
        type: resolvedType,
        side: resolvedSide,
        quantity: resolvedVolume,
        volume: resolvedVolume,
        price: resolvedPrice,
        ...(stopLimitParam !== undefined ? { price_limit: stopLimitParam } : {}),
        price_sl: nextSl,
        price_tp: nextTp,
        sl: nextSl,
        tp: nextTp,
        status: 'pending',
        created_at: new Date(nowMs).toISOString(),
        time_create: Math.floor(nowMs / 1000),
        client_order_id: resp.clientOrderId || clientOrderId,
      };
    } catch (error) {
      throw this.mapBinaryOrderError(error, requestId, clientOrderId);
    }
  }

  async cancelOrder(
    orderId: number | string,
    options: TradeSocketCancelOrderOptions = {},
  ): Promise<void> {
    const requestId = createTradeOrderUuid();
    const ticket = toPositiveSafeInteger(orderId);
    if (ticket === undefined) {
      throw new Error('Invalid pending order ticket');
    }

    const suppliedClientOrderId = String(options.client_order_id ?? options.clientOrderId ?? '').trim();
    if (suppliedClientOrderId && !isTradeOrderUuidV4(suppliedClientOrderId)) {
      throw new Error('client_order_id must be a UUID v4');
    }
    const clientOrderId = suppliedClientOrderId || createTradeOrderUuid();

    if (options.account_login !== undefined && toPositiveSafeInteger(options.account_login) === undefined) {
      throw new Error('Invalid account login for cancelOrder');
    }
    if (options.accountLogin !== undefined && toPositiveSafeInteger(options.accountLogin) === undefined) {
      throw new Error('Invalid account login for cancelOrder');
    }
    const explicitLogin = toPositiveSafeInteger(options.account_login) ?? toPositiveSafeInteger(options.accountLogin);

    this.assertBinaryCommandReady(requestId, clientOrderId);

    const accountLogin = explicitLogin ?? this.resolveSubscribedAccountLogin() ?? 0;
    try {
      await sendBinaryTcpOrder({
        action: BINARY_ORDER_ACTION_CANCEL_PENDING,
        accountLogin,
        ticket,
        clientOrderId,
        authToken: options.authToken !== undefined ? options.authToken : this.resolveActiveAuthToken(),
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: options.timeoutMs ?? this.options.orderTimeoutMs,
      });
    } catch (error) {
      throw this.mapBinaryOrderError(error, requestId, clientOrderId);
    }
  }

  cancelPendingOrder(
    orderId: number | string,
    options: TradeSocketCancelOrderOptions = {},
  ): Promise<void> {
    return this.cancelOrder(orderId, options);
  }

  getOrderStatus(clientOrderId: string, accountLogin: number, requestId = createTradeOrderUuid()): string {
    const normalizedClientOrderId = String(clientOrderId || '').trim();
    const normalizedAccountLogin = Number(accountLogin);
    if (!normalizedClientOrderId) throw new Error('Missing client_order_id for order status');
    if (!Number.isFinite(normalizedAccountLogin) || normalizedAccountLogin <= 0) {
      throw new Error('Missing account login for order status');
    }
    if (isDesktopBackendTarget()) {
      throw new TradeSocketTransportError('Binary TCP orders settle synchronously; use GET order status reconciliation', {
        code: 'BINARY_SYNC_ORDER_STATUS',
        requestId,
        clientOrderId: normalizedClientOrderId,
        orderWasSent: true,
      });
    }
    if (!this.isReadyForOrders() || !this.send({
      action: 'get_order_status',
      request_id: requestId,
      client_order_id: normalizedClientOrderId,
      account_login: normalizedAccountLogin,
    })) {
      throw new TradeSocketTransportError('Failed to request order status over the trade socket', {
        requestId,
        clientOrderId: normalizedClientOrderId,
      });
    }
    return requestId;
  }

  subscribeTicks(symbol: string, handler?: TradeSocketHandler) {
    return this.subscribe(`ticks.${symbol}`, handler);
  }

  subscribeAllTicks(handler?: TradeSocketHandler) {
    return this.subscribe('ticks.all', handler);
  }

  subscribeCandles(symbol: string, timeframe: Timeframe | string, handler?: TradeSocketHandler) {
    return this.subscribe(`candles.${symbol}.${timeframe}`, handler);
  }

  subscribeDepth(symbol: string, handler?: TradeSocketHandler) {
    return this.subscribe(`depth.${symbol}`, handler);
  }

  subscribePositions(login: number | string, handler?: TradeSocketHandler) {
    return this.subscribe(`positions.${login}`, handler);
  }

  subscribeAccount(login: number | string, handler?: TradeSocketHandler) {
    return this.subscribe(`account.${login}`, handler);
  }

  subscribeMetrics(login: number | string, handler?: TradeSocketHandler) {
    return this.subscribe(`metrics.${login}`, handler);
  }

  subscribeOrders(login: number | string, handler?: TradeSocketHandler) {
    return this.subscribe(`orders.${login}`, handler);
  }

  subscribeDeals(login: number | string, handler?: TradeSocketHandler) {
    return this.subscribe(`deals.${login}`, handler);
  }

  subscribeState(login: number | string, handler?: TradeSocketHandler) {
    return this.subscribe(`state.${login}`, handler);
  }

  private async executeBinaryPlaceMarketOrder(params: {
    accountLogin: number;
    symbol: string;
    side: 'buy' | 'sell';
    volume: number;
    sl: number;
    tp: number;
    requestId: string;
    clientOrderId: string;
    sessionScope: string;
    intentAtMs: number;
    apiStartedAtMs: number;
  }): Promise<TradeSocketOrderFilled> {
    const {
      accountLogin,
      symbol,
      side,
      volume,
      sl,
      tp,
      requestId,
      clientOrderId,
      sessionScope,
      intentAtMs,
      apiStartedAtMs,
    } = params;

    let flags = 0;
    if (sl > 0) flags |= BINARY_ORDER_FLAG_HAS_SL;
    if (tp > 0) flags |= BINARY_ORDER_FLAG_HAS_TP;

    const binaryParams: BinaryTcpOrderParams = {
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin,
      symbol,
      side: side === 'sell' ? BINARY_ORDER_SIDE_SELL : BINARY_ORDER_SIDE_BUY,
      orderSubType: BINARY_ORDER_SUBTYPE_MARKET,
      flags,
      volume,
      ...(sl > 0 ? { sl } : {}),
      ...(tp > 0 ? { tp } : {}),
      clientOrderId,
      authToken: this.resolveActiveAuthToken(),
      timeoutMs: this.options.orderTimeoutMs,
    };

    const sendStartedAtMs = tradeOrderNow();
    const orderPromise = sendBinaryTcpOrder(binaryParams);
    const sendCompletedAtMs = tradeOrderNow();

    recordTradeOrderLatency({
      phase: 'ws_enqueued',
      transport: 'websocket',
      traceId: toTradeOrderTraceId(clientOrderId),
      sessionScope,
      symbol,
      payloadBytes: BINARY_ORDER_REQ_HEADER_SIZE,
      serializationMs: 0,
      sendCallMs: sendCompletedAtMs - sendStartedAtMs,
      intentToEnqueueMs: sendCompletedAtMs - intentAtMs,
      apiToEnqueueMs: sendCompletedAtMs - apiStartedAtMs,
      totalMs: sendCompletedAtMs - apiStartedAtMs,
      bufferedAmountBefore: 0,
      bufferedAmountAfter: 0,
    });

    let resp: DecodedBinaryOrderResp;
    try {
      resp = await orderPromise;
    } catch (error) {
      const mapped = this.mapBinaryOrderError(error, requestId, clientOrderId);
      const completedAtMs = tradeOrderNow();
      recordTradeOrderLatency({
        phase: mapped instanceof TradeSocketOrderRejectedError ? 'order_rejected' : 'ws_transport_error',
        transport: 'websocket',
        traceId: toTradeOrderTraceId(clientOrderId),
        sessionScope,
        symbol,
        reason: mapped.code || (mapped instanceof TradeSocketOrderRejectedError ? 'order_rejected' : 'binary_transport_error'),
        terminalRttMs: completedAtMs - sendCompletedAtMs,
        totalMs: completedAtMs - apiStartedAtMs,
      });
      throw mapped;
    }

    const completedAtMs = tradeOrderNow();
    recordTradeOrderLatency({
      phase: 'order_filled',
      transport: 'websocket',
      traceId: toTradeOrderTraceId(clientOrderId),
      sessionScope,
      symbol,
      terminalRttMs: completedAtMs - sendCompletedAtMs,
      totalMs: completedAtMs - apiStartedAtMs,
    });

    const positionTicket = resp.positionTicket > 0 ? resp.positionTicket : resp.orderTicket;
    const orderTicket = resp.orderTicket > 0 ? resp.orderTicket : positionTicket;
    const resolvedVolume = resp.volume > 0 ? resp.volume : volume;
    const resolvedSymbol = resp.symbol || symbol;
    const resolvedSl = resp.sl > 0 ? resp.sl : sl;
    const resolvedTp = resp.tp > 0 ? resp.tp : tp;
    const resolvedClientOrderId = resp.clientOrderId || clientOrderId;

    return {
      type: 'order_filled',
      status: 'filled',
      success: true,
      request_id: requestId,
      client_order_id: resolvedClientOrderId,
      data: {
        ...(orderTicket > 0 ? { order_ticket: orderTicket } : {}),
        ...(positionTicket > 0 ? { position_ticket: positionTicket, ticket: positionTicket } : {}),
        ...(resp.dealTicket > 0 ? { deal_ticket: resp.dealTicket } : {}),
        account_login: accountLogin,
        symbol: resolvedSymbol,
        side,
        volume: resolvedVolume,
        quantity: resolvedVolume,
        price: resp.fillPrice,
        price_open: resp.fillPrice,
        open_price: resp.fillPrice,
        price_sl: resolvedSl,
        price_tp: resolvedTp,
        sl: resolvedSl,
        tp: resolvedTp,
        commission: resp.commission,
        profit: resp.profit,
        exec_micros: resp.execMicros,
        status: 'filled',
      },
    };
  }

  private assertBinaryCommandReady(requestId: string, clientOrderId: string): void {
    if (!isDesktopBackendTarget()) {
      throw new TradeSocketTransportError('Binary TCP trading command requires Desktop mode', {
        code: 'BINARY_DESKTOP_ONLY',
        requestId,
        clientOrderId,
        orderWasSent: false,
      });
    }
    if (!this.isReadyForOrders()) {
      throw new TradeSocketTransportError('Trade socket is not authenticated and open', {
        code: 'WS_NOT_READY',
        requestId,
        clientOrderId,
        orderWasSent: false,
      });
    }
  }

  private mapBinaryOrderError(
    error: unknown,
    requestId: string,
    clientOrderId: string,
  ): TradeSocketOrderRejectedError | TradeSocketTransportError {
    if (error instanceof TradeSocketOrderRejectedError || error instanceof TradeSocketTransportError) {
      return error;
    }

    if (isBinaryTcpOrderErrorInstance(error)) {
      const code = readNonEmptyString(error.code)
        || (error.status === 504
          ? 'ORDER_STATUS_TIMEOUT'
          : error.retryable
            ? 'BINARY_TUNNEL_UNAVAILABLE'
            : 'ORDER_REJECTED');
      const detail = readNonEmptyString(error.backendMessage)
        || readNonEmptyString(error.message)
        || 'Order rejected';
      const resolvedClientOrderId = readNonEmptyString(error.clientOrderId) || clientOrderId;

      if (error.status === 504) {
        return new TradeSocketTransportError(detail, {
          code,
          requestId,
          clientOrderId: resolvedClientOrderId,
          orderWasSent: true,
        });
      }

      if (error.retryable) {
        return new TradeSocketTransportError(detail, {
          code,
          requestId,
          clientOrderId: resolvedClientOrderId,
          orderWasSent: false,
        });
      }

      const upperCode = code.toUpperCase();
      const status: 'rejected' | 'expired' = (
        upperCode === 'ORDER_EXPIRED' || upperCode === 'EXPIRED'
      ) ? 'expired' : 'rejected';
      return new TradeSocketOrderRejectedError(detail, {
        code,
        requestId,
        clientOrderId: resolvedClientOrderId,
        status,
      });
    }

    const message = error instanceof Error && error.message
      ? error.message
      : 'Binary TCP order transport failed';
    return new TradeSocketTransportError(message, {
      code: 'BINARY_TRANSPORT_ERROR',
      requestId,
      clientOrderId,
      orderWasSent: false,
    });
  }

  private resolveActiveAuthToken(): string | null {
    return this.activeToken || getAuthToken() || getAccessToken() || null;
  }

  private resolveSubscribedAccountLogin(): number | undefined {
    for (const channel of this.channels) {
      const login = extractAccountLoginFromChannel(channel);
      if (login !== undefined) return login;
    }
    return toPositiveSafeInteger(getCommittedBrokerAccountSessionScope().accountId);
  }

  private syncBinaryAccountBinding(explicitLogin?: number): void {
    binaryTcpMarketStream.syncAccountSubscription(explicitLogin);
    const activeToken = readNonEmptyString(this.activeToken);
    const sessionToken = readNonEmptyString(getAccessToken());
    if (
      activeToken
      && activeToken !== sessionToken
      && explicitLogin !== undefined
      && explicitLogin > 0
    ) {
      void bindBinaryTcpAccountSub(explicitLogin, activeToken).catch(() => {});
    }
  }

  private attachBinaryTradeEvents(): void {
    if (this.unsubBinaryTradeEvents !== null) return;
    this.unsubBinaryTradeEvents = binaryTcpMarketStream.subscribeTradeEvents(this.handleBinaryTradeEvent);
  }

  private detachBinarySubscriptions(): void {
    if (this.unsubBinaryTradeEvents !== null) {
      const unsub = this.unsubBinaryTradeEvents;
      this.unsubBinaryTradeEvents = null;
      try { unsub(); } catch { /* ignore */ }
    }
    for (const unsub of this.binaryMarketUnsubs.values()) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.binaryMarketUnsubs.clear();
  }

  private syncBinaryMarketChannelSubscriptions(): void {
    if (!isDesktopBackendTarget() || !this.binaryModeConnected) return;
    for (const channel of this.channels) {
      this.attachBinaryMarketChannel(channel);
    }
  }

  private attachBinaryMarketChannel(channel: string): void {
    if (!isDesktopBackendTarget() || !this.binaryModeConnected) return;
    if (this.binaryMarketUnsubs.has(channel)) return;

    const trimmed = channel.trim();
    const lower = trimmed.toLowerCase();

    if (lower === 'ticks.all') {
      const unsub = binaryTcpMarketStream.onTick((tick: DecodedBinaryTick) => {
        if (!this.binaryModeConnected || this.state !== 'open') return;
        this.dispatch({
          channel: 'ticks.all',
          type: 'tick',
          symbol: tick.symbol,
          time: tick.timestamp,
          data: {
            symbol: tick.symbol,
            bid: tick.bid,
            ask: tick.ask,
            spread: tick.spread,
            ...(tick.dailyOpen !== undefined ? { daily_open: tick.dailyOpen } : {}),
            ...(tick.dailyChange !== undefined ? { daily_change: tick.dailyChange, daily_change_pct: tick.dailyChange } : {}),
            time: tick.timestamp,
          },
        });
      });
      this.binaryMarketUnsubs.set(channel, unsub);
      return;
    }

    if (lower.startsWith('ticks.')) {
      const symbol = trimmed.slice('ticks.'.length).trim().toUpperCase();
      if (!symbol) return;
      const unsub = binaryTcpMarketStream.onDirectChartTick(symbol, (tick: DecodedBinaryTick) => {
        if (!this.binaryModeConnected || this.state !== 'open') return;
        this.dispatch({
          channel,
          type: 'tick',
          symbol: tick.symbol,
          time: tick.timestamp,
          data: {
            symbol: tick.symbol,
            bid: tick.bid,
            ask: tick.ask,
            spread: tick.spread,
            ...(tick.dailyOpen !== undefined ? { daily_open: tick.dailyOpen } : {}),
            ...(tick.dailyChange !== undefined ? { daily_change: tick.dailyChange, daily_change_pct: tick.dailyChange } : {}),
            time: tick.timestamp,
          },
        });
      });
      this.binaryMarketUnsubs.set(channel, unsub);
      return;
    }

    if (lower.startsWith('candles.')) {
      const rest = trimmed.slice('candles.'.length);
      const lastDot = rest.lastIndexOf('.');
      const symbol = (lastDot > 0 ? rest.slice(0, lastDot) : rest).trim().toUpperCase();
      const expectedTimeframe = lastDot > 0 ? rest.slice(lastDot + 1).trim().toUpperCase() : '';
      if (!symbol) return;
      const unsub = binaryTcpMarketStream.onCandle(symbol, (candle: DecodedBinaryCandle) => {
        if (!this.binaryModeConnected || this.state !== 'open') return;
        if (expectedTimeframe && candle.timeframe !== expectedTimeframe) return;
        this.dispatch({
          channel,
          type: 'candle',
          symbol: candle.symbol,
          timeframe: candle.timeframe,
          time: candle.time,
          data: {
            time: candle.time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            tick_volume: candle.tickVolume,
            closed: candle.closed,
          },
        });
      });
      this.binaryMarketUnsubs.set(channel, unsub);
    }
  }

  private handleBinaryTradeEvent = (ev: DecodedBinaryTradeEvent): void => {
    if (!this.binaryModeConnected || this.state !== 'open') return;
    const message = toBinaryTradeSocketMessage(ev);
    if (!message) return;
    this.routePendingOrderMessage(message);
    this.dispatch(message);
  };

  private recordPendingOrderLatency(
    pending: PendingOrderRequest,
    phase: TradeOrderLatencyPhase,
    reason?: string,
  ): void {
    const recordedAtMs = tradeOrderNow();
    const terminal = phase === 'order_filled'
      || phase === 'order_rejected'
      || phase === 'ws_transport_error';
    recordTradeOrderLatency({
      phase,
      transport: 'websocket',
      traceId: toTradeOrderTraceId(pending.clientOrderId),
      sessionScope: pending.sessionScope,
      symbol: pending.symbol,
      reason,
      ...(phase === 'order_accepted' && pending.sendCompletedAtMs > 0
        ? { acceptedRttMs: recordedAtMs - pending.sendCompletedAtMs }
        : {}),
      ...(terminal && pending.sendCompletedAtMs > 0
        ? { terminalRttMs: recordedAtMs - pending.sendCompletedAtMs }
        : {}),
      ...(terminal && pending.acceptedAtMs !== null
        ? { acceptedToTerminalMs: recordedAtMs - pending.acceptedAtMs }
        : {}),
      ...(terminal && pending.statusRecoverySentAtMs !== null
        ? { statusRttMs: recordedAtMs - pending.statusRecoverySentAtMs }
        : {}),
      totalMs: recordedAtMs - pending.apiStartedAtMs,
    });
  }

  private armPendingOrderTimer(requestId: string, pending: PendingOrderRequest): void {
    this.clearPendingOrderTimer(pending);
    pending.timer = setTimeout(() => {
      if (this.pendingOrders.get(requestId) !== pending) return;
      if (!pending.recoveryAttempted) {
        this.recoverPendingOrder(requestId, pending);
        return;
      }

      this.recordPendingOrderLatency(pending, 'ws_transport_error', 'status_timeout');
      this.rejectPendingOrder(requestId, new TradeSocketTransportError(
        'The order was sent, but its final status could not be confirmed. Do not place it again; check open positions and order history.', {
        code: 'ORDER_STATUS_TIMEOUT',
        requestId,
        clientOrderId: pending.clientOrderId,
        orderWasSent: true,
      }));
    }, this.options.orderTimeoutMs);
  }

  private recoverPendingOrder(requestId: string, pending: PendingOrderRequest): void {
    if (pending.recoveryAttempted || this.pendingOrders.get(requestId) !== pending) return;
    pending.recoveryAttempted = true;
    this.clearPendingOrderTimer(pending);

    try {
      this.getOrderStatus(pending.clientOrderId, pending.accountLogin, requestId);
      pending.statusRecoverySentAtMs = tradeOrderNow();
      this.recordPendingOrderLatency(pending, 'status_recovery_sent', 'status_reconciliation');
      this.armPendingOrderTimer(requestId, pending);
    } catch (error) {
      const transportError = new TradeSocketTransportError(
        'The order was sent, but its final status could not be confirmed. Do not place it again; check open positions and order history.', {
          code: error instanceof TradeSocketTransportError
            ? error.code || 'ORDER_STATUS_RECOVERY_FAILED'
            : 'ORDER_STATUS_RECOVERY_FAILED',
          requestId,
          clientOrderId: pending.clientOrderId,
          orderWasSent: true,
        });
      this.recordPendingOrderLatency(pending, 'ws_transport_error', 'status_recovery_send_failed');
      this.rejectPendingOrder(requestId, transportError);
    }
  }

  private routePendingOrderMessage(message: TradeSocketMessage): void {
    const record = message as Record<string, unknown>;
    const type = String(record.type || '').trim().toLowerCase();
    if (!['order_accepted', 'order_filled', 'order_rejected', 'order_error', 'order_status_error', 'error'].includes(type)) return;

    const requestId = readCorrelationId(record.request_id);
    const clientOrderId = readCorrelationId(record.client_order_id);
    if (!requestId || !clientOrderId) return;

    const pending = this.pendingOrders.get(requestId);
    if (!pending || pending.clientOrderId !== clientOrderId) return;

    if (type === 'order_accepted') {
      // Acceptance proves durable reservation, but it must not extend the
      // absolute terminal deadline. At that deadline we reconcile status once.
      if (pending.acceptedAtMs !== null) return;
      pending.acceptedAtMs = tradeOrderNow();
      this.recordPendingOrderLatency(pending, 'order_accepted');
      return;
    }

    if (type === 'order_filled') {
      if (!isTerminalTradeOrderMessage(message)) return;
      this.recordPendingOrderLatency(pending, 'order_filled');
      this.resolvePendingOrder(requestId, message as unknown as TradeSocketOrderFilled);
      return;
    }

    // The gateway could not read the durable command. Hand the uncertainty to
    // the REST status reader immediately instead of waiting another full WS
    // timeout. The create was sent, so this must never permit another create.
    if (type === 'order_status_error') {
      const orderError = readOrderError(message);
      this.recordPendingOrderLatency(pending, 'ws_transport_error', orderError.code || 'order_status_error');
      this.rejectPendingOrder(requestId, new TradeSocketTransportError(orderError.message, {
        code: orderError.code || 'ORDER_STATUS_READ_FAILED',
        requestId,
        clientOrderId,
        orderWasSent: true,
      }));
      return;
    }

    // Only order_rejected is a terminal business decision. A correlated
    // order_error or generic error is execution uncertainty, so reconcile the durable
    // client_order_id. The original create frame was already sent and must never
    // be recreated through REST merely because reconciliation times out.
    if (type === 'error' || type === 'order_error') {
      this.recoverPendingOrder(requestId, pending);
      return;
    }

    const orderError = readOrderError(message);
    const status = String(record.status ?? '').trim().toLowerCase() === 'expired'
      ? 'expired'
      : 'rejected';
    if (!isTerminalTradeOrderMessage(message)) {
      this.recoverPendingOrder(requestId, pending);
      return;
    }

    this.recordPendingOrderLatency(pending, 'order_rejected', orderError.code || 'order_rejected');
    this.rejectPendingOrder(requestId, new TradeSocketOrderRejectedError(orderError.message, {
      code: orderError.code,
      requestId,
      clientOrderId,
      status,
    }));
  }

  private resolvePendingOrder(requestId: string, message: TradeSocketOrderFilled): void {
    const pending = this.pendingOrders.get(requestId);
    if (!pending) return;
    this.pendingOrders.delete(requestId);
    this.clearPendingOrderTimer(pending);
    pending.resolve(message);
  }

  private rejectPendingOrder(requestId: string, error: Error): void {
    const pending = this.pendingOrders.get(requestId);
    if (!pending) return;
    this.pendingOrders.delete(requestId);
    this.clearPendingOrderTimer(pending);
    pending.reject(error);
  }

  private clearPendingOrderTimer(pending: PendingOrderRequest): void {
    if (pending.timer === null) return;
    clearTimeout(pending.timer);
    pending.timer = null;
  }

  private rejectAllPendingOrders(message: string): void {
    for (const [requestId, pending] of this.pendingOrders) {
      this.recordPendingOrderLatency(pending, 'ws_transport_error', 'socket_closed');
      this.rejectPendingOrder(requestId, new TradeSocketTransportError(message, {
        requestId,
        clientOrderId: pending.clientOrderId,
        orderWasSent: true,
      }));
    }
  }

  private addHandler(channel: string, handler: TradeSocketHandler): void {
    const handlers = this.handlers.get(channel) || new Set<TradeSocketHandler>();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
  }

  private parseMessage(data: string): TradeSocketMessage {
    try {
      return JSON.parse(data) as TradeSocketMessage;
    } catch {
      return { type: 'raw', data };
    }
  }

  private dispatch(message: TradeSocketMessage): void {
    const delivered = new Set<TradeSocketHandler>();
    const notifySet = (set: Set<TradeSocketHandler> | undefined): void => {
      if (!set) return;
      set.forEach(handler => {
        if (delivered.has(handler)) return;
        delivered.add(handler);
        handler(message);
      });
    };

    const channel = message.channel || this.inferChannel(message);
    if (channel) {
      notifySet(this.handlers.get(channel));
      const dotIndex = channel.indexOf('.');
      if (dotIndex > 0) {
        const prefix = channel.slice(0, dotIndex);
        notifySet(this.handlers.get(`${prefix}.*`));
        notifySet(this.handlers.get(prefix));
      }
    }
    notifySet(this.handlers.get('*'));
    notifySet(this.anyHandlers);
  }

  private inferChannel(message: TradeSocketMessage): string | undefined {
    const data = message.data && typeof message.data === 'object' ? message.data as Record<string, unknown> : undefined;
    const payload = message.payload && typeof message.payload === 'object' ? message.payload as Record<string, unknown> : undefined;
    const symbol = typeof message.symbol === 'string'
      ? message.symbol
      : typeof data?.symbol === 'string'
        ? data.symbol
        : typeof payload?.symbol === 'string'
          ? payload.symbol
          : undefined;
    const login = typeof message.login === 'number' || typeof message.login === 'string'
      ? message.login
      : typeof message.account_login === 'number' || typeof message.account_login === 'string'
        ? message.account_login
        : undefined;
    const type = String(message.type || message.action || '').toLowerCase();

    if (type.includes('tick') && symbol) return `ticks.${symbol}`;
    if (type.includes('candle') && symbol) return `candles.${symbol}.${String(message.timeframe || '')}`;
    if ((type.includes('depth') || type.includes('orderbook') || type.includes('order_book')) && symbol) return `depth.${symbol}`;
    if (type.includes('position') && login) return `positions.${login}`;
    if (type.includes('metric') && login) return `metrics.${login}`;
    if (type.includes('account') && login) return `account.${login}`;
    if (type.includes('order') && login) return `orders.${login}`;
    if (type.includes('deal') && login) return `deals.${login}`;
    if (type.includes('state') && login) return `state.${login}`;

    return undefined;
  }

  private hasCurrentDeploymentConnection(): boolean {
    return Boolean(this.activeUrl && isTradeSocketAllowed(this.activeUrl, this.activeToken, this.activeBrokerId));
  }

  private scheduleReconnect(): void {
    if (isDesktopBackendTarget()) return;
    if (!this.options.reconnect || this.reconnectTimer || this.reconnectPendingWhileHidden) return;

    if (this.isDocumentHidden()) {
      this.reconnectPendingWhileHidden = true;
      return;
    }

    const exponentialDelay = Math.min(
      this.options.reconnectDelayMs * 2 ** this.reconnectAttempts,
      this.options.maxReconnectDelayMs
    );
    const delay = addReconnectJitter(exponentialDelay, this.options.maxReconnectDelayMs);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isDocumentHidden()) {
        this.reconnectPendingWhileHidden = true;
        return;
      }
      this.connect();
    }, delay);
  }

  private isUncorrelatedPongMessage(message: TradeSocketMessage): boolean {
    const record = message as Record<string, unknown>;
    const action = typeof record.action === 'string' ? record.action.trim().toLowerCase() : '';
    const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
    if (action !== 'pong' && type !== 'pong') return false;
    const requestId = readCorrelationId(record.request_id);
    return !requestId || !this.pendingOrders.has(requestId);
  }

  private startKeepaliveTimer(socket: WebSocket): void {
    this.clearKeepaliveTimer();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws === socket && this.state === 'open' && this.ws?.readyState === WS_OPEN) {
        this.send({ action: 'ping' });
      }
    }, TRADE_WS_KEEPALIVE_INTERVAL_MS);
  }

  private clearKeepaliveTimer(): void {
    if (!this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private clearStableOpenTimer(): void {
    if (!this.stableOpenTimer) return;
    clearTimeout(this.stableOpenTimer);
    this.stableOpenTimer = null;
  }

  private scheduleStableOpenReset(socket: WebSocket): void {
    this.clearStableOpenTimer();
    this.stableOpenTimer = setTimeout(() => {
      this.stableOpenTimer = null;
      if (this.ws === socket && socket.readyState === WS_OPEN && this.state === 'open') {
        this.reconnectAttempts = 0;
      }
    }, TRADE_WS_STABLE_OPEN_MS);
  }

  private isDocumentHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  private handleVisibilityChange = (): void => {
    if (isDesktopBackendTarget()) return;
    if (this.isDocumentHidden()) {
      if (this.reconnectTimer) {
        this.clearReconnectTimer();
        this.reconnectPendingWhileHidden = true;
      }
      return;
    }

    if (!this.reconnectPendingWhileHidden || !this.options.reconnect) return;
    this.reconnectPendingWhileHidden = false;
    this.connect();
  };

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: TradeSocketState): void {
    this.state = state;
    this.stateHandlers.forEach(handler => handler(state));
  }
}

let sharedTradeSocket: TradeWebSocketClient | null = null;
let sharedLifecycleInitialized = false;
let sharedLifecycleQueued = false;

const reconcileSharedTradeSocket = (): void => {
  sharedLifecycleQueued = false;
  const desktopMode = isDesktopBackendTarget();
  if (!desktopMode && typeof WebSocket === 'undefined') return;

  const sessionScope = getCommittedBrokerAccountSessionScope();
  const token = getAuthToken() || undefined;
  if (!sessionScope.authenticated || !sessionScope.accountId || !token || isStoredTokenExpired()) {
    destroyTradeWebSocketClient();
    return;
  }

  if (desktopMode) {
    const url = DESKTOP_BINARY_TRADE_URL;
    const scopedLogin = toPositiveSafeInteger(sessionScope.accountId);
    if (sharedTradeSocket?.usesConnection(token, url)) {
      if (!sharedTradeSocket.isReady()) {
        sharedTradeSocket.connect(token);
      } else {
        binaryTcpMarketStream.start();
        binaryTcpMarketStream.syncAccountSubscription(scopedLogin);
      }
      return;
    }

    destroyTradeWebSocketClient();
    sharedTradeSocket = new TradeWebSocketClient({ token, url });
    sharedTradeSocket.connect(token);
    return;
  }

  const url = buildApiV2WsUrl(token);
  if (!url) return;
  if (sharedTradeSocket?.usesConnection(token, url)) {
    if (sharedTradeSocket.readyState !== WS_CONNECTING && sharedTradeSocket.readyState !== WS_OPEN) {
      sharedTradeSocket.connect(token);
    }
    return;
  }

  destroyTradeWebSocketClient();
  sharedTradeSocket = new TradeWebSocketClient({ token, url });
  sharedTradeSocket.connect(token);
};

const queueSharedTradeSocketReconcile = (): void => {
  if (sharedLifecycleQueued) return;
  sharedLifecycleQueued = true;
  queueMicrotask(reconcileSharedTradeSocket);
};

export const initializeTradeWebSocketClient = (): void => {
  if (sharedLifecycleInitialized || typeof window === 'undefined') return;
  sharedLifecycleInitialized = true;
  window.addEventListener('auth:token-updated', queueSharedTradeSocketReconcile);
  // Re-warm a socket that the browser closed while the network or tab was
  // suspended. These listeners never delay a click and do not create a second
  // connection when the existing authenticated socket is still open.
  window.addEventListener('online', queueSharedTradeSocketReconcile);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') queueSharedTradeSocketReconcile();
  });
  // App may be evaluated speculatively while the anonymous login form is
  // visible. A stored token alone is not an authenticated runtime session;
  // connect as soon as the validated account scope is committed instead.
  onCommittedBrokerAccountSessionScopeChange(queueSharedTradeSocketReconcile);
  onSessionChange(queueSharedTradeSocketReconcile);
  queueSharedTradeSocketReconcile();
};

export const getTradeWebSocketClient = (options?: TradeSocketOptions): TradeWebSocketClient => {
  if (!sharedTradeSocket) {
    sharedTradeSocket = new TradeWebSocketClient(options);
  }
  return sharedTradeSocket;
};

export const destroyTradeWebSocketClient = (): void => {
  sharedTradeSocket?.disconnect();
  sharedTradeSocket = null;
};
