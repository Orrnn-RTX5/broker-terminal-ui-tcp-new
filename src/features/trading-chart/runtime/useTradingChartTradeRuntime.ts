import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import type { TradingChartVisibleRuntime } from '../../../hooks/useTradingChartVisibleRuntime';
import { useAppStore } from '../../../store/useAppStore';
import { drawingManager } from '../../../services/drawingManager';
import { requestChartTradeOverlayRefresh } from '../../../services/tradeOverlayRefreshEvents';
import { getTimeframeSeconds, type Timeframe as AggTimeframe } from '../../../services/candleAggregationService';
import type { ChartProperties } from '../../../store/useChartSettingsStore';
import { refreshChartUiTranslations } from '../../../utils/chartTradeControls';
import { getTradeHistoryMarkerPrice } from '../../../utils/chartTradeHistoryPresentation';
import {
  resolveNearestTradeOverlayCandleTime,
  resolveTradeOverlaySegmentGeometry,
} from '../../../services/tradeOverlayHistory';
import type {
  Candle,
  LivePriceOverlayColors,
  Timeframe,
  TradingViewChartTheme,
} from '../../../types/chart';
import type {
  ChartPostInteractionCallbacks,
  ChartPostInteractionCoordinator,
} from '../../../utils/chartPostInteractionCoordinator';
import {
  buildTradeHistoryLineCandleMask,
  getTradePlotClipLayer,
  layoutTradeControls,
  placeTradeMarkerTooltip,
  TRADE_LEVEL_OVERRIDES_STORAGE_KEY,
  TRADE_MARKER_TIP_OFFSET_PX,
  tradeMarkerTooltipLayouts,
  type TradeHistoryCandleSubRect,
  type TradeSide,
} from '../presentation/tradeOverlayPresentation';
import { useTradingChartTradeLevelDrag } from './useTradingChartTradeLevelDrag';
import { useTradingChartTradeOverlayRenderer } from './useTradingChartTradeOverlayRenderer';
import { readStoredTradeLevelOverrides } from './tradeLevelOverrideStorage';
import { readTradeControlSize, rememberTradeControlResize, type TradeControlSizeCache } from './tradeControlSizeCache';
import {
  readTradeOverlayContainerSize,
  rememberTradeOverlayContainerResize,
  type TradeOverlayContainerSizeCache,
} from './tradeOverlayContainerSizeCache';
import type {
  ActiveTradeSnapshot,
  ClosedTradeSnapshot,
  OverlayNodeData,
  TradeLevelModifyRequestId,
  TradeLevelOverride,
  TradeOverlayLayer,
  TradePositionRecord,
} from './tradeRuntimeContracts';

export type { ActiveTradeSnapshot } from './tradeRuntimeContracts';

interface UseTradingChartTradeRuntimeOptions {
  activeChartSourceId: string;
  activeToolRef: RefObject<string | null>;
  activeTradeSnapshotsRef: RefObject<Map<string, ActiveTradeSnapshot>>;
  applyLivePriceHorizontalGeometry: (measuredScaleWidth: number) => void;
  brokerAccountSessionScope: string;
  brokerTimeOffsetSec: number;
  candlesLoadedRev: number;
  candlesRef: RefObject<Candle[]>;
  chartRef: RefObject<IChartApi | null>;
  chartSettingsRef: RefObject<ChartProperties>;
  chartThemeRef: RefObject<TradingViewChartTheme>;
  containerRef: RefObject<HTMLDivElement | null>;
  currentCandleRef: RefObject<Candle | null>;
  drawingRuntimeContextRef: RefObject<{
    contextId: string;
    accountScope?: string;
    symbol: string;
    timeframe: Timeframe;
  }>;
  getDrawingSeriesData: () => Candle[];
  hideLivePriceOverlay: (clearPrice?: boolean) => void;
  isActive: boolean;
  isActiveRef: RefObject<boolean>;
  isChartInteractionActiveRef: RefObject<boolean>;
  isChartSurfaceLight: () => boolean;
  isDisposedRef: RefObject<boolean>;
  isLivePriceSafeForCandles: (price: number) => boolean;
  lastRenderedCandlesRef: RefObject<Candle[]>;
  livePriceBadgeRef: RefObject<HTMLDivElement | null>;
  livePriceLineRef: RefObject<HTMLDivElement | null>;
  livePriceOverlayColorsRef: RefObject<LivePriceOverlayColors>;
  livePriceRef: RefObject<number | null>;
  overlayRef: RefObject<HTMLDivElement | null>;
  postInteractionCallbacksRef: RefObject<ChartPostInteractionCallbacks>;
  postInteractionCoordinatorRef: RefObject<ChartPostInteractionCoordinator | null>;
  prevSymbolRef: RefObject<string>;
  prevTimeframeRef: RefObject<Timeframe>;
  repaintTradeOverlayGeometryRef: RefObject<() => void>;
  resolvedPriceDigits: number | null;
  resolvedPriceDigitsRef: RefObject<number | null>;
  seriesRef: RefObject<ISeriesApi<SeriesType> | null>;
  symbol: string;
  timeframe: Timeframe;
  tr: <T>(source: T, values?: Record<string, unknown>) => T;
  tradeAllowed: boolean;
  tradeLevelCrossRefreshPendingRef: RefObject<Set<string>>;
  visibleRuntime: TradingChartVisibleRuntime;
}

// First N entries of the history layout key describe the viewport; the rest the live candle OHLC.
const HISTORY_VIEWPORT_KEY_LENGTH = 14;

