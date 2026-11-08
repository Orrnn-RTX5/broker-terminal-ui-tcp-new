/**
 * Enhanced WebSocket Service — 100% Zero-WebSocket Pure Binary TCP in Desktop Mode
 *
 * - In Desktop Mode (`isDesktopBackendTarget() === true`):
 *   1. `new WebSocket(...)` is NEVER called for ANY endpoint (`/ws/v2`, `/ws/feed`, `/fix-ws`, etc.).
 *   2. All `ticks.*`, `quotes.*`, and `candles.*` subscriptions are served 100% locally
 *      from `binaryTcpMarketStream` (`/__rtx5_binary_stream` over `:4443` Binary TCP, frames
 *      `0x21` & `0x22`) with ZERO WebSocket subscribe traffic and ZERO JSON tick parsing.
 *   3. Authenticated `/ws/v2` private trade/account execution events (`account.*`, `positions.*`,
 *      `orders.*`, `metrics.*`, `deals.*`, `state.*`) stream directly over Binary TCP frame `0x3A`
 *      (`FrameBinaryTradeEvent`) bound via `POST /__rtx5_binary_account_sub` (`0x3B`).
 */

import { useWebSocketStore } from '../store/useWebSocketStore';
import { enqueueLiveTick } from './liveTickDispatcher';
import { buildBrokerWsV2Uri, getAccessToken, onSessionChange } from './brokerSession';
import { normalizeWsUrl as normalizeRuntimeWsUrl } from '../config/api';
import { isDesktopBackendTarget } from '../config/backendTarget.js';
import {
  binaryTcpMarketStream,
  type DecodedBinaryTick,
  type DecodedBinaryTradeEvent,
} from './binaryTcpMarketStream';
import {
  composeDailyChangeQuoteContext,
  readDailyChangeLastPrice,
  readDailyChangePercent,
  readDailyChangeInput,
  readDailyChangePreviousClose,
  resolveDailyChangePercent,
} from '../utils/dailyChange';
import { readRegisteredSymbolPriceSpec, resolveDailyChangePriceMode } from './dailyChangePriceModeRegistry';
import {
  isEnhancedStoreHandledTickFrame,
  isExactAccountStreamChannel,
  type WebSocketMessage,
} from './enhancedWebSocketMessage';
import { readFirstFiniteNumber, readFirstNonEmptyString } from '../utils/recordFields';
import { readQuoteSessionRange } from '../utils/quoteSessionRange';
import {
  asUnknownRecord,
  normalizeBrokerTimestampMs,
  readBrokerTimestampMs,
  readCandleFinality,
} from '../utils/brokerStreamSemantics';

export { isEnhancedStoreHandledTickFrame, isExactAccountStreamChannel };
export type { WebSocketMessage };

export const isLocalOnlyChannel = (channel: string): boolean => channel === '*';

const isBinaryInterceptedMarketChannel = (channel: string): boolean => {
  if (!isDesktopBackendTarget()) return false;
  const normalized = channel.trim().toLowerCase();
  return (
    normalized.startsWith('ticks.')
    || normalized.startsWith('quotes.')
    || normalized.startsWith('candles.')
  );
};

const extractMarketSymbolFromChannel = (channel: string): string => {
  const trimmed = channel.trim();
  if (trimmed.toLowerCase().startsWith('ticks.')) {
    return trimmed.slice('ticks.'.length).trim().toUpperCase();
  }
  if (trimmed.toLowerCase().startsWith('quotes.')) {
    return trimmed.slice('quotes.'.length).trim().toUpperCase();
  }
  if (trimmed.toLowerCase().startsWith('candles.')) {
    const rest = trimmed.slice('candles.'.length);
    const lastDot = rest.lastIndexOf('.');
    return (lastDot > 0 ? rest.slice(0, lastDot) : rest).trim().toUpperCase();
  }
  return '';
};

export type SubscriptionCallback = (data: unknown) => void;
export type ConnectionStateCallback = (state: ConnectionState) => void;
export type MetricsCallback = (metrics: ConnectionMetrics) => void;

export const ConnectionState = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
  OFFLINE: 'offline',
} as const;

export type ConnectionState = (typeof ConnectionState)[keyof typeof ConnectionState];

const PRIVATE_ACCOUNT_CHANNEL_RE = /^(?:account|accounts|positions|orders|pending_orders|metrics|deals|state|trades)\.([1-9]\d*)$/i;

const BINARY_EVENT_KIND_PREFIX: Readonly<Record<number, string>> = {
  1: 'positions',
  2: 'orders',
  3: 'account',
  4: 'metrics',
  5: 'deals',
  6: 'state',
};

const extractAccountLoginFromChannel = (channel: string): number => {
  const match = PRIVATE_ACCOUNT_CHANNEL_RE.exec(channel.trim());
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const parsePositiveLoginValue = (value: unknown): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) return 0;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
};

const extractLoginFromRecordFields = (record: Record<string, unknown> | null | undefined): number => {
  if (!record) return 0;
  for (const key of ['account_login', 'accountLogin', 'account_id', 'accountId', 'login']) {
    const login = parsePositiveLoginValue(record[key]);
    if (login > 0) return login;
  }
  return 0;
};

const extractExplicitAccountLoginFromMessage = (message: WebSocketMessage): number => {
  const record = message as unknown as Record<string, unknown>;
  const directLogin = extractLoginFromRecordFields(record);
  if (directLogin > 0) return directLogin;

  if (typeof message.channel === 'string') {
    const chLogin = extractAccountLoginFromChannel(message.channel);
    if (chLogin > 0) return chLogin;
  }

  const topic = typeof record.topic === 'string' ? record.topic : '';
  if (topic) {
    const topicLogin = extractAccountLoginFromChannel(topic);
    if (topicLogin > 0) return topicLogin;
  }

  if (Array.isArray(message.channels)) {
    for (const ch of message.channels) {
      if (typeof ch === 'string') {
        const chLogin = extractAccountLoginFromChannel(ch);
        if (chLogin > 0) return chLogin;
      }
    }
  }

  const nestedData = asUnknownRecord(message.data);
  const nestedDataLogin = extractLoginFromRecordFields(nestedData);
  if (nestedDataLogin > 0) return nestedDataLogin;
  if (typeof nestedData?.channel === 'string') {
    const nestedChLogin = extractAccountLoginFromChannel(nestedData.channel);
    if (nestedChLogin > 0) return nestedChLogin;
  }

  const nestedPayload = asUnknownRecord(record.payload);
  const nestedPayloadLogin = extractLoginFromRecordFields(nestedPayload);
  if (nestedPayloadLogin > 0) return nestedPayloadLogin;
  if (typeof nestedPayload?.channel === 'string') {
    const nestedPayloadChLogin = extractAccountLoginFromChannel(nestedPayload.channel);
    if (nestedPayloadChLogin > 0) return nestedPayloadChLogin;
  }

  return 0;
};

