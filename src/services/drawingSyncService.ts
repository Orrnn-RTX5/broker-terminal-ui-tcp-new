/**
 * Real-Time Multi-Device / Multi-User Account Drawing Sync Service
 *
 * Streams live chart drawings and visibility state (`drawingsHidden`) over
 * `/__rtx5_drawing_ws` scoped strictly to the active `(brokerId, accountLogin)`.
 * Every user/device logged into the same broker + account sees drawing creates,
 * edits, drags, locks, deletes, clears, and hide/show toggles in real time.
 */

import { FIX_API_URL, normalizeWsUrl } from '../config/api';
import { getRuntimeBrokerConfiguration, isDesktopBackendTarget } from '../config/backendTarget.js';
import { toDrawingModel } from '../drawing-tools/runtime/DrawingPersistenceCoordinator';
import type { Drawing } from '../drawing-tools/model/drawing';
import { useChartObjectStateStore } from '../store/useChartObjectStateStore';
import {
  getAccessToken,
  getCommittedBrokerAccountSessionScope,
  onCommittedBrokerAccountSessionScopeChange,
  onSessionChange,
} from './brokerSession';
import {
  DRAWING_SYNC_CLIENT_ID,
  drawingApi,
  transformServerDrawingToClient,
  type ServerDrawing,
} from './drawingApi';
import { drawingManager } from './drawingManager';

const DRAWING_SYNC_WS_PATH = '/__rtx5_drawing_ws';
const RECONNECT_DELAYS_MS = [400, 1000, 2000, 4000, 8000] as const;
const KEEPALIVE_PING_MS = 25_000;

interface DrawingSnapshotItem {
  symbol: string;
  timeframe?: string;
  drawing: Drawing;
}

type DrawingWSMessage =
  | {
    type: 'drawing_snapshot';
    brokerId?: string;
    accountLogin?: number;
    revision?: number;
    drawings?: ServerDrawing[];
    hiddenMap?: Record<string, boolean>;
  }
  | {
    type: 'drawing_upsert';
    brokerId?: string;
    accountLogin?: number;
    revision?: number;
    originClientId?: string;
    drawing?: ServerDrawing;
  }
  | {
    type: 'drawing_delete';
    brokerId?: string;
    accountLogin?: number;
    revision?: number;
    originClientId?: string;
    drawingId?: string;
    clientDrawingId?: string;
    symbol?: string;
    timeframe?: string;
  }
  | {
    type: 'drawings_clear';
    brokerId?: string;
    accountLogin?: number;
    revision?: number;
    originClientId?: string;
    symbol?: string;
    timeframe?: string;
  }
  | {
    type: 'drawing_visibility';
    brokerId?: string;
    accountLogin?: number;
    revision?: number;
    originClientId?: string;
    symbol?: string;
    timeframe?: string;
    accountWide?: boolean;
    drawingsHidden?: boolean;
    hiddenMap?: Record<string, boolean>;
  }
  | {
    type: 'pong';
    ts?: number;
  };

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

