/**
 * Closed reject & outcome reason-code catalog for Dealing Desk & Robot Dealer.
 *
 * Mirrors:
 *   - `DEALING_DESIGN/w1-api-contract/API_CONTRACT.md` §3.9 & §9.4
 *   - `services/gateway/internal/dealing/types.go` ReasonCode enum
 *   - `DEALING_DESIGN/DECISIONS.md` D2, D7
 *
 * Phase-B: merge `DEALING_ORDER_ERROR_MESSAGES` and `DEALING_EXPLAINED_REJECTION_CODES`
 * into `src/utils/orderError.ts`.
 */

import { MAX_REASON_TEXT_BYTES } from './binaryDealingCodec';
import { DEALING_REASON_UI_STRINGS } from './dealingI18n';

const URL_LIKE_RE = /\b(?:wss?|https?):\/\/\S+/gi;
const HOST_PORT_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;

/** All 17 §3.9 trader-facing reject codes. */
export const DEALING_REJECT_CODES = [
  'DEALER_REJECTED',
  'DEALER_TIMEOUT',
  'TIMEOUT_REJECTED',
  'OFF_QUOTES',
  'MARKET_CLOSED',
  'INVALID_PRICE',
  'INSUFFICIENT_LIQUIDITY',
  'RISK_LIMIT',
  'TOXIC_FLOW',
  'ROBOT_REJECTED',
  'NO_DEALER',
  'NO_MONEY',
  'MARGIN_RECHECK_FAILED',
  'CLIENT_DECLINED',
  'REQUOTE_DECLINED',
  'REQUOTE_EXPIRED',
  'CUSTOM',
] as const;

export type DealingRejectReasonCode = (typeof DEALING_REJECT_CODES)[number];

export type DealingReasonCode =
  | DealingRejectReasonCode
  | 'GATEWAY_LOST'
  | 'LEGACY_MIGRATION'
  | 'DEALING_ALREADY_RESOLVED'
  | 'DEALING_NOT_ENABLED'
  | 'REQUOTE'
  | 'IN_DEALING'
  | 'DEALER_REQUOTE';

/**
 * Exact default trader-facing text for every reason code (`API_CONTRACT.md` §3.9 & §9.4).
 * Sourced from `DEALING_REASON_UI_STRINGS` so code fallbacks stay aligned with i18n keys.
 */
export const DEALING_REASON_DEFAULT_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...DEALING_REASON_UI_STRINGS,
  CUSTOM: '',
});

/**
 * Ready-to-merge additions for `LOCAL_TRADING_ERROR_MESSAGES` in `src/utils/orderError.ts` (PHASE-B).
 */
export const DEALING_ORDER_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  DEALER_REJECTED: 'order rejected by dealer.',
  DEALER_TIMEOUT: 'dealing request timed out.',
  TIMEOUT_REJECTED: 'dealing request timed out.',
  OFF_QUOTES: 'off quotes — market price unavailable.',
  MARKET_CLOSED: 'the market is currently closed for this symbol.',
  INVALID_PRICE: 'the requested order price is invalid or out of range.',
  INSUFFICIENT_LIQUIDITY: 'insufficient liquidity for the requested volume.',
  RISK_LIMIT: 'order exceeds risk or exposure limits.',
  TOXIC_FLOW: 'order rejected by dealing policy.',
  ROBOT_REJECTED: 'order rejected by dealing policy.',
  NO_DEALER: 'no dealer is available to handle this request.',
  DEALING_NOT_ENABLED: 'dealing is not enabled on this server.',
  NO_MONEY: 'insufficient free margin to complete this order.',
  MARGIN_RECHECK_FAILED: 'insufficient free margin at execution confirmation.',
  CLIENT_DECLINED: 'requote was declined.',
  REQUOTE_DECLINED: 'requote was declined.',
  REQUOTE_EXPIRED: 'requote window expired.',
  GATEWAY_LOST: 'dealing request was cancelled after a gateway interruption.',
  LEGACY_MIGRATION: 'dealing request was cancelled cleanly during system upgrade.',
  DEALING_ALREADY_RESOLVED: 'this dealing request has already been resolved.',
  REQUOTE: 'market price changed (requote). Please try placing the order again.',
  CUSTOM: 'order rejected by dealer.',
});

/**
 * Ready-to-merge additions for `TRADER_EXPLAINED_REJECTION_CODES` in `src/utils/orderError.ts` (PHASE-B).
 */
