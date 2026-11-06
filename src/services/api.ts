/**
 * Comprehensive API Service Layer
 * Centralized API communication with type safety and error handling
 * Includes authentication with JWT token management and 401 handling
 */

import { resolveTickFromLookup, useAppStore } from '../store/useAppStore';
import { readBackendNumber } from './backendAccountMetrics';
import { normalizeBrokerOperationalConfig } from './brokerOperationalConfig';
import { API_V2_BASE_URL, normalizeBrokerServerUrl } from '../config/api';
import {
  getRuntimeConfiguredBrokerId,
  getRuntimeBrokerConfiguration,
  isConfiguredBrokerEndpoint,
  isDesktopBackendTarget,
  normalizeBrokerInfoForTarget,
  resolveBrokerBackendUrl,
  resolveBrokerExtApiUrl,
} from '../config/backendTarget.js';

// ============================================
// API Response Types
// ============================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface BrokerConfig {
  brokerName: string;
  logo_url?: string;
  priceFeedLP: string;
  executionMode: 'ABOOK' | 'BBOOK';
  defaultLeverage: number;
  defaultBalance: number;
  marginMode: 'HEDGING' | 'NETTING';
  maxTicksPerSymbol: number;
  disabledSymbols?: Record<string, boolean>;
}

export interface Symbol {
  symbol: string;
  displayName: string;
  category: string;
  enabled: boolean;
  contractSize: number;
  pipValue: number;
  minVolume: number;
  maxVolume: number;
  stepVolume: number;
  spread?: number;
}

export interface LPStatus {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  connected: boolean;
  symbolCount: number;
  latency?: number;
  lastQuote?: number;
}

export interface MarginPreview {
  symbol: string;
  volume: number;
  leverage: number;
  requiredMargin: number;
  currentMargin: number;
  freeMargin: number;
  marginAfter: number;
  freeMarginAfter: number;
  marginLevel: number;
  marginLevelAfter: number;
  canTrade: boolean;
}

export interface LotCalculation {
  symbol: string;
  riskPercent: number;
  slPips: number;
  balance: number;
  recommendedLot: number;
  riskAmount: number;
  pipValue: number;
}

export interface LedgerEntry {
  id: number;
  accountId: number;
  type: string;
  amount: number;
  balance: number;
  description: string;
  timestamp: string;
  referenceId?: string;
}

export interface AdminAccount {
  id: number;
  accountNumber: string;
  username: string;
  displayName: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  leverage: number;
  executionMode: string;
  status: string;
  createdAt: string;
}

// ============================================
// API Configuration
// ============================================

import { ApiError, apiClient, getAuthToken, type ApiRequestContext } from '../api/client';
import * as endpoints from '../api/endpoints';
import type { ClosePositionRequestOptions } from '../api/trade';
import {
  createTradeOrderUuid,
  getTradeWebSocketClient,
  initializeTradeWebSocketClient,
  isTerminalTradeOrderMessage,
  isTradeOrderUuidV4,
  TradeSocketOrderRejectedError,
  TradeSocketTransportError,
  type TradeSocketOrderFilled,
} from '../api/tradeSocket';
import {
  recordTradeOrderLatency,
  toTradeOrderTraceId,
  tradeOrderNow,
  type TradeOrderLatencyTransport,
  type TradeOrderTerminalStatus,
} from './orderLatencyTelemetry';
import {
  MARKET_ORDER_PLACEMENT_STATE_EVENT,
  type MarketOrderPlacementState,
} from './marketOrderPlacementEvents';
import {
  OrderCommandTerminalError,
  pollOrderCommandUntilTerminal,
  type NormalizedOrderCommand,
  type PollOrderCommandOptions,
} from './orderCommandLifecycle';
import { getStoredBrokerServer, resolveLoginBrokerTarget } from './brokerServers';
import {
  getCommittedBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScopeKey,
  getRefreshToken,
  persistBrokerSessionDiscovery,
} from './brokerSession';
import {
  BINARY_ORDER_ACTION_CANCEL_PENDING,
  BINARY_ORDER_ACTION_CLOSE_BULK,
  BINARY_ORDER_ACTION_CLOSE_BY,
  BINARY_ORDER_ACTION_CLOSE_POSITION,
  BINARY_ORDER_ACTION_MODIFY_PENDING,
  BINARY_ORDER_ACTION_MODIFY_POSITION,
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_ACTION_PLACE_PENDING,
  BINARY_ORDER_BULK_MODE_ALL,
  BINARY_ORDER_BULK_MODE_LOSERS,
  BINARY_ORDER_BULK_MODE_WINNERS,
  BINARY_ORDER_FLAG_CLEAR_SL,
  BINARY_ORDER_FLAG_CLEAR_TP,
  BINARY_ORDER_FLAG_HAS_EXPIRATION,
  BINARY_ORDER_FLAG_HAS_PRICE,
  BINARY_ORDER_FLAG_HAS_SL,
  BINARY_ORDER_FLAG_HAS_STOP_LIMIT,
  BINARY_ORDER_FLAG_HAS_TP,
  BINARY_ORDER_FLAG_PARTIAL_CLOSE,
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
  createFastBinaryClientOrderId,
  isBinaryTcpOrderEnabled,
  sendBinaryTcpOrder,
  type BinaryOrderSubType,
  type DecodedBinaryOrderResp,
} from './binaryTcpOrderClient';


if (!isBinaryTcpOrderEnabled()) {
  initializeTradeWebSocketClient();
}

interface LoginOptions {
  baseUrl?: string;
  broker_id?: string;
  server?: string;
}

export interface ClosePositionResult {
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

const PENDING_ORDER_SUBTYPE_BY_NAME: Record<string, BinaryOrderSubType> = {
  buy_limit: BINARY_ORDER_SUBTYPE_BUY_LIMIT,
  sell_limit: BINARY_ORDER_SUBTYPE_SELL_LIMIT,
  buy_stop: BINARY_ORDER_SUBTYPE_BUY_STOP,
  sell_stop: BINARY_ORDER_SUBTYPE_SELL_STOP,
  buy_stop_limit: BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT,
  sell_stop_limit: BINARY_ORDER_SUBTYPE_SELL_STOP_LIMIT,
};

const UNIX_MS_EXPIRATION_THRESHOLD = 32_503_680_000;

const normalizeLoginOption = (value: unknown): string => String(value || '').trim();

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const formatBinaryExecTiming = (execMicros: unknown): { exec_ms: number; execMicros: number } => {
  const micros = toFiniteNumber(execMicros, 0);
  const safeMicros = micros >= 0 ? micros : 0;
  return {
    exec_ms: Number((safeMicros / 1000).toFixed(3)),
    execMicros: safeMicros,
  };
};

const toPositiveSafeLogin = (value: unknown): number | undefined => {
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

const tryResolveTradingLogin = (login?: number | string): number => {
  const explicit = toPositiveSafeLogin(login);
  if (explicit !== undefined) return explicit;
  const stateLogin = Number.parseInt(String(useAppStore.getState().accountId || ''), 10);
  if (Number.isFinite(stateLogin) && stateLogin > 0) return stateLogin;
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('rtx_saved_username') || localStorage.getItem('rtx_last_login');
    const storedLogin = Number.parseInt(String(stored || ''), 10);
    if (Number.isFinite(storedLogin) && storedLogin > 0) return storedLogin;
  }
  return 0;
};

const resolveTradingLogin = (login?: number): number => {
  const resolved = tryResolveTradingLogin(login);
  if (resolved > 0) return resolved;
  throw new Error('Missing account login for trading request');
};

const isBinaryTcpOrderError = (error: unknown): error is BinaryTcpOrderError => (
  error instanceof BinaryTcpOrderError
  || (
    Boolean(error)
    && typeof error === 'object'
    && (error as { name?: unknown }).name === 'BinaryTcpOrderError'
    && typeof (error as { status?: unknown }).status === 'number'
  )
);

const isNonRetryableBinaryTcpOrderError = (error: BinaryTcpOrderError): boolean => (
  !error.retryable
  || (error.status >= 400 && error.status < 500)
  || error.status === 500
  || error.status === 504
);

const readBinaryErrorTerminalAtMs = (error: BinaryTcpOrderError, baseStartMs?: number): number | undefined => {
  const rawCompletedAtMs = typeof error.completedAtPerfMs === 'number' && Number.isFinite(error.completedAtPerfMs)
    ? error.completedAtPerfMs
    : typeof error.response?.completedAtPerfMs === 'number' && Number.isFinite(error.response.completedAtPerfMs)
      ? error.response.completedAtPerfMs
      : undefined;
  if (rawCompletedAtMs === undefined) {
    return undefined;
  }
  if (typeof baseStartMs === 'number' && Number.isFinite(baseStartMs)) {
    const rawElapsedMs = Math.max(0.01, rawCompletedAtMs - baseStartMs);
    const rawExecMicros = typeof error.execMicros === 'number' && Number.isFinite(error.execMicros) && error.execMicros > 0
      ? error.execMicros
      : typeof error.response?.execMicros === 'number' && Number.isFinite(error.response.execMicros) && error.response.execMicros > 0
        ? error.response.execMicros
        : 0;
    const wireExecMs = rawExecMicros > 0 ? rawExecMicros / 1000 : 0;
    const effectiveTotalMs = wireExecMs > 0 ? Math.min(rawElapsedMs, wireExecMs + 0.02) : rawElapsedMs;
    return baseStartMs + effectiveTotalMs;
  }
  return rawCompletedAtMs;
};

const resolveBinaryTerminalAtMs = (
  resp: DecodedBinaryOrderResp,
  baseStartMs: number,
  settledViaPoll = false,
): number => {
  if (settledViaPoll) {
    return tradeOrderNow();
  }
  const rawElapsedMs = typeof resp.completedAtPerfMs === 'number' && Number.isFinite(resp.completedAtPerfMs)
    ? Math.max(0.01, resp.completedAtPerfMs - baseStartMs)
    : Math.max(0.01, tradeOrderNow() - baseStartMs);
  const wireExecMs = typeof resp.execMicros === 'number' && Number.isFinite(resp.execMicros) && resp.execMicros > 0
    ? resp.execMicros / 1000
    : 0;
  const effectiveTotalMs = wireExecMs > 0
    ? Math.min(rawElapsedMs, wireExecMs + 0.02)
    : rawElapsedMs;
  return baseStartMs + effectiveTotalMs;
};

const resolveActionIntentContext = (options?: { intentAtMs?: number }) => {
  const apiStartedAtMs = tradeOrderNow();
  const sessionScope = getCommittedBrokerAccountSessionScopeKey(
    getCommittedBrokerAccountSessionScope(),
  );
  const requestedIntentAtMs = Number(options?.intentAtMs);
  const intentAtMs = Number.isFinite(requestedIntentAtMs)
    && requestedIntentAtMs >= 0
    && requestedIntentAtMs <= apiStartedAtMs
    ? requestedIntentAtMs
    : apiStartedAtMs;
  return { apiStartedAtMs, intentAtMs, sessionScope };
};

const formatCompactJournalNum = (value: number | undefined): string => (
  typeof value === 'number' && Number.isFinite(value)
    ? String(Number(value.toFixed(8)))
    : ''
);

const extractTerminalErrorInfo = (error: unknown): {
  terminalStatus: TradeOrderTerminalStatus;
  errorCode?: string;
  errorMessage?: string;
} => {
  if (error instanceof OrderCommandTerminalError) {
    return {
      terminalStatus: error.status,
      ...(error.code ? { errorCode: error.code } : {}),
      ...((error.backendMessage || error.message) ? { errorMessage: error.backendMessage || error.message } : {}),
    };
  }
  if (error instanceof ApiError) {
    const record = error as unknown as { code?: unknown; backendMessage?: unknown };
    const terminalStatus: TradeOrderTerminalStatus = error.status === 504
      ? 'expired'
      : error.status >= 400 && error.status < 500
        ? 'rejected'
        : 'failed';
    const code = typeof record.code === 'string' && record.code.trim() ? record.code.trim() : undefined;
    const msg = typeof record.backendMessage === 'string' && record.backendMessage.trim()
      ? record.backendMessage.trim()
      : (error.message || undefined);
    return {
      terminalStatus,
      ...(code ? { errorCode: code } : {}),
      ...(msg ? { errorMessage: msg } : {}),
    };
  }
  const record = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; status?: unknown }
    : undefined;
  const statusNum = Number(record?.status);
  const terminalStatus: TradeOrderTerminalStatus = statusNum === 504
    ? 'expired'
    : (Number.isFinite(statusNum) && statusNum >= 400 && statusNum < 500 ? 'rejected' : 'failed');
  return {
    terminalStatus,
    ...(typeof record?.code === 'string' && record.code ? { errorCode: record.code } : {}),
    ...(typeof record?.message === 'string' && record.message ? { errorMessage: record.message } : {}),
  };
};

const toBinaryTcpApiError = (error: BinaryTcpOrderError, fallbackClientOrderId: string): ApiError => {
  const status = Number.isFinite(error.status) && error.status >= 0 ? error.status : 400;
  const code = String(error.code || '').trim();
  const message = String(error.backendMessage || error.message || code || 'Order rejected').trim();
  const clientOrderId = error.clientOrderId || fallbackClientOrderId;
  const apiError = new ApiError(status, message, {
    ...(code ? { code, error: code } : {}),
    ...(message ? { message } : {}),
    client_order_id: clientOrderId,
  });
  Object.assign(apiError, {
    ...(code ? { code } : {}),
    ...(message ? { backendMessage: message } : {}),
    clientOrderId,
    retryable: false,
    ...(status === 504 ? { code: code || 'GATEWAY_TIMEOUT', orderWasSent: true } : {}),
  });
  return apiError;
};

const normalizeCommandSnapshotForPoll = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined;
  const rawStatus = String(
    record.status ?? record.state ?? data?.status ?? data?.state ?? record.type ?? '',
  ).trim().toLowerCase();
  if (
    rawStatus === 'succeeded'
    || rawStatus === 'closed'
    || rawStatus === 'partial_closed'
    || rawStatus === 'modified'
    || rawStatus === 'cancelled'
    || rawStatus === 'canceled'
    || rawStatus === 'placed'
    || rawStatus === 'pending_placed'
  ) {
    return {
      ...record,
      status: 'filled',
      original_status: rawStatus,
    };
  }
  return raw;
};

const settleBinaryOrderCommand = async (options: {
  clientOrderId: string;
  submittedAtMs: number;
  accountLogin?: number;
  pollImmediately?: boolean;
}): Promise<NormalizedOrderCommand> => {
  const command = await pollOrderCommandUntilTerminal({
    clientOrderId: options.clientOrderId,
    initialResponse: {
      status: 'accepted',
      client_order_id: options.clientOrderId,
    },
    readStatus: async (id) => normalizeCommandSnapshotForPoll(
      await endpoints.tradingApi.getOrderCommand(
        id,
        options.accountLogin && options.accountLogin > 0
          ? { account_login: options.accountLogin }
          : undefined,
      ),
    ),
    startedAtMs: options.submittedAtMs,
    pollImmediately: options.pollImmediately ?? false,
    onPollError: (pollError) => {
      console.warn('[Trade] Binary TCP order command status read failed; retrying until execute_before:', pollError);
    },
  });
  if (command.status !== 'filled') {
    const status = command.status === 'expired' ? 504 : 409;
    const code = command.error?.code || (command.status === 'expired' ? 'ORDER_COMMAND_EXPIRED' : 'ORDER_COMMAND_REJECTED');
    const message = command.error?.message || `Order command ${command.status}`;
    const apiErr = new ApiError(status, message, {
      code,
      error: code,
      message,
      client_order_id: options.clientOrderId,
    });
    Object.assign(apiErr, {
      code,
      backendMessage: message,
      clientOrderId: options.clientOrderId,
      orderWasSent: true,
      retryable: false,
    });
    throw apiErr;
  }
  return command;
};

const mapBinaryRespToPosition = (
  resp: DecodedBinaryOrderResp,
  fallback: {
    accountLogin: number;
    symbol: string;
    side: 'buy' | 'sell';
    volume: number;
    sl: number;
    tp: number;
  },
): endpoints.Position => {
  const ticket = toFiniteNumber(
    resp.positionTicket > 0 ? resp.positionTicket : resp.orderTicket,
    0,
  );
  const resolvedVolume = resp.volume > 0 ? resp.volume : fallback.volume;
  const openPrice = toFiniteNumber(resp.fillPrice, 0);
  const resolvedSl = resp.sl > 0 ? resp.sl : fallback.sl;
  const resolvedTp = resp.tp > 0 ? resp.tp : fallback.tp;
  const resolvedSymbol = requireSymbol(resp.symbol || fallback.symbol);
  const timing = formatBinaryExecTiming(resp.execMicros);

  return {
    ...(ticket > 0 ? {
      id: String(ticket),
      ticket,
      position_id: String(ticket),
      position_ticket: ticket,
    } : {}),
    ...(resp.orderTicket > 0 ? {
      order_id: String(resp.orderTicket),
      order_ticket: resp.orderTicket,
    } : {}),
    ...(resp.dealTicket > 0 ? { deal_ticket: resp.dealTicket } : {}),
    ...(resp.clientOrderId ? { client_order_id: resp.clientOrderId } : {}),
    account_login: fallback.accountLogin,
    symbol: resolvedSymbol,
    side: fallback.side,
    quantity: resolvedVolume,
    volume: resolvedVolume,
    price: openPrice,
    fill_price: openPrice,
    open_price: openPrice,
    price_open: openPrice,
    current_price: 0,
    price_current: 0,
    hasBackendCurrentPrice: false,
    hasBackendProfit: false,
    price_sl: resolvedSl,
    price_tp: resolvedTp,
    sl: resolvedSl,
    tp: resolvedTp,
    commission: toFiniteNumber(resp.commission, 0),
    ...timing,
  } as endpoints.Position;
};

const requireSymbol = (symbol: unknown): string => {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) throw new Error('Missing symbol');
  return normalized;
};

