/**
 * Awaits the dealer outcome of a dealing-queued market order (HTTP/WS 202 + dealing TLVs).
 *
 * A dealing-queued order is NOT a plain order command: the server may fill it long after the
 * 30 s order-command fallback (dealer Confirm, requote accept, timeout `auto_fill`). This module
 * replaces the plain `/order-commands/{coid}` poll for those orders with the dealing store, keyed
 * by the dealing REQUEST id (so a dealer Confirm fill that carries the `dl-<request_id>` confirm
 * coid is still matched).
 *
 * Retry behaviour (documented on purpose):
 * (i) this module and its caller never auto-retry and never resubmit an order; a timeout here is
 *     reported as the neutral DEALING_OUTCOME_PENDING, not as a failure;
 * (ii) the only server-side dedupe of a re-sent client_order_id is the gateway engine's per-account in-memory
 *     idempotency map (dealing_engine_hook.go, `acct.Idempotency[coid]`). It is NOT durable: it is lost on a
 *     gateway restart, and an order_commands row for this path is not established. Do not rely on it;
 * (iii) a new manual click creates a NEW client_order_id and therefore a new order, exactly as today.
 *
 * Used for every action the gateway can dealing-queue (PlaceMarket and ClosePosition only; see api.ts).
 * Lives in the lazy dealing chunk; `api.ts` loads it with a dynamic import only after a 202 while
 * the dealing order hooks are registered. Non-dealing orders never reach this file.
 */

import { ApiError } from '../../api/client';
import { useDealingStore } from '../../store/useDealingStore';
import {
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_CODEC_VERSION,
  type DecodedBinaryOrderResp,
} from '../binaryTcpOrderClient';
import {
  DEALING_OUTCOME_PENDING_CODE,
  DEALING_OUTCOME_PENDING_MESSAGE,
} from './dealingRuntimeHooks';
import { subscribeDealingTerminal, type DealingTerminalNotice } from './dealingEvents';
import type { DealingRequestRecord } from './dealingReducer';

/** Safety margin added to the wire expiry (timer lag, fill execution, LP round trip). */
export const DEALING_OUTCOME_SAFETY_MARGIN_MS = 15_000;
/** Used only when the server sent no usable expiry for the request. */
export const DEALING_OUTCOME_FALLBACK_WINDOW_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

/** Request id of a dealing-queued order, or null when the order is not a dealing request. */
export function findDealingRequestIdForOrder(clientOrderId: string): string | null {
  if (!clientOrderId) return null;
  return useDealingStore.getState().byClientOrderId[clientOrderId] ?? null;
}

/**
 * Local-clock deadline: wire expiry (extended by an open requote window) + safety margin.
 * Server timestamps are converted with the per-request server clock offset.
 */
export function computeDealingOutcomeDeadlineMs(
  record: DealingRequestRecord,
  submittedAtMs: number,
): number {
  const offset = record.serverNowMs > 0 ? record.serverClockOffsetMs : 0;
  let expiresServerMs = record.expiresAtMs > 0 ? record.expiresAtMs : 0;
  const requoteExpires = record.requote?.expiresAtMs ?? 0;
  if (requoteExpires > expiresServerMs) expiresServerMs = requoteExpires;
  let deadline = expiresServerMs > 0
    ? expiresServerMs - offset
    : submittedAtMs + DEALING_OUTCOME_FALLBACK_WINDOW_MS;
  deadline += DEALING_OUTCOME_SAFETY_MARGIN_MS;
  // A client accept/decline in flight gets a fresh margin for the server's answer.
  if (record.phase === 'accepting' || record.phase === 'declining') {
    deadline = Math.max(deadline, record.updatedAtMs + DEALING_OUTCOME_SAFETY_MARGIN_MS);
  }
  return deadline;
}

export function dealingFillToOrderResp(
  notice: DealingTerminalNotice,
  fallbackClientOrderId: string,
): DecodedBinaryOrderResp {
  const rec = notice.record;
  return {
    version: BINARY_ORDER_CODEC_VERSION,
    action: BINARY_ORDER_ACTION_PLACE_MARKET,
    status: 200,
    ok: true,
    execMicros: 0,
    orderTicket: notice.orderTicket ?? 0,
    positionTicket: notice.positionTicket ?? 0,
    dealTicket: notice.dealTicket ?? 0,
    fillPrice: notice.fillPrice ?? 0,
    volume: notice.volume ?? rec.volume ?? 0,
    profit: notice.profit ?? 0,
    commission: notice.commission ?? 0,
    sl: notice.sl ?? 0,
    tp: notice.tp ?? 0,
    symbol: rec.symbol || '',
    clientOrderId: fallbackClientOrderId,
    errorCode: '',
    message: '',
  };
}

