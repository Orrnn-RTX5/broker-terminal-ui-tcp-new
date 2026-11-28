import { normalizeBrokerTimestampMs, readBrokerTimestampMs } from '../utils/brokerStreamSemantics';
import { shouldDeferEmptyPositionSnapshot } from './positionSnapshotSafety';
import { readPositionStateVersion } from './positionStateVersion';
import { resolveSpecDigits, stripFloatPrecisionNoise } from '../utils/symbolUtils';

// Live (latest-quote) profit for the WINNERS / LOSERS bulk-close filter. livePositionMetrics
// registers it when it loads, so this low-level stream module stays free of UI/catalog imports
// (importing it must not pull the symbol registry or broker session). Unset -> stored profit.
let liveRoundedProfitResolver: ((pos: unknown) => number | null) | null = null;
export const registerLiveRoundedProfitResolver = (fn: ((pos: unknown) => number | null) | null): void => {
  liveRoundedProfitResolver = fn;
};
const readLiveRoundedProfit = (pos: unknown): number | null => (
  liveRoundedProfitResolver ? liveRoundedProfitResolver(pos) : null
);

const toFinite = (v: unknown, fallback = 0): number => {
  // FIX: Partial account packets may carry omitted/null fields or Money-like
  // `{ amount }` values. Neither may silently erase a known metric with zero.
  if (v === undefined || v === null || v === '') return fallback;
  const candidate = typeof v === 'object' && v !== null && 'amount' in v
    ? (v as { amount?: unknown }).amount
    : v;
  const n = Number(String(candidate).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
};

type StreamRecord = Record<string, unknown>;
const asRecord = (value: unknown): StreamRecord | null => (
  value !== null && typeof value === 'object' ? value as StreamRecord : null
);
export interface NormalizedPositionRecord {
  state_version?: string;
  state_version_text?: string;
  id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: number;
  volume_lots: number;
  quantity: number;
  openPrice: number;
  open_price: number;
  price_open: number;
  currentPrice: number;
  current_price: number;
  price_current: number;
  openTime: string;
  time_create: string;
  chartEntryTime: string;
  chartEntryPrice?: number;
  sl: number;
  price_sl: number;
  stopLoss: number;
  stop_loss: number;
  tp: number;
  price_tp: number;
  takeProfit: number;
  take_profit: number;
  swap: number;
  commission: number;
  unrealizedPnL: number;
  unrealized_pl: number;
  profit: number;
  hasBackendProfit: boolean;
  hasBackendCurrentPrice?: boolean;
  pnl_available?: boolean;
  margin?: number;
  used_margin?: number;
  margin_available?: boolean;
  hasBackendMargin?: boolean;
  price_time_msc?: number | string;
  digits?: number;
  comment?: string;
  time_update?: string;
  account_login?: number;
  broker_id?: string;
}

const hasOwnValue = (record: unknown, keys: readonly string[]): boolean => {
  const rec = asRecord(record);
  return (
    rec !== null
    && keys.some((key) => (
      Object.prototype.hasOwnProperty.call(rec, key)
      && rec[key] !== undefined
      && rec[key] !== null
      && rec[key] !== ''
    ))
  );
};

const stopLossAliases = ['price_sl', 'sl', 'stopLoss', 'stop_loss'] as const;
const takeProfitAliases = ['price_tp', 'tp', 'takeProfit', 'take_profit'] as const;

const readProtectionLevel = (record: unknown, keys: readonly string[]): number | undefined => {
  const rec = asRecord(record);
  if (!rec) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(rec, key)
      && rec[key] !== undefined && rec[key] !== '') {
      // Explicit null/zero removes a level; an omitted value leaves it intact.
      return toFinite(rec[key], 0);
    }
  }
  return undefined;
};

