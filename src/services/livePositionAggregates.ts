// Per-symbol position aggregates and the O(numSymbols) live selectors built on them:
// footer account metrics, Close In-Profit / In-Loss counts, exposure summary, per-symbol P/L.
//
// The aggregates are computed once per positions array (WeakMap cache, O(N) only when the array
// changes, never per tick). A quote update then costs O(numSymbols) (profit sums) or
// O(numSymbols * log N) (bulk-close counts), independent of the number of open trades.
//
// Footer rounding: the live floating P/L is the exact (unrounded) sum of position profits. The
// previous implementation summed per-row cent-rounded profits, so the totals can differ by up to
// 0.005 per trade. A per-row rounded sum cannot be kept in O(numSymbols).
/* eslint-disable @typescript-eslint/no-explicit-any -- positions arrive as several wire/normalized shapes (Position, ToolboxTradePosition, raw rows) */
import { useSyncExternalStore } from 'react';
import {
  resolveTradeProfit,
  toBackendFinancialNumber,
  type TradeAccountMetricResolution,
  type TradeProfitInput,
} from '../components/BottomDock.trade';
import {
  buildExposureSummary,
  getExposureContractSize,
  parseExposureSymbol,
  type ExposureAccountInput,
  type ExposureSummary,
} from '../components/BottomDock.exposure';
import { getLiveQuote, getLiveQuotesVersion, subscribeLiveQuotes } from './liveQuotes';
import {
  getLivePositionProfit,
  getSymbolConversion,
  type SymbolConversionMode,
} from './livePositionMetrics';

export interface SymbolAggregate {
  symbol: string;
  conversion: SymbolConversionMode;
  baseAsset: string | null;
  buyCount: number;
  sellCount: number;
  buyUnits: number;
  buyWeightedOpen: number;
  sellUnits: number;
  sellWeightedOpen: number;
  buyBaseUnits: number;
  sellBaseUnits: number;
  buyFallbackProfit: number;
  sellFallbackProfit: number;
  buyFallbackMissing: number;
  sellFallbackMissing: number;
  fallbackProfitable: number;
  fallbackLosing: number;
  fallbackBid: number;
  fallbackAsk: number;
  fallbackLastRate: number;
}

export interface PositionAggregates {
  totalCount: number;
  positionsMargin: number | null;
  hasMissingMargin: boolean;
  totalSwap: number;
  totalCommission: number;
  staticProfitSum: number;
  staticMissingProfitCount: number;
  staticProfitable: number;
  staticLosing: number;
  symbols: string[];
  heldSymbols: Set<string>;
  bySymbol: Map<string, SymbolAggregate>;
}

const createEmptySymbolAggregate = (symbol: string): SymbolAggregate => {
  const conv = getSymbolConversion(symbol);
  return {
    symbol,
    conversion: conv.mode,
    baseAsset: conv.base,
    buyCount: 0,
    sellCount: 0,
    buyUnits: 0,
    buyWeightedOpen: 0,
    sellUnits: 0,
    sellWeightedOpen: 0,
    buyBaseUnits: 0,
    sellBaseUnits: 0,
    buyFallbackProfit: 0,
    sellFallbackProfit: 0,
    buyFallbackMissing: 0,
    sellFallbackMissing: 0,
    fallbackProfitable: 0,
    fallbackLosing: 0,
    fallbackBid: 0,
    fallbackAsk: 0,
    fallbackLastRate: 0,
  };
};

const createEmptyAggregates = (): PositionAggregates => ({
  totalCount: 0,
  positionsMargin: 0,
  hasMissingMargin: false,
  totalSwap: 0,
  totalCommission: 0,
  staticProfitSum: 0,
  staticMissingProfitCount: 0,
  staticProfitable: 0,
  staticLosing: 0,
  symbols: [],
  heldSymbols: new Set(),
  bySymbol: new Map(),
});

const readFallbackRounded = (pos: any): number | null => {
  if (pos.hasBackendProfit === false) return null;
  return toBackendFinancialNumber(pos.profit ?? pos.unrealizedPnL ?? pos.unrealized_pl);
};

/** True when the symbol's live quote can be used for the aggregate (valid bid and ask). */
const usableQuote = (symbol: string) => {
  const q = getLiveQuote(symbol);
  return q && q.bid > 0 && q.ask > 0 ? q : null;
};

