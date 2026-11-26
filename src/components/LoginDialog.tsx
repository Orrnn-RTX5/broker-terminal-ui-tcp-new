import { useUiTranslation } from '../hooks/useUiTranslation';
import { useDraggableSheet } from '../hooks/useDraggableSheet';
import { getAuthenticatedAccountName } from '../utils/accountDisplayName';
import { resolveTradingAccountType } from '../services/tradingAccountType';
/**
 * Account login dialog shared by the web and desktop terminals.
 */

import React, { useState, useEffect, useRef, useCallback, useId } from 'react';
import ReactDOM from 'react-dom';
import { useAppStore } from '../store/useAppStore';
import { authV2Api } from '../api/trade';
import { removeToken, setRefreshToken, setToken } from '../api/client';
import { normalizeBrokerServerUrl, updateDynamicUrls, toLocalDevProxyUrl } from '../config/api';
import {
    getBackendTarget,
    getRuntimeBrokerConfiguration,
    isConfiguredBrokerEndpoint,
    isDesktopBackendTarget,
    normalizeBrokerInfoForTarget,
    resolveBrokerBackendUrl,
    resolveBrokerExtApiUrl,
} from '../config/backendTarget.js';
import {
    extractBrokerDiscoveryList,
    formatBrokerDisplayServer,
    getBrokerDirectorySignature,
    getDirectoryBrokerServerUrl,
    isDirectoryBrokerSelectable,
    switchDesktopTcpBroker,
} from '../services/brokerDiscovery';
import { loadAppBrokerDirectory } from '../services/brokerDirectory';
import { persistBrokerSessionDiscovery } from '../services/brokerSession';
import {
    applyBrokerChrome,
    loadBrokerPresentation,
    mergeBrokerPresentation,
} from '../services/brokerPresentation';
import { LAST_AUTHENTICATED_BROKER_ID_KEY, pickDiscoveryBroker, type BrokerServerItem } from './WelcomeTerminal';
import { BrokerLogoImage } from './BrokerLogoImage';
import { User, X, ChevronDown, LockKeyhole, Eye, EyeOff, Copy, Check, LoaderCircle, Server, AlertCircle } from 'lucide-react';
import '../styles/login-dialog.css';
import { useCopyFeedback } from '../hooks/useCopyFeedback';
import { useSavedLogin } from '../hooks/useSavedLogin';
import { rememberAccountSession } from '../services/accountSessionCache';
import {
    beginLoginPerformanceMeasurement,
    markAuthenticationAccepted,
    markAuthenticationRequestStarted,
    markPostAuthenticationPhase,
    scheduleAuthenticatedShellPaintMeasurement,
    waitForLoginFeedbackPaint,
} from '../startup/performanceBudget';

interface LoginDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onLoginSuccess?: (accountId: string) => void;
    initialLogin?: string;
    initialServer?: string;
    reason?: 'trade' | 'add-account';
    /** Prevent this broker-branded terminal from authenticating against another tenant. */
    lockedBrokerId?: string;
    /** Trusted policy display label; never used as the broker identity. */
    lockedBrokerDisplayName?: string;
}

const buildBrokerApiV2BaseUrl = (value: string): string => `${toLocalDevProxyUrl(normalizeBrokerServerUrl(value).replace(/\/$/, ''))}/api/v2`;

const isAbortError = (err: unknown): boolean =>
    err instanceof DOMException
        ? err.name === 'AbortError'
        : Boolean(err && typeof err === 'object' && 'name' in err && err.name === 'AbortError');

const getErrorMessage = (err: unknown, fallback: string): string =>
    err instanceof Error ? err.message : fallback;

const normalizeBrokerId = (value: unknown): string => String(value ?? '').trim();

const buildLockedRuntimeBroker = (brokerId: string, displayName?: string): BrokerServerItem => {
    const backendUrl = getBackendTarget();
    return normalizeBrokerInfoForTarget({
        broker_id: brokerId,
        broker_name: displayName || brokerId,
        backend_url: backendUrl,
        market_api_url: backendUrl,
        server_url: backendUrl,
        logo_url: '',
    }) as BrokerServerItem;
};

