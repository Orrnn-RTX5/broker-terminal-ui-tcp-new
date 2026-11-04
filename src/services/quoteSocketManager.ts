/**
 * Quotes Live Bid/Ask Manager — Pure Binary TCP Fast Path in Desktop Mode
 *
 * In RTX5 Desktop Clients (`isDesktopBackendTarget() === true`), quotes arrive
 * directly over the `:4443` Encrypted Binary TCP stream (`/__rtx5_binary_stream`,
 * 48-byte IEEE-754 Little-Endian `BinaryTick` structs):
 *   - ZERO WebSockets opened (`new WebSocket` is never called)
 *   - ZERO JSON parsing
 *   - 0 ms instant quote seeding when a symbol is added to Market Watch or opened on Chart
 *   - Active-demand filtering so idle unsubscribed instruments never trigger React re-renders
 */

import {
  buildBrokerWsFeedUri,
  buildBrokerWsV2Uri,
  getAccessToken,
  onSessionChange,
} from './brokerSession';
import { isDesktopBackendTarget } from '../config/backendTarget.js';
import { binaryTcpMarketStream, type DecodedBinaryTick } from './binaryTcpMarketStream';
import { enqueueLiveTick, isLiveMarketDataFrozen, type LiveTick } from './liveTickDispatcher';
import { useWebSocketStore } from '../store/useWebSocketStore';
import {
  processIncomingQuotePayload,
  type NormalizedQuoteTick,
} from './quotePayloadNormalizer';
import {
  AUTH_CLOSE_CODES,
  MAX_FEED_SYMBOLS_PER_FRAME,
  QUOTE_SOCKET_HEARTBEAT_INTERVAL_MS,
  QUOTE_SOCKET_MAX_SUBSCRIPTION_RETRIES,
  QUOTE_SOCKET_OPEN_TIMEOUT_MS,
  QUOTE_SOCKET_PONG_TIMEOUT_MS,
  QUOTE_SOCKET_STABLE_OPEN_MS,
  QUOTE_SOCKET_SUBSCRIPTION_ACK_TIMEOUT_MS,
  addQuoteReconnectJitter as addReconnectJitter,
  chunkQuoteSymbols as chunkStrings,
  collectQuoteConfirmationItems,
  isQuoteMessageRecord as isRecord,
  normalizeQuoteConfirmationItems,
  normalizeQuoteSymbol as normalizeSymbol,
  redactQuoteSocketUrl as redactWsUrl,
  summarizeQuoteSymbols as summarizeSymbols,
} from './quoteSocketProtocol';

export type { NormalizedQuoteTick } from './quotePayloadNormalizer';
export {
  QUOTE_SOCKET_HEARTBEAT_INTERVAL_MS,
  QUOTE_SOCKET_MAX_SUBSCRIPTION_RETRIES,
  QUOTE_SOCKET_OPEN_TIMEOUT_MS,
  QUOTE_SOCKET_PONG_TIMEOUT_MS,
  QUOTE_SOCKET_STABLE_OPEN_MS,
  QUOTE_SOCKET_SUBSCRIPTION_ACK_TIMEOUT_MS,
} from './quoteSocketProtocol';

type QuoteTickCallback = (tick: NormalizedQuoteTick) => void;
export type QuoteTransport = 'feed' | 'v2';

function toNormalizedQuoteTick(bt: DecodedBinaryTick): NormalizedQuoteTick {
  return {
    symbol: bt.symbol,
    bid: bt.bid,
    ask: bt.ask,
    spread: bt.spread,
    timestamp: bt.timestamp,
    sourceTimestamp: bt.sourceTimestamp,
    lp: 'cserver',
    ...(bt.dailyChange !== undefined ? { dailyChange: bt.dailyChange } : {}),
    ...(bt.high24h !== undefined ? { high24h: bt.high24h, high: bt.high24h } : {}),
    ...(bt.low24h !== undefined ? { low24h: bt.low24h, low: bt.low24h } : {}),
    ...(bt.dailyOpen !== undefined ? { open: bt.dailyOpen } : {}),
  } as NormalizedQuoteTick;
}