const readControlAction = (message: WebSocketMessage): string => {
  const record = message as unknown as Record<string, unknown>;
  const raw = typeof message.action === 'string' && message.action.trim()
    ? message.action
    : (typeof message.type === 'string' ? message.type : (typeof record.op === 'string' ? record.op : ''));
  return raw.trim().toLowerCase();
};

const isAuthControlMessage = (message: WebSocketMessage): boolean => {
  const action = readControlAction(message);
  if (action === 'auth' || action === 'authenticate' || action === 'login') {
    return true;
  }
  const record = message as unknown as Record<string, unknown>;
  return typeof record.token === 'string' && record.token.trim().length > 0;
};

const resolveBinaryTradeEventChannel = (ev: DecodedBinaryTradeEvent): string => {
  const explicit = typeof ev.channel === 'string' ? ev.channel.trim() : '';
  if (explicit) return explicit;
  const prefix = BINARY_EVENT_KIND_PREFIX[ev.eventKind];
  if (!prefix) return '';
  const login = typeof ev.accountLogin === 'number' && Number.isFinite(ev.accountLogin) && ev.accountLogin > 0
    ? Math.trunc(ev.accountLogin)
    : 0;
  return login > 0 ? `${prefix}.${login}` : prefix;
};

const resolveTickSourceTimestampMs = (...values: unknown[]): number | undefined => {
  return readBrokerTimestampMs(values.map(asUnknownRecord));
};

export interface ConnectionMetrics {
  messagesSent: number;
  messagesReceived: number;
  reconnectAttempts: number;
  lastLatency: number;
  latencyMeasuredAt?: number | null;
  averageLatency: number;
  uptime: number;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
}

interface QueuedMessage {
  message: WebSocketMessage;
  timestamp: number;
  retries: number;
}

export const ENHANCED_WS_OPEN_TIMEOUT_MS = 5_000;
export const ENHANCED_WS_STABLE_OPEN_MS = 10_000;

const RECONNECT_JITTER_RATIO = 0.2;

const addReconnectJitter = (delay: number, maximum: number): number => {
  const jitter = Math.floor(delay * RECONNECT_JITTER_RATIO * Math.random());
  return Math.min(maximum, delay + jitter);
};

