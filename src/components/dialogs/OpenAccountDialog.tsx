import { useUiTranslation } from '../../hooks/useUiTranslation';
import { getAuthenticatedAccountName } from '../../utils/accountDisplayName';
import { getBrokerSavedAccountTypes, resolveTradingAccountType, type TradingAccountType } from '../../services/tradingAccountType';
import React, { useCallback, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useDialogFocusScope } from '../../hooks/useDialogFocusScope';
import { useDraggableSheet } from '../../hooks/useDraggableSheet';
import { createPortal } from 'react-dom';
import { X, Search, ChevronRight, ArrowRight, Building2, Shield, Globe, Check, CheckCircle2, Copy, Eye, EyeOff, Loader2 } from 'lucide-react';
import { copyTextToClipboard } from '../../utils/clipboard';
import { tradeApi } from '../../api/trade';
import { parseTokenExpiresAt } from '../../api/client';
import { BROKER_DISCOVERY_URL, normalizeBrokerServerUrl, toLocalDevProxyUrl, updateDynamicUrls } from '../../config/api';
import {
    isDesktopBackendTarget,
    getRuntimeBrokerConfiguration,
    normalizeBrokerInfoForTarget,
    resolveBrokerBackendUrl,
    resolveBrokerExtApiUrl,
} from '../../config/backendTarget.js';
import { isBrokerSuspended, type BrokerDiscoveryItem } from '../../services/brokerDiscovery';
import { resolveRealAccountAvailability } from '../../services/realAccountAvailability';
import { getCachedBrokerDirectory, loadAppBrokerDirectory } from '../../services/brokerDirectory';
import { persistBrokerSessionDiscovery } from '../../services/brokerSession';
import { useAppStore } from '../../store/useAppStore';
import type { BrokerServer } from '../../types/api';
import { CountryCombobox } from './CountryCombobox';
import './open-account-dialog.css';
import { TradeAuthDialog } from '../TradeAuthDialog';
import {
    appendBrokerLogoVersionParam,
    BrokerLogoImage,
    isPlaceholderBrokerLogoUrl,
    normalizeSameOriginHttpsUrl,
} from '../BrokerLogoImage';
import { getCachedAccountSession, rememberAccountSession } from '../../services/accountSessionCache';
import { loadSavedLogin, saveLogin, supportsSavedLogins } from '../../services/savedLogins';

// Palette cycling for broker avatar gradients
const GRADIENTS = [
    { from: '#1d4ed8', to: '#0e7490' },
    { from: '#059669', to: '#0d9488' },
    { from: '#7c3aed', to: '#4f46e5' },
    { from: '#d97706', to: '#b45309' },
    { from: '#dc2626', to: '#9f1239' },
    { from: '#0891b2', to: '#0369a1' },
    { from: '#6d28d9', to: '#7c3aed' },
    { from: '#065f46', to: '#047857' },
];

const initials = (name: string) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const buildOpenAccountBrokerLogoSource = (broker: BrokerServer) => {
    const rawLogo = appendBrokerLogoVersionParam(
        broker.logo_url,
        broker.logo_version || broker.logo_updated_at,
    );
    const normalizedLogo = rawLogo && !isPlaceholderBrokerLogoUrl(rawLogo)
        ? toLocalDevProxyUrl(normalizeSameOriginHttpsUrl(rawLogo))
        : '';
    return {
        ...broker,
        logo_url: normalizedLogo,
        server_url: broker.server_url || broker.backend_url || BROKER_DISCOVERY_URL || undefined,
    };
};

const BrokerAvatar: React.FC<{ broker: BrokerServer }> = ({ broker }) => (
    <BrokerLogoImage
        broker={buildOpenAccountBrokerLogoSource(broker)}
        alt=""
        appFallbackUrl=""
        className="rtx-open-account-dialog__logo object-contain"
        fallback={(
            <div className="rtx-open-account-dialog__avatar rtx-open-account-dialog__initials" aria-hidden="true">
                {initials(broker.broker_name)}
            </div>
        )}
    />
);

const DropdownBrokerLogo: React.FC<{ broker: BrokerServer; index: number }> = ({ broker, index }) => {
    const grad = GRADIENTS[index % GRADIENTS.length];
    const [exhaustedKey, setExhaustedKey] = useState<string>('');
    const brokerSource = buildOpenAccountBrokerLogoSource(broker);
    const logoKey = `${brokerSource.broker_id || ''}|${brokerSource.logo_url || ''}|${brokerSource.server_url || ''}`;
    const isExhausted = exhaustedKey === logoKey;

    if (isExhausted) {
        return (
            <div
                className="rtx-open-account-dialog__avatar w-5 h-5 rounded flex items-center justify-center text-white font-semibold text-[12px] flex-shrink-0"
                style={{ background: `linear-gradient(135deg, ${grad.from} 0%, ${grad.to} 100%)` }}
            >
                {initials(broker.broker_name)}
            </div>
        );
    }

    return (
        <div className="w-5 h-5 rounded bg-white flex items-center justify-center overflow-hidden flex-shrink-0 border border-white/10">
            <BrokerLogoImage
                broker={brokerSource}
                alt={broker.broker_name}
                appFallbackUrl=""
                className="w-full h-full object-contain p-0.5"
                onExhausted={() => setExhaustedKey(logoKey)}
                fallback={(
                    <div
                        className="rtx-open-account-dialog__avatar w-5 h-5 rounded flex items-center justify-center text-white font-semibold text-[12px] flex-shrink-0"
                        style={{ background: `linear-gradient(135deg, ${grad.from} 0%, ${grad.to} 100%)` }}
                    >
                        {initials(broker.broker_name)}
                    </div>
                )}
            />
        </div>
    );
};

interface Props {
    isOpen: boolean;
    onClose: () => void;
    forceDemoCreation?: boolean;
    anchorRef?: React.RefObject<HTMLElement | null>;
}

type CreatedAccount = {
    login?: number | string;
    api_key?: string;
    broker_id?: string;
    group?: string;
    balance?: number | string;
    currency?: string;
    leverage?: number | string;
    master_password?: string;
    investor_password?: string;
    server?: string;
};

type AccountType = 'demo' | 'real' | 'existing';

type AccountFormData = {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    country: string;
    currency: string;
    leverage: string;
};

const EMPTY_ACCOUNT_FORM: AccountFormData = {
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    country: 'US',
    currency: 'USD',
    leverage: '100',
};

type CreatedAccountSummaryRow = {
    label: string;
    value: React.ReactNode;
    mono?: boolean;
    primary?: boolean;
    small?: boolean;
};

const buildBrokerApiV2BaseUrl = (value: string): string =>
    `${toLocalDevProxyUrl(normalizeBrokerServerUrl(value).replace(/\/$/, ''))}/api/v2`;

const getErrorMessage = (err: unknown, fallback: string): string =>
    err instanceof Error ? err.message : fallback;

const isSummaryRow = (row: CreatedAccountSummaryRow | false | null | undefined): row is CreatedAccountSummaryRow =>
    Boolean(row);

const isValidEmail = (value: string): boolean =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

const mapDiscoveryBroker = (broker: BrokerDiscoveryItem, index: number): BrokerServer => ({
    ...broker,
    id: broker.id ?? broker.broker_id ?? index,
    broker_id: String(broker.broker_id || broker.id || '').trim(),
    broker_name: String(broker.broker_name || broker.name || broker.broker_id || broker.id || '').trim(),
    server: String(broker.server || broker.server_url || broker.backend_url || broker.broker_id || '').trim(),
    server_url: typeof broker.server_url === 'string' ? broker.server_url : undefined,
    backend_url: typeof broker.backend_url === 'string' ? broker.backend_url : undefined,
    market_api_url: typeof broker.market_api_url === 'string' ? broker.market_api_url : undefined,
    server_ip: typeof broker.server_ip === 'string' ? broker.server_ip : undefined,
    server_port: typeof broker.server_port === 'number' ? broker.server_port : undefined,
    ws_url: typeof broker.ws_url === 'string' ? broker.ws_url : undefined,
    feed_url: typeof broker.feed_url === 'string' ? broker.feed_url : undefined,
    feed_ws_url: typeof broker.feed_ws_url === 'string' ? broker.feed_ws_url : undefined,
    feed_status_url: typeof broker.feed_status_url === 'string' ? broker.feed_status_url : undefined,
    region: typeof broker.region === 'string' ? broker.region : undefined,
    logo_url: typeof broker.logo_url === 'string' ? broker.logo_url : undefined,
    enabled: broker.enabled !== false,
});

const availableDirectoryBrokers = (rows: BrokerDiscoveryItem[]): BrokerServer[] => rows
    .filter(broker => !isBrokerSuspended(broker))
    .map(mapDiscoveryBroker)
    .filter(broker => Boolean(broker.broker_id && broker.broker_name));

