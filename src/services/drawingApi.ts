/**
 * ============================================================================
 * 🚫 AI FENCE: ISOLATED SYSTEM COMPONENT
 * ============================================================================
 * Do not modify, rewrite, or alter this file when processing other features.
 * Drawing tools are self-contained and highly sensitive to state/prop updates.
 * Any adjustments must be done ONLY under explicit drawing-specific requests.
 * ============================================================================
 */

/**
 * Drawing API Service
 * Handles all HTTP communication with /api/fix/drawings endpoints
 */

import { FIX_API_URL, toLocalDevProxyUrl } from '../config/api';
import { getRuntimeBrokerConfiguration, isDesktopBackendTarget } from '../config/backendTarget.js';
import { getAccessToken, getCommittedBrokerAccountSessionScope } from './brokerSession';
import { assertBrokerRequestAllowed } from '../api/brokerRequestGuard';
import type { PositionSizing } from '../drawing-tools/positionDrawingValues';

const generateClientSyncId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `drw-${crypto.randomUUID()}`;
    }
  } catch {
    // Fallback for environments without crypto.randomUUID
  }
  return `drw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/** Stable per-tab client identifier so real-time WS broadcasts can recognize self-origin echoes. */
export const DRAWING_SYNC_CLIENT_ID = generateClientSyncId();

// Server response types
export interface ServerDrawing {
  id: string;
  type: string;
  symbol: string;
  timeframe?: string;
  userId: string;
  properties: ServerDrawingProperties;
  createdAt: string;
  updatedAt: string;
}

export interface ServerDrawingProperties {
  annotation?: import('../drawing-tools/annotationToolCatalog').AnnotationStyle;
  id?: string;           // Client-generated ID (optional)
  points: Array<{
    time: number;
    price: number;
    logicalIndex?: number;
    barOffset?: number;
    pixelXOffset?: number;
  }>;
  color?: string;
  lineWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  fillColor?: string;
  fillOpacity?: number;
  text?: string;
  subtype?: string;
  locked?: boolean;
  selected?: boolean;
  channelOffset?: number;
  rayLeft?: boolean;
  rayRight?: boolean;
  channelMidpointRatio?: number;
  regressionSource?: 'open' | 'high' | 'low' | 'close' | 'hl2';
  regressionUpperDeviation?: number;
  regressionLowerDeviation?: number;
  showRegressionPearson?: boolean;
  pitchforkLevels?: number[];
  positionTargetPrice?: number;
  positionStopPrice?: number;
  positionEndTime?: number;
  positionEndLogicalIndex?: number;
  positionSizing?: PositionSizing;
  seriesSnapshot?: Array<{
    time: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    value?: number;
    volume?: number;
    tickVolume?: number;
    realVolume?: number;
  }>;
}

export interface LoadDrawingsResponse {
  drawings: ServerDrawing[];
  success: boolean;
  revision?: number;
  drawingsHidden?: boolean;
  hiddenMap?: Record<string, boolean>;
}

export interface LoadDrawingStateResult {
  drawings: ClientDrawing[];
  drawingsHidden?: boolean;
  hiddenMap?: Record<string, boolean>;
  revision?: number;
  authoritative: boolean;
}

export interface SaveDrawingResponse {
  drawingId: string;
  message: string;
  success: boolean;
  revision?: number;
}

export interface DrawingVisibilityResponse {
  success: boolean;
  revision?: number;
  symbol?: string;
  timeframe?: string;
  drawingsHidden?: boolean;
  hiddenMap?: Record<string, boolean>;
}

// Client drawing type (matches DrawingManager)
export interface ClientDrawing {
  annotation?: import('../drawing-tools/annotationToolCatalog').AnnotationStyle;
  id: string;
  type: string;
  points: Array<{
    time: number;
    price: number;
    logicalIndex?: number;
    barOffset?: number;
    pixelXOffset?: number;
  }>;
  text?: string;
  color?: string;
  lineWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  fillColor?: string;
  fillOpacity?: number;
  selected?: boolean;
  locked?: boolean;
  subtype?: string;
  serverId?: string;     // Server-generated ID for updates/deletes
  channelOffset?: number;
  rayLeft?: boolean;
  rayRight?: boolean;
  channelMidpointRatio?: number;
  regressionSource?: 'open' | 'high' | 'low' | 'close' | 'hl2';
  regressionUpperDeviation?: number;
  regressionLowerDeviation?: number;
  showRegressionPearson?: boolean;
  pitchforkLevels?: number[];
  positionTargetPrice?: number;
  positionStopPrice?: number;
  positionEndTime?: number;
  positionEndLogicalIndex?: number;
  positionSizing?: PositionSizing;
  seriesSnapshot?: Array<{
    time: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    value?: number;
    volume?: number;
    tickVolume?: number;
    realVolume?: number;
  }>;
}

export function transformServerDrawingToClient(serverDrawing: ServerDrawing): ClientDrawing {
  const props: Partial<ServerDrawingProperties> = serverDrawing.properties || {};

  return {
    id: props.id || serverDrawing.id || `drawing-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    type: serverDrawing.type,
    points: Array.isArray(props.points) ? props.points : [],
    text: props.text,
    annotation: props.annotation,
    color: props.color || '#3b82f6',
    lineWidth: props.lineWidth || 2,
    fillColor: props.fillColor,
    fillOpacity: props.fillOpacity,
    lineStyle: props.lineStyle || 'solid',
    selected: false, // Always false on load
    locked: props.locked || false,
    subtype: props.subtype,
    channelOffset: props.channelOffset,
    rayLeft: props.rayLeft,
    rayRight: props.rayRight,
    channelMidpointRatio: props.channelMidpointRatio,
    regressionSource: props.regressionSource,
    regressionUpperDeviation: props.regressionUpperDeviation,
    regressionLowerDeviation: props.regressionLowerDeviation,
    showRegressionPearson: props.showRegressionPearson,
    pitchforkLevels: props.pitchforkLevels,
    positionTargetPrice: props.positionTargetPrice,
    positionStopPrice: props.positionStopPrice,
    positionEndTime: props.positionEndTime,
    positionEndLogicalIndex: props.positionEndLogicalIndex,
    positionSizing: props.positionSizing,
    seriesSnapshot: props.seriesSnapshot,
    serverId: serverDrawing.id, // Store server ID for deletes/updates
  };
}

