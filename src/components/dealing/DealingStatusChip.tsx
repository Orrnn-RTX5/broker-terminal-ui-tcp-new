import React from 'react';
import { useUiTranslation } from '../../hooks/useUiTranslation';
import { useDealingRequest } from '../../hooks/useDealingRequest';
import { DEALING_UI_STRINGS } from '../../services/dealing/dealingI18n';
import { resolveDealingReasonDisplay } from '../../services/dealing/dealingReasonMessages';
import './dealing.css';

export interface DealingStatusChipProps {
  requestId?: string | null;
  clientOrderId?: string | null;
  symbol?: string | null;
  /** Keep showing terminal outcome (filled/rejected/expired/cancelled) until pruned (default: false). */
  showTerminal?: boolean;
  className?: string;
}

export const DealingStatusChip: React.FC<DealingStatusChipProps> = ({
  requestId,
  clientOrderId,
  symbol,
  showTerminal = false,
  className = '',
}) => {
  const tr = useUiTranslation();
  const {
    request,
    phase,
    isTerminal,
    remainingSeconds,
  } = useDealingRequest({
    requestId,
    clientOrderId,
    symbol,
    autoDeclineOnExpire: false,
  });

  if (!request || !phase) return null;
  if (isTerminal && !showTerminal) return null;

  let label: string;
  let showSpinner = false;

  switch (phase) {
    case 'in_dealing':
      label = tr(DEALING_UI_STRINGS.requestSentToDealer);
      showSpinner = true;
      break;
    case 'requoted':
      label = tr(DEALING_UI_STRINGS.requoteReceived);
      break;
    case 'accepting':
      label = tr(DEALING_UI_STRINGS.acceptingRequote);
      showSpinner = true;
      break;
    case 'declining':
      label = tr(DEALING_UI_STRINGS.decliningRequote);
      showSpinner = true;
      break;
    case 'filled':
      label = tr(DEALING_UI_STRINGS.orderFilledByDealer);
      break;
    case 'expired':
    case 'cancelled':
    case 'rejected': {
      if (request.synthetic && phase === 'expired') {
        label = tr(DEALING_UI_STRINGS.awaitingConfirmation);
        showSpinner = true;
        break;
      }
      const fallbackKey =
        phase === 'expired'
          ? DEALING_UI_STRINGS.dealingRequestExpired
          : phase === 'cancelled'
            ? DEALING_UI_STRINGS.dealingRequestCancelled
            : DEALING_UI_STRINGS.orderRejectedByDealer;
      if (request.reasonCode || request.reasonText) {
        const display = resolveDealingReasonDisplay(request.reasonCode, request.reasonText);
        label = display.i18nKey ? tr(display.i18nKey) : (display.verbatimText || tr(fallbackKey));
      } else {
        label = tr(fallbackKey);
      }
      break;
    }
  }

  return (
    <span
      role="status"
      aria-live="polite"
      data-dealing-phase={phase}
      data-dealing-synthetic={request.synthetic ? 'true' : undefined}
      className={`rtx-dealing-chip rtx-dealing-chip--${phase} ${className}`.trim()}
    >
      {showSpinner && (
        <svg
          className="rtx-dealing-chip__spinner"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r="6"
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="2"
          />
          <path
            d="M14 8a6 6 0 0 0-6-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span className="rtx-dealing-chip__label">{label}</span>
      {!isTerminal && remainingSeconds > 0 && (
        <span className="rtx-dealing-chip__countdown" aria-hidden="true">
          {tr(DEALING_UI_STRINGS.secondsShort, { seconds: remainingSeconds })}
        </span>
      )}
    </span>
  );
};
