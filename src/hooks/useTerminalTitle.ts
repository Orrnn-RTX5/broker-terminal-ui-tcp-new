import { brokerDisplayName, isBrokerName, NEUTRAL_TERMINAL_TITLE, resolveTerminalTitle } from '../services/brokerDisplayName';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAppStore } from '../store/useAppStore';
import { brokerV2Api } from '../api/trade';
import { configApi } from '../services/api';
import type { Broker, BrokerServer } from '../types/api';
import type { NormalizedMarketStatus } from '../utils/marketStatus';
import { API_V2_BASE_URL, RTX5_API_URL, normalizeServerUrl } from '../config/api';
import { apiClient } from '../api/client';
import { runAfterTerminalReady } from '../startup/runAfterTerminalReady';
import { setBrokerServerTimeZoneFromConfig } from '../services/brokerServerClock';
import { getCommittedBrokerAccountSessionScope, onSessionChange } from '../services/brokerSession';
import {
    buildBrokerDirectoryLogoUrl,
    getConfiguredBrokerLogoUrl,
    isPlaceholderBrokerLogoUrl,
    normalizeSameOriginHttpsUrl,
    shouldPreferDynamicLogoOverConfigured,
} from '../components/BrokerLogoImage';
import { getRuntimeBrokerConfiguration, isDesktopBackendTarget } from '../config/backendTarget.js';
import {
    getKnownBrokerServerName,
    recordBrokerServerIdentity,
    resolveServerDisplayLabel,
    useKnownBrokerServerName,
} from '../services/brokerServerIdentity';

/** Neutral fallback title. No vendor string; prefer getWebTerminalTitle(). */
export const WEB_TERMINAL_TITLE = NEUTRAL_TERMINAL_TITLE;
export const DEFAULT_BROKER_SERVER = WEB_TERMINAL_TITLE;

const getExplicitConfiguredBrokerName = (): string => {
    try {
        const config = getRuntimeBrokerConfiguration() as {
            explicitBrokerName?: unknown; brokerId?: unknown;
        } | null;
        const explicitFromConfig = typeof config?.explicitBrokerName === 'string'
            ? config.explicitBrokerName.trim()
            : '';
        const configBrokerId = typeof config?.brokerId === 'string' ? config.brokerId.trim() : '';
        if (isDesktopBackendTarget() && typeof window !== 'undefined') {
            const activeBrokerId = getStoredBrokerId();
            if (explicitFromConfig && isBrokerName(explicitFromConfig) && (!activeBrokerId || !configBrokerId || activeBrokerId === configBrokerId)) {
                return explicitFromConfig;
            }
            const sessionName = String(window.localStorage.getItem('broker_name') || '').trim();
            const knownServer = getKnownBrokerServerName();
            if (isBrokerName(sessionName) && (!knownServer || sessionName.toLowerCase() !== knownServer.toLowerCase())) {
                return sessionName;
            }
        }
        return explicitFromConfig && isBrokerName(explicitFromConfig) ? explicitFromConfig : '';
    } catch {
        return '';
    }
};

/**
 * White-label terminal title: broker display name from broker config when
 * configured, neutral fallback otherwise. Never a vendor default.
 */
export const getWebTerminalTitle = (): string => {
    try {
        const explicit = getExplicitConfiguredBrokerName();
        if (explicit) return explicit;
        const config = getRuntimeBrokerConfiguration() as {
            brokerName?: unknown; defaultMt5Server?: unknown; brokerId?: unknown;
        } | null;
        // The build fallback DEFAULT_MT5_SERVER yields to the broker-published
        // server name once the broker config is available.
        return resolveServerDisplayLabel(resolveTerminalTitle({
            displayName: config?.brokerName,
            defaultMt5Server: config?.defaultMt5Server,
            brokerId: config?.brokerId,
        }));
    } catch {
        return NEUTRAL_TERMINAL_TITLE;
    }
};

export const normalizeHeaderText = (value: unknown): string => String(value || '').trim();

/** Case-insensitive label equality for title dedupe (empty never equals). */
export const isSameTerminalLabel = (a: unknown, b: unknown): boolean => {
  const x = normalizeHeaderText(a).toLowerCase();
  const y = normalizeHeaderText(b).toLowerCase();
  return Boolean(x) && x === y;
};

const getStoredHeaderValue = (key: string): string => {
    if (typeof window === 'undefined') return '';
    return normalizeHeaderText(localStorage.getItem(key));
};

