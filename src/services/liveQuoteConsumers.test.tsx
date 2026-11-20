// Consumers of the live quote cache stay live and correct without any per-tick store write.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backendCloseProfit, buildTradeOverlayCloseSnapshots } from '../app/trading/positionRuntime';
import { BulkCloseConfirmDialog } from '../components/ui/BulkCloseConfirmDialog';
import { LastSymbolPanel } from '../components/LastSymbolPanel';
import { ExposureTab } from '../features/bottom-dock/exposure/ExposureTab';
import { TradeTab } from '../features/bottom-dock/trade/TradeTab';
import { bindTradeOverlayRuntimeSubscriptions } from '../features/trading-chart/runtime/bindTradeOverlayRuntimeSubscriptions';
import { createTradeOverlayDomRuntime } from '../features/trading-chart/runtime/createTradeOverlayDomRuntime';
import { replaceToolboxPositions, useToolboxTradeData } from '../hooks/useToolboxTradeData';
import { useAppStore, type Position } from '../store/useAppStore';
import { useBulkCloseConfirmStore } from '../store/useBulkCloseConfirmStore';
import { commitBrokerAccountSessionScope } from './brokerSession';
import { binaryTcpMarketStream } from './binaryTcpMarketStream';
import { getLiveBulkCloseCounts } from './livePositionAggregates';
import { getLivePositionPrice, getLivePositionProfit } from './livePositionMetrics';
import { getLiveQuote, resetLiveQuotesForTests, setLiveQuote } from './liveQuotes';
import { reconcilePositionBulkClose } from './positionStream';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const makeAccount = (overrides: Record<string, unknown> = {}) => {
  const now = Date.now();
  return {
    balance: 100000, credit: 0, equity: 100000, margin: 1080, freeMargin: 98920, unrealizedPL: 0, marginLevel: 9259.26,
    currency: 'USD', currencyDigits: 2, leverage: 100,
    hasBackendBalance: true, hasBackendEquity: true, hasBackendMargin: true, hasBackendFreeMargin: true,
    hasBackendMarginLevel: true, hasBackendFloatingPnL: true, hasBackendUnrealizedPL: true, hasBackendCredit: true,
    metricsStatus: 'valid',
    metricUpdatedAt: { balance: now, equity: now, margin: now, freeMargin: now, marginLevel: now, unrealizedPL: now, credit: now },
    ...overrides,
  };
};

const rawRow = (id: number, symbol: string, side: 'BUY' | 'SELL', volume: number, open: number, extra: Record<string, unknown> = {}) => ({
  id, ticket: id, symbol, side, volume, volume_lots: volume, openPrice: open, price_open: open, open_price: open,
  currentPrice: open, price_current: open, current_price: open, hasBackendCurrentPrice: true,
  profit: 0, unrealizedPnL: 0, hasBackendProfit: true, sl: 0, tp: 0, swap: 0, commission: 0,
  margin: 108, used_margin: 108, margin_available: true, hasBackendMargin: true,
  openTime: '2026-04-17T07:10:35.091Z', time_create: '2026-04-17T07:10:35.091Z', account_login: 200003,
  contractSize: 100000, digits: 5,
  ...extra,
});

const seedPositions = (rows: ReturnType<typeof rawRow>[]) => {
  const seeded = replaceToolboxPositions([], rows) as unknown as Position[];
  useAppStore.getState().setPositions(seeded, {});
  return useAppStore.getState().positions;
};

const flushFrames = () => { vi.advanceTimersByTime(150); };

