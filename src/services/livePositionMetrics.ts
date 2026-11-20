// Shared live-price / live-profit selectors.
//
// Positions in the store are NOT rewritten on every tick. Each consumer reads the latest quote
// from liveQuotes.ts and derives the live price and profit here, in O(1) per position. The math
// reproduces what patchPositionsFromTick used to write into every position on every tick:
//   - current price = bid for BUY, ask for SELL (quotes are already spread-widened);
//   - USD-quoted symbols: profit = (price - open) * dir * volume * contractSize / lotDivisor;
//   - USD-base symbols: the same value divided by the current price;
//   - any other cross, or unknown contract size: the price is updated and the backend profit is
//     kept verbatim (shown through resolveTradeProfit exactly as before).
/* eslint-disable @typescript-eslint/no-explicit-any -- positions arrive as several wire/normalized shapes (Position, ToolboxTradePosition, raw rows) */
import {
  calculateLivePositionProfit,
  readBackendPositionProfit,
  resolveTradeProfit,
  toBackendFinancialNumber,
  type TradeProfitInput,
} from '../components/BottomDock.trade';
import {
  getExposureContractSize,
  parseExposureSymbol,
} from '../components/BottomDock.exposure';
import { getLiveQuote, type LiveQuote } from './liveQuotes';
import { registerLiveRoundedProfitResolver } from './positionStream';

export type SymbolConversionMode = 'quote_usd' | 'base_usd' | 'static';

export interface TradeOverrideEntry {
  sl: number;
  tp: number;
  comment?: string;
  updatedAt?: number;
  baseSl?: number;
  baseTp?: number;
}

const BACKEND_PROFIT_ROUNDING_TOLERANCE = 0.005 + 1e-9;

const conversionCache = new Map<string, { mode: SymbolConversionMode; base: string | null }>();

export const getSymbolConversion = (
  symbol: unknown,
): { mode: SymbolConversionMode; base: string | null } => {
  const sym = String(symbol ?? '').trim().toUpperCase();
  if (!sym) return { mode: 'static', base: null };
  const hit = conversionCache.get(sym);
  if (hit) return hit;

  const parsed = parseExposureSymbol(sym);
  const quote = parsed?.quote ?? 'USD';
  const base = parsed?.base ?? null;
  let mode: SymbolConversionMode = 'static';
  if (quote === 'USD' || quote === 'USDT' || quote === 'USDC') {
    mode = 'quote_usd';
  } else if (base === 'USD') {
    mode = 'base_usd';
  }
  const out = { mode, base };
  conversionCache.set(sym, out);
  return out;
};

const toNumber = (value: unknown, fallback = 0): number => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (rec.amount !== undefined && rec.amount !== null) return toNumber(rec.amount, fallback);
  }
  const next = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(next) ? next : fallback;
};

/** The latest quote for the position's symbol (a newer backend write invalidates it, see liveQuotes). */
export const resolveLiveQuoteForPosition = (pos: any): LiveQuote | null => {
  if (!pos) return null;
  return getLiveQuote(String(pos.symbol ?? '')) ?? null;
};

export const getLivePositionPrice = (pos: any): number | null => {
  if (!pos) return null;
  const q = resolveLiveQuoteForPosition(pos);
  if (q) {
    const isSell = String(pos.side ?? '').toUpperCase() === 'SELL';
    const live = isSell ? q.ask : q.bid;
    if (Number.isFinite(live) && live > 0) return live;
  }
  if (pos.hasBackendCurrentPrice === false) return null;
  return toBackendFinancialNumber(pos.price_current ?? pos.current_price ?? pos.currentPrice);
};

export interface LiveProfitComputation {
  precise: number | null;
  rounded: number | null;
  currentPrice: number | null;
  hasBackendCurrentPrice: boolean;
  hasBackendProfit: boolean;
  timeUpdate: unknown;
  fromQuote: boolean;
  quote: LiveQuote | null;
}

