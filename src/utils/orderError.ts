/**
 * Produce a user-safe message for a failed order submission.
 *
 * Raw error strings from the API client can contain internal URLs, host:port
 * pairs, query strings (which may carry a token), or low-level fetch noise.
 * This helper maps known trading codes and scrubs anything URL-shaped.
 */

import { ApiError } from '../api/client';
import { mapBrokerError } from '../api/brokerApi';
import { useAppStore } from '../store/useAppStore';
import { accountMetricProvided } from '../services/accountMetrics';
import { protectionLevelViolation } from './tradeLevelDrag';
// dealing begin
import { DEALING_OUTCOME_PENDING_CODE, DEALING_OUTCOME_PENDING_MESSAGE } from '../services/dealing/dealingRuntimeHooks';
// dealing end

const URL_LIKE_RE = /\b(?:wss?|https?):\/\/\S+/gi;
const HOST_PORT_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const ERROR_CODE_RE = /\b([A-Z][A-Z0-9_]{3,})\b/;

const LOCAL_TRADING_ERROR_MESSAGES: Record<string, string> = {
  MARKET_CLOSED: 'the market is currently closed for this symbol.',
  INSUFFICIENT_MARGIN: 'not enough free margin to open this order.',
  MARGIN_INSUFFICIENT: 'not enough free margin to open this order.',
  FREE_MARGIN_INSUFFICIENT: 'not enough free margin to open this order.',
  INSUFFICIENT_FUNDS: 'not enough funds to complete this order.',
  INSUFFICIENT_BALANCE: 'insufficient account balance to place this order.',
  ACCOUNT_BALANCE_INSUFFICIENT: 'insufficient account balance to place this order.',
  NO_MONEY: 'insufficient account balance or free margin to place this order.',
  NOT_ENOUGH_MONEY: 'insufficient account balance or free margin to place this order.',
  ZERO_BALANCE: 'account balance is zero. Please fund your account before placing an order.',
  MARGIN_CALL: 'account is in margin call — not enough free margin to open a new order.',
  STOP_OUT: 'trading is blocked due to margin stop-out.',
  INVALID_VOLUME: 'the volume is invalid. Check the lot size and try again.',
  MAX_VOLUME_EXCEEDED: 'order volume exceeds the maximum allowed lot size.',
  POSITION_LIMIT_EXCEEDED: 'maximum open position limit reached for this account.',
  INVALID_SYMBOL: 'this symbol cannot be traded on the current account.',
  SYMBOL_NOT_FOUND: 'this symbol was not found on the trading server.',
  SYMBOL_DISABLED: 'trading is disabled for this symbol on the current account.',
  INVALID_SL_TP: 'the Stop Loss or Take Profit levels are invalid.',
  INVALID_STOPS: 'the Stop Loss or Take Profit level is on the wrong side of the current market price.',
  INVALID_PRICE: 'the requested order price is invalid or out of range.',
  PRICE_CHANGED: 'market price moved outside the allowed deviation. Please try again.',
  REQUOTE: 'market price changed (requote). Please try placing the order again.',
  NO_PRICE_AVAILABLE: 'no live price is available for this symbol right now.',
  OFF_QUOTES: 'no live quote is available for this symbol right now.',
  QUOTE_STALE: 'live market quote is stale — waiting for a fresh price tick.',
  STALE_QUOTE: 'live market quote is stale — waiting for a fresh price tick.',
  SYMBOL_STALE: 'live market quote is stale — waiting for a fresh price tick.',
  NO_LIQUIDITY: 'insufficient market liquidity to fill this order right now.',
  ROUTE_NOT_FOUND: 'order routing failed — no execution route is configured for this symbol.',
  ROUTING_ERROR: 'order routing failed while forwarding the trade to the execution engine.',
  NO_ROUTE: 'no execution route is available for this symbol.',
  BINARY_TCP_UNAVAILABLE: 'trading backend server is unreachable. Check that the backend service is running and try again.',
  BINARY_TRANSPORT_UNREACHABLE: 'trading backend server is unreachable. Check that the backend service is running and try again.',
  BINARY_TUNNEL_UNAVAILABLE: 'trading backend server is unreachable. Check that the backend service is running and try again.',
  GATEWAY_UNAVAILABLE: 'trading gateway is currently unavailable. Please try again shortly.',
  SERVICE_UNAVAILABLE: 'trading backend service is currently down or unavailable.',
  BAD_GATEWAY: 'cannot reach the trading backend server (bad gateway).',
  BINARY_TCP_TIMEOUT: 'trading backend server timed out before confirming the order.',
  GATEWAY_TIMEOUT: 'trading gateway timed out while routing the order.',
  BROKER_INACTIVE: 'the selected broker server is currently offline.',
  BROKER_OFFLINE: 'the selected broker server is currently offline.',
  TRADE_DISABLED: 'trading is disabled for this symbol on the current account.',
  CLOSE_ONLY: 'this symbol is set to Close-Only mode — new positions cannot be opened.',
  LONG_ONLY: 'only BUY orders are permitted for this symbol.',
  SHORT_ONLY: 'only SELL orders are permitted for this symbol.',
  ACCOUNT_SUSPENDED: 'this trading account is suspended.',
  ACCOUNT_READ_ONLY: 'this trading account is in read-only (investor) mode.',
  INVESTOR_MODE: 'this trading account is in read-only (investor) mode.',
  ACCOUNT_NOT_FOUND: 'the trading account was not found. Please sign in again.',
  ACCOUNT_NOT_SELECTED: 'no trading account is selected. Please sign in again.',
  INVALID_LOGIN: 'the trading account login is invalid. Please sign in again.',
  UNAUTHORIZED: 'your session is no longer authorized. Please sign in again.',

  // dealing begin
  DEALER_REJECTED: 'order rejected by dealer.',
  DEALER_TIMEOUT: 'dealing request timed out.',
  TIMEOUT_REJECTED: 'dealing request timed out.',
  INSUFFICIENT_LIQUIDITY: 'insufficient liquidity for the requested volume.',
  RISK_LIMIT: 'order exceeds risk or exposure limits.',
  TOXIC_FLOW: 'order rejected by dealing policy.',
  ROBOT_REJECTED: 'order rejected by dealing policy.',
  NO_DEALER: 'no dealer is available to handle this request.',
  DEALING_NOT_ENABLED: 'dealing is not enabled on this server.',
  MARGIN_RECHECK_FAILED: 'insufficient free margin at execution confirmation.',
  CLIENT_DECLINED: 'requote was declined.',
  REQUOTE_DECLINED: 'requote was declined.',
  REQUOTE_EXPIRED: 'requote window expired.',
  GATEWAY_LOST: 'dealing request was cancelled after a gateway interruption.',
  LEGACY_MIGRATION: 'dealing request was cancelled cleanly during system upgrade.',
  DEALING_ALREADY_RESOLVED: 'this dealing request has already been resolved.',
  CUSTOM: 'order rejected by dealer.',
  // dealing end
};