export const OpenAccountDialog: React.FC<Props> = (props) => {
    if (!isDesktopBackendTarget()) {
        const storeState = typeof useAppStore.getState === 'function' ? useAppStore.getState() : undefined;
        const runtimeConfig = getRuntimeBrokerConfiguration();
        const { hasDemoAndRealAccounts } = getBrokerSavedAccountTypes(storeState?.savedAccounts, {
            brokerId: runtimeConfig.brokerId || (typeof localStorage !== 'undefined' ? localStorage.getItem('broker_id') : ''),
            server: runtimeConfig.defaultMt5Server || (typeof localStorage !== 'undefined' ? localStorage.getItem('rtx_broker_server') : ''),
            serverUrl: runtimeConfig.apiHost || runtimeConfig.apiHostExt || (typeof localStorage !== 'undefined' ? localStorage.getItem('server_url') : ''),
        });
        return (
            <TradeAuthDialog
                isOpen={props.isOpen}
                onClose={props.onClose}
                initialMode={props.forceDemoCreation ? 'demo' : (hasDemoAndRealAccounts ? 'login' : 'demo')}
                allowDemoCreation={props.forceDemoCreation}
                anchorRef={props.anchorRef}
                intent={null}
                onAuthenticated={props.onClose}
            />
        );
    }
    return <DesktopOpenAccountDialog {...props} />;
};

const pickPreferredBrokerId = (mapped: BrokerServer[], preferCurrentBroker: boolean): string => {
    if (mapped.length === 0) return '';
    if (!preferCurrentBroker) return String(mapped[0].id);

    const runtimeConfig = getRuntimeBrokerConfiguration();
    const readStorage = (key: string): string => {
        if (typeof localStorage === 'undefined') return '';
        try {
            return String(localStorage.getItem(key) || '').trim();
        } catch {
            return '';
        }
    };
    const storedBrokerId = (readStorage('broker_id') || readStorage('rtx_broker_id') || String(runtimeConfig.brokerId || '')).trim().toLowerCase();
    const storedBrokerName = (readStorage('broker_name') || String(runtimeConfig.brokerName || '')).trim().toLowerCase();
    const storedServerUrl = (readStorage('server_url') || readStorage('backend_url') || readStorage('rtx_broker_server') || String(runtimeConfig.apiHost || runtimeConfig.apiHostExt || ''))
        .trim().replace(/\/+$/, '').toLowerCase();

    const matched = (storedBrokerId && mapped.find(b => String(b.broker_id || '').trim().toLowerCase() === storedBrokerId))
        || (storedBrokerName && mapped.find(b => String(b.broker_name || '').trim().toLowerCase() === storedBrokerName))
        || (storedServerUrl && mapped.find(b => String(b.server_url || b.backend_url || b.server || '').trim().replace(/\/+$/, '').toLowerCase() === storedServerUrl))
        || mapped[0];

    return matched ? String(matched.id) : '';
};

const readCurrentTimestampMs = (): number => Date.now();

const resolveBrokerCredentialScope = (targetBroker: BrokerServer | undefined): { brokerId: string; serverUrl: string } => {
    if (!targetBroker) return { brokerId: '', serverUrl: '' };
    const normalizedBroker = normalizeBrokerInfoForTarget(targetBroker);
    const brokerId = String(normalizedBroker.broker_id || targetBroker.broker_id || '').trim();
    const serverUrl = resolveBrokerExtApiUrl({ ...targetBroker, ...normalizedBroker });
    return { brokerId, serverUrl };
};

const lookupCachedAccountPassword = (loginValue: string, targetBroker: BrokerServer | undefined): string => {
    const trimmedLogin = loginValue.trim();
    if (!trimmedLogin || !targetBroker) return '';
    const { brokerId, serverUrl } = resolveBrokerCredentialScope(targetBroker);
    const cached = getCachedAccountSession({ brokerId, serverUrl, login: trimmedLogin });
    return cached?.password ?? '';
};

const buildInitialDirectoryState = (preferCurrentBroker: boolean) => {
    const cached = getCachedBrokerDirectory();
    const mapped = availableDirectoryBrokers(cached || []);
    return {
        brokers: mapped,
        loading: cached === null,
        selected: pickPreferredBrokerId(mapped, preferCurrentBroker),
    };
};

const DesktopOpenAccountDialog: React.FC<Props> = (props) => {
    if (!props.isOpen) return null;
    return <OpenDesktopAccountDialog key={String(props.forceDemoCreation ?? false)} {...props} />;
};

