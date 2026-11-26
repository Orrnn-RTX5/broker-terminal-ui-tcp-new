// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { candleCache } from '../../../services/candleCache';
import { candleAggregationService } from '../../../services/candleAggregationService';
import { createChartHistoryBackfillDiagnostics, createSelectedTimeframeHistoryCoordinator } from '../../../services/chartHistoryLoader';
import { createRenderedPriceReference } from '../../../services/chartPriceGuards';
import { defaultChartProperties } from '../../../store/useChartSettingsStore';
import type { Candle, Timeframe } from '../../../types/chart';
import { CANDLE_TIMEFRAMES } from '../../../utils/timeframeBoundary';
import { useTradingChartHistoryLoading } from './useTradingChartHistoryLoading';

const transport = vi.hoisted(() => ({
  fetch: vi.fn(),
  derive: vi.fn(),
  ticks: {} as Record<string, unknown>,
  ready: true,
}));

vi.mock('../../../store/useAppStore', () => ({ useAppStore: { getState: () => ({ ticks: transport.ticks }) } }));
vi.mock('../../../services/chartDataService', () => ({
  chartDataService: {
    fetchCandles: transport.fetch,
    normalizeTimeframe: (timeframe: string) => timeframe,
    getCandleCacheScope: () => 'preload-test-broker',
  },
}));
vi.mock('../../../services/derivedTimeframeHistoryService', async importOriginal => ({
  ...await importOriginal<typeof import('../../../services/derivedTimeframeHistoryService')>(),
  fetchDerivedTimeframeCandlesFromM1: transport.derive,
}));
vi.mock('../../../startup/waitForTerminalReady', () => ({
  waitForTerminalReady: (signal: AbortSignal) => Promise.resolve(!signal.aborted && transport.ready),
}));

type Options = Parameters<typeof useTradingChartHistoryLoading>[0];
const ref = <T,>(current: T) => ({ current });
const flushBackgroundTasks = async () => {
  for (let pass = 0; pass < 12; pass += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
    });
  }
};

const makeSeries = (count: number, stepSeconds: number, startTime = Date.UTC(2026, 9, 1, 0, 0) / 1000): Candle[] =>
  Array.from({ length: count }, (_, index) => ({
    time: startTime + index * stepSeconds,
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 5,
    tickVolume: 5,
    closed: index < count - 1,
  }));

const createHarness = (initialTf: Timeframe = 'M1') => {
  const coordinator = createSelectedTimeframeHistoryCoordinator();
  const buildHistoryCacheTarget = (activeTf: Timeframe) => {
    const metadata = {
      scope: 'preload-test-broker',
      symbol: 'BTCUSD',
      timeframe: activeTf,
      limit: activeTf === 'M1' ? 5000 : 500,
    };
    return { key: candleCache.createKey(metadata), metadata };
  };
  const setHistoryCache = (
    activeTf: Timeframe,
    candles: Candle[],
    brokerOffsetSeconds = 0,
    source: 'backend' | 'derived-m1' | 'mixed' = 'backend',
  ) => {
    const { key, metadata } = buildHistoryCacheTarget(activeTf);
    candleCache.setLatest(key, candles, { ...metadata, brokerOffsetSeconds, source });
  };
  const mergeHistoryCache = (
    activeTf: Timeframe,
    candles: Candle[],
    brokerOffsetSeconds = 0,
    source: 'backend' | 'derived-m1' | 'mixed' = 'backend',
  ) => {
    const { key, metadata } = buildHistoryCacheTarget(activeTf);
    candleCache.mergeLatest(key, candles, { ...metadata, brokerOffsetSeconds, source });
  };

  const options = {
    symbol: 'BTCUSD',
    timeframe: initialTf,
    brokerTimeOffsetSec: 0,
    brokerTimeOffsetSecRef: ref(0),
    candlesRef: ref<Candle[]>([]),
    currentCandleRef: ref<Candle | null>(null),
    chartRef: ref({ timeScale: () => ({ scrollToRealTime: vi.fn() }) }),
    chartSettingsRef: ref(defaultChartProperties),
    seriesRef: ref({ setData: vi.fn() }),
    volumeRef: ref({ setData: vi.fn() }),
    historyRequestCoordinatorRef: ref(coordinator),
    historyBackfillDiagnosticsRef: ref(createChartHistoryBackfillDiagnostics()),
    hasDisplayedHistoryRef: ref(false),
    protectedDisplayedHistoryRef: ref<Candle[]>([]),
    hasReachedBeginningRef: ref(false),
    isLoadingMoreRef: ref(false),
    isDisposedRef: ref(false),
    initialHistoryLoadPendingRef: ref(false),
    initialHistoryLoadSequenceRef: ref(0),
    lastStoreCandleSecRef: ref(0),
    prevPriceRef: ref(null),
    prevTimeframeRef: ref(initialTf),
    liveCandleMutationGenerationRef: ref(0),
    liveCandleMutationGenerationByTimeRef: ref(new Map()),
    renderedPriceReferenceRef: ref(createRenderedPriceReference([])),
    resetVisibleRangeOnNextDataRef: ref(true),
    scheduleBoundaryTimerRef: ref(null),
    hydrateHistoryFromCache: vi.fn(() => false),
    restoreProtectedDisplayedHistory: vi.fn(() => false),
    reconcileCandlesWithLiveQuote: vi.fn((rows: Candle[]) => rows),
    getLatestRenderableCandle: (rows: Candle[]) => rows.at(-1) ?? null,
    discardRetainedPublicChartSurface: vi.fn(),
    resetEmptyHistoryState: vi.fn(),
    resetLiveQuotePriceGuard: vi.fn(),
    setLoadingPhase: vi.fn(),
    setApiError: vi.fn(),
    updateChartData: vi.fn(),
    requestChartDataRender: vi.fn(),
    updateLegendDOM: vi.fn(),
    setHistoryCache,
    mergeHistoryCache,
    reloadAggregationCandles: (rows: Candle[], tf: Timeframe, offset = 0) => {
      candleAggregationService.loadHistoricalCandles(
        'BTCUSD',
        tf,
        rows.map(row => ({
          time: row.time,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume ?? 0,
          isComplete: row.closed,
        })),
        offset,
      );
    },
    buildHistoryCacheTarget,
    fetchOlderHistoryPage: vi.fn(),
    isVisibleRangeHistoryLoadSuppressed: () => false,
  } as unknown as Options;

  return { options, coordinator, buildHistoryCacheTarget };
};