const getStoredBrokerId = (): string => {
    const stored = getStoredHeaderValue('broker_id') || getStoredHeaderValue('rtx_broker_id');
    if (stored) return stored;
    try {
        return String(getRuntimeBrokerConfiguration().brokerId || '').trim();
    } catch {
        return '';
    }
};
const getStoredLogoUrl = (): string => {
    const storedLogo = getStoredHeaderValue('logo_url');
    const validStoredLogo = isPlaceholderBrokerLogoUrl(storedLogo) ? '' : storedLogo;
    return getConfiguredBrokerLogoUrl(getStoredBrokerId())
        || validStoredLogo
        || buildBrokerDirectoryLogoUrl(getStoredBrokerId());
};

const normalizeLogoBaseUrl = (value: unknown): string => {
    const normalized = normalizeServerUrl(normalizeHeaderText(value));
    return normalized.replace(/\/api\/v\d+\/?$/i, '').replace(/\/$/, '');
};

const appendLogoVersionParam = (rawUrl: string, versionHint?: unknown): string => {
    const trimmed = normalizeHeaderText(rawUrl);
    if (!trimmed || isPlaceholderBrokerLogoUrl(trimmed)) return '';
    const version = normalizeHeaderText(versionHint);
    if (!version || /^(?:data:|blob:)/i.test(trimmed)) return trimmed;
    try {
        const base = typeof window !== 'undefined' && window.location?.origin
            ? window.location.origin
            : 'https://broker.local';
        const parsed = new URL(trimmed, base);
        if (parsed.searchParams.get('v') || parsed.searchParams.get('version') || parsed.searchParams.get('t')) {
            return trimmed;
        }
        const sep = trimmed.includes('?') ? '&' : '?';
        return `${trimmed}${sep}v=${encodeURIComponent(version)}`;
    } catch {
        return trimmed;
    }
};

const hasVersionQuery = (rawUrl: string): boolean => /[?&](?:v|version|t)=[^&]+/i.test(rawUrl);

export const getLogoUrl = (url?: string, baseCandidates: string[] = []) => {
    const rawUrl = normalizeHeaderText(url);
    if (!rawUrl || isPlaceholderBrokerLogoUrl(rawUrl)) return '';
    if (/^(?:https?:|data:|blob:)/i.test(rawUrl)) {
        return normalizeSameOriginHttpsUrl(rawUrl);
    }
    if (rawUrl.startsWith('./')) {
        return rawUrl;
    }

    const base = [
        ...baseCandidates,
        getStoredHeaderValue('server_url'),
        getStoredHeaderValue('backend_url'),
        RTX5_API_URL,
    ].map(normalizeLogoBaseUrl).find(Boolean);
    if (!base) return rawUrl;

    const path = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
    return normalizeSameOriginHttpsUrl(`${base}${path}`);
};

type BrokerTitleConfig = {
    name?: string;
    brokerName?: string;
    broker_name?: string;
    server_name?: string;
    logo_url?: string;
    logo_version?: string;
    logo_updated_at?: string;
    marginMode?: string;
    margin_mode?: string;
};

const matchesBrokerServer = (server: BrokerServer, serverName: string): boolean => {
    if (!server || typeof server !== 'object') return false;
    const target = normalizeHeaderText(serverName).toLowerCase();
    if (!target) return false;

    return [
        server.server,
        server.server_url,
        server.backend_url,
        server.market_api_url,
        server.broker_id,
        server.broker_name,
    ].some((value) => normalizeHeaderText(value).toLowerCase() === target);
};

const pickExplicitBrokerName = (
    config: BrokerTitleConfig | null,
    matchedServer?: BrokerServer,
    brokers: Broker[] = [],
    brokerId = '',
): string => {
    const safeBrokers = Array.isArray(brokers) ? brokers : [];
    const targetBrokerId = matchedServer?.broker_id || brokerId;
    const matchedBroker = targetBrokerId
        ? safeBrokers.find((broker) => String(broker?.broker_id) === String(targetBrokerId))
        : undefined;
    const directoryName = matchedServer?.broker_name && (!targetBrokerId || String(matchedServer.broker_name) !== String(targetBrokerId))
        ? matchedServer.broker_name
        : matchedBroker?.name;
    const candidates = [
        directoryName,
        config?.broker_name,
        config?.brokerName,
        config?.name,
        getExplicitConfiguredBrokerName(),
    ];
    return candidates.map((value) => String(value ?? '').trim()).find(isBrokerName) || '';
};

