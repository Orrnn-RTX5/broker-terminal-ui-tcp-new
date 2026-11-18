// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTradingChartTradeRuntime } from './useTradingChartTradeRuntime';
import { useTradingChartTradeOverlayRenderer } from './useTradingChartTradeOverlayRenderer';
import type { OverlayNodeData } from './tradeRuntimeContracts';

vi.mock('./useTradingChartTradeOverlayRenderer', () => ({ useTradingChartTradeOverlayRenderer: vi.fn() }));
vi.mock('./useTradingChartTradeLevelDrag', () => ({ useTradingChartTradeLevelDrag: vi.fn() }));
vi.mock('../../../services/drawingManager', () => ({ drawingManager: {} }));

const ref = <T,>(current: T) => ({ current });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

const candle = (time: number, close: number) => ({ time, open: close - 0.01, high: close + 0.02, low: close - 0.02, close });

const fixture = () => {
  const wrapper = document.createElement('div');
  const container = document.createElement('div');
  const overlay = document.createElement('div');
  wrapper.append(container, overlay);
  document.body.append(wrapper);
  vi.spyOn(container, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(container, 'offsetHeight', 'get').mockReturnValue(400);

  const scale = { value: 1000 };
  const range = { from: 0, to: 10 };
  const priceToCoordinate = vi.fn((price: number) => 400 - (price - 1) * scale.value);
  const candles = [candle(1000, 1.1), candle(1060, 1.12), candle(1120, 1.11), candle(1180, 1.13)];
  const live = ref<ReturnType<typeof candle> | null>(candle(1240, 1.14));
  const repaint = ref(() => undefined);
  const options = {
    activeChartSourceId: 'chart-a', brokerAccountSessionScope: 'account-a', symbol: 'BTCUSD', timeframe: 'M1',
    activeTradeSnapshotsRef: ref(new Map()), containerRef: ref(container), overlayRef: ref(overlay),
    candlesRef: ref(candles), currentCandleRef: live, candlesLoadedRev: 0,
    chartRef: ref({
      timeScale: () => ({
        height: () => 20,
        getVisibleLogicalRange: () => range,
        timeToCoordinate: (time: number) => ((time - 1000) / 60) * 40,
      }),
    }),
    seriesRef: ref({ priceScale: () => ({ width: () => 60 }), priceToCoordinate }),
    chartSettingsRef: ref({ showBidPriceLine: false }), postInteractionCallbacksRef: ref({}),
    hideLivePriceOverlay: vi.fn(),
    repaintTradeOverlayGeometryRef: repaint, tr: <T,>(source: T) => source,
  } as unknown as Parameters<typeof useTradingChartTradeRuntime>[0];
  renderHook(() => useTradingChartTradeRuntime(options));
  const runtime = vi.mocked(useTradingChartTradeOverlayRenderer).mock.lastCall![0];

  const addHistoryNode = (el: HTMLElement, data: Omit<OverlayNodeData, 'layoutCache'>) => {
    wrapper.append(el);
    runtime.historyOverlayNodesRef.current.push(el);
    runtime.historyOverlayNodeDataRef.current.push({ ...data, layoutCache: { placed: false, live: false, styles: {} } });
    return runtime.historyOverlayNodeDataRef.current.at(-1)!;
  };
  const relayout = () => act(() => repaint.current());
  return { runtime, addHistoryNode, relayout, scale, range, live, priceToCoordinate };
};

const marker = () => {
  const el = document.createElement('div');
  el.className = 'rtx-trade-marker rtx-trade-marker--history';
  return el;
};
const line = () => {
  const el = document.createElement('div');
  el.className = 'rtx-trade-history-line';
  el.style.height = '1px';
  return el;
};

describe('closed-trade (history) overlay relayout', () => {
  it('does not write styles to history nodes on per-tick relayouts, only when the viewport changes', () => {
    const { addHistoryNode, relayout, scale, live } = fixture();
    const el = marker();
    addHistoryNode(el, { kind: 'marker', price: 1.12, time: 1060, markerSide: 'BUY', markerAnchor: 'candle', pixelOffsetY: -1 });
    const left = vi.spyOn(el.style, 'left', 'set');
    const top = vi.spyOn(el.style, 'top', 'set');
    const display = vi.spyOn(el.style, 'display', 'set');

    relayout();
    expect(left).toHaveBeenCalledTimes(1);
    expect(top).toHaveBeenCalledTimes(1);
    expect(display).toHaveBeenCalledTimes(1);

    // Live ticks only change the live candle: the old marker is neither recomputed nor rewritten.
    for (let tick = 0; tick < 25; tick += 1) {
      live.current = candle(1240, 1.14 + tick * 0.001);
      relayout();
    }
    expect(left).toHaveBeenCalledTimes(1);
    expect(top).toHaveBeenCalledTimes(1);
    expect(display).toHaveBeenCalledTimes(1);

    // A price-scale change moves the node: it is laid out again.
    scale.value = 1200;
    relayout();
    expect(top).toHaveBeenCalledTimes(2);
  });

  it('keeps recomputing only the segments that reach the live candle', () => {
    const { addHistoryNode, relayout, live } = fixture();
    const oldLine = line();
    const liveLine = line();
    const oldData = addHistoryNode(oldLine, { kind: 'segment', price: 1.1, time: 1000, endPrice: 1.12, endTime: 1060 });
    const liveData = addHistoryNode(liveLine, { kind: 'segment', price: 1.12, time: 1120, endPrice: 1.14, endTime: 1240 });
    relayout();
    expect(oldData.layoutCache?.live).toBe(false);
    expect(liveData.layoutCache?.live).toBe(true);

    const oldWidth = vi.spyOn(oldLine.style, 'width', 'set');
    const liveMaskBefore = liveData.layoutCache?.styles.maskImage;
    live.current = candle(1240, 1.2);
    relayout();
    relayout();
    expect(oldWidth).not.toHaveBeenCalled();
    expect(liveData.layoutCache?.styles.maskImage).not.toBe(liveMaskBefore);
  });
});
