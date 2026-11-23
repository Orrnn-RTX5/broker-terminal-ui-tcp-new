import { bindBinaryTcpAccountSub } from '../binaryTcpOrderClient';
import { binaryTcpMarketStream } from '../binaryTcpMarketStream';
import { getAccessToken, onSessionChange, type SessionChangeReason } from '../brokerSession';
import { translateUi } from '../../hooks/useUiTranslation';
import type { RequoteDecisionTransport } from '../../hooks/useDealingRequest';
import { useNotificationStore } from '../../store/useNotificationStore';
import {
  registerDealingReplayTrigger,
  registerDealingSweepDecline,
  subscribeDealingUnreconciled,
  useDealingStore,
  type DealingUnreconciledNotice,
} from '../../store/useDealingStore';
import {
  createDealingReconnectReplayController,
  ingestBinaryOrderRespDealing,
  type DealingRequestRecord,
} from './dealingEvents';
import { DEALING_UI_STRINGS } from './dealingI18n';
import { installDealingMarketStreamBridge } from './dealingMarketStreamBridge';
import {
  installDealingOrderClientHooks,
  resetDealingSyncProbeState,
  sendDealingAction10DeclineForRecord,
  sendDealingSyncProbe,
  type DealingSyncProbeResult,
} from './dealingOrderClient';
import {
  getLastSubscribedDealingAccount,
  isDealingTransportSupported,
  registerDealingAccountSubscribedHook,
  setDealingServerAdvertised,
} from './dealingRuntimeHooks';

export interface DealingShellRuntimeOptions {
  getAccountLogin: () => number | null | undefined;
  sendRequoteFrame?: RequoteDecisionTransport;
  sendAccountSub?: (accountLogin: number, authToken: string, encodedFrame0x3B: Uint8Array) => Promise<void> | void;
  sendDealingSync?: (accountLogin: number, authToken: string) => Promise<DealingSyncProbeResult> | DealingSyncProbeResult;
  subscribeStreamState?: (listener: (connected: boolean) => void) => () => void;
  subscribeSessionChange?: (listener: (reason: SessionChangeReason) => void) => () => void;
  notifyUnreconciled?: (notice: DealingUnreconciledNotice) => void;
  onUnreconciledNotice?: (notice: DealingUnreconciledNotice) => void;
}

const MAX_DECLINE_DEDUPE_KEYS = 256;

