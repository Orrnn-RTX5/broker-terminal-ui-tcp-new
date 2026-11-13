import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { api } from '../../services/api';
import { getActiveBinaryTcpOrderCount } from '../../services/binaryTcpOrderClient';
import { getCommittedBrokerAccountSessionScope, getCommittedBrokerAccountSessionScopeKey } from '../../services/brokerSession';
import { applyPositionStreamUpdate, decodePositionStreamMessage } from '../../services/tradePositionStream';
import { beginTradeHistoryRefresh } from '../../services/terminalHistory';
import { beginPositionsRead, useAppStore, type Order, type Position } from '../../store/useAppStore';
import { arePositionsReadsInFlight, markPositionsReadSettled, markPositionsReadStarted } from '../../services/positionSnapshotSafety';
import { parsePositiveLogin } from '../session/sessionIdentity';
import {
  bindDefaultHistoryFreshnessOwner,
  createHistoryFreshnessOwner,
} from './tradeHistoryFreshness';
import { fetchOrderHistory, getErrorMessage } from './orderHistoryRefresh';
import {
  applyOpenPositionSnapshot,
  normalizeAccountSummary,
  normalizePositions,
} from './positionRuntime';
import type {
  PendingPositionsRefresh,
  RefreshPositionsOptions,
  TradeRestRead,
} from './tradeRuntimeContracts';

/**
 * Quiet window after the last post-trade refresh request for a login. Trade completions
 * that each land within this window of the previous one form one burst, which runs one
 * positions read, one orders+history read and one account-metrics read once it goes quiet.
 */
export const POST_TRADE_REFRESH_COALESCE_MS = 150;

/**
 * Longest a burst may wait after its first request. Without it, a trader who keeps sending
 * orders faster than the quiet window would postpone every refresh until they stop.
 */
export const POST_TRADE_REFRESH_MAX_WAIT_MS = 500;

interface PostTradeRefresh {
  refreshPositions: (login?: number, options?: RefreshPositionsOptions) => Promise<void>;
  refreshOrdersAndHistory: (login?: number) => Promise<void>;
}

interface PostTradeRefreshBurst {
  login: number;
  /** Merged options of the positions requests in the burst; null when there were none. */
  positions: RefreshPositionsOptions | null;
  history: boolean;
  timer: number | null;
  /** Date.now() of the burst's first request. */
  startedAt: number;
  settled: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const createPostTradeRefreshBurst = (login: number): PostTradeRefreshBurst => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const settled = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { login, positions: null, history: false, timer: null, startedAt: Date.now(), settled, resolve, reject };
};

const mergePositionsOptions = (
  current: RefreshPositionsOptions | null,
  next: RefreshPositionsOptions,
): RefreshPositionsOptions => ({
  ...current,
  ...next,
  // One trade in the burst that allows WS commits lets the burst's single read commit through them.
  allowWsCommit: Boolean(current?.allowWsCommit || next.allowWsCommit),
});

interface UseTradeRefreshControllerOptions {
  getLiveTradingLogin: () => number | null;
  beginTradeRestRead: () => TradeRestRead;
  isStaleTradeRestRead: (request: TradeRestRead, options?: RefreshPositionsOptions) => boolean;
  reconcileOptimisticClosedPositions: (
    positions: Position[],
    options?: { clearConfirmedAbsent?: boolean },
  ) => Position[];
  accountIdRef: MutableRefObject<string>;
  isAuthenticatedRef: MutableRefObject<boolean>;
  positionsStreamVersionRef: MutableRefObject<number>;
  setOrders?: Dispatch<SetStateAction<unknown[]>>;
}

interface TradeRefreshController {
  refreshPositions: (login?: number, options?: RefreshPositionsOptions) => Promise<void>;
  refreshOrdersAndHistory: (login?: number) => Promise<void>;
  /**
   * Trade-completion variants of the two refreshes above. Requests for a login join its
   * current burst; the burst runs once, after POST_TRADE_REFRESH_COALESCE_MS of quiet.
   */
  postTradeRefresh: PostTradeRefresh;
}