export const computeLiveProfitPair = (pos: any): LiveProfitComputation => {
  if (!pos) {
    return {
      precise: null,
      rounded: null,
      currentPrice: null,
      hasBackendCurrentPrice: false,
      hasBackendProfit: false,
      timeUpdate: undefined,
      fromQuote: false,
      quote: null,
    };
  }
  const q = resolveLiveQuoteForPosition(pos);
  if (q) {
    const isSell = String(pos.side ?? '').toUpperCase() === 'SELL';
    const currentPrice = isSell ? q.ask : q.bid;
    if (Number.isFinite(currentPrice) && currentPrice > 0) {
      const openPrice = toNumber(pos.price_open ?? pos.open_price ?? pos.openPrice, 0);
      const volume = Math.abs(toNumber(pos.volume ?? pos.quantity, 0));
      const explicitCs = toBackendFinancialNumber(pos.contractSize ?? pos.contract_size);
      const contractSize = explicitCs ?? getExposureContractSize(pos);
      const lotDivRaw = toNumber(pos.lot_divisor ?? pos.lotDivisor, 1);
      const lotDivisor = lotDivRaw > 0 ? lotDivRaw : 1;
      const conv = getSymbolConversion(pos.symbol);

      if (
        openPrice > 0
        && volume > 0
        && contractSize !== null
        && contractSize > 0
        && conv.mode !== 'static'
      ) {
        const raw = ((currentPrice - openPrice) * (isSell ? -1 : 1) * volume * contractSize) / lotDivisor;
        if (Number.isFinite(raw)) {
          const live = conv.mode === 'base_usd' ? raw / currentPrice : raw;
          if (Number.isFinite(live)) {
            const rounded = Math.round(live * 100) / 100;
            const precise = Math.abs(raw - rounded) <= BACKEND_PROFIT_ROUNDING_TOLERANCE ? raw : rounded;
            return {
              precise,
              rounded,
              currentPrice,
              hasBackendCurrentPrice: true,
              hasBackendProfit: true,
              timeUpdate: q.timestamp || pos.time_update,
              fromQuote: true,
              quote: q,
            };
          }
        }
      }

      // Non-USD cross or unknown contract size: update the price, keep backend profit semantics.
      const backend = readBackendPositionProfit(pos as TradeProfitInput);
      const hasBackendProfit = pos.hasBackendProfit !== false && backend !== null;
      const precise = hasBackendProfit
        ? (
          calculateLivePositionProfit({
            ...(pos as TradeProfitInput),
            currentPrice,
            price_current: currentPrice,
            current_price: currentPrice,
            hasBackendCurrentPrice: true,
          }) ?? backend
        )
        : null;
      const resolvedFallback = hasBackendProfit && precise !== null && backend !== null
        ? (Math.abs(precise - backend) <= BACKEND_PROFIT_ROUNDING_TOLERANCE ? precise : backend)
        : (backend ?? (pos.hasBackendProfit === false ? null : precise));

      return {
        precise: resolvedFallback,
        rounded: backend ?? resolvedFallback,
        currentPrice,
        hasBackendCurrentPrice: true,
        hasBackendProfit: resolvedFallback !== null,
        timeUpdate: q.timestamp || pos.time_update,
        fromQuote: true,
        quote: q,
      };
    }
  }

  const backend = readBackendPositionProfit(pos as TradeProfitInput);
  const resolved = resolveTradeProfit(pos as TradeProfitInput).value;
  const fallbackPrice = pos.hasBackendCurrentPrice === false
    ? null
    : toBackendFinancialNumber(pos.price_current ?? pos.current_price ?? pos.currentPrice);
  return {
    precise: resolved,
    rounded: backend ?? resolved,
    currentPrice: fallbackPrice,
    hasBackendCurrentPrice: pos.hasBackendCurrentPrice !== false && fallbackPrice !== null,
    hasBackendProfit: resolved !== null,
    timeUpdate: pos.time_update,
    fromQuote: false,
    quote: null,
  };
};

/** Live profit as shown on screen (unrounded when it provably follows the backend rule). */
export const getLivePositionProfit = (pos: any): number | null => computeLiveProfitPair(pos).precise;

