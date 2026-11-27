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
import { TRADE_HISTORY_REFRESH_COMPLETED_EVENT } from '../../contracts/terminalEvents';
import {
  beginTradeHistoryRefresh,
  invalidateTerminalHistory,
  isHistoryTabMounted,
} from '../../services/terminalHistory';
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

/**
 * Minimum spacing between two order-history reads for one login on the post-trade and
 * 'rtx:refresh-trade-history-requested' paths. The first request runs at once; requests that
 * arrive inside the window collapse into one trailing read when the window ends, so the final
 * state is always fetched but a burst of closes never becomes a polling storm.
 */
export const HISTORY_REFRESH_MIN_INTERVAL_MS = 2000;

/** skipHistory: refresh pending orders only; the closed-trade history read is left to the 2 s gate. */
interface RefreshOrdersOptions {
  skipHistory?: boolean;
  /** Internal orders-only read while the history gate cools down: no cache invalidation. */
  quiet?: boolean;
  /** Read only the newest rows and merge them into the loaded history. Omit for the full load. */
  historyLimit?: number;
  /** Force cache invalidation and a full history reload that replaces store.trades (setTrades). */
  full?: boolean;
}

/** Rows read per source by post-trade and event-driven history refreshes. */
export const BACKGROUND_HISTORY_LIMIT = 100;

interface HistoryRefreshGate {
  /** Retries left after a failed read; one retry per failure streak. */
  retriesLeft: number;
  /** A limited read could not verify a new close: the next gated read is the full 500-row one. */
  wantsFull: boolean;
  lastRunAt: number;
  timer: number | null;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

interface PostTradeRefresh {
  refreshPositions: (login?: number, options?: RefreshPositionsOptions) => Promise<void>;
  refreshOrdersAndHistory: (login?: number, options?: RefreshOrdersOptions) => Promise<void>;
}

interface PostTradeRefreshBurst {
  login: number;
  /** Merged options of the positions requests in the burst; null when there were none. */
  positions: RefreshPositionsOptions | null;
  history: boolean;
  /** Require an unlimited history read that replaces store.trades instead of merging. */
  fullHistory: boolean;
  /** Orders and metrics only (no closed-history read): fills that only opened a position. */
  orders: boolean;
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
  return { login, positions: null, history: false, fullHistory: false, orders: false, timer: null, startedAt: Date.now(), settled, resolve, reject };
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
  refreshOrdersAndHistory: (login?: number, options?: RefreshOrdersOptions) => Promise<void>;
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
  const refreshHistoryPendingNeedsHistoryRef = useRef(false);
  const refreshHistoryPendingFullRef = useRef(false);
  const refreshHistoryFollowUpRef = useRef<Promise<void> | null>(null);
  // Ordering of history results per login: a read that started before a newer result was applied
  // never overwrites it (its rows only fill gaps).
  const historyReadCounterRef = useRef(0);
  const historyAppliedSeqRef = useRef(new Map<number, number>());
  // Outcome of the last closed-history read per login (false = failed), read by the gate.
  const historyOutcomeRef = useRef(new Map<number, boolean>());
  const requestHistoryReadRef = useRef<(login: number, full: boolean) => void>(() => undefined);
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

