import { useRef, type RefObject } from 'react';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { useActiveChartRuntimeEffect } from '../../../hooks/useActiveChartRuntimeEffect';
import type { TradingChartVisibleRuntime } from '../../../hooks/useTradingChartVisibleRuntime';
import { getPositionsAuthoritativeSeq, isConfirmedClosedBySnapshot, isPositionMarkedClosed, useAppStore } from '../../../store/useAppStore';
import {
  clampChartOpacityPercent,
  defaultChartProperties,
  useChartSettingsStore,
} from '../../../store/useChartSettingsStore';
import { getChartObjectState, useChartObjectStateStore } from '../../../store/useChartObjectStateStore';
import { getTradeHistoryExecutionSide } from '../../../utils/chartTradeHistoryPresentation';
import { getSharedChartTrade } from '../../../utils/tradeShareLink';
import { getTradeHistoryTimeRange, isTradeHistoryInTimeRange } from '../../../utils/tradeHistoryViewport';
import {
  buildClosedTradeHistorySnapshots,
  filterActiveTradeKeysForHistory,
  forgetTradeOverlayOptimisticClosedSnapshot,
  getTradeOverlayOptimisticClosedSnapshots,
  getTradeOverlayRedrawDecision,
  resolveStableTradeEntryPrice,
  resolveStableTradeEntryTime,
  shouldKeepMissingActiveTradeOverlay,
  shouldUseClosedTradeHistorySnapshot,
  type TradeOverlayHistoryRow,
} from '../../../services/tradeOverlayHistory';
import type { Candle, Timeframe, TradingViewChartTheme } from '../../../types/chart';
import type { ChartPostInteractionCoordinator } from '../../../utils/chartPostInteractionCoordinator';
import {
  TRADE_MISSING_POSITION_GRACE_MS,
  type TradeSide,
} from '../presentation/tradeOverlayPresentation';
import { createTradeOverlayModelRuntime } from './createTradeOverlayModelRuntime';
import { createTradeOverlayDomRuntime } from './createTradeOverlayDomRuntime';
import { bindTradeOverlayRuntimeSubscriptions } from './bindTradeOverlayRuntimeSubscriptions';
import {
  capRecentHistoryTrades,
  hashString32,
  reconcileHistoryOverlayNodes,
  type HistoryOverlayDesiredTrade,
  type HistoryOverlayEntries,
} from './tradeHistoryOverlayReconcile';
import {
  getEntryLineColor,
  getFrozenEntryTimeKey,
  TRADE_BUY_COLOR,
  TRADE_SELL_COLOR,
} from './tradeOverlayRuntimeConstants';
import type {
  ActiveTradeSnapshot,
  ClosedTradeSnapshot,
  OverlayNodeData,
  TradeLevelModifyRequestId,
  TradeLevelOverride,
  TradeOverlayLayer,
  TradePositionRecord,
} from './tradeRuntimeContracts';

const TRADE_HISTORY_PRESENTATION_VERSION = 'visibility-v21-mt5-execution-arrows';

interface UseTradingChartTradeOverlayRendererOptions {
  activeOverlayNodeDataRef: RefObject<OverlayNodeData[]>;
  activeOverlayNodesRef: RefObject<HTMLElement[]>;
  activeTradeSnapshotsRef: RefObject<Map<string, ActiveTradeSnapshot>>;
  brokerAccountSessionScope: string;
  brokerTimeOffsetSec: number;
  candlesRef: RefObject<Candle[]>;
  chartRef: RefObject<IChartApi | null>;
  chartThemeRef: RefObject<TradingViewChartTheme>;
  clearFrozenEntryTime: (tradeKey: number | string) => void;
  clearStableActiveMarkerTime: (tradeKey: number | string) => void;
  clearTradeOverlayLayer: (layer: TradeOverlayLayer) => void;
  clearTradeOverlayVisualRuntime: () => void;
  closeSuppressedTradeKeysRef: RefObject<Map<string, number>>;
  currentCandleRef: RefObject<Candle | null>;
  drawingRuntimeContextRef: RefObject<{ contextId: string; accountScope?: string; symbol: string; timeframe: Timeframe }>;
  frozenEntryPricesRef: RefObject<Map<number | string, number>>;
  frozenEntryTimesRef: RefObject<Map<number | string, number>>;
  getNearestCandleByTime: (time: number, maxDistanceSeconds?: number) => Candle | null;
  historyOverlayNodeDataRef: RefObject<OverlayNodeData[]>;
  historyOverlayNodesRef: RefObject<HTMLElement[]>;
  hydrateTradeLevelOverrides: () => void;
  isActiveRef: RefObject<boolean>;
  isChartInteractionActiveRef: RefObject<boolean>;
  isChartSurfaceLight: () => boolean;
  isDisposedRef: RefObject<boolean>;
  isLivePriceSafeForCandles: (price: number) => boolean;
  lastRenderedCandlesRef: RefObject<Candle[]>;
  lastActiveTradeOverlaySignatureRef: RefObject<string>;
  lastHistoryTradeOverlaySignatureRef: RefObject<string>;
  optimisticClosedTradeSnapshotsRef: RefObject<Map<string, ClosedTradeSnapshot>>;
  overlayRef: RefObject<HTMLDivElement | null>;
  pendingClosedTradeSnapshotsRef: RefObject<Map<string, ActiveTradeSnapshot>>;
  pendingMissingActiveTradesRef: RefObject<Map<string, { trade: ActiveTradeSnapshot; missingSince: number }>>;
  pendingTradeLevelModifyRequestsRef: RefObject<Map<string, TradeLevelModifyRequestId>>;
  persistTradeLevelOverrides: () => void;
  postInteractionCoordinatorRef: RefObject<ChartPostInteractionCoordinator | null>;
  prevTimeframeRef: RefObject<Timeframe>;
  resolvedPriceDigits: number | null;
  seriesRef: RefObject<ISeriesApi<SeriesType> | null>;
  stableActiveMarkerTimesRef: RefObject<Map<number | string, number>>;
  symbol: string;
  timeframe: Timeframe;
  tr: <T>(source: T, values?: Record<string, unknown>) => T;
  tradeControlLiveUpdatersRef: RefObject<Array<(positionsByTicket?: ReadonlyMap<number, TradePositionRecord>) => void>>;
  tradeHistoryRefreshTimerRef: RefObject<number | null>;
  tradeLevelCrossRefreshPendingRef: RefObject<Set<string>>;
  tradeLevelLastKnownLevelsRef: RefObject<Map<string, TradeLevelOverride>>;
  tradeLevelModifyRequestSeqRef: RefObject<TradeLevelModifyRequestId>;
  tradeLevelOptimisticGraceUntilRef: RefObject<Map<string, number>>;
  tradeLevelOverridesRef: RefObject<Map<string, TradeLevelOverride>>;
  tradeMissingGraceTimerRef: RefObject<number | null>;
  tradeOverlayRafRef: RefObject<number | null>;
  updateLabelPositions: (refreshMetrics?: boolean) => void;
  visibleRuntime: TradingChartVisibleRuntime;
}