const requireVolume = (volume: unknown): number => {
  const parsed = Number(volume);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Volume must be greater than zero');
  return parsed;
};

const requirePendingPrice = (price: unknown, label = 'Pending order price'): number => {
  const parsed = Number(price);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be greater than zero`);
  return parsed;
};

const resolveRawStopLimitPrice = (data: unknown): unknown => {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as {
    price_limit?: unknown;
    stop_limit_price?: unknown;
    stopLimitPrice?: unknown;
  };
  if (record.price_limit !== undefined) return record.price_limit;
  if (record.stop_limit_price !== undefined) return record.stop_limit_price;
  return record.stopLimitPrice;
};

const normalizePendingExpiration = (raw: unknown): number => {
  if (raw === undefined || raw === null || raw === '') return 0;
  if (typeof raw === 'boolean') throw new Error('Invalid pending order expiration');
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(raw))) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error('Invalid pending order expiration');
    }
    if (parsed === 0) return 0;
    return parsed > UNIX_MS_EXPIRATION_THRESHOLD ? Math.floor(parsed / 1000) : Math.trunc(parsed);
  }
  if (typeof raw === 'string') {
    const parsedMs = Date.parse(raw.trim());
    if (!Number.isFinite(parsedMs) || parsedMs <= 0) {
      throw new Error('Invalid pending order expiration');
    }
    return Math.floor(parsedMs / 1000);
  }
  throw new Error('Invalid pending order expiration');
};

const isClearingStopValue = (raw: unknown): boolean => (
  raw === null
  || raw === ''
  || (typeof raw !== 'boolean' && Number(raw) === 0)
);

const hasNonZeroOptionalNumeric = (raw: unknown): boolean => (
  raw !== undefined
  && raw !== null
  && raw !== ''
  && Number(raw) !== 0
);

const normalizeMarketProtection = (value: unknown, label: 'SL' | 'TP'): number => {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be zero (disabled) or a positive finite number`);
  }
  return value;
};

const normalizeSideForApi = (side: unknown): 'buy' | 'sell' => {
  const normalized = String(side || '').trim().toLowerCase();
  if (normalized !== 'buy' && normalized !== 'sell') throw new Error('Side must be buy or sell');
  return normalized;
};

const isRetryableTradeSocketFailure = (error: unknown): boolean => {
  if (error instanceof TradeSocketOrderRejectedError) return false;
  if (error instanceof TradeSocketTransportError) return error.retryable;
  if (!error || typeof error !== 'object') return false;

  const candidate = error as {
    name?: unknown;
    retryable?: unknown;
    orderWasSent?: unknown;
  };
  return candidate.name !== 'TradeSocketOrderRejectedError'
    && candidate.retryable === true
    && candidate.orderWasSent === false;
};

const pickPositiveFiniteNumber = (...values: unknown[]): number => {
  for (const value of values) {
    const parsed = toFiniteNumber(value, 0);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
};

const mapFilledOrderToPosition = (
  response: TradeSocketOrderFilled,
  fallback: {
    accountLogin: number;
    symbol: string;
    side: 'buy' | 'sell';
    volume: number;
    sl: number;
    tp: number;
  },
): endpoints.Position => {
  const fill = response.data as Record<string, unknown>;
  const ticket = toFiniteNumber(
    fill.position_ticket ?? fill.ticket ?? fill.order_ticket,
    0,
  );
  const volume = toFiniteNumber(fill.volume ?? fill.quantity, fallback.volume);
  const openPrice = pickPositiveFiniteNumber(
    fill.price_open,
    fill.open_price,
    fill.openPrice,
    fill.fill_price,
    fill.price,
    fill.chartEntryPrice,
  );
  const backendCurrentPrice = readBackendNumber(fill.price_current ?? fill.current_price ?? fill.currentPrice);
  const backendProfit = readBackendNumber(fill.profit ?? fill.unrealized_pl ?? fill.unrealized_pnl ?? fill.unrealizedPnL);
  const hasBackendCurrentPrice = fill.pnl_available !== false && fill.hasBackendCurrentPrice !== false && backendCurrentPrice !== undefined;
  const hasBackendProfit = fill.pnl_available !== false && fill.hasBackendProfit !== false && backendProfit !== undefined;
  const currentPrice = hasBackendCurrentPrice ? backendCurrentPrice : 0;

  return {
    ...fill,
    ...(ticket > 0 ? { id: String(ticket), ticket } : {}),
    account_login: toFiniteNumber(fill.account_login, fallback.accountLogin),
    symbol: requireSymbol(fill.symbol ?? fallback.symbol),
    side: normalizeSideForApi(fill.side ?? fallback.side),
    quantity: volume,
    volume,
    open_price: openPrice,
    price_open: openPrice,
    current_price: currentPrice,
    price_current: currentPrice,
    hasBackendCurrentPrice,
    hasBackendProfit,
    price_sl: toFiniteNumber(fill.price_sl ?? fill.sl, fallback.sl),
    price_tp: toFiniteNumber(fill.price_tp ?? fill.tp, fallback.tp),
    sl: toFiniteNumber(fill.sl ?? fill.price_sl, fallback.sl),
    tp: toFiniteNumber(fill.tp ?? fill.price_tp, fallback.tp),
    commission: toFiniteNumber(fill.commission, 0),
  } as endpoints.Position;
};

const readOrderPositionTicket = (value: unknown): number => {
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  return toFiniteNumber(
    record.position_ticket ?? record.position_id ?? record.ticket ?? record.order_ticket ?? record.id,
    0,
  );
};

const readLegacyRestPosition = (response: unknown): endpoints.Position | null => {
  if (!response || typeof response !== 'object') return null;
  const record = response as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined;
  const status = String(record.status ?? record.state ?? data?.status ?? data?.state ?? '').trim().toLowerCase();
  if (['accepted', 'processing', 'queued', 'executing', 'rejected', 'expired'].includes(status)) return null;
  const candidate = data?.position && typeof data.position === 'object'
    ? data.position
    : record.position && typeof record.position === 'object'
      ? record.position
      : response;
  return readOrderPositionTicket(candidate) > 0 ? candidate as endpoints.Position : null;
};

const mapRestCommandToPosition = (
  command: NormalizedOrderCommand,
  fallback: {
    accountLogin: number;
    symbol: string;
    side: 'buy' | 'sell';
    volume: number;
    sl: number;
    tp: number;
  },
): endpoints.Position => {
  const fill = command.position;
  if (!fill || readOrderPositionTicket(fill) <= 0) {
    throw new Error('Order command reported filled without a position ticket');
  }
  return mapFilledOrderToPosition({
    type: 'order_filled',
    status: 'filled',
    success: true,
    request_id: command.clientOrderId || '',
    client_order_id: command.clientOrderId || '',
    data: fill as TradeSocketOrderFilled['data'],
  }, fallback);
};

const timestampToIso = (value: unknown): string => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n > 1_000_000_000_000 ? n : n * 1000).toISOString();
};

const unwrapList = <T,>(payload: T[] | { positions?: T[]; orders?: T[]; count?: number } | undefined, key: 'positions' | 'orders'): T[] => {
  if (Array.isArray(payload)) return payload;
  const list = payload?.[key];
  return Array.isArray(list) ? list : [];
};

type LooseRecord = Record<string, unknown>;

type NormalizedGatewayPosition = LooseRecord & {
  id: number;
  ticket: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: number;
  quantity: number;
  openPrice: number;
  open_price: number;
  currentPrice: number;
  current_price: number;
  opened_at: string;
  sl: number;
  tp: number;
  swap: number;
  commission: number;
  unrealizedPnL: number;
  unrealized_pl: number;
};

type NormalizedGatewayOrder = LooseRecord & {
  id: string;
  ticket: number;
  symbol: string;
  type: string;
  side: 'BUY' | 'SELL';
  volume: number;
  quantity: number;
  price: number;
  sl: number;
  tp: number;
  status: string;
  created_at: unknown;
  createdAt: unknown;
};

type ExportRow = Record<string, unknown>;

const normalizeGatewayPositionForApp = (raw: LooseRecord, index = 0): NormalizedGatewayPosition => {
  const ticket = toFiniteNumber(raw?.ticket ?? raw?.id, index + 1);
  const openPrice = toFiniteNumber(raw?.price_open ?? raw?.open_price ?? raw?.openPrice ?? raw?.price, 0);
  const backendCurrentPrice = readBackendNumber(raw?.price_current ?? raw?.current_price ?? raw?.currentPrice);
  const backendProfit = readBackendNumber(raw?.profit ?? raw?.unrealized_pl ?? raw?.unrealized_pnl ?? raw?.unrealizedPnL);
  const hasBackendCurrentPrice = raw.pnl_available !== false && raw.hasBackendCurrentPrice !== false && backendCurrentPrice !== undefined;
  const hasBackendProfit = raw.pnl_available !== false && raw.hasBackendProfit !== false && backendProfit !== undefined;
  const currentPrice = hasBackendCurrentPrice ? backendCurrentPrice : 0;
  const side = String(raw?.side ?? '').toLowerCase() === 'sell' ? 'SELL' : 'BUY';
  const unrealizedPnL = hasBackendProfit ? backendProfit : 0;

  return {
    ...raw,
    id: ticket,
    ticket,
    symbol: requireSymbol(raw?.symbol),
    side,
    volume: toFiniteNumber(raw?.volume ?? raw?.quantity, 0),
    quantity: toFiniteNumber(raw?.volume ?? raw?.quantity, 0),
    openPrice,
    open_price: openPrice,
    currentPrice,
    current_price: currentPrice,
    hasBackendCurrentPrice,
    hasBackendProfit,
    opened_at: typeof raw?.opened_at === 'string' ? raw.opened_at : timestampToIso(raw?.time_create),
    sl: toFiniteNumber(raw?.price_sl ?? raw?.sl, 0),
    tp: toFiniteNumber(raw?.price_tp ?? raw?.tp, 0),
    swap: toFiniteNumber(raw?.swap, 0),
    commission: toFiniteNumber(raw?.commission, 0),
    unrealizedPnL,
    unrealized_pl: unrealizedPnL,
  };
};

const normalizeGatewayOrderForApp = (raw: LooseRecord, index = 0): NormalizedGatewayOrder => {
  const ticket = toFiniteNumber(raw?.ticket ?? raw?.id, index + 1);
  const type = String(raw?.type || '').toUpperCase();
  const side = String(raw?.side ?? '').toLowerCase() === 'sell' || type.includes('SELL') ? 'SELL' : 'BUY';

  return {
    ...raw,
    id: String(ticket),
    ticket,
    symbol: requireSymbol(raw?.symbol),
    type,
    side,
    volume: toFiniteNumber(raw?.volume ?? raw?.quantity, 0),
    quantity: toFiniteNumber(raw?.volume ?? raw?.quantity, 0),
    price: toFiniteNumber(raw?.price, 0),
    sl: toFiniteNumber(raw?.price_sl ?? raw?.sl, 0),
    tp: toFiniteNumber(raw?.price_tp ?? raw?.tp, 0),
    status: String(raw?.status || 'pending').toUpperCase(),
    created_at: raw?.created_at ?? timestampToIso(raw?.time_create),
    createdAt: raw?.createdAt ?? raw?.created_at ?? timestampToIso(raw?.time_create),
  };
};

// ============================================
// HTTP Client with Error Handling
// ============================================

// ============================================
// Authentication API
// ============================================

export const authApi = {
  async login(username: string, password: string, options?: string | LoginOptions): Promise<endpoints.LoginResponse> {
    const loginOptions = typeof options === 'string' ? { baseUrl: options } : options;
    const storedBrokerId = typeof window !== 'undefined'
      ? normalizeLoginOption(localStorage.getItem('rtx_broker_id') || localStorage.getItem('broker_id'))
      : '';
    const explicitBrokerId = normalizeLoginOption(loginOptions?.broker_id);
    const explicitServer = normalizeLoginOption(loginOptions?.server);
    const storedTarget = resolveLoginBrokerTarget(getStoredBrokerServer());
    const resolvedExplicitServer = explicitServer ? resolveLoginBrokerTarget(explicitServer) : undefined;
    const loginTarget = {
      displayValue: resolvedExplicitServer?.displayValue || explicitBrokerId || storedTarget.displayValue,
      broker_id: explicitBrokerId || resolvedExplicitServer?.broker_id || storedTarget.broker_id || storedBrokerId || getRuntimeConfiguredBrokerId(),
      server: resolvedExplicitServer?.server || storedTarget.server,
    };
    if (!isDesktopBackendTarget()) {
      const deployment = getRuntimeBrokerConfiguration();
      if (!deployment.valid) throw new Error(`Broker configuration error: ${deployment.errors.join('; ')}`);
      if (explicitBrokerId && explicitBrokerId !== deployment.brokerId) {
        throw new Error('The selected broker does not match this deployment.');
      }
      loginTarget.broker_id = deployment.brokerId;
    }
    const targetBroker = normalizeBrokerInfoForTarget({
      broker_id: loginTarget.broker_id,
      broker_name: loginTarget.displayValue,
      server_url: normalizeLoginOption(loginOptions?.baseUrl) || loginTarget.server || loginTarget.displayValue,
    });
    const normalizedUsername = normalizeLoginOption(username);
    const loginBaseUrl = resolveBrokerExtApiUrl(targetBroker);
    const result = await endpoints.authApi.login(
      { username: normalizedUsername, password, ...(loginTarget.broker_id ? { broker_id: loginTarget.broker_id } : {}) },
      loginBaseUrl ? { baseUrl: normalizeBrokerServerUrl(loginBaseUrl) } : undefined
    );
    const accessToken = result.token || result.access_token;
    const resolvedBrokerId = result.broker_id || loginTarget.broker_id;
    const resolvedBrokerServer = result.server_url || result.backend_url || resolveBrokerBackendUrl(targetBroker) || result.broker_server || loginTarget.displayValue;
    if (!isDesktopBackendTarget() && (resolvedBrokerId !== getRuntimeConfiguredBrokerId()
      || !isConfiguredBrokerEndpoint(resolvedBrokerServer, 'http'))) {
      throw new Error('The login response does not belong to the configured deployment broker.');
    }

    if (typeof window !== 'undefined') {
      persistBrokerSessionDiscovery({
        ...result,
        access_token: accessToken,
        broker_id: resolvedBrokerId,
        server_url: resolvedBrokerServer,
        backend_url: result.backend_url || resolvedBrokerServer,
        market_api_url: result.market_api_url || loginBaseUrl,
      });
    }
    // Bind the broker routing before token events can start account transports.
    if (accessToken) {
      useAppStore.getState().setAuthTokens(
        accessToken,
        result.refresh_token,
        result.expires_at ? new Date(result.expires_at).getTime() : undefined
      );
    }

    return { ...result, access_token: accessToken, broker_id: resolvedBrokerId, broker_server: resolvedBrokerServer };
  },

  async refresh(refreshToken: string): Promise<endpoints.LoginResponse> {
    const brokerId = getRuntimeBrokerConfiguration().brokerId;
    const result = await endpoints.authApi.refresh(refreshToken);
    if (!isDesktopBackendTarget() && (getRefreshToken() !== refreshToken
      || getRuntimeBrokerConfiguration().brokerId !== brokerId
      || (result.broker_id && String(result.broker_id) !== brokerId))) {
      throw new Error('The deployment broker session changed during token refresh.');
    }
    const accessToken = result.token || result.access_token;
    if (accessToken) {
      useAppStore.getState().setAuthTokens(
        accessToken,
        result.refresh_token,
        result.expires_at ? new Date(result.expires_at).getTime() : undefined
      );
    }
    return { ...result, access_token: accessToken };
  },

  logout(): void {
    useAppStore.getState().logout();
    endpoints.authApi.logout().catch(console.error);
  },
};

// ============================================
// Account API
// ============================================

export const accountApi = {
  async getAccountSummary(login?: number): Promise<endpoints.AccountSummary> {
    return endpoints.accountApi.getSummary(login);
  },

  async getAccountMetrics(login?: number): Promise<endpoints.AccountSummary> {
    return endpoints.accountApi.getMetrics(login);
  },
};

// ============================================
// Positions API
// ============================================

