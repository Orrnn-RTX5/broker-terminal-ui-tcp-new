/**
 * P01 round 4 (independent tester): tests probing the round-4 review findings
 * (A4, A6, B2, B4) against the backend rule (services/gateway/handlers/spread_markup.go:41-160,
 * services/gateway/internal/canonicalpolicy/approved_pricing.go:111-125,326-539).
 * Every expected value is worked out by hand in comments.
 */
import { describe, expect, it } from 'vitest';
import {
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  getSpreadMarkupSideOffsets,
  resolveSpreadMarkupEntry,
  roundPriceToDigits,
  type SpreadMarkupEntry,
} from './spreadMarkup';

const entryOf = (input: Parameters<typeof resolveSpreadMarkupEntry>[0]): SpreadMarkupEntry => {
  const entry = resolveSpreadMarkupEntry(input);
  if (!entry) throw new Error('expected an active markup entry');
  return entry;
};

describe('P01 round 4 (A4): add unrounded per-side delta then round once half-up at symbol digits', () => {
  it('digits 2, tick 0.005, m=1 and m=3 on 1.24 / 1.25: rounds once half-up', () => {
    // Backend (spread_markup.go:41-79, approved_pricing.go:119-124):
    // m=1: askPts = floor(1/2) = 0 -> +0; bidPts = 1 - 0 = 1 -> -0.005.
    //   unrounded bid = 1.24 - 0.005 = 1.235 -> round half-up at 2 digits = 1.24
    //   unrounded ask = 1.25 + 0 = 1.25 -> 1.25 ; spread = 1.25 - 1.24 = 0.01
    const m1 = applySpreadMarkupToQuote(
      { bid: 1.24, ask: 1.25, spread: 0.01 },
      entryOf({ spreadMarkup: 1, tickSize: 0.005, digits: 2 }),
    );
    expect(m1.bid).toBe(1.24);
    expect(m1.ask).toBe(1.25);
    expect(m1.spread).toBe(0.01);

    // m=3: askPts = floor(3/2) = 1 -> +0.005; bidPts = 3 - 1 = 2 -> -0.010.
    // Reconciled to real Go RAM engine (shapeAccountQuoteP at ram_symbol_reload_tcp.go:1193-1211,
    // widenQuoteForSpreadTermsUnits at spread_markup.go:144-160, roundPrice at ram_mt5_phase5.go:29-39;
    // fixture src/utils/__fixtures__/spreadMarkupEngineGolden.jsonl line 14):
    //   unrounded bid = 1.24 - 0.010 = 1.23 -> 1.23
    //   unrounded ask = 1.25 + 0.005 = 1.2549999999999999 -> roundPrice(*100) = 1.25
    //   spread = 1.25 - 1.23 = 0.02
    const m3 = applySpreadMarkupToQuote(
      { bid: 1.24, ask: 1.25, spread: 0.01 },
      entryOf({ spreadMarkup: 3, tickSize: 0.005, digits: 2 }),
    );
    expect(m3.bid).toBe(1.23);
    expect(m3.ask).toBe(1.25);
    expect(m3.spread).toBe(0.02);
  });

  it('digits 2, tick 0.005, m=1 and m=3 on 100.24 / 100.25: half-tie rounds half-up at larger magnitudes', () => {
    // Backend exact decimal:
    // m=1: unrounded bid = 100.24 - 0.005 = 100.235 -> half-up at 2 digits = 100.24; ask = 100.25.
    const m1 = applySpreadMarkupToQuote(
      { bid: 100.24, ask: 100.25, spread: 0.01 },
      entryOf({ spreadMarkup: 1, tickSize: 0.005, digits: 2 }),
    );
    expect(m1.bid).toBe(100.24);
    expect(m1.ask).toBe(100.25);

    // m=3: unrounded bid = 100.24 - 0.010 = 100.23;
    //   unrounded ask = 100.25 + 0.005 = 100.255 -> half-up at 2 digits = 100.26.
    const m3 = applySpreadMarkupToQuote(
      { bid: 100.24, ask: 100.25, spread: 0.01 },
      entryOf({ spreadMarkup: 3, tickSize: 0.005, digits: 2 }),
    );
    expect(m3.bid).toBe(100.23);
    expect(m3.ask).toBe(100.26);
  });

  it('digits 0, tick 0.25 on 100 / 102 for m=1..5: rounds once half-up at 0 digits', () => {
    // m=1: bid 100 - 0.25 = 99.75 -> 100 ; ask 102 + 0 = 102
    const q1 = applySpreadMarkupToQuote({ bid: 100, ask: 102 }, entryOf({ spreadMarkup: 1, tickSize: 0.25, digits: 0 }));
    expect(q1.bid).toBe(100);
    expect(q1.ask).toBe(102);

    // m=2: bid 100 - 0.25 = 99.75 -> 100 ; ask 102 + 0.25 = 102.25 -> 102
    const q2 = applySpreadMarkupToQuote({ bid: 100, ask: 102 }, entryOf({ spreadMarkup: 2, tickSize: 0.25, digits: 0 }));
    expect(q2.bid).toBe(100);
    expect(q2.ask).toBe(102);

    // m=3: bid 100 - 0.50 = 99.5 -> half-up 100 ; ask 102 + 0.25 = 102.25 -> 102
    const q3 = applySpreadMarkupToQuote({ bid: 100, ask: 102 }, entryOf({ spreadMarkup: 3, tickSize: 0.25, digits: 0 }));
    expect(q3.bid).toBe(100);
    expect(q3.ask).toBe(102);

    // m=4: bid 100 - 0.50 = 99.5 -> half-up 100 ; ask 102 + 0.50 = 102.5 -> half-up 103
    const q4 = applySpreadMarkupToQuote({ bid: 100, ask: 102 }, entryOf({ spreadMarkup: 4, tickSize: 0.25, digits: 0 }));
    expect(q4.bid).toBe(100);
    expect(q4.ask).toBe(103);

    // m=5: bid 100 - 0.75 = 99.25 -> 99 ; ask 102 + 0.50 = 102.5 -> half-up 103
    const q5 = applySpreadMarkupToQuote({ bid: 100, ask: 102 }, entryOf({ spreadMarkup: 5, tickSize: 0.25, digits: 0 }));
    expect(q5.bid).toBe(99);
    expect(q5.ask).toBe(103);
  });

  it('digits 2, tick 0.005, m=1 on depth levels: top matches shown quote 1.24 / 1.25', () => {
    const entry = entryOf({ spreadMarkup: 1, tickSize: 0.005, digits: 2 });
    const quote = applySpreadMarkupToQuote({ bid: 1.24, ask: 1.25 }, entry);
    const bids = applySpreadMarkupToBookLevels(
      [{ price: 1.24, volume: 1, total: 1 }, { price: 1.23, volume: 2, total: 3 }],
      'bid',
      entry,
      [{ price: 1.25 }],
    );
    const asks = applySpreadMarkupToBookLevels(
      [{ price: 1.25, volume: 1, total: 1 }],
      'ask',
      entry,
      [{ price: 1.24 }],
    );
    expect(bids[0].price).toBe(quote.bid);
    expect(asks[0].price).toBe(quote.ask);
  });
});

