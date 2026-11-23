/**
 * React hook for order-flow dealing status, binary requote Accept/Decline
 * (0x38 Actions 9/10 with TLVs 0x14/0x15, Ticket=0, Expiration=0), and
 * server-clock-adjusted countdown.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  CLIENT_CAP_DEALING_V1,
  DEFAULT_HUMAN_TIMEOUT_MS,
  DEFAULT_REQUOTE_WINDOW_MS,
  WIRE_ACTION_REQUOTE_ACCEPT,
  WIRE_ACTION_REQUOTE_DECLINE,
  WIRE_FLAG_HAS_EXTRAS,
  encodeRequoteActionFrame,
  type DecodedOrderRespWithExecWire,
} from '../services/dealing/binaryDealingCodec';
import {
  ingestBinaryOrderRespDealing,
  isTerminalDealingPhase,
  type DealingPhase,
  type DealingRequestRecord,
} from '../services/dealing/dealingEvents';
import {
  clampTimeoutDelayMs,
  isValidDealingExpiresAtMs,
  pickActiveRequoteId,
} from '../services/dealing/dealingReducer';
import { getBrokerServerNowMs } from '../services/brokerServerClock';
import {
  getDealingCountdownTickNowMs,
  subscribeDealingCountdownTick,
} from '../services/dealing/dealingCountdownTicker';
import { isKnownDealingReasonCode } from '../services/dealing/dealingReasonMessages';
import { setDealingServerAdvertised } from '../services/dealing/dealingRuntimeHooks';
import {
  selectActiveDealingRequestIdForSymbol,
  selectDealingRequestById,
  selectDealingRequestIdByClientOrderId,
  useDealingStore,
} from '../store/useDealingStore';

export const DEALING_DECISION_SAFETY_GRACE_MS = 2_000;
export const AUTO_DECLINE_RETRY_DELAY_MS = 250;
export const AUTO_DECLINE_HEAD_GRACE_MS = 1_000;

const noopSubscribe = (): (() => void) => () => {};
const getIdleTickSnapshot = (): number => 0;

export type RequoteDecisionTransport = (
  encodedFrame0x38: Uint8Array,
  meta: {
    action: typeof WIRE_ACTION_REQUOTE_ACCEPT | typeof WIRE_ACTION_REQUOTE_DECLINE;
    requestId: string;
    requoteId: string;
    accountLogin: number;
    symbol: string;
    price: number;
  },
) => Promise<Uint8Array | ArrayBuffer | DecodedOrderRespWithExecWire | void>
  | Uint8Array
  | ArrayBuffer
  | DecodedOrderRespWithExecWire
  | void;

export interface UseDealingRequestOptions {
  requestId?: string | null;
  clientOrderId?: string | null;
  symbol?: string | null;
  /** Injected binary transport sending encoded 0x38 Actions 9/10 frames. */
  sendRequoteFrame?: RequoteDecisionTransport;
  /** Session getter returning the active account login when record metadata omits it. */
  getAccountLogin?: () => number | null | undefined;
  /** Optional auth token override passed into 0x38 Actions 9/10 payload. */
  authToken?: string;
  /** Automatically send Action 10 decline when the requote countdown hits 0 (default: true). */
  autoDeclineOnExpire?: boolean;
  /** @deprecated Shared 100 ms countdown ticker is always used across all hooks. */
  tickIntervalMs?: number;
}

export interface AcceptRequoteOfferInput {
  requoteId: string;
  price: number;
}

export function isDealingTransportTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return typeof err === 'string' && /timeout|timed\s*out|deadline\s+exceeded/i.test(err);
  }
  const rec = err as { status?: unknown; name?: unknown; code?: unknown; message?: unknown; isTimeout?: unknown };
  if (rec.status === 504) return true;
  if (rec.isTimeout === true) return true;
  if (typeof rec.name === 'string' && /timeout/i.test(rec.name)) return true;
  if (
    typeof rec.code === 'string'
    && /^(?:E?TIMEDOUT|TIMEOUT|REQUEST_TIMEOUT|ORDER_TIMEOUT|GATEWAY_TIMEOUT|BINARY_TCP_TIMEOUT|DEADLINE_EXCEEDED)$/i.test(rec.code.trim())
  ) {
    return true;
  }
  if (typeof rec.message === 'string' && /timeout|timed\s*out|deadline\s+exceeded/i.test(rec.message)) return true;
  return false;
}

