import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  candleAggregationService,
  type OHLCV,
  type Timeframe as AggTimeframe,
} from '../../services/candleAggregationService';
import { candleCache } from '../../services/candleCache';
import { chartDataService } from '../../services/chartDataService';
import { useAppStore } from '../../store/useAppStore';
import type { ChartProperties, ColorScheme } from '../../store/useChartSettingsStore';
import { useMarketDataStore } from '../../store/useMarketDataStore';
import type { ChartType, TradingViewChartTheme } from '../../types/chart';
import { formatChartAxisPrice, inferObservedPriceDigits } from '../../utils/chartPriceScale';
import { readRegisteredSymbolPriceSpec } from '../../services/dailyChangePriceModeRegistry';
import { resolveSpecDigits } from '../../utils/symbolUtils';
import { getLivePriceOverlayColors, getLivePriceSeriesColor } from '../TradingChart.helpers';
import { aggregateM1CandlesToTimeframe } from '../../services/derivedTimeframeHistoryService';
import { useUiTranslation } from '../../hooks/useUiTranslation';

interface ChartPropertiesPreviewChartProps {
  symbol: string;
  timeframe: string;
  chartType: ChartType;
  effectiveColors: ChartProperties['colors'];
  previewTheme: TradingViewChartTheme;
  colorScheme: ColorScheme;
  onPanOffsetPxChange?: (panOffsetPx: number) => void;
}

interface PreviewCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PreviewViewState {
  visibleBars: number;
  panRightBars: number;
  verticalShiftRatio: number;
  priceZoom: number;
}

interface DragSession {
  mode: 'pan' | 'priceScale';
  pointerId: number;
  startX: number;
  startY: number;
  startView: PreviewViewState;
}

const DEFAULT_VISIBLE_BARS = 24;
const MIN_VISIBLE_BARS = 8;
const MAX_VISIBLE_BARS = 96;
const DEFAULT_VIEW_STATE: PreviewViewState = {
  visibleBars: DEFAULT_VISIBLE_BARS,
  panRightBars: 0,
  verticalShiftRatio: 0,
  priceZoom: 1,
};

const clamp = (value: number, min: number, max: number): number => (
  Math.max(min, Math.min(max, value))
);

const buildFallbackPreviewCandles = (anchorPrice?: number): PreviewCandle[] => {
  const base = anchorPrice && Number.isFinite(anchorPrice) && anchorPrice > 0 ? anchorPrice : 1.0864;
  const step = base * 0.00045;
  const nowSec = Math.floor(Date.now() / 60_000) * 60;
  const deltas = [
    -3.2, -2.5, -2.9, -1.8, -2.2, -1.2, -1.7, -0.9, -1.4, -0.5,
    0.2, -0.4, 0.6, 1.3, 0.8, 1.7, 1.1, 0.3, -0.5, -1.1,
    -0.4, 0.5, 1.2, 0.7, 1.6, 2.2, 1.5, 0.9, 1.8, 2.4,
    1.7, 2.5, 2.9, 2.2, 1.4, 0,
  ];
  const candles: PreviewCandle[] = [];
  let prevClose = base + deltas[0] * step;
  for (let i = 0; i < deltas.length; i += 1) {
    const close = i === deltas.length - 1 && anchorPrice ? anchorPrice : base + deltas[i] * step;
    const open = prevClose;
    const bodyMax = Math.max(open, close);
    const bodyMin = Math.min(open, close);
    const wickScale = ((i % 3) + 1) * step * 0.35;
    candles.push({
      time: nowSec - (deltas.length - 1 - i) * 60,
      open,
      high: bodyMax + wickScale,
      low: bodyMin - wickScale * 0.9,
      close,
      volume: 120 + ((i * 37) % 240),
    });
    prevClose = close;
  }
  return candles;
};