export const positionsApi = {
  async getPositions(login?: number): Promise<endpoints.Position[]> {
    const response = await endpoints.tradingApi.getPositions(resolveTradingLogin(login));
    return unwrapList(response, 'positions')
      .map((position) => normalizeGatewayPositionForApp(position as unknown as LooseRecord)) as unknown as endpoints.Position[];
  },

  async closePosition(
    positionId: string | number,
    volumeOrOptions?: ClosePositionRequestOptions | number,
    maybeOptions?: ClosePositionRequestOptions,
  ): Promise<ClosePositionResult | void> {
    let volumeInput: unknown;
    let opts: ClosePositionRequestOptions;
    if (typeof volumeOrOptions === 'number') {
      volumeInput = volumeOrOptions;
      opts = maybeOptions ?? {};
    } else if (volumeOrOptions !== undefined && volumeOrOptions !== null && typeof volumeOrOptions === 'object') {
      opts = volumeOrOptions;
      volumeInput = opts.volume;
    } else if (volumeOrOptions === undefined) {
      opts = maybeOptions ?? {};
      volumeInput = opts.volume;
    } else {
      throw new Error('Close volume must be a finite non-negative number');
    }

    const { intentAtMs, sessionScope } = resolveActionIntentContext(opts);

    let requestedVolume: number | undefined;
    if (volumeInput !== undefined && volumeInput !== null && volumeInput !== '') {
      const parsedVol = Number(volumeInput);
      if (!Number.isFinite(parsedVol) || parsedVol < 0) {
        throw new Error('Close volume must be a finite non-negative number');
      }
      if (parsedVol > 0) {
        requestedVolume = parsedVol;
      }
    }

    const suppliedClientOrderId = String(opts.client_order_id ?? opts.clientOrderId ?? '').trim();
    if (suppliedClientOrderId && !isTradeOrderUuidV4(suppliedClientOrderId)) {
      throw new Error('client_order_id must be a UUID v4');
    }

    if (opts.account_login !== undefined && toPositiveSafeLogin(opts.account_login) === undefined) {
      throw new Error('Invalid account identity for /api/v2/positions/{id}/close');
    }
    if (opts.accountLogin !== undefined && toPositiveSafeLogin(opts.accountLogin) === undefined) {
      throw new Error('Invalid account identity for /api/v2/positions/{id}/close');
    }
    const explicitAccountLogin = toPositiveSafeLogin(opts.account_login);
    const aliasAccountLogin = toPositiveSafeLogin(opts.accountLogin);
    if (
      explicitAccountLogin !== undefined
      && aliasAccountLogin !== undefined
      && explicitAccountLogin !== aliasAccountLogin
    ) {
      throw new Error('Conflicting account identity for /api/v2/positions/{id}/close (account_login !== accountLogin); refusing ambiguous close');
    }

    const trimmedTicket = String(positionId ?? '').trim();
    const numericTicket = typeof positionId === 'number'
      ? positionId
      : (/^\d+$/.test(trimmedTicket) ? Number(trimmedTicket) : Number.NaN);
    const hasSafeNumericTicket = Number.isSafeInteger(numericTicket)
      && numericTicket > 0
      && String(numericTicket) === trimmedTicket;

    const existingPos = hasSafeNumericTicket
      ? useAppStore.getState().positions.find(
          (p) => Number(p.id ?? (p as { ticket?: unknown }).ticket) === numericTicket,
        )
      : undefined;
    const existingPosVolume = toFiniteNumber(
      existingPos?.volume ?? (existingPos as { quantity?: unknown } | undefined)?.quantity,
      0,
    );
    const existingPosSideRaw = String(existingPos?.side ?? '').trim().toLowerCase();
    const existingPosSide: 'buy' | 'sell' | undefined = existingPosSideRaw === 'sell'
      ? 'sell'
      : (existingPosSideRaw === 'buy' ? 'buy' : undefined);
    const existingPosSymbol = typeof existingPos?.symbol === 'string'
      ? existingPos.symbol.trim().toUpperCase()
      : '';
    // Treat volume === position.volume (within floating-point lot tolerance) as a full close,
    // while volume < position.volume (or explicit partial volume when position volume is unknown)
    // sets BINARY_ORDER_FLAG_PARTIAL_CLOSE.
    const isFullVolumeMatch = requestedVolume !== undefined
      && existingPosVolume > 0
      && Math.abs(requestedVolume - existingPosVolume) <= 1e-8;
    const partialVolume = requestedVolume !== undefined && !isFullVolumeMatch
      ? requestedVolume
      : undefined;
    const isPartialClose = partialVolume !== undefined && partialVolume > 0;
    const useBinaryCloseFastPath = isBinaryTcpOrderEnabled() && hasSafeNumericTicket && !opts.signal?.aborted;
    const clientOrderId = suppliedClientOrderId
      || (useBinaryCloseFastPath ? createFastBinaryClientOrderId() : createTradeOrderUuid());

    if (useBinaryCloseFastPath) {
      const accountLogin = tryResolveTradingLogin(explicitAccountLogin ?? aliasAccountLogin);
      const binarySubmittedAtMs = Date.now();
      try {
        const resp = await sendBinaryTcpOrder({
          action: BINARY_ORDER_ACTION_CLOSE_POSITION,
          accountLogin,
          ticket: numericTicket,
          volume: isPartialClose ? partialVolume : 0,
          flags: isPartialClose ? BINARY_ORDER_FLAG_PARTIAL_CLOSE : 0,
          partialClose: isPartialClose,
          clientOrderId,
          authToken: opts.authToken ?? getAuthToken(),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });

        const effectiveClientOrderId = resp.clientOrderId || clientOrderId;
        const timing = formatBinaryExecTiming(resp.execMicros);
        let closedTicket = resp.positionTicket > 0 ? resp.positionTicket : numericTicket;
        let dealTicket = resp.dealTicket;
        let orderTicket = resp.orderTicket;
        let closePrice = resp.fillPrice;
        let profit = resp.profit;
        let commission = resp.commission;
        let closedVolume = resp.volume > 0 ? resp.volume : (partialVolume ?? existingPosVolume);
        let resolvedSymbol = resp.symbol || existingPosSymbol;

        if (resp.status === 202) {
          const settled = await settleBinaryOrderCommand({
            clientOrderId: effectiveClientOrderId,
            submittedAtMs: binarySubmittedAtMs,
            accountLogin,
          });
          const settledData = (settled.position ?? {}) as Record<string, unknown>;
          closedTicket = toFiniteNumber(
            settledData.position_ticket ?? settledData.position_id ?? settledData.ticket,
            closedTicket,
          );
          dealTicket = toFiniteNumber(
            settledData.deal_ticket ?? settledData.closing_deal_ticket,
            dealTicket,
          );
          orderTicket = toFiniteNumber(settledData.order_ticket, orderTicket);
          closePrice = toFiniteNumber(
            settledData.close_price ?? settledData.price_close ?? settledData.fill_price ?? settledData.price,
            closePrice,
          );
          profit = toFiniteNumber(settledData.profit ?? settledData.realized_profit, profit);
          commission = toFiniteNumber(settledData.commission, commission);
          closedVolume = toFiniteNumber(
            settledData.closed_volume ?? settledData.volume_closed ?? settledData.volume,
            closedVolume,
          );
          const settledSym = String(settledData.symbol ?? '').trim().toUpperCase();
          if (settledSym) resolvedSymbol = settledSym;
        }

        const terminalAtMs = resolveBinaryTerminalAtMs(resp, intentAtMs, resp.status === 202);
        const closeSubject = [
          `#${closedTicket}`,
          existingPosSide,
          resolvedSymbol,
          closedVolume > 0 ? formatCompactJournalNum(closedVolume) : '',
          closePrice > 0 ? `@ ${formatCompactJournalNum(closePrice)}` : '',
        ].filter(Boolean).join(' ');
        recordTradeOrderLatency({
          phase: 'placement_terminal',
          transport: 'websocket',
          traceId: toTradeOrderTraceId(effectiveClientOrderId),
          clientOrderId: effectiveClientOrderId,
          sessionScope,
          ticket: closedTicket,
          ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
          ...(existingPosSide ? { side: existingPosSide } : {}),
          ...(closedVolume > 0 ? { volume: closedVolume } : {}),
          ...(closePrice > 0 ? { price: closePrice } : {}),
          operationLabel: isPartialClose ? 'Position partially closed' : 'Position closed',
          journalMessage: `${isPartialClose ? 'Position partially closed' : 'Position closed'} ${closeSubject}`.trim(),
          terminalStatus: 'filled',
          totalMs: Math.max(0, terminalAtMs - intentAtMs),
        });

        const closeResult: ClosePositionResult = {
          ticket: closedTicket,
          position_id: String(closedTicket),
          position_ticket: closedTicket,
          deal_ticket: dealTicket,
          order_ticket: orderTicket,
          ...(orderTicket > 0 ? { order_id: String(orderTicket) } : {}),
          price: closePrice,
          fill_price: closePrice,
          close_price: closePrice,
          profit,
          commission,
          closed_volume: closedVolume,
          volume: closedVolume,
          symbol: resolvedSymbol,
          client_order_id: effectiveClientOrderId,
          ...timing,
          status: isPartialClose ? 'partial_closed' : 'closed',
        };
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('rtx:position-closed', {
            detail: {
              ...closeResult,
              login: accountLogin,
            },
          }));
        }
        return closeResult;
      } catch (err) {
        if (isBinaryTcpOrderError(err)) {
          if (isNonRetryableBinaryTcpOrderError(err)) {
            const effectiveClientOrderId = err.clientOrderId || clientOrderId;
            const terminalAtMs = readBinaryErrorTerminalAtMs(err, intentAtMs) ?? tradeOrderNow();
            const terminalStatus: TradeOrderTerminalStatus = err.status === 504 ? 'expired' : 'rejected';
            recordTradeOrderLatency({
              phase: 'placement_terminal',
              transport: 'websocket',
              traceId: toTradeOrderTraceId(effectiveClientOrderId),
              clientOrderId: effectiveClientOrderId,
              sessionScope,
              ticket: numericTicket,
              ...(existingPosSymbol ? { symbol: existingPosSymbol } : {}),
              ...(existingPosSide ? { side: existingPosSide } : {}),
              ...((partialVolume ?? existingPosVolume) > 0 ? { volume: partialVolume ?? existingPosVolume } : {}),
              operationLabel: `Position close ${terminalStatus}`,
              journalMessage: `Position close ${terminalStatus} #${numericTicket}${existingPosSymbol ? ` ${existingPosSymbol}` : ''}`,
              terminalStatus,
              ...(err.code ? { errorCode: err.code } : {}),
              ...((err.backendMessage || err.message) ? { errorMessage: err.backendMessage || err.message } : {}),
              totalMs: Math.max(0, terminalAtMs - intentAtMs),
            });
            throw toBinaryTcpApiError(err, clientOrderId);
          }
        } else {
          throw err;
        }
      }
    }

    const fallbackClientOrderId = isTradeOrderUuidV4(clientOrderId)
      ? clientOrderId
      : createTradeOrderUuid();
    const fallbackOptions: ClosePositionRequestOptions = {
      ...opts,
      ...(partialVolume !== undefined ? { volume: partialVolume } : {}),
      client_order_id: fallbackClientOrderId,
    };
    try {
      await endpoints.tradingApi.closePosition(positionId, fallbackOptions);
      const terminalAtMs = tradeOrderNow();
      const closeVolume = partialVolume ?? existingPosVolume;
      const closeSubject = [
        hasSafeNumericTicket ? `#${numericTicket}` : `#${trimmedTicket}`,
        existingPosSide,
        existingPosSymbol,
        closeVolume > 0 ? formatCompactJournalNum(closeVolume) : '',
      ].filter(Boolean).join(' ');
      recordTradeOrderLatency({
        phase: 'placement_terminal',
        transport: 'rest',
        traceId: toTradeOrderTraceId(fallbackClientOrderId),
        clientOrderId: fallbackClientOrderId,
        sessionScope,
        ...(hasSafeNumericTicket ? { ticket: numericTicket } : {}),
        ...(existingPosSymbol ? { symbol: existingPosSymbol } : {}),
        ...(existingPosSide ? { side: existingPosSide } : {}),
        ...(closeVolume > 0 ? { volume: closeVolume } : {}),
        operationLabel: isPartialClose ? 'Position partially closed' : 'Position closed',
        journalMessage: `${isPartialClose ? 'Position partially closed' : 'Position closed'} ${closeSubject}`.trim(),
        terminalStatus: 'filled',
        totalMs: Math.max(0, terminalAtMs - intentAtMs),
      });
    } catch (error) {
      const terminalAtMs = tradeOrderNow();
      const { terminalStatus, errorCode, errorMessage } = extractTerminalErrorInfo(error);
      recordTradeOrderLatency({
        phase: 'placement_terminal',
        transport: 'rest',
        traceId: toTradeOrderTraceId(fallbackClientOrderId),
        clientOrderId: fallbackClientOrderId,
        sessionScope,
        ...(hasSafeNumericTicket ? { ticket: numericTicket } : {}),
        ...(existingPosSymbol ? { symbol: existingPosSymbol } : {}),
        ...(existingPosSide ? { side: existingPosSide } : {}),
        operationLabel: `Position close ${terminalStatus}`,
        journalMessage: `Position close ${terminalStatus} #${hasSafeNumericTicket ? numericTicket : trimmedTicket}${existingPosSymbol ? ` ${existingPosSymbol}` : ''}`,
        terminalStatus,
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        totalMs: Math.max(0, terminalAtMs - intentAtMs),
      });
      throw error;
    }
  },

  async modifyPosition(
    positionId: string | number,
    dataOrSl: endpoints.ModifyPositionRequest | number | null | undefined,
    tpOrOptions?: number | null | MarketOrderPlacementOptions,
    maybeOptions?: MarketOrderPlacementOptions,
  ): Promise<endpoints.Position> {
    let data: endpoints.ModifyPositionRequest;
    let options: MarketOrderPlacementOptions | undefined;
    if (dataOrSl !== null && dataOrSl !== undefined && typeof dataOrSl === 'object') {
      data = dataOrSl;
      options = (tpOrOptions && typeof tpOrOptions === 'object')
        ? tpOrOptions
        : maybeOptions;
    } else {
      const numericSl = typeof dataOrSl === 'number' ? dataOrSl : dataOrSl === null ? 0 : undefined;
      const numericTp = typeof tpOrOptions === 'number' ? tpOrOptions : tpOrOptions === null ? 0 : undefined;
      data = {
        ...(numericSl !== undefined ? { price_sl: numericSl } : {}),
        ...(numericTp !== undefined ? { price_tp: numericTp } : {}),
      };
      options = (tpOrOptions && typeof tpOrOptions === 'object')
        ? tpOrOptions
        : maybeOptions;
    }

    const { intentAtMs, sessionScope } = resolveActionIntentContext(options);
    const ticket = Number.parseInt(String(positionId), 10);
    if (!Number.isFinite(ticket) || ticket <= 0) throw new Error('Invalid position ticket');

    const extendedData = data as endpoints.ModifyPositionRequest & {
      sl?: number | null;
      tp?: number | null;
    };
    const rawSl = data.price_sl !== undefined ? data.price_sl : extendedData.sl;
    const rawTp = data.price_tp !== undefined ? data.price_tp : extendedData.tp;

    const existingPosition = useAppStore.getState().positions.find(
      (p) => Number(p.id ?? (p as { ticket?: unknown }).ticket) === ticket,
    );
    const existingSymbol = typeof existingPosition?.symbol === 'string'
      ? existingPosition.symbol.trim().toUpperCase()
      : '';
    const existingComment = String((existingPosition as { comment?: unknown } | undefined)?.comment ?? '').trim();
    const hasCommentChange = data.comment !== undefined && data.comment.trim() !== existingComment;
    const hasTrailingChanges = hasNonZeroOptionalNumeric(data.trailing_stop)
      || hasNonZeroOptionalNumeric(data.trailing_step);
    const hasSlOrTpModification = rawSl !== undefined || rawTp !== undefined;

    if (
      isBinaryTcpOrderEnabled()
      && Number.isSafeInteger(ticket)
      && !hasTrailingChanges
      && !hasCommentChange
      && hasSlOrTpModification
    ) {
      let flags = 0;
      let slParam: number | undefined;
      let tpParam: number | undefined;
      let clearSl = false;
      let clearTp = false;

      if (rawSl !== undefined) {
        if (isClearingStopValue(rawSl)) {
          flags |= BINARY_ORDER_FLAG_CLEAR_SL;
          clearSl = true;
          slParam = 0;
        } else {
          const parsedSl = Number(rawSl);
          if (!Number.isFinite(parsedSl) || parsedSl < 0) {
            throw new Error('SL must be zero (disabled) or a positive finite number');
          }
          flags |= BINARY_ORDER_FLAG_HAS_SL;
          slParam = parsedSl;
        }
      }

      if (rawTp !== undefined) {
        if (isClearingStopValue(rawTp)) {
          flags |= BINARY_ORDER_FLAG_CLEAR_TP;
          clearTp = true;
          tpParam = 0;
        } else {
          const parsedTp = Number(rawTp);
          if (!Number.isFinite(parsedTp) || parsedTp < 0) {
            throw new Error('TP must be zero (disabled) or a positive finite number');
          }
          flags |= BINARY_ORDER_FLAG_HAS_TP;
          tpParam = parsedTp;
        }
      }

      const clientOrderId = createFastBinaryClientOrderId();
      const accountLogin = tryResolveTradingLogin();
      const binarySubmittedAtMs = Date.now();
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
          authToken: getAuthToken(),
        });

        const effectiveClientOrderId = resp.clientOrderId || clientOrderId;
        const timing = formatBinaryExecTiming(resp.execMicros);
        let settledData: Record<string, unknown> | undefined;
        if (resp.status === 202) {
          const settled = await settleBinaryOrderCommand({
            clientOrderId: effectiveClientOrderId,
            submittedAtMs: binarySubmittedAtMs,
            accountLogin,
          });
          settledData = (settled.position ?? {}) as Record<string, unknown>;
        }

        const resolvedTicket = toFiniteNumber(
          settledData?.position_ticket ?? settledData?.position_id ?? settledData?.ticket,
          resp.positionTicket > 0 ? resp.positionTicket : ticket,
        );
        const existingRecord = existingPosition as unknown as LooseRecord | undefined;
        const settledSym = String(settledData?.symbol ?? '').trim().toUpperCase();
        const resolvedSymbol = settledSym
          || resp.symbol
          || existingSymbol;
        const resolvedSide: 'buy' | 'sell' = String(existingPosition?.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy';
        const resolvedVolume = toFiniteNumber(
          settledData?.volume ?? settledData?.quantity,
          resp.volume > 0 ? resp.volume : toFiniteNumber(existingPosition?.volume, 0),
        );
        const openPrice = toFiniteNumber(
          settledData?.price_open ?? settledData?.open_price ?? settledData?.price,
          resp.fillPrice > 0
            ? resp.fillPrice
            : toFiniteNumber(existingRecord?.openPrice ?? existingRecord?.open_price ?? existingRecord?.price_open, 0),
        );
        const settledSl = settledData && (settledData.sl !== undefined || settledData.price_sl !== undefined)
          ? toFiniteNumber(settledData.sl ?? settledData.price_sl, 0)
          : undefined;
        const settledTp = settledData && (settledData.tp !== undefined || settledData.price_tp !== undefined)
          ? toFiniteNumber(settledData.tp ?? settledData.price_tp, 0)
          : undefined;
        const nextSl = rawSl !== undefined
          ? (clearSl ? 0 : (settledSl !== undefined && settledSl > 0 ? settledSl : (resp.sl > 0 ? resp.sl : (slParam ?? 0))))
          : (settledSl !== undefined ? settledSl : (resp.sl > 0 ? resp.sl : toFiniteNumber(existingPosition?.sl, 0)));
        const nextTp = rawTp !== undefined
          ? (clearTp ? 0 : (settledTp !== undefined && settledTp > 0 ? settledTp : (resp.tp > 0 ? resp.tp : (tpParam ?? 0))))
          : (settledTp !== undefined ? settledTp : (resp.tp > 0 ? resp.tp : toFiniteNumber(existingPosition?.tp, 0)));

        const terminalAtMs = resolveBinaryTerminalAtMs(resp, intentAtMs, resp.status === 202);
        const protectionSummary = `SL: ${formatCompactJournalNum(nextSl) || '0'}, TP: ${formatCompactJournalNum(nextTp) || '0'}`;
        recordTradeOrderLatency({
          phase: 'placement_terminal',
          transport: 'websocket',
          traceId: toTradeOrderTraceId(effectiveClientOrderId),
          clientOrderId: effectiveClientOrderId,
          sessionScope,
          ticket: resolvedTicket,
          ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
          side: resolvedSide,
          ...(resolvedVolume > 0 ? { volume: resolvedVolume } : {}),
          operationLabel: 'Position modified',
          journalMessage: `Position modified #${resolvedTicket}${resolvedSymbol ? ` ${resolvedSymbol}` : ''} (${protectionSummary})`,
          terminalStatus: 'filled',
          totalMs: Math.max(0, terminalAtMs - intentAtMs),
        });

        return {
          id: String(resolvedTicket),
          ticket: resolvedTicket,
          position_id: String(resolvedTicket),
          position_ticket: resolvedTicket,
          client_order_id: effectiveClientOrderId,
          account_login: accountLogin || toFiniteNumber(existingRecord?.account_login, 0),
          symbol: resolvedSymbol,
          side: resolvedSide,
          quantity: resolvedVolume,
          volume: resolvedVolume,
          price: openPrice,
          fill_price: openPrice,
          open_price: openPrice,
          price_open: openPrice,
          price_sl: nextSl,
          price_tp: nextTp,
          sl: nextSl,
          tp: nextTp,
          ...timing,
        } as endpoints.Position;
      } catch (err) {
        if (isBinaryTcpOrderError(err)) {
          if (isNonRetryableBinaryTcpOrderError(err)) {
            const effectiveClientOrderId = err.clientOrderId || clientOrderId;
            const terminalAtMs = readBinaryErrorTerminalAtMs(err, intentAtMs) ?? tradeOrderNow();
            const terminalStatus: TradeOrderTerminalStatus = err.status === 504 ? 'expired' : 'rejected';
            recordTradeOrderLatency({
              phase: 'placement_terminal',
              transport: 'websocket',
              traceId: toTradeOrderTraceId(effectiveClientOrderId),
              clientOrderId: effectiveClientOrderId,
              sessionScope,
              ticket,
              ...(existingSymbol ? { symbol: existingSymbol } : {}),
              operationLabel: `Position modify ${terminalStatus}`,
              journalMessage: `Position modify ${terminalStatus} #${ticket}${existingSymbol ? ` ${existingSymbol}` : ''}`,
              terminalStatus,
              ...(err.code ? { errorCode: err.code } : {}),
              ...((err.backendMessage || err.message) ? { errorMessage: err.backendMessage || err.message } : {}),
              totalMs: Math.max(0, terminalAtMs - intentAtMs),
            });
            throw toBinaryTcpApiError(err, clientOrderId);
          }
        } else {
          throw err;
        }
      }
    }

    const restClientOrderId = createTradeOrderUuid();
    try {
      const updated = await endpoints.tradingApi.modifyPosition(ticket, {
        price_sl: rawSl ?? undefined,
        price_tp: rawTp ?? undefined,
        comment: data.comment,
        trailing_stop: data.trailing_stop,
        trailing_step: data.trailing_step,
      });
      const terminalAtMs = tradeOrderNow();
      const updatedRecord = updated as unknown as LooseRecord | undefined;
      const resolvedSymbol = String(updatedRecord?.symbol ?? existingSymbol ?? '').trim().toUpperCase();
      const nextSl = toFiniteNumber(updatedRecord?.price_sl ?? updatedRecord?.sl, toFiniteNumber(rawSl, 0));
      const nextTp = toFiniteNumber(updatedRecord?.price_tp ?? updatedRecord?.tp, toFiniteNumber(rawTp, 0));
      const protectionSummary = `SL: ${formatCompactJournalNum(nextSl) || '0'}, TP: ${formatCompactJournalNum(nextTp) || '0'}`;
      recordTradeOrderLatency({
        phase: 'placement_terminal',
        transport: 'rest',
        traceId: toTradeOrderTraceId(restClientOrderId),
        clientOrderId: restClientOrderId,
        sessionScope,
        ticket,
        ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
        operationLabel: 'Position modified',
        journalMessage: `Position modified #${ticket}${resolvedSymbol ? ` ${resolvedSymbol}` : ''} (${protectionSummary})`,
        terminalStatus: 'filled',
        totalMs: Math.max(0, terminalAtMs - intentAtMs),
      });
      return updated;
    } catch (error) {
      const terminalAtMs = tradeOrderNow();
      const { terminalStatus, errorCode, errorMessage } = extractTerminalErrorInfo(error);
      recordTradeOrderLatency({
        phase: 'placement_terminal',
        transport: 'rest',
        traceId: toTradeOrderTraceId(restClientOrderId),
        clientOrderId: restClientOrderId,
        sessionScope,
        ticket,
        ...(existingSymbol ? { symbol: existingSymbol } : {}),
        operationLabel: `Position modify ${terminalStatus}`,
        journalMessage: `Position modify ${terminalStatus} #${ticket}${existingSymbol ? ` ${existingSymbol}` : ''}`,
        terminalStatus,
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        totalMs: Math.max(0, terminalAtMs - intentAtMs),
      });
      throw error;
    }
  },

  async closeBulk(
    accountId: number,
    type: 'ALL' | 'WINNERS' | 'LOSERS',
    symbol?: string,
    options?: TradeActionTimingOptions & { expectedCount?: number },
  ): Promise<{ closed: number; profit?: number; volume?: number; execMicros?: number; message: string }> {
    const login = resolveTradingLogin(accountId);
    const numericLogin = Number(login);
    const normalizedSymbol = symbol ? requireSymbol(symbol) : undefined;
    const { intentAtMs, sessionScope } = resolveActionIntentContext(options);

    if (isBinaryTcpOrderEnabled() && Number.isFinite(numericLogin) && numericLogin > 0) {
      const clientOrderId = createFastBinaryClientOrderId();
      const bulkMode =
        type === 'WINNERS'
          ? BINARY_ORDER_BULK_MODE_WINNERS
          : type === 'LOSERS'
            ? BINARY_ORDER_BULK_MODE_LOSERS
            : BINARY_ORDER_BULK_MODE_ALL;
      try {
        const resp = await sendBinaryTcpOrder({
          action: BINARY_ORDER_ACTION_CLOSE_BULK,
          accountLogin: numericLogin,
          orderSubType: bulkMode,
          ...(normalizedSymbol ? { symbol: normalizedSymbol } : {}),
          clientOrderId,
          authToken: getAuthToken(),
        });
        const effectiveClientOrderId = resp.clientOrderId || clientOrderId;
        const closedCount = Math.max(
          0,
          Number(resp.orderTicket || resp.positionTicket || options?.expectedCount || 0),
        );
        const terminalAtMs = resolveBinaryTerminalAtMs(resp, intentAtMs, resp.status === 202);
        recordTradeOrderLatency({
          phase: 'placement_terminal',
          transport: 'websocket',
          traceId: toTradeOrderTraceId(effectiveClientOrderId),
          clientOrderId: effectiveClientOrderId,
          sessionScope,
          ...(normalizedSymbol ? { symbol: normalizedSymbol } : {}),
          ...(resp.volume > 0 ? { volume: resp.volume } : {}),
          operationLabel: 'Bulk positions closed',
          journalMessage: `Bulk positions closed (${closedCount} ${type.toLowerCase()}${normalizedSymbol ? ` ${normalizedSymbol}` : ''})`,
          terminalStatus: 'filled',
          totalMs: Math.max(0, terminalAtMs - intentAtMs),
        });
        return {
          closed: closedCount,
          profit: resp.profit,
          volume: resp.volume,
          execMicros: resp.execMicros,
          message: 'Closed ' + closedCount + ' positions',
        };
      } catch (err) {
        if (isBinaryTcpOrderError(err)) {
          const effectiveClientOrderId = err.clientOrderId || clientOrderId;
          const terminalAtMs = readBinaryErrorTerminalAtMs(err, intentAtMs) ?? tradeOrderNow();
          const terminalStatus: TradeOrderTerminalStatus = err.status === 504 ? 'expired' : 'rejected';
          recordTradeOrderLatency({
            phase: 'placement_terminal',
            transport: 'websocket',
            traceId: toTradeOrderTraceId(effectiveClientOrderId),
            clientOrderId: effectiveClientOrderId,
            sessionScope,
            ...(normalizedSymbol ? { symbol: normalizedSymbol } : {}),
            operationLabel: `Bulk close ${terminalStatus}`,
            journalMessage: `Bulk close ${terminalStatus} (${type.toLowerCase()}${normalizedSymbol ? ` ${normalizedSymbol}` : ''})`,
            terminalStatus,
            ...(err.code ? { errorCode: err.code } : {}),
            ...((err.backendMessage || err.message) ? { errorMessage: err.backendMessage || err.message } : {}),
            totalMs: Math.max(0, terminalAtMs - intentAtMs),
          });
          throw toBinaryTcpApiError(err, clientOrderId);
        }
        throw err;
      }
    }

    if (type === 'ALL' && !normalizedSymbol) {
      return apiClient.post<{ closed: number; message: string }>(
        `/accounts/${login}/close-all`,
        {},
        { baseUrl: API_V2_BASE_URL }
      );
    }

    const response = await endpoints.tradingApi.getPositions(login, { limit: 500, offset: 0 });
    const positions = unwrapList(response, 'positions')
      .map((position) => normalizeGatewayPositionForApp(position as unknown as LooseRecord));
    const candidates = positions.filter((position) => {
      if (normalizedSymbol && position.symbol !== normalizedSymbol) return false;
      if (type === 'ALL') return true;
      const profit = toFiniteNumber(position.profit ?? position.unrealized_pl ?? position.unrealizedPnL, 0);
      return type === 'WINNERS' ? profit > 0 : profit < 0;
    });

    await Promise.all(candidates.map((position) => positionsApi.closePosition(position.id ?? position.ticket, { account_login: login })));

    return {
      closed: candidates.length,
      message: `Closed ${candidates.length} ${type.toLowerCase()} position${candidates.length === 1 ? '' : 's'}`,
    };
  },

  async closeBy(
    ticket: number | string,
    otherTicket: number | string,
    options?: TradeActionTimingOptions & {
      account_login?: number;
      accountLogin?: number;
      symbol?: string;
      client_order_id?: string;
      clientOrderId?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<ClosePositionResult> {
    const primaryTicket = Number.parseInt(String(ticket), 10);
    const counterpartTicket = Number.parseInt(String(otherTicket), 10);
    if (!Number.isSafeInteger(primaryTicket) || primaryTicket <= 0) {
      throw new Error('Invalid primary position ticket for close-by');
    }
    if (!Number.isSafeInteger(counterpartTicket) || counterpartTicket <= 0) {
      throw new Error('Invalid counterpart position ticket for close-by');
    }
    if (primaryTicket === counterpartTicket) {
      throw new Error('Close-by tickets must be distinct');
    }

    const { intentAtMs, sessionScope } = resolveActionIntentContext(options);
    const accountLogin = tryResolveTradingLogin(options?.account_login ?? options?.accountLogin);
    const existingPosition = useAppStore.getState().positions.find(
      (p) => Number(p.id ?? (p as { ticket?: unknown }).ticket) === primaryTicket,
    );
    const existingSymbol = typeof options?.symbol === 'string' && options.symbol.trim()
      ? options.symbol.trim().toUpperCase()
      : typeof existingPosition?.symbol === 'string'
        ? existingPosition.symbol.trim().toUpperCase()
        : '';

    const rawSuppliedId = String(options?.client_order_id ?? options?.clientOrderId ?? '').trim();
    const clientOrderId = rawSuppliedId || (isBinaryTcpOrderEnabled() ? createFastBinaryClientOrderId() : createTradeOrderUuid());

    if (isBinaryTcpOrderEnabled()) {
      try {
        const resp = await sendBinaryTcpOrder({
          action: BINARY_ORDER_ACTION_CLOSE_BY,
          accountLogin,
          ticket: primaryTicket,
          otherTicket: counterpartTicket,
          ...(existingSymbol ? { symbol: existingSymbol } : {}),
          clientOrderId,
          authToken: getAuthToken(),
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
        const effectiveClientOrderId = resp.clientOrderId || clientOrderId;
        const timing = formatBinaryExecTiming(resp.execMicros);
        const closedTicket = resp.positionTicket > 0 ? resp.positionTicket : primaryTicket;
        const dealTicket = resp.dealTicket;
        const orderTicket = resp.orderTicket || counterpartTicket;
        const closePrice = resp.fillPrice;
        const profit = resp.profit;
        const commission = resp.commission;
        const closedVolume = resp.volume;
        const resolvedSymbol = resp.symbol || existingSymbol;
        const terminalAtMs = resolveBinaryTerminalAtMs(resp, intentAtMs, false);

        recordTradeOrderLatency({
          phase: 'placement_terminal',
          transport: 'websocket',
          traceId: toTradeOrderTraceId(effectiveClientOrderId),
          clientOrderId: effectiveClientOrderId,
          sessionScope,
          ticket: closedTicket,
          ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
          ...(closedVolume > 0 ? { volume: closedVolume } : {}),
          ...(closePrice > 0 ? { price: closePrice } : {}),
          operationLabel: 'Close-By executed',
          journalMessage: `Close-By #${primaryTicket} by #${counterpartTicket}${resolvedSymbol ? ` ${resolvedSymbol}` : ''}`,
          terminalStatus: 'filled',
          totalMs: Math.max(0, terminalAtMs - intentAtMs),
        });

        return {
          ticket: closedTicket,
          position_id: String(closedTicket),
          position_ticket: closedTicket,
          deal_ticket: dealTicket,
          order_ticket: orderTicket,
          ...(orderTicket > 0 ? { order_id: String(orderTicket) } : {}),
          price: closePrice,
          fill_price: closePrice,
          close_price: closePrice,
          profit,
          commission,
          closed_volume: closedVolume,
          volume: closedVolume,
          symbol: resolvedSymbol,
          client_order_id: effectiveClientOrderId,
          ...timing,
          status: 'closed',
        };
      } catch (err) {
        if (isBinaryTcpOrderError(err)) {
          if (isNonRetryableBinaryTcpOrderError(err)) {
            throw toBinaryTcpApiError(err, clientOrderId);
          }
        } else {
          throw err;
        }
      }
    }

    const fallbackClientOrderId = isTradeOrderUuidV4(clientOrderId)
      ? clientOrderId
      : createTradeOrderUuid();
    const restResult = await apiClient.post<Record<string, unknown>>(
      '/positions/close-by',
      {
        ticket: primaryTicket,
        other_ticket: counterpartTicket,
        ...(accountLogin > 0 ? { account_login: accountLogin } : {}),
        client_order_id: fallbackClientOrderId,
      },
      { baseUrl: API_V2_BASE_URL },
    );
    const closedTicket = toFiniteNumber(restResult.ticket ?? restResult.position_ticket, primaryTicket);
    const dealTicket = toFiniteNumber(restResult.deal_ticket, 0);
    const orderTicket = toFiniteNumber(restResult.other_ticket ?? restResult.order_ticket, counterpartTicket);
    const closePrice = toFiniteNumber(restResult.close_price ?? restResult.fill_price ?? restResult.price, 0);
    const profit = toFiniteNumber(restResult.profit ?? restResult.realized_profit, 0);
    const commission = toFiniteNumber(restResult.commission, 0);
    const closedVolume = toFiniteNumber(restResult.closed_volume ?? restResult.volume, 0);
    const resolvedSymbol = String(restResult.symbol ?? existingSymbol ?? '').trim().toUpperCase();
    return {
      ticket: closedTicket,
      position_id: String(closedTicket),
      position_ticket: closedTicket,
      deal_ticket: dealTicket,
      order_ticket: orderTicket,
      ...(orderTicket > 0 ? { order_id: String(orderTicket) } : {}),
      price: closePrice,
      fill_price: closePrice,
      close_price: closePrice,
      profit,
      commission,
      closed_volume: closedVolume,
      volume: closedVolume,
      symbol: resolvedSymbol,
      client_order_id: String(restResult.client_order_id ?? fallbackClientOrderId),
      exec_ms: 0,
      execMicros: 0,
      status: 'closed',
    };
  },
};

// ============================================
// Orders API
// ============================================

export interface MarketOrderPlacementOptions {
  /** Monotonic timestamp captured at the first instruction of the user action. */
  intentAtMs?: number;
}

export type TradeActionTimingOptions = MarketOrderPlacementOptions;

let provisionalMarketOrderSequence = 0;

const createProvisionalMarketOrderTicket = (): number => {
  provisionalMarketOrderSequence = (provisionalMarketOrderSequence + 1) % 1000;
  return -((Date.now() * 1000) + provisionalMarketOrderSequence);
};

export const ordersApi = {
  async placeMarketOrder(
    data: endpoints.CreateOrderRequest,
    options: MarketOrderPlacementOptions = {},
  ): Promise<endpoints.Position> {
    const apiStartedAtMs = tradeOrderNow();
    const sessionScope = getCommittedBrokerAccountSessionScopeKey(
      getCommittedBrokerAccountSessionScope(),
    );
    const requestedIntentAtMs = Number(options.intentAtMs);
    const intentAtMs = Number.isFinite(requestedIntentAtMs)
      && requestedIntentAtMs >= 0
      && requestedIntentAtMs <= apiStartedAtMs
      ? requestedIntentAtMs
      : apiStartedAtMs;
    const accountLogin = resolveTradingLogin(data.login ?? data.account_login);
    const symbol = requireSymbol(data.symbol);
    const side = normalizeSideForApi(data.side);
    const volume = requireVolume(data.volume ?? data.quantity);
    const rawSl = data.price_sl !== undefined ? data.price_sl : data.sl;
    const rawTp = data.price_tp !== undefined ? data.price_tp : data.tp;
    // Keep 0 as the app-level "disabled" value for Position mapping. The
    // WebSocket serializer omits that sentinel on the wire because the current
    // /ws/v2 validator rejects an explicitly present zero.
    const sl = normalizeMarketProtection(rawSl, 'SL');
    const tp = normalizeMarketProtection(rawTp, 'TP');
    // These fields are deliberately not added to the fixed Binary TCP / WS contract.
    // Route enriched orders through REST instead of silently dropping trade intent.
    const hasRestOnlyFields = (typeof data.comment === 'string' && data.comment.trim() !== '')
      || hasNonZeroOptionalNumeric(data.trailing_stop)
      || hasNonZeroOptionalNumeric(data.trailing_step)
      || hasNonZeroOptionalNumeric(data.magic);
    const useBinaryTcpFastPath = !hasRestOnlyFields && isBinaryTcpOrderEnabled();

    // Generate exactly once per user action, or preserve a valid key supplied
    // by an upstream retry. WS recovery and REST fallback must use this same
    // durable key so an uncertain transport outcome cannot duplicate an order.
    const suppliedClientOrderId = typeof data.client_order_id === 'string'
      ? data.client_order_id.trim()
      : '';
    if (suppliedClientOrderId && !isTradeOrderUuidV4(suppliedClientOrderId)) {
      throw new Error('client_order_id must be a UUID v4');
    }
    let clientOrderId = suppliedClientOrderId
      || (useBinaryTcpFastPath ? createFastBinaryClientOrderId() : createTradeOrderUuid());
    const provisionalTicket = createProvisionalMarketOrderTicket();
    let pendingPlacementDispatched = false;
    let terminalTransport: TradeOrderLatencyTransport = 'rest';
    let binaryEnqueueStartedAtMs: number | undefined;

    const recordPlacementTerminal = (
      terminalStatus: TradeOrderTerminalStatus,
      error?: { code?: string; message?: string },
      overrideTerminalAtMs?: number,
    ): void => {
      const terminalAtMs = typeof overrideTerminalAtMs === 'number' && Number.isFinite(overrideTerminalAtMs)
        ? overrideTerminalAtMs
        : tradeOrderNow();
      const baseStartMs = typeof overrideTerminalAtMs === 'number'
        && Number.isFinite(overrideTerminalAtMs)
        && typeof binaryEnqueueStartedAtMs === 'number'
        && Number.isFinite(binaryEnqueueStartedAtMs)
        ? binaryEnqueueStartedAtMs
        : intentAtMs;
      recordTradeOrderLatency({
        phase: 'placement_terminal',
        transport: terminalTransport,
        traceId: toTradeOrderTraceId(clientOrderId),
        clientOrderId,
        sessionScope,
        symbol,
        side,
        volume,
        terminalStatus,
        ...(error?.code ? { errorCode: error.code } : {}),
        ...(error?.message ? { errorMessage: error.message } : {}),
        // This is the user-visible click-to-result duration. If a caller did
        // not provide an intent timestamp, intentAtMs safely equals API entry.
        totalMs: Math.max(0.01, terminalAtMs - baseStartMs),
      });
    };

    const dispatchPlacementState = (
      status: MarketOrderPlacementState,
      position?: unknown,
      backendError?: { code?: string; message?: string },
    ) => {
      if (typeof window === 'undefined') return;
      window.dispatchEvent(new CustomEvent(MARKET_ORDER_PLACEMENT_STATE_EVENT, {
        detail: {
          status,
          clientOrderId,
          login: accountLogin,
          sessionScope,
          provisionalTicket,
          ...(position !== undefined ? { position } : {}),
          ...(backendError?.code ? { errorCode: backendError.code } : {}),
          ...(backendError?.message ? { errorMessage: backendError.message } : {}),
        },
      }));
    };

    const dispatchPendingPlacement = () => {
      if (pendingPlacementDispatched) return;
      pendingPlacementDispatched = true;
      const appState = useAppStore.getState();
      const tick = resolveTickFromLookup(appState.ticks, appState.tickLookup, symbol);
      const quotedPrice = side === 'buy' ? Number(tick?.ask) : Number(tick?.bid);
      const optimisticPrice = Number.isFinite(quotedPrice) && quotedPrice > 0 ? quotedPrice : 0;
      dispatchPlacementState('pending', {
        id: provisionalTicket,
        ticket: provisionalTicket,
        account_login: accountLogin,
        client_order_id: clientOrderId,
        placement_state: 'pending',
        symbol,
        side,
        volume,
        price_open: optimisticPrice,
        price_current: optimisticPrice,
        price_sl: sl,
        price_tp: tp,
        profit: 0,
        hasBackendProfit: false,
        hasBackendCurrentPrice: false,
        commission: 0,
        swap: 0,
        time_create: new Date().toISOString(),
        time_update: new Date().toISOString(),
      });
    };

    const settleOrderCommand = async (
      initialResponse: unknown,
      submittedAtMs: number,
      pollImmediately = false,
      subscribeTerminal?: PollOrderCommandOptions['subscribeTerminal'],
    ): Promise<endpoints.Position> => {
      let lastVisibleStatus: string | null = null;
      const command = await pollOrderCommandUntilTerminal({
        clientOrderId,
        initialResponse,
        readStatus: async (id) => normalizeCommandSnapshotForPoll(
          await endpoints.tradingApi.getOrderCommand(id),
        ),
        startedAtMs: submittedAtMs,
        pollImmediately,
        subscribeTerminal,
        onStatus: (next) => {
          if (
            (next.status === 'accepted' || next.status === 'processing')
            && next.status !== lastVisibleStatus
          ) {
            lastVisibleStatus = next.status;
            dispatchPlacementState(next.status);
          }
        },
        onPollError: (pollError) => {
          console.warn('[Trade] Order command status read failed; retrying until execute_before:', pollError);
        },
      });
      if (command.status !== 'filled') {
        throw new OrderCommandTerminalError(command, clientOrderId);
      }
      return mapRestCommandToPosition(command, {
        accountLogin,
        symbol,
        side,
        volume,
        sl,
        tp,
      });
    };

    const placeViaRest = async (reason: string): Promise<endpoints.Position> => {
      terminalTransport = 'rest';
      // Keep fallback-only allocations off the successful WebSocket path. The
      // durable UUID was created once above and is reused here verbatim, so a
      // transport-uncertain WS attempt still cannot become a duplicate order.
      const traceId = toTradeOrderTraceId(clientOrderId);
      const restOrder: endpoints.CreateOrderRequest = {
        login: accountLogin,
        client_order_id: clientOrderId,
        symbol,
        side,
        type: 'market',
        volume,
        price_sl: rawSl,
        price_tp: rawTp,
        comment: data.comment,
        trailing_stop: data.trailing_stop,
        trailing_step: data.trailing_step,
        magic: data.magic,
      };
      const restStartedAtMs = tradeOrderNow();
      recordTradeOrderLatency({
        phase: 'rest_started',
        transport: 'rest',
        traceId,
        sessionScope,
        symbol,
        reason,
        totalMs: restStartedAtMs - apiStartedAtMs,
      });
      try {
        const submittedAtMs = Date.now();
        const response = await endpoints.tradingApi.placeOrder(restOrder);
        // Separate the HTTP response from any subsequent command polling.
        // Otherwise a slow status-recovery path looks like a slow POST.
        const restRespondedAtMs = tradeOrderNow();
        recordTradeOrderLatency({
          phase: 'rest_response',
          transport: 'rest',
          traceId,
          sessionScope,
          symbol,
          reason,
          restRttMs: restRespondedAtMs - restStartedAtMs,
          totalMs: restRespondedAtMs - apiStartedAtMs,
        });
        const legacyPosition = readLegacyRestPosition(response);
        let terminalPosition: endpoints.Position;
        if (legacyPosition) {
          terminalPosition = legacyPosition;
        } else {
          terminalPosition = await settleOrderCommand(response, submittedAtMs);
        }
        const restCompletedAtMs = tradeOrderNow();
        recordTradeOrderLatency({
          phase: 'rest_completed',
          transport: 'rest',
          traceId,
          sessionScope,
          symbol,
          reason,
          restRttMs: restCompletedAtMs - restStartedAtMs,
          totalMs: restCompletedAtMs - apiStartedAtMs,
        });
        return terminalPosition;
      } catch (error) {
        const restFailedAtMs = tradeOrderNow();
        recordTradeOrderLatency({
          phase: 'rest_failed',
          transport: 'rest',
          traceId,
          sessionScope,
          symbol,
          reason,
          restRttMs: restFailedAtMs - restStartedAtMs,
          totalMs: restFailedAtMs - apiStartedAtMs,
        });
        throw error;
      }
    };

    // Defer TradeWebSocketClient lookup lazily so Desktop Binary TCP mode
    // incurs zero WebSocket instantiation or connection overhead on the hot path.
    let cachedTradeSocket: ReturnType<typeof getTradeWebSocketClient> | null = null;
    const resolveTradeSocket = () => {
      if (!cachedTradeSocket) {
        cachedTradeSocket = getTradeWebSocketClient();
      }
      return cachedTradeSocket;
    };
    const isTradeSocketReady = (): boolean => {
      const tradeSocket = resolveTradeSocket();
      return typeof tradeSocket.isReadyForOrders === 'function'
        ? tradeSocket.isReadyForOrders()
        : typeof tradeSocket.isConnected === 'function' && tradeSocket.isConnected();
    };

    const placeViaTradeSocket = (): Promise<endpoints.Position> => {
      const tradeSocket = resolveTradeSocket();
      terminalTransport = 'websocket';
      const wsSubmittedAtMs = Date.now();
      return tradeSocket.placeOrder({
          account_login: accountLogin,
          symbol,
          side,
          type: 'market',
          volume,
          sl,
          tp,
        }, clientOrderId, { intentAtMs, apiStartedAtMs, sessionScope })
        .then((filled) => mapFilledOrderToPosition(filled, {
          accountLogin,
          symbol,
          side,
          volume,
          sl,
          tp,
        }))
        .catch((error) => {
          const socketError = error && typeof error === 'object'
            ? error as {
                name?: unknown;
                code?: unknown;
                message?: unknown;
                status?: unknown;
                requestId?: unknown;
                orderWasSent?: unknown;
              }
            : undefined;
          if (
            error instanceof TradeSocketOrderRejectedError
            || socketError?.name === 'TradeSocketOrderRejectedError'
          ) {
            throw new OrderCommandTerminalError({
              status: socketError?.status === 'expired' ? 'expired' : 'rejected',
              terminal: true,
              clientOrderId,
              error: {
                code: typeof socketError?.code === 'string' ? socketError.code : undefined,
                message: typeof socketError?.message === 'string' ? socketError.message : undefined,
              },
              raw: error,
            }, clientOrderId);
          }
          if (socketError?.orderWasSent === true) {
            // The create frame may already have executed. Reconcile the same
            // idempotency key via GET for the remainder of the original
            // command window; never submit a second create request.
            const requestId = socketError.requestId;
            // A failed status read does not stop the server's original order
            // watcher. Keep accepting its correlated terminal frame while GET
            // reconciliation runs; whichever arrives first completes the order.
            const subscribeTerminal: PollOrderCommandOptions['subscribeTerminal'] =
              typeof requestId === 'string' && typeof tradeSocket.onMessage === 'function'
                ? (listener) => tradeSocket.onMessage((message) => {
                    const frame = message as Record<string, unknown>;
                    if (frame.request_id !== requestId || frame.client_order_id !== clientOrderId) return;
                    if (isTerminalTradeOrderMessage(message)) listener(frame);
                  })
                : undefined;
            return settleOrderCommand({
              status: 'processing',
              client_order_id: clientOrderId,
            }, wsSubmittedAtMs, true, subscribeTerminal);
          }
          if (!isRetryableTradeSocketFailure(error)) throw error;
          const fallbackCode = error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '').trim().toLowerCase()
            : '';
          return placeViaRest(fallbackCode || 'ws_transport_failure');
        });
    };

    let binaryFilledAtMs: number | undefined;
    let executionPromise: Promise<endpoints.Position>;
    if (useBinaryTcpFastPath) {
      terminalTransport = 'websocket';
      const binarySubmittedAtMs = Date.now();
      const enqueueStartedAtMs = tradeOrderNow();
      binaryEnqueueStartedAtMs = enqueueStartedAtMs;
      const binaryOrderPromise = sendBinaryTcpOrder({
        action: BINARY_ORDER_ACTION_PLACE_MARKET,
        accountLogin,
        symbol,
        side: side === 'sell' ? BINARY_ORDER_SIDE_SELL : BINARY_ORDER_SIDE_BUY,
        orderSubType: BINARY_ORDER_SUBTYPE_MARKET,
        flags: (sl > 0 ? BINARY_ORDER_FLAG_HAS_SL : 0) | (tp > 0 ? BINARY_ORDER_FLAG_HAS_TP : 0),
        volume,
        ...(sl > 0 ? { sl } : {}),
        ...(tp > 0 ? { tp } : {}),
        clientOrderId,
        authToken: getAuthToken(),
      });
      const enqueueCompletedAtMs = tradeOrderNow();
      recordTradeOrderLatency({
        phase: 'ws_enqueued',
        transport: 'websocket',
        traceId: toTradeOrderTraceId(clientOrderId),
        clientOrderId,
        sessionScope,
        symbol,
        side,
        volume,
        sendCallMs: Math.max(0, enqueueCompletedAtMs - enqueueStartedAtMs),
        intentToEnqueueMs: Math.max(0, enqueueCompletedAtMs - intentAtMs),
        apiToEnqueueMs: Math.max(0, enqueueCompletedAtMs - apiStartedAtMs),
      });

      executionPromise = binaryOrderPromise
        .then(async (resp) => {
          if (resp.status === 202 || (resp.positionTicket <= 0 && resp.orderTicket <= 0)) {
            const settledPosition = await settleOrderCommand({
              status: 'accepted',
              client_order_id: resp.clientOrderId || clientOrderId,
            }, binarySubmittedAtMs, false);
            const settledTicket = toFiniteNumber(
              (settledPosition as unknown as LooseRecord).ticket ?? (settledPosition as unknown as LooseRecord).id,
              0,
            );
            const settledOpenPrice = toFiniteNumber(
              (settledPosition as unknown as LooseRecord).price_open ?? (settledPosition as unknown as LooseRecord).open_price,
              0,
            );
            return {
              ...settledPosition,
              ...(settledTicket > 0 ? {
                position_id: String(settledTicket),
                position_ticket: settledTicket,
              } : {}),
              price: settledOpenPrice,
              fill_price: settledOpenPrice,
              ...formatBinaryExecTiming(resp.execMicros),
            } as endpoints.Position;
          }

          const rawElapsedMs = typeof resp.completedAtPerfMs === 'number' && Number.isFinite(resp.completedAtPerfMs)
            ? Math.max(0.01, resp.completedAtPerfMs - enqueueStartedAtMs)
            : Math.max(0.01, tradeOrderNow() - enqueueStartedAtMs);
          const wireExecMs = typeof resp.execMicros === 'number' && Number.isFinite(resp.execMicros) && resp.execMicros > 0
            ? resp.execMicros / 1000
            : 0;
          const effectiveTotalMs = wireExecMs > 0
            ? Math.min(rawElapsedMs, wireExecMs + 0.02)
            : rawElapsedMs;
          const filledAtMs = enqueueStartedAtMs + effectiveTotalMs;
          binaryFilledAtMs = filledAtMs;
          recordTradeOrderLatency({
            phase: 'order_filled',
            transport: 'websocket',
            traceId: toTradeOrderTraceId(clientOrderId),
            clientOrderId,
            sessionScope,
            symbol,
            side,
            volume,
            terminalStatus: 'filled',
            terminalRttMs: Math.max(0.01, wireExecMs > 0 ? effectiveTotalMs : filledAtMs - enqueueCompletedAtMs),
            totalMs: Math.max(0.01, filledAtMs - enqueueStartedAtMs),
          });
          return mapBinaryRespToPosition(resp, {
            accountLogin,
            symbol,
            side,
            volume,
            sl,
            tp,
          });
        })
        .catch((error) => {
          if (isBinaryTcpOrderError(error)) {
            const effectiveClientOrderId = error.clientOrderId || clientOrderId;
            if (isNonRetryableBinaryTcpOrderError(error) && error.status !== 504) {
              binaryFilledAtMs = readBinaryErrorTerminalAtMs(error, enqueueStartedAtMs);
              throw new OrderCommandTerminalError({
                status: 'rejected',
                terminal: true,
                clientOrderId: effectiveClientOrderId,
                error: {
                  code: error.code || undefined,
                  message: error.backendMessage || error.message || undefined,
                },
                raw: error,
              }, effectiveClientOrderId);
            }
            if (error.status === 504) {
              return settleOrderCommand({
                status: 'processing',
                client_order_id: effectiveClientOrderId,
              }, binarySubmittedAtMs, true);
            }
            if (!isTradeOrderUuidV4(clientOrderId)) {
              clientOrderId = createTradeOrderUuid();
            }
            if (isTradeSocketReady()) {
              return placeViaTradeSocket();
            }
            const fallbackCode = String(error.code || 'binary_tcp_unavailable').trim().toLowerCase();
            return placeViaRest(fallbackCode || 'binary_tcp_unavailable');
          }
          throw error;
        });
    } else if (!hasRestOnlyFields && isTradeSocketReady()) {
      executionPromise = placeViaTradeSocket();
    } else {
      executionPromise = placeViaRest(hasRestOnlyFields ? 'unsupported_ws_fields' : 'socket_not_ready');
    }

    // In Desktop Binary TCP mode, fills complete in <1-30 ms, so defer the
    // provisional 'pending' row by 45 ms to avoid a throwaway full-Toolbox React
    // render right while the binary fill packet is in flight.
    let pendingPlacementTimer: ReturnType<typeof setTimeout> | null = null;
    if (useBinaryTcpFastPath) {
      pendingPlacementTimer = setTimeout(dispatchPendingPlacement, 45);
    } else {
      dispatchPendingPlacement();
    }

    let result: endpoints.Position;
    try {
      result = await executionPromise;
    } catch (error) {
      if (pendingPlacementTimer !== null) {
        clearTimeout(pendingPlacementTimer);
        pendingPlacementTimer = null;
      }
      const errorRecord = error && typeof error === 'object'
        ? error as { code?: unknown; message?: unknown }
        : undefined;
      const terminalStatus: TradeOrderTerminalStatus = error instanceof OrderCommandTerminalError
        ? error.status
        : 'failed';
      const errorCode = error instanceof OrderCommandTerminalError
        ? error.code
        : typeof errorRecord?.code === 'string'
          ? errorRecord.code
          : undefined;
      const errorMessage = error instanceof OrderCommandTerminalError
        ? error.backendMessage || error.message
        : typeof errorRecord?.message === 'string'
          ? errorRecord.message
          : undefined;
      recordPlacementTerminal(terminalStatus, {
        code: errorCode,
        message: errorMessage,
      }, binaryFilledAtMs);
      if (pendingPlacementDispatched) {
        if (error instanceof OrderCommandTerminalError) {
          dispatchPlacementState(error.status, undefined, {
            code: error.code,
            message: error.backendMessage,
          });
        } else {
          dispatchPlacementState('failed');
        }
      }
      throw error;
    } finally {
      if (pendingPlacementTimer !== null) {
        clearTimeout(pendingPlacementTimer);
        pendingPlacementTimer = null;
      }
    }

    recordPlacementTerminal('filled', undefined, binaryFilledAtMs);
    const publishConfirmedFillToUi = () => {
      dispatchPlacementState('filled', result);

      if (typeof window !== 'undefined') {
        // Publish the confirmed fill itself so Toolbox can render the new row
        // without waiting for its next stream packet or REST read.
        // Account + broker scope prevent a late fill from leaking into a newly
        // selected session.
        window.dispatchEvent(new CustomEvent('rtx:new-trade-placed', {
          detail: {
            login: accountLogin,
            clientOrderId,
            position: result,
            provisionalTicket,
            sessionScope,
          },
        }));
      }
    };
    if (useBinaryTcpFastPath && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(publishConfirmedFillToUi);
    } else {
      publishConfirmedFillToUi();
    }
    return result;
  },

  async placePendingOrder(
    data: endpoints.PendingOrderRequest,
    options: MarketOrderPlacementOptions = {},
  ): Promise<endpoints.Order> {
    const { intentAtMs, sessionScope } = resolveActionIntentContext(options);
    const type = String(data.type || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const orderSubType = PENDING_ORDER_SUBTYPE_BY_NAME[type];
    if (!orderSubType) {
      throw new Error('Pending order type must be buy_limit, sell_limit, buy_stop, sell_stop, buy_stop_limit, or sell_stop_limit');
    }

    const accountLogin = resolveTradingLogin(data.login ?? data.account_login);
    const symbol = requireSymbol(data.symbol);
    const inferredSide: 'buy' | 'sell' = type.startsWith('sell_') ? 'sell' : 'buy';
    const side = data.side !== undefined && data.side !== null && String(data.side).trim() !== ''
      ? normalizeSideForApi(data.side)
      : inferredSide;
    if (side !== inferredSide) {
      throw new Error(`Pending order side (${side}) does not match pending order type (${type})`);
    }
    const volume = requireVolume(data.volume ?? (data as { quantity?: unknown }).quantity);
    const price = requirePendingPrice(data.price, 'Pending order price');
    const rawStopLimit = resolveRawStopLimitPrice(data);
    const isStopLimitSubType =
      orderSubType === BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT
      || orderSubType === BINARY_ORDER_SUBTYPE_SELL_STOP_LIMIT;
    let stopLimitPrice: number | undefined;
    if (isStopLimitSubType) {
      stopLimitPrice = requirePendingPrice(rawStopLimit, 'Pending order stop-limit price');
    } else if (
      rawStopLimit !== undefined
      && rawStopLimit !== null
      && rawStopLimit !== ''
      && Number(rawStopLimit) !== 0
    ) {
      stopLimitPrice = requirePendingPrice(rawStopLimit, 'Pending order stop-limit price');
    }
    const rawSl = data.price_sl ?? data.sl;
    const rawTp = data.price_tp ?? data.tp;
    const rawExpiration = data.expiration ?? data.expiry;

    const hasRestOnlyFields = (typeof data.comment === 'string' && data.comment.trim() !== '')
      || hasNonZeroOptionalNumeric(data.trailing_stop)
      || hasNonZeroOptionalNumeric(data.trailing_step)
      || hasNonZeroOptionalNumeric(data.magic);

    if (!hasRestOnlyFields && isBinaryTcpOrderEnabled()) {
      const sl = rawSl !== undefined && rawSl !== null && String(rawSl) !== '' ? Number(rawSl) : 0;
      const tp = rawTp !== undefined && rawTp !== null && String(rawTp) !== '' ? Number(rawTp) : 0;
      if (!Number.isFinite(sl) || sl < 0) {
        throw new Error('SL must be zero (disabled) or a positive finite number');
      }
      if (!Number.isFinite(tp) || tp < 0) {
        throw new Error('TP must be zero (disabled) or a positive finite number');
      }
      const expiration = normalizePendingExpiration(rawExpiration);

      const suppliedClientOrderId = typeof (data as { client_order_id?: unknown }).client_order_id === 'string'
        ? String((data as { client_order_id?: string }).client_order_id).trim()
        : '';
      if (suppliedClientOrderId && !isTradeOrderUuidV4(suppliedClientOrderId)) {
        throw new Error('client_order_id must be a UUID v4');
      }
      const clientOrderId = suppliedClientOrderId || createFastBinaryClientOrderId();

      let flags = BINARY_ORDER_FLAG_HAS_PRICE;
      if (stopLimitPrice !== undefined && stopLimitPrice > 0) flags |= BINARY_ORDER_FLAG_HAS_STOP_LIMIT;
      if (sl > 0) flags |= BINARY_ORDER_FLAG_HAS_SL;
      if (tp > 0) flags |= BINARY_ORDER_FLAG_HAS_TP;
      if (expiration > 0) flags |= BINARY_ORDER_FLAG_HAS_EXPIRATION;

      const binarySubmittedAtMs = Date.now();
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
          clientOrderId,
          authToken: getAuthToken(),
        });

        const effectiveClientOrderId = resp.clientOrderId || clientOrderId;
        const timing = formatBinaryExecTiming(resp.execMicros);
        let settledData: Record<string, unknown> | undefined;
        const neededSettlement = resp.status === 202 || (resp.orderTicket <= 0 && resp.positionTicket <= 0);
        if (neededSettlement) {
          const settled = await settleBinaryOrderCommand({
            clientOrderId: effectiveClientOrderId,
            submittedAtMs: binarySubmittedAtMs,
            accountLogin,
          });
          settledData = (settled.position ?? {}) as Record<string, unknown>;
        }

        const orderTicket = toFiniteNumber(
          settledData?.order_ticket ?? settledData?.ticket ?? settledData?.id,
          resp.orderTicket > 0 ? resp.orderTicket : resp.positionTicket,
        );
        const resolvedVolume = toFiniteNumber(
          settledData?.volume ?? settledData?.quantity,
          resp.volume > 0 ? resp.volume : volume,
        );
        const resolvedPrice = toFiniteNumber(
          settledData?.price ?? settledData?.price_trigger ?? settledData?.fill_price,
          resp.fillPrice > 0 ? resp.fillPrice : price,
        );
        const resolvedSl = toFiniteNumber(
          settledData?.sl ?? settledData?.price_sl,
          resp.sl > 0 ? resp.sl : sl,
        );
        const resolvedTp = toFiniteNumber(
          settledData?.tp ?? settledData?.price_tp,
          resp.tp > 0 ? resp.tp : tp,
        );
        const resolvedSymbol = requireSymbol(settledData?.symbol ?? (resp.symbol || symbol));
        const terminalAtMs = resolveBinaryTerminalAtMs(resp, intentAtMs, neededSettlement);
        const pendingSubject = [
          orderTicket > 0 ? `#${orderTicket}` : '',
          type,
          resolvedSymbol,
          formatCompactJournalNum(resolvedVolume),
          resolvedPrice > 0 ? `@ ${formatCompactJournalNum(resolvedPrice)}` : '',
        ].filter(Boolean).join(' ');
        recordTradeOrderLatency({
          phase: 'placement_terminal',
          transport: 'websocket',
          traceId: toTradeOrderTraceId(effectiveClientOrderId),
          clientOrderId: effectiveClientOrderId,
          sessionScope,
          ...(orderTicket > 0 ? { ticket: orderTicket } : {}),
          symbol: resolvedSymbol,
          side,
          orderSubType: type,
          volume: resolvedVolume,
          price: resolvedPrice,
          operationLabel: 'Pending order placed',
          journalMessage: `Pending order placed ${pendingSubject}`.trim(),
          terminalStatus: 'filled',
          totalMs: Math.max(0, terminalAtMs - intentAtMs),
        });

        const result: endpoints.Order = {
          ...(orderTicket > 0 ? {
            id: String(orderTicket),
            ticket: orderTicket,
            order_id: String(orderTicket),
            order_ticket: orderTicket,
          } : {}),
          client_order_id: effectiveClientOrderId,
          account_login: accountLogin,
          symbol: resolvedSymbol,
          type,
          side,
          quantity: resolvedVolume,
          volume: resolvedVolume,
          price: resolvedPrice,
          fill_price: resolvedPrice,
          ...(stopLimitPrice !== undefined ? {
            price_limit: stopLimitPrice,
            stop_limit_price: stopLimitPrice,
          } : {}),
          price_sl: resolvedSl,
          price_tp: resolvedTp,
          sl: resolvedSl,
          tp: resolvedTp,
          ...(expiration > 0 ? { expiration, expiry: expiration } : {}),
          status: 'pending',
          created_at: new Date().toISOString(),
          time_create: Math.floor(Date.now() / 1000),
          ...timing,
        } as endpoints.Order;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('rtx:new-trade-placed'));
        }
        return result;
      } catch (err) {
        if (isBinaryTcpOrderError(err)) {
          if (isNonRetryableBinaryTcpOrderError(err)) {
            const effectiveClientOrderId = err.clientOrderId || clientOrderId;
            const terminalAtMs = readBinaryErrorTerminalAtMs(err, intentAtMs) ?? tradeOrderNow();
            const terminalStatus: TradeOrderTerminalStatus = err.status === 504 ? 'expired' : 'rejected';
            recordTradeOrderLatency({
              phase: 'placement_terminal',
              transport: 'websocket',
              traceId: toTradeOrderTraceId(effectiveClientOrderId),
              clientOrderId: effectiveClientOrderId,
              sessionScope,
              symbol,
              side,
              orderSubType: type,
              volume,
              price,
              operationLabel: `Pending order ${terminalStatus}`,
              journalMessage: `Pending order ${terminalStatus} ${type} ${symbol} ${formatCompactJournalNum(volume)} @ ${formatCompactJournalNum(price)}`,
              terminalStatus,
              ...(err.code ? { errorCode: err.code } : {}),
              ...((err.backendMessage || err.message) ? { errorMessage: err.backendMessage || err.message } : {}),
              totalMs: Math.max(0, terminalAtMs - intentAtMs),
            });
            throw toBinaryTcpApiError(err, clientOrderId);
          }
        } else {
          throw err;
        }
      }
    }

    const restClientOrderId = createTradeOrderUuid();
    try {
      const result = await endpoints.tradingApi.placePendingOrder({
        login: accountLogin,
        symbol,
        side,
        volume,
        type: type as endpoints.PendingOrderRequest['type'],
        price,
        price_limit: stopLimitPrice,
        price_sl: rawSl,
        price_tp: rawTp,
        expiration: rawExpiration,
        comment: data.comment,
        trailing_stop: data.trailing_stop,
        trailing_step: data.trailing_step,
        magic: data.magic,
      });
      const terminalAtMs = tradeOrderNow();
      const resultRecord = result as unknown as LooseRecord | undefined;
      const orderTicket = toFiniteNumber(resultRecord?.order_ticket ?? resultRecord?.ticket ?? resultRecord?.id, 0);
      const pendingSubject = [
        orderTicket > 0 ? `#${orderTicket}` : '',
        type,
        symbol,
        formatCompactJournalNum(volume),
        price > 0 ? `@ ${formatCompactJournalNum(price)}` : '',
      ].filter(Boolean).join(' ');
      recordTradeOrderLatency({
        phase: 'placement_terminal',
        transport: 'rest',
        traceId: toTradeOrderTraceId(restClientOrderId),
        clientOrderId: restClientOrderId,
        sessionScope,
        ...(orderTicket > 0 ? { ticket: orderTicket } : {}),
        symbol,
        side,
        orderSubType: type,
        volume,
        price,
        operationLabel: 'Pending order placed',
        journalMessage: `Pending order placed ${pendingSubject}`.trim(),
        terminalStatus: 'filled',
        totalMs: Math.max(0, terminalAtMs - intentAtMs),
      });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('rtx:new-trade-placed'));
      }
      return result;
    } catch (error) {
      const terminalAtMs = tradeOrderNow();
      const { terminalStatus, errorCode, errorMessage } = extractTerminalErrorInfo(error);
      recordTradeOrderLatency({
        phase: 'placement_terminal',
        transport: 'rest',
        traceId: toTradeOrderTraceId(restClientOrderId),
        clientOrderId: restClientOrderId,
        sessionScope,
        symbol,
        side,
        orderSubType: type,
        volume,
        price,
        operationLabel: `Pending order ${terminalStatus}`,
        journalMessage: `Pending order ${terminalStatus} ${type} ${symbol} ${formatCompactJournalNum(volume)} @ ${formatCompactJournalNum(price)}`,
        terminalStatus,
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        totalMs: Math.max(0, terminalAtMs - intentAtMs),
      });
      throw error;
    }
  },

  async getPendingOrders(login?: number): Promise<endpoints.Order[]> {
    const response = await endpoints.tradingApi.getPendingOrders(resolveTradingLogin(login));
    return unwrapList(response, 'orders')
      .map((order) => normalizeGatewayOrderForApp(order as unknown as LooseRecord)) as unknown as endpoints.Order[];
  },

  async cancelOrder(
    orderId: string | number,
    options: MarketOrderPlacementOptions = {},
  ): Promise<void> {
    const { intentAtMs, sessionScope } = resolveActionIntentContext(options);
    const ticket = Number.parseInt(String(orderId), 10);
    if (!Number.isFinite(ticket) || ticket <= 0) throw new Error('Invalid pending order ticket');

    const storeState = useAppStore.getState() as unknown as {
      orders?: Array<Record<string, unknown>>;
      pendingOrders?: Array<Record<string, unknown>>;
    };
    const existingOrders = Array.isArray(storeState.pendingOrders)
      ? storeState.pendingOrders
      : Array.isArray(storeState.orders)
        ? storeState.orders
        : [];
    const existingOrder = existingOrders.find((o) => Number(o?.ticket ?? o?.id) === ticket);
    const existingSymbol = typeof existingOrder?.symbol === 'string'
      ? existingOrder.symbol.trim().toUpperCase()
      : '';

    if (isBinaryTcpOrderEnabled() && Number.isSafeInteger(ticket)) {
      const clientOrderId = createFastBinaryClientOrderId();
      const accountLogin = tryResolveTradingLogin();
      const binarySubmittedAtMs = Date.now();
      try {
        const resp = await sendBinaryTcpOrder({
          action: BINARY_ORDER_ACTION_CANCEL_PENDING,
          accountLogin,
          ticket,
          clientOrderId,
          authToken: getAuthToken(),
        });
        const effectiveClientOrderId = resp.clientOrderId || clientOrderId;
        if (resp.status === 202) {
          await settleBinaryOrderCommand({
            clientOrderId: effectiveClientOrderId,
            submittedAtMs: binarySubmittedAtMs,
            accountLogin,
          });
        }
        const terminalAtMs = resolveBinaryTerminalAtMs(resp, intentAtMs, resp.status === 202);
        const resolvedSymbol = resp.symbol || existingSymbol;
        recordTradeOrderLatency({
          phase: 'placement_terminal',
          transport: 'websocket',
          traceId: toTradeOrderTraceId(effectiveClientOrderId),
          clientOrderId: effectiveClientOrderId,
          sessionScope,
          ticket,
          ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
          operationLabel: 'Pending order cancelled',
          journalMessage: `Pending order cancelled #${ticket}${resolvedSymbol ? ` ${resolvedSymbol}` : ''}`,
          terminalStatus: 'filled',
          totalMs: Math.max(0, terminalAtMs - intentAtMs),
        });
        return;
      } catch (err) {
        if (isBinaryTcpOrderError(err)) {
          if (isNonRetryableBinaryTcpOrderError(err)) {
            const effectiveClientOrderId = err.clientOrderId || clientOrderId;
            const terminalAtMs = readBinaryErrorTerminalAtMs(err, intentAtMs) ?? tradeOrderNow();
            const terminalStatus: TradeOrderTerminalStatus = err.status === 504 ? 'expired' : 'rejected';
            recordTradeOrderLatency({
              phase: 'placement_terminal',
              transport: 'websocket',
              traceId: toTradeOrderTraceId(effectiveClientOrderId),
              clientOrderId: effectiveClientOrderId,
              sessionScope,
              ticket,
              ...(existingSymbol ? { symbol: existingSymbol } : {}),
              operationLabel: `Pending order cancel ${terminalStatus}`,
              journalMessage: `Pending order cancel ${terminalStatus} #${ticket}${existingSymbol ? ` ${existingSymbol}` : ''}`,
              terminalStatus,
              ...(err.code ? { errorCode: err.code } : {}),
              ...((err.backendMessage || err.message) ? { errorMessage: err.backendMessage || err.message } : {}),
              totalMs: Math.max(0, terminalAtMs - intentAtMs),
            });
            throw toBinaryTcpApiError(err, clientOrderId);
          }
        } else {
          throw err;
        }
      }
    }

    const restClientOrderId = createTradeOrderUuid();
    try {
      await endpoints.tradingApi.cancelOrder(ticket);
      const terminalAtMs = tradeOrderNow();
      recordTradeOrderLatency({
        phase: 'placement_terminal',
        transport: 'rest',
        traceId: toTradeOrderTraceId(restClientOrderId),
        clientOrderId: restClientOrderId,
        sessionScope,
        ticket,
        ...(existingSymbol ? { symbol: existingSymbol } : {}),
        operationLabel: 'Pending order cancelled',
        journalMessage: `Pending order cancelled #${ticket}${existingSymbol ? ` ${existingSymbol}` : ''}`,
        terminalStatus: 'filled',
        totalMs: Math.max(0, terminalAtMs - intentAtMs),
      });
    } catch (error) {
      const terminalAtMs = tradeOrderNow();
      const { terminalStatus, errorCode, errorMessage } = extractTerminalErrorInfo(error);
      recordTradeOrderLatency({
        phase: 'placement_terminal',
        transport: 'rest',
        traceId: toTradeOrderTraceId(restClientOrderId),
        clientOrderId: restClientOrderId,
        sessionScope,
        ticket,
        ...(existingSymbol ? { symbol: existingSymbol } : {}),
        operationLabel: `Pending order cancel ${terminalStatus}`,
        journalMessage: `Pending order cancel ${terminalStatus} #${ticket}${existingSymbol ? ` ${existingSymbol}` : ''}`,
        terminalStatus,
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        totalMs: Math.max(0, terminalAtMs - intentAtMs),
      });
      throw error;
    }
  },

  async modifyPendingOrder(
    orderId: string | number,
    data: endpoints.ModifyPendingOrderRequest,
    options: MarketOrderPlacementOptions = {},
  ): Promise<endpoints.Order> {
    const { intentAtMs, sessionScope } = resolveActionIntentContext(options);
    const ticket = Number.parseInt(String(orderId), 10);
    if (!Number.isFinite(ticket) || ticket <= 0) throw new Error('Invalid pending order ticket');

    const storeState = useAppStore.getState() as unknown as {
      orders?: Array<Record<string, unknown>>;
      pendingOrders?: Array<Record<string, unknown>>;
    };
    const existingOrders = Array.isArray(storeState.pendingOrders)
      ? storeState.pendingOrders
      : Array.isArray(storeState.orders)
        ? storeState.orders
        : [];
    const existingOrder = existingOrders.find((o) => Number(o?.ticket ?? o?.id) === ticket);
    const existingSymbol = typeof existingOrder?.symbol === 'string'
      ? existingOrder.symbol.trim().toUpperCase()
      : '';
    const existingComment = String(existingOrder?.comment ?? '').trim();
    const hasCommentChange = data.comment !== undefined && data.comment.trim() !== existingComment;
    const hasTrailingChanges = hasNonZeroOptionalNumeric(data.trailing_stop)
      || hasNonZeroOptionalNumeric(data.trailing_step);

    const rawStopLimit = resolveRawStopLimitPrice(data);
    const rawSl = data.price_sl !== undefined ? data.price_sl : data.sl;
    const rawTp = data.price_tp !== undefined ? data.price_tp : data.tp;
    const rawExpiration = data.expiration !== undefined ? data.expiration : data.expiry;
    const hasBinarySupportedChanges = data.price !== undefined
      || rawStopLimit !== undefined
      || rawSl !== undefined
      || rawTp !== undefined
      || rawExpiration !== undefined;

    if (
      isBinaryTcpOrderEnabled()
      && Number.isSafeInteger(ticket)
      && !hasCommentChange
      && !hasTrailingChanges
      && hasBinarySupportedChanges
    ) {
      let flags = 0;
      let priceParam: number | undefined;
      let stopLimitParam: number | undefined;
      let slParam: number | undefined;
      let tpParam: number | undefined;
      let expirationParam: number | undefined;
      let clearSl = false;
      let clearTp = false;

      if (data.price !== undefined) {
        const parsedPrice = requirePendingPrice(data.price, 'Pending order price');
        flags |= BINARY_ORDER_FLAG_HAS_PRICE;
        priceParam = parsedPrice;
      }

      if (rawStopLimit !== undefined && rawStopLimit !== null && rawStopLimit !== '') {
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
        if (isClearingStopValue(rawSl)) {
          flags |= BINARY_ORDER_FLAG_CLEAR_SL;
          clearSl = true;
          slParam = 0;
        } else {
          const parsedSl = Number(rawSl);
          if (!Number.isFinite(parsedSl) || parsedSl < 0) {
            throw new Error('SL must be zero (disabled) or a positive finite number');
          }
          flags |= BINARY_ORDER_FLAG_HAS_SL;
          slParam = parsedSl;
        }
      }

      if (rawTp !== undefined) {
        if (isClearingStopValue(rawTp)) {
          flags |= BINARY_ORDER_FLAG_CLEAR_TP;
          clearTp = true;
          tpParam = 0;
        } else {
          const parsedTp = Number(rawTp);
          if (!Number.isFinite(parsedTp) || parsedTp < 0) {
            throw new Error('TP must be zero (disabled) or a positive finite number');
          }
          flags |= BINARY_ORDER_FLAG_HAS_TP;
          tpParam = parsedTp;
        }
      }

      if (rawExpiration !== undefined && rawExpiration !== null && String(rawExpiration) !== '') {
        const parsedExp = normalizePendingExpiration(rawExpiration);
        if (parsedExp > 0) {
          flags |= BINARY_ORDER_FLAG_HAS_EXPIRATION;
          expirationParam = parsedExp;
        }
      }

      if (flags !== 0) {
        const clientOrderId = createFastBinaryClientOrderId();
        const accountLogin = tryResolveTradingLogin();
        const binarySubmittedAtMs = Date.now();
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
            clearSl,
            clearTp,
            clientOrderId,
            authToken: getAuthToken(),
          });

          const effectiveClientOrderId = resp.clientOrderId || clientOrderId;
          const timing = formatBinaryExecTiming(resp.execMicros);
          let settledData: Record<string, unknown> | undefined;
          if (resp.status === 202) {
            const settled = await settleBinaryOrderCommand({
              clientOrderId: effectiveClientOrderId,
              submittedAtMs: binarySubmittedAtMs,
              accountLogin,
            });
            settledData = (settled.position ?? {}) as Record<string, unknown>;
          }

          const resolvedTicket = toFiniteNumber(
            settledData?.order_ticket ?? settledData?.ticket ?? settledData?.id,
            resp.orderTicket > 0 ? resp.orderTicket : ticket,
          );
          const settledSym = String(settledData?.symbol ?? '').trim().toUpperCase();
          const resolvedSymbol = settledSym
            || resp.symbol
            || existingSymbol;
          const resolvedSide: 'buy' | 'sell' = String(existingOrder?.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy';
          const resolvedType = typeof existingOrder?.type === 'string' && existingOrder.type ? existingOrder.type : 'buy_limit';
          const resolvedVolume = toFiniteNumber(
            settledData?.volume ?? settledData?.quantity,
            resp.volume > 0 ? resp.volume : toFiniteNumber(existingOrder?.volume ?? existingOrder?.quantity, 0),
          );
          const resolvedPrice = toFiniteNumber(
            settledData?.price ?? settledData?.price_trigger ?? settledData?.fill_price,
            resp.fillPrice > 0 ? resp.fillPrice : (priceParam ?? toFiniteNumber(existingOrder?.price, 0)),
          );
          const settledSl = settledData && (settledData.sl !== undefined || settledData.price_sl !== undefined)
            ? toFiniteNumber(settledData.sl ?? settledData.price_sl, 0)
            : undefined;
          const settledTp = settledData && (settledData.tp !== undefined || settledData.price_tp !== undefined)
            ? toFiniteNumber(settledData.tp ?? settledData.price_tp, 0)
            : undefined;
          const nextSl = rawSl !== undefined
            ? (clearSl ? 0 : (settledSl !== undefined && settledSl > 0 ? settledSl : (resp.sl > 0 ? resp.sl : (slParam ?? 0))))
            : (settledSl !== undefined ? settledSl : (resp.sl > 0 ? resp.sl : toFiniteNumber(existingOrder?.price_sl ?? existingOrder?.sl, 0)));
          const nextTp = rawTp !== undefined
            ? (clearTp ? 0 : (settledTp !== undefined && settledTp > 0 ? settledTp : (resp.tp > 0 ? resp.tp : (tpParam ?? 0))))
            : (settledTp !== undefined ? settledTp : (resp.tp > 0 ? resp.tp : toFiniteNumber(existingOrder?.price_tp ?? existingOrder?.tp, 0)));

          const terminalAtMs = resolveBinaryTerminalAtMs(resp, intentAtMs, resp.status === 202);
          const modifySubject = [
            `#${resolvedTicket}`,
            resolvedSymbol,
            resolvedPrice > 0 ? `@ ${formatCompactJournalNum(resolvedPrice)}` : '',
          ].filter(Boolean).join(' ');
          recordTradeOrderLatency({
            phase: 'placement_terminal',
            transport: 'websocket',
            traceId: toTradeOrderTraceId(effectiveClientOrderId),
            clientOrderId: effectiveClientOrderId,
            sessionScope,
            ticket: resolvedTicket,
            ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
            side: resolvedSide,
            orderSubType: resolvedType,
            ...(resolvedVolume > 0 ? { volume: resolvedVolume } : {}),
            ...(resolvedPrice > 0 ? { price: resolvedPrice } : {}),
            operationLabel: 'Pending order modified',
            journalMessage: `Pending order modified ${modifySubject}`.trim(),
            terminalStatus: 'filled',
            totalMs: Math.max(0, terminalAtMs - intentAtMs),
          });

          return {
            id: String(resolvedTicket),
            ticket: resolvedTicket,
            order_id: String(resolvedTicket),
            order_ticket: resolvedTicket,
            client_order_id: effectiveClientOrderId,
            account_login: accountLogin || toFiniteNumber(existingOrder?.account_login, 0),
            symbol: resolvedSymbol,
            type: resolvedType,
            side: resolvedSide,
            quantity: resolvedVolume,
            volume: resolvedVolume,
            price: resolvedPrice,
            fill_price: resolvedPrice,
            ...(stopLimitParam !== undefined ? {
              price_limit: stopLimitParam,
              stop_limit_price: stopLimitParam,
            } : {}),
            price_sl: nextSl,
            price_tp: nextTp,
            sl: nextSl,
            tp: nextTp,
            ...(expirationParam !== undefined ? {
              expiration: expirationParam,
              expiry: expirationParam,
            } : {}),
            status: 'pending',
            ...timing,
          } as endpoints.Order;
        } catch (err) {
          if (isBinaryTcpOrderError(err)) {
            if (isNonRetryableBinaryTcpOrderError(err)) {
              const effectiveClientOrderId = err.clientOrderId || clientOrderId;
              const terminalAtMs = readBinaryErrorTerminalAtMs(err, intentAtMs) ?? tradeOrderNow();
              const terminalStatus: TradeOrderTerminalStatus = err.status === 504 ? 'expired' : 'rejected';
              recordTradeOrderLatency({
                phase: 'placement_terminal',
                transport: 'websocket',
                traceId: toTradeOrderTraceId(effectiveClientOrderId),
                clientOrderId: effectiveClientOrderId,
                sessionScope,
                ticket,
                ...(existingSymbol ? { symbol: existingSymbol } : {}),
                operationLabel: `Pending order modify ${terminalStatus}`,
                journalMessage: `Pending order modify ${terminalStatus} #${ticket}${existingSymbol ? ` ${existingSymbol}` : ''}`,
                terminalStatus,
                ...(err.code ? { errorCode: err.code } : {}),
                ...((err.backendMessage || err.message) ? { errorMessage: err.backendMessage || err.message } : {}),
                totalMs: Math.max(0, terminalAtMs - intentAtMs),
              });
              throw toBinaryTcpApiError(err, clientOrderId);
            }
          } else {
            throw err;
          }
        }
      }
    }

    const restClientOrderId = createTradeOrderUuid();
    try {
      const updated = await endpoints.tradingApi.modifyPendingOrder(ticket, {
        price: data.price,
        price_limit: rawStopLimit !== undefined && rawStopLimit !== null && rawStopLimit !== ''
          ? Number(rawStopLimit)
          : data.price_limit,
        ...(data.time_in_force !== undefined ? { time_in_force: data.time_in_force } : {}),
        ...(data.state_version !== undefined ? { state_version: data.state_version } : {}),
        price_sl: data.price_sl ?? data.sl,
        price_tp: data.price_tp ?? data.tp,
        expiration: data.expiration !== undefined ? data.expiration : data.expiry,
        expiry: data.expiry !== undefined ? data.expiry : data.expiration,
        comment: data.comment,
        trailing_stop: data.trailing_stop,
        trailing_step: data.trailing_step,
        client_order_id: data.client_order_id || restClientOrderId,
      });
      const terminalAtMs = tradeOrderNow();
      const updatedRecord = updated as unknown as LooseRecord | undefined;
      const resolvedSymbol = String(updatedRecord?.symbol ?? existingSymbol ?? '').trim().toUpperCase();
      const resolvedPrice = toFiniteNumber(updatedRecord?.price, toFiniteNumber(data.price, 0));
      const modifySubject = [
        `#${ticket}`,
        resolvedSymbol,
        resolvedPrice > 0 ? `@ ${formatCompactJournalNum(resolvedPrice)}` : '',
      ].filter(Boolean).join(' ');
      recordTradeOrderLatency({
        phase: 'placement_terminal',
        transport: 'rest',
        traceId: toTradeOrderTraceId(restClientOrderId),
        clientOrderId: restClientOrderId,
        sessionScope,
        ticket,
        ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
        ...(resolvedPrice > 0 ? { price: resolvedPrice } : {}),
        operationLabel: 'Pending order modified',
        journalMessage: `Pending order modified ${modifySubject}`.trim(),
        terminalStatus: 'filled',
        totalMs: Math.max(0, terminalAtMs - intentAtMs),
      });
      return updated;
    } catch (error) {
      const terminalAtMs = tradeOrderNow();
      const { terminalStatus, errorCode, errorMessage } = extractTerminalErrorInfo(error);
      recordTradeOrderLatency({
        phase: 'placement_terminal',
        transport: 'rest',
        traceId: toTradeOrderTraceId(restClientOrderId),
        clientOrderId: restClientOrderId,
        sessionScope,
        ticket,
        ...(existingSymbol ? { symbol: existingSymbol } : {}),
        operationLabel: `Pending order modify ${terminalStatus}`,
        journalMessage: `Pending order modify ${terminalStatus} #${ticket}${existingSymbol ? ` ${existingSymbol}` : ''}`,
        terminalStatus,
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        totalMs: Math.max(0, terminalAtMs - intentAtMs),
      });
      throw error;
    }
  },
};

