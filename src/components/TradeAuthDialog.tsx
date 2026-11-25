import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, ChevronRight, Copy, Eye, EyeOff, Info, LogIn, UserPlus, X } from 'lucide-react';
import '../styles/trade-auth-dialog.css';
import { useCopyFeedback } from '../hooks/useCopyFeedback';
import { LoginDialog } from './LoginDialog';
import {
  loadDemoRegistrationModes,
  registerRuntimeBrokerDemoAccount,
  registerDesktopBrokerDemoAccount,
  splitDemoAccountName,
  DESKTOP_DEMO_NAME_MESSAGE,
  type DemoAccountMode,
  type DemoRegistrationModes,
} from '../api/demoRegistration';
import { parseTokenExpiresAt, setRefreshToken, setToken } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import type { TradingAuthIntent } from '../services/tradingAuthGate';
import { useBrokerLoginPolicy } from '../hooks/useBrokerLoginPolicy';
import { useDraggableSheet } from '../hooks/useDraggableSheet';
import { assertTerminalConnectedToBroker, useDesktopDemoBroker } from '../hooks/useDesktopDemoBroker';
import { updateDynamicUrls } from '../config/api';
import { getRuntimeBrokerConfiguration, isElectronRuntime, normalizeBrokerInfoForTarget } from '../config/backendTarget.js';
import type { BrokerLoginPolicy } from '../services/brokerLoginPolicy';
import {
  formatBrokerDisplayServer,
  getDirectoryBrokerServerUrl,
  type BrokerDiscoveryItem,
} from '../services/brokerDiscovery';
import { persistBrokerSessionDiscovery } from '../services/brokerSession';
import { rememberAccountSession } from '../services/accountSessionCache';
import { saveLogin, supportsSavedLogins } from '../services/savedLogins';
import { getBrokerSavedAccountTypes } from '../services/tradingAccountType';
import { useUiTranslation } from '../hooks/useUiTranslation';