export interface UseDealingRequestResult {
  request: DealingRequestRecord | null;
  requestId: string | null;
  phase: DealingPhase | null;
  isInDealing: boolean;
  isRequoted: boolean;
  isSubmitting: boolean;
  isSyntheticExpiry: boolean;
  isTerminal: boolean;
  remainingMs: number;
  remainingSeconds: number;
  totalWindowMs: number;
  progress: number;
  isCountdownExpired: boolean;
  accept: (expectedOffer: AcceptRequoteOfferInput) => Promise<boolean>;
  decline: () => Promise<boolean>;
}

export function useActiveRequoteId(options?: { autoDeclineGraceMs?: number }): string | null {
  const graceMs = options?.autoDeclineGraceMs ?? 0;
  const requoteQueue = useDealingStore((state) => state.requoteQueue);
  const storeActiveRequoteId = useDealingStore((state) => state.activeRequoteId);
  const headId = requoteQueue.length > 0 ? requoteQueue[0] : null;
  const headRecord = useDealingStore(selectDealingRequestById(headId));
  // M2: Ignore already-expired entries so the 100 ms shared countdown ticker stops immediately.
  const activeSnapshotId = requoteQueue.length > 0
    ? pickActiveRequoteId(
        useDealingStore.getState().requests,
        requoteQueue,
        getDealingCountdownTickNowMs(),
        graceMs,
      )
    : null;
  const activeRecord = useDealingStore(
    selectDealingRequestById(activeSnapshotId !== headId ? activeSnapshotId : null),
  );
  const hasQueue = activeSnapshotId !== null;
  const tickNowMs = useSyncExternalStore(
    hasQueue ? subscribeDealingCountdownTick : noopSubscribe,
    hasQueue ? getDealingCountdownTickNowMs : getIdleTickSnapshot,
    getIdleTickSnapshot,
  );
  if (!hasQueue) return null;
  void storeActiveRequoteId;
  void headRecord;
  void activeRecord;
  return pickActiveRequoteId(useDealingStore.getState().requests, requoteQueue, tickNowMs, graceMs);
}

function isDecodedResp(value: unknown): value is DecodedOrderRespWithExecWire {
  return (
    Boolean(value)
    && typeof value === 'object'
    && !(value instanceof Uint8Array)
    && !(value instanceof ArrayBuffer)
    && 'status' in (value as Record<string, unknown>)
    && 'action' in (value as Record<string, unknown>)
  );
}

