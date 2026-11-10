import {
    clearTradeHistoryRequestCache,
    tradeGatewayApi,
    type TradeHistoryDataSet,
} from '../api/tradeGateway';
import type { Trade } from '../store/useAppStore';
import {
    MARKET_ORDER_PLACEMENT_STATE_EVENT,
    type MarketOrderPlacementStateDetail,
} from './marketOrderPlacementEvents';

type HistoryListener = (data: TradeHistoryDataSet, ordersPending: boolean) => void;
type RejectedHistoryUpdateListener = (login: number, data: TradeHistoryDataSet) => void;

type HistoryCacheEntry = {
    login: number;
    scopeKey: string;
    data: TradeHistoryDataSet;
    ordersPending: boolean;
};

type HistoryFlight = {
    generation: number;
    serial: number;
    promise: Promise<TradeHistoryDataSet>;
    listeners: Set<HistoryListener>;
};

let generation = 0;
let publishSerial = 0;
let primed = false;
let cache: HistoryCacheEntry | null = null;
const flights = new Map<string, HistoryFlight>();
const pendingPlacementSnapshots = new Map<string, Record<string, unknown>>();
const rejectedPlacementHistory = new Map<number, Trade[]>();
const rejectedUpdateListeners = new Set<RejectedHistoryUpdateListener>();
let placementListenerBound = false;

const historyRequestKey = (login: number, scopeKey: string): string => `${scopeKey}\u0000${login}`;
const placementSnapshotKey = (login: number, clientOrderId: string): string =>
    `${login}\u0000${clientOrderId}`;

const mergeSessionRejectedIntoDataSet = (
    login: number,
    data: TradeHistoryDataSet,
): TradeHistoryDataSet => {
    const rejectedRows = rejectedPlacementHistory.get(login);
    if (!rejectedRows || rejectedRows.length === 0) return data;
    const seenClientIds = new Set(
        data.orders
            .map((order) => order.clientOrderId)
            .filter((id): id is string => Boolean(id)),
    );
    const missingRejected = rejectedRows.filter(
        (row) => !row.clientOrderId || !seenClientIds.has(row.clientOrderId),
    );
    if (missingRejected.length === 0) return data;
    return {
        ...data,
        orders: [...missingRejected, ...data.orders],
    };
};

const handlePlacementStateForHistory = (event: Event) => {
    const detail = (event as CustomEvent<MarketOrderPlacementStateDetail>).detail;
    const login = Number(detail?.login ?? 0);
    const clientOrderId = typeof detail?.clientOrderId === 'string' ? detail.clientOrderId : '';
    if (!detail || !(login > 0) || !clientOrderId) return;

    const snapKey = placementSnapshotKey(login, clientOrderId);
    if (detail.position && typeof detail.position === 'object') {
        pendingPlacementSnapshots.set(snapKey, detail.position as Record<string, unknown>);
    }

    if (detail.status === 'filled' || detail.status === 'confirmed' || detail.status === 'failed') {
        pendingPlacementSnapshots.delete(snapKey);
        return;
    }

    if (detail.status !== 'rejected' && detail.status !== 'expired') {
        return;
    }

    const source = (detail.position && typeof detail.position === 'object'
        ? detail.position as Record<string, unknown>
        : pendingPlacementSnapshots.get(snapKey)) ?? {};
    pendingPlacementSnapshots.delete(snapKey);

    const symbol = String(source.symbol ?? '').trim();
    const volume = Number(source.volume ?? source.volume_lots ?? source.quantity ?? 0);
    if (!symbol || !(volume > 0)) return;

    const nowIso = new Date().toISOString();
    const rawOpenTime = typeof source.time_create === 'string' && source.time_create.trim()
        ? source.time_create.trim()
        : nowIso;
    const sideLower = String(source.side ?? 'buy').trim().toLowerCase() === 'sell' ? 'sell' : 'buy';
    const placementError = [detail.errorCode, detail.errorMessage].filter(Boolean).join(': ');
    const ticket = Number(detail.provisionalTicket) || -Date.now();
    const rejectedTrade: Trade = {
        id: ticket,
        orderTicket: ticket,
        clientOrderId,
        symbol,
        type: sideLower,
        orderType: sideLower,
        side: sideLower.toUpperCase(),
        volume,
        openPrice: 0,
        closePrice: 0,
        openTime: rawOpenTime,
        closeTime: nowIso,
        profit: 0,
        commission: 0,
        swap: 0,
        sl: Number(source.price_sl ?? source.sl ?? 0),
        tp: Number(source.price_tp ?? source.tp ?? 0),
        status: detail.status,
        comment: placementError || (detail.status === 'expired' ? 'Order expired' : 'Order rejected'),
        ...(detail.errorCode ? { placementErrorCode: detail.errorCode } : {}),
        ...(detail.errorMessage ? { placementErrorMessage: detail.errorMessage } : {}),
        historySource: 'order',
    };

    const existing = rejectedPlacementHistory.get(login) ?? [];
    const nextRejected = [
        rejectedTrade,
        ...existing.filter((item) => item.clientOrderId !== clientOrderId),
    ];
    rejectedPlacementHistory.set(login, nextRejected);

    if (cache && cache.login === login) {
        cache = {
            ...cache,
            data: mergeSessionRejectedIntoDataSet(login, cache.data),
        };
        rejectedUpdateListeners.forEach((listener) => listener(login, cache!.data));
    } else {
        const baseData: TradeHistoryDataSet = {
            positions: [],
            deals: [],
            orders: nextRejected,
            errors: { positions: null, deals: null, orders: null },
        };
        rejectedUpdateListeners.forEach((listener) => listener(login, baseData));
    }
};

