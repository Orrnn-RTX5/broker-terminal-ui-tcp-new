import { saveWorkspaceFeature, printSetupFeature, printPreviewFeature, exitConfirmFeature, savePictureFeature, openAccountFeature } from '../../startup/terminalFeatures';
import { useUiTranslation } from '../../hooks/useUiTranslation';
import './file-menu-desktop.css';
import { Icon } from '../ui/Icon';
import { useInlineSubmenuPlacement } from './inlineSubmenuPosition';
import {
    appendBrokerLogoVersionParam,
    BrokerLogoImage,
    hasBrokerLogoVersionQuery,
    isPlaceholderBrokerLogoUrl,
    normalizeSameOriginHttpsUrl,
} from '../BrokerLogoImage';
import React, { Suspense, useState, useEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { RetainedLazyFeature } from '../../startup/RetainedLazyFeature';
import { useAppStore } from '../../store/useAppStore';
import { getBrokerSavedAccountTypes } from '../../services/tradingAccountType';
import { BROKER_CHROME_EVENT, getBrokerChrome, type BrokerChromeState } from '../../services/brokerPresentation';
import { getCommittedBrokerAccountSessionScope, onSessionChange } from '../../services/brokerSession';
import { getCachedBrokerDirectory } from '../../services/brokerDirectory';
import { getRuntimeBrokerConfiguration } from '../../config/backendTarget.js';
import { toLocalDevProxyUrl } from '../../config/api';
import { chartPrinter, type PrintPreferences, type ChartPrintData } from '../../services/chartPrinter';
import {
    getActiveChartSource,
    type ResolvedActiveChartSource,
} from '../../services/activeChartSource';
import { useDockLayoutStore } from '../../store/useDockLayoutStore';
import { useWorkspaceProfileSelectionStore } from '../../store/useWorkspaceProfileSelectionStore';
import { getTerminalShortcutHint } from '../../services/shortcutCatalog';
import { isDesktopBackendTarget } from '../../config/backendTarget.js';
import {
    BUILTIN_WORKSPACE_PROFILE_NAMES,
    deleteWorkspaceProfile,
    listWorkspaceProfiles,
    restoreBuiltinWorkspaceProfile,
    restoreWorkspaceProfile,
    saveCurrentWorkspaceProfile,
    type WorkspaceProfileSummary,
} from '../../services/localWorkspaceProfiles';

const SaveWorkspaceDialog = saveWorkspaceFeature.Component;
const PrintSetupDialog = printSetupFeature.Component;
const PrintPreviewDialog = printPreviewFeature.Component;
const ExitConfirmDialog = exitConfirmFeature.Component;
const SavePictureDialog = savePictureFeature.Component;
const OpenAccountDialog = openAccountFeature.Component;

type ElectronRuntime = NonNullable<Window['electron']> & {
    app?: {
        quit?: () => void;
    };
};

export interface FileMenuProps {
    shortcutsOnly?: boolean;
    profileShortcutsEnabled?: boolean;
    profileSymbols?: readonly string[];
    onSave?: (workspaceName?: string) => void;
    onSaveAsPicture?: () => void;
    onOpenDataFolder?: () => void;
    onPrint?: (chartData: ChartPrintData, preferences: PrintPreferences) => void | Promise<void>;
    onPrintPreview?: () => void;
    onPrintSetup?: () => void;
    onCloseActiveChart?: () => void;
    onChartRestored?: () => void;
    onProfileRestored?: (profileName: string) => void;
    onLoginTrade?: () => void;
    onLoginWebTrader?: () => void;
    accountId?: string;
    brokerId?: string;
    brokerName?: string;
    brokerLogoUrl?: string;
    brokerServerUrl?: string;
    onLogout?: () => void;
    onDialogOpenChange?: (open: boolean) => void;
    onInteractPin?: () => void;
    onExit?: () => void;
    hasUnsavedChanges?: boolean;
}

const readFileMenuStoredValue = (key: string): string => {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return '';
    try {
        return String(window.localStorage.getItem(key) || '').trim();
    } catch {
        return '';
    }
};

const readRuntimeBrokerIdFallback = (): string => {
    try {
        return String(getRuntimeBrokerConfiguration().brokerId || '').trim();
    } catch {
        return '';
    }
};

export const FileMenu: React.FC<FileMenuProps> = ({
    shortcutsOnly = false,
    profileShortcutsEnabled = true,
    profileSymbols,
    onSave,
    onSaveAsPicture,
    onOpenDataFolder,
    onPrint,
    onPrintPreview,
    onPrintSetup,
    onCloseActiveChart,
    onChartRestored,
    onProfileRestored,
    onLoginTrade,
    onLoginWebTrader,
    accountId,
    brokerId,
    brokerName,
    brokerLogoUrl,
    brokerServerUrl,
    onLogout,
    onDialogOpenChange,
    onInteractPin,
    onExit,
    hasUnsavedChanges = false
}) => {
    const tr = useUiTranslation();
    const { t } = useTranslation();
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [showSavePictureDialog, setShowSavePictureDialog] = useState(false);
    const [savePictureSource, setSavePictureSource] = useState<ResolvedActiveChartSource | null>(null);
    const [showPrintSetupDialog, setShowPrintSetupDialog] = useState(false);
    const [showPrintPreviewDialog, setShowPrintPreviewDialog] = useState(false);
    const [showExitDialog, setShowExitDialog] = useState(false);
    const [openAccountDialogMode, setOpenAccountDialogMode] = useState<'default' | 'demo' | null>(null);
    const showOpenAccountDialog = openAccountDialogMode !== null;
    const [openDeletedOpen, setOpenDeletedOpen] = useState(false);
    const [profilesOpen, setProfilesOpen] = useState(false);
    const [deleteSubmenuOpen, setDeleteSubmenuOpen] = useState(false);
    const fileMenuRef = useRef<HTMLDivElement>(null);
    const openDeletedAnchor = useRef<HTMLDivElement>(null);
    const openDeletedSubmenuRef = useRef<HTMLDivElement>(null);
    const profilesAnchor = useRef<HTMLDivElement>(null);
    const profilesSubmenuRef = useRef<HTMLDivElement>(null);
    const deleteAnchor = useRef<HTMLDivElement>(null);
    const deleteSubmenuRef = useRef<HTMLDivElement>(null);
    const hoverOpenedDeletedRef = useRef(false);
    const hoverOpenedProfilesRef = useRef(false);
    const hoverOpenedDeleteRef = useRef(false);
    const openDeletedPlacement = useInlineSubmenuPlacement(openDeletedOpen, openDeletedAnchor, openDeletedSubmenuRef, 'open-deleted');
    const profilesPlacement = useInlineSubmenuPlacement(profilesOpen, profilesAnchor, profilesSubmenuRef, 'profiles');
    const deletePlacement = useInlineSubmenuPlacement(deleteSubmenuOpen, deleteAnchor, deleteSubmenuRef, 'delete-profile');
    const closeFileSubmenus = () => {
        hoverOpenedDeletedRef.current = false;
        hoverOpenedProfilesRef.current = false;
        hoverOpenedDeleteRef.current = false;
        setOpenDeletedOpen(false);
        setProfilesOpen(false);
        setDeleteSubmenuOpen(false);
    };
    const effectiveAccount = accountId?.trim() || 'default';
    const activeProfileName = useWorkspaceProfileSelectionStore(state => (
        state.accountId === effectiveAccount ? state.profileName : 'Default'
    ));
    const setActiveProfileName = (name: string) => {
        useWorkspaceProfileSelectionStore.getState().selectProfile(effectiveAccount, name);
    };
    const [workspaceProfiles, setWorkspaceProfiles] = useState<WorkspaceProfileSummary[]>([]);
    const recentlyClosedCharts = useDockLayoutStore(state => state.recentlyClosedCharts);
    const isAuthenticated = useAppStore(state => state.isAuthenticated);
    const savedAccounts = useAppStore(state => state.savedAccounts);
    const { hasDemoAndRealAccounts } = getBrokerSavedAccountTypes(savedAccounts);
    const hideOpenAccountOption = Boolean(isAuthenticated && hasDemoAndRealAccounts);
    const isDesktopShell = typeof window !== 'undefined' && Boolean(window.electron?.window);
    const [brokerChrome, setBrokerChrome] = useState<BrokerChromeState>(() => getBrokerChrome());
    const [, bumpSessionRevision] = useReducer((value: number) => value + 1, 0);

    useEffect(() => {
        if (shortcutsOnly || typeof window === 'undefined') return undefined;
        const onBrokerChrome = (event: Event) => {
            const detail = (event as CustomEvent<BrokerChromeState>).detail;
            setBrokerChrome(detail || getBrokerChrome());
        };
        window.addEventListener(BROKER_CHROME_EVENT, onBrokerChrome);
        const unsubscribeSession = onSessionChange((reason) => {
            if (reason !== 'token_rotation') bumpSessionRevision();
        });
        return () => {
            window.removeEventListener(BROKER_CHROME_EVENT, onBrokerChrome);
            unsubscribeSession();
        };
    }, [shortcutsOnly]);

    const activeBrokerLogo = (() => {
        if (shortcutsOnly) return { brokerSource: null, alt: '' };

        const sessionScope = getCommittedBrokerAccountSessionScope();
        const storedBrokerId = readFileMenuStoredValue('broker_id')
            || readFileMenuStoredValue('rtx_broker_id')
            || String(sessionScope.brokerId || '').trim()
            || readRuntimeBrokerIdFallback();
        const effectiveBrokerId = String(brokerId || brokerChrome.brokerId || storedBrokerId || '').trim();
        const chromeMatchesActiveBroker = !brokerChrome.brokerId
            || !effectiveBrokerId
            || brokerChrome.brokerId.trim().toLowerCase() === effectiveBrokerId.toLowerCase();

        const storedServerUrl = readFileMenuStoredValue('rtx_broker_server')
            || readFileMenuStoredValue('server_url')
            || readFileMenuStoredValue('backend_url');
        const effectiveScopeServer = String(brokerServerUrl || sessionScope.serverUrl || storedServerUrl || '').trim();

        const cachedDirectory = getCachedBrokerDirectory() || [];
        const matchedDirectoryBroker = cachedDirectory.find((entry) => {
            if (effectiveBrokerId && String(entry.broker_id || '').trim() === effectiveBrokerId) return true;
            const entryServer = String(entry.server_url || '').trim().replace(/\/+$/, '').toLowerCase();
            const scopeServer = effectiveScopeServer.replace(/\/+$/, '').toLowerCase();
            return Boolean(entryServer && scopeServer && entryServer === scopeServer);
        });

        const cleanLogoUrl = (raw: unknown): string => {
            const trimmed = normalizeSameOriginHttpsUrl(String(raw || '').trim());
            if (!trimmed || isPlaceholderBrokerLogoUrl(trimmed)) return '';
            return toLocalDevProxyUrl(trimmed);
        };

        const propLogo = cleanLogoUrl(brokerLogoUrl);
        const chromeLogo = chromeMatchesActiveBroker ? cleanLogoUrl(brokerChrome.logoUrl) : '';
        const directoryLogo = cleanLogoUrl(
            appendBrokerLogoVersionParam(
                matchedDirectoryBroker?.logo_url,
                (matchedDirectoryBroker as { logo_version?: string; logo_updated_at?: string } | undefined)?.logo_version
                || (matchedDirectoryBroker as { logo_updated_at?: string } | undefined)?.logo_updated_at,
            ),
        );
        const storedLogo = cleanLogoUrl(readFileMenuStoredValue('logo_url'));
        const orderedLogos = [propLogo, chromeLogo, directoryLogo, storedLogo].filter(Boolean);
        const resolvedLogoUrl = orderedLogos.find((url) => hasBrokerLogoVersionQuery(url))
            || orderedLogos[0]
            || '';

        const resolvedBrokerName = String(
            brokerName
            || (chromeMatchesActiveBroker ? brokerChrome.brokerName : '')
            || readFileMenuStoredValue('broker_name')
            || matchedDirectoryBroker?.broker_name
            || '',
        ).trim();
        const resolvedServerUrl = String(
            brokerServerUrl
            || matchedDirectoryBroker?.server_url
            || sessionScope.serverUrl
            || storedServerUrl
            || '',
        ).trim();

        const brokerSource = resolvedLogoUrl || effectiveBrokerId
            ? {
                broker_id: effectiveBrokerId,
                broker_name: resolvedBrokerName,
                logo_url: resolvedLogoUrl,
                server_url: resolvedServerUrl,
            }
            : null;

        return {
            brokerSource,
            alt: resolvedBrokerName
                ? `${resolvedBrokerName} Logo`
                : (effectiveBrokerId ? `${effectiveBrokerId} Logo` : 'Active broker logo'),
        };
    })();

    const avatarBrokerKey = activeBrokerLogo.brokerSource
        ? `${activeBrokerLogo.brokerSource.broker_id}|${activeBrokerLogo.brokerSource.logo_url}|${activeBrokerLogo.brokerSource.server_url}`
        : '';
    const [avatarMediaState, setAvatarMediaState] = useState<{
        key: string;
        exhausted: boolean;
        wideBanner: boolean;
    }>({ key: '', exhausted: false, wideBanner: false });
    const currentAvatarMedia = avatarMediaState.key === avatarBrokerKey
        ? avatarMediaState
        : { key: avatarBrokerKey, exhausted: false, wideBanner: false };
    const showingBrokerImage = Boolean(avatarBrokerKey) && !currentAvatarMedia.exhausted;

    useEffect(() => {
        const selection = useWorkspaceProfileSelectionStore.getState();
        if (shortcutsOnly || selection.accountId !== effectiveAccount) {
            selection.selectProfile(effectiveAccount, 'Default');
        }
        setShowSaveDialog(false);
        hoverOpenedDeletedRef.current = false;
        hoverOpenedProfilesRef.current = false;
        hoverOpenedDeleteRef.current = false;
        setOpenDeletedOpen(false);
        setProfilesOpen(false);
        setDeleteSubmenuOpen(false);
    }, [effectiveAccount, shortcutsOnly]);

    useEffect(() => {
        const refreshProfiles = () => {
            try {
                setWorkspaceProfiles(listWorkspaceProfiles(effectiveAccount));
            } catch (error) {
                console.warn('[FileMenu] Could not load workspace profiles:', error);
                setWorkspaceProfiles([]);
            }
        };

        const handleProfileSelected = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.accountId === effectiveAccount && detail?.name) {
                useWorkspaceProfileSelectionStore.getState().selectProfile(effectiveAccount, detail.name);
                refreshProfiles();
            }
        };

        refreshProfiles();
        window.addEventListener('workspace:profile-saved', handleProfileSelected);
        window.addEventListener('workspace:profile-restored', handleProfileSelected);
        window.addEventListener('workspace:profile-deleted', refreshProfiles);
        return () => {
            window.removeEventListener('workspace:profile-saved', handleProfileSelected);
            window.removeEventListener('workspace:profile-restored', handleProfileSelected);
            window.removeEventListener('workspace:profile-deleted', refreshProfiles);
        };
    }, [effectiveAccount]);

    useEffect(() => {
        onDialogOpenChange?.(
            showSaveDialog
            || showSavePictureDialog
            || showPrintSetupDialog
            || showPrintPreviewDialog
            || showExitDialog
            || showOpenAccountDialog,
        );
    }, [
        onDialogOpenChange,
        showExitDialog,
        showOpenAccountDialog,
        showPrintPreviewDialog,
        showPrintSetupDialog,
        showSaveDialog,
        showSavePictureDialog,
    ]);

    // File actions can close the parent menu and unmount this dialog owner
    // before the next effect reports its closed state.
    useEffect(() => () => onDialogOpenChange?.(false), [onDialogOpenChange]);

    // Get current symbol and timeframe from store
    const selectedSymbol = useAppStore(state => state.selectedSymbol);
    const timeframe = useAppStore(state => state.timeframe);
    // SUI-T19b: no reactive workspace-modified source exists; best available
    // live dirty-state is open positions + pending orders (mirrors exitHandler).
    const openTradesCount = useAppStore(state => state.positions?.length ?? 0);
    const draftOrdersCount = useAppStore(state => state.orders?.filter(o => o.status === 'PENDING').length ?? 0);
    const hasOpenTrades = openTradesCount > 0;
    const hasDraftOrders = draftOrdersCount > 0;

    // Print state
    const [printPreferences, setPrintPreferences] = useState<PrintPreferences | null>(null);
    const [chartPrintData, setChartPrintData] = useState<ChartPrintData | null>(null);
    const [printError, setPrintError] = useState<string | null>(null);
    const [preparingPrint, setPreparingPrint] = useState(false);
    const printRequest = useRef(0);
    useEffect(() => () => { printRequest.current += 1; }, []);

    const handleSave = () => {
        setShowSaveDialog(true);
    };

    const handleSaveAsPicture = () => {
        const source = getActiveChartSource();
        const canvas = source?.canvas ?? null;
        const container = source?.container ?? null;

        if (!canvas && !container) {
            console.warn('[FileMenu] No active chart canvas or container found for export');
            alert('No chart available to export. Please open a chart first.');
            return;
        }

        setSavePictureSource(source);
        setShowSavePictureDialog(true);
        onSaveAsPicture?.();
    };

    const handleOpenDataFolder = () => {
        onOpenDataFolder?.();
    };

    const handlePrint = async (chartData?: ChartPrintData, selectedPreferences?: PrintPreferences) => {
        const preferences = selectedPreferences || printPreferences || chartPrinter.getPreferences(accountId);
        const data = chartData || await chartPrinter.captureActiveChartData();
        if (onPrint) await onPrint(data, preferences);
        else await chartPrinter.printChart(data, preferences);
    };

    const handleDirectPrint = async () => {
        if (preparingPrint) return;
        setPreparingPrint(true);
        setPrintError(null);
        try { await handlePrint(); }
        catch (error) { setPrintError(error instanceof Error ? error.message : 'The chart could not be printed.'); }
        finally { setPreparingPrint(false); }
    };

    const handleCloseActiveChart = () => {
        if (onCloseActiveChart) {
            onCloseActiveChart();
            return;
        }
        useDockLayoutStore.getState().closeActiveChart(selectedSymbol);
    };

    const handleRestoreChart = (panelId: string) => {
        if (useDockLayoutStore.getState().restoreClosedChart(panelId)) {
            onChartRestored?.();
        }
    };

    const allProfileNames = [...BUILTIN_WORKSPACE_PROFILE_NAMES, ...workspaceProfiles.map(p => p.name)]
        .filter((name, index, names) => names.findIndex(candidate => (
            candidate.toLowerCase() === name.toLowerCase()
        )) === index);

    const customProfiles = workspaceProfiles.filter(
        p => !BUILTIN_WORKSPACE_PROFILE_NAMES.some(b => b.toLowerCase() === p.name.toLowerCase())
    );

    const handleRestoreProfile = (profileName: string) => {
        try {
            let result = restoreWorkspaceProfile({ accountId: effectiveAccount, profileName });
            if (result.status !== 'restored') {
                result = profileSymbols
                    ? restoreBuiltinWorkspaceProfile(effectiveAccount, profileName, { symbols: profileSymbols })
                    : restoreBuiltinWorkspaceProfile(effectiveAccount, profileName);
            }
            if (result.status === 'restored') {
                setActiveProfileName(result.profile.name);
                onProfileRestored?.(result.profile.name);
                setProfilesOpen(false);
            }
        } catch (error) {
            console.error('[FileMenu] Failed to restore workspace profile:', error);
            window.alert(tr(error instanceof Error ? error.message : 'The workspace profile could not be restored.'));
        }
    };

    const handleNextProfile = () => {
        if (allProfileNames.length === 0) return;
        const currentIndex = allProfileNames.findIndex(
            name => name.toLowerCase() === activeProfileName.toLowerCase()
        );
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % allProfileNames.length : 0;
        handleRestoreProfile(allProfileNames[nextIndex]);
    };

    const handlePreviousProfile = () => {
        if (allProfileNames.length === 0) return;
        const currentIndex = allProfileNames.findIndex(
            name => name.toLowerCase() === activeProfileName.toLowerCase()
        );
        const prevIndex = currentIndex >= 0
            ? (currentIndex - 1 + allProfileNames.length) % allProfileNames.length
            : allProfileNames.length - 1;
        handleRestoreProfile(allProfileNames[prevIndex]);
    };

    const handleDeleteProfile = (profileNameToDelete: string) => {
        try {
            const deleted = deleteWorkspaceProfile({ accountId: effectiveAccount, profileName: profileNameToDelete });
            if (deleted) {
                setWorkspaceProfiles(listWorkspaceProfiles(effectiveAccount));
                if (activeProfileName.toLowerCase() === profileNameToDelete.toLowerCase()) {
                    handleRestoreProfile('Default');
                }
                window.dispatchEvent(new CustomEvent('workspace:profile-deleted', {
                    detail: { accountId: effectiveAccount, name: profileNameToDelete },
                }));
            }
        } catch (error) {
            window.alert(tr(error instanceof Error ? error.message : 'The workspace profile could not be deleted.'));
        }
        setDeleteSubmenuOpen(false);
    };

    useEffect(() => {
        if (!profileShortcutsEnabled) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented || showSaveDialog || showPrintSetupDialog || showPrintPreviewDialog
                || showSavePictureDialog || showExitDialog || showOpenAccountDialog) return;
            const target = e.target instanceof Element ? e.target : null;
            if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
            if (e.key === 'F5' && !e.altKey && !e.metaKey) {
                if (e.shiftKey && !e.ctrlKey) {
                    e.preventDefault();
                    handleNextProfile();
                } else if (e.ctrlKey && !e.shiftKey) {
                    e.preventDefault();
                    handlePreviousProfile();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [allProfileNames, activeProfileName, effectiveAccount, profileSymbols, profileShortcutsEnabled,
        showSaveDialog, showPrintSetupDialog, showPrintPreviewDialog, showSavePictureDialog,
        showExitDialog, showOpenAccountDialog]);

    const handlePrintPreview = async () => {
        const request = ++printRequest.current;
        onPrintPreview?.();
        setChartPrintData(null);
        setPrintError(null);
        setPrintPreferences(printPreferences || chartPrinter.getPreferences(accountId));
        setPreparingPrint(true);
        setShowPrintPreviewDialog(true);
        try {
            const data = await chartPrinter.captureActiveChartData();
            if (request === printRequest.current) setChartPrintData(data);
        } catch (error) {
            if (request === printRequest.current) setPrintError(error instanceof Error ? error.message : 'The chart could not be captured.');
        } finally {
            if (request === printRequest.current) setPreparingPrint(false);
        }
    };

    const handlePrintSetup = () => {
        onPrintSetup?.();
        setShowPrintSetupDialog(true);
    };

    useEffect(() => {
        if (!shortcutsOnly) {
            const handleRevealSubmenu = (event: Event) => {
                const submenu = (event as CustomEvent<{ submenu?: 'profiles' | null }>).detail?.submenu;
                hoverOpenedDeletedRef.current = false;
                hoverOpenedProfilesRef.current = false;
                hoverOpenedDeleteRef.current = false;
                setOpenDeletedOpen(false);
                setDeleteSubmenuOpen(false);
                setProfilesOpen(submenu === 'profiles');
            };
            window.addEventListener('rtx:reveal-file-submenu', handleRevealSubmenu);
            return () => window.removeEventListener('rtx:reveal-file-submenu', handleRevealSubmenu);
        }
    }, [shortcutsOnly]);

    // Keyboard actions use the same capture, error and dialog lifecycle as File.
    useEffect(() => {
        if (!shortcutsOnly) return;
        const preview = () => { void handlePrintPreview(); };
        const picture = () => handleSaveAsPicture();
        window.addEventListener('open-print-preview', preview);
        window.addEventListener('open-save-picture', picture);
        return () => {
            window.removeEventListener('open-print-preview', preview);
            window.removeEventListener('open-save-picture', picture);
        };
    });

    const handleOpenTcpServerDialog = () => {
        (window as unknown as { rtx5OpenTcpEndpointDialog?: () => void }).rtx5OpenTcpEndpointDialog?.();
    };

    const handleExit = () => {
        if (hasUnsavedChanges || hasOpenTrades || hasDraftOrders) {
            setShowExitDialog(true);
        } else {
            performExit();
        }
    };

    const performExit = () => {
        const desktopQuit = (window as unknown as { rtx5DesktopQuit?: () => void }).rtx5DesktopQuit;
        onExit?.();

        if (typeof desktopQuit === 'function') {
            desktopQuit();
            return;
        }

        const electronRuntime = window.electron as ElectronRuntime | undefined;
        if (electronRuntime) {
            electronRuntime.app?.quit?.();
            electronRuntime.ipcRenderer?.send?.('app-quit');
            return;
        }

        if (!onExit) {
            useAppStore.getState().logout?.();
        }
    };



    return (
        <>
            {!shortcutsOnly && <div ref={fileMenuRef} className="rtx-file-menu rtx-menu-surface min-w-[268px] py-1">
                {(accountId || onLogout) && (
                    <>
                        <div
                            className="mx-1 flex min-h-[50px] items-center gap-2 rounded-sm px-2 py-1.5 text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151]"
                            aria-label={tr('Current trading account {{value0}}', { value0: accountId || '' }).trim()}
                            data-testid="file-menu-account-header"
                            role="presentation"
                            onMouseEnter={closeFileSubmenus}
                        >
                            <div
                                className={`rtx-file-menu__account-avatar flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border ${
                                    showingBrokerImage
                                        ? 'border-white/15 bg-[#171a20] [.rtx-advanced-view_&]:border-[#d0d5dd] [.rtx-advanced-view_&]:bg-white'
                                        : 'border-blue-500/30 bg-blue-500/10 text-blue-400 [.rtx-advanced-view_&]:border-[#d6bbfb] [.rtx-advanced-view_&]:bg-[#f4f3ff] [.rtx-advanced-view_&]:text-[#6941C6]'
                                }`}
                                data-testid="file-menu-broker-avatar"
                            >
                                <BrokerLogoImage
                                    broker={activeBrokerLogo.brokerSource}
                                    alt={activeBrokerLogo.alt}
                                    className={currentAvatarMedia.wideBanner
                                        ? 'h-full w-full rounded-full object-contain px-0.5'
                                        : 'h-full w-full rounded-full object-cover'}
                                    appFallbackUrl=""
                                    onLoad={(event) => {
                                        const { naturalWidth, naturalHeight } = event.currentTarget;
                                        if (naturalWidth <= 0 || naturalHeight <= 0) return;
                                        const ratio = naturalWidth / naturalHeight;
                                        const isWideBanner = ratio > 2.2 || ratio < 0.45;
                                        setAvatarMediaState({
                                            key: avatarBrokerKey,
                                            exhausted: false,
                                            wideBanner: isWideBanner,
                                        });
                                    }}
                                    onExhausted={() => {
                                        setAvatarMediaState({
                                            key: avatarBrokerKey,
                                            exhausted: true,
                                            wideBanner: false,
                                        });
                                    }}
                                    fallback={<Icon name="user" size="sm" />}
                                />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="text-[11px] font-normal text-zinc-500 [.rtx-advanced-view_&]:text-[#667085]">{tr("Current account")}</div>
                                <div className="truncate font-mono text-[13px] font-medium text-zinc-200 [.rtx-advanced-view_&]:text-[#101828]">{accountId || '---'}</div>
                            </div>
                            {onLogout && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    aria-label={tr("Log Out")}
                                    data-file-menu-item="logout"
                                    title={tr("Log out of the current account")}
                                    onClick={onLogout}
                                    data-desktop-logout={isDesktopShell ? 'true' : undefined}
                                    className="rtx-file-menu__logout ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-sm border border-rose-500/20 px-2 text-[12px] font-medium text-rose-400 hover:border-rose-500/35 hover:bg-rose-500/10 hover:text-rose-300 [.rtx-advanced-view_&]:border-[#fecdca] [.rtx-advanced-view_&]:text-[#b42318] [.rtx-advanced-view_&]:hover:bg-[#fef3f2] [.rtx-advanced-view_&]:hover:text-[#912018]"
                                >
                                    {!isDesktopShell && <Icon name="log-out" size="xs" />}
                                    <span>{tr("Log Out")}</span>
                                </button>
                            )}
                        </div>
                        <div className="rtx-menu-divider" role="separator"></div>
                    </>
                )}

                {/* New Chart was removed from this menu on web and desktop:
                    charts open from the symbol search, where symbols and their
                    groups are browsed and searched. */}

                {/* Open Deleted */}
                <div
                    ref={openDeletedAnchor}
                    className="relative group/deleted px-1"
                    onMouseEnter={() => {
                        hoverOpenedProfilesRef.current = false;
                        hoverOpenedDeleteRef.current = false;
                        setProfilesOpen(false);
                        setDeleteSubmenuOpen(false);
                        if (recentlyClosedCharts.length > 0) {
                            if (!openDeletedOpen) hoverOpenedDeletedRef.current = true;
                            setOpenDeletedOpen(true);
                        }
                    }}
                >
                    <button
                        type="button"
                        data-file-menu-item="open-deleted"
                        disabled={recentlyClosedCharts.length === 0}
                        aria-haspopup={recentlyClosedCharts.length > 0 ? 'menu' : undefined}
                        aria-expanded={recentlyClosedCharts.length > 0 ? openDeletedOpen : undefined}
                        onClick={() => {
                            if (recentlyClosedCharts.length === 0) return;
                            onInteractPin?.();
                            hoverOpenedProfilesRef.current = false;
                            hoverOpenedDeleteRef.current = false;
                            setProfilesOpen(false);
                            setDeleteSubmenuOpen(false);
                            if (openDeletedOpen && !hoverOpenedDeletedRef.current) {
                                setOpenDeletedOpen(false);
                            } else {
                                hoverOpenedDeletedRef.current = false;
                                setOpenDeletedOpen(true);
                            }
                        }}
                        className={`w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left ${recentlyClosedCharts.length > 0
                            ? (openDeletedOpen
                                ? 'bg-[#2a2e39] [.rtx-advanced-view_&]:bg-[#f3f4f6] text-white [.rtx-advanced-view_&]:text-[#111827] cursor-default'
                                : 'text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default')
                            : 'text-zinc-600 [.rtx-advanced-view_&]:text-gray-400 cursor-not-allowed'}`}
                        title={recentlyClosedCharts.length > 0 ? tr("Restore a recently closed chart") : tr("No recently closed charts")}
                    >
                        <div className="w-4 flex items-center justify-center">
                            <Icon name="history" size="sm" />
                        </div>
                        <span className="flex-1">{t('menu.file.openDeleted')}</span>
                        {recentlyClosedCharts.length > 0 && <Icon name="chevron-right" size="xs" className="rtx-menu-icon--neutral" />}
                    </button>
                    {recentlyClosedCharts.length > 0 && (
                        <div
                            ref={openDeletedSubmenuRef}
                            role="menu"
                            aria-label={tr("{{value0}} menu", { value0: t('menu.file.openDeleted') })}
                            data-submenu-side={openDeletedPlacement.alignLeft ? 'left' : 'right'}
                            style={{ top: openDeletedPlacement.topOffset }}
                            className={`rtx-menu-surface submenu absolute min-w-[190px] max-w-[280px] py-1 z-[101] ${
                                openDeletedPlacement.alignLeft ? 'right-full -mr-px' : 'left-full -ml-px'
                            } ${openDeletedOpen ? 'block' : 'hidden'}`}
                        >
                            {recentlyClosedCharts.map(panel => (
                                <button
                                    key={panel.id}
                                    type="button"
                                    onClick={() => handleRestoreChart(panel.id)}
                                    className="w-full flex min-h-[30px] items-center gap-2 px-3 py-1.5 text-[14px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default"
                                    title={tr("Restore {{value0}}", { value0: panel.title || panel.props?.symbol || 'chart' })}
                                >
                                    <Icon name="candlestick" size="sm" className="rtx-menu-icon--neutral shrink-0" />
                                    <span className="truncate">{panel.title || String(panel.props?.symbol || 'Chart')}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Profiles submenu */}
                <div
                    ref={profilesAnchor}
                    className="relative group/profiles px-1"
                    onMouseEnter={() => {
                        hoverOpenedDeletedRef.current = false;
                        setOpenDeletedOpen(false);
                        if (!profilesOpen) hoverOpenedProfilesRef.current = true;
                        setProfilesOpen(true);
                    }}
                >
                    <button
                        type="button"
                        data-file-menu-item="profiles"
                        aria-haspopup="menu"
                        onClick={() => {
                            onInteractPin?.();
                            hoverOpenedDeletedRef.current = false;
                            setOpenDeletedOpen(false);
                            if (profilesOpen && !hoverOpenedProfilesRef.current) {
                                setProfilesOpen(false);
                                setDeleteSubmenuOpen(false);
                            } else {
                                hoverOpenedProfilesRef.current = false;
                                setProfilesOpen(true);
                            }
                        }}
                        className={`w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left cursor-default ${
                            profilesOpen
                                ? 'bg-[#2a2e39] [.rtx-advanced-view_&]:bg-[#f3f4f6] text-white [.rtx-advanced-view_&]:text-[#111827]'
                                : 'text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827]'
                        }`}
                        title={tr("Load profile configurations")}
                        aria-expanded={profilesOpen}
                    >
                        <div className="rtx-menu-icon--neutral w-4 flex items-center justify-center">
                            <Icon name="layout" size="sm" />
                        </div>
                        <span className="flex-1">{t('menu.file.profiles')}</span>
                        <Icon name="chevron-right" size="xs" className="rtx-menu-icon--neutral" />
                    </button>
                    <div
                        ref={profilesSubmenuRef}
                        role="menu"
                        aria-label={tr("{{value0}} menu", { value0: t('menu.file.profiles') })}
                        data-submenu-side={profilesPlacement.alignLeft ? 'left' : 'right'}
                        style={{ top: profilesPlacement.topOffset }}
                        className={`rtx-menu-surface submenu absolute min-w-[220px] w-max py-1 z-[101] ${profilesPlacement.alignLeft ? 'right-full -mr-px' : 'left-full -ml-px'} ${
                            profilesOpen ? 'block' : 'hidden'
                        }`}
                    >
                        {/* Next */}
                        <button
                            type="button"
                            onMouseEnter={() => {
                                hoverOpenedDeleteRef.current = false;
                                setDeleteSubmenuOpen(false);
                            }}
                            onClick={() => {
                                handleNextProfile();
                                setProfilesOpen(false);
                            }}
                            className="w-full flex min-h-[28px] items-center gap-2 px-3 py-1 text-[13px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default"
                            title={tr("Switch to next profile")}
                        >
                            <span className="w-3.5" />
                            <span className="flex-1">{tr("Next")}</span>
                            <span className="rtx-menu-row__shortcut">{tr("Shift+F5")}</span>
                        </button>

                        {/* Previous */}
                        <button
                            type="button"
                            onMouseEnter={() => {
                                hoverOpenedDeleteRef.current = false;
                                setDeleteSubmenuOpen(false);
                            }}
                            onClick={() => {
                                handlePreviousProfile();
                                setProfilesOpen(false);
                            }}
                            className="w-full flex min-h-[28px] items-center gap-2 px-3 py-1 text-[13px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default"
                            title={tr("Switch to previous profile")}
                        >
                            <span className="w-3.5" />
                            <span className="flex-1">{tr("Previous")}</span>
                            <span className="rtx-menu-row__shortcut">{tr("Ctrl+F5")}</span>
                        </button>

                        {/* Save As... */}
                        <button
                            type="button"
                            onMouseEnter={() => {
                                hoverOpenedDeleteRef.current = false;
                                setDeleteSubmenuOpen(false);
                            }}
                            onClick={() => {
                                setProfilesOpen(false);
                                setShowSaveDialog(true);
                            }}
                            className="w-full flex min-h-[28px] items-center gap-2 px-3 py-1 text-[13px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default"
                            title={tr("Save current workspace as a new profile")}
                        >
                            <span className="w-3.5" />
                            <span className="flex-1">{tr("Save As...")}</span>
                        </button>

                        {/* Delete submenu */}
                        <div
                            ref={deleteAnchor}
                            className="relative group/delete px-0"
                            onMouseEnter={() => {
                                if (customProfiles.length > 0) {
                                    if (!deleteSubmenuOpen) hoverOpenedDeleteRef.current = true;
                                    setDeleteSubmenuOpen(true);
                                }
                            }}
                        >
                            <button
                                type="button"
                                disabled={customProfiles.length === 0}
                                aria-haspopup={customProfiles.length > 0 ? 'menu' : undefined}
                                onClick={() => {
                                    if (customProfiles.length === 0) return;
                                    onInteractPin?.();
                                    if (deleteSubmenuOpen && !hoverOpenedDeleteRef.current) {
                                        setDeleteSubmenuOpen(false);
                                    } else {
                                        hoverOpenedDeleteRef.current = false;
                                        setDeleteSubmenuOpen(true);
                                    }
                                }}
                                aria-expanded={deleteSubmenuOpen}
                                className={`w-full flex min-h-[28px] items-center gap-2 px-3 py-1 text-[13px] font-normal rounded-sm text-left ${
                                    customProfiles.length > 0
                                        ? (deleteSubmenuOpen
                                            ? 'bg-[#2a2e39] [.rtx-advanced-view_&]:bg-[#f3f4f6] text-white [.rtx-advanced-view_&]:text-[#111827] cursor-default'
                                            : 'text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default')
                                        : 'text-zinc-600 [.rtx-advanced-view_&]:text-gray-400 cursor-not-allowed'
                                }`}
                                title={customProfiles.length > 0 ? tr("Delete a custom profile") : tr("No custom profiles to delete")}
                            >
                                <span className="w-3.5" />
                                <span className="flex-1">{tr("Delete")}</span>
                                {customProfiles.length > 0 && <Icon name="chevron-right" size="xs" className="rtx-menu-icon--neutral" />}
                            </button>

                            {customProfiles.length > 0 && (
                                <div
                                    ref={deleteSubmenuRef}
                                    role="menu"
                                    aria-label={tr("{{value0}} menu", { value0: tr("Delete") })}
                                    data-submenu-side={deletePlacement.alignLeft ? 'left' : 'right'}
                                    style={{ top: deletePlacement.topOffset }}
                                    className={`rtx-menu-surface submenu absolute min-w-[160px] py-1 z-[102] ${deletePlacement.alignLeft ? 'right-full -mr-px' : 'left-full -ml-px'} ${
                                        deleteSubmenuOpen ? 'block' : 'hidden'
                                    }`}
                                >
                                    {customProfiles.map(p => (
                                        <button
                                            key={`delete-${p.id}`}
                                            type="button"
                                            onClick={() => handleDeleteProfile(p.name)}
                                            className="w-full flex min-h-[28px] items-center gap-2 px-3 py-1 text-[13px] font-normal rounded-sm text-left text-rose-400 hover:bg-rose-500/10 hover:text-rose-300 [.rtx-advanced-view_&]:text-[#b42318] [.rtx-advanced-view_&]:hover:bg-[#fef3f2] cursor-default"
                                            title={tr("Delete profile {{value0}}", { value0: p.name })}
                                            aria-label={tr("Delete profile {{value0}}", { value0: p.name })}
                                        >
                                            <Icon name="x-close" size="xs" className="shrink-0" />
                                            <span className="truncate flex-1">{p.name}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="rtx-menu-divider" role="separator" />

                        {/* List of profiles (Built-in + Custom) */}
                        {allProfileNames.map(profileName => {
                            const isActive = profileName.toLowerCase() === activeProfileName.toLowerCase();
                            return (
                                <button
                                    key={profileName}
                                    type="button"
                                    aria-pressed={isActive}
                                    onMouseEnter={() => {
                                        hoverOpenedDeleteRef.current = false;
                                        setDeleteSubmenuOpen(false);
                                    }}
                                    onClick={() => handleRestoreProfile(profileName)}
                                    className={`rtx-file-menu__profile w-full flex min-h-[28px] items-center gap-2 px-3 py-1 text-[13px] font-normal rounded-sm text-left cursor-default transition-colors duration-75 ${
                                        isActive
                                            ? 'font-medium'
                                            : 'text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827]'
                                    }`}
                                    title={tr("Restore workspace {{value0}}", { value0: profileName })}
                                >
                                    <span
                                        aria-hidden="true"
                                        className={`w-3.5 text-center font-bold text-[11px] flex-none ${
                                            isActive ? 'text-current' : 'text-transparent'
                                        }`}
                                    >
                                        ✓
                                    </span>
                                    <span className="truncate flex-1">{profileName}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Close */}
                <button
                    data-file-menu-item="close"
                    onMouseEnter={closeFileSubmenus}
                    onClick={handleCloseActiveChart}
                    className="w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default group"
                    title={tr("Close current chart")}
                >
                    <div className="rtx-menu-icon--neutral w-4 flex items-center justify-center">
                        <Icon name="x-close" size="sm" />
                    </div>
                    <span className="flex-1">{t('menu.file.close')}</span>
                    <span className="rtx-menu-row__shortcut">{getTerminalShortcutHint('file.close-chart')}</span>
                </button>

                <div className="rtx-menu-divider" role="separator"></div>

                {/* Save */}
                <button
                    data-file-menu-item="save"
                    onMouseEnter={closeFileSubmenus}
                    onClick={handleSave}
                    className="w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default group"
                    title={tr("Save workspace configuration")}
                >
                    <div className="rtx-menu-icon--neutral w-4 flex items-center justify-center">
                        <Icon name="save" size="sm" />
                    </div>
                    <span className="flex-1">{t('menu.file.save')}</span>
                    <span className="rtx-menu-row__shortcut">{tr("Ctrl+S")}</span>
                </button>

                {/* Save As Picture */}
                <button
                    data-file-menu-item="save-picture"
                    onMouseEnter={closeFileSubmenus}
                    onClick={handleSaveAsPicture}
                    className="w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default group"
                    title={tr("Export chart as image")}
                >
                    <div className="rtx-menu-icon--neutral w-4 flex items-center justify-center">
                        <Icon name="image" size="sm" />
                    </div>
                    <span className="flex-1">{t('menu.file.saveAsPicture')}</span>
                    <span className="rtx-menu-row__shortcut">{getTerminalShortcutHint('file.save-picture')}</span>
                </button>

                <div className="rtx-menu-divider" role="separator"></div>

                {/* Open Data Folder */}
                <button
                    data-file-menu-item="open-data-folder"
                    onMouseEnter={closeFileSubmenus}
                    onClick={handleOpenDataFolder}
                    disabled={!onOpenDataFolder}
                    className={`w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left group ${onOpenDataFolder
                        ? 'text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default'
                        : 'text-zinc-600 [.rtx-advanced-view_&]:text-gray-400 cursor-not-allowed'}`}
                    title={onOpenDataFolder ? tr("Open application data directory") : tr("Available in the desktop app")}
                >
                    <div className="rtx-menu-icon--neutral w-4 flex items-center justify-center">
                        <Icon name="folder-open" size="sm" />
                    </div>
                    <span className="flex-1">{t('menu.file.openDataFolder')}</span>
                    {onOpenDataFolder && window.electron && (
                        <span className="rtx-menu-row__shortcut">{tr("Ctrl+Shift+D")}</span>
                    )}
                </button>

                <div className="rtx-menu-divider" role="separator"></div>

                {/* Print */}
                <button
                    data-file-menu-item="print"
                    onMouseEnter={closeFileSubmenus}
                    onClick={() => { void handleDirectPrint(); }}
                    disabled={preparingPrint}
                    className="w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default group"
                    title={tr("Print chart")}
                >
                    <div className="rtx-menu-icon--neutral w-4 flex items-center justify-center">
                        <Icon name="print" size="sm" />
                    </div>
                    <span className="flex-1">{t('menu.file.print')}</span>
                    <span className="rtx-menu-row__shortcut">{tr("Ctrl+P")}</span>
                </button>

                {/* Print Preview */}
                <button
                    data-file-menu-item="print-preview"
                    onMouseEnter={closeFileSubmenus}
                    onClick={handlePrintPreview}
                    className="w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default group"
                    title={tr("Preview before printing")}
                >
                    <div className="rtx-menu-icon--neutral w-4 flex items-center justify-center">
                        <Icon name="file-text" size="sm" />
                    </div>
                    <span className="flex-1">{t('menu.file.printPreview')}</span>
                    <span className="rtx-menu-row__shortcut">{getTerminalShortcutHint('file.print-preview')}</span>
                </button>

                {/* Print Setup */}
                <button
                    data-file-menu-item="print-setup"
                    onMouseEnter={closeFileSubmenus}
                    onClick={handlePrintSetup}
                    className="w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default group"
                    title={tr("Configure print settings")}
                >
                    <div className="rtx-menu-icon--neutral w-4 flex items-center justify-center">
                        <Icon name="settings" size="sm" />
                    </div>
                    <span className="flex-1">{t('menu.file.printSetup')}</span>
                </button>

                <div className="rtx-menu-divider" role="separator"></div>

                {/* Open an Account */}
                {!hideOpenAccountOption && (
                    <button
                        data-file-menu-item="open-account"
                        onMouseEnter={closeFileSubmenus}
                        onClick={() => setOpenAccountDialogMode('default')}
                        className="w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default group"
                        title={tr("Register new trading account")}
                    >
                        <div className="w-4 flex items-center justify-center">
                            <Icon name="user-plus" size="sm" className="text-blue-400" />
                        </div>
                        <span className="flex-1">{t('menu.file.openAccount')}</span>
                    </button>
                )}

                {/* Create a Demo Account */}
                <button
                    data-file-menu-item="create-demo-account"
                    aria-expanded={openAccountDialogMode === 'demo'}
                    onMouseEnter={closeFileSubmenus}
                    onClick={() => {
                        onInteractPin?.();
                        setOpenAccountDialogMode('demo');
                    }}
                    className={`w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left cursor-default group ${
                        openAccountDialogMode === 'demo'
                            ? 'bg-[#2a2e39] [.rtx-advanced-view_&]:bg-[#f3f4f6] text-white [.rtx-advanced-view_&]:text-[#111827]'
                            : 'text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827]'
                    }`}
                    title={tr("Open a new demo trading account")}
                >
                    <div className="w-4 flex items-center justify-center">
                        <Icon name="user-plus" size="sm" className="text-emerald-400" />
                    </div>
                    <span className="flex-1">{tr("Create a Demo Account")}</span>
                </button>

                {/* Login to Trade Account */}
                <button
                    data-file-menu-item="login-trade"
                    onMouseEnter={closeFileSubmenus}
                    onClick={onLoginTrade}
                    disabled={!onLoginTrade}
                    className={`w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left ${onLoginTrade
                        ? 'text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default'
                        : 'text-zinc-600 [.rtx-advanced-view_&]:text-gray-400 cursor-not-allowed'}`}
                    title={onLoginTrade ? tr("Connect to another trading account") : tr("Trade account login is unavailable")}
                >
                    <div className="w-4 flex items-center justify-center">
                        <Icon name="log-in" size="sm" className={onLoginTrade ? 'text-blue-400' : 'text-blue-400/50'} />
                    </div>
                    <span className="flex-1">{t('menu.file.loginTrade')}</span>
                </button>

                {/* Access Server */}
                <button
                    onMouseEnter={closeFileSubmenus}
                    onClick={handleOpenTcpServerDialog}
                    className="w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default group"
                    title="Configure Broker Access Server"
                >
                    <div className="w-4 flex items-center justify-center">
                        <Icon name="server" size="sm" className="text-emerald-400" />
                    </div>
                    <span className="flex-1">Access Server...</span>
                    {/* Alt+Shift+T is trading.toggle-one-click; Access Server has no catalog shortcut. */}
                </button>

                {/* Login to Web Trader */}
                <button
                    data-file-menu-item="login-web"
                    onMouseEnter={closeFileSubmenus}
                    onClick={onLoginWebTrader}
                    disabled={!onLoginWebTrader}
                    className={`w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left ${onLoginWebTrader
                        ? 'text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default'
                        : 'text-zinc-600 [.rtx-advanced-view_&]:text-gray-400 cursor-not-allowed'}`}
                    title={onLoginWebTrader ? tr("Open this broker in Web Trader") : tr("Web Trader URL is not configured")}
                >
                    <div className="w-4 flex items-center justify-center">
                        <Icon name="globe" size="sm" />
                    </div>
                    <span className="flex-1">{t('menu.file.loginWeb')}</span>
                </button>

                {/* Login to RTX5.community */}
                <button
                    data-file-menu-item="login-community"
                    onMouseEnter={closeFileSubmenus}
                    disabled
                    className="w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left text-zinc-600 [.rtx-advanced-view_&]:text-gray-400 cursor-not-allowed"
                    title={tr("RTX5 Community is not configured for this deployment")}
                >
                    <div className="w-4 flex items-center justify-center">
                        <Icon name="help-circle" size="sm" className="text-blue-500/50" />
                    </div>
                    <span className="flex-1">{t('menu.file.loginMql5')}</span>
                </button>

                {/* Exit */}
                {isAuthenticated && (
                    <>
                        <div className="rtx-menu-divider" role="separator"></div>
                        <button
                            data-file-menu-item="exit"
                            onMouseEnter={closeFileSubmenus}
                            onClick={handleExit}
                            className="w-full flex min-h-[30px] items-center gap-3 px-2 py-1.5 text-[14px] font-normal rounded-sm text-left text-zinc-300 [.rtx-advanced-view_&]:text-[#374151] hover:bg-[#2a2e39] [.rtx-advanced-view_&]:hover:bg-[#f3f4f6] hover:text-white [.rtx-advanced-view_&]:hover:text-[#111827] cursor-default group"
                            title={tr("Close application")}
                        >
                            <div className="w-4 flex items-center justify-center text-rose-400 group-hover:text-rose-300">
                                <Icon name="log-out" size="sm" />
                            </div>
                            <span className="flex-1">{t('menu.file.exit')}</span>
                        </button>
                    </>
                )}
            </div>}

            {/* Dialogs */}
            {showSaveDialog && (
                <Suspense fallback={null}>
                <SaveWorkspaceDialog
                    onConfirm={(workspaceName) => {
                        setShowSaveDialog(false);
                        if (workspaceName) {
                            setActiveProfileName(workspaceName);
                        }
                        onSave?.(workspaceName);
                    }}
                    onCancel={() => setShowSaveDialog(false)}
                    accountId={accountId || 'default'}
                />
                </Suspense>
            )}

            {showPrintSetupDialog && (
                <Suspense fallback={null}>
                <PrintSetupDialog
                    onConfirm={(preferences) => {
                        setShowPrintSetupDialog(false);
                        setPrintPreferences(preferences);
                        chartPrinter.setPreferences(preferences, accountId);
                    }}
                    onCancel={() => setShowPrintSetupDialog(false)}
                    accountId={accountId}
                />
                </Suspense>
            )}

            {showPrintPreviewDialog && (
                <Suspense fallback={null}>
                <PrintPreviewDialog
                    onPrint={(preferences) => handlePrint(chartPrintData || undefined, preferences)}
                    isLoading={preparingPrint}
                    error={printError || undefined}
                    onClose={() => { printRequest.current += 1; setPreparingPrint(false); setShowPrintPreviewDialog(false); }}
                    chartData={chartPrintData || undefined}
                    preferences={printPreferences || undefined}
                />
                </Suspense>
            )}

            {showSavePictureDialog && (
                <Suspense fallback={null}>
                <SavePictureDialog
                    isOpen={showSavePictureDialog}
                    onClose={() => {
                        setShowSavePictureDialog(false);
                        setSavePictureSource(null);
                    }}
                    chartCanvas={savePictureSource?.canvas ?? null}
                    chartContainer={savePictureSource?.container ?? null}
                    symbol={savePictureSource?.symbol || selectedSymbol || 'EURUSD'}
                    timeframe={savePictureSource?.timeframe || timeframe || '5m'}
                />
                </Suspense>
            )}

            {showExitDialog && (
                <Suspense fallback={null}>
                <ExitConfirmDialog
                    isOpen={showExitDialog}
                    changes={{
                        hasWorkspaceChanges: hasUnsavedChanges,
                        hasOpenTrades,
                        hasDraftOrders,
                        openTradesCount,
                        draftOrdersCount,
                        workspaceModified: hasUnsavedChanges,
                    }}
                    onConfirm={(saveWorkspace) => {
                        setShowExitDialog(false);
                        if (saveWorkspace && accountId?.trim()) {
                            try {
                                saveCurrentWorkspaceProfile({
                                    accountId,
                                    profileName: 'Default',
                                });
                            } catch (error) {
                                console.error('[FileMenu] Could not save workspace before exit:', error);
                                window.alert(tr(error instanceof Error
                                    ? error.message
                                    : 'The workspace could not be saved before exit.'));
                                return;
                            }
                        }
                        performExit();
                    }}
                    onCancel={() => setShowExitDialog(false)}
                />
                </Suspense>
            )}

            <RetainedLazyFeature active={showOpenAccountDialog}>
            <OpenAccountDialog
                isOpen={showOpenAccountDialog}
                forceDemoCreation={openAccountDialogMode === 'demo'}
                anchorRef={openAccountDialogMode === 'demo' ? fileMenuRef : undefined}
                onClose={() => setOpenAccountDialogMode(null)}
            />
            </RetainedLazyFeature>
        </>
    );
};
