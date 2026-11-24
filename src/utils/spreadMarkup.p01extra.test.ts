/**
 * P01 step 4 (independent tester): edge cases read from src/utils/spreadMarkup.ts and compared with the
 * released backend rule (services/gateway/handlers/spread_markup.go:41-160 and
 * services/gateway/internal/canonicalpolicy/approved_pricing.go:326-492). Expected values are worked by hand.
 * A failing test in this file is a finding about the product code, not a test bug.
 */
import { describe, expect, it } from 'vitest';
import { applySpreadMarkupToOrderBook } from '../features/market-data/useLiveOrderBook';
import {
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  buildSpreadMarkupMap,
  readSpreadMarkupPoints,
  resolveSpreadMarkupEntry,
  type SpreadMarkupEntry,
} from './spreadMarkup';

const entryOf = (input: Parameters<typeof resolveSpreadMarkupEntry>[0]): SpreadMarkupEntry => {
  const entry = resolveSpreadMarkupEntry(input);
  if (!entry) throw new Error('expected an active markup entry');
  return entry;
};

describe('P01 step 4: depth of market vs the shown quote (levels have no crossing or shaping fallback)', () => {
  it('crossing narrowing (m=5, D=-20): the DOM top of book keeps the shown quote', () => {
    // Shown quote, approved_pricing.go:406-411: bid 1.10007 > ask 1.10004 -> keep the base pair 1.10000 / 1.10012.
    // Depth gets the opposite top (now required): the same crossing check runs on the top, so the levels stay at 1.10000 / 1.10012.
    // Without the opposite top the fallback would move them +7 / -8 points (1.10007 / 1.10004).
    const entry = entryOf({ spreadMarkup: 5, spreadDiffPoints: -20, tickSize: 0.00001, digits: 5 });
    const quote = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10012 }, entry);
    expect(quote.bid).toBe(1.1);
    expect(quote.ask).toBe(1.10012);
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1, volume: 1, total: 1 }], 'bid', entry, [{ price: 1.10012 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10012, volume: 1, total: 1 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(quote.bid);
    expect(asks[0].price).toBe(quote.ask);
  });

  it('crossing narrowing: the order book spread is never negative', () => {
    // Best bid 1.10007 and best ask 1.10004 would give a DOM spread of -0.00003.
    const map = buildSpreadMarkupMap([
      { symbol: 'EURUSD', spreadMarkup: 5, spreadDiffPoints: -20, tickSize: 0.00001, digits: 5 },
    ]);
    const book = {
      symbol: 'EURUSD',
      bids: [{ price: 1.1, volume: 1, total: 1 }],
      asks: [{ price: 1.10012, volume: 1, total: 1 }],
      spread: 0.00012,
      spreadPips: null,
      timestamp: 1,
    };
    const shown = applySpreadMarkupToOrderBook(book, map);
    expect(shown?.spread).toBeGreaterThanOrEqual(0);
  });

  it('fixed spread (S=10, SB=0, raw 1.10000 / 1.10004): the DOM top of book matches the re-centred quote', () => {
    // Shown quote (approved_pricing.go:344-377): mid 1.10002 - 5 points = 1.09997 ; ask = 1.09997 + 10 points = 1.10007.
    // Depth gets the opposite top (now required): the top re-centres like the quote, bid -3 points, ask +3 points (1.09997 / 1.10007).
    const entry = entryOf({ fixedSpreadPoints: 10, spreadBalancePoints: 0, tickSize: 0.00001, digits: 5 });
    const quote = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10004 }, entry);
    expect(quote.bid).toBe(1.09997);
    expect(quote.ask).toBe(1.10007);
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1, volume: 1, total: 1 }], 'bid', entry, [{ price: 1.10004 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10004, volume: 1, total: 1 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(quote.bid);
    expect(asks[0].price).toBe(quote.ask);
  });

  it('floating balance (S=0, SB=3, m=5): the DOM top of book matches the shown quote (guard)', () => {
    // Shown quote: Layer 1 -> 1.10003 / 1.10015 ; Layer 2 (m=5: bid -3 points, ask +2 points) -> 1.10000 / 1.10017.
    // DOM: bid move = +3 - 3 = 0 -> 1.10000 ; ask move = +2 + 3 = +5 points -> 1.10017.
    const entry = entryOf({ spreadMarkup: 5, spreadBalancePoints: 3, tickSize: 0.00001, digits: 5 });
    const quote = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10012 }, entry);
    expect(quote.bid).toBe(1.1);
    expect(quote.ask).toBe(1.10017);
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1, volume: 1, total: 1 }], 'bid', entry, [{ price: 1.10012 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10012, volume: 1, total: 1 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(quote.bid);
    expect(asks[0].price).toBe(quote.ask);
  });
});

