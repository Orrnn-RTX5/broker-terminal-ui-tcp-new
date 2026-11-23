import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import {
  DEALING_EXPLAINED_REJECTION_CODES,
  DEALING_ORDER_ERROR_MESSAGES,
  DEALING_REJECT_CODES,
} from '../services/dealing/dealingReasonMessages';
import { OrderCommandTerminalError } from '../services/orderCommandLifecycle';
import { formatOrderError } from './orderError';

const makePreservedBinaryError = (code: string, message = code) =>
  new OrderCommandTerminalError(
    {
      status: 'rejected',
      terminal: true,
      clientOrderId: `cid-${code.toLowerCase()}`,
      error: { code, message },
      raw: {},
    },
    `cid-${code.toLowerCase()}`,
  );

describe('formatOrderError dealing reason codes', () => {
  it('maps every §3.9 reject code and operational dealing code to a friendly trader message across Binary TCP and REST', () => {
    const allCodes = Array.from(
      new Set<string>([
        ...DEALING_REJECT_CODES,
        'GATEWAY_LOST',
        'LEGACY_MIGRATION',
        'DEALING_ALREADY_RESOLVED',
        'REQUOTE',
      ]),
    );

    for (const code of allCodes) {
      expect(DEALING_ORDER_ERROR_MESSAGES[code], `DEALING_ORDER_ERROR_MESSAGES.${code}`).toBeTruthy();
      expect(DEALING_EXPLAINED_REJECTION_CODES.has(code), `DEALING_EXPLAINED_REJECTION_CODES.${code}`).toBe(true);

      const binaryResult = formatOrderError(makePreservedBinaryError(code));
      expect(binaryResult.startsWith('Order failed: '), `binary ${code}: ${binaryResult}`).toBe(true);
      expect(binaryResult, `binary ${code}`).not.toBe(code);

      const apiResult = formatOrderError(new ApiError(400, code, { code }));
      expect(apiResult.startsWith('Order failed: '), `api ${code}: ${apiResult}`).toBe(true);
      expect(apiResult, `api ${code}`).not.toBe(code);
    }
  });

  it('produces exact expected copy for every newly added dealing error code', () => {
    const expectedCases: ReadonlyArray<readonly [string, string]> = [
      ['DEALER_REJECTED', 'Order failed: order rejected by dealer.'],
      ['DEALER_TIMEOUT', 'Order failed: dealing request timed out.'],
      ['TIMEOUT_REJECTED', 'Order failed: dealing request timed out.'],
      ['INSUFFICIENT_LIQUIDITY', 'Order failed: insufficient liquidity for the requested volume.'],
      ['RISK_LIMIT', 'Order failed: order exceeds risk or exposure limits.'],
      ['TOXIC_FLOW', 'Order failed: order rejected by dealing policy.'],
      ['ROBOT_REJECTED', 'Order failed: order rejected by dealing policy.'],
      ['NO_DEALER', 'Order failed: no dealer is available to handle this request.'],
      ['MARGIN_RECHECK_FAILED', 'Order failed: insufficient free margin at execution confirmation.'],
      ['CLIENT_DECLINED', 'Order failed: requote was declined.'],
      ['REQUOTE_DECLINED', 'Order failed: requote was declined.'],
      ['REQUOTE_EXPIRED', 'Order failed: requote window expired.'],
      ['GATEWAY_LOST', 'Order failed: dealing request was cancelled after a gateway interruption.'],
      ['LEGACY_MIGRATION', 'Order failed: dealing request was cancelled cleanly during system upgrade.'],
      ['DEALING_ALREADY_RESOLVED', 'Order failed: this dealing request has already been resolved.'],
      ['CUSTOM', 'Order failed: order rejected by dealer.'],
    ];

    for (const [code, expected] of expectedCases) {
      expect(formatOrderError(makePreservedBinaryError(code)), `WS ${code}`).toBe(expected);
      expect(
        formatOrderError({
          preserveBackendOrderError: true,
          code,
          backendMessage: code,
        }),
        `preserved ${code}`,
      ).toBe(expected);
      expect(formatOrderError(new ApiError(400, code, { code })), `REST ${code}`).toBe(expected);
    }
  });

  it('preserves and scrubs dealer detail on explained dealing rejections without altering non-dealing codes', () => {
    expect(
      formatOrderError(makePreservedBinaryError('RISK_LIMIT', 'Max lot 2.00 exceeded')),
    ).toBe('Order failed: order exceeds risk or exposure limits (Max lot 2.00 exceeded).');

    expect(
      formatOrderError(makePreservedBinaryError('CUSTOM', 'Spread spiked at http://10.0.0.1:8092/internal')),
    ).toBe('Order failed: order rejected by dealer (Spread spiked at [server]).');

    expect(
      formatOrderError(makePreservedBinaryError('INVALID_PRICE', 'Price outside quoted band')),
    ).toBe('Order failed: the requested order price is invalid or out of range (Price outside quoted band).');

    expect(
      formatOrderError(makePreservedBinaryError('REQUOTE', 'New quote 1.1050')),
    ).toBe('Order failed: market price changed (requote). Please try placing the order again (New quote 1.1050).');

    expect(formatOrderError(makePreservedBinaryError('OFF_QUOTES'))).toBe(
      'Order failed: no live quote is available for this symbol right now.',
    );
    expect(formatOrderError(makePreservedBinaryError('MARKET_CLOSED'))).toBe(
      'Order failed: the market is currently closed for this symbol.',
    );
    expect(formatOrderError(makePreservedBinaryError('NO_MONEY'))).toBe(
      'Order failed: insufficient account balance or free margin to place this order.',
    );

    // Dealing mappings must not own or alter non-dealing codes such as 10026.
    expect(DEALING_ORDER_ERROR_MESSAGES['10026']).toBeUndefined();
    expect(DEALING_ORDER_ERROR_MESSAGES.TRADE_RETCODE_SERVER_DISABLES_AT).toBeUndefined();
    expect(DEALING_EXPLAINED_REJECTION_CODES.has('10026')).toBe(false);
    expect(DEALING_EXPLAINED_REJECTION_CODES.has('TRADE_RETCODE_SERVER_DISABLES_AT')).toBe(false);

    const preserved10026 = formatOrderError({
      preserveBackendOrderError: true,
      code: '10026',
      backendMessage: 'TRADE_RETCODE_SERVER_DISABLES_AT',
    });
    const terminal10026 = formatOrderError(
      makePreservedBinaryError('10026', 'TRADE_RETCODE_SERVER_DISABLES_AT'),
    );
    expect(preserved10026).toBe(terminal10026);
    expect(preserved10026.length).toBeGreaterThan(0);
    for (const dealingMsg of Object.values(DEALING_ORDER_ERROR_MESSAGES)) {
      expect(preserved10026).not.toContain(dealingMsg);
    }

    expect(
      formatOrderError({
        preserveBackendOrderError: true,
        code: 'NON_DEALING_CODE',
        backendMessage: 'Custom backend detail',
      }),
    ).toBe('NON_DEALING_CODE: Custom backend detail');
  });
});