const TRADER_EXPLAINED_REJECTION_CODES = new Set([
  'INSUFFICIENT_MARGIN',
  'MARGIN_INSUFFICIENT',
  'FREE_MARGIN_INSUFFICIENT',
  'INSUFFICIENT_FUNDS',
  'INSUFFICIENT_BALANCE',
  'ACCOUNT_BALANCE_INSUFFICIENT',
  'NO_MONEY',
  'NOT_ENOUGH_MONEY',
  'ZERO_BALANCE',
  'MARGIN_CALL',
  'STOP_OUT',
  'ROUTE_NOT_FOUND',
  'ROUTING_ERROR',
  'NO_ROUTE',
  'SYMBOL_NOT_FOUND',
  'NO_LIQUIDITY',
  'BINARY_TCP_UNAVAILABLE',
  'BINARY_TRANSPORT_UNREACHABLE',
  'BINARY_TUNNEL_UNAVAILABLE',
  'GATEWAY_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'BAD_GATEWAY',
  'BINARY_TCP_TIMEOUT',
  'GATEWAY_TIMEOUT',
  'BROKER_INACTIVE',
  'BROKER_OFFLINE',
  'MARKET_CLOSED',
  'OFF_QUOTES',
  'NO_PRICE_AVAILABLE',
  'QUOTE_STALE',
  'STALE_QUOTE',
  'SYMBOL_STALE',
  'TRADE_DISABLED',
  'SYMBOL_DISABLED',
  'CLOSE_ONLY',
  'LONG_ONLY',
  'SHORT_ONLY',

  // dealing begin
  'DEALER_REJECTED',
  'DEALER_TIMEOUT',
  'TIMEOUT_REJECTED',
  'INVALID_PRICE',
  'INSUFFICIENT_LIQUIDITY',
  'RISK_LIMIT',
  'TOXIC_FLOW',
  'ROBOT_REJECTED',
  'NO_DEALER',
  'DEALING_NOT_ENABLED',
  'MARGIN_RECHECK_FAILED',
  'CLIENT_DECLINED',
  'REQUOTE_DECLINED',
  'REQUOTE_EXPIRED',
  'GATEWAY_LOST',
  'LEGACY_MIGRATION',
  'DEALING_ALREADY_RESOLVED',
  'REQUOTE',
  'CUSTOM',
  // dealing end
]);

