import { useUiTranslation } from '../hooks/useUiTranslation';
import React, { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useLastSymbolStore } from '../store/useLastSymbolStore';
import {
  resolveDefaultTradeDeviation,
  resolveDefaultTradeVolume,
  useSettingsStore,
  useTradeDefaults,
} from '../store/useSettingsStore';
import {
  getChartDirectionalQuoteColors,
  getEffectiveChartColors,
  selectChartPropertiesForQuote,
  useChartSettingsStore,
  type ChartProperties,
} from '../store/useChartSettingsStore';
import { buildChartTheme } from '../features/trading-chart/presentation/chartTheme';
import { candleAggregationService, type OHLCV } from '../services/candleAggregationService';
import { candleCache } from '../services/candleCache';
import { isStructurallyValidPriceCandle } from '../services/chartPriceGuards';
import { API_V2_BASE_URL, RTX5_API_URL, toLocalDevProxyUrl } from '../config/api';
import { getPublicBackendTarget, isDesktopBackendTarget } from '../config/backendTarget.js';
import { useSymbolMarketStatus } from '../hooks/useSymbolMarketStatus';
import { useLiveOrderBook } from '../hooks/useLiveMarketData';
import {
  getMarketStatusTradeBlockMessage,
  shouldBlockSymbolTrading,
  type NormalizedMarketStatus,
} from '../utils/marketStatus';
import { formatSpreadDisplayWithUnit } from '../utils/spread';
import { RTX_ADVANCED_VIEW_CHANGE_EVENT } from '../utils/advancedViewRootClasses';
import { tradeApi } from '../api/trade';
import api from '../services/api';
import {
  buildBrokerApiV2,
  getAccessToken,
  getCommittedBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScopeKey,
} from '../services/brokerSession';
import { normalizeBrokerTimestampSeconds } from '../utils/brokerStreamSemantics';
import {
  CANDLE_TIMEFRAMES,
  getTimeframePeriodSeconds,
  type BoundaryTimeframe,
} from '../utils/timeframeBoundary';
import { getLivePositionProfit } from '../services/livePositionMetrics';
import {
  CHART_POSITION_MODIFY_EVENT,
  DARK_CHART_TRADE_COLORS,
  LIGHT_CHART_TRADE_COLORS,
  dispatchChartPositionAction,
  formatMoneyLabel,
  formatVolumeLots,
} from '../utils/chartTradeControls';
import { getStoredAccountLogin } from '../api/tradeGateway';
import { buildOrderTicketSymbolOptions } from '../utils/accountSymbolUniverse';
import { resolveSymbolDescription } from '../utils/symbolDescription';
import { resolveSpecDigits, stripFloatPrecisionNoise } from '../utils/symbolUtils';
import { inferObservedPriceDigits } from '../utils/chartPriceScale';
import { readRegisteredSymbolPriceSpec, readRegisteredSymbolStopsLevel } from '../services/dailyChangePriceModeRegistry';
import { depthExecutionForLevel } from './depthOfMarketModel';
import { captureTradeOrderIntent } from '../services/orderLatencyTelemetry';
import { accountMetricProvided } from '../services/accountMetrics';
import { formatOrderError } from '../utils/orderError';
import '../styles/order-panel-dialog.css';

// Symbol display names
const SYMBOL_NAMES: Record<string, string> = {
  EURUSD: 'Euro / US Dollar',
  GBPUSD: 'Pound / US Dollar',
  USDJPY: 'US Dollar / Yen',
  XAUUSD: 'Gold / US Dollar',
  XAGUSD: 'Silver / US Dollar',
  BTCUSD: 'Bitcoin / US Dollar',
  ETHUSD: 'Ethereum / US Dollar',
  AUDUSD: 'Aussie / US Dollar',
  USDCAD: 'US Dollar / CAD',
  USDCHF: 'US Dollar / Franc',
  NZDUSD: 'Kiwi / US Dollar',
  EURJPY: 'Euro / Yen',
  GBPJPY: 'Pound / Yen',
};

export type OrderType =
  | 'Market Execution'
  | 'Limit Order'
  | 'Stop Order'
  | 'Stop Limit Order'
  | 'Buy Limit'
  | 'Sell Limit'
  | 'Buy Stop'
  | 'Sell Stop'
  | 'Buy Stop Limit'
  | 'Sell Stop Limit';

const isLimitOrderType = (type: OrderType): boolean => (
  type === 'Limit Order' || type === 'Buy Limit' || type === 'Sell Limit'
);

const isStopOrderType = (type: OrderType): boolean => (
  type === 'Stop Order' || type === 'Buy Stop' || type === 'Sell Stop'
);

const isStopLimitOrderType = (type: OrderType): boolean => (
  type === 'Stop Limit Order' || type === 'Buy Stop Limit' || type === 'Sell Stop Limit'
);

const alignOrderTypeToSide = (type: OrderType, submitSide: 'buy' | 'sell'): OrderType => {
  const prefix = submitSide === 'buy' ? 'Buy' : 'Sell';
  if (type === 'Buy Limit' || type === 'Sell Limit') return `${prefix} Limit`;
  if (type === 'Buy Stop' || type === 'Sell Stop') return `${prefix} Stop`;
  if (type === 'Buy Stop Limit' || type === 'Sell Stop Limit') return `${prefix} Stop Limit`;
  return type;
};

export type FillPolicy = 'Fill or Kill' | 'Immediate or Cancel' | 'Return';
export type ExpirationType = 'GTC' | 'Today' | 'Specified' | 'Specified day';

interface OrderPanelProps {
  isOpen: boolean;
  onClose: () => void;
  symbol: string;
  currentPrice: { bid: number; ask: number };
  onSubmitOrder: (order: any) => Promise<void> | void;
  // Chart prefill (SUI-T10): when provided, the dialog opens with this order
  // type and price instead of blank defaults. Side still follows Buy/Sell.
  initialOrderType?: OrderType;
  initialPrice?: number;
  // Chart entry-point side (ITEM 2 / T10 side preselection): when provided
  // ('BUY'/'SELL'), the Buy/Sell submit path defaults to it while both
  // buttons stay functional. Invalid values are ignored (default flow).
  initialSide?: 'BUY' | 'SELL';
  marketStatus?: NormalizedMarketStatus;
  /**
   * Symbols the logged-in account may trade (its group catalogue). When
   * provided, the symbol dropdown offers only these instead of every quote
   * present in the tick store.
   */
  symbols?: readonly string[];
  /**
   * Broker instrument catalog rows (e.g. useMarketInstruments().symbols).
   * The dialog reads only broker data from them (contract_size, digits,
   * tick_size) for the currently selected symbol. Absent rows = unknown.
   */
  instruments?: readonly OrderPanelInstrumentRow[];
}

/** Broker catalog fields the dialog consumes (subset of MarketInstrument). */
export interface OrderPanelInstrumentRow {
  symbol: string;
  digits?: number;
  tickSize?: number;
  contractSize?: number;
  stops_level?: number;
  stopsLevel?: number;
}

export interface OrderPanelInstrumentConfig {
  /** Broker quote precision, or null when no broker data publishes it. */
  digits: number | null;
  /** Broker tick size, else 10^-digits; null when neither is known. */
  priceStep: number | null;
  /** Broker contract size, or null when the catalog does not publish it. */
  contractSize: number | null;
}

const readPositiveFinite = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
);

const readNonNegativeInt = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
};

export function resolveInstrumentStopsLevel(
  sym: string,
  instrument?: Partial<OrderPanelInstrumentRow> | null,
  liveTick?: { stops_level?: unknown; stopsLevel?: unknown } | null,
): number | null {
  return readRegisteredSymbolStopsLevel(sym)
    ?? readNonNegativeInt(instrument?.stops_level ?? instrument?.stopsLevel)
    ?? readNonNegativeInt(liveTick?.stops_level ?? liveTick?.stopsLevel);
}

/**
 * TERM-DIGITS-WL: instrument properties come ONLY from broker data, never
 * from the symbol name. Sources, in order: the registered broker catalog
 * (readRegisteredSymbolPriceSpec), the catalog row passed to the dialog,
 * then the live tick/quote payload digits. Unknown values stay null; the
 * symbol is used only as a lookup key into broker data.
 */
export function getInstrumentConfig(
  sym: string,
  liveDigits?: unknown,
  instrument?: Partial<OrderPanelInstrumentRow> | null,
  livePrices?: readonly unknown[],
): OrderPanelInstrumentConfig {
  const catalog = readRegisteredSymbolPriceSpec(sym);
  const baseDigits = resolveSpecDigits(catalog.digits, instrument?.digits, liveDigits);
  let digits = baseDigits;
  if (baseDigits !== null && baseDigits <= 2 && Array.isArray(livePrices) && livePrices.length > 0) {
    const hasSubUnitPrice = livePrices.some((value) => {
      const num = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(num) && num > 0 && num < 1;
    });
    if (hasSubUnitPrice) {
      const observed = inferObservedPriceDigits(null, livePrices);
      if (observed !== null && observed > baseDigits) {
        digits = Math.min(6, observed);
      }
    }
  }
  const tickSize = readPositiveFinite(catalog.tickSize) ?? readPositiveFinite(instrument?.tickSize);
  const digitStep = digits === null ? null : Math.pow(10, -digits);
  const priceStep = tickSize ?? digitStep;
  return {
    digits,
    priceStep,
    contractSize: readPositiveFinite(instrument?.contractSize),
  };
}

/** Broker digits -> fixed precision; unknown digits -> raw value (no guess). */
function formatDialogPrice(price: number, digits: number | null): string {
  return digits === null ? String(stripFloatPrecisionNoise(price)) : price.toFixed(digits);
}

// Format number with space separators (MT5 style: "1 000")
function formatMargin(val: number): string {
  const rounded = Math.round(val);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatRequiredMargin(val: number | null, currency: string): string {
  if (val === null || !Number.isFinite(val)) return '—';
  return `${formatMargin(val)} ${currency}`.trim();
}

function formatMt5QuotePrice(price: number, digits: number | null): string {
  if (!Number.isFinite(price) || price <= 0) return digits === null ? '—' : (0).toFixed(digits);
  const fixed = formatDialogPrice(price, digits);
  // Raw values in exponent notation (unknown digits) are shown verbatim.
  if (/e/i.test(fixed)) return fixed;
  const [intPart, decPart] = fixed.split('.');
  const spacedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return decPart !== undefined ? `${spacedInt}.${decPart}` : spacedInt;
}

function formatContractUnitsSummary(volumeStr: string, symbol: string, contractSize: number | null): string {
  const vol = Number.parseFloat(volumeStr);
  if (!Number.isFinite(vol) || vol <= 0) return `0 ${symbol}`;
  // Unknown broker contract size: honest unknown, never a guessed lot size.
  if (contractSize === null) return '—';
  const units = Number((vol * contractSize).toFixed(4));
  const [intPart, decPart] = String(units).split('.');
  const spacedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const formatted = decPart ? `${spacedInt}.${decPart}` : spacedInt;
  return `${formatted} ${symbol}`;
}

function formatDefaultExpirationDate(): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yy} ${hh}:${min}`;
}

// Parse a dialog expiration date string `DD.MM.YY HH:mm` or ISO `YYYY-MM-DDTHH:mm`
// (local time) to a Date, or null when unparseable. Strict shape: rejects overflow dates
// (e.g. 31.02.26) by round-tripping the components.
const parseDialogExpirationDate = (value: string): Date | null => {
  const trimmed = value.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?$/.exec(trimmed);
  if (isoMatch) {
    const [, yyyy, mm, dd, hh = '00', min = '00'] = isoMatch;
    const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), 0, 0);
    if (
      date.getFullYear() !== Number(yyyy)
      || date.getMonth() !== Number(mm) - 1
      || date.getDate() !== Number(dd)
      || date.getHours() !== Number(hh)
      || date.getMinutes() !== Number(min)
    ) return null;
    return date;
  }
  const match = /^(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const [, dd, mm, yy, hh, min] = match;
  const date = new Date(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(min), 0, 0);
  if (
    date.getDate() !== Number(dd) || date.getMonth() !== Number(mm) - 1
    || date.getFullYear() !== 2000 + Number(yy) || date.getHours() !== Number(hh)
    || date.getMinutes() !== Number(min)
  ) return null;
  return date;
};

export const formatDateTimeLocalValue = (ms: number): string => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const parseDateTimeLocalToDisplay = (isoLocal: string): string => {
  const parsed = parseDialogExpirationDate(isoLocal);
  if (!parsed) return isoLocal;
  const dd = String(parsed.getDate()).padStart(2, '0');
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const yy = String(parsed.getFullYear()).slice(-2);
  const hh = String(parsed.getHours()).padStart(2, '0');
  const min = String(parsed.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yy} ${hh}:${min}`;
};

export const formatDisplayToDateTimeLocal = (value: string, dateOnly = false): string => {
  const parsed = parseDialogExpirationDate(value);
  if (!parsed) return '';
  const full = formatDateTimeLocalValue(parsed.getTime());
  return dateOnly ? full.slice(0, 10) : full;
};

/**
 * Resolve the dialog expiration choice to whole epoch SECONDS for the order
 * wire (SUI-T2). Semantics (local time, documented): GTC → undefined (no
 * expiry); Today → end of the current local day; Specified day → end of the
 * selected local date; Specified → the exact selected local datetime. Past or
 * unparseable dated values THROW so submit blocks fail-closed (never 0/NaN).
 */
export const resolveDialogExpirationTimestamp = (
  expiration: ExpirationType,
  expirationDateStr: string,
  nowMs = Date.now(),
): number | undefined => {
  if (expiration === 'GTC') return undefined;
  if (expiration === 'Today') {
    const end = new Date(nowMs);
    end.setHours(23, 59, 59, 0);
    const seconds = Math.floor(end.getTime() / 1000);
    if (!(seconds * 1000 > nowMs)) throw new Error('Expiration must be in the future');
    return seconds;
  }
  const parsed = parseDialogExpirationDate(expirationDateStr);
  if (!parsed) throw new Error('Enter a valid expiration date (DD.MM.YY HH:mm)');
  if (expiration === 'Specified day') parsed.setHours(23, 59, 59, 0);
  const seconds = Math.floor(parsed.getTime() / 1000);
  if (!(seconds * 1000 > nowMs)) throw new Error('Expiration must be in the future');
  return seconds;
};

// SUI-T8: the ticket's last lot size feeds `last-used` volume mode. Kept at
// module scope so the field initializer and the open-reset share one read path.
function readStoredLotSize(): unknown {
  try {
    return localStorage.getItem('lastLotSize');
  } catch {
    return undefined;
  }
}

type TickChartColors = ChartProperties['colors'];

type TickPoint = { time: number; bid: number; ask: number };

type MiniChartTimeframe = BoundaryTimeframe;
const MINI_CHART_TIMEFRAMES: readonly MiniChartTimeframe[] = CANDLE_TIMEFRAMES;

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

type MiniChartAxisTimeMode =
  | 'date-year'
  | 'date-time'
  | 'time'
  | 'date-utc'
  | 'date-year-utc'
  | 'month-year-utc';

const formatMiniChartAxisTime = (timeMs: number, mode: MiniChartAxisTimeMode): string => {
  const date = new Date(timeMs);
  if (mode === 'date-utc' || mode === 'date-year-utc' || mode === 'month-year-utc') {
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const mon = SHORT_MONTHS[date.getUTCMonth()] ?? '';
    const yyyy = date.getUTCFullYear();
    if (mode === 'month-year-utc') return `${mon} ${yyyy}`;
    if (mode === 'date-year-utc') return `${dd} ${mon} ${yyyy}`;
    return `${dd} ${mon}`;
  }
  const dd = String(date.getDate()).padStart(2, '0');
  const mon = SHORT_MONTHS[date.getMonth()] ?? '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (mode === 'date-year') return `${dd} ${mon} ${date.getFullYear()}`;
  if (mode === 'date-time') return `${dd} ${mon} ${hh}:${mm}`;
  return `${hh}:${mm}`;
};

export const formatPendingOrderBadgeLabel = (
  side: string | undefined,
  type: string | undefined,
  volume: number | undefined,
): string => {
  const normalizedType = String(type ?? '')
    .trim()
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .toUpperCase();
  const normalizedSide = String(side ?? '').trim().toUpperCase();
  const typeAlreadyIncludesSide =
    normalizedType === 'BUY'
    || normalizedType === 'SELL'
    || normalizedType.startsWith('BUY ')
    || normalizedType.startsWith('SELL ');
  const prefix = typeAlreadyIncludesSide
    ? normalizedType
    : [normalizedSide, normalizedType].filter(Boolean).join(' ');
  const volPart = typeof volume === 'number' && Number.isFinite(volume) && volume > 0
    ? String(volume)
    : '';
  return `${prefix}${volPart ? ` ${volPart}` : ''}`.trim();
};

const aggregateM1CandlesToTimeframe = (
  m1Candles: readonly OHLCV[],
  timeframe: MiniChartTimeframe,
): OHLCV[] => {
  if (timeframe === 'M1' || m1Candles.length === 0) {
    return m1Candles.map((c) => ({ ...c }));
  }
  const buckets: OHLCV[] = [];
  for (const candle of m1Candles) {
    const bucketTime = getTimeframePeriodSeconds(candle.time, timeframe)?.startTime;
    if (bucketTime === undefined) continue;
    const last = buckets[buckets.length - 1];
    if (last && last.time === bucketTime) {
      last.high = Math.max(last.high, candle.high);
      last.low = Math.min(last.low, candle.low);
      last.close = candle.close;
      last.volume = (last.volume || 0) + (candle.volume || 0);
    } else {
      buckets.push({
        time: bucketTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
      });
    }
  }
  return buckets;
};

const resolveMiniChartCandleCacheScope = (): string => {
  const brokerBase = toLocalDevProxyUrl(buildBrokerApiV2()).replace(/\/$/, '');
  if (brokerBase) return brokerBase;
  const apiV2Base = API_V2_BASE_URL.replace(/\/$/, '');
  if (apiV2Base) return apiV2Base;
  const configBase = RTX5_API_URL.replace(/\/$/, '');
  return (configBase ? `${configBase}/api/v2` : '/api/v2') || 'default';
};

const normalizeDialogCandles = (raw: unknown, timeframe: MiniChartTimeframe): OHLCV[] => {
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { candles?: unknown }).candles))
      ? (raw as { candles: unknown[] }).candles
      : [];
  const byTime = new Map<number, OHLCV>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const rawTime = normalizeBrokerTimestampSeconds(
      row.time ?? row.Time ?? row.timestamp ?? row.t ?? row.date ?? row.datetime ?? row.open_time ?? row.openTime,
    );
    if (!rawTime) continue;
    const bucketTime = getTimeframePeriodSeconds(rawTime, timeframe)?.startTime ?? rawTime;
    const open = Number(row.open ?? row.Open ?? row.o);
    const high = Number(row.high ?? row.High ?? row.h);
    const low = Number(row.low ?? row.Low ?? row.l);
    const close = Number(row.close ?? row.Close ?? row.c);
    const volume = Number(row.tick_volume ?? row.tickVolume ?? row.volume ?? row.v ?? 0);
    if (!isStructurallyValidPriceCandle({ open, high, low, close })) continue;
    byTime.set(bucketTime, {
      time: bucketTime,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
    });
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
};

const mergeMiniChartCandles = (baseline: readonly OHLCV[], live: readonly OHLCV[]): OHLCV[] => {
  if (baseline.length === 0) return live.map((c) => ({ ...c }));
  if (live.length === 0) return baseline.map((c) => ({ ...c }));
  const byTime = new Map<number, OHLCV>();
  for (const bar of baseline) {
    if (Number.isFinite(bar.time) && bar.time > 0) {
      byTime.set(bar.time, { ...bar });
    }
  }
  const latestBaselineTime = baseline[baseline.length - 1]?.time ?? 0;
  for (const bar of live) {
    if (!Number.isFinite(bar.time) || bar.time <= 0) continue;
    const existing = byTime.get(bar.time);
    if (!existing) {
      if (bar.time >= latestBaselineTime || byTime.size < 2) {
        byTime.set(bar.time, { ...bar });
      }
    } else if (bar.time >= latestBaselineTime && bar.isComplete !== true) {
      byTime.set(bar.time, {
        ...existing,
        high: Math.max(existing.high, bar.high),
        low: Math.min(existing.low, bar.low),
        close: bar.close,
        volume: Math.max(existing.volume || 0, bar.volume || 0),
      });
    }
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
};

const computeNicePriceTicks = (
  minPrice: number,
  maxPrice: number,
  targetCount: number,
  minStep: number | null,
): number[] => {
  const span = maxPrice - minPrice;
  if (!(span > 0) || targetCount <= 0) return [];
  const rawStep = span / Math.max(2, targetCount);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  let niceFactor = 1;
  if (normalized <= 1.2) niceFactor = 1;
  else if (normalized <= 2.2) niceFactor = 2;
  else if (normalized <= 3.2) niceFactor = 2.5;
  else if (normalized <= 6) niceFactor = 5;
  else niceFactor = 10;
  let step = niceFactor * magnitude;
  if (minStep !== null && Number.isFinite(minStep) && minStep > 0 && step < minStep) {
    step = minStep;
  }
  const start = Math.ceil(minPrice / step) * step;
  const ticks: number[] = [];
  const maxIterations = 24;
  for (let i = 0; i < maxIterations; i += 1) {
    const value = start + i * step;
    if (value > maxPrice - step * 0.08) break;
    if (value >= minPrice + step * 0.08) {
      ticks.push(stripFloatPrecisionNoise(value));
    }
  }
  return ticks;
};

interface VerticalSlotItem {
  rawY: number;
  priority: number;
}

const resolveVerticalTagSlots = <T extends VerticalSlotItem>(
  items: readonly T[],
  minY: number,
  maxY: number,
  minGap: number,
): Array<T & { resolvedY: number }> => {
  if (items.length === 0 || maxY < minY) return [];
  const capacity = Math.max(1, Math.floor((maxY - minY) / Math.max(1, minGap)) + 1);
  // Keep highest-priority items first if the plot cannot physically fit every badge without overlap
  const kept = items.length > capacity
    ? [...items]
        .sort((a, b) => b.priority - a.priority)
        .slice(0, capacity)
    : [...items];

  const sorted = kept
    .map((item) => ({
      ...item,
      resolvedY: Math.max(minY, Math.min(maxY, item.rawY)),
    }))
    .sort((a, b) => (a.rawY === b.rawY ? b.priority - a.priority : a.rawY - b.rawY));

  for (let i = 1; i < sorted.length; i += 1) {
    const minAllowed = sorted[i - 1].resolvedY + minGap;
    if (sorted[i].resolvedY < minAllowed) {
      sorted[i].resolvedY = minAllowed;
    }
  }

  const overflow = sorted[sorted.length - 1].resolvedY - maxY;
  if (overflow > 0) {
    sorted[sorted.length - 1].resolvedY = maxY;
    for (let i = sorted.length - 2; i >= 0; i -= 1) {
      const maxAllowed = sorted[i + 1].resolvedY - minGap;
      if (sorted[i].resolvedY > maxAllowed) {
        sorted[i].resolvedY = maxAllowed;
      }
    }
  }

  for (const item of sorted) {
    item.resolvedY = Math.max(minY, Math.min(maxY, item.resolvedY));
  }

  return sorted;
};

const drawCrispPillRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  fillStyle?: string,
  strokeStyle?: string,
) => {
  const canRound = radius > 0 && typeof ctx.quadraticCurveTo === 'function';
  if (!canRound) {
    if (fillStyle) {
      ctx.fillStyle = fillStyle;
      ctx.fillRect(x, y, w, h);
    }
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    }
    return;
  }

  const r = Math.min(radius, w / 2, h / 2);
  const bx = x + 0.5;
  const by = y + 0.5;
  const bw = Math.max(0, w - 1);
  const bh = Math.max(0, h - 1);

  ctx.beginPath();
  ctx.moveTo(bx + r, by);
  ctx.lineTo(bx + bw - r, by);
  ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
  ctx.lineTo(bx + bw, by + bh - r);
  ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
  ctx.lineTo(bx + r, by + bh);
  ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
  ctx.lineTo(bx, by + r);
  ctx.quadraticCurveTo(bx, by, bx + r, by);
  ctx.closePath();

  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }
  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
};