export class EnhancedWebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private readonly rawRequestedUrl: string;

  private reconnectAttempts = 0;
  private baseReconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private openTimeout: ReturnType<typeof setTimeout> | null = null;
  private stableOpenTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectPendingWhileHidden = false;

  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingIntervalMs = 25000;
  private pongTimeoutMs = 15000;
  private lastPongTime = 0;
  private lastPingSentAt = 0;
  private lastPingStartedAt = 0;
  private pongSupportedUrl: string | null = null;
  private lastDataTime = 0;
  private lastBinaryTradeMetricsNotifyAt = 0;

  private subscribers: Map<string, Set<SubscriptionCallback>> = new Map();
  private binaryTickUnsubs: Map<string, () => void> = new Map();
  private unsubBinaryTradeEvents: (() => void) | null = null;
  private lastSyncedDesktopLogin = 0;
  private lastSyncedDesktopToken = '';
  private stateListeners: Set<ConnectionStateCallback> = new Set();
  private metricsListeners: Set<MetricsCallback> = new Set();
  private messageListeners: Set<SubscriptionCallback> = new Set();
  private openListeners: Set<() => void> = new Set();
  private eventListeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private disposed = false;
  private unsubSessionChange: (() => void) | null = null;

  private messageQueue: QueuedMessage[] = [];
  private maxQueueSize = 1000;

  private metrics: ConnectionMetrics = {
    messagesSent: 0,
    messagesReceived: 0,
    reconnectAttempts: 0,
    lastLatency: 0,
    averageLatency: 0,
    uptime: 0,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
  };
  private latencyMeasurements: number[] = [];
  private maxLatencyMeasurements = 100;

  constructor(url: string) {
    this.rawRequestedUrl = url || '';
    this.url = this.normalizeWsUrl(url);

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
      document.addEventListener('visibilitychange', this.handleVisibilityChange);

      this.unsubSessionChange = onSessionChange((reason) => {
        if (reason === 'logout' || reason === 'login' || reason === 'broker_url_change' || reason === 'account_change') {
          this.messageQueue = [];
          this.lastSyncedDesktopLogin = 0;
          this.lastSyncedDesktopToken = '';
        }
        if (reason === 'logout') {
          if (isDesktopBackendTarget() && !this.isMarketFeedOnlyEndpoint()) {
            binaryTcpMarketStream.syncAccountSubscription(0);
          }
          this.disconnect();
        } else if (
          reason === 'token_rotation'
          || reason === 'broker_url_change'
          || reason === 'login'
          || reason === 'account_change'
        ) {
          this.lastSyncedDesktopLogin = 0;
          this.lastSyncedDesktopToken = '';
          this.forceReconnect();
        }
      });
    }
  }

  private isMarketFeedOnlyEndpoint(): boolean {
    if (!isDesktopBackendTarget()) return false;
    const lower = this.rawRequestedUrl.toLowerCase();
    return lower.includes('/ws/feed') || lower.includes('/fix-ws');
  }

  public forceReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.clearOpenTimeout();
    this.clearStableOpenTimeout();
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try { socket.close(1000, 'force reconnect'); } catch { /* ignore */ }
    }
    this.stopPingInterval();
    if (isDesktopBackendTarget()) {
      this.lastSyncedDesktopLogin = 0;
      this.lastSyncedDesktopToken = '';
      if (!binaryTcpMarketStream.isConnected()) {
        binaryTcpMarketStream.forceReconnect();
      }
      this.connect();
      return;
    }
    if (this.isRuntimeSuspended()) {
      this.reconnectPendingWhileHidden = true;
      this.updateState(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'reconnecting');
      return;
    }
    this.connect();
  }

  public updateUrl(newUrl: string): void {
    const normalized = this.normalizeWsUrl(newUrl);
    if (normalized === this.url) return;
    this.url = normalized;
    this.forceReconnect();
  }

  private handleVisibilityChange = (): void => {
    if (isDesktopBackendTarget()) return;

    if (document.visibilityState === 'hidden') {
      this.stopPingInterval();
      this.clearOpenTimeout();
      this.reconnectPendingWhileHidden = Boolean(this.ws || this.subscribers.size > 0 || this.reconnectTimeout);
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      if (this.reconnectPendingWhileHidden) this.updateState('reconnecting');
      return;
    }

    if (document.visibilityState === 'visible') {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        this.reconnectPendingWhileHidden = Boolean(this.ws || this.subscribers.size > 0);
        return;
      }

      const staleThreshold = 30000;
      const timeSinceLastData = Date.now() - this.lastDataTime;
      const heartbeatIsStale = this.pongSupportedUrl === this.url && (
        this.lastPongTime === 0
        || Date.now() - this.lastPongTime > this.pingIntervalMs + this.pongTimeoutMs + 5000
      );
      if (
        this.reconnectPendingWhileHidden
        || !this.ws
        || this.ws.readyState !== WebSocket.OPEN
        || (timeSinceLastData > staleThreshold && heartbeatIsStale)
      ) {
        this.reconnectPendingWhileHidden = false;
        this.forceReconnect();
      } else {
        this.startPingInterval();
      }
    }
  };

  public connect(): void {
    if (this.disposed) return;

    // 100% Zero-WebSocket Pure Binary TCP in Desktop Mode:
    // NEVER invoke `new WebSocket(...)` for ANY endpoint (/ws/v2, /ws/feed, /fix-ws, etc.).
    if (isDesktopBackendTarget()) {
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      this.clearOpenTimeout();
      this.clearStableOpenTimeout();
      this.stopPingInterval();
      this.reconnectPendingWhileHidden = false;
      this.reconnectAttempts = 0;
      this.messageQueue = [];

      const wasConnected = this.connectionState === ConnectionState.CONNECTED;
      binaryTcpMarketStream.start();
      if (!this.isMarketFeedOnlyEndpoint()) {
        this.attachBinaryTradeEvents();
        this.syncDesktopAccountSubscription(undefined, !wasConnected);
      }

      const now = Date.now();
      this.lastDataTime = now;
      this.metrics.lastConnectedAt = now;
      this.updateState(ConnectionState.CONNECTED);
      this.notifyMetricsListeners();
      return;
    }

    if (this.isRuntimeSuspended()) {
      this.reconnectPendingWhileHidden = true;
      this.updateState(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'reconnecting');
      return;
    }
    if (
      this.ws?.readyState === WebSocket.OPEN
      || this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    this.clearOpenTimeout();

    const token = getAccessToken();
    if (!token) {
      this.updateState('disconnected');
      return;
    }

    this.updateState('connecting');

    let urlWithAuth: string;
    const configuredUrl = buildBrokerWsV2Uri(null);
    if (configuredUrl) {
      this.url = configuredUrl;
      urlWithAuth = buildBrokerWsV2Uri(token);
    } else {
      this.updateState('disconnected');
      return;
    }
    if (!urlWithAuth) {
      this.updateState('disconnected');
      return;
    }

    if (isDesktopBackendTarget()) {
      return;
    }

    try {
      const socket = new WebSocket(urlWithAuth);
      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.clearOpenTimeout();
        this.lastDataTime = Date.now();
        this.lastPongTime = 0;
        this.lastPingSentAt = 0;
        this.lastPingStartedAt = 0;
        this.latencyMeasurements = [];
        this.metrics.lastLatency = 0;
        this.metrics.averageLatency = 0;
        this.metrics.latencyMeasuredAt = null;
        this.metrics.lastConnectedAt = Date.now();
        this.updateState('connected');
        this.startPingInterval();
        this.processMessageQueue();
        this.resubscribeChannels();
        this.notifyMetricsListeners();
        this.scheduleStableOpenReset(socket);
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        this.lastDataTime = Date.now();
        try {
          const data = JSON.parse(event.data) as WebSocketMessage;
          this.handleMessage(data);
          this.metrics.messagesReceived++;
        } catch (error) {
          console.error('[WS] Failed to parse message:', error);
        }
      };

      socket.onerror = (error) => {
        if (this.ws !== socket) return;
        console.error('[WS] Error:', error);
        this.updateState('error');
      };

      socket.onclose = (event) => {
        if (this.ws !== socket) return;
        this.clearOpenTimeout();
        this.clearStableOpenTimeout();
        this.ws = null;
        this.metrics.lastDisconnectedAt = Date.now();
        this.updateState('disconnected');
        this.stopPingInterval();
        this.notifyMetricsListeners();

        if ([1008, 4001, 4003, 4401, 4403].includes(event.code) || event.code === 401) {
          localStorage.removeItem('auth_token');
          localStorage.removeItem('refresh_token');
          localStorage.removeItem('token_expires_at');
          sessionStorage.removeItem('auth_token');
          sessionStorage.removeItem('refresh_token');
          sessionStorage.removeItem('token_expires_at');
          window.dispatchEvent(new CustomEvent('ws-auth-failed'));
          window.dispatchEvent(new CustomEvent('auth:unauthorized', { detail: { reason: 'websocket_auth_failed' } }));
          return;
        }

        this.attemptReconnect();
      };
      this.startOpenTimeout(socket);
    } catch {
      this.updateState('error');
      this.attemptReconnect();
    }
  }

  public disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.clearOpenTimeout();
    this.clearStableOpenTimeout();
    this.reconnectPendingWhileHidden = false;
    this.stopPingInterval();
    this.detachBinaryTradeEvents();
    this.lastSyncedDesktopLogin = 0;
    this.lastSyncedDesktopToken = '';

    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      socket.close(1000, 'Client initiated disconnect');
    }

    this.reconnectAttempts = 0;
    if (this.connectionState !== ConnectionState.DISCONNECTED) {
      this.metrics.lastDisconnectedAt = Date.now();
    }
    this.updateState(ConnectionState.DISCONNECTED);
    this.notifyMetricsListeners();
  }

  private attachBinaryTradeEvents(): void {
    if (this.unsubBinaryTradeEvents || this.disposed || !isDesktopBackendTarget()) return;
    this.unsubBinaryTradeEvents = binaryTcpMarketStream.subscribeTradeEvents((ev) => {
      this.handleBinaryTradeEvent(ev);
    });
  }

  private detachBinaryTradeEvents(): void {
    if (!this.unsubBinaryTradeEvents) return;
    const unsub = this.unsubBinaryTradeEvents;
    this.unsubBinaryTradeEvents = null;
    unsub();
  }

  private resolveSubscribedAccountLogin(): number | undefined {
    let fallbackLogin = 0;
    for (const channel of this.subscribers.keys()) {
      const login = extractAccountLoginFromChannel(channel);
      if (login > 0) {
        if (channel.trim().toLowerCase().startsWith('account.')) {
          return login;
        }
        fallbackLogin = login;
      }
    }
    return fallbackLogin > 0 ? fallbackLogin : undefined;
  }

  private syncDesktopAccountSubscription(explicitLogin?: number, force = false): void {
    if (!isDesktopBackendTarget() || this.isMarketFeedOnlyEndpoint()) return;

    const token = getAccessToken() ?? '';
    const candidateLogin = (typeof explicitLogin === 'number' && Number.isFinite(explicitLogin) && explicitLogin > 0)
      ? Math.trunc(explicitLogin)
      : (this.resolveSubscribedAccountLogin() ?? 0);

    if (
      !force
      && candidateLogin > 0
      && candidateLogin === this.lastSyncedDesktopLogin
      && token === this.lastSyncedDesktopToken
    ) {
      return;
    }
    if (
      !force
      && candidateLogin === 0
      && this.lastSyncedDesktopLogin === -1
      && token === this.lastSyncedDesktopToken
    ) {
      return;
    }

    this.lastSyncedDesktopLogin = candidateLogin > 0 ? candidateLogin : -1;
    this.lastSyncedDesktopToken = token;
    binaryTcpMarketStream.syncAccountSubscription(candidateLogin > 0 ? candidateLogin : undefined);
  }

  private handleBinaryTradeEvent(ev: DecodedBinaryTradeEvent): void {
    if (this.disposed) return;

    const channel = resolveBinaryTradeEventChannel(ev);
    if (!channel) return;

    const payloadRecord = asUnknownRecord(ev.payload);
    const isPrewrappedChannelMessage = Boolean(
      payloadRecord
      && payloadRecord.type === 'channel_message'
      && typeof payloadRecord.channel === 'string'
      && 'data' in payloadRecord,
    );
    const innerData = isPrewrappedChannelMessage ? payloadRecord!.data : ev.payload;

    const now = Date.now();
    const timestamp = (typeof ev.timestampMs === 'number' && Number.isFinite(ev.timestampMs) && ev.timestampMs > 0)
      ? ev.timestampMs
      : now;

    const channelLogin = extractAccountLoginFromChannel(channel);
    const resolvedLogin = channelLogin > 0
      ? channelLogin
      : (typeof ev.accountLogin === 'number' && Number.isFinite(ev.accountLogin) && ev.accountLogin > 0
        ? Math.trunc(ev.accountLogin)
        : 0);

    this.lastDataTime = now;
    this.metrics.messagesReceived++;
    const shouldNotifyMetrics = now - this.lastBinaryTradeMetricsNotifyAt >= 1000;
    if (shouldNotifyMetrics) {
      this.lastBinaryTradeMetricsNotifyAt = now;
      try {
        useWebSocketStore.getState().updateLastMessageTime(now);
      } catch { /* store not ready */ }
    }

    const envelope: WebSocketMessage = {
      type: 'channel_message',
      channel,
      topic: channel,
      data: innerData,
      payload: innerData,
      timestamp,
      ...(resolvedLogin > 0 ? { account_login: resolvedLogin } : {}),
      ...(typeof ev.eventKind === 'number' && ev.eventKind > 0 ? { eventKind: ev.eventKind } : {}),
    };

    this.handleMessage(envelope);

    // Bridge `state.<login>` invalidations for Orders & History:
    const stateMatch = /^state\.([1-9]\d*)$/.exec(channel);
    if (stateMatch) {
      const stateLogin = stateMatch[1];
      const innerRecord = asUnknownRecord(innerData);
      const nestedDataRecord = asUnknownRecord(innerRecord?.data);
      const entity = (
        (typeof nestedDataRecord?.entity === 'string' && nestedDataRecord.entity)
        || (typeof innerRecord?.entity === 'string' && innerRecord.entity)
        || ''
      ).trim().toLowerCase();

      let syntheticChannel = '';
      if (entity === 'orders' || entity === 'pending_orders') {
        syntheticChannel = `orders.${stateLogin}`;
      } else if (entity === 'deals' || entity === 'history') {
        syntheticChannel = `deals.${stateLogin}`;
      }

      if (syntheticChannel) {
        this.handleMessage({
          type: 'channel_message',
          channel: syntheticChannel,
          topic: syntheticChannel,
          data: innerData,
          payload: innerData,
          timestamp,
          ...(resolvedLogin > 0 ? { account_login: resolvedLogin } : {}),
        });
      }
    }

    if (shouldNotifyMetrics) {
      this.notifyMetricsListeners();
    }
  }

  private clearOpenTimeout(): void {
    if (this.openTimeout === null) return;
    clearTimeout(this.openTimeout);
    this.openTimeout = null;
  }

  private clearStableOpenTimeout(): void {
    if (this.stableOpenTimeout === null) return;
    clearTimeout(this.stableOpenTimeout);
    this.stableOpenTimeout = null;
  }

  private scheduleStableOpenReset(socket: WebSocket): void {
    this.clearStableOpenTimeout();
    this.stableOpenTimeout = setTimeout(() => {
      this.stableOpenTimeout = null;
      if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
        this.reconnectAttempts = 0;
      }
    }, ENHANCED_WS_STABLE_OPEN_MS);
  }

  private isDocumentHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  private isRuntimeSuspended(): boolean {
    return this.isDocumentHidden()
      || (typeof navigator !== 'undefined' && navigator.onLine === false);
  }

  private startOpenTimeout(socket: WebSocket): void {
    this.clearOpenTimeout();
    this.openTimeout = setTimeout(() => {
      this.openTimeout = null;
      if (this.ws !== socket || socket.readyState !== WebSocket.CONNECTING) return;
      if (this.isRuntimeSuspended()) {
        this.reconnectPendingWhileHidden = true;
        return;
      }

      this.ws = null;
      try { socket.close(4000, 'Opening handshake timed out'); } catch { /* ignore */ }
      this.metrics.lastDisconnectedAt = Date.now();
      this.updateState('disconnected');
      this.notifyMetricsListeners();
      this.attemptReconnect();
    }, ENHANCED_WS_OPEN_TIMEOUT_MS);
  }

  private attachBinaryMarketChannel(channel: string): void {
    if (this.binaryTickUnsubs.has(channel)) return;
    const symbol = extractMarketSymbolFromChannel(channel);
    if (!symbol) return;

    const lower = channel.trim().toLowerCase();
    if (lower.startsWith('candles.')) {
      const unsub = binaryTcpMarketStream.onCandle(symbol, (candle) => {
        if (this.disposed) return;
        const msg: WebSocketMessage = {
          type: 'update',
          channel,
          symbol: candle.symbol,
          timeframe: candle.timeframe,
          candle: {
            time: candle.time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            tick_volume: candle.tickVolume,
            closed: candle.closed,
          },
        };
        this.handleFixCandle(msg);
        this.broadcastToSubscribers(msg);
      });
      this.binaryTickUnsubs.set(channel, unsub);
      return;
    }

    const emitBinaryTick = (bt: DecodedBinaryTick) => {
      if (this.disposed) return;
      const specDigits = readRegisteredSymbolPriceSpec(bt.symbol).digits;
      const msg: WebSocketMessage = {
        type: 'tick',
        channel,
        symbol: bt.symbol,
        bid: bt.bid,
        ask: bt.ask,
        spread: bt.spread,
        timestamp: bt.timestamp,
        sourceTimestamp: bt.sourceTimestamp,
        ...(specDigits !== null ? { digits: specDigits } : {}),
        ...(bt.dailyChange !== undefined ? { dailyChange: bt.dailyChange } : {}),
        ...(bt.high24h !== undefined ? { high24h: bt.high24h } : {}),
        ...(bt.low24h !== undefined ? { low24h: bt.low24h } : {}),
        ...(bt.dailyOpen !== undefined ? { open: bt.dailyOpen } : {}),
      };
      this.broadcastToSubscribers(msg);
    };

    const unsub = binaryTcpMarketStream.onDirectChartTick(symbol, emitBinaryTick);
    this.binaryTickUnsubs.set(channel, unsub);
  }

  private detachBinaryMarketChannel(channel: string): void {
    const unsub = this.binaryTickUnsubs.get(channel);
    if (unsub) {
      unsub();
      this.binaryTickUnsubs.delete(channel);
    }
  }

  public subscribe(channel: string, callback: SubscriptionCallback): () => void {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }

    this.subscribers.get(channel)!.add(callback);

    if (isLocalOnlyChannel(channel)) {
      return () => {
        const callbacks = this.subscribers.get(channel);
        if (!callbacks) return;
        callbacks.delete(callback);
        if (callbacks.size === 0) this.subscribers.delete(channel);
      };
    }

    // Pure Binary TCP intercept for market-data channels in Desktop mode!
    if (isBinaryInterceptedMarketChannel(channel)) {
      this.attachBinaryMarketChannel(channel);
      return () => {
        const callbacks = this.subscribers.get(channel);
        if (callbacks) {
          callbacks.delete(callback);
          if (callbacks.size === 0) {
            this.subscribers.delete(channel);
            this.detachBinaryMarketChannel(channel);
          }
        }
      };
    }

    // Pure Binary TCP intercept for private /ws/v2 & general channels in Desktop mode!
    if (isDesktopBackendTarget()) {
      binaryTcpMarketStream.start();
      if (!this.isMarketFeedOnlyEndpoint()) {
        this.attachBinaryTradeEvents();
        const channelLogin = extractAccountLoginFromChannel(channel);
        if (channelLogin > 0) {
          this.syncDesktopAccountSubscription(channelLogin, false);
        }
      }
      return () => {
        const callbacks = this.subscribers.get(channel);
        if (callbacks) {
          callbacks.delete(callback);
          if (callbacks.size === 0) {
            this.subscribers.delete(channel);
          }
        }
      };
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendMessage({
        action: 'subscribe',
        channel,
        channels: [channel],
      });
    }

    return () => {
      const callbacks = this.subscribers.get(channel);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.subscribers.delete(channel);
          this.sendMessage({
            action: 'unsubscribe',
            channel,
            channels: [channel],
          });
        }
      }
    };
  }

  public subscribeSymbols(symbols: string[], callback: SubscriptionCallback): () => void {
    const unsubscribers = symbols
      .map((symbol) => String(symbol).trim().toUpperCase())
      .filter(Boolean)
      .map((symbol) => this.subscribe(`ticks.${symbol}`, callback));

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }

  public onStateChange(callback: ConnectionStateCallback): () => void {
    this.stateListeners.add(callback);
    callback(this.connectionState);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  public onMetricsChange(callback: MetricsCallback): () => void {
    this.metricsListeners.add(callback);
    callback(this.metrics);
    return () => {
      this.metricsListeners.delete(callback);
    };
  }

  public onMessage(callback: SubscriptionCallback): () => void {
    this.messageListeners.add(callback);
    return () => {
      this.messageListeners.delete(callback);
    };
  }

  public onOpen(callback: () => void): () => void {
    this.openListeners.add(callback);
    if (this.connectionState === ConnectionState.CONNECTED) {
      try { callback(); } catch (error) { console.error('[WS] Open listener error:', error); }
    }
    return () => {
      this.openListeners.delete(callback);
    };
  }

  public on(event: string, callback: (...args: unknown[]) => void): () => void {
    const key = event.trim();
    if (!key) return () => {};
    let listeners = this.eventListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(key, listeners);
    }
    listeners.add(callback);
    if ((key === 'open' || key === 'connect' || key === 'connected') && this.connectionState === ConnectionState.CONNECTED) {
      try { callback(); } catch (error) { console.error('[WS] Event listener error:', error); }
    }
    return () => {
      this.off(key, callback);
    };
  }

  public off(event: string, callback?: (...args: unknown[]) => void): void {
    const key = event.trim();
    if (!key) return;
    if (!callback) {
      this.eventListeners.delete(key);
      return;
    }
    const listeners = this.eventListeners.get(key);
    if (!listeners) return;
    listeners.delete(callback);
    if (listeners.size === 0) {
      this.eventListeners.delete(key);
    }
  }

  public addEventListener(event: string, callback: (...args: unknown[]) => void): () => void {
    return this.on(event, callback);
  }

  public removeEventListener(event: string, callback?: (...args: unknown[]) => void): void {
    this.off(event, callback);
  }

  public isConnected(): boolean {
    return this.connectionState === ConnectionState.CONNECTED;
  }

  public getState(): ConnectionState {
    return this.connectionState;
  }

  public getMetrics(): ConnectionMetrics {
    return { ...this.metrics };
  }

  public hasActiveConsumers(): boolean {
    return (
      this.subscribers.size > 0
      || this.stateListeners.size > 0
      || this.metricsListeners.size > 0
      || this.messageListeners.size > 0
      || this.openListeners.size > 0
      || this.eventListeners.size > 0
    );
  }

  private absorbDesktopOutboundMessage(message: WebSocketMessage): boolean {
    const action = readControlAction(message);
    const isAuth = isAuthControlMessage(message);
    const explicitLogin = extractExplicitAccountLoginFromMessage(message);

    if (action === 'subscribe') {
      binaryTcpMarketStream.start();
    }

    if (!this.isMarketFeedOnlyEndpoint()) {
      if (isAuth) {
        binaryTcpMarketStream.start();
        this.attachBinaryTradeEvents();
        this.syncDesktopAccountSubscription(explicitLogin > 0 ? explicitLogin : undefined, true);
      } else if (explicitLogin > 0 && action !== 'unsubscribe') {
        binaryTcpMarketStream.start();
        this.attachBinaryTradeEvents();
        this.syncDesktopAccountSubscription(explicitLogin, false);
      }
    }

    // Silently absorb subscribe / unsubscribe / ping / auth & all control frames in Desktop mode
    // without queuing into `this.messageQueue` or emitting warnings.
    return true;
  }

  public sendMessage(message: WebSocketMessage): boolean {
    if (isDesktopBackendTarget()) {
      return this.absorbDesktopOutboundMessage(message);
    }

    const messageStr = JSON.stringify(message);
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(messageStr);
        this.metrics.messagesSent++;
        return true;
      } catch {
        this.queueMessage(message);
        return false;
      }
    } else {
      this.queueMessage(message);
      return false;
    }
  }

  public send(message: WebSocketMessage | string): boolean {
    if (typeof message === 'string') {
      const trimmed = message.trim();
      if (!trimmed) {
        return isDesktopBackendTarget();
      }
      if (trimmed.toLowerCase() === 'ping') {
        return this.sendMessage({ action: 'ping', type: 'ping' });
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return this.sendMessage(parsed as WebSocketMessage);
        }
      } catch {
        // Non-JSON raw frame
      }
      if (isDesktopBackendTarget()) {
        return true;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(message);
          this.metrics.messagesSent++;
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    return this.sendMessage(message);
  }

  private queueMessage(message: WebSocketMessage): void {
    const isPing = [message.action, message.type].some((value) => (
      typeof value === 'string' && value.trim().toLowerCase() === 'ping'
    ));
    if (isPing) return;

    if (this.messageQueue.length >= this.maxQueueSize) {
      this.messageQueue.shift();
    }
    this.messageQueue.push({
      message,
      timestamp: Date.now(),
      retries: 0,
    });
  }

  private processMessageQueue(): void {
    if (this.messageQueue.length === 0) return;
    const now = Date.now();
    const maxAge = 60000;
    this.messageQueue = this.messageQueue.filter((queued) => {
      if (now - queued.timestamp > maxAge) return false;
      this.sendMessage(queued.message);
      return false;
    });
  }

  private handleMessage(data: WebSocketMessage): void {
    const { type } = data;
    const nestedPayload = asUnknownRecord(data.data);

    const isPong = [data.action, data.type, nestedPayload?.action, nestedPayload?.type].some((value) => (
      typeof value === 'string' && value.trim().toLowerCase() === 'pong'
    ));
    if (isPong) {
      this.handlePong(data);
      return;
    }

    if (type === 'tick' && isEnhancedStoreHandledTickFrame(data)) {
      this.handleFixTick(data);
      this.broadcastToSubscribers(data);
      return;
    }

    if (type === 'update' && data.candle && data.symbol) {
      this.handleFixCandle(data);
      this.broadcastToSubscribers(data);
      return;
    }

    if (type === 'mt5_positions' || type === 'mt5_orders' || type === 'mt5_account') {
      this.broadcastToSubscribers(data);
      return;
    }

    if (type === 'channel_message' || typeof data.channel === 'string') {
      try {
        const payload = data.data as any;
        if (isEnhancedStoreHandledTickFrame(data) && data.channel?.startsWith('ticks.') && payload) {
          const channelSymbol = data.channel.slice('ticks.'.length).trim().toUpperCase();
          const sourceTimestamp = resolveTickSourceTimestampMs(payload, data);
          this.handleFixTick({
            ...payload,
            symbol: channelSymbol || payload.symbol,
            sourceTimestamp,
          }, data);
        }
      } catch (err) {
        console.error('[WS] Failed to map channel_message to store:', err);
      }
    }
    this.broadcastToSubscribers(data);
  }

  private handleFixTick(data: WebSocketMessage, envelope?: WebSocketMessage): void {
    const sourceTimestamp = resolveTickSourceTimestampMs(data);
    const ts = sourceTimestamp ?? Date.now();
    const dailyChangeContext = composeDailyChangeQuoteContext(data, envelope);
    const last = readDailyChangeLastPrice(dailyChangeContext);
    const priceMode = resolveDailyChangePriceMode(data, data.symbol, envelope);
    const bid = Number(data.bid) || 0;
    const ask = Number(data.ask) || bid;
    const previousClose = readDailyChangePreviousClose(dailyChangeContext);
    const dailyOpen = readFirstFiniteNumber(data, ['daily_open', 'dailyOpen', 'open', 'open_price', 'openPrice']);
    const close = readFirstFiniteNumber(data, ['close', 'close_price', 'closePrice']) ?? previousClose;
    const rawBidVolume = readFirstFiniteNumber(data, ['bid_size', 'bidSize', 'bid_volume', 'bidVolume']);
    const rawAskVolume = readFirstFiniteNumber(data, ['ask_size', 'askSize', 'ask_volume', 'askVolume']);
    const bidVolume = rawBidVolume !== undefined && rawBidVolume > 0 ? rawBidVolume : undefined;
    const askVolume = rawAskVolume !== undefined && rawAskVolume > 0 ? rawAskVolume : undefined;
    const volume = readFirstFiniteNumber(data, [
      'volume', 'volume_24h', 'volume24h', 'tick_volume', 'tickVolume', 'real_volume', 'realVolume',
    ]);
    const lp = readFirstNonEmptyString(data, [
      'lp', 'provider', 'liquidity_provider', 'liquidityProvider', 'lp_name', 'lpName',
    ]);
    const session = ((data as any).session ?? {}) as Record<string, unknown>;
    const high = readFirstFiniteNumber(data, ['high']);
    const low = readFirstFiniteNumber(data, ['low']);
    const sessionHigh = Math.max(Number(session.high_bid) || 0, Number(session.high_ask) || 0, high || 0);
    const sessionLowValues = [
      Number(session.low_bid) || 0,
      Number(session.low_ask) || 0,
      low || 0,
    ].filter((value) => value > 0);
    const sessionLow = sessionLowValues.length > 0 ? Math.min(...sessionLowValues) : undefined;
    const high24h = readFirstFiniteNumber(data, ['high24h', 'high_24h']) ?? (sessionHigh || undefined);
    const low24h = readFirstFiniteNumber(data, ['low24h', 'low_24h']) ?? sessionLow;
    const dailyChange = resolveDailyChangePercent(
      readDailyChangePercent(dailyChangeContext),
      bid,
      previousClose,
      dailyChangeContext,
      priceMode,
    );

    enqueueLiveTick(data.symbol!, {
      symbol: data.symbol!,
      bid,
      ask,
      spread: Number(data.spread) || (ask - bid),
      timestamp: ts,
      sourceTimestamp,
      lp,
      volume,
      ...(bidVolume !== undefined ? { bidVolume } : {}),
      ...(askVolume !== undefined ? { askVolume } : {}),
      last,
      dailyChange,
      dailyChangeInput: readDailyChangeInput({ ...dailyChangeContext, bid: data.bid }, priceMode),
      high24h,
      low24h,
      high,
      low,
      ...readQuoteSessionRange(data),
      open: dailyOpen,
      close,
    });
  }

  private handleFixCandle(data: WebSocketMessage): void {
    const candle = data.candle as Record<string, unknown> | undefined;
    import('../store/useMarketDataStore').then(({ useMarketDataStore }) => {
      const store = useMarketDataStore.getState();
      if (candle && data.symbol) {
        const candleTime = normalizeBrokerTimestampMs(
          candle.time ?? candle.timestamp ?? candle.timestamp_ms ?? candle.time_ms ?? candle.time_msc ?? candle.t ?? candle.open_time ?? candle.openTime,
        );
        if (candleTime === undefined) return;
        const closed = readCandleFinality([asUnknownRecord(candle), asUnknownRecord(data)]);
        const sourceTimestamp = readBrokerTimestampMs([asUnknownRecord(data)])
          ?? readBrokerTimestampMs([asUnknownRecord(candle)], [
            'sourceTimestamp', 'source_timestamp', 'event_timestamp', 'eventTimestamp',
            'event_time', 'eventTime', 'server_timestamp', 'serverTimestamp',
            'server_time', 'serverTime', 'updated_at', 'updatedAt', 'revision_time', 'revisionTime',
          ]);
        store.updateCandle({
          symbol: data.symbol,
          timeframe: String(data.timeframe ?? data.period ?? data.tf ?? candle.timeframe ?? candle.period ?? candle.tf ?? 'M1'),
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          volume: Number(candle.volume ?? candle.tick_volume ?? candle.tickVolume ?? 0),
          time: candleTime,
          ...(closed === undefined ? {} : { closed }),
          source: 'server',
          sourceTimestamp,
        });
      }
    }).catch(() => undefined);
  }

  private broadcastToSubscribers(data: WebSocketMessage): void {
    const channel = data.channel || data.symbol || data.type;
    const dataRecord = data as unknown as Record<string, unknown>;
    const topic = typeof dataRecord.topic === 'string' ? dataRecord.topic : '';
    const isAccountChannelMessage =
      data.type === 'channel_message'
      && typeof data.channel === 'string'
      && data.channel.startsWith('account.');

    const cloneDataPayload = (value: unknown): unknown => {
      if (value === null || value === undefined) return value;
      if (typeof structuredClone === 'function') {
        try { return structuredClone(value); } catch { /* fallback */ }
      }
      try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
    };

    const makeCallbackMessage = (): WebSocketMessage => {
      if (!isAccountChannelMessage) return data;
      const cloned = cloneDataPayload(data.data);
      return 'payload' in dataRecord
        ? { ...data, data: cloned, payload: cloned }
        : { ...data, data: cloned };
    };

    const matchingCallbacks = new Set<SubscriptionCallback>();
    if (channel) {
      this.subscribers.get(channel)?.forEach((cb) => matchingCallbacks.add(cb));
    }
    if (topic && topic !== channel) {
      this.subscribers.get(topic)?.forEach((cb) => matchingCallbacks.add(cb));
    }
    if (typeof data.type === 'string' && data.type !== channel && data.type !== topic) {
      this.subscribers.get(data.type)?.forEach((cb) => matchingCallbacks.add(cb));
    }
    if (data.symbol) {
      this.subscribers.get(`ticks.${data.symbol}`)?.forEach((cb) => matchingCallbacks.add(cb));
    }
    const payloadRecord = asUnknownRecord(data.data);
    const rawSymbol = typeof data.symbol === 'string' && data.symbol.trim()
      ? data.symbol.trim().toUpperCase()
      : typeof payloadRecord?.symbol === 'string' && payloadRecord.symbol.trim()
        ? payloadRecord.symbol.trim().toUpperCase()
        : '';
    const normalizedType = String(data.type || data.action || '').toLowerCase();
    if (rawSymbol && (
      normalizedType.includes('depth')
      || normalizedType.includes('orderbook')
      || normalizedType.includes('order_book')
      || (typeof data.channel === 'string' && data.channel.toLowerCase().startsWith('depth.'))
    )) {
      this.subscribers.get(`depth.${rawSymbol}`)?.forEach((cb) => matchingCallbacks.add(cb));
    }

    if (matchingCallbacks.size > 0) {
      matchingCallbacks.forEach((callback) => {
        try { callback(makeCallbackMessage()); } catch (error) { console.error('[WS] Callback error:', error); }
      });
    }

    const wildcardCallbacks = this.subscribers.get('*');
    if (wildcardCallbacks) {
      wildcardCallbacks.forEach((callback) => {
        try { callback(makeCallbackMessage()); } catch (error) { console.error('[WS] Wildcard callback error:', error); }
      });
    }

    if (this.messageListeners.size > 0) {
      this.messageListeners.forEach((callback) => {
        try { callback(makeCallbackMessage()); } catch (error) { console.error('[WS] Message listener error:', error); }
      });
    }

    if (this.eventListeners.size > 0) {
      this.emitEvent('message', makeCallbackMessage());
      if (channel && channel !== 'message') {
        this.emitEvent(channel, makeCallbackMessage());
      }
      if (topic && topic !== channel && topic !== 'message') {
        this.emitEvent(topic, makeCallbackMessage());
      }
    }
  }

  private startPingInterval(): void {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, this.pingIntervalMs);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private sendPing(): void {
    if (this.isRuntimeSuspended()) return;
    const targetSocket = this.ws;
    if (!targetSocket || targetSocket.readyState !== WebSocket.OPEN) return;
    if (this.pongTimeout !== null) return;

    const pingTime = Date.now();
    this.lastPingSentAt = pingTime;
    this.lastPingStartedAt = performance.now();
    // rtx5-gateway handleGatewayWSAction matches action:"ping" (fallback type:"ping")
    // and echoes request_id in {"action":"pong","request_id":...,"data":{"time":...}}.
    this.sendMessage({ action: 'ping', type: 'ping', request_id: pingTime, timestamp: pingTime });

    if (this.pongSupportedUrl !== this.url) return;

    this.pongTimeout = setTimeout(() => {
      this.pongTimeout = null;
      const socket = this.ws;
      if (!socket || socket !== targetSocket || socket.readyState !== WebSocket.OPEN) return;
      if (this.isRuntimeSuspended()) {
        this.reconnectPendingWhileHidden = true;
        return;
      }
      // If inbound server frames arrived on this socket after pingTime, the
      // /ws/v2 stream is actively delivering data and must not be torn down.
      if (this.lastDataTime > pingTime) {
        this.lastPongTime = this.lastDataTime;
        return;
      }
      this.ws = null;
      try { socket.close(4000, 'WebSocket heartbeat timeout'); } catch { /* ignore */ }
      this.metrics.lastDisconnectedAt = Date.now();
      this.updateState('disconnected');
      this.stopPingInterval();
      this.notifyMetricsListeners();
      this.attemptReconnect();
    }, this.pongTimeoutMs);
  }

  private handlePong(data: WebSocketMessage): void {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
    const now = Date.now();
    this.pongSupportedUrl = this.url;
    const nestedPayload = asUnknownRecord(data.data);
    const echo = data.request_id
      ?? nestedPayload?.request_id
      ?? data.ping_timestamp
      ?? data.request_timestamp
      ?? data.timestamp
      ?? nestedPayload?.timestamp;
    if (this.lastPingSentAt > 0 && Number(echo) === this.lastPingSentAt) {
      const latency = performance.now() - this.lastPingStartedAt;
      this.recordLatency(latency);
      this.lastPingSentAt = 0;
    }
    this.lastPongTime = now;
  }

  private recordLatency(latency: number): void {
    if (!Number.isFinite(latency) || latency < 0) return;
    const measuredLatency = Math.floor(latency);
    this.latencyMeasurements.push(measuredLatency);
    if (this.latencyMeasurements.length > this.maxLatencyMeasurements) {
      this.latencyMeasurements.shift();
    }
    this.metrics.lastLatency = measuredLatency;
    this.metrics.latencyMeasuredAt = Date.now();
    this.metrics.averageLatency =
      this.latencyMeasurements.reduce((sum, l) => sum + l, 0) / this.latencyMeasurements.length;
    this.notifyMetricsListeners();
  }

  private attemptReconnect(): void {
    if (this.disposed || this.reconnectTimeout || this.reconnectPendingWhileHidden) return;
    if (isDesktopBackendTarget()) return;

    if (this.isRuntimeSuspended()) {
      this.reconnectPendingWhileHidden = true;
      this.updateState(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'reconnecting');
      return;
    }

    this.reconnectAttempts++;
    this.metrics.reconnectAttempts++;

    const exponentialDelay = Math.min(
      this.baseReconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 10)),
      this.maxReconnectDelay,
    );
    const delay = addReconnectJitter(exponentialDelay, this.maxReconnectDelay);
    this.updateState('reconnecting');

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.isRuntimeSuspended()) {
        this.reconnectPendingWhileHidden = true;
        return;
      }
      this.connect();
    }, delay);
  }

  private resubscribeChannels(): void {
    if (isDesktopBackendTarget()) return;

    this.subscribers.forEach((_, channel) => {
      if (isLocalOnlyChannel(channel)) return;
      if (channel.startsWith('symbols:')) return;
      if (isBinaryInterceptedMarketChannel(channel)) return;

      this.sendMessage({
        action: 'subscribe',
        channel,
        channels: [channel],
      });
    });
  }

  private emitEvent(event: string, ...args: unknown[]): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners || listeners.size === 0) return;
    listeners.forEach((listener) => {
      try { listener(...args); } catch (error) { console.error(`[WS] Event (${event}) listener error:`, error); }
    });
  }

  private updateState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    try {
      useWebSocketStore.getState().setConnectionState(state, 'legacy_mt5');
    } catch { /* store not ready */ }

    this.stateListeners.forEach((listener) => {
      try { listener(state); } catch (error) { console.error('[WS] State listener error:', error); }
    });

    this.emitEvent('state', state);
    this.emitEvent('stateChange', state);

    if (state === ConnectionState.CONNECTED) {
      this.openListeners.forEach((listener) => {
        try { listener(); } catch (error) { console.error('[WS] Open listener error:', error); }
      });
      this.emitEvent('open');
      this.emitEvent('connect');
      this.emitEvent('connected');
    } else if (state === ConnectionState.DISCONNECTED) {
      this.emitEvent('close');
      this.emitEvent('disconnect');
      this.emitEvent('disconnected');
    } else if (state === ConnectionState.ERROR) {
      this.emitEvent('error', new Error('WebSocket connection error'));
    }
  }

  private notifyMetricsListeners(): void {
    this.metricsListeners.forEach((listener) => {
      try { listener(this.metrics); } catch (error) { console.error('[WS] Metrics listener error:', error); }
    });
    this.emitEvent('metrics', this.metrics);
  }

  private handleOnline = (): void => {
    if (isDesktopBackendTarget()) {
      if (!this.disposed && this.connectionState === ConnectionState.CONNECTED) {
        binaryTcpMarketStream.start();
        if (!this.isMarketFeedOnlyEndpoint()) {
          this.syncDesktopAccountSubscription(undefined, true);
        }
      }
      return;
    }

    if (this.isDocumentHidden()) {
      this.reconnectPendingWhileHidden = true;
      this.updateState('reconnecting');
      return;
    }
    if (this.connectionState === 'offline' || this.connectionState === 'disconnected' || this.reconnectPendingWhileHidden) {
      this.reconnectPendingWhileHidden = false;
      this.forceReconnect();
    }
  };

  private handleOffline = (): void => {
    if (isDesktopBackendTarget()) return;

    this.stopPingInterval();
    this.clearOpenTimeout();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectPendingWhileHidden = Boolean(this.ws || this.subscribers.size > 0);
    this.updateState('offline');
  };

  public destroy(): void {
    this.disposed = true;
    this.disconnect();
    this.binaryTickUnsubs.forEach((unsub) => unsub());
    this.binaryTickUnsubs.clear();

    this.unsubSessionChange?.();
    this.unsubSessionChange = null;

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('offline', this.handleOffline);
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.subscribers.clear();
    this.stateListeners.clear();
    this.metricsListeners.clear();
    this.messageListeners.clear();
    this.openListeners.clear();
    this.eventListeners.clear();
    this.messageQueue = [];
  }

  private normalizeWsUrl(input: string): string {
    if (!isDesktopBackendTarget()) return buildBrokerWsV2Uri(null);
    if (input?.includes('/ws/v2')) return input;

    const fallback = normalizeRuntimeWsUrl(buildBrokerWsV2Uri(null));
    if (!input) return fallback;

    try {
      const url = new URL(input, window.location.origin);
      if (
        (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
        && (url.port === '5173' || url.port === '')
        && (url.pathname === '/ws' || url.pathname === '/fix-ws')
      ) {
        return fallback;
      }
      if (url.pathname === '/ws' && fallback) {
        return fallback;
      }
      return url.toString();
    } catch {
      return fallback;
    }
  }
}

