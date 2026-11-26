/**
 * Chart Data Service — Pure Binary TCP OHLCV History & Live Binary Candle Stream
 *
 * In RTX5 Desktop Mode (`isDesktopBackendTarget() === true`):
 *   - Historical candles load directly from `GET /api/v2/binary-candles/{symbol}`
 *     as raw 64-byte IEEE-754 Little-Endian structs (`application/octet-stream`),
 *     decoded via `DataView` in < 0.5 ms with ZERO `JSON.parse()`.
 *   - Live candle updates stream directly from `binaryTcpMarketStream` (`0x22`
 *     64-byte `BinaryCandle` frames over `:4443` Binary TCP) with ZERO WebSockets.
 */

import type { TickData } from '../types/history';
import type { FetchCandlesOptions, OHLCData } from '../types/chartData';
import {
  getPublicBackendTarget,
  getRuntimeBrokerConfiguration,
  getRuntimeConfiguredBrokerId,
  isDesktopBackendTarget,
} from '../config/backendTarget.js';
import {
  API_V2_BASE_URL,
  RTX5_API_URL,
  RTX5_WS_URL,
  toLocalDevProxyUrl,
} from '../config/api';
import {
  buildBrokerApiV2,
  buildBrokerWsV2Uri,
  getAccessToken,
  getCommittedBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScopeKey,
  onCommittedBrokerAccountSessionScopeChange,
  onSessionChange,
} from './brokerSession';
import { binaryTcpMarketStream, fetchBinaryCandles } from './binaryTcpMarketStream';
import { assertBrokerRequestAllowed } from '../api/brokerRequestGuard';
import { alignTimeframeBoundarySeconds } from '../utils/timeframeBoundary';
import { decodeJwtPayload } from '../utils/jwt';
import { candleCache } from './candleCache';
import { takePublicStartupHistory } from '../startup/publicHistoryPrefetch';
import {
  preloadAuthenticatedStartupHistory,
  StartupHistorySessionChangedError,
  takeAuthenticatedStartupHistory,
} from '../startup/authenticatedHistoryPrefetch';
import {
  DEFAULT_CHART_SYMBOL,
  DEFAULT_CHART_TIMEFRAME,
  FIRST_PAINT_HISTORY_COUNT,
} from '../constants/chartDefaults';
import {
  getChartPriceFromQuote,
  isStructurallyValidPriceCandle,
  repairPriceCandle,
} from './chartPriceGuards';
import {
  CANDLE_TIMEFRAME_SECONDS,
  normalizeBackendCandleTimeframe,
  normalizeBackendCandleTimeframeOrNull,
  normalizeCandleApiQueryParams,
  type BackendCandleTimeframe,
  type CandleApiQueryParams,
} from '../utils/candleApi';
import {
  asUnknownRecord,
  normalizeBrokerTimestampSeconds,
  readCandleFinality,
} from '../utils/brokerStreamSemantics';

export type { FetchCandlesOptions, OHLCData } from '../types/chartData';

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export type ApiTimeframe = BackendCandleTimeframe;

export interface CandleStreamOptions {
  symbol: string;
  timeframe: string;
  onSnapshot?: (candles: OHLCData[]) => void;
  onCandle?: (candle: OHLCData) => void;
  onError?: (error: Error) => void;
  onConnected?: () => void;
}

export interface CandleStreamSubscription {
  close: () => void;
}

interface SharedCandleStream {
  scope: string;
  consumers: Set<CandleStreamOptions>;
  transport: CandleStreamSubscription | null;
  ready: boolean;
  readyRevision: number;
  closed: boolean;
  releaseScopeListeners: () => void;
}

export const CANDLE_STREAM_BASE_RECONNECT_DELAY_MS = 1_000;
export const CANDLE_STREAM_OPEN_TIMEOUT_MS = 10_000;
export const CANDLE_STREAM_SUBSCRIPTION_ACK_TIMEOUT_MS = 3_000;
export const CANDLE_STREAM_MAX_SUBSCRIPTION_RETRIES = 3;
export const CANDLE_STREAM_HEARTBEAT_INTERVAL_MS = 25_000;
export const CANDLE_STREAM_PONG_TIMEOUT_MS = 10_000;
const CANDLE_STREAM_MAX_RECONNECT_DELAY_MS = 30_000;
const CANDLE_STREAM_AUTH_CLOSE_CODES = new Set([1008, 4001, 4003, 4401, 4403]);

const candleDeploymentIdentity = (): string => {
  if (isDesktopBackendTarget()) return 'desktop';
  const configuration = getRuntimeBrokerConfiguration();
  return JSON.stringify([configuration.valid, configuration.brokerId, configuration.apiHost, configuration.apiHostExt, configuration.wsHost]);
};

const resolveCandleStreamEndpoint = (): { url: string; token: string | null } => {
  if (isDesktopBackendTarget()) return { url: 'desktop-binary-tcp', token: null };
  const token = getAuthToken();
  const brokerUrl = buildBrokerWsV2Uri(token);
  const wsBase = brokerUrl || (isDesktopBackendTarget() ? RTX5_WS_URL.replace(/\/$/, '') : '');
  const separator = wsBase.includes('?') ? '&' : '?';
  return {
    url: brokerUrl || (wsBase ? `${wsBase}${token ? `${separator}token=${encodeURIComponent(token)}` : ''}` : ''),
    token,
  };
};

const candleStreamScope = (): string => JSON.stringify([
  candleDeploymentIdentity(),
  getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope()),
  resolveCandleStreamEndpoint(),
]);

const normalizeTimeForApiTimeframe = (time: number, timeframe?: ApiTimeframe): number => {
  if (!time || !timeframe) return time;
  return alignTimeframeBoundarySeconds(time, timeframe, CANDLE_TIMEFRAME_SECONDS[timeframe]);
};

const runtimeApiV2BaseUrl = (): string => {
  const brokerBase = toLocalDevProxyUrl(buildBrokerApiV2()).replace(/\/$/, '');
  if (brokerBase) return brokerBase;
  const apiV2Base = API_V2_BASE_URL.replace(/\/$/, '');
  if (apiV2Base) return apiV2Base;
  const configBase = RTX5_API_URL.replace(/\/$/, '');
  return configBase ? `${configBase}/api/v2` : '/api/v2';
};