describe('P01 round 4 (A6): deep depth levels with large markup on tiny prices', () => {
  it('2-level tiny book (m=9, raw bids [0.00008, 0.00004], asks [0.00010]): drops negative deep bid, top matches quote', () => {
    // Drop-rule hand calculation:
    // m=9, tick 0.00001, digits 5: askPts = floor(9/2) = 4 (+0.00004), bidPts = 9 - 4 = 5 (-0.00005).
    // Shown quote: bid = 0.00008 - 0.00005 = 0.00003; ask = 0.00010 + 0.00004 = 0.00014.
    // Bid side:
    //   level 0: 0.00008 - 0.00005 = 0.00003 > 0 -> kept ({ price: 0.00003, volume: 1, total: 1 })
    //   level 1: 0.00004 - 0.00005 = -0.00001 <= 0 -> DROPPED (never clamped to top or smallest step)
    // Ask side:
    //   level 0: 0.00010 + 0.00004 = 0.00014 > 0 -> kept ({ price: 0.00014, volume: 1, total: 1 })
    const entry = entryOf({ spreadMarkup: 9, tickSize: 0.00001, digits: 5 });
    const quote = applySpreadMarkupToQuote({ bid: 0.00008, ask: 0.0001 }, entry);
    const rawBids = [
      { price: 0.00008, volume: 1, total: 1 },
      { price: 0.00004, volume: 2, total: 3 },
    ];
    const rawAsks = [{ price: 0.0001, volume: 1, total: 1 }];
    const bids = applySpreadMarkupToBookLevels(rawBids, 'bid', entry, rawAsks);
    const asks = applySpreadMarkupToBookLevels(rawAsks, 'ask', entry, rawBids);

    expect(bids).toEqual([{ price: 0.00003, volume: 1, total: 1 }]);
    expect(asks).toEqual([{ price: 0.00014, volume: 1, total: 1 }]);
    expect(bids[0].price).toBe(quote.bid);
    expect(asks[0].price).toBe(quote.ask);
  });

  it('multi-level tiny book (m=9, raw bids [0.00008, 0.00006, 0.00005, 0.00004, 0.00002]): preserves monotonic bid order', () => {
    // Raw bids are strictly descending: 0.00008 > 0.00006 > 0.00005 > 0.00004 > 0.00002.
    // m=9, bidPts=5 (-0.00005):
    //   level 0: 0.00008 - 0.00005 = 0.00003 (moved top = quote.bid)
    //   level 1: 0.00006 - 0.00005 = 0.00001
    //   levels 2..4 would become <= 0; invariant requires: <= top bid, > 0, and monotonic non-increasing.
    const entry = entryOf({ spreadMarkup: 9, tickSize: 0.00001, digits: 5 });
    const quote = applySpreadMarkupToQuote({ bid: 0.00008, ask: 0.0001 }, entry);
    const rawBids = [0.00008, 0.00006, 0.00005, 0.00004, 0.00002].map((price, i) => ({
      price,
      volume: i + 1,
      total: i + 1,
    }));
    const rawAsks = [{ price: 0.0001, volume: 1, total: 1 }, { price: 0.00011, volume: 2, total: 3 }];
    const bids = applySpreadMarkupToBookLevels(rawBids, 'bid', entry, rawAsks);
    const asks = applySpreadMarkupToBookLevels(rawAsks, 'ask', entry, rawBids);

    expect(bids[0].price).toBe(quote.bid);
    expect(asks[0].price).toBe(quote.ask);
    for (let i = 0; i < bids.length; i += 1) {
      expect(bids[i].price).toBeGreaterThan(0);
      expect(bids[i].price).toBeLessThanOrEqual(bids[0].price);
      if (i > 0) {
        expect(bids[i].price).toBeLessThanOrEqual(bids[i - 1].price);
      }
    }
  });

  it('positive deep level that shrinks below half a digit step does not round down to zero (digits 2, tick 0.005, m=1)', () => {
    // Raw bids [0.02, 0.009], asks [0.03], digits 2, tick 0.005, m=1 (bid move -0.005).
    // level 0: 0.02 - 0.005 = 0.015 -> round half-up 0.02 (= quote.bid).
    // level 1: 0.009 - 0.005 = 0.004 > 0, which rounds to 0.00 at digits=2 unless guarded.
    // Requirement: no level may be zero or negative unless the raw level was.
    const entry = entryOf({ spreadMarkup: 1, tickSize: 0.005, digits: 2 });
    const rawBids = [{ price: 0.02, volume: 1, total: 1 }, { price: 0.009, volume: 2, total: 3 }];
    const rawAsks = [{ price: 0.03, volume: 1, total: 1 }];
    const bids = applySpreadMarkupToBookLevels(rawBids, 'bid', entry, rawAsks);
    for (const level of bids) {
      expect(level.price).toBeGreaterThan(0);
    }
  });

  it('top bid itself would become non-positive (m=5, raw bids [0.00002, 0.00001]): keeps raw levels and matches shown quote', () => {
    // Top 0.00002 - 0.00003 = -0.00001 <= 0 -> backend/terminal keeps raw bid 0.00002 (move = 0).
    const entry = entryOf({ spreadMarkup: 5, tickSize: 0.00001, digits: 5 });
    const quote = applySpreadMarkupToQuote({ bid: 0.00002, ask: 0.0001 }, entry);
    const rawBids = [{ price: 0.00002, volume: 1, total: 1 }, { price: 0.00001, volume: 2, total: 3 }];
    const rawAsks = [{ price: 0.0001, volume: 1, total: 1 }];
    const bids = applySpreadMarkupToBookLevels(rawBids, 'bid', entry, rawAsks);
    expect(bids[0].price).toBe(quote.bid);
    expect(bids.map((level) => level.price)).toEqual([0.00002, 0.00001]);
  });
});

