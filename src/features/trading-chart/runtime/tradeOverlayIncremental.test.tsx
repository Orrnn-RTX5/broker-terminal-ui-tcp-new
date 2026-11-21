// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../store/useAppStore';
import { TRADE_OVERLAY_CLOSE_STATE_EVENT } from '../../../services/tradeOverlayHistory';
import { buildClosedTradeHistorySnapshots } from '../../../services/tradeOverlayHistory';
import { TRADE_OVERLAY_REFRESH_EVENT } from '../../../services/tradeOverlayRefreshEvents';
import { buildTradeShareUrl, resetSharedChartTradeCache } from '../../../utils/tradeShareLink';
import { TRADE_LEVEL_BADGE_LEFT_INSET_PX, TRADE_LEVEL_BADGE_STACK_OFFSET_PX } from '../presentation/tradeOverlayPresentation';
import { useTradingChartTradeOverlayRenderer } from './useTradingChartTradeOverlayRenderer';

// Real DOM runtime (real nodes), stubbed model runtime: the renderer's keyed active reconcile runs for real.
const runtime = vi.hoisted(() => {
  type Stub = (...args: unknown[]) => Stub;
  const deepStub = (): Stub => {
    const children = new Map<PropertyKey, unknown>();
    return new Proxy(function stub() {} as unknown as Stub, {
      get(_target, key) {
        if (key === 'then') return undefined;
        if (key === Symbol.toPrimitive) return () => 0;
        if (!children.has(key)) children.set(key, deepStub());
        return children.get(key);
      },
      apply() { return deepStub(); },
    });
  };
  const stubWith = (members: Record<string, unknown>) => {
    const fallback = deepStub() as unknown as Record<PropertyKey, unknown>;
    return new Proxy({}, {
      get(_target, key) {
        if (typeof key === 'string' && key in members) return members[key];
        return fallback[key];
      },
    });
  };
  return { deepStub, stubWith, modelFactory: vi.fn(() => deepStub()), queueRelayout: vi.fn() };
});

vi.mock('./createTradeOverlayModelRuntime', () => ({ createTradeOverlayModelRuntime: runtime.modelFactory }));
vi.mock('../../../services/tradeOverlayHistory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/tradeOverlayHistory')>();
  return { ...actual, buildClosedTradeHistorySnapshots: vi.fn(actual.buildClosedTradeHistorySnapshots) };
});

type RendererOptions = Parameters<typeof useTradingChartTradeOverlayRenderer>[0];

const SYMBOL = 'EURUSD';
const OPEN_TIME_SEC = 1_699_999_000;

const position = (index: number, overrides: Record<string, unknown> = {}) => {
  const price = 1.1 + index * 0.0001;
  return {
    id: 1000 + index, ticket: 1000 + index, symbol: SYMBOL, side: index % 2 ? 'SELL' : 'BUY',
    volume: 0.1, quantity: 0.1, openTime: OPEN_TIME_SEC,
    price_open: price, open_price: price, openPrice: price,
    currentPrice: price, current_price: price, sl: 0, tp: 0, ...overrides,
  };
};
const positions = (count: number, overrides: Record<number, Record<string, unknown>> = {}) =>
  Array.from({ length: count }, (_, index) => position(index, overrides[index]));

