/**
 * P01 round 3, step 2 (independent tester):
 *   1. 24,000-case fixed-seed property test comparing the fast path, the shaped path,
 *      zero-shaping entries, and an independent integer-arithmetic backend reference.
 *   2. Hand-worked half-tick cases (fixed spread and spread balance with odd point counts)
 *      on 3-digit (USDJPY) and 5-digit (EURUSD) symbols for quotes and top depth levels.
 */
import { describe, expect, it } from 'vitest';
import {
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  resolveSpreadMarkupEntry,
  type SpreadMarkupEntry,
} from './spreadMarkup';

interface InstrumentSpec {
  name: string;
  digits: number;
  tickSize: number;
  tickUnits: bigint; // tickSize expressed in units of 10^-digits
}

const SPECS: readonly InstrumentSpec[] = [
  { name: 'd0_t1', digits: 0, tickSize: 1, tickUnits: 1n },
  { name: 'd1_t0.1', digits: 1, tickSize: 0.1, tickUnits: 1n },
  { name: 'd1_t0.5', digits: 1, tickSize: 0.5, tickUnits: 5n },
  { name: 'd2_t0.01', digits: 2, tickSize: 0.01, tickUnits: 1n },
  { name: 'd2_t0.25', digits: 2, tickSize: 0.25, tickUnits: 25n },
  { name: 'd2_t0.5', digits: 2, tickSize: 0.5, tickUnits: 50n },
  { name: 'd3_t0.001', digits: 3, tickSize: 0.001, tickUnits: 1n },
  { name: 'd5_t0.00001', digits: 5, tickSize: 0.00001, tickUnits: 1n },
];

/** Deterministic Mulberry32 PRNG (fixed seed). */
const createPrng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randInt = (rng: () => number, min: number, maxInclusive: number): number =>
  min + Math.floor(rng() * (maxInclusive - min + 1));

/** Converts an exact integer count of 10^-digits units to a JS number without float multiplication drift. */
const unitsToNumber = (units: bigint, digits: number): number => {
  if (units === 0n) return 0;
  const neg = units < 0n;
  const abs = neg ? -units : units;
  if (digits === 0) return Number(neg ? `-${abs}` : `${abs}`);
  const s = abs.toString().padStart(digits + 1, '0');
  const intPart = s.slice(0, s.length - digits);
  const fracPart = s.slice(s.length - digits);
  return Number(`${neg ? '-' : ''}${intPart}.${fracPart}`);
};

const pow10Big = (n: number): bigint => 10n ** BigInt(n);

const pickPriceUnits = (rng: () => number, spec: InstrumentSpec, bucket: number): bigint => {
  const oneUnit = pow10Big(spec.digits);
  const maxUnits = 100_000n * oneUnit;
  let minTicks: bigint;
  let maxTicks: bigint;

  if (bucket === 0 && spec.digits >= 1) {
    // Sub-unit: strictly < 1
    minTicks = 1n;
    maxTicks = (oneUnit - 1n) / spec.tickUnits;
  } else if (bucket === 1) {
    // Small: 1 .. 10
    minTicks = oneUnit / spec.tickUnits;
    if (minTicks < 1n) minTicks = 1n;
    maxTicks = (10n * oneUnit) / spec.tickUnits;
  } else if (bucket === 2) {
    // Medium: 10 .. 1,000
    minTicks = (10n * oneUnit) / spec.tickUnits;
    maxTicks = (1_000n * oneUnit) / spec.tickUnits;
  } else if (bucket === 3) {
    // Large: 1,000 .. 10,000
    minTicks = (1_000n * oneUnit) / spec.tickUnits;
    maxTicks = (10_000n * oneUnit) / spec.tickUnits;
  } else {
    // Very large: 10,000 .. 100,000
    minTicks = (10_000n * oneUnit) / spec.tickUnits;
    maxTicks = maxUnits / spec.tickUnits;
  }

  if (maxTicks < minTicks) maxTicks = minTicks;
  const span = maxTicks - minTicks + 1n;
  // Combine two 32-bit draws for uniform coverage across large spans (e.g. digits=5 up to 10^10 ticks).
  const hi = BigInt(Math.floor(rng() * 0x100000000));
  const lo = BigInt(Math.floor(rng() * 0x100000000));
  const offset = ((hi << 32n) | lo) % span;
  return (minTicks + offset) * spec.tickUnits;
};