export const computeLiveAccountMetricsFromAggregates = (
  metrics: TradeAccountMetricResolution,
  agg: PositionAggregates,
): TradeAccountMetricResolution => {
  if (agg.totalCount === 0) {
    return metrics.floatingPnL === null
      ? metrics
      : { ...metrics, floatingPnL: 0, unrealizedPL: 0 };
  }

  let positionsMargin = metrics.marginUnavailable || agg.hasMissingMargin ? null : agg.positionsMargin;
  if (positionsMargin !== null && !Number.isFinite(positionsMargin)) {
    positionsMargin = null;
  }

  const margin = metrics.margin !== null && metrics.margin > 0
    ? metrics.margin
    : positionsMargin !== null && positionsMargin > 0
      ? positionsMargin
      : (metrics.margin ?? positionsMargin);

  if (metrics.balance === null) {
    return margin !== metrics.margin ? { ...metrics, margin } : metrics;
  }

  let floatingPnL = agg.totalSwap + agg.staticProfitSum;
  let allProfitsAvailable = agg.staticMissingProfitCount === 0;

  if (allProfitsAvailable) {
    for (const symAgg of agg.bySymbol.values()) {
      if (symAgg.conversion === 'static') continue;
      const q = usableQuote(symAgg.symbol);
      if (q) {
        if (symAgg.conversion === 'quote_usd') {
          floatingPnL += (symAgg.buyUnits * q.bid - symAgg.buyWeightedOpen)
            + (symAgg.sellWeightedOpen - symAgg.sellUnits * q.ask);
        } else {
          floatingPnL += (symAgg.buyUnits - symAgg.buyWeightedOpen / q.bid)
            + (symAgg.sellWeightedOpen / q.ask - symAgg.sellUnits);
        }
      } else {
        if (symAgg.buyFallbackMissing > 0 || symAgg.sellFallbackMissing > 0) {
          allProfitsAvailable = false;
          break;
        }
        floatingPnL += symAgg.buyFallbackProfit + symAgg.sellFallbackProfit;
      }
    }
  }

  if (!allProfitsAvailable || !Number.isFinite(floatingPnL)) {
    if (positionsMargin === null) return metrics;
    const equity = metrics.equity;
    const freeMargin = equity === null || margin === null ? metrics.freeMargin : equity - margin;
    const marginLevel = equity === null || margin === null
      ? metrics.marginLevel
      : margin <= 0
        ? (metrics.marginLevel !== null && metrics.marginLevel > 0 ? metrics.marginLevel : null)
        : (equity / margin) * 100;
    return {
      ...metrics,
      margin,
      freeMargin,
      marginLevel,
      freeMarginSource: freeMargin === null ? 'unavailable' : 'backend',
      marginLevelSource: marginLevel === null ? 'unavailable' : 'backend',
      warnings: metrics.warnings.filter((warning) => (
        (freeMargin === null || warning !== 'missing_backend_free_margin')
        && (marginLevel === null || warning !== 'missing_backend_margin_level')
      )),
    };
  }

  const liveEquity = metrics.balance + (metrics.credit ?? 0) + floatingPnL;
  const hasBackendPositionTotals = positionsMargin !== null;
  const equity = metrics.equity === null && !hasBackendPositionTotals ? null : liveEquity;
  const freeMargin = (metrics.freeMargin === null && !hasBackendPositionTotals) || margin === null
    ? metrics.freeMargin
    : liveEquity - margin;
  const marginLevel = (metrics.marginLevel === null && !hasBackendPositionTotals) || margin === null
    ? metrics.marginLevel
    : margin <= 0
      ? (metrics.marginLevel !== null && metrics.marginLevel > 0 ? metrics.marginLevel : null)
      : (liveEquity / margin) * 100;
  const livePnL = metrics.floatingPnL === null && !hasBackendPositionTotals ? null : floatingPnL;
  const warnings = hasBackendPositionTotals
    ? metrics.warnings.filter((warning) => (
      (equity === null || warning !== 'missing_backend_equity')
      && (freeMargin === null || warning !== 'missing_backend_free_margin')
      && (marginLevel === null || warning !== 'missing_backend_margin_level')
    ))
    : metrics.warnings;

  return {
    ...metrics,
    margin,
    equity,
    freeMargin,
    marginLevel,
    floatingPnL: livePnL,
    unrealizedPL: livePnL,
    equitySource: equity === null ? 'unavailable' : 'backend',
    freeMarginSource: freeMargin === null ? 'unavailable' : 'backend',
    marginLevelSource: marginLevel === null ? 'unavailable' : 'backend',
    warnings,
  };
};

// Binary-search helpers on ascending Float64Array.
const upperBound = (arr: Float64Array, x: number): number => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const lowerBound = (arr: Float64Array, x: number): number => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

interface SideSortedIndex {
  opens: Float64Array;
  units: Float64Array;
  minUnit: number;
}

