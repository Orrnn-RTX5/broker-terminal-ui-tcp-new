/**
 * P01 round 9, step 5 (independent tester): object identity preservation in spreadMarkup.ts
 * for already-widened quotes and unchanged depth levels.
 */
import { describe, expect, it } from 'vitest';
import {
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  resolveSpreadMarkupEntry,
} from './spreadMarkup';

describe('P01 round 9 step 5 (tester): spreadMarkup object and array identity', () => {
  it('applySpreadMarkupToQuote returns the exact same object reference when already widened to the same result', () => {
    const entry = resolveSpreadMarkupEntry({ spreadMarkup: 5, tickSize: 0.00001, digits: 5 });
    const raw = { bid: 1.1, ask: 1.10012, spread: 0.00012 };
    const once = applySpreadMarkupToQuote(raw, entry);
    expect(once).not.toBe(raw);
    expect(once.bid).toBe(1.09997);
    expect(once.ask).toBe(1.10014);

    // Same prepared entry and equivalent freshly resolved entry both preserve reference identity.
    const samePrepared = applySpreadMarkupToQuote(once, entry);
    expect(samePrepared).toBe(once);

    const equalEntry = resolveSpreadMarkupEntry({ spreadMarkup: 5, tickSize: 0.00001, digits: 5 });
    const sameEqual = applySpreadMarkupToQuote(once, equalEntry);
    expect(sameEqual).toBe(once);
  });

  it('applySpreadMarkupToBookLevels returns the exact same array reference when no level changes', () => {
    // Crossing narrowing fallback (m=5, D=-20): both top and deeper levels revert to stored prices (unchanged at d=5).
    const entry = resolveSpreadMarkupEntry({
      spreadMarkup: 5,
      spreadDiffPoints: -20,
      tickSize: 0.00001,
      digits: 5,
    });
    const bids = [
      { price: 1.1, volume: 1, total: 1 },
      { price: 1.09999, volume: 2, total: 3 },
    ];
    const asks = [{ price: 1.10012, volume: 1, total: 1 }];
    const result = applySpreadMarkupToBookLevels(bids, 'bid', entry, asks);
    expect(result).toBe(bids);
  });
});