const wsInstances = new Map<string, EnhancedWebSocketService>();
let defaultWsInstanceKey: string | null = null;

export const getEnhancedWebSocketService = (url?: string): EnhancedWebSocketService => {
  const normalizedRequestedUrl = (() => {
    if (!url) return undefined;
    if (!isDesktopBackendTarget()) return buildBrokerWsV2Uri(null);
    return url;
  })();

  const requestedKey = normalizedRequestedUrl
    || (isDesktopBackendTarget()
      ? (url || (!defaultWsInstanceKey ? (buildBrokerWsV2Uri(null) || 'binary-tcp://desktop/ws/v2') : undefined))
      : undefined);
  if (requestedKey) {
    let instance = wsInstances.get(requestedKey);
    if (!instance) {
      instance = new EnhancedWebSocketService(requestedKey);
      wsInstances.set(requestedKey, instance);
    }
    if (!defaultWsInstanceKey) defaultWsInstanceKey = requestedKey;
    return instance;
  }

  const defaultInstance = defaultWsInstanceKey
    ? wsInstances.get(defaultWsInstanceKey)
    : undefined;
  if (!defaultInstance) {
    throw new Error('WebSocket service not initialized. Provide URL on first call.');
  }
  return defaultInstance;
};

export const releaseEnhancedWebSocketService = (service: EnhancedWebSocketService): void => {
  queueMicrotask(() => {
    const ownedKeys = Array.from(wsInstances.entries())
      .filter(([, instance]) => instance === service)
      .map(([key]) => key);
    if (ownedKeys.length === 0 || service.hasActiveConsumers()) return;

    service.destroy();
    ownedKeys.forEach((key) => wsInstances.delete(key));
    if (defaultWsInstanceKey && !wsInstances.has(defaultWsInstanceKey)) {
      defaultWsInstanceKey = wsInstances.keys().next().value ?? null;
    }
  });
};

export const destroyWebSocketService = (): void => {
  wsInstances.forEach((instance) => instance.destroy());
  wsInstances.clear();
  defaultWsInstanceKey = null;
};