// ============================================
// Market Data API
// ============================================

export const marketApi = {
  async getSymbols(): Promise<endpoints.Symbol[]> {
    return endpoints.marketApi.getSymbols();
  },

  async getTicks(symbol: string): Promise<unknown[]> {
    return endpoints.marketApi.getTicks(symbol);
  },

  async getOHLC(
    symbol: string,
    timeframe: string,
    count = 500
  ): Promise<endpoints.Candle[]> {
    const res = await endpoints.marketApi.getCandles(symbol, { timeframe, count });
    return Array.isArray(res) ? res : res.candles;
  },
};

// ============================================
// Risk Management API
// ============================================

export const riskApi = {
  async calculateLot(
    symbol: string,
    riskPercent: number,
    slPips: number
  ): Promise<LotCalculation> {
    return apiClient.get<LotCalculation>('/risk/calculate-lot', {
      params: { symbol, riskPercent, slPips }
    });
  },

  async previewMargin(
    symbol: string,
    volume: number,
    side: string
  ): Promise<MarginPreview> {
    return apiClient.get<MarginPreview>('/risk/margin-preview', {
      params: { symbol, volume, side }
    });
  },
};

// ============================================
// Trading History API
// ============================================

export const historyApi = {
  async getLedger(): Promise<endpoints.Transaction[]> {
    return endpoints.accountApi.getTransactions();
  },

  async getEquityHistory(period?: '1d' | '7d' | '30d' | '90d' | '1y'): Promise<endpoints.EquityHistoryPoint[]> {
    return endpoints.accountApi.getEquityHistory({ period });
  },
};

