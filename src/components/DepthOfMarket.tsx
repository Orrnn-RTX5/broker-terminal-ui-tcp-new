import { useUiTranslation } from '../hooks/useUiTranslation';
import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useCurrentTick } from '../store/useMarketDataStore';
import { useChartSettingsStore } from '../store/useChartSettingsStore';
import { useLiveOrderBook } from '../hooks/useLiveMarketData';
import { formatPrice } from '../utils/symbolUtils';
import { getFallbackSymbolDescription } from '../utils/symbolDescription';
import { inferObservedPriceDigits } from '../utils/chartPriceScale';
import { readRegisteredSymbolPriceSpec } from '../services/dailyChangePriceModeRegistry';
import { resolveMarketWatchPriceDigits } from './market-watch/marketWatchPanelModel';
import {
  buildDepthOrderRequest,
  depthExecutionForLevel,
  readDepthTypography,
  splitLadderPrice,
} from './depthOfMarketModel';
import type { DepthOrderRequest } from './depthOfMarketModel';
import './DepthOfMarket.css';

export type { DepthOrderExecution, DepthOrderRequest } from './depthOfMarketModel';

interface DepthOfMarketProps {
    symbol: string;
    onClose?: () => void;
    onPlaceOrder?: (request: DepthOrderRequest) => void;
    onCloseBulk?: (type: 'ALL' | 'WINNERS' | 'LOSERS', symbol?: string) => void;
    onDragHandleMouseDown?: (e: React.MouseEvent) => void;
}

/* ─── Project Theme Fonts (from theme.css) ──────────────────────────── */
const FONT = "var(--font-sans, 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)";
const MONO = "var(--font-mono, 'Roboto Mono', 'Courier New', monospace)";

type DepthTypography = ReturnType<typeof readDepthTypography>;

function useDepthTypography() {
  const [typography, setTypography] = useState(readDepthTypography);
  useEffect(() => {
    const update = () => setTypography(current => {
      const next = readDepthTypography();
      return Object.keys(next).every(key => (
        current[key as keyof DepthTypography] === next[key as keyof DepthTypography]
      )) ? current : next;
    });
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, []);
  return typography;
}

/* ─── Chart display types ──────────────────────────────────────────── */
type ChartMode = 'bar' | 'candlestick' | 'line' | 'tick';

/* ─── Dark Charcoal Theme Colors (aligned with terminal surfaces) ────── */
const C = {
  bgPrimary:   '#141416',
  bgSecondary: '#1f1f1f',
  bgTertiary:  '#1f1f1f',
  bgElevated:  '#2a2a2c',
  bgHover:     '#303034',

  textPrimary:   '#e2e2e8',
  textSecondary: '#909098',
  textTertiary:  '#5c5c64',
  textDisabled:  '#46464e',

  borderPrimary:   '#38383c',
  borderSecondary: '#444448',
  borderHover:     '#56565c',

  profit:    '#4597ff',
  loss:      '#ff5858',
};

/* ─────────────────────────────────────────────────────────────────────── */
/*  Tick Chart Canvas (Left Panel) — supports bar/candle/line/tick modes  */
/* ─────────────────────────────────────────────────────────────────────── */
interface TickChartProps {
  symbol: string;
  width: number;
  height: number;
  chartMode: ChartMode;
  crosshair: boolean;
  zoomLevel: number; // 1=default, higher=zoomed in
  typography: DepthTypography;
  digits: number | null;
}

interface TickData {
  bid: number;
  ask: number;
  time: number;
  volume: number;
}

// Aggregate ticks into OHLC bars for candle/bar display
interface OHLCBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

function aggregateToOHLC(ticks: TickData[], barCount: number): OHLCBar[] {
  if (ticks.length < 2) return [];
  const bars: OHLCBar[] = [];
  const perBar = Math.max(1, Math.floor(ticks.length / barCount));

  for (let i = 0; i < ticks.length; i += perBar) {
    const slice = ticks.slice(i, i + perBar);
    if (slice.length === 0) continue;
    const mid = (p: TickData) => (p.bid + p.ask) / 2;
    const prices = slice.map(mid);
    bars.push({
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1],
      volume: slice.reduce((s, t) => s + (t.volume || 1), 0),
      time: slice[0].time,
    });
  }
  return bars;
}

