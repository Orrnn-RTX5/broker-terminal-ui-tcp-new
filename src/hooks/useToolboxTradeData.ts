import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBrokerAccountSessionScope } from './useBrokerAccountSessionScope';
import { normalizeAccountMetrics } from '../services/accountMetrics';
import type { Account, Position } from '../store/useAppStore';
import { calculateLivePositionProfit, type TradeProfitSource } from '../components/BottomDock.trade';
import { parseExposureSymbol } from '../components/BottomDock.exposure';
import { applyAccountSpreadMarkup } from '../services/accountSpreadMarkup';
import { binaryTcpMarketStream } from '../services/binaryTcpMarketStream';
import { getStoredAccountLogin, normalizePosition, type GatewayPosition } from '../api/tradeGateway';
import {
  getAccessToken,
  getCommittedBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScopeKey,
  getServerUrl,
} from '../services/brokerSession';
import {
  beginPositionsRead,
  isConfirmedClosedBySnapshot,
  isConfirmedClosedPosition,
  isConfirmedOpenPosition,
  useAppStore,
} from '../store/useAppStore';
import { TRADE_OVERLAY_CLOSE_STATE_EVENT } from '../services/tradeOverlayHistory';
import {
  requestPositionSnapshotRevalidation,
  shouldDeferEmptyPositionSnapshot,
} from '../services/positionSnapshotSafety';
import { getSessionTradeSnapshotRequests } from '../services/tradeStartupSnapshot';
import {
  MARKET_ORDER_PLACEMENT_STATE_EVENT,
  type MarketOrderPlacementState,
  type MarketOrderPlacementStateDetail,
} from '../services/marketOrderPlacementEvents';
import { resolvePositionOpenTime } from '../services/tradePositionTime';
import { readBackendNumber } from '../services/backendAccountMetrics';
import { isConfiguredBrokerEndpoint } from '../config/backendTarget.js';
import { resolveSpecDigits, stripFloatPrecisionNoise } from '../utils/symbolUtils';
import { overlayRelevantPositionsChanged } from './toolboxTickCoalescer';
import { clearLiveQuotes, setLiveQuote } from '../services/liveQuotes';
import { getLivePositionRoundedProfit } from '../services/livePositionMetrics';
import { getPositionAggregatesForArray } from '../services/livePositionAggregates';

type TradeWsState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export type ToolboxTradePosition = Omit<Position, 'time_create' | 'time_update'> & {
  account_login?: number;
  ticket?: number;
  digits?: number;
  contractSize?: number;
  contract_size?: number;
  lot_divisor?: number;
  margin?: number;
  used_margin?: number;
  margin_available?: boolean;
  hasBackendMargin?: boolean;
  hasBackendProfit?: boolean;
  hasBackendCurrentPrice?: boolean;
  profitSource?: TradeProfitSource;
  price_open?: number;
  price_current?: number;
  price_sl?: number;
  price_tp?: number;
  profit?: number;
  time_create?: number | string;
  time_update?: number | string;
  clientOrderId?: string;
  placementState?: MarketOrderPlacementState;
  placementErrorCode?: string;
  placementErrorMessage?: string;
  entryPrice?: number;
  price?: number;
  livePrice?: number;
  time_open?: number | string;
  open_time?: string;
  time?: string | number;
};

export type ToolboxTradeDebugEvent = {
  at: number;
  source: 'rest' | 'ws' | 'session';
  message: string;
};

type ToolboxTradeState = {
  account: Account | null;
  positions: ToolboxTradePosition[];
  pendingPositions: ToolboxTradePosition[];
  loading: boolean;
  error: string | null;
  login: number | null;
  restBaseUrl: string;
  wsUrl: string;
  wsState: TradeWsState;
  lastRestAt: number | null;
  lastWsAt: number | null;
  debug: ToolboxTradeDebugEvent[];
};

const INITIAL_STATE: ToolboxTradeState = {
  account: null,
  positions: [],
  pendingPositions: [],
  loading: false,
  error: null,
  login: null,
  restBaseUrl: '',
  wsUrl: '',
  wsState: 'idle',
  lastRestAt: null,
  lastWsAt: null,
  debug: [],
};

const DEBUG_LIMIT = 18;
const IMMEDIATE_POSITION_RETENTION_MS = 30_000;
const PENDING_MARKET_ORDER_ORPHAN_MS = 120_000;
export const TERMINAL_PLACEMENT_FAILURE_RETENTION_MS = 5_000;

const toNumber = (value: unknown, fallback = 0): number => {
  if (value === null || value === undefined) return fallback;
  // calc-v2 Money: { amount, currency, scale } — Number(object) is NaN → false zero balance.
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.amount !== undefined && record.amount !== null) {
      return toNumber(record.amount, fallback);
    }
  }
  const cleanStr = String(value).replace(/,/g, '');
  const next = Number(cleanStr);
  return Number.isFinite(next) ? next : fallback;
};

type RawPositionLike = Record<string, unknown>;

type RawToolboxPosition = Record<string, unknown> & {
  account_login?: number;
  login?: number;
  time_create?: number | string;
  open_time?: string;
  time?: string | number;
  time_update?: number | string;
  clientOrderId?: string;
  client_order_id?: string;
  placementState?: MarketOrderPlacementState;
  placement_state?: MarketOrderPlacementState;
  placementErrorCode?: string;
  placement_error_code?: string;
  placementErrorMessage?: string;
  placement_error_message?: string;
  comment?: string;
};

// Retained for tests; the production account path normalizes via `applyMetrics`.
// `partial` preserves the previous value for any field a packet omits.
export const normalizeToolboxAccount = (raw: unknown, previous?: Account | null): Account => (
  normalizeAccountMetrics(raw, previous, { partial: true })
);

const getPositionTicket = (position: unknown): number => {
  const record = position as RawPositionLike | null | undefined;
  return toNumber(record?.ticket ?? record?.position_id ?? record?.position_ticket ?? record?.id, 0);
};

