/**
 * Brand-neutral English i18n keys for the terminal dealing UI.
 *
 * Matches the repository's `ui` namespace convention (English sentence as key,
 * `keySeparator: false`) used by `useUiTranslation()` (`src/hooks/useUiTranslation.ts`).
 *
 * PHASE-B: merge these keys into `src/locales/en/ui.json`, update
 * `src/locales/translation-todo.json` and `src/locales/NEEDS_TRANSLATION.md`,
 * and run `catalogs.test.ts` + `brandNeutralValues.test.ts`.
 */

export const DEALING_UI_STRINGS = {
  requestSentToDealer: 'Request sent to dealer…',
  awaitingConfirmation: 'Awaiting dealer confirmation…',
  requoteReceived: 'Requote received',
  acceptingRequote: 'Accepting requote…',
  decliningRequote: 'Declining requote…',
  orderFilledByDealer: 'Order filled by dealer',
  orderRejectedByDealer: 'Order rejected by dealer',
  dealingRequestExpired: 'Dealing request expired',
  dealingRequestCancelled: 'Dealing request cancelled',
  statusUnknownCheckHistory: 'Status unknown — check your positions or history',
  requoteDialogTitle: 'Dealer Requote',
  requoteSubtitle: 'The dealer offered a new quote for your order. Press Escape to decline.',
  symbolLabel: 'Symbol',
  sideLabel: 'Side',
  volumeLabel: 'Volume',
  requestedPriceLabel: 'Requested Price',
  newBidLabel: 'New Bid',
  newAskLabel: 'New Ask',
  offeredPriceLabel: 'New Quote Price',
  timeRemainingLabel: 'Time remaining',
  secondsShort: '{{seconds}}s',
  acceptRequoteButton: 'Accept',
  acceptRequoteAtPriceButton: 'Accept @ {{price}}',
  declineRequoteButton: 'Decline',
  requoteExpiredNotice: 'Requote expired',
  buyLabel: 'BUY',
  sellLabel: 'SELL',
} as const;

/**
 * Brand-neutral English i18n keys for §3.9 / §9.4 dealer reason codes.
 * Used via `useUiTranslation()` (`keySeparator: false`) in `DealingStatusChip`.
 */
export const DEALING_REASON_UI_STRINGS = {
  DEALER_REJECTED: 'Order rejected by dealer',
  DEALER_TIMEOUT: 'Dealing request timed out',
  TIMEOUT_REJECTED: 'Dealing request timed out',
  OFF_QUOTES: 'Off quotes — market price unavailable',
  MARKET_CLOSED: 'Market is closed',
  INVALID_PRICE: 'Invalid order price',
  INSUFFICIENT_LIQUIDITY: 'Insufficient liquidity for requested volume',
  RISK_LIMIT: 'Order exceeds risk or exposure limits',
  TOXIC_FLOW: 'Order rejected by dealing policy',
  ROBOT_REJECTED: 'Order rejected by dealing policy',
  NO_DEALER: 'No dealer available to handle request',
  DEALING_NOT_ENABLED: 'No dealer available to handle request',
  NO_MONEY: 'Insufficient free margin',
  MARGIN_RECHECK_FAILED: 'Insufficient free margin at execution confirmation',
  CLIENT_DECLINED: 'Requote declined by client',
  REQUOTE_DECLINED: 'Requote declined by client',
  REQUOTE_EXPIRED: 'Requote window expired',
  GATEWAY_LOST: 'Gateway lost — cancelled by risk safety-net sweeper',
  LEGACY_MIGRATION: 'Cancelled cleanly during schema migration',
  DEALING_ALREADY_RESOLVED: 'Dealing request already resolved',
  REQUOTE: 'Market price changed (requote). Please review the new quote.',
} as const;

export type DealingUiStringKey = (typeof DEALING_UI_STRINGS)[keyof typeof DEALING_UI_STRINGS];
export type DealingReasonUiStringKey =
  (typeof DEALING_REASON_UI_STRINGS)[keyof typeof DEALING_REASON_UI_STRINGS];

export const DEALING_UI_STRING_KEYS: readonly string[] = Object.freeze(
  Array.from(
    new Set<string>([
      ...Object.values(DEALING_UI_STRINGS),
      ...Object.values(DEALING_REASON_UI_STRINGS),
    ]),
  ),
);