describe('live quote consumers (array mode)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    (binaryTcpMarketStream as unknown as { ensureStarted: () => void }).ensureStarted = () => {};
    resetLiveQuotesForTests();
    commitBrokerAccountSessionScope({ authenticated: true, accountId: '200003', brokerId: 'test', serverUrl: 'https://broker.invalid' });
    useAppStore.setState({
      isAuthenticated: true, accountId: '200003', authToken: 'test-token',
      positions: [], orders: [], trades: [], ticks: {}, tickLookup: {}, account: makeAccount() as never,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    try { root.unmount(); } catch { /* already unmounted */ }
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('BulkCloseConfirmDialog: per-row P/L, combined P/L and breakdown follow the quotes', () => {
    seedPositions([
      rawRow(3002, 'GBPUSD', 'SELL', 0.1, 1.27),
      rawRow(3001, 'EURUSD', 'BUY', 0.1, 1.08),
    ]);
    void useBulkCloseConfirmStore.getState().showBulkCloseConfirm({
      type: 'ALL',
      positions: [
        { id: 3001, symbol: 'EURUSD', side: 'BUY', volume: 0.1, openPrice: 1.08, pnl: 0 },
        { id: 3002, symbol: 'GBPUSD', side: 'SELL', volume: 0.1, openPrice: 1.27, pnl: 0 },
      ] as never,
      combinedPnL: 0,
    });
    flushSync(() => { root.render(createElement(BulkCloseConfirmDialog)); });
    expect(host.textContent).toContain('+0.00');

    setLiveQuote({ symbol: 'EURUSD', bid: 1.085, ask: 1.0852 });
    setLiveQuote({ symbol: 'GBPUSD', bid: 1.2678, ask: 1.268 });
    flushSync(() => { flushFrames(); });

    expect(host.textContent).toContain('+70.00');
    expect(host.textContent).toContain('+50.00');
    expect(host.textContent).toContain('+20.00');
  });

  it('chart overlay: relayouts on a live quote; a positions write keeps the original full reconcile', () => {
    const ref = <T,>(current: T) => ({ current }) as { current: T };
    let relayouts = 0;
    let fullRenders = 0;
    const activeSnapshots = new Map<string, unknown>([
      ['trade:4001', { key: 'trade:4001', symbol: 'EURGBP', side: 'BUY', volume: 0.1, entryPrice: 0.85, entryTime: 1800000, currentPrice: 0.85, kind: 'open' }],
    ]);
    useAppStore.setState({
      positions: replaceToolboxPositions([], [rawRow(4001, 'EURGBP', 'BUY', 0.1, 0.85, { price_current: 0.851, profit: 12.7 })]) as unknown as Position[],
    });

    const unbind = bindTradeOverlayRuntimeSubscriptions({
      activeTradeSnapshotsRef: ref(activeSnapshots),
      chartRef: ref({ timeScale: () => ({ subscribeVisibleLogicalRangeChange() {}, unsubscribeVisibleLogicalRangeChange() {} }) }),
      clearFrozenEntryTime() {},
      clearStableActiveMarkerTime() {},
      clearTradeOverlayLayer() {},
      clearTradeOverlayVisualRuntime() {},
      closeSuppressedTradeKeysRef: ref(new Map()),
      drawingRuntimeContextRef: ref({ contextId: 'c1', symbol: 'EURGBP', timeframe: '1m' }),
      frozenEntryPricesRef: ref(new Map()),
      isActiveRef: ref(true),
      optimisticClosedTradeSnapshotsRef: ref(new Map()),
      pendingClosedTradeSnapshotsRef: ref(new Map()),
      pendingMissingActiveTradesRef: ref(new Map()),
      persistTradeLevelOverrides() {},
      renderTradeOverlay: () => { fullRenders += 1; },
      symbol: 'EURGBP',
      tradeLevelCrossRefreshPendingRef: ref(new Set()),
      buildClosedTradeFromEventSnapshot: (() => null) as never,
      buildImmediateClosedTrade: (() => null) as never,
      clearTradeLevelRuntimeState: (() => false) as never,
      clearTradeLevelRuntimeStateByKey: (() => false) as never,
      queueTradeOverlayRelayout: () => { relayouts += 1; },
      resolveSymbolTick: (() => undefined) as never,
      scheduleHistoryRefresh() {},
    } as never);
    fullRenders = 0;
    relayouts = 0;

    setLiveQuote({ symbol: 'EURGBP', bid: 0.852, ask: 0.8522 });
    flushFrames();
    expect(relayouts).toBe(1);
    expect(fullRenders).toBe(0);

    relayouts = 0;
    const current = useAppStore.getState().positions[0];
    // Ticks no longer write state.positions, so a positions write is a real backend event
    // (pnl_update / snapshot) and keeps the pre-existing rule: a full overlay reconcile.
    // The reconcile is scheduled with requestAnimationFrame (not faked here), so run it inline.
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    useAppStore.setState({ positions: [{ ...current, currentPrice: 0.853, price_current: 0.853, unrealizedPnL: 38.1, profit: 38.1 }] });
    expect(fullRenders).toBe(1);
    rafSpy.mockRestore();
    unbind();
  });

  it('chart overlay money chip, SL/TP money and close snapshot use the live profit and price', () => {
    const ref = <T,>(current: T) => ({ current }) as { current: T };
    useAppStore.setState({
      positions: replaceToolboxPositions([], [rawRow(4002, 'EURUSD', 'BUY', 0.1, 1.08, { tp: 1.09, price_tp: 1.09 })]) as unknown as Position[],
    });
    setLiveQuote({ symbol: 'EURUSD', bid: 1.082, ask: 1.0822 });

    const overlayDiv = document.createElement('div');
    const parentDiv = document.createElement('div');
    parentDiv.appendChild(overlayDiv);
    const domRuntime = createTradeOverlayDomRuntime({
      activeOverlayNodeDataRef: ref([]),
      activeOverlayNodesRef: ref([]),
      activeTradeSnapshotsRef: ref(new Map()),
      brokerAccountSessionScope: 'test',
      chartThemeRef: ref({ background: '#000' }),
      deleteTradeLevelState() {},
      digits: 5,
      formatTradeLevelBadgePrice: (price: number) => price.toFixed(5),
      getTradeLevelStateKeys: () => ['trade:4002'],
      getTradeTicketLabel: () => '#4002',
      historyOverlayNodeDataRef: ref([]),
      historyOverlayNodesRef: ref([]),
      isChartSurfaceLight: () => false,
      overlayRef: ref(overlayDiv),
      pendingTradeLevelModifyRequestsRef: ref(new Map()),
      persistTradeLevelOverrides() {},
      prevTimeframeRef: ref('1m'),
      resolveSymbolTick: () => undefined,
      seriesRef: ref({ priceFormatter: () => ({ format: (price: number) => price.toFixed(5) }), priceToCoordinate: () => 100 }),
      setTradeLevelState() {},
      timeframe: '1m',
      tr: (source: string) => source,
      tradeControlLiveUpdatersRef: ref([]),
      tradeLevelLastKnownLevelsRef: ref(new Map()),
      tradeLevelModifyRequestSeqRef: ref(0),
      tradeLevelOptimisticGraceUntilRef: ref(new Map()),
      tradeLevelOverridesRef: ref(new Map()),
    } as never);
    const tradeSnap = {
      key: 'trade:4002', symbol: 'EURUSD', side: 'BUY', volume: 0.1, entryPrice: 1.08, entryTime: 1800000, currentPrice: 1.08, kind: 'open',
    } as never;
    domRuntime.createEntryControlsForTrade(tradeSnap, { sl: 0, tp: 1.09 } as never);
    expect(parentDiv.textContent).toContain('20.00');
    domRuntime.createLevelControlsForTrade(tradeSnap, 'TP', { sl: 0, tp: 1.09 } as never);
    expect(parentDiv.textContent).toContain('100.00');

    const position = useAppStore.getState().positions[0];
    expect(backendCloseProfit(position)).toBe(20);
    const closeSnapshots = buildTradeOverlayCloseSnapshots(useAppStore.getState().positions);
    expect(closeSnapshots[0].profit).toBe(20);
    expect(closeSnapshots[0].exitPrice).toBe(1.082);
  });

  it('ExposureTab and LastSymbolPanel follow the quotes', () => {
    const positions = seedPositions([rawRow(5001, 'EURUSD', 'BUY', 0.5, 1.08, { margin: 540 })]);
    useAppStore.setState({
      selectedSymbol: 'EURUSD',
      account: makeAccount({ balance: 10000, equity: 10000, margin: 540, freeMargin: 9460 }) as never,
    });

    const exposureHost = document.createElement('div');
    document.body.appendChild(exposureHost);
    const exposureRoot = createRoot(exposureHost);
    flushSync(() => {
      exposureRoot.render(createElement(ExposureTab, {
        positions: positions as never,
        formatMoney: (value: number | null | undefined) => (value == null ? '-' : Number(value).toFixed(2)),
        account: useAppStore.getState().account as never,
      }));
    });
    expect(exposureHost.textContent).toContain('1.08000');
    setLiveQuote({ symbol: 'EURUSD', bid: 1.084, ask: 1.0842 });
    flushSync(() => { flushFrames(); });
    expect(exposureHost.textContent).toContain('1.08400');
    exposureRoot.unmount();
    exposureHost.remove();

    const panelHost = document.createElement('div');
    document.body.appendChild(panelHost);
    const panelRoot = createRoot(panelHost);
    flushSync(() => { panelRoot.render(createElement(LastSymbolPanel, { symbol: 'EURUSD' })); });
    expect(panelHost.textContent).toContain('+200.00');
    setLiveQuote({ symbol: 'EURUSD', bid: 1.086, ask: 1.0862 });
    flushSync(() => { flushFrames(); });
    expect(panelHost.textContent).toContain('+300.00');
    panelRoot.unmount();
    panelHost.remove();
  });

  it('Close In-Profit / In-Loss counts, WINNERS reconciliation and per-position selectors use the live price', () => {
    const rows = replaceToolboxPositions([], [
      rawRow(5001, 'EURUSD', 'BUY', 0.5, 1.08, { profit: -50, unrealizedPnL: -50 }),
    ]);
    // Backend says -50 (stale); the live quote makes it a winner.
    setLiveQuote({ symbol: 'EURUSD', bid: 1.084, ask: 1.0842 });
    expect(getLiveBulkCloseCounts(rows)).toEqual({ all: 1, profitable: 1, losing: 0 });
    expect(getLivePositionPrice(rows[0])).toBe(1.084);
    expect(getLivePositionProfit(rows[0])).toBeCloseTo(200, 6);
    const reconciled = reconcilePositionBulkClose(rows as never, { filter_type: 'WINNERS', closed_tickets: [] } as never);
    expect(reconciled.closedTickets).toEqual([5001]);
    expect(reconciled.positions.length).toBe(0);
  });

  it('Trade tab: rows and the footer follow ticks with no store write per tick', () => {
    seedPositions([rawRow(6001, 'EURUSD', 'BUY', 0.1, 1.08)]);
    useAppStore.setState({ account: makeAccount({ balance: 5000, equity: 5000, margin: 108, freeMargin: 4892 }) as never });

    const Harness = () => {
      const trade = useToolboxTradeData();
      return createElement(TradeTab, {
        positions: trade.positions,
        account: trade.account,
        onClosePosition: () => {},
        onModifyPosition: () => {},
        formatMoney: (value: number | null | undefined) => (value == null ? '-' : Number(value).toFixed(2)),
        loading: trade.loading,
        error: trade.error,
      } as never);
    };
    flushSync(() => { root.render(createElement(Harness)); });

    const storePositionsBefore = useAppStore.getState().positions;
    const listeners = (binaryTcpMarketStream as unknown as { tickListeners: Set<(tick: unknown) => void> }).tickListeners;
    flushSync(() => {
      listeners.forEach((listener) => listener({ symbol: 'EURUSD', bid: 1.083, ask: 1.0832, spread: 0.0002, timestamp: 1_800_000_500_000 }));
      flushFrames();
    });

    const rowText = host.querySelector('tbody > tr:not([data-rtx-spacer])')?.textContent ?? '';
    const footerText = host.querySelector('.rtx-trade-footer')?.textContent ?? '';
    expect(rowText).toContain('1.08300');
    expect(rowText).toContain('30.00');
    expect(footerText).toContain('5030.00');
    expect(footerText).toContain('30.00');
    expect(getLiveQuote('EURUSD')?.bid).toBe(1.083);
    expect(useAppStore.getState().positions).toBe(storePositionsBefore);
  });
});