function TickChart({ symbol, width: fallbackWidth, height, chartMode, crosshair, zoomLevel, typography, digits }: TickChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tickHistoryRef = useRef<TickData[]>([]);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const MAX_TICKS = 500;

  const currentTick = useCurrentTick(symbol);
  const showVolumes = useChartSettingsStore((state) => {
    const props = state.symbolProperties[symbol] || state.globalProperties;
    return Boolean(props.showTickVolumes || props.showRealVolumes);
  });

  // Accumulate ticks
  useEffect(() => {
    if (!currentTick) return;
    const history = tickHistoryRef.current;
    history.push({
      bid: currentTick.bid,
      ask: currentTick.ask,
      time: currentTick.timestamp || Date.now(),
      volume: currentTick.volume || 1,
    });
    if (history.length > MAX_TICKS) {
      history.splice(0, history.length - MAX_TICKS);
    }
  }, [currentTick]);

  // Mouse tracking for crosshair
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!crosshair) { mouseRef.current = null; return; }
    const rect = e.currentTarget.getBoundingClientRect();
    mouseRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, [crosshair]);

  const handleMouseLeave = useCallback(() => {
    mouseRef.current = null;
  }, []);

  // Draw chart at 10fps (plus immediate draw when props or tick update)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const renderFrame = () => {
      const rawHistory = tickHistoryRef.current;
      const allHistory = rawHistory.length >= 2
        ? rawHistory
        : rawHistory.length === 1
          ? [rawHistory[0], rawHistory[0]]
          : currentTick
            ? [
                { bid: currentTick.bid, ask: currentTick.ask, time: currentTick.timestamp || Date.now(), volume: currentTick.volume || 1 },
                { bid: currentTick.bid, ask: currentTick.ask, time: currentTick.timestamp || Date.now(), volume: currentTick.volume || 1 },
              ]
            : [];
      if (allHistory.length < 2) return;

      const width = canvas.clientWidth || fallbackWidth;
      const measuredHeight = canvas.clientHeight || height;
      const isLaptopCanvas = canvas.clientWidth > 0
        && typeof window !== 'undefined'
        && (window.innerWidth <= 1720 || window.innerHeight <= 920);
      const effectiveFontSize = isLaptopCanvas
        ? Math.min(typography.fontSize, window.innerWidth <= 1440 || window.innerHeight <= 780 ? 10.5 : 11)
        : typography.fontSize;
      const bodyFont = `${typography.bodyWeight} ${effectiveFontSize}px ${typography.fontFamily}`;
      const controlFont = `${typography.controlWeight} ${effectiveFontSize}px ${typography.fontFamily}`;
      const labelHeight = isLaptopCanvas ? Math.round(effectiveFontSize * 1.45) + 3 : typography.lineHeight + 4;

      const visibleCount = Math.max(20, Math.floor(MAX_TICKS / zoomLevel));
      const history = allHistory.slice(-visibleCount);

      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = measuredHeight * dpr;
      ctx.scale(dpr, dpr);

      const isLight = document.documentElement.classList.contains('rtx-skin-untitled-light');
      const upColor = isLight ? '#2563eb' : '#4597ff';
      const downColor = isLight ? '#dc2626' : '#ff5858';

      const rootStyle = getComputedStyle(document.documentElement);
      const hostStyle = getComputedStyle(canvas);
      const readColor = (name: string, fallback: string) => (
        hostStyle.getPropertyValue(name).trim() || rootStyle.getPropertyValue(name).trim() || fallback
      );
      const plotBg = isLight ? readColor('--rtx-light-panel', '#fafbfc') : C.bgPrimary;
      const axisBg = isLight ? readColor('--rtx-light-panel-subtle', '#f1f5f9') : C.bgPrimary;
      const borderStroke = isLight ? readColor('--rtx-light-border', '#cbd5e1') : readColor('--border-primary', C.borderPrimary);
      const axisTextColor = isLight ? readColor('--rtx-light-text-secondary', '#475569') : readColor('--text-secondary', C.textSecondary);

      ctx.fillStyle = plotBg;
      ctx.fillRect(0, 0, width, measuredHeight);

      const chartH = showVolumes
        ? Math.max(labelHeight, (measuredHeight - 10) * 0.78)
        : Math.max(labelHeight, measuredHeight - 8);
      const volH = showVolumes ? Math.max(0, measuredHeight - chartH - 8) : 0;
      const volTop = chartH + 4;
      let minP = Infinity, maxP = -Infinity;
      let minVol = Infinity, maxVol = 1;
      for (const t of history) {
        minP = Math.min(minP, t.bid, t.ask);
        maxP = Math.max(maxP, t.bid, t.ask);
        minVol = Math.min(minVol, t.volume);
        maxVol = Math.max(maxVol, t.volume);
      }
      const spreadSpan = Math.max(maxP - minP, (history[history.length - 1]?.ask - history[history.length - 1]?.bid) || 1);
      const padding = spreadSpan * 0.22;
      minP -= padding;
      maxP += padding;
      const totalRange = Math.max(maxP - minP, 1e-9);

      const scaleDigits = digits ?? inferObservedPriceDigits(null, [minP, maxP, currentTick?.bid, currentTick?.ask]) ?? 5;
      ctx.font = bodyFont;
      const sampleLabel = formatPrice(maxP, scaleDigits);
      const axisWidth = Math.min(Math.max(62, ctx.measureText(sampleLabel).width + 18), Math.floor(width * 0.36));
      const plotWidth = Math.max(40, width - axisWidth);
      const plotLeft = 6;
      const plotInnerW = Math.max(20, plotWidth - plotLeft - 6);

      if (axisBg !== plotBg) {
        ctx.fillStyle = axisBg;
        ctx.fillRect(plotWidth, 0, axisWidth, measuredHeight);
      }

      // Quiet terminal grid lines inside plot area
      ctx.strokeStyle = isLight ? 'rgba(100, 116, 139, 0.14)' : 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 0.5;
      for (let i = 1; i < 5; i++) {
        const y = Math.round((chartH / 5) * i) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotWidth, y); ctx.stroke();
      }
      for (let i = 1; i < 4; i++) {
        const x = Math.round((plotWidth / 4) * i) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, chartH); ctx.stroke();
      }

      // Vertical separator between plot and price scale
      ctx.strokeStyle = borderStroke;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(plotWidth + 0.5, 0); ctx.lineTo(plotWidth + 0.5, measuredHeight); ctx.stroke();

      // Price scale on right (even vertical rhythm + collision guard around live badge)
      const lastLabelCenterY = history.length > 0
        ? Math.max(labelHeight / 2, Math.min(chartH - labelHeight / 2, chartH - ((history[history.length - 1].bid - minP) / totalRange) * chartH))
        : null;
      ctx.fillStyle = axisTextColor;
      ctx.font = bodyFont;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const axisPadY = Math.max(10, Math.round(labelHeight * 0.65));
      const axisSpanH = Math.max(labelHeight, chartH - axisPadY * 2);
      const priceIntervals = Math.max(1, Math.min(4, Math.floor(axisSpanH / (labelHeight + 10))));
      for (let i = 0; i <= priceIntervals; i++) {
        const y = axisPadY + (axisSpanH / priceIntervals) * i;
        if (lastLabelCenterY !== null && Math.abs(y - lastLabelCenterY) < labelHeight * 1.05) continue;
        const price = maxP - (y / chartH) * totalRange;
        ctx.fillText(formatPrice(price, scaleDigits), width - 7, y);
      }

      const pointCount = Math.max(history.length - 1, 1);
      const xForIndex = (index: number) => plotLeft + (index / pointCount) * plotInnerW;

      // === CHART MODE RENDERING ===
      if (chartMode === 'tick' || chartMode === 'line') {
        if (chartMode === 'line') {
          ctx.beginPath();
          for (let i = 0; i < history.length; i++) {
            const x = xForIndex(i);
            const y = chartH - ((history[i].bid - minP) / totalRange) * chartH;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.lineTo(xForIndex(history.length - 1), chartH);
          ctx.lineTo(xForIndex(0), chartH);
          ctx.closePath();
          if (typeof ctx.createLinearGradient === 'function') {
            const grad = ctx.createLinearGradient(0, 0, 0, chartH);
            grad.addColorStop(0, isLight ? 'rgba(220, 38, 38, 0.09)' : 'rgba(255, 88, 88, 0.08)');
            grad.addColorStop(1, 'rgba(255, 88, 88, 0)');
            ctx.fillStyle = grad;
          } else {
            ctx.fillStyle = isLight ? 'rgba(220, 38, 38, 0.05)' : 'rgba(255, 88, 88, 0.04)';
          }
          ctx.fill();
        }

        // Draw Ask line (Blue — crisp fine dashed)
        ctx.save?.();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = isLight ? 'rgba(37, 99, 235, 0.72)' : 'rgba(69, 151, 255, 0.75)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        for (let i = 0; i < history.length; i++) {
          const x = xForIndex(i);
          const y = chartH - ((history[i].ask - minP) / totalRange) * chartH;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw Bid line (Red — continuous sharp trace)
        ctx.strokeStyle = downColor;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let i = 0; i < history.length; i++) {
          const x = xForIndex(i);
          const y = chartH - ((history[i].bid - minP) / totalRange) * chartH;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore?.();
      } else {
        // Bar / Candlestick mode
        const barCount = Math.max(6, Math.min(36, Math.floor(history.length / 2) || 6));
        const bars = aggregateToOHLC(history, barCount);
        if (bars.length > 0) {
          const slotW = plotInnerW / Math.max(bars.length, 1);
          const bw = Math.max(3, Math.min(12, slotW * 0.65));

          let bMinP = Infinity, bMaxP = -Infinity;
          for (const b of bars) {
            bMinP = Math.min(bMinP, b.low);
            bMaxP = Math.max(bMaxP, b.high);
          }
          const bPad = (bMaxP - bMinP || 1) * 0.12;
          bMinP -= bPad;
          bMaxP += bPad;
          const bRange = Math.max(bMaxP - bMinP, 1e-9);

          for (let i = 0; i < bars.length; i++) {
            const bar = bars[i];
            const x = plotLeft + (i + 0.5) * slotW;
            const isUp = bar.close >= bar.open;
            const color = isUp ? upColor : downColor;
            const oY = chartH - ((bar.open - bMinP) / bRange) * chartH;
            const cY = chartH - ((bar.close - bMinP) / bRange) * chartH;
            const hY = chartH - ((bar.high - bMinP) / bRange) * chartH;
            const lY = chartH - ((bar.low - bMinP) / bRange) * chartH;

            if (chartMode === 'candlestick') {
              ctx.strokeStyle = color;
              ctx.lineWidth = 1.2;
              ctx.beginPath(); ctx.moveTo(x, hY); ctx.lineTo(x, lY); ctx.stroke();
              const bodyTop = Math.min(oY, cY);
              const bodyH = Math.max(2, Math.abs(oY - cY));
              ctx.fillStyle = color;
              ctx.fillRect(x - bw / 2, bodyTop, bw, bodyH);
            } else {
              ctx.strokeStyle = color;
              ctx.lineWidth = 1.3;
              ctx.beginPath(); ctx.moveTo(x, hY); ctx.lineTo(x, lY); ctx.stroke();
              ctx.beginPath(); ctx.moveTo(x - bw / 2, oY); ctx.lineTo(x, oY); ctx.stroke();
              ctx.beginPath(); ctx.moveTo(x, cY); ctx.lineTo(x + bw / 2, cY); ctx.stroke();
            }
          }

          if (showVolumes && volH > 4) {
            let bMaxVol = 1;
            let bMinVol = Infinity;
            for (const b of bars) {
              bMaxVol = Math.max(bMaxVol, b.volume);
              bMinVol = Math.min(bMinVol, b.volume);
            }
            const uniformBarVol = bMaxVol <= bMinVol;

            for (let i = 0; i < bars.length; i++) {
              const bar = bars[i];
              const x = plotLeft + (i + 0.5) * slotW;
              const bh = uniformBarVol ? volH * 0.32 : (bar.volume / bMaxVol) * (volH * 0.72);
              const isUp = bar.close >= bar.open;
              ctx.fillStyle = isUp
                ? (isLight ? 'rgba(37, 99, 235, 0.28)' : 'rgba(69, 151, 255, 0.30)')
                : (isLight ? 'rgba(220, 38, 38, 0.28)' : 'rgba(255, 88, 88, 0.30)');
              ctx.fillRect(x - bw / 2, volTop + volH - bh, bw, bh);
            }
          }
        }
      }

      // Draw volume bars for tick/line modes (spread cleanly across plot area)
      if (showVolumes && (chartMode === 'tick' || chartMode === 'line') && volH > 4) {
        const uniformVol = maxVol <= minVol;
        const slotW = plotInnerW / Math.max(history.length, 1);
        const barWidth = Math.max(1.5, Math.min(6, slotW * 0.65));
        for (let i = 0; i < history.length; i++) {
          const x = xForIndex(i) - barWidth / 2;
          const bh = uniformVol ? volH * 0.28 : (history[i].volume / maxVol) * (volH * 0.68);
          const isUp = i === 0 || history[i].bid >= history[i - 1].bid;
          ctx.fillStyle = isUp
            ? (isLight ? 'rgba(37, 99, 235, 0.24)' : 'rgba(69, 151, 255, 0.26)')
            : (isLight ? 'rgba(220, 38, 38, 0.24)' : 'rgba(255, 88, 88, 0.26)');
          ctx.fillRect(x, volTop + volH - bh, barWidth, bh);
        }
      }

      // Border between chart and volume
      if (showVolumes) {
        ctx.strokeStyle = borderStroke;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, Math.round(chartH) + 0.5); ctx.lineTo(plotWidth, Math.round(chartH) + 0.5); ctx.stroke();
      }

      // === CROSSHAIR ===
      if (crosshair && mouseRef.current) {
        const { x: mx, y: my } = mouseRef.current;
        const clampedMx = Math.min(mx, plotWidth);
        ctx.strokeStyle = isLight ? 'rgba(71, 85, 105, 0.55)' : 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(clampedMx, 0); ctx.lineTo(clampedMx, measuredHeight); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(plotWidth, my); ctx.stroke();
        ctx.setLineDash([]);

        const badgeBg = isLight ? readColor('--rtx-light-accent', '#2563eb') : '#38383f';
        const badgeFg = '#ffffff';

        if (my <= chartH) {
          const price = maxP - (my / chartH) * totalRange;
          const labelText = formatPrice(price, digits ?? undefined);
          ctx.font = bodyFont;
          ctx.fillStyle = badgeBg;
          const labelY = Math.max(0, Math.min(chartH - labelHeight, my - labelHeight / 2));
          ctx.fillRect(plotWidth + 1, labelY, axisWidth - 1, labelHeight);
          ctx.fillStyle = badgeFg;
          ctx.textAlign = 'right';
          ctx.fillText(labelText, width - 7, labelY + labelHeight / 2);
        }

        const idx = Math.min(history.length - 1, Math.max(0, Math.floor((clampedMx / plotWidth) * history.length)));
        if (idx >= 0 && idx < history.length) {
          const tick = history[idx];
          const d = new Date(tick.time);
          const timeStr = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
          ctx.font = bodyFont;
          const tw = ctx.measureText(timeStr).width + 10;
          const labelX = Math.max(0, Math.min(plotWidth - tw, clampedMx - tw / 2));
          ctx.fillStyle = badgeBg;
          ctx.fillRect(labelX, measuredHeight - labelHeight, tw, labelHeight);
          ctx.fillStyle = badgeFg;
          ctx.textAlign = 'center';
          ctx.fillText(timeStr, labelX + tw / 2, measuredHeight - labelHeight / 2);
        }

        if (my <= chartH) {
          const t = history[idx];
          if (t) {
            const tooltipLines = [
              `Bid: ${formatPrice(t.bid, digits ?? undefined)}`,
              `Ask: ${formatPrice(t.ask, digits ?? undefined)}`,
              ...(showVolumes ? [`Vol: ${t.volume.toFixed(2)}`] : []),
            ];
            ctx.font = bodyFont;
            const tooltipX = clampedMx + 10;
            const tw = Math.max(...tooltipLines.map(line => ctx.measureText(line).width)) + 14;
            const th = tooltipLines.length * typography.lineHeight + 8;
            const tooltipY = Math.max(4, Math.min(my, chartH - th - 4));
            ctx.fillStyle = isLight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(26, 26, 30, 0.95)';
            ctx.strokeStyle = isLight ? readColor('--rtx-light-border-strong', '#94a3b8') : C.borderSecondary;
            ctx.lineWidth = 1;
            const rx = Math.max(4, Math.min(tooltipX, plotWidth - tw - 4));
            ctx.beginPath();
            ctx.roundRect(rx, tooltipY, tw, th, 3);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = isLight ? readColor('--rtx-light-text', '#0f172a') : C.textPrimary;
            ctx.textAlign = 'left';
            tooltipLines.forEach((line, li) => {
              ctx.fillText(line, rx + 7, tooltipY + 4 + typography.lineHeight * (li + 0.5));
            });
          }
        }
      }

      // Current price line & badge in the right axis strip
      if (history.length > 0) {
        const lastTick = history[history.length - 1];
        const lastY = chartH - ((lastTick.bid - minP) / totalRange) * chartH;
        ctx.font = controlFont;
        const priceText = formatPrice(lastTick.bid, scaleDigits);
        const priceLabelY = Math.max(0, Math.min(chartH - labelHeight, lastY - labelHeight / 2));

        ctx.strokeStyle = isLight ? 'rgba(220, 38, 38, 0.55)' : 'rgba(255, 88, 88, 0.55)';
        ctx.lineWidth = 0.85;
        ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(0, lastY); ctx.lineTo(plotWidth, lastY); ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = isLight ? '#dc2626' : '#d93a3e';
        ctx.fillRect(plotWidth + 1, priceLabelY, axisWidth - 1, labelHeight);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.fillText(priceText, width - 7, priceLabelY + labelHeight / 2);
      }
    };

    renderFrame();
    const interval = setInterval(renderFrame, 100);
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => renderFrame())
      : null;
    resizeObserver?.observe(canvas);

    return () => {
      clearInterval(interval);
      resizeObserver?.disconnect();
    };
  }, [fallbackWidth, height, symbol, chartMode, crosshair, zoomLevel, typography, digits, currentTick, showVolumes]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block', cursor: crosshair ? 'crosshair' : 'default' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    />
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/*  Toolbar (Fully Functional)                                            */
/* ─────────────────────────────────────────────────────────────────────── */
interface DOMToolbarProps {
  chartMode: ChartMode;
  crosshair: boolean;
  onChartModeChange: (mode: ChartMode) => void;
  onToggleCrosshair: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

const CHART_MODE_LABELS: Record<ChartMode, string> = {
  bar: 'OHLC Bar',
  candlestick: 'Candlestick',
  line: 'Line',
  tick: 'Tick Stream',
};

function DOMToolbar({ chartMode, crosshair, onChartModeChange, onToggleCrosshair, onZoomIn, onZoomOut }: DOMToolbarProps) {
    const tr = useUiTranslation();
  const iconBtn = (active: boolean) => `rtx-dom-toolbar-btn ${active ? 'is-active' : ''}`;

  return (
    <div
      className="rtx-dom-toolbar flex items-center justify-between gap-2 px-3 py-1 border-b select-none shrink-0"
      style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-tertiary)' }}
    >
      <div className="flex items-center gap-1.5">
        <div className="rtx-dom-toolbar-group" role="group" aria-label={tr("Chart mode")}>
          {/* Bar Chart (OHLC) */}
          <button
            type="button"
            className={iconBtn(chartMode === 'bar')}
            onClick={() => onChartModeChange('bar')}
            title={tr("Bar Chart (OHLC)")}
            aria-label={tr("Bar Chart (OHLC)")}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 3.5V12.5M1.75 6.25H3.5M3.5 9.75H5.25" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
              <path d="M8 2.25V13.75M6.25 8.5H8M8 5.25H9.75" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
              <path d="M12.5 4V12M10.75 6H12.5M12.5 9.25H14.25" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            </svg>
          </button>

          {/* Candlestick */}
          <button
            type="button"
            className={iconBtn(chartMode === 'candlestick')}
            onClick={() => onChartModeChange('candlestick')}
            title={tr("Candlestick Chart")}
            aria-label={tr("Candlestick Chart")}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 3V13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <rect x="2.2" y="5.4" width="2.6" height="5.2" rx="0.45" fill="currentColor" />
              <path d="M8 2V4.3M8 10.6V14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <rect x="6.7" y="4.3" width="2.6" height="6.3" rx="0.45" stroke="currentColor" strokeWidth="1.2" fill="none" />
              <path d="M12.5 3.2V12.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <rect x="11.2" y="5.8" width="2.6" height="4.6" rx="0.45" fill="currentColor" />
            </svg>
          </button>

          {/* Line Chart */}
          <button
            type="button"
            className={iconBtn(chartMode === 'line')}
            onClick={() => onChartModeChange('line')}
            title={tr("Line Chart")}
            aria-label={tr("Line Chart")}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <polyline
                points="1.75,11.25 5.25,6.75 8.75,9.25 14.25,3.75"
                stroke="currentColor"
                fill="none"
                strokeWidth="1.45"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* Tick Stream */}
          <button
            type="button"
            className={iconBtn(chartMode === 'tick')}
            onClick={() => onChartModeChange('tick')}
            title={tr("Tick Chart")}
            aria-label={tr("Tick Chart")}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <polyline
                points="1.5,10 4,5.25 6.6,10.5 9.3,3.8 11.9,11.2 14.5,4"
                stroke="currentColor"
                fill="none"
                strokeWidth="1.4"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Separator */}
        <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border-primary, #38383c)' }} />

        {/* Crosshair */}
        <button
          type="button"
          className={`rtx-dom-toolbar-btn rtx-dom-toolbar-btn--tool ${crosshair ? 'is-active' : ''}`}
          onClick={onToggleCrosshair}
          title={crosshair ? tr("Crosshair: ON") : tr("Crosshair: OFF")}
          aria-label={tr("Crosshair")}
          aria-pressed={crosshair}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 1.75V5M8 11V14.25M1.75 8H5M11 8H14.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <circle cx="8" cy="8" r="2.1" stroke="currentColor" fill="none" strokeWidth="1.25" />
          </svg>
        </button>

        {/* Separator */}
        <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border-primary, #38383c)' }} />

        {/* Zoom Controls */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="rtx-dom-toolbar-btn rtx-dom-toolbar-btn--tool"
            onClick={onZoomIn}
            title={tr("Zoom In")}
            aria-label={tr("Zoom In")}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.3" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5 7H9M7 5V9M10.3 10.3L14 14" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            </svg>
          </button>

          <button
            type="button"
            className="rtx-dom-toolbar-btn rtx-dom-toolbar-btn--tool"
            onClick={onZoomOut}
            title={tr("Zoom Out")}
            aria-label={tr("Zoom Out")}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.3" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5 7H9M10.3 10.3L14 14" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <span className="rtx-dom-toolbar-mode uppercase" aria-hidden="true">
        {tr(CHART_MODE_LABELS[chartMode])}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/*  Main DepthOfMarket Component                                          */
/* ─────────────────────────────────────────────────────────────────────── */
export const DepthOfMarket: React.FC<DepthOfMarketProps> = ({
  symbol,
  onClose,
  onPlaceOrder,
  onCloseBulk,
  onDragHandleMouseDown,
}) => {
    const tr = useUiTranslation();
  const typography = useDepthTypography();
  const currentTick = useCurrentTick(symbol);
  // Inputs keep the raw text while typing (so clearing / "0." intermediates
  // work); orders always use the validated numeric values derived below.
  const [volumeInput, setVolumeInput] = useState('0.01');
  const [slInput, setSlInput] = useState('0');
  const [tpInput, setTpInput] = useState('0');
  const volume = useMemo(() => {
    const parsed = Number.parseFloat(volumeInput);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : 0.01;
  }, [volumeInput]);
  const sl = useMemo(() => {
    const parsed = Number.parseFloat(slInput);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }, [slInput]);
  const tp = useMemo(() => {
    const parsed = Number.parseFloat(tpInput);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }, [tpInput]);
  const mainContentRef = useRef<HTMLDivElement>(null);
  const [mainContentHeight, setMainContentHeight] = useState(280);
  const [hasMeasuredWidth, setHasMeasuredWidth] = useState(false);

  // Toolbar state
  const [chartMode, setChartMode] = useState<ChartMode>('tick');
  const [crosshair, setCrosshair] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);

  const handleZoomIn = useCallback(() => {
    setZoomLevel(prev => Math.min(8, prev * 1.5));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomLevel(prev => Math.max(0.5, prev / 1.5));
  }, []);

  const ROW_H = typography.rowHeight;
  const COLUMN_HEADER_HEIGHT = 28;
  const ladderColumns = 'minmax(72px, 1.02fr) minmax(88px, 1.16fr) 50px';
  const symbolDescription = useMemo(() => getFallbackSymbolDescription(symbol), [symbol]);
  const isLaptopDomSurface = typeof window !== 'undefined'
    && hasMeasuredWidth
    && (window.innerWidth <= 1720 || window.innerHeight <= 920);
  const effectiveRowH = isLaptopDomSurface
    ? (window.innerWidth <= 1440 || window.innerHeight <= 780 ? 18 : 20)
    : ROW_H;
  const effectiveHeaderH = isLaptopDomSurface
    ? (window.innerWidth <= 1440 || window.innerHeight <= 780 ? 22 : 23)
    : COLUMN_HEADER_HEIGHT;
  const availableForRows = Math.max(effectiveRowH * 4 * 2, mainContentHeight - effectiveHeaderH);
  const dynamicLevels = isLaptopDomSurface
    ? Math.max(4, Math.floor((availableForRows - effectiveRowH + 6) / (effectiveRowH * 2)))
    : Math.max(4, Math.floor((availableForRows - ROW_H + 6) / (ROW_H * 2)));
  const requestLevels = Math.max(10, dynamicLevels);
  const { orderBook, loading: depthLoading, error: depthError } = useLiveOrderBook(symbol, requestLevels);
  const bestBid = currentTick?.bid ?? orderBook?.bids[0]?.price ?? 0;
  const bestAsk = currentTick?.ask ?? orderBook?.asks[0]?.price ?? 0;
  const hasDepthSurface = Boolean(currentTick || orderBook);

  useEffect(() => {
    const element = mainContentRef.current;
    if (!element) return;

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setMainContentHeight(Math.max(120, rect.height));
      setHasMeasuredWidth(rect.width > 0 || element.clientWidth > 0);
    };
    updateSize();

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setMainContentHeight(Math.max(120, entry.contentRect.height));
        setHasMeasuredWidth(entry.contentRect.width > 0 || element.clientWidth > 0);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasDepthSurface]);

  // Catalog (symbol-data) digits: the broker instrument catalog first, then
  // broker tick metadata. Unknown precision stays null and renders raw —
  // never guessed from the symbol name. Read on every render (cheap): the
  // catalog registry is not reactive, so a memo could pin a stale null.
  // (MarketData Tick carries no typed digits field; read defensively.)
  const currentTickDigits = (currentTick as { digits?: unknown } | null | undefined)?.digits;
  const digits = resolveMarketWatchPriceDigits(
    symbol,
    readRegisteredSymbolPriceSpec(symbol).digits,
    currentTickDigits,
    bestBid,
    bestAsk,
  );

  const rawTickBidVolume = (currentTick as { bidVolume?: unknown } | null | undefined)?.bidVolume;
  const rawTickAskVolume = (currentTick as { askVolume?: unknown } | null | undefined)?.askVolume;
  const bestBidTickVolume = typeof rawTickBidVolume === 'number' && Number.isFinite(rawTickBidVolume) && rawTickBidVolume > 0
    ? rawTickBidVolume
    : 0;
  const bestAskTickVolume = typeof rawTickAskVolume === 'number' && Number.isFinite(rawTickAskVolume) && rawTickAskVolume > 0
    ? rawTickAskVolume
    : 0;

  type DepthLevel = { price: number; volume: number };
  const depthLevels = useMemo(() => {
    if (orderBook && (orderBook.asks.length > 0 || orderBook.bids.length > 0)) {
      const rawAsks = orderBook.asks.slice(0, dynamicLevels);
      const rawBids = orderBook.bids.slice(0, dynamicLevels);
      if (digits !== null && (rawAsks.length < dynamicLevels || rawBids.length < dynamicLevels)) {
        const point = 10 ** -digits;
        const roundPrice = (value: number) => Number(value.toFixed(digits));
        const paddedAsks: DepthLevel[] = [...rawAsks];
        let lastAsk = paddedAsks.length > 0 ? paddedAsks[paddedAsks.length - 1].price : bestAsk;
        while (paddedAsks.length < dynamicLevels && lastAsk > 0) {
          lastAsk = roundPrice(lastAsk + point);
          paddedAsks.push({ price: lastAsk, volume: 0 });
        }
        const paddedBids: DepthLevel[] = [...rawBids];
        let lastBid = paddedBids.length > 0 ? paddedBids[paddedBids.length - 1].price : bestBid;
        while (paddedBids.length < dynamicLevels && lastBid > 0) {
          lastBid = roundPrice(lastBid - point);
          paddedBids.push({ price: lastBid, volume: 0 });
        }
        const asks = paddedAsks.reverse();
        const bids = paddedBids;
        const maxVolume = Math.max(...[...asks, ...bids].map((level) => level.volume), 0);
        return { asks, bids, maxVolume, synthetic: false };
      }
      const asks = rawAsks.reverse();
      const bids = rawBids;
      const maxVolume = Math.max(...[...asks, ...bids].map((level) => level.volume), 0);
      return { asks, bids, maxVolume, synthetic: false };
    }

    // Broker without a depth feed: build a one-point price ladder around the
    // live tick so limit-order entry keeps working. Prices are real (derived
    // from the current bid/ask); no liquidity volumes are invented (only real
    // top-of-book tick volumes are shown when published by the broker).
    if (bestBid > 0 && bestAsk > 0) {
      const topMaxVolume = Math.max(bestAskTickVolume, bestBidTickVolume, 0);
      const isPurelySynthetic = topMaxVolume === 0;
      if (digits === null) {
        // Unknown precision: expose the live quote raw — no point-step
        // expansion and no rounding.
        return {
          asks: [{ price: bestAsk, volume: bestAskTickVolume }],
          bids: [{ price: bestBid, volume: bestBidTickVolume }],
          maxVolume: topMaxVolume,
          synthetic: isPurelySynthetic,
        };
      }
      const point = 10 ** -digits;
      const roundPrice = (value: number) => Number(value.toFixed(digits));
      const asks: DepthLevel[] = Array.from({ length: dynamicLevels }, (_, index) => {
        const offsetFromBest = dynamicLevels - 1 - index;
        return {
          price: roundPrice(bestAsk + offsetFromBest * point),
          volume: offsetFromBest === 0 ? bestAskTickVolume : 0,
        };
      });
      const bids: DepthLevel[] = Array.from({ length: dynamicLevels }, (_, index) => ({
        price: roundPrice(bestBid - index * point),
        volume: index === 0 ? bestBidTickVolume : 0,
      }));
      return { asks, bids, maxVolume: topMaxVolume, synthetic: isPurelySynthetic };
    }

    return { asks: [] as DepthLevel[], bids: [] as DepthLevel[], maxVolume: 0, synthetic: false };
  }, [orderBook, dynamicLevels, bestBid, bestAsk, bestBidTickVolume, bestAskTickVolume, digits]);

  const handleCloseAll = useCallback(() => {
    onCloseBulk?.('ALL', symbol);
  }, [onCloseBulk, symbol]);

  if (!currentTick && !orderBook) {
    return (
      <div
        className="rtx-depth-of-market flex flex-col items-center justify-center h-full select-none"
        style={{ background: 'var(--bg-secondary)', fontFamily: FONT, fontSize: typography.fontSize, fontWeight: typography.bodyWeight, lineHeight: 1.5, color: C.textSecondary, borderRadius: 6 }}
      >
        <div className="text-center">
          {depthLoading && (
            <div
              className="w-4 h-4 border-2 rounded-full animate-spin mx-auto mb-2"
              style={{ borderColor: 'var(--border-primary, #38383c)', borderTopColor: 'var(--text-secondary, #909098)' }}
            />
          )}
          {depthError || `Waiting for ${symbol} market depth...`}
        </div>
      </div>
    );
  }

  return (
    <div
      className="rtx-depth-of-market flex flex-col w-full h-full select-none overflow-hidden"
      style={{ background: 'var(--bg-secondary)', fontFamily: FONT, fontSize: typography.fontSize, fontWeight: typography.bodyWeight, lineHeight: 1.5, borderRadius: 6 }}
    >
      {/* ── Title Bar ── */}
      <div
        className="rtx-dom-titlebar flex min-h-[32px] items-center justify-between gap-2 px-3 py-1 border-b shrink-0 cursor-move"
        style={{
          background: 'var(--bg-tertiary)',
          borderColor: 'var(--border-primary)',
          color: 'var(--text-primary, #e2e2e8)',
          borderRadius: '6px 6px 0 0',
        }}
        onMouseDown={onDragHandleMouseDown}
      >
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="rtx-depth-of-market__heading uppercase tracking-normal shrink-0" style={{ color: 'var(--text-primary, #e2e2e8)', fontSize: typography.fontSize, fontWeight: 600 }}>
            {symbol}
          </span>
          {symbolDescription && (
            <span className="rtx-dom-description text-[12px] leading-[18px] font-normal truncate" style={{ color: 'var(--text-secondary, #909098)', letterSpacing: 'normal' }}>
              {tr(symbolDescription)}
            </span>
          )}
        </div>
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rtx-dom-icon-btn rtx-dom-icon-btn--danger"
            onMouseDown={e => e.stopPropagation()}
            title={tr("Close")}
            aria-label={tr("Close")}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
              <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Top Trade Controls: SL | Volume | TP ── */}
      <div
        className="rtx-dom-params-bar flex items-center justify-between gap-3 px-3 py-1.5 border-b shrink-0"
        style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)' }}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="rtx-dom-param-group flex items-center gap-2">
          <span className="rtx-dom-stepper__label">{tr("SL")}</span>
          <div className="rtx-dom-stepper" title={tr("Stop Loss distance in points (0 = off)")}>
            <button type="button" className="rtx-dom-stepper__btn" onClick={() => setSlInput(String(Math.max(0, sl - 1)))} aria-label={tr("Decrease Stop Loss")}>−</button>
            <input
              type="number"
              value={slInput}
              min={0}
              step={1}
              onChange={e => setSlInput(e.target.value)}
              onBlur={() => setSlInput(String(sl))}
              className="rtx-dom-stepper__input"
              style={{ fontFamily: MONO }}
              aria-label={tr("Stop Loss points")}
            />
            <button type="button" className="rtx-dom-stepper__btn" onClick={() => setSlInput(String(sl + 1))} aria-label={tr("Increase Stop Loss")}>+</button>
          </div>
        </div>

        <div className="rtx-dom-param-group flex items-center gap-2">
          <span className="rtx-dom-stepper__label">{tr("Volume")}</span>
          <div className="rtx-dom-stepper rtx-dom-stepper--volume" title={tr("Order volume in lots")}>
            <button type="button" className="rtx-dom-stepper__btn" onClick={() => setVolumeInput(Math.max(0.01, Math.round((volume - 0.01) * 100) / 100).toFixed(2))} aria-label={tr("Decrease volume")}>−</button>
            <input
              type="number"
              value={volumeInput}
              min={0.01}
              step={0.01}
              onChange={e => setVolumeInput(e.target.value)}
              onBlur={() => setVolumeInput(volume.toFixed(2))}
              className="rtx-dom-stepper__input rtx-dom-stepper__input--volume"
              style={{ fontFamily: MONO }}
              aria-label={tr("Order volume in lots")}
            />
            <button type="button" className="rtx-dom-stepper__btn" onClick={() => setVolumeInput((Math.round((volume + 0.01) * 100) / 100).toFixed(2))} aria-label={tr("Increase volume")}>+</button>
          </div>
        </div>

        <div className="rtx-dom-param-group flex items-center gap-2">
          <span className="rtx-dom-stepper__label">{tr("TP")}</span>
          <div className="rtx-dom-stepper" title={tr("Take Profit distance in points (0 = off)")}>
            <button type="button" className="rtx-dom-stepper__btn" onClick={() => setTpInput(String(Math.max(0, tp - 1)))} aria-label={tr("Decrease Take Profit")}>−</button>
            <input
              type="number"
              value={tpInput}
              min={0}
              step={1}
              onChange={e => setTpInput(e.target.value)}
              onBlur={() => setTpInput(String(tp))}
              className="rtx-dom-stepper__input"
              style={{ fontFamily: MONO }}
              aria-label={tr("Take Profit points")}
            />
            <button type="button" className="rtx-dom-stepper__btn" onClick={() => setTpInput(String(tp + 1))} aria-label={tr("Increase Take Profit")}>+</button>
          </div>
        </div>
      </div>

      {/* ── Toolbar (Functional) ── */}
      <DOMToolbar
        chartMode={chartMode}
        crosshair={crosshair}
        onChartModeChange={setChartMode}
        onToggleCrosshair={() => setCrosshair(prev => !prev)}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
      />

      {/* ── Main Content: Tick Chart + DOM Table ── */}
      <div ref={mainContentRef} className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── Left: Tick Chart ── */}
        <div className="flex-[51] h-full border-r min-w-0 relative" style={{ borderColor: 'var(--border-primary)' }}>
          <TickChart
            symbol={symbol}
            width={250}
            height={mainContentHeight}
            chartMode={chartMode}
            crosshair={crosshair}
            zoomLevel={zoomLevel}
            typography={typography}
            digits={digits}
          />
        </div>

        {/* ── Right: DOM Table ── */}
        <div className="flex-[49] flex flex-col min-w-[232px] overflow-hidden">
          {/* Scrollable Price Levels (sticky column headers inside so vertical rules align 1:1 with scrollbar) */}
          <div className="rtx-dom-ladder-scroll flex-1 overflow-y-auto overflow-x-hidden" style={{ background: 'var(--bg-secondary)' }}>
            {/* Column Headers */}
            <div
              className="rtx-depth-of-market__columns grid sticky top-0 z-[2] border-b"
              style={{
                gridTemplateColumns: ladderColumns,
                minHeight: COLUMN_HEADER_HEIGHT,
                fontSize: 10.5,
                fontWeight: 600,
                borderColor: 'var(--border-primary)',
                background: 'var(--bg-tertiary)',
              }}
            >
              <div
                className="flex items-center justify-end px-2 border-r uppercase whitespace-nowrap"
                style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary, #909098)', letterSpacing: '0.03em' }}
                title={depthLevels.synthetic ? tr("No depth feed for this symbol — showing a price ladder around the live quote") : undefined}
              >
                {tr("Volume")}</div>
              <div className="flex items-center justify-end px-2 border-r uppercase whitespace-nowrap" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary, #909098)', letterSpacing: '0.03em' }}>
                {tr("Price")}</div>
              <div className="flex items-center justify-center px-1 uppercase whitespace-nowrap" style={{ color: 'var(--text-secondary, #909098)', letterSpacing: '0.03em' }}>
                {tr("Trade")}</div>
            </div>
            {depthLevels.asks.length === 0 && depthLevels.bids.length === 0 && (
              <div
                className="flex items-center justify-center px-3 text-center text-[13px] leading-[20px] font-normal"
                style={{ height: `calc(100% - ${effectiveHeaderH}px)`, color: 'var(--text-tertiary, #5c5c64)' }}
              >
                {depthLoading ? tr("Loading market depth...") : depthError || tr("No market depth available")}
              </div>
            )}
            {/* ── ASK (Sell) rows ── */}
            {depthLevels.asks.map((level, i) => {
              const isNearSpread = i === depthLevels.asks.length - 1;
              const [priceBase, pricePips] = splitLadderPrice(level.price, digits);
              const cellBorder = 'color-mix(in srgb, var(--border-primary, #38383c) 58%, transparent)';
              return (
                <div
                  key={`ask-${i}`}
                  className={`rtx-depth-of-market__row rtx-dom-level rtx-dom-level--ask ${isNearSpread ? 'rtx-dom-level--best-ask' : ''} grid`}
                  style={{
                    gridTemplateColumns: ladderColumns,
                    height: ROW_H,
                    borderBottom: `1px solid ${cellBorder}`,
                  }}
                  onClick={() => onPlaceOrder?.(buildDepthOrderRequest('SELL', level.price, volume, depthExecutionForLevel('SELL', level.price, bestBid, bestAsk), digits, sl, tp))}
                  onMouseDown={e => e.stopPropagation()}
                >
                  <div className="flex items-center justify-end px-2 border-r" style={{ borderColor: cellBorder }}>
                    {level.volume > 0 ? (
                      <span
                        className="text-[12px]"
                        style={{
                          fontFamily: MONO,
                          color: C.loss,
                          fontWeight: isNearSpread ? 600 : 400,
                          opacity: isNearSpread ? 1 : 0.78,
                        }}
                      >
                        {level.volume.toFixed(2)}
                      </span>
                    ) : (
                      <span className="rtx-dom-vol-placeholder text-[11px]" style={{ fontFamily: MONO }}>—</span>
                    )}
                  </div>
                  <div className="flex items-center justify-end px-2 border-r" style={{ borderColor: cellBorder }}>
                    <span
                      className="rtx-dom-price rtx-dom-price--ask"
                      style={{
                        fontFamily: MONO,
                        fontSize: typography.fontSize,
                        fontWeight: isNearSpread ? 600 : 400,
                        color: C.loss,
                      }}
                    >
                      {priceBase}<span className="rtx-dom-price__pips" style={{ fontWeight: 600 }}>{pricePips}</span>
                    </span>
                  </div>
                  <div className="flex items-center justify-center">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); onPlaceOrder?.(buildDepthOrderRequest('SELL', level.price, volume, depthExecutionForLevel('SELL', level.price, bestBid, bestAsk), digits, sl, tp)); }}
                      onMouseDown={e => e.stopPropagation()}
                      className="rtx-dom-trade-btn rtx-dom-trade-btn--sell"
                      title={tr("Sell @ {{value0}}", { value0: formatPrice(level.price, digits ?? undefined) })}
                      aria-label={tr("Sell @ {{value0}}", { value0: formatPrice(level.price, digits ?? undefined) })}
                    >
                      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <path d="M2 3.25L5 6.75L8 3.25Z" fill="currentColor" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}

            {/* ── Spread row ── */}
            {(bestBid > 0 || bestAsk > 0) && (
              <div
                className="rtx-depth-of-market__row rtx-dom-spread flex items-center justify-center gap-1.5"
                style={{
                  height: ROW_H,
                  background: 'var(--bg-tertiary)',
                  borderBottom: '1px solid var(--border-primary)',
                }}
              >
                <span className="rtx-dom-spread__label uppercase" style={{ color: 'var(--text-secondary, #909098)', fontSize: 10.5, fontWeight: 500, letterSpacing: '0.06em' }}>
                  {tr("Spread")}</span>
                <span className="rtx-dom-spread__badge uppercase" style={{ fontFamily: MONO }}>
                  {digits === null
                    ? String(Number((bestAsk - bestBid).toFixed(8)))
                    : `${((bestAsk - bestBid) * Math.pow(10, digits)).toFixed(1)} ${tr("pts")}`}
                </span>
              </div>
            )}

            {/* ── BID (Buy) rows ── */}
            {depthLevels.bids.map((level, i) => {
              const isNearSpread = i === 0;
              const [priceBase, pricePips] = splitLadderPrice(level.price, digits);
              const cellBorder = 'color-mix(in srgb, var(--border-primary, #38383c) 58%, transparent)';
              return (
                <div
                  key={`bid-${i}`}
                  className={`rtx-depth-of-market__row rtx-dom-level rtx-dom-level--bid ${isNearSpread ? 'rtx-dom-level--best-bid' : ''} grid`}
                  style={{
                    gridTemplateColumns: ladderColumns,
                    height: ROW_H,
                    borderBottom: `1px solid ${cellBorder}`,
                  }}
                  onClick={() => onPlaceOrder?.(buildDepthOrderRequest('BUY', level.price, volume, depthExecutionForLevel('BUY', level.price, bestBid, bestAsk), digits, sl, tp))}
                  onMouseDown={e => e.stopPropagation()}
                >
                  <div className="flex items-center justify-end px-2 border-r" style={{ borderColor: cellBorder }}>
                    {level.volume > 0 ? (
                      <span
                        className="text-[12px]"
                        style={{
                          fontFamily: MONO,
                          color: C.profit,
                          fontWeight: isNearSpread ? 600 : 400,
                          opacity: isNearSpread ? 1 : 0.78,
                        }}
                      >
                        {level.volume.toFixed(2)}
                      </span>
                    ) : (
                      <span className="rtx-dom-vol-placeholder text-[11px]" style={{ fontFamily: MONO }}>—</span>
                    )}
                  </div>
                  <div className="flex items-center justify-end px-2 border-r" style={{ borderColor: cellBorder }}>
                    <span
                      className="rtx-dom-price rtx-dom-price--bid"
                      style={{
                        fontFamily: MONO,
                        fontSize: typography.fontSize,
                        fontWeight: isNearSpread ? 600 : 400,
                        color: C.profit,
                      }}
                    >
                      {priceBase}<span className="rtx-dom-price__pips" style={{ fontWeight: 600 }}>{pricePips}</span>
                    </span>
                  </div>
                  <div className="flex items-center justify-center">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); onPlaceOrder?.(buildDepthOrderRequest('BUY', level.price, volume, depthExecutionForLevel('BUY', level.price, bestBid, bestAsk), digits, sl, tp)); }}
                      onMouseDown={e => e.stopPropagation()}
                      className="rtx-dom-trade-btn rtx-dom-trade-btn--buy"
                      title={tr("Buy @ {{value0}}", { value0: formatPrice(level.price, digits ?? undefined) })}
                      aria-label={tr("Buy @ {{value0}}", { value0: formatPrice(level.price, digits ?? undefined) })}
                    >
                      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <path d="M2 6.75L5 3.25L8 6.75Z" fill="currentColor" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Sell / Close / Buy Buttons ── */}
      <div className="rtx-dom-exec-footer flex items-center shrink-0" style={{ borderTop: '1px solid var(--border-primary)' }}>
        <button
          type="button"
          onClick={() => onPlaceOrder?.(buildDepthOrderRequest('SELL', bestBid, volume, 'market', digits, sl, tp))}
          onMouseDown={e => e.stopPropagation()}
          className="rtx-dom-exec-btn rtx-dom-exec-btn--sell"
          title={tr("Sell {{value0}} at market", { value0: volume.toFixed(2) })}
        >
          <span className="rtx-dom-exec-btn__caption">{tr("Sell")}</span>
          <span className="rtx-dom-exec-btn__price">{bestBid > 0 ? formatPrice(bestBid, digits ?? undefined) : '—'}</span>
        </button>
        <button
          type="button"
          onClick={handleCloseAll}
          onMouseDown={e => e.stopPropagation()}
          className="rtx-dom-exec-btn rtx-dom-exec-btn--flat"
          title={tr("Close all {{value0}} positions", { value0: symbol })}
        >
          <span className="rtx-dom-exec-btn__caption">{tr("Close All")}</span>
          <span className="rtx-dom-exec-btn__price rtx-dom-exec-btn__symbol">{symbol}</span>
        </button>
        <button
          type="button"
          onClick={() => onPlaceOrder?.(buildDepthOrderRequest('BUY', bestAsk, volume, 'market', digits, sl, tp))}
          onMouseDown={e => e.stopPropagation()}
          className="rtx-dom-exec-btn rtx-dom-exec-btn--buy"
          title={tr("Buy {{value0}} at market", { value0: volume.toFixed(2) })}
        >
          <span className="rtx-dom-exec-btn__caption">{tr("Buy")}</span>
          <span className="rtx-dom-exec-btn__price">{bestAsk > 0 ? formatPrice(bestAsk, digits ?? undefined) : '—'}</span>
        </button>
      </div>
    </div>
  );
};