interface TradeAuthDialogProps {
  isOpen: boolean;
  intent: TradingAuthIntent | null;
  onClose: () => void;
  onAuthenticated: (accountId: string) => void;
  initialMode?: 'choice' | 'demo' | 'login';
  allowDemoCreation?: boolean;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

type DialogMode = 'choice' | 'login' | 'demo';

interface TradeAuthFlowProps extends TradeAuthDialogProps {
  brokerPolicy: BrokerLoginPolicy | null;
  /**
   * Set only on the desktop terminal: the directory row of the broker server
   * the terminal is connected to (null until it is known).
   */
  desktopBroker?: BrokerDiscoveryItem | null;
  desktop: boolean;
}

// Same key the desktop login writes (WelcomeTerminal.LAST_AUTHENTICATED_BROKER_ID_KEY).
const LAST_AUTHENTICATED_BROKER_ID_KEY = 'rtx_last_authenticated_broker_id';

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unable to create the demo account.';
const normalizeBrokerId = (value: unknown): string => String(value ?? '').trim();

/**
 * Session routing of the connected desktop broker, built from its directory
 * row exactly as the desktop login builds it (LoginDialog), so a demo session
 * and a login session of one broker are stored the same way.
 */
const describeDesktopBrokerSession = (broker: BrokerDiscoveryItem | null, brokerId: string) => {
  const serverUrl = getDirectoryBrokerServerUrl(broker);
  if (!broker || !serverUrl) return null;
  const submitBroker = normalizeBrokerInfoForTarget(broker) as BrokerDiscoveryItem;
  const brokerName = normalizeBrokerId(broker.broker_name || submitBroker.broker_name);
  const displayServer = formatBrokerDisplayServer(broker)
    || normalizeBrokerId(broker.display_server || submitBroker.display_server || submitBroker.broker_name);
  const tcpAddr = normalizeBrokerId(broker.tcp_addr || submitBroker.tcp_addr);
  return {
    serverUrl,
    displayServer,
    routing: {
      ...submitBroker,
      broker_id: brokerId,
      broker_name: brokerName,
      display_server: displayServer || brokerName,
      broker_server: displayServer || brokerName,
      ...(tcpAddr ? { tcp_addr: tcpAddr } : {}),
      backend_url: serverUrl,
      market_api_url: serverUrl,
      server_url: serverUrl,
    },
  };
};

export function TradeAuthDialog(props: TradeAuthDialogProps) {
  // Desktop accounts belong to a directory server, not a web deployment: the
  // login keeps its broker selector, and a demo account is opened at the
  // broker server the terminal is connected to.
  return isElectronRuntime() ? <DesktopTradeAuthDialog {...props} /> : <WebTradeAuthDialog {...props} />;
}

function WebTradeAuthDialog(props: TradeAuthDialogProps) {
  const brokerPolicy = useBrokerLoginPolicy(props.isOpen);
  return <TradeAuthFlow {...props} brokerPolicy={brokerPolicy} desktop={false} />;
}

function DesktopTradeAuthDialog(props: TradeAuthDialogProps) {
  const connected = useDesktopDemoBroker(props.isOpen);
  return (
    <TradeAuthFlow
      {...props}
      brokerPolicy={connected?.policy ?? null}
      desktopBroker={connected?.broker ?? null}
      desktop
    />
  );
}

function TradeAuthFlow({
  isOpen, intent, onClose, onAuthenticated, initialMode = 'choice', allowDemoCreation = false, anchorRef, brokerPolicy, desktopBroker = null, desktop,
}: TradeAuthFlowProps) {
  const [mode, setMode] = useState<DialogMode>(initialMode);
  const [anchoredLeft, setAnchoredLeft] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const { copied: copiedPassword, copy: copyPassword, reset: resetPasswordCopy } = useCopyFeedback();
  const { copied: copiedConfirmPassword, copy: copyConfirmPassword, reset: resetConfirmPasswordCopy } = useCopyFeedback();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountMode, setAccountMode] = useState<DemoAccountMode>('hedging');
  const [demoModes, setDemoModes] = useState<{ brokerId: string; modes: DemoRegistrationModes } | null>(null);
  const tr = useUiTranslation();
  const dialogId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const { dragStyle, dragHandleProps } = useDraggableSheet({ isOpen, elementRef: dialogRef });
  const demoRequestGenerationRef = useRef(0);
  const brokerId = brokerPolicy?.status === 'ready' ? brokerPolicy.brokerId : '';
  const brokerPolicyError = brokerPolicy?.status === 'error' ? brokerPolicy.error : undefined;
  const configuration = getRuntimeBrokerConfiguration();
  const configurationIdentity = JSON.stringify(configuration);
  const termsUrl = configuration.valid ? configuration.brokerTermsUrl : '';
  const storeState = typeof useAppStore.getState === 'function' ? useAppStore.getState() : undefined;
  // The desktop terminal serves every directory broker from one local address
  // and bookmarks untyped logins as real, so saved accounts cannot tell there
  // whether this broker's choice is still needed: it always shows the choice.
  const { hasDemoAndRealAccounts } = (desktop || allowDemoCreation)
    ? { hasDemoAndRealAccounts: false }
    : getBrokerSavedAccountTypes(storeState?.savedAccounts, {
      brokerId: brokerId || configuration.brokerId,
      brokerName: brokerPolicy?.displayName,
      server: configuration.defaultMt5Server,
      serverUrl: configuration.apiHost || configuration.apiHostExt,
    });
  const effectiveInitialMode: DialogMode = hasDemoAndRealAccounts ? 'login' : initialMode;
  // Each demo option is shown on the broker's own flag. Netting fails closed
  // (shown only on an explicit true for THIS broker); hedging stays offered
  // unless the broker explicitly says it is off while netting is on.
  const knownDemoModes = demoModes && brokerId && demoModes.brokerId === brokerId ? demoModes.modes : null;
  const nettingAvailable = knownDemoModes?.netting === true;
  const hedgingOffered = !(nettingAvailable && knownDemoModes?.hedging === false);
  const selectedAccountMode: DemoAccountMode = nettingAvailable
    ? (hedgingOffered ? accountMode : 'netting')
    : 'hedging';
  // A desktop terminal can connect to any directory broker, so it does not
  // offer a demo account at a broker that says it has none.
  const demoNotOffered = desktop && knownDemoModes?.hedging === false && !nettingAvailable;