const OpenDesktopAccountDialog: React.FC<Props> = ({ isOpen, onClose, forceDemoCreation = false, anchorRef }) => {
    const tr = useUiTranslation();
    const isDesktopShell = typeof window !== 'undefined' && Boolean(window.electron?.window);
    const minStep = forceDemoCreation ? 2 : 0;
    const [initialDirectory] = useState(() => buildInitialDirectoryState(forceDemoCreation));
    const [step, setStep] = useState(minStep);
    const [anchoredLeft, setAnchoredLeft] = useState<number | null>(null);
    const [brokers, setBrokers] = useState<BrokerServer[]>(initialDirectory.brokers);
    const [loadingBrokers, setLoadingBrokers] = useState(initialDirectory.loading);
    const [selected, setSelected] = useState<string>(initialDirectory.selected);
    const [directoryError, setDirectoryError] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [accountType, setAccountType] = useState<AccountType>('demo');

    // "Connect existing" sub-form state
    const [existingLogin, setExistingLogin] = useState('');
    const [existingPassword, setExistingPassword] = useState('');
    const [showExistingPassword, setShowExistingPassword] = useState(false);
    const [existingServerSearch, setExistingServerSearch] = useState('');
    const [existingServerDropOpen, setExistingServerDropOpen] = useState(false);
    const [existingBroker, setExistingBroker] = useState<BrokerServer | null>(null);
    const [formData, setFormData] = useState<AccountFormData>(EMPTY_ACCOUNT_FORM);
    const [termsAccepted, setTermsAccepted] = useState(false);
    const [createdAccount, setCreatedAccount] = useState<CreatedAccount | null>(null);
    // Broker-returned classification of the created account. The success
    // copy is driven from this (not the requested type) so a mismatch
    // fails closed instead of claiming a real account was created.
    const [createdAccountType, setCreatedAccountType] = useState<TradingAccountType | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [createError, setCreateError] = useState('');
    const [validationError, setValidationError] = useState('');
    const [copiedField, setCopiedField] = useState<string | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const { dragStyle, dragHandleProps } = useDraggableSheet({ isOpen, elementRef: dialogRef });
    const searchRef = useRef<HTMLInputElement>(null);
    const firstNameRef = useRef<HTMLInputElement>(null);
    const existingPasswordInputRef = useRef<HTMLInputElement>(null);
    const mountedRef = useRef(false);
    const requestSeqRef = useRef(0);
    const existingLoginRef = useRef('');
    const existingBrokerRef = useRef<BrokerServer | null>(null);
    const closeDialog = () => {
        setCopiedField(null);
        setExistingPassword('');
        setShowExistingPassword(false);
        setCreateError('');
        setValidationError('');
        onClose();
    };
    const handleCopyCredential = async (label: string, value: string) => {
        if (!value) return;
        const ok = await copyTextToClipboard(value);
        if (ok) setCopiedField(label);
    };
    const existingPasswordCopied = Boolean(existingPassword) && copiedField === 'existing-password';
    useEffect(() => {
        existingLoginRef.current = existingLogin;
        existingBrokerRef.current = existingBroker;
    }, [existingLogin, existingBroker]);

    useEffect(() => {
        if (!copiedField) return undefined;
        const timer = window.setTimeout(() => setCopiedField(null), 1600);
        return () => window.clearTimeout(timer);
    }, [copiedField]);
    useDialogFocusScope({ isOpen, dialogRef, onClose: closeDialog, initialFocusRef: forceDemoCreation ? firstNameRef : searchRef });

    useLayoutEffect(() => {
        if (!isOpen || !anchorRef) {
            setAnchoredLeft(null);
            return undefined;
        }
        const updateAnchoredLeft = () => {
            const anchorRect = anchorRef.current?.getBoundingClientRect();
            if (!anchorRect || anchorRect.width <= 0) {
                setAnchoredLeft(null);
                return;
            }
            const dialogWidth = dialogRef.current?.getBoundingClientRect().width || 520;
            const viewportWidth = window.innerWidth;
            let nextLeft: number;
            if (anchorRect.right + dialogWidth + 16 <= viewportWidth) {
                nextLeft = Math.round(anchorRect.right);
            } else if (anchorRect.left - dialogWidth >= 16) {
                nextLeft = Math.round(anchorRect.left - dialogWidth);
            } else {
                nextLeft = Math.max(16, Math.round(viewportWidth - dialogWidth - 16));
            }
            setAnchoredLeft(nextLeft);
        };
        updateAnchoredLeft();
        window.addEventListener('resize', updateAnchoredLeft);
        return () => window.removeEventListener('resize', updateAnchoredLeft);
    }, [anchorRef, isOpen, step]);

    const prefillCachedPassword = useCallback((loginValue: string, targetBroker: BrokerServer | undefined) => {
        const cachedPassword = lookupCachedAccountPassword(loginValue, targetBroker);
        if (cachedPassword) {
            setExistingPassword(current => current || cachedPassword);
        }
    }, []);

    const applyDirectory = useCallback((rows: BrokerDiscoveryItem[]) => {
        const mapped = availableDirectoryBrokers(rows);
        const nextSelected = pickPreferredBrokerId(mapped, forceDemoCreation);
        setBrokers(mapped);
        setSelected(nextSelected);
        const targetBroker = existingBrokerRef.current || mapped.find(b => String(b.id) === nextSelected);
        prefillCachedPassword(existingLoginRef.current, targetBroker);
    }, [forceDemoCreation, prefillCachedPassword]);

    const startBrokerDirectoryRequest = useCallback((seq: number) => {
        void loadAppBrokerDirectory({ forceRefresh: true, desktop: isDesktopBackendTarget() })
            .then(rows => {
                if (mountedRef.current && seq === requestSeqRef.current) {
                    applyDirectory(rows);
                }
            })
            .catch(err => {
                console.warn('[OpenAccountDialog] Could not load brokers:', err);
                if (mountedRef.current && seq === requestSeqRef.current) {
                    setDirectoryError('Broker servers are unavailable. Please try again.');
                }
            })
            .finally(() => {
                if (mountedRef.current && seq === requestSeqRef.current) {
                    setLoadingBrokers(false);
                }
            });
    }, [applyDirectory]);

    const runBrokerDirectoryLoad = useCallback(() => {
        // Retry used to bump a directory attempt that shared the open-reset
        // effect, so a failed directory load cleared the wizard before reload.
        setStep(minStep);
        setSearchQuery('');
        setAccountType('demo');
        setExistingLogin('');
        setExistingPassword('');
        setShowExistingPassword(false);
        setCopiedField(null);
        setExistingServerSearch('');
        setExistingServerDropOpen(false);
        setExistingBroker(null);
        existingLoginRef.current = '';
        existingBrokerRef.current = null;
        setFormData(EMPTY_ACCOUNT_FORM);
        setTermsAccepted(false);
        setCreatedAccount(null);
        setCreatedAccountType(null);
        setCreateError('');
        setValidationError('');
        setDirectoryError('');
        const cached = getCachedBrokerDirectory();
        applyDirectory(cached || []);
        setLoadingBrokers(cached === null);
        requestSeqRef.current += 1;
        startBrokerDirectoryRequest(requestSeqRef.current);
    }, [applyDirectory, minStep, startBrokerDirectoryRequest]);

    useEffect(() => {
        mountedRef.current = true;
        requestSeqRef.current += 1;
        startBrokerDirectoryRequest(requestSeqRef.current);
        return () => {
            mountedRef.current = false;
        };
    }, [startBrokerDirectoryRequest]);

    useEffect(() => {
        const trimmedLogin = existingLogin.trim();
        const targetBroker = existingBroker || brokers.find(b => String(b.id) === selected);
        if (!trimmedLogin || !targetBroker) return;
        if (lookupCachedAccountPassword(trimmedLogin, targetBroker)) return;
        const { brokerId, serverUrl } = resolveBrokerCredentialScope(targetBroker);
        if (!brokerId || !serverUrl || !supportsSavedLogins()) return;
        let cancelled = false;
        void loadSavedLogin({ brokerId, serverUrl }, trimmedLogin)
            .then(saved => {
                if (!cancelled && saved?.password) {
                    setExistingPassword(current => current || saved.password);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [existingLogin, existingBroker, brokers, selected]);

    const filteredBrokers = searchQuery.trim()
        ? brokers.filter(b =>
            String(b.broker_name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
            String(b.server || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
            String(b.broker_id || '').toLowerCase().includes(searchQuery.toLowerCase())
        )
        : brokers;
    const existingFilteredBrokers = existingServerSearch.trim()
        ? brokers.filter(broker =>
            String(broker.broker_name || '').toLowerCase().includes(existingServerSearch.toLowerCase()) ||
            String(broker.server || '').toLowerCase().includes(existingServerSearch.toLowerCase()) ||
            String(broker.broker_id || '').toLowerCase().includes(existingServerSearch.toLowerCase())
        )
        : brokers;

    const selectedBroker = brokers.find(b => String(b.id) === selected);
    // Real-account creation is broker-config driven: this build's
    // self-registration wiring provisions demo accounts only, so the Real
    // option is available only when the selected broker's config advertises
    // a real-account onboarding contract. No broker is named here.
    const realAccountAvailability = resolveRealAccountAvailability(selectedBroker);
    const realAccountSupported = realAccountAvailability.supported;
    const runtimeConfiguration = isDesktopBackendTarget() ? null : getRuntimeBrokerConfiguration();
    const termsUrl = runtimeConfiguration?.valid ? runtimeConfiguration.brokerTermsUrl : '';
    const storeStateForBroker = typeof useAppStore.getState === 'function' ? useAppStore.getState() : undefined;
    const { hasDemoAndRealAccounts } = getBrokerSavedAccountTypes(
        storeStateForBroker?.savedAccounts,
        selectedBroker
            ? {
                  brokerId: selectedBroker.broker_id,
                  brokerName: selectedBroker.broker_name,
                  server: selectedBroker.server,
                  serverUrl: selectedBroker.server_url || selectedBroker.backend_url,
              }
            : undefined,
    );
    const suppressAccountCreation = !forceDemoCreation && hasDemoAndRealAccounts;
    const effectiveAccountType: AccountType = suppressAccountCreation ? 'existing' : accountType;
    const activeExistingBroker = existingBroker || (effectiveAccountType === 'existing' ? selectedBroker || null : null);

    const resolveSelectedBrokerRouting = (broker: BrokerServer | undefined = selectedBroker) => {
        if (!broker) throw new Error('Please select a broker server.');
        const normalizedBroker = normalizeBrokerInfoForTarget(broker);
        const submitBroker: BrokerServer = {
            ...broker,
            ...normalizedBroker,
            id: broker.id,
            broker_id: String(normalizedBroker.broker_id || broker.broker_id),
            broker_name: broker.broker_name,
            server: String(normalizedBroker.broker_server || normalizedBroker.server_url || broker.server),
        };
        const brokerServerUrl = resolveBrokerBackendUrl(submitBroker);
        const brokerExtApiUrl = resolveBrokerExtApiUrl(submitBroker);
        if (!brokerExtApiUrl) throw new Error('The selected broker does not provide an API endpoint.');
        return { submitBroker, brokerServerUrl, brokerExtApiUrl };
    };

    const connectExistingAccount = async () => {
        const normalizedLogin = existingLogin.trim();
        if (!/^\d+$/.test(normalizedLogin) || Number(normalizedLogin) <= 0) {
            throw new Error('Enter a valid positive account ID.');
        }
        if (!existingPassword) throw new Error('Password is required.');

        const { submitBroker, brokerServerUrl, brokerExtApiUrl } = resolveSelectedBrokerRouting(existingBroker || selectedBroker);
        const data = await tradeApi.auth.login({
            username: normalizedLogin,
            password: existingPassword,
            broker_id: submitBroker.broker_id,
        }, {
            baseUrl: buildBrokerApiV2BaseUrl(brokerExtApiUrl),
            skipDynamicUrl: true,
        });

        const token = data.access_token || data.token;
        if (!token) throw new Error('No authentication token received.');
        const accountId = String(data.account_login ?? normalizedLogin);
        const loginNumber = Number.parseInt(accountId, 10);
        if (!Number.isFinite(loginNumber) || loginNumber <= 0) {
            throw new Error('The broker did not return a valid account login.');
        }

        const prevState = useAppStore.getState();
        const prevToken = prevState.authToken || localStorage.getItem('auth_token');
        if (prevState.isAuthenticated && prevState.accountId && prevToken) {
            rememberAccountSession({
                brokerId: localStorage.getItem('broker_id') || localStorage.getItem('rtx_broker_id') || submitBroker.broker_id,
                serverUrl: localStorage.getItem('server_url') || localStorage.getItem('backend_url') || brokerServerUrl,
                login: prevState.accountId,
                authToken: prevToken,
                refreshToken: prevState.refreshToken || localStorage.getItem('refresh_token') || undefined,
                expiresAt: prevState.tokenExpiresAt || undefined,
            });
        }

        persistBrokerSessionDiscovery({
            ...submitBroker,
            ...data,
            access_token: token,
            broker_id: data.broker_id || submitBroker.broker_id,
            backend_url: data.backend_url || brokerServerUrl,
            market_api_url: data.market_api_url || brokerExtApiUrl,
            server_url: data.server_url || data.broker_server || brokerServerUrl,
            ws_url: data.ws_url || submitBroker.ws_url,
            feed_url: data.feed_url || submitBroker.feed_url || submitBroker.feed_ws_url,
            feed_ws_url: data.feed_ws_url || submitBroker.feed_ws_url,
            feed_status_url: data.feed_status_url || submitBroker.feed_status_url,
            logo_url: data.logo_url?.trim() || submitBroker.logo_url,
        });
        updateDynamicUrls();

        const expiresAt = parseTokenExpiresAt(data.expires_at) ?? undefined;
        const tradingAccountType = resolveTradingAccountType(data);
        const resolvedBrokerId = String(data.broker_id || submitBroker.broker_id || '').trim();
        const resolvedServerUrl = String(data.server_url || data.broker_server || brokerServerUrl || brokerExtApiUrl || '').trim();
        const candidateBrokerIds = Array.from(new Set([resolvedBrokerId, submitBroker.broker_id].filter(Boolean)));
        for (const brokerId of candidateBrokerIds) {
            rememberAccountSession({
                brokerId,
                serverUrl: resolvedServerUrl,
                login: accountId,
                authToken: token,
                refreshToken: data.refresh_token,
                expiresAt,
                password: existingPassword,
            });
            if (brokerExtApiUrl && brokerExtApiUrl !== resolvedServerUrl) {
                rememberAccountSession({
                    brokerId,
                    serverUrl: brokerExtApiUrl,
                    login: accountId,
                    authToken: token,
                    refreshToken: data.refresh_token,
                    expiresAt,
                    password: existingPassword,
                });
            }
        }
        if (existingPassword && candidateBrokerIds.length > 0 && supportsSavedLogins()) {
            const candidateUrls = Array.from(new Set([resolvedServerUrl, brokerExtApiUrl].filter(Boolean)));
            for (const brokerId of candidateBrokerIds) {
                for (const url of candidateUrls) {
                    void saveLogin({ brokerId, serverUrl: url }, accountId, existingPassword).catch(() => undefined);
                }
            }
        }
        const store = useAppStore.getState();
        store.setAuthTokens(token, data.refresh_token, expiresAt);
        store.setAuthenticated(true, accountId, token, data.refresh_token, expiresAt, {
            login: loginNumber,
            name: getAuthenticatedAccountName(data),
            server: submitBroker.broker_name || submitBroker.broker_id,
            ...(tradingAccountType ? { accountType: tradingAccountType, isLive: tradingAccountType === 'real' } : {}),
            lastUsed: readCurrentTimestampMs(),
        });
        localStorage.setItem('rtx_last_login', accountId);
        localStorage.setItem('rtx_saved_username', accountId);
        localStorage.removeItem('rtx_saved_password');
        closeDialog();
    };

    // Shared creation wiring for demo and (when the broker config advertises
    // a real-account onboarding contract) real accounts. No parallel flow:
    // both types collect details through the same steps and submit through
    // the same broker account-creation endpoint.
    const createTradingAccount = async (requestedType: AccountType) => {
        const { submitBroker, brokerExtApiUrl } = resolveSelectedBrokerRouting();
        const request = {
            name: `${formData.firstName.trim()} ${formData.lastName.trim()}`,
            email: formData.email.trim(),
            phone: formData.phone.trim() || undefined,
            country: formData.country,
            currency: formData.currency,
            leverage: Number.parseInt(formData.leverage, 10),
        };
        const response = await tradeApi.account.create(request, {
            baseUrl: buildBrokerApiV2BaseUrl(brokerExtApiUrl),
            skipDynamicUrl: true,
        });
        const responseRecord = response as unknown as Record<string, unknown>;
        const accountRecord = responseRecord?.account && typeof responseRecord.account === 'object'
            ? responseRecord.account as CreatedAccount
            : response as CreatedAccount;
        if (!accountRecord?.login) {
            throw new Error(requestedType === 'real'
                ? 'The broker did not return the new real account login.'
                : 'The broker did not return the new demo account login.');
        }
        setCreatedAccount({
            ...accountRecord,
            broker_id: accountRecord.broker_id || submitBroker.broker_id,
        });
        // Classify from the broker-returned payload via the existing path
        // so the success copy reflects what was created, not what was asked.
        const brokerReturnedType = resolveTradingAccountType(response, accountRecord) ?? 'demo';
        setCreatedAccountType(brokerReturnedType);
        const createdLogin = Number.parseInt(String(accountRecord.login), 10);
        if (Number.isSafeInteger(createdLogin) && createdLogin > 0) {
            const createdAccountType = brokerReturnedType;
            const createdBrokerId = String(accountRecord.broker_id || submitBroker.broker_id || '').trim();
            const storeState = useAppStore.getState();
            const activeSameBrokerAccount = storeState.isAuthenticated
                ? storeState.savedAccounts?.find(
                    item => String(item.login) === String(storeState.accountId)
                        && String(item.brokerId || '').toLowerCase() === createdBrokerId.toLowerCase(),
                )
                : undefined;
            const activeBrokerId = typeof localStorage !== 'undefined'
                ? String(localStorage.getItem('broker_id') || localStorage.getItem('rtx_broker_id') || '').trim()
                : '';
            const activeServerUrl = typeof localStorage !== 'undefined'
                ? String(localStorage.getItem('server_url') || localStorage.getItem('backend_url') || '').trim()
                : '';
            const createdServerUrl = activeSameBrokerAccount?.serverUrl
                || (
                    activeBrokerId
                    && activeBrokerId.toLowerCase() === createdBrokerId.toLowerCase()
                    && activeServerUrl
                        ? activeServerUrl
                        : (resolveBrokerBackendUrl(submitBroker) || submitBroker.server_url || submitBroker.backend_url || brokerExtApiUrl)
                );
            const createdToken = String(
                (responseRecord?.access_token as string)
                || (responseRecord?.token as string)
                || ((accountRecord as unknown as Record<string, unknown>)?.access_token as string)
                || ((accountRecord as unknown as Record<string, unknown>)?.token as string)
                || '',
            ).trim();
            const createdPassword = String(accountRecord.master_password || '').trim();
            const candidateBrokerIds = Array.from(new Set([createdBrokerId, submitBroker.broker_id].filter(Boolean)));
            for (const brokerId of candidateBrokerIds) {
                rememberAccountSession({
                    brokerId,
                    serverUrl: createdServerUrl,
                    login: createdLogin,
                    authToken: createdToken || undefined,
                    password: createdPassword || undefined,
                });
                if (brokerExtApiUrl && brokerExtApiUrl !== createdServerUrl) {
                    rememberAccountSession({
                        brokerId,
                        serverUrl: brokerExtApiUrl,
                        login: createdLogin,
                        authToken: createdToken || undefined,
                        password: createdPassword || undefined,
                    });
                }
            }
            if (createdPassword && candidateBrokerIds.length > 0 && supportsSavedLogins()) {
                const candidateUrls = Array.from(new Set([createdServerUrl, brokerExtApiUrl].filter(Boolean)));
                for (const brokerId of candidateBrokerIds) {
                    for (const url of candidateUrls) {
                        void saveLogin({ brokerId, serverUrl: url }, String(createdLogin), createdPassword).catch(() => undefined);
                    }
                }
            }
            useAppStore.getState().addSavedAccount?.({
                login: createdLogin,
                name: request.name,
                server: accountRecord.server || submitBroker.broker_name || submitBroker.broker_id,
                brokerId: createdBrokerId,
                serverUrl: createdServerUrl,
                accountType: createdAccountType,
                isLive: createdAccountType === 'real',
                lastUsed: readCurrentTimestampMs(),
            });
        }
        setStep(4);
    };

    const handleNext = async () => {
        setValidationError('');
        setCreateError('');

        if (step === 0) {
            if (!selectedBroker) {
                setValidationError('Please select a broker server.');
                return;
            }
            if (suppressAccountCreation) {
                setAccountType('existing');
                setExistingBroker(selectedBroker);
                prefillCachedPassword(existingLogin, selectedBroker);
            }
            setStep(1);
            return;
        }

        if (step === 1 && effectiveAccountType === 'existing') {
            try {
                setIsCreating(true);
                await connectExistingAccount();
            } catch (err: unknown) {
                setValidationError(getErrorMessage(err, 'Authentication failed'));
            } finally {
                setIsCreating(false);
            }
            return;
        }

        if (step === 1 && accountType === 'real' && !realAccountSupported) {
            // Stale selection for a broker without a real-account onboarding
            // contract (e.g. the broker changed after the type was picked):
            // explain and stay open instead of advancing or closing.
            setValidationError(realAccountAvailability.reason);
            return;
        }

        if (step === 1) {
            setStep(2);
            return;
        }

        if (step === 2 && accountType === 'real' && !realAccountSupported) {
            // The terminal has no real-account creation contract for this
            // broker configuration: guide back to the account-type choice
            // instead of closing the dialog without effect.
            setValidationError(realAccountAvailability.reason);
            setStep(1);
            return;
        }

        if (step === 2) {
            if (!formData.firstName.trim() || !formData.lastName.trim()) {
                setValidationError('First name and last name are required.');
                return;
            }
            if (!isValidEmail(formData.email)) {
                setValidationError('Enter a valid email address.');
                return;
            }
            if (isDesktopShell && !formData.country) {
                setValidationError('Select a country from the list.');
                return;
            }
            setStep(3);
            return;
        }

        if (step === 3) {
            if (!Number.isFinite(Number(formData.leverage)) || Number(formData.leverage) <= 0) {
                setValidationError('Select a valid leverage.');
                return;
            }
            if (!termsAccepted) {
                setValidationError('Accept the terms and data protection policy to continue.');
                return;
            }
            try {
                setIsCreating(true);
                await createTradingAccount(accountType);
            } catch (err: unknown) {
                setCreateError(getErrorMessage(err, accountType === 'real' ? 'Failed to create real account' : 'Failed to create demo account'));
            } finally {
                setIsCreating(false);
            }
            return;
        }

        closeDialog();
    };

    const handleBack = () => { if (step > minStep) setStep(step - 1); };

    // ─── Step 0: Broker Selection ───────────────────────────────────────────────
    const renderStep0 = () => (
        <div className="rtx-open-account-dialog__broker-step">
            {/* Search bar */}
            <div className="rtx-open-account-dialog__search">
                <Search aria-hidden="true" />
                <input
                    ref={searchRef}
                    type="text"
                    aria-label={tr("Search brokers")}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder={tr("Search broker name or server address…")}
                />
            </div>

            {/* Section header */}
            <div className="rtx-open-account-dialog__list-heading">
                <span>
                    {tr("Available Brokers")}</span>
                <span className="rtx-open-account-dialog__count" aria-live="polite">
                    {loadingBrokers ? '…' : filteredBrokers.length}
                </span>
            </div>

            {/* Broker list */}
            <div className="rtx-open-account-dialog__broker-list" aria-label={tr("Available Brokers")} aria-busy={loadingBrokers}>
                {loadingBrokers ? (
                    <div className="rtx-open-account-dialog__empty flex flex-col items-center gap-2 py-10 text-[14px] font-normal text-zinc-600" role="status">
                        <Loader2 className="w-6 h-6 animate-spin opacity-50" />
                        <p>{tr("Loading brokers…")}</p>
                    </div>
                ) : directoryError ? (
                    <div className="rtx-open-account-dialog__empty py-6 text-center text-[14px] font-normal text-zinc-500">
                        <p role="alert">{tr(directoryError)}</p>
                        <button
                            type="button"
                            className="mt-3 rounded-md border border-[var(--border-primary)] px-4 py-2 text-[var(--text-primary)] hover:bg-[var(--bg-quaternary)]"
                            onClick={runBrokerDirectoryLoad}
                        >
                            {tr('Retry')}
                        </button>
                    </div>
                ) : filteredBrokers.length === 0 ? (
                    <div className="rtx-open-account-dialog__empty py-10 text-center text-[14px] font-normal text-zinc-600" role="status">
                        <Globe className="w-8 h-8 mx-auto mb-2 opacity-30" />
                        <p>{tr("No brokers found")}</p>
                    </div>
                ) : (
                    filteredBrokers.map(broker => {
                        const isSelected = selected === String(broker.id);
                        return (
                            <button
                                type="button"
                                key={broker.id}
                                aria-pressed={isSelected}
                                onClick={() => {
                                    setSelected(String(broker.id));
                                    prefillCachedPassword(existingLogin, existingBroker || broker);
                                }}
                                onDoubleClick={handleNext}
                                data-selected={isSelected}
                                className="rtx-open-account-dialog__broker rtx-open-account-dialog__broker-row"
                            >
                                {/* Avatar */}
                                <BrokerAvatar broker={broker} />

                                {/* Info */}
                                <div className="rtx-open-account-dialog__broker-info">
                                    <div className="rtx-open-account-dialog__broker-heading">
                                        <span className="rtx-open-account-dialog__broker-name truncate">
                                            {broker.broker_name}
                                        </span>
                                        {broker.region && (
                                            <span
                                                className="rtx-open-account-dialog__badge"
                                            >
                                                <Globe aria-hidden="true" />
                                                {broker.region}
                                            </span>
                                        )}
                                    </div>
                                    <div className="rtx-open-account-dialog__broker-id">
                                        <span className="truncate">{broker.broker_id}</span>
                                    </div>
                                </div>

                                {isSelected
                                    ? <CheckCircle2 className="rtx-open-account-dialog__selected-icon" aria-hidden="true" />
                                    : <ChevronRight className="rtx-open-account-dialog__row-chevron" aria-hidden="true" />}
                            </button>
                        );
                    })
                )}
            </div>

            {selectedBroker && !isDesktopShell && (
                <div className="rtx-open-account-dialog__selection" role="status">
                    <span><CheckCircle2 aria-hidden="true" />{tr("Selected broker")}</span>
                    <strong title={selectedBroker.broker_name}>{selectedBroker.broker_name}</strong>
                </div>
            )}
        </div>
    );

    // ─── Step 1: Account Type ───────────────────────────────────────────────────
    const renderStep1 = () => (
        <div className="rtx-open-account-dialog__step">
            <div className="rtx-open-account-dialog__options">
                {!suppressAccountCreation && <>
                <label className="rtx-open-account-dialog__option group" data-selected={effectiveAccountType === 'demo'}>
                    <div className="rtx-open-account-dialog__option-radio">
                        <input aria-label={tr("Demo account")} type="radio" checked={effectiveAccountType === 'demo'} onChange={() => { setAccountType('demo'); setValidationError(''); }} className="w-4 h-4 accent-indigo-500" />
                    </div>
                    <div className="rtx-open-account-dialog__option-copy">
                        <div className="rtx-open-account-dialog__option-title">{tr("Open a demo account to trade virtual money without risk")}</div>
                        <div className="rtx-open-account-dialog__option-desc">{tr("A demo account allows you to learn trading on stock exchanges and test your strategies without risking real money.")}</div>
                    </div>
                </label>

                <label className="rtx-open-account-dialog__option group" data-selected={effectiveAccountType === 'real'} aria-disabled={!realAccountSupported}>
                    <div className="rtx-open-account-dialog__option-radio">
                        <input aria-label={tr("Real account")} type="radio" checked={effectiveAccountType === 'real'} disabled={!realAccountSupported} aria-describedby={!realAccountSupported ? 'rtx-real-account-unavailable-reason' : undefined} onChange={() => { setAccountType('real'); setValidationError(''); }} className="w-4 h-4 accent-indigo-500 disabled:cursor-not-allowed disabled:opacity-50" />
                    </div>
                    <div className="rtx-open-account-dialog__option-copy">
                        <div className="rtx-open-account-dialog__option-title">{tr("Open a real account for live trading")}</div>
                        <div className="rtx-open-account-dialog__option-desc">{tr("A real account requires additional proof of identity. You will need to provide copies of identification documents.")}</div>
                        {!realAccountSupported && (
                            <div id="rtx-real-account-unavailable-reason" role="note" className="rtx-open-account-dialog__warning rtx-open-account-dialog__warning--inline">
                                <Shield className="rtx-open-account-dialog__warning-icon" aria-hidden="true" />
                                <span className="rtx-open-account-dialog__warning-text">
                                    {selectedBroker?.broker_name || tr('The selected broker')} — {tr(realAccountAvailability.reason)}
                                </span>
                            </div>
                        )}
                    </div>
                </label>

                {realAccountSupported && realAccountAvailability.onboardingUrl && (
                    <div className="pl-2">
                        <a
                            href={realAccountAvailability.onboardingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[12.5px] font-medium text-indigo-400 hover:text-indigo-300"
                        >
                            {tr("Continue verification on the broker website")}
                        </a>
                    </div>
                )}</>}
                <label className="rtx-open-account-dialog__option group" data-selected={effectiveAccountType === 'existing'}>
                    <div className="rtx-open-account-dialog__option-radio">
                        <input
                            aria-label={tr("Existing account")}
                            type="radio"
                            checked={effectiveAccountType === 'existing'}
                            onChange={() => {
                                const nextBroker = selectedBroker || null;
                                setAccountType('existing');
                                setExistingBroker(nextBroker);
                                setValidationError('');
                                prefillCachedPassword(existingLogin, nextBroker || undefined);
                            }}
                            className="w-4 h-4 accent-indigo-500"
                        />
                    </div>
                    <div className="rtx-open-account-dialog__option-copy">
                        <div className="rtx-open-account-dialog__option-title">{tr("Connect with an existing trade account")}</div>
                        {effectiveAccountType === 'existing' && (
                            <div className="mt-2.5 flex flex-col gap-2">
                                <div className="flex items-center gap-2.5">
                                    <span className="w-16 flex-shrink-0 text-right text-[12.5px] leading-5 font-medium text-zinc-400">{tr("Login:")}</span>
                                    <input
                                        aria-label={tr("Existing account ID")}
                                        inputMode="numeric"
                                        autoComplete="username"
                                        enterKeyHint="next"
                                        type="text"
                                        value={existingLogin}
                                        onChange={e => {
                                            const nextLogin = e.target.value;
                                            setExistingLogin(nextLogin);
                                            prefillCachedPassword(nextLogin, existingBroker || selectedBroker);
                                        }}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                                                e.preventDefault();
                                                existingPasswordInputRef.current?.focus();
                                            }
                                        }}
                                        className="h-[32px] flex-1 rounded-md border border-zinc-700 bg-transparent px-2.5 text-[13px] font-normal text-white outline-none focus:border-indigo-500"
                                        placeholder={tr("Account ID")}
                                    />
                                </div>
                                <div className="flex items-center gap-2.5">
                                    <span className="w-16 flex-shrink-0 text-right text-[12.5px] leading-5 font-medium text-zinc-400">{tr("Password:")}</span>
                                    <div className="rtx-open-account-dialog__password-wrap">
                                        <input
                                            ref={existingPasswordInputRef}
                                            aria-label={tr("Existing account password")}
                                            autoComplete="off"
                                            spellCheck={false}
                                            autoCorrect="off"
                                            autoCapitalize="none"
                                            enterKeyHint="go"
                                            type="text"
                                            value={existingPassword}
                                            onChange={e => setExistingPassword(e.target.value)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' && !e.nativeEvent.isComposing && !isCreating) {
                                                    e.preventDefault();
                                                    void handleNext();
                                                }
                                            }}
                                            className={`${showExistingPassword ? '' : 'rtx-secret-input '}rtx-open-account-dialog__password-input h-[32px] w-full rounded-md border border-zinc-700 bg-transparent pl-2.5 pr-[58px] text-[13px] font-normal text-white outline-none focus:border-indigo-500`}
                                            placeholder={tr("Password")}
                                        />
                                        <div className="rtx-open-account-dialog__password-actions">
                                            <button
                                                type="button"
                                                className="rtx-open-account-dialog__password-btn"
                                                aria-label={showExistingPassword ? tr("Hide password") : tr("Show password")}
                                                aria-pressed={showExistingPassword}
                                                title={showExistingPassword ? tr("Hide password") : tr("Show password")}
                                                disabled={isCreating}
                                                onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                                                onClick={e => { e.preventDefault(); e.stopPropagation(); setShowExistingPassword(current => !current); }}
                                            >
                                                {showExistingPassword ? <EyeOff className="w-3.5 h-3.5" aria-hidden="true" /> : <Eye className="w-3.5 h-3.5" aria-hidden="true" />}
                                            </button>
                                            <button
                                                type="button"
                                                className={`rtx-open-account-dialog__password-btn${existingPasswordCopied ? ' is-copied' : ''}`}
                                                aria-label={existingPasswordCopied ? tr("Copied") : `${tr("Copy")} ${tr("Password")}`}
                                                title={existingPasswordCopied ? tr("Copied") : tr("Copy")}
                                                disabled={isCreating || !existingPassword}
                                                onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
                                                onClick={e => { e.preventDefault(); e.stopPropagation(); void handleCopyCredential('existing-password', existingPassword); }}
                                            >
                                                {existingPasswordCopied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                                {/* Server dropdown with search */}
                                <div className="flex items-start gap-2.5">
                                    <span className="mt-1.5 w-16 flex-shrink-0 text-right text-[12.5px] leading-5 font-medium text-zinc-400">{tr("Server:")}</span>
                                    <div className="flex-1 relative">
                                        <button
                                            type="button"
                                            onClick={() => setExistingServerDropOpen(o => !o)}
                                            className="rtx-open-account-dialog__server-trigger flex h-[32px] w-full items-center justify-between gap-2 rounded-md border border-zinc-700 bg-[#1a1c23] px-2.5 text-left text-[13px] font-normal outline-none focus:border-indigo-500"
                                        >
                                            <div className="flex items-center gap-2 truncate flex-1">
                                                {activeExistingBroker ? (
                                                    <>
                                                        <DropdownBrokerLogo broker={activeExistingBroker} index={0} />
                                                        <span className="truncate text-zinc-300">
                                                            {activeExistingBroker.broker_name} <span className="font-mono text-[12px] font-normal text-zinc-600">({activeExistingBroker.broker_id})</span>
                                                        </span>
                                                    </>
                                                ) : (
                                                    <span className="text-zinc-600">{tr("Select server…")}</span>
                                                )}
                                            </div>
                                            <ChevronRight className={`w-3 h-3 text-zinc-500 flex-shrink-0 transition-transform ${existingServerDropOpen ? 'rotate-90' : ''}`} />
                                        </button>
                                        {existingServerDropOpen && (
                                            <div className="rtx-open-account-dialog__menu absolute z-50 left-0 right-0 top-full mt-1 bg-[#1e2030] border border-zinc-600/60 rounded-md shadow-xl max-h-[200px] flex flex-col">
                                                <div className="px-2 pt-2 pb-1 border-b border-zinc-700/50">
                                                    <input
                                                        autoFocus
                                                        type="text"
                                                        value={existingServerSearch}
                                                        onChange={e => setExistingServerSearch(e.target.value)}
                                                        placeholder={tr("Search broker or server…")}
                                                        className="h-[26px] w-full rounded border border-zinc-600/40 bg-[#131520] px-2 text-[12.5px] font-normal text-zinc-200 outline-none placeholder:text-zinc-600"
                                                        onClick={e => e.stopPropagation()}
                                                    />
                                                </div>
                                                <div className="overflow-y-auto flex-1">
                                                    {existingFilteredBrokers.map((b, idx) => (
                                                        <button
                                                            key={b.id}
                                                            type="button"
                                                            onClick={() => {
                                                                setExistingBroker(b);
                                                                setExistingServerDropOpen(false);
                                                                setExistingServerSearch('');
                                                                prefillCachedPassword(existingLogin, b);
                                                            }}
                                                            data-selected={existingBroker?.id === b.id}
                                                            className={`rtx-open-account-dialog__broker flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-zinc-700/60 ${existingBroker?.id === b.id ? 'bg-zinc-700/40 font-semibold text-white' : 'font-normal text-zinc-300'}`}
                                                        >
                                                            <DropdownBrokerLogo broker={b} index={idx} />
                                                            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                                                <span className="truncate">{b.broker_name}</span>
                                                                <span className="truncate font-mono text-[11.5px] font-normal text-zinc-500">{b.broker_id}</span>
                                                            </div>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </label>
            </div>
        </div>
    );

    // ─── Step 2: Personal Details ───────────────────────────────────────────────
    const renderDesktopDetails = () => (
        <div className="rtx-account-body">
            <div className="rtx-account-fields">
                {([
                    ['firstName', 'First name', 'given-name', 'text'],
                    ['lastName', 'Last name', 'family-name', 'text'],
                    ['email', 'Email', 'email', 'email'],
                    ['phone', 'Mobile phone', 'tel', 'tel'],
                ] as const).map(([field, label, autoComplete, type]) => (
                    <label className="rtx-account-field" key={field}>
                        <span>{tr(label)}{field === 'phone' && <small>{tr("Optional")}</small>}</span>
                        <input
                            ref={field === 'firstName' ? firstNameRef : undefined}
                            aria-label={tr(label)}
                            autoComplete={autoComplete}
                            type={type}
                            required={field !== 'phone'}
                            value={formData[field]}
                            onChange={event => {
                                setFormData(current => ({ ...current, [field]: event.target.value }));
                                setValidationError('');
                            }}
                        />
                    </label>
                ))}
                <CountryCombobox
                    className="rtx-account-field--wide"
                    value={formData.country}
                    onChange={country => {
                        setFormData(current => ({ ...current, country }));
                        setValidationError('');
                    }}
                    error={validationError === 'Select a country from the list.' ? tr(validationError) : undefined}
                />
            </div>
            <p className="rtx-account-note">{accountType === 'real' ? tr("These details are used to request your real account.") : tr("These details are used to open your demo account.")}</p>
        </div>
    );

    const renderDesktopSettings = () => (
        <div className="rtx-account-body">
            <div className="rtx-account-fields">
                <label className="rtx-account-field">
                    <span>{tr("Currency")}</span>
                    <select aria-label={tr("Currency")} value={formData.currency} onChange={event => setFormData(current => ({ ...current, currency: event.target.value }))}>
                        <option value="USD">USD — US Dollar</option>
                        <option value="EUR">EUR — Euro</option>
                    </select>
                </label>
                <label className="rtx-account-field">
                    <span>{tr("Leverage")}</span>
                    <select aria-label={tr("Leverage")} value={formData.leverage} onChange={event => setFormData(current => ({ ...current, leverage: event.target.value }))}>
                        <option value="100">1:100</option>
                        <option value="200">1:200</option>
                        <option value="500">1:500</option>
                    </select>
                </label>
            </div>
            <div className="rtx-account-consent">
                <label>
                    <input
                        aria-label={tr("Accept account terms")}
                        type="checkbox"
                        checked={termsAccepted}
                        onChange={event => { setTermsAccepted(event.target.checked); setValidationError(''); }}
                    />
                    <span>{tr("I agree with the terms and conditions for opening an account and the data protection policy")}</span>
                </label>
                {termsUrl && <a href={termsUrl} target="_blank" rel="noopener noreferrer">{tr("Terms and data protection policy")}</a>}
            </div>
            {createError && <div role="alert" className="rtx-account-error">{tr(createError)}</div>}
        </div>
    );

    // A real type without a broker-config onboarding contract shows the
    // verification notice (its Next guides back instead of closing); a
    // config-supported real type collects details through the shared forms.
    const renderStep2 = () => accountType === 'real' && !realAccountSupported ? (
        <div className="rtx-open-account-dialog__complete">
            <div className="rtx-open-account-dialog__warning rtx-open-account-dialog__warning--stacked">
                <div className="rtx-open-account-dialog__warning-heading">
                    <Shield className="rtx-open-account-dialog__warning-icon" aria-hidden="true" />
                    <span className="rtx-section-title rtx-open-account-dialog__warning-title">
                        {tr("Identity verification is required")}
                    </span>
                </div>
                <p className="rtx-open-account-dialog__warning-text">
                    {selectedBroker?.broker_name || 'The selected broker'} {tr(" must complete identity checks and approve a live trading agreement before opening a real account.")}
                </p>
                <p className="rtx-open-account-dialog__warning-subtext">
                    {tr("This terminal will not create or fund a real account automatically. Contact the broker through its verified customer-support or onboarding channel.")}
                </p>
            </div>
        </div>
    ) : isDesktopShell ? renderDesktopDetails() : (
        <div className="rtx-open-account-dialog__step">
            <div className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2.5">
                    <span className="w-24 flex-shrink-0 text-right text-[12.5px] leading-5 font-medium text-zinc-400">{tr("First name:")}</span>
                    <input ref={firstNameRef} aria-label={tr("First name")} autoComplete="given-name" type="text" value={formData.firstName} onChange={e => setFormData(s => ({ ...s, firstName: e.target.value }))} className="h-[34px] flex-1 rounded-md border border-indigo-500 bg-transparent px-2.5 text-[13px] font-normal text-white outline-none" />
                </div>
                <div className="flex items-center gap-2.5">
                    <span className="w-24 flex-shrink-0 text-right text-[12.5px] leading-5 font-medium text-zinc-400">{tr("Last name:")}</span>
                    <input aria-label={tr("Last name")} autoComplete="family-name" type="text" value={formData.lastName} onChange={e => setFormData(s => ({ ...s, lastName: e.target.value }))} className="h-[34px] flex-1 rounded-md border border-zinc-700 bg-transparent px-2.5 text-[13px] font-normal text-white outline-none focus:border-indigo-500" />
                </div>
                <div className="flex items-center gap-2.5">
                    <span className="w-24 flex-shrink-0 text-right text-[12.5px] leading-5 font-medium text-zinc-400">{tr("Email:")}</span>
                    <input aria-label={tr("Email")} autoComplete="email" type="email" value={formData.email} onChange={e => setFormData(s => ({ ...s, email: e.target.value }))} className="h-[34px] flex-1 rounded-md border border-zinc-700 bg-transparent px-2.5 text-[13px] font-normal text-white outline-none focus:border-indigo-500" />
                </div>
                <div className="flex items-center gap-2.5">
                    <span className="w-24 flex-shrink-0 text-right text-[12.5px] leading-5 font-medium text-zinc-400">{tr("Mobile Phone:")}</span>
                    <input aria-label={tr("Mobile phone")} autoComplete="tel" type="tel" value={formData.phone} onChange={e => setFormData(s => ({ ...s, phone: e.target.value }))} className="h-[34px] flex-1 rounded-md border border-zinc-700 bg-transparent px-2.5 text-[13px] font-normal text-white outline-none focus:border-indigo-500" />
                </div>
                <div className="flex items-center gap-2.5">
                    <span className="w-24 flex-shrink-0 text-right text-[12.5px] leading-5 font-medium text-zinc-400">{tr("Country:")}</span>
                    <select aria-label={tr("Country")} value={formData.country} onChange={e => setFormData(s => ({ ...s, country: e.target.value }))} className="h-[34px] flex-1 rounded-md border border-zinc-700 bg-[#1a1c23] px-2.5 text-[13px] font-normal text-zinc-300 outline-none">
                        <option value="US">{tr("United States (US)")}</option>
                        <option value="IN">{tr("India (IN)")}</option>
                    </select>
                </div>
            </div>
        </div>
    );

    // ─── Step 3: Account Settings ───────────────────────────────────────────────
    const renderStep3 = () => isDesktopShell ? renderDesktopSettings() : (
        <div className="rtx-open-account-dialog__step">
            <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center gap-2">
                        <span className="w-20 flex-shrink-0 text-right text-[12.5px] leading-5 font-medium text-zinc-400">{tr("Currency:")}</span>
                        <select aria-label={tr("Currency")} value={formData.currency} onChange={e => setFormData(s => ({ ...s, currency: e.target.value }))} className="h-[34px] flex-1 min-w-0 rounded-md border border-zinc-700 bg-[#1a1c23] px-2.5 text-[13px] font-normal text-zinc-300 outline-none">
                            <option value="USD">{tr("USD")}</option>
                            <option value="EUR">{tr("EUR")}</option>
                        </select>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="w-16 flex-shrink-0 text-right text-[12.5px] leading-5 font-medium text-zinc-400">{tr("Leverage:")}</span>
                        <select aria-label={tr("Leverage")} value={formData.leverage} onChange={e => setFormData(s => ({ ...s, leverage: e.target.value }))} className="h-[34px] flex-1 min-w-0 rounded-md border border-zinc-700 bg-[#1a1c23] px-2.5 text-[13px] font-normal text-zinc-300 outline-none">
                            <option value="100">1:100</option>
                            <option value="200">1:200</option>
                            <option value="500">1:500</option>
                        </select>
                    </div>
                </div>
                <div className="rtx-account-consent rtx-account-consent--inline">
                    <label>
                        <input aria-label={tr("Accept account terms")} type="checkbox" checked={termsAccepted} onChange={e => setTermsAccepted(e.target.checked)} />
                        <span>{tr("I agree with the terms and conditions for opening an account and the data protection policy")}</span>
                    </label>
                    {termsUrl && <a href={termsUrl} target="_blank" rel="noopener noreferrer">{tr("Terms and data protection policy")}</a>}
                </div>
                {createError && (
                    <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12.5px] font-normal text-red-400">
                        {tr(createError)}
                    </div>
                )}
            </div>
        </div>
    );

    // ─── Step 4: Success ────────────────────────────────────────────────────────
    const renderStep4 = () => {
        if (!createdAccount) return null;
        // Success copy follows the broker-returned classification stored at
        // creation time. A requested real that came back non-real reports the
        // mismatch instead of claiming a real account was created.
        const createdType = createdAccountType ?? 'demo';
        const createdTypeMismatch = accountType === 'real' && createdType !== 'real';
        return (
            <div className="rtx-open-account-dialog__complete">
                <div className="rtx-open-account-dialog__complete-header">
                    <div className="rtx-open-account-dialog__complete-icon" aria-hidden="true">
                        <CheckCircle2 />
                    </div>
                    <div className="rtx-open-account-dialog__complete-copy">
                        <h3 className="rtx-section-title rtx-open-account-dialog__complete-title">{tr("Registration Complete")}</h3>
                        <p className="rtx-open-account-dialog__complete-subtitle">
                            {createdType === 'real' ? tr("Your real account has been successfully created.") : tr("Your demo account has been successfully created.")}{' '}
                            {tr("Save any credentials returned by the broker.")}
                        </p>
                    </div>
                </div>
                {createdTypeMismatch && (
                    <p role="alert" className="rtx-open-account-dialog__mismatch">
                        {tr("The broker did not create a real account for this request.")}
                    </p>
                )}
                {createdType === 'real' && realAccountAvailability.onboardingUrl && (
                    <a
                        href={realAccountAvailability.onboardingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rtx-open-account-dialog__onboarding-link"
                    >
                        {tr("Continue verification on the broker website")}
                    </a>
                )}
                <div className="rtx-open-account-dialog__surface rtx-open-account-dialog__summary">
                    {[
                        { label: 'Login (Account)', value: createdAccount.login, mono: true, primary: true },
                        createdAccount.master_password && { label: 'Master Password', value: createdAccount.master_password, mono: true },
                        createdAccount.investor_password && { label: 'Investor Password', value: createdAccount.investor_password, mono: true },
                        createdAccount.api_key && { label: 'API Key', value: createdAccount.api_key, mono: true, small: true },
                        { label: 'Broker / Server', value: selectedBroker?.broker_name || createdAccount.broker_id || 'Broker' },
                        createdAccount.group && { label: 'Group', value: createdAccount.group },
                        createdAccount.balance !== undefined && { label: 'Balance', value: `${createdAccount.balance} ${createdAccount.currency || formData.currency}` },
                        { label: 'Leverage', value: `1:${createdAccount.leverage || formData.leverage}` },
                    ].filter(isSummaryRow).map((row) => (
                        <div key={row.label} className="rtx-open-account-dialog__summary-row">
                            <span className="rtx-open-account-dialog__summary-label">{tr(row.label)}</span>
                            <div className="rtx-open-account-dialog__summary-value-wrap">
                                <span
                                    className={`rtx-open-account-dialog__summary-value${row.mono ? ' rtx-open-account-dialog__summary-value--mono' : ''}${row.primary ? ' rtx-open-account-dialog__summary-value--primary' : ''}${row.small ? ' rtx-open-account-dialog__summary-value--truncate' : ''}`}
                                >
                                    {String(row.value)}
                                </span>
                                {row.mono && (
                                    <button
                                        type="button"
                                        onClick={() => { void handleCopyCredential(row.label, String(row.value)); }}
                                        className={`rtx-open-account-dialog__copy-btn${copiedField === row.label ? ' is-copied' : ''}`}
                                        aria-label={`${tr('Copy')} ${tr(row.label)}`}
                                        title={copiedField === row.label ? tr('Copied') : tr('Copy')}
                                    >
                                        {copiedField === row.label ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    const getHeader = () => {
        if (step === 0) return { title: 'Open an Account', sub: 'Select a broker to get started' };
        if (step === 1) return { title: 'Open an account', sub: 'Trade real or virtual money and gain experience' };
        if (step === 2 && accountType === 'real' && !realAccountSupported) return { title: 'Real Account Application', sub: 'Complete identity verification with your broker' };
        if (step === 2) return { title: accountType === 'real' ? 'Real Account Details' : 'Demo Account Details', sub: 'Enter the account holder information' };
        if (step === 3) return { title: accountType === 'real' ? 'Real Account Settings' : 'Demo Account Settings', sub: 'Configure currency and leverage for your new account' };
        return { title: 'Registration Successful', sub: 'Your new account details' };
    };

    const header = getHeader();
    const desktopSteps = forceDemoCreation
        ? ['Details', 'Settings']
        : effectiveAccountType === 'existing'
            ? ['Broker', 'Account type']
            : accountType === 'real' && !realAccountSupported ? ['Broker', 'Account type', 'Verification']
                : ['Broker', 'Account type', 'Details', 'Settings'];
    const isStepValid = (step === 0 || (forceDemoCreation && step === 3)) ? Boolean(selectedBroker) && !loadingBrokers : true;
    const actionLabel = isCreating
        ? effectiveAccountType === 'existing' ? 'Connecting...' : 'Creating...'
        : step === 1 && effectiveAccountType === 'existing' ? 'Connect'
            : step === 2 && accountType === 'real' && !realAccountSupported ? 'Back to account types'
                : step < 3 ? 'Next >'
                    : step === 3 ? (accountType === 'real' ? 'Create Real Account' : 'Create Demo Account')
                        : 'Finish';

    return createPortal(
        <div
            className={`rtx-open-account-backdrop fixed inset-0 z-[9999] flex items-center ${anchoredLeft !== null ? 'justify-start' : 'justify-center'}`}
            style={anchoredLeft !== null ? { justifyContent: 'flex-start', paddingLeft: anchoredLeft } : undefined}
            onClick={e => { e.stopPropagation(); if (e.target === e.currentTarget) closeDialog(); }}
            onMouseDown={e => e.stopPropagation()}
            onTouchStart={e => e.stopPropagation()}
            onPointerDown={e => e.stopPropagation()}
        >
            <div
                ref={dialogRef}
                role="dialog"
                tabIndex={-1}
                aria-modal="true"
                aria-labelledby="rtx-open-account-title"
                aria-describedby="rtx-open-account-description"
                data-step={step}
                style={dragStyle}
                className={`rtx-open-account-dialog ${isDesktopShell ? 'rtx-open-account-dialog--desktop' : ''} relative flex flex-col overflow-hidden`}
            >
                {/* Header */}
                <div className="rtx-open-account-dialog__header flex shrink-0 items-center justify-between gap-3" {...dragHandleProps}>
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                        {step === 0 && (
                            <div className="rtx-open-account-dialog__header-icon flex items-center justify-center" aria-hidden="true">
                                <Building2 className="w-4 h-4 text-white" />
                            </div>
                        )}
                        <div className="min-w-0">
                            <h2 id="rtx-open-account-title" className="rtx-dialog-title break-words text-[20px] leading-7 font-semibold text-white tracking-tight">
                                {isDesktopShell ? tr(header.title) : step > 0 ? tr("Open an Account: {{value0}}", { value0: selectedBroker?.broker_name || tr('Broker') }) : tr(header.title)}
                            </h2>
                            <p id="rtx-open-account-description" className="mt-0.5 text-[14px] font-normal text-zinc-500">{isDesktopShell && step > 0 ? selectedBroker?.broker_name : tr(step > 0 ? header.title : header.sub)}</p>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={closeDialog} className="rtx-open-account-dialog__close" aria-label={tr("Close")} title={tr("Close")}>
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>

                {isDesktopShell && step < 4 && (
                    <ol className="rtx-account-progress" aria-label={tr("Account setup progress")}>
                        {desktopSteps.map((label, index) => {
                            const absoluteStep = index + minStep;
                            return (
                                <li key={label} aria-current={absoluteStep === step ? 'step' : undefined} data-complete={absoluteStep < step}>
                                    <span className="rtx-account-progress__number" aria-hidden="true">{absoluteStep < step ? <CheckCircle2 /> : index + 1}</span>
                                    <span>{tr(label)}</span>
                                </li>
                            );
                        })}
                    </ol>
                )}

                {step === 0 && renderStep0()}
                {step === 1 && renderStep1()}
                {step === 2 && renderStep2()}
                {step === 3 && renderStep3()}
                {step === 4 && renderStep4()}

                {/* Footer */}
                {isDesktopShell ? (
                    <div className="rtx-account-footer">
                        {validationError && validationError !== 'Select a country from the list.' && <p role="alert" className="rtx-account-error">{tr(validationError)}</p>}
                        {!validationError && forceDemoCreation && directoryError && <p role="alert" className="rtx-account-error">{tr(directoryError)}</p>}
                        <div className="rtx-account-footer__actions">
                            {step > minStep && step < 4
                                ? <button type="button" disabled={isCreating} onClick={handleBack}>{tr("Back")}</button>
                                : <span />}
                            <div>
                                <button type="button" disabled={isCreating} onClick={closeDialog}>{tr("Cancel")}</button>
                                <button type="button" onClick={handleNext} disabled={!isStepValid || isCreating} className="rtx-account-primary">
                                    {isCreating && <Loader2 className="animate-spin" aria-hidden="true" />}
                                    {tr(actionLabel === 'Next >' ? 'Next' : actionLabel)}
                                    {!isCreating && actionLabel === 'Next >' && <ArrowRight aria-hidden="true" />}
                                </button>
                            </div>
                        </div>
                    </div>
                ) : <div className="rtx-open-account-dialog__footer">
                    <div className="rtx-open-account-dialog__footer-hint">
                        {(validationError || (forceDemoCreation && directoryError)) ? <span role="alert" className="text-red-400">{tr(validationError || directoryError)}</span> : null}
                    </div>
                    <div className="rtx-open-account-dialog__footer-actions">
                        {step > minStep && step < 4 && (
                            <button
                                type="button"
                                onClick={handleBack}
                            >
                                {tr("< Back")}</button>
                        )}
                        <button
                            type="button"
                            onClick={closeDialog}
                        >
                            {tr("Cancel")}</button>
                        <button
                            type="button"
                            onClick={handleNext}
                            disabled={!isStepValid || isCreating}
                            className="rtx-open-account-dialog__primary"
                        >
                            {isCreating && <Loader2 className="animate-spin" aria-hidden="true" />}
                            {tr(actionLabel === 'Next >' ? 'Next' : actionLabel)}
                            {!isCreating && actionLabel === 'Next >' && <ArrowRight aria-hidden="true" />}
                        </button>
                    </div>
                </div>}
            </div>
        </div>,
        document.body
    );
};

export default OpenAccountDialog;