export const useTradeRefreshController = ({
  getLiveTradingLogin,
  beginTradeRestRead,
  isStaleTradeRestRead,
  reconcileOptimisticClosedPositions,
  accountIdRef,
  isAuthenticatedRef,
  positionsStreamVersionRef,
  setOrders,
}: UseTradeRefreshControllerOptions): TradeRefreshController => {
  const refreshPositionsInFlightRef = useRef<Promise<void> | null>(null);
  const refreshPositionsInFlightLoginRef = useRef<number | null>(null);
  const refreshPositionsPendingRef = useRef<PendingPositionsRefresh | null>(null);
  const refreshHistoryInFlightRef = useRef<Promise<void> | null>(null);
  const refreshHistoryInFlightLoginRef = useRef<number | null>(null);
  const refreshHistoryPendingLoginRef = useRef<number | null>(null);
  const refreshMetricsInFlightRef = useRef<Promise<void> | null>(null);
  const refreshMetricsInFlightLoginRef = useRef<number | null>(null);
  const refreshMetricsStartedAtRef = useRef(0);
  const refreshMetricsPendingLoginRef = useRef<number | null>(null);

  const refreshAccountMetrics = useCallback(async (login?: number): Promise<void> => {
    if (typeof api.account?.getAccountMetrics !== 'function') return;
    const requestedLogin = login || getLiveTradingLogin();
    if (!requestedLogin) return;
    if (refreshMetricsInFlightRef.current && refreshMetricsInFlightLoginRef.current === requestedLogin) {
      if (Date.now() - refreshMetricsStartedAtRef.current > 50) {
        refreshMetricsPendingLoginRef.current = requestedLogin;
      }
      await refreshMetricsInFlightRef.current;
      return;
    }

    const request = (async () => {
      try {
        const restRead = beginTradeRestRead();
        const startedAuthToken = useAppStore.getState().authToken;
        const accountScope = getCommittedBrokerAccountSessionScope();
        const metricsScope = getCommittedBrokerAccountSessionScopeKey(accountScope);
        const requestedAt = Date.now();
        const metricsPayload = await api.account.getAccountMetrics(requestedLogin);
        const activeLogin = parsePositiveLogin(useAppStore.getState().accountId || accountIdRef.current || undefined);
        if (!isAuthenticatedRef.current || activeLogin !== requestedLogin) return;
        if (useAppStore.getState().authToken !== startedAuthToken) return;
        if (getCommittedBrokerAccountSessionScopeKey(getCommittedBrokerAccountSessionScope()) !== metricsScope) return;
        if (isStaleTradeRestRead(restRead, { allowWsCommit: true })) return;
        if (!metricsPayload) return;

        const normalizedAccount = normalizeAccountSummary(
          metricsPayload,
          useAppStore.getState().account,
          { partial: true, login: requestedLogin, scope: metricsScope, requestedAt },
        );
        useAppStore.getState().setAccount(normalizedAccount);
      } catch (error) {
        console.warn('[App] refreshAccountMetrics failed:', getErrorMessage(error, 'Account metrics refresh failed'));
      } finally {
        if (refreshMetricsInFlightRef.current === request) {
          refreshMetricsInFlightRef.current = null;
          refreshMetricsInFlightLoginRef.current = null;
          const pendingLogin = refreshMetricsPendingLoginRef.current;
          refreshMetricsPendingLoginRef.current = null;
          if (pendingLogin) void refreshAccountMetrics(pendingLogin);
        }
      }
    })();

    refreshMetricsInFlightLoginRef.current = requestedLogin;
    refreshMetricsStartedAtRef.current = Date.now();
    refreshMetricsInFlightRef.current = request;
    await request;
  }, [accountIdRef, beginTradeRestRead, getLiveTradingLogin, isAuthenticatedRef, isStaleTradeRestRead]);

  const refreshPositions = useCallback(async (
    login?: number,
    options: RefreshPositionsOptions = {},
  ): Promise<void> => {
    const requestedLogin = login || getLiveTradingLogin();
    if (!requestedLogin) return;
    void refreshAccountMetrics(requestedLogin);
    if (refreshPositionsInFlightRef.current && refreshPositionsInFlightLoginRef.current === requestedLogin) {
      refreshPositionsPendingRef.current = { login: requestedLogin, options };
      await refreshPositionsInFlightRef.current;
      return;
    }

    const request = (async () => {
      markPositionsReadStarted();
      try {
        const restRead = beginTradeRestRead();
        const startedAuthToken = useAppStore.getState().authToken;
        const positionsReadStartedAt = beginPositionsRead();
        const positionsPayload = await api.positions.getPositions(requestedLogin);
        const activeLogin = parsePositiveLogin(useAppStore.getState().accountId || accountIdRef.current || undefined);
        if (!isAuthenticatedRef.current || activeLogin !== requestedLogin) return;
        if (useAppStore.getState().authToken !== startedAuthToken) return;
        if (isStaleTradeRestRead(restRead, options)) return;

        const currentPositions = useAppStore.getState().positions;
        const decoded = decodePositionStreamMessage({ data: { positions: positionsPayload } });
        // Stream frames arriving during the read do not make it partial. The store
        // decides omitted tickets from readStartedAt; only a structurally partial list
        // (decoded as patch) closes nothing.
        const normalized = reconcileOptimisticClosedPositions(decoded
          ? applyPositionStreamUpdate(currentPositions, { ...decoded, source: 'rest' }, (raw) => normalizePositions([raw])[0])
          : normalizePositions(positionsPayload), { clearConfirmedAbsent: true });
        applyOpenPositionSnapshot(normalized, {
          readStartedAt: positionsReadStartedAt,
          complete: decoded === null || decoded.kind === 'snapshot',
        });
      } catch (error) {
        console.warn('[App] refreshPositions failed:', getErrorMessage(error, 'Position refresh failed'));
      } finally {
        markPositionsReadSettled();
        if (refreshPositionsInFlightRef.current === request) {
          refreshPositionsInFlightRef.current = null;
          refreshPositionsInFlightLoginRef.current = null;
          const pendingRefresh = refreshPositionsPendingRef.current;
          refreshPositionsPendingRef.current = null;
          if (pendingRefresh) void refreshPositions(pendingRefresh.login, pendingRefresh.options);
        }
      }
    })();

    refreshPositionsInFlightLoginRef.current = requestedLogin;
    refreshPositionsInFlightRef.current = request;
    await request;
  }, [
    accountIdRef,
    beginTradeRestRead,
    getLiveTradingLogin,
    isAuthenticatedRef,
    isStaleTradeRestRead,
    reconcileOptimisticClosedPositions,
    refreshAccountMetrics,
  ]);

  const refreshOrdersAndHistory = useCallback(async (login?: number): Promise<void> => {
    const resolvedLogin = login || getLiveTradingLogin();
    if (!resolvedLogin) return;
    if (!arePositionsReadsInFlight()) {
      void refreshAccountMetrics(resolvedLogin);
    }
    if (refreshHistoryInFlightRef.current && refreshHistoryInFlightLoginRef.current === resolvedLogin) {
      refreshHistoryPendingLoginRef.current = resolvedLogin;
      await refreshHistoryInFlightRef.current;
      return;
    }

    beginTradeHistoryRefresh();
    window.dispatchEvent(new CustomEvent('rtx:trade-history-refresh-started', {
      detail: { login: resolvedLogin },
    }));
    const request = (async () => {
      let historyError: unknown = null;
      let historySucceeded = false;
      try {
        const [pendingOrdersResult, orderHistoryResult] = await Promise.allSettled([
          api.orders.getPendingOrders(resolvedLogin),
          fetchOrderHistory(resolvedLogin),
        ]);
        if (!isAuthenticatedRef.current || getLiveTradingLogin() !== resolvedLogin) return;

        const pendingOrders = pendingOrdersResult.status === 'fulfilled'
          ? pendingOrdersResult.value
          : [];
        setOrders?.(pendingOrders);
        useAppStore.getState().setOrders(pendingOrders as unknown as Order[]);

        if (orderHistoryResult.status === 'fulfilled') {
          historySucceeded = true;
          useAppStore.getState().setTrades(orderHistoryResult.value.trades);
          if (orderHistoryResult.value.warning) {
            historyError = orderHistoryResult.value.warning;
            console.warn('[History] Partially refreshed trade history:', historyError);
            window.dispatchEvent(new CustomEvent('rtx:trade-history-refresh-error', {
              detail: {
                login: resolvedLogin,
                partial: true,
                message: getErrorMessage(historyError, 'Some order history sources failed'),
              },
            }));
          }
        } else {
          historyError = orderHistoryResult.reason;
          console.error('[History] Failed to refresh trade history:', historyError);
          window.dispatchEvent(new CustomEvent('rtx:trade-history-refresh-error', {
            detail: {
              login: resolvedLogin,
              message: getErrorMessage(historyError, 'Failed to refresh order history'),
            },
          }));
        }
      } finally {
        window.dispatchEvent(new CustomEvent('rtx:trade-history-refresh-completed', {
          detail: {
            login: resolvedLogin,
            ok: historySucceeded,
            message: historyError ? getErrorMessage(historyError, 'Failed to refresh order history') : null,
          },
        }));
        if (refreshHistoryInFlightRef.current === request) {
          refreshHistoryInFlightRef.current = null;
          refreshHistoryInFlightLoginRef.current = null;
          const pendingLogin = refreshHistoryPendingLoginRef.current;
          refreshHistoryPendingLoginRef.current = null;
          if (pendingLogin) void refreshOrdersAndHistory(pendingLogin);
        }
      }
    })();

    refreshHistoryInFlightLoginRef.current = resolvedLogin;
    refreshHistoryInFlightRef.current = request;
    await request;
  }, [getLiveTradingLogin, isAuthenticatedRef, refreshAccountMetrics, setOrders]);

  // Post-trade refreshes. Each request joins its login's burst and re-arms the quiet timer;
  // the burst then runs the immediate refreshes above once. Non-trade callers (safety net,
  // stream recovery, startup) keep calling the immediate functions and read at once.
  const postTradeBurstsRef = useRef(new Map<number, PostTradeRefreshBurst>());
  const postTradeRunnersRef = useRef({
    refreshPositions,
    refreshOrdersAndHistory,
    getLiveTradingLogin,
    isAuthenticatedRef,
  });
  useEffect(() => {
    postTradeRunnersRef.current = { refreshPositions, refreshOrdersAndHistory, getLiveTradingLogin, isAuthenticatedRef };
  }, [getLiveTradingLogin, isAuthenticatedRef, refreshOrdersAndHistory, refreshPositions]);

  const runPostTradeBurst = useCallback((burst: PostTradeRefreshBurst): void => {
    const bursts = postTradeBurstsRef.current;
    if (bursts.get(burst.login) === burst) bursts.delete(burst.login);
    if (burst.timer !== null) {
      window.clearTimeout(burst.timer);
      burst.timer = null;
    }
    const runners = postTradeRunnersRef.current;
    // A burst for a login that is no longer live has nothing left to reconcile.
    const isLive = runners.isAuthenticatedRef.current && runners.getLiveTradingLogin() === burst.login;
    const reads: Promise<void>[] = [];
    if (isLive && burst.positions) reads.push(runners.refreshPositions(burst.login, burst.positions));
    // Positions start first: the orders+history read skips its own metrics read while a
    // positions read is in flight, so the burst issues one account-metrics read.
    if (isLive && burst.history) reads.push(runners.refreshOrdersAndHistory(burst.login));
    Promise.all(reads).then(burst.resolve, burst.reject);
  }, []);

  const requestPostTradeRefresh = useCallback((
    login: number,
    request: { positions?: RefreshPositionsOptions; history?: boolean },
  ): Promise<void> => {
    const bursts = postTradeBurstsRef.current;
    const burst = bursts.get(login) ?? createPostTradeRefreshBurst(login);
    bursts.set(login, burst);
    if (request.positions) burst.positions = mergePositionsOptions(burst.positions, request.positions);
    if (request.history) burst.history = true;
    if (burst.timer !== null) window.clearTimeout(burst.timer);
    const untilMaxWait = burst.startedAt + POST_TRADE_REFRESH_MAX_WAIT_MS - Date.now();
    const delayMs = Math.max(0, Math.min(POST_TRADE_REFRESH_COALESCE_MS, untilMaxWait));
    burst.timer = window.setTimeout(() => runPostTradeBurst(burst), delayMs);
    return burst.settled;
  }, [runPostTradeBurst]);

  const refreshPositionsAfterTrade = useCallback((
    login?: number,
    options: RefreshPositionsOptions = {},
  ): Promise<void> => {
    const requestedLogin = login || getLiveTradingLogin();
    if (!requestedLogin) return Promise.resolve();
    return requestPostTradeRefresh(requestedLogin, { positions: options });
  }, [getLiveTradingLogin, requestPostTradeRefresh]);

  const refreshOrdersAndHistoryAfterTrade = useCallback((login?: number): Promise<void> => {
    const resolvedLogin = login || getLiveTradingLogin();
    if (!resolvedLogin) return Promise.resolve();
    return requestPostTradeRefresh(resolvedLogin, { history: true });
  }, [getLiveTradingLogin, requestPostTradeRefresh]);

  const postTradeRefresh = useMemo<PostTradeRefresh>(() => ({
    refreshPositions: refreshPositionsAfterTrade,
    refreshOrdersAndHistory: refreshOrdersAndHistoryAfterTrade,
  }), [refreshOrdersAndHistoryAfterTrade, refreshPositionsAfterTrade]);

  // Unmount runs pending bursts now instead of dropping their final refresh.
  useEffect(() => {
    const bursts = postTradeBurstsRef.current;
    return () => {
      Array.from(bursts.values()).forEach((burst) => runPostTradeBurst(burst));
    };
  }, [runPostTradeBurst]);

  useEffect(() => {
    let refreshTimer: number | null = null;
    let pendingLogin: number | null = null;
    const schedulePositionSync = (delayMs: number) => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (getActiveBinaryTcpOrderCount() > 0) {
          schedulePositionSync(400);
          return;
        }
        refreshTimer = null;
        const nextLogin = pendingLogin;
        pendingLogin = null;
        if (nextLogin) void refreshPositionsAfterTrade(nextLogin, { allowWsCommit: true });
      }, delayMs);
    };
    const handleSync = (event: Event) => {
      const eventLogin = parsePositiveLogin(String((event as CustomEvent)?.detail?.login ?? ''));
      const requestedLogin = eventLogin || getLiveTradingLogin();
      if (!requestedLogin) return;
      pendingLogin = requestedLogin;
      schedulePositionSync(100);
    };
    window.addEventListener('rtx:force-refresh-positions', handleSync);
    return () => {
      window.removeEventListener('rtx:force-refresh-positions', handleSync);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [getLiveTradingLogin, refreshPositionsAfterTrade]);

  useEffect(() => {
    const handleHistoryRefreshRequest = (event: Event) => {
      if (!isAuthenticatedRef.current) return;
      const requestedLogin = parsePositiveLogin(String((event as CustomEvent)?.detail?.login ?? ''));
      const liveLogin = getLiveTradingLogin();
      if (!requestedLogin || !liveLogin || requestedLogin !== liveLogin) return;
      void refreshOrdersAndHistory(requestedLogin).catch((error) => {
        console.error('[History] Failed to refresh orders/history:', error);
      });
    };
    window.addEventListener('rtx:refresh-trade-history-requested', handleHistoryRefreshRequest);
    return () => window.removeEventListener('rtx:refresh-trade-history-requested', handleHistoryRefreshRequest);
  }, [getLiveTradingLogin, isAuthenticatedRef, refreshOrdersAndHistory]);

  // Order and close call sites outside hooks refresh History through this owner.
  // It is bound once per mount and reads the latest callbacks through a ref, so a
  // new callback identity never disposes fallbacks that are still pending.
  const historyOwnerLatestRef = useRef({ refreshOrdersAndHistory: refreshOrdersAndHistoryAfterTrade, getLiveTradingLogin });
  useEffect(() => {
    historyOwnerLatestRef.current = { refreshOrdersAndHistory: refreshOrdersAndHistoryAfterTrade, getLiveTradingLogin };
  }, [getLiveTradingLogin, refreshOrdersAndHistoryAfterTrade]);
  useEffect(() => bindDefaultHistoryFreshnessOwner(createHistoryFreshnessOwner(
    (login) => historyOwnerLatestRef.current.refreshOrdersAndHistory(login),
    (login) => isAuthenticatedRef.current && historyOwnerLatestRef.current.getLiveTradingLogin() === login,
  )), [isAuthenticatedRef]);

  return { refreshPositions, refreshOrdersAndHistory, postTradeRefresh };
};