  // Desktop: the directory address of the broker the TCP link is connected to.
  const desktopServerUrl = desktop ? getDirectoryBrokerServerUrl(desktopBroker) : '';

  useEffect(() => {
    // A previous answer never outlives the broker/config it was read for.
    setDemoModes(null);
    if (!isOpen || !brokerId || (desktop && !desktopServerUrl)) return undefined;
    const controller = new AbortController();
    const request = desktop
      ? loadDemoRegistrationModes(brokerId, controller.signal, { brokerId, serverUrl: desktopServerUrl })
      : loadDemoRegistrationModes(brokerId, controller.signal);
    void request.then((modes) => {
      if (!controller.signal.aborted) setDemoModes({ brokerId, modes });
    });
    return () => controller.abort();
  }, [isOpen, brokerId, configurationIdentity, desktop, desktopServerUrl]);

  useEffect(() => {
    if (!isOpen) return;
    setMode(effectiveInitialMode);
    setAccountMode('hedging');
    setError(null);
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirmPassword(false);
    resetPasswordCopy();
    resetConfirmPasswordCopy();
  }, [isOpen, effectiveInitialMode, resetPasswordCopy, resetConfirmPasswordCopy]);

  useEffect(() => {
    if (!password) resetPasswordCopy();
  }, [password, resetPasswordCopy]);

