import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useUiTranslation } from '../../hooks/useUiTranslation';
import { getAccessToken, onSessionChange } from '../../services/brokerSession';
import { sendDealingRequoteFrame } from '../../services/dealing/dealingOrderClient';
import { installDealingShellRuntime } from '../../services/dealing/dealingShellRuntime';
import { useAppStore } from '../../store/useAppStore';
import {
  getActiveDealingRequestIds,
  selectActiveDealingRequestIdsVersion,
  useDealingStore,
  type DealingUnreconciledNotice,
} from '../../store/useDealingStore';
import { DealingStatusChip } from './DealingStatusChip';
import { RequoteDialog } from './RequoteDialog';
import './dealingShellHost.css';

export interface DealingShellHostProps {
  accountId: string;
  getAccountLogin: () => number | null | undefined;
}

const UNRECONCILED_BANNER_TTL_MS = 12_000;

const subscribeAuthToken = (onStoreChange: () => void): (() => void) => {
  const unsubSession = onSessionChange(() => onStoreChange());
  if (typeof window !== 'undefined') {
    window.addEventListener('auth:token-updated', onStoreChange);
  }
  return () => {
    unsubSession();
    if (typeof window !== 'undefined') {
      window.removeEventListener('auth:token-updated', onStoreChange);
    }
  };
};

const getAuthTokenSnapshot = (): string | undefined => {
  const token = (getAccessToken() ?? '').trim();
  return token || undefined;
};

/**
 * Lazy-loaded root dealing host mounted in `App.tsx`.
 * Installs the sweep-decline / Action 11 `DealingSync` / unreconciled-notice runtime hooks,
 * mounts the singleton `<RequoteDialog />`, and renders active `<DealingStatusChip />` indicators.
 */
export const DealingShellHost: React.FC<DealingShellHostProps> = ({
  accountId,
  getAccountLogin,
}) => {
  const tr = useUiTranslation();
  const getAccountLoginRef = useRef(getAccountLogin);
  useEffect(() => {
    getAccountLoginRef.current = getAccountLogin;
  }, [getAccountLogin]);

  const stableGetAccountLogin = useCallback(() => getAccountLoginRef.current(), []);
  const authToken = useSyncExternalStore(subscribeAuthToken, getAuthTokenSnapshot, () => undefined);
  const [unreconciledNotices, setUnreconciledNotices] = useState<DealingUnreconciledNotice[]>([]);
  const bannerTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissUnreconciledNotice = useCallback((requestId: string) => {
    const timer = bannerTimersRef.current.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      bannerTimersRef.current.delete(requestId);
    }
    setUnreconciledNotices((prev) => prev.filter((item) => item.requestId !== requestId));
  }, []);

  const prevAccountIdRef = useRef(accountId);
  useEffect(() => {
    if (prevAccountIdRef.current !== accountId) {
      prevAccountIdRef.current = accountId;
      useDealingStore.getState().reset();
      for (const timer of bannerTimersRef.current.values()) {
        clearTimeout(timer);
      }
      bannerTimersRef.current.clear();
      queueMicrotask(() => setUnreconciledNotices([]));
    }
  }, [accountId]);

  useEffect(() => {
    const timers = bannerTimersRef.current;
    const teardown = installDealingShellRuntime({
      getAccountLogin: stableGetAccountLogin,
      // Renders ONLY the accessible tray banner here (avoids duplicate toast + banner per R1 MINOR-4).
      notifyUnreconciled: (notice) => {
        setUnreconciledNotices((prev) => {
          if (prev.some((existing) => existing.requestId === notice.requestId)) {
            return prev;
          }
          return [...prev.slice(-2), notice];
        });
        if (!timers.has(notice.requestId)) {
          const timer = setTimeout(() => {
            timers.delete(notice.requestId);
            setUnreconciledNotices((prev) => prev.filter((item) => item.requestId !== notice.requestId));
          }, UNRECONCILED_BANNER_TTL_MS);
          timers.set(notice.requestId, timer);
        }
      },
    });
    return () => {
      teardown();
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      if (!useAppStore.getState().isAuthenticated) {
        useDealingStore.getState().reset();
      }
    };
  }, [stableGetAccountLogin]);

  const activeIdsVersion = useDealingStore(selectActiveDealingRequestIdsVersion);
  const activeIds = useMemo(() => {
    void activeIdsVersion;
    return getActiveDealingRequestIds();
  }, [activeIdsVersion]);

  return (
    <>
      <RequoteDialog
        sendRequoteFrame={sendDealingRequoteFrame}
        getAccountLogin={stableGetAccountLogin}
        authToken={authToken}
      />
      {(activeIds.length > 0 || unreconciledNotices.length > 0) && (
        <div className="rtx-dealing-status-tray" data-testid="dealing-status-tray">
          {unreconciledNotices.map((notice) => (
            <div
              key={notice.requestId}
              role="status"
              aria-live="polite"
              className="rtx-dealing-unreconciled-banner"
              data-testid="dealing-unreconciled-banner"
            >
              {notice.symbol && (
                <span className="rtx-dealing-unreconciled-banner__symbol">{notice.symbol}</span>
              )}
              <span>{tr(notice.messageKey)}</span>
              <button
                type="button"
                aria-label={tr('Dismiss')}
                className="rtx-dealing-unreconciled-banner__dismiss"
                onClick={() => dismissUnreconciledNotice(notice.requestId)}
              >
                ×
              </button>
            </div>
          ))}
          {activeIds.map((id) => (
            <DealingStatusChip key={id} requestId={id} />
          ))}
        </div>
      )}
    </>
  );
};