interface SymbolSortedIndex {
  symbol: string;
  conversion: SymbolConversionMode;
  buy: SideSortedIndex | null;
  sell: SideSortedIndex | null;
  fallbackProfitable: number;
  fallbackLosing: number;
}

const buildSideIndexFromPairs = (opens: number[], units: number[]): SideSortedIndex | null => {
  const len = opens.length;
  if (len === 0) return null;
  const order = new Int32Array(len);
  for (let i = 0; i < len; i += 1) order[i] = i;
  order.sort((a, b) => opens[a] - opens[b]);
  const sOpens = new Float64Array(len);
  const sUnits = new Float64Array(len);
  let minUnit = Number.POSITIVE_INFINITY;
  for (let i = 0; i < len; i += 1) {
    const idx = order[i];
    sOpens[i] = opens[idx];
    const u = units[idx];
    sUnits[i] = u;
    if (u < minUnit) minUnit = u;
  }
  return { opens: sOpens, units: sUnits, minUnit };
};

const countSymbolBulkClose = (entry: SymbolSortedIndex): { profitable: number; losing: number } => {
  if (entry.conversion === 'static') {
    return { profitable: entry.fallbackProfitable, losing: entry.fallbackLosing };
  }
  const q = usableQuote(entry.symbol);
  if (!q) {
    return { profitable: entry.fallbackProfitable, losing: entry.fallbackLosing };
  }
  const isBaseUsd = entry.conversion === 'base_usd';
  let profitable = 0;
  let losing = 0;

  if (entry.buy && entry.buy.minUnit > 0) {
    const b = entry.buy;
    const denom = isBaseUsd ? q.bid : 1;
    const eps = (0.005 * denom) / b.minUnit;
    const bProfEnd = upperBound(b.opens, q.bid - eps - 1e-12);
    const bLossStart = upperBound(b.opens, q.bid + eps + 1e-12);
    profitable += bProfEnd;
    losing += b.opens.length - bLossStart;
    for (let k = bProfEnd; k < bLossStart; k += 1) {
      const r = Math.round((((q.bid - b.opens[k]) * b.units[k]) / denom) * 100) / 100;
      if (r > 0) profitable += 1;
      else if (r < 0) losing += 1;
    }
  }

  if (entry.sell && entry.sell.minUnit > 0) {
    const s = entry.sell;
    const denom = isBaseUsd ? q.ask : 1;
    const eps = (0.005 * denom) / s.minUnit;
    const sLossEnd = lowerBound(s.opens, q.ask - eps - 1e-12);
    const sProfStart = lowerBound(s.opens, q.ask + eps + 1e-12);
    losing += sLossEnd;
    profitable += s.opens.length - sProfStart;
    for (let k = sLossEnd; k < sProfStart; k += 1) {
      const r = Math.round((((s.opens[k] - q.ask) * s.units[k]) / denom) * 100) / 100;
      if (r > 0) profitable += 1;
      else if (r < 0) losing += 1;
    }
  }

  return { profitable, losing };
};

const arrayAggCache = new WeakMap<object, PositionAggregates>();
const arraySortedIndexCache = new WeakMap<object, SymbolSortedIndex[]>();