export function useDealingRequest(
  options: UseDealingRequestOptions = {},
): UseDealingRequestResult {
  const {
    requestId: explicitRequestId,
    clientOrderId,
    symbol,
    sendRequoteFrame,
    getAccountLogin,
    authToken,
    autoDeclineOnExpire = true,
  } = options;

  const idByCoid = useDealingStore(selectDealingRequestIdByClientOrderId(clientOrderId));
  const idBySymbol = useDealingStore(
    selectActiveDealingRequestIdForSymbol(explicitRequestId || idByCoid ? null : symbol),
  );
  const resolvedId = explicitRequestId?.trim() || idByCoid || idBySymbol || null;
  const request = useDealingStore(selectDealingRequestById(resolvedId));

  const phase = request?.phase ?? null;
  const requote = request?.requote ?? null;
  const isCountdownActive = Boolean(
    request
    && (
      phase === 'requoted'
      || phase === 'accepting'
      || phase === 'declining'
      || (phase === 'in_dealing' && request.expiresAtMs > 0)
    ),
  );

  const tickNowMs = useSyncExternalStore(
    isCountdownActive ? subscribeDealingCountdownTick : noopSubscribe,
    isCountdownActive ? getDealingCountdownTickNowMs : getIdleTickSnapshot,
    getIdleTickSnapshot,
  );

  const activeRequoteKey = request && requote
    ? `${request.requestId}:${requote.requoteId}`
    : null;
  const inflightKeyRef = useRef<string | null>(null);
  const autoDeclineAttemptRef = useRef<{ key: string; attempts: number } | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendDecision = useCallback(
    async (
      action: typeof WIRE_ACTION_REQUOTE_ACCEPT | typeof WIRE_ACTION_REQUOTE_DECLINE,
      expectedOffer?: AcceptRequoteOfferInput,
    ): Promise<boolean> => {
      const latest = resolvedId ? useDealingStore.getState().requests[resolvedId] : null;
      if (!latest || !latest.requote) return false;
      if (latest.phase !== 'requoted') return false;

      if (action === WIRE_ACTION_REQUOTE_ACCEPT) {
        if (!sendRequoteFrame) {
          return false;
        }
        if (
          !expectedOffer
          || typeof expectedOffer !== 'object'
          || typeof expectedOffer.requoteId !== 'string'
        ) {
          return false;
        }
        const expectedId = expectedOffer.requoteId.trim();
        if (
          !expectedId
          || !Number.isFinite(expectedOffer.price)
          || expectedOffer.price <= 0
          || latest.requote.requoteId !== expectedId
          || latest.requote.offeredPrice !== expectedOffer.price
        ) {
          return false;
        }
        const now = Date.now();
        const brokerNow = latest.serverNowMs > 0
          ? now + latest.serverClockOffsetMs
          : (getBrokerServerNowMs(now) ?? now);
        if (!isValidDealingExpiresAtMs(latest.requote.expiresAtMs, brokerNow) || latest.requote.expiresAtMs <= brokerNow) {
          return false;
        }
      }

      const rawSessionLogin = getAccountLogin ? getAccountLogin() : undefined;
      const accountLogin = latest.accountLogin > 0
        ? latest.accountLogin
        : (typeof rawSessionLogin === 'number' && Number.isSafeInteger(rawSessionLogin) && rawSessionLogin > 0
            ? rawSessionLogin
            : 0);
      if (!Number.isSafeInteger(accountLogin) || accountLogin <= 0) {
        return false;
      }

      const targetRequoteId = action === WIRE_ACTION_REQUOTE_ACCEPT && expectedOffer
        ? expectedOffer.requoteId.trim()
        : latest.requote.requoteId;
      const key = `${latest.requestId}:${targetRequoteId}`;
      if (inflightKeyRef.current === key) {
        return false;
      }

      const targetPrice = action === WIRE_ACTION_REQUOTE_ACCEPT && expectedOffer
        ? expectedOffer.price
        : 0;
      if (action === WIRE_ACTION_REQUOTE_ACCEPT && !(targetPrice > 0)) {
        return false;
      }

      const store = useDealingStore.getState();
      const transitioned = action === WIRE_ACTION_REQUOTE_ACCEPT
        ? store.markAccepting(latest.requestId, targetRequoteId)
        : store.markDeclining(latest.requestId, targetRequoteId);
      if (!transitioned) return false;

      inflightKeyRef.current = key;
      try {
        const frame0x38 = encodeRequoteActionFrame({
          action,
          side: latest.wireSide,
          flags: WIRE_FLAG_HAS_EXTRAS,
          accountLogin,
          ticket: 0,
          volume: latest.volume,
          price: targetPrice,
          expiration: 0,
          symbol: latest.symbol,
          clientOrderId: latest.clientOrderId,
          authToken,
          requestId: latest.requestId,
          requoteId: targetRequoteId,
          clientCaps: CLIENT_CAP_DEALING_V1,
        });

        if (sendRequoteFrame) {
          const reply = await sendRequoteFrame(frame0x38, {
            action,
            requestId: latest.requestId,
            requoteId: targetRequoteId,
            accountLogin,
            symbol: latest.symbol,
            price: targetPrice,
          });
          if (reply instanceof Uint8Array || reply instanceof ArrayBuffer || isDecodedResp(reply)) {
            let replyStatus = 0;
            if (isDecodedResp(reply)) {
              replyStatus = reply.status;
            } else {
              const bytes = reply instanceof Uint8Array ? reply : new Uint8Array(reply);
              if (bytes.byteLength >= 4) {
                replyStatus = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint16(2, true);
              }
            }
            if (replyStatus === 501) {
              setDealingServerAdvertised(false);
            }
            ingestBinaryOrderRespDealing(reply, {
              accountLogin,
              side: latest.side,
              wireSide: latest.wireSide,
              kind: latest.kind,
              digits: latest.digits,
              volume: latest.volume,
              requestedPrice: latest.requestedPrice,
              isExpert: latest.isExpert,
              requestId: latest.requestId,
            });
          } else if (action === WIRE_ACTION_REQUOTE_DECLINE) {
            // Gate closed / HTTP 501 / void Decline transport resolves cleanly instead of freezing in 'declining'.
            useDealingStore.getState().dismissRequote(latest.requestId);
          }
        } else {
          // Local decline without wired transport marks the entry cancelled cleanly.
          useDealingStore.getState().dismissRequote(latest.requestId);
        }
        return true;
      } catch (err) {
        const current = useDealingStore.getState().requests[latest.requestId];
        const stillPending = Boolean(
          current
          && (current.phase === 'accepting' || current.phase === 'declining')
          && current.requote?.requoteId === targetRequoteId,
        );
        const rec = err && typeof err === 'object' ? (err as { status?: unknown; code?: unknown }) : null;
        const errStatus = rec && typeof rec.status === 'number' ? rec.status : 0;
        const errCode = rec && typeof rec.code === 'string' ? rec.code.trim().toUpperCase() : '';

        if (isDealingTransportTimeoutError(err) || errCode === 'TRUNCATED_BINARY_ORDER_RESP') {
          if (stillPending && current) {
            useDealingStore.getState().applyEvent(
              {
                requestId: latest.requestId,
                seq: current.seq,
                phase: 'expired',
                synthetic: true,
              },
              Date.now(),
            );
          }
        } else if (errStatus === 501 || errCode === 'DEALING_NOT_ENABLED') {
          setDealingServerAdvertised(false);
          if (stillPending && current) {
            if (action === WIRE_ACTION_REQUOTE_DECLINE) {
              useDealingStore.getState().dismissRequote(latest.requestId);
            } else {
              useDealingStore.getState().applyEvent(
                {
                  requestId: latest.requestId,
                  seq: current.seq,
                  phase: 'rejected',
                  reasonCode: 'DEALING_NOT_ENABLED',
                  reasonText: '',
                },
                Date.now(),
              );
            }
          }
        } else if (errStatus === 404 || errCode === 'DEALING_REQUEST_NOT_FOUND') {
          if (stillPending && current) {
            if (action === WIRE_ACTION_REQUOTE_DECLINE) {
              const reasonCode = isKnownDealingReasonCode(errCode) ? errCode : 'CLIENT_DECLINED';
              useDealingStore.getState().applyEvent(
                {
                  requestId: latest.requestId,
                  seq: current.seq,
                  phase: 'cancelled',
                  reasonCode,
                  reasonText: '',
                },
                Date.now(),
              );
            } else if (isKnownDealingReasonCode(errCode)) {
              useDealingStore.getState().applyEvent(
                {
                  requestId: latest.requestId,
                  seq: current.seq,
                  phase: 'rejected',
                  reasonCode: errCode,
                  reasonText: '',
                },
                Date.now(),
              );
            } else {
              useDealingStore.getState().applyEvent(
                {
                  requestId: latest.requestId,
                  seq: current.seq,
                  phase: 'cancelled',
                  reasonCode: 'DEALING_ALREADY_RESOLVED',
                  reasonText: '',
                },
                Date.now(),
              );
            }
          }
        } else if (
          errStatus >= 400
          && errCode !== 'BINARY_TRANSPORT_UNREACHABLE'
          && errCode !== 'BINARY_TUNNEL_UNAVAILABLE'
          && errCode !== 'REQUEST_ABORTED'
        ) {
          if (stillPending && current) {
            if (action === WIRE_ACTION_REQUOTE_DECLINE) {
              const reasonCode = isKnownDealingReasonCode(errCode) ? errCode : 'CLIENT_DECLINED';
              useDealingStore.getState().applyEvent(
                {
                  requestId: latest.requestId,
                  seq: current.seq,
                  phase: 'cancelled',
                  reasonCode,
                  reasonText: '',
                },
                Date.now(),
              );
            } else {
              const reasonCode = isKnownDealingReasonCode(errCode) ? errCode : 'DEALER_REJECTED';
              useDealingStore.getState().applyEvent(
                {
                  requestId: latest.requestId,
                  seq: current.seq,
                  phase: 'rejected',
                  reasonCode,
                  reasonText: '',
                },
                Date.now(),
              );
            }
          }
        } else {
          // Transient local transport/socket failure re-enables Accept/Decline for the same requoteId;
          // Gateway handles a retried identical requoteId idempotently per API_CONTRACT.md §9.4.
          useDealingStore.getState().revertRequotePending(latest.requestId, targetRequoteId);
        }
        throw err;
      } finally {
        if (inflightKeyRef.current === key) {
          inflightKeyRef.current = null;
        }
      }
    },
    [authToken, getAccountLogin, resolvedId, sendRequoteFrame],
  );

  const accept = useCallback(
    (expectedOffer: AcceptRequoteOfferInput) => sendDecision(WIRE_ACTION_REQUOTE_ACCEPT, expectedOffer),
    [sendDecision],
  );

  const decline = useCallback(
    () => sendDecision(WIRE_ACTION_REQUOTE_DECLINE),
    [sendDecision],
  );

  // Safety timeout for stuck accepting/declining awaiting a server settlement reply.
  // M1/m8: Enforces a 2 s floor from NOW so a tab waking late never goes synthetic before a fast reply arrives.
  useEffect(() => {
    if (!request || !requote || (phase !== 'accepting' && phase !== 'declining')) {
      return;
    }
    const now = Date.now();
    const brokerNow = request.serverNowMs > 0
      ? now + request.serverClockOffsetMs
      : (getBrokerServerNowMs(now) ?? now);
    const baseExpiryMs = isValidDealingExpiresAtMs(requote.expiresAtMs, brokerNow)
      ? requote.expiresAtMs
      : brokerNow;
    const deadlineBrokerMs = baseExpiryMs + DEALING_DECISION_SAFETY_GRACE_MS;
    const rawDelayMs = Math.max(
      DEALING_DECISION_SAFETY_GRACE_MS,
      deadlineBrokerMs - brokerNow,
    );
    const delayMs = clampTimeoutDelayMs(rawDelayMs, DEALING_DECISION_SAFETY_GRACE_MS);
    const targetRequestId = request.requestId;
    const targetRequoteId = requote.requoteId;

    const safetyTimer = setTimeout(() => {
      try {
        const current = useDealingStore.getState().requests[targetRequestId];
        if (
          !current
          || (current.phase !== 'accepting' && current.phase !== 'declining')
          || current.requote?.requoteId !== targetRequoteId
        ) {
          return;
        }
        const key = `${targetRequestId}:${targetRequoteId}`;
        if (inflightKeyRef.current === key) {
          inflightKeyRef.current = null;
        }
        useDealingStore.getState().applyEvent(
          {
            requestId: targetRequestId,
            seq: current.seq,
            phase: 'expired',
            synthetic: true,
          },
          Date.now(),
        );
      } catch {
        // m2: Never throw out of safety timer callback.
      }
    }, delayMs);

    return () => {
      clearTimeout(safetyTimer);
    };
  }, [phase, request, requote]);

  // Derive countdown safely using server-clock offset and monotonic baseline >= request.updatedAtMs.
  let remainingMs = 0;
  let totalWindowMs = DEFAULT_REQUOTE_WINDOW_MS;
  let isCountdownExpired = phase === 'expired';

  if (request) {
    const localAnchorNow = Math.max(tickNowMs, request.updatedAtMs);
    const brokerNow = request.serverNowMs > 0
      ? localAnchorNow + request.serverClockOffsetMs
      : (getBrokerServerNowMs(localAnchorNow) ?? localAnchorNow);

    if (requote && (phase === 'requoted' || phase === 'accepting' || phase === 'declining')) {
      totalWindowMs = requote.windowMs > 0 ? requote.windowMs : DEFAULT_REQUOTE_WINDOW_MS;
      remainingMs = Math.max(0, requote.expiresAtMs - brokerNow);
      isCountdownExpired = remainingMs <= 0;
    } else if (phase === 'in_dealing' && request.expiresAtMs > 0) {
      totalWindowMs = request.serverNowMs > 0 && request.expiresAtMs > request.serverNowMs
        ? request.expiresAtMs - request.serverNowMs
        : DEFAULT_HUMAN_TIMEOUT_MS;
      remainingMs = Math.max(0, request.expiresAtMs - brokerNow);
      isCountdownExpired = remainingMs <= 0;
    }
  }

  // Clear pending auto-decline retry timer only when active requote key changes or unmounts.
  useEffect(() => () => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, [activeRequoteKey]);

  useEffect(() => {
    if (
      !autoDeclineOnExpire
      || !request
      || phase !== 'requoted'
      || !activeRequoteKey
      || !isCountdownExpired
    ) {
      return;
    }
    const existingAttempts = autoDeclineAttemptRef.current?.key === activeRequoteKey
      ? autoDeclineAttemptRef.current.attempts
      : 0;
    if (existingAttempts >= 1) {
      return;
    }
    autoDeclineAttemptRef.current = { key: activeRequoteKey, attempts: 1 };

    const targetRequestId = request.requestId;
    const targetRequoteId = request.requote?.requoteId ?? '';

    const moveHeadToSyntheticAwaiting = () => {
      const current = useDealingStore.getState().requests[targetRequestId];
      if (!current || current.phase !== 'requoted') return;
      if (targetRequoteId && current.requote?.requoteId && current.requote.requoteId !== targetRequoteId) {
        return;
      }
      useDealingStore.getState().applyEvent(
        {
          requestId: targetRequestId,
          seq: current.seq,
          phase: 'expired',
          synthetic: true,
        },
        Date.now(),
      );
    };

    const scheduleSingleRetry = () => {
      if (retryTimerRef.current !== null) return;
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        try {
          const current = useDealingStore.getState().requests[targetRequestId];
          if (!current || current.phase !== 'requoted') return;
          const curKey = `${current.requestId}:${current.requote?.requoteId ?? ''}`;
          if (curKey !== activeRequoteKey) return;
          autoDeclineAttemptRef.current = { key: activeRequoteKey, attempts: 2 };
          void decline().then(
            (ok) => {
              if (!ok) {
                moveHeadToSyntheticAwaiting();
              }
            },
            () => {
              moveHeadToSyntheticAwaiting();
            },
          );
        } catch {
          // m2: Never throw out of retry timer callback.
        }
      }, clampTimeoutDelayMs(AUTO_DECLINE_RETRY_DELAY_MS));
    };

    void decline().then(
      (ok) => {
        if (!ok) {
          scheduleSingleRetry();
        }
      },
      () => {
        scheduleSingleRetry();
      },
    );
  }, [activeRequoteKey, autoDeclineOnExpire, decline, isCountdownExpired, phase, request]);

  const remainingSeconds = remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  const progress = totalWindowMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalWindowMs)) : 0;

  const isSyntheticExpiry = Boolean(request?.synthetic && phase === 'expired');

  return {
    request,
    requestId: resolvedId,
    phase,
    isInDealing: phase === 'in_dealing',
    isRequoted: phase === 'requoted',
    isSubmitting: phase === 'accepting' || phase === 'declining',
    isSyntheticExpiry,
    isTerminal: phase !== null && isTerminalDealingPhase(phase) && !request?.synthetic,
    remainingMs,
    remainingSeconds,
    totalWindowMs,
    progress,
    isCountdownExpired,
    accept,
    decline,
  };
}