export const ensureTerminalHistoryPlacementListener = (): void => {
    if (placementListenerBound || typeof window === 'undefined') return;
    placementListenerBound = true;
    window.addEventListener(MARKET_ORDER_PLACEMENT_STATE_EVENT, handlePlacementStateForHistory);
};

ensureTerminalHistoryPlacementListener();

export const subscribeTerminalHistoryRejectedUpdates = (
    listener: RejectedHistoryUpdateListener,
): (() => void) => {
    ensureTerminalHistoryPlacementListener();
    rejectedUpdateListeners.add(listener);
    return () => {
        rejectedUpdateListeners.delete(listener);
    };
};

const matchesCache = (login: number, scopeKey: string): HistoryCacheEntry | null => {
    if (!cache || cache.login !== login || cache.scopeKey !== scopeKey) return null;
    const mergedData = mergeSessionRejectedIntoDataSet(login, cache.data);
    if (mergedData !== cache.data) {
        cache = { ...cache, data: mergedData };
    }
    return cache;
};

export const peekTerminalHistory = (login: number, scopeKey: string): HistoryCacheEntry | null => (
    matchesCache(login, scopeKey)
);

const publishHistory = (
    flight: HistoryFlight,
    login: number,
    scopeKey: string,
    data: TradeHistoryDataSet,
    ordersPending: boolean,
) => {
    if (flight.generation !== generation || flight.serial !== publishSerial) return;
    const mergedData = mergeSessionRejectedIntoDataSet(login, data);
    cache = { login, scopeKey, data: mergedData, ordersPending };
    flight.listeners.forEach(listener => listener(mergedData, ordersPending));
};

// Drops the account-history snapshot when the signed-in account changes.
// The next read must not reuse another account's deals or orders.
export const resetTerminalHistorySession = (): void => {
    generation += 1;
    publishSerial += 1;
    primed = false;
    cache = null;
    flights.clear();
    pendingPlacementSnapshots.clear();
    rejectedPlacementHistory.clear();
    clearTradeHistoryRequestCache();
};

// The first refresh shares the prefetch already in flight. Later refreshes,
// such as a fill or close, drop that snapshot so the next read is current.
export const beginTradeHistoryRefresh = (): void => {
    if (primed) {
        generation += 1;
        publishSerial += 1;
        cache = null;
        flights.clear();
        clearTradeHistoryRequestCache();
    }
    primed = true;
};

export const loadTerminalHistory = (
    login: number,
    scopeKey: string,
    options?: { force?: boolean; refresh?: boolean; onUpdate?: HistoryListener },
): Promise<TradeHistoryDataSet> => {
    const key = historyRequestKey(login, scopeKey);
    const force = options?.force === true;
    const refresh = options?.refresh === true;
    const onUpdate = options?.onUpdate;

    if (!force) {
        const existing = flights.get(key);
        if (existing && existing.generation === generation) {
            if (onUpdate) {
                existing.listeners.add(onUpdate);
                const cached = matchesCache(login, scopeKey);
                if (cached) onUpdate(cached.data, cached.ordersPending);
            }
            return existing.promise.finally(() => {
                if (onUpdate) existing.listeners.delete(onUpdate);
            });
        }
        const cached = matchesCache(login, scopeKey);
        if (!refresh && cached && !cached.ordersPending) {
            onUpdate?.(cached.data, false);
            return Promise.resolve(cached.data);
        }
    }

    const flight: HistoryFlight = {
        generation,
        serial: ++publishSerial,
        promise: Promise.resolve({
            positions: [],
            deals: [],
            orders: [],
            errors: { positions: null, deals: null, orders: null },
        }),
        listeners: new Set(onUpdate ? [onUpdate] : []),
    };
    const promise = tradeGatewayApi.getHistoryDataSet(login, {
        force,
        onPartial: (data) => publishHistory(flight, login, scopeKey, data, true),
    }).then((data) => {
        publishHistory(flight, login, scopeKey, data, false);
        return data;
    }).finally(() => {
        if (flights.get(key)?.promise === promise) flights.delete(key);
    });
    flight.promise = promise;
    flights.set(key, flight);
    return promise;
};
