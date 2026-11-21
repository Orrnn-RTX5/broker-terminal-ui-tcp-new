/**
 * Trading Chart Live Candle Runtime — MT5 Event-Driven VSync Fast Path
 *
 * Replaces the legacy 50 ms `setInterval` chart polling loop with a direct,
 * event-driven Binary TCP tick -> OHLC model -> single coalesced `requestAnimationFrame`
 * VSync canvas update:
 *   - ZERO 50 ms `setInterval` polling loop
 *   - Every intra-frame tick updates High/Low/Close/Volume synchronously (zero dropped wicks)
 *   - Canvas/DOM paints coalesce to monitor VSync (60–144 FPS, < 1–8 ms tick-to-pixel latency)
 *   - MT5 Continuous Session Open chaining (`open = prevCandle.close` within active sessions)
 */

import { useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import { isDesktopBackendTarget } from '../../../config/backendTarget.js';
import { updateDrawingCandle } from '../../../drawing-tools/drawingCandleUpdates';
import { useActiveChartRuntimeEffect } from '../../../hooks/useActiveChartRuntimeEffect';
import type { TradingChartVisibleRuntime } from '../../../hooks/useTradingChartVisibleRuntime';
import {
  binaryTcpMarketStream,
  type DecodedBinaryTick,
} from '../../../services/binaryTcpMarketStream';
import {
  getActiveBinaryTcpOrderCount,
  getBinaryTcpOrderActiveDurationMs,
} from '../../../services/binaryTcpOrderClient';
import {
  candleAggregationService,
  getTimeframeSeconds,
  omitPartialLeadingM1Aggregate,
  type Timeframe as AggTimeframe,
} from '../../../services/candleAggregationService';
import type { CandleCacheSource } from '../../../services/candleCache';
import { chartDataService } from '../../../services/chartDataService';
import { aggregateM1CandlesToTimeframe } from '../../../services/derivedTimeframeHistoryService';
import {
  canDropPreloadedCandlesForLiveQuoteMismatch,
  createRenderedPriceReference,
  updateLiveQuoteGuardState,
  type RenderedPriceReference,
} from '../../../services/chartPriceGuards';
import { getQuoteSocketManager } from '../../../services/quoteSocketManager';
import { applyAccountSpreadMarkup } from '../../../services/accountSpreadMarkup';
import { useAppStore } from '../../../store/useAppStore';
import type { ChartProperties } from '../../../store/useChartSettingsStore';
import {
  applyTickToFormingCandle,
  formatHistoryForOhlcv,
  mergeAuthoritativeCandleHistory,
  mergeBackendCandlePage,
  mergeFormingCandleEnvelope,
  resolveCanonicalServerCandle,
  upsertCandleIntoHistory,
  type LogicalRangeLike,
} from '../../../utils/candleHistory';
import type {
  ChartPostInteractionCallbacks,
  ChartPostInteractionCoordinator,
} from '../../../utils/chartPostInteractionCoordinator';
import {
  isChartSelectionLivePaintAllowed,
  shouldCommitFirstLiveSelectionBaseline,
} from '../../../utils/chartSelectionPresentation';
import type { PeriodSeparator } from '../../../utils/periodSeparators';
import { getRawQuoteSides } from '../../../utils/spreadMarkup';
import { resolveFormingCandleLiveClose } from '../../../utils/liveCandleQuote';
import type { SynchronizedMarketClockAnchor } from '../../../utils/synchronizedMarketClock';
import { getTradingChartShiftRightOffset } from '../../../utils/chartTimeFormat';
import {
  alignTimeframeBoundarySeconds,
  getTimeframePeriodSeconds,
} from '../../../utils/timeframeBoundary';
import type {
  Candle,
  ChartSelectionPresentationGate,
  ChartType,
  Timeframe,
  TradingViewChartTheme,
} from '../../../types/chart';
import {
  getDisplayVolume,
  getValidSortedCandles,
  getVolumeBarColor,
  isCandleAtOrBeforeFinalizedTime,
  markFinalizedCandleTime,
  resolveCandleFinalityFromActivePeriod,
  shouldRecomputeMarketGapSeparatorsForCandle,
  shouldShowVolumeForChartType,
} from '../../../components/TradingChart.helpers';
import {
  getStartupSnapshotCandleCount,
  shouldBuildVolumeData,
  shouldScrollToRealtime,
} from './chartRuntime';
import type { ChartDataRenderRequest } from './chartRuntimeContracts';
import type { ActiveTradeSnapshot } from './useTradingChartTradeRuntime';
import {
  TRADE_LEVEL_CROSS_REFRESH_MIN_DISPATCH_INTERVAL_MS,
} from '../presentation/tradeOverlayPresentation';

const RAF_WATCHDOG_MS = 100;
const RAF_SUSTAINED_DEFERRAL_CAP_MS = 200;

interface UseTradingChartLiveCandleRuntimeOptions {
  discardRetainedPublicChartSurface: () => void;
  activeTradeSnapshotsRef: RefObject<Map<string, ActiveTradeSnapshot>>;
  applyAreaTrendColors: (latestClose?: number) => void;
  authToken: string | null;
  autoScrollEnabledRef: RefObject<boolean>;
  brokerAccountSessionScope: string;
  brokerTimeOffsetSecRef: RefObject<number>;
  cancelQueuedChartRender: () => void;
  candlesRef: RefObject<Candle[]>;
  chartRef: RefObject<IChartApi | null>;
  chartSelectionPresentationKey: string;
  chartSelectionPresentationRef: RefObject<ChartSelectionPresentationGate>;
  chartSettingsRef: RefObject<ChartProperties>;
  chartThemeRef: RefObject<TradingViewChartTheme>;
  clearPeriodSeparators: () => void;
  currentCandleRef: RefObject<Candle | null>;
  drawingRenderFrameRef: RefObject<number | null>;
  drawingRenderSettledFrameRef: RefObject<number | null>;
  drawingRuntimeContextRef: RefObject<{ contextId: string; accountScope?: string; symbol: string; timeframe: Timeframe }>;
  firstRenderedCandleTimeRef: RefObject<number | null>;
  flushPostInteractionWork: () => boolean;
  getSynchronizedChartMarketNowMs: () => number;
  hasDisplayedHistoryRef: RefObject<boolean>;
  hideLivePriceOverlay: (clearPrice?: boolean) => void;
  incompatibleQuoteCountRef: RefObject<number>;
  initialHistoryLoadPendingRef: RefObject<boolean>;
  isActive: boolean;
  isActiveRef: RefObject<boolean>;
  isChartInteractionActiveRef: RefObject<boolean>;
  isDisposedRef: RefObject<boolean>;
  isLivePriceSafeForCandles: (price: number) => boolean;
  isPotentialMarketClosedPlaceholder: (candle: Candle) => boolean;
  isRebuildingRef: RefObject<boolean>;
  lastAcceptedQuoteRef: RefObject<number | null>;
  lastCrossRefreshDispatchAtRef: RefObject<number>;
  lastRenderedCandlesRef: RefObject<Candle[]>;
  lastStoreCandleSecRef: RefObject<number>;
  lastVisibleLogicalRangeRef: RefObject<LogicalRangeLike | null>;
  leftVisibleTimeRef: RefObject<number | null>;
  liveCandleMutationGenerationByTimeRef: RefObject<Map<number, number>>;
  liveCandleMutationGenerationRef: RefObject<number>;
  liveMarketDataFrozenRef: RefObject<boolean>;
  mergeCandleIntoRef: (incoming: Candle) => void;
  mergeHistoryCache: (activeTimeframe: Timeframe, candles: Candle[], brokerOffsetSeconds?: number, source?: CandleCacheSource) => void;
  periodSeparatorsRef: RefObject<PeriodSeparator[]>;
  postInteractionCallbacksRef: RefObject<ChartPostInteractionCallbacks>;
  postInteractionCoordinatorRef: RefObject<ChartPostInteractionCoordinator | null>;
  prevChartTypeRef: RefObject<ChartType>;
  prevPriceRef: RefObject<number | null>;
  prevSymbolRef: RefObject<string>;
  prevTimeframeRef: RefObject<Timeframe>;
  protectedDisplayedHistoryRef: RefObject<Candle[]>;
  reconcileCandlesWithLiveQuote: (candles: Candle[], context: string) => Candle[];
  repaintLivePriceOverlayFromCurrentPrice: (activeCandle: Candle) => void;
  renderedPriceReferenceRef: RefObject<RenderedPriceReference | null>;
  requestChartDataRender: (request?: ChartDataRenderRequest) => void;
  resetLiveQuotePriceGuard: () => void;
  resetVisibleRangeOnNextDataRef: RefObject<boolean>;
  restoreProtectedDisplayedHistory: (activeTimeframe: Timeframe, reason: string) => boolean;
  scheduleBoundaryTimerRef: RefObject<() => void>;
  scheduleDrawingRenderAfterChartData: (activeSymbol: string, activeTimeframe: Timeframe) => void;
  seriesRef: RefObject<ISeriesApi<SeriesType> | null>;
  setApiError: Dispatch<SetStateAction<string>>;
  setHistoryCache: (activeTimeframe: Timeframe, candles: Candle[], brokerOffsetSeconds?: number, source?: CandleCacheSource) => void;
  symbol: string;
  syncSupplementalPriceLines: (askPrice: number, lastPrice: number) => void;
  synchronizeChartMarketClock: (sourceTimestamp: unknown) => void;
  synchronizedMarketClockRef: RefObject<SynchronizedMarketClockAnchor | null>;
  timeframe: Timeframe;
  tradeLevelCrossRefreshPendingRef: RefObject<Set<string>>;
  updateChartData: (candles: Candle[], currentChartType?: ChartType, request?: ChartDataRenderRequest) => void;
  updateLegendDOM: (open: number, high: number, low: number, close: number, volume: number) => void;
  validateRenderedCandlesAgainstLivePrice: (price: number, activeTimeframe: Timeframe) => boolean;
  visibleRuntime: TradingChartVisibleRuntime;
  volumeRef: RefObject<ISeriesApi<SeriesType> | null>;
}

interface RawLiveChartTickInput {
  rawBid: number;
  rawAsk: number;
  execBid: number;
  execAsk: number;
  rawTimestampMs: number;
  sequence?: number;
}

export const useTradingChartLiveCandleRuntime = (options: UseTradingChartLiveCandleRuntimeOptions): void => {
  const {
    activeTradeSnapshotsRef, applyAreaTrendColors, authToken, autoScrollEnabledRef,
    brokerAccountSessionScope, brokerTimeOffsetSecRef, cancelQueuedChartRender, candlesRef,
    chartRef, chartSelectionPresentationKey, chartSelectionPresentationRef, chartSettingsRef,
    chartThemeRef, clearPeriodSeparators, currentCandleRef, discardRetainedPublicChartSurface, drawingRenderFrameRef,
    drawingRenderSettledFrameRef, drawingRuntimeContextRef, firstRenderedCandleTimeRef,
    flushPostInteractionWork, getSynchronizedChartMarketNowMs, hasDisplayedHistoryRef,
    hideLivePriceOverlay, incompatibleQuoteCountRef, initialHistoryLoadPendingRef, isActive,
    isActiveRef, isChartInteractionActiveRef, isDisposedRef, isLivePriceSafeForCandles,
    isPotentialMarketClosedPlaceholder, isRebuildingRef, lastAcceptedQuoteRef,
    lastCrossRefreshDispatchAtRef, lastRenderedCandlesRef, lastStoreCandleSecRef,
    lastVisibleLogicalRangeRef, leftVisibleTimeRef,
    liveCandleMutationGenerationByTimeRef, liveCandleMutationGenerationRef,
    liveMarketDataFrozenRef, mergeCandleIntoRef, mergeHistoryCache, periodSeparatorsRef,
    postInteractionCallbacksRef, postInteractionCoordinatorRef, prevChartTypeRef, prevPriceRef,
    prevSymbolRef, prevTimeframeRef, protectedDisplayedHistoryRef, reconcileCandlesWithLiveQuote,
    repaintLivePriceOverlayFromCurrentPrice, renderedPriceReferenceRef, requestChartDataRender,
    resetLiveQuotePriceGuard, resetVisibleRangeOnNextDataRef, restoreProtectedDisplayedHistory,
    scheduleBoundaryTimerRef, scheduleDrawingRenderAfterChartData, seriesRef, setApiError,
    setHistoryCache, symbol, syncSupplementalPriceLines, synchronizeChartMarketClock,
    synchronizedMarketClockRef, timeframe,
    tradeLevelCrossRefreshPendingRef, updateChartData, updateLegendDOM,
    validateRenderedCandlesAgainstLivePrice, visibleRuntime, volumeRef,
  } = options;

  const updateLegendDOMRef = useRef(updateLegendDOM);
  updateLegendDOMRef.current = updateLegendDOM;
  const chartSelectionPresentationKeyRef = useRef(chartSelectionPresentationKey);
  chartSelectionPresentationKeyRef.current = chartSelectionPresentationKey;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  const runtimeCallbacksRef = useRef({
    applyAreaTrendColors,
    cancelQueuedChartRender,
    clearPeriodSeparators,
    discardRetainedPublicChartSurface,
    flushPostInteractionWork,
    hideLivePriceOverlay,
    isLivePriceSafeForCandles,
    isPotentialMarketClosedPlaceholder,
    mergeCandleIntoRef,
    mergeHistoryCache,
    reconcileCandlesWithLiveQuote,
    repaintLivePriceOverlayFromCurrentPrice,
    requestChartDataRender,
    resetLiveQuotePriceGuard,
    restoreProtectedDisplayedHistory,
    scheduleDrawingRenderAfterChartData,
    setHistoryCache,
    syncSupplementalPriceLines,
    updateChartData,
    validateRenderedCandlesAgainstLivePrice,
  });
  runtimeCallbacksRef.current = {
    applyAreaTrendColors,
    cancelQueuedChartRender,
    clearPeriodSeparators,
    discardRetainedPublicChartSurface,
    flushPostInteractionWork,
    hideLivePriceOverlay,
    isLivePriceSafeForCandles,
    isPotentialMarketClosedPlaceholder,
    mergeCandleIntoRef,
    mergeHistoryCache,
    reconcileCandlesWithLiveQuote,
    repaintLivePriceOverlayFromCurrentPrice,
    requestChartDataRender,
    resetLiveQuotePriceGuard,
    restoreProtectedDisplayedHistory,
    scheduleDrawingRenderAfterChartData,
    setHistoryCache,
    syncSupplementalPriceLines,
    updateChartData,
    validateRenderedCandlesAgainstLivePrice,
  };

  useActiveChartRuntimeEffect(visibleRuntime.candle, () => {
    if (!isActive || !symbol) return;

    const normalizedSymbol = symbol.trim().toUpperCase();
    const getActiveTimeframe = (): Timeframe => (
      prevTimeframeRef.current || timeframeRef.current
    );

    let liveEffectClosed = false;
    let lastTickKey = '';
    let lastSelectionKey = chartSelectionPresentationKeyRef.current;
    let lastMarketGapSeriesRefreshTime: number | null = null;
    let pendingLiveChartPaint = false;
    let pendingLiveChartRequiresFullRender = false;
    let pendingLiveShouldScrollToRealtime = false;
    let pendingSupplementalPriceLines: { ask: number; last: number; time: number } | null = null;
    const finalizedCandleTimeByTimeframe = new Map<string, number>();

    // VSync rAF coalescing state: multiple ticks arriving within one 16 ms monitor frame
    // update OHLC High/Low/Close immediately in RAM and paint once on VSync!
    let rafPaintId: number | null = null;
    let rafWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let rafDeferralStartedAt = 0;
    let forceWatchdogPaint = false;
    const clearRafWatchdog = () => {
      if (rafWatchdogTimer !== null) {
        clearTimeout(rafWatchdogTimer);
        rafWatchdogTimer = null;
      }
    };
    let queuedVSyncNewBar = false;
    let queuedVSyncAskPrice: number | null = null;
    let queuedVSyncLastPrice: number | null = null;
    let queuedVSyncTimeSec = 0;

    const canPaintLiveChart = (allowDuringSettle = false): boolean => (
      isActiveRef.current
      && (allowDuringSettle || !isChartInteractionActiveRef.current)
      && !isDisposedRef.current
      && !isRebuildingRef.current
      && Boolean(seriesRef.current)
      && isChartSelectionLivePaintAllowed(
        chartSelectionPresentationRef.current,
        chartSelectionPresentationKeyRef.current,
      )
    );

    const requestDeferredLivePaint = (
      requiresFullRender = false,
      shouldScrollToRealtime = false,
    ): void => {
      pendingLiveChartPaint = true;
      pendingLiveChartRequiresFullRender ||= requiresFullRender;
      pendingLiveShouldScrollToRealtime ||= shouldScrollToRealtime;
      postInteractionCoordinatorRef.current?.request({ live: true });
    };

    const repaintLivePriceOverlayOrDefer = (c: Candle): void => {
      if (!canPaintLiveChart()) {
        requestDeferredLivePaint();
        return;
      }
      runtimeCallbacksRef.current.repaintLivePriceOverlayFromCurrentPrice?.(c);
    };

    const refreshMarketGapSeriesForCandle = (c: Candle): boolean => {
      if (isDisposedRef.current || !seriesRef.current || !chartRef.current) {
        return false;
      }
      const activeSymbol = prevSymbolRef.current || symbol;
      const activeTf = getActiveTimeframe();
      const marketGapOptions = {
        symbol: activeSymbol,
        timeframe: activeTf,
        brokerOffsetSeconds: brokerTimeOffsetSecRef.current,
      };
      const candlesForFormatting = upsertCandleIntoHistory(candlesRef.current, c).candles;
      if (!shouldRecomputeMarketGapSeparatorsForCandle(candlesForFormatting, c, marketGapOptions)) {
        return false;
      }
      if (lastMarketGapSeriesRefreshTime === c.time) {
        return false;
      }
      lastMarketGapSeriesRefreshTime = c.time;
      runtimeCallbacksRef.current.requestChartDataRender?.({ reason: 'market-gap-refresh' });
      return true;
    };

    const syncCandleIntoRef = (candle: Candle) => {
      if (runtimeCallbacksRef.current.mergeCandleIntoRef) {
        runtimeCallbacksRef.current.mergeCandleIntoRef(candle);
      } else {
        candlesRef.current = upsertCandleIntoHistory(candlesRef.current, candle).candles;
      }
    };

    const push = (c: Candle, isNewCandle: boolean, allowDuringSettle = false) => {
      if (isDisposedRef.current) return;
      if (liveMarketDataFrozenRef.current) return;
      if (!canPaintLiveChart(allowDuringSettle)) {
        if (shouldCommitFirstLiveSelectionBaseline({
          gate: chartSelectionPresentationRef.current,
          selectionKey: chartSelectionPresentationKeyRef.current,
          active: isActiveRef.current,
          disposed: isDisposedRef.current,
          rebuilding: isRebuildingRef.current,
          hasSeries: Boolean(seriesRef.current),
          hasCurrentCandle: Boolean(currentCandleRef.current),
        })) {
          runtimeCallbacksRef.current.requestChartDataRender?.({
            immediate: true,
            resetVisibleRange: true,
            releaseLivePaintAfterRender: true,
            finishLoadingAfterRender: !initialHistoryLoadPendingRef.current,
            reason: 'first-live-selection-baseline',
          });
        } else {
          requestDeferredLivePaint(isNewCandle, isNewCandle);
        }
        return;
      }

      const series = seriesRef.current;
      if (!series) return;
      const rightOffset = getTradingChartShiftRightOffset(
        getActiveTimeframe(),
        chartSettingsRef.current.chartShift,
      );
      const followRealtime = isNewCandle && shouldScrollToRealtime(
        chartRef.current,
        autoScrollEnabledRef.current,
        chartSettingsRef.current.chartAutoScroll,
        rightOffset,
      );
      try {
        const ct = prevChartTypeRef.current || 'candlestick';
        if (ct === 'line' || ct === 'area') {
          series.update({ time: c.time as Time, value: c.close });
          if (ct === 'area') runtimeCallbacksRef.current.applyAreaTrendColors?.(c.close);
        } else {
          series.update({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close });
        }
        if (volumeRef.current && shouldBuildVolumeData(chartSettingsRef.current) && shouldShowVolumeForChartType(ct)) {
          const theme = chartThemeRef.current;
          const displayVolume = getDisplayVolume(c, chartSettingsRef.current);
          volumeRef.current.update({
            time: c.time as Time,
            value: displayVolume,
            color: getVolumeBarColor(c, ct, theme),
          });
        }
        updateDrawingCandle(lastRenderedCandlesRef.current, c);
        const drawingContext = drawingRuntimeContextRef.current;
        if (drawingRenderFrameRef.current === null && drawingRenderSettledFrameRef.current === null) {
          runtimeCallbacksRef.current.scheduleDrawingRenderAfterChartData?.(drawingContext.symbol, drawingContext.timeframe as Timeframe);
        }
        updateLegendDOMRef.current?.(c.open, c.high, c.low, c.close, getDisplayVolume(c, chartSettingsRef.current));
        if (isNewCandle) {
          refreshMarketGapSeriesForCandle(c);
        }
        if (followRealtime && chartRef.current && !isDisposedRef.current) {
          try {
            chartRef.current.timeScale().scrollToPosition(rightOffset, false);
          } catch { /* chart may be rebuilding */ }
        }
      } catch (e) {
        console.error(`[Push] series.update failed:`, e);
      }
    };

    const flushVSyncLivePaint = () => {
      rafPaintId = null;
      clearRafWatchdog();
      const forcedPaint = forceWatchdogPaint;
      forceWatchdogPaint = false;
      if (liveEffectClosed || isDisposedRef.current || isRebuildingRef.current || liveMarketDataFrozenRef.current) {
        rafDeferralStartedAt = 0;
        return;
      }

      if (!forcedPaint && getActiveBinaryTcpOrderCount() > 0 && getBinaryTcpOrderActiveDurationMs() < 250) {
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          rafPaintId = window.requestAnimationFrame(flushVSyncLivePaint);
          armRafWatchdog();
          return;
        }
      }
      rafDeferralStartedAt = 0;

      if (pendingSupplementalPriceLines && canPaintLiveChart(true)) {
        const pending = pendingSupplementalPriceLines;
        pendingSupplementalPriceLines = null;
        if ((!currentCandleRef.current || pending.time >= currentCandleRef.current.time)
          && runtimeCallbacksRef.current.validateRenderedCandlesAgainstLivePrice(pending.last, getActiveTimeframe())
          && runtimeCallbacksRef.current.isLivePriceSafeForCandles(pending.last)) {
          runtimeCallbacksRef.current.syncSupplementalPriceLines?.(pending.ask, pending.last);
        }
      }

      if (queuedVSyncAskPrice !== null && queuedVSyncLastPrice !== null) {
        const ask = queuedVSyncAskPrice;
        const last = queuedVSyncLastPrice;
        const tsSec = queuedVSyncTimeSec;
        queuedVSyncAskPrice = null;
        queuedVSyncLastPrice = null;
        if (canPaintLiveChart(true)) {
          pendingSupplementalPriceLines = null;
          runtimeCallbacksRef.current.syncSupplementalPriceLines?.(ask, last);
        } else {
          pendingSupplementalPriceLines = { ask, last, time: tsSec };
        }
      }

      if (pendingLiveChartPaint && currentCandleRef.current && canPaintLiveChart()) {
        runtimeCallbacksRef.current.flushPostInteractionWork?.();
      }

      const active = currentCandleRef.current;
      if (!active) return;

      const isNew = queuedVSyncNewBar;
      queuedVSyncNewBar = false;
      push(active, isNew);
      repaintLivePriceOverlayOrDefer(active);
    };

    // rAF is paused in background/occluded WebView2 or tabs. Fallback timer paints
    // once if the frame callback has not fired; whichever fires first cancels the other.
    const runWatchdogPaint = () => {
      rafWatchdogTimer = null;
      if (rafPaintId !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafPaintId);
      }
      forceWatchdogPaint = true;
      flushVSyncLivePaint();
    };
    function armRafWatchdog() {
      if (rafWatchdogTimer !== null) return;
      const now = Date.now();
      if (rafDeferralStartedAt === 0) rafDeferralStartedAt = now;
      const remainingCap = Math.max(0, RAF_SUSTAINED_DEFERRAL_CAP_MS - (now - rafDeferralStartedAt));
      rafWatchdogTimer = setTimeout(runWatchdogPaint, Math.min(RAF_WATCHDOG_MS, remainingCap));
    }

    const scheduleVSyncLivePaint = (isNewBar: boolean) => {
      if (isNewBar) queuedVSyncNewBar = true;
      if (rafPaintId !== null) return;
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        rafPaintId = window.requestAnimationFrame(flushVSyncLivePaint);
        armRafWatchdog();
      } else {
        flushVSyncLivePaint();
      }
    };

    const prepareDeferredLiveModel = () => {
      if (!pendingLiveChartPaint || !pendingLiveChartRequiresFullRender) return;
      runtimeCallbacksRef.current.requestChartDataRender?.({
        resetVisibleRange: false,
        reason: 'deferred-live-rollover',
      });
    };

    const paintDeferredLive = (fullModelPainted: boolean) => {
      if (!pendingLiveChartPaint) return;
      const current = currentCandleRef.current;
      const shouldScroll = pendingLiveShouldScrollToRealtime;
      pendingLiveChartPaint = false;
      pendingLiveChartRequiresFullRender = false;
      pendingLiveShouldScrollToRealtime = false;
      if (!current) return;

      if (!fullModelPainted) {
        push(current, false, true);
      } else {
        updateLegendDOMRef.current?.(
          current.open,
          current.high,
          current.low,
          current.close,
          getDisplayVolume(current, chartSettingsRef.current),
        );
      }
      runtimeCallbacksRef.current.repaintLivePriceOverlayFromCurrentPrice?.(current);

      if (
        shouldScroll
        && chartRef.current
        && shouldScrollToRealtime(
          chartRef.current,
          autoScrollEnabledRef.current,
          chartSettingsRef.current.chartAutoScroll,
          getTradingChartShiftRightOffset(getActiveTimeframe(), chartSettingsRef.current.chartShift),
        )
      ) {
        try {
          chartRef.current.timeScale().scrollToPosition(
            getTradingChartShiftRightOffset(getActiveTimeframe(), chartSettingsRef.current.chartShift),
            false,
          );
        } catch { /* chart may be rebuilding */ }
      }
    };

    postInteractionCallbacksRef.current.prepareLiveModel = prepareDeferredLiveModel;
    postInteractionCallbacksRef.current.paintLive = paintDeferredLive;

    // MT5 Continuous Session Rollover: chains Open = prevCandle.Close within active trading sessions
    const rolloverModel = (newTime: number, tickPrice: number, activeTf: AggTimeframe): boolean => {
      if (liveMarketDataFrozenRef.current || isDisposedRef.current) return false;
      if (!currentCandleRef.current) return false;
      const prevTime = Number(currentCandleRef.current.time);
      if (prevTime >= newTime) return false;
      if (!Number.isFinite(tickPrice) || tickPrice <= 0) return false;

      const done = { ...currentCandleRef.current, closed: true };
      candlesRef.current = upsertCandleIntoHistory(candlesRef.current, done).candles;

      const tfs = Math.max(60, getTimeframeSeconds(activeTf));
      const maxContinuousSessionGap = Math.max(tfs * 5, 300);
      const gap = newTime - prevTime;
      let open = tickPrice;
      if (gap > 0 && gap <= maxContinuousSessionGap && done.close > 0) {
        const relDiff = Math.abs(tickPrice - done.close) / done.close;
        if (relDiff < 0.015) {
          open = done.close;
        }
      }

      const newCandle: Candle = {
        time: newTime,
        open,
        high: Math.max(open, tickPrice),
        low: Math.min(open, tickPrice),
        close: tickPrice,
        volume: 1,
        tickVolume: 1,
        closed: false,
      };
      currentCandleRef.current = newCandle;
      syncCandleIntoRef(newCandle);
      return true;
    };

    const reconcileSynchronizedCandleBoundary = (): number | null => {
      if (!synchronizedMarketClockRef.current || liveMarketDataFrozenRef.current) return null;
      const currentCandle = currentCandleRef.current;
      if (!currentCandle) return null;

      const activeTf = getActiveTimeframe() as AggTimeframe;
      const marketNowSeconds = getSynchronizedChartMarketNowMs() / 1000;
      const boundaryOffsetSeconds = brokerTimeOffsetSecRef.current;
      const currentPeriod = getTimeframePeriodSeconds(
        marketNowSeconds,
        activeTf,
        boundaryOffsetSeconds,
      );
      if (!currentPeriod || currentPeriod.startTime <= Number(currentCandle.time)) {
        return null;
      }
      return currentPeriod.startTime;
    };

    scheduleBoundaryTimerRef.current = reconcileSynchronizedCandleBoundary;
    reconcileSynchronizedCandleBoundary();

    const handleSynchronizedClockVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        reconcileSynchronizedCandleBoundary();
        scheduleVSyncLivePaint(false);
      }
    };
    document.addEventListener('visibilitychange', handleSynchronizedClockVisibilityChange);

    // ── Direct Event-Driven Tick Ingestion (Zero 50ms Polling!) ──────────────
    const ingestLiveChartTick = (input: RawLiveChartTickInput) => {
      if (liveEffectClosed || isDisposedRef.current || isRebuildingRef.current || liveMarketDataFrozenRef.current) {
        return;
      }

      if (lastSelectionKey !== chartSelectionPresentationKeyRef.current) {
        lastSelectionKey = chartSelectionPresentationKeyRef.current;
        lastTickKey = '';
      }

      const { rawBid, rawAsk, execBid, execAsk, rawTimestampMs, sequence } = input;
      const price = Number.isFinite(rawBid) && rawBid > 0 ? rawBid : rawAsk;
      if (!Number.isFinite(price) || price <= 0) return;
      if (!Number.isFinite(rawTimestampMs) || rawTimestampMs <= 0) return;

      const activeTf = getActiveTimeframe();

      synchronizeChartMarketClock(rawTimestampMs);
      reconcileSynchronizedCandleBoundary();

      const tickKey = sequence !== undefined
        ? `seq:${sequence}:${rawBid}:${rawAsk}`
        : `${rawTimestampMs}:${rawBid}:${rawAsk}:${price}`;
      if (tickKey === lastTickKey) return;
      lastTickKey = tickKey;

      const livePriceMatchesRenderedScale = runtimeCallbacksRef.current.validateRenderedCandlesAgainstLivePrice(price, activeTf);
      if (!livePriceMatchesRenderedScale || !runtimeCallbacksRef.current.isLivePriceSafeForCandles(price)) {
        const allowDrop = canDropPreloadedCandlesForLiveQuoteMismatch({
          hasDisplayedHistory: hasDisplayedHistoryRef.current,
          protectedHistoryCount: protectedDisplayedHistoryRef.current.length,
          currentHistoryCount: candlesRef.current.length,
        });
        const guard = updateLiveQuoteGuardState({
          lastAcceptedQuote: lastAcceptedQuoteRef.current,
          incompatibleQuoteCount: incompatibleQuoteCountRef.current,
        }, false, price, { allowDrop });
        lastAcceptedQuoteRef.current = guard.state.lastAcceptedQuote;
        incompatibleQuoteCountRef.current = guard.state.incompatibleQuoteCount;

        if (guard.shouldDropCandles) {
          if (runtimeCallbacksRef.current.restoreProtectedDisplayedHistory?.(activeTf, 'live-quote-mismatch-drop')) {
            runtimeCallbacksRef.current.resetLiveQuotePriceGuard?.();
            return;
          }
          if (activeTf === 'M1') {
            runtimeCallbacksRef.current.resetLiveQuotePriceGuard?.();
            return;
          }
          runtimeCallbacksRef.current.cancelQueuedChartRender?.();
          candlesRef.current = [];
          currentCandleRef.current = null;
          prevPriceRef.current = null;
          renderedPriceReferenceRef.current = createRenderedPriceReference([]);
          periodSeparatorsRef.current = [];
          firstRenderedCandleTimeRef.current = null;
          lastRenderedCandlesRef.current = [];
          hasDisplayedHistoryRef.current = false;
          protectedDisplayedHistoryRef.current = [];
          runtimeCallbacksRef.current.clearPeriodSeparators?.();
          resetVisibleRangeOnNextDataRef.current = true;
          leftVisibleTimeRef.current = null;
          lastVisibleLogicalRangeRef.current = null;
          lastStoreCandleSecRef.current = 0;
          runtimeCallbacksRef.current.discardRetainedPublicChartSurface?.();
          try { seriesRef.current?.setData([]); } catch { /* ignore */ }
          try { volumeRef.current?.setData([]); } catch { /* ignore */ }
          runtimeCallbacksRef.current.hideLivePriceOverlay?.();
          candleAggregationService.loadHistoricalCandles(
            symbol,
            activeTf as AggTimeframe,
            [],
            brokerTimeOffsetSecRef.current,
          );
          runtimeCallbacksRef.current.resetLiveQuotePriceGuard?.();
        }
        return;
      } else {
        const guard = updateLiveQuoteGuardState({
          lastAcceptedQuote: lastAcceptedQuoteRef.current,
          incompatibleQuoteCount: incompatibleQuoteCountRef.current,
        }, true, price);
        lastAcceptedQuoteRef.current = guard.state.lastAcceptedQuote;
        incompatibleQuoteCountRef.current = guard.state.incompatibleQuoteCount;
      }

      let ts = rawTimestampMs;
      if (ts > 1_000_000_000_000) ts = Math.floor(ts / 1000);

      if (currentCandleRef.current && ts < currentCandleRef.current.time) {
        return;
      }

      queuedVSyncAskPrice = execAsk;
      queuedVSyncLastPrice = price;
      queuedVSyncTimeSec = ts;

      const aggregationUpdates = candleAggregationService.processTick({
        symbol,
        bid: rawBid,
        ask: rawAsk,
        timestamp: rawTimestampMs,
        volume: 1,
      });
      const aggregationCandles = candleAggregationService.getCandles(
        symbol,
        activeTf as AggTimeframe,
        true,
        false,
      );
      const latestAggregatedCandle = aggregationUpdates.get(activeTf as AggTimeframe)
        ?? aggregationCandles[aggregationCandles.length - 1];
      const tfs = getTimeframeSeconds(activeTf as AggTimeframe);
      const tickPeriod = getTimeframePeriodSeconds(
        ts,
        activeTf as AggTimeframe,
        brokerTimeOffsetSecRef.current,
      );
      const m1DerivedCandle = latestAggregatedCandle && (
        !tickPeriod || latestAggregatedCandle.time === tickPeriod.startTime
      ) ? latestAggregatedCandle : undefined;
      const candleTime = m1DerivedCandle?.time ?? tickPeriod?.startTime
        ?? alignTimeframeBoundarySeconds(ts, activeTf as AggTimeframe, tfs);
      const derivedCurrentCandle: Candle | null = m1DerivedCandle?.time === candleTime
        ? { ...m1DerivedCandle, tickVolume: m1DerivedCandle.volume, closed: false }
        : null;

      if (isCandleAtOrBeforeFinalizedTime(finalizedCandleTimeByTimeframe, activeTf, candleTime)) return;

      const liveMutationGeneration = liveCandleMutationGenerationRef.current + 1;
      liveCandleMutationGenerationRef.current = liveMutationGeneration;
      const liveMutationTime = Number(candleTime);
      liveCandleMutationGenerationByTimeRef.current.delete(liveMutationTime);
      liveCandleMutationGenerationByTimeRef.current.set(liveMutationTime, liveMutationGeneration);
      while (liveCandleMutationGenerationByTimeRef.current.size > 256) {
        const oldestTrackedTime = liveCandleMutationGenerationByTimeRef.current.keys().next().value;
        if (oldestTrackedTime === undefined) break;
        liveCandleMutationGenerationByTimeRef.current.delete(oldestTrackedTime);
      }

      let isNewBar = false;
      if (!currentCandleRef.current) {
        currentCandleRef.current = derivedCurrentCandle
          ?? { time: candleTime, open: price, high: price, low: price, close: price, volume: 1, tickVolume: 1, closed: false };
        syncCandleIntoRef(currentCandleRef.current);
        isNewBar = true;
      } else if (candleTime > currentCandleRef.current.time) {
        isNewBar = rolloverModel(candleTime, price, activeTf as AggTimeframe);
        if (currentCandleRef.current && currentCandleRef.current.time === candleTime && derivedCurrentCandle) {
          // Preserve chained MT5 open while folding in any wider derived high/low envelope
          const chainedOpen = currentCandleRef.current.open;
          currentCandleRef.current = {
            ...mergeFormingCandleEnvelope(currentCandleRef.current, derivedCurrentCandle),
            open: chainedOpen,
            high: Math.max(chainedOpen, currentCandleRef.current.high, derivedCurrentCandle.high),
            low: Math.min(chainedOpen, currentCandleRef.current.low, derivedCurrentCandle.low),
            closed: false,
          };
          syncCandleIntoRef(currentCandleRef.current);
        }
      } else {
        if (derivedCurrentCandle && derivedCurrentCandle.time === currentCandleRef.current.time) {
          const existingOpen = currentCandleRef.current.open;
          currentCandleRef.current = {
            ...mergeFormingCandleEnvelope(currentCandleRef.current, derivedCurrentCandle),
            open: existingOpen,
            high: Math.max(existingOpen, currentCandleRef.current.high, derivedCurrentCandle.high, price),
            low: Math.min(existingOpen, currentCandleRef.current.low, derivedCurrentCandle.low, price),
            close: price,
            closed: false,
          };
        } else {
          currentCandleRef.current = {
            ...applyTickToFormingCandle(currentCandleRef.current, price),
            closed: false,
          };
        }
        syncCandleIntoRef(currentCandleRef.current);
      }

      scheduleVSyncLivePaint(isNewBar);

      // SL/TP cross server-refresh detection
      activeTradeSnapshotsRef.current.forEach((trade) => {
        if (tradeLevelCrossRefreshPendingRef.current.has(trade.key)) return;
        let shouldRefreshForCross = false;
        if (trade.side === 'BUY') {
          if (trade.sl != null && trade.sl > 0 && execBid <= trade.sl) shouldRefreshForCross = true;
          if (trade.tp != null && trade.tp > 0 && execBid >= trade.tp) shouldRefreshForCross = true;
        } else {
          if (trade.sl != null && trade.sl > 0 && execAsk >= trade.sl) shouldRefreshForCross = true;
          if (trade.tp != null && trade.tp > 0 && execAsk <= trade.tp) shouldRefreshForCross = true;
        }

        if (shouldRefreshForCross) {
          tradeLevelCrossRefreshPendingRef.current.add(trade.key);
          const crossDispatchNow = Date.now();
          if (crossDispatchNow - lastCrossRefreshDispatchAtRef.current >= TRADE_LEVEL_CROSS_REFRESH_MIN_DISPATCH_INTERVAL_MS) {
            lastCrossRefreshDispatchAtRef.current = crossDispatchNow;
            window.dispatchEvent(new Event('rtx:force-refresh-positions'));
            const login = Number.parseInt(String(useAppStore.getState().accountId ?? ''), 10);
            if (Number.isFinite(login) && login > 0) {
              window.dispatchEvent(new CustomEvent('rtx:refresh-trade-history-requested', {
                detail: { login },
              }));
            }
          }
          window.setTimeout(() => {
            tradeLevelCrossRefreshPendingRef.current.delete(trade.key);
          }, 2500);
        }
      });
    };

    // Subscribe directly to raw Binary TCP ticks in Desktop/TCP mode (or QuoteSocketManager in browser mode)
    let unsubscribeTickSource: () => void;
    if (isDesktopBackendTarget()) {
      unsubscribeTickSource = binaryTcpMarketStream.onDirectChartTick(symbol, (bt: DecodedBinaryTick) => {
        const widened = applyAccountSpreadMarkup(symbol, {
          symbol,
          bid: bt.bid,
          ask: bt.ask,
          spread: bt.spread,
          timestamp: bt.timestamp,
        });
        ingestLiveChartTick({
          rawBid: bt.bid,
          rawAsk: bt.ask,
          execBid: Number(widened.bid ?? bt.bid),
          execAsk: Number(widened.ask ?? bt.ask),
          rawTimestampMs: bt.sourceTimestamp || bt.timestamp,
          sequence: bt.sequence,
        });
      });
    } else {
      unsubscribeTickSource = getQuoteSocketManager().onQuoteSnapshot(symbol, (tick) => {
        const rawSides = getRawQuoteSides(tick);
        const rawBid = Number(rawSides?.bid ?? tick.bid);
        const rawAsk = Number(rawSides?.ask ?? tick.ask ?? rawBid);
        ingestLiveChartTick({
          rawBid,
          rawAsk,
          execBid: Number(tick.bid ?? rawBid),
          execAsk: Number(tick.ask ?? rawAsk),
          rawTimestampMs: Number(tick.sourceTimestamp ?? tick.timestamp),
        });
      });
    }

    // Seed once immediately if window.rtxTickCache already has a quote
    const warmCachedTick = typeof window !== 'undefined' && window.rtxTickCache
      ? (window.rtxTickCache.get(symbol) ?? window.rtxTickCache.get(normalizedSymbol))
      : undefined;
    if (warmCachedTick) {
      const rawSides = getRawQuoteSides(warmCachedTick);
      const rawBid = Number(rawSides?.bid ?? warmCachedTick.bid);
      const rawAsk = Number(rawSides?.ask ?? warmCachedTick.ask ?? rawBid);
      const warmTs = Number(warmCachedTick.sourceTimestamp ?? warmCachedTick.timestamp);
      if (Number.isFinite(rawBid) && rawBid > 0 && Number.isFinite(warmTs) && warmTs > 0) {
        ingestLiveChartTick({
          rawBid,
          rawAsk,
          execBid: Number(warmCachedTick.bid ?? rawBid),
          execAsk: Number(warmCachedTick.ask ?? rawAsk),
          rawTimestampMs: warmTs,
        });
      }
    }

    // ── Server-Confirmed Authoritative Candles (0x22 BinaryCandle Frames) ────
    const applyServerCandle = (
      c: Candle,
      source: CandleCacheSource = 'backend',
      candleTimeframe: AggTimeframe = 'M1',
    ) => {
      if (liveEffectClosed || isDisposedRef.current || isRebuildingRef.current) return;
      if (liveMarketDataFrozenRef.current) return;
      const [reconciled] = runtimeCallbacksRef.current.reconcileCandlesWithLiveQuote([c], 'stream update');
      if (!reconciled) return;
      c = reconciled;
      c = resolveCanonicalServerCandle(currentCandleRef.current, c);
      const activeTf = getActiveTimeframe();
      if (!runtimeCallbacksRef.current.validateRenderedCandlesAgainstLivePrice(c.close, activeTf)) return;
      runtimeCallbacksRef.current.mergeHistoryCache?.(
        activeTf,
        [c],
        brokerTimeOffsetSecRef.current,
        source,
      );

      if (c.closed === true) {
        const activePeriodStart = getTimeframePeriodSeconds(
          getSynchronizedChartMarketNowMs() / 1000,
          candleTimeframe,
          brokerTimeOffsetSecRef.current,
        )?.startTime;
        if (!Number.isFinite(activePeriodStart) || c.time < Number(activePeriodStart)) {
          markFinalizedCandleTime(finalizedCandleTimeByTimeframe, candleTimeframe, c.time);
        }
        candlesRef.current = mergeBackendCandlePage(candlesRef.current, [c]).candles;
        if (!currentCandleRef.current || c.time >= currentCandleRef.current.time) {
          currentCandleRef.current = { ...c };
        }
        runtimeCallbacksRef.current.updateChartData?.(candlesRef.current, undefined, {
          reason: 'server-final-candle-replacement',
        });
        if (currentCandleRef.current?.time === c.time) {
          repaintLivePriceOverlayOrDefer(currentCandleRef.current);
        }
        return;
      }

      if (currentCandleRef.current && c.time < currentCandleRef.current.time) {
        syncCandleIntoRef(c);
        runtimeCallbacksRef.current.updateChartData?.(candlesRef.current, undefined, {
          reason: 'server-candle-history-correction',
        });
        return;
      }

      if (currentCandleRef.current && c.time === currentCandleRef.current.time) {
        // Server M1 forming candle carries authoritative chained Open & High/Low envelope
        currentCandleRef.current = {
          ...mergeFormingCandleEnvelope(currentCandleRef.current, c),
          open: c.open,
          high: Math.max(c.open, currentCandleRef.current.high, c.high),
          low: Math.min(c.open, currentCandleRef.current.low, c.low),
          closed: false,
        };
        syncCandleIntoRef(currentCandleRef.current);
        if (runtimeCallbacksRef.current.isPotentialMarketClosedPlaceholder?.(currentCandleRef.current)) {
          runtimeCallbacksRef.current.updateChartData?.(candlesRef.current);
        } else {
          refreshMarketGapSeriesForCandle(currentCandleRef.current);
          scheduleVSyncLivePaint(false);
        }
        return;
      }

      if (!currentCandleRef.current) {
        currentCandleRef.current = { ...c };
        syncCandleIntoRef(currentCandleRef.current);
        if (runtimeCallbacksRef.current.isPotentialMarketClosedPlaceholder?.(currentCandleRef.current)) {
          runtimeCallbacksRef.current.updateChartData?.(candlesRef.current);
        } else {
          refreshMarketGapSeriesForCandle(currentCandleRef.current);
          scheduleVSyncLivePaint(true);
        }
        return;
      }

      if (c.time > currentCandleRef.current.time) {
        const activeTf = getActiveTimeframe() as AggTimeframe;
        rolloverModel(c.time, c.close, activeTf);
        if (currentCandleRef.current && currentCandleRef.current.time === c.time) {
          currentCandleRef.current = { ...c };
          syncCandleIntoRef(currentCandleRef.current);
          if (runtimeCallbacksRef.current.isPotentialMarketClosedPlaceholder?.(currentCandleRef.current)) {
            runtimeCallbacksRef.current.updateChartData?.(candlesRef.current);
          } else {
            refreshMarketGapSeriesForCandle(currentCandleRef.current);
            scheduleVSyncLivePaint(true);
          }
        }
      }
    };

    const streamTimeframe: AggTimeframe = 'M1';
    const getDisplayedStreamTimeframe = (): AggTimeframe => (
      getActiveTimeframe() as AggTimeframe
    );
    const classifyServerM1CandleFinality = (candle: Candle): Candle => {
      if (typeof candle.closed === 'boolean') return candle;
      const marketNowSeconds = getSynchronizedChartMarketNowMs() / 1000;
      const activeM1Period = getTimeframePeriodSeconds(
        marketNowSeconds,
        'M1',
        brokerTimeOffsetSecRef.current,
      );
      return resolveCandleFinalityFromActivePeriod(candle, activeM1Period?.startTime);
    };
    const resolveServerM1LiveClose = (candle: Candle): Candle => {
      const quote = window.rtxTickCache?.get(normalizedSymbol)
        ?? useAppStore.getState().ticks[normalizedSymbol];
      return resolveFormingCandleLiveClose(candle, quote, symbol, 'M1', brokerTimeOffsetSecRef.current);
    };
    const reconcileServerM1Candle = (candle: Candle): Candle => {
      const classifiedCandle = resolveServerM1LiveClose(classifyServerM1CandleFinality(candle));
      const [m1] = formatHistoryForOhlcv([classifiedCandle]);
      if (!m1) return classifiedCandle;
      candleAggregationService.reconcileServerCandle(
        symbol,
        'M1',
        m1,
        classifiedCandle.closed === true,
      );
      return classifiedCandle;
    };
    const applyLatestM1DerivedServerCandle = () => {
      const displayedStreamTimeframe = getDisplayedStreamTimeframe();
      if (displayedStreamTimeframe === 'M1') return;
      const derivedCandles = candleAggregationService.getCandles(
        symbol,
        displayedStreamTimeframe,
        true,
        false,
      );
      const latest = derivedCandles[derivedCandles.length - 1];
      if (latest) {
        const activePeriodStart = getTimeframePeriodSeconds(
          getSynchronizedChartMarketNowMs() / 1000,
          displayedStreamTimeframe,
          brokerTimeOffsetSecRef.current,
        )?.startTime;
        const isClosedBucket = latest.isComplete === true
          && Number.isFinite(activePeriodStart)
          && latest.time < Number(activePeriodStart);
        applyServerCandle(
          { ...latest, tickVolume: latest.volume, closed: isClosedBucket },
          'derived-m1',
          displayedStreamTimeframe,
        );
      }
    };

    const candleStream = chartDataService.subscribeCandles({
      symbol,
      timeframe: streamTimeframe,
      onSnapshot: (snapshot) => {
        if (liveEffectClosed || isDisposedRef.current || isRebuildingRef.current || snapshot.length === 0) return;
        if (liveMarketDataFrozenRef.current) return;
        const rawSnapshot = getValidSortedCandles(snapshot as Candle[])
          .map(classifyServerM1CandleFinality).map(resolveServerM1LiveClose);
        const reconciledSnapshot = runtimeCallbacksRef.current.reconcileCandlesWithLiveQuote(rawSnapshot, 'stream snapshot');
        if (reconciledSnapshot.length === 0) return;
        const displayedStreamTimeframe = getDisplayedStreamTimeframe();
        const activePeriodStart = getTimeframePeriodSeconds(
          getSynchronizedChartMarketNowMs() / 1000,
          displayedStreamTimeframe,
          brokerTimeOffsetSecRef.current,
        )?.startTime;
        let displaySnapshot = reconciledSnapshot;
        if (displayedStreamTimeframe !== 'M1') {
          const existingM1: Candle[] = candleAggregationService.getCandles(symbol, 'M1', true, false)
            .map((candle) => ({ ...candle, closed: candle.isComplete === true }));
          const latestM1 = existingM1[existingM1.length - 1];
          const m1Seed = mergeAuthoritativeCandleHistory(existingM1, reconciledSnapshot, {
            formingLiveCandle: latestM1,
            hasNewerLiveMutation: liveCandleMutationGenerationRef.current > 0,
          });
          candleAggregationService.loadHistoricalCandles(
            symbol,
            'M1',
            m1Seed.map((candle) => ({ ...candle, isComplete: candle.closed })),
            brokerTimeOffsetSecRef.current,
          );
          const derived = aggregateM1CandlesToTimeframe(
            reconciledSnapshot,
            displayedStreamTimeframe,
            brokerTimeOffsetSecRef.current,
          ).map((candle) => ({ ...candle, volume: candle.volume ?? 0 }));
          displaySnapshot = omitPartialLeadingM1Aggregate(
            derived,
            reconciledSnapshot[0].time,
            displayedStreamTimeframe,
            brokerTimeOffsetSecRef.current,
          ).map((candle) => resolveCandleFinalityFromActivePeriod(candle, activePeriodStart));
          if (displaySnapshot.length === 0) return;
        }
        const activeFormingCandle = currentCandleRef.current;
        const protectedSnapshot = activeFormingCandle
          ? displaySnapshot.map((snapshotCandle) => (
            resolveCanonicalServerCandle(activeFormingCandle, snapshotCandle)
          ))
          : displaySnapshot;
        protectedSnapshot.forEach((snapshotCandle) => {
          if (
            snapshotCandle.closed === true
            && (displayedStreamTimeframe === 'M1' || !Number.isFinite(activePeriodStart) || snapshotCandle.time < Number(activePeriodStart))
          ) {
            markFinalizedCandleTime(finalizedCandleTimeByTimeframe, displayedStreamTimeframe, snapshotCandle.time);
          }
        });
        if (displayedStreamTimeframe === 'M1') {
          candleAggregationService.loadHistoricalCandles(
            symbol,
            'M1',
            formatHistoryForOhlcv(protectedSnapshot).map((candle, index) => ({
              ...candle,
              isComplete: protectedSnapshot[index].closed,
            })),
            brokerTimeOffsetSecRef.current,
          );
          const explicitFinal = [...protectedSnapshot].reverse().find((item) => item.closed === true);
          if (explicitFinal) reconcileServerM1Candle(explicitFinal);
        }
        const latestClose = protectedSnapshot[protectedSnapshot.length - 1]?.close;
        if (latestClose && !runtimeCallbacksRef.current.validateRenderedCandlesAgainstLivePrice(latestClose, displayedStreamTimeframe)) return;
        const hasNewerLiveSnapshotMutation = Boolean(
          activeFormingCandle
          && liveCandleMutationGenerationByTimeRef.current.has(activeFormingCandle.time),
        );
        candlesRef.current = mergeAuthoritativeCandleHistory(candlesRef.current, protectedSnapshot, {
          formingLiveCandle: activeFormingCandle,
          hasNewerLiveMutation: hasNewerLiveSnapshotMutation,
        });
        runtimeCallbacksRef.current.setHistoryCache?.(
          displayedStreamTimeframe,
          candlesRef.current,
          brokerTimeOffsetSecRef.current,
          displayedStreamTimeframe === 'M1' ? 'backend' : 'derived-m1',
        );
        runtimeCallbacksRef.current.updateChartData?.(candlesRef.current, undefined, {
          immediate: true,
          releaseLivePaintAfterRender: true,
          finishLoadingAfterRender: !initialHistoryLoadPendingRef.current
            || protectedSnapshot.length >= getStartupSnapshotCandleCount(displayedStreamTimeframe),
          reason: 'stream-snapshot',
        });
        currentCandleRef.current = candlesRef.current[candlesRef.current.length - 1] ?? currentCandleRef.current;
        if (currentCandleRef.current) {
          repaintLivePriceOverlayOrDefer(currentCandleRef.current);
        }
      },
      onCandle: (candle) => {
        if (liveEffectClosed) return;
        const [validatedCandle] = runtimeCallbacksRef.current.reconcileCandlesWithLiveQuote(
          [classifyServerM1CandleFinality(candle)],
          'stream update',
        );
        if (!validatedCandle) return;
        const displayedStreamTimeframe = getDisplayedStreamTimeframe();
        if (displayedStreamTimeframe === 'M1') {
          applyServerCandle(reconcileServerM1Candle(validatedCandle), 'backend', 'M1');
          return;
        }
        reconcileServerM1Candle(validatedCandle);
        applyLatestM1DerivedServerCandle();
      },
      onConnected: () => {
        if (!liveEffectClosed) setApiError('');
      },
      onError: (error) => {
        if (!liveEffectClosed) setApiError(error.message);
      },
    });

    return () => {
      liveEffectClosed = true;
      clearRafWatchdog();
      if (rafPaintId !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafPaintId);
        rafPaintId = null;
      }
      unsubscribeTickSource();
      candleStream.close();
      document.removeEventListener('visibilitychange', handleSynchronizedClockVisibilityChange);
      if (scheduleBoundaryTimerRef.current === reconcileSynchronizedCandleBoundary) {
        scheduleBoundaryTimerRef.current = () => undefined;
      }
      if (postInteractionCallbacksRef.current.prepareLiveModel === prepareDeferredLiveModel) {
        postInteractionCallbacksRef.current.prepareLiveModel = () => undefined;
      }
      if (postInteractionCallbacksRef.current.paintLive === paintDeferredLive) {
        postInteractionCallbacksRef.current.paintLive = () => undefined;
      }
      postInteractionCoordinatorRef.current?.clear();
    };
  }, [
    symbol,
    authToken,
    applyAreaTrendColors,
    brokerAccountSessionScope,
    getSynchronizedChartMarketNowMs,
    synchronizeChartMarketClock,
  ]);
};