/** Live profit rounded to cents, the value the old tick patch wrote into position.profit. */
export const getLivePositionRoundedProfit = (pos: any): number | null => computeLiveProfitPair(pos).rounded;

// positionStream's WINNERS / LOSERS bulk-close reconcile reads live profit through this hook.
registerLiveRoundedProfitResolver(getLivePositionRoundedProfit);

export interface LiveRowCacheEntry {
  q: LiveQuote | null;
  override: TradeOverrideEntry | undefined;
  out: any;
}

/**
 * Applies the latest quote (and the optimistic SL/TP override) to one position row. The result is
 * memoised per (position object, quote object, override) so a row whose inputs did not change
 * keeps the same output identity.
 */
export const applyLiveQuoteToPosition = <T extends Record<string, any>>(
  position: T,
  override?: TradeOverrideEntry,
  cache?: WeakMap<object, LiveRowCacheEntry>,
): T => {
  const q = resolveLiveQuoteForPosition(position);
  if (cache) {
    const hit = cache.get(position);
    if (hit && hit.q === q && hit.override === override) {
      return hit.out as T;
    }
  }

  const pos = position as Record<string, any>;
  const symbol = pos.symbol ?? '';
  const openPrice = Number(
    pos.price_open ?? pos.open_price ?? pos.openPrice ?? pos.entryPrice ?? pos.chartEntryPrice ?? pos.price ?? 0,
  );
  const openTime = pos.time_create ?? pos.openTime ?? pos.open_time ?? pos.time ?? pos.chartEntryTime;
  const volume = Number(pos.volume_lots ?? pos.volume ?? pos.quantity ?? 0);

  const comp = computeLiveProfitPair(pos);

  const backendSl = Number(pos.price_sl ?? pos.sl ?? 0);
  const backendTp = Number(pos.price_tp ?? pos.tp ?? 0);
  const backendUpdatedFromBase = Boolean(
    override && (
      (override.baseSl !== undefined && Math.abs(backendSl - override.baseSl) > 1e-8 && Math.abs(backendSl - override.sl) > 1e-8)
      || (override.baseTp !== undefined && Math.abs(backendTp - override.baseTp) > 1e-8 && Math.abs(backendTp - override.tp) > 1e-8)
    ),
  );
  const useOverride = Boolean(
    override
    && !backendUpdatedFromBase
    && ((Date.now() - (override.updatedAt ?? 0)) <= 5000
      || (Math.abs(backendSl - (override.baseSl ?? backendSl)) <= 1e-8
        && Math.abs(backendTp - (override.baseTp ?? backendTp)) <= 1e-8)),
  );
  const sl = Number((useOverride ? override!.sl : (pos.price_sl ?? pos.sl ?? 0)) ?? 0);
  const tp = Number((useOverride ? override!.tp : (pos.price_tp ?? pos.tp ?? 0)) ?? 0);
  const comment = (useOverride ? override?.comment : undefined) ?? pos.comment ?? '';

  const livePrice = comp.currentPrice;
  const livePnL = comp.precise;
  const hasProfit = livePnL !== null;

  const out = {
    ...pos,
    symbol,
    volume,
    openPrice,
    price_open: openPrice,
    open_price: openPrice,
    currentPrice: livePrice,
    price_current: livePrice,
    current_price: livePrice,
    hasBackendCurrentPrice: comp.hasBackendCurrentPrice,
    openTime,
    time_create: openTime,
    open_time: openTime,
    time_update: comp.timeUpdate,
    sl,
    tp,
    price_sl: sl,
    price_tp: tp,
    comment,
    profit: livePnL,
    unrealizedPnL: livePnL ?? pos.unrealizedPnL,
    livePrice,
    livePnL,
    hasBackendProfit: hasProfit,
    profitSource: hasProfit ? 'backend' : 'missing',
    profitWarnings: hasProfit ? [] : ['missing_backend_profit'],
  };

  if (cache) {
    cache.set(position, { q, override, out });
  }
  return out as unknown as T;
};