const runtimeApiRootUrl = (): string => runtimeApiV2BaseUrl().replace(/\/api\/v2\/?$/, '');

const BRIDGE_CANDLE_TIMEFRAMES: Record<ApiTimeframe, string | null> = {
  M1: '1m',
  M5: '5m',
  M15: '15m',
  M30: '30m',
  H1: '1h',
  H4: '4h',
  D1: '1d',
  W1: null,
  MN: null,
};

const MAX_BRIDGE_CANDLE_LIMIT = 500;

const buildPublicBridgeCandleUrl = (
  symbol: string,
  timeframe: ApiTimeframe,
  limit?: number,
): string => {
  const root = runtimeApiRootUrl();
  const tf = BRIDGE_CANDLE_TIMEFRAMES[timeframe];
  if (!root || !tf || !symbol) return '';

  const params = new URLSearchParams({
    symbol: normalizeSymbol(symbol),
    tf,
  });
  if (limit !== undefined) {
    params.set('limit', String(Math.min(MAX_BRIDGE_CANDLE_LIMIT, Math.max(1, limit))));
  }
  return `${root}/api/v1/candles?${params.toString()}`;
};

const getAuthToken = (): string | null => getAccessToken();

export class CandleAuthBrokerMismatchError extends Error {
  constructor(expectedBrokerId: string, tokenBrokerId: string) {
    super(`Candle auth token broker mismatch: active broker is ${expectedBrokerId}, token broker is ${tokenBrokerId}`);
    this.name = 'CandleAuthBrokerMismatchError';
  }
}

const normalizeBrokerId = (value: unknown): string => String(value ?? '').trim();
const hasPublicCandleBridge = (): boolean => getRuntimeBrokerConfiguration().publicCandleBridge;

const getActiveBrokerId = (): string => {
  if (!isDesktopBackendTarget()) return getRuntimeConfiguredBrokerId();
  if (typeof window === 'undefined') return '';
  return normalizeBrokerId(
    localStorage.getItem('broker_id')
    || localStorage.getItem('rtx_broker_id')
    || '',
  );
};

const getTokenBrokerId = (token: string): string => {
  const payload = decodeJwtPayload(token);
  return normalizeBrokerId(payload?.broker_id);
};

const assertCandleAuthMatchesActiveBroker = (token: string): void => {
  const expectedBrokerId = getActiveBrokerId();
  const tokenBrokerId = getTokenBrokerId(token);
  if (!expectedBrokerId || !tokenBrokerId) return;
  if (expectedBrokerId === tokenBrokerId) return;

  candleCache.clearAll();
  throw new CandleAuthBrokerMismatchError(expectedBrokerId, tokenBrokerId);
};

const buildQuery = (params: CandleApiQueryParams): string => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) search.set(key, String(value));
  });
  const qs = search.toString();
  return qs ? `?${qs}` : '';
};

const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase();

const normalizeApiTimeframeValue = (timeframe: unknown): ApiTimeframe | null => (
  normalizeBackendCandleTimeframeOrNull(timeframe)
);

const toSeconds = (value: unknown): number => normalizeBrokerTimestampSeconds(value) ?? 0;

const toFiniteNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const toOptionalBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'closed' || normalized === 'final') return true;
  if (normalized === 'false' || normalized === 'open' || normalized === 'forming') return false;
  return undefined;
};

const CANDLE_ARRAY_KEYS = [
  'candles', 'bars', 'ohlc', 'ohlcv', 'rates', 'history', 'items', 'rows', 'values', 'data',
] as const;

const CANDLE_WRAPPER_KEYS = [
  'data', 'payload', 'result', 'response', 'body', 'history',
] as const;

const findCandleArray = (payload: any, depth = 0): { candles: any[]; matched: boolean } => {
  if (Array.isArray(payload)) return { candles: payload, matched: true };
  if (!payload || typeof payload !== 'object' || depth > 4) return { candles: [], matched: false };

  for (const key of CANDLE_ARRAY_KEYS) {
    if (Array.isArray(payload[key])) return { candles: payload[key], matched: true };
  }
  for (const key of CANDLE_WRAPPER_KEYS) {
    const nested = findCandleArray(payload[key], depth + 1);
    if (nested.matched) return nested;
  }
  return { candles: [], matched: false };
};

const extractCandles = (payload: any): any[] => findCandleArray(payload).candles;
const extractCandle = (payload: any): any | null => (
  payload?.candle ?? payload?.data?.candle ?? payload?.payload?.candle ?? payload?.data ?? null
);

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const metadataText = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

const SYMBOL_METADATA_KEYS = [
  'symbol', 'Symbol', 'SYMBOL', 'instrument', 'Instrument', 'INSTRUMENT', 'pair', 'Pair', 'PAIR',
] as const;

const TIMEFRAME_METADATA_KEYS = [
  'timeframe', 'timeFrame', 'time_frame', 'Timeframe', 'TIMEFRAME',
  'tf', 'TF', 'period', 'Period', 'PERIOD', 'interval', 'Interval', 'INTERVAL',
  'resolution', 'Resolution', 'RESOLUTION',
] as const;

const METADATA_WRAPPER_KEYS = [
  'data', 'payload', 'result', 'response', 'body', 'candle', 'bar', 'rate', 'message',
] as const;

