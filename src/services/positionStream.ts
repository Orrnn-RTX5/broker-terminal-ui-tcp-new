import { normalizeBrokerTimestampMs, readBrokerTimestampMs } from '../utils/brokerStreamSemantics';
import { shouldDeferEmptyPositionSnapshot } from './positionSnapshotSafety';
import { readPositionStateVersion } from './positionStateVersion';
import { resolveSpecDigits, stripFloatPrecisionNoise } from '../utils/symbolUtils';

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

const hasOwnValue = (record: any, keys: readonly string[]): boolean => (
  !!record
  && typeof record === 'object'
  && keys.some((key) => (
    Object.prototype.hasOwnProperty.call(record, key)
    && record[key] !== undefined
    && record[key] !== null
    && record[key] !== ''
  ))
);

const stopLossAliases = ['price_sl', 'sl', 'stopLoss', 'stop_loss'] as const;
const takeProfitAliases = ['price_tp', 'tp', 'takeProfit', 'take_profit'] as const;

const readProtectionLevel = (record: any, keys: readonly string[]): number | undefined => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)
      && record[key] !== undefined && record[key] !== '') {
      // Explicit null/zero removes a level; an omitted value leaves it intact.
      return toFinite(record[key], 0);
    }
  }
  return undefined;
};

