import React, { useCallback, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useUiTranslation } from '../../hooks/useUiTranslation';
import { useDialogFocusScope } from '../../hooks/useDialogFocusScope';
import { useDraggableSheet } from '../../hooks/useDraggableSheet';
import {
  AUTO_DECLINE_HEAD_GRACE_MS,
  useActiveRequoteId,
  useDealingRequest,
  type RequoteDecisionTransport,
} from '../../hooks/useDealingRequest';
import { DEALING_UI_STRINGS } from '../../services/dealing/dealingI18n';
import './dealing.css';

export interface RequoteDialogProps {
  /** Optional explicit request ID; defaults to the FIFO active requote in `useDealingStore`. */
  requestId?: string | null;
  /** Injected binary transport callback invoked for 0x38 Actions 9 (Accept) and 10 (Decline). */
  sendRequoteFrame?: RequoteDecisionTransport;
  /** Optional session getter returning active account login when record metadata omits it. */
  getAccountLogin?: () => number | null | undefined;
  authToken?: string;
  /** Automatically send Action 10 decline when countdown reaches 0 (default: true). */
  autoDeclineOnExpire?: boolean;
}

function formatPrice(value: number, digits: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const safeDigits = Number.isInteger(digits) && digits >= 0 && digits <= 12 ? digits : 5;
  return value.toFixed(safeDigits);
}

function formatVolume(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return value.toFixed(2);
}

