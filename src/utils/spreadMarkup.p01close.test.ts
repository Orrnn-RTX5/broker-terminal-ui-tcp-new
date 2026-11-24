/**
 * P01 round 10 close-out, ruling 1: digits 11 to 18 are used as configured (they were clamped to 10). Out-of-range digits
 * keep the rule they had: above the top they are clamped to it; below 0 they are not given, so the digits come from the
 * tick size as before, and with no tick size there is no entry.
 *
 * Expected values are worked by hand from the engine's rule: roundPrice is round(x * 10^d) / 10^d (ram_mt5_phase5.go:24-39);
 * the stored quote is rounded once (ram_mt5_views_sync.go:1210-1213); the market fill adds the group share (ask floor(m / 2)
 * ticks, bid the rest, tick == point) and rounds again (ram_mt5_engine.go:3443, 3447-3448). One unit is 10^-d, so m = 3 moves
 * the bid 2 units down and the ask 1 unit up. With a fixed spread S (in units), the mid branch gives base bid = mid - trunc(S / 2)
 * units and base ask = base bid + S units.
 */
import { describe, expect, it } from 'vitest';
import {
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  getQuoteAskMarkupOffset,
  getQuoteBidMarkupOffset,
  resolveSpreadMarkupEntry,
  roundPriceToDigits,
} from './spreadMarkup';

interface DigitsCase {
  name: string;
  /** Digits the instrument sends. */
  digits: number;
  /** Digits the terminal prices at. */
  usedDigits: number;
  points: number;
  tickSize: number;
  fixedSpreadPoints: number;
  raw: { bid: number; ask: number };
  expected: { bid: number; ask: number };
}

const cases: DigitsCase[] = [
  {
    // Units of 1e-11: raw bid 123456789012, raw ask 123456789034. Store: unchanged. Fill: bid 123456789010, ask 123456789035.
    name: 'digits 11, unshaped',
    digits: 11,
    usedDigits: 11,
    points: 3,
    tickSize: 1e-11,
    fixedSpreadPoints: 0,
    raw: { bid: 1.23456789012, ask: 1.23456789034 },
    expected: { bid: 1.2345678901, ask: 1.23456789035 },
  },
  {
    // Raw spread 22 units, S = 4: mid 123456789023, base bid 123456789021, base ask 123456789025. Fill: 019 and 026.
    name: 'digits 11, shaped (S = 4)',
    digits: 11,
    usedDigits: 11,
    points: 3,
    tickSize: 1e-11,
    fixedSpreadPoints: 4,
    raw: { bid: 1.23456789012, ask: 1.23456789034 },
    expected: { bid: 1.23456789019, ask: 1.23456789026 },
  },
  {
    // Units of 1e-12: raw bid 123456789012, raw ask 123456789034. Fill: bid 123456789010, ask 123456789035.
    name: 'digits 12, unshaped',
    digits: 12,
    usedDigits: 12,
    points: 3,
    tickSize: 1e-12,
    fixedSpreadPoints: 0,
    raw: { bid: 0.123456789012, ask: 0.123456789034 },
    expected: { bid: 0.12345678901, ask: 0.123456789035 },
  },
  {
    // Same units as the digits 11 shaped case: base 021 and 025, fill 019 and 026.
    name: 'digits 12, shaped (S = 4)',
    digits: 12,
    usedDigits: 12,
    points: 3,
    tickSize: 1e-12,
    fixedSpreadPoints: 4,
    raw: { bid: 0.123456789012, ask: 0.123456789034 },
    expected: { bid: 0.123456789019, ask: 0.123456789026 },
  },
  {
    // Units of 1e-18: raw bid 123, raw ask 127. Fill: bid 121, ask 128.
    name: 'digits 18, unshaped',
    digits: 18,
    usedDigits: 18,
    points: 3,
    tickSize: 1e-18,
    fixedSpreadPoints: 0,
    raw: { bid: 1.23e-16, ask: 1.27e-16 },
    expected: { bid: 1.21e-16, ask: 1.28e-16 },
  },
  {
    // Raw spread 6 units, S = 4: mid 126, base bid 124, base ask 128. Fill: bid 122, ask 129.
    name: 'digits 18, shaped (S = 4)',
    digits: 18,
    usedDigits: 18,
    points: 3,
    tickSize: 1e-18,
    fixedSpreadPoints: 4,
    raw: { bid: 1.23e-16, ask: 1.29e-16 },
    expected: { bid: 1.22e-16, ask: 1.29e-16 },
  },
  {
    // Digits 19 is above the table top: it is priced at 18, so the result is the digits 18 unshaped result.
    name: 'digits 19 (priced at 18), unshaped',
    digits: 19,
    usedDigits: 18,
    points: 3,
    tickSize: 1e-18,
    fixedSpreadPoints: 0,
    raw: { bid: 1.23e-16, ask: 1.27e-16 },
    expected: { bid: 1.21e-16, ask: 1.28e-16 },
  },
  {
    // Digits 19 priced at 18: the digits 18 shaped result.
    name: 'digits 19 (priced at 18), shaped (S = 4)',
    digits: 19,
    usedDigits: 18,
    points: 3,
    tickSize: 1e-18,
    fixedSpreadPoints: 4,
    raw: { bid: 1.23e-16, ask: 1.29e-16 },
    expected: { bid: 1.22e-16, ask: 1.29e-16 },
  },
  {
    // Digits -1 is not given, so the digits come from the tick 0.01 (2). Store 1.23 and 1.24; m = 5: bid 3 ticks down
    // (1.20), ask 2 ticks up (1.26).
    name: 'digits -1 (not given, inferred 2 from the tick), unshaped',
    digits: -1,
    usedDigits: 2,
    points: 5,
    tickSize: 0.01,
    fixedSpreadPoints: 0,
    raw: { bid: 1.2345, ask: 1.2355 },
    expected: { bid: 1.2, ask: 1.26 },
  },
];