const resolveBrokerDisplayName = (
    serverName: string,
    config: BrokerTitleConfig | null,
    matchedServer?: BrokerServer,
    brokers: Broker[] = [],
    brokerId = '',
): string => {
    const explicit = pickExplicitBrokerName(config, matchedServer, brokers, brokerId);
    if (explicit) return explicit;
    const safeBrokers = Array.isArray(brokers) ? brokers : [];
    const targetBrokerId = matchedServer?.broker_id || brokerId;
    const matchedBroker = targetBrokerId
        ? safeBrokers.find((broker) => String(broker?.broker_id) === String(targetBrokerId))
        : undefined;

    const directoryName = matchedServer?.broker_name || matchedBroker?.name;
    return brokerDisplayName(
        serverName,
        directoryName,
        config?.broker_name,
        config?.brokerName,
        config?.name,
        config?.server_name,
    );
};

type BrokerDetails = [BrokerTitleConfig | null, BrokerServer[], { brokers: Broker[]; count: number } | null];

// HeaderBar and StatusBar both mount this hook; share one in-flight fetch per server.
let detailsCache: { key: string; promise: Promise<BrokerDetails> } | null = null;

// Shared tab-focus / visibility / background polling refresh trigger so Super Admin logo updates
// reflect live across the chart watermark, account tree, status bar, toolbar, and menus without reloading.
const BROKER_METADATA_REVALIDATE_MIN_GAP_MS = 5_000;
const BROKER_METADATA_POLL_INTERVAL_MS = 15_000;
let brokerMetadataRefreshTick = 0;
let lastBrokerMetadataRefreshAt = 0;
let lastObservedTcpStatusIdentity = '';
let brokerMetadataPollTimer: ReturnType<typeof setInterval> | null = null;
const brokerMetadataRefreshListeners = new Set<() => void>();
let brokerMetadataListenersBound = false;

export const notifyBrokerMetadataRefresh = (force = false) => {
    const now = Date.now();
    if (
        !force
        && now >= lastBrokerMetadataRefreshAt
        && now - lastBrokerMetadataRefreshAt < BROKER_METADATA_REVALIDATE_MIN_GAP_MS
    ) {
        return;
    }
    lastBrokerMetadataRefreshAt = now;
    brokerMetadataRefreshTick += 1;
    brokerMetadataRefreshListeners.forEach((listener) => listener());
};

const handleVisibilityOrFocusRefresh = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    notifyBrokerMetadataRefresh();
};

const handleTcpStatusRefresh = (event: Event) => {
    const detail = (event as CustomEvent<{ broker_id?: string; broker_name?: string; logo_url?: string }>).detail;
    if (!detail || typeof detail !== 'object') return;
    const identity = `${String(detail.broker_id || '').trim()}|${String(detail.broker_name || '').trim()}|${String(detail.logo_url || '').trim()}`;
    if (!identity.replace(/\|/g, '')) return;
    if (identity !== lastObservedTcpStatusIdentity) {
        lastObservedTcpStatusIdentity = identity;
        notifyBrokerMetadataRefresh(true);
    }
};

const ensureBrokerMetadataPollTimer = () => {
    if (typeof window === 'undefined' || brokerMetadataPollTimer !== null) return;
    brokerMetadataPollTimer = window.setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        notifyBrokerMetadataRefresh();
    }, BROKER_METADATA_POLL_INTERVAL_MS);
};

const stopBrokerMetadataPollTimer = () => {
    if (brokerMetadataPollTimer === null || typeof window === 'undefined') return;
    window.clearInterval(brokerMetadataPollTimer);
    brokerMetadataPollTimer = null;
};

const bindBrokerMetadataRefreshEvents = () => {
    if (brokerMetadataListenersBound || typeof window === 'undefined' || typeof document === 'undefined') return;
    brokerMetadataListenersBound = true;
    window.addEventListener('focus', handleVisibilityOrFocusRefresh);
    window.addEventListener('rtx5-tcp-status', handleTcpStatusRefresh);
    document.addEventListener('visibilitychange', handleVisibilityOrFocusRefresh);
};