describe('P01 round 4 (B4): prepared entries, copies, hand-built entries, and immutability', () => {
  it('copying a prepared entry with changed points, tickSize, or digits uses the new values (no stale deltas)', () => {
    const base = entryOf({ spreadMarkup: 5, tickSize: 0.00001, digits: 5 });

    // Changed points: { ...base, points: 10 } -> bid -5 pts (1.09995), ask +5 pts (1.10017)
    const copyPoints = { ...base, points: 10 };
    const qPoints = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10012 }, copyPoints);
    expect(qPoints.bid).toBe(1.09995);
    expect(qPoints.ask).toBe(1.10017);
    expect(getSpreadMarkupSideOffsets(copyPoints)).toEqual({ bidOffset: 0.00005, askOffset: 0.00005 });
    expect(
      applySpreadMarkupToBookLevels([{ price: 1.1, volume: 1, total: 1 }], 'bid', copyPoints, [{ price: 1.10012 }])[0].price,
    ).toBe(1.09995);

    // Changed tickSize: { ...base, tickSize: 0.0001 } -> m=5: bid -3*0.0001 (1.0997), ask +2*0.0001 (1.10032)
    const copyTick = { ...base, tickSize: 0.0001 };
    const qTick = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10012 }, copyTick);
    expect(qTick.bid).toBe(1.0997);
    expect(qTick.ask).toBe(1.10032);

    // Changed digits & tickSize: { ...base, digits: 4, tickSize: 0.0001 } -> bid 1.0997, ask 1.1003
    const copyDigits = { ...base, digits: 4, tickSize: 0.0001 };
    const qDigits = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.1001 }, copyDigits);
    expect(qDigits.bid).toBe(1.0997);
    expect(qDigits.ask).toBe(1.1003);

    // Changed points to 0: { ...base, points: 0 } -> untouched raw quote
    const raw = { bid: 1.1, ask: 1.10012 };
    expect(applySpreadMarkupToQuote(raw, { ...base, points: 0 })).toBe(raw);
  });

  it('a hand-built entry without resolveSpreadMarkupEntry prices identically for quotes, depth, and offsets', () => {
    const prepared = entryOf({ spreadMarkup: 5, tickSize: 0.00001, digits: 5 });
    const handBuilt: SpreadMarkupEntry = { points: 5, tickSize: 0.00001, digits: 5 };
    const q = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10012, spread: 0.00012 }, handBuilt);
    expect(q.bid).toBe(1.09997);
    expect(q.ask).toBe(1.10014);
    expect(q.spread).toBe(0.00017);
    const offsets = getSpreadMarkupSideOffsets(handBuilt);
    expect(offsets).toEqual(getSpreadMarkupSideOffsets(prepared));
    expect(offsets.bidOffset).toBeCloseTo(0.00003, 10);
    expect(offsets.askOffset).toBeCloseTo(0.00002, 10);
    expect(
      applySpreadMarkupToBookLevels([{ price: 1.1, volume: 1, total: 1 }], 'bid', handBuilt, [{ price: 1.10012 }])[0].price,
    ).toBe(1.09997);
  });

  it('attempting to mutate a prepared entry throws and never corrupts later quotes', () => {
    const entry = entryOf({ spreadMarkup: 5, tickSize: 0.00001, digits: 5 });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { points: number }).points = 999;
    }).toThrow(TypeError);
    expect(() => {
      (entry as { groupBidDelta?: number }).groupBidDelta = 999;
    }).toThrow(TypeError);

    const q = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10012, spread: 0.00012 }, entry);
    expect(q.bid).toBe(1.09997);
    expect(q.ask).toBe(1.10014);
    expect(q.spread).toBe(0.00017);
  });
});