// ============================================
// Configuration API
// ============================================

export const configApi = {
  async getConfig(): Promise<BrokerConfig> {
    try {
      return await apiClient.get<BrokerConfig>('/broker/config', {
        baseUrl: API_V2_BASE_URL,
        skipAuth: true,
      });
    } catch (error) {
      // Some deployments do not expose the v2 broker config yet.
      if (error instanceof ApiError && error.status === 404) {
        return {
          ...normalizeBrokerOperationalConfig(null),
        } as unknown as BrokerConfig;
      }
      throw error;
    }
  },

  async updateConfig(config: Partial<BrokerConfig>): Promise<{ success: boolean; config: BrokerConfig }> {
    return apiClient.post<{ success: boolean; config: BrokerConfig }>('/api/config', config);
  },
};

// ============================================
// Admin API
// ============================================

export const adminApi = {
  async getAccounts(): Promise<AdminAccount[]> {
    const data = await apiClient.get<AdminAccount[]>('/admin/accounts');
    return data || [];
  },

  async deposit(accountId: number, amount: number, method: string, description: string): Promise<void> {
    return apiClient.post<void>('/admin/deposit', { accountId, amount, method, description });
  },

  async withdraw(accountId: number, amount: number, method: string, description: string): Promise<void> {
    return apiClient.post<void>('/admin/withdraw', { accountId, amount, method, description });
  },

  async adjust(accountId: number, amount: number, description: string): Promise<void> {
    return apiClient.post<void>('/admin/adjust', { accountId, amount, description });
  },

  async bonus(accountId: number, amount: number, description: string): Promise<void> {
    return apiClient.post<void>('/admin/bonus', { accountId, amount, description });
  },

  async getLedgerAll(): Promise<LedgerEntry[]> {
    const data = await apiClient.get<LedgerEntry[]>('/admin/ledger');
    return data || [];
  },

  async updateAccount(accountId: number, data: Partial<AdminAccount>): Promise<void> {
    return apiClient.post<void>('/admin/account/update', { accountId, ...data });
  },

  async resetPassword(accountId: number, newPassword: string): Promise<void> {
    return apiClient.post<void>('/admin/reset-password', { accountId, newPassword });
  },

  async getSymbols(): Promise<Symbol[]> {
    const data = await apiClient.get<Symbol[]>('/admin/symbols');
    return data || [];
  },

  async toggleSymbol(symbol: string, enabled: boolean): Promise<void> {
    return apiClient.post<void>('/admin/symbols/toggle', { symbol, enabled });
  },

  async getExecutionMode(): Promise<{ mode: string; description: unknown; priceFeed: string }> {
    return apiClient.get<{ mode: string; description: unknown; priceFeed: string }>('/admin/execution-mode');
  },

  async setExecutionMode(mode: 'ABOOK' | 'BBOOK'): Promise<unknown> {
    return apiClient.post<unknown>('/admin/execution-mode', { mode });
  },

  async getLPStatus(): Promise<LPStatus[]> {
    const data = await apiClient.get<LPStatus[]>('/admin/lp-status');
    return data || [];
  },

  async restartServer(): Promise<{ success: boolean; message: string }> {
    return apiClient.post<{ success: boolean; message: string }>('/admin/restart', {});
  },
};