const pickPositiveToolboxPrice = (...values: unknown[]): number => {
  for (const value of values) {
    const parsed = toNumber(value, 0);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
};

export const normalizeToolboxPosition = (raw: unknown): ToolboxTradePosition => {
  const rawRecord = (raw && typeof raw === 'object' ? raw : {}) as RawToolboxPosition;
  const normalized = normalizePosition(rawRecord as GatewayPosition) as ToolboxTradePosition;
  const ticket = getPositionTicket(rawRecord) || normalized.id;
  const openPrice = stripFloatPrecisionNoise(pickPositiveToolboxPrice(
    rawRecord.price_open,
    rawRecord.open_price,
    rawRecord.openPrice,
    rawRecord.entryPrice,
    rawRecord.fill_price,
    rawRecord.price,
    rawRecord.chartEntryPrice,
    normalized.openPrice,
  ));
  const rawCurrentPrice = readBackendNumber(
    rawRecord.price_current ?? rawRecord.current_price ?? rawRecord.currentPrice,
  );
  const hasBackendCurrentPrice = rawRecord.hasBackendCurrentPrice !== false && rawCurrentPrice !== undefined;
  const priceCurrent = hasBackendCurrentPrice ? stripFloatPrecisionNoise(rawCurrentPrice!) : 0;
  const rawProfit = rawRecord.profit ?? rawRecord.unrealized_pl ?? rawRecord.unrealizedPnL;
  const backendProfit = readBackendNumber(rawProfit);
  const hasBackendProfit = rawRecord.pnl_available !== false && rawRecord.hasBackendProfit !== false && backendProfit !== undefined;
  const profit = hasBackendProfit ? backendProfit! : 0;
  const rawMargin = readBackendNumber(rawRecord.margin ?? rawRecord.used_margin ?? normalized.margin ?? normalized.used_margin);
  const hasBackendMargin = rawRecord.hasBackendMargin !== false
    && rawRecord.margin_available !== false
    && rawMargin !== undefined
    && rawMargin >= 0;
  const chartEntryTime = typeof rawRecord.chartEntryTime === 'string' && rawRecord.chartEntryTime.trim()
    ? rawRecord.chartEntryTime.trim()
    : (typeof normalized.chartEntryTime === 'string' && normalized.chartEntryTime.trim()
      ? normalized.chartEntryTime.trim()
      : undefined);
  const rawChartEntryPrice = pickPositiveToolboxPrice(rawRecord.chartEntryPrice, normalized.chartEntryPrice);
  const chartEntryPrice = rawChartEntryPrice > 0 ? stripFloatPrecisionNoise(rawChartEntryPrice) : undefined;
  const openTime = resolvePositionOpenTime(
    rawRecord,
    chartEntryTime || normalized.openTime || (typeof normalized.time_create === 'string' ? normalized.time_create : undefined),
  );
  const digits = resolveSpecDigits(rawRecord.digits, normalized.digits);
  const sl = stripFloatPrecisionNoise(toNumber(rawRecord.price_sl ?? rawRecord.sl ?? normalized.sl, normalized.sl));
  const tp = stripFloatPrecisionNoise(toNumber(rawRecord.price_tp ?? rawRecord.tp ?? normalized.tp, normalized.tp));

  return {
    ...normalized,
    id: ticket,
    ticket,
    account_login: rawRecord.account_login ?? rawRecord.login ?? normalized.account_login,
    ...(digits !== null ? { digits } : {}),
    contractSize: toNumber(rawRecord.contractSize ?? rawRecord.contract_size ?? normalized.contractSize, 0) || undefined,
    contract_size: toNumber(rawRecord.contract_size ?? rawRecord.contractSize ?? normalized.contract_size, 0) || undefined,
    lot_divisor: toNumber(rawRecord.lot_divisor ?? rawRecord.lotDivisor ?? (normalized as { lot_divisor?: unknown }).lot_divisor, 0) || undefined,
    openPrice,
    price_open: openPrice,
    open_price: openPrice,
    currentPrice: priceCurrent,
    hasBackendCurrentPrice,
    price_current: priceCurrent,
    current_price: priceCurrent,
    openTime,
    ...(chartEntryPrice !== undefined ? { chartEntryPrice } : {}),
    ...(chartEntryTime !== undefined ? { chartEntryTime } : {}),
    ...(hasBackendMargin ? {
      margin: rawMargin,
      used_margin: rawMargin,
      margin_available: true,
      hasBackendMargin: true,
    } : (rawRecord.margin_available === false || rawRecord.hasBackendMargin === false ? {
      margin_available: false,
      hasBackendMargin: false,
    } : {})),
    time_create: rawRecord.time_create ?? normalized.time_create ?? openTime,
    open_time: rawRecord.open_time ?? openTime,
    time: rawRecord.time ?? openTime,
    sl,
    tp,
    price_sl: sl,
    price_tp: tp,
    profit,
    unrealizedPnL: profit,
    hasBackendProfit,
    swap: toNumber(rawRecord.swap ?? rawRecord.storage ?? normalized.swap, normalized.swap),
    commission: toNumber(rawRecord.commission ?? normalized.commission, normalized.commission),
    time_update: rawRecord.time_update ?? normalized.time_update,
    clientOrderId: rawRecord.clientOrderId ?? rawRecord.client_order_id,
    placementState: rawRecord.placementState ?? rawRecord.placement_state,
    placementErrorCode: rawRecord.placementErrorCode ?? rawRecord.placement_error_code,
    placementErrorMessage: rawRecord.placementErrorMessage ?? rawRecord.placement_error_message,
    comment: rawRecord.comment ?? normalized.comment ?? '',
  };
};

const positionSignature = (position: ToolboxTradePosition): string => [
  position.id,
  position.account_login ?? '',
  position.symbol,
  position.side,
  position.volume,
  position.digits ?? '',
  position.contractSize ?? position.contract_size ?? '',
  position.lot_divisor ?? '',
  position.margin ?? position.used_margin ?? '',
  position.hasBackendMargin ?? '',
  position.margin_available ?? '',
  position.hasBackendProfit ?? '',
  position.hasBackendCurrentPrice ?? '',
  position.price_open ?? position.openPrice,
  position.price_current ?? position.currentPrice,
  position.price_sl ?? position.sl,
  position.price_tp ?? position.tp,
  position.swap,
  position.commission,
  position.profit ?? position.unrealizedPnL,
  position.time_create ?? '',
  position.time_update ?? '',
  position.chartEntryPrice ?? '',
  position.chartEntryTime ?? '',
  position.clientOrderId ?? '',
  position.placementState ?? '',
  position.placementErrorCode ?? '',
  position.placementErrorMessage ?? '',
  position.comment ?? '',
  position.state_version ?? '',
  position.protection_version ?? '',
  position.price_time_msc ?? '',
].join(':');

const positionsSignature = (positions: ToolboxTradePosition[]): string => (
  positions.map(positionSignature).join('|')
);

const memoPositionsSignature = (
  cache: { current: { list: ToolboxTradePosition[]; sig: string } | null },
  positions: ToolboxTradePosition[],
): string => {
  const hit = cache.current;
  if (hit && hit.list === positions) return hit.sig;
  const sig = positionsSignature(positions);
  cache.current = { list: positions, sig };
  return sig;
};

const accountSignature = (account: Account | null): string => (
  account
    ? [
      account.balance,
      account.equity,
      account.margin,
      account.freeMargin,
      account.marginLevel,
      account.unrealizedPL,
      account.credit ?? 0,
      account.hasBackendEquity ?? '',
      account.hasBackendBalance ?? '',
      account.hasBackendMargin ?? '',
      account.hasBackendUnrealizedPL ?? '',
      account.hasBackendCredit ?? '',
      account.hasBackendFreeMargin ?? '',
      account.hasBackendMarginLevel ?? '',
      account.currency,
    ].join(':')
    : ''
);

const isFullPosition = (raw: unknown): boolean => {
  const record = raw as RawPositionLike | null | undefined;
  return (
    Boolean(record?.symbol) &&
    toNumber(record?.volume_lots ?? record?.volume ?? record?.quantity, 0) > 0 &&
    toNumber(record?.price_open ?? record?.open_price ?? record?.openPrice, 0) > 0
  );
};

const mergePatchIntoPosition = (
  existing: ToolboxTradePosition,
  raw: unknown,
): ToolboxTradePosition => {
  const record = (raw && typeof raw === 'object' ? raw : null) as RawToolboxPosition | null;
  const next: ToolboxTradePosition = { ...existing };
  const pricePatch = readBackendNumber(record?.price_current ?? record?.current_price ?? record?.currentPrice);
  const profitPatch = readBackendNumber(record?.profit ?? record?.unrealized_pl ?? record?.unrealizedPnL);
  const hasPricePatch = record?.price_current !== undefined || record?.current_price !== undefined
    || record?.currentPrice !== undefined || record?.hasBackendCurrentPrice !== undefined;
  const hasProfitPatch = record?.profit !== undefined || record?.unrealized_pl !== undefined
    || record?.unrealizedPnL !== undefined || record?.hasBackendProfit !== undefined;

  if (hasPricePatch) {
    const supplied = record?.hasBackendCurrentPrice !== false && pricePatch !== undefined;
    const price = supplied ? pricePatch! : 0;
    next.currentPrice = price;
    next.price_current = price;
    next.current_price = price;
    next.hasBackendCurrentPrice = supplied;
  }

  if (hasProfitPatch) {
    const supplied = record?.hasBackendProfit !== false && profitPatch !== undefined;
    const profit = supplied ? profitPatch! : 0;
    next.unrealizedPnL = profit;
    next.profit = profit;
    next.hasBackendProfit = supplied;
  }

  const marginPatch = readBackendNumber(record?.margin ?? record?.used_margin);
  const hasMarginPatch = record?.margin !== undefined || record?.used_margin !== undefined
    || record?.margin_available !== undefined || record?.hasBackendMargin !== undefined;
  if (hasMarginPatch) {
    const supplied = record?.hasBackendMargin !== false && record?.margin_available !== false
      && marginPatch !== undefined && marginPatch >= 0;
    if (supplied) {
      next.margin = marginPatch!;
      next.used_margin = marginPatch!;
      next.margin_available = true;
      next.hasBackendMargin = true;
    } else if (record?.margin_available === false || record?.hasBackendMargin === false) {
      delete next.margin;
      delete next.used_margin;
      next.margin_available = false;
      next.hasBackendMargin = false;
    }
  }

  if (record && (record.swap !== undefined || record.storage !== undefined)) {
    next.swap = toNumber(record.swap ?? record.storage, existing.swap);
  }

  if (record && record.commission !== undefined) {
    next.commission = toNumber(record.commission, existing.commission);
  }

  if (record && (record.price_sl !== undefined || record.sl !== undefined)) {
    const sl = toNumber(record.price_sl ?? record.sl, existing.sl);
    next.sl = sl;
    next.price_sl = sl;
  }

  if (record && (record.price_tp !== undefined || record.tp !== undefined)) {
    const tp = toNumber(record.price_tp ?? record.tp, existing.tp);
    next.tp = tp;
    next.price_tp = tp;
  }

  if (record && (record.time_update !== undefined || record.time !== undefined)) {
    next.time_update = record.time_update ?? record.time;
  }

  return next;
};

export const replaceToolboxPositions = (
  current: ToolboxTradePosition[],
  rawPositions: unknown[],
): ToolboxTradePosition[] => {
  const previousByTicket = new Map(current.map((position) => [position.id, position]));
  const nextByTicket = new Map<number, ToolboxTradePosition>();

  rawPositions.forEach((raw) => {
    const ticket = getPositionTicket(raw);
    if (ticket <= 0) return;

    const previous = previousByTicket.get(ticket);
    const normalized = normalizeToolboxPosition(raw);
    const hasRenderableIdentity = Boolean(
      String(normalized.symbol ?? '').trim()
      && toNumber(normalized.volume, 0) > 0,
    );

    // Sparse updates may patch a known row, but cannot create a blank row.
    // This keeps the Trade footer stable while REST and WS snapshots race.
    const candidate = hasRenderableIdentity
      ? normalized
      : previous
        ? mergePatchIntoPosition(previous, raw)
        : null;
    if (
      !candidate
      || !String(candidate.symbol ?? '').trim()
      || !(toNumber(candidate.volume, 0) > 0)
    ) return;

    nextByTicket.set(
      ticket,
      previous && positionSignature(previous) === positionSignature(candidate)
        ? previous
        : candidate,
    );
  });

  return Array.from(nextByTicket.values()).sort((a, b) => b.id - a.id);
};

export const patchToolboxPositions = (
  current: ToolboxTradePosition[],
  rawUpdates: unknown[],
  closeTickets: number[] = [],
): ToolboxTradePosition[] => {
  let next = current;
  const closeSet = new Set(closeTickets.filter(Boolean));

  if (closeSet.size > 0) {
    next = next.filter((position) => !closeSet.has(position.id));
  }

  for (const raw of rawUpdates) {
    const ticket = getPositionTicket(raw);
    if (!ticket) continue;

    const index = next.findIndex((position) => position.id === ticket);
    if (index < 0) {
      if (isFullPosition(raw)) {
        const created = normalizeToolboxPosition(raw);
        next = [created, ...next];
      }
      continue;
    }

    const patched = mergePatchIntoPosition(next[index], raw);
    if (positionSignature(patched) !== positionSignature(next[index])) {
      next = next.map((position, itemIndex) => itemIndex === index ? patched : position);
    }
  }

  return next;
};

export type ImmediateToolboxPositionDetail = {
  login?: number | string;
  position?: unknown;
  sessionScope?: string;
};

export const applyImmediateToolboxPosition = (
  current: ToolboxTradePosition[],
  detail: ImmediateToolboxPositionDetail | null | undefined,
  activeLogin: number,
  activeSessionScope: string,
): ToolboxTradePosition[] => {
  const eventLogin = toNumber(detail?.login, 0);
  if (
    !detail?.position
    || eventLogin !== activeLogin
    || !detail.sessionScope
    || detail.sessionScope !== activeSessionScope
  ) {
    return current;
  }

  return patchToolboxPositions(current, [detail.position]);
};

export const applyMarketOrderPlacementState = (
  current: ToolboxTradePosition[],
  detail: MarketOrderPlacementStateDetail | null | undefined,
  activeLogin: number,
  activeSessionScope: string,
): ToolboxTradePosition[] => {
  if (
    !detail
    || toNumber(detail.login, 0) !== activeLogin
    || !detail.sessionScope
    || detail.sessionScope !== activeSessionScope
    || !detail.clientOrderId
  ) {
    return current;
  }

  const existingProvisional = current.find((position) => (
    position.clientOrderId === detail.clientOrderId
    || position.id === detail.provisionalTicket
  ));
  const withoutProvisional = current.filter((position) => (
    position.clientOrderId !== detail.clientOrderId
    && position.id !== detail.provisionalTicket
  ));
  const removedProvisional = withoutProvisional.length !== current.length;

  if (detail.status === 'failed' || detail.status === 'rejected' || detail.status === 'expired') {
    return removedProvisional ? withoutProvisional : current;
  }

  const provisionalStatus = ['pending', 'accepted', 'processing'].includes(detail.status);
  if (provisionalStatus) {
    const source = detail.position && typeof detail.position === 'object'
      ? detail.position as Record<string, unknown>
      : existingProvisional;
    if (!source) return current;

    const rawPosition: Record<string, unknown> = {
      ...source,
      // Later events reuse a normalized row. Replace both aliases so its old
      // camelCase state cannot mask an accepted or terminal wire status.
      clientOrderId: detail.clientOrderId,
      client_order_id: detail.clientOrderId,
      placementState: detail.status,
      placement_state: detail.status,
      placementErrorCode: detail.errorCode,
      placement_error_code: detail.errorCode,
      placementErrorMessage: detail.errorMessage,
      placement_error_message: detail.errorMessage,
    };
    const ticket = getPositionTicket(rawPosition);
    const volume = toNumber(rawPosition.volume_lots ?? rawPosition.volume ?? rawPosition.quantity, 0);
    if (!ticket || !rawPosition.symbol || !(volume > 0)) {
      return removedProvisional ? withoutProvisional : current;
    }
    return [normalizeToolboxPosition(rawPosition), ...withoutProvisional];
  }

  if (!detail.position || typeof detail.position !== 'object') {
    return removedProvisional ? withoutProvisional : current;
  }

  const rawPosition: Record<string, unknown> = {
    ...(detail.position as Record<string, unknown>),
    clientOrderId: detail.clientOrderId,
    client_order_id: detail.clientOrderId,
    placementState: detail.status,
    placement_state: detail.status,
    placementErrorCode: undefined,
    placement_error_code: undefined,
    placementErrorMessage: undefined,
    placement_error_message: undefined,
  };

  return patchToolboxPositions(withoutProvisional, [rawPosition]);
};

export type RetainedImmediateToolboxPosition = {
  position: ToolboxTradePosition;
  expiresAt: number;
};

type OptimisticallyClosedToolboxPosition = {
  position: ToolboxTradePosition;
  status: 'pending' | 'confirmed';
  expiresAt: number;
};

export const mergeRetainedImmediateToolboxPositions = (
  snapshot: ToolboxTradePosition[],
  retained: RetainedImmediateToolboxPosition[],
  now = Date.now(),
): ToolboxTradePosition[] => {
  const byTicket = new Map(snapshot.map((position) => [position.id, position]));
  retained.forEach(({ position, expiresAt }) => {
    if (expiresAt > now && !byTicket.has(position.id)) {
      byTicket.set(position.id, position);
    }
  });
  return Array.from(byTicket.values()).sort((a, b) => {
    const aPending = a.placementState === 'pending';
    const bPending = b.placementState === 'pending';
    if (aPending !== bPending) return aPending ? -1 : 1;
    return b.id - a.id;
  });
};

export const patchPositionsFromTick = (
  current: ToolboxTradePosition[],
  tick: unknown,
): ToolboxTradePosition[] => {
  const t = (tick && typeof tick === 'object' ? tick : null) as {
    symbol?: unknown;
    bid?: unknown;
    ask?: unknown;
    time?: unknown;
    timestamp?: unknown;
  } | null;
  if (!t) return current;
  const symbol = String(t.symbol ?? '').toUpperCase();
  if (!symbol) return current;

  let changed = false;
  const tickTime = toNumber(t.time ?? t.timestamp, 0);
  const next = current.map((position) => {
    if (String(position.symbol ?? '').toUpperCase() !== symbol) return position;

    const bid = toNumber(t.bid, 0);
    const ask = toNumber(t.ask, bid);
    const isSell = String(position.side ?? '').toUpperCase() === 'SELL';
    const currentPrice = isSell ? ask : bid;
    if (!currentPrice || (currentPrice === position.currentPrice && position.hasBackendCurrentPrice && position.hasBackendProfit)) {
      return position;
    }

    const candidate: ToolboxTradePosition = {
      ...position,
      currentPrice,
      price_current: currentPrice,
      current_price: currentPrice,
      hasBackendCurrentPrice: true,
      time_update: tickTime || position.time_update,
    };

    const rawLiveProfit = calculateLivePositionProfit(candidate);
    if (rawLiveProfit !== null && Number.isFinite(rawLiveProfit)) {
      const parsedSym = parseExposureSymbol(position.symbol);
      const quoteAsset = parsedSym?.quote ?? 'USD';
      const baseAsset = parsedSym?.base ?? '';
      let liveProfit: number | null = null;
      if (quoteAsset === 'USD' || quoteAsset === 'USDT' || quoteAsset === 'USDC') {
        liveProfit = rawLiveProfit;
      } else if (baseAsset === 'USD' && currentPrice > 0) {
        liveProfit = rawLiveProfit / currentPrice;
      }
      if (liveProfit !== null && Number.isFinite(liveProfit)) {
        const roundedProfit = Math.round(liveProfit * 100) / 100;
        candidate.profit = roundedProfit;
        candidate.unrealizedPnL = roundedProfit;
        candidate.hasBackendProfit = true;
      }
    }

    changed = true;
    return candidate;
  });

  return changed ? next : current;
};

const arrayFrom = (payload: unknown, key?: string): RawToolboxPosition[] => {
  if (Array.isArray(payload)) return payload as RawToolboxPosition[];
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  if (key && Array.isArray(record[key])) return record[key] as RawToolboxPosition[];
  if (Array.isArray(record.data)) return record.data as RawToolboxPosition[];
  if (record.data && typeof record.data === 'object') return arrayFrom(record.data, key);
  if (Array.isArray(record.items)) return record.items as RawToolboxPosition[];
  if (Array.isArray(record.results)) return record.results as RawToolboxPosition[];
  return [];
};

const readLogin = (): number | null => {
  const storeState = useAppStore.getState();
  const storeLogin = Number.parseInt(String(storeState.accountId ?? ''), 10);
  if (storeState.isAuthenticated && Number.isFinite(storeLogin) && storeLogin > 0) {
    return storeLogin;
  }

  const direct = getStoredAccountLogin();
  if (direct) return direct;
  return Number.isFinite(storeLogin) && storeLogin > 0 ? storeLogin : null;
};

const getBrokerRestBaseUrl = (): string => {
  const serverUrl = getServerUrl();
  return serverUrl ? `${serverUrl.replace(/\/+$/, '')}/api/v2` : '';
};

type WarmTradeStoreSnapshot = Pick<
  ReturnType<typeof useAppStore.getState>,
  'isAuthenticated' | 'accountId' | 'account' | 'positions'
>;

type WarmTradeSessionScope = {
  authenticated: boolean;
  accountId: string | null;
};

export const selectWarmToolboxTradeSnapshot = (
  storeSnapshot: WarmTradeStoreSnapshot,
  activeLogin: number | null,
  sessionScope: WarmTradeSessionScope,
): Pick<ToolboxTradeState, 'account' | 'positions'> | null => {
  const storeLogin = Number.parseInt(String(storeSnapshot.accountId ?? ''), 10);
  const scopeLogin = Number.parseInt(String(sessionScope.accountId ?? ''), 10);
  if (
    !activeLogin
    || !storeSnapshot.isAuthenticated
    || !sessionScope.authenticated
    || storeLogin !== activeLogin
    || scopeLogin !== activeLogin
  ) {
    return null;
  }

  return {
    account: storeSnapshot.account,
    positions: replaceToolboxPositions([], storeSnapshot.positions as ToolboxTradePosition[]),
  };
};

const createInitialToolboxTradeState = (): ToolboxTradeState => {
  const login = readLogin();
  const restBaseUrl = getBrokerRestBaseUrl();
  const warmSnapshot = selectWarmToolboxTradeSnapshot(
    useAppStore.getState(),
    login,
    getCommittedBrokerAccountSessionScope(),
  );

  return {
    ...INITIAL_STATE,
    login,
    restBaseUrl,
    account: warmSnapshot?.account ?? null,
    positions: warmSnapshot?.positions ?? [],
    loading: Boolean(login && restBaseUrl && !warmSnapshot),
  };
};

const buildUrl = (baseUrl: string, path: string, params?: Record<string, string | number>): string => {
  const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  Object.entries(params ?? {}).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });
  return url.toString();
};

