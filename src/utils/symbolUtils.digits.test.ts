import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatPrice,
  resolveSpecDigits,
  stripFloatPrecisionNoise,
} from './symbolUtils';
import {
  readRegisteredSymbolPriceSpec,
  registerDailyChangePriceModes,
  resetDailyChangePriceModeRegistryForTests,
} from '../services/dailyChangePriceModeRegistry';
import {
  commitBrokerAccountSessionScope,
} from '../services/brokerSession';

describe('symbolUtils — exact broker digits & float precision noise', () => {
  beforeEach(() => {
    commitBrokerAccountSessionScope({
      authenticated: true,
      accountId: '200003',
      brokerId: 'tradex',
      serverUrl: 'https://tradex.example',
    });
    resetDailyChangePriceModeRegistryForTests();
  });

  afterEach(() => {
    commitBrokerAccountSessionScope({ authenticated: false, brokerId: '', serverUrl: '' });
    resetDailyChangePriceModeRegistryForTests();
  });

  it('formats BTCUSD prices with exact 2 digits (toFixed(2)) including trailing zeros and float artifacts', () => {
    const btcDigits = 2;
    expect(formatPrice(75755.51000000001, btcDigits)).toBe('75755.51');
    expect(formatPrice(75756.12000000001, btcDigits)).toBe('75756.12');
    expect(formatPrice(75758.68000000001, btcDigits)).toBe('75758.68');
    expect(formatPrice(75755.5, btcDigits)).toBe('75755.50');
    expect(formatPrice(75756.03, btcDigits)).toBe('75756.03');
    expect(formatPrice(75758.7, btcDigits)).toBe('75758.70');
    expect(formatPrice(75736.48, btcDigits)).toBe('75736.48');
  });

  it('strips IEEE-754 float64 arithmetic noise when digits are null while preserving genuine decimals', () => {
    expect(stripFloatPrecisionNoise(75755.51000000001)).toBe(75755.51);
    expect(stripFloatPrecisionNoise(75756.12000000001)).toBe(75756.12);
    expect(stripFloatPrecisionNoise(75758.68000000001)).toBe(75758.68);
    expect(formatPrice(75755.51000000001, undefined)).toBe('75755.51');
    expect(formatPrice(75756.12000000001, null)).toBe('75756.12');
    expect(formatPrice(75758.68000000001)).toBe('75758.68');

    // Genuine decimals stay untouched when digits are null
    expect(formatPrice(1.123456789)).toBe('1.123456789');
    expect(formatPrice(0.000012345)).toBe('0.000012345');
    expect(formatPrice(1.5)).toBe('1.5');
  });

  it('registers symbol digits in dailyChangePriceModeRegistry even when brokerSpecification omits digits', () => {
    registerDailyChangePriceModes([
      {
        symbol: 'BTCUSD',
        digits: 2,
        tickSize: 0.01,
        contractSize: 1,
        brokerSpecification: { chart_mode: 'bid' },
      },
    ]);

    const spec = readRegisteredSymbolPriceSpec('BTCUSD');
    expect(spec.digits).toBe(2);
    expect(spec.tickSize).toBe(0.01);
    expect(resolveSpecDigits(spec.digits)).toBe(2);
  });
});