const makeOptions = () => {
  const host = document.createElement('div');
  const overlay = document.createElement('div');
  host.appendChild(overlay);
  document.body.appendChild(host);
  const ref = <T,>(current: T) => ({ current });
  const options = {
    activeOverlayNodeDataRef: ref([]), activeOverlayNodesRef: ref([]),
    activeTradeSnapshotsRef: ref(new Map()), brokerAccountSessionScope: 'Test:incremental',
    brokerTimeOffsetSec: 0, candlesRef: ref([]), chartRef: ref(runtime.deepStub()),
    chartThemeRef: ref({ background: '#000000' }),
    clearFrozenEntryTime: vi.fn(), clearStableActiveMarkerTime: vi.fn(),
    clearTradeOverlayLayer: vi.fn(), clearTradeOverlayVisualRuntime: vi.fn(),
    closeSuppressedTradeKeysRef: ref(new Map()), currentCandleRef: ref(null),
    drawingRuntimeContextRef: ref({ contextId: 'incremental', symbol: SYMBOL, timeframe: 'M1' }),
    frozenEntryPricesRef: ref(new Map()), frozenEntryTimesRef: ref(new Map()),
    getNearestCandleByTime: vi.fn(() => null), historyOverlayNodeDataRef: ref([]), historyOverlayNodesRef: ref([]),
    hydrateTradeLevelOverrides: vi.fn(), isActiveRef: ref(true), isChartInteractionActiveRef: ref(false),
    isChartSurfaceLight: () => false, isDisposedRef: ref(false), isLivePriceSafeForCandles: () => true,
    lastActiveTradeOverlaySignatureRef: ref(''), lastHistoryTradeOverlaySignatureRef: ref(''),
    lastRenderedCandlesRef: ref([]), optimisticClosedTradeSnapshotsRef: ref(new Map()),
    overlayRef: ref(overlay), pendingClosedTradeSnapshotsRef: ref(new Map()),
    pendingMissingActiveTradesRef: ref(new Map()), pendingTradeLevelModifyRequestsRef: ref(new Map()),
    persistTradeLevelOverrides: vi.fn(), postInteractionCoordinatorRef: ref(null), prevTimeframeRef: ref('M1'),
    resolvedPriceDigits: 5,
    seriesRef: ref({
      priceToCoordinate: vi.fn(() => 100), coordinateToPrice: vi.fn(() => 1.1),
      priceFormatter: () => ({ format: (price: number) => price.toFixed(5) }),
      createPriceLine: vi.fn(() => ({})), removePriceLine: vi.fn(),
    }),
    stableActiveMarkerTimesRef: ref(new Map()), symbol: SYMBOL, timeframe: 'M1', tr: <T,>(source: T) => source,
    tradeControlLiveUpdatersRef: ref([]), tradeHistoryRefreshTimerRef: ref(null),
    tradeLevelCrossRefreshPendingRef: ref(new Set()), tradeLevelLastKnownLevelsRef: ref(new Map()),
    tradeLevelModifyRequestSeqRef: ref(0), tradeLevelOptimisticGraceUntilRef: ref(new Map()),
    tradeLevelOverridesRef: ref(new Map()), tradeMissingGraceTimerRef: ref(null), tradeOverlayRafRef: ref(null),
    updateLabelPositions: vi.fn(), visibleRuntime: { overlay: true },
  } as unknown as RendererOptions;
  // Same contract as the runtime hook's clearTradeOverlayLayer for the active layer.
  vi.mocked(options.clearTradeOverlayLayer).mockImplementation((layer) => {
    const nodesRef = layer === 'active' ? options.activeOverlayNodesRef : options.historyOverlayNodesRef;
    const dataRef = layer === 'active' ? options.activeOverlayNodeDataRef : options.historyOverlayNodeDataRef;
    nodesRef.current.forEach((node) => node.remove());
    nodesRef.current = [];
    dataRef.current = [];
    if (layer === 'active') {
      options.lastActiveTradeOverlaySignatureRef.current = '';
      options.tradeControlLiveUpdatersRef.current = [];
    } else {
      options.lastHistoryTradeOverlaySignatureRef.current = '';
    }
  });
  return { host, options };
};