export const RequoteDialog: React.FC<RequoteDialogProps> = ({
  requestId: explicitRequestId,
  sendRequoteFrame,
  getAccountLogin,
  authToken,
  autoDeclineOnExpire = true,
}) => {
  const tr = useUiTranslation();
  const activeRequoteId = useActiveRequoteId({
    autoDeclineGraceMs: autoDeclineOnExpire ? AUTO_DECLINE_HEAD_GRACE_MS : 0,
  });
  const targetRequestId = explicitRequestId ?? activeRequoteId;

  const {
    request,
    phase,
    isSubmitting,
    remainingSeconds,
    progress,
    isCountdownExpired,
    accept,
    decline,
  } = useDealingRequest({
    requestId: targetRequestId,
    sendRequoteFrame,
    getAccountLogin,
    authToken,
    autoDeclineOnExpire,
  });

  const isOpen = Boolean(
    request
    && !request.isExpert
    && request.requote
    && (phase === 'requoted' || phase === 'accepting' || phase === 'declining'),
  );

  const dialogRef = useRef<HTMLDivElement>(null);
  const declineBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();
  const renderedRequoteId = request?.requote?.requoteId ?? '';
  const renderedOfferedPrice = request?.requote?.offeredPrice ?? 0;

  const handleDecline = useCallback(() => {
    if (isSubmitting || phase !== 'requoted') return;
    void decline().catch(() => {
      // Transport rejection reverts store back to `requoted` so the trader can retry or wait for expiry.
    });
  }, [decline, isSubmitting, phase]);

  const handleAccept = useCallback(() => {
    if (isSubmitting || phase !== 'requoted') return;
    void accept({
      requoteId: renderedRequoteId,
      price: renderedOfferedPrice,
    }).catch(() => {
      // Transport rejection reverts store back to `requoted`.
    });
  }, [accept, isSubmitting, phase, renderedOfferedPrice, renderedRequoteId]);

  // Initial focus stays on Decline (safety against accidental Enter fill) and Escape declines only from `requoted`.
  useDialogFocusScope({
    isOpen,
    dialogRef,
    onClose: handleDecline,
    initialFocusRef: declineBtnRef,
    closeOnEscape: isOpen && !isSubmitting && phase === 'requoted',
  });
  const { dragStyle, dragHandleProps } = useDraggableSheet({ isOpen, elementRef: dialogRef });

  if (!isOpen || !request || !request.requote || request.isExpert) {
    return null;
  }

  const digits = request.digits;
  const offer = request.requote;
  const sideText = request.side === 'buy'
    ? tr(DEALING_UI_STRINGS.buyLabel)
    : request.side === 'sell'
      ? tr(DEALING_UI_STRINGS.sellLabel)
      : '—';

  const hasBidAsk = offer.bid > 0 && offer.ask > 0;
  const acceptDisabled = isSubmitting || isCountdownExpired || !(offer.offeredPrice > 0);
  const declineDisabled = isSubmitting || phase !== 'requoted';
  const formattedOfferedPrice = formatPrice(offer.offeredPrice, digits);

  return createPortal(
    <div
      className="rtx-requote-backdrop"
      onContextMenuCapture={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        style={dragStyle}
        className="rtx-requote-dialog"
      >
        <div className="rtx-requote-dialog__header" {...dragHandleProps}>
          <div className="rtx-requote-dialog__title-group">
            <h2 id={titleId} className="rtx-requote-dialog__title">
              {tr(DEALING_UI_STRINGS.requoteDialogTitle)}
            </h2>
            {request.symbol && (
              <span className="rtx-requote-dialog__symbol-badge">{request.symbol}</span>
            )}
          </div>
        </div>

        <div className="rtx-requote-dialog__body">
          <p id={descId} className="rtx-requote-dialog__subtitle">
            {tr(DEALING_UI_STRINGS.requoteSubtitle)}
          </p>

          <div className="rtx-requote-dialog__meta-grid">
            <div className="rtx-requote-dialog__stat">
              <span className="rtx-requote-dialog__stat-label">
                {tr(DEALING_UI_STRINGS.symbolLabel)}
              </span>
              <span className="rtx-requote-dialog__stat-value">{request.symbol || '—'}</span>
            </div>
            <div className="rtx-requote-dialog__stat">
              <span className="rtx-requote-dialog__stat-label">
                {tr(DEALING_UI_STRINGS.sideLabel)}
              </span>
              <span
                className={`rtx-requote-dialog__stat-value rtx-requote-dialog__side--${request.side}`}
              >
                {sideText}
              </span>
            </div>
            <div className="rtx-requote-dialog__stat">
              <span className="rtx-requote-dialog__stat-label">
                {tr(DEALING_UI_STRINGS.volumeLabel)}
              </span>
              <span className="rtx-requote-dialog__stat-value">{formatVolume(request.volume)}</span>
            </div>
          </div>

          {hasBidAsk ? (
            <div className="rtx-requote-dialog__quotes">
              <div
                className={`rtx-requote-dialog__quote-card ${
                  request.side === 'sell' ? 'rtx-requote-dialog__quote-card--active' : ''
                }`.trim()}
              >
                <span className="rtx-requote-dialog__quote-label">
                  {tr(DEALING_UI_STRINGS.newBidLabel)}
                </span>
                <span className="rtx-requote-dialog__quote-price" data-testid="requote-bid">
                  {formatPrice(offer.bid, digits)}
                </span>
              </div>
              <div
                className={`rtx-requote-dialog__quote-card ${
                  request.side === 'buy' ? 'rtx-requote-dialog__quote-card--active' : ''
                }`.trim()}
              >
                <span className="rtx-requote-dialog__quote-label">
                  {tr(DEALING_UI_STRINGS.newAskLabel)}
                </span>
                <span className="rtx-requote-dialog__quote-price" data-testid="requote-ask">
                  {formatPrice(offer.ask, digits)}
                </span>
              </div>
            </div>
          ) : (
            <div className="rtx-requote-dialog__quote-card rtx-requote-dialog__quote-card--active">
              <span className="rtx-requote-dialog__quote-label">
                {tr(DEALING_UI_STRINGS.offeredPriceLabel)}
              </span>
              <span className="rtx-requote-dialog__quote-price" data-testid="requote-price">
                {formattedOfferedPrice}
              </span>
            </div>
          )}

          {request.requestedPrice > 0 && (
            <div className="rtx-requote-dialog__requested-row">
              <span>{tr(DEALING_UI_STRINGS.requestedPriceLabel)}</span>
              <span>{formatPrice(request.requestedPrice, digits)}</span>
            </div>
          )}

          <div className="rtx-requote-dialog__countdown">
            <div className="rtx-requote-dialog__countdown-row">
              <span>{tr(DEALING_UI_STRINGS.timeRemainingLabel)}</span>
              <span data-testid="requote-countdown">
                {tr(DEALING_UI_STRINGS.secondsShort, { seconds: remainingSeconds })}
              </span>
            </div>
            <div className="rtx-requote-dialog__countdown-track" aria-hidden="true">
              <div
                className="rtx-requote-dialog__countdown-bar"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          </div>

          {/* Synthetic safety expiry closes this modal; DealingStatusChip renders awaitingConfirmation. */}
          {isCountdownExpired && (
            <div className="rtx-requote-dialog__expired" role="status">
              {phase === 'accepting'
                ? tr(DEALING_UI_STRINGS.awaitingConfirmation)
                : tr(DEALING_UI_STRINGS.requoteExpiredNotice)}
            </div>
          )}
        </div>

        <div className="rtx-requote-dialog__footer">
          <button
            ref={declineBtnRef}
            type="button"
            onClick={handleDecline}
            disabled={declineDisabled}
            className="rtx-requote-dialog__btn rtx-requote-dialog__btn--decline"
          >
            {phase === 'declining'
              ? tr(DEALING_UI_STRINGS.decliningRequote)
              : tr(DEALING_UI_STRINGS.declineRequoteButton)}
          </button>
          <button
            type="button"
            onClick={handleAccept}
            disabled={acceptDisabled}
            className="rtx-requote-dialog__btn rtx-requote-dialog__btn--accept"
          >
            {phase === 'accepting'
              ? tr(DEALING_UI_STRINGS.acceptingRequote)
              : formattedOfferedPrice !== '—'
                ? tr(DEALING_UI_STRINGS.acceptRequoteAtPriceButton, { price: formattedOfferedPrice })
                : tr(DEALING_UI_STRINGS.acceptRequoteButton)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