beforeEach(() => {
  transport.fetch.mockReset();
  transport.derive.mockReset();
  transport.ticks = {};
  transport.ready = true;
  candleCache.clearAll();
  candleAggregationService.clearAll();
});

afterEach(() => {
  cleanup();
  candleCache.clearAll();
  candleAggregationService.clearAll();
});

describe('background M1-to-MN timeframe preloading', () => {
  it('warms M5-H1 from M1 in memory and preloads H4-MN smoothly in the background', async () => {
    const m1FirstPaint = makeSeries(500, 60, Date.UTC(2026, 9, 1, 0, 0) / 1000);
    const m1Full = makeSeries(2_400, 60, Date.UTC(2026, 8, 29, 16, 20) / 1000);
    const stepByTf: Record<string, number> = {
      M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN: 2592000,
    };

    transport.fetch.mockImplementation(async ({ timeframe, count }: { timeframe: string; count: number }) => {
      if (timeframe === 'M1' && count === 500) return m1FirstPaint;
      if (timeframe === 'M1') return m1Full;
      return makeSeries(30, stepByTf[timeframe] ?? 14400);
    });

    const harness = createHarness('M1');
    const view = renderHook(() => useTradingChartHistoryLoading(harness.options));
    await act(() => view.result.current.loadHistory('BTCUSD', 'M1'));
    await flushBackgroundTasks();

    for (const tf of CANDLE_TIMEFRAMES) {
      const cached = candleCache.getLatest(harness.buildHistoryCacheTarget(tf as Timeframe).key);
      expect(cached?.candles.length ?? 0).toBeGreaterThanOrEqual(30);
    }

    const fetchedTimeframes = transport.fetch.mock.calls.map(([req]) => req.timeframe);
    expect(fetchedTimeframes).toContain('H4');
    expect(fetchedTimeframes).toContain('D1');
    expect(fetchedTimeframes).toContain('W1');
    expect(fetchedTimeframes).toContain('MN');
    expect(fetchedTimeframes).not.toContain('M5');
    expect(fetchedTimeframes).not.toContain('M15');
    expect(fetchedTimeframes).not.toContain('M30');
    expect(fetchedTimeframes).not.toContain('H1');
  });

  it('derives M5-H1 from preloaded M1 and warms remaining frames when starting on H4', async () => {
    const m1Full = makeSeries(2_400, 60, Date.UTC(2026, 8, 29, 16, 20) / 1000);
    const stepByTf: Record<string, number> = {
      H4: 14400, D1: 86400, W1: 604800, MN: 2592000,
    };

    transport.fetch.mockImplementation(async ({ timeframe }: { timeframe: string }) => {
      if (timeframe === 'M1') return m1Full;
      return makeSeries(30, stepByTf[timeframe] ?? 14400);
    });

    const harness = createHarness('H4');
    const view = renderHook(() => useTradingChartHistoryLoading(harness.options));
    await act(() => view.result.current.loadHistory('BTCUSD', 'H4'));
    await flushBackgroundTasks();

    for (const tf of CANDLE_TIMEFRAMES) {
      const cached = candleCache.getLatest(harness.buildHistoryCacheTarget(tf as Timeframe).key);
      expect(cached?.candles.length ?? 0).toBeGreaterThanOrEqual(30);
    }

    const fetchedTimeframes = transport.fetch.mock.calls.map(([req]) => req.timeframe);
    expect(fetchedTimeframes).toHaveLength(5);
    expect(fetchedTimeframes).toEqual(expect.arrayContaining(['H4', 'M1', 'D1', 'W1', 'MN']));
  });

  it('skips redundant history fetches on fresh cache hits while syncing the live quote tail', async () => {
    const h4Cached = makeSeries(30, 14400, Date.UTC(2026, 9, 1, 0, 0) / 1000);
    const d1Cached = makeSeries(30, 86400, Date.UTC(2026, 9, 1, 0, 0) / 1000);
    const harness = createHarness('H4');
    harness.options.setHistoryCache('H4', h4Cached, 0, 'backend');
    harness.options.setHistoryCache('D1', d1Cached, 0, 'backend');
    vi.mocked(harness.options.hydrateHistoryFromCache).mockImplementation(() => {
      harness.options.candlesRef.current = h4Cached;
      harness.options.currentCandleRef.current = { ...h4Cached[h4Cached.length - 1] };
      return true;
    });
    const latestBucketStart = h4Cached[h4Cached.length - 1].time;
    transport.ticks.BTCUSD = {
      symbol: 'BTCUSD',
      bid: 108,
      ask: 109,
      rawBid: 108,
      rawAsk: 109,
      timestamp: (latestBucketStart + 120) * 1000,
      sourceTimestamp: (latestBucketStart + 120) * 1000,
    };
    transport.fetch.mockImplementation(async ({ timeframe }: { timeframe: string }) => {
      if (timeframe === 'M1') return makeSeries(2_400, 60, Date.UTC(2026, 8, 29, 16, 20) / 1000);
      return makeSeries(30, 86400);
    });

    const view = renderHook(() => useTradingChartHistoryLoading(harness.options));
    await act(() => view.result.current.loadHistory('BTCUSD', 'H4'));
    await flushBackgroundTasks();

    const fetchedTimeframes = transport.fetch.mock.calls.map(([req]) => req.timeframe);
    expect(fetchedTimeframes).not.toContain('H4');
    expect(fetchedTimeframes).not.toContain('D1');
    expect(fetchedTimeframes).toEqual(expect.arrayContaining(['M1', 'W1', 'MN']));
    expect(harness.options.currentCandleRef.current?.close).toBe(108);
    expect(harness.options.requestChartDataRender).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'cached-live-quote',
    }));
  });

  it('cancels parallel background timeframe preloading immediately when selection is aborted', async () => {
    const h4Candles = makeSeries(30, 14400);
    const pendingRejects: Array<(error: Error) => void> = [];
    transport.fetch.mockImplementation(({ timeframe, signal }: { timeframe: string; signal?: AbortSignal }) => {
      if (timeframe === 'H4') return Promise.resolve(h4Candles);
      return new Promise((_, reject) => {
        pendingRejects.push(reject);
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });

    const harness = createHarness('H4');
    const view = renderHook(() => useTradingChartHistoryLoading(harness.options));
    await act(() => view.result.current.loadHistory('BTCUSD', 'H4'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });

    const preloadedTimeframes = transport.fetch.mock.calls.slice(1).map(([req]) => req.timeframe);
    expect(preloadedTimeframes).toEqual(expect.arrayContaining(['M1', 'D1', 'W1', 'MN']));

    const callsAtAbort = transport.fetch.mock.calls.length;
    act(() => {
      harness.coordinator.abort();
      for (const reject of pendingRejects) reject(new DOMException('Aborted', 'AbortError'));
    });
    await flushBackgroundTasks();

    expect(transport.fetch).toHaveBeenCalledTimes(callsAtAbort);
    expect(candleCache.getLatest(harness.buildHistoryCacheTarget('M1').key)).toBeNull();
    expect(candleCache.getLatest(harness.buildHistoryCacheTarget('D1').key)).toBeNull();
  });
});