const subscribeBrokerMetadataRefresh = (listener: () => void) => {
    bindBrokerMetadataRefreshEvents();
    brokerMetadataRefreshListeners.add(listener);
    ensureBrokerMetadataPollTimer();
    return () => {
        brokerMetadataRefreshListeners.delete(listener);
        if (brokerMetadataRefreshListeners.size === 0) {
            stopBrokerMetadataPollTimer();
        }
    };
};

const getBrokerMetadataRefreshTick = () => brokerMetadataRefreshTick;

const extractServersArray = (raw: unknown): BrokerServer[] => {
    if (Array.isArray(raw)) return raw as BrokerServer[];
    if (raw && typeof raw === 'object') {
        const rec = raw as Record<string, unknown>;
        if (Array.isArray(rec.servers)) return rec.servers as BrokerServer[];
        if (Array.isArray(rec.brokers)) return rec.brokers as BrokerServer[];
        if (Array.isArray(rec.data)) return rec.data as BrokerServer[];
    }
    return [];
};

const fetchBrokerDetails = (key: string): Promise<BrokerDetails> => {
    if (detailsCache?.key === key) return detailsCache.promise;
    const promise = Promise.all([
        configApi.getConfig().catch(() => null),
        brokerV2Api.getServers().then(extractServersArray).catch(() => [] as BrokerServer[]),
        brokerV2Api.getBrokers().catch(() => ({ brokers: [] as Broker[], count: 0 })),
    ]).finally(() => {
        if (detailsCache?.promise === promise) detailsCache = null;
    }) as Promise<BrokerDetails>;
    detailsCache = { key, promise };
    return promise;
};

/** Shown while the signed account's own mode is unknown; never a guessed Hedge. */
export const UNKNOWN_MARGIN_MODE = '—';

/** accounts.account_mode ('netting' | 'hedging') → title label; anything else stays unknown. */
export const accountModeLabel = (value: unknown): string => {
    const mode = normalizeHeaderText(value).toLowerCase();
    if (mode === 'netting') return 'Netting';
    if (mode === 'hedging') return 'Hedge';
    return UNKNOWN_MARGIN_MODE;
};

type AccountModeRead = { account_login?: unknown; account_mode?: unknown };

// Netting/hedging is per account (group), not per broker: read it from the
// signed current-account capability snapshot once per account/session key.
// Every hook user shares one record per account/session key (resolved mode +
// read count), one in-flight read per key and symbol, and one session epoch,
// and is notified when a mode resolves (a small external store).
let accountModeCache: { key: string; promise: Promise<string> } | null = null;
const accountModeRecords = new Map<string, { mode: string; reads: number }>();
const accountModeListeners = new Set<() => void>();
/** Reads per account/session key while the mode stays unknown (one per symbol change). */
const MAX_ACCOUNT_MODE_READS = 3;
/** Bounded: only the current and a few recent account/session keys are kept. */
const MAX_ACCOUNT_MODE_RECORDS = 8;
/** Shared by every hook user, so a user that mounts after a login uses the same key. */
let accountModeSessionEpoch = 0;

const notifyAccountMode = () => { accountModeListeners.forEach((listener) => listener()); };
const subscribeAccountMode = (listener: () => void) => {
    accountModeListeners.add(listener);
    return () => { accountModeListeners.delete(listener); };
};

// Registered at import, before any hook user subscribes, so the epoch has moved
// when their own session listeners re-render. A login, logout or account change
// never reuses a previous session's mode.
onSessionChange((reason) => {
    if (reason === 'token_rotation') return;
    accountModeSessionEpoch += 1;
    accountModeRecords.clear();
    accountModeCache = null;
    notifyAccountMode();
});

const accountModeRecordFor = (key: string) => {
    let record = accountModeRecords.get(key);
    if (!record) {
        record = { mode: UNKNOWN_MARGIN_MODE, reads: 0 };
        accountModeRecords.set(key, record);
        while (accountModeRecords.size > MAX_ACCOUNT_MODE_RECORDS) {
            accountModeRecords.delete(accountModeRecords.keys().next().value as string);
        }
    }
    return record;
};

/** The shared resolved mode for this account/session key. */
const knownAccountMode = (key: string): string => accountModeRecords.get(key)?.mode ?? UNKNOWN_MARGIN_MODE;