/** True when the server expired the request as `recovery_unverified` (outcome unknown, a fill may exist). */
export function isRecoveryUnverified(notice: DealingTerminalNotice): boolean {
  const code = (notice.error?.code || notice.record.reasonCode || '').trim().toLowerCase();
  return code === 'recovery_unverified';
}

function dispatchRefresh(accountLogin: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('rtx:force-refresh-positions', { detail: { login: accountLogin } }));
    window.dispatchEvent(new CustomEvent('rtx:refresh-trade-history-requested', { detail: { login: accountLogin } }));
  } catch {
    // Refresh is best effort; the pending error below is what matters.
  }
}

function buildDealingError(
  status: number,
  code: string,
  message: string,
  clientOrderId: string,
): ApiError {
  const err = new ApiError(status, message, {
    code,
    error: code,
    message,
    client_order_id: clientOrderId,
  });
  Object.assign(err, {
    code,
    backendMessage: message,
    clientOrderId,
    // NOTE: no boolean `retryable` here: api.ts duck-types it as a BinaryTcpOrderError and would re-wrap the error.
  });
  return err;
}

/**
 * Resolves with a synthetic filled order response, or rejects:
 * - dealing reject/decline/expired-reject: ApiError with the dealing code (mapped by `orderError.ts`);
 * - no outcome by the deadline: ApiError `DEALING_OUTCOME_PENDING` (neutral, never a failure claim),
 *   after asking Positions/History to refresh. Never resubmits.
 * Resolves `null` when the order is not a dealing request (caller keeps the plain command path).
 */
export function awaitDealingQueuedOrderOutcome(options: {
  clientOrderId: string;
  submittedAtMs: number;
  accountLogin: number;
}): Promise<DecodedBinaryOrderResp | null> {
  const requestId = findDealingRequestIdForOrder(options.clientOrderId);
  if (requestId === null) return Promise.resolve(null);

  return new Promise<DecodedBinaryOrderResp | null>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let armedDeadline = -1;
    let unsubTerminal: (() => void) | null = null;
    let unsubStore: (() => void) | null = null;

    const cleanup = (): void => {
      done = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      unsubTerminal?.();
      unsubTerminal = null;
      unsubStore?.();
      unsubStore = null;
    };

    const rejectPending = (): void => {
      dispatchRefresh(options.accountLogin);
      reject(buildDealingError(
        202,
        DEALING_OUTCOME_PENDING_CODE,
        DEALING_OUTCOME_PENDING_MESSAGE,
        options.clientOrderId,
      ));
    };

    const onDeadline = (): void => {
      if (done) return;
      cleanup();
      rejectPending();
    };

    const rearm = (): void => {
      if (done) return;
      const rec = useDealingStore.getState().requests[requestId];
      if (!rec) return;
      const deadline = computeDealingOutcomeDeadlineMs(rec, options.submittedAtMs);
      if (timer !== null && deadline === armedDeadline) return;
      if (timer !== null) clearTimeout(timer);
      armedDeadline = deadline;
      timer = setTimeout(onDeadline, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - Date.now())));
    };

    const onTerminal = (notice: DealingTerminalNotice): void => {
      if (done) return;
      cleanup();
      if (notice.status === 'filled') {
        resolve(dealingFillToOrderResp(notice, options.clientOrderId));
        return;
      }
      // recovery_unverified: the server could NOT prove the order was never filled (a position may exist), so it is
      // neutral "still with the dealer" plus a positions refresh, never a failure and never an invitation to resend.
      if (notice.status === 'expired' && isRecoveryUnverified(notice)) {
        rejectPending();
        return;
      }
      const code = notice.error?.code || (notice.status === 'expired' ? 'DEALER_TIMEOUT' : 'DEALER_REJECTED');
      const message = notice.error?.message || code;
      const err = buildDealingError(409, code, message, options.clientOrderId);
      Object.assign(err, { preserveBackendOrderError: true });
      reject(err);
    };

    unsubTerminal = subscribeDealingTerminal({ requestId }, onTerminal);
    if (done) {
      unsubTerminal();
      unsubTerminal = null;
      return;
    }
    unsubStore = useDealingStore.subscribe(rearm);
    rearm();
    if (timer === null) {
      // Record vanished from the store (pruned): same neutral outcome after the fallback window.
      armedDeadline = options.submittedAtMs + DEALING_OUTCOME_FALLBACK_WINDOW_MS + DEALING_OUTCOME_SAFETY_MARGIN_MS;
      timer = setTimeout(
        onDeadline,
        Math.min(MAX_TIMER_DELAY_MS, Math.max(0, armedDeadline - Date.now())),
      );
    }
  });
}