class QuoteSocketManager {
  private ws: WebSocket | null = null;
  private wsUrl: string = '';
  private subscribedSymbols: Set<string> = new Set();
  private pendingSubscriptions: Set<string> = new Set();

  private demandSources: Map<string, Set<string>> = new Map();
  private activeSymbols: Set<string> = new Set();
  private symbolListeners: Map<string, Set<QuoteTickCallback>> = new Map();
  private globalListeners: Set<QuoteTickCallback> = new Set();

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimeout: ReturnType<typeof setTimeout> | null = null;
  private stableOpenTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionAckTimeout: ReturnType<typeof setTimeout> | null = null;
  private subscriptionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionRetrySymbols: Set<string> = new Set();
  private subscriptionAttempts: Map<string, number> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectPendingWhileHidden = false;
  private maxReconnectDelay = 30000;
  private baseReconnectDelay = 1000;
  private disposed = false;

  private activeTransport: QuoteTransport = 'feed';
  private feedAuthFailed = false;
  private fallbackActive = false;

  // Binary TCP fast-path bindings (Desktop mode)
  private unsubBinaryTick: (() => void) | null = null;
  private unsubBinaryState: (() => void) | null = null;
  private binaryConnected = false;

  private unsubSessionChange: (() => void) | null = null;