const fetchAccountMode = (key: string, accountId: string, symbol: string): Promise<string> => {
    const record = accountModeRecordFor(key);
    if (record.mode !== UNKNOWN_MARGIN_MODE) return Promise.resolve(record.mode);
    const readKey = `${key}|${symbol}`;
    if (accountModeCache?.key === readKey) return accountModeCache.promise;
    if (record.reads >= MAX_ACCOUNT_MODE_READS) return Promise.resolve(UNKNOWN_MARGIN_MODE);
    record.reads += 1;
    const promise = apiClient.get<AccountModeRead>(
        `/account/symbol-capabilities/${encodeURIComponent(symbol)}`,
        { baseUrl: API_V2_BASE_URL },
    ).then((read) => (
        // A snapshot for another login (stale token after a switch) is not this account's mode.
        normalizeHeaderText(read?.account_login) === accountId ? accountModeLabel(read?.account_mode) : UNKNOWN_MARGIN_MODE
    )).catch(() => UNKNOWN_MARGIN_MODE).then((mode) => {
        // Keep the answer for its own key, even after a symbol change; an
        // unknown never replaces a known mode.
        const current = accountModeRecords.get(key);
        if (current && current.mode === UNKNOWN_MARGIN_MODE && mode !== UNKNOWN_MARGIN_MODE) {
            current.mode = mode;
            notifyAccountMode();
        }
        return knownAccountMode(key);
    }).finally(() => {
        if (accountModeCache?.promise === promise) accountModeCache = null;
    });
    accountModeCache = { key: readKey, promise };
    return promise;
};

export interface TerminalBrokerInfo {
    accountId: string;
    accountName?: string;
    serverName: string;
    brokerName: string;
    marginMode: string;
    logoUrl: string;
    logoBaseCandidates: string[];
}

/**
 * @param symbol the chart symbol the caller shows (required: App / StatusBar own
 *   it; the store's selectedSymbol is not kept in sync). Used only for the account-mode read.
 */
