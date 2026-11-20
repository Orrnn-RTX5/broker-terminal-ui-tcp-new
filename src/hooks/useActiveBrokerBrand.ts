import { useEffect, useMemo, useRef, useState } from 'react';
import { toLocalDevProxyUrl } from '../config/api';
import { getRuntimeBrokerConfiguration } from '../config/backendTarget.js';
import { getBrokerChrome, BROKER_CHROME_EVENT, type BrokerChromeState } from '../services/brokerPresentation';
import { brokerDisplayName, isBrokerName, NEUTRAL_TERMINAL_TITLE } from '../services/brokerDisplayName';
import { getCachedBrokerDirectory } from '../services/brokerDirectory';
import type { BrokerDiscoveryItem } from '../services/brokerDiscovery';
import { getCommittedBrokerAccountSessionScope } from '../services/brokerSession';
import { useBrokerAccountSessionScope } from './useBrokerAccountSessionScope';
import { getLogoUrl, getWebTerminalTitle, useTerminalBrokerInfo, type TerminalBrokerInfo } from './useTerminalTitle';
import {
    appendBrokerLogoVersionParam,
    hasBrokerLogoVersionQuery,
    isPlaceholderBrokerLogoUrl,
    normalizeSameOriginHttpsUrl,
} from '../components/BrokerLogoImage';

export interface ActiveBrokerBrandOptions {
    symbol?: string;
    accountBrokerName?: string;
}

export interface ActiveBrokerBrand {
    brokerId: string;
    brokerName: string;
    brandTitle: string;
    logoUrl: string;
    serverUrl: string;
    brokerInfo: TerminalBrokerInfo;
    matchedDirectoryBroker: BrokerDiscoveryItem | undefined;
    isSpecificBrokerLabel: (value?: string | null) => value is string;
}

const isSameLabel = (a: unknown, b: unknown): boolean => {
    const x = String(a ?? '').trim().toLowerCase();
    const y = String(b ?? '').trim().toLowerCase();
    return Boolean(x) && x === y;
};

const isSpecificBrokerLabel = (value?: string | null): value is string => {
    const trimmed = String(value ?? '').trim();
    if (!isBrokerName(trimmed)) return false;
    if (isSameLabel(trimmed, NEUTRAL_TERMINAL_TITLE)) return false;
    return !/^rtx\s*5?(?:[- ]?(?:live|demo|web|terminal))?$/i.test(trimmed);
};

const formatBrandTitleLabel = (brokerName: string): string => {
    const trimmed = brokerName.trim();
    if (!trimmed || trimmed === NEUTRAL_TERMINAL_TITLE) return trimmed;
    if (/(?:-| )(?:live|demo)$/i.test(trimmed)) return trimmed;
    return `${trimmed}-Live`;
};

/**
 * Resolves the active broker identity, display name, and live logo URL across
 * runtime config, live server metadata, broker chrome events, and directory
 * cache so toolbar/menu surfaces update in sync without duplicating logic.
 */