  useEffect(() => {
    if (!confirmPassword) resetConfirmPasswordCopy();
  }, [confirmPassword, resetConfirmPasswordCopy]);

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
      const dialogWidth = dialogRef.current?.getBoundingClientRect().width || 440;
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
  }, [anchorRef, isOpen, mode]);

  useLayoutEffect(() => {
    if (!isOpen || brokerPolicyError) {
      demoRequestGenerationRef.current += 1;
      if (brokerPolicyError) {
        setSubmitting(false);
        // The desktop login selects its own server; a demo broker that cannot
        // be named does not close it.
        if (!desktop) setMode(current => current === 'login' ? 'choice' : current);
      }
    }
    return () => {
      demoRequestGenerationRef.current += 1;
    };
  }, [isOpen, configurationIdentity, brokerPolicyError, desktop]);

  const closeDialog = useCallback(() => {
    demoRequestGenerationRef.current += 1;
    setSubmitting(false);
    onClose();
  }, [onClose]);

  const leaveDemo = useCallback(() => {
    demoRequestGenerationRef.current += 1;
    setSubmitting(false);
    if (allowDemoCreation && initialMode === 'demo') {
      onClose();
      return;
    }
    setMode('choice');
  }, [allowDemoCreation, initialMode, onClose]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The desktop login handles Escape itself (server list, then close).
      if (desktop && mode === 'login') return;
      if (mode === 'choice') closeDialog();
      else leaveDemo();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeDialog, desktop, isOpen, leaveDemo, mode]);

  useEffect(() => {
    if (!isOpen || mode !== 'choice' || (!brokerId && !desktop)) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.focus({ preventScroll: true });
    }
  }, [brokerId, desktop, isOpen, mode]);

  const completeDemoSession = (response: Awaited<ReturnType<typeof registerRuntimeBrokerDemoAccount>>) => {
    if (!brokerId) throw new Error('This terminal does not have a broker configured.');
    const desktopSession = desktop ? describeDesktopBrokerSession(desktopBroker, brokerId) : null;
    if (desktop && !desktopSession) throw new Error('This terminal does not have a broker configured.');
    if (response.broker_id && normalizeBrokerId(response.broker_id) !== normalizeBrokerId(brokerId)) {
      throw new Error('The demo account was returned for a different broker.');
    }
    const token = response.access_token || response.token;
    const accountId = String(response.account_login ?? response.login ?? '');
    if (!token || !accountId) throw new Error('The demo session response is incomplete.');

    const expiresAt = parseTokenExpiresAt(response.expires_at)
      || (response.expires_in ? Date.now() + response.expires_in * 1000 : undefined);

    const sessionServerUrl = localStorage.getItem('server_url')
      || localStorage.getItem('backend_url')
      || configuration.apiHost
      || configuration.apiHostExt
      || '';
    const prevState = useAppStore.getState();
    const prevToken = prevState.authToken || localStorage.getItem('auth_token');
    if (prevState.isAuthenticated && prevState.accountId && prevToken) {
      rememberAccountSession({
        brokerId: localStorage.getItem('broker_id') || localStorage.getItem('rtx_broker_id') || brokerId,
        serverUrl: sessionServerUrl,
        login: prevState.accountId,
        authToken: prevToken,
        refreshToken: prevState.refreshToken || localStorage.getItem('refresh_token') || undefined,
        expiresAt: prevState.tokenExpiresAt || undefined,
      });
    }
    if (desktopSession) {
      // The same two commits as the desktop login: the connected broker's
      // routing first, then its token, so no listener ever sees the new token
      // at another broker's address.
      persistBrokerSessionDiscovery(desktopSession.routing, { notifySessionChange: 'routing-changes' });
      updateDynamicUrls();
      persistBrokerSessionDiscovery({ ...desktopSession.routing, access_token: token }, { notifySessionChange: false });
      if (desktopSession.displayServer) localStorage.setItem('rtx_broker_server', desktopSession.displayServer);
      localStorage.setItem(LAST_AUTHENTICATED_BROKER_ID_KEY, brokerId);
      updateDynamicUrls();
    } else {
      persistBrokerSessionDiscovery({
        broker_id: brokerId,
        broker_name: brokerPolicy?.displayName,
        ...(sessionServerUrl ? { server_url: sessionServerUrl, backend_url: sessionServerUrl } : {}),
      });
    }
    setToken(token);
    if (response.refresh_token) {
      setRefreshToken(response.refresh_token);
    } else {
      localStorage.removeItem('refresh_token');
      sessionStorage.removeItem('refresh_token');
    }
    if (expiresAt) {
      localStorage.setItem('token_expires_at', new Date(expiresAt).toISOString());
    } else {
      localStorage.removeItem('token_expires_at');
      sessionStorage.removeItem('token_expires_at');
    }
    localStorage.setItem('rtx_last_login', accountId);
    localStorage.setItem('rtx_saved_username', accountId);
    localStorage.removeItem('rtx_saved_password');

    const demoServerUrl = desktopSession
      ? desktopSession.serverUrl
      : configuration.apiHostExt || configuration.apiHost || sessionServerUrl;
    rememberAccountSession({
      brokerId,
      serverUrl: desktopSession ? desktopSession.serverUrl : sessionServerUrl || demoServerUrl,
      login: accountId,
      authToken: token,
      refreshToken: response.refresh_token,
      expiresAt,
      password,
    });

    const login = Number.parseInt(accountId, 10);
    const hasValidLogin = Number.isFinite(login) && login > 0;
    const store = useAppStore.getState();
    const savedAccount = hasValidLogin ? {
      login,
      name: response.name || response.username || name.trim(),
      server: desktopSession
        ? desktopSession.displayServer || brokerPolicy?.displayName || brokerId
        : response.broker_name || brokerPolicy?.displayName || response.server || response.broker_id || brokerId,
      accountType: 'demo' as const,
      isLive: false,
      lastUsed: Date.now(),
    } : undefined;
    if (desktopSession) {
      // Like the desktop login: one store commit publishes the whole session.
      store.setAuthenticated(true, accountId, token, response.refresh_token, expiresAt, savedAccount);
    } else {
      store.setAuthTokens(token, response.refresh_token, expiresAt);
      store.setAuthenticated(true, accountId, token, response.refresh_token, expiresAt, savedAccount);
      if (hasValidLogin) {
        store.setActiveAccount(login);
      }
    }
    // The desktop login saves a password only when its "Save password" box is
    // ticked; the desktop demo signup has no such choice, so it saves none.
    if (!desktopSession && password && supportsSavedLogins()) {
      const candidateUrls = Array.from(new Set([demoServerUrl, sessionServerUrl].filter(Boolean)));
      for (const url of candidateUrls) {
        void saveLogin({ brokerId, serverUrl: url }, accountId, password).catch(() => undefined);
      }
    }

    onAuthenticated(accountId);
  };

  const handleDemoSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!brokerId || submitting) return;

    if (!name.trim() || !email.trim() || !password) {
      setError('Name, email, and password are required.');
      return;
    }
    if (desktop && !splitDemoAccountName(name)) {
      setError(DESKTOP_DEMO_NAME_MESSAGE);
      return;
    }
    if (desktop && !phone.trim()) {
      setError('Phone number is required.');
      return;
    }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      setError('Password must be at least 8 characters and include a letter and a number.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    const requestGeneration = ++demoRequestGenerationRef.current;
    try {
      if (desktop) {
        if (!desktopBroker || !desktopServerUrl) throw new Error('This terminal does not have a broker configured.');
        await assertTerminalConnectedToBroker(desktopBroker);
        if (requestGeneration !== demoRequestGenerationRef.current) return;
      }
      const response = desktop
        ? await registerDesktopBrokerDemoAccount(
          selectedAccountMode === 'netting'
            ? { name, email, password, phone, accountMode: 'netting' }
            : { name, email, password, phone },
          { brokerId, serverUrl: desktopServerUrl },
        )
        : await registerRuntimeBrokerDemoAccount(
          selectedAccountMode === 'netting'
            ? { name, email, password, accountMode: 'netting' }
            : { name, email, password },
          brokerId,
        );
      if (requestGeneration !== demoRequestGenerationRef.current) return;
      if (desktop && desktopBroker) {
        // The link was checked before the request; check it again before this
        // broker's session is stored. This catches a switch during the request
        // (not one in the instant between this check and the storing). The
        // request went to the shared local address, so after a switch the
        // account may be at either broker: the message does not guess which.
        try {
          await assertTerminalConnectedToBroker(desktopBroker);
        } catch {
          const login = String(response.account_login ?? response.login ?? '');
          const formBroker = brokerPolicy?.displayName || brokerId;
          throw new Error(`Demo account ${login} was created, but the terminal's broker connection changed during sign-up, so you were not logged in. The account is at ${formBroker} or at the broker server you switched to. Log in there with account ${login} and the password you chose.`);
        }
        if (requestGeneration !== demoRequestGenerationRef.current) return;
      }
      completeDemoSession(response);
    } catch (registrationError) {
      if (requestGeneration !== demoRequestGenerationRef.current) return;
      setError(tr(getErrorMessage(registrationError)));
    } finally {
      if (requestGeneration === demoRequestGenerationRef.current) setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  if (desktop && mode === 'login') {
    // The desktop login chooses its server from the directory itself, so it
    // does not wait for (or depend on) the broker a demo account would use.
    return (
      <LoginDialog
        isOpen
        reason="trade"
        onClose={closeDialog}
        onLoginSuccess={onAuthenticated}
      />
    );
  }

  const loginBrokerId = brokerId || ((hasDemoAndRealAccounts || mode === 'login') ? configuration.brokerId : '');
  if (!desktop && (mode === 'login' || hasDemoAndRealAccounts) && loginBrokerId && !brokerPolicyError) {
    return (
      <LoginDialog
        isOpen
        onClose={(hasDemoAndRealAccounts || initialMode === 'login') ? closeDialog : () => setMode('choice')}
        onLoginSuccess={onAuthenticated}
        initialServer={loginBrokerId}
        lockedBrokerId={loginBrokerId}
        lockedBrokerDisplayName={brokerPolicy?.displayName}
      />
    );
  }

  const isMutationIntent = intent?.kind === 'mutation';
  const isDemo = mode === 'demo';

  return createPortal(
    <div
      className="rtx-auth-backdrop"
      style={anchoredLeft !== null ? { justifyContent: 'flex-start', paddingLeft: anchoredLeft } : undefined}
    >
      <button
        type="button"
        className="rtx-auth-backdrop__dismiss"
        aria-label="Close authentication dialog"
        tabIndex={-1}
        onClick={closeDialog}
      />

      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trade-auth-title"
        aria-describedby="trade-auth-description"
        className="rtx-auth-dialog"
        style={dragStyle}
        data-mode={mode}
        onKeyDown={(event) => {
          if (!isDemo && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'ArrowRight')) {
            const actionBtns = Array.from(
              dialogRef.current?.querySelectorAll<HTMLButtonElement>('.rtx-auth-action:not(:disabled)') || [],
            );
            if (actionBtns.length > 0) {
              const activeIdx = actionBtns.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === 'ArrowRight') {
                const targetBtn = activeIdx >= 0 ? actionBtns[activeIdx] : actionBtns[0];
                if (targetBtn) {
                  event.preventDefault();
                  targetBtn.click();
                  return;
                }
              } else {
                event.preventDefault();
                const nextIdx =
                  event.key === 'ArrowDown'
                    ? activeIdx >= 0
                      ? (activeIdx + 1) % actionBtns.length
                      : 0
                    : activeIdx >= 0
                      ? (activeIdx - 1 + actionBtns.length) % actionBtns.length
                      : actionBtns.length - 1;
                actionBtns[nextIdx]?.focus();
                return;
              }
            }
          }
          if (event.key !== 'Tab') return;
          const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ) || []);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="rtx-auth-dialog__header" {...dragHandleProps}>
          <div className="rtx-auth-dialog__heading">
            <div className="rtx-auth-dialog__heading-copy">
              <h2 id="trade-auth-title" className="rtx-dialog-title rtx-auth-dialog__title">
                {isDemo ? 'Create demo account' : 'Account required to trade'}
              </h2>
              <p id="trade-auth-description" className="rtx-auth-dialog__subtitle">
                {isDemo
                  ? 'Open a practice account with virtual funds.'
                  : 'Choose an account to continue securely.'}
              </p>
            </div>
          </div>
          <button type="button" onClick={closeDialog} className="rtx-auth-dialog__close" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        {!isDemo ? (
          <>
            <div className="rtx-auth-dialog__body">
              {intent && (
                <div className="rtx-auth-order-card">
                  <div className="rtx-auth-order-info">
                    <div className="rtx-auth-order-lead">
                      {isMutationIntent ? (
                        <span className="rtx-auth-badge rtx-auth-badge--action">Action</span>
                      ) : (
                        <span className={`rtx-auth-badge rtx-auth-badge--${intent.side.toLowerCase()}`}>
                          {intent.side}
                        </span>
                      )}
                      <span className="rtx-auth-order-symbol">
                        {isMutationIntent ? intent.actionLabel : intent.symbol}
                      </span>
                      {!isMutationIntent && intent.volume && (
                        <>
                          <span className="rtx-auth-order-dot" aria-hidden="true">·</span>
                          <span className="rtx-auth-order-volume">{intent.volume} lots</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="rtx-auth-order-note">
                    <Info size={13} className="rtx-auth-order-note-icon" aria-hidden="true" />
                    <span className="rtx-auth-order-note-text">
                      {isMutationIntent
                        ? 'This action will not run automatically after login. Review your account data, then choose it again.'
                        : 'This order will not be sent automatically. Review your account after login, then place it again.'}
                    </span>
                  </div>
                </div>
              )}

              <div className="rtx-auth-actions">
                <button
                  type="button"
                  className="rtx-auth-action rtx-auth-action--primary"
                  onClick={() => setMode('login')}
                  disabled={!desktop && !brokerId}
                >
                  <span className="rtx-auth-action__icon" aria-hidden="true">
                    <LogIn size={16} strokeWidth={1.85} />
                  </span>
                  <span className="rtx-auth-action__copy">
                    <span className="rtx-auth-action__label">Log in to live account</span>
                    <span className="rtx-auth-action__description">Access your existing trading account</span>
                  </span>
                  <span className="rtx-auth-action__cta" aria-hidden="true">
                    <ChevronRight size={15} strokeWidth={1.85} aria-hidden="true" />
                  </span>
                </button>

                {!hasDemoAndRealAccounts && (
                  <button
                    type="button"
                    className="rtx-auth-action rtx-auth-action--secondary"
                    onClick={() => setMode('demo')}
                    disabled={!brokerId || demoNotOffered}
                  >
                    <span className="rtx-auth-action__icon" aria-hidden="true">
                      <UserPlus size={16} strokeWidth={1.85} />
                    </span>
                    <span className="rtx-auth-action__copy">
                      <span className="rtx-auth-action__label">Create demo account</span>
                      <span className="rtx-auth-action__description">
                        {demoNotOffered ? 'This broker does not offer demo accounts' : 'Practice with virtual funds'}
                      </span>
                    </span>
                    <span className="rtx-auth-action__cta" aria-hidden="true">
                      <ChevronRight size={15} strokeWidth={1.85} aria-hidden="true" />
                    </span>
                  </button>
                )}
              </div>

              {brokerPolicyError && (
                <div role="alert" className="rtx-auth-alert">
                  <AlertCircle size={13} strokeWidth={2.2} />
                  <span>{brokerPolicyError}</span>
                </div>
              )}
            </div>

          </>
        ) : (
          <form onSubmit={handleDemoSubmit}>
            <div className="rtx-auth-dialog__body">
              <div className="rtx-auth-broker">
                <span className="rtx-auth-broker__label">Broker</span>
                <span className="rtx-auth-broker__value">
                  {brokerPolicy?.displayName || 'Not configured'}
                </span>
              </div>

              {nettingAvailable && (
                <fieldset className="rtx-auth-mode" aria-describedby="trade-auth-mode-hint">
                  <legend className="rtx-auth-field__label">{tr('Account mode')}</legend>
                  <div className="rtx-auth-mode__options">
                    <label className="rtx-auth-mode__option">
                      <input
                        type="radio"
                        name="trade-auth-account-mode"
                        value="hedging"
                        checked={selectedAccountMode === 'hedging'}
                        disabled={!hedgingOffered || submitting}
                        onChange={() => setAccountMode('hedging')}
                      />
                      <span>{tr('Hedging')}</span>
                    </label>
                    <label className="rtx-auth-mode__option">
                      <input
                        type="radio"
                        name="trade-auth-account-mode"
                        value="netting"
                        checked={selectedAccountMode === 'netting'}
                        disabled={submitting}
                        onChange={() => setAccountMode('netting')}
                      />
                      <span>{tr('Netting')}</span>
                    </label>
                  </div>
                  <span id="trade-auth-mode-hint" className="rtx-auth-field__hint">
                    {selectedAccountMode === 'netting'
                      ? tr('Netting: one position per symbol; new trades add to it, reduce it or reverse it.')
                      : tr('Hedging: each trade opens its own position, so one symbol can have several.')}
                  </span>
                </fieldset>
              )}

              <div className="rtx-auth-form">
                <label className="rtx-auth-field">
                  <span className="rtx-auth-field__label">Full name</span>
                  <input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="name"
                    placeholder={desktop ? 'First and last name' : 'Your name'}
                  />
                </label>

                <label className="rtx-auth-field">
                  <span className="rtx-auth-field__label">Email</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                </label>

                {desktop && (
                  <label className="rtx-auth-field">
                    <span className="rtx-auth-field__label">Phone</span>
                    <input
                      type="tel"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      autoComplete="tel"
                      placeholder="+1 555 0100"
                    />
                  </label>
                )}

                <div className="rtx-auth-grid">
                  <div className="rtx-auth-field">
                    <label htmlFor={`${dialogId}-password`} className="rtx-auth-field__label">Password</label>
                    <div className="rtx-auth-password-wrap">
                      <input
                        id={`${dialogId}-password`}
                        type="text"
                        className={`rtx-auth-password-input${showPassword ? '' : ' rtx-secret-input'}`}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        autoCorrect="off"
                        autoCapitalize="none"
                        placeholder="••••••••"
                      />
                      <div className="rtx-auth-password-actions">
                        <button
                          type="button"
                          className="rtx-auth-password-btn"
                          aria-label={showPassword ? tr('Hide password') : tr('Show password')}
                          aria-controls={`${dialogId}-password`}
                          aria-pressed={showPassword}
                          title={showPassword ? tr('Hide password') : tr('Show password')}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => setShowPassword((current) => !current)}
                        >
                          {showPassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          className={`rtx-auth-password-btn${copiedPassword ? ' is-copied' : ''}`}
                          aria-label={copiedPassword ? tr('Copied') : `${tr('Copy')} ${tr('Password')}`}
                          aria-controls={`${dialogId}-password`}
                          title={copiedPassword ? tr('Copied') : tr('Copy')}
                          disabled={!password}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => { void copyPassword(password); }}
                        >
                          {copiedPassword ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="rtx-auth-field">
                    <label htmlFor={`${dialogId}-confirm-password`} className="rtx-auth-field__label">Confirm password</label>
                    <div className="rtx-auth-password-wrap">
                      <input
                        id={`${dialogId}-confirm-password`}
                        type="text"
                        className={`rtx-auth-password-input${showConfirmPassword ? '' : ' rtx-secret-input'}`}
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        autoCorrect="off"
                        autoCapitalize="none"
                        placeholder="••••••••"
                      />
                      <div className="rtx-auth-password-actions">
                        <button
                          type="button"
                          className="rtx-auth-password-btn"
                          aria-label={showConfirmPassword ? tr('Hide password') : tr('Show password')}
                          aria-controls={`${dialogId}-confirm-password`}
                          aria-pressed={showConfirmPassword}
                          title={showConfirmPassword ? tr('Hide password') : tr('Show password')}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => setShowConfirmPassword((current) => !current)}
                        >
                          {showConfirmPassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          className={`rtx-auth-password-btn${copiedConfirmPassword ? ' is-copied' : ''}`}
                          aria-label={copiedConfirmPassword ? tr('Copied') : `${tr('Copy')} ${tr('Password')}`}
                          aria-controls={`${dialogId}-confirm-password`}
                          title={copiedConfirmPassword ? tr('Copied') : tr('Copy')}
                          disabled={!confirmPassword}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => { void copyConfirmPassword(confirmPassword); }}
                        >
                          {copiedConfirmPassword ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <span className="rtx-auth-field__hint">
                  At least 8 characters, including one letter and one number.
                </span>
              </div>

              {(error || brokerPolicyError) && (
                <div role="alert" className="rtx-auth-alert">
                  <AlertCircle size={13} strokeWidth={2.2} />
                  <span>{error || brokerPolicyError}</span>
                </div>
              )}
              {termsUrl && (
                <a href={termsUrl} target="_blank" rel="noopener noreferrer">Terms and data protection policy</a>
              )}
            </div>

            <div className="rtx-auth-dialog__footer">
              <button type="button" onClick={leaveDemo} className="rtx-auth-button" data-variant="ghost">
                {allowDemoCreation && initialMode === 'demo' ? tr('Cancel') : 'Back'}
              </button>
              <button
                type="submit"
                disabled={submitting || !brokerId}
                className="rtx-auth-button"
                data-variant="primary"
              >
                {submitting && <span className="rtx-auth-spinner" aria-hidden="true" />}
                {submitting ? 'Creating…' : 'Create and continue'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>,
    document.body,
  );
}