export const DEALING_EXPLAINED_REJECTION_CODES: ReadonlySet<string> = new Set([
  'DEALER_REJECTED',
  'DEALER_TIMEOUT',
  'TIMEOUT_REJECTED',
  'OFF_QUOTES',
  'MARKET_CLOSED',
  'INVALID_PRICE',
  'INSUFFICIENT_LIQUIDITY',
  'RISK_LIMIT',
  'TOXIC_FLOW',
  'ROBOT_REJECTED',
  'NO_DEALER',
  'NO_MONEY',
  'MARGIN_RECHECK_FAILED',
  'CLIENT_DECLINED',
  'REQUOTE_DECLINED',
  'REQUOTE_EXPIRED',
  'DEALING_NOT_ENABLED',
  'GATEWAY_LOST',
  'LEGACY_MIGRATION',
  'DEALING_ALREADY_RESOLVED',
  'REQUOTE',
  'CUSTOM',
]);

const utf8Encoder = new TextEncoder();

/**
 * Sanitizes trader-facing `reason_text`:
 * - scrubs internal URLs and host:port tokens
 * - strips ASCII control chars (`< 0x20`, `0x7f`) and angle brackets (`<`, `>`)
 * - truncates cleanly on valid UTF-8 code-point boundaries to `<= 200` bytes (`API_CONTRACT.md` §3.9)
 */
export function sanitizeDealingReasonText(rawText: unknown): string {
  if (typeof rawText !== 'string') return '';
  const scrubbed = rawText
    .replace(URL_LIKE_RE, '[server]')
    .replace(HOST_PORT_RE, '[server]')
    .trim();
  if (!scrubbed) return '';

  let result = '';
  let byteCount = 0;
  for (const ch of scrubbed) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || cp < 0x20 || cp === 0x7f || cp === 0x3c || cp === 0x3e) {
      continue;
    }
    const chBytes = utf8Encoder.encode(ch).byteLength;
    if (byteCount + chBytes > MAX_REASON_TEXT_BYTES) {
      break;
    }
    result += ch;
    byteCount += chBytes;
  }
  return result.trim();
}

export function isKnownDealingReasonCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const upper = code.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(DEALING_REASON_DEFAULT_MESSAGES, upper);
}

export function getDealingReasonDefaultMessage(code: unknown): string {
  if (typeof code !== 'string') return '';
  const upper = code.trim().toUpperCase();
  return DEALING_REASON_DEFAULT_MESSAGES[upper] ?? '';
}

export function getDealingReasonI18nKey(code: unknown): string {
  if (typeof code !== 'string') return '';
  const upper = code.trim().toUpperCase();
  return (DEALING_REASON_UI_STRINGS as Record<string, string>)[upper] ?? '';
}

export interface DealingReasonDisplayResolution {
  i18nKey: string | null;
  verbatimText: string;
}

/**
 * Determines whether a terminal reason should be rendered via a translated
 * `DEALING_REASON_UI_STRINGS` key or as sanitized verbatim custom dealer text.
 */
export function resolveDealingReasonDisplay(
  reasonCode?: string | null,
  reasonText?: string | null,
): DealingReasonDisplayResolution {
  const code = typeof reasonCode === 'string' ? reasonCode.trim().toUpperCase() : '';
  const cleanText = sanitizeDealingReasonText(reasonText);
  const codeKey = getDealingReasonI18nKey(code);

  if (cleanText && cleanText.toUpperCase() !== code) {
    if (code === 'CUSTOM' || !codeKey || cleanText !== codeKey) {
      return { i18nKey: null, verbatimText: cleanText };
    }
  }

  return {
    i18nKey: codeKey || DEALING_REASON_UI_STRINGS.DEALER_REJECTED,
    verbatimText: '',
  };
}

/**
 * Resolves a safe trader-facing reason message from `(reasonCode, reasonText)`.
 * Custom dealer text is displayed verbatim after sanitization (never translated);
 * standard reason codes resolve via `DEALING_REASON_UI_STRINGS` (using `translate` when provided).
 */
export function formatDealingReasonMessage(
  reasonCode?: string | null,
  reasonText?: string | null,
  translate?: (key: string) => string,
): string {
  const resolved = resolveDealingReasonDisplay(reasonCode, reasonText);
  if (resolved.i18nKey) {
    return translate ? translate(resolved.i18nKey) : resolved.i18nKey;
  }
  return resolved.verbatimText;
}
