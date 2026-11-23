import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { OrderCommandTerminalError } from '../orderCommandLifecycle';
import { formatOrderError } from '../../utils/orderError';
import { MAX_REASON_TEXT_BYTES } from './binaryDealingCodec';
import {
  DEALING_REASON_UI_STRINGS,
  DEALING_UI_STRING_KEYS,
  DEALING_UI_STRINGS,
} from './dealingI18n';
import {
  DEALING_EXPLAINED_REJECTION_CODES,
  DEALING_ORDER_ERROR_MESSAGES,
  DEALING_REASON_DEFAULT_MESSAGES,
  DEALING_REJECT_CODES,
  formatDealingReasonMessage,
  getDealingReasonDefaultMessage,
  getDealingReasonI18nKey,
  isKnownDealingReasonCode,
  resolveDealingReasonDisplay,
  sanitizeDealingReasonText,
} from './dealingReasonMessages';

const VENDOR_BRAND_RE = /rtx[\s-]?5|orrnn/i;

describe('dealingReasonMessages & dealingI18n', () => {
  it('covers all 17 §3.9 reject codes plus D2/D7/§9.4 operational codes', () => {
    expect(DEALING_REJECT_CODES).toHaveLength(17);

    for (const code of DEALING_REJECT_CODES) {
      expect(isKnownDealingReasonCode(code), code).toBe(true);
      expect(DEALING_ORDER_ERROR_MESSAGES[code], code).toBeTruthy();
      expect(DEALING_EXPLAINED_REJECTION_CODES.has(code), code).toBe(true);
      if (code !== 'CUSTOM') {
        expect(getDealingReasonDefaultMessage(code), code).toBeTruthy();
      }
    }

    for (const extra of ['GATEWAY_LOST', 'LEGACY_MIGRATION', 'DEALING_ALREADY_RESOLVED', 'REQUOTE']) {
      expect(isKnownDealingReasonCode(extra), extra).toBe(true);
      expect(getDealingReasonDefaultMessage(extra), extra).toBeTruthy();
      expect(DEALING_ORDER_ERROR_MESSAGES[extra], extra).toBeTruthy();
      expect(DEALING_EXPLAINED_REJECTION_CODES.has(extra), extra).toBe(true);
    }
  });

  it('sanitizes URLs, host:port, HTML brackets, control chars, and enforces <= 200 UTF-8 bytes', () => {
    const dirty = 'Rejected via https://10.0.0.1:8092/internal <script>alert(1)</script>\x00\x07';
    const clean = sanitizeDealingReasonText(dirty);
    expect(clean).not.toContain('10.0.0.1');
    expect(clean).not.toContain('https://');
    expect(clean).not.toContain('<');
    expect(clean).not.toContain('>');
    expect(clean).not.toContain('\x00');
    expect(clean).not.toContain('\x07');

    // Multi-byte UTF-8 boundary truncation (200 bytes max without splitting surrogate pairs)
    const multiByte = '€'.repeat(100); // 300 UTF-8 bytes
    const capped = sanitizeDealingReasonText(multiByte);
    expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(MAX_REASON_TEXT_BYTES);
    expect(capped.length).toBe(66); // 66 * 3 = 198 bytes
  });

  it('formats CUSTOM and code-only rejections cleanly', () => {
    expect(formatDealingReasonMessage('OFF_QUOTES', '')).toBe(DEALING_REASON_DEFAULT_MESSAGES.OFF_QUOTES);
    expect(formatDealingReasonMessage('OFF_QUOTES', 'OFF_QUOTES')).toBe(DEALING_REASON_DEFAULT_MESSAGES.OFF_QUOTES);
    expect(formatDealingReasonMessage('CUSTOM', 'Spread spiked beyond dealer limit')).toBe('Spread spiked beyond dealer limit');
    expect(formatDealingReasonMessage('UNKNOWN_CODE', '')).toBe(DEALING_REASON_DEFAULT_MESSAGES.DEALER_REJECTED);
  });

  it('routes reason codes through i18n keys while keeping custom text verbatim', () => {
    const tr = vi.fn((key: string) => `[es] ${key}`);

    expect(getDealingReasonI18nKey('risk_limit')).toBe(DEALING_REASON_UI_STRINGS.RISK_LIMIT);
    expect(resolveDealingReasonDisplay('RISK_LIMIT', '')).toEqual({
      i18nKey: DEALING_REASON_UI_STRINGS.RISK_LIMIT,
      verbatimText: '',
    });
    // Standard English default echoed by server still resolves through i18n key for localization
    expect(resolveDealingReasonDisplay('RISK_LIMIT', DEALING_REASON_UI_STRINGS.RISK_LIMIT)).toEqual({
      i18nKey: DEALING_REASON_UI_STRINGS.RISK_LIMIT,
      verbatimText: '',
    });
    expect(formatDealingReasonMessage('RISK_LIMIT', '', tr)).toBe(
      `[es] ${DEALING_REASON_UI_STRINGS.RISK_LIMIT}`,
    );
    expect(tr).toHaveBeenCalledWith(DEALING_REASON_UI_STRINGS.RISK_LIMIT);

    // Custom verbatim dealer message is sanitized but never passed through translator
    tr.mockClear();
    expect(resolveDealingReasonDisplay('CUSTOM', 'Desk manual note')).toEqual({
      i18nKey: null,
      verbatimText: 'Desk manual note',
    });
    expect(formatDealingReasonMessage('CUSTOM', 'Desk manual note', tr)).toBe('Desk manual note');
    expect(tr).not.toHaveBeenCalled();

    // Non-matching custom dealer detail on a code still shows sanitized verbatim text
    expect(resolveDealingReasonDisplay('RISK_LIMIT', 'Symbol lot cap 2.00 exceeded')).toEqual({
      i18nKey: null,
      verbatimText: 'Symbol lot cap 2.00 exceeded',
    });
  });

  it('keeps dealing UI i18n keys brand-neutral and non-empty', () => {
    const uniqueExpected = new Set([
      ...Object.values(DEALING_UI_STRINGS),
      ...Object.values(DEALING_REASON_UI_STRINGS),
    ]);
    expect(DEALING_UI_STRING_KEYS.length).toBe(uniqueExpected.size);
    for (const key of DEALING_UI_STRING_KEYS) {
      expect(key.trim().length).toBeGreaterThan(0);
      expect(VENDOR_BRAND_RE.test(key)).toBe(false);
    }
    for (const msg of Object.values(DEALING_REASON_DEFAULT_MESSAGES)) {
      expect(VENDOR_BRAND_RE.test(msg)).toBe(false);
    }
  });

  it('MINOR-2: formats DEALING_NOT_ENABLED in orderError.ts without altering non-dealing codes', () => {
    expect(isKnownDealingReasonCode('DEALING_NOT_ENABLED')).toBe(true);
    expect(DEALING_ORDER_ERROR_MESSAGES.DEALING_NOT_ENABLED).toBe(
      'dealing is not enabled on this server.',
    );
    expect(DEALING_EXPLAINED_REJECTION_CODES.has('DEALING_NOT_ENABLED')).toBe(true);

    const preserved = new OrderCommandTerminalError(
      {
        status: 'rejected',
        terminal: true,
        clientOrderId: 'cid-dealing-disabled',
        error: { code: 'DEALING_NOT_ENABLED', message: 'DEALING_NOT_ENABLED' },
        raw: {},
      },
      'cid-dealing-disabled',
    );
    expect(formatOrderError(preserved)).toBe('Order failed: dealing is not enabled on this server.');
    expect(formatOrderError(new ApiError(501, 'DEALING_NOT_ENABLED', { code: 'DEALING_NOT_ENABLED' }))).toBe(
      'Order failed: dealing is not enabled on this server.',
    );

    expect(isKnownDealingReasonCode('10026')).toBe(false);
    expect(isKnownDealingReasonCode('TRADE_RETCODE_SERVER_DISABLES_AT')).toBe(false);

    const preserved10026 = formatOrderError({
      preserveBackendOrderError: true,
      code: '10026',
      backendMessage: 'TRADE_RETCODE_SERVER_DISABLES_AT',
    });
    const terminal10026 = formatOrderError(
      new OrderCommandTerminalError(
        {
          status: 'rejected',
          terminal: true,
          clientOrderId: 'cid-10026',
          error: { code: '10026', message: 'TRADE_RETCODE_SERVER_DISABLES_AT' },
          raw: {},
        },
        'cid-10026',
      ),
    );
    expect(preserved10026).toBe(terminal10026);
    expect(preserved10026).not.toBe('Order failed: dealing is not enabled on this server.');
  });
});
