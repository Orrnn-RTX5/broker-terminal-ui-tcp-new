import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandleStreamOptions } from '../../../services/chartDataService';
import { candleAggregationService } from '../../../services/candleAggregationService';
import type { Candle } from '../../../types/chart';
import { useTradingChartLiveCandleRuntime } from './useTradingChartLiveCandleRuntime';

const transport = vi.hoisted(() => ({
  streams: [] as CandleStreamOptions[],
  quoteHandlers: [] as Array<(tick: Record<string, unknown>) => void>,
}));
vi.mock('../../../services/chartDataService', () => ({
  chartDataService: { subscribeCandles: (options: CandleStreamOptions) => {
    transport.streams.push(options);
    return { close: vi.fn() };
  } },
}));
vi.mock('../../../services/quoteSocketManager', () => ({
  getQuoteSocketManager: () => ({
    onQuoteSnapshot: (_symbol: string, handler: (tick: Record<string, unknown>) => void) => {
      transport.quoteHandlers.push(handler);
      return vi.fn();
    },
  }),
}));
vi.mock('../../../store/useAppStore', () => ({ useAppStore: { getState: () => ({ ticks: {} }) } }));

type Options = Parameters<typeof useTradingChartLiveCandleRuntime>[0];
const ref = <T,>(current: T) => ({ current });
const minuteStart = 1_788_240_000;

const createOptions = (update: ReturnType<typeof vi.fn>): Options => ({
  symbol: 'BTCUSD', timeframe: 'M1', authToken: 'account-a-token',
  brokerAccountSessionScope: 'account-a',
  chartSelectionPresentationKey: 'account-a:BTCUSD:M1',
  chartSelectionPresentationRef: ref({ selectionKey: 'account-a:BTCUSD:M1', livePaintAllowed: true }),
  visibleRuntime: { history: true, status: true, quote: true, candle: true, interval: true, overlay: true },
  isActive: true, isActiveRef: ref(true), isDisposedRef: ref(false), isRebuildingRef: ref(false),
  liveMarketDataFrozenRef: ref(false), isChartInteractionActiveRef: ref(false),
  initialHistoryLoadPendingRef: ref(false),
  brokerTimeOffsetSecRef: ref(0), synchronizedMarketClockRef: ref(null),
  prevTimeframeRef: ref('M1'), candlesRef: ref([]),
  currentCandleRef: ref<Candle>({ time: minuteStart, open: 100, high: 102, low: 99, close: 100, volume: 10 }),
  liveCandleMutationGenerationByTimeRef: ref(new Map()), liveCandleMutationGenerationRef: ref(0),
  postInteractionCallbacksRef: ref({}), postInteractionCoordinatorRef: ref(null),
  seriesRef: ref({ update }), chartRef: ref(null), volumeRef: ref(null),
  chartSettingsRef: ref({ chartShift: false, chartAutoScroll: false, showTickVolumes: true }),
  prevChartTypeRef: ref('candlestick'), lastRenderedCandlesRef: ref([]),
  drawingRuntimeContextRef: ref({ contextId: 'chart-a', symbol: 'BTCUSD', timeframe: 'M1' }),
  drawingRenderFrameRef: ref(1), drawingRenderSettledFrameRef: ref(1),
  updateLegendDOM: vi.fn(), repaintLivePriceOverlayFromCurrentPrice: vi.fn(),
  flushPostInteractionWork: vi.fn(),
  hasDisplayedHistoryRef: ref(true), protectedDisplayedHistoryRef: ref([]),
  lastAcceptedQuoteRef: ref(null), incompatibleQuoteCountRef: ref(0),
  activeTradeSnapshotsRef: ref(new Map()), tradeLevelCrossRefreshPendingRef: ref(new Set()),
  getSynchronizedChartMarketNowMs: () => (minuteStart + 10) * 1000,
  synchronizeChartMarketClock: vi.fn(),
  reconcileCandlesWithLiveQuote: (candles: Candle[]) => candles,
  validateRenderedCandlesAgainstLivePrice: vi.fn(() => true), isLivePriceSafeForCandles: vi.fn(() => true),
  syncSupplementalPriceLines: vi.fn(), setApiError: vi.fn(), discardRetainedPublicChartSurface: vi.fn(),
  setHistoryCache: vi.fn(), updateChartData: vi.fn(),
  scheduleBoundaryTimerRef: ref(null),
} as unknown as Options);