const mergeLiveAndCachedCandles = (
  cached: readonly { time: number; open: number; high: number; low: number; close: number; volume?: number; tickVolume?: number; closed?: boolean }[],
  aggregated: readonly OHLCV[],
): PreviewCandle[] => {
  const byTime = new Map<number, PreviewCandle>();
  for (const bar of cached) {
    if (!Number.isFinite(bar?.time) || bar.time <= 0) continue;
    if (!Number.isFinite(bar.open) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close)) continue;
    byTime.set(bar.time, {
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: Number(bar.tickVolume ?? bar.volume ?? 0) || 0,
    });
  }
  for (const bar of aggregated) {
    if (!Number.isFinite(bar?.time) || bar.time <= 0) continue;
    if (!Number.isFinite(bar.open) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close)) continue;
    const existing = byTime.get(bar.time);
    if (!existing || !bar.isComplete) {
      byTime.set(bar.time, {
        time: bar.time,
        open: existing ? existing.open : bar.open,
        high: existing ? Math.max(existing.high, bar.high) : bar.high,
        low: existing ? Math.min(existing.low, bar.low) : bar.low,
        close: bar.close,
        volume: Math.max(existing?.volume ?? 0, Number(bar.volume ?? 0) || 0),
      });
    }
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
};

const formatPreviewTimeLabel = (unixSec: number, timeframe: string): string => {
  const date = new Date(unixSec * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const tf = timeframe.toUpperCase();
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mon = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  if (tf === 'D1' || tf === 'W1' || tf === 'MN') {
    return `${dd} ${mon}`;
  }
  return `${hh}:${mm}`;
};

export const ChartPropertiesPreviewChart: React.FC<ChartPropertiesPreviewChartProps> = ({
  symbol,
  timeframe,
  chartType,
  effectiveColors,
  previewTheme,
  colorScheme,
  onPanOffsetPxChange,
}) => {
  const tr = useUiTranslation();
  const normalizedSymbol = symbol.trim().toUpperCase();
  const normalizedTf = (timeframe || 'M1').trim().toUpperCase() as AggTimeframe;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const [surfaceSize, setSurfaceSize] = useState({ width: 496, height: 168 });
  const [isDragging, setIsDragging] = useState(false);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [viewState, setViewState] = useState<PreviewViewState>(DEFAULT_VIEW_STATE);

  const symbolData = useMarketDataStore((state) => (
    normalizedSymbol ? state.symbolData[normalizedSymbol] : undefined
  ));
  const appTick = useAppStore((state) => (
    normalizedSymbol ? state.ticks[normalizedSymbol] ?? state.ticks[symbol] : undefined
  ));

  useEffect(() => {
    const element = surfaceRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const syncSize = () => {
      const nextWidth = Math.round(element.clientWidth);
      const nextHeight = Math.round(element.clientHeight);
      if (nextWidth > 40 && nextHeight > 40) {
        setSurfaceSize((current) => (
          current.width === nextWidth && current.height === nextHeight
            ? current
            : { width: nextWidth, height: nextHeight }
        ));
      }
    };
    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const tickRevision = symbolData?.tickBufferRevision ?? 0;
  const liveBidRaw = Number(symbolData?.currentTick?.bid ?? appTick?.bid ?? 0);
  const liveAskRaw = Number(symbolData?.currentTick?.ask ?? appTick?.ask ?? 0);
  const liveLastRaw = Number(appTick?.last ?? 0);

  const {
    allCandles,
    hasLiveMarketCandles,
    digits,
    liveBid,
  } = useMemo(() => {
    void tickRevision;
    let aggCandles = normalizedSymbol
      ? candleAggregationService.getCandles(normalizedSymbol, normalizedTf, true, false)
      : [];
    if (aggCandles.length < 2 && normalizedSymbol && normalizedTf !== 'M1') {
      const m1Candles = candleAggregationService.getCandles(normalizedSymbol, 'M1', true, false);
      if (m1Candles.length >= 2) {
        aggCandles = aggregateM1CandlesToTimeframe(m1Candles, normalizedTf);
      }
    }
    const apiTimeframe = chartDataService.normalizeTimeframe(normalizedTf);
    const cachedEntry = normalizedSymbol
      ? candleCache.getLatestForSymbolTimeframe(chartDataService.getCandleCacheScope(), normalizedSymbol, apiTimeframe)
      : null;

    const merged = normalizedSymbol
      ? mergeLiveAndCachedCandles(cachedEntry?.candles ?? [], aggCandles)
      : [];
    const hasLiveCandles = merged.length >= 2;
    const baseAnchor = liveBidRaw > 0
      ? liveBidRaw
      : liveLastRaw > 0
        ? liveLastRaw
        : undefined;
    const candles = (hasLiveCandles ? merged : buildFallbackPreviewCandles(baseAnchor)).slice(-160);

    if (liveBidRaw > 0 && candles.length > 0) {
      const last = candles[candles.length - 1];
      candles[candles.length - 1] = {
        ...last,
        close: liveBidRaw,
        high: Math.max(last.high, liveBidRaw),
        low: Math.min(last.low, liveBidRaw),
      };
    }

    const latestClose = candles[candles.length - 1]?.close ?? 1.0864;
    const resolvedBid = liveBidRaw > 0 ? liveBidRaw : latestClose;
    const defaultSpread = resolvedBid >= 100 ? resolvedBid * 0.00018 : resolvedBid * 0.00012;
    const resolvedAsk = liveAskRaw > resolvedBid
      ? liveAskRaw
      : liveAskRaw > 0 && liveBidRaw > 0
        ? liveAskRaw
        : resolvedBid + defaultSpread;
    const registeredSpecDigits = normalizedSymbol
      ? readRegisteredSymbolPriceSpec(normalizedSymbol).digits
      : undefined;
    const resolvedDigits = resolveSpecDigits(
      registeredSpecDigits,
      symbolData?.currentTick?.digits,
      appTick?.digits,
    ) ?? inferObservedPriceDigits(candles.slice(-24), [resolvedBid, resolvedAsk]) ?? 4;

    return {
      allCandles: candles,
      hasLiveMarketCandles: hasLiveCandles || liveBidRaw > 0,
      digits: resolvedDigits,
      liveBid: resolvedBid,
    };
  }, [
    appTick?.digits,
    liveAskRaw,
    liveBidRaw,
    liveLastRaw,
    normalizedSymbol,
    normalizedTf,
    symbolData?.currentTick?.digits,
    tickRevision,
  ]);

  const width = surfaceSize.width;
  const height = surfaceSize.height;
  const axisWidth = 68;
  const timeAxisHeight = 16;
  const plotLeft = 0;
  const plotRight = Math.max(140, width - axisWidth);
  const plotTop = 18;
  const plotBottom = Math.max(52, height - timeAxisHeight);
  const pricePlotBottom = Math.max(plotTop + 26, plotBottom - 4);
  const plotHeight = Math.max(24, pricePlotBottom - plotTop);

  const visibleBars = clamp(viewState.visibleBars, MIN_VISIBLE_BARS, Math.min(MAX_VISIBLE_BARS, Math.max(24, allCandles.length)));
  const barPitch = Math.max(4, plotRight / visibleBars);
  const rightMarginOffset = 0.8;
  const maxPanBars = Math.max(0, allCandles.length - 4);
  const clampedPanBars = clamp(viewState.panRightBars, -3, maxPanBars);
  const endFloatIndex = allCandles.length - 1 - clampedPanBars;

  const xForIndex = (index: number): number => (
    plotRight - (barPitch * rightMarginOffset) - ((endFloatIndex - index) * barPitch)
  );

  const visibleIndexedCandles: Array<{ candle: PreviewCandle; index: number; x: number }> = [];
  let minVisiblePrice = Number.POSITIVE_INFINITY;
  let maxVisiblePrice = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < allCandles.length; index += 1) {
    const x = xForIndex(index);
    if (x < plotLeft - barPitch || x > plotRight + barPitch) continue;
    const candle = allCandles[index];
    visibleIndexedCandles.push({ candle, index, x });
    if (candle.low < minVisiblePrice) minVisiblePrice = candle.low;
    if (candle.high > maxVisiblePrice) maxVisiblePrice = candle.high;
  }

  if (visibleIndexedCandles.length === 0 && allCandles.length > 0) {
    const fallbackStart = Math.max(0, allCandles.length - visibleBars);
    for (let index = fallbackStart; index < allCandles.length; index += 1) {
      const candle = allCandles[index];
      const x = xForIndex(index);
      visibleIndexedCandles.push({ candle, index, x });
      if (candle.low < minVisiblePrice) minVisiblePrice = candle.low;
      if (candle.high > maxVisiblePrice) maxVisiblePrice = candle.high;
    }
  }

  const nearLiveEdge = clampedPanBars <= 1.5;
  if (nearLiveEdge) {
    minVisiblePrice = Math.min(minVisiblePrice, liveBid);
    maxVisiblePrice = Math.max(maxVisiblePrice, liveBid);
  }

  if (!Number.isFinite(minVisiblePrice) || !Number.isFinite(maxVisiblePrice)) {
    minVisiblePrice = liveBid * 0.998;
    maxVisiblePrice = liveBid * 1.002;
  }

  const rawSpan = Math.max(Math.abs(maxVisiblePrice - minVisiblePrice), Math.abs(liveBid || 1) * 0.0005);
  const midPrice = (minVisiblePrice + maxVisiblePrice) / 2;
  const zoomedHalfSpan = (rawSpan * 0.62) / viewState.priceZoom;
  const verticalShift = viewState.verticalShiftRatio * (zoomedHalfSpan * 2);
  const rangeMin = midPrice - zoomedHalfSpan + verticalShift;
  const rangeMax = midPrice + zoomedHalfSpan + verticalShift;
  const priceSpan = Math.max(1e-9, rangeMax - rangeMin);

  const yForPrice = (price: number): number => (
    plotTop + ((rangeMax - price) / priceSpan) * plotHeight
  );
  const priceForY = (y: number): number => (
    rangeMax - ((y - plotTop) / plotHeight) * priceSpan
  );

  const candleWidth = clamp(Math.floor(barPitch * 0.62), 2, 12);
  const halfTick = Math.max(2, Math.floor(candleWidth * 0.5));

  const isSlatePreset = colorScheme === 'Green and White' || colorScheme === 'Green and Blue';
  const liveBidLineColor = isSlatePreset
    ? effectiveColors.bidPriceLine
    : getLivePriceSeriesColor(effectiveColors, chartType, (allCandles[allCandles.length - 1]?.close ?? 0) >= (allCandles[allCandles.length - 1]?.open ?? 0) ? 'up' : 'down');
  const bidBadgeColor = getLivePriceOverlayColors(effectiveColors, effectiveColors.bidPriceLine || liveBidLineColor);

  const closeLinePoints = visibleIndexedCandles
    .map(({ candle, x }) => `${x.toFixed(1)},${clamp(yForPrice(candle.close), plotTop - 4, pricePlotBottom + 4).toFixed(1)}`)
    .join(' ');
  const areaFillPath = visibleIndexedCandles.length >= 2
    ? `M ${visibleIndexedCandles[0].x.toFixed(1)} ${yForPrice(visibleIndexedCandles[0].candle.close).toFixed(1)} `
      + `${visibleIndexedCandles.slice(1).map(({ candle, x }) => `L ${x.toFixed(1)} ${yForPrice(candle.close).toFixed(1)}`).join(' ')} `
      + `L ${visibleIndexedCandles[visibleIndexedCandles.length - 1].x.toFixed(1)} ${plotBottom} `
      + `L ${visibleIndexedCandles[0].x.toFixed(1)} ${plotBottom} Z`
    : '';

  const priceTicks = [
    rangeMax - priceSpan * 0.16,
    rangeMax - priceSpan * 0.5,
    rangeMax - priceSpan * 0.84,
  ];
  const timeTicks = visibleIndexedCandles.length >= 3
    ? [
        visibleIndexedCandles[Math.floor(visibleIndexedCandles.length * 0.18)],
        visibleIndexedCandles[Math.floor(visibleIndexedCandles.length * 0.5)],
        visibleIndexedCandles[Math.floor(visibleIndexedCandles.length * 0.82)],
      ].filter((item): item is { candle: PreviewCandle; index: number; x: number } => (
        Boolean(item) && item.x > plotLeft + 18 && item.x < plotRight - 18
      ))
    : [];

  let hoveredCandle: PreviewCandle | null = null;
  let hoveredPrice: number | null = null;
  let hoveredTimeLabel: string | null = null;
  if (hoverPos && hoverPos.x >= plotLeft && hoverPos.x <= plotRight && hoverPos.y >= plotTop && hoverPos.y <= plotBottom) {
    hoveredPrice = priceForY(hoverPos.y);
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const item of visibleIndexedCandles) {
      const distance = Math.abs(item.x - hoverPos.x);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        hoveredCandle = item.candle;
      }
    }
    if (hoveredCandle) {
      hoveredTimeLabel = formatPreviewTimeLabel(hoveredCandle.time, normalizedTf);
    }
  }

  const hudCandle = hoveredCandle ?? allCandles[allCandles.length - 1] ?? null;

  const updatePanOffsetCallback = useCallback((nextPanBars: number) => {
    onPanOffsetPxChange?.(nextPanBars * barPitch);
  }, [barPitch, onPanOffsetPxChange]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    dragSessionRef.current = {
      mode: localX >= plotRight ? 'priceScale' : 'pan',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startView: viewState,
    };
    setIsDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom does not implement setPointerCapture
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    if (localX >= 0 && localX <= width && localY >= 0 && localY <= height) {
      setHoverPos({ x: localX, y: localY });
    }

    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;

    if (session.mode === 'priceScale') {
      const nextPriceZoom = clamp(session.startView.priceZoom * Math.exp(-dy / 90), 0.4, 3.0);
      setViewState((current) => ({ ...current, priceZoom: nextPriceZoom }));
      return;
    }

    const nextPanBars = clamp(
      session.startView.panRightBars + dx / barPitch,
      -3,
      Math.max(0, allCandles.length - 4),
    );
    const nextVerticalShiftRatio = clamp(
      session.startView.verticalShiftRatio + dy / Math.max(40, plotHeight),
      -1.5,
      1.5,
    );
    updatePanOffsetCallback(nextPanBars);
    setViewState((current) => ({
      ...current,
      panRightBars: nextPanBars,
      verticalShiftRatio: nextVerticalShiftRatio,
    }));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragSessionRef.current?.pointerId === event.pointerId) {
      dragSessionRef.current = null;
      setIsDragging(false);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // jsdom does not implement releasePointerCapture
      }
    }
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const nextPan = clamp(
        viewState.panRightBars - (delta / Math.max(8, barPitch)),
        -3,
        Math.max(0, allCandles.length - 4),
      );
      updatePanOffsetCallback(nextPan);
      setViewState((current) => ({ ...current, panRightBars: nextPan }));
      return;
    }

    if (event.deltaY === 0) return;
    const zoomStep = event.deltaY < 0 ? -3 : 3;
    setViewState((current) => ({
      ...current,
      visibleBars: clamp(
        current.visibleBars + zoomStep,
        MIN_VISIBLE_BARS,
        Math.min(MAX_VISIBLE_BARS, Math.max(36, allCandles.length)),
      ),
    }));
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    setViewState(DEFAULT_VIEW_STATE);
    updatePanOffsetCallback(0);
  };

  const bidY = clamp(yForPrice(liveBid), plotTop, pricePlotBottom);
  const previewSymbolLabel = normalizedSymbol || 'EURUSD';
  const hudSummary = hudCandle
    ? `${previewSymbolLabel},${normalizedTf}  O:${formatChartAxisPrice(hudCandle.open, digits)} H:${formatChartAxisPrice(hudCandle.high, digits)} L:${formatChartAxisPrice(hudCandle.low, digits)} C:${formatChartAxisPrice(hudCandle.close, digits)}`
    : `${previewSymbolLabel},${normalizedTf}`;

  return (
    <div
      ref={surfaceRef}
      className="rtx-cp-preview-chart-surface relative w-full h-full select-none"
      style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => setHoverPos(null)}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
      title={tr('Drag to move chart, scroll to zoom, double-click to reset')}
    >
      <svg
        data-testid="cp-color-preview-chart"
        aria-label={tr('Chart color preview')}
        data-symbol={normalizedSymbol || 'PREVIEW'}
        data-timeframe={normalizedTf}
        data-live-source={hasLiveMarketCandles ? 'live' : 'fallback'}
        data-pan-bars={clampedPanBars.toFixed(2)}
        data-visible-bars={visibleBars}
        data-price-zoom={viewState.priceZoom.toFixed(2)}
        className="rtx-cp-preview-chart block w-full h-full pointer-events-none"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="cpLiveAreaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={previewTheme.areaUpLine} stopOpacity="0.32" />
            <stop offset="100%" stopColor={previewTheme.areaUpLine} stopOpacity="0.02" />
          </linearGradient>
          <clipPath id="cpPreviewPlotClip">
            <rect x={plotLeft} y={0} width={plotRight} height={plotBottom} />
          </clipPath>
        </defs>

        <g clipPath="url(#cpPreviewPlotClip)">
          {/* Live Price Line */}
          <line
            data-testid="cp-preview-bid-line"
            x1={plotLeft}
            y1={bidY}
            x2={plotRight}
            y2={bidY}
            stroke={effectiveColors.bidPriceLine}
            strokeWidth="1.15"
          />

          {/* Live Series */}
          {chartType === 'area' && areaFillPath && (
            <path data-testid="cp-preview-area" d={areaFillPath} fill="url(#cpLiveAreaGradient)" />
          )}

          {(chartType === 'line' || chartType === 'area') && (
            <polyline
              data-testid="cp-preview-line"
              fill="none"
              stroke={chartType === 'area' ? previewTheme.areaUpLine : effectiveColors.lineChart}
              strokeWidth="1.65"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={closeLinePoints}
            />
          )}

          {chartType === 'candlestick' && (
            <g data-testid="cp-preview-candles">
              {visibleIndexedCandles.map(({ candle, x }) => {
                const isBull = candle.close >= candle.open;
                const openY = yForPrice(candle.open);
                const closeY = yForPrice(candle.close);
                const highY = yForPrice(candle.high);
                const lowY = yForPrice(candle.low);
                const bodyTop = Math.min(openY, closeY);
                const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
                const strokeColor = isBull ? effectiveColors.barUp : effectiveColors.barDown;
                const fillColor = isBull ? effectiveColors.bullCandle : effectiveColors.bearCandle;
                return (
                  <g key={`c-${candle.time}`}>
                    <line x1={x} y1={highY} x2={x} y2={lowY} stroke={strokeColor} strokeWidth="1.1" />
                    <rect
                      data-trend={isBull ? 'bull' : 'bear'}
                      x={x - candleWidth / 2}
                      y={bodyTop}
                      width={candleWidth}
                      height={bodyHeight}
                      fill={fillColor}
                      stroke={strokeColor}
                      strokeWidth="1"
                    />
                  </g>
                );
              })}
            </g>
          )}

          {chartType === 'bar' && (
            <g data-testid="cp-preview-bars">
              {visibleIndexedCandles.map(({ candle, x }) => {
                const isBull = candle.close >= candle.open;
                const openY = yForPrice(candle.open);
                const closeY = yForPrice(candle.close);
                const highY = yForPrice(candle.high);
                const lowY = yForPrice(candle.low);
                const strokeColor = isBull ? effectiveColors.barUp : effectiveColors.barDown;
                return (
                  <g key={`b-${candle.time}`} data-trend={isBull ? 'bull' : 'bear'} stroke={strokeColor} strokeWidth="1.3" strokeLinecap="square">
                    <line x1={x} y1={highY} x2={x} y2={lowY} />
                    <line x1={x - halfTick} y1={openY} x2={x} y2={openY} />
                    <line x1={x} y1={closeY} x2={x + halfTick} y2={closeY} />
                  </g>
                );
              })}
            </g>
          )}

          {/* Crosshair Guides */}
          {hoverPos && hoveredPrice !== null && (
            <g data-testid="cp-preview-crosshair">
              <line
                x1={hoverPos.x}
                y1={0}
                x2={hoverPos.x}
                y2={plotBottom}
                stroke={previewTheme.crosshair}
                strokeWidth="1"
                strokeDasharray="2 2"
              />
              <line
                x1={plotLeft}
                y1={hoverPos.y}
                x2={plotRight}
                y2={hoverPos.y}
                stroke={previewTheme.crosshair}
                strokeWidth="1"
                strokeDasharray="2 2"
              />
            </g>
          )}
        </g>

        {/* Live OHLC Top-Left HUD */}
        <rect x={0} y={0} width={plotRight} height={16} fill={previewTheme.background} fillOpacity="0.72" />
        <text
          data-testid="cp-preview-ohlc"
          x={6}
          y={11.5}
          fontSize="8.5"
          fontFamily="var(--font-mono, monospace)"
          fill={effectiveColors.foreground}
        >
          {hudSummary}
        </text>
        {chartType !== 'line' && chartType !== 'area' && plotRight > 190 && (
          <polyline
            data-testid="cp-preview-line"
            fill="none"
            stroke={effectiveColors.lineChart}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={`${plotRight - 36},11 ${plotRight - 28},7 ${plotRight - 21},10 ${plotRight - 13},5 ${plotRight - 6},8`}
          />
        )}

        {/* Right Price Scale & Bottom Time Scale Gutters */}
        <rect x={plotRight} y={0} width={axisWidth} height={height} fill={previewTheme.background} fillOpacity="0.92" />
        <rect x={0} y={plotBottom} width={plotRight} height={timeAxisHeight} fill={previewTheme.background} fillOpacity="0.92" />
        <line x1={plotRight} y1={0} x2={plotRight} y2={plotBottom} stroke={previewTheme.scaleBorder} strokeWidth="1" />
        <line x1={0} y1={plotBottom} x2={width} y2={plotBottom} stroke={previewTheme.scaleBorder} strokeWidth="1" />

        {(() => {
          const bidBadgeY = clamp(bidY - 7, 2, plotBottom - 16);
          const bidCenterY = bidBadgeY + 7;

          return (
            <>
              {priceTicks.map((tickPrice, idx) => {
                const tickY = yForPrice(tickPrice);
                if (tickY < 10 || tickY > plotBottom - 8) return null;
                if (Math.abs(tickY - bidCenterY) < 12) return null;
                return (
                  <g key={`pt-${idx}`}>
                    <line x1={plotRight} y1={tickY} x2={plotRight + 3} y2={tickY} stroke={previewTheme.scaleBorder} strokeWidth="1" />
                    <text x={plotRight + 5} y={tickY + 3} fontSize="8" fontFamily="var(--font-mono, monospace)" fill={previewTheme.axisText}>
                      {formatChartAxisPrice(tickPrice, digits)}
                    </text>
                  </g>
                );
              })}

              <rect x={plotRight + 2} y={bidBadgeY} width={axisWidth - 4} height={14} rx={2} fill={effectiveColors.bidPriceLine} />
              <text
                x={plotRight + axisWidth / 2}
                y={bidBadgeY + 10}
                textAnchor="middle"
                fontSize="8.5"
                fontWeight="600"
                fontFamily="var(--font-mono, monospace)"
                fill={bidBadgeColor.badgeTextColor}
              >
                {formatChartAxisPrice(liveBid, digits)}
              </text>
            </>
          );
        })()}

        {hoverPos && hoveredPrice !== null && (
          <g>
            <rect x={plotRight + 2} y={clamp(hoverPos.y - 7, 2, plotBottom - 16)} width={axisWidth - 4} height={14} rx={2} fill="#334155" />
            <text
              x={plotRight + axisWidth / 2}
              y={clamp(hoverPos.y - 7, 2, plotBottom - 16) + 10}
              textAnchor="middle"
              fontSize="8.5"
              fontWeight="600"
              fontFamily="var(--font-mono, monospace)"
              fill="#ffffff"
            >
              {formatChartAxisPrice(hoveredPrice, digits)}
            </text>
          </g>
        )}

        {timeTicks.map((item) => (
          <g key={`tt-${item.candle.time}`}>
            <line x1={item.x} y1={plotBottom} x2={item.x} y2={plotBottom + 3} stroke={previewTheme.scaleBorder} strokeWidth="1" />
            <text
              x={item.x}
              y={plotBottom + 11.5}
              textAnchor="middle"
              fontSize="8"
              fontFamily="var(--font-mono, monospace)"
              fill={previewTheme.axisText}
            >
              {formatPreviewTimeLabel(item.candle.time, normalizedTf)}
            </text>
          </g>
        ))}

        {hoverPos && hoveredTimeLabel && (
          <g>
            <rect x={clamp(hoverPos.x - 18, 2, plotRight - 38)} y={plotBottom + 1} width={36} height={14} rx={2} fill="#334155" />
            <text
              x={clamp(hoverPos.x - 18, 2, plotRight - 38) + 18}
              y={plotBottom + 11}
              textAnchor="middle"
              fontSize="8"
              fontFamily="var(--font-mono, monospace)"
              fill="#ffffff"
            >
              {hoveredTimeLabel}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
};
