import { useCallback, useEffect, useRef, useState } from 'react';
import { getStoredAccountLogin, type TradeHistoryDataSet } from '../../../api/tradeGateway';
import { getTradeWebSocketClient } from '../../../api/tradeSocket';
import { TRADE_HISTORY_REFRESH_COMPLETED_EVENT, type TradeHistoryRefreshCompletedEventDetail } from '../../../contracts/terminalEvents';
import {
  getCommittedBrokerAccountSessionScope,
  getCommittedBrokerAccountSessionScopeKey,
  onCommittedBrokerAccountSessionScopeChange,
} from '../../../services/brokerSession';
import {
  loadTerminalHistory,
  peekTerminalHistory,
  subscribeTerminalHistoryRejectedUpdates,
} from '../../../services/terminalHistory';
import { useAppStore } from '../../../store/useAppStore';
import { EMPTY_HISTORY_DATA_SET } from './historyFilters';
import {
  loadBalanceHistory,
  normalizeHistoryBalanceRecord,
  type HistoryBalanceOperation,
} from './balanceHistory';

export type HistoryFetchOptions = {
  force?: boolean;
  background?: boolean;
  refresh?: boolean;
};

export type HistoryDataControllerOptions = {
  liveWithdrawalSync?: boolean;
};

const BALANCE_REALTIME_POLL_MS = 4_000;
const REALTIME_BALANCE_ENTITIES = new Set([
  '*',
  'account',
  'accounts',
  'balance',
  'balances',
  'deal',
  'deals',
  'deposit',
  'deposits',
  'ledger',
  'transaction',
  'transactions',
  'withdraw',
  'withdrawal',
  'withdrawals',
]);

const getCurrentSessionScopeKey = (): string => getCommittedBrokerAccountSessionScopeKey(
  getCommittedBrokerAccountSessionScope(),
);

const readFiniteBalance = (account: { balance?: unknown } | null | undefined): number | null => {
  const balance = Number(account?.balance);
  return Number.isFinite(balance) ? balance : null;
};

const extractSocketBalanceOperations = (
  message: Record<string, unknown>,
  login: number,
): HistoryBalanceOperation[] => {
  const results: HistoryBalanceOperation[] = [];
  const data = message.data && typeof message.data === 'object' ? message.data : null;
  const candidates: unknown[] = [message, data];
  if (Array.isArray(message.data)) candidates.push(...message.data);
  if (data && !Array.isArray(data)) {
    const dataRecord = data as Record<string, unknown>;
    candidates.push(dataRecord.operation, dataRecord.transaction, dataRecord.withdrawal, dataRecord.data);
    if (Array.isArray(dataRecord.operations)) candidates.push(...dataRecord.operations);
    if (Array.isArray(dataRecord.history)) candidates.push(...dataRecord.history);
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeHistoryBalanceRecord(candidate, login);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    results.push(normalized);
  }
  return results;
};

const upsertBalanceOperations = (
  existing: HistoryBalanceOperation[] | null,
  incoming: HistoryBalanceOperation[],
): HistoryBalanceOperation[] => {
  const next = existing ? [...existing] : [];
  for (const op of incoming) {
    const idx = next.findIndex((item) => item.id === op.id);
    if (idx >= 0) next[idx] = { ...next[idx], ...op };
    else next.unshift(op);
  }
  return next;
};