const sendTick = (price: number, tsSec: number): void => {
  act(() => {
    transport.quoteHandlers.forEach((handler) => handler({
      symbol: 'BTCUSD', bid: price, ask: price + 0.2, timestamp: tsSec * 1000,
    }));
  });
};

let rafCallbacks: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextRafId = 1;
const originalRaf = window.requestAnimationFrame;
const originalCancel = window.cancelAnimationFrame;
const runFrame = (): void => {
  const pending = rafCallbacks;
  rafCallbacks = [];
  act(() => { pending.forEach(({ cb }) => cb(performance.now())); });
};

beforeEach(() => {
  vi.useFakeTimers();
  transport.streams = [];
  transport.quoteHandlers = [];
  rafCallbacks = [];
  nextRafId = 1;
  // Manual frame control: a "paused" rAF is simply a frame that never runs.
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafCallbacks.push({ id, cb });
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    rafCallbacks = rafCallbacks.filter((entry) => entry.id !== id);
  }) as typeof window.cancelAnimationFrame;
  candleAggregationService.getSymbols().forEach((symbol) => candleAggregationService.clearSymbol(symbol));
});
afterEach(() => {
  window.requestAnimationFrame = originalRaf;
  window.cancelAnimationFrame = originalCancel;
  vi.useRealTimers();
});

describe('live paint watchdog', () => {
  it('paints exactly once through the 100 ms watchdog when rAF never fires', () => {
    const update = vi.fn();
    const view = renderHook(() => useTradingChartLiveCandleRuntime(createOptions(update)));
    update.mockClear();

    sendTick(101, minuteStart + 20);
    expect(update).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(99); });
    expect(update).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(update).toHaveBeenCalledTimes(1);
    expect(rafCallbacks).toHaveLength(0);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(update).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('paints once per frame and leaves no timer behind when rAF fires in time', () => {
    const update = vi.fn();
    const view = renderHook(() => useTradingChartLiveCandleRuntime(createOptions(update)));
    update.mockClear();

    sendTick(101, minuteStart + 20);
    sendTick(101.5, minuteStart + 21);
    expect(update).not.toHaveBeenCalled();
    expect(rafCallbacks).toHaveLength(1);
    const timersWithWatchdog = vi.getTimerCount();

    runFrame();
    expect(update).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(timersWithWatchdog - 1);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(update).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('clears the watchdog on unmount without painting', () => {
    const update = vi.fn();
    const view = renderHook(() => useTradingChartLiveCandleRuntime(createOptions(update)));
    update.mockClear();
    sendTick(101, minuteStart + 20);
    const pendingBefore = vi.getTimerCount();
    view.unmount();
    expect(vi.getTimerCount()).toBeLessThan(pendingBefore);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('premature closed M1 candle', () => {
  it('does not finalize the current minute, so later ticks still update the live candle', () => {
    const update = vi.fn();
    const options = createOptions(update);
    const view = renderHook(() => useTradingChartLiveCandleRuntime(options));
    const stream = transport.streams[transport.streams.length - 1];
    expect(stream).toBeDefined();

    act(() => {
      stream.onCandle?.({
        time: minuteStart, open: 100, high: 103, low: 99, close: 101, volume: 12, closed: true,
      } as Candle);
    });
    sendTick(110, minuteStart + 30);
    expect(options.currentCandleRef.current?.time).toBe(minuteStart);
    expect(options.currentCandleRef.current?.close).toBe(110);
    view.unmount();
  });
});