export const useTradingChartTradeRuntime = ({
  activeChartSourceId,
  activeToolRef,
  activeTradeSnapshotsRef,
  applyLivePriceHorizontalGeometry,
  brokerAccountSessionScope,
  brokerTimeOffsetSec,
  candlesLoadedRev,
  candlesRef,
  chartRef,
  chartSettingsRef,
  chartThemeRef,
  containerRef,
  currentCandleRef,
  drawingRuntimeContextRef,
  getDrawingSeriesData,
  hideLivePriceOverlay,
  isActive,
  isActiveRef,
  isChartInteractionActiveRef,
  isChartSurfaceLight,
  isDisposedRef,
  isLivePriceSafeForCandles,
  lastRenderedCandlesRef,
  livePriceBadgeRef,
  livePriceLineRef,
  livePriceOverlayColorsRef,
  livePriceRef,
  overlayRef,
  postInteractionCallbacksRef,
  postInteractionCoordinatorRef,
  prevSymbolRef,
  prevTimeframeRef,
  repaintTradeOverlayGeometryRef,
  resolvedPriceDigits,
  resolvedPriceDigitsRef,
  seriesRef,
  symbol,
  timeframe,
  tr,
  tradeAllowed,
  tradeLevelCrossRefreshPendingRef,
  visibleRuntime,
}: UseTradingChartTradeRuntimeOptions): void => {


  // ─── Trade Annotations on Chart (MT5-style entry/exit markers + live trails) ───
  const activeOverlayNodesRef = useRef<HTMLElement[]>([]);


  const activeOverlayNodeDataRef = useRef<OverlayNodeData[]>([]);


  const historyOverlayNodesRef = useRef<HTMLElement[]>([]);


  const historyOverlayNodeDataRef = useRef<OverlayNodeData[]>([]);


  // Live Pips/USD refresh hooks for the on-line position control bars.
  const tradeControlLiveUpdatersRef = useRef<Array<(positionsByTicket?: ReadonlyMap<number, TradePositionRecord>) => void>>([]);
  const tradeControlSizesRef = useRef<TradeControlSizeCache>(new WeakMap());
  const tradeOverlayContainerSizesRef = useRef<TradeOverlayContainerSizeCache>(new WeakMap());
  const tradeControlSizeObservationRef = useRef(false);


  const frozenEntryTimesRef = useRef<Map<number | string, number>>(new Map());


  const stableActiveMarkerTimesRef = useRef<Map<number | string, number>>(new Map());


  const frozenEntryPricesRef = useRef<Map<number | string, number>>(new Map());




  const pendingMissingActiveTradesRef = useRef<Map<string, { trade: ActiveTradeSnapshot; missingSince: number }>>(new Map());


  const closeSuppressedTradeKeysRef = useRef<Map<string, number>>(new Map());


  const pendingClosedTradeSnapshotsRef = useRef<Map<string, ActiveTradeSnapshot>>(new Map());


  const optimisticClosedTradeSnapshotsRef = useRef<Map<string, ClosedTradeSnapshot>>(new Map());


  const tradeHistoryRefreshTimerRef = useRef<number | null>(null);


  const tradeMissingGraceTimerRef = useRef<number | null>(null);


  const tradeOverlayRafRef = useRef<number | null>(null);






  const tradeLevelOverridesRef = useRef<Map<string, TradeLevelOverride>>(new Map());


  const tradeLevelLastKnownLevelsRef = useRef<Map<string, TradeLevelOverride>>(new Map());


  const tradeLevelModifyRequestSeqRef = useRef<TradeLevelModifyRequestId>(0);


  const pendingTradeLevelModifyRequestsRef = useRef<Map<string, TradeLevelModifyRequestId>>(new Map());


  const tradeLevelOptimisticGraceUntilRef = useRef<Map<string, number>>(new Map());


  const tradeLevelOverridesHydratedRef = useRef(false);


  const lastActiveTradeOverlaySignatureRef = useRef('');


  const lastHistoryTradeOverlaySignatureRef = useRef('');
  // Viewport + candle fingerprint of the last history layout pass (null = lay out everything).
  const historyViewportKeyRef = useRef<number[] | null>(null);







  const clearFrozenEntryTime = (tradeKey: number | string) => {
    const directKey = String(tradeKey);
    const scopedPrefix = `${directKey}::`;
    frozenEntryTimesRef.current.delete(tradeKey);
    frozenEntryTimesRef.current.delete(directKey);
    Array.from(frozenEntryTimesRef.current.keys()).forEach((key) => {
      if (String(key).startsWith(scopedPrefix)) {
        frozenEntryTimesRef.current.delete(key);
      }
    });
  };



  const clearStableActiveMarkerTime = (tradeKey: number | string) => {
    const directKey = String(tradeKey);
    const markerKey = `${directKey}:marker`;
    const scopedPrefix = `${markerKey}::`;
    stableActiveMarkerTimesRef.current.delete(tradeKey);
    stableActiveMarkerTimesRef.current.delete(directKey);
    stableActiveMarkerTimesRef.current.delete(markerKey);
    Array.from(stableActiveMarkerTimesRef.current.keys()).forEach((key) => {
      if (String(key).startsWith(scopedPrefix)) {
        stableActiveMarkerTimesRef.current.delete(key);
      }
    });
  };



  const hydrateTradeLevelOverrides = useCallback(() => {
    if (tradeLevelOverridesHydratedRef.current || typeof window === 'undefined') return;
    tradeLevelOverridesHydratedRef.current = true;

    try {
      readStoredTradeLevelOverrides(window.localStorage).forEach((levels, key) => {
        tradeLevelOverridesRef.current.set(key, levels);
      });
    } catch {
      // Ignore malformed local optimistic state.
    }
  }, []);



  const persistTradeLevelOverrides = useCallback(() => {
    if (typeof window === 'undefined') return;

    try {
      const savedAt = Date.now();
      const rows = Array.from(tradeLevelOverridesRef.current.entries())
        .filter(([key, levels]) => key.startsWith('trade:') && ((levels.sl || 0) > 0 || (levels.tp || 0) > 0))
        .map(([key, levels]) => ({
          key,
          sl: levels.sl || 0,
          tp: levels.tp || 0,
          savedAt,
        }));

      if (rows.length === 0) {
        window.localStorage.removeItem(TRADE_LEVEL_OVERRIDES_STORAGE_KEY);
      } else {
        window.localStorage.setItem(TRADE_LEVEL_OVERRIDES_STORAGE_KEY, JSON.stringify(rows));
      }
    } catch {
      // Local persistence is best-effort only.
    }
  }, []);



  const clearTradeOverlayLayer = useCallback((layer: TradeOverlayLayer) => {
    const nodesRef = layer === 'active' ? activeOverlayNodesRef : historyOverlayNodesRef;
    const dataRef = layer === 'active' ? activeOverlayNodeDataRef : historyOverlayNodeDataRef;

    for (const node of nodesRef.current) {
      try {
        node.remove();
      } catch {
        // Ignore detached nodes.
      }
    }
    const overlayHost = overlayRef.current?.parentElement ?? overlayRef.current;
    const staleSelector = layer === 'active'
      ? '.rtx-trade-marker--active,.rtx-trade-active-segment,.rtx-trade-level-line,.rtx-trade-level-badge,.rtx-trade-level-hit-area,.rtx-trade-axis-price-badge,.rtx-trade-overflow,.rtx-trade-control-leader'
      : '.rtx-trade-marker--history,.rtx-trade-marker-hover-target,.rtx-trade-history-line';
    overlayHost?.querySelectorAll(staleSelector).forEach((node) => {
      try {
        node.remove();
      } catch {
        // Ignore detached nodes.
      }
    });
    nodesRef.current = [];
    dataRef.current = [];
    if (layer === 'active') {
      lastActiveTradeOverlaySignatureRef.current = '';
      tradeControlLiveUpdatersRef.current = [];
    } else {
      lastHistoryTradeOverlaySignatureRef.current = '';
      historyViewportKeyRef.current = null;
    }
  }, [overlayRef]);



  const clearTradeOverlay = useCallback(() => {
    clearTradeOverlayLayer('active');
    clearTradeOverlayLayer('history');
  }, [clearTradeOverlayLayer]);



  const clearTradeOverlayVisualRuntime = useCallback(() => {
    if (tradeHistoryRefreshTimerRef.current !== null) {
      window.clearTimeout(tradeHistoryRefreshTimerRef.current);
      tradeHistoryRefreshTimerRef.current = null;
    }
    if (tradeMissingGraceTimerRef.current !== null) {
      window.clearTimeout(tradeMissingGraceTimerRef.current);
      tradeMissingGraceTimerRef.current = null;
    }
    if (tradeOverlayRafRef.current !== null) {
      window.cancelAnimationFrame(tradeOverlayRafRef.current);
      tradeOverlayRafRef.current = null;
    }
    clearTradeOverlay();
  }, [clearTradeOverlay]);



  const getNearestCandleByTime = useCallback((time: number, maxDistanceSeconds?: number): Candle | null => {
    const candles = candlesRef.current;
    const nearestTime = resolveNearestTradeOverlayCandleTime(
      time,
      candles,
      currentCandleRef.current,
      maxDistanceSeconds,
    );
    if (nearestTime == null) return null;

    if (currentCandleRef.current?.time === nearestTime) {
      return currentCandleRef.current;
    }

    return candles.find((candle) => candle.time === nearestTime) ?? null;
  }, [candlesRef, currentCandleRef]);



  useEffect(() => {
    activeTradeSnapshotsRef.current.clear();
    pendingMissingActiveTradesRef.current.clear();
    closeSuppressedTradeKeysRef.current.clear();
    pendingClosedTradeSnapshotsRef.current.clear();
    optimisticClosedTradeSnapshotsRef.current.clear();
    frozenEntryTimesRef.current.clear();
    stableActiveMarkerTimesRef.current.clear();
    frozenEntryPricesRef.current.clear();
    tradeLevelLastKnownLevelsRef.current.clear();
    pendingTradeLevelModifyRequestsRef.current.clear();
    tradeLevelOptimisticGraceUntilRef.current.clear();
    clearTradeOverlay();

    if (tradeHistoryRefreshTimerRef.current !== null) {
      window.clearTimeout(tradeHistoryRefreshTimerRef.current);
      tradeHistoryRefreshTimerRef.current = null;
    }
    if (tradeMissingGraceTimerRef.current !== null) {
      window.clearTimeout(tradeMissingGraceTimerRef.current);
      tradeMissingGraceTimerRef.current = null;
    }

    window.dispatchEvent(new Event('rtx:force-refresh-positions'));
  }, [
    activeTradeSnapshotsRef,
    clearTradeOverlay,
    symbol,
  ]);



  const updateLabelPositions = useCallback((refreshMetrics = true) => {
    if (!seriesRef.current || !chartRef.current) return;

    const series = seriesRef.current;
    const chart = chartRef.current;
    const overlayLayers = [
      { nodes: historyOverlayNodesRef.current, data: historyOverlayNodeDataRef.current, isHistory: true },
      { nodes: activeOverlayNodesRef.current, data: activeOverlayNodeDataRef.current, isHistory: false },
    ];
    const { width: chartWidth, height: chartHeight } = readTradeOverlayContainerSize(
      tradeOverlayContainerSizesRef.current, containerRef.current, tradeControlSizeObservationRef.current,
    );
    // A collapsed/zero-size container has no valid geometry; leave nodes as
    // they are rather than culling the entire overlay against height 0.
    if (chartWidth <= 0 || chartHeight <= 0) return;
    const priceScaleWidth = series.priceScale().width();
    const timeScaleHeight = chart.timeScale().height();
    const plotHeight = Math.max(0, chartHeight - (Number.isFinite(timeScaleHeight) ? timeScaleHeight : 0));
    const overlayHost = overlayRef.current;
    const controlNodes = new Map<string, { element: HTMLElement; anchorY: number }>();
    for (const host of [overlayHost, overlayHost?.parentElement]) {
      if (!host) continue;
      const clipLayer = getTradePlotClipLayer(host);
      clipLayer.style.right = `${Math.max(0, priceScaleWidth)}px`;
      clipLayer.style.bottom = `${Math.max(0, chartHeight - plotHeight)}px`;
    }
    const snapCssPixel = (value: number): number => Math.round(value);
    const resolveTimeCoordinate = (time: unknown): number | null => {
      const numericTime = Number(time);
      if (!Number.isFinite(numericTime) || numericTime <= 0) return null;

      const directCoordinate = chart.timeScale().timeToCoordinate(numericTime as Time);
      if (directCoordinate != null) return directCoordinate;

      const activeTf = prevTimeframeRef.current || timeframe;
      const timeframeSeconds = getTimeframeSeconds(activeTf as AggTimeframe);
      const firstCandleTime = candlesRef.current[0]?.time ?? currentCandleRef.current?.time ?? null;
      const maxDistance = firstCandleTime != null && numericTime >= firstCandleTime
        ? undefined
        : (Number.isFinite(timeframeSeconds) && timeframeSeconds > 0 ? timeframeSeconds : undefined);
      const nearest = getNearestCandleByTime(numericTime, maxDistance);
      if (!nearest?.time) return null;

      return chart.timeScale().timeToCoordinate(nearest.time as Time);
    };
    // Candle lookup for execution arrows: hydrated once per layout pass, only
    // when a candle-anchored marker actually needs it.
    const tradeMarkerCandles = new Map<number, Candle>();
    let tradeMarkerCandlesHydrated = false;
    const resolveTradeMarkerAnchorPrice = (node: OverlayNodeData): number => {
      if (node.markerAnchor !== 'candle' || !node.markerSide || node.price == null) {
        return node.price ?? 0;
      }
      if (!tradeMarkerCandlesHydrated) {
        tradeMarkerCandlesHydrated = true;
        for (const candle of candlesRef.current) tradeMarkerCandles.set(candle.time, candle);
        const liveCandle = currentCandleRef.current;
        if (liveCandle) tradeMarkerCandles.set(liveCandle.time, liveCandle);
      }
      let markerTime = Number(node.time);
      if (!tradeMarkerCandles.has(markerTime) && node.resolveTime) {
        const resolvedTime = Number(node.resolveTime());
        if (Number.isFinite(resolvedTime) && resolvedTime > 0) {
          markerTime = resolvedTime;
        }
      }
      if (!tradeMarkerCandles.has(markerTime)) {
        const activeTf = prevTimeframeRef.current || timeframe;
        const timeframeSeconds = getTimeframeSeconds(activeTf as AggTimeframe);
        const firstCandleTime = candlesRef.current[0]?.time ?? currentCandleRef.current?.time ?? null;
        const maxDistance = firstCandleTime != null && markerTime >= firstCandleTime
          ? undefined
          : (Number.isFinite(timeframeSeconds) && timeframeSeconds > 0 ? timeframeSeconds : undefined);
        const fallbackTime = getNearestCandleByTime(markerTime, maxDistance)?.time;
        if (fallbackTime != null) {
          markerTime = fallbackTime;
        }
      }
      return getTradeHistoryMarkerPrice(node.markerSide, node.price, tradeMarkerCandles.get(markerTime));
    };

    const candleBodyRectCache = new Map<number, TradeHistoryCandleSubRect | null>();
    let cachedHalfBodyWidth: number | null = null;
    const resolveHalfBodyWidth = (sampleIndex: number): number => {
      if (cachedHalfBodyWidth != null) return cachedHalfBodyWidth;
      const candles = candlesRef.current;
      let barSpacing = 0;
      const idxA = Math.max(0, Math.min(sampleIndex, candles.length - 2));
      if (idxA >= 0 && idxA + 1 < candles.length) {
        const cxA = chart.timeScale().timeToCoordinate(candles[idxA].time as Time);
        const cxB = chart.timeScale().timeToCoordinate(candles[idxA + 1].time as Time);
        if (cxA != null && cxB != null && Math.abs(cxB - cxA) > 0.5) {
          barSpacing = Math.abs(cxB - cxA);
        }
      }
      if (!(barSpacing > 0.5)) {
        const timeScaleWithOptions = chart.timeScale() as { options?: () => { barSpacing?: number } };
        barSpacing = Number(timeScaleWithOptions.options?.()?.barSpacing) || 8;
      }
      cachedHalfBodyWidth = Math.max(2.5, barSpacing * 0.42 + 0.75);
      return cachedHalfBodyWidth;
    };
    const resolveCandleBodyRect = (candle: Candle, sampleIndex: number): TradeHistoryCandleSubRect | null => {
      if (candleBodyRectCache.has(candle.time)) {
        return candleBodyRectCache.get(candle.time) ?? null;
      }
      const cx = chart.timeScale().timeToCoordinate(candle.time as Time);
      const openY = series.priceToCoordinate(candle.open);
      const closeY = series.priceToCoordinate(candle.close);
      if (cx == null || openY == null || closeY == null) {
        candleBodyRectCache.set(candle.time, null);
        return null;
      }
      const halfWidth = resolveHalfBodyWidth(sampleIndex);
      const rect: TradeHistoryCandleSubRect = {
        left: cx - halfWidth,
        right: cx + halfWidth,
        top: Math.min(openY, closeY) - 1,
        bottom: Math.max(openY, closeY) + 1,
      };
      candleBodyRectCache.set(candle.time, rect);
      return rect;
    };
    const collectSegmentCandleBodyRects = (startTime: number, endTime: number): TradeHistoryCandleSubRect[] => {
      const candles = candlesRef.current;
      const minTime = Math.min(startTime, endTime);
      const maxTime = Math.max(startTime, endTime);
      const rects: TradeHistoryCandleSubRect[] = [];
      if (candles.length > 0) {
        let lo = 0;
        let hi = candles.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (candles[mid].time < minTime) lo = mid + 1;
          else hi = mid;
        }
        const startIdx = Math.max(0, lo - 1);
        lo = startIdx;
        hi = candles.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (candles[mid].time <= maxTime) lo = mid + 1;
          else hi = mid;
        }
        const endIdx = Math.min(candles.length - 1, lo);
        for (let idx = startIdx; idx <= endIdx; idx++) {
          const rect = resolveCandleBodyRect(candles[idx], idx);
          if (rect) rects.push(rect);
        }
      }
      const liveCandle = currentCandleRef.current;
      if (liveCandle && !candleBodyRectCache.has(liveCandle.time)) {
        const rect = resolveCandleBodyRect(liveCandle, Math.max(0, candles.length - 1));
        if (rect) rects.push(rect);
      } else if (liveCandle) {
        const cachedLive = candleBodyRectCache.get(liveCandle.time);
        if (cachedLive && (candles.length === 0 || candles[candles.length - 1].time !== liveCandle.time)) {
          rects.push(cachedLive);
        }
      }
      return rects;
    };

    // Closed-trade (history) geometry depends only on the viewport and candle data, never on the
    // live quote. Re-lay out history nodes only when that key changes, for new nodes, and for the
    // few nodes touching the live candle; every other tick leaves them (and their styles) alone.
    let historyFullPass = true;
    let historyLiveDirty = false;
    let nextHistoryKey: number[] | null = null;
    let liveThresholdTime = Number.POSITIVE_INFINITY;
    if (historyOverlayNodesRef.current.length > 0) {
      try {
        const candles = candlesRef.current;
        const liveCandle = currentCandleRef.current;
        const candleCount = candles.length;
        if (candleCount > 0) {
          const timeScale = chart.timeScale();
          const range = timeScale.getVisibleLogicalRange();
          const probePrice = candles[0].close > 0 ? candles[0].close : 1;
          const missing = Number.MAX_VALUE;
          const key = [
            range?.from ?? missing, range?.to ?? missing, chartWidth, chartHeight, priceScaleWidth,
            Number.isFinite(timeScaleHeight) ? timeScaleHeight : 0,
            candleCount, candles[0].time, candles[candleCount - 1].time, liveCandle?.time ?? 0,
            series.priceToCoordinate(probePrice) ?? missing,
            series.priceToCoordinate(probePrice * 1.5) ?? missing,
            timeScale.timeToCoordinate(candles[0].time as Time) ?? missing,
            timeScale.timeToCoordinate(candles[candleCount - 1].time as Time) ?? missing,
            // Live candle OHLC: only nodes touching the live candle depend on these.
            liveCandle?.open ?? 0, liveCandle?.high ?? 0, liveCandle?.low ?? 0, liveCandle?.close ?? 0,
          ];
          const previous = historyViewportKeyRef.current;
          if (previous && previous.length === key.length) {
            historyFullPass = false;
            for (let k = 0; k < HISTORY_VIEWPORT_KEY_LENGTH; k++) {
              if (key[k] !== previous[k]) { historyFullPass = true; break; }
            }
            for (let k = HISTORY_VIEWPORT_KEY_LENGTH; k < key.length; k++) {
              if (key[k] !== previous[k]) { historyLiveDirty = true; break; }
            }
          }
          nextHistoryKey = key;
          liveThresholdTime = Math.min(liveCandle?.time ?? Number.POSITIVE_INFINITY, candles[candleCount - 1].time);
        }
      } catch {
        historyFullPass = true;
        nextHistoryKey = null;
      }
    }
    // Writes a style value; history nodes skip the DOM write when the value is unchanged.
    const put = (el: HTMLElement, node: OverlayNodeData, prop: string, value: string) => {
      const styles = node.layoutCache?.styles;
      if (styles) {
        if (styles[prop] === value) return;
        styles[prop] = value;
      }
      (el.style as unknown as Record<string, string>)[prop] = value;
    };

    for (const { nodes, data, isHistory } of overlayLayers) {
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        const node = data[i];
        if (!el || !node) continue;
        const layoutCache = isHistory ? node.layoutCache : undefined;
        if (layoutCache && layoutCache.placed && !historyFullPass && !(layoutCache.live && historyLiveDirty)) continue;

        try {
          if (node.kind === 'axis-price-badge') {
            const y = node.price == null ? null : series.priceToCoordinate(node.price);
            if (y == null) {
              if (!el.style.top) el.style.display = 'none';
              continue;
            }
            const snappedY = snapCssPixel(y);
            // Outlined prices belong entirely to the scale, never the time axis.
            if (priceScaleWidth <= 0 || snappedY < 10 || snappedY + 10 > plotHeight) {
              el.style.display = 'none';
              continue;
            }
            el.style.display = 'flex';
            el.style.top = `${snappedY}px`;
            el.style.right = '0px';
            el.style.width = `${priceScaleWidth}px`;
            continue;
          }
          if (
            node.kind === 'horizontal-line'
            || node.kind === 'price-badge'
            || node.kind === 'price-hit-area'
          ) {
            if (node.price == null) {
              el.style.display = 'none';
              continue;
            }

            const y = series.priceToCoordinate(node.price);
            if (y == null) {
              // The scale reports no coordinates while candles reload (feed
              // reconnects, empty snapshots from a flaky backend). Freeze
              // already-placed nodes instead of blinking the overlay off.
              if (!el.style.top) el.style.display = 'none';
              continue;
            }
            if (y < -20 || y > chartHeight + 20) {
              el.style.display = 'none';
              continue;
            }

            const snappedY = snapCssPixel(y);
            const isControl = el.classList.contains('rtx-trade-controls');
            // Restore the node's own display mode: flex control bars must not
            // be flattened to block or their buttons fall onto the text baseline.
            el.style.display = el.dataset.display || 'block';
            if (!isControl) {
              el.style.top = node.kind === 'price-badge' && el.classList.contains('rtx-trade-level-badge--line-text')
                ? `${snappedY - 14}px`
                : `${snappedY + (node.pixelOffsetY ?? 0)}px`;
            }

            if (node.kind === 'horizontal-line' || node.kind === 'price-hit-area') {
              el.style.left = '0px';
              el.style.right = `${priceScaleWidth}px`;
            } else {
              const leftInset = Number.parseFloat(el.dataset.leftInset ?? '') || 0;
              el.style.width = 'max-content';
              if (isControl) {
                if (snappedY < 0 || snappedY > plotHeight) {
                  el.style.display = 'none';
                  continue;
                }
                el.style.maxWidth = `${Math.max(0, chartWidth - priceScaleWidth - 32)}px`;
                controlNodes.set(`${el.dataset.tradeKey}:${el.dataset.role}`, { element: el, anchorY: snappedY });
              } else {
                el.style.maxWidth = `${Math.max(96, chartWidth - priceScaleWidth - leftInset - 12)}px`;
                if (el.dataset.align === 'right') {
                  el.style.left = 'auto';
                  el.style.right = `${priceScaleWidth + 16}px`;
                }
              }
            }

            continue;
          }

          if (node.kind === 'segment') {
            if (node.price == null || node.time == null) {
              put(el, node, 'display', 'none');
              if (layoutCache) layoutCache.placed = true;
              continue;
            }

            const endPrice = node.resolveEndPrice?.() ?? node.endPrice ?? null;
            const endTime = node.resolveEndTime?.() ?? node.endTime ?? null;
            if (endPrice == null || endTime == null) {
              put(el, node, 'display', 'none');
              if (layoutCache) layoutCache.placed = true;
              continue;
            }

            const resolveSegmentEndY = (price: number, time: number, markerSide?: TradeSide) => {
              if (!markerSide) return series.priceToCoordinate(price);
              const y = series.priceToCoordinate(
                resolveTradeMarkerAnchorPrice({ kind: 'marker', price, time, markerSide, markerAnchor: 'candle' }),
              );
              if (y == null) return null;
              return y + (markerSide === 'BUY' ? TRADE_MARKER_TIP_OFFSET_PX : -TRADE_MARKER_TIP_OFFSET_PX);
            };
            const x1 = resolveTimeCoordinate(node.time);
            const y1 = resolveSegmentEndY(node.price, node.time, node.startMarkerSide);
            const x2 = resolveTimeCoordinate(endTime);
            const y2 = resolveSegmentEndY(endPrice, endTime, node.endMarkerSide);
            const geometry = resolveTradeOverlaySegmentGeometry({
              x1,
              y1,
              x2,
              y2,
              minLengthPx: 0,
            });
            if (!geometry) {
              // Coordinate gaps during candle reloads freeze placed segments.
              if (!el.style.top) el.style.display = 'none';
              continue;
            }

            put(el, node, 'display', 'block');
            put(el, node, 'left', `${geometry.left}px`);
            const isHistoryLine = el.classList.contains('rtx-trade-history-line');
            // History lines have a fixed inline height; reading offsetHeight here
            // forced one synchronous layout per trade segment on every pass.
            const segmentHeight = isHistoryLine ? (Number.parseFloat(el.style.height) || 1) : 0;
            put(el, node, 'top', `${geometry.top - segmentHeight / 2}px`);
            put(el, node, 'width', `${geometry.width}px`);
            put(el, node, 'transform', `rotate(${geometry.angleDeg}deg)`);
            put(el, node, 'transformOrigin', isHistoryLine ? '0 50%' : '0 0');
            if (isHistoryLine && x1 != null && y1 != null && x2 != null && y2 != null) {
              const maskImage = buildTradeHistoryLineCandleMask(
                x1,
                y1,
                x2,
                y2,
                collectSegmentCandleBodyRects(node.time, endTime),
              );
              // Skip the DOM write when the cached value is unchanged.
              const maskStyles = layoutCache?.styles;
              if (!maskStyles || maskStyles.maskImage !== maskImage) {
                if (maskStyles) maskStyles.maskImage = maskImage;
                el.style.maskImage = maskImage;
              }
              if (!maskStyles || maskStyles.webkitMaskImage !== maskImage) {
                if (maskStyles) maskStyles.webkitMaskImage = maskImage;
                el.style.webkitMaskImage = maskImage;
              }
            }
            if (layoutCache) {
              // Only a segment reaching the live candle's body depends on the live quote.
              const liveCandle = currentCandleRef.current;
              const liveRect = liveCandle
                ? resolveCandleBodyRect(liveCandle, Math.max(0, candlesRef.current.length - 1))
                : null;
              layoutCache.live = liveRect == null
                ? liveCandle != null
                : Math.max(x1 ?? Number.NEGATIVE_INFINITY, x2 ?? Number.NEGATIVE_INFINITY) >= liveRect.left;
              layoutCache.placed = true;
            }
            continue;
          }

          if (node.price == null || node.time == null) {
            put(el, node, 'display', 'none');
            if (layoutCache) layoutCache.placed = true;
            continue;
          }

          let x = resolveTimeCoordinate(node.time);
          if (x == null && node.resolveTime) {
            const fallbackX = resolveTimeCoordinate(node.resolveTime());
            if (fallbackX != null) {
              x = fallbackX;
            }
          }
          const anchoredPrice = node.kind === 'marker' ? resolveTradeMarkerAnchorPrice(node) : node.price;
          const y = series.priceToCoordinate(anchoredPrice);
          if (x == null || y == null) {
            // Keep last placement through transient coordinate gaps.
            if (!el.style.top) el.style.display = 'none';
            continue;
          }
          if (layoutCache) {
            layoutCache.live = Number(node.time) >= liveThresholdTime;
            layoutCache.placed = true;
          }
          if (x < -24 || x > chartWidth + 24 || y < -24 || y > chartHeight + 24) {
            put(el, node, 'display', 'none');
            continue;
          }

          put(el, node, 'display', 'block');

          if (node.kind === 'marker') {
            const markerY = y + (node.pixelOffsetY ?? 0);
            put(el, node, 'left', `${x}px`);
            put(el, node, 'top', `${markerY}px`);
            put(el, node, 'transform', node.markerSide === 'BUY'
              ? 'translate(-50%, 0)'
              : 'translate(-50%, -100%)');

            const tooltip = el.querySelector<HTMLElement>('.rtx-trade-marker__price-tooltip');
            if (tooltip) {
              tradeMarkerTooltipLayouts.set(el, {
                x,
                markerY,
                markerSide: node.markerSide,
                plotWidth: Math.max(0, chartWidth - priceScaleWidth),
                plotHeight,
              });
              // Hidden tooltips are placed when shown (hover/focus).
              if (tooltip.style.visibility === 'visible') placeTradeMarkerTooltip(el, tooltip);
            }
            continue;
          }
        } catch {
          el.style.display = 'none';
        }
      }
    }

    historyViewportKeyRef.current = nextHistoryKey;

    // Refresh the live Pips/USD text on position control bars. Relayout is
    // already tick-driven for active trades, so this stays in the same frame.
    // Build a ticket -> Position lookup map once per frame so N positions update in O(N) instead of O(N^2).
    if (refreshMetrics && tradeControlLiveUpdatersRef.current.length > 0) {
      const positions = useAppStore.getState().positions;
      const positionsByTicket = new Map<number, TradePositionRecord>();
      if (Array.isArray(positions)) {
        for (let i = 0; i < positions.length; i++) {
          const position = positions[i] as TradePositionRecord;
          const posTicket = Number(position.id ?? position.ticket);
          if (Number.isSafeInteger(posTicket) && posTicket > 0 && !positionsByTicket.has(posTicket)) {
            positionsByTicket.set(posTicket, position);
          }
        }
      }
      for (const refreshTradeControlMetrics of tradeControlLiveUpdatersRef.current) {
        try { refreshTradeControlMetrics(positionsByTicket); } catch { /* overlay may be rebuilding */ }
      }
    }

    // Observer-provided border boxes keep quote-driven placement from forcing
    // layout after every marker/style write. Dense trades retain their anchors.
    if (controlNodes.size && containerRef.current) {
      const plotWidth = Math.max(0, chartWidth - priceScaleWidth);
      const inputs = Array.from(controlNodes, ([key, { element, anchorY }]) => {
        const { width, height } = readTradeControlSize(
          tradeControlSizesRef.current, element, tradeControlSizeObservationRef.current,
        );
        return {
          key, anchorY, width, height,
          preferredLeft: element.dataset.align === 'right'
            ? plotWidth - width - 16
            : Number.parseFloat(element.dataset.leftInset ?? '') || 16,
        };
      });
      const placements = layoutTradeControls(inputs, plotWidth);
      for (const placement of placements) {
        const element = controlNodes.get(placement.key)!.element;
        element.style.left = `${snapCssPixel(placement.left)}px`;
        element.style.right = 'auto';
        element.style.top = `${snapCssPixel(placement.top + placement.height / 2)}px`;
        element.dataset.priceAnchorOffsetY = String(placement.offsetY);
        element.dataset.priceAnchorY = String(placement.anchorY);
      }
    }

    if (
      chartSettingsRef.current.showBidPriceLine
      && livePriceRef.current !== null
      && livePriceLineRef.current
      && livePriceBadgeRef.current
    ) {
      const y = series.priceToCoordinate(livePriceRef.current);
      if (y !== null && y !== undefined && y > 0) {
        const overlayColors = livePriceOverlayColorsRef.current;
        applyLivePriceHorizontalGeometry(priceScaleWidth);
        livePriceLineRef.current.style.display = 'block';
        livePriceLineRef.current.style.top = `${y}px`;
        livePriceLineRef.current.style.borderTopColor = overlayColors.lineColor;
        livePriceBadgeRef.current.style.display = 'block';
        livePriceBadgeRef.current.style.top = `${y}px`;
        livePriceBadgeRef.current.style.background = overlayColors.badgeBackground;
        livePriceBadgeRef.current.style.color = overlayColors.badgeTextColor;
      }
    } else if (!chartSettingsRef.current.showBidPriceLine) {
      hideLivePriceOverlay(false);
    }
  }, [
    applyLivePriceHorizontalGeometry,
    candlesRef,
    chartRef,
    chartSettingsRef,
    containerRef,
    currentCandleRef,
    getNearestCandleByTime,
    hideLivePriceOverlay,
    livePriceBadgeRef,
    livePriceLineRef,
    livePriceOverlayColorsRef,
    livePriceRef,
    overlayRef,
    prevTimeframeRef,
    seriesRef,
    timeframe,
  ]);



  useEffect(() => {
    const repaintTradeOverlayGeometry = () => updateLabelPositions(false);
    repaintTradeOverlayGeometryRef.current = repaintTradeOverlayGeometry;
    return () => {
      if (repaintTradeOverlayGeometryRef.current === repaintTradeOverlayGeometry) {
        repaintTradeOverlayGeometryRef.current = () => undefined;
      }
    };
  }, [repaintTradeOverlayGeometryRef, updateLabelPositions]);

  useEffect(() => {
    const container = containerRef.current;
    const wrapper = container?.parentElement;
    if (!container || !wrapper) return;
    let frame: number | null = null;
    let observeFrame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => { frame = null; updateLabelPositions(false); });
    };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === container) {
          rememberTradeOverlayContainerResize(tradeOverlayContainerSizesRef.current, entry);
        } else if ((entry.target as HTMLElement).classList.contains('rtx-trade-controls')) {
          rememberTradeControlResize(tradeControlSizesRef.current, entry);
        }
      }
      schedule();
    });
    tradeControlSizeObservationRef.current = resize !== null;
    // Observed elements are tracked so a mutation only observes the newly added nodes and unobserves the
    // removed ones. Re-observing all N controls (disconnect + observe) re-fired the observer for every
    // control and forced another layout pass per trade open/close.
    const observed = new Set<Element>();
    const observeOnce = (element: Element, options?: ResizeObserverOptions) => {
      if (!resize || observed.has(element)) return;
      observed.add(element);
      resize.observe(element, options);
    };
    const observeControlSizes = () => {
      if (resize) {
        for (const element of observed) {
          if (element.isConnected) continue;
          resize.unobserve(element);
          observed.delete(element);
        }
        observeOnce(wrapper);
        observeOnce(container, { box: 'border-box' });
        container.querySelectorAll('td, canvas').forEach(element => observeOnce(element));
        wrapper.querySelectorAll('.rtx-trade-controls').forEach(element => observeOnce(element));
      }
      schedule();
    };
    const scheduleObserveControlSizes = () => {
      if (observeFrame !== null) return;
      observeFrame = window.requestAnimationFrame(() => {
        observeFrame = null;
        observeControlSizes();
      });
    };
    const children = new MutationObserver(scheduleObserveControlSizes);
    children.observe(wrapper, { childList: true });
    children.observe(container, { childList: true, subtree: true });
    observeControlSizes();
    return () => {
      children.disconnect();
      resize?.disconnect();
      observed.clear();
      tradeControlSizeObservationRef.current = false;
      tradeControlSizesRef.current = new WeakMap();
      tradeOverlayContainerSizesRef.current = new WeakMap();
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (observeFrame !== null) window.cancelAnimationFrame(observeFrame);
    };
  }, [containerRef, updateLabelPositions]);



  const layoutPostInteractionOverlays = useCallback(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const overlay = overlayRef.current;
    if (!isDisposedRef.current && chart && series && overlay) {
      drawingManager.setChart(
        chart,
        series,
        prevSymbolRef.current || symbol,
        1,
        overlay,
        prevTimeframeRef.current || timeframe,
        activeChartSourceId,
        drawingRuntimeContextRef.current.accountScope,
        getDrawingSeriesData,
      );
      drawingManager.renderContext(overlay);
    }
    updateLabelPositions();
  }, [
    activeChartSourceId,
    chartRef,
    drawingRuntimeContextRef,
    getDrawingSeriesData,
    isDisposedRef,
    overlayRef,
    prevSymbolRef,
    prevTimeframeRef,
    seriesRef,
    symbol,
    timeframe,
    updateLabelPositions,
  ]);



  useEffect(() => {
    const callbacks = postInteractionCallbacksRef.current;
    const previousLayoutOverlay = callbacks.layoutOverlay;
    callbacks.layoutOverlay = layoutPostInteractionOverlays;
    return () => {
      if (callbacks.layoutOverlay === layoutPostInteractionOverlays) {
        callbacks.layoutOverlay = previousLayoutOverlay;
      }
    };
  }, [layoutPostInteractionOverlays, postInteractionCallbacksRef]);



  useTradingChartTradeOverlayRenderer({
    activeOverlayNodeDataRef,
    activeOverlayNodesRef,
    activeTradeSnapshotsRef,
    brokerAccountSessionScope,
    brokerTimeOffsetSec,
    candlesRef,
    chartRef,
    chartThemeRef,
    clearFrozenEntryTime,
    clearStableActiveMarkerTime,
    clearTradeOverlayLayer,
    clearTradeOverlayVisualRuntime,
    closeSuppressedTradeKeysRef,
    currentCandleRef,
    drawingRuntimeContextRef,
    frozenEntryPricesRef,
    frozenEntryTimesRef,
    getNearestCandleByTime,
    historyOverlayNodeDataRef,
    historyOverlayNodesRef,
    hydrateTradeLevelOverrides,
    isActiveRef,
    isChartInteractionActiveRef,
    isChartSurfaceLight,
    isDisposedRef,
    isLivePriceSafeForCandles,
    lastActiveTradeOverlaySignatureRef,
    lastRenderedCandlesRef,
    lastHistoryTradeOverlaySignatureRef,
    optimisticClosedTradeSnapshotsRef,
    overlayRef,
    pendingClosedTradeSnapshotsRef,
    pendingMissingActiveTradesRef,
    pendingTradeLevelModifyRequestsRef,
    persistTradeLevelOverrides,
    postInteractionCoordinatorRef,
    prevTimeframeRef,
    resolvedPriceDigits,
    seriesRef,
    stableActiveMarkerTimesRef,
    symbol,
    timeframe,
    tr,
    tradeControlLiveUpdatersRef,
    tradeHistoryRefreshTimerRef,
    tradeLevelCrossRefreshPendingRef,
    tradeLevelLastKnownLevelsRef,
    tradeLevelModifyRequestSeqRef,
    tradeLevelOptimisticGraceUntilRef,
    tradeLevelOverridesRef,
    tradeMissingGraceTimerRef,
    tradeOverlayRafRef,
    updateLabelPositions,
    visibleRuntime,
  });



  // Relabel existing overlays in place. Changing the interface language must
  // not recreate the chart, reset its viewport, or interrupt a level drag.
  useEffect(() => {
    const host = overlayRef.current?.parentElement ?? overlayRef.current;
    if (!host) return;
    refreshChartUiTranslations(host);
    host.querySelectorAll<HTMLElement>('[data-chart-ui-label]').forEach(label => {
      label.textContent = tr(label.dataset.chartUiLabel || '');
    });
    host.querySelectorAll<HTMLElement>('.rtx-trade-marker-hover-target').forEach(marker => {
      const side = marker.dataset.positionSide;
      const lifecycle = marker.dataset.tradeLifecycle;
      if (!side || !lifecycle) return;
      const sourceHeader = `${side} ${lifecycle === 'open' ? 'OPEN' : 'CLOSE'}`;
      const translatedHeader = `${tr(side)} ${tr(lifecycle === 'open' ? 'Open' : 'Close')}`;
      const header = marker.querySelector<HTMLElement>('.rtx-trade-marker__tooltip-header');
      if (header) header.textContent = translatedHeader;
      const accessibleLabel = marker.dataset.historyAccessibleLabel;
      if (accessibleLabel) marker.setAttribute('aria-label', accessibleLabel.replace(sourceHeader, translatedHeader));
    });
  }, [overlayRef, tr]);



  useEffect(() => {
    if (candlesLoadedRev <= 0) return;
    requestChartTradeOverlayRefresh(drawingRuntimeContextRef.current.contextId, 'reconcile');
  }, [candlesLoadedRev, drawingRuntimeContextRef]);



  useTradingChartTradeLevelDrag({
    activeToolRef,
    activeTradeSnapshotsRef,
    brokerAccountSessionScope,
    chartRef,
    chartSettingsRef,
    containerRef,
    isActive,
    isChartInteractionActiveRef,
    isChartSurfaceLight,
    overlayRef,
    pendingTradeLevelModifyRequestsRef,
    persistTradeLevelOverrides,
    resolvedPriceDigitsRef,
    seriesRef,
    tr,
    tradeAllowed,
    tradeLevelLastKnownLevelsRef,
    tradeLevelModifyRequestSeqRef,
    tradeLevelOptimisticGraceUntilRef,
    tradeLevelOverridesRef,
  });
};