// ============================================
// Analytics & Export API
// ============================================

const requireExportLogin = (accountId: string): number => {
  const parsed = Number.parseInt(String(accountId || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Missing account login for export request');
  return parsed;
};

const unwrapExportRows = <T,>(payload: T[] | Record<string, unknown>, key: string): T[] => {
  if (Array.isArray(payload)) return payload;
  const rows = (payload as Record<string, unknown>)?.[key];
  return Array.isArray(rows) ? rows as T[] : [];
};

const rowTimeMs = (row: ExportRow): number => {
  const raw = row.time_ms ?? row.time ?? row.created_at ?? row.createdAt ?? row.openTime ?? row.closeTime;
  if (!raw) return 0;
  if (typeof raw === 'string' && Number.isNaN(Number(raw))) return Date.parse(raw);
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return 0;
  return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
};

const filterExportRowsByDate = <T extends ExportRow>(rows: T[], startDate: string, endDate: string): T[] => {
  const from = startDate ? Date.parse(startDate) : 0;
  const to = endDate ? Date.parse(endDate) : 0;
  if (!Number.isFinite(from) && !Number.isFinite(to)) return rows;

  return rows.filter((row) => {
    const time = rowTimeMs(row);
    if (!time) return true;
    if (Number.isFinite(from) && from > 0 && time < from) return false;
    if (Number.isFinite(to) && to > 0 && time > to + 24 * 60 * 60 * 1000 - 1) return false;
    return true;
  });
};

const csvEscape = (value: unknown): string => {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const rowsToCsv = (rows: ExportRow[]): string => {
  const columnSet = new Set<string>();
  rows.forEach((row) => {
    Object.keys(row || {}).forEach((key) => columnSet.add(key));
  });
  const columns = Array.from(columnSet);
  if (columns.length === 0) return '';
  return [
    columns.map(csvEscape).join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row?.[column])).join(',')),
  ].join('\n');
};