describe('P01 round 3 step 2: fast path vs shaped path vs integer backend reference (24,000 cases)', () => {
  it('agrees across 24,000 deterministic cases covering digits {0,1,2,3,5}, ticks {0.25,0.5,...}, m=0..500, and all quote modes', () => {
    const TOTAL_CASES = 24_000;
    const rng = createPrng(0x50303133);
    const mismatches: string[] = [];

    for (let i = 0; i < TOTAL_CASES; i += 1) {
      const spec = SPECS[i % SPECS.length];
      // Guarantee m=0, m=1, odd/even coverage plus uniform 0..500
      const m = i < 501 ? i : randInt(rng, 0, 500);
      const mode = i % 3; // 0: two-sided, 1: bid-only, 2: ask-only
      const bucket = Math.floor(i / SPECS.length) % 5;

      const baseUnits = pickPriceUnits(rng, spec, bucket);
      const rawSpreadTicks = BigInt(randInt(rng, 0, 50));
      const rawBidUnits = mode === 2 ? 0n : baseUnits;
      const rawAskUnits = mode === 1 ? 0n : baseUnits + rawSpreadTicks * spec.tickUnits;

      const rawBid = unitsToNumber(rawBidUnits, spec.digits);
      const rawAsk = unitsToNumber(rawAskUnits, spec.digits);
      const rawSpread = mode === 0 ? unitsToNumber(rawAskUnits - rawBidUnits, spec.digits) : undefined;
      const quote = mode === 0
        ? { bid: rawBid, ask: rawAsk, spread: rawSpread }
        : { bid: rawBid, ask: rawAsk };

      // Independent integer-arithmetic backend rule (no product helpers imported):
      // ask_shown = raw_ask + floor(m/2) * tick ; bid_shown = raw_bid - (m - floor(m/2)) * tick
      const mBig = BigInt(m);
      const askPts = mBig / 2n;
      const bidPts = mBig - askPts;
      const bidDeltaUnits = bidPts * spec.tickUnits;
      const askDeltaUnits = askPts * spec.tickUnits;

      const hasBid = rawBidUnits > 0n;
      const hasAsk = rawAskUnits > 0n;
      let expectedBidUnits = rawBidUnits;
      let bidFallback = false;
      if (hasBid) {
        const candidate = rawBidUnits - bidDeltaUnits;
        if (candidate > 0n) {
          expectedBidUnits = candidate;
        } else {
          bidFallback = true;
        }
      }
      const expectedAskUnits = hasAsk ? rawAskUnits + askDeltaUnits : 0n;

      const expectedBid = unitsToNumber(expectedBidUnits, spec.digits);
      const expectedAsk = unitsToNumber(expectedAskUnits, spec.digits);

      const entry = resolveSpreadMarkupEntry({
        spreadMarkup: m,
        tickSize: spec.tickSize,
        digits: spec.digits,
      });

      const shown = applySpreadMarkupToQuote(quote, entry);

      // (a) Result equals independent integer-arithmetic backend rule.
      if (shown.bid !== expectedBid || shown.ask !== expectedAsk) {
        if (mismatches.length < 20) {
          mismatches.push(
            `case ${i} (${spec.name} m=${m} mode=${mode} raw=${rawBid}/${rawAsk}): `
            + `backend ${expectedBid}/${expectedAsk} vs shown ${shown.bid}/${shown.ask}`,
          );
        }
        continue;
      }

      // (b) Shown spread equals raw spread + m * t at symbol digits (accounting for non-positive bid fallback).
      if (hasBid && hasAsk) {
        const expectedSpreadUnits = bidFallback
          ? (rawAskUnits - rawBidUnits) + askDeltaUnits
          : (rawAskUnits - rawBidUnits) + mBig * spec.tickUnits;
        const expectedSpread = unitsToNumber(expectedSpreadUnits, spec.digits);
        const actualSpread = (shown as { spread?: number }).spread;
        if (actualSpread !== expectedSpread) {
          if (mismatches.length < 20) {
            mismatches.push(
              `case ${i} (${spec.name} m=${m} raw=${rawBid}/${rawAsk}): `
              + `spread expected ${expectedSpread}, got ${String(actualSpread)}`,
            );
          }
          continue;
        }
      }

      // (c) Idempotence: applying twice equals applying once.
      const twice = applySpreadMarkupToQuote(shown, entry);
      if (
        twice.bid !== shown.bid
        || twice.ask !== shown.ask
        || (twice as { spread?: number }).spread !== (shown as { spread?: number }).spread
        || twice.rawBid !== shown.rawBid
        || twice.rawAsk !== shown.rawAsk
        || twice.spreadMarkup !== shown.spreadMarkup
      ) {
        if (mismatches.length < 20) {
          mismatches.push(`case ${i} (${spec.name} m=${m}): second application changed quote`);
        }
        continue;
      }

      // (d) Entry with all four shaping fields present as 0 yields identical result.
      const zeroShapedEntry = resolveSpreadMarkupEntry({
        spreadMarkup: m,
        tickSize: spec.tickSize,
        digits: spec.digits,
        fixedSpreadPoints: 0,
        spreadBalancePoints: 0,
        spreadDiffPoints: 0,
        spreadDiffBalancePoints: 0,
      });
      const zeroShapedShown = applySpreadMarkupToQuote(quote, zeroShapedEntry);
      if (
        zeroShapedShown.bid !== shown.bid
        || zeroShapedShown.ask !== shown.ask
        || (zeroShapedShown as { spread?: number }).spread !== (shown as { spread?: number }).spread
      ) {
        if (mismatches.length < 20) {
          mismatches.push(
            `case ${i} (${spec.name} m=${m}): zero-shaping entry gave ${zeroShapedShown.bid}/${zeroShapedShown.ask} vs ${shown.bid}/${shown.ask}`,
          );
        }
        continue;
      }

      // (e) Direct fast-path vs shaped-path check: force shapedQuote/shapeSides/roundShapedPrice with S=0, SB=0.
      if (entry) {
        const forcedShapedEntry: SpreadMarkupEntry = { ...entry, hasSymbolShaping: true };
        const forcedShaped = applySpreadMarkupToQuote(quote, forcedShapedEntry);
        if (
          forcedShaped.bid !== shown.bid
          || forcedShaped.ask !== shown.ask
          || (forcedShaped as { spread?: number }).spread !== (shown as { spread?: number }).spread
        ) {
          if (mismatches.length < 20) {
            mismatches.push(
              `case ${i} (${spec.name} m=${m} raw=${rawBid}/${rawAsk}): `
              + `fast path ${shown.bid}/${shown.ask} != shaped path ${forcedShaped.bid}/${forcedShaped.ask}`,
            );
          }
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});

const entryOf = (input: Parameters<typeof resolveSpreadMarkupEntry>[0]): SpreadMarkupEntry => {
  const entry = resolveSpreadMarkupEntry(input);
  if (!entry) throw new Error('expected active entry');
  return entry;
};

describe('P01 round 3 step 2: half-tick cases through the shaped path (RAM engine float64 roundPrice)', () => {
  it('USDJPY (digits 3): fixed S=10, SB=0, raw 150.123 / 150.124 -> 150.118 / 150.128', () => {
    // Reconciled to real Go RAM engine (shapeAccountQuoteP at ram_symbol_reload_tcp.go:1193-1211,
    // roundPrice at ram_mt5_phase5.go:29-39; fixture src/utils/__fixtures__/spreadMarkupEngineGolden.jsonl line 1):
    //   unrounded bid = 150.1235 - 0.005 = 150.11849999999998 -> roundPrice(*1000) = 150.118
    //   unrounded ask = 150.11849999999998 + 0.01 = 150.12849999999997 -> roundPrice(*1000) = 150.128
    const entry = entryOf({ fixedSpreadPoints: 10, spreadBalancePoints: 0, tickSize: 0.001, digits: 3 });
    const quote = applySpreadMarkupToQuote({ bid: 150.123, ask: 150.124 }, entry);
    expect(quote.bid).toBe(150.118);
    expect(quote.ask).toBe(150.128);
    const bids = applySpreadMarkupToBookLevels([{ price: 150.123 }], 'bid', entry, [{ price: 150.124 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 150.124 }], 'ask', entry, [{ price: 150.123 }]);
    expect(bids[0].price).toBe(150.118);
    expect(asks[0].price).toBe(150.128);
  });

  it('USDJPY (digits 3): odd fixed S=7, SB=0, raw 150.123 / 150.124 -> 150.121 / 150.128', () => {
    // Hand work:
    //   mid = 150.1235 ; Int(7/2) = 3 -> fixedBidOffset = 0.003
    //   unrounded bid = 150.1235 - 0.003 = 150.1205 -> half-up = 150.121
    //   unrounded ask = 150.1205 + 0.007 = 150.1275 -> half-up = 150.128
    const entry = entryOf({ fixedSpreadPoints: 7, spreadBalancePoints: 0, tickSize: 0.001, digits: 3 });
    const quote = applySpreadMarkupToQuote({ bid: 150.123, ask: 150.124 }, entry);
    expect(quote.bid).toBe(150.121);
    expect(quote.ask).toBe(150.128);
    const bids = applySpreadMarkupToBookLevels([{ price: 150.123 }], 'bid', entry, [{ price: 150.124 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 150.124 }], 'ask', entry, [{ price: 150.123 }]);
    expect(bids[0].price).toBe(150.121);
    expect(asks[0].price).toBe(150.128);
  });

  it('USDJPY (digits 3): odd fixed S=7, odd SB=-3, raw 150.123 / 150.126 -> 150.119 / 150.126', () => {
    // Hand work:
    //   raw spread = 0.003 != 0.007 -> mid = (150.123 + 150.126) / 2 = 150.1245
    //   fixedBidOffset = 0.001 * (Int(7/2) - (-3)) = 0.001 * (3 + 3) = 0.006
    //   unrounded bid = 150.1245 - 0.006 = 150.1185 -> half-up = 150.119
    //   unrounded ask = 150.1185 + 0.007 = 150.1255 -> half-up = 150.126
    const entry = entryOf({ fixedSpreadPoints: 7, spreadBalancePoints: -3, tickSize: 0.001, digits: 3 });
    const quote = applySpreadMarkupToQuote({ bid: 150.123, ask: 150.126 }, entry);
    expect(quote.bid).toBe(150.119);
    expect(quote.ask).toBe(150.126);
    const bids = applySpreadMarkupToBookLevels([{ price: 150.123 }], 'bid', entry, [{ price: 150.126 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 150.126 }], 'ask', entry, [{ price: 150.123 }]);
    expect(bids[0].price).toBe(150.119);
    expect(asks[0].price).toBe(150.126);
  });

  it('USDJPY (digits 3): odd fixed S=9, odd SB=+3, raw 150.123 / 150.124 -> 150.122 / 150.131', () => {
    // Reconciled to real Go RAM engine (shapeAccountQuoteP at ram_symbol_reload_tcp.go:1193-1211,
    // roundPrice at ram_mt5_phase5.go:29-39; fixture src/utils/__fixtures__/spreadMarkupEngineGolden.jsonl line 4):
    //   unrounded bid = 150.12249999999997 -> roundPrice(*1000) = 150.122
    //   unrounded ask = 150.13149999999996 -> roundPrice(*1000) = 150.131
    const entry = entryOf({ fixedSpreadPoints: 9, spreadBalancePoints: 3, tickSize: 0.001, digits: 3 });
    const quote = applySpreadMarkupToQuote({ bid: 150.123, ask: 150.124 }, entry);
    expect(quote.bid).toBe(150.122);
    expect(quote.ask).toBe(150.131);
    const bids = applySpreadMarkupToBookLevels([{ price: 150.123 }], 'bid', entry, [{ price: 150.124 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 150.124 }], 'ask', entry, [{ price: 150.123 }]);
    expect(bids[0].price).toBe(150.122);
    expect(asks[0].price).toBe(150.131);
  });

  it('USDJPY (digits 3): odd fixed S=5, odd SB=+1, odd m=3, raw 150.123 / 150.124 -> 150.12 / 150.128', () => {
    // Reconciled to real Go RAM engine (shapeAccountQuoteP at ram_symbol_reload_tcp.go:1193-1211,
    // widenQuoteForSpreadTermsUnits at spread_markup.go:144-160, roundPrice at ram_mt5_phase5.go:29-39;
    // fixture src/utils/__fixtures__/spreadMarkupEngineGolden.jsonl line 5):
    //   unrounded bid = 150.12049999999996 -> roundPrice(*1000) = 150.12
    //   unrounded ask = 150.12849999999997 -> roundPrice(*1000) = 150.128
    const entry = entryOf({
      spreadMarkup: 3, fixedSpreadPoints: 5, spreadBalancePoints: 1, tickSize: 0.001, digits: 3,
    });
    const quote = applySpreadMarkupToQuote({ bid: 150.123, ask: 150.124 }, entry);
    expect(quote.bid).toBe(150.12);
    expect(quote.ask).toBe(150.128);
    const bids = applySpreadMarkupToBookLevels([{ price: 150.123 }], 'bid', entry, [{ price: 150.124 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 150.124 }], 'ask', entry, [{ price: 150.123 }]);
    expect(bids[0].price).toBe(150.12);
    expect(asks[0].price).toBe(150.128);
  });

  it('USDJPY (digits 3): fixed S=6, odd SB=+1, odd D=-3, B=0, raw 150.123 / 150.124 -> 150.123 / 150.126', () => {
    // Reconciled to real Go RAM engine (shapeAccountQuoteP at ram_symbol_reload_tcp.go:1193-1211,
    // widenQuoteForSpreadTermsUnits at spread_markup.go:144-160, roundPrice at ram_mt5_phase5.go:29-39;
    // fixture src/utils/__fixtures__/spreadMarkupEngineGolden.jsonl line 6):
    //   unrounded bid = 150.12349999999998 -> roundPrice(*1000) = 150.123
    //   unrounded ask = 150.12649999999996 -> roundPrice(*1000) = 150.126
    const entry = entryOf({
      fixedSpreadPoints: 6, spreadBalancePoints: 1, spreadDiffPoints: -3, spreadDiffBalancePoints: 0, tickSize: 0.001, digits: 3,
    });
    const quote = applySpreadMarkupToQuote({ bid: 150.123, ask: 150.124 }, entry);
    expect(quote.bid).toBe(150.123);
    expect(quote.ask).toBe(150.126);
    const bids = applySpreadMarkupToBookLevels([{ price: 150.123 }], 'bid', entry, [{ price: 150.124 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 150.124 }], 'ask', entry, [{ price: 150.123 }]);
    expect(bids[0].price).toBe(150.123);
    expect(asks[0].price).toBe(150.126);
  });

  it('EURUSD (digits 5): odd fixed S=7, SB=0, raw 1.10000 / 1.10001 -> 1.09997 / 1.10005', () => {
    // Reconciled to real Go RAM engine (shapeAccountQuoteP at ram_symbol_reload_tcp.go:1193-1211,
    // roundPrice at ram_mt5_phase5.go:29-39; fixture src/utils/__fixtures__/spreadMarkupEngineGolden.jsonl line 7):
    //   unrounded bid = 1.0999749999999997 -> roundPrice(*1e5) = 1.09997
    //   unrounded ask = 1.100045 -> roundPrice(*1e5) = 1.10005
    const entry = entryOf({ fixedSpreadPoints: 7, spreadBalancePoints: 0, tickSize: 0.00001, digits: 5 });
    const quote = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10001 }, entry);
    expect(quote.bid).toBe(1.09997);
    expect(quote.ask).toBe(1.10005);
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1 }], 'bid', entry, [{ price: 1.10001 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10001 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(1.09997);
    expect(asks[0].price).toBe(1.10005);
  });

  it('EURUSD (digits 5): odd fixed S=9, odd SB=-3, raw 1.10000 / 1.10003 -> 1.09995 / 1.10003', () => {
    // Reconciled to real Go RAM engine (shapeAccountQuoteP at ram_symbol_reload_tcp.go:1193-1211,
    // roundPrice at ram_mt5_phase5.go:29-39; fixture src/utils/__fixtures__/spreadMarkupEngineGolden.jsonl line 8):
    //   unrounded bid = 1.0999450000000002 -> roundPrice(*1e5) = 1.09995
    //   unrounded ask = 1.1000349999999998 -> roundPrice(*1e5) = 1.10003
    const entry = entryOf({ fixedSpreadPoints: 9, spreadBalancePoints: -3, tickSize: 0.00001, digits: 5 });
    const quote = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10003 }, entry);
    expect(quote.bid).toBe(1.09995);
    expect(quote.ask).toBe(1.10003);
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1 }], 'bid', entry, [{ price: 1.10003 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10003 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(1.09995);
    expect(asks[0].price).toBe(1.10003);
  });

  it('EURUSD (digits 5): odd fixed S=5, odd SB=+1, odd m=3, raw 1.10000 / 1.10001 -> 1.09997 / 1.10006', () => {
    // Reconciled to real Go RAM engine (shapeAccountQuoteP at ram_symbol_reload_tcp.go:1193-1211,
    // widenQuoteForSpreadTermsUnits at spread_markup.go:144-160, roundPrice at ram_mt5_phase5.go:29-39;
    // fixture src/utils/__fixtures__/spreadMarkupEngineGolden.jsonl line 9):
    //   unrounded bid = 1.0999749999999997 -> roundPrice(*1e5) = 1.09997
    //   unrounded ask = 1.100055 -> roundPrice(*1e5) = 1.10006
    const entry = entryOf({
      spreadMarkup: 3, fixedSpreadPoints: 5, spreadBalancePoints: 1, tickSize: 0.00001, digits: 5,
    });
    const quote = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10001 }, entry);
    expect(quote.bid).toBe(1.09997);
    expect(quote.ask).toBe(1.10006);
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1 }], 'bid', entry, [{ price: 1.10001 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10001 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(1.09997);
    expect(asks[0].price).toBe(1.10006);
  });

  it('EURUSD (digits 5): fixed S=6, SB=0, odd D=5, odd B=-1, raw 1.10000 / 1.10001 -> 1.09993 / 1.10004', () => {
    // Reconciled to Go RAM engine market-order path (OnLiveTick Layer-1 round -> shapeAccountBaseQuote -> roundPrice;
    // fixture src/utils/__fixtures__/spreadMarkupEngineGoldenMarket.jsonl line 10, p01paths:411):
    //   Layer 1 stored: bid = round(1.0999749999999997, 5) = 1.09997, ask = round(1.1000349999999998, 5) = 1.10003
    //   Layer 2 (D=5, B=-1 -> bid -4 pts, ask +1 pt): bid = 1.09993, ask = 1.10004
    const entry = entryOf({
      fixedSpreadPoints: 6, spreadBalancePoints: 0, spreadDiffPoints: 5, spreadDiffBalancePoints: -1, tickSize: 0.00001, digits: 5,
    });
    const quote = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10001 }, entry);
    expect(quote.bid).toBe(1.09993);
    expect(quote.ask).toBe(1.10004);
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1 }], 'bid', entry, [{ price: 1.10001 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10001 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(1.09993);
    expect(asks[0].price).toBe(1.10004);
  });
});