const formatMappedFailure = (mappedCode: string): string => {
  if (/^order failed:/i.test(mappedCode)) return mappedCode;
  return mappedCode === mappedCode.toLowerCase()
    ? `Order failed: ${mappedCode}`
    : `Order failed: ${mappedCode.charAt(0).toLowerCase()}${mappedCode.slice(1)}`;
};

const inferGenericRejectionReasonFromAccount = (): string | null => {
  try {
    const account = useAppStore.getState()?.account;
    if (!account) return null;
    const balance = Number(account.balance);
    // Unavailable free margin is unknown, not 0: no margin-based rejection is inferred from it.
    const freeMargin = accountMetricProvided(account, 'freeMargin') ?? Number.NaN;
    if (Number.isFinite(balance) && balance <= 0 && Number.isFinite(freeMargin) && freeMargin <= 0) {
      return 'Order failed: insufficient account balance (0.00) to place this order.';
    }
    if (Number.isFinite(freeMargin) && freeMargin <= 0) {
      return 'Order failed: not enough free margin to open this order.';
    }
  } catch {
    // ignore store read errors
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object';

const scrub = (message: string): string =>
  message
    .replace(URL_LIKE_RE, '[server]')
    .replace(HOST_PORT_RE, '[server]')
    .trim();

const readString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const extractErrorCode = (err: unknown): string => {
  if (!isRecord(err)) return '';

  const data = isRecord(err.data) ? err.data : isRecord(err.body) ? err.body : {};
  const nested = isRecord(data.error) ? data.error : {};
  const candidates = [
    data.error,
    data.code,
    data.error_code,
    data.reason,
    nested.code,
    nested.error,
    err.code,
  ];

  for (const candidate of candidates) {
    const value = readString(candidate);
    if (value && /^[A-Z][A-Z0-9_]+$/.test(value)) return value;
  }

  const message = readString(err.message);
  const match = message.match(ERROR_CODE_RE);
  return match?.[1] || '';
};

const mapKnownTradingCode = (code: string): string => {
  const normalized = code.toUpperCase();
  if (LOCAL_TRADING_ERROR_MESSAGES[normalized]) {
    return LOCAL_TRADING_ERROR_MESSAGES[normalized];
  }

  const mapped = mapBrokerError(normalized);
  return mapped === normalized ? '' : mapped;
};

const PROTECTION_REFUSAL_CODES = new Set([
  'INVALID_STOPS',
  'INVALID_SL_TP',
  'PROTECTION_VIOLATION',
  'STOPS_LEVEL_VIOLATION',
]);

/**
 * Plain-words explanation for a rejected SL/TP modify, naming the offending
 * level against the LIVE Bid/Ask (e.g. "Stop loss must be below the current
 * Bid 81,486.42 for a BUY"). Returns null when the error is not a
 * protection refusal. Unknown codes fall back to the server message —
 * never a bare "Failed".
 */
export const describeProtectionRefusal = (
  err: unknown,
  context: {
    side: 'BUY' | 'SELL';
    sl?: number | null;
    tp?: number | null;
    bid: number;
    ask: number;
    digits: number | null;
  },
): string | null => {
  const code = extractErrorCode(err);
  if (!code || !PROTECTION_REFUSAL_CODES.has(code.toUpperCase())) return null;
  const { side, sl, tp, bid, ask, digits } = context;
  const slReason = sl !== undefined && sl !== null && sl > 0
    ? protectionLevelViolation({ side, role: 'SL', price: sl, bid, ask, digits })
    : null;
  if (slReason) return slReason;
  const tpReason = tp !== undefined && tp !== null && tp > 0
    ? protectionLevelViolation({ side, role: 'TP', price: tp, bid, ask, digits })
    : null;
  if (tpReason) return tpReason;
  // Levels look valid against this quote (it moved): keep the server text.
  const structured = readStructuredBackendError(err);
  if (structured) return `${structured.message}`;
  return null;
};

export const isStaleOrderError = (err: unknown): boolean => {
  const code = extractErrorCode(err);
  if (code === 'QUOTE_STALE' || code === 'STALE_QUOTE' || code === 'SYMBOL_STALE') return true;
  const message = isRecord(err) ? readString(err.backendMessage) || readString(err.message) : readString(err);
  return /\b(?:quote|symbol)\b[^.]*\bstale\b|\bstale[ _-]+quote\b/i.test(message);
};

const readStructuredBackendError = (
  err: unknown,
): { code: string; message: string } | null => {
  if (!isRecord(err)) return null;
  const data = isRecord(err.data) ? err.data : isRecord(err.body) ? err.body : null;
  if (!data) return null;
  const nested = isRecord(data.error) ? data.error : null;
  const code = readString(
    nested?.code
      ?? data.code
      ?? data.error_code
      ?? (typeof data.error === 'string' ? data.error : ''),
  );
  const message = readString(
    nested?.message
      ?? data.message
      ?? data.error_message,
  );
  if (!code || !message || code.toUpperCase() === message.toUpperCase() || /^HTTP Error:\s*\d+$/i.test(message)) return null;
  return { code, message: scrub(message) };
};

const TOO_MANY_ORDERS_MESSAGE = 'Account busy — previous orders are still processing. Please retry.';

const BACKEND_UNREACHABLE_RE =
  /encrypted binary tcp server[^\n]*unreachable|dial tcp|connectex|connection refused|econnrefused|socket hang up|backend[^\n]*(?:down|offline|unreachable)|gateway[^\n]*(?:down|offline|unreachable)/i;

/**
 * TOO_MANY_ORDERS: the server refused the order before booking it, so nothing
 * changed and no refresh is needed. Two transports carry it: REST (HTTP 429)
 * and the trade WebSocket, whose rejection has no HTTP status but keeps the
 * backend code on a preserved order error (OrderCommandTerminalError, status
 * "rejected" or "expired").
 */
const isTooManyOrdersRefusal = (err: unknown): boolean => {
  if (!isRecord(err) || extractErrorCode(err).toUpperCase() !== 'TOO_MANY_ORDERS') return false;
  if (Number(err.status) === 429) return true;
  return err.preserveBackendOrderError === true || err.status === 'rejected' || err.status === 'expired';
};

export const formatOrderError = (err: unknown): string => {
  if (isTooManyOrdersRefusal(err)) return TOO_MANY_ORDERS_MESSAGE;
  // dealing begin
  if (isRecord(err) && err.code === DEALING_OUTCOME_PENDING_CODE) return DEALING_OUTCOME_PENDING_MESSAGE;
  // dealing end

  if (isRecord(err) && err.preserveBackendOrderError === true) {
    const code = readString(err.code);
    const backendMessage = readString(err.backendMessage);
    const upperCode = code.toUpperCase();

    if (
      upperCode === 'ORDER_REJECTED'
      && (!backendMessage || backendMessage.toUpperCase() === 'ORDER_REJECTED' || /^binary tcp order failed/i.test(backendMessage) || /^order rejected$/i.test(backendMessage))
    ) {
      return inferGenericRejectionReasonFromAccount() || 'Order failed: the order was rejected by the trading engine.';
    }

    if (upperCode && TRADER_EXPLAINED_REJECTION_CODES.has(upperCode)) {
      const mapped = mapKnownTradingCode(upperCode);
      if (mapped) {
        const base = formatMappedFailure(mapped);
        if (
          !backendMessage
          || backendMessage.toUpperCase() === upperCode
          || /^binary tcp order failed/i.test(backendMessage)
          || BACKEND_UNREACHABLE_RE.test(backendMessage)
          || backendMessage.toLowerCase() === mapped.toLowerCase()
        ) {
          return base;
        }
        const cleanDetail = scrub(backendMessage);
        return `${base.replace(/\.$/, '')} (${cleanDetail}).`;
      }
    }

    if (code && (!backendMessage || backendMessage.toUpperCase() === upperCode)) {
      const mapped = mapKnownTradingCode(upperCode);
      if (mapped) return formatMappedFailure(mapped);
      return code;
    }

    if (code && backendMessage) return `${code}: ${backendMessage}`;
    if (code || backendMessage) return code || backendMessage;
  }

  const structuredBackendError = readStructuredBackendError(err);
  if (
    structuredBackendError
    && !TRADER_EXPLAINED_REJECTION_CODES.has(structuredBackendError.code.toUpperCase())
  ) {
    return `${structuredBackendError.code}: ${structuredBackendError.message}`;
  }

  if (isRecord(err) && err.orderWasSent === true) {
    return 'Order status unknown: the request was sent, but the server did not confirm the final result. Do not place it again; check open positions and order history.';
  }

  if (err instanceof ApiError || (isRecord(err) && typeof err.status === 'number')) {
    const status = Number((err as { status: number }).status);
    const code = extractErrorCode(err);
    if (code.toUpperCase() === 'ORDER_REJECTED') {
      return inferGenericRejectionReasonFromAccount() || 'Order failed: the order was rejected by the trading engine.';
    }
    const mappedCode = code ? mapKnownTradingCode(code) : '';
    if (mappedCode) {
      return formatMappedFailure(mappedCode);
    }

    const rawDetail = readString((err as { message?: unknown }).message);
    if (BACKEND_UNREACHABLE_RE.test(rawDetail)) {
      return 'Order failed: trading backend server is unreachable. Check that the backend service is running and try again.';
    }

    if (status === 0) {
      return 'Order failed: cannot reach the trading server. Check your connection and try again.';
    }
    if (status === 401 || status === 403) {
      return 'Order failed: your session is no longer authorized. Please sign in again.';
    }
    if (status === 429) {
      return 'Order failed: too many requests. Please slow down and try again.';
    }
    if (status >= 500) {
      return 'Order failed: the trading server reported an error. Please try again shortly.';
    }

    const detail = scrub(rawDetail);
    if (!detail || /^HTTP Error:\s*\d+$/i.test(detail)) {
      return 'Order failed. Please try again.';
    }
    return `Order failed: ${detail}`;
  }

  const rawMessage =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const detail = scrub(rawMessage);

  if (BACKEND_UNREACHABLE_RE.test(rawMessage)) {
    return 'Order failed: trading backend server is unreachable. Check that the backend service is running and try again.';
  }

  if (!detail || /failed to fetch|networkerror|load failed/i.test(detail)) {
    return 'Order failed: cannot reach the trading server. Check your connection and try again.';
  }

  if (/missing account login/i.test(detail)) {
    return 'Order failed: no trading account is selected. Please sign in again.';
  }
  if (/missing symbol/i.test(detail)) {
    return 'Order failed: no symbol is selected.';
  }
  if (/volume must be greater than zero|missing order volume/i.test(detail)) {
    return 'Order failed: the volume is invalid. Check the lot size and try again.';
  }
  if (/side must be buy or sell/i.test(detail)) {
    return 'Order failed: the order side is invalid.';
  }
  if (/insufficient (?:account )?balance|zero balance|balance is zero|not enough balance|no money|not enough money/i.test(detail)) {
    return 'Order failed: insufficient account balance to place this order.';
  }
  if (/no (?:execution )?route|route not found|routing (?:error|failed)|unroutable/i.test(detail)) {
    return 'Order failed: order routing failed — no execution route is available for this symbol.';
  }

  const codeMatch = detail.match(ERROR_CODE_RE);
  if (codeMatch) {
    if (codeMatch[1].toUpperCase() === 'ORDER_REJECTED') {
      return inferGenericRejectionReasonFromAccount() || 'Order failed: the order was rejected by the trading engine.';
    }
    const mapped = mapKnownTradingCode(codeMatch[1]);
    if (mapped) return formatMappedFailure(mapped);
  }

  return `Order failed: ${detail}`;
};