export const analyticsApi = {
  async exportPDF(accountId: string, startDate: string, endDate: string): Promise<Blob> {
    void accountId;
    void startDate;
    void endDate;
    throw new Error('PDF export is unavailable because this broker backend does not expose a PDF export endpoint');
  },

  async exportCSV(accountId: string, startDate: string, endDate: string, dataType: string): Promise<string> {
    const login = requireExportLogin(accountId);
    const normalizedType = String(dataType || '').trim().toLowerCase();
    let rows: ExportRow[];

    if (normalizedType === 'positions') {
      const data = await endpoints.tradingApi.getPositions(login, { limit: 500, offset: 0 });
      rows = unwrapExportRows<ExportRow>(data as ExportRow[] | Record<string, unknown>, 'positions');
    } else if (normalizedType === 'trades') {
      const data = await apiClient.get<ExportRow[] | { deals?: ExportRow[] }>(`/deals/${login}`, {
        baseUrl: API_V2_BASE_URL,
        params: { limit: 500, offset: 0 },
      });
      rows = unwrapExportRows<ExportRow>(data, 'deals');
    } else {
      throw new Error('Performance export is unavailable because this broker backend does not expose a performance export endpoint');
    }

    return rowsToCsv(filterExportRowsByDate(rows, startDate, endDate));
  },

  async getPerformanceReport(accountId: string, startDate: string, endDate: string): Promise<never> {
    void accountId;
    void startDate;
    void endDate;
    throw new Error('Performance export is unavailable because this broker backend does not expose a performance export endpoint');
  },
};