export function LoginDialog({
    isOpen,
    onClose,
    onLoginSuccess,
    initialLogin = '',
    initialServer,
    reason,
    lockedBrokerId: requestedLockedBrokerId,
    lockedBrokerDisplayName,
}: LoginDialogProps) {
    const tr = useUiTranslation();
    const dialogId = useId();
    const tradeLogin = reason === 'trade';
    const addAccountLogin = reason === 'add-account';
    const isDesktop = isDesktopBackendTarget();
    const configuration = getRuntimeBrokerConfiguration();
    const lockedBrokerId = isDesktop ? requestedLockedBrokerId : configuration.brokerId;
    const deploymentError = !isDesktop
        ? !configuration.valid
            ? configuration.errors.join(' ') || 'This terminal does not have a broker configured.'
            : requestedLockedBrokerId && requestedLockedBrokerId !== configuration.brokerId
                ? 'This terminal only accepts accounts for its configured broker.'
                : ''
        : '';
    const [directoryLoading, setDirectoryLoading] = useState(false);
    const [directoryRevision, setDirectoryRevision] = useState(0);
    const lastTcpKeyRef = useRef('');
    const submittingRef = useRef(false);
    const [brokerList, setBrokerList] = useState<BrokerServerItem[]>([]);
    const brokerListRef = useRef<BrokerServerItem[]>([]);
    const [selectedBroker, setSelectedBroker] = useState<BrokerServerItem | null>(null);
    const selectedBrokerRef = useRef<BrokerServerItem | null>(null);
    const userSelectedBrokerRef = useRef<BrokerServerItem | null>(null);
    const brokerSelectionSeqRef = useRef(0);
    const resolvedInitialLogin = addAccountLogin
        ? initialLogin
        : (initialLogin || useAppStore.getState().accountId || localStorage.getItem('rtx_saved_username') || '');
    const { login, password, setLogin, setPassword, savePassword, setSavePassword, available: passwordSavingAvailable, restoring, storageError, persistPassword } = useSavedLogin(
        isOpen,
        resolvedInitialLogin,
        selectedBroker ? {
            brokerId: selectedBroker.broker_id,
            serverUrl: isDesktop ? getDirectoryBrokerServerUrl(selectedBroker) : resolveBrokerExtApiUrl(selectedBroker),
        } : null,
        { restoreEmptyLogin: !addAccountLogin },
    );
    const [searchQuery, setSearchQuery] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const { copied: passwordCopied, copy: copyPassword, reset: resetPasswordCopy } = useCopyFeedback();
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [healthStatus, setHealthStatus] = useState<'checking' | 'online' | 'offline' | null>(null);
    const healthStatusRef = useRef<'checking' | 'online' | 'offline' | null>(null);
    const healthCheckUrlRef = useRef<string | null>(null);
    const healthAbortRef = useRef<AbortController | null>(null);
    const presentationAbortRef = useRef<AbortController | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const loginInputRef = useRef<HTMLInputElement>(null);
    const passwordInputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const { dragStyle, dragHandleProps } = useDraggableSheet({ isOpen, elementRef: dialogRef });

    healthStatusRef.current = healthStatus;

    useEffect(() => {
        if (!isOpen) return;
        const previousFocus = document.activeElement as HTMLElement | null;
        return () => { previousFocus?.focus(); };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const onTcpStatus = (event: Event) => {
            const detail = (event as CustomEvent<{ target_tcp?: string; broker_id?: string; broker_name?: string; connected?: boolean }>).detail;
            if (!detail) return;
            const endpointKey = `${detail.broker_id || ''}|${detail.target_tcp || ''}`;
            const prevKey = lastTcpKeyRef.current;
            lastTcpKeyRef.current = endpointKey;
            if (isDesktop && userSelectedBrokerRef.current) return;
            if (!prevKey || prevKey === endpointKey) return;
            const current = selectedBrokerRef.current;
            if (current && (
                (detail.broker_id && String(current.broker_id) === String(detail.broker_id))
                || (detail.target_tcp && String(current.tcp_addr || '') === String(detail.target_tcp))
            )) {
                return;
            }
            setDirectoryRevision(v => v + 1);
        };
        window.addEventListener('rtx5-tcp-status', onTcpStatus);
        return () => window.removeEventListener('rtx5-tcp-status', onTcpStatus);
    }, [isOpen, isDesktop]);
    const loginRequestGenerationRef = useRef(0);
    const isMountedRef = useRef(true);
    const isOpenRef = useRef(isOpen);
    const lockedBrokerDisplayNameRef = useRef(lockedBrokerDisplayName);
    const lockedBrokerKey = normalizeBrokerId(lockedBrokerId);

    isOpenRef.current = isOpen;
    lockedBrokerDisplayNameRef.current = lockedBrokerDisplayName;

    const invalidatePendingLogin = useCallback(() => {
        loginRequestGenerationRef.current += 1;
    }, []);

    const closeDialog = useCallback(() => {
        invalidatePendingLogin();
        setLoading(false);
        setShowPassword(false);
        resetPasswordCopy();
        onClose();
    }, [invalidatePendingLogin, onClose, resetPasswordCopy]);

    // Pre-fill with current account or provided initial login
    useEffect(() => {
        if (!isOpen) {
            lastTcpKeyRef.current = '';
            brokerSelectionSeqRef.current += 1;
            healthCheckUrlRef.current = null;
            healthStatusRef.current = null;
            userSelectedBrokerRef.current = null;
            setHealthStatus(null);
            resetPasswordCopy();
            invalidatePendingLogin();
            return undefined;
        }
        setError(null);
        setShowPassword(false);
        resetPasswordCopy();
        setSearchQuery('');
        const selectTimer = setTimeout(() => loginInputRef.current?.select(), 100);
        return () => clearTimeout(selectTimer);
    }, [isOpen, initialLogin, invalidatePendingLogin, resetPasswordCopy]);

    useEffect(() => {
        if (!password) resetPasswordCopy();
    }, [password, resetPasswordCopy]);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            invalidatePendingLogin();
        };
    }, [invalidatePendingLogin]);

    const runHealthCheck = async (serverUrl: string, targetBrokerId?: string) => {
        const cleanUrl = normalizeBrokerServerUrl(serverUrl).replace(/\/$/, '');
        const healthUrl = `${cleanUrl}${isDesktop ? '/health' : '/api/v2/time'}`;
        if (healthAbortRef.current) {
            healthAbortRef.current.abort();
        }
        const controller = new AbortController();
        healthAbortRef.current = controller;
        healthCheckUrlRef.current = healthUrl;

        healthStatusRef.current = 'checking';
        setHealthStatus('checking');

        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, 8000);

        try {
            if (!isConfiguredBrokerEndpoint(healthUrl)) throw new Error('Broker health URL does not match this deployment.');
            const proxiedHealthUrl = toLocalDevProxyUrl(healthUrl);
            const isSameOriginGateway = typeof window !== 'undefined' && (
                proxiedHealthUrl.startsWith('/')
                || (() => {
                    try {
                        return new URL(proxiedHealthUrl, window.location.origin).origin === window.location.origin;
                    } catch {
                        return false;
                    }
                })()
            );
            const response = await fetch(proxiedHealthUrl, {
                signal: controller.signal,
                cache: 'no-store',
                redirect: 'error',
                credentials: 'omit',
                ...(isSameOriginGateway && targetBrokerId ? { headers: { 'X-Broker-ID': targetBrokerId } } : {}),
            });
            clearTimeout(timeoutId);
            if (healthAbortRef.current !== controller || controller.signal.aborted) return;
            if (response.ok) {
                healthStatusRef.current = 'online';
                setHealthStatus('online');
            } else {
                healthStatusRef.current = 'offline';
                setHealthStatus('offline');
            }
        } catch (err: unknown) {
            clearTimeout(timeoutId);
            if (healthAbortRef.current === controller && (timedOut || !isAbortError(err))) {
                healthStatusRef.current = 'offline';
                setHealthStatus('offline');
            }
        }
    };

    const applySelectedBroker = (item: BrokerServerItem, userInitiated = false) => {
        if (submittingRef.current || (isDesktop && !isDirectoryBrokerSelectable(item))) return;
        setError(null);
        if (lockedBrokerKey && normalizeBrokerId(item.broker_id) !== lockedBrokerKey) return;
        const selectionSeq = ++brokerSelectionSeqRef.current;
        if (userInitiated) {
            userSelectedBrokerRef.current = item;
        }
        const normalizedBroker = normalizeBrokerInfoForTarget(item) as BrokerServerItem;
        const normalizedServerUrl = isDesktop ? getDirectoryBrokerServerUrl(item) : resolveBrokerBackendUrl(normalizedBroker);
        const previousBroker = selectedBrokerRef.current;
        if (isDesktop && previousBroker && (previousBroker.broker_id !== item.broker_id || getDirectoryBrokerServerUrl(previousBroker) !== normalizedServerUrl)) setPassword('');
        const displayServer = formatBrokerDisplayServer(item) || normalizedBroker.display_server || item.broker_name;
        const nextBroker: BrokerServerItem = {
            ...item,
            ...normalizedBroker,
            broker_name: item.broker_name || normalizedBroker.broker_name,
            display_server: displayServer,
            server_url: normalizedServerUrl,
            ...(isDesktop ? { backend_url: normalizedServerUrl, market_api_url: normalizedServerUrl } : {}),
        };
        selectedBrokerRef.current = nextBroker;
        setSelectedBroker(nextBroker);
        setSearchQuery(item.broker_name);
        setDropdownOpen(false);

        applyBrokerChrome({
            brokerId: nextBroker.broker_id,
            brokerName: nextBroker.broker_name,
            logoUrl: nextBroker.logo_url,
            themeColor: nextBroker.theme_color,
        });
        presentationAbortRef.current?.abort();
        const controller = new AbortController();
        presentationAbortRef.current = controller;
        const runPostSelectChecks = () => {
            if (!isMountedRef.current || !isOpenRef.current || brokerSelectionSeqRef.current !== selectionSeq) return;
            void runHealthCheck(normalizedServerUrl, nextBroker.broker_id);
            if (!normalizedServerUrl) return;
            void loadBrokerPresentation({
                broker_id: nextBroker.broker_id,
                server_url: normalizedServerUrl,
            }, controller.signal).then((presentation) => {
                if (!presentation || controller.signal.aborted || brokerSelectionSeqRef.current !== selectionSeq) return;
                const presentationBroker = mergeBrokerPresentation(nextBroker, presentation) as BrokerServerItem;
                setSelectedBroker(current => {
                    if (!current || current.broker_id !== presentationBroker.broker_id) return current;
                    selectedBrokerRef.current = presentationBroker;
                    return presentationBroker;
                });
                applyBrokerChrome({
                    brokerId: presentationBroker.broker_id,
                    brokerName: presentationBroker.broker_name,
                    logoUrl: presentationBroker.logo_url,
                    themeColor: presentationBroker.theme_color,
                });
            }).catch(() => undefined);
        };

        if (isDesktop && nextBroker.tcp_addr) {
            void switchDesktopTcpBroker(nextBroker).finally(runPostSelectChecks);
        } else {
            runPostSelectChecks();
        }
    };

    const handleSelectBroker = (item: BrokerServerItem) => {
        applySelectedBroker(item, true);
    };

    useEffect(() => {
        if (!isOpen || !lockedBrokerKey || !lockedBrokerDisplayName) return;
        setBrokerList(current => current.map(item => (
            normalizeBrokerId(item.broker_id) === lockedBrokerKey
                ? { ...item, broker_name: lockedBrokerDisplayName }
                : item
        )));
        setSelectedBroker(current => (
            current && normalizeBrokerId(current.broker_id) === lockedBrokerKey
                ? { ...current, broker_name: lockedBrokerDisplayName }
                : current
        ));
        setSearchQuery(lockedBrokerDisplayName);
    }, [isOpen, lockedBrokerDisplayName, lockedBrokerKey]);

    // Fetch broker servers from API
    useEffect(() => {
        if (!isOpen) return;
        if (deploymentError) {
            setError(deploymentError);
            setBrokerList([]);
            setSelectedBroker(null);
            setDirectoryLoading(false);
            return;
        }
        let isMounted = true;
        const displayName = lockedBrokerDisplayNameRef.current;
        setDirectoryLoading(true);
        const lockedFallback = lockedBrokerKey
            ? buildLockedRuntimeBroker(String(lockedBrokerId), displayName)
            : null;
        if (lockedFallback) {
            brokerListRef.current = [lockedFallback];
            setBrokerList([lockedFallback]);
            setSelectedBroker(lockedFallback);
            setSearchQuery(lockedFallback.broker_name);
            setDropdownOpen(false);
            void runHealthCheck(resolveBrokerExtApiUrl(lockedFallback), lockedFallback.broker_id);
        }
        const directoryRequest = !isDesktop && !configuration.discoveryBaseUrl
            ? Promise.resolve(lockedFallback ? [lockedFallback] : [])
            : loadAppBrokerDirectory({ forceRefresh: true, desktop: isDesktop });
        directoryRequest
            .then((payload: unknown) => {
                if (!isMounted) return;
                const currentDisplayName = lockedBrokerDisplayNameRef.current;
                const discovered = extractBrokerDiscoveryList(payload) as BrokerServerItem[];
                const data = lockedBrokerKey
                    ? discovered.filter(item => normalizeBrokerId(item.broker_id) === lockedBrokerKey)
                    : discovered;
                if (lockedBrokerKey && currentDisplayName) {
                    data.forEach((item) => { item.broker_name = currentDisplayName; });
                }
                if (lockedBrokerKey && data.length === 0 && lockedFallback) data.push(lockedFallback);
                brokerListRef.current = data;
                setBrokerList(data);

                const tcpStatus = (window as unknown as { __RTX5_TCP_STATUS__?: { broker_id?: string; target_tcp?: string } }).__RTX5_TCP_STATUS__;
                const activeTcpBroker = isDesktop && tcpStatus
                    ? data.find(item => isDirectoryBrokerSelectable(item) && (
                        (tcpStatus.broker_id && item.broker_id === tcpStatus.broker_id)
                        || (tcpStatus.target_tcp && item.tcp_addr === tcpStatus.target_tcp)
                    ))
                    : undefined;
                const userSelected = isDesktop && userSelectedBrokerRef.current
                    ? data.find(item => item.broker_id === userSelectedBrokerRef.current?.broker_id && isDirectoryBrokerSelectable(item))
                    : undefined;
                const savedBrokerId = lockedBrokerId || initialServer || localStorage.getItem('broker_id') || localStorage.getItem('rtx_broker_id') || '';
                const lastAuthenticatedBrokerId = localStorage.getItem(LAST_AUTHENTICATED_BROKER_ID_KEY || 'rtx_last_authenticated_broker_id') || '';
                const selectedDiscoveryBroker = userSelected || activeTcpBroker || pickDiscoveryBroker(data, {
                    isDesktopBrokerSelection: isDesktopBackendTarget(),
                    savedBrokerId,
                    lastAuthenticatedBrokerId,
                });
                if (selectedDiscoveryBroker) {
                    const currentSelected = selectedBrokerRef.current;
                    const sameBrokerSelection = Boolean(
                        currentSelected
                        && healthStatusRef.current === 'online'
                        && currentSelected.broker_id === selectedDiscoveryBroker.broker_id
                        && getDirectoryBrokerServerUrl(currentSelected) === getDirectoryBrokerServerUrl(selectedDiscoveryBroker)
                        && String(currentSelected.tcp_addr || '') === String(selectedDiscoveryBroker.tcp_addr || '')
                        && String(currentSelected.broker_name || '') === String(selectedDiscoveryBroker.broker_name || '')
                    );
                    if (!sameBrokerSelection) {
                        applySelectedBroker(selectedDiscoveryBroker, false);
                    }
                }
            })
            .catch(() => {
                if (!isMounted) return;
                if (!isDesktop && lockedFallback) {
                    brokerListRef.current = [lockedFallback];
                    setBrokerList([lockedFallback]);
                    setSelectedBroker(current => current || lockedFallback);
                    setSearchQuery(current => current || lockedFallback.broker_name);
                    void runHealthCheck(resolveBrokerExtApiUrl(lockedFallback), lockedFallback.broker_id);
                    return;
                }
                setError('Broker servers are unavailable. Please reopen this dialog to retry.');
            })
            .finally(() => { if (isMounted) setDirectoryLoading(false); });
        return () => {
            isMounted = false;
            if (healthAbortRef.current) {
                healthAbortRef.current.abort();
                healthAbortRef.current = null;
            }
            if (healthStatusRef.current === 'checking') {
                healthStatusRef.current = null;
                healthCheckUrlRef.current = null;
            }
            presentationAbortRef.current?.abort();
        };
    }, [isOpen, initialServer, lockedBrokerId, lockedBrokerKey, deploymentError, configuration.discoveryBaseUrl, isDesktop, directoryRevision]);

    // Close dropdown on outside click
    useEffect(() => {
        if (!dropdownOpen) return;
        const handler = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownOpen(false);
                if (selectedBroker) {
                    setSearchQuery(selectedBroker.broker_name);
                }
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [dropdownOpen, selectedBroker]);

    // Handle ESC key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (dropdownOpen) {
                    setDropdownOpen(false);
                    if (selectedBroker) {
                        setSearchQuery(selectedBroker.broker_name);
                    }
                    return;
                }
                closeDialog();
            }
        };
        if (isOpen) document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, closeDialog, dropdownOpen, selectedBroker]);

    // Clean up health probe abort ref on unmount
    useEffect(() => {
        return () => {
            if (healthAbortRef.current) {
                healthAbortRef.current.abort();
            }
        };
    }, []);

    const filteredBrokers = brokerList.filter(b =>
        String(b.broker_name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(b.broker_id || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(b.tcp_addr || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(b.display_server || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(b.region || '').toLowerCase().includes(searchQuery.toLowerCase())
    );

    const handleSubmit = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        if (deploymentError) { setError(deploymentError); return; }
        if (submittingRef.current) return;
        if (restoring) return;
        if (isDesktop && (directoryLoading || !isDirectoryBrokerSelectable(selectedBroker) || healthStatus !== 'online')) {
            setError('Select an available broker server and wait for the server check.');
            return;
        }
        if (!login.trim() || !password.trim()) {
            setError('Login and password are required');
            return;
        }
        if (!selectedBroker) {
            setError('Please select a broker server');
            return;
        }
        if (lockedBrokerKey && normalizeBrokerId(selectedBroker.broker_id) !== lockedBrokerKey) {
            setError('This terminal only accepts accounts for its configured broker.');
            return;
        }

        submittingRef.current = true;
        beginLoginPerformanceMeasurement();
        setLoading(true);
        setError(null);
        void waitForLoginFeedbackPaint();
        const requestGeneration = ++loginRequestGenerationRef.current;
        const isCurrentRequest = () => (
            requestGeneration === loginRequestGenerationRef.current
            && isMountedRef.current
            && isOpenRef.current
        );

        try {
            // Capture the active session's broker scope before discovery storage is updated
            // so switching/adding accounts reliably caches the outgoing account's session.
            const previousBrokerId = localStorage.getItem('broker_id') || localStorage.getItem('rtx_broker_id') || '';
            const previousServerUrl = localStorage.getItem('server_url') || localStorage.getItem('backend_url') || '';

            // Save selected broker details before login so the request targets the broker backend.
            const submitBroker = normalizeBrokerInfoForTarget(selectedBroker) as BrokerServerItem;
            const brokerServerUrl = isDesktop ? getDirectoryBrokerServerUrl(selectedBroker) : resolveBrokerBackendUrl(submitBroker);
            const brokerExtApiUrl = isDesktop ? brokerServerUrl : resolveBrokerExtApiUrl(submitBroker);
            const displayServerLabel = formatBrokerDisplayServer(selectedBroker)
                || String(selectedBroker.display_server || submitBroker.display_server || submitBroker.broker_name || '').trim();
            persistBrokerSessionDiscovery({
                ...submitBroker,
                broker_id: submitBroker.broker_id,
                broker_name: selectedBroker.broker_name || submitBroker.broker_name,
                display_server: displayServerLabel || submitBroker.broker_name,
                broker_server: displayServerLabel || submitBroker.broker_name,
                ...(selectedBroker.tcp_addr ? { tcp_addr: selectedBroker.tcp_addr } : {}),
                backend_url: brokerServerUrl,
                market_api_url: brokerExtApiUrl,
                server_url: brokerServerUrl,
            }, { notifySessionChange: 'routing-changes' });
            updateDynamicUrls();

            if (isDesktop && (selectedBroker.tcp_addr || submitBroker.tcp_addr)) {
                await switchDesktopTcpBroker({
                    broker_id: submitBroker.broker_id || selectedBroker.broker_id,
                    broker_name: selectedBroker.broker_name || submitBroker.broker_name,
                    tcp_addr: selectedBroker.tcp_addr || submitBroker.tcp_addr,
                });
            }

            markAuthenticationRequestStarted();
            const data = await authV2Api.login({
                username: login.trim(),
                password,
                broker_id: submitBroker.broker_id,
            }, {
                baseUrl: buildBrokerApiV2BaseUrl(brokerExtApiUrl),
                skipDynamicUrl: true,
                persistSession: false,
            });
            if (!isCurrentRequest()) return;

            if (lockedBrokerKey && data.broker_id && normalizeBrokerId(data.broker_id) !== lockedBrokerKey) {
                removeToken();
                useAppStore.getState().logout();
                throw new Error('The account belongs to a different broker.');
            }

            const token = data.access_token || data.token;
            if (!token) throw new Error('No authentication token received');
            markAuthenticationAccepted();

            const prevState = useAppStore.getState();
            const prevToken = prevState.authToken || localStorage.getItem('auth_token');
            if (prevState.isAuthenticated && prevState.accountId && prevToken) {
                rememberAccountSession({
                    brokerId: previousBrokerId || localStorage.getItem('broker_id') || localStorage.getItem('rtx_broker_id') || submitBroker.broker_id,
                    serverUrl: previousServerUrl || localStorage.getItem('server_url') || localStorage.getItem('backend_url') || brokerServerUrl,
                    login: prevState.accountId,
                    authToken: prevToken,
                    refreshToken: prevState.refreshToken || localStorage.getItem('refresh_token') || undefined,
                    expiresAt: prevState.tokenExpiresAt || undefined,
                });
            }

            persistBrokerSessionDiscovery({
                ...data,
                access_token: token,
                broker_id: data.broker_id || submitBroker.broker_id,
                broker_name: selectedBroker.broker_name || submitBroker.broker_name,
                display_server: displayServerLabel || submitBroker.broker_name,
                broker_server: displayServerLabel || submitBroker.broker_name,
                ...(selectedBroker.tcp_addr ? { tcp_addr: selectedBroker.tcp_addr } : {}),
                backend_url: data.backend_url || brokerServerUrl,
                market_api_url: data.market_api_url || brokerExtApiUrl,
                server_url: data.server_url || data.broker_server || brokerServerUrl,
                ws_url: data.ws_url || submitBroker.ws_url,
                feed_url: data.feed_url || submitBroker.feed_url || submitBroker.feed_ws_url,
                feed_ws_url: data.feed_ws_url || submitBroker.feed_ws_url,
                feed_status_url: data.feed_status_url || submitBroker.feed_status_url,
                logo_url: data.logo_url?.trim() || submitBroker.logo_url,
                theme_color: submitBroker.theme_color,
            }, { notifySessionChange: false });
            if (displayServerLabel) {
                localStorage.setItem('rtx_broker_server', displayServerLabel);
            }
            localStorage.setItem(
                LAST_AUTHENTICATED_BROKER_ID_KEY || 'rtx_last_authenticated_broker_id',
                String(data.broker_id || submitBroker.broker_id),
            );
            updateDynamicUrls();

            const accountId = data.account_login ?? login.trim();

            try {
                await persistPassword({ brokerId: submitBroker.broker_id, serverUrl: brokerExtApiUrl }, String(accountId), password);
            } catch {
                throw new Error('Unable to save the password. Turn off Save password to log in without saving it.');
            }
            if (!isCurrentRequest()) return;

            localStorage.setItem('rtx_last_login', String(accountId));
            localStorage.setItem('rtx_saved_username', String(accountId));
            localStorage.removeItem('rtx_saved_password');

            setToken(token);
            if (data.refresh_token) {
                setRefreshToken(data.refresh_token);
                sessionStorage.removeItem('refresh_token');
            } else {
                localStorage.removeItem('refresh_token');
                sessionStorage.removeItem('refresh_token');
            }

            let expiresAt: number | undefined = undefined;
            if (data.expires_at) {
                if (typeof data.expires_at === 'number') {
                    expiresAt = data.expires_at < 100000000000 ? data.expires_at * 1000 : data.expires_at;
                } else if (/^\d+$/.test(data.expires_at)) {
                    const num = parseInt(data.expires_at, 10);
                    expiresAt = num < 100000000000 ? num * 1000 : num;
                } else {
                    expiresAt = Date.parse(data.expires_at);
                }
                localStorage.setItem('token_expires_at', String(expiresAt));
                sessionStorage.removeItem('token_expires_at');
            } else if ((data as { expires_in?: unknown }).expires_in) {
                const expiresIn = Number((data as { expires_in?: unknown }).expires_in);
                if (Number.isFinite(expiresIn) && expiresIn > 0) {
                    expiresAt = Date.now() + expiresIn * 1000;
                    localStorage.setItem('token_expires_at', String(expiresAt));
                    sessionStorage.removeItem('token_expires_at');
                }
            } else {
                localStorage.removeItem('token_expires_at');
                sessionStorage.removeItem('token_expires_at');
            }

            markPostAuthenticationPhase('auth-session-persist');
            const loginNum = parseInt(String(accountId), 10);
            const tradingAccountType = resolveTradingAccountType(data);
            const resolvedSessionBrokerId = data.broker_id || submitBroker.broker_id;
            const resolvedSessionServerUrl = data.server_url || data.broker_server || brokerServerUrl || brokerExtApiUrl;
            rememberAccountSession({
                brokerId: resolvedSessionBrokerId,
                serverUrl: resolvedSessionServerUrl,
                login: String(accountId),
                authToken: token,
                refreshToken: data.refresh_token,
                expiresAt,
                password,
            });
            if (submitBroker.broker_id !== resolvedSessionBrokerId || brokerExtApiUrl !== resolvedSessionServerUrl) {
                rememberAccountSession({
                    brokerId: submitBroker.broker_id,
                    serverUrl: brokerExtApiUrl,
                    login: String(accountId),
                    authToken: token,
                    refreshToken: data.refresh_token,
                    expiresAt,
                    password,
                });
            }
            useAppStore.getState().setAuthenticated(
                true,
                String(accountId),
                token,
                data.refresh_token,
                expiresAt,
                !isNaN(loginNum) ? {
                    login: loginNum,
                    name: getAuthenticatedAccountName(data),
                    server: displayServerLabel || submitBroker.broker_name || '',
                    ...(tradingAccountType ? { accountType: tradingAccountType, isLive: tradingAccountType === 'real' } : { isLive: true }),
                    lastUsed: Date.now(),
                } : undefined,
            );
            markPostAuthenticationPhase('auth-store-commit');

            onClose();
            if (onLoginSuccess) {
                onLoginSuccess(String(accountId));
            }
            markPostAuthenticationPhase('auth-handoff');
            scheduleAuthenticatedShellPaintMeasurement();
        } catch (err: unknown) {
            if (!isCurrentRequest()) return;
            console.error('[LoginDialog] Auth error:', err);
            setError(getErrorMessage(err, 'Authentication failed'));
        } finally {
            submittingRef.current = false;
            if (isCurrentRequest()) setLoading(false);
        }
    };

    if (!isOpen) return null;

    const serverStatusLabel = directoryLoading
        ? 'Loading broker servers...'
        : healthStatus === 'checking' ? 'Checking server...'
            : healthStatus === 'online' ? 'Server online'
                : healthStatus === 'offline' ? 'Server unavailable' : null;

    return ReactDOM.createPortal(
        <div className="rtx-login-layer">
            <div className="rtx-login-backdrop" onClick={closeDialog} />

            {/* Dialog */}
            <div
                role="dialog"
                ref={dialogRef}
                aria-modal="true"
                aria-labelledby={`${dialogId}-title`}
                aria-describedby={!tradeLogin ? `${dialogId}-description` : undefined}
                className="rtx-login-dialog rtx-login-dialog--polished"
                style={dragStyle}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={event => {
                    if (event.key !== 'Tab') return;
                    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || []);
                    const first = controls[0];
                    const last = controls[controls.length - 1];
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                }}
            >
                <header className="rtx-login-header" {...dragHandleProps}>
                    <div className="rtx-login-heading">
                        <div className="rtx-login-mark" aria-hidden="true">
                            <User size={20} strokeWidth={2} />
                        </div>
                        <div>
                            <h2 id={`${dialogId}-title`} className="rtx-dialog-title rtx-login-title">{tr(tradeLogin ? "Log in to trade" : addAccountLogin ? "Add another account" : "Login")}</h2>
                            {!tradeLogin && <p id={`${dialogId}-description`} className="rtx-login-description">{tr(addAccountLogin ? "Log in to add another account on this broker." : "Access your trading account.")}</p>}
                        </div>
                    </div>
                    <button type="button" onClick={closeDialog} className="rtx-login-close" aria-label={tr("Close")} title={tr("Close")}>
                        <X size={16} aria-hidden="true" />
                    </button>
                </header>

                <form onSubmit={handleSubmit} className="rtx-login-form" aria-busy={loading}
                    data-rtx-login-form data-login-submit-pending={loading ? 'true' : 'false'}>
                    {isDesktop && (
                        <div className="rtx-login-field">
                            <label htmlFor={`${dialogId}-server`} className="rtx-login-label text-[14px] leading-5 font-medium">{tr("Broker Server")}</label>
                            <div className="rtx-login-control">
                                <Server size={17} className="rtx-login-field-icon" aria-hidden="true" />
                                <select
                                    id={`${dialogId}-server`}
                                    value={selectedBroker?.broker_id || ''}
                                    disabled={loading || directoryLoading || Boolean(lockedBrokerKey)}
                                    onFocus={() => {
                                        if (lockedBrokerKey) return;
                                        void loadAppBrokerDirectory({ forceRefresh: true, desktop: true })
                                            .then((payload: unknown) => {
                                                const discovered = extractBrokerDiscoveryList(payload) as BrokerServerItem[];
                                                if (discovered.length > 0 && getBrokerDirectorySignature(discovered) !== getBrokerDirectorySignature(brokerListRef.current)) {
                                                    brokerListRef.current = discovered;
                                                    setBrokerList(discovered);
                                                }
                                            })
                                            .catch(() => undefined);
                                    }}
                                    onChange={event => {
                                        const broker = brokerList.find(item => String(item.broker_id ?? '') === event.target.value);
                                        if (broker) handleSelectBroker(broker);
                                    }}
                                    className="rtx-login-input rtx-login-select"
                                >
                                    <option value="" disabled>{tr(directoryLoading ? "Loading broker servers..." : "Select broker server")}</option>
                                    {brokerList.map(broker => {
                                        const optionLabel = String(
                                            broker.broker_name
                                            || String(broker.display_server || '').replace(/\s*\([^)]*:\d+\)\s*$/, '').trim()
                                        );
                                        return (
                                            <option key={broker.broker_id} value={broker.broker_id} disabled={!isDirectoryBrokerSelectable(broker)}>
                                                {optionLabel}{!isDirectoryBrokerSelectable(broker) ? ` (${tr("Unavailable")})` : ''}
                                            </option>
                                        );
                                    })}
                                </select>
                                <ChevronDown size={16} className="rtx-login-select-chevron" aria-hidden="true" />
                            </div>
                        </div>
                    )}

                    {/* Login Field */}
                    <div className="rtx-login-field">
                        <label htmlFor={`${dialogId}-account`} className="rtx-login-label text-[14px] leading-5 font-medium">{tr("Account ID")}</label>
                        <div className="rtx-login-control">
                            <User size={17} className="rtx-login-field-icon" aria-hidden="true" />
                            <input
                                id={`${dialogId}-account`}
                                name="username"
                                autoComplete="username"
                                autoCapitalize="none"
                                spellCheck={false}
                                enterKeyHint="next"
                                disabled={loading || (isDesktop && (directoryLoading || healthStatus !== 'online'))}
                                ref={loginInputRef}
                                type="text"
                                value={login}
                                onChange={(e) => setLogin(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                        e.preventDefault();
                                        passwordInputRef.current?.focus();
                                    }
                                }}
                                className="rtx-login-input"
                                placeholder={tr("Account ID")}
                                autoFocus
                            />
                        </div>
                    </div>

                    {/* Password Field */}
                    <div className="rtx-login-field">
                        <label htmlFor={`${dialogId}-password`} className="rtx-login-label text-[14px] leading-5 font-medium">{tr("Password")}</label>
                        <div className="rtx-login-control">
                            <LockKeyhole size={17} className="rtx-login-field-icon" aria-hidden="true" />
                            <input
                                id={`${dialogId}-password`}
                                name="account-key"
                                autoComplete="off"
                                spellCheck={false}
                                autoCorrect="off"
                                autoCapitalize="none"
                                enterKeyHint="go"
                                disabled={loading || (isDesktop && (directoryLoading || healthStatus !== 'online'))}
                                ref={passwordInputRef}
                                type="text"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                        e.preventDefault();
                                        void handleSubmit(e);
                                    }
                                }}
                                className={`rtx-login-input rtx-login-password-input${showPassword ? '' : ' rtx-secret-input'}`}
                                placeholder={tr("Password")}
                            />
                            <div className="rtx-login-password-actions">
                                <button
                                    type="button"
                                    className="rtx-login-password-toggle"
                                    aria-label={tr(showPassword ? "Hide password" : "Show password")}
                                    aria-controls={`${dialogId}-password`}
                                    aria-pressed={showPassword}
                                    title={tr(showPassword ? "Hide password" : "Show password")}
                                    disabled={loading || (isDesktop && (directoryLoading || healthStatus !== 'online'))}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => setShowPassword((current) => !current)}
                                >
                                    {showPassword ? (
                                        <EyeOff size={17} aria-hidden="true" />
                                    ) : (
                                        <Eye size={17} aria-hidden="true" />
                                    )}
                                </button>
                                <button
                                    type="button"
                                    className={`rtx-login-password-toggle${passwordCopied ? ' is-copied' : ''}`}
                                    aria-label={passwordCopied ? tr("Copied") : `${tr("Copy")} ${tr("Password")}`}
                                    aria-controls={`${dialogId}-password`}
                                    title={passwordCopied ? tr("Copied") : tr("Copy")}
                                    disabled={loading || (isDesktop && (directoryLoading || healthStatus !== 'online')) || !password}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => { void copyPassword(password); }}
                                >
                                    {passwordCopied ? (
                                        <Check size={16} aria-hidden="true" />
                                    ) : (
                                        <Copy size={16} aria-hidden="true" />
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Server / Broker Dropdown */}
                    {!isDesktop && <div className="rtx-login-field">
                        <div className="rtx-login-field-heading">
                            <label htmlFor={`${dialogId}-server`} className="rtx-login-label text-[14px] leading-5 font-medium">{tr("Server")}</label>
                            {serverStatusLabel && <span role="status" className="rtx-login-status" data-status={directoryLoading ? 'checking' : healthStatus}>{tr(serverStatusLabel)}</span>}
                        </div>
                        <div ref={dropdownRef}>
                            <div className="rtx-login-control">
                                {selectedBroker ? (
                                    <BrokerLogoImage
                                        broker={selectedBroker}
                                        alt=""
                                        className="rtx-login-broker-logo"
                                        appFallbackUrl=""
                                        fallback={<Server size={17} className="rtx-login-field-icon" aria-hidden="true" />}
                                    />
                                ) : <Server size={17} className="rtx-login-field-icon" aria-hidden="true" />}
                                <input
                                    id={`${dialogId}-server`}
                                    type="text"
                                    autoComplete="off"
                                    disabled={loading || directoryLoading}
                                    value={searchQuery}
                                    onChange={(e) => {
                                        if (lockedBrokerKey) return;
                                        setSearchQuery(e.target.value);
                                        setDropdownOpen(true);
                                    }}
                                    onFocus={() => { if (!lockedBrokerKey) setDropdownOpen(true); }}
                                    readOnly={Boolean(lockedBrokerKey)}
                                    className="rtx-login-input rtx-login-server-input"
                                    placeholder={tr("Search broker...")}
                                    aria-label="Broker server"
                                    aria-readonly={Boolean(lockedBrokerKey)}
                                />
                                {!lockedBrokerKey && <ChevronDown size={16} className={`rtx-login-select-chevron ${dropdownOpen ? 'rotate-180' : ''}`} aria-hidden="true" />}
                            </div>

                            {/* Dropdown panel */}
                            {dropdownOpen && !lockedBrokerKey && (
                                <div className="rtx-login-brokers">
                                    {filteredBrokers.length === 0 ? (
                                        <div className="rtx-login-brokers-empty">{tr("No brokers found")}</div>
                                    ) : (
                                        filteredBrokers.map(item => (
                                            <button
                                                key={item.broker_id}
                                                type="button"
                                                onClick={() => handleSelectBroker(item)}
                                                disabled={loading}
                                                className="rtx-login-broker-option"
                                                data-selected={selectedBroker?.broker_id === item.broker_id}
                                            >
                                                <div className="flex items-center gap-2 truncate">
                                                    <BrokerLogoImage
                                                        broker={item}
                                                        alt=""
                                                        className="w-[16px] h-[16px] rounded object-contain flex-shrink-0"
                                                        appFallbackUrl=""
                                                        fallback={(
                                                            <div className="w-[16px] h-[16px] rounded bg-white/5 flex items-center justify-center text-[10px] text-zinc-500 flex-shrink-0">
                                                                B
                                                            </div>
                                                        )}
                                                    />
                                                    <span className="truncate">{item.broker_name}</span>
                                                </div>
                                                {item.region && (
                                                    <span className="rtx-login-broker-region">
                                                        {item.region}
                                                    </span>
                                                )}
                                            </button>
                                        ))
                                    )}
                                </div>
                            )}

                            {healthStatus === 'offline' && (
                                <div className="rtx-login-offline">
                                    <AlertCircle size={14} aria-hidden="true" />
                                    <span>{tr("Broker server unreachable")}</span>
                                </div>
                            )}
                        </div>
                    </div>}

                    <label className="rtx-login-save-password">
                        <input
                            type="checkbox"
                            name="savePassword"
                            checked={savePassword}
                            onChange={event => setSavePassword(event.target.checked)}
                            disabled={loading || restoring || !passwordSavingAvailable}
                        />
                        <span>{tr("Save password")}</span>
                    </label>
                    {!passwordSavingAvailable && <p className="rtx-login-storage-note">{tr("Password saving is unavailable on this device.")}</p>}
                    {storageError && <p role="status" className="rtx-login-storage-note">{tr(storageError)}</p>}

                    {/* Error */}
                    {error && (
                        <div role="alert" className="rtx-login-error">
                            <AlertCircle size={17} aria-hidden="true" />
                            <span>{error}</span>
                        </div>
                    )}

                    {/* Buttons */}
                    <div className="rtx-login-actions">
                        <button
                            type="button"
                            onClick={onClose}
                            disabled={loading}
                            className="rtx-login-button rtx-login-button--secondary"
                        >
                            {tr(tradeLogin ? "Continue viewing" : "Cancel")}
                        </button>
                        <button
                            type="submit"
                            data-rtx-login-submit
                            data-rtx-login-feedback={loading ? 'true' : undefined}
                            disabled={Boolean(deploymentError) || loading || restoring || !selectedBroker || (isDesktop && (directoryLoading || healthStatus !== 'online'))}
                            className="rtx-login-button rtx-login-button--primary"
                        >
                            {loading ? <LoaderCircle size={16} className="rtx-login-spinner" aria-hidden="true" /> : null}
                            {tr(loading ? "Connecting..." : "Log in")}
                        </button>
                    </div>
                </form>
            </div>
        </div>,
        document.body
    );
}