export function useTerminalBrokerInfo(symbol = ''): TerminalBrokerInfo {
    const [sessionRevision, setSessionRevision] = useState(0);
    useEffect(() => onSessionChange(reason => {
        if (reason !== 'token_rotation') setSessionRevision(value => value + 1);
    }), []);
    const metadataRefreshTick = useSyncExternalStore(
        subscribeBrokerMetadataRefresh,
        getBrokerMetadataRefreshTick,
        getBrokerMetadataRefreshTick,
    );
    const accountId = useAppStore((s) => s.accountId) || '---';
    const rawSavedAccounts = useAppStore((s) => s.savedAccounts);
    const savedAccounts = Array.isArray(rawSavedAccounts) ? rawSavedAccounts : [];
    const activeAccount = savedAccounts.find(a => a && String(a.login) === String(accountId));
    const accountName = normalizeHeaderText(activeAccount?.name);
    const storedServer = typeof window !== 'undefined' ? localStorage.getItem('rtx_broker_server') : '';
    const serverName = storedServer || activeAccount?.server || DEFAULT_BROKER_SERVER;
    const brokerId = getStoredBrokerId();
    const infoKey = `${brokerId}|${serverName}|${accountId}|${sessionRevision}`;
    const detailsFetchKey = `${infoKey}|r${metadataRefreshTick}`;

    const [resolvedKey, setResolvedKey] = useState(infoKey);
    const [brokerName, setBrokerName] = useState<string>(() => getExplicitConfiguredBrokerName() || brokerDisplayName(serverName));
    const [hasExplicitBroker, setHasExplicitBroker] = useState<boolean>(() => Boolean(getExplicitConfiguredBrokerName()));
    const isAuthenticated = useAppStore((s) => s.isAuthenticated);
    const modeSymbol = normalizeHeaderText(symbol);
    const modeKey = `${brokerId}|${serverName}|${accountId}|${isAuthenticated ? 'auth' : 'guest'}|${accountModeSessionEpoch}`;
    const [logoUrl, setLogoUrl] = useState<string>(() => getStoredLogoUrl());
    const [logoBaseCandidates, setLogoBaseCandidates] = useState<string[]>([]);

    useEffect(() => {
        const initialExplicit = getExplicitConfiguredBrokerName();
        setResolvedKey(infoKey);
        setBrokerName(initialExplicit || brokerDisplayName(serverName));
        setHasExplicitBroker(Boolean(initialExplicit));
        setLogoUrl(getStoredLogoUrl());
        setLogoBaseCandidates([]);
    }, [infoKey, serverName]);

    useEffect(() => {
        let active = true;

        const fetchDetails = async () => {
            try {
                const [config, rawServers, brokersData] = await fetchBrokerDetails(detailsFetchKey);

                if (!active) return;

                const servers = extractServersArray(rawServers);

                // The broker may declare its server timezone for the server clock.
                if (config) setBrokerServerTimeZoneFromConfig(config);
                // The broker-published server name (config server_name, else the
                // current broker's /broker/servers entry) replaces the build fallback.
                recordBrokerServerIdentity(config, servers);

                // Find broker ID, broker name, and logo from server matching
                const matchedServer = servers.find(server => brokerId && String(server?.broker_id) === brokerId)
                    || servers.find((server) => matchesBrokerServer(server, serverName));
                const rawBrokersList = Array.isArray(brokersData)
                    ? brokersData
                    : brokersData?.brokers;
                const brokersList: Broker[] = Array.isArray(rawBrokersList) ? rawBrokersList : [];
                const matchedBroker = brokersList.find(broker => String(broker?.broker_id) === (brokerId || String(matchedServer?.broker_id || '')));

                const serverLogoCandidates = [
                    appendLogoVersionParam(
                        matchedServer?.logo_url || '',
                        matchedServer?.logo_version || matchedServer?.logo_updated_at,
                    ),
                    appendLogoVersionParam(
                        matchedBroker?.logo_url || '',
                        matchedBroker?.logo_version || matchedBroker?.logo_updated_at,
                    ),
                    appendLogoVersionParam(
                        config?.logo_url || '',
                        config?.logo_version || config?.logo_updated_at,
                    ),
                ].filter((v) => Boolean(v) && !isPlaceholderBrokerLogoUrl(v));

                const freshServerLogoUrl = serverLogoCandidates.find((v) => hasVersionQuery(v))
                    || serverLogoCandidates[0]
                    || '';

                const configuredLogoUrl = getConfiguredBrokerLogoUrl(brokerId);
                const pickValidLogoUrl = (...values: Array<string | undefined>): string =>
                    values
                        .map((v) => normalizeHeaderText(v))
                        .find((v) => Boolean(v) && !isPlaceholderBrokerLogoUrl(v)) || '';

                const finalLogoUrl = shouldPreferDynamicLogoOverConfigured(configuredLogoUrl, freshServerLogoUrl)
                    ? pickValidLogoUrl(
                        freshServerLogoUrl,
                        configuredLogoUrl,
                        getStoredHeaderValue('logo_url'),
                        getStoredLogoUrl(),
                    )
                    : pickValidLogoUrl(
                        configuredLogoUrl,
                        freshServerLogoUrl,
                        getStoredHeaderValue('logo_url'),
                        getStoredLogoUrl(),
                    );
                let nextLogoBaseCandidates: string[] = [];
                if (matchedServer) {
                    nextLogoBaseCandidates = [
                        matchedServer.server_url || '',
                        matchedServer.backend_url || '',
                        matchedServer.market_api_url || '',
                    ];
                }

                const committedScope = getCommittedBrokerAccountSessionScope();
                const storedBrokerId = getStoredBrokerId();
                const sessionMatchesBroker = !committedScope.authenticated
                    || !committedScope.brokerId
                    || !brokerId
                    || committedScope.brokerId === brokerId;
                const storageMatchesBroker = !brokerId || !storedBrokerId || storedBrokerId === brokerId;
                if (
                    freshServerLogoUrl
                    && typeof window !== 'undefined'
                    && sessionMatchesBroker
                    && storageMatchesBroker
                ) {
                    const currentStored = getStoredHeaderValue('logo_url');
                    if (currentStored !== freshServerLogoUrl) {
                        try {
                            window.localStorage.setItem('logo_url', freshServerLogoUrl);
                        } catch {
                            // Storage can be restricted in hardened browser contexts.
                        }
                    }
                }

                const explicitName = pickExplicitBrokerName(config, matchedServer, brokersList, brokerId);
                if (explicitName && isDesktopBackendTarget() && typeof window !== 'undefined') {
                    const currentStoredBrokerName = getStoredHeaderValue('broker_name');
                    const knownServerName = getKnownBrokerServerName();
                    if (!currentStoredBrokerName || (knownServerName && currentStoredBrokerName.toLowerCase() === knownServerName.toLowerCase())) {
                        window.localStorage.setItem('broker_name', explicitName);
                    }
                }
                setHasExplicitBroker(Boolean(explicitName));
                setBrokerName(explicitName || resolveBrokerDisplayName(serverName, config, matchedServer, brokersList, brokerId));
                setLogoUrl(finalLogoUrl);
                setLogoBaseCandidates((prev) => (
                    prev.length === nextLogoBaseCandidates.length
                    && prev.every((item, idx) => item === nextLogoBaseCandidates[idx])
                        ? prev
                        : nextLogoBaseCandidates
                ));
            } catch (err) {
                console.error('[TerminalTitle] Error loading dynamic titlebar info:', err);
                if (!active) return;
                const fallbackExplicit = getExplicitConfiguredBrokerName();
                setHasExplicitBroker(Boolean(fallbackExplicit));
                setBrokerName(fallbackExplicit || brokerDisplayName(serverName));
                setLogoUrl(getStoredLogoUrl());
                setLogoBaseCandidates((prev) => (prev.length === 0 ? prev : []));
            }
        };

        const cancelScheduledDetails = runAfterTerminalReady(() => { void fetchDetails(); });
        return () => {
            active = false;
            cancelScheduledDetails();
        };
    }, [detailsFetchKey, infoKey, serverName, brokerId]);

    // Account mode: read once per account/session; unknown until the signed
    // snapshot for this login answers. The read is per symbol and can fail for
    // a symbol outside this account's scope, so while the mode is still
    // unknown a symbol change may retry (capped); a known mode never re-reads.
    const sharedMode = useSyncExternalStore(subscribeAccountMode, () => knownAccountMode(modeKey));
    const marginMode = isAuthenticated ? sharedMode : UNKNOWN_MARGIN_MODE;
    const modeReadSymbol = marginMode !== UNKNOWN_MARGIN_MODE ? '' : modeSymbol;
    useEffect(() => {
        const login = accountId === '---' ? '' : String(accountId);
        if (!isAuthenticated || !login || !modeReadSymbol) return undefined;
        // The answer lands in the shared record for its own key and notifies
        // every hook user, so a read that finishes after a symbol change still counts.
        return runAfterTerminalReady(() => {
            void fetchAccountMode(modeKey, login, modeReadSymbol);
        });
    }, [modeKey, accountId, isAuthenticated, modeReadSymbol]);

    // Re-render when the broker-published server name becomes known so the
    // build fallback is replaced without waiting for another session change.
    useKnownBrokerServerName();
    const currentDetails = resolvedKey === infoKey;
    const explicitFallback = getExplicitConfiguredBrokerName();
    const resolvedDisplayBrokerName = currentDetails
        ? (hasExplicitBroker ? brokerName : resolveServerDisplayLabel(brokerName))
        : (explicitFallback || resolveServerDisplayLabel(brokerDisplayName(serverName)));
    return {
        accountId, accountName, serverName: resolveServerDisplayLabel(serverName), marginMode,
        brokerName: resolvedDisplayBrokerName,
        logoUrl: currentDetails ? logoUrl : getStoredLogoUrl(),
        logoBaseCandidates: currentDetails ? logoBaseCandidates : [],
    };
}