const firstDefined = (record: unknown, keys: readonly string[]): unknown => {
  const rec = asRecord(record);
  if (!rec) return undefined;
  for (const key of keys) {
    const value = rec[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const timestampToIso = (v: unknown): string => {
  const timestamp = normalizeBrokerTimestampMs(v);
  return timestamp === undefined ? '' : new Date(timestamp).toISOString();
};

export function normalizePosition(raw: unknown): NormalizedPositionRecord {
  const rec = asRecord(raw) ?? {};
  // FIX: Position event time accepts every broker precision/ISO alias without
  // multiplying a millisecond/microsecond/nanosecond epoch a second time.
  const openTimestamp = readBrokerTimestampMs([rec], [
    'time_create', 'time_create_ms', 'time_create_msc',
    'time_open', 'time_open_ms', 'time_open_msc',
    'opened_at', 'open_time', 'openTime',
    'time_ms', 'time_msc', 'timestamp_ms', 'timestamp', 'time',
  ]);
  const openTime = openTimestamp === undefined ? '' : timestampToIso(openTimestamp);

  const id = getPositionId(rec);
  const volume = toFinite(rec.volume_lots ?? rec.volume ?? rec.quantity, 0);
  const openPrice = stripFloatPrecisionNoise(toFinite(rec.price_open ?? rec.open_price ?? rec.openPrice ?? rec.price, 0));
  const currentPrice = stripFloatPrecisionNoise(toFinite(rec.price_current ?? rec.current_price ?? rec.currentPrice, 0));
  const unrealizedPnL = toFinite(rec.profit ?? rec.unrealized_pl ?? rec.unrealizedPnL, 0);
  const sl = stripFloatPrecisionNoise(readProtectionLevel(rec, stopLossAliases) ?? 0);
  const tp = stripFloatPrecisionNoise(readProtectionLevel(rec, takeProfitAliases) ?? 0);
  const digits = resolveSpecDigits(rec.digits);

  return {
    ...rec,
    state_version: positionVersion(rec),
    id,
    symbol: typeof rec.symbol === 'string' ? rec.symbol : '',
    side: Number(rec.action) === 1 || ['sell', 'short'].includes(String(rec.side).toLowerCase()) ? 'SELL' as const : 'BUY' as const,
    volume,
    volume_lots: volume,
    openPrice,
    currentPrice,
    openTime,
    ...(digits !== null ? { digits } : {}),
    chartEntryTime: (typeof rec.chartEntryTime === 'string' && rec.chartEntryTime.trim())
      ? rec.chartEntryTime.trim()
      : (openTime || new Date().toISOString()),
    sl,
    price_sl: sl,
    stopLoss: sl,
    stop_loss: sl,
    tp,
    price_tp: tp,
    takeProfit: tp,
    take_profit: tp,
    swap: toFinite(rec.storage ?? rec.swap, 0),
    commission: toFinite(rec.commission, 0),
    unrealizedPnL,
    hasBackendProfit: rec.pnl_available !== false && rec.hasBackendProfit !== false && hasOwnValue(rec, ['profit', 'unrealized_pl', 'unrealizedPnL']),
    comment: typeof rec.comment === 'string' ? rec.comment : undefined,
    // FIX: Keep wire aliases synchronized with the canonical fields. Several
    // trade-table consumers still read these defensive aliases first.
    open_price: openPrice,
    price_open: openPrice,
    current_price: currentPrice,
    price_current: currentPrice,
    quantity: volume,
    unrealized_pl: unrealizedPnL,
    profit: unrealizedPnL,
    time_create: openTime,
  } as NormalizedPositionRecord;
}

export const getPositionId = (raw: unknown): number => {
  const rec = asRecord(raw);
  return rec
    ? toFinite(rec.position_id ?? rec.ticket ?? rec.id ?? rec.position_ticket ?? rec.closed_ticket, 0)
    : 0;
};

export const isDeletedPositionRecord = (raw: unknown): boolean => {
  const rec = asRecord(raw);
  if (!rec) return false;
  if (rec.deleted === true) return true;
  const closeReason = String(rec.close_reason ?? rec.closeReason ?? '').trim().toLowerCase();
  if (closeReason === 'deleted') return true;
  const lifecycle = String(rec.event ?? rec.type ?? rec.status ?? rec.state ?? '').trim().toLowerCase();
  if (lifecycle === 'position_deleted' || lifecycle === 'deleted') return true;
  const action = String(rec.action ?? '').trim().toLowerCase();
  return action === 'position_deleted' || action === 'deleted';
};

export const isDeletedPositionStreamMessage = (message: unknown): boolean => {
  const root = asRecord(message);
  const data = asRecord(root?.data);
  const envelopes = [root, data, asRecord(data?.data)];
  for (const env of envelopes) {
    if (!env) continue;
    if (isDeletedPositionRecord(env)) return true;
    if (
      isDeletedPositionRecord(env.position)
      || isDeletedPositionRecord(env.closed_position)
      || isDeletedPositionRecord(env.result)
    ) {
      return true;
    }
    const list = Array.isArray(env) ? env : Array.isArray(env.positions) ? env.positions : null;
    if (list && list.some((item: unknown) => isDeletedPositionRecord(item))) return true;
  }
  return false;
};

export const isClosedPositionRecord = (raw: unknown): boolean => {
  if (isDeletedPositionRecord(raw)) return true;
  const rec = asRecord(raw);
  const lifecycle = String(rec?.event ?? rec?.status ?? rec?.state ?? '').trim().toLowerCase();
  if (rec?.closed === true || ['close', 'closed', 'deleted', 'position_deleted', 'sl_hit', 'tp_hit', 'stop_out'].includes(lifecycle)) {
    return true;
  }
  const closedAt = readBrokerTimestampMs([rec], [
    'time_close', 'time_close_ms', 'time_close_msc',
    'closed_at', 'close_time', 'closeTime',
  ]);
  if (
    closedAt !== undefined
    && closedAt > 0
  ) return true;
  const volumeKeys = ['volume_lots', 'volume', 'quantity'] as const;
  return hasOwnValue(rec, volumeKeys) && toFinite(firstDefined(rec, volumeKeys), 0) <= 0;
};

export const mergePositionRecord = <T extends object = NormalizedPositionRecord>(
  raw: unknown,
  existing?: T,
): NormalizedPositionRecord => {
  const rec = asRecord(raw) ?? {};
  if (existing && isOlderPositionVersion(rec, existing)) return existing as unknown as NormalizedPositionRecord;
  const prev = existing as unknown as NormalizedPositionRecord | undefined;
  if (prev && rec.update_kind === 'pnl') {
    const incomingTime = Number(rec.price_time_msc);
    const previousTime = Number(prev.price_time_msc);
    if (Number.isFinite(incomingTime) && Number.isFinite(previousTime) && incomingTime < previousTime) {
      return existing as unknown as NormalizedPositionRecord;
    }
    // Display messages are never allowed to modify volume, side or protection,
    // even if a legacy publisher accidentally includes those fields.
    const profit = firstDefined(rec, ['profit', 'unrealized_pl', 'unrealizedPnL']);
    const price = firstDefined(rec, ['price_current', 'current_price', 'currentPrice']);
    const cleanPrice = price !== undefined ? stripFloatPrecisionNoise(toFinite(price)) : undefined;
    return {
      ...prev,
      pnl_available: true,
      ...(cleanPrice !== undefined ? { currentPrice: cleanPrice, current_price: cleanPrice, price_current: cleanPrice, hasBackendCurrentPrice: true } : {}),
      ...(profit !== undefined ? { profit: toFinite(profit), unrealizedPnL: toFinite(profit), unrealized_pl: toFinite(profit), hasBackendProfit: true } : {}),
      ...(rec.margin !== undefined ? {
        margin: toFinite(rec.margin),
        used_margin: toFinite(rec.margin),
        margin_available: (rec.margin_available as boolean | undefined) ?? true,
        hasBackendMargin: (rec.hasBackendMargin as boolean | undefined) ?? (rec.margin_available !== false),
      } : {}),
      ...(Number.isFinite(incomingTime) ? { price_time_msc: incomingTime } : {}),
    } as NormalizedPositionRecord;
  }
  const normalized = normalizePosition(rec);
  if (!prev) return normalized;
  const duplicatePricedSnapshot = rec.pnl_available === false
    && positionVersion(rec) !== undefined && positionVersion(rec) === positionVersion(prev)
    && prev.pnl_available !== false && prev.hasBackendProfit !== false;
  if (positionVersion(prev) !== undefined && positionVersion(rec) === positionVersion(prev)
    && Number(prev.price_time_msc) > (Number(rec.price_time_msc) || 0)) {
    normalized.currentPrice = prev.currentPrice;
    normalized.unrealizedPnL = prev.unrealizedPnL;
    normalized.price_time_msc = prev.price_time_msc;
  }

  const volume = hasOwnValue(rec, ['volume_lots', 'volume', 'quantity']) ? normalized.volume : prev.volume;
  const openPrice = hasOwnValue(rec, ['price_open', 'open_price', 'openPrice', 'price'])
    ? normalized.openPrice
    : prev.openPrice;
  const hasCurrentPrice = hasOwnValue(rec, ['price_current', 'current_price', 'currentPrice']);
  const currentPrice = hasCurrentPrice ? normalized.currentPrice : prev.currentPrice;
  const openTime = hasOwnValue(rec, [
    'time_create', 'time_create_ms', 'time_create_msc',
    'time_ms', 'time_msc', 'time', 'timestamp', 'timestamp_ms',
    'time_open', 'time_open_ms', 'time_open_msc', 'opened_at', 'open_time', 'openTime',
  ])
    ? normalized.openTime
    : prev.openTime;
  const hasProfit = hasOwnValue(rec, ['profit', 'unrealized_pl', 'unrealizedPnL']);
  const unrealizedPnL = hasProfit ? normalized.unrealizedPnL : prev.unrealizedPnL;
  const sl = stripFloatPrecisionNoise(readProtectionLevel(rec, stopLossAliases) ?? prev.sl);
  const tp = stripFloatPrecisionNoise(readProtectionLevel(rec, takeProfitAliases) ?? prev.tp);
  const mergedDigits = resolveSpecDigits(normalized.digits, prev.digits);

  return {
    ...prev,
    ...normalized,
    ...(mergedDigits !== null ? { digits: mergedDigits } : {}),
    pnl_available: duplicatePricedSnapshot ? true : ((rec.pnl_available as boolean | undefined) ?? prev.pnl_available),
    state_version: positionVersion(rec) ?? positionVersion(prev),
    state_version_text: positionVersion(rec) ?? positionVersion(prev),
    symbol: hasOwnValue(rec, ['symbol']) ? normalized.symbol : prev.symbol,
    side: hasOwnValue(rec, ['action', 'side']) ? normalized.side : prev.side,
    volume,
    volume_lots: volume,
    quantity: volume,
    openPrice,
    open_price: openPrice,
    price_open: openPrice,
    currentPrice,
    current_price: currentPrice,
    price_current: currentPrice,
    openTime,
    time_create: openTime,
    chartEntryTime: hasOwnValue(rec, ['chartEntryTime'])
      ? normalized.chartEntryTime
      : (prev.chartEntryTime || openTime || normalized.chartEntryTime),
    sl,
    tp,
    price_sl: sl,
    stopLoss: sl,
    stop_loss: sl,
    price_tp: tp,
    takeProfit: tp,
    take_profit: tp,
    swap: hasOwnValue(rec, ['storage', 'swap']) ? normalized.swap : prev.swap,
    commission: hasOwnValue(rec, ['commission']) ? normalized.commission : prev.commission,
    unrealizedPnL,
    unrealized_pl: unrealizedPnL,
    profit: unrealizedPnL,
    // Rows admitted from an order fill have no backend price/P&L yet and are
    // flagged unavailable. A frame that supplies them must clear those flags,
    // or the Trade tab keeps showing dashes until a REST reload. A duplicate
    // snapshot of an already priced version keeps its flags.
    ...(hasCurrentPrice && !duplicatePricedSnapshot
      ? { hasBackendCurrentPrice: rec.hasBackendCurrentPrice !== false && rec.pnl_available !== false }
      : {}),
    hasBackendProfit: duplicatePricedSnapshot ? prev.hasBackendProfit : rec.pnl_available === false ? false
      : hasProfit ? normalized.hasBackendProfit : prev.hasBackendProfit,
    comment: hasOwnValue(rec, ['comment']) ? normalized.comment : prev.comment,
  } as NormalizedPositionRecord;
};

const positionVersion = (raw: unknown): string | undefined => {
  const rec = asRecord(raw);
  return readPositionStateVersion(rec?.state_version_text ?? rec?.state_version) ?? undefined;
};

// Do not coerce version strings to Number: PostgreSQL bigint exceeds JS's
// exact integer range. Unversioned legacy messages remain compatible.
export const isOlderPositionVersion = (incoming: unknown, existing: unknown): boolean => {
  const next = positionVersion(incoming);
  const current = positionVersion(existing);
  return next !== undefined && current !== undefined
    && (next.length < current.length || (next.length === current.length && next < current));
};

export type PositionStreamBatch = {
  positions: StreamRecord[];
  mode: 'delta' | 'snapshot';
  closedTickets?: number[];
};

export const DELTA_EVENTS = new Set([
  'position_update',
  'positions_update',
  'pnl_update',
  'positions_bulk_closed',
  'bulk_closed',
]);

export const POSITION_CLOSED_EVENTS = new Set([
  'close', 'closed', 'position_closed', 'position_deleted', 'deleted', 'sl_hit', 'tp_hit', 'stop_out',
]);

export const POSITION_BULK_CLOSED_EVENTS = new Set([
  'positions_bulk_closed', 'bulk_closed',
]);

export type PositionBulkFilterType = 'ALL' | 'WINNERS' | 'LOSERS' | 'BUY_ONLY' | 'SELL_ONLY';

export type PositionBulkCloseEvent = {
  account_login?: number;
  broker_id?: string;
  symbol?: string;
  filter_type: PositionBulkFilterType;
  closed_tickets: number[];
};

const normalizeBulkFilterType = (raw: unknown): PositionBulkFilterType => {
  if (raw === 1 || raw === '1') return 'WINNERS';
  if (raw === 2 || raw === '2') return 'LOSERS';
  if (raw === 3 || raw === '3') return 'BUY_ONLY';
  if (raw === 4 || raw === '4') return 'SELL_ONLY';
  const normalized = String(raw ?? '').trim().toUpperCase();
  if (normalized === 'WINNERS' || normalized === 'PROFIT') return 'WINNERS';
  if (normalized === 'LOSERS' || normalized === 'LOSS') return 'LOSERS';
  if (normalized === 'BUY_ONLY' || normalized === 'BUY') return 'BUY_ONLY';
  if (normalized === 'SELL_ONLY' || normalized === 'SELL') return 'SELL_ONLY';
  return 'ALL';
};

export const readPositionBulkCloseEvent = (message: unknown): PositionBulkCloseEvent | null => {
  const root = asRecord(message);
  const data = asRecord(root?.data);
  const envelopes = [asRecord(data?.data), data, root];
  const event = envelopes
    .flatMap((value) => [value?.event, value?.type, value?.action])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .find((value) => POSITION_BULK_CLOSED_EVENTS.has(value));
  if (!event) return null;

  const rawTickets = envelopes
    .flatMap((value) => [value?.closed_tickets, value?.closedTickets, value?.tickets])
    .find((value): value is unknown[] => Array.isArray(value));
  const closedTickets = Array.isArray(rawTickets)
    ? rawTickets
        .map((t) => toFinite(t, 0))
        .filter((t) => Number.isSafeInteger(t) && t > 0)
    : [];

  const rawLogin = firstDefined(envelopes[0], ['account_login', 'login'])
    ?? firstDefined(envelopes[1], ['account_login', 'login'])
    ?? firstDefined(envelopes[2], ['account_login', 'login']);
  const accountLogin = rawLogin !== undefined ? toFinite(rawLogin, 0) : undefined;

  const rawBrokerId = firstDefined(envelopes[0], ['broker_id'])
    ?? firstDefined(envelopes[1], ['broker_id'])
    ?? firstDefined(envelopes[2], ['broker_id']);
  const brokerId = typeof rawBrokerId === 'string' && rawBrokerId.trim() ? rawBrokerId.trim() : undefined;

  const rawSymbol = firstDefined(envelopes[0], ['symbol'])
    ?? firstDefined(envelopes[1], ['symbol'])
    ?? firstDefined(envelopes[2], ['symbol']);
  const symbol = typeof rawSymbol === 'string' && rawSymbol.trim()
    ? rawSymbol.trim().toUpperCase()
    : undefined;

  const rawFilter = firstDefined(envelopes[0], ['filter_type', 'filterType', 'mode', 'order_sub_type', 'sub_type'])
    ?? firstDefined(envelopes[1], ['filter_type', 'filterType', 'mode', 'order_sub_type', 'sub_type'])
    ?? firstDefined(envelopes[2], ['filter_type', 'filterType', 'mode', 'order_sub_type', 'sub_type']);

  return {
    ...(accountLogin && accountLogin > 0 ? { account_login: accountLogin } : {}),
    ...(brokerId ? { broker_id: brokerId } : {}),
    ...(symbol ? { symbol } : {}),
    filter_type: normalizeBulkFilterType(rawFilter),
    closed_tickets: closedTickets,
  };
};

export const reconcilePositionBulkClose = <T extends { id: number }>(
  current: T[],
  bulkClose: PositionBulkCloseEvent,
): { positions: T[]; closedTickets: number[] } => {
  const explicitSet = bulkClose.closed_tickets.length > 0
    ? new Set<number>(bulkClose.closed_tickets)
    : null;
  const targetSymbol = bulkClose.symbol ? bulkClose.symbol.trim().toUpperCase() : '';
  const filterType = bulkClose.filter_type;

  const remaining: T[] = [];
  const closedTickets: number[] = [];

  for (let i = 0; i < current.length; i++) {
    const pos = current[i] as unknown as StreamRecord;
    const ticket = Number(pos?.id ?? pos?.ticket ?? 0);
    if (explicitSet) {
      if (explicitSet.has(ticket)) {
        if (ticket > 0) closedTickets.push(ticket);
        continue;
      }
      remaining.push(current[i]);
      continue;
    }

    if (
      bulkClose.account_login !== undefined
      && pos?.account_login !== undefined
      && Number(pos.account_login) > 0
      && Number(pos.account_login) !== bulkClose.account_login
    ) {
      remaining.push(current[i]);
      continue;
    }

    if (targetSymbol) {
      const posSymbol = String(pos?.symbol ?? '').trim().toUpperCase();
      if (posSymbol !== targetSymbol) {
        remaining.push(current[i]);
        continue;
      }
    }

    let matchesFilter = true;
    if (filterType === 'WINNERS') {
      const profit = readLiveRoundedProfit(pos) ?? toFinite(pos?.profit ?? pos?.unrealizedPnL ?? pos?.unrealized_pl, 0);
      matchesFilter = profit > 0;
    } else if (filterType === 'LOSERS') {
      const profit = readLiveRoundedProfit(pos) ?? toFinite(pos?.profit ?? pos?.unrealizedPnL ?? pos?.unrealized_pl, 0);
      matchesFilter = profit < 0;
    } else if (filterType === 'BUY_ONLY') {
      const side = String(pos?.side ?? '').trim().toUpperCase();
      matchesFilter = side === 'BUY' || Number(pos?.action) === 0;
    } else if (filterType === 'SELL_ONLY') {
      const side = String(pos?.side ?? '').trim().toUpperCase();
      matchesFilter = side === 'SELL' || Number(pos?.action) === 1;
    }

    if (matchesFilter) {
      if (ticket > 0) closedTickets.push(ticket);
    } else {
      remaining.push(current[i]);
    }
  }

  return { positions: remaining, closedTickets };
};

const SIDE_ONLY_ACTIONS = new Set(['buy', 'sell', 'long', 'short']);

export const readPositionStreamEvent = (message: unknown): { event: string; position: StreamRecord | undefined } => {
  const root = asRecord(message);
  const data = asRecord(root?.data);
  const envelopes = [asRecord(data?.data), data, root];
  const event = envelopes.flatMap((value) => [
    value?.event,
    value?.type,
    SIDE_ONLY_ACTIONS.has(String(value?.action ?? '').trim().toLowerCase()) ? undefined : value?.action,
  ])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .find((value) => value && value !== 'channel_message') ?? '';
  const allowResult = event.startsWith('position_') || POSITION_CLOSED_EVENTS.has(event);
  const position = envelopes.flatMap((value) => [
    value?.position,
    value?.closed_position,
    ...(allowResult ? [value?.result] : []),
    value,
  ]).find((value): value is StreamRecord => getPositionId(value) > 0);
  return { event, position };
};

const extractBatchFromRecord = (value: unknown): StreamRecord[] | undefined => {
  if (Array.isArray(value)) return value as StreamRecord[];
  const rec = asRecord(value);
  if (!rec) return undefined;
  for (const key of ['positions', 'open_positions', 'items', 'data'] as const) {
    const candidate = rec[key];
    if (Array.isArray(candidate)) return candidate as StreamRecord[];
  }
  return undefined;
};

/** Account channels carry symbol-scoped P&L batches as well as snapshots.
 * Inspect the broker event inside either /ws/v2 or channel_message envelopes.
 * An array alone does not establish that omitted tickets have been closed.
 */
export const readPositionStreamBatch = (message: unknown): PositionStreamBatch | null => {
  const root = asRecord(message);
  const data = asRecord(root?.data);
  const envelopes = [root, data, asRecord(data?.data)];
  const positions = envelopes
    .map(extractBatchFromRecord)
    .find((candidate): candidate is StreamRecord[] => Array.isArray(candidate));
  const rawClosedTickets = envelopes
    .flatMap((value) => [value?.closed_tickets, value?.closedTickets, value?.tickets])
    .find((value): value is unknown[] => Array.isArray(value));
  const closedTickets = Array.isArray(rawClosedTickets)
    ? rawClosedTickets
        .map((t) => toFinite(t, 0))
        .filter((t) => Number.isSafeInteger(t) && t > 0)
    : [];
  if (!positions && closedTickets.length === 0) return null;

  const events = envelopes.flatMap((value) => [value?.event, value?.type])
    .map((value) => String(value ?? '').toLowerCase());
  const isDelta = events.some((event) => DELTA_EVENTS.has(event))
    || envelopes.some((value) => value?.symbol || value?.partial === true || value?.snapshot === false)
    || (!positions && closedTickets.length > 0);
  const isSnapshot = !isDelta && (
    events.some((event) => ['snapshot', 'positions_snapshot', 'mt5_positions'].includes(event))
    || envelopes.some((value) => value?.snapshot === true)
  );
  return {
    positions: positions ?? [],
    mode: isSnapshot ? 'snapshot' : 'delta',
    ...(closedTickets.length > 0 ? { closedTickets } : {}),
  };
};

export const reconcilePositionStreamBatch = <T extends { id: number }>(
  current: T[],
  batch: PositionStreamBatch,
): { positions: T[]; needsRevalidation: boolean; closedTickets: number[] } => {
  const currentById = new Map(current.map((position) => [Number(position.id), position]));
  // Stream snapshots merge like deltas: they upsert the rows they carry and never remove the
  // tickets they omit (no backend marks a stream snapshot as complete-account). Removal comes
  // from explicit close records, or from a complete REST read that confirmed the ticket.
  const nextById = new Map(currentById);
  let needsRevalidation = false;
  const closedTickets = new Set<number>(
    Array.isArray(batch.closedTickets)
      ? batch.closedTickets.map((t) => toFinite(t, 0)).filter((t) => Number.isSafeInteger(t) && t > 0)
      : [],
  );
  for (const ticket of closedTickets) {
    nextById.delete(ticket);
  }
  for (const raw of batch.positions) {
    const ticket = getPositionId(raw);
    if (!Number.isFinite(ticket) || ticket <= 0) continue;
    const existing = currentById.get(ticket);
    if (!existing && (raw.display_only === true || raw.update_kind === 'pnl')) {
      needsRevalidation = true;
      continue;
    }
    if (existing && raw.update_kind === 'pnl' && positionVersion(raw) !== undefined
      && positionVersion(existing) !== undefined && positionVersion(raw) !== positionVersion(existing)) {
      if (!isOlderPositionVersion(raw, existing)) needsRevalidation = true;
      nextById.set(ticket, existing);
      continue;
    }
    if (existing && isOlderPositionVersion(raw, existing)) {
      nextById.set(ticket, existing);
      continue;
    }
    if (isClosedPositionRecord(raw)) {
      nextById.delete(ticket);
      closedTickets.add(ticket);
      continue;
    }
    const merged = mergePositionRecord(raw, existing);
    if (!existing && (!merged.symbol || !(merged.volume > 0))) {
      // A price-only update cannot create a valid row. Recover its identity
      // from REST without discarding any of the already visible positions.
      needsRevalidation = true;
      continue;
    }
    nextById.set(ticket, merged as unknown as T);
  }

  const positions = Array.from(nextById.values());
  const retained = current.filter((position) => !closedTickets.has(position.id));
  if (shouldDeferEmptyPositionSnapshot(retained, positions)) {
    return { positions: retained, needsRevalidation: true, closedTickets: [...closedTickets] };
  }
  return {
    positions,
    closedTickets: [...closedTickets],
    needsRevalidation: needsRevalidation || (batch.positions.length === 0 && closedTickets.size === 0 && retained.length > 0),
  };
};