export function resolveDrawingSyncWsUrl(token: string): string {
  const query = `token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(DRAWING_SYNC_CLIENT_ID)}`;
  const cfg = readRuntimeConfigRecord();
  const explicit = typeof cfg?.DRAWING_SYNC_WS_URL === 'string' ? cfg.DRAWING_SYNC_WS_URL.trim() : '';
  if (explicit) {
    return `${explicit}${explicit.includes('?') ? '&' : '?'}${query}`;
  }

  if (
    typeof window !== 'undefined'
    && window.location?.host
    && /^https?:$/i.test(window.location.protocol || '')
  ) {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${window.location.host}${DRAWING_SYNC_WS_PATH}?${query}`;
  }

  const origin = isDesktopBackendTarget()
    ? FIX_API_URL
    : (getRuntimeBrokerConfiguration().wsHost || getRuntimeBrokerConfiguration().apiHostExt);
  const wsOrigin = normalizeWsUrl(origin);
  if (!wsOrigin) return '';
  return `${wsOrigin.replace(/\/+$/, '')}${DRAWING_SYNC_WS_PATH}?${query}`;
}

class DrawingSyncService {
  private ws: WebSocket | null = null;
  private started = false;
  private activeSessionKey = '';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private unsubScope: (() => void) | null = null;
  private unsubSession: (() => void) | null = null;

  private lastRevision = 0;
  private hasSnapshot = false;
  private cachedItems: DrawingSnapshotItem[] = [];
  private cachedHiddenMap: Record<string, boolean> = {};

  private readonly handleVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.requestSyncOrReconnect();
    }
  };

  private readonly handleOnline = () => {
    this.requestSyncOrReconnect();
  };

  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    drawingManager.setOnChartContextBound((identity) => {
      this.applyCachedStateForContext(identity.contextId, identity.symbol, identity.timeframe);
    });
    this.unsubScope = onCommittedBrokerAccountSessionScopeChange(() => this.syncSessionConnection());
    this.unsubSession = onSessionChange(() => this.syncSessionConnection());
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
    window.addEventListener('online', this.handleOnline);
    this.syncSessionConnection();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    drawingManager.setOnChartContextBound(null);
    this.unsubScope?.();
    this.unsubScope = null;
    this.unsubSession?.();
    this.unsubSession = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
    }
    this.teardownSocket();
    this.activeSessionKey = '';
    this.resetCache();
  }

  private resetCache(): void {
    this.lastRevision = 0;
    this.hasSnapshot = false;
    this.cachedItems = [];
    this.cachedHiddenMap = {};
  }

  private resolveActiveSession(): { key: string; token: string } | null {
    const scope = getCommittedBrokerAccountSessionScope();
    const token = getAccessToken();
    if (!scope.authenticated || !scope.accountId || !token) return null;
    const brokerId = (scope.brokerId || getRuntimeBrokerConfiguration().brokerId || 'default').trim().toLowerCase();
    return {
      key: `${brokerId}::${scope.accountId}`,
      token,
    };
  }

  private syncSessionConnection(): void {
    if (!this.started) return;
    const active = this.resolveActiveSession();
    if (!active) {
      if (this.activeSessionKey) {
        this.activeSessionKey = '';
        this.teardownSocket();
        this.resetCache();
        drawingManager.resetLoadedContexts();
      }
      return;
    }

    if (active.key !== this.activeSessionKey) {
      this.activeSessionKey = active.key;
      this.teardownSocket();
      this.resetCache();
      drawingManager.resetLoadedContexts();
      this.connect(active.token, active.key);
      return;
    }

    if (!this.ws || (this.ws.readyState !== WebSocket.OPEN && this.ws.readyState !== WebSocket.CONNECTING)) {
      this.connect(active.token, active.key);
    }
  }

  private requestSyncOrReconnect(): void {
    if (!this.started) return;
    const active = this.resolveActiveSession();
    if (!active) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ action: 'sync' }));
      } catch {
        // Ignore send errors; close handler schedules reconnect.
      }
      return;
    }
    this.syncSessionConnection();
  }

  private connect(token: string, expectedSessionKey: string): void {
    this.clearTimers();
    const wsUrl = resolveDrawingSyncWsUrl(token);
    if (!wsUrl || typeof WebSocket === 'undefined') return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect(expectedSessionKey);
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket || this.activeSessionKey !== expectedSessionKey) {
        try { socket.close(); } catch { /* ignore */ }
        return;
      }
      this.reconnectAttempt = 0;
      this.startKeepalive(socket);
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket || this.activeSessionKey !== expectedSessionKey) return;
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data) as DrawingWSMessage;
        this.handleMessage(msg);
      } catch {
        // Ignore malformed server frame
      }
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      try { socket.close(); } catch { /* ignore */ }
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.clearTimers();
      this.ws = null;
      if (this.started && this.activeSessionKey === expectedSessionKey) {
        this.scheduleReconnect(expectedSessionKey);
      }
    };
  }

  private startKeepalive(socket: WebSocket): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ action: 'ping' }));
      } catch {
        // Close handler handles reconnect
      }
    }, KEEPALIVE_PING_MS);
  }

  private scheduleReconnect(expectedSessionKey: string): void {
    if (this.reconnectTimer || !this.started || this.activeSessionKey !== expectedSessionKey) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.started || this.activeSessionKey !== expectedSessionKey) return;
      const active = this.resolveActiveSession();
      if (active && active.key === expectedSessionKey) {
        this.connect(active.token, expectedSessionKey);
      }
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private teardownSocket(): void {
    this.clearTimers();
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Handles an incoming server frame (also exposed for deterministic unit testing).
   */
  handleMessage(msg: DrawingWSMessage): void {
    if (!msg || typeof msg !== 'object') return;
    if ('revision' in msg && typeof msg.revision === 'number' && msg.revision > this.lastRevision) {
      this.lastRevision = msg.revision;
    }

    switch (msg.type) {
      case 'drawing_snapshot': {
        const items: DrawingSnapshotItem[] = Array.isArray(msg.drawings)
          ? msg.drawings.map(raw => ({
            symbol: String(raw.symbol || '').trim().toUpperCase(),
            timeframe: raw.timeframe ? String(raw.timeframe).trim().toUpperCase() : undefined,
            drawing: toDrawingModel(transformServerDrawingToClient(raw)),
          }))
          : [];
        const hiddenMap = msg.hiddenMap && typeof msg.hiddenMap === 'object'
          ? { ...msg.hiddenMap }
          : {};
        this.cachedItems = items;
        this.cachedHiddenMap = hiddenMap;
        this.hasSnapshot = true;
        drawingManager.applyRemoteSnapshot(items, hiddenMap);
        break;
      }

      case 'drawing_upsert': {
        if (!msg.drawing) return;
        const symbol = String(msg.drawing.symbol || '').trim().toUpperCase();
        const timeframe = msg.drawing.timeframe ? String(msg.drawing.timeframe).trim().toUpperCase() : undefined;
        const drawing = toDrawingModel(transformServerDrawingToClient(msg.drawing));

        const idx = this.cachedItems.findIndex(
          item => item.drawing.id === drawing.id
            || (drawing.serverId && item.drawing.serverId === drawing.serverId),
        );
        const entry: DrawingSnapshotItem = { symbol, timeframe, drawing };
        if (idx !== -1) this.cachedItems[idx] = entry;
        else this.cachedItems.push(entry);

        if (msg.originClientId && msg.originClientId === DRAWING_SYNC_CLIENT_ID) {
          return;
        }
        drawingManager.applyRemoteUpsert(symbol, timeframe, drawing);
        break;
      }

      case 'drawing_delete': {
        const drawingId = String(msg.drawingId || '').trim();
        const clientDrawingId = String(msg.clientDrawingId || '').trim() || undefined;
        if (!drawingId && !clientDrawingId) return;

        this.cachedItems = this.cachedItems.filter(
          item => item.drawing.id !== drawingId
            && item.drawing.serverId !== drawingId
            && (!clientDrawingId || (item.drawing.id !== clientDrawingId && item.drawing.serverId !== clientDrawingId)),
        );

        if (msg.originClientId && msg.originClientId === DRAWING_SYNC_CLIENT_ID) {
          return;
        }
        drawingManager.applyRemoteDelete(drawingId || clientDrawingId!, clientDrawingId, msg.symbol, msg.timeframe);
        break;
      }

      case 'drawings_clear': {
        const sym = String(msg.symbol || '').trim().toUpperCase();
        const tf = String(msg.timeframe || '').trim().toUpperCase();
        this.cachedItems = this.cachedItems.filter(item => {
          if (sym && item.symbol !== sym) return true;
          if (tf && item.timeframe && item.timeframe !== tf) return true;
          return false;
        });

        if (msg.originClientId && msg.originClientId === DRAWING_SYNC_CLIENT_ID) {
          return;
        }
        drawingManager.applyRemoteClear(sym || undefined, tf || undefined);
        break;
      }

      case 'drawing_visibility': {
        const hidden = Boolean(msg.drawingsHidden);
        if (msg.hiddenMap && typeof msg.hiddenMap === 'object') {
          this.cachedHiddenMap = { ...msg.hiddenMap };
        } else {
          const sym = String(msg.symbol || '').trim().toUpperCase();
          const tf = String(msg.timeframe || '').trim().toUpperCase();
          const key = !sym ? '*' : (!tf ? `${sym}::*` : `${sym}::${tf}`);
          this.cachedHiddenMap[key] = hidden;
          if (msg.accountWide) this.cachedHiddenMap['*'] = hidden;
        }

        if (msg.originClientId && msg.originClientId === DRAWING_SYNC_CLIENT_ID) {
          return;
        }
        if (msg.accountWide || !msg.symbol) {
          drawingManager.applyRemoteVisibility(undefined, undefined, hidden);
        } else {
          drawingManager.applyRemoteVisibility(msg.symbol, msg.timeframe, hidden);
        }
        break;
      }

      case 'pong':
      default:
        break;
    }
  }

  /**
   * Immediately applies cached remote drawings and visibility state when a
   * chart mounts or changes symbol/timeframe after the live WS snapshot arrived.
   */
  applyCachedStateForContext(contextId: string, symbol: string, timeframe: string): void {
    if (!this.hasSnapshot) return;
    const sym = symbol.trim().toUpperCase();
    const tf = timeframe.trim().toUpperCase();
    const hidden = (`${sym}::${tf}` in this.cachedHiddenMap)
      ? this.cachedHiddenMap[`${sym}::${tf}`]
      : (`${sym}::*` in this.cachedHiddenMap)
        ? this.cachedHiddenMap[`${sym}::*`]
        : ('*' in this.cachedHiddenMap)
          ? this.cachedHiddenMap['*']
          : undefined;
    if (hidden !== undefined) {
      useChartObjectStateStore.getState().setDrawingsHidden(contextId, hidden);
      drawingManager.setDrawingsVisible(contextId, !hidden);
    }
    drawingManager.applyRemoteSnapshot(this.cachedItems, this.cachedHiddenMap);
  }

  /**
   * Publishes a local Hide/Show drawings toggle to the live broker account sync hub.
   */
  publishDrawingsVisibility(
    symbol: string | undefined,
    timeframe: string | undefined,
    drawingsHidden: boolean,
  ): void {
    const sym = String(symbol || '').trim().toUpperCase();
    const tf = String(timeframe || '').trim().toUpperCase();
    const key = !sym ? '*' : (!tf ? `${sym}::*` : `${sym}::${tf}`);
    this.cachedHiddenMap[key] = drawingsHidden;
    this.cachedHiddenMap['*'] = drawingsHidden;
    if (typeof drawingApi.setDrawingsVisibility === 'function') {
      void drawingApi.setDrawingsVisibility(sym, tf || undefined, drawingsHidden).catch(() => {
        // Keep local toggle responsive even if offline.
      });
    }
  }
}

export const drawingSyncService = new DrawingSyncService();