  constructor() {
    if (isDesktopBackendTarget()) {
      this.attachBinaryTcpFastPath();
    }

    this.unsubSessionChange = onSessionChange((reason) => {
      if (isDesktopBackendTarget()) {
        if (reason === 'broker_url_change') {
          binaryTcpMarketStream.forceReconnect();
        } else if (reason === 'login' || reason === 'account_change' || reason === 'logout') {
          // Re-seed demanded symbols immediately so account group spread markup updates in 0 ms
          this.seedDemandedSymbolsFromBinaryCache([...this.activeSymbols]);
        }
        return;
      }

      if (
        reason === 'logout'
        || reason === 'token_rotation'
        || reason === 'broker_url_change'
        || reason === 'login'
        || reason === 'account_change'
      ) {
        if (
          reason !== 'broker_url_change'
          && this.activeTransport === 'feed'
          && this.ws?.readyState === WebSocket.OPEN
          && this.wsUrl === buildBrokerWsFeedUri()
        ) {
          return;
        }
        this.resetFeedFailure();
        this.reconnect();
      }
    });

    if (typeof window !== 'undefined' && !isDesktopBackendTarget()) {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private attachBinaryTcpFastPath(): void {
    if (this.unsubBinaryTick) return;
    this.activeTransport = 'feed';
    this.fallbackActive = false;

    this.unsubBinaryState = binaryTcpMarketStream.onStateChange((connected) => {
      this.binaryConnected = connected;
      try {
        useWebSocketStore.getState().setConnectionState(
          connected ? 'connected' : 'reconnecting',
          'fix_socket',
        );
        useWebSocketStore.getState().setQuoteTransportState?.(
          connected ? 'feed' : 'none',
          false,
        );
      } catch { /* store not ready */ }

      if (connected && this.activeSymbols.size > 0) {
        this.seedDemandedSymbolsFromBinaryCache([...this.activeSymbols]);
      }
    });

    this.unsubBinaryTick = binaryTcpMarketStream.onTick((bt) => {
      if (this.disposed) return;
      const sym = bt.symbol;
      const hasDemand = (
        this.activeSymbols.has(sym)
        || this.symbolListeners.has(sym)
        || this.globalListeners.size > 0
      );
      if (!hasDemand) return;
      this.dispatchNormalizedTick(toNormalizedQuoteTick(bt));
    });
  }

  private seedDemandedSymbolsFromBinaryCache(symbols: readonly string[]): void {
    for (const sym of symbols) {
      const cached = binaryTcpMarketStream.getLatestTick(sym);
      if (cached) {
        this.dispatchNormalizedTick(toNormalizedQuoteTick(cached));
      }
    }
  }

  private dispatchNormalizedTick(tick: NormalizedQuoteTick): void {
    if (isLiveMarketDataFrozen(tick.symbol)) return;

    enqueueLiveTick(tick.symbol, tick as LiveTick);

    if (tick.bid <= 0 && tick.ask <= 0) return;

    const callbacks = this.symbolListeners.get(tick.symbol);
    if (callbacks) {
      callbacks.forEach((cb) => {
        try { cb(tick); } catch (e) { console.error('[QuoteSocket] listener error:', e); }
      });
    }

    this.globalListeners.forEach((cb) => {
      try { cb(tick); } catch (e) { console.error('[QuoteSocket] global listener error:', e); }
    });
  }

  setDemand(sourceId: string, symbols: string[]): void {
    const normalized = new Set(symbols.map(normalizeSymbol).filter(Boolean));
    this.demandSources.set(sourceId, normalized);
    this.syncActiveSymbols();
  }

  removeDemand(sourceId: string): void {
    this.demandSources.delete(sourceId);
    this.syncActiveSymbols();
  }

  private syncActiveSymbols(): void {
    const merged = new Set<string>();
    this.demandSources.forEach((symbols) => {
      symbols.forEach((s) => merged.add(s));
    });

    const oldSymbols = this.activeSymbols;
    this.activeSymbols = merged;

    if (isDesktopBackendTarget()) {
      this.attachBinaryTcpFastPath();
      binaryTcpMarketStream.ensureStarted();
      const added = [...merged].filter((s) => !oldSymbols.has(s));
      if (added.length > 0) {
        added.forEach((s) => this.subscribedSymbols.add(s));
        this.seedDemandedSymbolsFromBinaryCache(added);
      }
      [...oldSymbols].forEach((s) => {
        if (!merged.has(s)) this.subscribedSymbols.delete(s);
      });
      return;
    }

    if (merged.size === 0) {
      this.scheduleIdleClose();
      return;
    }

    this.cancelIdleClose();

    if (this.ws?.readyState === WebSocket.CONNECTING) return;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect();
      return;
    }

    const added = [...merged].filter((s) => !oldSymbols.has(s));
    const removed = [...oldSymbols].filter((s) => !merged.has(s));

    if (added.length > 0) {
      this.sendSubscribe(added);
    }

    if (removed.length > 0) {
      this.sendUnsubscribe(removed);
    }
  }

  private resolveTransport(): QuoteTransport {
    const feedAvailable = Boolean(buildBrokerWsFeedUri());
    if (!feedAvailable) return 'v2';
    if (!this.feedAuthFailed) return 'feed';
    return getAccessToken() ? 'v2' : 'feed';
  }

  private buildTransportUrl(transport: QuoteTransport): string {
    if (transport === 'feed') return buildBrokerWsFeedUri();
    return getAccessToken() ? buildBrokerWsV2Uri() : buildBrokerWsV2Uri(null);
  }

  private resetFeedFailure(): void {
    this.feedAuthFailed = false;
    this.fallbackActive = false;
  }

  private publishQuoteTransport(): void {
    try {
      useWebSocketStore.getState().setQuoteTransportState?.(
        isDesktopBackendTarget()
          ? (this.binaryConnected ? 'feed' : 'none')
          : (this.ws ? this.activeTransport : 'none'),
        this.fallbackActive,
      );
    } catch { /* store not ready */ }
  }

  private isFeedAuthErrorText(data: Record<string, unknown>): boolean {
    if (this.activeTransport !== 'feed') return false;
    const text = [data.code, data.message, data.error, data.reason]
      .map((value) => (typeof value === 'string' ? value : ''))
      .join(' ')
      .toLowerCase();
    if (!text) return false;
    return /token[_ ]?mismatch|unauthori[sz]ed|invalid[_ ]?token|auth(?:entication)?[_ ]?(?:failed|error|rejected)/.test(text);
  }

  private failOverToV2(reason: string): boolean {
    if (!getAccessToken()) return false;
    console.warn(`[QuoteSocket] ${reason} — failing over to authenticated v2`);
    this.feedAuthFailed = true;
    this.cancelScheduledReconnect();
    this.closeSocket();
    if (this.isRuntimeSuspended()) {
      this.reconnectPendingWhileHidden = true;
      try {
        useWebSocketStore.getState().setConnectionState('reconnecting', 'fix_socket');
      } catch { /* store not ready */ }
      return true;
    }
    this.connect();
    return true;
  }

  private cancelScheduledReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connect(): void {
    if (this.disposed) return;
    if (isDesktopBackendTarget()) {
      this.attachBinaryTcpFastPath();
      binaryTcpMarketStream.ensureStarted();
      return;
    }
    if (this.isRuntimeSuspended()) {
      this.reconnectPendingWhileHidden = this.activeSymbols.size > 0;
      return;
    }
    if (
      this.ws?.readyState === WebSocket.OPEN
      || this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    const nextTransport = this.resolveTransport();
    const nextWsUrl = this.buildTransportUrl(nextTransport);
    if (!nextWsUrl) {
      return;
    }

    this.closeSocket();

    this.wsUrl = nextWsUrl;
    this.activeTransport = nextTransport;
    this.fallbackActive = nextTransport === 'v2' && this.feedAuthFailed;

    console.log(`[QuoteSocket] Opening ${nextTransport} WebSocket → ${redactWsUrl(this.wsUrl)}`);

    try {
      const socket = new WebSocket(this.wsUrl);
      this.ws = socket;
      let opened = false;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        opened = true;
        this.clearOpenTimeout();
        this.startHeartbeat(socket);

        try {
          useWebSocketStore.getState().setConnectionState('connected', 'fix_socket');
        } catch { /* store not ready */ }
        this.publishQuoteTransport();

        if (this.activeSymbols.size > 0) {
          this.sendSubscribe([...this.activeSymbols]);
        }
        this.scheduleStableOpenReset(socket);
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        this.recordTransportActivity();

        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (err) {
          console.error('[QuoteSocket] Failed to parse message:', err);
        }
      };

      socket.onerror = (err) => {
        if (this.ws !== socket) return;
        console.error('[QuoteSocket] Error:', err);
      };

      socket.onclose = (event) => {
        if (this.ws !== socket) return;
        this.clearOpenTimeout();
        this.clearStableOpenTimer();
        this.clearHeartbeat();
        this.clearSubscriptionTimers(true);

        this.ws = null;
        this.subscribedSymbols.clear();
        this.pendingSubscriptions.clear();

        try {
          useWebSocketStore.getState().setConnectionState('disconnected', 'fix_socket');
        } catch { /* store not ready */ }
        this.publishQuoteTransport();

        if (this.disposed) return;

        if (
          nextTransport === 'feed'
          && (!opened || AUTH_CLOSE_CODES.has(event.code))
          && this.failOverToV2('Feed auth/handshake failure')
        ) {
          return;
        }

        if (nextTransport === 'v2' && AUTH_CLOSE_CODES.has(event.code)) {
          return;
        }

        if (this.activeSymbols.size > 0) {
          this.scheduleReconnect();
        }
      };
      this.startOpenTimeout(socket);
    } catch {
      this.scheduleReconnect();
    }
  }

  private sendSubscribe(symbols: string[] = []): void {
    if (isDesktopBackendTarget()) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const requestedSymbols = symbols.length > 0 ? symbols : [...this.activeSymbols];
    const subscriptionSymbols = Array.from(new Set(
      requestedSymbols.map(normalizeSymbol).filter(Boolean)
    )).filter((symbol) => !this.subscribedSymbols.has(symbol) && !this.pendingSubscriptions.has(symbol));
    if (subscriptionSymbols.length === 0) return;

    if (this.activeTransport === 'feed') {
      chunkStrings(subscriptionSymbols, MAX_FEED_SYMBOLS_PER_FRAME).forEach((batch) => {
        this.ws?.send(JSON.stringify({ type: 'subscribe', symbols: batch }));
      });
    } else {
      subscriptionSymbols.forEach((symbol) => {
        const channel = `ticks.${symbol}`;
        this.ws?.send(JSON.stringify({ action: 'subscribe', channel, channels: [channel] }));
      });
    }
    subscriptionSymbols.forEach((symbol) => this.pendingSubscriptions.add(symbol));
    this.scheduleSubscriptionAckTimeout();
  }

  private sendUnsubscribe(symbols: string[]): void {
    if (isDesktopBackendTarget()) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const unsubscribeSymbols = symbols.length > 0 ? symbols : ['*'];
    if (this.activeTransport === 'feed') {
      const feedSymbols = unsubscribeSymbols
        .map((symbol) => (symbol === '*' ? '*' : normalizeSymbol(symbol)))
        .filter(Boolean);
      chunkStrings(feedSymbols, MAX_FEED_SYMBOLS_PER_FRAME).forEach((batch) => {
        this.ws?.send(JSON.stringify({ type: 'unsubscribe', symbols: batch }));
      });
    } else {
      unsubscribeSymbols.forEach((symbol) => {
        if (symbol === '*') {
          this.ws?.send(JSON.stringify({ action: 'unsubscribe', channel: '*' }));
          return;
        }
        const channel = `ticks.${normalizeSymbol(symbol)}`;
        this.ws?.send(JSON.stringify({ action: 'unsubscribe', channel, channels: [channel] }));
      });
    }
    unsubscribeSymbols.forEach((symbol) => {
      this.subscribedSymbols.delete(symbol);
      this.pendingSubscriptions.delete(symbol);
      this.subscriptionAttempts.delete(symbol);
      this.subscriptionRetrySymbols.delete(symbol);
    });
    this.scheduleSubscriptionAckTimeout();
  }

  private handleMessage(data: unknown): void {
    if (!isRecord(data)) return;
    if (data.type === 'pong') return;

    if (data.type === 'subscribed' || data.type === 'unsubscribed') {
      const confirmedItems = collectQuoteConfirmationItems(data);
      const confirmedSymbols = this.reconcileSubscriptionConfirmation(data.type, confirmedItems);
      if (data.type === 'unsubscribed') this.retryRejectedSubscriptions(confirmedSymbols);
      return;
    }

    if (data.type === 'error') {
      if (this.isFeedAuthErrorText(data) && this.failOverToV2('Feed credential rejected in-band')) {
        return;
      }
      const rejectedItems = collectQuoteConfirmationItems(data);
      if (rejectedItems.length > 0) {
        const rejectedSymbols = this.reconcileSubscriptionConfirmation('unsubscribed', rejectedItems);
        this.retryRejectedSubscriptions(rejectedSymbols);
      } else {
        const rejectedSymbols = [...this.pendingSubscriptions];
        this.pendingSubscriptions.clear();
        this.retryRejectedSubscriptions(rejectedSymbols);
      }
      return;
    }

    const ticks = processIncomingQuotePayload(data);
    if (ticks.length === 0) return;

    ticks.forEach((tick) => {
      if (this.pendingSubscriptions.delete(tick.symbol)) {
        this.subscribedSymbols.add(tick.symbol);
      }
      this.subscriptionAttempts.delete(tick.symbol);
      this.subscriptionRetrySymbols.delete(tick.symbol);
    });
    this.scheduleSubscriptionAckTimeout();

    ticks.forEach((tick) => this.dispatchNormalizedTick(tick));
  }

  private reconcileSubscriptionConfirmation(type: 'subscribed' | 'unsubscribed', list: unknown): string[] {
    const symbols = normalizeQuoteConfirmationItems(list);
    if (symbols.length === 0) return [];

    if (type === 'subscribed') {
      symbols.forEach((symbol) => {
        this.pendingSubscriptions.delete(symbol);
        this.subscribedSymbols.add(symbol);
        this.subscriptionAttempts.delete(symbol);
        this.subscriptionRetrySymbols.delete(symbol);
      });
    } else {
      symbols.forEach((symbol) => {
        this.pendingSubscriptions.delete(symbol);
        this.subscribedSymbols.delete(symbol);
      });
    }
    this.scheduleSubscriptionAckTimeout();
    return symbols;
  }

  private clearSubscriptionAckTimeout(): void {
    if (this.subscriptionAckTimeout === null) return;
    clearTimeout(this.subscriptionAckTimeout);
    this.subscriptionAckTimeout = null;
  }

  private clearSubscriptionTimers(resetAttempts = false): void {
    this.clearSubscriptionAckTimeout();
    if (this.subscriptionRetryTimer !== null) clearTimeout(this.subscriptionRetryTimer);
    this.subscriptionRetryTimer = null;
    this.subscriptionRetrySymbols.clear();
    if (resetAttempts) this.subscriptionAttempts.clear();
  }

  private scheduleSubscriptionAckTimeout(): void {
    this.clearSubscriptionAckTimeout();
    if (
      this.disposed
      || this.pendingSubscriptions.size === 0
      || !this.ws
      || this.ws.readyState !== WebSocket.OPEN
    ) return;

    this.subscriptionAckTimeout = setTimeout(() => {
      this.subscriptionAckTimeout = null;
      const unconfirmed = [...this.pendingSubscriptions].filter((symbol) => this.activeSymbols.has(symbol));
      unconfirmed.forEach((symbol) => this.pendingSubscriptions.delete(symbol));
      this.retryRejectedSubscriptions(unconfirmed);
      this.scheduleSubscriptionAckTimeout();
    }, QUOTE_SOCKET_SUBSCRIPTION_ACK_TIMEOUT_MS);
  }

  private retryRejectedSubscriptions(symbols: readonly string[]): void {
    symbols.forEach((symbol) => {
      if (!this.activeSymbols.has(symbol) || this.subscribedSymbols.has(symbol)) return;
      const attempt = (this.subscriptionAttempts.get(symbol) ?? 0) + 1;
      this.subscriptionAttempts.set(symbol, attempt);
      if (attempt <= QUOTE_SOCKET_MAX_SUBSCRIPTION_RETRIES) {
        this.subscriptionRetrySymbols.add(symbol);
      } else {
        console.error(`[QuoteSocket] Subscription was not confirmed after ${attempt - 1} retries: ${symbol}`);
      }
    });

    if (this.subscriptionRetrySymbols.size === 0 || this.subscriptionRetryTimer !== null) return;
    this.subscriptionRetryTimer = setTimeout(() => {
      this.subscriptionRetryTimer = null;
      const retrySymbols = [...this.subscriptionRetrySymbols].filter((symbol) => this.activeSymbols.has(symbol));
      this.subscriptionRetrySymbols.clear();
      this.sendSubscribe(retrySymbols);
    }, QUOTE_SOCKET_SUBSCRIPTION_ACK_TIMEOUT_MS);
  }

  onQuoteSnapshot(symbol: string, cb: QuoteTickCallback): () => void {
    const key = normalizeSymbol(symbol);
    if (!this.symbolListeners.has(key)) {
      this.symbolListeners.set(key, new Set());
    }
    this.symbolListeners.get(key)!.add(cb);

    if (isDesktopBackendTarget()) {
      this.attachBinaryTcpFastPath();
      const cached = binaryTcpMarketStream.getLatestTick(key);
      if (cached) {
        queueMicrotask(() => {
          if (this.symbolListeners.get(key)?.has(cb)) {
            try { cb(toNormalizedQuoteTick(cached)); } catch { /* ignore */ }
          }
        });
      }
    }

    return () => {
      const listeners = this.symbolListeners.get(key);
      if (listeners) {
        listeners.delete(cb);
        if (listeners.size === 0) this.symbolListeners.delete(key);
      }
    };
  }

  onAnyQuote(cb: QuoteTickCallback): () => void {
    this.globalListeners.add(cb);
    if (isDesktopBackendTarget()) {
      this.attachBinaryTcpFastPath();
    }
    return () => { this.globalListeners.delete(cb); };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || this.reconnectPendingWhileHidden) return;
    if (isDesktopBackendTarget()) return;

    if (this.isRuntimeSuspended()) {
      this.reconnectPendingWhileHidden = true;
      try {
        useWebSocketStore.getState().setConnectionState('reconnecting', 'fix_socket');
      } catch { /* store not ready */ }
      return;
    }

    const exponentialDelay = Math.min(
      this.baseReconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts, 10)),
      this.maxReconnectDelay,
    );
    const delay = addReconnectJitter(exponentialDelay, this.maxReconnectDelay);
    this.reconnectAttempts++;

    try {
      useWebSocketStore.getState().setConnectionState('reconnecting', 'fix_socket');
    } catch { /* store not ready */ }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isRuntimeSuspended()) {
        this.reconnectPendingWhileHidden = true;
        return;
      }
      this.connect();
    }, delay);
  }

  private clearOpenTimeout(): void {
    if (this.openTimeout === null) return;
    clearTimeout(this.openTimeout);
    this.openTimeout = null;
  }

  private clearStableOpenTimer(): void {
    if (this.stableOpenTimer === null) return;
    clearTimeout(this.stableOpenTimer);
    this.stableOpenTimer = null;
  }

  private scheduleStableOpenReset(socket: WebSocket): void {
    this.clearStableOpenTimer();
    this.stableOpenTimer = setTimeout(() => {
      this.stableOpenTimer = null;
      if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
        this.reconnectAttempts = 0;
      }
    }, QUOTE_SOCKET_STABLE_OPEN_MS);
  }

  private isDocumentHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  private isRuntimeSuspended(): boolean {
    return this.isDocumentHidden()
      || (typeof navigator !== 'undefined' && navigator.onLine === false);
  }

  private recordTransportActivity(): void {
    if (this.pongTimeout === null) return;
    clearTimeout(this.pongTimeout);
    this.pongTimeout = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval !== null) clearInterval(this.heartbeatInterval);
    if (this.pongTimeout !== null) clearTimeout(this.pongTimeout);
    this.heartbeatInterval = null;
    this.pongTimeout = null;
  }

  private startHeartbeat(socket: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws !== socket || socket.readyState !== WebSocket.OPEN || this.isRuntimeSuspended()) return;
      if (this.pongTimeout !== null) return;

      try {
        socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      } catch {
        this.handleHeartbeatTimeout(socket);
        return;
      }
      this.pongTimeout = setTimeout(
        () => this.handleHeartbeatTimeout(socket),
        QUOTE_SOCKET_PONG_TIMEOUT_MS,
      );
    }, QUOTE_SOCKET_HEARTBEAT_INTERVAL_MS);
  }

  private handleHeartbeatTimeout(socket: WebSocket): void {
    if (this.ws !== socket) return;
    if (this.isRuntimeSuspended()) {
      this.clearHeartbeat();
      this.reconnectPendingWhileHidden = this.activeSymbols.size > 0;
      return;
    }
    this.ws = null;
    this.clearHeartbeat();
    this.clearStableOpenTimer();
    this.clearSubscriptionTimers(true);
    try { socket.close(4000, 'Quote socket heartbeat timeout'); } catch { /* ignore */ }
    this.subscribedSymbols.clear();
    this.pendingSubscriptions.clear();
    try {
      useWebSocketStore.getState().setConnectionState('disconnected', 'fix_socket');
    } catch { /* store not ready */ }
    this.publishQuoteTransport();
    if (!this.disposed && this.activeSymbols.size > 0) this.scheduleReconnect();
  }

  private startOpenTimeout(socket: WebSocket): void {
    this.clearOpenTimeout();
    this.openTimeout = setTimeout(() => {
      this.openTimeout = null;
      if (this.ws !== socket || socket.readyState !== WebSocket.CONNECTING) return;
      if (this.isRuntimeSuspended()) {
        this.reconnectPendingWhileHidden = this.activeSymbols.size > 0;
        return;
      }

      const transport = this.activeTransport;
      this.ws = null;
      try { socket.close(4000, 'Opening handshake timed out'); } catch { /* ignore */ }
      this.subscribedSymbols.clear();
      this.pendingSubscriptions.clear();
      try {
        useWebSocketStore.getState().setConnectionState('disconnected', 'fix_socket');
      } catch { /* store not ready */ }
      this.publishQuoteTransport();

      if (this.disposed || this.activeSymbols.size === 0) return;

      if (transport === 'feed' && this.failOverToV2('Feed handshake timed out')) return;
      this.scheduleReconnect();
    }, QUOTE_SOCKET_OPEN_TIMEOUT_MS);
  }

  private cancelIdleClose(): void {
    if (this.idleCloseTimer === null) return;
    clearTimeout(this.idleCloseTimer);
    this.idleCloseTimer = null;
  }

  private scheduleIdleClose(): void {
    if (isDesktopBackendTarget()) return;
    if (this.idleCloseTimer !== null || this.disposed) return;
    this.idleCloseTimer = setTimeout(() => {
      this.idleCloseTimer = null;
      if (this.activeSymbols.size === 0) this.close();
    }, 0);
  }

  reconnect(): void {
    if (isDesktopBackendTarget()) {
      binaryTcpMarketStream.forceReconnect();
      return;
    }
    this.resetFeedFailure();
    this.cancelScheduledReconnect();
    if (this.activeSymbols.size > 0) {
      this.closeSocket();
      if (this.isRuntimeSuspended()) {
        this.reconnectPendingWhileHidden = true;
        try {
          useWebSocketStore.getState().setConnectionState('reconnecting', 'fix_socket');
        } catch { /* store not ready */ }
        return;
      }
      this.connect();
    }
  }

  private closeSocket(): void {
    this.cancelIdleClose();
    this.clearOpenTimeout();
    this.clearStableOpenTimer();
    this.clearHeartbeat();
    this.clearSubscriptionTimers(true);
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try { socket.close(1000, 'QuoteSocketManager closing'); } catch { /* ignore */ }
    }
    this.subscribedSymbols.clear();
    this.pendingSubscriptions.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  close(): void {
    if (isDesktopBackendTarget()) return;
    this.closeSocket();
    this.reconnectPendingWhileHidden = false;
    this.reconnectAttempts = 0;
    this.resetFeedFailure();
    try {
      useWebSocketStore.getState().setConnectionState('disconnected', 'fix_socket');
    } catch { /* store not ready */ }
    this.publishQuoteTransport();
  }

  destroy(): void {
    this.disposed = true;
    if (this.unsubBinaryTick) {
      this.unsubBinaryTick();
      this.unsubBinaryTick = null;
    }
    if (this.unsubBinaryState) {
      this.unsubBinaryState();
      this.unsubBinaryState = null;
    }
    this.closeSocket();
    this.demandSources.clear();
    this.activeSymbols.clear();
    this.symbolListeners.clear();
    this.globalListeners.clear();
    if (this.unsubSessionChange) {
      this.unsubSessionChange();
      this.unsubSessionChange = null;
    }
    if (typeof window !== 'undefined' && !isDesktopBackendTarget()) {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('offline', this.handleOffline);
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private handleOnline = (): void => {
    this.reconnect();
  };

  private handleOffline = (): void => {
    this.clearHeartbeat();
    this.clearOpenTimeout();
    this.cancelScheduledReconnect();
    this.reconnectPendingWhileHidden = this.activeSymbols.size > 0;
    try {
      useWebSocketStore.getState().setConnectionState('offline', 'fix_socket');
    } catch { /* store not ready */ }
  };

  private handleVisibilityChange = (): void => {
    if (this.isDocumentHidden()) {
      this.clearHeartbeat();
      this.clearOpenTimeout();
      this.reconnectPendingWhileHidden = this.activeSymbols.size > 0;
      if (this.reconnectTimer) {
        this.cancelScheduledReconnect();
        this.reconnectPendingWhileHidden = true;
        try {
          useWebSocketStore.getState().setConnectionState('reconnecting', 'fix_socket');
        } catch { /* store not ready */ }
      }
      return;
    }

    if (this.reconnectPendingWhileHidden) {
      if (this.disposed || this.activeSymbols.size === 0) return;
      this.reconnectPendingWhileHidden = false;
      this.connect();
      return;
    }

    if (this.activeSymbols.size > 0) this.reconnect();
  };

  getActiveSymbols(): string[] {
    return [...this.activeSymbols];
  }

  isConnected(): boolean {
    if (isDesktopBackendTarget()) return this.binaryConnected;
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getTransport(): QuoteTransport {
    return this.activeTransport;
  }

  isFallbackActive(): boolean {
    return this.fallbackActive;
  }

  /** Helper kept to preserve unused import compatibility if inspected */
  public debugSummary(): string {
    return summarizeSymbols(this.activeSymbols);
  }
}

let instance: QuoteSocketManager | null = null;

export function getQuoteSocketManager(): QuoteSocketManager {
  if (!instance) {
    instance = new QuoteSocketManager();
  }
  return instance;
}

export function destroyQuoteSocketManager(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

export { QuoteSocketManager };