describe('P01 round 4 -> round 9 (R2): sub-unit quotes use configured digits and tickSize', () => {
  it('digits 2, tick 0.01, m=5 on 0.12345 / 0.12355: uses configured digits -> 0.09 / 0.14, spread 0.05', () => {
    // Reconciled to Go RAM engine market-order path (spreadMarkupEngineGoldenMarket.jsonl line 15, p01round4:266).
    const shown = applySpreadMarkupToQuote(
      { bid: 0.12345, ask: 0.12355, spread: 0.0001 },
      entryOf({ spreadMarkup: 5, tickSize: 0.01, digits: 2 }),
    );
    expect(shown.bid).toBe(0.09);
    expect(shown.ask).toBe(0.14);
    expect(shown.spread).toBe(0.05);
  });

  it('digits 2, tick 0.01, m=5 on 0.50 / 0.55: uses configured digits -> 0.47 / 0.57, spread 0.10', () => {
    // Reconciled to Go RAM engine market-order path (spreadMarkupEngineGoldenMarket.jsonl line 16, p01round4:276).
    const shown = applySpreadMarkupToQuote(
      { bid: 0.5, ask: 0.55, spread: 0.05 },
      entryOf({ spreadMarkup: 5, tickSize: 0.01, digits: 2 }),
    );
    expect(shown.bid).toBe(0.47);
    expect(shown.ask).toBe(0.57);
    expect(shown.spread).toBe(0.1);
  });

  it('digits 2, tick 0.01, m=7 on 0.1234 / 0.1236: uses configured digits -> 0.08 / 0.15, spread 0.07', () => {
    // Reconciled to Go RAM engine market-order path (spreadMarkupEngineGoldenMarket.jsonl line 17, p01round4:287).
    const shown = applySpreadMarkupToQuote(
      { bid: 0.1234, ask: 0.1236, spread: 0.0002 },
      entryOf({ spreadMarkup: 7, tickSize: 0.01, digits: 2 }),
    );
    expect(shown.bid).toBe(0.08);
    expect(shown.ask).toBe(0.15);
    expect(shown.spread).toBe(0.07);
  });

  it('digits 2, tick 0.01, m=5 on 0.1234567 / 0.1234577: uses configured digits -> 0.09 / 0.14, spread 0.05', () => {
    // Reconciled to Go RAM engine market-order path (spreadMarkupEngineGoldenMarket.jsonl line 18, p01round4:299).
    const shown = applySpreadMarkupToQuote(
      { bid: 0.1234567, ask: 0.1234577 },
      entryOf({ spreadMarkup: 5, tickSize: 0.01, digits: 2 }),
    );
    expect(shown.bid).toBe(0.09);
    expect(shown.ask).toBe(0.14);
    expect(shown.spread).toBe(0.05);
  });

  it('digits 1, tick 0.1, m=3 on 0.55 / 0.60: uses configured digits -> 0.4 / 0.7, spread 0.3', () => {
    // Reconciled to Go RAM engine market-order path (spreadMarkupEngineGoldenMarket.jsonl line 19, p01round4:310).
    const shown = applySpreadMarkupToQuote(
      { bid: 0.55, ask: 0.6 },
      entryOf({ spreadMarkup: 3, tickSize: 0.1, digits: 1 }),
    );
    expect(shown.bid).toBe(0.4);
    expect(shown.ask).toBe(0.7);
    expect(shown.spread).toBe(0.3);
  });
});