const firstDefined = (record: any, keys: readonly string[]): unknown => {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const timestampToIso = (v: unknown): string => {
  const timestamp = normalizeBrokerTimestampMs(v);
  return timestamp === undefined ? '' : new Date(timestamp).toISOString();
};

export function normalizePosition(raw: any) {
  // FIX: Position event time accepts every broker precision/ISO alias without
  // multiplying a millisecond/microsecond/nanosecond epoch a second time.
  const openTimestamp = readBrokerTimestampMs([raw], [
    'time_create', 'time_create_ms', 'time_create_msc',
    'time_open', 'time_open_ms', 'time_open_msc',
    'opened_at', 'open_time', 'openTime',
    'time_ms', 'time_msc', 'timestamp_ms', 'timestamp', 'time',
  ]);
  const openTime = openTimestamp === undefined ? '' : timestampToIso(openTimestamp);

  const id = getPositionId(raw);
  const volume = toFinite(raw.volume_lots ?? raw.volume ?? raw.quantity, 0);
  const openPrice = stripFloatPrecisionNoise(toFinite(raw.price_open ?? raw.open_price ?? raw.openPrice ?? raw.price, 0));
  const currentPrice = stripFloatPrecisionNoise(toFinite(raw.price_current ?? raw.current_price ?? raw.currentPrice, 0));
  const unrealizedPnL = toFinite(raw.profit ?? raw.unrealized_pl ?? raw.unrealizedPnL, 0);
  const sl = stripFloatPrecisionNoise(readProtectionLevel(raw, stopLossAliases) ?? 0);
  const tp = stripFloatPrecisionNoise(readProtectionLevel(raw, takeProfitAliases) ?? 0);
  const digits = resolveSpecDigits(raw.digits);

  return {
    ...raw,
    state_version: positionVersion(raw),
    id,
    symbol: raw.symbol || '',
    side: Number(raw.action) === 1 || ['sell', 'short'].includes(String(raw.side).toLowerCase()) ? 'SELL' as const : 'BUY' as const,
    volume,
    volume_lots: volume,
    openPrice,
    currentPrice,
    openTime,
    ...(digits !== null ? { digits } : {}),
    chartEntryTime: (typeof raw?.chartEntryTime === 'string' && raw.chartEntryTime.trim())
      ? raw.chartEntryTime.trim()
      : (openTime || new Date().toISOString()),
    sl,
    price_sl: sl,
    stopLoss: sl,
    stop_loss: sl,
    tp,
    price_tp: tp,
    takeProfit: tp,
    take_profit: tp,
    swap: toFinite(raw.storage ?? raw.swap, 0),
    commission: toFinite(raw.commission, 0),
    unrealizedPnL,
    hasBackendProfit: raw.pnl_available !== false && raw.hasBackendProfit !== false && hasOwnValue(raw, ['profit', 'unrealized_pl', 'unrealizedPnL']),
    comment: raw.comment,
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
  };
}

export const getPositionId = (raw: any): number => (
  toFinite(raw?.position_id ?? raw?.ticket ?? raw?.id ?? raw?.position_ticket ?? raw?.closed_ticket, 0)
);

export const isClosedPositionRecord = (raw: any): boolean => {
  const lifecycle = String(raw?.event ?? raw?.status ?? raw?.state ?? '').trim().toLowerCase();
  if (raw?.closed === true || ['close', 'closed', 'sl_hit', 'tp_hit', 'stop_out'].includes(lifecycle)) {
    return true;
  }
  const closedAt = readBrokerTimestampMs([raw], [
    'time_close', 'time_close_ms', 'time_close_msc',
    'closed_at', 'close_time', 'closeTime',
  ]);
  if (
    closedAt !== undefined
    && closedAt > 0
  ) return true;
  const volumeKeys = ['volume_lots', 'volume', 'quantity'] as const;
  return hasOwnValue(raw, volumeKeys) && toFinite(firstDefined(raw, volumeKeys), 0) <= 0;
};

export const mergePositionRecord = (raw: any, existing?: any): any => {
  if (existing && isOlderPositionVersion(raw, existing)) return existing;
  if (existing && raw?.update_kind === 'pnl') {
    const incomingTime = Number(raw.price_time_msc);
    const previousTime = Number(existing.price_time_msc);
    if (Number.isFinite(incomingTime) && Number.isFinite(previousTime) && incomingTime < previousTime) return existing;
    // Display messages are never allowed to modify volume, side or protection,
    // even if a legacy publisher accidentally includes those fields.
    const profit = firstDefined(raw, ['profit', 'unrealized_pl', 'unrealizedPnL']);
    const price = firstDefined(raw, ['price_current', 'current_price', 'currentPrice']);
    const cleanPrice = price !== undefined ? stripFloatPrecisionNoise(toFinite(price)) : undefined;
    return {
      ...existing,
      pnl_available: true,
      ...(cleanPrice !== undefined ? { currentPrice: cleanPrice, current_price: cleanPrice, price_current: cleanPrice, hasBackendCurrentPrice: true } : {}),
      ...(profit !== undefined ? { profit: toFinite(profit), unrealizedPnL: toFinite(profit), unrealized_pl: toFinite(profit), hasBackendProfit: true } : {}),
      ...(raw.margin !== undefined ? {
        margin: toFinite(raw.margin),
        used_margin: toFinite(raw.margin),
        margin_available: raw.margin_available ?? true,
        hasBackendMargin: raw.hasBackendMargin ?? (raw.margin_available !== false),
      } : {}),
      ...(Number.isFinite(incomingTime) ? { price_time_msc: incomingTime } : {}),
    };
  }
  const normalized = normalizePosition(raw) as any;
  if (!existing) return normalized;
  const duplicatePricedSnapshot = raw.pnl_available === false
    && positionVersion(raw) !== undefined && positionVersion(raw) === positionVersion(existing)
    && existing.pnl_available !== false && existing.hasBackendProfit !== false;
  if (positionVersion(existing) !== undefined && positionVersion(raw) === positionVersion(existing)
    && Number(existing.price_time_msc) > (Number(raw.price_time_msc) || 0)) {
    normalized.currentPrice = existing.currentPrice;
    normalized.unrealizedPnL = existing.unrealizedPnL;
    normalized.price_time_msc = existing.price_time_msc;
  }

  const volume = hasOwnValue(raw, ['volume_lots', 'volume', 'quantity']) ? normalized.volume : existing.volume;
  const openPrice = hasOwnValue(raw, ['price_open', 'open_price', 'openPrice', 'price'])
    ? normalized.openPrice
    : existing.openPrice;
  const hasCurrentPrice = hasOwnValue(raw, ['price_current', 'current_price', 'currentPrice']);
  const currentPrice = hasCurrentPrice ? normalized.currentPrice : existing.currentPrice;
  const openTime = hasOwnValue(raw, [
    'time_create', 'time_create_ms', 'time_create_msc',
    'time_ms', 'time_msc', 'time', 'timestamp', 'timestamp_ms',
    'time_open', 'time_open_ms', 'time_open_msc', 'opened_at', 'open_time', 'openTime',
  ])
    ? normalized.openTime
    : existing.openTime;
  const hasProfit = hasOwnValue(raw, ['profit', 'unrealized_pl', 'unrealizedPnL']);
  const unrealizedPnL = hasProfit ? normalized.unrealizedPnL : existing.unrealizedPnL;
  const sl = stripFloatPrecisionNoise(readProtectionLevel(raw, stopLossAliases) ?? existing.sl);
  const tp = stripFloatPrecisionNoise(readProtectionLevel(raw, takeProfitAliases) ?? existing.tp);
  const mergedDigits = resolveSpecDigits(normalized.digits, existing.digits);

  return {
    ...existing,
    ...normalized,
    ...(mergedDigits !== null ? { digits: mergedDigits } : {}),
    pnl_available: duplicatePricedSnapshot ? true : (raw.pnl_available ?? existing.pnl_available),
    state_version: positionVersion(raw) ?? positionVersion(existing),
    state_version_text: positionVersion(raw) ?? positionVersion(existing),
    symbol: hasOwnValue(raw, ['symbol']) ? normalized.symbol : existing.symbol,
    side: hasOwnValue(raw, ['action', 'side']) ? normalized.side : existing.side,
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
    chartEntryTime: hasOwnValue(raw, ['chartEntryTime'])
      ? normalized.chartEntryTime
      : (existing.chartEntryTime || openTime || normalized.chartEntryTime),
    sl,
    tp,
    price_sl: sl,
    stopLoss: sl,
    stop_loss: sl,
    price_tp: tp,
    takeProfit: tp,
    take_profit: tp,
    swap: hasOwnValue(raw, ['storage', 'swap']) ? normalized.swap : existing.swap,
    commission: hasOwnValue(raw, ['commission']) ? normalized.commission : existing.commission,
    unrealizedPnL,
    unrealized_pl: unrealizedPnL,
    profit: unrealizedPnL,
    // Rows admitted from an order fill have no backend price/P&L yet and are
    // flagged unavailable. A frame that supplies them must clear those flags,
    // or the Trade tab keeps showing dashes until a REST reload. A duplicate
    // snapshot of an already priced version keeps its flags.
    ...(hasCurrentPrice && !duplicatePricedSnapshot
      ? { hasBackendCurrentPrice: raw.hasBackendCurrentPrice !== false && raw.pnl_available !== false }
      : {}),
    hasBackendProfit: duplicatePricedSnapshot ? existing.hasBackendProfit : raw.pnl_available === false ? false
      : hasProfit ? normalized.hasBackendProfit : existing.hasBackendProfit,
    comment: hasOwnValue(raw, ['comment']) ? normalized.comment : existing.comment,
  };
};

const positionVersion = (raw: any): string | undefined => (
  readPositionStateVersion(raw?.state_version_text ?? raw?.state_version) ?? undefined
);

// Do not coerce version strings to Number: PostgreSQL bigint exceeds JS's
// exact integer range. Unversioned legacy messages remain compatible.
export const isOlderPositionVersion = (incoming: any, existing: any): boolean => {
  const next = positionVersion(incoming);
  const current = positionVersion(existing);
  return next !== undefined && current !== undefined
    && (next.length < current.length || (next.length === current.length && next < current));
};

export type PositionStreamBatch = {
  positions: any[];
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
  'close', 'closed', 'position_closed', 'sl_hit', 'tp_hit', 'stop_out',
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

export const readPositionBulkCloseEvent = (message: any): PositionBulkCloseEvent | null => {
  const envelopes = [message?.data?.data, message?.data, message];
  const event = envelopes
    .flatMap((value) => [value?.event, value?.type, value?.action])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .find((value) => POSITION_BULK_CLOSED_EVENTS.has(value));
  if (!event) return null;

  const rawTickets = envelopes
    .flatMap((value) => [value?.closed_tickets, value?.closedTickets, value?.tickets])
    .find((value) => Array.isArray(value)) as unknown[] | undefined;
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
    const pos = current[i] as any;
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
      const profit = toFinite(pos?.profit ?? pos?.unrealizedPnL ?? pos?.unrealized_pl, 0);
      matchesFilter = profit > 0;
    } else if (filterType === 'LOSERS') {
      const profit = toFinite(pos?.profit ?? pos?.unrealizedPnL ?? pos?.unrealized_pl, 0);
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

export const readPositionStreamEvent = (message: any): { event: string; position: any } => {
  const envelopes = [message?.data?.data, message?.data, message];
  const event = envelopes.flatMap((value) => [value?.event, value?.type, value?.action])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .find((value) => value && value !== 'channel_message') ?? '';
  const allowResult = event.startsWith('position_') || POSITION_CLOSED_EVENTS.has(event);
  const position = envelopes.flatMap((value) => [
    value?.position,
    value?.closed_position,
    ...(allowResult ? [value?.result] : []),
    value,
  ]).find((value) => getPositionId(value) > 0);
  return { event, position };
};

const extractBatchFromRecord = (value: any): any[] | undefined => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return undefined;
  for (const key of ['positions', 'open_positions', 'items', 'data'] as const) {
    if (Array.isArray(value[key])) return value[key];
  }
  return undefined;
};

/** Account channels carry symbol-scoped P&L batches as well as snapshots.
 * Inspect the broker event inside either /ws/v2 or channel_message envelopes.
 * An array alone does not establish that omitted tickets have been closed.
 */
export const readPositionStreamBatch = (message: any): PositionStreamBatch | null => {
  const envelopes = [message, message?.data, message?.data?.data];
  const positions = envelopes
    .map(extractBatchFromRecord)
    .find((candidate): candidate is any[] => Array.isArray(candidate));
  const rawClosedTickets = envelopes
    .flatMap((value) => [value?.closed_tickets, value?.closedTickets, value?.tickets])
    .find((value) => Array.isArray(value)) as unknown[] | undefined;
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
    nextById.set(ticket, merged);
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