// ============================================
// Workspace API
// ============================================

export interface WorkspaceConfig {
  charts: unknown[];
  layout: unknown;
  marketWatch: unknown;
  orderPanel: unknown;
  version: string;
}

export interface Workspace {
  id?: string;
  name: string;
  description?: string;
  userId: string;
  accountId?: string;
  charts: unknown;
  layout: unknown;
  marketWatch: unknown;
  orderPanel: unknown;
  version: string;
  createdAt?: string;
  updatedAt?: string;
  thumbnail?: string;
  isDefault: boolean;
  tags?: string;
}

export interface SaveWorkspaceRequest {
  workspace: Workspace;
  overwrite: boolean;
}

export interface SaveWorkspaceResponse {
  success: boolean;
  workspaceId?: string;
  message?: string;
  conflict?: boolean;
  conflictVersion?: Workspace;
}

export const workspaceApi = {
  async saveWorkspace(workspace: Workspace, overwrite = false): Promise<SaveWorkspaceResponse> {
    return apiClient.post<SaveWorkspaceResponse>('/workspaces', { workspace, overwrite });
  },

  async loadWorkspace(workspaceId: string): Promise<{ success: boolean; workspace?: Workspace; message?: string }> {
    return apiClient.get<{ success: boolean; workspace?: Workspace; message?: string }>(`/workspaces/${workspaceId}`);
  },

  async listWorkspaces(userId: string, accountId?: string): Promise<{ success: boolean; workspaces: unknown[]; message?: string }> {
    return apiClient.get<{ success: boolean; workspaces: unknown[]; message?: string }>('/workspaces', {
      params: { userId, accountId }
    });
  },

  async deleteWorkspace(workspaceId: string): Promise<{ success: boolean; message?: string }> {
    return apiClient.delete<{ success: boolean; message?: string }>(`/workspaces/${workspaceId}`);
  },
};

// ============================================
// Notifications API
// ============================================

export interface Notification {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export const notificationsApi = {
  async getUnreadCount(): Promise<{ count: number }> {
    try {
      return await apiClient.get<{ count: number }>('/api/v2/notifications/unread-count');
    } catch {
      // Optional endpoint — silently return 0 on any error (404, 502, network, etc.)
      return { count: 0 };
    }
  },

  async getNotifications(limit = 50): Promise<Notification[]> {
    const data = await apiClient.get<Notification[]>('/api/v2/notifications', {
      params: { limit }
    });
    return data || [];
  },

  async markAsRead(notificationId: string): Promise<void> {
    return apiClient.post<void>(`/api/v2/notifications/${notificationId}/read`, { notificationId });
  },

  async markAllRead(): Promise<void> {
    return apiClient.post<void>('/api/v2/notifications/read-all', {});
  },

  async deleteNotification(notificationId: string): Promise<void> {
    return apiClient.delete<void>(`/api/v2/notifications/${notificationId}`);
  },
};

// ============================================
// Economic Calendar API
// ============================================

export const economicCalendarApi = {
  async getEvents(params?: { from?: string; to?: string; currencies?: string[]; impact?: string[] }): Promise<endpoints.EconomicEvent[]> {
    const response = await endpoints.economicCalendarApi.getEvents(params);
    return response.events || [];
  },

  async getEventsForToday(): Promise<endpoints.EconomicEvent[]> {
    const response = await endpoints.economicCalendarApi.getEventsForToday();
    return response.events || [];
  },

  async getEventsForWeek(): Promise<endpoints.EconomicEvent[]> {
    const response = await endpoints.economicCalendarApi.getEventsForWeek();
    return response.events || [];
  },
};
// ============================================
// MT5 Journal (Server Log) API
// ============================================

export interface JournalLogEntry {
  id?: number | string;
  latency_ms?: number;
  datetime_ms?: number;
  client_order_id?: number | string;
  request_id?: number | string;
  order_ticket?: number | string;
  position_ticket?: number | string;
  code: number;
  code_text: string;
  type: number;
  type_text: string;
  datetime: number;   // Unix timestamp (seconds)
  source: string;
  message: string;
}

export interface JournalQuery {
  mode?: number;   // 0=Standard, 1=Errors only, 2=Full
  type?: number;   // 0=All, 1=Config, 2=System, 3=Network, 4=History, 5=User, 6=Trade, 7=API, 8=Notify
}

export interface JournalResponse {
  count: number;
  logs: JournalLogEntry[];
}

export interface JournalRequestOptions {
  signal?: AbortSignal;
}

const isJournalRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const normalizeJournalNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeJournalText = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value);

const normalizeOptionalJournalLatency = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const normalizeOptionalJournalIdentifier = (value: unknown): number | string | undefined => {
  if (typeof value === 'string') return value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

type NormalizedTradeJournalTiming = {
  latencyMs: number;
  message: string;
};

const journalDurationToMilliseconds = (value: string, unit: string): number => {
  const duration = Number(value);
  switch (unit.toLowerCase()) {
    case 'ns': return duration / 1_000_000;
    case 'µs':
    case 'μs':
    case 'us': return duration / 1_000;
    case 's': return duration * 1_000;
    default: return duration;
  }
};

const normalizeTradeJournalTiming = (
  typeText: string,
  source: string,
  message: string,
): NormalizedTradeJournalTiming | null => {
  if (typeText.trim().toLowerCase() !== 'trade' || source.trim().toLowerCase() !== 'gateway') {
    return null;
  }

  // Compatibility for the deployed Gateway journal. Match only the known
  // terminal trade formats so unrelated durations (for example quote age in a
  // QUOTE_STALE rejection) can never be mislabeled as order latency.
  const timedTerminal = message.match(
    /^(Order\s+(?:(?:buy|sell)\s+\S+\s+\S+\s+(?:filled|executed|completed|succeeded)|close\s+\S+\s+\S+\s+\S+\s+(?:filled|executed|completed|succeeded))|Position\s+(?:.*?\s+)?opened|Close\s+(?:buy|sell)\s+\S+\s+ticket\s+\S+\s+profit\s+\S+|Modify\s+\S+\s+ticket\s+\S+)\s+in\s+(\d+(?:\.\d+)?)(ns|[µμu]s|ms|s)$/i,
  );
  if (timedTerminal) {
    return {
      message: timedTerminal[1],
      latencyMs: journalDurationToMilliseconds(timedTerminal[2], timedTerminal[3]),
    };
  }

  const timingDetail = message.match(
    /^(Timing\s+(?:(?:buy|sell)\s+\S+\s+\S+|close\s+\S+\s+\S+\s+\S+)):\s+.*\btotal\s+(\d+(?:\.\d+)?)(ns|[µμu]s|ms|s)$/i,
  );
  if (timingDetail) {
    return {
      message: timingDetail[1],
      latencyMs: journalDurationToMilliseconds(timingDetail[2], timingDetail[3]),
    };
  }

  return null;
};

export const normalizeJournalResponse = (rawPayload: unknown): JournalResponse => {
  // Accept both the bare `{ count, logs }` body and a v2 `{ data: { count, logs } }` envelope.
  const payload = isJournalRecord(rawPayload) && !Array.isArray(rawPayload.logs) && isJournalRecord(rawPayload.data)
    ? rawPayload.data
    : rawPayload;
  if (!isJournalRecord(payload) || !Array.isArray(payload.logs)) {
    throw new Error('Invalid Journal API response');
  }

  const logs = payload.logs
    .filter(isJournalRecord)
    .map((log): JournalLogEntry => {
      const id = normalizeOptionalJournalIdentifier(log.id);
      const typeText = normalizeJournalText(log.type_text);
      const source = normalizeJournalText(log.source);
      const message = normalizeJournalText(log.message);
      const compatibleTiming = normalizeTradeJournalTiming(typeText, source, message);
      const explicitLatencyMs = normalizeOptionalJournalLatency(log.latency_ms);
      const tailDurationMatch = explicitLatencyMs === undefined && typeText.trim().toLowerCase() === 'trade'
        ? message.match(/\s+in\s+(\d+(?:\.\d+)?)(ns|[µμu]s|ms|s)$/i)
        : null;
      const latencyMs = explicitLatencyMs
        ?? compatibleTiming?.latencyMs
        ?? (tailDurationMatch ? journalDurationToMilliseconds(tailDurationMatch[1], tailDurationMatch[2]) : undefined);
      const datetimeSec = normalizeJournalNumber(log.datetime);
      const rawDatetimeMs = normalizeJournalNumber(log.datetime_ms);
      const datetimeMs = rawDatetimeMs > 0 ? rawDatetimeMs : (datetimeSec > 0 ? datetimeSec * 1000 : undefined);
      const clientOrderId = normalizeOptionalJournalIdentifier(log.client_order_id);
      const requestId = normalizeOptionalJournalIdentifier(log.request_id);
      const orderTicket = normalizeOptionalJournalIdentifier(log.order_ticket);
      const positionTicket = normalizeOptionalJournalIdentifier(log.position_ticket);

      return {
        ...(id !== undefined ? { id } : {}),
        ...(latencyMs !== undefined ? { latency_ms: latencyMs } : {}),
        ...(datetimeMs !== undefined ? { datetime_ms: datetimeMs } : {}),
        ...(clientOrderId !== undefined ? { client_order_id: clientOrderId } : {}),
        ...(requestId !== undefined ? { request_id: requestId } : {}),
        ...(orderTicket !== undefined ? { order_ticket: orderTicket } : {}),
        ...(positionTicket !== undefined ? { position_ticket: positionTicket } : {}),
        code: normalizeJournalNumber(log.code),
        code_text: normalizeJournalText(log.code_text),
        type: normalizeJournalNumber(log.type),
        type_text: typeText,
        datetime: datetimeSec,
        source,
        message: explicitLatencyMs !== undefined ? message : (compatibleTiming?.message ?? message),
      };
    });
  const count = Number(payload.count);

  return {
    count: Number.isFinite(count) ? count : logs.length,
    logs,
  };
};

let journalSessionGeneration = 0;
let lastJournalAccessToken: string | null = null;
let lastJournalRefreshToken: string | null = null;
let lastJournalScopeKey = '';

const getStoredJournalRefreshToken = (): string | null => {
  return getRefreshToken();
};

const getJournalRequestContext = (
  apiRootBaseUrl: string,
  accessToken: string | null,
): ApiRequestContext | undefined => {
  if (!accessToken) return undefined;

  const refreshToken = getStoredJournalRefreshToken();
  if (!refreshToken) return undefined;

  const scopeKey = getCommittedBrokerAccountSessionScopeKey(
    getCommittedBrokerAccountSessionScope(),
  );
  if (
    accessToken !== lastJournalAccessToken
    || refreshToken !== lastJournalRefreshToken
    || scopeKey !== lastJournalScopeKey
  ) {
    journalSessionGeneration += 1;
    lastJournalAccessToken = accessToken;
    lastJournalRefreshToken = refreshToken;
    lastJournalScopeKey = scopeKey;
  }

  return Object.freeze({
    key: `journal:${journalSessionGeneration}:${scopeKey}`,
    backendOrigin: apiRootBaseUrl,
    refreshEndpoint: `${API_V2_BASE_URL.replace(/\/$/, '')}/auth/refresh`,
    refreshToken,
  });
};

export const journalApi = {
  async getLogs(
    params: JournalQuery = {},
    options: JournalRequestOptions = {},
  ): Promise<JournalResponse> {
    const apiRootBaseUrl = API_V2_BASE_URL.replace(/\/api\/v2\/?$/, '');
    const accessToken = getAuthToken();
    const payload = await apiClient.get<unknown>('/api/v2/journal', {
      ...(apiRootBaseUrl ? { baseUrl: apiRootBaseUrl, skipDynamicUrl: true } : {}),
      authToken: accessToken,
      requestContext: getJournalRequestContext(apiRootBaseUrl, accessToken),
      signal: options.signal,
      params: {
        mode: params.mode ?? 2,
        type: params.type ?? 0,
      },
      headers: {
        accept: 'application/json',
      },
    });
    return normalizeJournalResponse(payload);
  },
};



export const api = {
  auth: authApi,
  account: accountApi,
  positions: positionsApi,
  orders: ordersApi,
  market: marketApi,
  risk: riskApi,
  history: historyApi,
  config: configApi,
  admin: adminApi,
  analytics: analyticsApi,
  workspace: workspaceApi,
  notifications: notificationsApi,
  economicCalendar: economicCalendarApi,
  journal: journalApi,
};

export default api;