describe('P01 round 5: depth drop rule, negative spreadDiff asks, rounded-to-zero top, one-sided books, immutability', () => {
  it('bids: drops several failing deep levels (zero, negative, rounds-to-zero) and preserves order and raw-minus-share prices', () => {
    // Case A: digits 5, tick 0.00001, m=9 -> askPts=4 (+0.00004), bidPts=5 (-0.00005).
    // Raw bids: [0.00010, 0.00008, 0.00006, 0.00005, 0.00004, 0.00001], raw asks: [0.00012].
    //   0.00010 - 0.00005 = 0.00005 (kept)
    //   0.00008 - 0.00005 = 0.00003 (kept)
    //   0.00006 - 0.00005 = 0.00001 (kept)
    //   0.00005 - 0.00005 = 0.00000 (dropped)
    //   0.00004 - 0.00005 = -0.00001 (dropped)
    //   0.00001 - 0.00005 = -0.00004 (dropped)
    const entryA = entryOf({ spreadMarkup: 9, tickSize: 0.00001, digits: 5 });
    const quoteA = applySpreadMarkupToQuote({ bid: 0.0001, ask: 0.00012 }, entryA);
    const rawBidsA = [0.0001, 0.00008, 0.00006, 0.00005, 0.00004, 0.00001].map((price, idx) => ({
      price,
      volume: idx + 1,
      total: (idx + 1) * 10,
    }));
    const bidsA = applySpreadMarkupToBookLevels(rawBidsA, 'bid', entryA, [{ price: 0.00012 }]);
    expect(bidsA).toEqual([
      { price: 0.00005, volume: 1, total: 10 },
      { price: 0.00003, volume: 2, total: 20 },
      { price: 0.00001, volume: 3, total: 30 },
    ]);
    expect(bidsA[0].price).toBe(quoteA.bid);
    for (let i = 0; i < bidsA.length; i += 1) {
      expect(bidsA[i].price).toBeGreaterThan(0);
      expect(bidsA[i].price).toBe(roundPriceToDigits(rawBidsA[i].price - 0.00005, 5));
      if (i > 0) expect(bidsA[i].price).toBeLessThan(bidsA[i - 1].price);
    }

    // Case B (rounds-to-zero boundary): digits 2, tick 0.005, m=3 -> askPts=1 (+0.005), bidPts=2 (-0.010).
    // Raw bids: [0.03, 0.016, 0.015, 0.014, 0.008], raw asks: [0.05].
    // Reconciled to Go RAM engine market-order path (OnLiveTick Layer-1 roundPrice -> Layer 2 -> roundPrice;
    // fixture src/utils/__fixtures__/spreadMarkupEngineGoldenMarket.jsonl lines 20-24):
    //   0.03  -> stored 0.03  - 0.01 = 0.02  -> roundPrice(0.02, 2)  = 0.02 (kept)
    //   0.016 -> stored 0.02  - 0.01 = 0.01  -> roundPrice(0.01, 2)  = 0.01 (kept)
    //   0.015 -> stored 0.02  - 0.01 = 0.01  -> roundPrice(0.01, 2)  = 0.01 (kept)
    //   0.014 -> stored 0.01  - 0.01 = 0     -> <= 0                      (dropped)
    //   0.008 -> stored 0.01  - 0.01 = 0     -> <= 0                      (dropped)
    const entryB = entryOf({ spreadMarkup: 3, tickSize: 0.005, digits: 2 });
    const rawBidsB = [0.03, 0.016, 0.015, 0.014, 0.008].map((price, idx) => ({
      price,
      volume: idx + 1,
      total: idx + 1,
    }));
    const bidsB = applySpreadMarkupToBookLevels(rawBidsB, 'bid', entryB, [{ price: 0.05 }]);
    expect(bidsB.map((level) => level.price)).toEqual([0.02, 0.01, 0.01]);
    for (let i = 0; i < bidsB.length; i += 1) {
      expect(bidsB[i].price).toBeGreaterThan(0);
      expect(bidsB[i].price).toBe(roundPriceToDigits(roundPriceToDigits(rawBidsB[i].price, 2) - 0.01, 2));
      if (i > 0) expect(bidsB[i].price).toBeLessThanOrEqual(bidsB[i - 1].price);
    }
  });

  it('bids: handles only the last level failing and none failing (with half-up rounding)', () => {
    // Only last failing: digits 5, tick 0.00001, m=5 -> bidDelta=0.00003.
    // Raw bids: [0.00009, 0.00006, 0.00004, 0.00003] -> [0.00006, 0.00003, 0.00001], 0.00003-0.00003=0 dropped.
    const entry5 = entryOf({ spreadMarkup: 5, tickSize: 0.00001, digits: 5 });
    const lastFailBids = applySpreadMarkupToBookLevels(
      [0.00009, 0.00006, 0.00004, 0.00003].map((price, idx) => ({ price, volume: idx + 1, total: idx + 1 })),
      'bid',
      entry5,
      [{ price: 0.0001 }],
    );
    expect(lastFailBids.map((level) => level.price)).toEqual([0.00006, 0.00003, 0.00001]);

    // None failing (exact subtraction): [0.00009, 0.00006, 0.00004] -> [0.00006, 0.00003, 0.00001].
    const noneFailBids = applySpreadMarkupToBookLevels(
      [0.00009, 0.00006, 0.00004].map((price, idx) => ({ price, volume: idx + 1, total: idx + 1 })),
      'bid',
      entry5,
      [{ price: 0.0001 }],
    );
    expect(noneFailBids.map((level) => level.price)).toEqual([0.00006, 0.00003, 0.00001]);

    // None failing with half-up rounding: digits 2, tick 0.005, m=1 -> bidDelta=0.005.
    // [1.24, 1.23, 1.22] - 0.005 = [1.235, 1.225, 1.215] -> half-up at 2 digits = [1.24, 1.23, 1.22].
    const entryHalf = entryOf({ spreadMarkup: 1, tickSize: 0.005, digits: 2 });
    const halfBids = applySpreadMarkupToBookLevels(
      [1.24, 1.23, 1.22].map((price, idx) => ({ price, volume: idx + 1, total: idx + 1 })),
      'bid',
      entryHalf,
      [{ price: 1.25 }],
    );
    expect(halfBids.map((level) => level.price)).toEqual([1.24, 1.23, 1.22]);
  });

  it('asks: positive markup never drops asks; negative spreadDiff moves asks down while staying positive and ascending', () => {
    // 1. Positive markup (m=9, tick 0.00001, digits 5): askDelta=+0.00004, all 3 asks kept ascending.
    const posEntry = entryOf({ spreadMarkup: 9, tickSize: 0.00001, digits: 5 });
    const posAsks = applySpreadMarkupToBookLevels(
      [0.0001, 0.00011, 0.00012].map((price, idx) => ({ price, volume: idx + 1, total: idx + 1 })),
      'ask',
      posEntry,
      [{ price: 0.00008 }, { price: 0.00004 }],
    );
    expect(posAsks.map((level) => level.price)).toEqual([0.00014, 0.00015, 0.00016]);

    // 2. Negative spreadDiffPoints=-10 (digits 5, tick 0.00001):
    //    sdkBidPoints(-10, 0) = -10 - trunc(-5) = -5 -> bidDelta = -0.00005, askDelta = -0.00005.
    //    Two-sided non-crossing: bid 0.00002 -> 0.00007, asks [0.00013, 0.00015, 0.00018] -> [0.00008, 0.00010, 0.00013].
    const negEntry = entryOf({ spreadMarkup: 0, spreadDiffPoints: -10, tickSize: 0.00001, digits: 5 });
    const negQuote = applySpreadMarkupToQuote({ bid: 0.00002, ask: 0.00013 }, negEntry);
    expect(negQuote.ask).toBe(0.00008);
    const negAsks = applySpreadMarkupToBookLevels(
      [0.00013, 0.00015, 0.00018].map((price, idx) => ({ price, volume: idx + 1, total: idx + 1 })),
      'ask',
      negEntry,
      [{ price: 0.00002 }],
    );
    expect(negAsks.map((level) => level.price)).toEqual([0.00008, 0.0001, 0.00013]);
    expect(negAsks[0].price).toBe(negQuote.ask);

    // 3. Two-sided negative spreadDiffPoints=-10 where top ask would become <= 0:
    //    raw bid 0.00001, raw asks [0.00004, 0.00008, 0.00010]: outAsk = -0.00001 <= 0 -> fallback keeps raw.
    const fallbackQuote = applySpreadMarkupToQuote({ bid: 0.00001, ask: 0.00004 }, negEntry);
    expect(fallbackQuote.ask).toBe(0.00004);
    const fallbackAsks = applySpreadMarkupToBookLevels(
      [0.00004, 0.00008, 0.0001].map((price, idx) => ({ price, volume: idx + 1, total: idx + 1 })),
      'ask',
      negEntry,
      [{ price: 0.00001 }],
    );
    expect(fallbackAsks.map((level) => level.price)).toEqual([0.00004, 0.00008, 0.0001]);
    expect(fallbackAsks[0].price).toBe(fallbackQuote.ask);
  });

  it('asks: one-sided book with negative spreadDiff keeps asks > 0 and ascending when top would become <= 0', () => {
    // One-sided ask book (opposite = []) with D=-10, tick 0.00001, digits 5 (askDelta = -0.00005):
    // raw asks [0.00004, 0.00008, 0.00010]:
    //   top 0.00004 - 0.00005 = -0.00001 <= 0 -> top falls back to raw 0.00004,
    //   while deeper levels 0.00008 - 0.00005 = 0.00003 and 0.00010 - 0.00005 = 0.00005
    //   must NOT violate ascending order (asks[i].price >= asks[i - 1].price).
    const negEntry = entryOf({ spreadMarkup: 0, spreadDiffPoints: -10, tickSize: 0.00001, digits: 5 });
    const oneSidedAsks = applySpreadMarkupToBookLevels(
      [0.00004, 0.00008, 0.0001].map((price, idx) => ({ price, volume: idx + 1, total: idx + 1 })),
      'ask',
      negEntry,
      [],
    );
    for (let i = 0; i < oneSidedAsks.length; i += 1) {
      expect(oneSidedAsks[i].price).toBeGreaterThan(0);
      if (i > 0) expect(oneSidedAsks[i].price).toBeGreaterThanOrEqual(oneSidedAsks[i - 1].price);
    }
  });

  it('asks: one-sided book with negative spreadDiff keeps top > 0 when moved top is positive but rounds to zero', () => {
    // D=-2, B=1, digits 3, tick 0.001:
    //   sdkBidPoints(-2, 1) = -2 - trunc(-1) + 1 = 0; askPoints = -2 - 0 = -2 -> askDelta = -0.002.
    // Raw asks [0.0024, 0.0030], opposite = []:
    //   top 0.0024 - 0.002 = 0.0004 > 0, which rounds to 0 at digits=3; no ask may be shown at <= 0.
    const balEntry = entryOf({
      spreadMarkup: 0,
      spreadDiffPoints: -2,
      spreadDiffBalancePoints: 1,
      tickSize: 0.001,
      digits: 3,
    });
    const asks = applySpreadMarkupToBookLevels(
      [0.0024, 0.003].map((price, idx) => ({ price, volume: idx + 1, total: idx + 1 })),
      'ask',
      balEntry,
      [],
    );
    for (let i = 0; i < asks.length; i += 1) {
      expect(asks[i].price).toBeGreaterThan(0);
      if (i > 0) expect(asks[i].price).toBeGreaterThanOrEqual(asks[i - 1].price);
    }
  });

  it('top of book whose moved price is positive but rounds to zero matches market-order engine and never emits 0 (digits 2, tick 0.005, raw 0.009, m=1)', () => {
    // Market-order path (spreadMarkupEngineGoldenMarket.jsonl line 25, p01round4:499):
    //   storedBid = roundPrice(0.009, 2) = 0.01 -> 0.01 - 0.005 = 0.005 -> roundPrice(0.005, 2) = 0.01.
    // Terminal invariant (rulings): top of book must match shown quote and never emit 0.
    const entry = entryOf({ spreadMarkup: 1, tickSize: 0.005, digits: 2 });
    const quote = applySpreadMarkupToQuote({ bid: 0.009, ask: 0.03 }, entry);
    const bids = applySpreadMarkupToBookLevels(
      [{ price: 0.009, volume: 1, total: 1 }],
      'bid',
      entry,
      [{ price: 0.03 }],
    );
    expect(quote.bid).toBe(0.01);
    expect(bids[0].price).toBe(0.01);
    expect(bids[0].price).toBe(quote.bid);
  });

  it('top of book whose moved price is positive but rounds to zero without sub-unit rule (digits 3, tick 0.0005, raw 0.0009, m=1) matches market-order engine 0.001', () => {
    // Market-order path (spreadMarkupEngineGoldenMarket.jsonl line 26, p01round4:515):
    //   storedBid = roundPrice(0.0009, 3) = 0.001 -> 0.001 - 0.0005 = 0.0005 -> roundPrice(0.0005, 3) = 0.001.
    const entry = entryOf({ spreadMarkup: 1, tickSize: 0.0005, digits: 3 });
    const quote = applySpreadMarkupToQuote({ bid: 0.0009, ask: 0.003 }, entry);
    const bids = applySpreadMarkupToBookLevels(
      [{ price: 0.0009, volume: 1, total: 1 }],
      'bid',
      entry,
      [{ price: 0.003 }],
    );
    expect(quote.bid).toBe(0.001);
    expect(bids[0].price).toBe(0.001);
    expect(bids[0].price).toBe(quote.bid);
  });

  it('one-sided books, empty side, and immutability (returns new arrays, never mutates frozen input)', () => {
    const entry5 = entryOf({ spreadMarkup: 5, tickSize: 0.00001, digits: 5 });
    const entry9 = entryOf({ spreadMarkup: 9, tickSize: 0.00001, digits: 5 });

    // Empty side with frozen opposite side
    const frozenOpp = Object.freeze([Object.freeze({ price: 1.10012, volume: 1, total: 1 })]);
    expect(applySpreadMarkupToBookLevels([], 'bid', entry5, frozenOpp)).toEqual([]);
    expect(applySpreadMarkupToBookLevels([], 'ask', entry5, frozenOpp)).toEqual([]);

    // One-sided bid book: normal widening
    const oneBids = Object.freeze([
      Object.freeze({ price: 1.1, volume: 1, total: 1 }),
      Object.freeze({ price: 1.09999, volume: 2, total: 3 }),
    ]);
    const widenedBids = applySpreadMarkupToBookLevels(oneBids, 'bid', entry5, []);
    expect(widenedBids.map((level) => level.price)).toEqual([1.09997, 1.09996]);
    expect(widenedBids).not.toBe(oneBids);
    expect(widenedBids[0]).not.toBe(oneBids[0]);
    expect(oneBids.map((level) => level.price)).toEqual([1.1, 1.09999]);

    // One-sided bid book: deep drop path (m=9) with frozen input
    const dropInput = Object.freeze([
      Object.freeze({ price: 0.00008, volume: 1, total: 1 }),
      Object.freeze({ price: 0.00006, volume: 2, total: 3 }),
      Object.freeze({ price: 0.00004, volume: 3, total: 6 }),
    ]);
    const droppedBids = applySpreadMarkupToBookLevels(dropInput, 'bid', entry9, []);
    expect(droppedBids.map((level) => level.price)).toEqual([0.00003, 0.00001]);
    expect(droppedBids).not.toBe(dropInput);
    expect(droppedBids[0]).not.toBe(dropInput[0]);
    expect(dropInput.map((level) => level.price)).toEqual([0.00008, 0.00006, 0.00004]);

    // One-sided bid book: tiny top where moved top <= 0 keeps raw top and matches one-sided quote,
    // while deeper level 0.00001 - 0.00003 = -0.00002 <= 0 is dropped under the drop rule.
    const tinyOneBids = [
      { price: 0.00002, volume: 1, total: 1 },
      { price: 0.00001, volume: 2, total: 3 },
    ];
    const tinyQuote = applySpreadMarkupToQuote({ bid: 0.00002 }, entry5);
    const tinyOut = applySpreadMarkupToBookLevels(tinyOneBids, 'bid', entry5, []);
    expect(tinyOut[0].price).toBe(tinyQuote.bid);
    expect(tinyOut.map((level) => level.price)).toEqual([0.00002]);

    // One-sided ask book with frozen input
    const oneAsks = Object.freeze([
      Object.freeze({ price: 1.10012, volume: 1, total: 1 }),
      Object.freeze({ price: 1.10013, volume: 2, total: 3 }),
    ]);
    const widenedAsks = applySpreadMarkupToBookLevels(oneAsks, 'ask', entry5, []);
    expect(widenedAsks.map((level) => level.price)).toEqual([1.10014, 1.10015]);
    expect(widenedAsks).not.toBe(oneAsks);
    expect(widenedAsks[0]).not.toBe(oneAsks[0]);
    expect(oneAsks.map((level) => level.price)).toEqual([1.10012, 1.10013]);
  });
});