export function useActiveBrokerBrand({
    symbol = '',
    accountBrokerName,
}: ActiveBrokerBrandOptions = {}): ActiveBrokerBrand {
    const brokerInfo = useTerminalBrokerInfo(symbol);
    useBrokerAccountSessionScope();
    const sessionScope = getCommittedBrokerAccountSessionScope();
    const [brokerChrome, setBrokerChrome] = useState<BrokerChromeState>(() => getBrokerChrome());

    // Track whether the latest logo change arrived from BROKER_CHROME_EVENT or from
    // useTerminalBrokerInfo so live server refreshes aren't shadowed by an older chrome state
    // while explicit applyBrokerChrome() calls (e.g. direct chrome updates) still apply.
    const [logoPreference, setLogoPreference] = useState<'chrome' | 'resolved'>('chrome');
    const prevResolvedLogoRef = useRef<string>('');

    useEffect(() => {
        const updateFromChrome = (nextChrome: BrokerChromeState) => {
            setBrokerChrome(nextChrome);
            if (!isPlaceholderBrokerLogoUrl(nextChrome.logoUrl) && String(nextChrome.logoUrl || '').trim()) {
                setLogoPreference('chrome');
            }
        };
        updateFromChrome(getBrokerChrome());
        const onBrokerChrome = (event: Event) => {
            const detail = (event as CustomEvent<BrokerChromeState>).detail;
            updateFromChrome(detail || getBrokerChrome());
        };
        window.addEventListener(BROKER_CHROME_EVENT, onBrokerChrome);
        return () => window.removeEventListener(BROKER_CHROME_EVENT, onBrokerChrome);
    }, []);

    const resolvedBrokerLogoUrl = toLocalDevProxyUrl(
        getLogoUrl(brokerInfo.logoUrl, brokerInfo.logoBaseCandidates),
    );

    useEffect(() => {
        if (resolvedBrokerLogoUrl && resolvedBrokerLogoUrl !== prevResolvedLogoRef.current) {
            prevResolvedLogoRef.current = resolvedBrokerLogoUrl;
            setLogoPreference('resolved');
        } else if (!resolvedBrokerLogoUrl) {
            prevResolvedLogoRef.current = '';
        }
    }, [resolvedBrokerLogoUrl]);

    const storedBrokerId = typeof window !== 'undefined'
        ? String(
            localStorage.getItem('broker_id')
            || localStorage.getItem('rtx_broker_id')
            || (sessionScope.authenticated ? sessionScope.brokerId : '')
            || getRuntimeBrokerConfiguration().brokerId
            || '',
        ).trim()
        : '';
    const brokerId = String(brokerChrome.brokerId || storedBrokerId || '').trim();

    const chromeMatchesActiveBroker = !brokerChrome.brokerId
        || !brokerId
        || brokerChrome.brokerId.trim().toLowerCase() === brokerId.toLowerCase();

    const rawChromeLogoUrl = chromeMatchesActiveBroker && !isPlaceholderBrokerLogoUrl(brokerChrome.logoUrl)
        ? toLocalDevProxyUrl(normalizeSameOriginHttpsUrl(brokerChrome.logoUrl || ''))
        : '';

    const storedBrokerName = typeof window !== 'undefined'
        ? (localStorage.getItem('broker_name') || '').trim()
        : '';
    const storedBrokerServer = typeof window !== 'undefined'
        ? (localStorage.getItem('rtx_broker_server') || localStorage.getItem('server_url') || '')
        : '';

    const matchedDirectoryBroker = useMemo(() => {
        const cachedDirectory = getCachedBrokerDirectory() || [];
        return cachedDirectory.find((entry) => {
            if (brokerId && String(entry.broker_id || '').trim() === brokerId) return true;
            const entryServer = String(entry.server_url || '').trim().replace(/\/+$/, '').toLowerCase();
            const scopeServer = String(sessionScope.serverUrl || storedBrokerServer || '').trim().replace(/\/+$/, '').toLowerCase();
            return Boolean(entryServer && scopeServer && entryServer === scopeServer);
        });
    }, [brokerId, sessionScope.serverUrl, storedBrokerServer]);

    const directoryLogoWithVersion = appendBrokerLogoVersionParam(
        matchedDirectoryBroker?.logo_url,
        (matchedDirectoryBroker as { logo_version?: string; logo_updated_at?: string } | undefined)?.logo_version
        || (matchedDirectoryBroker as { logo_updated_at?: string } | undefined)?.logo_updated_at,
    );
    const directoryLogoUrl = toLocalDevProxyUrl(
        getLogoUrl(
            directoryLogoWithVersion,
            [matchedDirectoryBroker?.server_url || '', sessionScope.serverUrl].filter(Boolean),
        ),
    );

    const orderedLogoCandidates = logoPreference === 'resolved'
        ? [resolvedBrokerLogoUrl, rawChromeLogoUrl, directoryLogoUrl]
        : [rawChromeLogoUrl, resolvedBrokerLogoUrl, directoryLogoUrl];
    const logoUrl = orderedLogoCandidates.find((url) => hasBrokerLogoVersionQuery(url))
        || orderedLogoCandidates.find(Boolean)
        || '';

    const webTerminalTitle = getWebTerminalTitle();
    const brokerName = useMemo(() => {
        const candidates = [
            accountBrokerName,
            brokerInfo.brokerName,
            brokerChrome.brokerName,
            storedBrokerName,
            matchedDirectoryBroker?.broker_name,
            brokerDisplayName(storedBrokerServer || brokerId || ''),
        ];
        const specific = candidates.find(isSpecificBrokerLabel);
        if (specific) return specific.trim();
        return candidates.find((value) => isBrokerName(value))?.trim() || webTerminalTitle;
    }, [accountBrokerName, brokerChrome.brokerName, brokerId, brokerInfo.brokerName, matchedDirectoryBroker?.broker_name, storedBrokerName, storedBrokerServer, webTerminalTitle]);

    const brandTitle = formatBrandTitleLabel(brokerName);
    const serverUrl = brokerInfo.logoBaseCandidates?.[0]
        || matchedDirectoryBroker?.server_url
        || sessionScope.serverUrl
        || '';

    return {
        brokerId,
        brokerName,
        brandTitle,
        logoUrl,
        serverUrl,
        brokerInfo,
        matchedDirectoryBroker,
        isSpecificBrokerLabel,
    };
}