type MiniChartDisplayType = 'bar' | 'candlestick' | 'line' | 'dot' | 'area' | 'hlc';

const MINI_CHART_TYPE_OPTIONS: ReadonlyArray<{ id: MiniChartDisplayType; label: string }> = [
  { id: 'candlestick', label: 'Candlestick chart' },
  { id: 'bar', label: 'Bar chart' },
  { id: 'line', label: 'Line chart' },
  { id: 'dot', label: 'Dot chart' },
  { id: 'area', label: 'Area chart' },
  { id: 'hlc', label: 'HLC chart' },
];

function MiniChartTypeIcon({ type }: { type: MiniChartDisplayType }) {
  switch (type) {
    case 'bar':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 3.5V12.5M2.3 6.5H4M4 9.5H5.7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          <path d="M8 2.5V13.5M6.3 8.5H8M8 5.5H9.7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          <path d="M12 4V12M10.3 6H12M12 9H13.7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        </svg>
      );
    case 'candlestick':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 3V13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <rect x="2.2" y="5.5" width="2.6" height="5" rx="0.4" fill="currentColor" />
          <path d="M8 2V4.2M8 10.4V14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <rect x="6.7" y="4.2" width="2.6" height="6.2" rx="0.4" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path d="M12.5 3.5V12.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <rect x="11.2" y="5.8" width="2.6" height="4.4" rx="0.4" fill="currentColor" />
        </svg>
      );
    case 'line':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M1.8 10.5L4.8 12.6L8.2 6.8L11.2 9.4L14.2 3.6"
            stroke="currentColor"
            strokeWidth="1.45"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'dot':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="3" cy="10.5" r="1.2" fill="currentColor" />
          <circle cx="5.6" cy="8.2" r="1.2" fill="currentColor" />
          <circle cx="7.8" cy="11.2" r="1.2" fill="currentColor" />
          <circle cx="9.8" cy="6.2" r="1.2" fill="currentColor" />
          <circle cx="11.8" cy="8.8" r="1.2" fill="currentColor" />
          <circle cx="13.5" cy="4.8" r="1.2" fill="currentColor" />
        </svg>
      );
    case 'area':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M1.8 11.2L5.2 7.4L8.4 9.6L12.6 4.5L14.2 6.2V12.8H1.8V11.2Z"
            fill="currentColor"
            fillOpacity="0.28"
          />
          <path
            d="M1.8 11.2L5.2 7.4L8.4 9.6L12.6 4.5L14.2 6.2"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M1.8 13H14.2" stroke="currentColor" strokeWidth="1.1" strokeDasharray="1.4 1.4" />
        </svg>
      );
    case 'hlc':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 3.5V12.5M4 9.5H5.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          <path d="M8 2.5V13.5M8 5.5H9.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          <path d="M12 4V12M12 8.5H13.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        </svg>
      );
  }
}

// ─── Enterprise MT5 Tick & Candlestick Chart ──────────────────────
interface MiniChartTradeBarItem {
  id: string;
  price: number;
  kind: 'position' | 'pending' | 'sl' | 'tp' | 'draft';
  side: 'BUY' | 'SELL' | 'NEUTRAL';
  ticket?: number;
  parentKind?: 'position' | 'pending';
  typeLabel: string;
  volumeLabel?: string;
  pnlValue?: number | null;
  showTpChip?: boolean;
  showSlChip?: boolean;
  canClose?: boolean;
  accentColorLight: string;
  accentColorDark: string;
  priority: number;
}

const formatDraftOrderTypeLabel = (orderType: OrderType | undefined, sideHint: 'buy' | 'sell' | null | undefined): string => {
  if (!orderType || orderType === 'Market Execution') return 'PRICE';
  const upper = orderType.trim().toUpperCase();
  if (upper.startsWith('BUY ') || upper.startsWith('SELL ')) return upper;
  const sidePrefix = sideHint === 'sell' ? 'SELL' : 'BUY';
  if (upper.startsWith('LIMIT')) return `${sidePrefix} LIMIT`;
  if (upper.startsWith('STOP LIMIT')) return `${sidePrefix} STOP LIMIT`;
  if (upper.startsWith('STOP')) return `${sidePrefix} STOP`;
  return upper;
};