export const getPositionAggregatesForArray = (positions: readonly any[]): PositionAggregates => {
  const cached = arrayAggCache.get(positions);
  if (cached) return cached;

  const agg = createEmptyAggregates();
  agg.totalCount = positions.length;
  let marginSum = 0;
  let missingMargin = false;
  let swapSum = 0;
  let commSum = 0;

  for (let i = 0; i < positions.length; i += 1) {
    const pos = positions[i];
    if (!pos) continue;
    const sym = String(pos.symbol ?? '').trim().toUpperCase();
    const openPrice = Number(pos.price_open ?? pos.open_price ?? pos.openPrice ?? 0);
    const volume = Math.abs(Number(pos.volume ?? pos.quantity ?? 0));
    const curPrice = Number(pos.price_current ?? pos.current_price ?? pos.currentPrice ?? 0);
    const explicitCs = toBackendFinancialNumber(pos.contractSize ?? pos.contract_size);
    const contractSize = explicitCs ?? getExposureContractSize(pos);
    const lotDivRaw = Number(pos.lot_divisor ?? pos.lotDivisor ?? 1);
    const lotDivisor = Number.isFinite(lotDivRaw) && lotDivRaw > 0 ? lotDivRaw : 1;
    const isSell = String(pos.side ?? '').toUpperCase() === 'SELL';
    const posMargin = pos.hasBackendMargin === false || pos.margin_available === false
      ? null
      : toBackendFinancialNumber(pos.margin ?? pos.used_margin);

    if (posMargin === null || !(posMargin >= 0)) {
      missingMargin = true;
    } else {
      marginSum += posMargin;
    }
    swapSum += Number(pos.swap ?? pos.storage ?? 0) || 0;
    commSum += Number(pos.commission ?? 0) || 0;

    const resolvedFallback = resolveTradeProfit(pos as TradeProfitInput).value;
    const roundedFallback = readFallbackRounded(pos) ?? resolvedFallback;
    const conv = getSymbolConversion(sym);

    let sAgg = sym ? agg.bySymbol.get(sym) : undefined;
    if (sym && !sAgg) {
      sAgg = createEmptySymbolAggregate(sym);
      agg.bySymbol.set(sym, sAgg);
      agg.heldSymbols.add(sym);
      agg.symbols.push(sym);
    }

    if (sAgg && conv.mode !== 'static' && openPrice > 0 && volume > 0 && contractSize && contractSize > 0) {
      const u = (volume * contractSize) / lotDivisor;
      const baseU = volume * contractSize;
      if (roundedFallback !== null) {
        if (roundedFallback > 0) sAgg.fallbackProfitable += 1;
        else if (roundedFallback < 0) sAgg.fallbackLosing += 1;
      }
      if (isSell) {
        sAgg.sellCount += 1;
        sAgg.sellUnits += u;
        sAgg.sellWeightedOpen += u * openPrice;
        sAgg.sellBaseUnits += baseU;
        if (curPrice > 0) sAgg.fallbackAsk = curPrice;
        if (resolvedFallback === null) sAgg.sellFallbackMissing += 1;
        else sAgg.sellFallbackProfit += resolvedFallback;
      } else {
        sAgg.buyCount += 1;
        sAgg.buyUnits += u;
        sAgg.buyWeightedOpen += u * openPrice;
        sAgg.buyBaseUnits += baseU;
        if (curPrice > 0) sAgg.fallbackBid = curPrice;
        if (resolvedFallback === null) sAgg.buyFallbackMissing += 1;
        else sAgg.buyFallbackProfit += resolvedFallback;
      }
      if (curPrice > 0) sAgg.fallbackLastRate = curPrice;
    } else {
      if (resolvedFallback === null) {
        agg.staticMissingProfitCount += 1;
      } else {
        agg.staticProfitSum += resolvedFallback;
      }
      if (roundedFallback !== null) {
        if (roundedFallback > 0) agg.staticProfitable += 1;
        else if (roundedFallback < 0) agg.staticLosing += 1;
      }
    }
  }

  agg.hasMissingMargin = missingMargin;
  agg.positionsMargin = missingMargin ? null : marginSum;
  agg.totalSwap = swapSum;
  agg.totalCommission = commSum;
  arrayAggCache.set(positions, agg);
  return agg;
};

const getSortedIndexForArray = (positions: readonly any[]): SymbolSortedIndex[] => {
  const cached = arraySortedIndexCache.get(positions);
  if (cached) return cached;

  const bySym = new Map<string, {
    conversion: SymbolConversionMode;
    buyOpens: number[];
    buyUnits: number[];
    sellOpens: number[];
    sellUnits: number[];
    fbProf: number;
    fbLoss: number;
  }>();

  for (let i = 0; i < positions.length; i += 1) {
    const pos = positions[i];
    if (!pos) continue;
    const sym = String(pos.symbol ?? '').trim().toUpperCase();
    if (!sym) continue;
    let bucket = bySym.get(sym);
    if (!bucket) {
      bucket = {
        conversion: getSymbolConversion(sym).mode,
        buyOpens: [],
        buyUnits: [],
        sellOpens: [],
        sellUnits: [],
        fbProf: 0,
        fbLoss: 0,
      };
      bySym.set(sym, bucket);
    }
    if (bucket.conversion !== 'static') {
      const openPrice = Number(pos.price_open ?? pos.open_price ?? pos.openPrice ?? 0);
      const volume = Math.abs(Number(pos.volume ?? pos.quantity ?? 0));
      const explicitCs = toBackendFinancialNumber(pos.contractSize ?? pos.contract_size);
      const contractSize = explicitCs ?? getExposureContractSize(pos);
      const lotDivRaw = Number(pos.lot_divisor ?? pos.lotDivisor ?? 1);
      const lotDivisor = Number.isFinite(lotDivRaw) && lotDivRaw > 0 ? lotDivRaw : 1;
      if (openPrice > 0 && volume > 0 && contractSize && contractSize > 0) {
        // Fallback counts only for positions that are in this live index; positions that
        // cannot be priced live are counted once, as static, by getPositionAggregatesForArray.
        // Same fallback rule as the aggregate (rounded backend profit, else resolved profit).
        const fb = readFallbackRounded(pos) ?? resolveTradeProfit(pos as TradeProfitInput).value;
        if (fb !== null) {
          if (fb > 0) bucket.fbProf += 1;
          else if (fb < 0) bucket.fbLoss += 1;
        }
        const u = (volume * contractSize) / lotDivisor;
        if (String(pos.side ?? '').toUpperCase() === 'SELL') {
          bucket.sellOpens.push(openPrice);
          bucket.sellUnits.push(u);
        } else {
          bucket.buyOpens.push(openPrice);
          bucket.buyUnits.push(u);
        }
      }
    }
  }

  const out: SymbolSortedIndex[] = [];
  for (const [symbol, bucket] of bySym) {
    if (bucket.conversion === 'static') continue;
    out.push({
      symbol,
      conversion: bucket.conversion,
      buy: buildSideIndexFromPairs(bucket.buyOpens, bucket.buyUnits),
      sell: buildSideIndexFromPairs(bucket.sellOpens, bucket.sellUnits),
      fallbackProfitable: bucket.fbProf,
      fallbackLosing: bucket.fbLoss,
    });
  }
  arraySortedIndexCache.set(positions, out);
  return out;
};