async function requestBrokerJson<T>(
  baseUrl: string,
  path: string,
  params: Record<string, string | number> | undefined,
  signal: AbortSignal,
): Promise<T> {
  const token = getAccessToken();
  if (!baseUrl) throw new Error('Missing broker server_url. Trade tab will not fall back to localhost.');
  if (!token) throw new Error('Missing auth token');

  const url = buildUrl(baseUrl, path, params);
  if (!isConfiguredBrokerEndpoint(url)) throw new Error('Trade endpoint does not belong to this broker deployment.');
  const response = await fetch(url, {
    signal,
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const errorRecord = body && typeof body === 'object'
      ? (body as { message?: unknown; error?: unknown })
      : null;
    const message = errorRecord?.message ?? errorRecord?.error ?? `HTTP ${response.status}`;
    throw new Error(`${message} (${response.status})`);
  }

  return body as T;
}

export function useToolboxTradeData() {
  const storeAccountId = useAppStore((state) => state.accountId);
  const storeAuthToken = useAppStore((state) => state.authToken);
  const brokerAccountScope = useBrokerAccountSessionScope();
  const [state, setState] = useState<ToolboxTradeState>(createInitialToolboxTradeState);

  const accountRef = useRef<Account | null>(state.account);
  const positionsRef = useRef<ToolboxTradePosition[]>(state.positions);
  // Symbols with open positions: only their ticks are written to the live quote cache.
  const heldSymbolsRef = useRef<Set<string>>(getPositionAggregatesForArray(state.positions).heldSymbols);
  const positionsSigRef = useRef<{ list: ToolboxTradePosition[]; sig: string } | null>(null);
  const storeSigRef = useRef<{ list: ToolboxTradePosition[]; sig: string } | null>(null);
  const retainedImmediatePositionsRef = useRef<Map<number, RetainedImmediateToolboxPosition>>(new Map());
  const pendingMarketOrdersRef = useRef<Map<string, RetainedImmediateToolboxPosition>>(new Map());
  const pendingPlacementTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const optimisticallyClosedPositionsRef = useRef<Map<number, OptimisticallyClosedToolboxPosition>>(new Map());
  const placementSessionScopeRef = useRef(getCommittedBrokerAccountSessionScopeKey(
    getCommittedBrokerAccountSessionScope(),
  ));
  const refreshSeqRef = useRef(0);
  const activeRefreshControllerRef = useRef<AbortController | null>(null);

  const sessionKey = useMemo(() => {
    return [
      storeAccountId ?? '',
      storeAuthToken ?? '',
      brokerAccountScope,
      getServerUrl(),
      getAccessToken() ?? '',
      readLogin() ?? '',
    ].join('|');
  }, [brokerAccountScope, storeAccountId, storeAuthToken]);
  const stateSessionKeyRef = useRef(sessionKey);

  const pushDebug = useCallback((event: ToolboxTradeDebugEvent) => {
    setState((prev) => ({
      ...prev,
      debug: [event, ...prev.debug].slice(0, DEBUG_LIMIT),
    }));
  }, []);

  const commitAccount = useCallback((account: Account | null) => {
    const previousSig = accountSignature(accountRef.current);
    const nextSig = accountSignature(account);
    accountRef.current = account;
    if (previousSig === nextSig) return;
    setState((prev) => ({ ...prev, account }));
  }, []);

  const commitPositions = useCallback((
    positions: ToolboxTradePosition[],
    read?: { readStartedAt?: number; unlistedTickets?: readonly number[]; touchedTickets?: readonly number[] },
  ) => {
    const previousPositions = positionsRef.current;
    // Signatures are memoised per array identity: the previous list and the store list were
    // signed when they were committed, so a tick commit signs only the new list (once).
    const previousSig = memoPositionsSignature(positionsSigRef, previousPositions);
    positions = positions.filter((position) => !isConfirmedClosedPosition(position.id));
    let nextSig = positionsSignature(positions);
    const storePositions = Array.isArray(useAppStore.getState().positions)
      ? useAppStore.getState().positions as ToolboxTradePosition[]
      : [];
    if (memoPositionsSignature(storeSigRef, storePositions) !== nextSig || (read?.touchedTickets?.length ?? 0) > 0) {
      const submitted = positions;
      useAppStore.getState().setPositions(positions as Position[], {
        removedTickets: [...optimisticallyClosedPositionsRef.current.keys()],
        readStartedAt: read?.readStartedAt,
        unlistedTickets: read?.unlistedTickets,
        touchedTickets: read?.touchedTickets,
      });
      positions = useAppStore.getState().positions as ToolboxTradePosition[];
      if (positions !== submitted) nextSig = positionsSignature(positions);
      storeSigRef.current = { list: positions, sig: nextSig };
      // Only structural changes (rows added/removed, side, volume, open price, SL/TP) need an
      // explicit overlay refresh; pure current-price/profit updates are drawn by the live path.
      if (typeof window !== 'undefined' && overlayRelevantPositionsChanged(previousPositions, positions)) {
        window.dispatchEvent(new CustomEvent('rtx:refresh-trade-overlay'));
      }
    }
    positionsRef.current = positions;
    positionsSigRef.current = { list: positions, sig: nextSig };
    heldSymbolsRef.current = getPositionAggregatesForArray(positions).heldSymbols;
    if (previousSig === nextSig) return;
    setState((prev) => ({ ...prev, positions }));
  }, []);

  const refresh = useCallback(async () => {
    const login = readLogin();
    const restBaseUrl = getBrokerRestBaseUrl();
    const seq = ++refreshSeqRef.current;
    activeRefreshControllerRef.current?.abort();
    const controller = new AbortController();
    const metricsScope = getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope());
    const positionsReadStartedAt = beginPositionsRead();
    const startedPositions = useAppStore.getState().positions;
    const startedAuthToken = useAppStore.getState().authToken;
    activeRefreshControllerRef.current = controller;

    setState((prev) => ({
      ...prev,
      login,
      restBaseUrl,
      loading: positionsRef.current.length === 0,
      error: null,
    }));

    if (!login || !restBaseUrl) {
      const message = !login
        ? 'No account login found for Trade tab'
        : 'Missing broker server_url. Trade tab will not fall back to localhost.';
      setState((prev) => ({ ...prev, loading: false, error: message }));
      pushDebug({ at: Date.now(), source: 'session', message });
      return;
    }

    try {
      // Start every read together, but never hold open-position rows behind
      // account or optional metrics latency.
      const startupRequests = getSessionTradeSnapshotRequests(login);
      const metricsRequestedAt = Date.now();
      const metricsPromise = requestBrokerJson<unknown>(
        restBaseUrl,
        `/account/${login}/metrics`,
        undefined,
        controller.signal,
      ).catch(() => null);
      const positionsResult = await startupRequests.positionsResultPromise;

      if (seq !== refreshSeqRef.current || controller.signal.aborted) return;
      if (useAppStore.getState().authToken !== startedAuthToken) return;
      if (metricsScope !== getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope())) return;
      if (positionsResult.status === 'rejected') {
        throw positionsResult.reason;
      }
      const positionsBody = positionsResult.value;
      // REST rows are the complete list. A live row the store replaced during this read is
      // newer than the REST row for that ticket. A ticket the read omitted is never re-added here.
      const livePositions = useAppStore.getState().positions;
      const startedById = new Map(startedPositions.map((position) => [position.id, position]));
      const liveById = new Map(livePositions.map((position) => [position.id, position]));
      const rawPositions = arrayFrom(positionsBody, 'positions').map((raw): RawToolboxPosition => {
        const live = liveById.get(getPositionTicket(raw));
        if (!live || live === startedById.get(live.id)) return raw;
        return {
          ...live,
          ...(live.margin === undefined && raw?.margin !== undefined ? {
            margin: raw.margin,
            used_margin: raw.used_margin ?? raw.margin,
            margin_available: raw.margin_available,
            hasBackendMargin: raw.hasBackendMargin,
          } : {}),
          ...(live.hasBackendProfit === false && raw?.pnl_available !== false && raw?.hasBackendProfit !== false && (raw?.profit !== undefined || raw?.unrealized_pl !== undefined || raw?.unrealizedPnL !== undefined) ? {
            profit: raw.profit ?? raw.unrealized_pl ?? raw.unrealizedPnL,
            unrealized_pl: raw.unrealized_pl ?? raw.profit ?? raw.unrealizedPnL,
            unrealizedPnL: raw.unrealizedPnL ?? raw.profit ?? raw.unrealized_pl,
            hasBackendProfit: true,
            pnl_available: raw.pnl_available ?? true,
          } : {}),
          ...(live.hasBackendCurrentPrice === false && raw?.pnl_available !== false && raw?.hasBackendCurrentPrice !== false && (raw?.price_current !== undefined || raw?.current_price !== undefined || raw?.currentPrice !== undefined) ? {
            price_current: raw.price_current ?? raw.current_price ?? raw.currentPrice,
            current_price: raw.current_price ?? raw.price_current ?? raw.currentPrice,
            currentPrice: raw.currentPrice ?? raw.price_current ?? raw.current_price,
            hasBackendCurrentPrice: true,
          } : {}),
        };
      });
      const rawPositionTickets = new Set(rawPositions.map(getPositionTicket).filter(Boolean));
      const now = Date.now();
      const confirmedClientOrderIds = new Set(rawPositions
        .map((position) => String(position?.client_order_id ?? position?.clientOrderId ?? '').trim())
        .filter(Boolean));
      pendingMarketOrdersRef.current.forEach(({ expiresAt }, clientOrderId) => {
        if (expiresAt <= now || confirmedClientOrderIds.has(clientOrderId)) {
          pendingMarketOrdersRef.current.delete(clientOrderId);
        }
      });
      optimisticallyClosedPositionsRef.current.forEach((entry, ticket) => {
        if (entry.expiresAt <= now || (entry.status === 'confirmed' && !rawPositionTickets.has(ticket))) {
          optimisticallyClosedPositionsRef.current.delete(ticket);
        }
      });
      const visibleRawPositions = rawPositions.filter(
        (position) => !optimisticallyClosedPositionsRef.current.has(getPositionTicket(position)),
      );
      const snapshot = replaceToolboxPositions(positionsRef.current, visibleRawPositions);
      const snapshotTickets = new Set(snapshot.map((position) => position.id));
      retainedImmediatePositionsRef.current.forEach(({ expiresAt }, ticket) => {
        if (
          expiresAt <= now
          || snapshotTickets.has(ticket)
          || isConfirmedOpenPosition(ticket)
          || isConfirmedClosedPosition(ticket)
          || isConfirmedClosedBySnapshot(ticket)
        ) {
          retainedImmediatePositionsRef.current.delete(ticket);
        }
      });
      commitPositions(mergeRetainedImmediateToolboxPositions(
        snapshot,
        Array.from(retainedImmediatePositionsRef.current.values()),
        now,
      ), {
        readStartedAt: positionsReadStartedAt,
        // Retained fills the REST response did not list: admitted, never confirmed by this read.
        unlistedTickets: Array.from(retainedImmediatePositionsRef.current.keys()),
      });
      setState((prev) => ({
        ...prev,
        pendingPositions: Array.from(pendingMarketOrdersRef.current.values())
          .map(({ position }) => position)
          .sort((a, b) => a.id - b.id),
      }));

      setState((prev) => ({
        ...prev,
        loading: false,
        error: null,
        lastRestAt: Date.now(),
      }));
      pushDebug({
        at: Date.now(),
        source: 'rest',
        message: `Loaded ${rawPositions.length} open position(s) for account ${login} from ${restBaseUrl}`,
      });

      const applyMetrics = (body: unknown, requestedAt?: number) => {
        if (metricsScope !== getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope())) return;
        if (useAppStore.getState().authToken !== startedAuthToken) return;
        const current = useAppStore.getState().account ?? accountRef.current;
        const next = normalizeAccountMetrics(body, current, { partial: true, scope: metricsScope, login, requestedAt });
        commitAccount(next);
        if (next !== current) useAppStore.getState().setAccount(next);
      };

      const [accountResult, metricsBody] = await Promise.all([
        startupRequests.accountResultPromise,
        metricsPromise,
      ]);
      if (seq !== refreshSeqRef.current || controller.signal.aborted) return;

      if (accountResult.status === 'fulfilled' && accountResult.value) {
        applyMetrics(accountResult.value, startupRequests.accountRequestedAt);
      }
      if (metricsBody) {
        applyMetrics(metricsBody, metricsRequestedAt);
      }
      if (
        accountResult.status === 'rejected'
        && !metricsBody
        && !accountRef.current
        && !useAppStore.getState().account
      ) {
        throw accountResult.reason;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'Failed to load Trade tab data';
      setState((prev) => ({ ...prev, loading: false, error: message }));
      pushDebug({ at: Date.now(), source: 'rest', message });
    } finally {
      if (activeRefreshControllerRef.current === controller) {
        activeRefreshControllerRef.current = null;
      }
    }
  }, [commitAccount, commitPositions, pushDebug]);

  const removePosition = useCallback((ticket: number) => {
    retainedImmediatePositionsRef.current.delete(ticket);
    commitPositions(positionsRef.current.filter((position) => position.id !== ticket));
  }, [commitPositions]);

  const removePositionsByMode = useCallback((mode: 'ALL' | 'WINNERS' | 'LOSERS') => {
    const current = positionsRef.current;
    if (mode === 'ALL') {
      retainedImmediatePositionsRef.current.clear();
      commitPositions([]);
      return;
    }
    const retained = current.filter((position) => {
      const livePnl = getLivePositionRoundedProfit(position);
      if (livePnl === null || !Number.isFinite(livePnl)) return true;
      return mode === 'WINNERS' ? livePnl <= 0 : livePnl >= 0;
    });
    const retainedTickets = new Set(retained.map((position) => position.id));
    retainedImmediatePositionsRef.current.forEach((_value, ticket) => {
      if (!retainedTickets.has(ticket)) retainedImmediatePositionsRef.current.delete(ticket);
    });
    commitPositions(retained);
  }, [commitPositions]);

  useEffect(() => {
    const sessionChanged = stateSessionKeyRef.current !== sessionKey;
    if (sessionChanged) {
      stateSessionKeyRef.current = sessionKey;
      accountRef.current = null;
      positionsRef.current = [];
      heldSymbolsRef.current = new Set();
      clearLiveQuotes();
      pendingPlacementTimersRef.current.forEach((timer) => clearTimeout(timer));
      pendingPlacementTimersRef.current.clear();
      pendingMarketOrdersRef.current.clear();
      setState({
        ...INITIAL_STATE,
        login: readLogin(),
        restBaseUrl: getBrokerRestBaseUrl(),
        loading: Boolean(readLogin()),
      });
    }
    retainedImmediatePositionsRef.current.clear();
    optimisticallyClosedPositionsRef.current.clear();
    const nextPlacementScope = getCommittedBrokerAccountSessionScopeKey(
      getCommittedBrokerAccountSessionScope(),
    );
    if (placementSessionScopeRef.current !== nextPlacementScope) {
      placementSessionScopeRef.current = nextPlacementScope;
      pendingPlacementTimersRef.current.forEach((timer) => clearTimeout(timer));
      pendingPlacementTimersRef.current.clear();
      pendingMarketOrdersRef.current.clear();
      setState((prev) => ({ ...prev, pendingPositions: [] }));
    }
    return () => {
      activeRefreshControllerRef.current?.abort();
    };
  }, [sessionKey]);

  useEffect(() => {
    const sessionScope = getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope());
    let observedAccount: Account | null | undefined;
    let observedPositions: Position[] | undefined;
    let disposed = false;
    const syncStore = (snapshot: ReturnType<typeof useAppStore.getState>) => {
      if (disposed) return;
      const accountChanged = observedAccount !== snapshot.account;
      const positionsChanged = observedPositions !== snapshot.positions;
      if (!accountChanged && !positionsChanged) return;
      if (
        snapshot.accountId !== storeAccountId
        || snapshot.authToken !== storeAuthToken
        || sessionScope !== getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope())
      ) return;
      const login = readLogin();
      const storeLogin = Number.parseInt(String(snapshot.accountId ?? ''), 10);
      if (!login || storeLogin !== login) return;
      observedAccount = snapshot.account;
      observedPositions = snapshot.positions;

      // Apply the stream directly once. A React store selector followed by a
      // copying effect first painted the old rows, then scheduled a nested
      // render for every account/position packet.
      if (accountChanged && accountSignature(accountRef.current) !== accountSignature(snapshot.account)) {
        accountRef.current = snapshot.account;
      }
      let deferSnapshot = false;
      if (positionsChanged) {
        const now = Date.now();
        retainedImmediatePositionsRef.current.forEach(({ expiresAt }, ticket) => {
          if (
            expiresAt <= now
            || isConfirmedOpenPosition(ticket)
            || isConfirmedClosedPosition(ticket)
            || isConfirmedClosedBySnapshot(ticket)
          ) {
            retainedImmediatePositionsRef.current.delete(ticket);
          }
        });
        const nextPositions = mergeRetainedImmediateToolboxPositions(
          replaceToolboxPositions(
            positionsRef.current,
            Array.isArray(snapshot.positions) ? snapshot.positions : [],
          ),
          Array.from(retainedImmediatePositionsRef.current.values()),
        ).filter((position) => (
          !isConfirmedClosedPosition(position.id)
          && !isConfirmedClosedBySnapshot(position.id)
        ));
        deferSnapshot = shouldDeferEmptyPositionSnapshot(
          positionsRef.current.filter((position) => !isConfirmedClosedPosition(position.id) && !isConfirmedClosedBySnapshot(position.id)),
          nextPositions,
        );
        if (deferSnapshot) {
          // A lagging empty stream snapshot must not remove confirmed rows.
          // Account metrics can still advance while REST revalidates them.
          requestPositionSnapshotRevalidation();
        } else if (memoPositionsSignature(positionsSigRef, positionsRef.current) !== memoPositionsSignature(storeSigRef, nextPositions)) {
          positionsRef.current = nextPositions;
          positionsSigRef.current = { list: nextPositions, sig: memoPositionsSignature(storeSigRef, nextPositions) };
          heldSymbolsRef.current = getPositionAggregatesForArray(nextPositions).heldSymbols;
        }
      }
      const account = accountRef.current;
      const positions = positionsRef.current;
      const restBaseUrl = getBrokerRestBaseUrl();
      setState((prev) => {
        if (deferSnapshot) return prev.account === account ? prev : { ...prev, account };
        if (
          prev.account === account && prev.positions === positions
          && !prev.loading && prev.error === null && prev.login === login
          && prev.restBaseUrl === restBaseUrl && prev.wsState === 'connected'
        ) return prev;
        return { ...prev, account, positions, loading: false, error: null, login, restBaseUrl, wsState: 'connected' };
      });
    };
    const unsubscribe = useAppStore.subscribe(syncStore);
    syncStore(useAppStore.getState());
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [sessionKey, storeAccountId, storeAuthToken]);

  useEffect(() => {
    const handleManualRefresh = () => void refresh();
    window.addEventListener('rtx:toolbox-trade-refresh', handleManualRefresh);
    return () => {
      window.removeEventListener('rtx:toolbox-trade-refresh', handleManualRefresh);
    };
  }, [refresh]);

  useEffect(() => {
    const unsubscribeTick = binaryTcpMarketStream.onTick((bt) => {
      const held = heldSymbolsRef.current;
      if (held.size === 0) return;
      const symUpper = String(bt.symbol ?? '').toUpperCase();
      if (!symUpper || !held.has(symUpper)) return;

      const widened = applyAccountSpreadMarkup(bt.symbol, {
        symbol: bt.symbol,
        bid: bt.bid,
        ask: bt.ask,
        spread: bt.spread,
        timestamp: bt.timestamp,
      });
      // O(1) quote cache write + rAF/timer coalesced subscriber notify.
      setLiveQuote({
        symbol: symUpper,
        bid: Number(widened.bid ?? bt.bid),
        ask: Number(widened.ask ?? bt.ask),
        timestamp: bt.sourceTimestamp || bt.timestamp,
      });
    });
    return () => {
      unsubscribeTick();
    };
  }, []);

  useEffect(() => {
    const pendingPlacementTimers = pendingPlacementTimersRef.current;
    const handleMarketOrderPlacement = (event: Event) => {
      const login = readLogin();
      if (!login) return;

      const activeSessionScope = getCommittedBrokerAccountSessionScopeKey(
        getCommittedBrokerAccountSessionScope(),
      );
      const detail = (event as CustomEvent<MarketOrderPlacementStateDetail>).detail;
      if (
        !detail
        || toNumber(detail.login, 0) !== login
        || detail.sessionScope !== activeSessionScope
      ) return;
      const clearPlacementTimer = (clientOrderId: string) => {
        const existingTimer = pendingPlacementTimers.get(clientOrderId);
        if (existingTimer !== undefined) {
          clearTimeout(existingTimer);
          pendingPlacementTimers.delete(clientOrderId);
        }
      };

      if (['pending', 'accepted', 'processing'].includes(detail.status)) {
        const currentPending = Array.from(pendingMarketOrdersRef.current.values())
          .map(({ position }) => position);
        const nextPending = applyMarketOrderPlacementState(
          currentPending,
          detail,
          login,
          activeSessionScope,
        );
        if (nextPending === currentPending) return;

        clearPlacementTimer(detail.clientOrderId);
        const position = nextPending.find((candidate) => candidate.clientOrderId === detail.clientOrderId);
        if (position) {
          pendingMarketOrdersRef.current.set(detail.clientOrderId, {
            position,
            expiresAt: Date.now() + PENDING_MARKET_ORDER_ORPHAN_MS,
          });
        }
        setState((prev) => ({
          ...prev,
          pendingPositions: Array.from(pendingMarketOrdersRef.current.values())
            .map(({ position: pendingPosition }) => pendingPosition)
            .sort((a, b) => a.id - b.id),
        }));
        return;
      }

      clearPlacementTimer(detail.clientOrderId);
      pendingMarketOrdersRef.current.delete(detail.clientOrderId);
      setState((prev) => ({
        ...prev,
        pendingPositions: Array.from(pendingMarketOrdersRef.current.values())
          .map(({ position }) => position)
          .sort((a, b) => a.id - b.id),
      }));
      if (detail.status === 'failed' || detail.status === 'rejected' || detail.status === 'expired') return;

      const next = applyMarketOrderPlacementState(
        positionsRef.current,
        detail,
        login,
        activeSessionScope,
      );
      if (next === positionsRef.current) return;

      const ticket = getPositionTicket(detail.position);
      const position = next.find((candidate) => candidate.id === ticket);
      if (ticket && position) {
        retainedImmediatePositionsRef.current.set(ticket, {
          position,
          expiresAt: Date.now() + IMMEDIATE_POSITION_RETENTION_MS,
        });
      }
      commitPositions(next, ticket ? { touchedTickets: [ticket] } : undefined);
    };

    window.addEventListener(MARKET_ORDER_PLACEMENT_STATE_EVENT, handleMarketOrderPlacement);
    return () => {
      window.removeEventListener(MARKET_ORDER_PLACEMENT_STATE_EVENT, handleMarketOrderPlacement);
      pendingPlacementTimers.forEach((timer) => clearTimeout(timer));
      pendingPlacementTimers.clear();
    };
  }, [commitPositions]);

  useEffect(() => {
    const handleCloseState = (event: Event) => {
      const detail = (event as CustomEvent<{
        status?: 'pending' | 'confirmed' | 'failed';
        ticketIds?: Array<number | string>;
      }>).detail;
      const ticketIds = Array.isArray(detail?.ticketIds)
        ? detail.ticketIds.map((ticket) => toNumber(ticket, 0)).filter(Boolean)
        : [];
      if (ticketIds.length === 0) return;

      if (detail.status === 'confirmed') {
        // Closes are confirm-first (MT5 behaviour): the row is still listed
        // here, so the backend confirmation is what removes it.
        const expiresAt = Date.now() + IMMEDIATE_POSITION_RETENTION_MS;
        ticketIds.forEach((ticket) => {
          const position = optimisticallyClosedPositionsRef.current.get(ticket)?.position
            ?? positionsRef.current.find((candidate) => candidate.id === ticket);
          if (position) {
            optimisticallyClosedPositionsRef.current.set(ticket, {
              position,
              status: 'confirmed',
              expiresAt,
            });
          }
          retainedImmediatePositionsRef.current.delete(ticket);
        });
        useAppStore.getState().setPositions(useAppStore.getState().positions, { closedTickets: ticketIds });
        const remaining = positionsRef.current.filter((position) => !ticketIds.includes(position.id));
        if (remaining.length !== positionsRef.current.length) commitPositions(remaining);
      }
    };

    window.addEventListener(TRADE_OVERLAY_CLOSE_STATE_EVENT, handleCloseState);
    return () => window.removeEventListener(TRADE_OVERLAY_CLOSE_STATE_EVENT, handleCloseState);
  }, [commitPositions]);

  // eslint-disable-next-line react-hooks/refs -- intentional render-time session guard preventing 1-frame stale account state before the session reset effect runs
  const visibleState = stateSessionKeyRef.current === sessionKey
    ? state
    : {
      ...INITIAL_STATE,
      login: readLogin(),
      restBaseUrl: getBrokerRestBaseUrl(),
      loading: true,
    };

  return {
    ...visibleState,
    refresh,
    removePosition,
    removePositionsByMode,
  };
}