function MiniTickChart({
  symbol,
  bid,
  ask,
  digits,
  priceStep,
  chartColors,
  chartSettings,
  isAdvancedUntitledLight,
  orderPrice,
  stopLossPrice,
  takeProfitPrice,
  volumeText,
  sideHint,
  orderType,
}: {
  symbol: string;
  bid: number;
  ask: number;
  /** Broker digits; null = unknown (raw prices, no interpolated axis labels). */
  digits: number | null;
  /** Broker tick size or 10^-digits; null = unknown. */
  priceStep: number | null;
  chartColors: TickChartColors;
  chartSettings: ChartProperties;
  isAdvancedUntitledLight: boolean;
  orderPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  volumeText?: string;
  sideHint?: 'buy' | 'sell' | null;
  orderType?: OrderType;
}) {
  const tr = useUiTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayLayerRef = useRef<HTMLDivElement>(null);
  const chartTypeMenuRef = useRef<HTMLDivElement>(null);
  const tickHistoryRef = useRef<TickPoint[]>([]);
  const frameRef = useRef<number | null>(null);
  const hoverPosRef = useRef<{ x: number; y: number } | null>(null);
  const scheduleDrawRef = useRef<() => void>(() => undefined);
  const ohlcOpenRef = useRef<HTMLSpanElement>(null);
  const ohlcHighRef = useRef<HTMLSpanElement>(null);
  const ohlcLowRef = useRef<HTMLSpanElement>(null);
  const ohlcCloseRef = useRef<HTMLSpanElement>(null);
  const fetchedCandlesByKeyRef = useRef<Map<string, OHLCV[]>>(new Map());
  const inFlightHistoryKeysRef = useRef<Set<string>>(new Set());
  const [miniChartType, setMiniChartType] = useState<MiniChartDisplayType>('candlestick');
  const [activeTimeframe, setActiveTimeframe] = useState<MiniChartTimeframe>('M1');
  const [historyRevision, setHistoryRevision] = useState(0);
  const [isChartTypeMenuOpen, setIsChartTypeMenuOpen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const showPriceLines = true;
  const chartShift = true;

  const chartTheme = useMemo(
    () => buildChartTheme(
      chartColors,
      chartSettings.showGrid,
      isAdvancedUntitledLight,
      chartSettings.gridLineStyle,
      chartSettings.gridType,
      chartSettings.colorScheme,
    ),
    [
      chartColors,
      chartSettings.colorScheme,
      chartSettings.gridLineStyle,
      chartSettings.gridType,
      chartSettings.showGrid,
      isAdvancedUntitledLight,
    ],
  );

  const hudQuoteColors = useMemo(
    () => getChartDirectionalQuoteColors(chartSettings, { isAdvancedUntitledLight }),
    [chartSettings, isAdvancedUntitledLight],
  );

  useEffect(() => {
    if (!isChartTypeMenuOpen) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (chartTypeMenuRef.current && !chartTypeMenuRef.current.contains(event.target as Node)) {
        setIsChartTypeMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsChartTypeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isChartTypeMenuOpen]);

  const allPositions = useAppStore((s) => s.positions);
  const allOrders = useAppStore((s) => s.orders);
  const normalizedTargetSymbol = symbol.trim().toUpperCase();

  const symbolPositions = useMemo(
    () => (allPositions ?? []).filter((p) => String(p?.symbol ?? '').trim().toUpperCase() === normalizedTargetSymbol),
    [allPositions, normalizedTargetSymbol],
  );
  const symbolPendingOrders = useMemo(
    () => (allOrders ?? []).filter(
      (o) => String(o?.symbol ?? '').trim().toUpperCase() === normalizedTargetSymbol
        && (!o.status || o.status === 'PENDING'),
    ),
    [allOrders, normalizedTargetSymbol],
  );

  // Unified main-chart-style trade & pending-order floating bar descriptors
  const tradeBarItems = useMemo<MiniChartTradeBarItem[]>(() => {
    const items: MiniChartTradeBarItem[] = [];

    symbolPositions.forEach((pos, idx) => {
      const entryPrice = Number(pos.openPrice ?? pos.open_price ?? pos.price_open ?? 0);
      const isBuy = String(pos.side ?? '').toUpperCase() === 'BUY';
      const vol = Number(pos.volume ?? pos.quantity ?? 0);
      const ticket = Number(pos.id);
      const hasTicket = Number.isSafeInteger(ticket) && ticket > 0;
      const livePnl = getLivePositionProfit(pos);
      const rawProfit = livePnl !== null && Number.isFinite(livePnl)
        ? livePnl
        : (Number.isFinite(Number(pos.profit)) ? Number(pos.profit) : null);
      const hasSl = Number.isFinite(pos.sl) && pos.sl > 0;
      const hasTp = Number.isFinite(pos.tp) && pos.tp > 0;

      if (Number.isFinite(entryPrice) && entryPrice > 0) {
        items.push({
          id: `pos-${pos.id ?? idx}`,
          price: entryPrice,
          kind: 'position',
          side: isBuy ? 'BUY' : 'SELL',
          ticket: hasTicket ? ticket : undefined,
          typeLabel: isBuy ? 'BUY' : 'SELL',
          volumeLabel: vol > 0 ? formatVolumeLots(vol) : undefined,
          pnlValue: rawProfit,
          showTpChip: !hasTp,
          showSlChip: !hasSl,
          canClose: hasTicket,
          accentColorLight: isBuy ? LIGHT_CHART_TRADE_COLORS.buy : LIGHT_CHART_TRADE_COLORS.sell,
          accentColorDark: isBuy ? DARK_CHART_TRADE_COLORS.buy : DARK_CHART_TRADE_COLORS.sell,
          priority: 50,
        });
      }
      if (hasSl) {
        items.push({
          id: `pos-sl-${pos.id ?? idx}`,
          price: pos.sl,
          kind: 'sl',
          side: isBuy ? 'BUY' : 'SELL',
          ticket: hasTicket ? ticket : undefined,
          parentKind: 'position',
          typeLabel: 'SL',
          volumeLabel: formatDialogPrice(pos.sl, digits),
          canClose: false,
          accentColorLight: LIGHT_CHART_TRADE_COLORS.sl,
          accentColorDark: DARK_CHART_TRADE_COLORS.sl,
          priority: 40,
        });
      }
      if (hasTp) {
        items.push({
          id: `pos-tp-${pos.id ?? idx}`,
          price: pos.tp,
          kind: 'tp',
          side: isBuy ? 'BUY' : 'SELL',
          ticket: hasTicket ? ticket : undefined,
          parentKind: 'position',
          typeLabel: 'TP',
          volumeLabel: formatDialogPrice(pos.tp, digits),
          canClose: false,
          accentColorLight: LIGHT_CHART_TRADE_COLORS.tp,
          accentColorDark: DARK_CHART_TRADE_COLORS.tp,
          priority: 40,
        });
      }
    });

    symbolPendingOrders.forEach((ord, idx) => {
      const isBuy = String(ord.side ?? '').toUpperCase() === 'BUY';
      const ticket = Number(ord.id);
      const hasTicket = Number.isSafeInteger(ticket) && ticket > 0;
      const hasSl = typeof ord.sl === 'number' && Number.isFinite(ord.sl) && ord.sl > 0;
      const hasTp = typeof ord.tp === 'number' && Number.isFinite(ord.tp) && ord.tp > 0;
      const typeOnlyLabel = formatPendingOrderBadgeLabel(ord.side, ord.type, undefined);

      if (Number.isFinite(ord.price) && ord.price > 0) {
        items.push({
          id: `ord-${ord.id ?? idx}`,
          price: ord.price,
          kind: 'pending',
          side: isBuy ? 'BUY' : 'SELL',
          ticket: hasTicket ? ticket : undefined,
          typeLabel: typeOnlyLabel || (isBuy ? 'BUY LIMIT' : 'SELL LIMIT'),
          volumeLabel: Number.isFinite(ord.volume) && ord.volume > 0 ? formatVolumeLots(ord.volume) : undefined,
          showTpChip: !hasTp,
          showSlChip: !hasSl,
          canClose: hasTicket,
          accentColorLight: isBuy ? LIGHT_CHART_TRADE_COLORS.pendingBuy : LIGHT_CHART_TRADE_COLORS.pendingSell,
          accentColorDark: isBuy ? DARK_CHART_TRADE_COLORS.pendingBuy : DARK_CHART_TRADE_COLORS.pendingSell,
          priority: 55,
        });
      }
      if (hasSl && typeof ord.sl === 'number') {
        items.push({
          id: `ord-sl-${ord.id ?? idx}`,
          price: ord.sl,
          kind: 'sl',
          side: isBuy ? 'BUY' : 'SELL',
          ticket: hasTicket ? ticket : undefined,
          parentKind: 'pending',
          typeLabel: 'SL',
          volumeLabel: formatDialogPrice(ord.sl, digits),
          canClose: false,
          accentColorLight: LIGHT_CHART_TRADE_COLORS.sl,
          accentColorDark: DARK_CHART_TRADE_COLORS.sl,
          priority: 42,
        });
      }
      if (hasTp && typeof ord.tp === 'number') {
        items.push({
          id: `ord-tp-${ord.id ?? idx}`,
          price: ord.tp,
          kind: 'tp',
          side: isBuy ? 'BUY' : 'SELL',
          ticket: hasTicket ? ticket : undefined,
          parentKind: 'pending',
          typeLabel: 'TP',
          volumeLabel: formatDialogPrice(ord.tp, digits),
          canClose: false,
          accentColorLight: LIGHT_CHART_TRADE_COLORS.tp,
          accentColorDark: DARK_CHART_TRADE_COLORS.tp,
          priority: 42,
        });
      }
    });

    if (typeof orderPrice === 'number' && Number.isFinite(orderPrice) && orderPrice > 0) {
      const draftSide: 'BUY' | 'SELL' =
        orderType?.toLowerCase().startsWith('sell')
          ? 'SELL'
          : orderType?.toLowerCase().startsWith('buy')
            ? 'BUY'
            : (sideHint === 'sell' ? 'SELL' : 'BUY');
      const parsedVol = Number.parseFloat(volumeText ?? '');
      items.push({
        id: 'draft-price',
        price: orderPrice,
        kind: 'draft',
        side: draftSide,
        typeLabel: formatDraftOrderTypeLabel(orderType, sideHint),
        volumeLabel: Number.isFinite(parsedVol) && parsedVol > 0 ? formatVolumeLots(parsedVol) : undefined,
        showTpChip: !(typeof takeProfitPrice === 'number' && takeProfitPrice > 0),
        showSlChip: !(typeof stopLossPrice === 'number' && stopLossPrice > 0),
        canClose: false,
        accentColorLight: draftSide === 'BUY' ? LIGHT_CHART_TRADE_COLORS.pendingBuy : LIGHT_CHART_TRADE_COLORS.pendingSell,
        accentColorDark: draftSide === 'BUY' ? DARK_CHART_TRADE_COLORS.pendingBuy : DARK_CHART_TRADE_COLORS.pendingSell,
        priority: 80,
      });
    }
    if (typeof stopLossPrice === 'number' && Number.isFinite(stopLossPrice) && stopLossPrice > 0) {
      items.push({
        id: 'draft-sl',
        price: stopLossPrice,
        kind: 'sl',
        side: 'NEUTRAL',
        typeLabel: 'SL',
        volumeLabel: formatDialogPrice(stopLossPrice, digits),
        canClose: false,
        accentColorLight: LIGHT_CHART_TRADE_COLORS.sl,
        accentColorDark: DARK_CHART_TRADE_COLORS.sl,
        priority: 75,
      });
    }
    if (typeof takeProfitPrice === 'number' && Number.isFinite(takeProfitPrice) && takeProfitPrice > 0) {
      items.push({
        id: 'draft-tp',
        price: takeProfitPrice,
        kind: 'tp',
        side: 'NEUTRAL',
        typeLabel: 'TP',
        volumeLabel: formatDialogPrice(takeProfitPrice, digits),
        canClose: false,
        accentColorLight: LIGHT_CHART_TRADE_COLORS.tp,
        accentColorDark: DARK_CHART_TRADE_COLORS.tp,
        priority: 75,
      });
    }

    return items;
  }, [
    bid,
    ask,
    digits,
    orderPrice,
    orderType,
    sideHint,
    stopLossPrice,
    symbolPendingOrders,
    symbolPositions,
    takeProfitPrice,
    volumeText,
  ]);

  const handleOpenModifyForBar = useCallback((item: MiniChartTradeBarItem, role?: 'TP' | 'SL') => {
    if (item.kind === 'draft') {
      const targetId = role === 'TP' ? `${symbol}-tp` : `${symbol}-sl`;
      const input = document.querySelector<HTMLInputElement>(
        role === 'TP' ? 'input[id$="take-profit"]' : 'input[id$="stop-loss"]',
      );
      if (input) {
        input.focus();
      } else {
        void targetId;
      }
      return;
    }
    if (!item.ticket) return;
    const sessionScope = getCommittedBrokerAccountSessionScopeKey(
      getCommittedBrokerAccountSessionScope(),
    );
    const kind = item.kind === 'pending' || item.parentKind === 'pending' ? 'pending-order' : 'position';
    window.dispatchEvent(new CustomEvent(CHART_POSITION_MODIFY_EVENT, {
      detail: { ticket: item.ticket, symbol, sessionScope, kind },
    }));
  }, [symbol]);

  const handleCloseOrCancelBar = useCallback((item: MiniChartTradeBarItem) => {
    if (!item.ticket) return;
    if (item.kind === 'pending') {
      void api.orders.cancelOrder(String(item.ticket))
        .then(() => {
          const loginId = Number.parseInt(String(useAppStore.getState().accountId ?? ''), 10);
          if (Number.isFinite(loginId) && loginId > 0) {
            return api.orders.getPendingOrders(loginId).then((orders) => {
              useAppStore.getState().setOrders(orders as any);
            });
          }
        })
        .catch((err) => {
          window.dispatchEvent(new CustomEvent('rtx:order-feedback', {
            detail: { message: formatOrderError(err), type: 'error' },
          }));
        });
      return;
    }
    if (item.kind === 'position') {
      dispatchChartPositionAction({ action: 'close', ticket: item.ticket, symbol });
    }
  }, [symbol]);

  useEffect(() => {
    tickHistoryRef.current = [];
    hoverPosRef.current = null;
  }, [symbol]);

  useEffect(() => {
    const normalizedSym = symbol.trim();
    if (!normalizedSym) return;
    const cacheScope = resolveMiniChartCandleCacheScope();
    const historyKey = `${cacheScope}\u001f${normalizedSym.toUpperCase()}\u001f${activeTimeframe}`;
    if (fetchedCandlesByKeyRef.current.has(historyKey) || inFlightHistoryKeysRef.current.has(historyKey)) {
      return;
    }

    const cachedEntry = candleCache.getLatestForSymbolTimeframe(cacheScope, normalizedSym, activeTimeframe);
    if (cachedEntry && (cachedEntry.source !== 'derived-m1' || cachedEntry.candles.length >= 24)) {
      return;
    }

    const existingAgg = candleAggregationService.getCandles(normalizedSym, activeTimeframe, true, false);
    if (existingAgg.length >= 24) {
      return;
    }

    const hasCandleBackend = isDesktopBackendTarget() || Boolean(getAccessToken()) || Boolean(getPublicBackendTarget());
    if (!hasCandleBackend) return;

    let cancelled = false;
    inFlightHistoryKeysRef.current.add(historyKey);

    const loadCandles = async () => {
      try {
        const raw = await tradeApi.market.getCandles(normalizedSym, {
          timeframe: activeTimeframe,
          limit: 120,
        });
        let normalized = normalizeDialogCandles(raw, activeTimeframe);
        if (!cancelled && normalized.length === 0 && (activeTimeframe === 'W1' || activeTimeframe === 'MN')) {
          const d1Raw = await tradeApi.market.getCandles(normalizedSym, {
            timeframe: 'D1',
            limit: 500,
          });
          const d1Candles = normalizeDialogCandles(d1Raw, 'D1');
          if (d1Candles.length > 0) {
            normalized = aggregateM1CandlesToTimeframe(d1Candles, activeTimeframe);
          }
        }
        if (cancelled) return;
        fetchedCandlesByKeyRef.current.set(historyKey, normalized);
        if (normalized.length > 0) {
          setHistoryRevision((rev) => rev + 1);
        }
      } catch {
        // Keep existing aggregation/tick fallback when history endpoint is unavailable.
      } finally {
        inFlightHistoryKeysRef.current.delete(historyKey);
      }
    };

    void loadCandles();
    return () => {
      cancelled = true;
    };
  }, [activeTimeframe, symbol]);

  useEffect(() => {
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;

    const now = Date.now();
    const nextTick = { time: now, bid, ask };
    const cutoff = now - 300_000;
    const retained = tickHistoryRef.current.filter((tick) => tick.time >= cutoff);
    const lastTick = retained[retained.length - 1];

    if (lastTick && lastTick.bid === bid && lastTick.ask === ask) {
      retained[retained.length - 1] = nextTick;
    } else {
      retained.push(nextTick);
    }

    tickHistoryRef.current = retained.slice(-240);
  }, [bid, ask]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const readCssValue = (name: string, fallback: string): string => {
      const value = window.getComputedStyle(canvas).getPropertyValue(name).trim();
      return value || fallback;
    };

    const updateOhlcHud = (bar: { open: number; high: number; low: number; close: number } | null) => {
      if (!bar) {
        if (ohlcOpenRef.current) ohlcOpenRef.current.textContent = '—';
        if (ohlcHighRef.current) ohlcHighRef.current.textContent = '—';
        if (ohlcLowRef.current) ohlcLowRef.current.textContent = '—';
        if (ohlcCloseRef.current) ohlcCloseRef.current.textContent = '—';
        return;
      }
      if (ohlcOpenRef.current) ohlcOpenRef.current.textContent = formatDialogPrice(bar.open, digits);
      if (ohlcHighRef.current) ohlcHighRef.current.textContent = formatDialogPrice(bar.high, digits);
      if (ohlcLowRef.current) ohlcLowRef.current.textContent = formatDialogPrice(bar.low, digits);
      if (ohlcCloseRef.current) ohlcCloseRef.current.textContent = formatDialogPrice(bar.close, digits);
    };

    const draw = () => {
      const isCompactViewport = window.innerWidth <= 1720 || window.innerHeight <= 920;
      const cssWidth = Math.max(isCompactViewport ? 280 : 380, Math.round(canvas.clientWidth || (isCompactViewport ? 460 : 540)));
      const cssHeight = Math.max(isCompactViewport ? 220 : 280, Math.round(canvas.clientHeight || (isCompactViewport ? 350 : 450)));
      const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
      const backingWidth = Math.round(cssWidth * pixelRatio);
      const backingHeight = Math.round(cssHeight * pixelRatio);

      if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
        canvas.width = backingWidth;
        canvas.height = backingHeight;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      const isLightSkin =
        isAdvancedUntitledLight
        || document.documentElement.classList.contains('rtx-skin-untitled-light')
        || document.documentElement.classList.contains('theme-light');

      // Exact trading chart color palette from buildChartTheme / useChartSettingsStore
      const candleUpBody = chartTheme.candleUp || chartColors.bullCandle || chartColors.barUp || '#2563eb';
      const candleDownBody = chartTheme.candleDown || chartColors.bearCandle || chartColors.barDown || '#dc2626';
      const candleUpBorder = chartTheme.barUp || candleUpBody;
      const candleDownBorder = chartTheme.barDown || candleDownBody;

      const palette = {
        background: chartTheme.background || chartColors.background || readCssValue('--bg-primary', isLightSkin ? '#ffffff' : '#000000'),
        foreground: chartTheme.text || chartColors.foreground || readCssValue('--text-secondary', isLightSkin ? '#0f172a' : '#ffffff'),
        grid: chartColors.grid || readCssValue('--border-primary', 'rgba(255,255,255,0.12)'),
        axisSurface: chartTheme.background || readCssValue('--order-chart-axis-surface', isLightSkin ? '#ffffff' : '#090d14'),
        axis: readCssValue('color', '#a1a1aa'),
        bid: chartColors.bidPriceLine || readCssValue('--order-bid', '#778899'),
        ask: chartColors.askPriceLine || readCssValue('--order-ask', '#F23645'),
        stopLevel: chartColors.stopLevels || '#dc2626',
        tagText: readCssValue('--order-tag-text', '#fff'),
        monoFont: readCssValue('--font-mono', 'Tahoma, Segoe UI, Consolas, monospace'),
      };

      const fontSize = isCompactViewport ? 10 : 11;
      const badgeFontSize = isCompactViewport ? 9.5 : 10.5;
      const fontFamily = isLightSkin
        ? '"Segoe UI", -apple-system, BlinkMacSystemFont, "Plus Jakarta Sans Variable", Arial, sans-serif'
        : palette.monoFont;
      const bodyFont = `500 ${fontSize}px ${fontFamily}`;
      const controlFont = `600 ${badgeFontSize}px ${fontFamily}`;
      ctx.font = controlFont;

      const width = cssWidth;
      const height = cssHeight;
      const left = 0;
      const samplePrice = Math.max(Math.abs(bid), Math.abs(ask), 100);
      const right = Math.max(
        isCompactViewport ? 62 : 70,
        Math.ceil(ctx.measureText(formatDialogPrice(samplePrice, digits)).width) + 18,
      );
      const tagHeight = isCompactViewport ? 16 : 18;
      const top = 22; // Clean headroom for top-left OHLC HUD matching TradingChart
      const bottom = isCompactViewport ? 22 : 24;
      const plotWidth = Math.max(120, width - left - right);
      const plotHeight = Math.max(100, height - top - bottom);
      const plotRight = left + plotWidth;
      const plotBottom = top + plotHeight;

      // Pure main-chart canvas surface
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = palette.background;
      ctx.fillRect(0, 0, width, height);

      const fullHistory = tickHistoryRef.current;
      const visibleCount = Math.max(14, Math.round(120 / Math.max(0.5, zoomLevel)));
      const history = fullHistory.slice(-visibleCount);

      // Compute dynamic visible candle count to match TradingChart proportions (~8.5px/bar at 1x zoom)
      const rightShiftPx = chartShift ? Math.min(54, Math.max(24, Math.round(plotWidth * 0.09))) : 6;
      const usablePlotWidth = Math.max(60, plotWidth - rightShiftPx);
      const targetBarPitch = Math.max(4.5, Math.min(20, 8.5 * Math.max(0.5, zoomLevel)));
      const maxCandleBars = Math.max(16, Math.min(110, Math.floor(usablePlotWidth / targetBarPitch)));

      // Read live candles from candleAggregationService merged with candleCache / fetched history
      let aggCandles = candleAggregationService.getCandles(symbol, activeTimeframe, true, false);
      if (aggCandles.length < 2 && activeTimeframe !== 'M1') {
        const m1Source = candleAggregationService.getCandles(symbol, 'M1', true, false);
        if (m1Source.length >= 2) {
          aggCandles = aggregateM1CandlesToTimeframe(m1Source, activeTimeframe);
        }
      }
      const cacheScope = resolveMiniChartCandleCacheScope();
      const historyKey = `${cacheScope}\u001f${symbol.trim().toUpperCase()}\u001f${activeTimeframe}`;
      const cachedEntry = candleCache.getLatestForSymbolTimeframe(cacheScope, symbol, activeTimeframe);
      const cachedCandles: OHLCV[] = cachedEntry
        ? cachedEntry.candles.map((c) => ({
            time: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume ?? 0,
            isComplete: c.closed,
          }))
        : [];
      const fetchedCandles = fetchedCandlesByKeyRef.current.get(historyKey) ?? [];
      const historicalBaseline = cachedCandles.length >= fetchedCandles.length
        ? cachedCandles
        : fetchedCandles;
      const aggregatedCandles = mergeMiniChartCandles(historicalBaseline, aggCandles);
      const liveCandles: OHLCV[] = aggregatedCandles.slice(-maxCandleBars).map((c) => ({ ...c }));
      if (liveCandles.length > 0 && bid > 0) {
        const lastBar = liveCandles[liveCandles.length - 1];
        lastBar.close = bid;
        lastBar.high = Math.max(lastBar.high, bid);
        lastBar.low = Math.min(lastBar.low, bid);
      }

      if (history.length === 0 && liveCandles.length === 0 && (bid <= 0 || ask <= 0)) {
        updateOhlcHud(null);
        ctx.fillStyle = palette.axis;
        ctx.font = bodyFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tr('Waiting for the first live quote from the broker.'), left + plotWidth / 2, top + plotHeight / 2, plotWidth - 20);
        return;
      }

      const seedHistory = history.length > 0
        ? history
        : [{ time: Date.now(), bid, ask }];
      const plotHistory = seedHistory.length === 1
        ? [{ ...seedHistory[0], time: seedHistory[0].time - 1_000 }, seedHistory[0]]
        : seedHistory;

      // Build fallback tick candles when historical candles are not yet in candleAggregationService
      const candlesToDraw: OHLCV[] = liveCandles.length >= 2
        ? liveCandles
        : (() => {
            const bucketCount = Math.min(24, Math.max(1, plotHistory.length));
            const chunkSize = Math.max(1, Math.ceil(plotHistory.length / bucketCount));
            const bars: OHLCV[] = [];
            for (let i = 0; i < plotHistory.length; i += chunkSize) {
              const slice = plotHistory.slice(i, i + chunkSize);
              if (slice.length === 0) continue;
              const open = slice[0].bid > 0 ? slice[0].bid : slice[0].ask;
              const close = slice[slice.length - 1].bid > 0 ? slice[slice.length - 1].bid : slice[slice.length - 1].ask;
              let high = Math.max(open, close);
              let low = Math.min(open, close);
              for (const pt of slice) {
                const ptPrice = pt.bid > 0 ? pt.bid : pt.ask;
                if (ptPrice > 0) {
                  high = Math.max(high, ptPrice);
                  low = Math.min(low, ptPrice);
                }
              }
              bars.push({
                time: Math.floor(slice[0].time / 1000),
                open,
                high,
                low,
                close,
                volume: 0,
              });
            }
            return bars;
          })();

      // Detect whether volume histogram should be displayed (matching main TradingChart bottom volume band)
      const showVolumeOverlay = chartSettings.showTickVolumes !== false || chartSettings.showRealVolumes;
      let maxVolume = 0;
      if (showVolumeOverlay && liveCandles.length >= 2) {
        for (const bar of candlesToDraw) {
          if (Number.isFinite(bar.volume) && bar.volume > maxVolume) {
            maxVolume = bar.volume;
          }
        }
      }
      const hasVolumeBars = maxVolume > 0;
      const volumeBandHeight = hasVolumeBars ? Math.min(54, Math.max(28, Math.round(plotHeight * 0.17))) : 0;
      const pricePlotTop = top + 6;
      const pricePlotBottom = plotBottom - volumeBandHeight - (hasVolumeBars ? 8 : 6);
      const pricePlotHeight = Math.max(60, pricePlotBottom - pricePlotTop);

      // Compute price scale bounds across visible candles + active trades/orders/draft levels
      let minPrice = Number.POSITIVE_INFINITY;
      let maxPrice = Number.NEGATIVE_INFINITY;
      for (const bar of candlesToDraw) {
        if (Number.isFinite(bar.low) && bar.low > 0) minPrice = Math.min(minPrice, bar.low);
        if (Number.isFinite(bar.high) && bar.high > 0) maxPrice = Math.max(maxPrice, bar.high);
      }
      for (const tick of plotHistory) {
        const tickPrice = tick.bid > 0 ? tick.bid : tick.ask;
        if (tickPrice > 0) {
          minPrice = Math.min(minPrice, tickPrice);
          maxPrice = Math.max(maxPrice, tickPrice);
        }
      }
      for (const extraPrice of [orderPrice, stopLossPrice, takeProfitPrice]) {
        if (typeof extraPrice === 'number' && Number.isFinite(extraPrice) && extraPrice > 0) {
          minPrice = Math.min(minPrice, extraPrice);
          maxPrice = Math.max(maxPrice, extraPrice);
        }
      }
      for (const pos of symbolPositions) {
        const entry = Number(pos.openPrice ?? pos.open_price ?? pos.price_open ?? 0);
        if (Number.isFinite(entry) && entry > 0) {
          minPrice = Math.min(minPrice, entry);
          maxPrice = Math.max(maxPrice, entry);
        }
        if (Number.isFinite(pos.sl) && pos.sl > 0) {
          minPrice = Math.min(minPrice, pos.sl);
          maxPrice = Math.max(maxPrice, pos.sl);
        }
        if (Number.isFinite(pos.tp) && pos.tp > 0) {
          minPrice = Math.min(minPrice, pos.tp);
          maxPrice = Math.max(maxPrice, pos.tp);
        }
      }
      for (const ord of symbolPendingOrders) {
        if (Number.isFinite(ord.price) && ord.price > 0) {
          minPrice = Math.min(minPrice, ord.price);
          maxPrice = Math.max(maxPrice, ord.price);
        }
      }

      const brokerStep = priceStep !== null && Number.isFinite(priceStep) && priceStep > 0 ? priceStep : null;
      const observedRange = maxPrice - minPrice;
      const minimumRange = Math.max((brokerStep ?? 0) * 16, Math.abs(ask - bid) * 4);
      if (observedRange < minimumRange) {
        const midpoint = (maxPrice + minPrice) / 2;
        minPrice = midpoint - minimumRange / 2;
        maxPrice = midpoint + minimumRange / 2;
      }
      const padding = Math.max((maxPrice - minPrice) * 0.1, (brokerStep ?? 0) * 2);
      minPrice -= padding;
      maxPrice += padding;
      if (!(maxPrice - minPrice > 0)) {
        const visualSpan = Math.abs((maxPrice + minPrice) / 2) * 1e-6 || 1;
        minPrice -= visualSpan;
        maxPrice += visualSpan;
      }
      const totalRange = maxPrice - minPrice;

      const barCount = Math.max(1, candlesToDraw.length);
      const slotPitch = usablePlotWidth / Math.max(barCount, 12);
      const barStartX = left + Math.max(4, usablePlotWidth - barCount * slotPitch);
      const candleCenterX = (index: number) =>
        barCount === 1
          ? left + usablePlotWidth * 0.5
          : barStartX + (index + 0.5) * slotPitch;

      const timeStart = liveCandles.length >= 2
        ? liveCandles[0].time * 1000
        : plotHistory[0].time;
      const timeEnd = liveCandles.length >= 2
        ? liveCandles[liveCandles.length - 1].time * 1000
        : plotHistory[plotHistory.length - 1].time;
      const timeRange = Math.max(timeEnd - timeStart, 1_000);
      const xOf = (time: number) => left + ((time - timeStart) / timeRange) * usablePlotWidth;
      const yOf = (price: number) => pricePlotTop + pricePlotHeight - ((price - minPrice) / totalRange) * pricePlotHeight;
      const priceOfY = (y: number) => maxPrice - ((y - pricePlotTop) / pricePlotHeight) * totalRange;

      // Compute clean main-chart nice price ticks & time ticks
      const targetPriceTickCount = Math.max(4, Math.min(8, Math.floor(pricePlotHeight / 42)));
      const priceTicks = computeNicePriceTicks(minPrice, maxPrice, targetPriceTickCount, brokerStep);

      const minTimeTickSpacing = isCompactViewport ? 72 : 84;
      const timeTicks: Array<{ x: number; timeMs: number; isFirst?: boolean }> = [];
      if (liveCandles.length >= 2) {
        const maxTimeTicks = Math.max(2, Math.floor(plotWidth / minTimeTickSpacing));
        const stepIdx = Math.max(1, Math.ceil(barCount / maxTimeTicks));
        for (let idx = 0; idx < barCount; idx += stepIdx) {
          const x = candleCenterX(idx);
          if (x < left + 26 || x > plotRight - 26) continue;
          if (timeTicks.length > 0 && x - timeTicks[timeTicks.length - 1].x < minTimeTickSpacing * 0.85) continue;
          timeTicks.push({ x, timeMs: candlesToDraw[idx].time * 1000, isFirst: timeTicks.length === 0 });
        }
      } else {
        const cols = Math.max(3, Math.min(6, Math.floor(plotWidth / minTimeTickSpacing)));
        for (let c = 1; c < cols; c += 1) {
          const x = left + (c / cols) * plotWidth;
          const t = timeStart + (c / cols) * timeRange;
          timeTicks.push({ x, timeMs: t, isFirst: c === 1 });
        }
      }

      // Draw crisp main-chart dotted square/scale grid
      if (chartSettings.showGrid !== false) {
        const gridStroke = isLightSkin
          ? 'rgba(100, 116, 139, 0.24)'
          : (chartTheme.gridHorizontal || 'rgba(148, 163, 184, 0.16)');
        const isSolidGrid = chartSettings.gridLineStyle === 'solid';
        ctx.save();
        ctx.strokeStyle = gridStroke;
        ctx.lineWidth = 1;
        ctx.globalAlpha = isLightSkin ? (isSolidGrid ? 0.9 : 0.82) : (isSolidGrid ? 0.9 : 0.7);
        if (!isSolidGrid && typeof ctx.setLineDash === 'function') {
          ctx.setLineDash([1, 2]);
        }

        // Horizontal gridlines aligned to nice price ticks
        const hYs = priceTicks.length >= 2
          ? priceTicks.map((p) => Math.round(yOf(p)) + 0.5)
          : Array.from({ length: 6 }, (_, i) => Math.round(top + ((i + 1) / 7) * plotHeight) + 0.5);
        for (const y of hYs) {
          if (y <= top || y >= plotBottom) continue;
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(plotRight, y);
          ctx.stroke();
        }

        // Vertical gridlines aligned to time ticks (plus crisp square sub-lines)
        const vXs = timeTicks.length >= 2
          ? timeTicks.map((tk) => Math.round(tk.x) + 0.5)
          : Array.from({ length: 6 }, (_, i) => Math.round(left + ((i + 1) / 7) * plotWidth) + 0.5);
        for (const x of vXs) {
          if (x <= left || x >= plotRight) continue;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, plotBottom);
          ctx.stroke();
        }
        ctx.restore();
      }

      const candleWidth = Math.max(3, Math.min(11, Math.floor(slotPitch * 0.66)));
      const halfTickArm = Math.max(2, Math.floor(candleWidth / 2));

      // Draw subtle bottom volume histogram matching main TradingChart (50% opacity directional bars)
      if (hasVolumeBars && volumeBandHeight > 4) {
        const volWidth = Math.max(2, Math.min(candleWidth + 1, Math.floor(slotPitch * 0.72)));
        for (let index = 0; index < candlesToDraw.length; index += 1) {
          const bar = candlesToDraw[index];
          if (!(bar.volume > 0)) continue;
          const cx = Math.round(candleCenterX(index)) + 0.5;
          const isBull = bar.close >= bar.open;
          const barH = Math.max(2, Math.round((bar.volume / maxVolume) * (volumeBandHeight - 2)));
          const barLeft = Math.round(cx - volWidth / 2);
          const barTop = plotBottom - barH;
          ctx.fillStyle = isBull
            ? (chartTheme.volumeUp || 'rgba(37, 99, 235, 0.45)')
            : (chartTheme.volumeDown || 'rgba(220, 38, 38, 0.45)');
          ctx.fillRect(barLeft, barTop, volWidth, barH);
        }
      }

      // Draw primary price series (Candlestick, Bar, HLC, Line, Area, Dot)
      if (miniChartType === 'candlestick') {
        candlesToDraw.forEach((bar, index) => {
          const cx = Math.round(candleCenterX(index)) + 0.5;
          const isBull = bar.close >= bar.open;
          const bodyColor = isBull ? candleUpBody : candleDownBody;
          const borderColor = isBull ? candleUpBorder : candleDownBorder;

          const yHigh = Math.max(top + 2, Math.min(pricePlotBottom + 2, yOf(bar.high)));
          const yLow = Math.max(top + 2, Math.min(pricePlotBottom + 2, yOf(bar.low)));
          const yOpen = Math.max(top + 2, Math.min(pricePlotBottom + 2, yOf(bar.open)));
          const yClose = Math.max(top + 2, Math.min(pricePlotBottom + 2, yOf(bar.close)));

          ctx.beginPath();
          ctx.moveTo(cx, yHigh);
          ctx.lineTo(cx, yLow);
          ctx.strokeStyle = borderColor;
          ctx.lineWidth = 1;
          ctx.stroke();

          const bodyTop = Math.round(Math.min(yOpen, yClose));
          const bodyHeight = Math.max(1.5, Math.round(Math.abs(yClose - yOpen)));
          const bodyLeft = Math.round(cx - candleWidth / 2);
          ctx.fillStyle = bodyColor;
          ctx.fillRect(bodyLeft, bodyTop, candleWidth, bodyHeight);
          if (candleWidth >= 4 && bodyHeight >= 2) {
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = 1;
            ctx.strokeRect(bodyLeft + 0.5, bodyTop + 0.5, candleWidth - 1, Math.max(1, bodyHeight - 1));
          }
        });
      } else if (miniChartType === 'bar' || miniChartType === 'hlc') {
        candlesToDraw.forEach((bar, index) => {
          const cx = Math.round(candleCenterX(index)) + 0.5;
          const isBull = bar.close >= bar.open;
          const strokeColor = isBull ? candleUpBorder : candleDownBorder;

          const yHigh = Math.round(Math.max(top + 2, Math.min(pricePlotBottom + 2, yOf(bar.high)))) + 0.5;
          const yLow = Math.round(Math.max(top + 2, Math.min(pricePlotBottom + 2, yOf(bar.low)))) + 0.5;
          const yOpen = Math.round(Math.max(top + 2, Math.min(pricePlotBottom + 2, yOf(bar.open)))) + 0.5;
          const yClose = Math.round(Math.max(top + 2, Math.min(pricePlotBottom + 2, yOf(bar.close)))) + 0.5;

          ctx.beginPath();
          ctx.moveTo(cx, yHigh);
          ctx.lineTo(cx, yLow);
          if (miniChartType === 'bar') {
            ctx.moveTo(cx - halfTickArm, yOpen);
            ctx.lineTo(cx, yOpen);
          }
          ctx.moveTo(cx, yClose);
          ctx.lineTo(cx + halfTickArm, yClose);
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = 1.25;
          ctx.stroke();
        });
      } else if (miniChartType === 'line' || miniChartType === 'area' || miniChartType === 'dot') {
        const points = candlesToDraw.length >= 2
          ? candlesToDraw.map((bar, index) => ({
              x: candleCenterX(index),
              y: Math.max(top + 2, Math.min(pricePlotBottom + 2, yOf(bar.close))),
            }))
          : plotHistory.map((tick) => ({
              x: xOf(tick.time),
              y: Math.max(top + 2, Math.min(pricePlotBottom + 2, yOf(tick.bid > 0 ? tick.bid : tick.ask))),
            }));

        const lineStroke = chartTheme.line || chartColors.lineChart || '#2563eb';
        if (points.length > 0) {
          if (miniChartType === 'area' && points.length >= 2) {
            ctx.save();
            ctx.beginPath();
            points.forEach((pt, idx) => {
              if (idx === 0) ctx.moveTo(pt.x, pt.y);
              else ctx.lineTo(pt.x, pt.y);
            });
            ctx.lineTo(points[points.length - 1].x, plotBottom);
            ctx.lineTo(points[0].x, plotBottom);
            ctx.closePath();
            ctx.fillStyle = lineStroke;
            ctx.globalAlpha = isLightSkin ? 0.14 : 0.24;
            ctx.fill();
            ctx.restore();
          }

          if (miniChartType === 'line' || miniChartType === 'area') {
            ctx.beginPath();
            points.forEach((pt, idx) => {
              if (idx === 0) ctx.moveTo(pt.x, pt.y);
              else ctx.lineTo(pt.x, pt.y);
            });
            ctx.strokeStyle = lineStroke;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.lineWidth = 1.6;
            ctx.stroke();
          }

          if (miniChartType === 'dot') {
            ctx.fillStyle = lineStroke;
            points.forEach((pt) => {
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, 2.2, 0, Math.PI * 2);
              ctx.fill();
            });
          }
        }
      }

      // Tick-only fallback trace when no historical candles exist yet
      if (liveCandles.length < 2 && (miniChartType === 'candlestick' || miniChartType === 'bar' || miniChartType === 'hlc')) {
        const bgNormForTrace = palette.background.trim().toLowerCase();
        const isInvisibleForTrace = (c: string) => {
          const n = c.trim().toLowerCase();
          if (isLightSkin) {
            return n === '#ffffff' || n === '#fff' || n === '#f8fafc' || n === '#fafbfc' || n === bgNormForTrace;
          }
          return n === '#000000' || n === '#000' || n === bgNormForTrace;
        };
        const traceUpColor = !isInvisibleForTrace(candleUpBody) ? candleUpBody : candleUpBorder;
        ctx.beginPath();
        let hasTracePoint = false;
        plotHistory.forEach((tick) => {
          const tickPrice = tick.bid > 0 ? tick.bid : tick.ask;
          if (!(tickPrice > 0)) return;
          const x = xOf(tick.time);
          const y = yOf(tickPrice);
          if (!hasTracePoint) {
            ctx.moveTo(x, y);
            hasTracePoint = true;
          } else {
            ctx.lineTo(x, y);
          }
        });
        if (hasTracePoint) {
          ctx.strokeStyle = traceUpColor;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.lineWidth = 1.15;
          ctx.stroke();
        }
      }

      // Collect all trade/order/draft levels + live price for guaranteed zero-overlap layout
      interface LevelOverlaySpec {
        id: string;
        price: number;
        rawY: number;
        badgeLabel: string;
        accentColor: string;
        textColorLight: string;
        textColorDark: string;
        dashed: boolean;
        priority: number;
        isLive?: boolean;
        solidBg?: string;
        solidText?: string;
      }

      const levelSpecs: LevelOverlaySpec[] = [];

      const pushLevel = (
        id: string,
        priceVal: number | undefined,
        badgeLabel: string,
        accentColor: string,
        textColorLight: string,
        textColorDark: string,
        priority: number,
        dashed = true,
      ) => {
        if (typeof priceVal !== 'number' || !Number.isFinite(priceVal) || priceVal <= 0) return;
        const rawY = yOf(priceVal);
        if (rawY < top - 4 || rawY > plotBottom + 4) return;
        levelSpecs.push({
          id,
          price: priceVal,
          rawY,
          badgeLabel,
          accentColor,
          textColorLight,
          textColorDark,
          dashed,
          priority,
        });
      };

      for (const item of tradeBarItems) {
        const lineAccent = isLightSkin ? item.accentColorLight : item.accentColorDark;
        const lineColor = item.kind === 'sl'
          ? (isLightSkin ? '#d97706' : '#fbbf24')
          : item.kind === 'tp'
            ? (isLightSkin ? '#059669' : '#4ade80')
            : item.side === 'BUY'
              ? '#2563eb'
              : '#dc2626';
        pushLevel(
          item.id,
          item.price,
          item.typeLabel,
          lineColor,
          lineAccent,
          item.accentColorDark,
          item.priority,
        );
      }

      // Single live price line (Bid, falling back to Ask) — matches TradingChart & contract test
      const lastTick = plotHistory[plotHistory.length - 1];
      const livePrice = lastTick
        ? (lastTick.bid > 0 ? lastTick.bid : (lastTick.ask > 0 ? lastTick.ask : 0))
        : 0;

      let liveLevelSpec: LevelOverlaySpec | null = null;
      if (showPriceLines && livePrice > 0) {
        const bgNorm = palette.background.trim().toLowerCase();
        const isInvisibleOnPlot = (c: string) => {
          const n = c.trim().toLowerCase();
          if (isLightSkin) {
            return n === '#ffffff' || n === '#fff' || n === '#f8fafc' || n === '#fafbfc' || n === bgNorm;
          }
          return n === '#000000' || n === '#000' || n === bgNorm;
        };
        const visibleUpColor = !isInvisibleOnPlot(candleUpBody) ? candleUpBody : candleUpBorder;
        const visibleDownColor = !isInvisibleOnPlot(candleDownBody) ? candleDownBody : candleDownBorder;
        const visibleLineColor = chartColors.lineChart && !isInvisibleOnPlot(chartColors.lineChart)
          ? chartColors.lineChart
          : visibleUpColor;
        const getReadableTagText = (bgHex: string): string => {
          const trimmed = bgHex.trim();
          const shortMatch = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(trimmed);
          const hex = shortMatch
            ? `${shortMatch[1]}${shortMatch[1]}${shortMatch[2]}${shortMatch[2]}${shortMatch[3]}${shortMatch[3]}`
            : trimmed.replace(/^#/, '');
          const m = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
          if (!m) return '#ffffff';
          const lum = (0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)) / 255;
          return lum > 0.6 ? '#000000' : '#ffffff';
        };
        const lastBar = candlesToDraw[candlesToDraw.length - 1];
        const isLiveUp = !lastBar || lastBar.close >= lastBar.open;
        const liveLineColor = miniChartType === 'line' || miniChartType === 'area' || miniChartType === 'dot'
          ? visibleLineColor
          : (isLiveUp ? visibleUpColor : visibleDownColor);
        const liveTagText = getReadableTagText(liveLineColor);

        liveLevelSpec = {
          id: 'live-bid',
          price: livePrice,
          rawY: Math.max(top, Math.min(plotBottom, yOf(livePrice))),
          badgeLabel: '',
          accentColor: liveLineColor,
          textColorLight: liveTagText,
          textColorDark: liveTagText,
          dashed: false,
          priority: 100,
          isLive: true,
          solidBg: liveLineColor,
          solidText: liveTagText,
        };
      }

      // Resolve non-overlapping vertical slots independently for left floating trade strips and right axis pills
      const tagMinY = top + tagHeight / 2 + 2;
      const tagMaxY = plotBottom - tagHeight / 2 - 2;
      const leftBarMinGap = isCompactViewport ? 21 : 22;
      const resolvedLeftBadges = resolveVerticalTagSlots(
        levelSpecs.filter((item) => Boolean(item.badgeLabel)),
        tagMinY,
        tagMaxY,
        leftBarMinGap,
      );
      const rightTagCandidates = liveLevelSpec ? [...levelSpecs, liveLevelSpec] : [...levelSpecs];
      const resolvedRightTags = resolveVerticalTagSlots(
        rightTagCandidates,
        tagMinY,
        tagMaxY,
        tagHeight + 2,
      );

      // Check hover crosshair position
      const hover = hoverPosRef.current;
      const isHoveringPlot =
        hover !== null
        && hover.x >= left
        && hover.x <= plotRight
        && hover.y >= top
        && hover.y <= plotBottom;

      let hoveredCandleIndex: number | null = null;
      let hoveredPrice: number | null = null;
      if (isHoveringPlot && hover) {
        hoveredPrice = priceOfY(hover.y);
        if (candlesToDraw.length > 0) {
          let bestIdx = 0;
          let bestDist = Infinity;
          for (let i = 0; i < candlesToDraw.length; i += 1) {
            const dist = Math.abs(candleCenterX(i) - hover.x);
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = i;
            }
          }
          hoveredCandleIndex = bestIdx;
        }
      }

      // Sync top-left OHLC HUD to hovered candle (or live latest candle when not hovering)
      const activeHudCandle =
        hoveredCandleIndex !== null
          ? candlesToDraw[hoveredCandleIndex]
          : candlesToDraw[candlesToDraw.length - 1] ?? null;
      updateOhlcHud(activeHudCandle);

      // Draw trade/order dashed horizontal lines across plot
      for (const spec of levelSpecs) {
        const lineY = Math.round(Math.max(top, Math.min(plotBottom, spec.rawY))) + 0.5;
        ctx.save();
        if (spec.dashed && typeof ctx.setLineDash === 'function') {
          ctx.setLineDash([4, 3]);
        }
        ctx.beginPath();
        ctx.moveTo(left, lineY);
        ctx.lineTo(plotRight, lineY);
        ctx.strokeStyle = spec.accentColor;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }

      // Draw live Bid horizontal price line across plot
      if (liveLevelSpec) {
        const liveLineY = Math.round(liveLevelSpec.rawY) + 0.5;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(left, liveLineY);
        ctx.lineTo(plotRight, liveLineY);
        ctx.strokeStyle = liveLevelSpec.accentColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }

      // Position interactive main-chart-style DOM floating strips with zero overlap
      // and draw subtle elbow connectors whenever a strip is shifted off its exact price line
      const overlayLayer = overlayLayerRef.current;
      if (overlayLayer) {
        const barNodes = overlayLayer.querySelectorAll<HTMLElement>('[data-order-chart-bar-id]');
        barNodes.forEach((node) => {
          node.style.display = 'none';
        });
      }
      for (const badge of resolvedLeftBadges) {
        const lineY = Math.round(Math.max(top, Math.min(plotBottom, badge.rawY))) + 0.5;
        const centerY = Math.round(badge.resolvedY);
        if (Math.abs(centerY - lineY) >= 2) {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(left + 1, lineY);
          ctx.lineTo(left + 7, centerY);
          ctx.strokeStyle = badge.accentColor;
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
        }
        if (overlayLayer) {
          const barNode = overlayLayer.querySelector<HTMLElement>(`[data-order-chart-bar-id="${badge.id}"]`);
          if (barNode) {
            barNode.style.top = `${centerY}px`;
            barNode.style.display = 'inline-flex';
          }
        }
      }

      // Draw interactive crosshair lines inside plot (before axes so axis pills sit cleanly on top)
      if (isHoveringPlot && hover) {
        const crossX = hoveredCandleIndex !== null
          ? Math.round(candleCenterX(hoveredCandleIndex)) + 0.5
          : Math.round(hover.x) + 0.5;
        const crossY = Math.round(hover.y) + 0.5;
        ctx.save();
        ctx.strokeStyle = isLightSkin ? 'rgba(71, 85, 105, 0.55)' : (chartTheme.crosshair || 'rgba(148, 163, 184, 0.55)');
        ctx.lineWidth = 1;
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(crossX, top);
        ctx.lineTo(crossX, plotBottom);
        ctx.moveTo(left, crossY);
        ctx.lineTo(plotRight, crossY);
        ctx.stroke();
        ctx.restore();
      }

      // Draw Right Price Scale & Bottom Time Axis Surfaces + Crisp Rules (matching main TradingChart)
      const axisBorderColor = isLightSkin ? '#cbd5e1' : 'rgba(148, 163, 184, 0.24)';
      const scaleLabelColor = isLightSkin ? '#334155' : '#cbd5e1';
      const scaleTickColor = isLightSkin ? '#94a3b8' : '#64748b';

      ctx.fillStyle = palette.axisSurface;
      ctx.fillRect(plotRight + 1, 0, right - 1, height);
      ctx.fillRect(0, plotBottom + 1, width, bottom - 1);

      // Vertical price-axis border & horizontal time-axis border
      ctx.strokeStyle = axisBorderColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotRight + 0.5, 0);
      ctx.lineTo(plotRight + 0.5, plotBottom + 0.5);
      ctx.moveTo(left, plotBottom + 0.5);
      ctx.lineTo(width, plotBottom + 0.5);
      ctx.stroke();

      // Track all active right-axis pill Y coordinates so static labels never collide with pills
      const occupiedRightYs = resolvedRightTags.map((t) => t.resolvedY);
      if (isHoveringPlot && hover) {
        occupiedRightYs.push(hover.y);
      }

      // Draw static right-side price scale labels & tick marks
      const scaleDigits = digits ?? inferObservedPriceDigits(null, [minPrice, maxPrice, bid, ask]);
      const tickPricesToRender = priceTicks.length >= 2
        ? priceTicks
        : Array.from({ length: 7 }, (_, r) => maxPrice - (r / 6) * totalRange);

      ctx.font = bodyFont;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (const price of tickPricesToRender) {
        const y = Math.round(yOf(price)) + 0.5;
        if (y < top + 6 || y > plotBottom - 6) continue;
        const collidesWithActiveTag = occupiedRightYs.some((tagY) => Math.abs(y - tagY) < tagHeight * 0.92);
        if (collidesWithActiveTag) continue;

        ctx.beginPath();
        ctx.moveTo(plotRight + 0.5, y);
        ctx.lineTo(plotRight + 4.5, y);
        ctx.strokeStyle = scaleTickColor;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = scaleLabelColor;
        const labelText = scaleDigits !== null
          ? price.toFixed(scaleDigits)
          : formatDialogPrice(Number(price.toPrecision(6)), digits);
        ctx.fillText(labelText, plotRight + 7, y + 0.5);
      }

      // Draw non-overlapping right-side price pills (trade/order levels first, Live Bid last on top)
      const sortedTagsForPaint = [...resolvedRightTags].sort((a, b) => (a.isLive ? 1 : 0) - (b.isLive ? 1 : 0));
      for (const tag of sortedTagsForPaint) {
        const lineY = Math.round(Math.max(top, Math.min(plotBottom, tag.rawY))) + 0.5;
        const centerY = Math.round(tag.resolvedY);
        const tagTop = Math.round(centerY - tagHeight / 2);
        const tagWidth = right - 4;
        const tagX = plotRight + 3;

        // Connector tick from exact lineY to pill center
        ctx.beginPath();
        ctx.moveTo(plotRight + 0.5, lineY);
        ctx.lineTo(tagX, centerY);
        ctx.strokeStyle = tag.accentColor;
        ctx.lineWidth = 1.25;
        ctx.stroke();

        if (tag.isLive) {
          drawCrispPillRect(ctx, tagX, tagTop, tagWidth, tagHeight, 2.5, tag.solidBg || tag.accentColor);
          ctx.fillStyle = tag.solidText || '#ffffff';
        } else {
          const pillBg = isLightSkin ? '#ffffff' : '#0f172a';
          drawCrispPillRect(ctx, tagX, tagTop, tagWidth, tagHeight, 2.5, pillBg, tag.accentColor);
          ctx.fillStyle = isLightSkin ? tag.textColorLight : tag.textColorDark;
        }

        ctx.font = controlFont;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatDialogPrice(tag.price, digits), tagX + 4, centerY + 0.5);
      }

      // Draw bottom time axis labels & crisp downward tick marks (matching TradingChart)
      ctx.font = bodyFont;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = scaleLabelColor;
      const timeLabelY = plotBottom + Math.round(bottom / 2) + 1;

      let lastTimeRightEdge = -Infinity;
      let hasDrawnFirstTimeLabel = false;
      let lastDrawnTickMs: number | null = null;
      const isMonthlyTf = activeTimeframe === 'MN';
      const isDateOnlyTf = activeTimeframe === 'D1' || activeTimeframe === 'W1';
      for (let i = 0; i < timeTicks.length; i += 1) {
        const tk = timeTicks[i];
        const tx = Math.round(tk.x) + 0.5;
        let labelMode: MiniChartAxisTimeMode;
        if (isMonthlyTf) {
          labelMode = 'month-year-utc';
        } else if (isDateOnlyTf) {
          const prevYear = lastDrawnTickMs !== null ? new Date(lastDrawnTickMs).getUTCFullYear() : null;
          const currYear = new Date(tk.timeMs).getUTCFullYear();
          labelMode = !hasDrawnFirstTimeLabel || prevYear !== currYear ? 'date-year-utc' : 'date-utc';
        } else {
          const prevDate = lastDrawnTickMs !== null ? new Date(lastDrawnTickMs) : null;
          const currDate = new Date(tk.timeMs);
          const dayChanged = !prevDate
            || prevDate.getFullYear() !== currDate.getFullYear()
            || prevDate.getMonth() !== currDate.getMonth()
            || prevDate.getDate() !== currDate.getDate();
          labelMode = !hasDrawnFirstTimeLabel || dayChanged ? 'date-time' : 'time';
        }
        const labelText = formatMiniChartAxisTime(tk.timeMs, labelMode);
        const labelW = Math.ceil(ctx.measureText(labelText).width);
        const leftEdge = tx - labelW / 2;
        const rightEdge = tx + labelW / 2;
        if (leftEdge < left + 4 || rightEdge > plotRight - 4 || leftEdge < lastTimeRightEdge + 12) continue;

        ctx.beginPath();
        ctx.moveTo(tx, plotBottom + 0.5);
        ctx.lineTo(tx, plotBottom + 4.5);
        ctx.strokeStyle = scaleTickColor;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.fillText(labelText, tx, timeLabelY);
        lastTimeRightEdge = rightEdge;
        lastDrawnTickMs = tk.timeMs;
        hasDrawnFirstTimeLabel = true;
      }

      // Draw interactive crosshair price & time readout badges on the axes
      if (isHoveringPlot && hover && hoveredPrice !== null && Number.isFinite(hoveredPrice) && hoveredPrice > 0) {
        const crossBg = isLightSkin ? '#334155' : '#475569';
        const crossCenterY = Math.round(Math.max(tagMinY, Math.min(tagMaxY, hover.y)));
        const crossTagTop = Math.round(crossCenterY - tagHeight / 2);
        const crossTagW = right - 4;
        drawCrispPillRect(ctx, plotRight + 3, crossTagTop, crossTagW, tagHeight, 2.5, crossBg);
        ctx.fillStyle = '#ffffff';
        ctx.font = controlFont;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const hoveredPriceText = scaleDigits !== null
          ? hoveredPrice.toFixed(scaleDigits)
          : formatDialogPrice(hoveredPrice, digits);
        ctx.fillText(hoveredPriceText, plotRight + 7, crossCenterY + 0.5);

        if (hoveredCandleIndex !== null && candlesToDraw[hoveredCandleIndex]) {
          const crossTimeMs = candlesToDraw[hoveredCandleIndex].time * 1000;
          const crossTimeMode: MiniChartAxisTimeMode = isMonthlyTf
            ? 'month-year-utc'
            : isDateOnlyTf
              ? 'date-year-utc'
              : 'date-time';
          const crossTimeText = formatMiniChartAxisTime(crossTimeMs, crossTimeMode);
          const crossTimeW = Math.ceil(ctx.measureText(crossTimeText).width) + 12;
          const rawCrossX = candleCenterX(hoveredCandleIndex);
          const pillX = Math.max(left + 2, Math.min(plotRight - crossTimeW - 2, Math.round(rawCrossX - crossTimeW / 2)));
          const pillH = Math.max(15, bottom - 4);
          const pillY = plotBottom + 2;
          drawCrispPillRect(ctx, pillX, pillY, crossTimeW, pillH, 2.5, crossBg);
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(crossTimeText, pillX + crossTimeW / 2, pillY + pillH / 2 + 0.5);
        }
      }
    };

    const scheduleDraw = () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        draw();
      });
    };
    scheduleDrawRef.current = scheduleDraw;

    scheduleDraw();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleDraw);
    resizeObserver?.observe(canvas);

    const themeObserver = new MutationObserver(scheduleDraw);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    if (document.body) {
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    }

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      resizeObserver?.disconnect();
      themeObserver.disconnect();
    };
  }, [
    activeTimeframe,
    ask,
    bid,
    chartColors,
    chartSettings.gridLineStyle,
    chartSettings.showGrid,
    chartSettings.showRealVolumes,
    chartSettings.showTickVolumes,
    chartShift,
    chartTheme,
    digits,
    historyRevision,
    isAdvancedUntitledLight,
    miniChartType,
    orderPrice,
    priceStep,
    showPriceLines,
    stopLossPrice,
    symbol,
    symbolPendingOrders,
    symbolPositions,
    takeProfitPrice,
    tr,
    tradeBarItems,
    zoomLevel,
  ]);

  const activeChartTypeOption = MINI_CHART_TYPE_OPTIONS.find((opt) => opt.id === miniChartType) ?? MINI_CHART_TYPE_OPTIONS[1];

  const handleCanvasMouseMove = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    hoverPosRef.current = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    scheduleDrawRef.current();
  }, []);

  const handleCanvasMouseLeave = useCallback(() => {
    if (hoverPosRef.current !== null) {
      hoverPosRef.current = null;
      scheduleDrawRef.current();
    }
  }, []);

  const handleCanvasWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    if (Math.abs(event.deltaY) < 2) return;
    const step = event.deltaY < 0 ? 0.25 : -0.25;
    setZoomLevel((z) => Math.max(0.5, Math.min(4, Number((z + step).toFixed(2)))));
  }, []);

  return (
    <div className="rtx-order-dialog__chart-shell">
      <div className="rtx-order-dialog__chart-toolbar" role="toolbar" aria-label={tr("Tick chart toolbar")}>
        <div className="rtx-order-dialog__chart-type-wrap" ref={chartTypeMenuRef}>
          <button
            type="button"
            className={`rtx-order-dialog__chart-type-btn ${isChartTypeMenuOpen ? 'rtx-order-dialog__chart-type-btn--open' : ''}`}
            title={tr(activeChartTypeOption.label)}
            aria-label={tr("Chart type")}
            aria-haspopup="menu"
            aria-expanded={isChartTypeMenuOpen}
            data-testid="order-mini-chart-type-trigger"
            onClick={() => setIsChartTypeMenuOpen((prev) => !prev)}
          >
            <MiniChartTypeIcon type={miniChartType} />
            <svg
              className="rtx-order-dialog__chart-type-caret"
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="none"
              aria-hidden="true"
            >
              <path d="M1.5 2.75L4 5.25L6.5 2.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {isChartTypeMenuOpen && (
            <div
              className="rtx-order-dialog__chart-type-menu"
              role="menu"
              aria-label={tr("Chart type")}
              data-testid="order-mini-chart-type-menu"
            >
              {MINI_CHART_TYPE_OPTIONS.map((opt) => {
                const isSelected = opt.id === miniChartType;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    className={`rtx-order-dialog__chart-type-item ${isSelected ? 'rtx-order-dialog__chart-type-item--active' : ''}`}
                    onClick={() => {
                      setMiniChartType(opt.id);
                      setIsChartTypeMenuOpen(false);
                    }}
                  >
                    <span className="rtx-order-dialog__chart-type-item-icon" aria-hidden="true">
                      <MiniChartTypeIcon type={opt.id} />
                    </span>
                    <span className="rtx-order-dialog__chart-type-item-label">{tr(opt.label)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <span className="rtx-order-dialog__toolbar-sep" aria-hidden="true" />

        <div className="rtx-order-dialog__tf-group" role="group" aria-label={tr("Timeframe")}>
          {MINI_CHART_TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              data-testid={`order-mini-chart-tf-${tf}`}
              aria-pressed={activeTimeframe === tf}
              className={`rtx-order-dialog__tf-btn ${activeTimeframe === tf ? 'rtx-order-dialog__tf-btn--active' : ''}`}
              onClick={() => setActiveTimeframe(tf)}
            >
              {tf}
            </button>
          ))}
        </div>

        <span className="rtx-order-dialog__toolbar-sep" aria-hidden="true" />

        <button
          type="button"
          className="rtx-order-dialog__toolbar-btn"
          title={tr("Zoom out")}
          onClick={() => setZoomLevel((z) => Math.max(0.5, Number((z - 0.5).toFixed(1))))}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.25" />
            <path d="M4.8 7H9.2M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className="rtx-order-dialog__toolbar-btn"
          title={tr("Zoom in")}
          onClick={() => setZoomLevel((z) => Math.min(4, Number((z + 0.5).toFixed(1))))}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="#2563eb" strokeWidth="1.25" />
            <path d="M7 4.8V9.2M4.8 7H9.2M10.5 10.5L14 14" stroke="#2563eb" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
        </button>

        <div className="rtx-order-dialog__chart-quotes-sr" aria-label={tr("{{value0}} live bid and ask", { value0: symbol })}>
          <span>{tr("Bid ")}<strong>{bid > 0 ? formatDialogPrice(bid, digits) : '—'}</strong></span>
          <span>{tr("Ask ")}<strong>{ask > 0 ? formatDialogPrice(ask, digits) : '—'}</strong></span>
        </div>
      </div>

      <div className="rtx-order-dialog__chart-stage" style={{ background: chartTheme.background }}>
        <div
          className="rtx-order-dialog__chart-hud"
          style={{ background: chartTheme.background }}
          aria-hidden="true"
        >
          <span className="rtx-order-dialog__chart-hud-symbol">{symbol}, {activeTimeframe}</span>
          <span className="rtx-order-dialog__chart-hud-ohlc">
            <span className="rtx-order-dialog__chart-hud-metric">
              O: <span ref={ohlcOpenRef} className="rtx-order-dialog__chart-hud-val">—</span>
            </span>
            <span className="rtx-order-dialog__chart-hud-metric">
              H: <span ref={ohlcHighRef} className="rtx-order-dialog__chart-hud-val" style={{ color: hudQuoteColors.upColor }}>—</span>
            </span>
            <span className="rtx-order-dialog__chart-hud-metric">
              L: <span ref={ohlcLowRef} className="rtx-order-dialog__chart-hud-val" style={{ color: hudQuoteColors.downColor }}>—</span>
            </span>
            <span className="rtx-order-dialog__chart-hud-metric">
              C: <span ref={ohlcCloseRef} className="rtx-order-dialog__chart-hud-val">—</span>
            </span>
          </span>
        </div>

        <canvas
          ref={canvasRef}
          width={520}
          height={371}
          className="rtx-order-dialog__chart-canvas"
          data-testid="order-mini-tick-chart"
          role="img"
          aria-label={tr("Live {{value0}} bid and ask tick chart", { value0: symbol })}
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={handleCanvasMouseLeave}
          onWheel={handleCanvasWheel}
        />

        <div
          ref={overlayLayerRef}
          className="rtx-order-dialog__chart-trade-overlay"
          data-testid="order-mini-chart-trade-overlay"
        >
          {tradeBarItems.map((item) => {
            const hasPnl = item.kind === 'position' && item.pnlValue != null && Number.isFinite(item.pnlValue);
            const pnlRounded = hasPnl ? Number(item.pnlValue!.toFixed(2)) : 0;
            const pnlText = hasPnl
              ? `${pnlRounded > 0 ? '+' : ''}${formatMoneyLabel(item.pnlValue)}`
              : null;
            const pnlToneClass = pnlRounded > 0
              ? 'rtx-order-dialog__trade-bar-pnl--profit'
              : pnlRounded < 0
                ? 'rtx-order-dialog__trade-bar-pnl--loss'
                : '';
            const sideToneClass =
              item.kind === 'tp'
                ? 'rtx-order-dialog__trade-bar-side--tp'
                : item.kind === 'sl'
                  ? 'rtx-order-dialog__trade-bar-side--sl'
                  : item.side === 'BUY'
                    ? 'rtx-order-dialog__trade-bar-side--buy'
                    : 'rtx-order-dialog__trade-bar-side--sell';

            return (
              <div
                key={item.id}
                data-order-chart-bar-id={item.id}
                data-order-chart-bar-kind={item.kind}
                className="rtx-order-dialog__trade-bar"
                style={{ display: 'none' }}
              >
                {(item.showTpChip || item.showSlChip) && (
                  <span className="rtx-order-dialog__trade-bar-brackets">
                    {item.showTpChip && (
                      <button
                        type="button"
                        className="rtx-order-dialog__trade-bar-bracket rtx-order-dialog__trade-bar-bracket--tp"
                        title={tr("Add Take Profit")}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenModifyForBar(item, 'TP');
                        }}
                      >
                        TP
                      </button>
                    )}
                    {item.showSlChip && (
                      <button
                        type="button"
                        className="rtx-order-dialog__trade-bar-bracket rtx-order-dialog__trade-bar-bracket--sl"
                        title={tr("Add Stop Loss")}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenModifyForBar(item, 'SL');
                        }}
                      >
                        SL
                      </button>
                    )}
                  </span>
                )}

                <span className="rtx-order-dialog__trade-bar-primary">
                  <span className={`rtx-order-dialog__trade-bar-side ${sideToneClass}`}>
                    {item.typeLabel}
                  </span>
                  {item.volumeLabel && (
                    <span className="rtx-order-dialog__trade-bar-vol">
                      {item.volumeLabel}
                    </span>
                  )}
                  {pnlText !== null && (
                    <span className={`rtx-order-dialog__trade-bar-pnl ${pnlToneClass}`}>
                      {pnlText}
                    </span>
                  )}
                </span>

                {item.canClose && (
                  <button
                    type="button"
                    className="rtx-order-dialog__trade-bar-close"
                    title={item.kind === 'pending' ? tr("Cancel order") : tr("Close position")}
                    aria-label={item.kind === 'pending' ? tr("Cancel order") : tr("Close position")}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCloseOrCancelBar(item);
                    }}
                  >
                    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── MT5 Depth of Market Pane ────────────────────────────────────
const DOM_LADDER_LEVELS = 6;

function OrderDialogDomPane({
  symbol,
  bid,
  ask,
  bidVolume,
  askVolume,
  digits,
  priceStep,
  onToggleTickChart,
  onSelectDomPrice,
}: {
  symbol: string;
  bid: number;
  ask: number;
  /** Top-of-book bid volume published on the live quote tick, if any. */
  bidVolume?: number;
  /** Top-of-book ask volume published on the live quote tick, if any. */
  askVolume?: number;
  /** Broker digits; null = unknown (raw prices, no rounding). */
  digits: number | null;
  /** Broker tick size or 10^-digits; null = unknown (no synthetic levels). */
  priceStep: number | null;
  onToggleTickChart: () => void;
  onSelectDomPrice: (price: number, side: 'buy' | 'sell') => void;
}) {
  const tr = useUiTranslation();
  const orderBookResult = useLiveOrderBook(symbol, DOM_LADDER_LEVELS);
  const rawOrderBook = (orderBookResult && 'orderBook' in orderBookResult ? orderBookResult.orderBook : orderBookResult) as {
    asks?: { price: number; volume: number }[];
    bids?: { price: number; volume: number }[];
  } | null;
  const reloadOrderBook = orderBookResult && 'reload' in orderBookResult && typeof orderBookResult.reload === 'function'
    ? orderBookResult.reload
    : undefined;
  const [showVolumeBars, setShowVolumeBars] = useState(true);

  // Ladder spacing comes from broker data only (tick size, else 10^-digits).
  const stepUnit = priceStep !== null && Number.isFinite(priceStep) && priceStep > 0 ? priceStep : null;

  const { asks, bids, maxVolume } = useMemo(() => {
    const liveAsks = Array.isArray(rawOrderBook?.asks) ? rawOrderBook.asks.slice(0, DOM_LADDER_LEVELS) : [];
    const liveBids = Array.isArray(rawOrderBook?.bids) ? rawOrderBook.bids.slice(0, DOM_LADDER_LEVELS) : [];
    const roundLevel = (price: number) => (digits === null ? price : Number(price.toFixed(digits)));
    const canSynthesize = stepUnit !== null && (ask > 0 || bid > 0);
    const step = stepUnit ?? 0;
    const safeAsk = ask > 0 ? ask : bid + step * 2;
    const safeBid = bid > 0 ? bid : Math.max(step, safeAsk - step * 2);
    const bestAskTickVolume = typeof askVolume === 'number' && Number.isFinite(askVolume) && askVolume > 0
      ? askVolume
      : 0;
    const bestBidTickVolume = typeof bidVolume === 'number' && Number.isFinite(bidVolume) && bidVolume > 0
      ? bidVolume
      : 0;

    // Use live order-book levels when published by the broker; if fewer than 6
    // levels or no depth feed is published by the backend, synthesize remaining
    // price ladder steps from live bid/ask + broker tick step with volume = 0
    // (never invent volume numbers; only real feed volumes are displayed).
    const sortedLiveAsksAsc = [...liveAsks].sort((a, b) => a.price - b.price);
    const sortedLiveBidsDesc = [...liveBids].sort((a, b) => b.price - a.price);

    const resolvedAsks = sortedLiveAsksAsc.length > 0
      ? (() => {
          const bestBookAsk = sortedLiveAsksAsc[0].price;
          const canShiftAsk = digits !== null && step > 0 && safeAsk > 0
            && Math.abs(safeAsk - bestBookAsk) > 0
            && Math.abs(safeAsk - bestBookAsk) < step * 250;
          const askShiftDelta = canShiftAsk ? (safeAsk - bestBookAsk) : 0;
          const shiftedAsksAsc = sortedLiveAsksAsc
            .map((lvl, idx) => {
              const lvlVol = Number(lvl.volume) > 0 ? Number(lvl.volume) : 0;
              return {
                price: askShiftDelta !== 0 ? roundLevel(lvl.price + askShiftDelta) : lvl.price,
                volume: lvlVol > 0 ? lvlVol : (idx === 0 ? bestAskTickVolume : 0),
              };
            })
            .sort((a, b) => a.price - b.price);
          if (shiftedAsksAsc.length < DOM_LADDER_LEVELS && canSynthesize && step > 0) {
            const outerBookAsk = shiftedAsksAsc[shiftedAsksAsc.length - 1].price;
            const missingCount = DOM_LADDER_LEVELS - shiftedAsksAsc.length;
            for (let i = 1; i <= missingCount; i += 1) {
              shiftedAsksAsc.push({
                price: roundLevel(outerBookAsk + i * step),
                volume: 0,
              });
            }
          }
          return shiftedAsksAsc.sort((a, b) => b.price - a.price);
        })()
      : !canSynthesize
        ? []
        : Array.from({ length: DOM_LADDER_LEVELS }, (_, idx) => {
            const offsetFromBest = DOM_LADDER_LEVELS - 1 - idx;
            return {
              price: roundLevel(safeAsk + offsetFromBest * step),
              volume: offsetFromBest === 0 ? bestAskTickVolume : 0,
            };
          });

    const resolvedBids = sortedLiveBidsDesc.length > 0
      ? (() => {
          const bestBookBid = sortedLiveBidsDesc[0].price;
          const canShiftBid = digits !== null && step > 0 && safeBid > 0
            && Math.abs(safeBid - bestBookBid) > 0
            && Math.abs(safeBid - bestBookBid) < step * 250;
          const bidShiftDelta = canShiftBid ? (safeBid - bestBookBid) : 0;
          const shiftedBidsDesc = sortedLiveBidsDesc
            .map((lvl, idx) => {
              const lvlVol = Number(lvl.volume) > 0 ? Number(lvl.volume) : 0;
              return {
                price: bidShiftDelta !== 0 ? roundLevel(Math.max(step, lvl.price + bidShiftDelta)) : lvl.price,
                volume: lvlVol > 0 ? lvlVol : (idx === 0 ? bestBidTickVolume : 0),
              };
            })
            .sort((a, b) => b.price - a.price);
          if (shiftedBidsDesc.length < DOM_LADDER_LEVELS && canSynthesize && step > 0) {
            const outerBookBid = shiftedBidsDesc[shiftedBidsDesc.length - 1].price;
            const missingCount = DOM_LADDER_LEVELS - shiftedBidsDesc.length;
            for (let i = 1; i <= missingCount; i += 1) {
              shiftedBidsDesc.push({
                price: roundLevel(Math.max(step, outerBookBid - i * step)),
                volume: 0,
              });
            }
          }
          return shiftedBidsDesc;
        })()
      : !canSynthesize
        ? []
        : Array.from({ length: DOM_LADDER_LEVELS }, (_, idx) => ({
            price: roundLevel(Math.max(step, safeBid - idx * step)),
            volume: idx === 0 ? bestBidTickVolume : 0,
          }));

    const allVols = [...resolvedAsks, ...resolvedBids].map((r) => r.volume);
    return {
      asks: resolvedAsks,
      bids: resolvedBids,
      maxVolume: Math.max(...allVols, 1),
    };
  }, [ask, askVolume, bid, bidVolume, digits, rawOrderBook?.asks, rawOrderBook?.bids, stepUnit]);

  return (
    <div className="rtx-order-dialog__dom" data-testid="order-dom-pane">
      <div className="rtx-order-dialog__dom-toolbar" role="toolbar" aria-label={tr("Depth of Market toolbar")}>
        <button
          type="button"
          className="rtx-order-dialog__toolbar-btn"
          title={tr("Tick chart")}
          onClick={onToggleTickChart}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M1.5 7L4.5 3.5L7.5 6.5L11.5 2.5L14.5 5.5" stroke="#3687ff" strokeWidth="1.3" />
            <rect x="8.5" y="8.5" width="5" height="5" rx="1" stroke="#3687ff" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          type="button"
          className={`rtx-order-dialog__toolbar-btn ${showVolumeBars ? 'rtx-order-dialog__toolbar-btn--active' : ''}`}
          title={tr("Depth of Market mode")}
          onClick={() => setShowVolumeBars((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="4" y="2" width="8" height="12" stroke="#3687ff" strokeWidth="1.2" />
            <path d="M2 5.5H14M2 10.5H14" stroke="#3687ff" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          type="button"
          className="rtx-order-dialog__toolbar-btn"
          title={tr("Center spread")}
          onClick={() => {
            void reloadOrderBook?.();
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 4H14M2 12H14M5 8H11" stroke="#7a7a85" strokeWidth="1.2" />
          </svg>
        </button>
      </div>

      <div className="rtx-order-dialog__dom-table-wrap">
        <table className="rtx-order-dialog__dom-table" aria-label={tr("Depth of Market")}>
          <thead>
            <tr>
              <th>{tr("Volume")}</th>
              <th>{tr("Price")}</th>
              <th>{tr("Trade")}</th>
            </tr>
          </thead>
          <tbody>
            {asks.map((level, idx) => {
              const hasVolume = level.volume > 0;
              const barPct = showVolumeBars && hasVolume ? Math.min(100, Math.round((level.volume / maxVolume) * 100)) : 0;
              return (
                <tr
                  key={`ask-${idx}`}
                  className={`rtx-order-dialog__dom-row rtx-order-dialog__dom-row--ask ${idx === asks.length - 1 ? 'rtx-order-dialog__dom-row--best-ask' : ''}`}
                >
                  <td className="rtx-order-dialog__dom-vol">
                    {showVolumeBars && hasVolume && (
                      <span
                        className="rtx-order-dialog__dom-bar rtx-order-dialog__dom-bar--ask"
                        style={{ width: `${barPct}%` }}
                        aria-hidden="true"
                      />
                    )}
                    {hasVolume ? <span className="rtx-order-dialog__dom-vol-text">{level.volume}</span> : null}
                  </td>
                  <td
                    className="rtx-order-dialog__dom-price rtx-order-dialog__dom-price--ask"
                    onClick={() => onSelectDomPrice(level.price, 'sell')}
                  >
                    {formatDialogPrice(level.price, digits)}
                  </td>
                  <td className="rtx-order-dialog__dom-trade">
                    <button
                      type="button"
                      className="rtx-order-dialog__dom-chevron rtx-order-dialog__dom-chevron--sell"
                      title={tr("Sell at {{value0}}", { value0: formatDialogPrice(level.price, digits) })}
                      onClick={() => onSelectDomPrice(level.price, 'sell')}
                    >
                      ∨
                    </button>
                    <button
                      type="button"
                      className="rtx-order-dialog__dom-chevron rtx-order-dialog__dom-chevron--buy"
                      title={tr("Buy at {{value0}}", { value0: formatDialogPrice(level.price, digits) })}
                      onClick={() => onSelectDomPrice(level.price, 'buy')}
                    >
                      ∧
                    </button>
                  </td>
                </tr>
              );
            })}
            {bids.map((level, idx) => {
              const hasVolume = level.volume > 0;
              const barPct = showVolumeBars && hasVolume ? Math.min(100, Math.round((level.volume / maxVolume) * 100)) : 0;
              return (
                <tr
                  key={`bid-${idx}`}
                  className={`rtx-order-dialog__dom-row rtx-order-dialog__dom-row--bid ${idx === 0 ? 'rtx-order-dialog__dom-row--best-bid' : ''}`}
                >
                  <td className="rtx-order-dialog__dom-vol">
                    {showVolumeBars && hasVolume && (
                      <span
                        className="rtx-order-dialog__dom-bar rtx-order-dialog__dom-bar--bid"
                        style={{ width: `${barPct}%` }}
                        aria-hidden="true"
                      />
                    )}
                    {hasVolume ? <span className="rtx-order-dialog__dom-vol-text">{level.volume}</span> : null}
                  </td>
                  <td
                    className="rtx-order-dialog__dom-price rtx-order-dialog__dom-price--bid"
                    onClick={() => onSelectDomPrice(level.price, 'buy')}
                  >
                    {formatDialogPrice(level.price, digits)}
                  </td>
                  <td className="rtx-order-dialog__dom-trade">
                    <button
                      type="button"
                      className="rtx-order-dialog__dom-chevron rtx-order-dialog__dom-chevron--sell"
                      title={tr("Sell at {{value0}}", { value0: formatDialogPrice(level.price, digits) })}
                      onClick={() => onSelectDomPrice(level.price, 'sell')}
                    >
                      ∨
                    </button>
                    <button
                      type="button"
                      className="rtx-order-dialog__dom-chevron rtx-order-dialog__dom-chevron--buy"
                      title={tr("Buy at {{value0}}", { value0: formatDialogPrice(level.price, digits) })}
                      onClick={() => onSelectDomPrice(level.price, 'buy')}
                    >
                      ∧
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type DialogSubmitSide = 'buy' | 'sell';

function resolveSideForOrderType(type: OrderType | undefined): DialogSubmitSide | null {
  if (!type) return null;
  if (type.startsWith('Buy ')) return 'buy';
  if (type.startsWith('Sell ')) return 'sell';
  return null;
}

/** True when `price` is not at least `minDist` below `anchor`. Level 0 stays strict. */
function stopsTooCloseBelow(price: number, anchor: number, minDist: number, eps: number): boolean {
  return minDist > 0 ? price > anchor - minDist + eps : price >= anchor - eps;
}

/** True when `price` is not at least `minDist` above `anchor`. Level 0 stays strict. */
function stopsTooCloseAbove(price: number, anchor: number, minDist: number, eps: number): boolean {
  return minDist > 0 ? price < anchor + minDist - eps : price <= anchor + eps;
}

// ITEM 2 (T10 side preselection): normalize the chart-provided side.
// Fail-closed: anything other than BUY/SELL resolves to null (default flow).
function normalizeInitialDialogSide(value: unknown): DialogSubmitSide | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'BUY') return 'buy';
  if (normalized === 'SELL') return 'sell';
  return null;
}

/**
 * Draft side for the order-panel draft pipeline (App openOrderPanelForSymbol).
 * Fail-closed: only exact BUY/SELL (any case, trimmed) produce a preselected
 * side; everything else yields undefined (dialog default flow).
 */
export function resolveOrderPanelSide(value: unknown): 'BUY' | 'SELL' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase();
  return normalized === 'BUY' || normalized === 'SELL' ? normalized : undefined;
}

// ─── Main Order Dialog ──────────────────────────────────────
export function OrderPanelDialog({
  isOpen,
  onClose,
  symbol: initialSymbol,
  currentPrice,
  onSubmitOrder,
  initialOrderType,
  initialPrice,
  initialSide,
  marketStatus,
  symbols: accountSymbols,
  instruments,
}: OrderPanelProps) {
  const tr = useUiTranslation();
  const [symbol, setSymbol] = useState(initialSymbol);
  // ITEM 2 (T10 side preselection): the Buy/Sell submit path defaults to the
  // chart-implied side while both buttons stay functional (user can switch
  // by pressing the other button). Null = default flow (absent/invalid).
  const [selectedSide, setSelectedSide] = useState<DialogSubmitSide | null>(() =>
    normalizeInitialDialogSide(initialSide) ?? resolveSideForOrderType(initialOrderType),
  );
  // SUI-T2 keeps honoring explicit caller props; SUI-T8 seeds the rest from
  // the persisted Options trade defaults (no literals).
  const [orderType, setOrderType] = useState<OrderType>(initialOrderType ?? 'Market Execution');
  // SUI-T8: seed the ticket from the persisted Options trade defaults.
  // `default` mode uses the configured default; `last-used` volume mode
  // prefers the ticket's last lot size. Every fallback derives from the
  // store itself — never a literal.
  const tradeDefaults = useTradeDefaults();
  const [volumeStr, setVolumeStr] = useState(() =>
    String(resolveDefaultTradeVolume(tradeDefaults, { lastUsedVolume: readStoredLotSize() })),
  );
  const [deviationStr, setDeviationStr] = useState(() =>
    String(resolveDefaultTradeDeviation(tradeDefaults)),
  );
  // Price inputs start blank (never a fake '0.00'): the submit path omits
  // non-positive values, and SL/TP validity depends on the Buy/Sell side
  // chosen at submit time.
  const [priceStr, setPriceStr] = useState(() => (
    initialPrice !== undefined && Number.isFinite(initialPrice) && initialPrice > 0
      ? String(initialPrice)
      : ''
  ));
  const [stopLimitPriceStr, setStopLimitPriceStr] = useState('');
  const [isPriceEdited, setIsPriceEdited] = useState(() => (
    initialPrice !== undefined && Number.isFinite(initialPrice) && initialPrice > 0
  ));
  const [isStopLimitPriceEdited, setIsStopLimitPriceEdited] = useState(false);
  const [isPriceFocused, setIsPriceFocused] = useState(false);
  const [isStopLimitPriceFocused, setIsStopLimitPriceFocused] = useState(false);
  const [stopLossStr, setStopLossStr] = useState('');
  const [takeProfitStr, setTakeProfitStr] = useState('');
  const [fillPolicy, setFillPolicy] = useState<FillPolicy>('Fill or Kill');
  const [expiration, setExpiration] = useState<ExpirationType>('GTC');
  const [expirationDateStr, setExpirationDateStr] = useState(formatDefaultExpirationDate);
  const [comment, setComment] = useState('');
  const [isPlacing, setIsPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requiredMargin, setRequiredMargin] = useState<number | null>(null);
  const [marginCurrency, setMarginCurrency] = useState('');

  // Left sidebar & right pane view toggles (MT5 desktop layout)
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(false);
  const [showOneClickTrading, setShowOneClickTrading] = useState(true);
  const [showTickChart, setShowTickChart] = useState(true);
  const [showDom, setShowDom] = useState(true);
  const [marketRangeEnabled, setMarketRangeEnabled] = useState(true);
  const [slEnabled, setSlEnabled] = useState(false);
  const [tpEnabled, setTpEnabled] = useState(false);
  const [trailingStopEnabled, setTrailingStopEnabled] = useState(false);
  const [breakEvenEnabled, setBreakEvenEnabled] = useState(false);

  const liveMarketStatus = useSymbolMarketStatus(symbol, {
    enabled: isOpen && Boolean(symbol),
  });

  const tick = useAppStore((s) => s.ticks[symbol]);
  const account = useAppStore((s) => s.account);
  const storeAccountId = useAppStore((s) => s.accountId);
  const lastImmediateMarginTargetRef = useRef<string>('');
  const tickSymbolsKey = useAppStore((s) => (accountSymbols ? '' : Object.keys(s.ticks).join('|')));
  const chartSettings = useChartSettingsStore((state) => (
    state.symbolProperties[symbol] || state.globalProperties
  ));
  const quoteChartSettings = useChartSettingsStore((state) => (
    selectChartPropertiesForQuote(state, symbol)
  ));
  // Start with deterministic false so SSR and initial client hydration match,
  // then synchronize immediately before browser paint via useLayoutEffect below.
  const [isAdvancedUntitledLight, setIsAdvancedUntitledLight] = useState(false);
  const dialogQuoteColors = getChartDirectionalQuoteColors(quoteChartSettings, {
    isAdvancedUntitledLight,
  });

  useLayoutEffect(() => {
    const root = document.documentElement;
    const syncSkinState = () => {
      setIsAdvancedUntitledLight(
        root.classList.contains('rtx-advanced-view')
        && root.classList.contains('rtx-skin-untitled-light'),
      );
    };
    const handleAdvancedViewChange = (event: Event) => {
      const detail = (event as CustomEvent<{ isAdvancedUntitledLight?: boolean }>).detail;
      if (typeof detail?.isAdvancedUntitledLight === 'boolean') {
        setIsAdvancedUntitledLight(detail.isAdvancedUntitledLight);
      } else {
        syncSkinState();
      }
    };

    syncSkinState();
    const observer = new MutationObserver(syncSkinState);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener(RTX_ADVANCED_VIEW_CHANGE_EVENT, handleAdvancedViewChange);
    return () => {
      observer.disconnect();
      window.removeEventListener(RTX_ADVANCED_VIEW_CHANGE_EVENT, handleAdvancedViewChange);
    };
  }, []);

  const symbolOptions = useMemo(() => buildOrderTicketSymbolOptions({
    accountSymbols,
    tickSymbols: tickSymbolsKey ? tickSymbolsKey.split('|') : [],
    currentSymbol: accountSymbols ? symbol : initialSymbol,
  }), [accountSymbols, initialSymbol, symbol, tickSymbolsKey]);

  // TERM-DIGITS-WL: every instrument property comes from broker data only
  // (registered catalog, catalog row prop, then tick digits). No name table,
  // no fallback constant. Unknown precision stays null -> raw String(value),
  // no rounding/point math; unknown contract size -> '—'.
  const catalogInstrument = useMemo(() => {
    const target = symbol.trim().toUpperCase();
    return instruments?.find((row) => String(row?.symbol ?? '').trim().toUpperCase() === target) ?? null;
  }, [instruments, symbol]);
  const bid = tick?.bid || currentPrice.bid || 0;
  const ask = tick?.ask || currentPrice.ask || 0;
  const {
    digits: specDigits,
    priceStep,
    contractSize,
  } = getInstrumentConfig(symbol, tick?.digits, catalogInstrument, [bid, ask, tick?.rawBid, tick?.rawAsk]);
  const specStopsLevel = useMemo(
    () => resolveInstrumentStopsLevel(symbol, catalogInstrument, tick as { stops_level?: unknown; stopsLevel?: unknown } | undefined),
    [catalogInstrument, symbol, tick],
  );
  const chartColors = useMemo(
    () => getEffectiveChartColors(chartSettings, { isAdvancedUntitledLight }),
    [chartSettings, isAdvancedUntitledLight],
  );
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      setPos({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  useEffect(() => {
    if (isOpen) {
      setSymbol(initialSymbol);
      setError(null);
      // SUI-T8: re-seed ticket defaults from Options on every open so the
      // dialog follows settings edits made while it was closed. Drafts
      // edited while the dialog is open are intentionally left untouched.
      const latestTrade = useSettingsStore.getState().trade;
      setVolumeStr(String(resolveDefaultTradeVolume(latestTrade, { lastUsedVolume: readStoredLotSize() })));
      setDeviationStr(String(resolveDefaultTradeDeviation(latestTrade)));
    }
  }, [isOpen, initialSymbol]);

  // ITEM 2 (T10 side preselection): re-seed the default submit path on every
  // open so the dialog follows the latest chart entry point. Manual switches
  // made while open are left untouched until the next open/prop change.
  useEffect(() => {
    if (isOpen) {
      setSelectedSide(normalizeInitialDialogSide(initialSide) ?? resolveSideForOrderType(initialOrderType));
    }
  }, [isOpen, initialSide, initialOrderType]);

  useEffect(() => {
    if (isOpen && initialOrderType) {
      setOrderType(initialOrderType);
    }
  }, [isOpen, initialOrderType]);

  useEffect(() => {
    if (!isOpen) return;
    if (initialPrice !== undefined && Number.isFinite(initialPrice) && initialPrice > 0) {
      setIsPriceEdited(true);
      setPriceStr(specDigits === null ? String(initialPrice) : initialPrice.toFixed(specDigits));
    } else {
      setIsPriceEdited(false);
      setIsStopLimitPriceEdited(false);
    }
  }, [isOpen, initialPrice, specDigits]);

  // While a pending order mode (Limit, Stop, Stop-Limit) is active and the user
  // has not manually edited or focused the Price / Stop Limit price field, keep
  // it populated with the live broker quote so it shows the live price and stays editable.
  useEffect(() => {
    if (!isOpen || orderType === 'Market Execution') return;
    const effectiveSide = resolveSideForOrderType(orderType) ?? selectedSide;
    const refPrice = effectiveSide === 'sell' ? (bid || ask) : (ask || bid);
    if (!(refPrice > 0)) return;
    const formattedRef = formatDialogPrice(refPrice, specDigits);
    if (!isPriceEdited && !isPriceFocused) {
      setPriceStr((prev) => (prev === formattedRef ? prev : formattedRef));
    }
    if (isStopLimitOrderType(orderType) && !isStopLimitPriceEdited && !isStopLimitPriceFocused) {
      setStopLimitPriceStr((prev) => (prev === formattedRef ? prev : formattedRef));
    }
  }, [
    ask,
    bid,
    isOpen,
    isPriceEdited,
    isPriceFocused,
    isStopLimitPriceEdited,
    isStopLimitPriceFocused,
    orderType,
    selectedSide,
    specDigits,
  ]);

  const spread = ask - bid;
  // Spread pips from the same catalog-first spec digits as the prices.
  const spreadDisplay = formatSpreadDisplayWithUnit(symbol, spread, bid, ask, specDigits);
  const propMarketStatus = marketStatus?.symbol === symbol.toUpperCase()
    ? marketStatus
    : null;
  const effectiveMarketStatus = liveMarketStatus.loading && propMarketStatus
    ? propMarketStatus
    : liveMarketStatus;
  const marketBlockedMessage = getMarketStatusTradeBlockMessage(effectiveMarketStatus, symbol);
  const isMarketExecutionBlocked = orderType === 'Market Execution'
    && shouldBlockSymbolTrading(effectiveMarketStatus, symbol);

  // Margin currency from the broker margin response, else the account
  // currency; omitted when neither is known (never derived from the symbol).
  const baseCurrency = marginCurrency || account?.currency || '';
  const accountBalance = account && Number.isFinite(Number(account.balance)) ? Number(account.balance) : null;
  // A NOT VALUED account (the backend said its margin cannot be valued) has an unknown free margin (null),
  // never 0. Every other account keeps the 5ad2aa97 reading, including a valued account whose free-margin
  // flag is false (review hk-rev-term-notvalued2: its insufficient-margin block must stay).
  const accountNotValued = Boolean(account)
    && ((account as { metricsMarginUnavailable?: boolean | null }).metricsMarginUnavailable === true
      || (account as { metricsStatus?: string | null }).metricsStatus === 'unavailable');
  const accountFreeMargin = !account
    ? null
    : accountNotValued
      ? accountMetricProvided(account, 'freeMargin')
      : (Number.isFinite(Number(account.freeMargin)) ? Number(account.freeMargin) : null);
  // An unknown free margin never removes the zero-balance block that the balance alone triggers (5ad2aa97).
  const hasZeroOrNegativeBalance = accountBalance !== null
    && accountBalance <= 0
    && (accountFreeMargin === null || accountFreeMargin <= 0);
  const hasInsufficientMargin = Boolean(
    hasZeroOrNegativeBalance
    || (
      requiredMargin !== null
      && Number.isFinite(requiredMargin)
      && requiredMargin > 0
      && accountFreeMargin !== null
      && requiredMargin > accountFreeMargin
    ),
  );
  const insufficientMarginNotice = hasZeroOrNegativeBalance
    ? tr('Insufficient account balance (0.00) to open a new order.')
    : hasInsufficientMargin && requiredMargin !== null && accountFreeMargin !== null
      ? tr(
          'Insufficient free margin: required {{value0}}, available {{value1}}.',
          {
            value0: formatRequiredMargin(requiredMargin, baseCurrency),
            value1: formatRequiredMargin(accountFreeMargin, baseCurrency),
          },
        )
      : null;

  useEffect(() => {
    if (!isOpen) {
      lastImmediateMarginTargetRef.current = '';
      setRequiredMargin(null);
      return;
    }
    const parsedStoreLogin = Number.parseInt(String(storeAccountId ?? ''), 10);
    const login = (Number.isFinite(parsedStoreLogin) && parsedStoreLogin > 0 ? parsedStoreLogin : null)
      ?? getStoredAccountLogin();
    const volume = parseFloat(volumeStr);
    if (!login || !symbol || !Number.isFinite(volume) || volume <= 0) {
      setRequiredMargin(null);
      return;
    }
    let cancelled = false;
    const targetKey = `${login}:${symbol}`;
    const isImmediateFetch = lastImmediateMarginTargetRef.current !== targetKey;
    lastImmediateMarginTargetRef.current = targetKey;
    const timer = window.setTimeout(() => {
      tradeApi.market.calculateMargin({
        account_login: login,
        symbol,
        side: 'buy',
        volume,
      }).then((data) => {
        if (cancelled) return;
        const required = Number(data?.required_margin);
        setRequiredMargin(Number.isFinite(required) ? required : null);
        const currency = typeof data?.currency === 'string' && data.currency.trim() ? data.currency : '';
        setMarginCurrency(currency);
      }).catch(() => {
        if (!cancelled) setRequiredMargin(null);
      });
    }, isImmediateFetch ? 0 : 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, storeAccountId, symbol, volumeStr]);

  const adjustVolume = (delta: number) => {
    const current = parseFloat(volumeStr) || 0;
    const next = Math.max(0.01, Math.round((current + delta) * 100) / 100);
    setVolumeStr(next.toString());
  };

  const stepPriceField = (
    currentValue: string,
    setter: React.Dispatch<React.SetStateAction<string>>,
    direction: 1 | -1,
    anchorPrice: number,
  ) => {
    // New-order price stepping uses catalog digits only (no heuristic pipSize,
    // no fallback). Unknown digits = raw value, no rounding/point math.
    const parsed = Number.parseFloat(currentValue);
    if (specDigits === null) {
      if (!Number.isFinite(parsed) || parsed <= 0) {
        const seed = anchorPrice > 0 ? anchorPrice : (bid || ask || 0);
        setter(seed > 0 ? String(seed) : '');
        return;
      }
      setter(String(parsed));
      return;
    }
    // Broker tick size when published, else one point (10^-digits).
    const step = priceStep ?? Math.pow(10, -specDigits);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      const seed = anchorPrice > 0 ? anchorPrice : (bid || ask || step);
      setter(seed.toFixed(specDigits));
      return;
    }
    const next = Math.max(0, parsed + direction * step);
    setter(next.toFixed(specDigits));
  };

  const parsedPrice = Number.parseFloat(priceStr);
  const parsedStopLimitPrice = Number.parseFloat(stopLimitPriceStr);
  const parsedStopLoss = Number.parseFloat(stopLossStr);
  const parsedTakeProfit = Number.parseFloat(takeProfitStr);
  const parsedDeviation = Number.parseInt(deviationStr, 10);
  const unitStep = specDigits !== null ? (priceStep ?? Math.pow(10, -specDigits)) : null;
  const parsedVol = Number.parseFloat(volumeStr);

  const isPendingSideValid = useCallback((side: 'buy' | 'sell'): boolean => {
    if (orderType === 'Market Execution') return true;
    const explicitSide = resolveSideForOrderType(orderType);
    if (explicitSide && explicitSide !== side) return false;
    if (!Number.isFinite(parsedVol) || parsedVol < 0.01) return false;
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) return false;
    if (isStopLimitOrderType(orderType) && (!Number.isFinite(parsedStopLimitPrice) || parsedStopLimitPrice <= 0)) {
      return false;
    }

    // Stops level is points (10^-digits), the same distance handleSubmit uses.
    // priceStep stays the broker tick for the spinner, the DOM ladder, and the chart.
    const point = specDigits !== null ? Math.pow(10, -specDigits) : null;
    const minDist = (specStopsLevel !== null && specStopsLevel > 0 && point !== null)
      ? specStopsLevel * point
      : 0;
    const eps = specDigits !== null ? Math.pow(10, -(specDigits + 3)) : 1e-9;

    if (isLimitOrderType(orderType)) {
      if (side === 'buy' && ask > 0 && stopsTooCloseBelow(parsedPrice, ask, minDist, eps)) return false;
      if (side === 'sell' && bid > 0 && stopsTooCloseAbove(parsedPrice, bid, minDist, eps)) return false;
    } else if (isStopOrderType(orderType) || isStopLimitOrderType(orderType)) {
      if (side === 'buy' && ask > 0 && stopsTooCloseAbove(parsedPrice, ask, minDist, eps)) return false;
      if (side === 'sell' && bid > 0 && stopsTooCloseBelow(parsedPrice, bid, minDist, eps)) return false;
    }

    const entryRef = isStopLimitOrderType(orderType) && Number.isFinite(parsedStopLimitPrice) && parsedStopLimitPrice > 0
      ? parsedStopLimitPrice
      : parsedPrice;
    if (Number.isFinite(parsedStopLoss) && parsedStopLoss > 0) {
      if (side === 'buy' && stopsTooCloseBelow(parsedStopLoss, entryRef, minDist, eps)) return false;
      if (side === 'sell' && stopsTooCloseAbove(parsedStopLoss, entryRef, minDist, eps)) return false;
    }
    if (Number.isFinite(parsedTakeProfit) && parsedTakeProfit > 0) {
      if (side === 'buy' && stopsTooCloseAbove(parsedTakeProfit, entryRef, minDist, eps)) return false;
      if (side === 'sell' && stopsTooCloseBelow(parsedTakeProfit, entryRef, minDist, eps)) return false;
    }

    if (expiration === 'Specified' || expiration === 'Specified day') {
      try {
        resolveDialogExpirationTimestamp(expiration, expirationDateStr);
      } catch {
        return false;
      }
    }

    return true;
  }, [
    ask,
    bid,
    expiration,
    expirationDateStr,
    orderType,
    parsedPrice,
    parsedStopLimitPrice,
    parsedStopLoss,
    parsedTakeProfit,
    parsedVol,
    specDigits,
    specStopsLevel,
  ]);

  const handleOrderTypeChange = useCallback((nextType: OrderType) => {
    setOrderType(nextType);
    const impliedSide = resolveSideForOrderType(nextType);
    if (impliedSide) {
      setSelectedSide(impliedSide);
    }
    if (nextType === 'Market Execution') {
      setIsPriceEdited(false);
      setIsStopLimitPriceEdited(false);
      return;
    }
    const effectiveSide = impliedSide ?? selectedSide;
    const refPrice = effectiveSide === 'sell' ? (bid || ask) : (ask || bid);
    if (refPrice > 0) {
      const formattedRef = formatDialogPrice(refPrice, specDigits);
      if (!isPriceEdited || priceStr.trim() === '') {
        setIsPriceEdited(false);
        setPriceStr(formattedRef);
      }
      if (isStopLimitOrderType(nextType) && (!isStopLimitPriceEdited || stopLimitPriceStr.trim() === '')) {
        setIsStopLimitPriceEdited(false);
        setStopLimitPriceStr(formattedRef);
      }
    }
  }, [ask, bid, isPriceEdited, isStopLimitPriceEdited, priceStr, selectedSide, specDigits, stopLimitPriceStr]);

  const handleSubmit = useCallback(async (
    side: 'buy' | 'sell',
    overrideProtection?: { priceSl?: number; priceTp?: number; forceMarket?: boolean },
  ) => {
    const intentAtMs = captureTradeOrderIntent();
    if (isPlacing) return;
    const effectiveOrderType = overrideProtection?.forceMarket
      ? 'Market Execution'
      : alignOrderTypeToSide(orderType, side);
    const blocked = effectiveOrderType === 'Market Execution'
      && shouldBlockSymbolTrading(effectiveMarketStatus, symbol);
    if (blocked) {
      setError(marketBlockedMessage || tr('Market is closed for {{value0}}.', { value0: symbol }));
      return;
    }
    setIsPlacing(true);
    setError(null);

    try {
      const volume = parseFloat(volumeStr) || 0.01;
      localStorage.setItem('lastLotSize', volume.toString());

      const slVal = overrideProtection?.priceSl !== undefined
        ? overrideProtection.priceSl
        // TERM-DIGITS-WL: submit raw parsed SL/TP (no toFixed rounding here;
        // display rounding happens onBlur/step via catalog specDigits only).
        : (Number.isFinite(parsedStopLoss) && parsedStopLoss > 0 ? parsedStopLoss : undefined);
      const tpVal = overrideProtection?.priceTp !== undefined
        ? overrideProtection.priceTp
        : (Number.isFinite(parsedTakeProfit) && parsedTakeProfit > 0 ? parsedTakeProfit : undefined);

      if (specStopsLevel !== null && specStopsLevel > 0 && specDigits !== null) {
        const minDist = specStopsLevel * Math.pow(10, -specDigits);
        const eps = Math.pow(10, -(specDigits + 3));
        if (effectiveOrderType === 'Market Execution') {
          const refPrice = side === 'buy' ? bid : ask;
          const refLabel = side === 'buy' ? 'Bid' : 'Ask';
          if (refPrice > 0) {
            if (slVal !== undefined) {
              const bound = side === 'buy' ? refPrice - minDist : refPrice + minDist;
              const violated = side === 'buy' ? slVal > bound + eps : slVal < bound - eps;
              if (violated) {
                setError(`Stop loss must be ${side === 'buy' ? 'at most' : 'at least'} ${bound.toFixed(specDigits)} (minimum distance ${specStopsLevel} pts from ${refLabel} ${refPrice.toFixed(specDigits)})`);
                setIsPlacing(false);
                return;
              }
            }
            if (tpVal !== undefined) {
              const bound = side === 'buy' ? refPrice + minDist : refPrice - minDist;
              const violated = side === 'buy' ? tpVal < bound - eps : tpVal > bound + eps;
              if (violated) {
                setError(`Take profit must be ${side === 'buy' ? 'at least' : 'at most'} ${bound.toFixed(specDigits)} (minimum distance ${specStopsLevel} pts from ${refLabel} ${refPrice.toFixed(specDigits)})`);
                setIsPlacing(false);
                return;
              }
            }
          }
        } else if (Number.isFinite(parsedPrice) && parsedPrice > 0) {
          const entryRef = isStopLimitOrderType(effectiveOrderType) && Number.isFinite(parsedStopLimitPrice) && parsedStopLimitPrice > 0
            ? parsedStopLimitPrice
            : parsedPrice;
          if (slVal !== undefined) {
            const bound = side === 'buy' ? entryRef - minDist : entryRef + minDist;
            const violated = side === 'buy' ? slVal > bound + eps : slVal < bound - eps;
            if (violated) {
              setError(`Pending order SL must be ${side === 'buy' ? 'at most' : 'at least'} ${bound.toFixed(specDigits)} (minimum distance ${specStopsLevel} pts)`);
              setIsPlacing(false);
              return;
            }
          }
          if (tpVal !== undefined) {
            const bound = side === 'buy' ? entryRef + minDist : entryRef - minDist;
            const violated = side === 'buy' ? tpVal < bound - eps : tpVal > bound + eps;
            if (violated) {
              setError(`Pending order TP must be ${side === 'buy' ? 'at least' : 'at most'} ${bound.toFixed(specDigits)} (minimum distance ${specStopsLevel} pts)`);
              setIsPlacing(false);
              return;
            }
          }
        }
      }

      // SUI-T2: convert the expiration choice to epoch seconds here. GTC
      // omits expiry; Today/Specified resolve to a timestamp; invalid or past
      // dated values block submit fail-closed (never 0/NaN).
      let expirationTimestamp: number | undefined;
      if (effectiveOrderType !== 'Market Execution') {
        try {
          expirationTimestamp = resolveDialogExpirationTimestamp(expiration, expirationDateStr);
        } catch (expiryErr) {
          setError(expiryErr instanceof Error ? expiryErr.message : 'Invalid expiration');
          setIsPlacing(false);
          return;
        }
      }
      await onSubmitOrder({
        type: side,
        volume,
        symbol,
        ...(effectiveOrderType === 'Market Execution' && Number.isFinite(parsedDeviation) && parsedDeviation >= 0
          ? { deviation: parsedDeviation }
          : {}),
        ...(effectiveOrderType !== 'Market Execution' ? {
          orderType: effectiveOrderType,
          price: Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : undefined,
          stopLimitPrice: isStopLimitOrderType(effectiveOrderType) && Number.isFinite(parsedStopLimitPrice) && parsedStopLimitPrice > 0
            ? parsedStopLimitPrice
            : undefined,
          expiration,
          ...(expirationTimestamp !== undefined ? { expirationTimestamp } : {}),
        } : {}),
        ...(slVal ? { priceSl: slVal } : {}),
        ...(tpVal ? { priceTp: tpVal } : {}),
        comment: comment.trim() || undefined,
        intentAtMs,
      });

      useLastSymbolStore.getState().setLastSymbol(symbol, side.toUpperCase() as 'BUY' | 'SELL');
      onClose();
    } catch (err: any) {
      const rawMsg = typeof err?.message === 'string' ? err.message.trim() : '';
      const formattedMsg = /^(?:Order (?:failed|status unknown):|Account busy|[A-Z][A-Z0-9_]{2,}:\s)/.test(rawMsg)
        ? rawMsg
        : formatOrderError(err);
      setError(formattedMsg || 'Order failed');
      setTimeout(() => setError(null), 5000);
    } finally {
      setIsPlacing(false);
    }
  }, [
    comment,
    effectiveMarketStatus,
    expiration,
    expirationDateStr,
    isPlacing,
    marketBlockedMessage,
    onClose,
    onSubmitOrder,
    orderType,
    parsedDeviation,
    parsedPrice,
    parsedStopLimitPrice,
    parsedStopLoss,
    parsedTakeProfit,
    ask,
    bid,
    specDigits,
    specStopsLevel,
    symbol,
    tr,
    volumeStr,
  ]);

  const handleSelectDomPrice = useCallback((clickedPrice: number, side: 'buy' | 'sell') => {
    // New-order price display uses catalog digits only; unknown = raw value.
    setIsPriceEdited(true);
    setPriceStr(specDigits === null ? String(clickedPrice) : clickedPrice.toFixed(specDigits));
    setSelectedSide(side);
    const execKind = depthExecutionForLevel(side === 'buy' ? 'BUY' : 'SELL', clickedPrice, bid, ask);
    if (orderType === 'Market Execution' || orderType === 'Limit Order' || orderType === 'Stop Order') {
      setOrderType(execKind === 'stop' ? 'Stop Order' : 'Limit Order');
    } else if (
      orderType === 'Buy Limit' || orderType === 'Sell Limit'
      || orderType === 'Buy Stop' || orderType === 'Sell Stop'
    ) {
      if (execKind === 'stop') {
        setOrderType(side === 'buy' ? 'Buy Stop' : 'Sell Stop');
      } else {
        setOrderType(side === 'buy' ? 'Buy Limit' : 'Sell Limit');
      }
    }
  }, [specDigits, orderType, bid, ask]);

  if (!isOpen) return null;

  const fullSymbolDescription = resolveSymbolDescription(symbol, SYMBOL_NAMES[symbol]);
  const headerTitleText = fullSymbolDescription
    ? `${tr("Order")}: ${symbol} - ${fullSymbolDescription}`
    : `${tr("Order")}: ${symbol}`;

  const symbolFieldId = `new-order-${symbol}-symbol`;
  const orderTypeFieldId = `new-order-${symbol}-type`;
  const volumeFieldId = `new-order-${symbol}-volume`;
  const deviationFieldId = `new-order-${symbol}-deviation`;
  const priceFieldId = `new-order-${symbol}-price`;
  const stopLimitPriceFieldId = `new-order-${symbol}-stop-limit-price`;
  const stopLossFieldId = `new-order-${symbol}-stop-loss`;
  const takeProfitFieldId = `new-order-${symbol}-take-profit`;
  const fillPolicyFieldId = `new-order-${symbol}-fill-policy`;
  const expirationFieldId = `new-order-${symbol}-expiration`;
  const expirationDateFieldId = `new-order-${symbol}-expiration-date`;
  const commentFieldId = `new-order-${symbol}-comment`;

  const contractUnitsText = formatContractUnitsSummary(volumeStr, symbol, contractSize);

  const splitQuoteParts = (value: number): { prefix: string; emphasis: string } => {
    const formatted = formatMt5QuotePrice(value, specDigits);
    if (!formatted || formatted === '—' || specDigits === null || specDigits <= 0) {
      return { prefix: formatted, emphasis: '' };
    }
    const splitIdx = Math.max(0, formatted.length - Math.min(2, specDigits));
    return {
      prefix: formatted.slice(0, splitIdx),
      emphasis: formatted.slice(splitIdx),
    };
  };
  const bidQuoteParts = splitQuoteParts(bid);
  const askQuoteParts = splitQuoteParts(ask);

  const orderHeadingTitle = orderType === 'Market Execution'
    ? tr("New market order")
    : isLimitOrderType(orderType)
      ? tr("New limit order")
      : isStopOrderType(orderType)
        ? tr("New stop order")
        : tr("New stop-limit order");

  const refEntryPrice = orderType === 'Market Execution'
    ? (selectedSide === 'sell' ? (bid || ask) : (ask || bid))
    : (Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : (ask || bid));

  const computeProtectionStats = (targetPrice: number) => {
    if (!Number.isFinite(targetPrice) || targetPrice <= 0 || !(refEntryPrice > 0) || unitStep === null || unitStep <= 0) {
      return { pips: '—', estBalance: '—', estProfit: '—', isPositive: false };
    }
    const rawDiff = Math.abs(targetPrice - refEntryPrice);
    const pipsCount = Math.round((rawDiff / unitStep) * 10) / 10;
    if (contractSize === null || contractSize <= 0 || !Number.isFinite(parsedVol) || parsedVol <= 0) {
      return { pips: String(pipsCount), estBalance: '—', estProfit: '—', isPositive: false };
    }
    const signedDiff = selectedSide === 'sell'
      ? (refEntryPrice - targetPrice)
      : (targetPrice - refEntryPrice);
    const pnl = signedDiff * parsedVol * contractSize;
    const pnlPrefix = pnl > 0 ? '+' : '';
    const estProfit = baseCurrency
      ? `${pnlPrefix}${pnl.toFixed(2)} ${baseCurrency}`
      : `${pnlPrefix}${pnl.toFixed(2)}`;
    const balance = Number(account?.balance);
    const estBalance = Number.isFinite(balance) && balance > 0
      ? `${pnlPrefix}${((pnl / balance) * 100).toFixed(2)} %`
      : '—';
    return {
      pips: String(pipsCount),
      estBalance,
      estProfit,
      isPositive: pnl >= 0,
    };
  };

  const slStats = computeProtectionStats(parsedStopLoss);
  const tpStats = computeProtectionStats(parsedTakeProfit);
  const pipValueDisplay = (
    unitStep !== null && unitStep > 0 && contractSize !== null && contractSize > 0 && Number.isFinite(parsedVol) && parsedVol > 0
  )
    ? `${(unitStep * parsedVol * contractSize).toFixed(2)}${baseCurrency ? ` ${baseCurrency}` : ''}`
    : '—';

  const tickHighRaw = Number((tick as { high?: unknown } | undefined)?.high);
  const tickLowRaw = Number((tick as { low?: unknown } | undefined)?.low);
  const sessionHighDisplay = Number.isFinite(tickHighRaw) && tickHighRaw > 0
    ? formatDialogPrice(tickHighRaw, specDigits)
    : (ask > 0 ? formatDialogPrice(ask, specDigits) : '—');
  const sessionLowDisplay = Number.isFinite(tickLowRaw) && tickLowRaw > 0
    ? formatDialogPrice(tickLowRaw, specDigits)
    : (bid > 0 ? formatDialogPrice(bid, specDigits) : '—');
  const sentimentSplit = (() => {
    const recentBars = candleAggregationService.getCandles(symbol, 'M1', true, false).slice(-20);
    let bullScore = 0;
    let bearScore = 0;
    for (const bar of recentBars) {
      const vol = Math.max(1, Number(bar.volume) || 1);
      if (bar.close > bar.open) bullScore += vol;
      else if (bar.close < bar.open) bearScore += vol;
      else {
        bullScore += vol * 0.5;
        bearScore += vol * 0.5;
      }
    }
    const mid = bid > 0 && ask > 0 ? (bid + ask) * 0.5 : (bid || ask || 0);
    if (Number.isFinite(tickHighRaw) && Number.isFinite(tickLowRaw) && tickHighRaw > tickLowRaw && mid > 0) {
      const rangeRatio = Math.max(0, Math.min(1, (mid - tickLowRaw) / (tickHighRaw - tickLowRaw)));
      bullScore += rangeRatio * 10;
      bearScore += (1 - rangeRatio) * 10;
    }
    const total = bullScore + bearScore;
    if (total <= 0) return { sellPct: 50, buyPct: 50 };
    const buyPct = Math.min(90, Math.max(10, Math.round((bullScore / total) * 100)));
    return { sellPct: 100 - buyPct, buyPct };
  })();

  return (
    <div
      className="rtx-order-dialog-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onContextMenuCapture={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        className="rtx-order-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${tr("New Order · ")}${symbol}`}
        data-order-mode={orderType}
        data-side={selectedSide ?? undefined}
        data-sidebar-expanded={isSidebarExpanded ? 'true' : 'false'}
        data-show-tick-chart={showTickChart ? 'true' : 'false'}
        data-show-dom={showDom ? 'true' : 'false'}
        style={{
          transform: `translate(${pos.x}px, ${pos.y}px)`,
          transition: dragRef.current ? 'none' : 'transform 0.1s ease-out',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="rtx-order-dialog__header"
          onMouseDown={handleHeaderMouseDown}
        >
          <span className="rtx-order-dialog__title">{headerTitleText}</span>
          <button
            type="button"
            aria-label={tr("Close New Order dialog")}
            className="rtx-order-dialog__close"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="rtx-order-dialog__content">
          {/* Column 1: Left Mode & View Sidebar (vertical mode tabs) */}
          <div className="rtx-order-dialog__sidebar" role="navigation" aria-label={tr("Order execution modes and panels")}>
            <div className="rtx-order-dialog__sidebar-top">
              <button
                type="button"
                data-testid="order-mode-market"
                className={`rtx-order-dialog__mode-btn ${orderType === 'Market Execution' ? 'rtx-order-dialog__mode-btn--active' : ''}`}
                title={tr("Market Execution")}
                onClick={() => handleOrderTypeChange('Market Execution')}
              >
                <span className="rtx-order-dialog__mode-text">{tr("Market order")}</span>
                {isSidebarExpanded && <span className="rtx-order-dialog__mode-label">{tr("Market Execution")}</span>}
              </button>

              <button
                type="button"
                data-testid="order-mode-limit"
                className={`rtx-order-dialog__mode-btn ${isLimitOrderType(orderType) ? 'rtx-order-dialog__mode-btn--active' : ''}`}
                title={tr("Limit Order")}
                onClick={() => handleOrderTypeChange('Limit Order')}
              >
                <span className="rtx-order-dialog__mode-text">{tr("Limit order")}</span>
                {isSidebarExpanded && <span className="rtx-order-dialog__mode-label">{tr("Limit Order")}</span>}
              </button>

              <button
                type="button"
                data-testid="order-mode-stop"
                className={`rtx-order-dialog__mode-btn ${isStopOrderType(orderType) ? 'rtx-order-dialog__mode-btn--active' : ''}`}
                title={tr("Stop Order")}
                onClick={() => handleOrderTypeChange('Stop Order')}
              >
                <span className="rtx-order-dialog__mode-text">{tr("Stop order")}</span>
                {isSidebarExpanded && <span className="rtx-order-dialog__mode-label">{tr("Stop Order")}</span>}
              </button>

              <button
                type="button"
                data-testid="order-mode-stop-limit"
                className={`rtx-order-dialog__mode-btn ${isStopLimitOrderType(orderType) ? 'rtx-order-dialog__mode-btn--active' : ''}`}
                title={tr("Stop Limit Order")}
                onClick={() => handleOrderTypeChange('Stop Limit Order')}
              >
                <span className="rtx-order-dialog__mode-text">{tr("Stop-limit order")}</span>
                {isSidebarExpanded && <span className="rtx-order-dialog__mode-label">{tr("Stop Limit Order")}</span>}
              </button>
            </div>

            <div className="rtx-order-dialog__sidebar-bottom">
              <button
                type="button"
                data-testid="order-toggle-oct"
                className={`rtx-order-dialog__view-btn ${showOneClickTrading ? 'rtx-order-dialog__view-btn--active' : ''}`}
                title={tr("One Click Trading")}
                onClick={() => setShowOneClickTrading((v) => !v)}
              >
                <span className="rtx-order-dialog__view-icon-box">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <rect x="2" y="3" width="4" height="10" fill="#f23645" />
                    <rect x="10" y="3" width="4" height="10" fill="#3687ff" />
                    <rect x="5" y="4.5" width="6" height="7" fill="#e5e7eb" />
                  </svg>
                </span>
                {isSidebarExpanded && <span className="rtx-order-dialog__mode-label">{tr("One Click Trading")}</span>}
              </button>

              <button
                type="button"
                data-testid="order-toggle-tick-chart"
                className={`rtx-order-dialog__view-btn ${showTickChart ? 'rtx-order-dialog__view-btn--active' : ''}`}
                title={tr("Tick Chart")}
                onClick={() => setShowTickChart((v) => !v)}
              >
                <span className="rtx-order-dialog__view-icon-box">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M1.5 6H5L6.8 3.5L9.2 8L11 6H14.5" stroke="#f23645" strokeWidth="1.3" />
                    <path d="M1.5 11.5H5.5L7.5 9.5L9.5 12.5L11.5 10.5H14.5" stroke="#3687ff" strokeWidth="1.3" />
                  </svg>
                </span>
                {isSidebarExpanded && <span className="rtx-order-dialog__mode-label">{tr("Tick Chart")}</span>}
              </button>

              <button
                type="button"
                data-testid="order-toggle-dom"
                className={`rtx-order-dialog__view-btn ${showDom ? 'rtx-order-dialog__view-btn--active' : ''}`}
                title={tr("Depth of Market")}
                onClick={() => setShowDom((v) => !v)}
              >
                <span className="rtx-order-dialog__view-icon-box">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <circle cx="3" cy="3.5" r="1" fill="#f23645" />
                    <circle cx="3" cy="6.5" r="1" fill="#f23645" />
                    <rect x="6" y="2.5" width="8" height="2" fill="#f23645" />
                    <rect x="8" y="5.5" width="6" height="2" fill="#f23645" />
                    <circle cx="3" cy="9.5" r="1" fill="#3687ff" />
                    <circle cx="3" cy="12.5" r="1" fill="#3687ff" />
                    <rect x="8" y="8.5" width="6" height="2" fill="#3687ff" />
                    <rect x="6" y="11.5" width="8" height="2" fill="#3687ff" />
                  </svg>
                </span>
                {isSidebarExpanded && <span className="rtx-order-dialog__mode-label">{tr("Depth of Market")}</span>}
              </button>

              <button
                type="button"
                data-testid="order-toggle-sidebar"
                className="rtx-order-dialog__view-btn rtx-order-dialog__view-btn--minimize"
                title={tr("Minimize")}
                onClick={() => setIsSidebarExpanded((v) => !v)}
              >
                <span className="rtx-order-dialog__view-icon-box">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    {isSidebarExpanded ? (
                      <path d="M12.5 8H3.5M6.5 5L3.5 8L6.5 11" stroke="#3687ff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    ) : (
                      <path d="M3.5 8H12.5M9.5 5L12.5 8L9.5 11" stroke="#3687ff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    )}
                  </svg>
                </span>
                {isSidebarExpanded && <span className="rtx-order-dialog__mode-label">{tr("Minimize")}</span>}
              </button>
            </div>
          </div>

          {/* Column 2: Main Order Form */}
          <div className="rtx-order-dialog__form">
            {/* Hero Title Bar */}
            <div className="rtx-order-dialog__hero-bar">
              <span className="rtx-order-dialog__hero-title">{orderHeadingTitle}</span>
              <div className="rtx-order-dialog__hero-actions">
                <button
                  type="button"
                  className="rtx-order-dialog__hero-icon-btn"
                  title={tr("Order Type")}
                  onClick={() => {
                    const el = document.getElementById(orderTypeFieldId);
                    el?.focus();
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <circle cx="12" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
                    <circle cx="4" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
                    <circle cx="12" cy="12.5" r="1.8" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M5.6 7.1L10.4 4.4M5.6 8.9L10.4 11.6" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`rtx-order-dialog__hero-icon-btn ${showDom ? 'rtx-order-dialog__hero-icon-btn--active' : ''}`}
                  title={tr("Depth of Market")}
                  onClick={() => setShowDom((v) => !v)}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M8 2.5C5.8 2.5 4.2 4.1 4.2 6.3V9.5L3 11H13L11.8 9.5V6.3C11.8 4.1 10.2 2.5 8 2.5Z" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M6.6 12.2C6.9 12.8 7.4 13.2 8 13.2C8.6 13.2 9.1 12.8 9.4 12.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`rtx-order-dialog__hero-icon-btn ${showTickChart ? 'rtx-order-dialog__hero-icon-btn--active' : ''}`}
                  title={tr("Tick Chart")}
                  onClick={() => setShowTickChart((v) => !v)}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d={showTickChart ? 'M9.5 4L5.5 8L9.5 12' : 'M6.5 4L10.5 8L6.5 12'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Instrument Status Subheader */}
            <div className="rtx-order-dialog__instrument-meta">
              <span className="rtx-order-dialog__instrument-desc">
                <span
                  className={`rtx-order-dialog__instrument-status-dot ${isMarketExecutionBlocked ? 'rtx-order-dialog__instrument-status-dot--closed' : ''}`}
                  aria-hidden="true"
                >
                  <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                    {isMarketExecutionBlocked ? (
                      <path d="M6 3.2V6.4M6 8.8H6.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    ) : (
                      <path d="M2.5 6.2L4.9 8.6L9.5 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    )}
                  </svg>
                </span>
                <span className="rtx-order-dialog__instrument-name">
                  {fullSymbolDescription ? tr(fullSymbolDescription) : symbol}
                </span>
                <span className="rtx-order-dialog__info-badge" aria-hidden="true" title={headerTitleText}>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M8 7.2V11.2M8 4.9H8.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </span>
              </span>
              <span className="rtx-order-dialog__instrument-change" title={`${tr("Spread: ")}${spreadDisplay}`}>
                <span className="rtx-order-dialog__spread-pill-label">{tr("Spread")}</span>
                <span className="rtx-order-dialog__spread-pill-val">{spreadDisplay}</span>
              </span>
            </div>

            {/* Symbol Selector + Order Type Row */}
            <div className="rtx-order-dialog__symbol-bar">
              <div className="rtx-order-dialog__field rtx-order-dialog__field--symbol">
                <label
                  className={`rtx-order-dialog__label ${isSidebarExpanded ? '' : 'rtx-order-dialog__label--compact-symbol'}`}
                  htmlFor={symbolFieldId}
                >
                  {tr("Symbol")}
                </label>
                <div className="rtx-order-dialog__symbol-select-wrap">
                  <select
                    id={symbolFieldId}
                    value={symbol}
                    onChange={(e) => {
                      setSymbol(e.target.value);
                      setIsPriceEdited(false);
                      setIsStopLimitPriceEdited(false);
                    }}
                    className="rtx-order-dialog__control rtx-order-dialog__symbol-select"
                  >
                    {symbolOptions.map(({ symbol: s, disabled }) => {
                      const desc = SYMBOL_NAMES[s] ? tr(SYMBOL_NAMES[s]) : resolveSymbolDescription(s);
                      return (
                        <option key={s} value={s} disabled={disabled}>
                          {desc ? `${s}, ${desc}` : s}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              <div className="rtx-order-dialog__field rtx-order-dialog__field--type-compact">
                <label className="rtx-order-dialog__label" htmlFor={orderTypeFieldId}>
                  {tr("Type")}
                </label>
                <select
                  id={orderTypeFieldId}
                  data-testid="order-type-select"
                  value={orderType}
                  onChange={(e) => handleOrderTypeChange(e.target.value as OrderType)}
                  className="rtx-order-dialog__control rtx-order-dialog__type-select"
                >
                  <option value="Market Execution">{tr("Market")}</option>
                  <option value="Buy Limit">{tr("Buy Limit")}</option>
                  <option value="Sell Limit">{tr("Sell Limit")}</option>
                  <option value="Buy Stop">{tr("Buy Stop")}</option>
                  <option value="Sell Stop">{tr("Sell Stop")}</option>
                  <option value="Buy Stop Limit">{tr("Buy Stop Limit")}</option>
                  <option value="Sell Stop Limit">{tr("Sell Stop Limit")}</option>
                  {orderType === 'Limit Order' && (
                    <option value="Limit Order">{tr("Limit")}</option>
                  )}
                  {orderType === 'Stop Order' && (
                    <option value="Stop Order">{tr("Stop")}</option>
                  )}
                  {orderType === 'Stop Limit Order' && (
                    <option value="Stop Limit Order">{tr("Stop Limit")}</option>
                  )}
                </select>
              </div>
            </div>

            {/* MT5 Order Fields (Volume, Deviation / Pending Price, Stop Loss, Take Profit, Fill Policy / Expiration, Comment) */}
            <div className="rtx-order-dialog__mt5-fields">
              <div className="rtx-order-dialog__field">
                <label className="rtx-order-dialog__label" htmlFor={volumeFieldId}>{tr("Volume")}</label>
                <div className="rtx-order-dialog__volume-row">
                  <div className="rtx-order-dialog__volume-control">
                    <input
                      id={volumeFieldId}
                      type="text"
                      inputMode="decimal"
                      value={volumeStr}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === '' || /^\d*\.?\d*$/.test(val)) {
                          setVolumeStr(val);
                        }
                      }}
                      onBlur={() => {
                        const parsed = parseFloat(volumeStr);
                        if (isNaN(parsed) || parsed < 0.01) {
                          setVolumeStr('0.01');
                        } else {
                          setVolumeStr(parsed.toString());
                        }
                      }}
                      className="rtx-order-dialog__volume-input"
                    />
                    <div className="rtx-order-dialog__spinner">
                      <button
                        type="button"
                        aria-label={tr("Increase volume")}
                        onClick={() => adjustVolume(0.01)}
                        className="rtx-order-dialog__spinner-button"
                      >▲</button>
                      <button
                        type="button"
                        aria-label={tr("Decrease volume")}
                        onClick={() => adjustVolume(-0.01)}
                        className="rtx-order-dialog__spinner-button"
                      >▼</button>
                    </div>
                  </div>
                  {orderType === 'Market Execution' && (
                    <span className="rtx-order-dialog__contract-units">{contractUnitsText}</span>
                  )}
                  <span
                    className={`rtx-order-dialog__margin ${hasInsufficientMargin ? 'rtx-order-dialog__margin--insufficient' : ''}`}
                    data-testid="order-required-margin"
                    data-insufficient-margin={hasInsufficientMargin ? 'true' : 'false'}
                  >
                    {formatRequiredMargin(requiredMargin, baseCurrency)}
                  </span>
                </div>
              </div>

              {orderType === 'Market Execution' && (
                <div className="rtx-order-dialog__field">
                  <label className="rtx-order-dialog__label" htmlFor={deviationFieldId}>{tr("Deviation")}</label>
                  <div className="rtx-order-dialog__volume-row">
                    <div className="rtx-order-dialog__volume-control">
                      <input
                        id={deviationFieldId}
                        type="text"
                        inputMode="numeric"
                        value={deviationStr}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === '' || /^\d*$/.test(val)) {
                            setDeviationStr(val);
                          }
                        }}
                        onBlur={() => {
                          const parsed = Number.parseInt(deviationStr, 10);
                          setDeviationStr(
                            Number.isFinite(parsed) && parsed >= 0
                              ? String(parsed)
                              : String(resolveDefaultTradeDeviation(useSettingsStore.getState().trade)),
                          );
                        }}
                        className="rtx-order-dialog__volume-input"
                      />
                    </div>
                  </div>
                </div>
              )}

              {orderType !== 'Market Execution' && (
                <>
                  <div className="rtx-order-dialog__field rtx-order-dialog__field--spaced-top">
                    <label className="rtx-order-dialog__label" htmlFor={priceFieldId}>{tr("Price")}</label>
                    <div className="rtx-order-dialog__volume-row">
                      <div className="rtx-order-dialog__volume-control">
                        <input
                          id={priceFieldId}
                          type="text"
                          inputMode="decimal"
                          value={priceStr}
                          onFocus={() => setIsPriceFocused(true)}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === '' || /^\d*\.?\d*$/.test(val)) {
                              setIsPriceEdited(true);
                              setPriceStr(val);
                            }
                          }}
                          onBlur={() => {
                            setIsPriceFocused(false);
                            const parsed = Number.parseFloat(priceStr);
                            if (Number.isFinite(parsed) && parsed > 0) {
                              setPriceStr(specDigits === null ? String(parsed) : parsed.toFixed(specDigits));
                            } else {
                              setIsPriceEdited(false);
                              const effectiveSide = resolveSideForOrderType(orderType) ?? selectedSide;
                              const refPrice = effectiveSide === 'sell' ? (bid || ask) : (ask || bid);
                              setPriceStr(refPrice > 0 ? formatDialogPrice(refPrice, specDigits) : '');
                            }
                          }}
                          className="rtx-order-dialog__volume-input"
                        />
                        <div className="rtx-order-dialog__spinner">
                          <button
                            type="button"
                            aria-label={tr("Increase price")}
                            onClick={() => {
                              setIsPriceEdited(true);
                              stepPriceField(priceStr, setPriceStr, 1, ask || bid);
                            }}
                            className="rtx-order-dialog__spinner-button"
                          >▲</button>
                          <button
                            type="button"
                            aria-label={tr("Decrease price")}
                            onClick={() => {
                              setIsPriceEdited(true);
                              stepPriceField(priceStr, setPriceStr, -1, bid || ask);
                            }}
                            className="rtx-order-dialog__spinner-button"
                          >▼</button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rtx-order-dialog__field">
                    <label className="rtx-order-dialog__label" htmlFor={stopLimitPriceFieldId}>{tr("Stop Limit price")}</label>
                    <div className="rtx-order-dialog__volume-row">
                      <div
                        className={`rtx-order-dialog__volume-control ${!isStopLimitOrderType(orderType) ? 'rtx-order-dialog__volume-control--disabled' : ''}`}
                      >
                        <input
                          id={stopLimitPriceFieldId}
                          type="text"
                          inputMode="decimal"
                          disabled={!isStopLimitOrderType(orderType)}
                          value={stopLimitPriceStr}
                          onFocus={() => setIsStopLimitPriceFocused(true)}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === '' || /^\d*\.?\d*$/.test(val)) {
                              setIsStopLimitPriceEdited(true);
                              setStopLimitPriceStr(val);
                            }
                          }}
                          onBlur={() => {
                            setIsStopLimitPriceFocused(false);
                            const parsed = Number.parseFloat(stopLimitPriceStr);
                            if (Number.isFinite(parsed) && parsed > 0) {
                              setStopLimitPriceStr(specDigits === null ? String(parsed) : parsed.toFixed(specDigits));
                            } else {
                              setIsStopLimitPriceEdited(false);
                              const effectiveSide = resolveSideForOrderType(orderType) ?? selectedSide;
                              const refPrice = effectiveSide === 'sell' ? (bid || ask) : (ask || bid);
                              setStopLimitPriceStr(refPrice > 0 ? formatDialogPrice(refPrice, specDigits) : '');
                            }
                          }}
                          className="rtx-order-dialog__volume-input"
                        />
                        <div className="rtx-order-dialog__spinner">
                          <button
                            type="button"
                            disabled={!isStopLimitOrderType(orderType)}
                            aria-label={tr("Increase stop limit price")}
                            onClick={() => {
                              setIsStopLimitPriceEdited(true);
                              stepPriceField(stopLimitPriceStr, setStopLimitPriceStr, 1, ask || bid);
                            }}
                            className="rtx-order-dialog__spinner-button"
                          >▲</button>
                          <button
                            type="button"
                            disabled={!isStopLimitOrderType(orderType)}
                            aria-label={tr("Decrease stop limit price")}
                            onClick={() => {
                              setIsStopLimitPriceEdited(true);
                              stepPriceField(stopLimitPriceStr, setStopLimitPriceStr, -1, bid || ask);
                            }}
                            className="rtx-order-dialog__spinner-button"
                          >▼</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}

              <div className="rtx-order-dialog__field">
                <label className="rtx-order-dialog__label" htmlFor={stopLossFieldId}>{tr("Stop Loss")}</label>
                <div className="rtx-order-dialog__volume-row">
                  <div className="rtx-order-dialog__volume-control">
                    <input
                      id={stopLossFieldId}
                      type="text"
                      inputMode="decimal"
                      value={stopLossStr}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === '' || /^\d*\.?\d*$/.test(val)) setStopLossStr(val);
                      }}
                      onBlur={() => {
                        const parsed = Number.parseFloat(stopLossStr);
                        setStopLossStr(Number.isFinite(parsed) && parsed >= 0 ? (specDigits === null ? String(parsed) : parsed.toFixed(specDigits)) : '');
                      }}
                      className="rtx-order-dialog__volume-input"
                    />
                    <div className="rtx-order-dialog__spinner">
                      <button
                        type="button"
                        aria-label={tr("Increase stop loss")}
                        onClick={() => stepPriceField(stopLossStr, setStopLossStr, 1, bid || ask)}
                        className="rtx-order-dialog__spinner-button"
                      >▲</button>
                      <button
                        type="button"
                        aria-label={tr("Decrease stop loss")}
                        onClick={() => stepPriceField(stopLossStr, setStopLossStr, -1, bid || ask)}
                        className="rtx-order-dialog__spinner-button"
                      >▼</button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rtx-order-dialog__field">
                <label className="rtx-order-dialog__label" htmlFor={takeProfitFieldId}>{tr("Take Profit")}</label>
                <div className="rtx-order-dialog__volume-row">
                  <div className="rtx-order-dialog__volume-control">
                    <input
                      id={takeProfitFieldId}
                      type="text"
                      inputMode="decimal"
                      value={takeProfitStr}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === '' || /^\d*\.?\d*$/.test(val)) setTakeProfitStr(val);
                      }}
                      onBlur={() => {
                        const parsed = Number.parseFloat(takeProfitStr);
                        setTakeProfitStr(Number.isFinite(parsed) && parsed >= 0 ? (specDigits === null ? String(parsed) : parsed.toFixed(specDigits)) : '');
                      }}
                      className="rtx-order-dialog__volume-input"
                    />
                    <div className="rtx-order-dialog__spinner">
                      <button
                        type="button"
                        aria-label={tr("Increase take profit")}
                        onClick={() => stepPriceField(takeProfitStr, setTakeProfitStr, 1, ask || bid)}
                        className="rtx-order-dialog__spinner-button"
                      >▲</button>
                      <button
                        type="button"
                        aria-label={tr("Decrease take profit")}
                        onClick={() => stepPriceField(takeProfitStr, setTakeProfitStr, -1, ask || bid)}
                        className="rtx-order-dialog__spinner-button"
                      >▼</button>
                    </div>
                  </div>
                </div>
              </div>

              {orderType === 'Market Execution' ? (
                <div className="rtx-order-dialog__field">
                  <label className="rtx-order-dialog__label" htmlFor={fillPolicyFieldId}>{tr("Fill policy")}</label>
                  <div
                    className="rtx-order-dialog__fill-policy-wrap"
                    title={tr("Fill policy is not supported by the execution venue and is not sent")}
                  >
                    <div className="rtx-order-dialog__fill-tabs" role="tablist">
                      {(['Fill or Kill', 'Immediate or Cancel', 'Return'] as const).map((policy) => (
                        <button
                          key={policy}
                          type="button"
                          role="tab"
                          aria-selected={fillPolicy === policy}
                          className={`rtx-order-dialog__fill-tab ${fillPolicy === policy ? 'rtx-order-dialog__fill-tab--active' : ''}`}
                          onClick={() => setFillPolicy(policy)}
                          disabled
                          title={tr("Fill policy is not supported by the execution venue and is not sent")}
                          aria-describedby={`${fillPolicyFieldId}-unsupported-reason`}
                        >
                          {tr(policy)}
                        </button>
                      ))}
                    </div>
                    <select
                      id={fillPolicyFieldId}
                      value={fillPolicy}
                      onChange={(e) => setFillPolicy(e.target.value as FillPolicy)}
                      className="rtx-order-dialog__fill-select-sr"
                      disabled
                      title={tr("Fill policy is not supported by the execution venue and is not sent")}
                      aria-describedby={`${fillPolicyFieldId}-unsupported-reason`}
                    >
                      <option value="Fill or Kill">{tr("Fill or Kill")}</option>
                      <option value="Immediate or Cancel">{tr("Immediate or Cancel")}</option>
                      <option value="Return">{tr("Return")}</option>
                    </select>
                    <div
                      id={`${fillPolicyFieldId}-unsupported-reason`}
                      role="note"
                      className="rtx-order-dialog__margin"
                    >
                      {tr("Fill policy is not supported by the execution venue and is not sent")}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rtx-order-dialog__field">
                  <label className="rtx-order-dialog__label" htmlFor={expirationFieldId}>{tr("Expiration")}</label>
                  <div className="rtx-order-dialog__expiration-row">
                    <select
                      id={expirationFieldId}
                      value={expiration}
                      onChange={(e) => setExpiration(e.target.value as ExpirationType)}
                      className="rtx-order-dialog__control rtx-order-dialog__expiration-select"
                    >
                      <option value="GTC">{tr("GTC")}</option>
                      <option value="Today">{tr("Today")}</option>
                      <option value="Specified">{tr("Specified")}</option>
                      <option value="Specified day">{tr("Specified day")}</option>
                    </select>
                    <label className="rtx-order-dialog__expiration-date-label" htmlFor={expirationDateFieldId}>
                      {tr("Expiration date")}:
                    </label>
                    <input
                      id={expirationDateFieldId}
                      type="text"
                      value={expirationDateStr}
                      disabled={expiration === 'GTC' || expiration === 'Today'}
                      onChange={(e) => setExpirationDateStr(e.target.value)}
                      className="rtx-order-dialog__control rtx-order-dialog__expiration-date-input"
                    />
                    {(expiration === 'Specified' || expiration === 'Specified day') && (
                      <input
                        aria-label={tr("Expiration date picker")}
                        data-testid="order-dialog-expiration-picker"
                        type={expiration === 'Specified day' ? 'date' : 'datetime-local'}
                        value={formatDisplayToDateTimeLocal(expirationDateStr, expiration === 'Specified day')}
                        onChange={(e) => {
                          const rawVal = e.target.value;
                          if (!rawVal) return;
                          const nextDisplay = expiration === 'Specified day'
                            ? parseDateTimeLocalToDisplay(`${rawVal}T23:59`)
                            : parseDateTimeLocalToDisplay(rawVal);
                          setExpirationDateStr(nextDisplay);
                        }}
                        className="rtx-order-dialog__control rtx-order-dialog__expiration-date-picker ml-1"
                      />
                    )}
                  </div>
                </div>
              )}

              <div className="rtx-order-dialog__field">
                <label className="rtx-order-dialog__label" htmlFor={commentFieldId}>{tr("Comment")}</label>
                <div className="rtx-order-dialog__comment-wrap">
                  <input
                    id={commentFieldId}
                    type="text"
                    maxLength={64}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    className="rtx-order-dialog__control rtx-order-dialog__comment-input"
                  />
                  <span className="rtx-order-dialog__comment-chevron" aria-hidden="true">⌄</span>
                </div>
              </div>
            </div>

            <div
              className="rtx-order-dialog__message-slot"
              data-has-message={Boolean(error || isMarketExecutionBlocked || insufficientMarginNotice)}
            >
              {error ? (
                <div className="rtx-order-dialog__message rtx-order-dialog__message--error" role="alert">{tr(error)}</div>
              ) : isMarketExecutionBlocked ? (
                <div className="rtx-order-dialog__message rtx-order-dialog__message--warning" role="status">
                  {marketBlockedMessage || tr('Market is closed for {{value0}}.', { value0: symbol })}
                </div>
              ) : insufficientMarginNotice ? (
                <div
                  className="rtx-order-dialog__message rtx-order-dialog__message--warning"
                  data-testid="order-insufficient-margin-notice"
                  role="status"
                >
                  {insufficientMarginNotice}
                </div>
              ) : null}
            </div>

            {/* Bottom Action Footer: Sell / Buy Buttons, Sentiment Bar & Spread Summary */}
            <div className="rtx-order-dialog__bottom-actions">
              {orderType === 'Market Execution' ? (
                <div className="rtx-order-dialog__actions">
                  <button
                    type="button"
                    onClick={() => { setSelectedSide('sell'); void handleSubmit('sell'); }}
                    disabled={isPlacing || bid <= 0 || isMarketExecutionBlocked}
                    className="rtx-order-dialog__action rtx-order-dialog__action--sell"
                    aria-pressed={selectedSide === 'sell'}
                  >
                    <span className="rtx-order-dialog__sr-only">
                      {isPlacing ? tr("Placing...") : tr("Sell by Market")}
                    </span>
                    <span className="rtx-order-dialog__action-card-top" aria-hidden="true">
                      <span className="rtx-order-dialog__action-card-label">{tr("Sell")}</span>
                      <span className="rtx-order-dialog__action-card-side-tag">BID</span>
                    </span>
                    <span className="rtx-order-dialog__action-card-price" aria-hidden="true">
                      <span className="rtx-order-dialog__action-card-prefix">{bidQuoteParts.prefix}</span>
                      {bidQuoteParts.emphasis && (
                        <span className="rtx-order-dialog__action-card-pips">{bidQuoteParts.emphasis}</span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSelectedSide('buy'); void handleSubmit('buy'); }}
                    disabled={isPlacing || ask <= 0 || isMarketExecutionBlocked}
                    className="rtx-order-dialog__action rtx-order-dialog__action--buy"
                    aria-pressed={selectedSide === 'buy'}
                  >
                    <span className="rtx-order-dialog__sr-only">
                      {isPlacing ? tr("Placing...") : tr("Buy by Market")}
                    </span>
                    <span className="rtx-order-dialog__action-card-top" aria-hidden="true">
                      <span className="rtx-order-dialog__action-card-label">{tr("Buy")}</span>
                      <span className="rtx-order-dialog__action-card-side-tag">ASK</span>
                    </span>
                    <span className="rtx-order-dialog__action-card-price" aria-hidden="true">
                      <span className="rtx-order-dialog__action-card-prefix">{askQuoteParts.prefix}</span>
                      {askQuoteParts.emphasis && (
                        <span className="rtx-order-dialog__action-card-pips">{askQuoteParts.emphasis}</span>
                      )}
                    </span>
                  </button>
                </div>
              ) : (
                <div className="rtx-order-dialog__actions">
                  <button
                    type="button"
                    onClick={() => { setSelectedSide('sell'); void handleSubmit('sell'); }}
                    disabled={isPlacing || !isPendingSideValid('sell')}
                    className="rtx-order-dialog__action rtx-order-dialog__action--sell"
                    aria-pressed={selectedSide === 'sell'}
                  >
                    <span className="rtx-order-dialog__sr-only">
                      {isPlacing ? tr("Placing...") : tr("Sell")}
                    </span>
                    <span className="rtx-order-dialog__action-card-top" aria-hidden="true">
                      <span className="rtx-order-dialog__action-card-label">{tr("Sell")}</span>
                      <span className="rtx-order-dialog__action-card-side-tag">BID</span>
                    </span>
                    <span className="rtx-order-dialog__action-card-price" aria-hidden="true">
                      <span className="rtx-order-dialog__action-card-prefix">{bidQuoteParts.prefix}</span>
                      {bidQuoteParts.emphasis && (
                        <span className="rtx-order-dialog__action-card-pips">{bidQuoteParts.emphasis}</span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSelectedSide('buy'); void handleSubmit('buy'); }}
                    disabled={isPlacing || !isPendingSideValid('buy')}
                    className="rtx-order-dialog__action rtx-order-dialog__action--buy"
                    aria-pressed={selectedSide === 'buy'}
                  >
                    <span className="rtx-order-dialog__sr-only">
                      {isPlacing ? tr("Placing...") : tr("Buy")}
                    </span>
                    <span className="rtx-order-dialog__action-card-top" aria-hidden="true">
                      <span className="rtx-order-dialog__action-card-label">{tr("Buy")}</span>
                      <span className="rtx-order-dialog__action-card-side-tag">ASK</span>
                    </span>
                    <span className="rtx-order-dialog__action-card-price" aria-hidden="true">
                      <span className="rtx-order-dialog__action-card-prefix">{askQuoteParts.prefix}</span>
                      {askQuoteParts.emphasis && (
                        <span className="rtx-order-dialog__action-card-pips">{askQuoteParts.emphasis}</span>
                      )}
                    </span>
                  </button>
                </div>
              )}

              <div className="rtx-order-dialog__sentiment-strip" aria-hidden="true">
                <div className="rtx-order-dialog__sentiment-sell" style={{ width: `${sentimentSplit.sellPct}%` }}>
                  {sentimentSplit.sellPct}%
                </div>
                <div className="rtx-order-dialog__sentiment-buy" style={{ width: `${sentimentSplit.buyPct}%` }}>
                  {sentimentSplit.buyPct}%
                </div>
              </div>

              <div
                className="rtx-order-dialog__price-summary"
                aria-label={tr("Bid {{value0}}, Ask {{value1}}", { value0: formatDialogPrice(bid, specDigits), value1: formatDialogPrice(ask, specDigits) })}
              >
                <div className="rtx-order-dialog__summary-row">
                  <span className="rtx-order-dialog__spread-meta">
                    <span className="rtx-order-dialog__summary-key">{tr("Spread:")}</span>{' '}
                    <span className="rtx-order-dialog__summary-val">{spreadDisplay}</span>
                  </span>
                  <span className="rtx-order-dialog__mt5-quote">
                    {dialogQuoteColors.isDefaultPalette ? (
                      `${formatMt5QuotePrice(bid, specDigits)} / ${formatMt5QuotePrice(ask, specDigits)}`
                    ) : (
                      <>
                        <span style={{ color: dialogQuoteColors.downColor }}>{formatMt5QuotePrice(bid, specDigits)}</span>
                        {' / '}
                        <span style={{ color: dialogQuoteColors.upColor }}>{formatMt5QuotePrice(ask, specDigits)}</span>
                      </>
                    )}
                  </span>
                </div>
                <div className="rtx-order-dialog__summary-row rtx-order-dialog__summary-row--range">
                  <span className="rtx-order-dialog__range-item">
                    <span className="rtx-order-dialog__summary-key">{tr("High:")}</span>{' '}
                    <span className="rtx-order-dialog__summary-val">{sessionHighDisplay}</span>
                  </span>
                  <span className="rtx-order-dialog__range-item">
                    <span className="rtx-order-dialog__summary-key">{tr("Low:")}</span>{' '}
                    <span className="rtx-order-dialog__summary-val">{sessionLowDisplay}</span>
                  </span>
                </div>
                <span className="rtx-order-dialog__spread-sr">{tr("Spread: ")}{spreadDisplay}</span>
                {specStopsLevel !== null && specStopsLevel > 0 && (
                  <div
                    className="rtx-order-dialog__summary-row rtx-order-dialog__summary-row--range"
                    data-testid="order-dialog-stops-level"
                  >
                    <span className="rtx-order-dialog__margin">
                      {tr("Min stop distance")}: {specStopsLevel} pts
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="rtx-order-dialog__status-box" aria-live="polite">
              {isPlacing && <div className="rtx-order-dialog__progress-bar" />}
            </div>
          </div>

          {/* Column 3: Right Candlestick + Tick Chart Pane */}
          {showTickChart && (
            <div className="rtx-order-dialog__chart">
              <MiniTickChart
                symbol={symbol}
                bid={bid}
                ask={ask}
                digits={specDigits}
                priceStep={priceStep}
                chartColors={chartColors}
                chartSettings={chartSettings}
                isAdvancedUntitledLight={isAdvancedUntitledLight}
                orderPrice={orderType !== 'Market Execution' && Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : undefined}
                stopLossPrice={Number.isFinite(parsedStopLoss) && parsedStopLoss > 0 ? parsedStopLoss : undefined}
                takeProfitPrice={Number.isFinite(parsedTakeProfit) && parsedTakeProfit > 0 ? parsedTakeProfit : undefined}
                volumeText={volumeStr}
                sideHint={selectedSide}
                orderType={orderType}
              />
            </div>
          )}

          {/* Column 4: Depth of Market Pane */}
          {showDom && (
            <OrderDialogDomPane
              symbol={symbol}
              bid={bid}
              ask={ask}
              bidVolume={tick?.bidVolume}
              askVolume={tick?.askVolume}
              digits={specDigits}
              priceStep={priceStep}
              onToggleTickChart={() => setShowTickChart((v) => !v)}
              onSelectDomPrice={handleSelectDomPrice}
            />
          )}
        </div>
      </div>
    </div>
  );
}