export const getLiveBulkCloseCounts = (
  source: readonly any[] | null | undefined,
): { all: number; profitable: number; losing: number } => {
  if (!source || source.length === 0) return { all: 0, profitable: 0, losing: 0 };
  const agg = getPositionAggregatesForArray(source);
  const entries = getSortedIndexForArray(source);
  let profitable = agg.staticProfitable;
  let losing = agg.staticLosing;
  for (let i = 0; i < entries.length; i += 1) {
    const res = countSymbolBulkClose(entries[i]);
    profitable += res.profitable;
    losing += res.losing;
  }
  return { all: source.length, profitable, losing };
};

const noopSubscribe = () => () => {};
const zeroSnapshot = () => 0;

export const useLiveBulkCloseCounts = (
  source: readonly any[] | null | undefined,
): { all: number; profitable: number; losing: number } => {
  const active = Boolean(source && source.length > 0);
  useSyncExternalStore(
    active ? subscribeLiveQuotes : noopSubscribe,
    active ? getLiveQuotesVersion : zeroSnapshot,
    zeroSnapshot,
  );
  return getLiveBulkCloseCounts(source);
};

export const buildExposureSummaryFromAggregates = (
  agg: PositionAggregates,
  account?: ExposureAccountInput | null,
): ExposureSummary => {
  // O(numSymbols) exposure summary from the per-symbol aggregates.
  const synthPositions: any[] = [];
  for (const symAgg of agg.bySymbol.values()) {
    const parsed = parseExposureSymbol(symAgg.symbol);
    if (!parsed) continue;
    const q = usableQuote(symAgg.symbol);
    if (symAgg.buyBaseUnits > 0) {
      const rate = q ? q.bid : (symAgg.fallbackBid || symAgg.fallbackLastRate || 1);
      if (rate > 0) {
        synthPositions.push({
          symbol: symAgg.symbol,
          side: 'BUY',
          volume: symAgg.buyBaseUnits,
          contractSize: 1,
          currentPrice: rate,
          price_current: rate,
          current_price: rate,
        });
      }
    }
    if (symAgg.sellBaseUnits > 0) {
      const rate = q ? q.ask : (symAgg.fallbackAsk || symAgg.fallbackLastRate || 1);
      if (rate > 0) {
        synthPositions.push({
          symbol: symAgg.symbol,
          side: 'SELL',
          volume: symAgg.sellBaseUnits,
          contractSize: 1,
          currentPrice: rate,
          price_current: rate,
          current_price: rate,
        });
      }
    }
  }
  return buildExposureSummary(synthPositions, account);
};

export const getLiveSymbolPnLFromSource = (
  source: readonly any[],
  symbol: string,
): { count: number; totalPnL: number } => {
  const upper = String(symbol ?? '').trim().toUpperCase();
  if (!upper) return { count: 0, totalPnL: 0 };
  let count = 0;
  let totalPnL = 0;
  for (let i = 0; i < source.length; i += 1) {
    const p = source[i];
    if (String(p?.symbol ?? '').trim().toUpperCase() !== upper) continue;
    count += 1;
    totalPnL += getLivePositionProfit(p) ?? (Number(p?.unrealizedPnL ?? p?.profit ?? 0) || 0);
  }
  return { count, totalPnL };
};
