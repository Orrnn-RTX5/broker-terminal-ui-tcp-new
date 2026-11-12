import { describe, expect, it } from 'vitest';

import {
  buildExposureSummary,
  formatExposureVolume,
  getExposureContractSize,
  parseExposureSymbol,
} from './BottomDock.exposure';

describe('BottomDock exposure helpers', () => {
  it('parses forex, metal, and crypto symbols into base and quote assets', () => {
    expect(parseExposureSymbol('GBPUSD')).toEqual({ base: 'GBP', quote: 'USD' });
    expect(parseExposureSymbol('XAUUSD')).toEqual({ base: 'XAU', quote: 'USD' });
    expect(parseExposureSymbol('BTCUSD.r')).toEqual({ base: 'BTC', quote: 'USD' });
  });

  it('allocates used margin to the traded asset and remaining free margin to account currency', () => {
    const summary = buildExposureSummary(
      [{
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: 0.01,
        currentPrice: 4326.095,
        contractSize: 100,
      }],
      {
        balance: 3328.65,
        equity: 3322.30,
        margin: 8.65,
        freeMargin: 3313.65,
        marginLevel: 38408.09,
        currency: 'USD',
        leverage: 500,
      }
    );

    const usd = summary.rows.find((row) => row.asset === 'USD');
    const xau = summary.rows.find((row) => row.asset === 'XAU');

    expect(usd?.value).toBeCloseTo(3305.00, 2);
    expect(xau?.volume).toBeCloseTo(1, 5);
    expect(xau?.rate).toBeCloseTo(4326.095, 5);
    expect(xau?.value).toBeCloseTo(8.65, 2);
    expect(summary.longSegments.map((segment) => segment.asset)).toEqual(['USD', 'XAU']);
  });

  it('keeps short assets negative and renders them as short graph values', () => {
    const summary = buildExposureSummary(
      [{
        symbol: 'GBPUSD',
        side: 'SELL',
        volume: 0.02,
        currentPrice: 1.34,
        contract_size: 100000,
      }],
      {
        balance: 1000,
        equity: 1000,
        margin: 26.8,
        freeMargin: 973.2,
        currency: 'USD',
      }
    );

    const gbp = summary.rows.find((row) => row.asset === 'GBP');
    expect(gbp?.volume).toBeCloseTo(-2000, 5);
    expect(gbp?.value).toBeCloseTo(-26.8, 2);
    expect(gbp?.shortValue).toBeCloseTo(26.8, 2);
  });

  it('formats MT-style compact volume labels', () => {
    expect(formatExposureVolume('USD', 3305)).toBe('3.305K');
    expect(formatExposureVolume('GBP', -2000)).toBe('-2.000K');
    expect(formatExposureVolume('XAU', 1)).toBe('1.00');
  });

  it('calculates long segment percentages summing to 1 for long exposure', () => {
    const summary = buildExposureSummary(
      [{
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: 0.01,
        currentPrice: 2000,
        contractSize: 100,
      }],
      {
        balance: 10000,
        equity: 10000,
        margin: 20,
        freeMargin: 9980,
        currency: 'USD',
      }
    );

    const totalPct = summary.longSegments.reduce((acc, seg) => acc + seg.percent, 0);
    expect(totalPct).toBeCloseTo(1, 4);
    expect(summary.longSegments[0].color).toBeTruthy();
  });

  it('never sizes exposure from a symbol-name contract table (TERM-DIGITS-WL)', () => {
    expect(getExposureContractSize({ symbol: 'USDJPY' })).toBeNull();
    expect(getExposureContractSize({ symbol: 'XAUUSD' })).toBeNull();
    expect(getExposureContractSize({ symbol: 'XAUUSD', contract_size: '50' })).toBe(50);

    const summary = buildExposureSummary(
      [{ symbol: 'USDJPY', side: 'BUY', volume: 1, currentPrice: 150 }],
      { balance: 1000, equity: 1000, margin: 0, freeMargin: 1000, currency: 'USD' }
    );
    // Unknown contract size: the position is left out, not sized as 100000.
    expect(summary.rows.map((row) => row.asset)).toEqual(['USD']);
  });
});

describe('BottomDock exposure with unavailable free margin', () => {
  const eurusdBuy = [{ symbol: 'EURUSD', side: 'BUY', volume: 1, openPrice: 1.1, currentPrice: 1.1, contract_size: 100000 }];

  it('does not size the account-currency leg from equity or a stored 0 when the account is not valued', () => {
    const summary = buildExposureSummary(
      eurusdBuy,
      { currency: 'USD', balance: 1000, equity: 1000, margin: 0, freeMargin: 0, hasBackendFreeMargin: false, metricsMarginUnavailable: true, leverage: 100 },
    );
    expect(summary.freeMarginAvailable).toBe(false);
    expect(summary.rows.find((row) => row.asset === 'USD')).toBeUndefined();
  });

  it('keeps the valued account cash leg exactly as before when its free-margin flag is false', () => {
    // 5000 equity minus the 1100 EURUSD leg (110000 notional at leverage 100) = 3900, as on 5ad2aa97.
    const summary = buildExposureSummary(
      eurusdBuy,
      { currency: 'USD', balance: 5000, equity: 5000, margin: 0, freeMargin: 0, hasBackendFreeMargin: false, metricsStatus: 'valid', leverage: 100 },
    );
    expect(summary.freeMarginAvailable).toBe(true);
    expect(summary.rows.find((row) => row.asset === 'USD')?.value).toBeCloseTo(3900, 6);
  });

  it('keeps the valued account cash leg when the account has no status and the free-margin flag is false', () => {
    const summary = buildExposureSummary(
      eurusdBuy,
      { currency: 'USD', balance: 5000, equity: 5000, margin: 0, freeMargin: 0, hasBackendFreeMargin: false, leverage: 100 },
    );
    expect(summary.freeMarginAvailable).toBe(true);
    expect(summary.rows.find((row) => row.asset === 'USD')?.value).toBeCloseTo(3900, 6);
  });

  it('marks the cash leg unavailable when the backend status is unavailable and free margin is unflagged', () => {
    const summary = buildExposureSummary(
      eurusdBuy,
      { currency: 'USD', balance: 5000, equity: 5000, margin: 0, freeMargin: 0, hasBackendFreeMargin: false, metricsStatus: 'unavailable', leverage: 100 },
    );
    expect(summary.freeMarginAvailable).toBe(false);
    expect(summary.rows.find((row) => row.asset === 'USD')).toBeUndefined();
  });
});