const findMetadataText = (
  value: unknown,
  keys: readonly string[],
  depth = 0,
): string | null => {
  if (depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMetadataText(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const found = metadataText(value[key]);
    if (found) return found;
  }
  for (const key of METADATA_WRAPPER_KEYS) {
    const found = findMetadataText(value[key], keys, depth + 1);
    if (found) return found;
  }
  return null;
};

const getMessageChannel = (message: unknown): string | null => {
  if (!isRecord(message)) return null;
  return metadataText(message.channel) ?? metadataText(message.topic);
};

const messageMatchesCandleSubscription = (
  message: unknown,
  channel: string,
  symbol: string,
  timeframe: ApiTimeframe,
): boolean => {
  const messageChannel = getMessageChannel(message);
  if (messageChannel) return messageChannel.toUpperCase() === channel.toUpperCase();

  const messageSymbol = findMetadataText(message, SYMBOL_METADATA_KEYS);
  const messageTimeframe = findMetadataText(message, TIMEFRAME_METADATA_KEYS);
  if (!messageSymbol) return false;

  if (!messageTimeframe) {
    return timeframe === 'M1'
      && isRecord(message)
      && String(message.type ?? '').toLowerCase() === 'update'
      && normalizeSymbol(messageSymbol) === symbol;
  }

  return normalizeSymbol(messageSymbol) === symbol
    && normalizeApiTimeframeValue(messageTimeframe) === timeframe;
};

export class ChartDataService {
  private readonly candleStreams = new Map<string, SharedCandleStream>();
  private readonly candleStreamRefreshers = new Set<() => void>();

  normalizeTimeframe(timeframe: string): ApiTimeframe {
    return normalizeBackendCandleTimeframe(timeframe);
  }

  getCandleCacheScope(): string {
    return runtimeApiV2BaseUrl() || 'default';
  }

  normalizeCandle(input: any, timeframe?: string): OHLCData | null {
    if (!input) return null;
    const tf = timeframe ? this.normalizeTimeframe(timeframe) : undefined;
    const row = Array.isArray(input) ? {
      time: input[0],
      open: input[1],
      high: input[2],
      low: input[3],
      close: input[4],
      volume: input[5],
      tick_volume: input[5],
      real_volume: input[7],
    } : input;
    const rawTime = toSeconds(
      row.time ?? row.Time ?? row.TIME ?? row.timestamp ?? row.Timestamp
      ?? row.t ?? row.date ?? row.datetime ?? row.open_time ?? row.openTime,
    );
    const time = normalizeTimeForApiTimeframe(rawTime, tf);
    const open = Number(row.open ?? row.Open ?? row.OPEN ?? row.o);
    const high = Number(row.high ?? row.High ?? row.HIGH ?? row.h);
    const low = Number(row.low ?? row.Low ?? row.LOW ?? row.l);
    const close = Number(row.close ?? row.Close ?? row.CLOSE ?? row.c);
    const tickVolume = toFiniteNumber(
      row.tick_volume ?? row.tickVolume ?? row.tick_count ?? row.tickCount ?? row.ticks ?? row.TICK_VOLUME ?? row.TICK_COUNT,
    );
    const realVolume = toFiniteNumber(row.real_volume ?? row.realVolume ?? row.REAL_VOLUME);
    const legacyVolume = toFiniteNumber(row.volume ?? row.Volume ?? row.VOLUME ?? row.v);
    const positiveVolume = [tickVolume, legacyVolume, realVolume].find((value) => value !== undefined && value > 0);
    const volume = positiveVolume ?? tickVolume ?? legacyVolume ?? realVolume ?? 0;
    const closed = toOptionalBoolean(
      row.closed ?? row.is_closed ?? row.isClosed ?? row.complete ?? row.completed ?? row.is_complete ?? row.isComplete ?? row.final,
    );

    const backendPrices = { open, high, low, close };
    if (!time || !isStructurallyValidPriceCandle(backendPrices)) return null;

    return {
      time,
      ...(tf === 'D1' ? { sourceTime: rawTime } : {}),
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
      ...(tickVolume !== undefined ? { tickVolume } : {}),
      ...(realVolume !== undefined ? { realVolume } : {}),
      ...(closed !== undefined ? { closed } : {}),
    };
  }

  normalizeCandles(input: any, timeframe?: string): OHLCData[] {
    return this.normalizeCandleItems(extractCandles(input), timeframe);
  }

  private normalizeCandleItems(items: any[], timeframe?: string): OHLCData[] {
    const byTime = new Map<number, OHLCData>();
    for (const item of items) {
      const candle = this.normalizeCandle(item, timeframe);
      if (candle) byTime.set(candle.time, candle);
    }
    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  }

  private normalizeCandleResponse(input: any, timeframe?: string, expectedSymbol?: string): OHLCData[] {
    const responseSymbol = findMetadataText(input, SYMBOL_METADATA_KEYS);
    const responseTimeframe = findMetadataText(input, TIMEFRAME_METADATA_KEYS);
    if (expectedSymbol && responseSymbol && normalizeSymbol(responseSymbol) !== normalizeSymbol(expectedSymbol)) {
      throw new Error(`Candle response symbol mismatch: expected ${expectedSymbol}, received ${responseSymbol}`);
    }
    if (timeframe && responseTimeframe
      && normalizeApiTimeframeValue(responseTimeframe) !== this.normalizeTimeframe(timeframe)) {
      throw new Error(`Candle response timeframe mismatch: expected ${timeframe}, received ${responseTimeframe}`);
    }
    const extracted = findCandleArray(input);
    if (!extracted.matched) throw new Error('Malformed candle response');
    const candles = this.normalizeCandleItems(extracted.candles, timeframe);
    if (extracted.candles.length > 0 && candles.length === 0) {
      throw new Error('Malformed candle response');
    }
    return candles;
  }

  mergeCandle(candles: OHLCData[], incoming: OHLCData, maxCandles?: number): OHLCData[] {
    const next = [...candles];
    const last = next[next.length - 1];
    if (!isStructurallyValidPriceCandle(incoming)) return next;
    const sealedIncoming = { ...incoming };

    if (!last || incoming.time > last.time) {
      next.push(sealedIncoming);
    } else if (incoming.time === last.time) {
      const merged = sealedIncoming.closed === true
        ? sealedIncoming
        : {
          ...last,
          ...sealedIncoming,
          high: Math.max(last.high, sealedIncoming.high),
          low: Math.min(last.low, sealedIncoming.low),
          volume: Math.max(last.volume, sealedIncoming.volume),
        };
      next[next.length - 1] = merged;
    } else {
      const index = next.findIndex((c) => c.time === incoming.time);
      if (index >= 0) {
        const existing = next[index];
        next[index] = sealedIncoming.closed === true
          ? sealedIncoming
          : {
            ...existing,
            ...sealedIncoming,
            high: Math.max(existing.high, sealedIncoming.high),
            low: Math.min(existing.low, sealedIncoming.low),
            volume: Math.max(existing.volume, sealedIncoming.volume),
          };
      } else {
        next.push(sealedIncoming);
      }
      const sorted = next.sort((a, b) => a.time - b.time);
      return maxCandles && sorted.length > maxCandles ? sorted.slice(-maxCandles) : sorted;
    }

    return maxCandles && next.length > maxCandles ? next.slice(-maxCandles) : next;
  }

  shouldRepaintForCandle(candles: OHLCData[], incoming: OHLCData): boolean {
    const last = candles[candles.length - 1];
    return !!last && incoming.time < last.time;
  }

  async fetchCandles(options: FetchCandlesOptions): Promise<OHLCData[]> {
    const startupHistory = takeAuthenticatedStartupHistory(options);
    if (startupHistory) {
      try {
        const candles = await startupHistory;
        if (candles.length > 0) {
          options.onStartupPrefetchConsumed?.();
          return candles;
        }
      } catch (error) {
        if (options.signal?.aborted || error instanceof StartupHistorySessionChangedError) throw error;
      }
    }
    return this.fetchCandlesFromNetwork(options);
  }

  preloadStartupHistory(): void {
    if (!DEFAULT_CHART_SYMBOL) return;
    preloadAuthenticatedStartupHistory((signal) => this.fetchCandlesFromNetwork({
      symbol: DEFAULT_CHART_SYMBOL,
      timeframe: DEFAULT_CHART_TIMEFRAME,
      count: FIRST_PAINT_HISTORY_COUNT,
      signal,
    }));
  }

  private async fetchCandlesFromNetwork(options: FetchCandlesOptions): Promise<OHLCData[]> {
    const { symbol, timeframe, count, from, to, signal } = options;
    const apiTf = this.normalizeTimeframe(timeframe);
    const apiV2BaseUrl = runtimeApiV2BaseUrl();
    const token = getAuthToken();
    const deploymentIdentity = candleDeploymentIdentity();
    const assertRequestSession = () => {
      if (deploymentIdentity !== candleDeploymentIdentity()
        || (!isDesktopBackendTarget() && token !== getAuthToken())) {
        throw new DOMException('The deployment broker session changed while loading candle history.', 'AbortError');
      }
    };
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
    const queryParams = normalizeCandleApiQueryParams({
      timeframe: apiTf,
      count,
      from,
      to,
    });

    let candleAuthMatchesActiveBroker = true;
    if (token) {
      try {
        assertCandleAuthMatchesActiveBroker(token);
      } catch (error) {
        if (!(error instanceof CandleAuthBrokerMismatchError)) throw error;
        candleAuthMatchesActiveBroker = false;
      }
    }

    // ── PURE BINARY TCP FAST PATH (RTX5 Desktop Client) ──────────────────────
    // Serves both guest pre-login and authenticated chart requests directly
    // from MT5CandleEngine RAM/PG in raw 64-byte IEEE-754 Little-Endian binary!
    if (isDesktopBackendTarget() && candleAuthMatchesActiveBroker) {
      const binaryUrl = `${apiV2BaseUrl}/binary-candles/${encodeURIComponent(symbol)}${buildQuery(queryParams)}`;
      try {
        const binaryCandles = await fetchBinaryCandles(binaryUrl, apiTf, signal, authHeaders);
        assertRequestSession();
        return binaryCandles;
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err;
        // Fall through to legacy /candles/{symbol} only if binary endpoint is unavailable
      }
    }

    const attempts: Array<{
      url: string;
      headers?: Record<string, string>;
      isAuthenticatedCore?: boolean;
    }> = [];

    if (isDesktopBackendTarget() && apiV2BaseUrl && candleAuthMatchesActiveBroker) {
      attempts.push({
        url: `${apiV2BaseUrl}/candles/${encodeURIComponent(symbol)}${buildQuery(queryParams)}`,
        headers: authHeaders,
        ...(token ? { isAuthenticatedCore: true } : {}),
      });
    }

    const publicBackend = getPublicBackendTarget();
    if (!token && !isDesktopBackendTarget() && publicBackend) {
      attempts.push({
        url: toLocalDevProxyUrl(`${publicBackend}/api/v2/candles/${encodeURIComponent(symbol)}${buildQuery(queryParams)}`),
        headers: { 'X-Broker-ID': getRuntimeConfiguredBrokerId() },
      });
    }
    if (token && apiV2BaseUrl && !isDesktopBackendTarget() && candleAuthMatchesActiveBroker) {
      attempts.push({
        url: `${apiV2BaseUrl}/candles/${encodeURIComponent(symbol)}${buildQuery(queryParams)}`,
        headers: authHeaders,
        isAuthenticatedCore: true,
      });
    }

    if (from === undefined && to === undefined && hasPublicCandleBridge()) {
      const publicUrl = buildPublicBridgeCandleUrl(symbol, apiTf, queryParams.limit);
      if (publicUrl) attempts.push({ url: publicUrl });
    }

    if (attempts.length === 0) {
      return [];
    }

    let lastError: Error | null = null;
    let authenticatedCoreContractError: Error | null = null;
    let sawSuccessfulSource = false;
    for (const attempt of attempts) {
      try {
        assertRequestSession();
        assertBrokerRequestAllowed(attempt.url);
        if (!isDesktopBackendTarget() && attempt.headers?.Authorization
          && attempt.headers.Authorization !== `Bearer ${getAuthToken()}`) {
          throw new Error('The broker session changed before loading candle history.');
        }
        if (!token && !isDesktopBackendTarget()) {
          const prefetched = takePublicStartupHistory(attempt.url, signal);
          if (prefetched) {
            try {
              const candles = this.normalizeCandleResponse(await prefetched, apiTf, symbol);
              assertRequestSession();
              if (candles.length > 0) {
                options.onStartupPrefetchConsumed?.();
                return candles;
              }
            } catch (error) {
              if (signal?.aborted) throw error;
            }
          }
        }
        assertRequestSession();
        const response = await fetch(attempt.url, {
          signal,
          headers: attempt.headers,
          cache: 'no-store',
          redirect: 'error',
          ...(!token ? { credentials: 'omit' as const } : {}),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        let candles: OHLCData[];
        try {
          candles = this.normalizeCandleResponse(await response.json(), apiTf, symbol);
          assertRequestSession();
        } catch (error) {
          if ((error as Error).name === 'AbortError') throw error;
          const normalizedError = error instanceof Error ? error : new Error('Malformed candle response');
          if (attempt.isAuthenticatedCore) authenticatedCoreContractError = normalizedError;
          lastError = normalizedError;
          continue;
        }

        sawSuccessfulSource = true;
        if (candles.length > 0) return candles;
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        lastError = error instanceof Error ? error : new Error('Failed to load candles');
      }
    }

    if (sawSuccessfulSource) {
      if (authenticatedCoreContractError) throw authenticatedCoreContractError;
      return [];
    }
    throw lastError ?? new Error('Failed to load candles');
  }

  /**
   * Full-reconnect entry point for chart/data candle streams.
   * Reuses each live transport's existing refresh path; it adds no new
   * socket layer and leaves scope/auth guards untouched (broker-agnostic).
   */
  refreshCandleStreams(): void {
    if (isDesktopBackendTarget()) {
      binaryTcpMarketStream.forceReconnect();
    }
    for (const refresh of Array.from(this.candleStreamRefreshers)) {
      try {
        refresh();
      } catch {
        // Keep sibling streams isolated; one failed refresh must not block the rest.
      }
    }
  }

  subscribeCandles(options: CandleStreamOptions): CandleStreamSubscription {
    const scope = candleStreamScope();
    const symbol = normalizeSymbol(options.symbol);
    const timeframe = this.normalizeTimeframe(options.timeframe);
    const key = JSON.stringify([scope, symbol, timeframe]);
    const consumer = { ...options };
    const retire = (streamKey: string, stream: SharedCandleStream) => {
      if (stream.closed) return;
      stream.closed = true;
      stream.ready = false;
      stream.releaseScopeListeners();
      stream.transport?.close();
      stream.consumers.clear();
      if (this.candleStreams.get(streamKey) === stream) this.candleStreams.delete(streamKey);
    };
    for (const [streamKey, stream] of this.candleStreams) {
      if (stream.scope !== scope) retire(streamKey, stream);
    }

    let stream = this.candleStreams.get(key);
    if (!stream) {
      stream = {
        scope,
        consumers: new Set(),
        transport: null,
        ready: false,
        readyRevision: 0,
        closed: false,
        releaseScopeListeners: () => undefined,
      };
      this.candleStreams.set(key, stream);
      const ownedStream = stream;
      const isCurrent = () => {
        if (ownedStream.closed) return false;
        if (candleStreamScope() === ownedStream.scope) return true;
        retire(key, ownedStream);
        return false;
      };
      const notify = (deliver: (listener: CandleStreamOptions) => void) => {
        if (!isCurrent()) return;
        for (const listener of [...ownedStream.consumers]) {
          if (!ownedStream.consumers.has(listener) || !isCurrent()) continue;
          try {
            deliver(listener);
          } catch (error) {
            try {
              listener.onError?.(error instanceof Error ? error : new Error('Candle listener failed'));
            } catch {
              // Keep sibling consumers isolated.
            }
          }
        }
      };
      const releaseSession = onSessionChange(() => { isCurrent(); });
      const releaseScope = onCommittedBrokerAccountSessionScopeChange(() => { isCurrent(); });
      ownedStream.releaseScopeListeners = () => { releaseSession(); releaseScope(); };
      ownedStream.consumers.add(consumer);
      ownedStream.transport = this.createCandleStream(
        {
          symbol,
          timeframe,
          onConnected: () => {
            ownedStream.ready = true;
            ownedStream.readyRevision += 1;
            notify((listener) => listener.onConnected?.());
          },
          onSnapshot: (candles) => notify((listener) => listener.onSnapshot?.(candles.map((candle) => ({ ...candle })))),
          onCandle: (candle) => notify((listener) => listener.onCandle?.({ ...candle })),
          onError: (error) => {
            ownedStream.ready = false;
            notify((listener) => listener.onError?.(error));
          },
        },
        isCurrent,
        () => { ownedStream.ready = false; },
      );
    } else {
      stream.consumers.add(consumer);
      const ownedStream = stream;
      const readyRevision = ownedStream.readyRevision;
      if (ownedStream.ready) {
        void Promise.resolve().then(() => {
          if (ownedStream.closed || !ownedStream.ready || ownedStream.readyRevision !== readyRevision || !ownedStream.consumers.has(consumer)) return;
          if (candleStreamScope() !== ownedStream.scope) {
            retire(key, ownedStream);
            return;
          }
          try {
            consumer.onConnected?.();
          } catch (error) {
            try {
              consumer.onError?.(error instanceof Error ? error : new Error('Candle listener failed'));
            } catch {
              // Keep sibling consumers isolated.
            }
          }
        });
      }
    }

    const ownedStream = stream;
    return {
      close: () => {
        if (!ownedStream.consumers.delete(consumer)) return;
        if (ownedStream.consumers.size > 0) return;
        void Promise.resolve().then(() => {
          if (ownedStream.consumers.size === 0) retire(key, ownedStream);
        });
      },
    };
  }

  private createCandleStream(
    options: CandleStreamOptions,
    isScopeCurrent: () => boolean,
    onDisconnected: () => void,
  ): CandleStreamSubscription {
    const apiTf = this.normalizeTimeframe(options.timeframe);
    const symbol = normalizeSymbol(options.symbol);

    const attachBinaryTcpCandleStream = (): CandleStreamSubscription => {
      let binaryClosed = false;
      const unsubCandle = binaryTcpMarketStream.onCandle(symbol, (bc) => {
        if (binaryClosed) return;
        const bcTf = this.normalizeTimeframe(bc.timeframe);
        if (bcTf !== apiTf) return;
        options.onCandle?.({
          time: bc.time,
          ...(apiTf === 'D1' ? { sourceTime: bc.time } : {}),
          open: bc.open,
          high: bc.high,
          low: bc.low,
          close: bc.close,
          volume: bc.volume,
          tickVolume: bc.tickVolume,
          closed: bc.closed,
        });
      });

      const unsubState = binaryTcpMarketStream.onStateChange((connected) => {
        if (!binaryClosed) {
          if (connected) {
            options.onConnected?.();
          } else {
            onDisconnected();
          }
        }
      });

      return {
        close: () => {
          binaryClosed = true;
          unsubCandle();
          unsubState();
        },
      };
    };

    // ── PURE BINARY TCP LIVE CANDLE STREAM (ZERO WEBSOCKET, ZERO JSON) ───────
    if (isDesktopBackendTarget()) {
      return attachBinaryTcpCandleStream();
    }

    // ── Web Browser Fallback (STRICTLY NON-DESKTOP ONLY) ─────────────────────
    const allowPublicPollingFallback = !getAuthToken() && !isDesktopBackendTarget();
    const channel = `candles.${symbol}.${apiTf}`;
    const deploymentIdentity = candleDeploymentIdentity();
    let socketToken: string | null = null;
    let closed = false;
    let lateBinarySubscription: CandleStreamSubscription | null = null;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let subscriptionAckTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;
    let subscriptionAttempts = 0;
    let subscriptionReady = false;
    let reconnectAttempts = 0;
    let reconnectPendingWhileSuspended = false;
    let publicPollingFallbackActive = false;
    let publicPollingController: AbortController | null = null;
    let publicPollingTimer: ReturnType<typeof setTimeout> | null = null;

    const isDocumentHidden = () => (
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
    );
    const isRuntimeSuspended = () => (
      isDocumentHidden()
      || (typeof navigator !== 'undefined' && navigator.onLine === false)
    );

    const clearReconnectTimer = () => {
      if (reconnectTimer === null) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };
    const clearOpenTimer = () => {
      if (openTimer === null) return;
      clearTimeout(openTimer);
      openTimer = null;
    };
    const clearSubscriptionAckTimer = () => {
      if (subscriptionAckTimer === null) return;
      clearTimeout(subscriptionAckTimer);
      subscriptionAckTimer = null;
    };
    const recordTransportActivity = () => {
      if (pongTimer === null) return;
      clearTimeout(pongTimer);
      pongTimer = null;
    };
    const clearHeartbeat = () => {
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      if (pongTimer !== null) clearTimeout(pongTimer);
      heartbeatTimer = null;
      pongTimer = null;
    };
    const stopPublicPollingFallback = () => {
      publicPollingController?.abort();
      publicPollingController = null;
      if (publicPollingTimer !== null) clearTimeout(publicPollingTimer);
      publicPollingTimer = null;
      publicPollingFallbackActive = false;
    };

    const switchToDesktopBinaryStream = (): boolean => {
      if (!isDesktopBackendTarget()) return false;
      clearReconnectTimer();
      clearOpenTimer();
      clearSubscriptionAckTimer();
      clearHeartbeat();
      stopPublicPollingFallback();
      const socket = ws;
      ws = null;
      try { socket?.close(1000, 'Desktop Binary TCP mode active'); } catch { /* ignore */ }
      if (!closed && lateBinarySubscription === null) {
        lateBinarySubscription = attachBinaryTcpCandleStream();
      }
      return true;
    };

    const retireChangedDeployment = (): boolean => {
      if (switchToDesktopBinaryStream()) return true;
      if (deploymentIdentity === candleDeploymentIdentity() && isScopeCurrent()) return false;
      closed = true;
      clearReconnectTimer(); clearOpenTimer(); clearSubscriptionAckTimer(); clearHeartbeat();
      stopPublicPollingFallback();
      const socket = ws;
      ws = null;
      try { socket?.close(1000, 'Deployment broker changed'); } catch { /* ignore */ }
      options.onError?.(new DOMException('The deployment broker changed.', 'AbortError'));
      return true;
    };

    const startPublicPollingFallback = (): boolean => {
      if (switchToDesktopBinaryStream()) return true;
      if (retireChangedDeployment()) return false;
      if (!allowPublicPollingFallback || closed || publicPollingFallbackActive) return false;

      onDisconnected();
      publicPollingFallbackActive = true;
      clearReconnectTimer(); clearOpenTimer(); clearSubscriptionAckTimer(); clearHeartbeat();
      reconnectPendingWhileSuspended = isRuntimeSuspended();

      const socket = ws;
      ws = null;
      try { socket?.close(1000, 'Anonymous candle stream unavailable; using public REST'); } catch { /* ignore */ }

      const controller = new AbortController();
      publicPollingController = controller;
      const refresh = async () => {
        try {
          if (retireChangedDeployment()) return;
          if (document.visibilityState === 'hidden') return;
          const candles = await this.fetchCandles({
            symbol: options.symbol,
            timeframe: options.timeframe,
            count: 3,
            signal: controller.signal,
          });
          if (controller.signal.aborted || retireChangedDeployment()) return;
          options.onConnected?.();
          candles.forEach((candle) => options.onCandle?.(candle));
        } catch (error) {
          if (!controller.signal.aborted) {
            options.onError?.(error instanceof Error ? error : new Error('Public candle refresh failed'));
          }
        } finally {
          if (!controller.signal.aborted) publicPollingTimer = setTimeout(refresh, 3000);
        }
      };
      void refresh();
      return true;
    };

    const buildStreamUrl = (): { url: string; token: string | null } => {
      if (isDesktopBackendTarget()) return { url: '', token: null };
      return resolveCandleStreamEndpoint();
    };

    let connect = () => undefined;
    const scheduleReconnect = () => {
      onDisconnected();
      if (closed || lateBinarySubscription !== null || publicPollingFallbackActive || reconnectTimer !== null) return;
      if (switchToDesktopBinaryStream()) return;
      if (isRuntimeSuspended()) {
        reconnectPendingWhileSuspended = true;
        return;
      }
      const delay = Math.min(
        CANDLE_STREAM_BASE_RECONNECT_DELAY_MS * Math.pow(2, Math.min(reconnectAttempts, 10)),
        CANDLE_STREAM_MAX_RECONNECT_DELAY_MS,
      );
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (switchToDesktopBinaryStream()) return;
        if (isRuntimeSuspended()) {
          reconnectPendingWhileSuspended = true;
          return;
        }
        connect();
      }, delay);
    };

    const retireStaleSocket = (socket: WebSocket): boolean => {
      if (switchToDesktopBinaryStream()) return true;
      if (closed || ws !== socket || retireChangedDeployment()) return true;
      if (isDesktopBackendTarget() || socketToken === getAuthToken()) return false;
      clearOpenTimer(); clearSubscriptionAckTimer(); clearHeartbeat();
      ws = null;
      try { socket.close(1000, 'Broker session token changed'); } catch { /* ignore */ }
      scheduleReconnect();
      return true;
    };

    const sendSubscription = (socket: WebSocket) => {
      if (retireStaleSocket(socket) || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ action: 'subscribe', channel, channels: [channel] }));
      clearSubscriptionAckTimer();
      subscriptionAckTimer = setTimeout(() => {
        subscriptionAckTimer = null;
        if (closed || ws !== socket || subscriptionReady) return;
        if (switchToDesktopBinaryStream()) return;
        if (isRuntimeSuspended()) {
          reconnectPendingWhileSuspended = true;
          return;
        }
        if (subscriptionAttempts < CANDLE_STREAM_MAX_SUBSCRIPTION_RETRIES) {
          subscriptionAttempts += 1;
          sendSubscription(socket);
          return;
        }
        if (startPublicPollingFallback()) return;
        ws = null;
        try { socket.close(4000, 'Candle subscription acknowledgement timeout'); } catch { /* ignore */ }
        scheduleReconnect();
      }, CANDLE_STREAM_SUBSCRIPTION_ACK_TIMEOUT_MS);
    };

    const startHeartbeat = (socket: WebSocket) => {
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (retireStaleSocket(socket) || socket.readyState !== WebSocket.OPEN) return;
        if (isRuntimeSuspended()) return;
        try { socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() })); } catch { /* ignore */ }
        if (pongTimer !== null) return;
        pongTimer = setTimeout(() => {
          pongTimer = null;
          if (closed || ws !== socket) return;
          if (switchToDesktopBinaryStream()) return;
          if (isRuntimeSuspended()) {
            reconnectPendingWhileSuspended = true;
            return;
          }
          ws = null;
          clearHeartbeat();
          clearSubscriptionAckTimer();
          try { socket.close(4000, 'Candle stream heartbeat timeout'); } catch { /* ignore */ }
          scheduleReconnect();
        }, CANDLE_STREAM_PONG_TIMEOUT_MS);
      }, CANDLE_STREAM_HEARTBEAT_INTERVAL_MS);
    };

    connect = () => {
      if (closed || lateBinarySubscription !== null || publicPollingFallbackActive) return;
      if (switchToDesktopBinaryStream()) return;
      if (retireChangedDeployment()) return;
      if (isRuntimeSuspended()) {
        reconnectPendingWhileSuspended = true;
        return;
      }
      const { url, token } = buildStreamUrl();
      socketToken = token;
      if (!url) {
        if (switchToDesktopBinaryStream()) return;
        if (startPublicPollingFallback()) return;
        options.onError?.(new Error(`Candle stream URL is unavailable for ${channel}`));
        scheduleReconnect();
        return;
      }

      // Hard Desktop Binary TCP guard: NEVER instantiate WebSocket in Desktop mode
      if (isDesktopBackendTarget()) {
        switchToDesktopBinaryStream();
        return;
      }

      try {
        const socket = new WebSocket(url);
        ws = socket;
        subscriptionAttempts = 0;
        subscriptionReady = false;
        clearOpenTimer();
        openTimer = setTimeout(() => {
          openTimer = null;
          if (closed || ws !== socket || socket.readyState !== WebSocket.CONNECTING) return;
          if (switchToDesktopBinaryStream()) return;
          if (isRuntimeSuspended()) {
            reconnectPendingWhileSuspended = true;
            return;
          }
          ws = null;
          try { socket.close(4000, 'Candle stream open timeout'); } catch { /* ignore */ }
          scheduleReconnect();
        }, CANDLE_STREAM_OPEN_TIMEOUT_MS);

        socket.onopen = () => {
          if (retireStaleSocket(socket)) return;
          clearOpenTimer();
          reconnectPendingWhileSuspended = false;
          reconnectAttempts = 0;
          startHeartbeat(socket);
          if (token) socket.send(JSON.stringify({ action: 'auth', token }));
          sendSubscription(socket);
        };

        socket.onmessage = (event) => {
          if (retireStaleSocket(socket)) return;
          recordTransportActivity();
          try {
            const message = JSON.parse(event.data);
            if (String(message?.type ?? '').toLowerCase() === 'error') {
              if (startPublicPollingFallback()) return;
              return;
            }
            if (!messageMatchesCandleSubscription(message, channel, symbol, apiTf)) return;
            clearSubscriptionAckTimer();
            if (!subscriptionReady) {
              subscriptionReady = true;
              options.onConnected?.();
            }

            const snapshot = extractCandles(message);
            if (snapshot.length > 0) {
              options.onSnapshot?.(this.normalizeCandles(snapshot, apiTf));
              return;
            }

            const extractedCandle = extractCandle(message);
            const candle = this.normalizeCandle(extractedCandle, apiTf);
            if (candle) {
              const finality = readCandleFinality([
                asUnknownRecord(extractedCandle),
                asUnknownRecord(message?.data),
                asUnknownRecord(message),
              ]);
              options.onCandle?.(finality === undefined ? candle : { ...candle, closed: finality });
            }
          } catch (error) {
            options.onError?.(error instanceof Error ? error : new Error('Invalid candle stream message'));
          }
        };

        socket.onerror = () => undefined;

        socket.onclose = (event) => {
          if (ws !== socket) return;
          clearOpenTimer();
          clearSubscriptionAckTimer();
          clearHeartbeat();
          ws = null;
          if (closed || switchToDesktopBinaryStream()) return;
          if (CANDLE_STREAM_AUTH_CLOSE_CODES.has(event.code) && startPublicPollingFallback()) return;
          if (CANDLE_STREAM_AUTH_CLOSE_CODES.has(event.code)) {
            options.onError?.(new Error(`Candle stream authorization failed for ${channel}`));
            return;
          }
          scheduleReconnect();
        };
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error('Failed to open candle stream'));
        scheduleReconnect();
      }
    };

    const refreshConnection = (reason: string) => {
      if (closed) return;
      onDisconnected();
      clearReconnectTimer();
      clearOpenTimer();
      clearSubscriptionAckTimer();
      clearHeartbeat();
      stopPublicPollingFallback();
      const socket = ws;
      ws = null;
      try { socket?.close(1000, reason); } catch { /* ignore */ }
      reconnectPendingWhileSuspended = false;
      connect();
    };
    const refreshCandleStream = (): void => {
      refreshConnection('Manual connection refresh');
    };
    this.candleStreamRefreshers.add(refreshCandleStream);

    const handleOnline = () => {
      if (closed) return;
      if (isDocumentHidden()) {
        reconnectPendingWhileSuspended = true;
        return;
      }
      refreshConnection('Network restored; refreshing candle stream');
    };
    const handleOffline = () => {
      onDisconnected();
      clearReconnectTimer();
      clearOpenTimer();
      clearSubscriptionAckTimer();
      clearHeartbeat();
      stopPublicPollingFallback();
      reconnectPendingWhileSuspended = true;
    };
    const handleVisibilityChange = () => {
      if (isDocumentHidden()) {
        onDisconnected();
        clearReconnectTimer();
        clearOpenTimer();
        clearSubscriptionAckTimer();
        clearHeartbeat();
        stopPublicPollingFallback();
        reconnectPendingWhileSuspended = true;
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (reconnectPendingWhileSuspended || ws?.readyState === WebSocket.OPEN) {
        refreshConnection('Foreground restored; refreshing candle stream');
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    connect();

    return {
      close: () => {
        this.candleStreamRefreshers.delete(refreshCandleStream);
        closed = true;
        lateBinarySubscription?.close();
        lateBinarySubscription = null;
        clearReconnectTimer();
        clearOpenTimer();
        clearSubscriptionAckTimer();
        clearHeartbeat();
        stopPublicPollingFallback();
        if (typeof window !== 'undefined') {
          window.removeEventListener('online', handleOnline);
          window.removeEventListener('offline', handleOffline);
          document.removeEventListener('visibilitychange', handleVisibilityChange);
        }
        const socket = ws;
        ws = null;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ action: 'unsubscribe', channel, channels: [channel] }));
        }
        socket?.close(1000, 'Chart candle subscription closed');
      },
    };
  }

  aggregateToOHLC(ticks: TickData[], timeframe: Timeframe): OHLCData[] {
    if (ticks.length === 0) return [];
    const intervalMs = this.getIntervalMs(timeframe);
    const candles = new Map<number, OHLCData>();
    const sortedTicks = [...ticks].sort((a, b) => a.timestamp - b.timestamp);

    for (const tick of sortedTicks) {
      const candleTime = Math.floor(tick.timestamp / intervalMs) * intervalMs;
      const price = getChartPriceFromQuote(tick);
      if (price === null) continue;

      if (!candles.has(candleTime)) {
        const opened = repairPriceCandle({
          time: candleTime,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: tick.volume || 0,
          tickVolume: tick.volume || 0,
        });
        if (opened) candles.set(candleTime, opened);
      } else {
        const candle = candles.get(candleTime)!;
        candle.high = Math.max(candle.high, price);
        candle.low = Math.min(candle.low, price);
        candle.close = price;
        candle.volume += tick.volume || 0;
        candle.tickVolume = (candle.tickVolume ?? 0) + (tick.volume || 0);
        const repaired = repairPriceCandle(candle);
        if (repaired) {
          candle.high = repaired.high;
          candle.low = repaired.low;
          candle.open = repaired.open;
          candle.close = repaired.close;
        }
      }
    }

    return Array.from(candles.values()).sort((a, b) => a.time - b.time);
  }

  calculateHeikinAshi(ohlc: OHLCData[]): OHLCData[] {
    if (ohlc.length === 0) return [];
    const haCandles: OHLCData[] = [];
    let prevHA: OHLCData | null = null;

    for (const candle of ohlc) {
      const haClose = (candle.open + candle.high + candle.low + candle.close) / 4;
      const haOpen = prevHA
        ? (prevHA.open + prevHA.close) / 2
        : (candle.open + candle.close) / 2;
      const haHigh = Math.max(candle.high, haOpen, haClose);
      const haLow = Math.min(candle.low, haOpen, haClose);

      const haCandle: OHLCData = {
        time: candle.time,
        open: haOpen,
        high: haHigh,
        low: haLow,
        close: haClose,
        volume: candle.volume,
      };
      haCandles.push(haCandle);
      prevHA = haCandle;
    }

    return haCandles;
  }

  resampleOHLC(ohlc: OHLCData[], targetTimeframe: Timeframe): OHLCData[] {
    if (ohlc.length === 0) return [];
    const intervalMs = this.getIntervalMs(targetTimeframe);
    const resampled = new Map<number, OHLCData>();

    for (const candle of ohlc) {
      const targetTime = Math.floor(candle.time / intervalMs) * intervalMs;
      if (!resampled.has(targetTime)) {
        resampled.set(targetTime, {
          time: targetTime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        });
      } else {
        const existing = resampled.get(targetTime)!;
        existing.high = Math.max(existing.high, candle.high);
        existing.low = Math.min(existing.low, candle.low);
        existing.close = candle.close;
        existing.volume += candle.volume;
      }
    }

    return Array.from(resampled.values()).sort((a, b) => a.time - b.time);
  }

  mergeHistoricalAndLive(historical: TickData[], live: TickData[]): TickData[] {
    if (historical.length === 0) return live;
    if (live.length === 0) return historical;
    const lastHistoricalTime = Math.max(...historical.map((t) => t.timestamp));
    const newLiveTicks = live.filter((t) => t.timestamp > lastHistoricalTime);
    return [...historical, ...newLiveTicks].sort((a, b) => a.timestamp - b.timestamp);
  }

  private getIntervalMs(timeframe: Timeframe): number {
    const intervals: Record<Timeframe, number> = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '30m': 30 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
    };
    return intervals[timeframe];
  }
}

export const chartDataService = new ChartDataService();