class DrawingApiService {
  private pendingTimeframe?: string;

  /**
   * Passes the active chart timeframe into the next saveDrawing call without
   * altering the two-argument saveDrawing(drawing, symbol) signature.
   */
  setNextDrawingTimeframe(timeframe?: string): void {
    const normalized = String(timeframe || '').trim().toUpperCase();
    this.pendingTimeframe = normalized || undefined;
  }

  // Resolve the configured broker through the same development proxy as trading.
  private get baseUrl() {
    const origin = isDesktopBackendTarget() ? FIX_API_URL : getRuntimeBrokerConfiguration().apiHostExt;
    const url = toLocalDevProxyUrl(`${origin}/api/fix/drawings`);
    assertBrokerRequestAllowed(url);
    return url;
  }

  /**
   * Get auth headers with Bearer token, broker scope, and sync client id.
   */
  private getHeaders(): HeadersInit {
    const token = getAccessToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Client-ID': DRAWING_SYNC_CLIENT_ID,
    };
    const committedBrokerId = getCommittedBrokerAccountSessionScope().brokerId
      || getRuntimeBrokerConfiguration().brokerId;
    if (committedBrokerId) {
      headers['X-Broker-ID'] = committedBrokerId;
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * Extract user / account ID from JWT token
   */
  private getUserId(): string {
    try {
      const token = getAccessToken();
      if (!token) return 'guest';

      const segment = token.split('.')[1];
      if (!segment) return 'guest';
      const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
      const payload = JSON.parse(atob(padded));
      return String(payload.account_login || payload.sub || payload.userId || payload.id || 'guest');
    } catch (e) {
      console.warn('[DrawingApi] Failed to parse JWT:', e);
      return 'guest';
    }
  }

  /**
   * Transform client drawing to server payload
   */
  private transformClientToServer(drawing: ClientDrawing, symbol: string, timeframe?: string): object {
    const normalizedTimeframe = String(timeframe || '').trim().toUpperCase();
    return {
      ...(drawing.serverId ? { id: drawing.serverId } : {}),
      type: drawing.type,
      symbol: symbol,
      ...(normalizedTimeframe ? { timeframe: normalizedTimeframe } : {}),
      userId: this.getUserId(),
      properties: {
        id: drawing.id,           // Preserve client ID
        points: drawing.points,
        color: drawing.color,
        lineWidth: drawing.lineWidth,
        fillColor: drawing.fillColor,
        fillOpacity: drawing.fillOpacity,
        lineStyle: drawing.lineStyle,
        text: drawing.text,
        annotation: drawing.annotation,
        subtype: drawing.subtype,
        channelOffset: drawing.channelOffset,
        rayLeft: drawing.rayLeft,
        rayRight: drawing.rayRight,
        channelMidpointRatio: drawing.channelMidpointRatio,
        regressionSource: drawing.regressionSource,
        regressionUpperDeviation: drawing.regressionUpperDeviation,
        regressionLowerDeviation: drawing.regressionLowerDeviation,
        showRegressionPearson: drawing.showRegressionPearson,
        pitchforkLevels: drawing.pitchforkLevels,
        positionTargetPrice: drawing.positionTargetPrice,
        positionStopPrice: drawing.positionStopPrice,
        positionEndTime: drawing.positionEndTime,
        positionEndLogicalIndex: drawing.positionEndLogicalIndex,
        positionSizing: drawing.positionSizing,
        seriesSnapshot: drawing.seriesSnapshot,
        locked: drawing.locked,
        // Exclude 'selected' - it's transient UI state
      },
    };
  }

  /**
   * Load drawings + visibility state for a symbol/timeframe from the live broker sync server.
   */
  async loadDrawingState(symbol: string, timeframe?: string): Promise<LoadDrawingStateResult> {
    const token = getAccessToken();
    if (!token) {
      return { drawings: [], authoritative: false };
    }
    const params = new URLSearchParams();
    const sym = String(symbol || '').trim().toUpperCase();
    const tf = String(timeframe || '').trim().toUpperCase();
    if (sym) params.set('symbol', sym);
    if (tf) params.set('timeframe', tf);
    const query = params.toString();
    const url = query ? `${this.baseUrl}?${query}` : this.baseUrl;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        cache: 'no-store',
        redirect: 'error',
      });
      if (!response.ok) {
        return { drawings: [], authoritative: false };
      }
      const data = (await response.json()) as Partial<LoadDrawingsResponse>;
      if (!data || data.success === false || !Array.isArray(data.drawings)) {
        return { drawings: [], authoritative: false };
      }
      return {
        drawings: data.drawings.map(transformServerDrawingToClient),
        drawingsHidden: typeof data.drawingsHidden === 'boolean' ? data.drawingsHidden : undefined,
        hiddenMap: data.hiddenMap && typeof data.hiddenMap === 'object' ? data.hiddenMap : undefined,
        revision: typeof data.revision === 'number' ? data.revision : undefined,
        authoritative: true,
      };
    } catch {
      return { drawings: [], authoritative: false };
    }
  }

  /**
   * Load all drawings for a symbol
   */
  async loadDrawings(symbol: string, timeframe?: string): Promise<ClientDrawing[]> {
    const state = await this.loadDrawingState(symbol, timeframe);
    return state.drawings;
  }

  /**
   * Save or upsert a drawing
   */
  async saveDrawing(drawing: ClientDrawing, symbol: string): Promise<string> {
    const timeframe = this.pendingTimeframe;
    this.pendingTimeframe = undefined;
    const payload = this.transformClientToServer(drawing, symbol, timeframe);

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
      redirect: 'error',
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || errorData.error || `Save failed: HTTP ${response.status}`);
    }

    const result: SaveDrawingResponse = await response.json();

    if (!result.success) {
      throw new Error('Server returned unsuccessful response');
    }

    return result.drawingId;
  }

  /**
   * Delete a drawing by server ID
   */
  async deleteDrawing(serverId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(serverId)}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
      redirect: 'error',
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Delete failed: HTTP ${response.status}`);
    }
  }

  /**
   * Clear all drawings for a symbol/timeframe on the live account.
   */
  async clearDrawings(symbol: string, timeframe?: string): Promise<void> {
    if (!getAccessToken()) return;
    const params = new URLSearchParams();
    const sym = String(symbol || '').trim().toUpperCase();
    const tf = String(timeframe || '').trim().toUpperCase();
    if (sym) params.set('symbol', sym);
    if (tf) params.set('timeframe', tf);
    const query = params.toString();
    const url = query ? `${this.baseUrl}?${query}` : this.baseUrl;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.getHeaders(),
      redirect: 'error',
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Clear drawings failed: HTTP ${response.status}`);
    }
  }

  /**
   * Publish shared drawings visibility (Hide/Show drawings) for the account.
   */
  async setDrawingsVisibility(
    symbol: string,
    timeframe: string | undefined,
    drawingsHidden: boolean,
  ): Promise<DrawingVisibilityResponse | null> {
    if (!getAccessToken()) return null;
    const response = await fetch(`${this.baseUrl}/visibility`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({
        symbol: String(symbol || '').trim().toUpperCase(),
        timeframe: String(timeframe || '').trim().toUpperCase(),
        drawingsHidden: Boolean(drawingsHidden),
      }),
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`Visibility update failed: HTTP ${response.status}`);
    }
    return (await response.json()) as DrawingVisibilityResponse;
  }

  /**
   * Update an existing drawing (if your API supports it)
   * Note: Your API may require DELETE + POST instead
   */
  async updateDrawing(serverId: string, drawing: ClientDrawing, symbol: string): Promise<void> {
    await this.deleteDrawing(serverId);
    await this.saveDrawing(drawing, symbol);
  }
}

// Export singleton
export const drawingApi = new DrawingApiService();