describe('P01 close-out ruling 1: digits 11 to 18 are used as configured', () => {
  it.each(cases)('$name: the shown quote and the depth top equal the hand-worked fill', (c) => {
    const entry = resolveSpreadMarkupEntry({
      spreadMarkup: c.points,
      tickSize: c.tickSize,
      digits: c.digits,
      fixedSpreadPoints: c.fixedSpreadPoints,
    });
    expect(entry?.digits).toBe(c.usedDigits);

    const shown = applySpreadMarkupToQuote({ bid: c.raw.bid, ask: c.raw.ask }, entry);
    expect(shown.bid).toBe(c.expected.bid);
    expect(shown.ask).toBe(c.expected.ask);

    const bidTop = applySpreadMarkupToBookLevels([{ price: c.raw.bid }], 'bid', entry, [{ price: c.raw.ask }]);
    const askTop = applySpreadMarkupToBookLevels([{ price: c.raw.ask }], 'ask', entry, [{ price: c.raw.bid }]);
    expect(bidTop[0]?.price).toBe(c.expected.bid);
    expect(askTop[0]?.price).toBe(c.expected.ask);
  });
});

describe('P01 close-out ruling 1: out-of-range digits keep the rule they had', () => {
  it('digits above 18 are priced at 18, as digits above 10 were priced at 10 before', () => {
    const at19 = resolveSpreadMarkupEntry({ spreadMarkup: 3, tickSize: 1e-18, digits: 19 });
    const at18 = resolveSpreadMarkupEntry({ spreadMarkup: 3, tickSize: 1e-18, digits: 18 });
    expect(at19?.digits).toBe(18);
    expect(at18?.digits).toBe(18);
    const shown = applySpreadMarkupToQuote({ bid: 1.23e-16, ask: 1.27e-16 }, at19);
    expect(shown.bid).toBe(1.21e-16);
    expect(shown.ask).toBe(1.28e-16);
  });

  it('a digits value below 0 is not given: the digits come from the tick size (capped at 10), as before', () => {
    const entry = resolveSpreadMarkupEntry({ spreadMarkup: 5, tickSize: 0.01, digits: -1 });
    expect(entry?.digits).toBe(2);
    const shown = applySpreadMarkupToQuote({ bid: 1.2345, ask: 1.2355 }, entry);
    expect(shown.bid).toBe(1.2);
    expect(shown.ask).toBe(1.26);
    // A tick with 13 decimals (1.234567e-7) is inferred at the 10-digit cap, which is unchanged from before.
    expect(resolveSpreadMarkupEntry({ spreadMarkup: 3, tickSize: 1.234567e-7, digits: -1 })?.digits).toBe(10);
  });

  it('a digits value below 0 with no tick size gives no entry, so the raw quote comes back', () => {
    expect(resolveSpreadMarkupEntry({ spreadMarkup: 5, digits: -1 })).toBeNull();
    const raw = { bid: 1.2345, ask: 1.2355 };
    expect(applySpreadMarkupToQuote(raw, null)).toBe(raw);
  });
});

describe('P01 close-out ruling 1: the rounding table and the markup offsets', () => {
  it('roundPriceToDigits rounds at 11 and 18 digits and clamps 19 to 18; the negative-digits case documents terminal behaviour that DIFFERS from the engine, for an input no caller sends', () => {
    expect(roundPriceToDigits(1.23456789012, 11)).toBe(1.23456789012);
    expect(roundPriceToDigits(1.23456789012, 10)).toBe(1.2345678901);
    expect(roundPriceToDigits(1.23e-16, 19)).toBe(1.23e-16);
    expect(roundPriceToDigits(1.6, -1)).toBe(2);
  });

  it('the markup offsets still round at 10 digits (marketWatchSymbolDetailsModel shows them)', () => {
    expect(getQuoteBidMarkupOffset({ bid: 1.09997, rawBid: 1.1 })).toBe(0.00003);
    expect(getQuoteAskMarkupOffset({ ask: 1.10014, rawAsk: 1.10012 })).toBe(0.00002);
  });
});