describe('active trade overlay is reconciled incrementally per trade key', () => {
  let frames: FrameRequestCallback[];
  let prev: { positions: unknown; orders: unknown; trades: unknown };

  const flushFrames = () => {
    let guard = 0;
    while (frames.length > 0 && guard++ < 100) frames.shift()!(16);
  };
  const setPositions = (rows: unknown[]) => {
    act(() => { useAppStore.setState({ positions: rows as never }); });
    flushFrames();
  };
  const controls = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>('.rtx-trade-controls--entry'));
  const activeNodes = (options: RendererOptions) => new Set(options.activeOverlayNodesRef.current);

  beforeEach(() => {
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    vi.spyOn(Date, 'now').mockImplementation(() => 1_700_000_000_000);
    runtime.modelFactory.mockImplementation(() => runtime.stubWith({
      queueTradeOverlayRelayout: runtime.queueRelayout,
      normalizeUnixSeconds: (value: unknown) => {
        const num = Number(value);
        return Number.isFinite(num) && num > 0 ? Math.floor(num > 1e11 ? num / 1000 : num) : null;
      },
      pickPositiveNumber: (...values: unknown[]) => {
        for (const value of values) {
          const num = Number(value);
          if (Number.isFinite(num) && num > 0) return num;
        }
        return 0;
      },
      getTradeTicketLabel: (key: string) => `#${key.replace(/^trade:/, '')}`,
      formatTradeLevelBadgePrice: (price: number) => price.toFixed(5),
      resolveSymbolTick: () => null,
      mapTradeTimestampToChartTime: () => null,
      getClosedTradeLineColor: () => '#2962ff',
      getLiveTrailTime: () => 1_700_000_000,
      getActiveMarkerTimeKey: (key: string) => `${key}:marker`,
      canResolveOverlayTime: (ts: number) => ts > 0,
      getLiveTrailPrice: (_side: string, price: number) => price,
      buildImmediateClosedTrade: () => null,
      buildClosedTradeFromEventSnapshot: () => null,
      mapStoredClosedTradeToChart: () => null,
      scheduleHistoryRefresh: vi.fn(),
      getTradeLevelStateKeys: (trade: { key: string }) => [trade.key],
      setTradeLevelState: vi.fn(),
      deleteTradeLevelState: vi.fn(),
      clearTradeLevelRuntimeState: vi.fn(() => false),
      clearTradeLevelRuntimeStateByKey: vi.fn(() => false),
      resolveTradeLevels: (trade: { sl?: number; tp?: number }) => ({ sl: trade.sl || 0, tp: trade.tp || 0 }),
      formatSignaturePrice: (value?: number) => (Number(value) || 0).toFixed(5),
      priceTolerance: 0.00001,
    }) as never);
    const state = useAppStore.getState();
    prev = { positions: state.positions, orders: state.orders, trades: state.trades };
    useAppStore.setState({ positions: [] as never, orders: [] as never, trades: [] as never });
    vi.mocked(buildClosedTradeHistorySnapshots).mockClear();
    runtime.queueRelayout.mockClear();
  });

  afterEach(() => {
    useAppStore.setState({ positions: prev.positions as never, orders: prev.orders as never, trades: prev.trades as never });
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/');
    resetSharedChartTradeCache();
    vi.restoreAllMocks();
    runtime.modelFactory.mockReset();
  });

  const mountWith = (count: number) => {
    useAppStore.setState({ positions: positions(count) as never });
    const { host, options } = makeOptions();
    const view = renderHook(() => useTradingChartTradeOverlayRenderer(options));
    flushFrames();
    return { host, options, view };
  };

  it('opening trade #101 adds one control set and keeps all 100 existing nodes', () => {
    const { host, options, view } = mountWith(100);
    const before = controls(host);
    const nodesBefore = activeNodes(options);
    expect(before).toHaveLength(100);
    const rebuilds = vi.mocked(options.clearTradeOverlayLayer).mock.calls.filter(([layer]) => layer === 'active').length;

    setPositions(positions(101));

    const after = controls(host);
    expect(after).toHaveLength(101);
    // Same node identity for the 100 existing control bars, still attached.
    before.forEach((element, index) => {
      expect(after[index]).toBe(element);
      expect(element.isConnected).toBe(true);
    });
    nodesBefore.forEach((node) => expect(node.isConnected).toBe(true));
    const created = options.activeOverlayNodesRef.current.filter((node) => !nodesBefore.has(node));
    expect(created.length).toBeGreaterThan(0);
    expect(created.filter((node) => node.classList.contains('rtx-trade-controls--entry'))).toHaveLength(1);
    // No second wipe of the active layer happened.
    expect(vi.mocked(options.clearTradeOverlayLayer).mock.calls.filter(([layer]) => layer === 'active').length)
      .toBe(rebuilds);
    expect(options.tradeControlLiveUpdatersRef.current).toHaveLength(101);
    view.unmount();
  });

  it('closing one trade removes exactly its nodes', () => {
    const { host, options, view } = mountWith(100);
    const baseline = activeNodes(options);
    setPositions(positions(101));
    const withOpened = activeNodes(options);
    const perTradeNodes = withOpened.size - baseline.size;
    expect(perTradeNodes).toBeGreaterThan(0);
    const controlsWithOpened = controls(host);

    act(() => {
      window.dispatchEvent(new CustomEvent(TRADE_OVERLAY_CLOSE_STATE_EVENT, {
        detail: { status: 'confirmed', ticket: 1100 },
      }));
    });
    flushFrames();

    const remaining = activeNodes(options);
    expect(withOpened.size - remaining.size).toBe(perTradeNodes);
    baseline.forEach((node) => {
      expect(remaining.has(node)).toBe(true);
      expect(node.isConnected).toBe(true);
    });
    const closedControl = controlsWithOpened.find((element) => element.dataset.tradeKey === 'trade:1100');
    expect(closedControl).toBeDefined();
    expect(closedControl!.isConnected).toBe(false);
    expect(controls(host)).toHaveLength(100);
    expect(options.tradeControlLiveUpdatersRef.current).toHaveLength(100);
    view.unmount();
  });

  it('modifying SL/TP of one trade rebuilds only that trade', () => {
    const { host, options, view } = mountWith(100);
    const before = controls(host);
    const nodesBefore = activeNodes(options);
    const target = 42;
    const targetKey = `trade:${1000 + target}`;
    expect(host.querySelectorAll(`.rtx-trade-level-line--sl[data-trade-key="${targetKey}"]`)).toHaveLength(0);

    setPositions(positions(100, { [target]: { sl: 1.0, tp: 1.3 } }));

    expect(host.querySelectorAll(`.rtx-trade-level-line--sl[data-trade-key="${targetKey}"]`)).toHaveLength(1);
    expect(host.querySelectorAll(`.rtx-trade-level-line--tp[data-trade-key="${targetKey}"]`)).toHaveLength(1);
    const after = controls(host);
    const changed = after.filter((element) => !before.includes(element));
    expect(changed.every((element) => element.dataset.tradeKey === targetKey)).toBe(true);
    expect(before.filter((element) => !element.isConnected).every((element) => element.dataset.tradeKey === targetKey)).toBe(true);
    // Every other trade keeps its entry control bar node.
    before.filter((element) => element.dataset.tradeKey !== targetKey).forEach((element) => {
      expect(element.isConnected).toBe(true);
    });
    const survivors = Array.from(nodesBefore).filter((node) => node.isConnected);
    expect(survivors.length).toBeGreaterThan(nodesBefore.size - 12);
    expect(options.tradeControlLiveUpdatersRef.current.length).toBeGreaterThanOrEqual(100);
    view.unmount();
  });

  it('adding an active trade does not rescan the closed history', () => {
    const { options, view } = mountWith(5);
    const builds = vi.mocked(buildClosedTradeHistorySnapshots).mock.calls.length;
    expect(builds).toBeGreaterThan(0);

    setPositions(positions(6));
    setPositions(positions(7));

    expect(vi.mocked(buildClosedTradeHistorySnapshots).mock.calls.length).toBe(builds);
    expect(options.activeOverlayNodesRef.current.length).toBeGreaterThan(0);
    view.unmount();
  });

  it('coalesces label placement into one animation-frame pass and never measures synchronously', () => {
    const { options, view } = mountWith(3);
    vi.mocked(options.updateLabelPositions).mockClear();
    act(() => { useAppStore.setState({ positions: positions(4) as never }); });
    // The store change queued one render frame; running it must not call updateLabelPositions synchronously.
    const renderFrame = frames.shift()!;
    renderFrame(16);
    expect(options.updateLabelPositions).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    flushFrames();
    expect(options.updateLabelPositions).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  // A placement pass that can resolve coordinates: shows every node it is asked to place.
  const placeAll = (options: RendererOptions) => {
    vi.mocked(options.updateLabelPositions).mockImplementation(() => {
      options.activeOverlayNodesRef.current.forEach((node) => { node.style.display = 'block'; });
    });
  };

  it('queues one follow-up relayout when a new node is still unplaced after the placement pass', () => {
    const { options, view } = mountWith(3);
    runtime.queueRelayout.mockClear();
    // updateLabelPositions is a no-op stub here: the new trade's nodes keep display:none (no coordinates yet).
    setPositions(positions(4));
    expect(options.updateLabelPositions).toHaveBeenCalled();
    expect(runtime.queueRelayout).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('does not queue a follow-up relayout when the placement pass placed every new node', () => {
    const { options, view } = mountWith(3);
    placeAll(options);
    runtime.queueRelayout.mockClear();
    setPositions(positions(4));
    expect(runtime.queueRelayout).not.toHaveBeenCalled();
    view.unmount();
  });

  it('places a full rebuild synchronously, so no frame paints an empty overlay', () => {
    const { host, options, view } = mountWith(5);
    placeAll(options);
    vi.mocked(options.updateLabelPositions).mockClear();
    frames.length = 0;

    // Settings/theme style rebuild request: explicit `true` -> every node is recreated.
    const before = activeNodes(options);
    act(() => { window.dispatchEvent(new CustomEvent(TRADE_OVERLAY_REFRESH_EVENT)); });

    expect(options.updateLabelPositions).toHaveBeenCalledTimes(1);
    const after = options.activeOverlayNodesRef.current;
    expect(after.length).toBeGreaterThan(0);
    after.forEach((node) => expect(before.has(node)).toBe(false));
    // Placed before any animation frame ran.
    after.forEach((node) => expect(node.style.display).toBe('block'));
    expect(controls(host)).toHaveLength(5);
    view.unmount();
  });

  it('stacks share-link annotation badges against every trade SL/TP like the single shared factory did', () => {
    const shared = { version: 1 as const, ticket: 9999, symbol: SYMBOL, timeframe: 'M1', side: 'BUY' as const, volume: 1, entryPrice: 1.2, entryTime: OPEN_TIME_SEC, sl: 1.05, tp: 0 };
    window.history.replaceState(null, '', buildTradeShareUrl(shared));
    resetSharedChartTradeCache();
    // Every price maps to the same y: all SL/TP registrations land in one collision bucket.
    const lineTextInsets = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>('.rtx-trade-level-badge--line-text'))
      .map((badge) => Number(badge.dataset.leftInset));
    const inset = (index: number) => TRADE_LEVEL_BADGE_LEFT_INSET_PX + index * TRADE_LEVEL_BADGE_STACK_OFFSET_PX;

    useAppStore.setState({ positions: positions(2, { 0: { sl: 1.0 }, 1: { sl: 1.0 } }) as never });
    const { host, options, view } = makeMounted();
    // Two trades registered SL at the same height, so ENTRY gets index 2 and the shared SL index 3.
    expect(lineTextInsets(host)).toEqual([inset(2), inset(3)]);
    const firstBadges = Array.from(host.querySelectorAll('.rtx-trade-level-badge--line-text'));

    // A third trade with an SL changes the shared offsets even though the shared payload is unchanged.
    setPositions(positions(3, { 0: { sl: 1.0 }, 1: { sl: 1.0 }, 2: { sl: 1.0 } }));
    expect(lineTextInsets(host)).toEqual([inset(3), inset(4)]);
    firstBadges.forEach((badge) => expect(badge.isConnected).toBe(false));
    expect(options.activeOverlayNodesRef.current.length).toBeGreaterThan(0);
    view.unmount();
  });

  function makeMounted() {
    const { host, options } = makeOptions();
    const view = renderHook(() => useTradingChartTradeOverlayRenderer(options));
    flushFrames();
    return { host, options, view };
  }
});