  // Throttled (2 s, leading + trailing) refresh request for a mounted History tab.
  const tabRefreshGateRef = useRef(new Map<number, { last: number; timer: number | null }>());
  const requestHistoryTabRefresh = useCallback((login: number): void => {
    const gates = tabRefreshGateRef.current;
    let gate = gates.get(login);
    if (!gate) {
      gate = { last: Number.NEGATIVE_INFINITY, timer: null };
      gates.set(login, gate);
    }
    const activeGate = gate;
    const dispatchRefresh = () => {
      activeGate.timer = null;
      activeGate.last = Date.now();
      window.dispatchEvent(new CustomEvent(TRADE_HISTORY_REFRESH_COMPLETED_EVENT, {
        detail: { login, ok: true, message: null },
      }));
    };
    if (activeGate.timer !== null) return;
    const wait = activeGate.last + HISTORY_REFRESH_MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) dispatchRefresh();
    else activeGate.timer = window.setTimeout(dispatchRefresh, wait);
  }, []);
  const refreshOrdersAndHistory = useCallback(async (login?: number, options?: RefreshOrdersOptions): Promise<void> => {
    const skipHistory = options?.skipHistory === true;
    const full = options?.full === true;
    const historyLimit = full ? undefined : options?.historyLimit;
    const resolvedLogin = login || getLiveTradingLogin();
    if (!resolvedLogin) return;
    if (skipHistory && options?.quiet !== true) {
      // Opens, placed and cancelled pending orders: no history read, but the History tab and the
      // request cache must not keep a snapshot without the new deals/orders.
      invalidateTerminalHistory();
      // A mounted History tab does its own single refresh (its data-set read) when told; the
      // controller adds no closed-history read of its own for an open.
      if (isHistoryTabMounted()) requestHistoryTabRefresh(resolvedLogin);
    }
    if (!arePositionsReadsInFlight()) {
      void refreshAccountMetrics(resolvedLogin);
    }
    if (refreshHistoryInFlightRef.current && refreshHistoryInFlightLoginRef.current === resolvedLogin) {
      refreshHistoryPendingLoginRef.current = resolvedLogin;
      if (!skipHistory) {
        refreshHistoryPendingNeedsHistoryRef.current = true;
        if (historyLimit === undefined) refreshHistoryPendingFullRef.current = true;
      }
      await refreshHistoryInFlightRef.current;
      // The follow-up read that carries this call's flags runs right after the in-flight one:
      // wait for it too, so the caller (and the gate's retry check) sees its real outcome.
      const followUp = refreshHistoryFollowUpRef.current;
      if (followUp) await followUp.catch(() => undefined);
      return;
    }

    if (!skipHistory) {
      if (full) invalidateTerminalHistory();
      beginTradeHistoryRefresh();
      window.dispatchEvent(new CustomEvent('rtx:trade-history-refresh-started', {
        detail: { login: resolvedLogin },
      }));
    }
    const readSeq = ++historyReadCounterRef.current;
    const request = (async () => {
      let historyError: unknown = null;
      let historySucceeded = false;
      try {
        const [pendingOrdersResult, orderHistoryResult] = await Promise.allSettled([
          api.orders.getPendingOrders(resolvedLogin),
          skipHistory
            ? Promise.resolve(null)
            : (historyLimit === undefined ? fetchOrderHistory(resolvedLogin) : fetchOrderHistory(resolvedLogin, { limit: historyLimit })),
        ]);
        if (!isAuthenticatedRef.current || getLiveTradingLogin() !== resolvedLogin) return;

        const pendingOrders = pendingOrdersResult.status === 'fulfilled'
          ? pendingOrdersResult.value
          : [];
        setOrders?.(pendingOrders);
        useAppStore.getState().setOrders(pendingOrders as unknown as Order[]);

        if (skipHistory) {
          // Orders only: the history read belongs to the 2 s gate.
        } else if (orderHistoryResult.status === 'fulfilled' && orderHistoryResult.value) {
          historySucceeded = true;
          const appliedSeqs = historyAppliedSeqRef.current;
          const stale = readSeq < (appliedSeqs.get(resolvedLogin) ?? 0);
          if (!stale) appliedSeqs.set(resolvedLogin, readSeq);
          const store = useAppStore.getState();
          if (historyLimit === undefined && !stale) {
            store.setTrades(orderHistoryResult.value.trades);
          } else {
            const needsFullRead = store.mergeTrades(orderHistoryResult.value.trades, {
              unverified: orderHistoryResult.value.unverified,
              preferExisting: stale,
            });
            if (needsFullRead && historyLimit !== undefined) requestHistoryReadRef.current(resolvedLogin, true);
          }
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
        } else if (orderHistoryResult.status === 'rejected') {
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
        if (!skipHistory) {
          historyOutcomeRef.current.set(resolvedLogin, historySucceeded);
          window.dispatchEvent(new CustomEvent('rtx:trade-history-refresh-completed', {
            detail: {
              login: resolvedLogin,
              ok: historySucceeded,
              message: historyError ? getErrorMessage(historyError, 'Failed to refresh order history') : null,
            },
          }));
        }
        if (refreshHistoryInFlightRef.current === request) {
          refreshHistoryInFlightRef.current = null;
          refreshHistoryInFlightLoginRef.current = null;
          const pendingLogin = refreshHistoryPendingLoginRef.current;
          refreshHistoryPendingLoginRef.current = null;
          const pendingNeedsHistory = refreshHistoryPendingNeedsHistoryRef.current;
          const pendingFull = refreshHistoryPendingFullRef.current;
          refreshHistoryPendingNeedsHistoryRef.current = false;
          refreshHistoryPendingFullRef.current = false;
          if (pendingLogin) {
            const followUp = refreshOrdersAndHistory(pendingLogin, {
              skipHistory: !pendingNeedsHistory,
              quiet: true,
              ...(pendingNeedsHistory && pendingFull ? { full: true } : {}),
              historyLimit: pendingNeedsHistory && !pendingFull ? (historyLimit ?? BACKGROUND_HISTORY_LIMIT) : undefined,
            });
            refreshHistoryFollowUpRef.current = followUp;
            void followUp.then(
              () => undefined,
              (error) => console.error('[History] Failed to refresh orders/history:', error),
            ).finally(() => {
              if (refreshHistoryFollowUpRef.current === followUp) refreshHistoryFollowUpRef.current = null;
            });
          }
        }
      }
    })();

    refreshHistoryInFlightLoginRef.current = resolvedLogin;
    refreshHistoryInFlightRef.current = request;
    await request;
  }, [getLiveTradingLogin, isAuthenticatedRef, refreshAccountMetrics, requestHistoryTabRefresh, setOrders]);

  // Post-trade refreshes. Each request joins its login's burst and re-arms the quiet timer;
  // the burst then runs the immediate refreshes above once. Non-trade callers (safety net,
  // stream recovery, startup) keep calling the immediate functions and read at once.
  const postTradeBurstsRef = useRef(new Map<number, PostTradeRefreshBurst>());
  const historyGatesRef = useRef(new Map<number, HistoryRefreshGate>());
  const postTradeRunnersRef = useRef({
    refreshPositions,
    refreshOrdersAndHistory,
    getLiveTradingLogin,
    isAuthenticatedRef,
  });
  useEffect(() => {
    postTradeRunnersRef.current = { refreshPositions, refreshOrdersAndHistory, getLiveTradingLogin, isAuthenticatedRef };
  }, [getLiveTradingLogin, isAuthenticatedRef, refreshOrdersAndHistory, refreshPositions]);

  // Per-login 2 s gate on closed-history reads (post-trade, close events, stream close frames).
  // The first read runs at once with limit 100; later requests collapse into one trailing read.
  // After a limited read that could not verify a new close, the next gated read is a full one.
  const gatedHistoryRead = useCallback((login: number, options?: { full?: boolean }): Promise<void> => {
    const gates = historyGatesRef.current;
    let gate = gates.get(login);
    if (!gate) {
      gate = { retriesLeft: 1, wantsFull: false, lastRunAt: Number.NEGATIVE_INFINITY, timer: null, waiters: [] };
      gates.set(login, gate);
    }
    if (options?.full) gate.wantsFull = true;
    const activeGate = gate;
    const runOptions = (): RefreshOrdersOptions | undefined => {
      const full = activeGate.wantsFull;
      activeGate.wantsFull = false;
      return full ? { full: true } : { historyLimit: BACKGROUND_HISTORY_LIMIT };
    };
    const runners = postTradeRunnersRef.current;
    // A read whose history part failed is retried once through the gate, keeping its full flag.
    const runRead = (read: typeof refreshOrdersAndHistory, readOptions: RefreshOrdersOptions | undefined): Promise<void> => {
      const wasFull = readOptions === undefined || readOptions.full === true;
      historyOutcomeRef.current.delete(login);
      return read(login, readOptions).then(() => {
        if (historyOutcomeRef.current.get(login) === false) {
          if (activeGate.retriesLeft > 0) {
            activeGate.retriesLeft -= 1;
            activeGate.wantsFull = activeGate.wantsFull || wasFull;
            requestHistoryReadRef.current(login, wasFull);
          }
        } else if (historyOutcomeRef.current.get(login) === true) {
          activeGate.retriesLeft = 1;
        }
      });
    };
    const now = Date.now();
    if (gate.timer === null && now - gate.lastRunAt >= HISTORY_REFRESH_MIN_INTERVAL_MS) {
      gate.lastRunAt = now;
      return runRead(runners.refreshOrdersAndHistory, runOptions());
    }
    const trailing = new Promise<void>((resolve, reject) => activeGate.waiters.push({ resolve, reject }));
    runners.refreshOrdersAndHistory(login, { skipHistory: true, quiet: true }).catch((error) => {
      console.error('[History] Failed to refresh orders/history:', error);
    });
    if (activeGate.timer === null) {
      activeGate.timer = window.setTimeout(() => {
        activeGate.timer = null;
        activeGate.lastRunAt = Date.now();
        const waiters = activeGate.waiters;
        activeGate.waiters = [];
        const current = postTradeRunnersRef.current;
        if (!current.isAuthenticatedRef.current || current.getLiveTradingLogin() !== login) {
          waiters.forEach((w) => w.resolve());
          return;
        }
        runRead(current.refreshOrdersAndHistory, runOptions()).then(
          () => waiters.forEach((w) => w.resolve()),
          (error) => waiters.forEach((w) => w.reject(error)),
        );
      }, Math.max(0, activeGate.lastRunAt + HISTORY_REFRESH_MIN_INTERVAL_MS - now));
    }
    return trailing;
  }, []);

  useEffect(() => {
    requestHistoryReadRef.current = (login: number, full: boolean) => {
      const gates = historyGatesRef.current;
      const existing = gates.get(login);
      if (existing) existing.wantsFull = existing.wantsFull || full;
      else gates.set(login, { retriesLeft: 1, wantsFull: full, lastRunAt: Number.NEGATIVE_INFINITY, timer: null, waiters: [] });
      void gatedHistoryRead(login).catch((error) => {
        console.error('[History] Failed to refresh orders/history:', error);
      });
    };
  }, [gatedHistoryRead]);

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
    if (isLive && burst.history) reads.push(gatedHistoryRead(burst.login, burst.fullHistory ? { full: true } : undefined));
    else if (isLive && burst.orders) reads.push(runners.refreshOrdersAndHistory(burst.login, { skipHistory: true }));
    Promise.all(reads).then(burst.resolve, burst.reject);
  }, [gatedHistoryRead]);

  const requestPostTradeRefresh = useCallback((
    login: number,
    request: { positions?: RefreshPositionsOptions; history?: boolean; fullHistory?: boolean; orders?: boolean },
  ): Promise<void> => {
    const bursts = postTradeBurstsRef.current;
    const burst = bursts.get(login) ?? createPostTradeRefreshBurst(login);
    bursts.set(login, burst);
    if (request.positions) burst.positions = mergePositionsOptions(burst.positions, request.positions);
    if (request.history) burst.history = true;
    if (request.fullHistory) {
      burst.history = true;
      burst.fullHistory = true;
    }
    if (request.orders) burst.orders = true;
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

  const refreshOrdersAndHistoryAfterTrade = useCallback((login?: number, options?: RefreshOrdersOptions): Promise<void> => {
    const resolvedLogin = login || getLiveTradingLogin();
    if (!resolvedLogin) return Promise.resolve();
    if (options?.full) {
      invalidateTerminalHistory();
      return requestPostTradeRefresh(resolvedLogin, { history: true, fullHistory: true });
    }
    // A fill that only opened a position cannot change closed history: refresh orders/metrics only.
    return requestPostTradeRefresh(resolvedLogin, options?.skipHistory ? { orders: true } : { history: true });
  }, [getLiveTradingLogin, requestPostTradeRefresh]);

  const postTradeRefresh = useMemo<PostTradeRefresh>(() => ({
    refreshPositions: refreshPositionsAfterTrade,
    refreshOrdersAndHistory: refreshOrdersAndHistoryAfterTrade,
  }), [refreshOrdersAndHistoryAfterTrade, refreshPositionsAfterTrade]);

  // Unmount runs pending bursts now instead of dropping their final refresh.
  useEffect(() => {
    const bursts = postTradeBurstsRef.current;
    const historyGates = historyGatesRef.current;
    const tabRefreshGates = tabRefreshGateRef.current;
    return () => {
      Array.from(bursts.values()).forEach((burst) => runPostTradeBurst(burst));
      historyGates.forEach((gate) => {
        if (gate.timer !== null) window.clearTimeout(gate.timer);
        gate.timer = null;
        gate.waiters.forEach((w) => w.resolve());
        gate.waiters = [];
      });
      historyGates.clear();
      tabRefreshGates.forEach((gate) => {
        if (gate.timer !== null) window.clearTimeout(gate.timer);
        gate.timer = null;
      });
      tabRefreshGates.clear();
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
      const detail = (event as CustomEvent<{ login?: unknown; full?: unknown }>)?.detail;
      const requestedLogin = parsePositiveLogin(String(detail?.login ?? ''));
      const liveLogin = getLiveTradingLogin();
      if (!requestedLogin || !liveLogin || requestedLogin !== liveLogin) return;
      // Debounced post-trade burst plus the per-login 2 s history gate: a burst of requests
      // collapses into at most one read per window, with a trailing read.
      void refreshOrdersAndHistoryAfterTrade(
        requestedLogin,
        detail?.full === true ? { full: true } : undefined,
      ).catch((error) => {
        console.error('[History] Failed to refresh orders/history:', error);
      });
    };
    window.addEventListener('rtx:refresh-trade-history-requested', handleHistoryRefreshRequest);
    return () => window.removeEventListener('rtx:refresh-trade-history-requested', handleHistoryRefreshRequest);
  }, [getLiveTradingLogin, isAuthenticatedRef, refreshOrdersAndHistoryAfterTrade]);

  useEffect(() => {
    const handleStateChanged = (event: Event) => {
      if (!isAuthenticatedRef.current) return;
      const detail = (event as CustomEvent<{
        entities?: unknown;
        login?: unknown;
        historyPurgeScheduled?: unknown;
      }>)?.detail;
      if (detail?.historyPurgeScheduled === true) return;
      const entities = Array.isArray(detail?.entities)
        ? detail.entities.map((item) => String(item ?? '').trim().toLowerCase())
        : [];
      if (!entities.includes('history')) return;
      const liveLogin = getLiveTradingLogin();
      if (!liveLogin) return;
      if (detail?.login !== undefined && detail.login !== null && detail.login !== '') {
        const eventLogin = parsePositiveLogin(String(detail.login));
        if (!eventLogin || eventLogin !== liveLogin) return;
      }
      invalidateTerminalHistory();
      void refreshOrdersAndHistoryAfterTrade(liveLogin, { full: true }).catch((error) => {
        console.error('[History] Failed to refresh orders/history:', error);
      });
    };
    window.addEventListener('rtx:state-changed', handleStateChanged);
    return () => window.removeEventListener('rtx:state-changed', handleStateChanged);
  }, [getLiveTradingLogin, isAuthenticatedRef, refreshOrdersAndHistoryAfterTrade]);

  // Order and close call sites outside hooks refresh History through this owner.
  // It is bound once per mount and reads the latest callbacks through a ref, so a
  // new callback identity never disposes fallbacks that are still pending.
  const historyOwnerLatestRef = useRef({ refreshOrdersAndHistory: refreshOrdersAndHistoryAfterTrade, getLiveTradingLogin });
  useEffect(() => {
    historyOwnerLatestRef.current = { refreshOrdersAndHistory: refreshOrdersAndHistoryAfterTrade, getLiveTradingLogin };
  }, [getLiveTradingLogin, refreshOrdersAndHistoryAfterTrade]);
  useEffect(() => bindDefaultHistoryFreshnessOwner(createHistoryFreshnessOwner(
    (login, options) => historyOwnerLatestRef.current.refreshOrdersAndHistory(login, options),
    (login) => isAuthenticatedRef.current && historyOwnerLatestRef.current.getLiveTradingLogin() === login,
  )), [isAuthenticatedRef]);

  return { refreshPositions, refreshOrdersAndHistory, postTradeRefresh };
};