export const useTradingChartTradeOverlayRenderer = ({
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
  lastRenderedCandlesRef,
  lastActiveTradeOverlaySignatureRef,
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
}: UseTradingChartTradeOverlayRendererOptions): void => {
  // Last authoritative positions snapshot seen by a render pass (null before the first pass).
  // Hook-level ref: the render pass runs inside the effect callback, where hooks are not allowed.
  const lastAuthoritativePositionsSeqRef = useRef<number | null>(null);
  useActiveChartRuntimeEffect(visibleRuntime.overlay, () => {
    if (isDisposedRef.current || !seriesRef.current || !chartRef.current || !symbol) return;

    hydrateTradeLevelOverrides();

    // FIX: Trade overlays use the same opaque identity as orders and quotes.
    const normalizedChartSymbol = symbol.trim().toUpperCase();
    const digits = resolvedPriceDigits;

    const {
      queueTradeOverlayRelayout,
      normalizeUnixSeconds,
      pickPositiveNumber,
      getTradeTicketLabel,
      formatTradeLevelBadgePrice,
      resolveSymbolTick,
      mapTradeTimestampToChartTime,
      getClosedTradeLineColor,
      getLiveTrailTime,
      getActiveMarkerTimeKey,
      canResolveOverlayTime,
      getLiveTrailPrice,
      buildImmediateClosedTrade,
      buildClosedTradeFromEventSnapshot,
      mapStoredClosedTradeToChart,
      scheduleHistoryRefresh,
      getTradeLevelStateKeys,
      setTradeLevelState,
      deleteTradeLevelState,
      clearTradeLevelRuntimeState,
      clearTradeLevelRuntimeStateByKey,
      resolveTradeLevels,
      formatSignaturePrice,
      priceTolerance,
    } = createTradeOverlayModelRuntime({
      brokerTimeOffsetSec,
      candlesRef,
      chartRef,
      chartThemeRef,
      currentCandleRef,
      digits,
      getNearestCandleByTime,
      isChartInteractionActiveRef,
      isLivePriceSafeForCandles,
      pendingTradeLevelModifyRequestsRef,
      persistTradeLevelOverrides,
      postInteractionCoordinatorRef,
      prevTimeframeRef,
      stableActiveMarkerTimesRef,
      symbol,
      timeframe,
      tradeHistoryRefreshTimerRef,
      tradeLevelLastKnownLevelsRef,
      tradeLevelOptimisticGraceUntilRef,
      tradeLevelOverridesRef,
      tradeOverlayRafRef,
      updateLabelPositions,
    });

    const {
      createCollisionOffsetFactory,
      createTradeMarker,
      createTradeHistoryLine,
      createPriceLevel,
      getLocalizedTradeTitle,
      getTradeTicket,
      addTradeAxisPriceLine,
      createEntryPriceLevels,
      createEntryControlsForTrade,
      createLevelControlsForTrade,
    } = createTradeOverlayDomRuntime({
      activeOverlayNodeDataRef,
      activeOverlayNodesRef,
      activeTradeSnapshotsRef,
      brokerAccountSessionScope,
      chartThemeRef,
      deleteTradeLevelState,
      digits,
      formatTradeLevelBadgePrice,
      getTradeLevelStateKeys,
      getTradeTicketLabel,
      historyOverlayNodeDataRef,
      historyOverlayNodesRef,
      isChartSurfaceLight,
      overlayRef,
      pendingTradeLevelModifyRequestsRef,
      persistTradeLevelOverrides,
      prevTimeframeRef,
      resolveSymbolTick,
      seriesRef,
      setTradeLevelState,
      timeframe,
      tr,
      tradeControlLiveUpdatersRef,
      tradeLevelLastKnownLevelsRef,
      tradeLevelModifyRequestSeqRef,
      tradeLevelOptimisticGraceUntilRef,
      tradeLevelOverridesRef,
    });

    const pruneCloseSuppressedTradeKeys = (now = Date.now()) => {
      closeSuppressedTradeKeysRef.current.forEach((expiresAt, key) => {
        if (expiresAt <= now) {
          closeSuppressedTradeKeysRef.current.delete(key);
        }
      });
    };

    // Closed-history snapshots are built from `rows` + the candle window only. The set of active ticket
    // keys merely hides snapshots of still-open tickets, so it is applied as a cheap filter and a newly
    // opened trade never forces a rescan of the whole closed history.
    let historyCache: {
      rows: unknown[]; candleWindow: string; all: ClosedTradeSnapshot[];
      activeKeys: string; filtered: ClosedTradeSnapshot[];
    } | undefined;
    // Keyed history nodes (ticket key -> DOM nodes) so a close only adds/removes its own nodes.
    const historyEntries: HistoryOverlayEntries = new Map();
    let lastHistoryHeader: string | undefined;
    // Keyed active nodes: `0|<first trade key>` shared entry-price line, `1|<trade key>` marker/controls/levels,
    // `2|shared` share-link annotation. Same pattern as the history entries above.
    type ActiveOverlayItem = { key: string; build: () => void };
    const activeEntries: HistoryOverlayEntries = new Map();
    const activeUpdaters = new Map<string, Array<(positionsByTicket?: ReadonlyMap<number, TradePositionRecord>) => void>>();
    const dropActiveUpdaters = (key: string) => {
      const stale = activeUpdaters.get(key);
      if (!stale) return;
      activeUpdaters.delete(key);
      const drop = new Set(stale);
      tradeControlLiveUpdatersRef.current = tradeControlLiveUpdatersRef.current.filter((updater) => !drop.has(updater));
    };
    // Nodes created by the current pass: after they are placed, any that are still hidden (the series
    // had no coordinates yet, e.g. a fill on a brand-new candle) get one follow-up relayout.
    let unplacedNodes: HTMLElement[] = [];
    const trackCreated = <I,>(nodesRef: { current: HTMLElement[] }, build: (item: I) => void) => (item: I) => {
      const before = nodesRef.current.length;
      build(item);
      const nodes = nodesRef.current;
      for (let i = before; i < nodes.length; i++) unplacedNodes.push(nodes[i]);
    };
    const runPlacementPass = () => {
      updateLabelPositions();
      if (unplacedNodes.length === 0) return;
      const created = unplacedNodes;
      unplacedNodes = [];
      for (let i = 0; i < created.length; i++) {
        if (created[i].isConnected && created[i].style.display === 'none') {
          queueTradeOverlayRelayout();
          return;
        }
      }
    };
    // Incremental passes: ONE coalesced rAF pass; nodes are never measured right after insertion.
    let placementFrame: number | null = null;
    const schedulePlacementPass = () => {
      if (typeof window.requestAnimationFrame !== 'function') {
        runPlacementPass();
        return;
      }
      if (placementFrame !== null) return;
      placementFrame = window.requestAnimationFrame(() => {
        placementFrame = null;
        if (isDisposedRef.current) return;
        runPlacementPass();
      });
    };
    const closedContentCache = new WeakMap<ClosedTradeSnapshot, { key: string; hash: number }>();
    const getClosedTradeContent = (trade: ClosedTradeSnapshot) => {
      let content = closedContentCache.get(trade);
      if (!content) {
        const key = [
          trade.key,
          trade.side,
          trade.volume,
          trade.entryTime,
          trade.exitTime,
          trade.entryExecutionTime,
          trade.exitExecutionTime,
          formatSignaturePrice(trade.entryPrice),
          formatSignaturePrice(trade.exitPrice),
          trade.profit ?? '',
          trade.source,
        ].join(':');
        content = { key, hash: hashString32(key) };
        closedContentCache.set(trade, content);
      }
      return content;
    };
    const renderTradeOverlay = (options: boolean | { forceActive?: boolean; forceHistory?: boolean } = false) => {
      if (isDisposedRef.current || !seriesRef.current || !overlayRef.current) return;
      const forceActive = typeof options === 'boolean' ? options : Boolean(options.forceActive);
      const forceHistory = typeof options === 'boolean' ? options : Boolean(options.forceHistory);
      // An explicit `true` (settings/theme/rebuild requests) still rebuilds every history node;
      // object-form forces (a close) reconcile incrementally.
      const explicitHistoryRebuild = options === true;
      const explicitActiveRebuild = options === true;
      // A full rebuild is placed synchronously so it never paints an empty overlay.
      let fullRebuild = false;
      const now = Date.now();
      pruneCloseSuppressedTradeKeys(now);
      const closeSuppressedTradeKeys = new Set(closeSuppressedTradeKeysRef.current.keys());

      const chartProperties = useChartSettingsStore.getState().symbolProperties[symbol]
        || useChartSettingsStore.getState().globalProperties;
      const showTradeLevels = chartProperties.showTradeLevels !== false
        && !getChartObjectState(
          useChartObjectStateStore.getState().byContext,
          drawingRuntimeContextRef.current.contextId,
        ).tradesHidden;
      const showTradeHistoryLine = chartProperties.showTradeHistory !== false;
      const showTradeHistoryArrows = chartProperties.showTradeHistoryArrows !== false;
      const showAnyTradeHistoryOverlay = showTradeHistoryLine || showTradeHistoryArrows;
      const tradeHistoryLineOpacityPercent = clampChartOpacityPercent(
        chartProperties.tradeHistoryLineOpacity,
        defaultChartProperties.tradeHistoryLineOpacity,
      );
      const tradeHistoryLineOpacity = tradeHistoryLineOpacityPercent / 100;
      const appState = useAppStore.getState();
      const appPositions: TradePositionRecord[] = Array.isArray(appState.positions) ? appState.positions : [];
      const appOrders: Array<Record<string, unknown>> = Array.isArray(appState.orders)
        ? (appState.orders as unknown as Array<Record<string, unknown>>)
        : [];
      const appTrades = Array.isArray(appState.trades) ? appState.trades : [];
      const liveTrailTime = getLiveTrailTime();
      const isMatchingTradeSymbol = (rawSymbol: unknown) => {
        const positionSymbol = String(rawSymbol || '').trim().toUpperCase();
        if (!positionSymbol) return false;
        return positionSymbol === normalizedChartSymbol;
      };
      const getPositionId = (position: TradePositionRecord): number | string | null => {
        const rawId = position?.id ?? position?.ticket ?? position?.positionId ?? position?.position_id;
        const id = String(rawId ?? '').trim();
        return id ? id : null;
      };
      const getPositionSymbol = (position: TradePositionRecord): string =>
        String(position?.symbol ?? position?.instrument ?? position?.name ?? '');
      const getPositionVolume = (position: TradePositionRecord): number => Number(
        position?.volume
        ?? position?.quantity
        ?? position?.volume_lots
        ?? position?.lots
        ?? 0,
      ) || 0;
      const getPositionSide = (position: TradePositionRecord): TradeSide => {
        const side = String(position?.side ?? position?.action ?? position?.type ?? '').trim().toUpperCase();
        return side.includes('SELL') || side === '1' ? 'SELL' : 'BUY';
      };
      // Backend open price only. A netting add/reduce re-averages it on the same ticket;
      // the click-time quote (chartEntryPrice) is just the fallback until it exists.
      const getPositionOpenPrice = (position: TradePositionRecord): number => pickPositiveNumber(
        position?.openPrice,
        position?.open_price,
        position?.price_open,
        position?.priceOpen,
      );
      const getPositionCurrentPrice = (position: TradePositionRecord): number => pickPositiveNumber(
        position?.currentPrice,
        position?.current_price,
        position?.price_current,
        position?.priceCurrent,
        position?.price,
      );
      const getPositionOpenTime = (position: TradePositionRecord): number | null => normalizeUnixSeconds(
        position?.chartEntryTime
        ?? position?.openTime
        ?? position?.time_create
        ?? position?.time_open
        ?? position?.time_ms
        ?? position?.time,
      );
      const rawActiveTradeKeys = new Set(
        appPositions
          .filter((position) => {
            const positionId = getPositionId(position);
            return positionId != null
              && !isPositionMarkedClosed(positionId, now)
              && getPositionVolume(position) > 0
              && isMatchingTradeSymbol(getPositionSymbol(position));
          })
          .map((position) => `trade:${String(getPositionId(position))}`),
      );
      const activeTradeKeys = filterActiveTradeKeysForHistory(rawActiveTradeKeys, closeSuppressedTradeKeys);
      const mapHistoryTimestamp = (value: unknown): number =>
        mapTradeTimestampToChartTime(value) ?? normalizeUnixSeconds(value) ?? 0;
      const activeKeys = Array.from(activeTradeKeys).sort().join('|');
      const candleWindow = `${candlesRef.current.length}:${candlesRef.current[0]?.time}:${candlesRef.current.at(-1)?.time}:${currentCandleRef.current?.time}:${prevTimeframeRef.current || timeframe}:${brokerTimeOffsetSec}`;
      if (!historyCache || historyCache.rows !== appTrades || historyCache.candleWindow !== candleWindow) {
        const all = buildClosedTradeHistorySnapshots({
          rows: appTrades as unknown as TradeOverlayHistoryRow[],
          symbol: normalizedChartSymbol,
          mapTimestamp: mapHistoryTimestamp,
        });
        historyCache = { rows: appTrades, candleWindow, all, activeKeys: '<unset>', filtered: all };
      }
      if (historyCache.activeKeys !== activeKeys) {
        const all = historyCache.all;
        let hidesAny = false;
        for (let i = 0; i < all.length && !hidesAny; i++) hidesAny = activeTradeKeys.has(all[i].key);
        historyCache.filtered = hidesAny ? all.filter((trade) => !activeTradeKeys.has(trade.key)) : all;
        historyCache.activeKeys = activeKeys;
      }
      const closedHistorySnapshots = historyCache.filtered;
      const realClosedTradeKeys = new Set(closedHistorySnapshots.map((trade) => trade.key));
      let didClearClosedHistoryTradeLevels = false;
      realClosedTradeKeys.forEach((key) => {
        const capturedTrade = activeTradeSnapshotsRef.current.get(key)
          ?? pendingMissingActiveTradesRef.current.get(key)?.trade
          ?? pendingClosedTradeSnapshotsRef.current.get(key);
        didClearClosedHistoryTradeLevels = capturedTrade
          ? clearTradeLevelRuntimeState(capturedTrade) || didClearClosedHistoryTradeLevels
          : clearTradeLevelRuntimeStateByKey(key) || didClearClosedHistoryTradeLevels;
        pendingClosedTradeSnapshotsRef.current.delete(key);
      });
      if (didClearClosedHistoryTradeLevels) persistTradeLevelOverrides();

      const normalizedAppPositions = appPositions.map((position) => ({
        id: getPositionId(position),
        symbol: getPositionSymbol(position),
        side: getPositionSide(position),
        volume: getPositionVolume(position),
        openPrice: getPositionOpenPrice(position),
        chartEntryPrice: pickPositiveNumber(position?.chartEntryPrice),
        currentPrice: getPositionCurrentPrice(position),
        rawOpenTime: getPositionOpenTime(position),
        sl: pickPositiveNumber(position.sl, position.price_sl, position.stopLoss, position.stop_loss),
        tp: pickPositiveNumber(position.tp, position.price_tp, position.takeProfit, position.take_profit),
      }));

      const matchingPositions = normalizedAppPositions.filter((position) => {
        const positionSymbol = String(position.symbol || '').trim().toUpperCase();
        if (!position.id || !positionSymbol) return false;
        // FIX: Never render or manage a different suffix contract's position.
        return Number(position.volume) > 0
          && positionSymbol === normalizedChartSymbol
          && !isPositionMarkedClosed(position.id, now);
      });

      // A broker snapshot written since the previous pass that no longer lists a
      // ticket proves it closed; the grace window below only covers gaps that no
      // snapshot has confirmed yet.
      const authoritativePositionsSeq = getPositionsAuthoritativeSeq();
      const lastAuthoritativePositionsSeq = lastAuthoritativePositionsSeqRef.current;
      lastAuthoritativePositionsSeqRef.current = authoritativePositionsSeq;
      const hasFreshAuthoritativeSnapshot = lastAuthoritativePositionsSeq !== null
        && lastAuthoritativePositionsSeq !== authoritativePositionsSeq;
      // The store decides confirmed-then-absent tickets; a fresh snapshot covers the rest.
      const isExcludedByAuthoritativeSnapshot = (key: string): boolean => isConfirmedClosedBySnapshot(getTradeTicket(key))
        || (hasFreshAuthoritativeSnapshot
          && !appPositions.some((position) => `trade:${String(getPositionId(position))}` === key));

      const nextActiveSnapshots = new Map<string, ActiveTradeSnapshot>();

      for (const position of matchingPositions) {
        const key = `trade:${String(position.id)}`;
        if (closeSuppressedTradeKeys.has(key)) {
          pendingMissingActiveTradesRef.current.delete(key);
          continue;
        }

        const activeTf = prevTimeframeRef.current || timeframe;
        const scopedEntryTimeKey = getFrozenEntryTimeKey(key, activeTf);
        const storedEntryTime = frozenEntryTimesRef.current.get(scopedEntryTimeKey);
        const validStoredEntryTime = storedEntryTime != null && canResolveOverlayTime(storedEntryTime)
          ? storedEntryTime
          : null;
        const rawEntryTime = position.rawOpenTime ?? normalizeUnixSeconds(Date.now());
        const mappedEntryTime = resolveStableTradeEntryTime(
          validStoredEntryTime,
          rawEntryTime,
          mapTradeTimestampToChartTime,
          liveTrailTime,
        );
        const entryTime = canResolveOverlayTime(mappedEntryTime)
          ? mappedEntryTime
          : (liveTrailTime ?? mappedEntryTime);
        if (validStoredEntryTime == null && entryTime > 0 && canResolveOverlayTime(entryTime)) {
          frozenEntryTimesRef.current.set(scopedEntryTimeKey, entryTime);
        }

        const storedEntryPrice = frozenEntryPricesRef.current.get(key);
        // A positive backend open price wins and re-pins (netting add/reduce keeps the
        // ticket); the pin only holds a click-quote / live-price fallback steady.
        const entryPrice = resolveStableTradeEntryPrice(
          storedEntryPrice,
          position.openPrice,
          position.chartEntryPrice || position.currentPrice,
        );
        if (entryPrice > 0 && entryPrice !== storedEntryPrice) {
          frozenEntryPricesRef.current.set(key, entryPrice);
        }
        if (!(entryTime > 0) || !(entryPrice > 0)) continue;

        nextActiveSnapshots.set(key, {
          key,
          symbol: normalizedChartSymbol,
          side: position.side,
          volume: position.volume,
          entryPrice,
          entryTime,
          entryExecutionTime: rawEntryTime ?? entryTime,
          currentPrice: getLiveTrailPrice(position.side, position.currentPrice || entryPrice) ?? entryPrice,
          currentTime: liveTrailTime ?? entryTime,
          sl: position.sl,
          tp: position.tp,
        });
        pendingMissingActiveTradesRef.current.delete(key);
      }

      for (const rawOrder of appOrders) {
        const rawStatus = String(rawOrder?.status ?? 'pending').trim().toLowerCase();
        if (['cancelled', 'canceled', 'expired', 'rejected', 'filled', 'triggered'].includes(rawStatus)) {
          continue;
        }
        const orderSymbol = String(rawOrder?.symbol ?? '').trim().toUpperCase();
        if (!orderSymbol || orderSymbol !== normalizedChartSymbol) continue;
        const orderId = String(rawOrder?.ticket ?? rawOrder?.id ?? '').trim();
        if (!orderId || orderId === '0') continue;
        const orderVolume = Number(rawOrder?.volume ?? rawOrder?.quantity ?? rawOrder?.lots ?? 0) || 0;
        if (!(orderVolume > 0)) continue;
        const orderPrice = pickPositiveNumber(rawOrder?.price, rawOrder?.price_trigger, rawOrder?.openPrice, rawOrder?.open_price);
        if (!(orderPrice > 0)) continue;
        const rawOrderType = String(rawOrder?.type ?? rawOrder?.orderType ?? '').trim().toLowerCase();
        const orderSide: TradeSide = String(rawOrder?.side ?? rawOrderType).toUpperCase().includes('SELL') ? 'SELL' : 'BUY';
        const key = `order:${orderId}`;
        const activeTf = prevTimeframeRef.current || timeframe;
        const scopedEntryTimeKey = getFrozenEntryTimeKey(key, activeTf);
        const storedEntryTime = frozenEntryTimesRef.current.get(scopedEntryTimeKey);
        const validStoredEntryTime = storedEntryTime != null && canResolveOverlayTime(storedEntryTime)
          ? storedEntryTime
          : null;
        const rawOrderTime = normalizeUnixSeconds(rawOrder?.time_setup ?? rawOrder?.time_create ?? rawOrder?.created_at)
          ?? validStoredEntryTime
          ?? normalizeUnixSeconds(Date.now());
        const mappedOrderTime = resolveStableTradeEntryTime(
          validStoredEntryTime,
          rawOrderTime,
          mapTradeTimestampToChartTime,
          liveTrailTime,
        );
        const entryTime = canResolveOverlayTime(mappedOrderTime)
          ? mappedOrderTime
          : (liveTrailTime ?? mappedOrderTime);
        if (validStoredEntryTime == null && entryTime > 0 && canResolveOverlayTime(entryTime)) {
          frozenEntryTimesRef.current.set(scopedEntryTimeKey, entryTime);
        }
        nextActiveSnapshots.set(key, {
          key,
          kind: 'pending',
          orderType: rawOrderType || (orderSide === 'SELL' ? 'sell_limit' : 'buy_limit'),
          symbol: normalizedChartSymbol,
          side: orderSide,
          volume: orderVolume,
          entryPrice: orderPrice,
          limitPrice: pickPositiveNumber(rawOrder?.price_limit, rawOrder?.limitPrice),
          entryTime: entryTime || normalizeUnixSeconds(Date.now()) || 1,
          entryExecutionTime: rawOrderTime ?? entryTime ?? 1,
          currentPrice: getLiveTrailPrice(orderSide, orderPrice) ?? orderPrice,
          currentTime: liveTrailTime ?? entryTime ?? 1,
          sl: pickPositiveNumber(rawOrder?.price_sl, rawOrder?.sl),
          tp: pickPositiveNumber(rawOrder?.price_tp, rawOrder?.tp),
          expiry: Number(rawOrder?.time_expiry ?? rawOrder?.expiry ?? 0) || null,
          comment: typeof rawOrder?.comment === 'string' ? rawOrder.comment : undefined,
          stateVersion: Number(rawOrder?.state_version ?? 0) || undefined,
        });
        pendingMissingActiveTradesRef.current.delete(key);
      }

      const renderActiveSnapshots = new Map(nextActiveSnapshots);
      const visuallyRetainedActiveTradeKeys = new Set<string>();

      activeTradeSnapshotsRef.current.forEach((previousTrade, key) => {
        if (previousTrade.symbol !== normalizedChartSymbol || nextActiveSnapshots.has(key)) return;
        if (previousTrade.kind === 'pending') {
          pendingMissingActiveTradesRef.current.delete(key);
          return;
        }
        if (!shouldKeepMissingActiveTradeOverlay({
          tradeKey: key,
          closeSuppressedTradeKeys,
          closedHistoryTradeKeys: realClosedTradeKeys,
          brokerMarkedClosed: isPositionMarkedClosed(getTradeTicket(key), now),
        })) {
          pendingMissingActiveTradesRef.current.delete(key);
          return;
        }

        // Grace window (pendingMissingActiveTradesRef): a missing row alone is not
        // proof of execution. Lagged or partial stream/REST updates can omit an open
        // position for a moment, so it is kept until closure is confirmed. A fresh
        // broker snapshot that excludes the ticket confirms it, so it is dropped now.
        if (isExcludedByAuthoritativeSnapshot(key)) {
          pendingMissingActiveTradesRef.current.delete(key);
          return;
        }
        if (!pendingMissingActiveTradesRef.current.has(key)) {
          pendingMissingActiveTradesRef.current.set(key, { trade: previousTrade, missingSince: now });
          scheduleHistoryRefresh();
        }
      });

      pendingMissingActiveTradesRef.current.forEach((pending, key) => {
        if (
          pending.trade.symbol !== normalizedChartSymbol
          || nextActiveSnapshots.has(key)
          || isExcludedByAuthoritativeSnapshot(key)
          || !shouldKeepMissingActiveTradeOverlay({
            tradeKey: key,
            closeSuppressedTradeKeys,
            closedHistoryTradeKeys: realClosedTradeKeys,
            brokerMarkedClosed: isPositionMarkedClosed(getTradeTicket(key), now),
          })
        ) {
          pendingMissingActiveTradesRef.current.delete(key);
          return;
        }

        // Retain until a broker close marker, closed history row, or explicit
        // close request owns removal. Local price crossings and a missing row
        // cannot prove execution, even when other account positions are live.
        renderActiveSnapshots.set(key, pending.trade);
        visuallyRetainedActiveTradeKeys.add(key);
      });

      // Keep retained fills in the live snapshot map so a lagged empty store
      // cannot drop on-chart open trades on the next overlay pass.
      activeTradeSnapshotsRef.current = renderActiveSnapshots;

      // The first missing snapshot already requests history above. Continue
      // checking at a bounded cadence without inferring a fill from elapsed time.
      if (pendingMissingActiveTradesRef.current.size > 0) {
        if (tradeMissingGraceTimerRef.current === null) {
          tradeMissingGraceTimerRef.current = window.setTimeout(() => {
            tradeMissingGraceTimerRef.current = null;
            scheduleHistoryRefresh();
            renderTradeOverlay({ forceActive: true });
          }, TRADE_MISSING_POSITION_GRACE_MS);
        }
      } else if (tradeMissingGraceTimerRef.current !== null) {
        window.clearTimeout(tradeMissingGraceTimerRef.current);
        tradeMissingGraceTimerRef.current = null;
      }

      const closedTrades = new Map<string, ClosedTradeSnapshot>();
      const baseHistoryCandles = lastRenderedCandlesRef.current.length > 0
        ? lastRenderedCandlesRef.current
        : candlesRef.current;
      const renderedHistoryCandles = currentCandleRef.current
        && baseHistoryCandles.at(-1)?.time !== currentCandleRef.current.time
        ? [...baseHistoryCandles, currentCandleRef.current]
        : baseHistoryCandles;
      const historyTimeRange = getTradeHistoryTimeRange(
        renderedHistoryCandles, chartRef.current?.timeScale().getVisibleLogicalRange() ?? null,
      );
      const registerClosedTrade = (trade: ClosedTradeSnapshot) => {
        if (trade.entryPrice > 0 && trade.exitPrice > 0 && trade.entryTime > 0 && trade.exitTime > 0) {
          closedTrades.set(trade.key, trade);
        }
      };
      const hasRenderableClosedTradePath = (trade: ClosedTradeSnapshot): boolean => {
        const hasVisibleSpan = Math.abs(trade.entryTime - trade.exitTime) > 0
          || Math.abs(trade.entryPrice - trade.exitPrice) > priceTolerance;
        return hasVisibleSpan && canResolveOverlayTime(trade.entryTime) && canResolveOverlayTime(trade.exitTime);
      };

      if (showAnyTradeHistoryOverlay) {
        getTradeOverlayOptimisticClosedSnapshots(normalizedChartSymbol).forEach((trade) => {
          if (activeTradeKeys.has(trade.key)) {
            forgetTradeOverlayOptimisticClosedSnapshot(trade.key);
            return;
          }
          const chartTrade = mapStoredClosedTradeToChart(trade);
          if (chartTrade) {
            registerClosedTrade(chartTrade);
          }
        });
        optimisticClosedTradeSnapshotsRef.current.forEach((trade, key) => {
          if (activeTradeKeys.has(key)) {
            optimisticClosedTradeSnapshotsRef.current.delete(key);
            return;
          }
          if (trade.symbol === normalizedChartSymbol) {
            registerClosedTrade(trade);
          }
        });
        closedHistorySnapshots.forEach((trade) => {
          const existingTrade = closedTrades.get(trade.key);
          const backendHasRenderablePath = hasRenderableClosedTradePath(trade);
          if (shouldUseClosedTradeHistorySnapshot({
            existingTrade,
            candidateTrade: trade,
            canRenderTradePath: hasRenderableClosedTradePath,
          })) {
            registerClosedTrade(trade);
            if (backendHasRenderablePath) {
              optimisticClosedTradeSnapshotsRef.current.delete(trade.key);
              forgetTradeOverlayOptimisticClosedSnapshot(trade.key);
            }
          } else if (existingTrade) {
            registerClosedTrade({
              ...existingTrade,
              entryExecutionTime: trade.entryExecutionTime,
              exitExecutionTime: trade.exitExecutionTime,
            });
          }
        });
      }

      // Reconcile the complete account history before selecting DOM membership.
      // Panning never removes records or changes optimistic close reconciliation.
      // Only trades crossing the visible time range keep DOM, capped to the most recent ones.
      const visibleClosedTrades = capRecentHistoryTrades(
        Array.from(closedTrades.values()).filter(trade => isTradeHistoryInTimeRange(trade, historyTimeRange)),
      );
      const sortedActiveSnapshots = Array.from(renderActiveSnapshots.values())
        .sort((a, b) => a.key.localeCompare(b.key));
      const activeSignature = showTradeLevels
        ? sortedActiveSnapshots.map((trade) => {
          const levels = nextActiveSnapshots.has(trade.key) || visuallyRetainedActiveTradeKeys.has(trade.key)
            ? resolveTradeLevels(trade)
            : { sl: 0, tp: 0 };
          return [
            trade.key,
            trade.side,
            trade.volume,
            trade.entryTime,
            formatSignaturePrice(trade.entryPrice),
            formatSignaturePrice(levels.sl),
            formatSignaturePrice(levels.tp),
          ].join(':');
        }).join('|')
        : '';
      // Order-independent rolling signature (count + sum + xor of per-trade hashes): no sort/join
      // of the whole set per pass; the keyed diff below is what decides which nodes change.
      const desiredHistory: Array<HistoryOverlayDesiredTrade<ClosedTradeSnapshot>> = [];
      let closedSignature = '';
      if (showAnyTradeHistoryOverlay) {
        let hashSum = 0;
        let hashXor = 0;
        for (const trade of visibleClosedTrades) {
          const content = getClosedTradeContent(trade);
          hashSum = (hashSum + content.hash) >>> 0;
          hashXor = (hashXor ^ content.hash) >>> 0;
          desiredHistory.push({ key: trade.key, contentKey: content.key, item: trade });
        }
        closedSignature = `${desiredHistory.length}:${hashSum}:${hashXor}`;
      }
      const sharedTradeForSignature = getSharedChartTrade();
      const sharedTradeSignature = sharedTradeForSignature && sharedTradeForSignature.symbol === normalizedChartSymbol
        ? `shared:${sharedTradeForSignature.ticket}:${activeTradeKeys.has(`trade:${sharedTradeForSignature.ticket}`) ? 'live' : 'annotated'}`
        : 'shared:none';
      const nextActiveSignature = [
        normalizedChartSymbol,
        timeframe,
        TRADE_HISTORY_PRESENTATION_VERSION,
        showTradeLevels ? 'levels:on' : 'levels:off',
        sharedTradeSignature,
        activeSignature,
      ].join('\n');
      const historyHeader = [
        normalizedChartSymbol,
        timeframe,
        TRADE_HISTORY_PRESENTATION_VERSION,
        showTradeHistoryLine ? 'history-lines:on' : 'history-lines:off',
        showTradeHistoryArrows ? 'arrows:on' : 'arrows:off',
        `line-opacity:${tradeHistoryLineOpacityPercent}`,
      ].join('\n');
      const nextHistorySignature = `${historyHeader}\n${closedSignature}`;

      const { activeChanged, historyChanged } = getTradeOverlayRedrawDecision({
        lastActiveSignature: lastActiveTradeOverlaySignatureRef.current,
        nextActiveSignature,
        lastHistorySignature: lastHistoryTradeOverlaySignatureRef.current,
        nextHistorySignature,
        forceActive,
        forceHistory,
      });
      if (!activeChanged && !historyChanged) {
        queueTradeOverlayRelayout();
        return;
      }

      if (activeChanged) {
        // A settings/theme/rebuild request (explicit `true`) or an externally cleared layer rebuilds every
        // active node. Everything else (a fill, a close, an SL/TP edit, a grace-timer pass) is reconciled
        // per trade key: unchanged trades keep their DOM nodes, listeners and size-cache entries.
        if (explicitActiveRebuild || lastActiveTradeOverlaySignatureRef.current === '') {
          clearTradeOverlayLayer('active');
          activeEntries.clear();
          activeUpdaters.clear();
          fullRebuild = true;
        }
        lastActiveTradeOverlaySignatureRef.current = nextActiveSignature;

        const desiredActive: Array<HistoryOverlayDesiredTrade<ActiveOverlayItem>> = [];
        if (showTradeLevels) {
          // The translated SL/TP words fingerprint the UI language, so a language switch rebuilds kept trades'
          // titles on the next pass exactly like the old full rebuild did (2 lookups per pass, never per tick).
          const themeKey = `${isChartSurfaceLight() ? 'L' : 'D'}${chartThemeRef.current.background ?? ''}|${tr('SL')}|${tr('TP')}`;
          const liveTradeKeys = new Set(nextActiveSnapshots.keys());
          const tradeLevels = new Map<string, TradeLevelOverride>();
          const entryGroups = new Map<number, ActiveTradeSnapshot[]>();
          for (const trade of sortedActiveSnapshots) {
            tradeLevels.set(
              trade.key,
              liveTradeKeys.has(trade.key) || visuallyRetainedActiveTradeKeys.has(trade.key)
                ? resolveTradeLevels(trade)
                : { sl: 0, tp: 0 },
            );
            if (!Number.isFinite(trade.entryPrice) || !(trade.entryPrice > 0)) continue;
            const group = entryGroups.get(trade.entryPrice);
            if (group) group.push(trade);
            else entryGroups.set(trade.entryPrice, [trade]);
          }
          // Entry price lines are shared per exact price; a trade's hover binding depends on its group.
          const entryGroupHash = new Map<number, number>();
          for (const [price, group] of entryGroups) {
            const groupContentKey = `${themeKey}|${price}|${group.map((trade) => (
              `${trade.key}/${trade.side}/${trade.kind ?? ''}/${trade.volume}/${liveTradeKeys.has(trade.key) ? 1 : 0}`
            )).join(',')}`;
            entryGroupHash.set(price, hashString32(groupContentKey));
            // Keyed by the group's first trade so groups are created in the same (trade key) order as before.
            const groupKey = `0|${group[0].key}`;
            desiredActive.push({
              key: groupKey,
              contentKey: groupContentKey,
              item: { key: groupKey, build: () => createEntryPriceLevels(group, liveTradeKeys) },
            });
          }
          // Same stacking as before: ONE collision factory shared by all trades (SL then TP, sorted order),
          // then the share-link annotation. Only built when something consumes the offsets.
          const sharedTrade = getSharedChartTrade();
          const sharedActive = Boolean(
            sharedTrade
            && sharedTrade.symbol === normalizedChartSymbol
            && !activeTradeKeys.has(`trade:${sharedTrade.ticket}`),
          );
          let needsStacking = sharedActive;
          if (!needsStacking) {
            for (const trade of sortedActiveSnapshots) {
              if (!liveTradeKeys.has(trade.key) && !visuallyRetainedActiveTradeKeys.has(trade.key)) {
                needsStacking = true;
                break;
              }
            }
          }
          const stackOffset = needsStacking ? createCollisionOffsetFactory() : null;
          sortedActiveSnapshots.forEach((trade) => {
            const isLiveActiveTrade = liveTradeKeys.has(trade.key);
            const isVisuallyRetainedTrade = visuallyRetainedActiveTradeKeys.has(trade.key);
            const levels = tradeLevels.get(trade.key)!;
            const slOffset = stackOffset && levels.sl > 0 ? stackOffset('SL', levels.sl) : 0;
            const tpOffset = stackOffset && levels.tp > 0 ? stackOffset('TP', levels.tp) : 0;
            const contentKey = [
              themeKey, trade.key, trade.side, trade.volume, trade.kind ?? '', trade.orderType ?? '',
              trade.entryPrice, trade.entryTime, trade.limitPrice ?? '', trade.stateVersion ?? '',
              levels.sl, levels.tp, isLiveActiveTrade ? 1 : 0, isVisuallyRetainedTrade ? 1 : 0,
              entryGroupHash.get(trade.entryPrice) ?? '', slOffset, tpOffset,
            ].join(':');
            desiredActive.push({
              key: `1|${trade.key}`,
              contentKey,
              item: {
                key: `1|${trade.key}`,
                build: () => {
                  const ticketLabel = getTradeTicketLabel(trade.key);
                  const entryPriceLabel = formatTradeLevelBadgePrice(trade.entryPrice);
                  const markerTitle = `${trade.side} ${trade.volume} ${ticketLabel} @ ${entryPriceLabel}`.trim();
                  const activeMarkerTimeKey = getActiveMarkerTimeKey(trade.key);
                  let stableActiveMarkerTime = stableActiveMarkerTimesRef.current.get(activeMarkerTimeKey) ?? null;
                  if (
                    !(stableActiveMarkerTime != null && stableActiveMarkerTime > 0 && canResolveOverlayTime(stableActiveMarkerTime))
                    && trade.currentTime > 0
                  ) {
                    stableActiveMarkerTime = trade.currentTime;
                    if (canResolveOverlayTime(stableActiveMarkerTime)) {
                      stableActiveMarkerTimesRef.current.set(activeMarkerTimeKey, stableActiveMarkerTime);
                    }
                  }
                  createTradeMarker(
                    trade.side,
                    trade.entryPrice,
                    trade.entryTime,
                    markerTitle,
                    'active',
                    1,
                    () => stableActiveMarkerTimesRef.current.get(activeMarkerTimeKey) ?? stableActiveMarkerTime,
                  );

                  // Keep the control bars rendered while a position momentarily
                  // drops out of the store (REST refresh / WS reconnect gaps). A
                  // live<->retained flap must not blink the on-chart controls; only
                  // the settings toggle or a real close removes them.
                  const showTradeControls = isLiveActiveTrade || isVisuallyRetainedTrade;
                  if (showTradeControls) {
                    createEntryControlsForTrade(trade, levels, { showAxisPriceLine: false });
                  }

                  if (levels.sl && levels.sl > 0) {
                    const stopLossPriceLabel = formatTradeLevelBadgePrice(levels.sl);
                    createPriceLevel(`SL ${ticketLabel} ${stopLossPriceLabel}`.trim(), levels.sl, TRADE_SELL_COLOR, {
                      tradeKey: isLiveActiveTrade ? trade.key : undefined,
                      role: isLiveActiveTrade ? 'SL' : undefined,
                      badgeOffsetIndex: showTradeControls ? 0 : slOffset,
                      title: isVisuallyRetainedTrade
                        ? `Stop Loss for ${ticketLabel || trade.key} @ ${stopLossPriceLabel}. Waiting for position refresh.`
                        : `Stop Loss for ${ticketLabel || trade.key} @ ${stopLossPriceLabel}`,
                      getTitle: () => `${getLocalizedTradeTitle(trade, 'SL', levels.sl)}${isVisuallyRetainedTrade ? ` · ${tr('Loading open positions...')}` : ''}`,
                      getLabel: () => `${tr('SL')} ${ticketLabel} ${stopLossPriceLabel}`,
                      labelVariant: showTradeControls ? 'none' : 'lineText',
                    });
                    if (showTradeControls) {
                      createLevelControlsForTrade(trade, 'SL', levels);
                    }
                  }
                  if (levels.tp && levels.tp > 0) {
                    const takeProfitPriceLabel = formatTradeLevelBadgePrice(levels.tp);
                    createPriceLevel(`TP ${ticketLabel} ${takeProfitPriceLabel}`.trim(), levels.tp, TRADE_BUY_COLOR, {
                      tradeKey: isLiveActiveTrade ? trade.key : undefined,
                      role: isLiveActiveTrade ? 'TP' : undefined,
                      badgeOffsetIndex: showTradeControls ? 0 : tpOffset,
                      title: isVisuallyRetainedTrade
                        ? `Take Profit for ${ticketLabel || trade.key} @ ${takeProfitPriceLabel}. Waiting for position refresh.`
                        : `Take Profit for ${ticketLabel || trade.key} @ ${takeProfitPriceLabel}`,
                      getTitle: () => `${getLocalizedTradeTitle(trade, 'TP', levels.tp)}${isVisuallyRetainedTrade ? ` · ${tr('Loading open positions...')}` : ''}`,
                      getLabel: () => `${tr('TP')} ${ticketLabel} ${takeProfitPriceLabel}`,
                      labelVariant: showTradeControls ? 'none' : 'lineText',
                    });
                    if (showTradeControls) {
                      createLevelControlsForTrade(trade, 'TP', levels);
                    }
                  }
                },
              },
            });
          });

          // A trade opened from a share link renders as an annotation drawn
          // purely from the URL payload, so the shared view keeps showing the
          // trade even after the position closes. Suppressed while the same
          // ticket is still live (the live control bar already shows it).
          if (sharedActive && sharedTrade) {
            const entryOffset = stackOffset!('ENTRY', sharedTrade.entryPrice);
            const sharedSlOffset = sharedTrade.sl > 0 ? stackOffset!('SL', sharedTrade.sl) : 0;
            const sharedTpOffset = sharedTrade.tp > 0 ? stackOffset!('TP', sharedTrade.tp) : 0;
            desiredActive.push({
              key: '2|shared',
              contentKey: [
                themeKey, sharedTrade.ticket, sharedTrade.side, sharedTrade.volume, sharedTrade.entryPrice,
                sharedTrade.entryTime, sharedTrade.sl, sharedTrade.tp, entryOffset, sharedSlOffset, sharedTpOffset,
              ].join(':'),
              item: {
                key: '2|shared',
                build: () => {
                  const sharedColor = getEntryLineColor(sharedTrade.side);
                  const sharedTicketLabel = sharedTrade.ticket > 0 ? `#${sharedTrade.ticket} ` : '';
                  const sharedLabel = `Shared ${sharedTrade.side} ${sharedTicketLabel}${sharedTrade.volume} at ${formatTradeLevelBadgePrice(sharedTrade.entryPrice)}`.trim();
                  createPriceLevel(sharedLabel, sharedTrade.entryPrice, sharedColor, {
                    badgeOffsetIndex: entryOffset,
                    title: `${sharedLabel} (from share link)`,
                    labelVariant: 'lineText',
                    lineColor: sharedColor,
                  });
                  addTradeAxisPriceLine(`shared:${sharedTrade.ticket}:entry`, sharedTrade.entryPrice, sharedColor);
                  if (sharedTrade.entryTime > 0) {
                    createTradeMarker(sharedTrade.side, sharedTrade.entryPrice, sharedTrade.entryTime, sharedLabel, 'active', 0.9);
                  }
                  if (sharedTrade.sl > 0) {
                    createPriceLevel(`SL ${formatTradeLevelBadgePrice(sharedTrade.sl)}`, sharedTrade.sl, TRADE_SELL_COLOR, {
                      badgeOffsetIndex: sharedSlOffset,
                      title: `Shared Stop Loss @ ${formatTradeLevelBadgePrice(sharedTrade.sl)}`,
                      labelVariant: 'lineText',
                    });
                  }
                  if (sharedTrade.tp > 0) {
                    createPriceLevel(`TP ${formatTradeLevelBadgePrice(sharedTrade.tp)}`, sharedTrade.tp, TRADE_BUY_COLOR, {
                      badgeOffsetIndex: sharedTpOffset,
                      title: `Shared Take Profit @ ${formatTradeLevelBadgePrice(sharedTrade.tp)}`,
                      labelVariant: 'lineText',
                    });
                  }
                },
              },
            });
          }
        }

        reconcileHistoryOverlayNodes({
          desired: desiredActive,
          entries: activeEntries,
          nodesRef: activeOverlayNodesRef,
          dataRef: activeOverlayNodeDataRef,
          create: trackCreated(activeOverlayNodesRef, ({ key, build }: ActiveOverlayItem) => {
            // A rebuilt entry replaces its previous live-metric refreshers.
            dropActiveUpdaters(key);
            const updatersBefore = tradeControlLiveUpdatersRef.current.length;
            build();
            const added = tradeControlLiveUpdatersRef.current.slice(updatersBefore);
            if (added.length > 0) activeUpdaters.set(key, added);
          }),
        });
        // Entries removed outright (closed trades) drop their refreshers too.
        for (const key of Array.from(activeUpdaters.keys())) {
          if (!activeEntries.has(key)) dropActiveUpdaters(key);
        }
      }

      if (historyChanged) {
        // Presentation changes, explicit rebuilds and an externally cleared layer rebuild everything;
        // otherwise only the added/removed/changed trades touch the DOM.
        if (
          explicitHistoryRebuild
          || lastHistoryHeader !== historyHeader
          || lastHistoryTradeOverlaySignatureRef.current === ''
        ) {
          clearTradeOverlayLayer('history');
          historyEntries.clear();
          fullRebuild = true;
        }
        lastHistoryTradeOverlaySignatureRef.current = nextHistorySignature;
        lastHistoryHeader = historyHeader;

        if (showAnyTradeHistoryOverlay) {
          reconcileHistoryOverlayNodes({
            desired: desiredHistory,
            entries: historyEntries,
            nodesRef: historyOverlayNodesRef,
            dataRef: historyOverlayNodeDataRef,
            create: trackCreated(historyOverlayNodesRef, (trade: ClosedTradeSnapshot) => {
            const exitSide = getTradeHistoryExecutionSide(trade.side, 'CLOSE');
            if (showTradeHistoryLine) {
              createTradeHistoryLine(
                trade.entryPrice,
                trade.entryTime,
                trade.exitPrice,
                trade.exitTime,
                getClosedTradeLineColor(trade),
                tradeHistoryLineOpacity,
                // Join the arrow tips when arrows are drawn; otherwise the raw fill prices.
                showTradeHistoryArrows ? { start: trade.side, end: exitSide } : undefined,
              );
            }
            if (showTradeHistoryArrows) {
              const entryPriceLabel = formatTradeLevelBadgePrice(trade.entryPrice);
              createTradeMarker(trade.side, trade.entryPrice, trade.entryTime, entryPriceLabel, 'history', 1, undefined, 'open', trade.side, trade.entryExecutionTime);
              const closePriceLabel = formatTradeLevelBadgePrice(trade.exitPrice);
              createTradeMarker(exitSide, trade.exitPrice, trade.exitTime, closePriceLabel, 'history', 1, undefined, 'close', trade.side, trade.exitExecutionTime);
            }
            }),
          });
        } else {
          historyEntries.clear();
        }
      }

      // New nodes are created hidden. A full rebuild is placed right now (no empty-overlay frame);
      // incremental passes coalesce into one rAF pass. Either way a node that still has no coordinates
      // afterwards gets a follow-up relayout.
      if (fullRebuild) {
        if (placementFrame !== null && typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(placementFrame);
          placementFrame = null;
        }
        runPlacementPass();
      } else {
        schedulePlacementPass();
      }
    };

    const unbindSubscriptions = bindTradeOverlayRuntimeSubscriptions({
      activeTradeSnapshotsRef,
      buildClosedTradeFromEventSnapshot,
      buildImmediateClosedTrade,
      chartRef,
      clearFrozenEntryTime,
      clearStableActiveMarkerTime,
      clearTradeLevelRuntimeState,
      clearTradeLevelRuntimeStateByKey,
      clearTradeOverlayLayer,
      clearTradeOverlayVisualRuntime,
      closeSuppressedTradeKeysRef,
      drawingRuntimeContextRef,
      frozenEntryPricesRef,
      isActiveRef,
      optimisticClosedTradeSnapshotsRef,
      pendingClosedTradeSnapshotsRef,
      pendingMissingActiveTradesRef,
      persistTradeLevelOverrides,
      queueTradeOverlayRelayout,
      renderTradeOverlay,
      resolveSymbolTick,
      scheduleHistoryRefresh,
      symbol,
      tradeLevelCrossRefreshPendingRef,
    });
    return () => {
      if (placementFrame !== null) window.cancelAnimationFrame(placementFrame);
      placementFrame = null;
      unbindSubscriptions();
    };
  }, [brokerTimeOffsetSec, clearTradeOverlayLayer, clearTradeOverlayVisualRuntime, getNearestCandleByTime, hydrateTradeLevelOverrides, isLivePriceSafeForCandles, persistTradeLevelOverrides, resolvedPriceDigits, symbol, timeframe, TRADE_HISTORY_PRESENTATION_VERSION, updateLabelPositions]);
};