describe('P01 step 4: catalogue parsing and symbol edge cases', () => {
  it('readSpreadMarkupPoints: negative and non-numeric markup is 0, decimals round, absent or null is undefined', () => {
    expect(readSpreadMarkupPoints({ spread_markup: -5 })).toBe(0);
    expect(readSpreadMarkupPoints({ spread_markup: 'abc' })).toBe(0);
    expect(readSpreadMarkupPoints({ spread_markup: '5' })).toBe(5);
    expect(readSpreadMarkupPoints({ spreadMarkup: 2.6 })).toBe(3);
    expect(readSpreadMarkupPoints({ spread_markup: null })).toBeUndefined();
    expect(readSpreadMarkupPoints({})).toBeUndefined();
  });

  it('a markup of NaN, negative or zero with no MT5 shaping builds no entry', () => {
    expect(resolveSpreadMarkupEntry({ spreadMarkup: Number.NaN, tickSize: 0.00001, digits: 5 })).toBeNull();
    expect(resolveSpreadMarkupEntry({ spreadMarkup: -5, tickSize: 0.00001, digits: 5 })).toBeNull();
    expect(resolveSpreadMarkupEntry({ spreadMarkup: 0, tickSize: 0.00001, digits: 5 })).toBeNull();
  });

  it('US30 (tick 0.5, digits 1) with m=3 on the instrument tick: bid 39999.0 / ask 40002.5, spread 3.5', () => {
    // Legacy split on the instrument tick: askPts floor(3/2) = 1 -> +0.5 ; bidPts 3 - 1 = 2 -> -1.0.
    const entry = entryOf({ spreadMarkup: 3, tickSize: 0.5, digits: 1 });
    const shown = applySpreadMarkupToQuote({ bid: 40000, ask: 40002, spread: 2 }, entry);
    expect(shown.bid).toBe(39999);
    expect(shown.ask).toBe(40002.5);
    expect(shown.spread).toBe(3.5);
  });

  it('sub-unit feed decimals (R2): uses configured digits=2 and tick=0.01 instead of observed decimals (0.09 / 0.14)', () => {
    // Owner ruling R2: observed-digits rule is removed; active entries always use configured digits and tickSize.
    // Engine market-order value (spreadMarkupEngineGoldenMarket.jsonl line 15, p01round4:266):
    //   storedBid = round(0.12345, 2) = 0.12, storedAsk = round(0.12355, 2) = 0.12
    //   m=5: bidPts=3 (-0.03), askPts=2 (+0.02) -> mBid = 0.09, mAsk = 0.14, spread = 0.05.
    const entry = entryOf({ spreadMarkup: 5, tickSize: 0.01, digits: 2 });
    const shown = applySpreadMarkupToQuote({ bid: 0.12345, ask: 0.12355, spread: 0.0001 }, entry);
    expect(Object.is(shown.bid, 0.09)).toBe(true);
    expect(Object.is(shown.ask, 0.14)).toBe(true);
    expect(shown.spread).toBe(0.05);
    const bids = applySpreadMarkupToBookLevels([{ price: 0.12345 }], 'bid', entry, [{ price: 0.12355 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 0.12355 }], 'ask', entry, [{ price: 0.12345 }]);
    expect(Object.is(bids[0].price, 0.09)).toBe(true);
    expect(Object.is(asks[0].price, 0.14)).toBe(true);
  });

  it('R3(b): with no active markup or shaping, the terminal returns the raw quote and depth levels untouched even with > digits decimals', () => {
    expect(resolveSpreadMarkupEntry({ spreadMarkup: 0, tickSize: 0.01, digits: 2 })).toBeNull();
    const raw = { bid: 1.23456, ask: 1.23489, spread: 0.00033 };
    expect(applySpreadMarkupToQuote(raw, null)).toBe(raw);
    const levels = [{ price: 1.23456, volume: 1, total: 1 }];
    expect(applySpreadMarkupToBookLevels(levels, 'bid', null, [{ price: 1.23489 }])).toBe(levels);
  });

  it('R3(c): when the market-order engine returns <= 0 for a side, the terminal keeps the documented positive base/raw price (never <= 0)', () => {
    // Case 1: negative mBid (-10 / 26) in spreadMarkupEngineGoldenMarket.jsonl line 30 (p01extra:r3c_neg).
    const negEntry = entryOf({
      spreadMarkup: 64, fixedSpreadPoints: 31, spreadDiffBalancePoints: -28, tickSize: 1, digits: 0,
    });
    const negShown = applySpreadMarkupToQuote({ bid: 1, ask: 10 }, negEntry);
    expect(Object.is(negShown.bid, 1)).toBe(true);
    expect(Object.is(negShown.ask, 26)).toBe(true);

    // Case 2: mBid rounds to 0 (0 / 0.004) in spreadMarkupEngineGoldenMarket.jsonl line 32 (p01extra:r3c_round0).
    const zeroEntry = entryOf({ spreadMarkup: 11, tickSize: 0.0001, digits: 3 });
    const zeroShown = applySpreadMarkupToQuote({ bid: 0.001, ask: 0.003 }, zeroEntry);
    expect(Object.is(zeroShown.bid, 0.001)).toBe(true);
    expect(Object.is(zeroShown.ask, 0.004)).toBe(true);
  });

  // exists before this change, identical at HEAD; not part of P01
  it.fails('after the markup is removed the raw quote keeps the feed spread exactly (no float residue)', () => {
    const entry = entryOf({ spreadMarkup: 5, tickSize: 0.00001, digits: 5 });
    const widened = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10012, spread: 0.00012 }, entry);
    const restored = applySpreadMarkupToQuote(widened, undefined);
    expect(restored.bid).toBe(1.1);
    expect(restored.ask).toBe(1.10012);
    expect(restored.spread).toBe(0.00012);
  });
});