export const useHistoryDataController = (
  activeLogin: number,
  activeScopeKey: string,
  controllerOptions: HistoryDataControllerOptions = {},
): {
  historyData: TradeHistoryDataSet;
  historyLoadedAt: number;
  loading: boolean;
  balanceLoading: boolean;
  ordersPending: boolean;
  error: string | null;
  financialDealsAvailable: boolean;
  balanceHistory: HistoryBalanceOperation[] | null;
  balanceHistoryError: string | null;
  sessionResetVersion: number;
  fetchHistory: (options?: HistoryFetchOptions) => Promise<void>;
  refreshBalanceHistory: (options?: { background?: boolean }) => Promise<void>;
} => {
  const liveWithdrawalSync = Boolean(controllerOptions.liveWithdrawalSync);
  const cachedHistory = peekTerminalHistory(activeLogin, activeScopeKey);
  const [historyData, setHistoryData] = useState<TradeHistoryDataSet>(
    () => cachedHistory?.data ?? EMPTY_HISTORY_DATA_SET,
  );
  const [historyLoadedAt, setHistoryLoadedAt] = useState(Date.now);
  const [loading, setLoading] = useState(() => !cachedHistory);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [ordersPending, setOrdersPending] = useState(() => cachedHistory?.ordersPending ?? false);
  const [error, setError] = useState<string | null>(null);
  const [sessionResetVersion, setSessionResetVersion] = useState(0);
  const requestScope = `${activeScopeKey}\0${activeLogin}`;
  const [financialScope, setFinancialScope] = useState<string | null>(() => cachedHistory ? requestScope : null);
  const [ledger, setLedger] = useState<{
    scope: string; operations: HistoryBalanceOperation[] | null; error: string | null;
  } | null>(null);
  const requestSerialRef = useRef(0);
  const ledgerSerialRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSerialRef.current += 1;
      ledgerSerialRef.current += 1;
    };
  }, []);

  const refreshBalanceHistory = useCallback(async (options?: { background?: boolean }) => {
    const ledgerSerial = ++ledgerSerialRef.current;
    const login = Number.isFinite(activeLogin) && activeLogin > 0 ? activeLogin : null;
    if (!login) return;

    const targetScope = `${activeScopeKey}\0${login}`;
    const stillCurrent = () => (
      mountedRef.current
      && ledgerSerial === ledgerSerialRef.current
      && Number.parseInt(String(useAppStore.getState().accountId ?? getStoredAccountLogin() ?? ''), 10) === login
      && getCurrentSessionScopeKey() === activeScopeKey
    );

    if (!options?.background) setBalanceLoading(true);
    try {
      const operations = await loadBalanceHistory(login, stillCurrent);
      if (!stillCurrent()) return;
      setLedger({ scope: targetScope, operations, error: null });
      setHistoryLoadedAt((prev) => Math.max(prev, Date.now()));
    } catch (caught: unknown) {
      if (!stillCurrent()) return;
      const message = caught instanceof Error ? caught.message : 'Balance history unavailable';
      setLedger((prev) => {
        if (options?.background && prev?.scope === targetScope && prev.operations !== null) {
          return { ...prev, error: message };
        }
        return { scope: targetScope, operations: null, error: message };
      });
    } finally {
      if (stillCurrent() && !options?.background) setBalanceLoading(false);
    }
  }, [activeLogin, activeScopeKey]);

  const fetchHistory = useCallback(async (options?: HistoryFetchOptions) => {
    const requestSerial = ++requestSerialRef.current;
    const ledgerSerial = ++ledgerSerialRef.current;
    const login = Number.isFinite(activeLogin) && activeLogin > 0 ? activeLogin : null;
    if (!login) {
      setError('No account login found');
      if (!options?.background) setLoading(false);
      return;
    }

    if (!options?.background) setLoading(true);
    setError(null);
    const stillCurrent = () => (
      mountedRef.current
      && requestSerial === requestSerialRef.current
      && Number.parseInt(String(useAppStore.getState().accountId ?? getStoredAccountLogin() ?? ''), 10) === login
      && getCurrentSessionScopeKey() === activeScopeKey
    );
    const stillCurrentLedger = () => (
      mountedRef.current
      && ledgerSerial === ledgerSerialRef.current
      && Number.parseInt(String(useAppStore.getState().accountId ?? getStoredAccountLogin() ?? ''), 10) === login
      && getCurrentSessionScopeKey() === activeScopeKey
    );

    // A slow/unavailable ledger must not prevent the trade records from appearing.
    void loadBalanceHistory(login, stillCurrentLedger).then(operations => {
      if (stillCurrentLedger()) {
        setLedger({ scope: `${activeScopeKey}\0${login}`, operations, error: null });
        setHistoryLoadedAt((prev) => Math.max(prev, Date.now()));
      }
    }).catch((caught: unknown) => {
      if (stillCurrentLedger()) setLedger({
        scope: `${activeScopeKey}\0${login}`,
        operations: null,
        error: caught instanceof Error ? caught.message : 'Balance history unavailable',
      });
    });

    try {
      const data = await loadTerminalHistory(login, activeScopeKey, {
        force: options?.force,
        refresh: options?.refresh,
        onUpdate: (next, pending) => {
          if (!stillCurrent()) return;
          setHistoryData(next);
          setHistoryLoadedAt(Date.now());
          setFinancialScope(`${activeScopeKey}\0${login}`);
          setOrdersPending(pending);
          if (!pending || next.positions.length > 0 || next.deals.length > 0 || next.orders.length > 0) {
            setLoading(false);
          }
        },
      });
      if (!stillCurrent()) return;
      setHistoryData(data);
      setHistoryLoadedAt(Date.now());
      setFinancialScope(`${activeScopeKey}\0${login}`);
      setOrdersPending(false);
    } catch (caught: unknown) {
      if (!stillCurrent()) return;
      console.warn('[History] Failed to load:', caught);
      setOrdersPending(false);
      if (!options?.background) {
        setError(caught instanceof Error ? caught.message : 'Failed to load history');
      }
      setFinancialScope(null);
    } finally {
      if (stillCurrent() && !options?.background) setLoading(false);
    }
  }, [activeLogin, activeScopeKey]);

  useEffect(() => {
    const cached = peekTerminalHistory(activeLogin, activeScopeKey);
    if (cached) {
      setHistoryData(cached.data);
      setOrdersPending(cached.ordersPending);
      setLoading(false);
      setFinancialScope(requestScope);
    } else {
      setHistoryData(EMPTY_HISTORY_DATA_SET);
      setOrdersPending(false);
      setFinancialScope(null);
    }
    setLedger(null);
    void fetchHistory({ background: Boolean(cached) });
  }, [activeLogin, activeScopeKey, fetchHistory, requestScope]);

  useEffect(() => {
    const handleCompleted = (event: Event) => {
      const detail = (event as CustomEvent<TradeHistoryRefreshCompletedEventDetail>).detail;
      if (!detail || detail.ok === false || detail.login !== activeLogin) return;
      void fetchHistory({ background: true, refresh: true });
    };
    window.addEventListener(TRADE_HISTORY_REFRESH_COMPLETED_EVENT, handleCompleted);
    const unsubscribeRejected = subscribeTerminalHistoryRejectedUpdates((login, updatedData) => {
      if (login !== activeLogin) return;
      setHistoryData((prev) => {
        const seenClientIds = new Set(
          prev.orders
            .map((order) => order.clientOrderId)
            .filter((id): id is string => Boolean(id)),
        );
        const addedOrders = updatedData.orders.filter(
          (order) => order.clientOrderId && !seenClientIds.has(order.clientOrderId),
        );
        if (addedOrders.length === 0) return updatedData;
        return {
          ...prev,
          orders: [...addedOrders, ...prev.orders],
        };
      });
      setHistoryLoadedAt(Date.now());
    });
    return () => {
      window.removeEventListener(TRADE_HISTORY_REFRESH_COMPLETED_EVENT, handleCompleted);
      unsubscribeRejected();
    };
  }, [activeLogin, activeScopeKey, fetchHistory]);

  useEffect(() => {
    const login = Number.isFinite(activeLogin) && activeLogin > 0 ? activeLogin : null;
    if (!login) return undefined;

    let balanceRefreshTimer: number | null = null;
    let lastObservedBalance = readFiniteBalance(useAppStore.getState().account);

    const scheduleLedgerRefresh = (delayMs = 150) => {
      if (balanceRefreshTimer !== null) window.clearTimeout(balanceRefreshTimer);
      balanceRefreshTimer = window.setTimeout(() => {
        balanceRefreshTimer = null;
        void refreshBalanceHistory({ background: true });
      }, delayMs);
    };

    const unsubscribeStore = useAppStore.subscribe((state) => {
      const storeLogin = Number.parseInt(String(state.accountId ?? getStoredAccountLogin() ?? ''), 10);
      if (storeLogin !== login || getCurrentSessionScopeKey() !== activeScopeKey) return;
      const nextBalance = readFiniteBalance(state.account);
      if (nextBalance === null) return;
      if (lastObservedBalance !== null && nextBalance !== lastObservedBalance) {
        lastObservedBalance = nextBalance;
        scheduleLedgerRefresh(150);
        return;
      }
      lastObservedBalance = nextBalance;
    });

    const socketClient = typeof getTradeWebSocketClient === 'function' ? getTradeWebSocketClient() : null;
    const unsubscribeSocket = typeof socketClient?.subscribe === 'function'
      ? socketClient.subscribe('*', (rawMessage) => {
      if (!rawMessage || typeof rawMessage !== 'object') return;
      const msg = rawMessage as Record<string, unknown>;
      const channel = String(msg.channel ?? '').toLowerCase();
      if (
        channel.startsWith('ticks.')
        || channel.startsWith('quotes.')
        || channel.startsWith('candles.')
        || channel.startsWith('depth.')
        || channel === 'prices'
      ) {
        return;
      }
      const msgLogin = Number(msg.account_login ?? msg.login ?? (channel.includes('.') ? channel.slice(channel.lastIndexOf('.') + 1) : NaN));
      if (Number.isFinite(msgLogin) && msgLogin > 0 && msgLogin !== login) return;

      const dataObj = msg.data && typeof msg.data === 'object' ? msg.data as Record<string, unknown> : null;
      const msgType = String(msg.type ?? msg.event ?? dataObj?.type ?? dataObj?.event ?? '').toLowerCase();
      if (msgType === 'metrics_update' || msgType === 'account_metrics') return;

      const directOps = extractSocketBalanceOperations(msg, login);
      if (directOps.length > 0) {
        setLedger((prev) => {
          const base = prev?.scope === requestScope ? prev.operations : null;
          return {
            scope: requestScope,
            operations: upsertBalanceOperations(base, directOps),
            error: null,
          };
        });
        setHistoryLoadedAt((prev) => Math.max(prev, Date.now()));
        scheduleLedgerRefresh(200);
        return;
      }

      const isCashOrDealChannel = (
        channel.startsWith('deals.')
        || channel.startsWith('state.')
        || channel.includes('balance')
        || channel.includes('withdraw')
        || channel.includes('deposit')
        || channel.includes('ledger')
      );
      const isCashOrDealType = (
        msgType.includes('withdraw')
        || msgType.includes('deposit')
        || msgType.includes('balance')
        || msgType.includes('ledger')
        || msgType.includes('transaction')
        || msgType.includes('deal')
      );
      if (isCashOrDealChannel || isCashOrDealType) {
        scheduleLedgerRefresh(200);
      }
    })
      : () => undefined;

    const handleStateChanged = (event: Event) => {
      const entities = ((event as CustomEvent<{ entities?: unknown[] }>).detail?.entities ?? [])
        .map((item) => String(item ?? '').toLowerCase());
      if (entities.length === 0 || entities.some((entity) => REALTIME_BALANCE_ENTITIES.has(entity))) {
        scheduleLedgerRefresh(150);
      }
    };
    const handleStreamRecovered = () => scheduleLedgerRefresh(150);
    const handleBalanceUpdated = () => scheduleLedgerRefresh(50);

    window.addEventListener('rtx:state-changed', handleStateChanged);
    window.addEventListener('rtx:trade-stream-recovered', handleStreamRecovered);
    window.addEventListener('rtx:balance-history-updated', handleBalanceUpdated);

    return () => {
      if (balanceRefreshTimer !== null) window.clearTimeout(balanceRefreshTimer);
      unsubscribeStore();
      unsubscribeSocket();
      window.removeEventListener('rtx:state-changed', handleStateChanged);
      window.removeEventListener('rtx:trade-stream-recovered', handleStreamRecovered);
      window.removeEventListener('rtx:balance-history-updated', handleBalanceUpdated);
    };
  }, [activeLogin, activeScopeKey, refreshBalanceHistory, requestScope]);

  useEffect(() => {
    if (!liveWithdrawalSync) return undefined;
    const login = Number.isFinite(activeLogin) && activeLogin > 0 ? activeLogin : null;
    if (!login) return undefined;

    const initialTimer = window.setTimeout(() => {
      void refreshBalanceHistory({ background: true });
    }, 0);
    const intervalId = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refreshBalanceHistory({ background: true });
    }, BALANCE_REALTIME_POLL_MS);

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refreshBalanceHistory({ background: true });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeLogin, liveWithdrawalSync, refreshBalanceHistory]);

  useEffect(() => onCommittedBrokerAccountSessionScopeChange(() => {
    requestSerialRef.current += 1;
    ledgerSerialRef.current += 1;
    setHistoryData(EMPTY_HISTORY_DATA_SET);
    setOrdersPending(false);
    setBalanceLoading(false);
    setError(null);
    setFinancialScope(null);
    setLedger(null);
    setSessionResetVersion(version => version + 1);
  }), []);

  return {
    historyData,
    historyLoadedAt,
    loading,
    balanceLoading,
    ordersPending,
    error,
    financialDealsAvailable: financialScope === requestScope && !historyData.errors.deals,
    balanceHistory: ledger?.scope === requestScope ? ledger.operations : null,
    balanceHistoryError: ledger?.scope === requestScope ? ledger.error : null,
    sessionResetVersion,
    fetchHistory,
    refreshBalanceHistory,
  };
};