export function formatTerminalTitle(
    info: Pick<TerminalBrokerInfo, 'accountId' | 'brokerName' | 'marginMode'>,
    symbol: string,
    timeframe: string,
    marketStatus?: NormalizedMarketStatus & { loading?: boolean },
): string {
    const marketStatusSuffix = marketStatus?.isTradeBlocked && !marketStatus.loading && marketStatus.status !== 'unknown'
        ? ` - ${marketStatus.label}`
        : '';
    const webTitle = getWebTerminalTitle();
    const knownServer = getKnownBrokerServerName();
    const primaryLabel = (
        knownServer
        && isSameTerminalLabel(webTitle, knownServer)
        && isBrokerName(info.brokerName)
        && !isSameTerminalLabel(info.brokerName, knownServer)
    )
        ? info.brokerName
        : webTitle;
    // Broker display name from discovery/runtime-config, shown once: when it
    // equals the title prefix the broker segment adds nothing, so it is dropped
    // (the server label then appears only once via the remaining segment).
    const brokerSegment = isSameTerminalLabel(info.brokerName, primaryLabel) ? '' : info.brokerName;
    const title = `${primaryLabel} - ${info.accountId}`
        + (brokerSegment ? ` - ${brokerSegment}` : '')
        + ` - ${info.marginMode} - ${symbol},${timeframe.toUpperCase()}${marketStatusSuffix}`;
    return title;
}