function recordDeclineDedupeKey(cache: Set<string>, key: string): boolean {
  if (cache.has(key)) return false;
  if (cache.size >= MAX_DECLINE_DEDUPE_KEYS) {
    const oldest = cache.values().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.add(key);
  return true;
}

/**
 * Installs root-level dealing runtime hooks for the terminal application shell:
 * 1. Registers lazy order-client (`dealingOrderClient.ts`) and market-stream (`dealingMarketStreamBridge.ts`) hooks.
 * 2. Sends D18 Action 11 (`DealingSync`) once after push stream `0x3B` subscription commits (when transport supports it).
 * 3. `registerDealingSweepDecline`: sends `0x38` Action 10 when requotes expire in queue or background tabs.
 * 4. Disconnect / unload sweep-decline: sends `0x38` Action 10 on stream disconnect, `offline`, `pagehide`, and `beforeunload`.
 * 5. `registerDealingReplayTrigger`: reconciles stale/synthetic entries via Action 11 (only while stream is connected).
 * 6. `subscribeDealingUnreconciled`: surfaces one neutral notice after 5-minute unreconciled prune.
 * 7. `onSessionChange`: resets `useDealingStore` and D18 capability gate cleanly on logout / account switch / broker URL change.
 */
export function installDealingShellRuntime(options: DealingShellRuntimeOptions): () => void {
  const unregOrderHooks = installDealingOrderClientHooks();
  const unregStreamBridge = installDealingMarketStreamBridge();

  const sentDeclineKeys = new Set<string>();
  const resolveLoginNumber = (): number => {
    const raw = Number(options.getAccountLogin() ?? 0);
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  };

  let isStreamConnected = false;
  let lastProbedEpochLogin: string | null = null;

  const runSyncProbe = (accountLogin: number, authToken: string): void => {
    if (!Number.isSafeInteger(accountLogin) || accountLogin <= 0) return;
    if (!isDealingTransportSupported()) return;
    if (options.sendDealingSync) {
      void Promise.resolve(options.sendDealingSync(accountLogin, authToken)).catch(() => {});
      return;
    }
    void sendDealingSyncProbe({ accountLogin, authToken }).catch(() => {});
  };

  const runSyncProbeForEpoch = (
    accountLogin: number,
    authToken: string,
    connectionEpoch: number,
  ): void => {
    if (!Number.isSafeInteger(accountLogin) || accountLogin <= 0) return;
    if (!isDealingTransportSupported()) return;
    const epochLoginKey = `${connectionEpoch}:${accountLogin}`;
    if (lastProbedEpochLogin === epochLoginKey) {
      return;
    }
    lastProbedEpochLogin = epochLoginKey;
    const probePromise = options.sendDealingSync
      ? Promise.resolve(options.sendDealingSync(accountLogin, authToken))
      : sendDealingSyncProbe({ accountLogin, authToken });
    void probePromise.then(
      (res) => {
        if (!res || !res.sent || res.status === 401) {
          if (lastProbedEpochLogin === epochLoginKey) {
            lastProbedEpochLogin = null;
          }
        }
      },
      () => {
        if (lastProbedEpochLogin === epochLoginKey) {
          lastProbedEpochLogin = null;
        }
      },
    );
  };

  const unregAccountSubHook = registerDealingAccountSubscribedHook(
    ({ accountLogin, authToken, connectionEpoch }) => {
      runSyncProbeForEpoch(accountLogin, authToken, connectionEpoch);
    },
  );

  // If 0x3B already committed while the lazy DealingShellHost chunk was loading, probe immediately.
  const alreadySub = getLastSubscribedDealingAccount();
  if (alreadySub && alreadySub.accountLogin > 0) {
    runSyncProbeForEpoch(alreadySub.accountLogin, alreadySub.authToken, alreadySub.connectionEpoch);
  }

  const declineRecordOnce = async (record: DealingRequestRecord, keepalive: boolean): Promise<void> => {
    const requoteId = record.requote?.requoteId?.trim() ?? '';
    if (!requoteId) return;
    const dedupeKey = `${record.requestId}:${requoteId}`;
    if (!recordDeclineDedupeKey(sentDeclineKeys, dedupeKey)) {
      return;
    }

    const reply = await sendDealingAction10DeclineForRecord(record, options.getAccountLogin, {
      keepalive,
      sendFrame: options.sendRequoteFrame,
    });
    if (!keepalive && reply) {
      const accountLogin = record.accountLogin > 0 ? record.accountLogin : resolveLoginNumber();
      ingestBinaryOrderRespDealing(reply, {
        accountLogin: accountLogin > 0 ? accountLogin : undefined,
        side: record.side,
        wireSide: record.wireSide,
        kind: record.kind,
        digits: record.digits,
        volume: record.volume,
        requestedPrice: record.requestedPrice,
        isExpert: record.isExpert,
        requestId: record.requestId,
      });
    }
  };

  const declineAllPendingRequotes = (mode: 'disconnect' | 'unload'): void => {
    const state = useDealingStore.getState();
    if (state.requoteQueue.length === 0) return;
    const nowMs = Date.now();
    const candidates: DealingRequestRecord[] = [];
    for (const id of state.requoteQueue) {
      const rec = state.requests[id];
      if (!rec || rec.isExpert || rec.phase !== 'requoted' || !rec.requote) continue;
      candidates.push(rec);
    }

    for (const rec of candidates) {
      void declineRecordOnce(rec, mode === 'unload');
      if (mode === 'disconnect') {
        state.applyEvent(
          {
            requestId: rec.requestId,
            seq: rec.seq,
            phase: 'expired',
            synthetic: true,
          },
          nowMs,
        );
      }
    }
  };

  const unsubSweepDecline = registerDealingSweepDecline((record) => declineRecordOnce(record, false));

  const replayController = createDealingReconnectReplayController({
    getAccountLogin: resolveLoginNumber,
    getAuthToken: () => getAccessToken(),
    sendAccountSub: async (accountLogin, authToken, encodedFrame0x3B) => {
      if (options.sendAccountSub) {
        await options.sendAccountSub(accountLogin, authToken, encodedFrame0x3B);
        return;
      }
      await bindBinaryTcpAccountSub(accountLogin, authToken);
    },
  });

  const unsubReplayTrigger = registerDealingReplayTrigger(() => {
    // R1 MINOR-4: never fire replay while stream is offline; reconnect sends Action 11 after 0x3B subscribe.
    if (!isStreamConnected) return;
    if (options.sendAccountSub) {
      void replayController.onStreamReconnected().catch(() => {});
      return;
    }
    const login = resolveLoginNumber();
    if (login > 0) {
      runSyncProbe(login, (getAccessToken() ?? '').trim());
    }
  });

  const unsubUnreconciled = subscribeDealingUnreconciled((notice) => {
    if (options.notifyUnreconciled) {
      options.notifyUnreconciled(notice);
      return;
    }
    if (options.onUnreconciledNotice) {
      options.onUnreconciledNotice(notice);
      return;
    }
    useNotificationStore.getState().addNotification({
      type: 'trading',
      severity: 'info',
      title: notice.symbol || translateUi(DEALING_UI_STRINGS.dealingRequestExpired),
      message: translateUi(notice.messageKey),
      data: {
        requestId: notice.requestId,
        clientOrderId: notice.clientOrderId,
      },
    });
  });

  const subscribeStream = options.subscribeStreamState ?? ((cb) => binaryTcpMarketStream.onStateChange(cb));
  const unsubStreamState = subscribeStream((connected) => {
    const wasConnected = isStreamConnected;
    isStreamConnected = connected;
    if (wasConnected && !connected) {
      declineAllPendingRequotes('disconnect');
      lastProbedEpochLogin = null;
      setDealingServerAdvertised(false);
      resetDealingSyncProbeState();
    } else if (!wasConnected && connected) {
      const login = resolveLoginNumber();
      if (login > 0 && options.sendAccountSub) {
        void replayController.onStreamReconnected().catch(() => {});
      }
    }
  });

  const subscribeSession = options.subscribeSessionChange ?? onSessionChange;
  const unsubSession = subscribeSession((reason) => {
    if (reason === 'logout' || reason === 'account_change' || reason === 'broker_url_change') {
      sentDeclineKeys.clear();
      lastProbedEpochLogin = null;
      setDealingServerAdvertised(false);
      resetDealingSyncProbeState();
      useDealingStore.getState().reset();
    }
  });

  const handleOffline = () => declineAllPendingRequotes('disconnect');
  const handleUnload = () => declineAllPendingRequotes('unload');

  if (typeof window !== 'undefined') {
    window.addEventListener('offline', handleOffline);
    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('beforeunload', handleUnload);
  }

  return () => {
    unregAccountSubHook();
    unsubSweepDecline();
    unsubReplayTrigger();
    unsubUnreconciled();
    unsubStreamState();
    unsubSession();
    unregStreamBridge();
    unregOrderHooks();
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('pagehide', handleUnload);
      window.removeEventListener('beforeunload', handleUnload);
    }
  };
}
