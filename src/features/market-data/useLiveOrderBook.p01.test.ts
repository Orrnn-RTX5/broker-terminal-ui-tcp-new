/**
 * P01 round 2, step 4 (independent tester): depth of market against the shown quote.
 *
 * For the same raw top of book, the best depth bid and ask after markup must equal the shown quote's bid and ask
 * (applySpreadMarkupToQuote, same module). Also checked: the depth spread is never negative and equals the quote spread;
 * deeper levels keep their distance from the top (to one digit point, each level rounds on its own); a one-sided book
 * behaves like the one-sided quote; an empty side stays empty.
 *
 * Backend rule used for the hand values (services/gateway/internal/canonicalpolicy/approved_pricing.go:326-414,
 * approvedPriceRound = exact decimal, RoundHalfUp at the symbol digits, one rounding at the end).
 *
 * Hand anchors (EURUSD digits 5, tick = point 0.00001, raw bid 1.10000 / ask 1.10012 unless stated):
 *   m=5: bid 1.10000 - 3 points = 1.09997 ; ask 1.10012 + 2 points = 1.10014
 *   m=7: bid - 4 points = 1.09996 ; ask + 3 points = 1.10015
 *   S=10 (raw 1.10000 / 1.10004): mid 1.10002, bid = mid - 5 points = 1.09997, ask = bid + 10 points = 1.10007
 *   D=-20, m=5 (crossing): quote keeps 1.10000 / 1.10012 ; depth must too (not 1.10007 / 1.10004)
 */
import { describe, expect, it } from 'vitest';
import {
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  buildSpreadMarkupMap,
  resolveSpreadMarkupEntry,
  roundPriceToDigits,
  type SpreadMarkupEntry,
} from '../../utils/spreadMarkup';
import { applySpreadMarkupToOrderBook } from './useLiveOrderBook';

type Level = { price: number; volume: number; total: number };
type Shaping = Partial<Pick<
  SpreadMarkupEntry,
  'fixedSpreadPoints' | 'spreadBalancePoints' | 'spreadDiffPoints' | 'spreadDiffBalancePoints'
>>;

const DEPTH = 4;
const MARKUPS = [0, 1, 5, 7];

const INSTRUMENTS: Array<{ symbol: string; digits: number; tickSize: number; tops: Array<[number, number]> }> = [
  {
    symbol: 'EURUSD',
    digits: 5,
    tickSize: 0.00001,
    tops: [[1.1, 1.10012], [1.1, 1.10004], [1.1, 1.10001], [1.1, 1.10003], [1.1, 1.1]],
  },
  { symbol: 'USDJPY', digits: 3, tickSize: 0.001, tops: [[150.123, 150.135], [150.123, 150.124]] },
  { symbol: 'XAUUSD', digits: 2, tickSize: 0.01, tops: [[4425.9, 4426.05], [4425.9, 4425.93]] },
];

const SHAPINGS: Array<{ name: string; shaping: Shaping }> = [
  { name: 'none', shaping: {} },
  { name: 'S=10', shaping: { fixedSpreadPoints: 10 } },
  { name: 'S=10 SB=-2', shaping: { fixedSpreadPoints: 10, spreadBalancePoints: -2 } },
  { name: 'S=12 SB=-1 (S = raw spread)', shaping: { fixedSpreadPoints: 12, spreadBalancePoints: -1 } },
  { name: 'floating SB=+3', shaping: { spreadBalancePoints: 3 } },
  { name: 'floating SB=-3', shaping: { spreadBalancePoints: -3 } },
  { name: 'D=4 B=-1', shaping: { spreadDiffPoints: 4, spreadDiffBalancePoints: -1 } },
  { name: 'D=-3', shaping: { spreadDiffPoints: -3 } },
  { name: 'D=-20 (crossing)', shaping: { spreadDiffPoints: -20 } },
  { name: 'D=0 B=+2', shaping: { spreadDiffBalancePoints: 2 } },
  { name: 'S=10 D=3', shaping: { fixedSpreadPoints: 10, spreadDiffPoints: 3 } },
];

const entryOf = (input: Parameters<typeof resolveSpreadMarkupEntry>[0]): SpreadMarkupEntry => {
  const entry = resolveSpreadMarkupEntry(input);
  if (!entry) throw new Error('expected an active markup entry');
  return entry;
};

/** Raw depth: `top` then one level per `step`; bids go down (direction -1), asks go up (+1). */
const rawSide = (top: number, step: number, digits: number, direction: 1 | -1): Level[] =>
  Array.from({ length: DEPTH }, (_, i) => ({
    price: roundPriceToDigits(top + direction * i * step, digits),
    volume: i + 1,
    total: 0,
  }));

describe('P01 round 2 step 4: depth of market against the shown quote (matrix)', () => {
  it('for every instrument, markup and shaping: best depth bid/ask = shown quote; spread never negative; distances kept; one-sided books', () => {
    const problems: string[] = [];
    let cases = 0;
    for (const inst of INSTRUMENTS) {
      const pointSize = 10 ** -inst.digits;
      for (const m of MARKUPS) {
        for (const variant of SHAPINGS) {
          for (const [rawBid, rawAsk] of inst.tops) {
            const id = `${inst.symbol} m=${m} ${variant.name} raw ${rawBid}/${rawAsk}`;
            cases += 1;
            const entry = resolveSpreadMarkupEntry({
              spreadMarkup: m, tickSize: inst.tickSize, digits: inst.digits, ...variant.shaping,
            });
            const bidsIn = rawSide(rawBid, inst.tickSize, inst.digits, -1);
            const asksIn = rawSide(rawAsk, inst.tickSize, inst.digits, 1);
            if (!entry) {
              // No markup and no shaping: the depth must stay the raw book.
              if (applySpreadMarkupToBookLevels(bidsIn, 'bid', entry, asksIn) !== bidsIn) {
                problems.push(`${id}: no entry but the bid depth changed`);
              }
              continue;
            }
            const quote = applySpreadMarkupToQuote({ bid: rawBid, ask: rawAsk }, entry);
            const bids = applySpreadMarkupToBookLevels(bidsIn, 'bid', entry, asksIn);
            const asks = applySpreadMarkupToBookLevels(asksIn, 'ask', entry, bidsIn);

            if (bids[0].price !== quote.bid) problems.push(`${id}: depth bid ${bids[0].price} != quote bid ${quote.bid}`);
            if (asks[0].price !== quote.ask) problems.push(`${id}: depth ask ${asks[0].price} != quote ask ${quote.ask}`);

            const depthSpread = roundPriceToDigits(asks[0].price - bids[0].price, inst.digits);
            const quoteSpread = roundPriceToDigits(quote.ask - quote.bid, inst.digits);
            if (depthSpread < 0) problems.push(`${id}: negative depth spread ${depthSpread}`);
            if (depthSpread !== quoteSpread) problems.push(`${id}: depth spread ${depthSpread} != quote spread ${quoteSpread}`);

            for (let i = 1; i < DEPTH; i += 1) {
              const bidShift = (bids[i].price - bids[0].price) - (bidsIn[i].price - bidsIn[0].price);
              const askShift = (asks[i].price - asks[0].price) - (asksIn[i].price - asksIn[0].price);
              if (Math.abs(bidShift) > pointSize + 1e-9) problems.push(`${id}: bid level ${i} distance moved by ${bidShift}`);
              if (Math.abs(askShift) > pointSize + 1e-9) problems.push(`${id}: ask level ${i} distance moved by ${askShift}`);
            }
            for (const level of [...bids, ...asks]) {
              if (!(level.price > 0) || !Number.isFinite(level.price)) problems.push(`${id}: non-positive level ${level.price}`);
            }

            // One-sided books: an empty opposite side gives the one-sided quote.
            const bidOnly = applySpreadMarkupToBookLevels(bidsIn, 'bid', entry, []);
            const quoteBidOnly = applySpreadMarkupToQuote({ bid: rawBid, ask: 0 }, entry);
            if (bidOnly[0].price !== quoteBidOnly.bid) {
              problems.push(`${id}: bid-only depth ${bidOnly[0].price} != one-sided quote ${quoteBidOnly.bid}`);
            }
            const askOnly = applySpreadMarkupToBookLevels(asksIn, 'ask', entry, []);
            const quoteAskOnly = applySpreadMarkupToQuote({ bid: 0, ask: rawAsk }, entry);
            if (askOnly[0].price !== quoteAskOnly.ask) {
              problems.push(`${id}: ask-only depth ${askOnly[0].price} != one-sided quote ${quoteAskOnly.ask}`);
            }
          }
        }
      }
    }
    // Printed so the report can state how many combinations were compared.
    console.log(`[P01 step 4 matrix] combinations=${cases} problems=${problems.length}`);
    expect(problems).toEqual([]);
  });
});

describe('P01 round 2 step 4: hand-worked depth values', () => {
  it('EURUSD m=5 (no shaping): top 1.09997 / 1.10014 (-3 / +2 points); deeper bids keep one tick each', () => {
    const entry = entryOf({ spreadMarkup: 5, tickSize: 0.00001, digits: 5 });
    const bids = applySpreadMarkupToBookLevels(rawSide(1.1, 0.00001, 5, -1), 'bid', entry, rawSide(1.10012, 0.00001, 5, 1));
    const asks = applySpreadMarkupToBookLevels(rawSide(1.10012, 0.00001, 5, 1), 'ask', entry, rawSide(1.1, 0.00001, 5, -1));
    expect(bids.slice(0, 3).map((level) => level.price)).toEqual([1.09997, 1.09996, 1.09995]);
    expect(asks[0].price).toBe(1.10014);
  });

  it('EURUSD m=7 (no shaping): top 1.09996 / 1.10015 (-4 / +3 points)', () => {
    const entry = entryOf({ spreadMarkup: 7, tickSize: 0.00001, digits: 5 });
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1, volume: 1, total: 1 }], 'bid', entry, [{ price: 1.10012 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10012, volume: 1, total: 1 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(1.09996);
    expect(asks[0].price).toBe(1.10015);
  });

  it('EURUSD fixed S=10 re-centres the depth top like the quote: 1.09997 / 1.10007 (raw 1.10000 / 1.10004)', () => {
    const entry = entryOf({ fixedSpreadPoints: 10, spreadBalancePoints: 0, tickSize: 0.00001, digits: 5 });
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1, volume: 1, total: 1 }], 'bid', entry, [{ price: 1.10004 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10004, volume: 1, total: 1 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(1.09997);
    expect(asks[0].price).toBe(1.10007);
  });

  it('EURUSD D=-20 with m=5 (crossing): depth keeps 1.10000 / 1.10012, spread 0.00012, never negative', () => {
    const entry = entryOf({ spreadMarkup: 5, spreadDiffPoints: -20, tickSize: 0.00001, digits: 5 });
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1, volume: 1, total: 1 }], 'bid', entry, [{ price: 1.10012 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10012, volume: 1, total: 1 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(1.1);
    expect(asks[0].price).toBe(1.10012);
    expect(roundPriceToDigits(asks[0].price - bids[0].price, 5)).toBe(0.00012);
  });

  it('EURUSD D=-3 (narrowing, m=0) from raw 1.10000 / 1.10012: depth 1.10002 / 1.10011', () => {
    // bidPts = -3 - (-1) = -2 -> bid +2 points ; askPts = -1 -> ask -1 point
    const entry = entryOf({ spreadDiffPoints: -3, tickSize: 0.00001, digits: 5 });
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1, volume: 1, total: 1 }], 'bid', entry, [{ price: 1.10012 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10012, volume: 1, total: 1 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(1.10002);
    expect(asks[0].price).toBe(1.10011);
  });

  it('USDJPY m=5 (digits 3): top 150.12 / 150.137 (bid -3, ask +2 thousandths)', () => {
    const entry = entryOf({ spreadMarkup: 5, tickSize: 0.001, digits: 3 });
    const bids = applySpreadMarkupToBookLevels([{ price: 150.123, volume: 1, total: 1 }], 'bid', entry, [{ price: 150.135 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 150.135, volume: 1, total: 1 }], 'ask', entry, [{ price: 150.123 }]);
    expect(bids[0].price).toBe(150.12);
    expect(asks[0].price).toBe(150.137);
  });

  it('XAUUSD m=7 (digits 2): top 4425.86 / 4426.08 (bid -4, ask +3 cents), spread 0.22', () => {
    const entry = entryOf({ spreadMarkup: 7, tickSize: 0.01, digits: 2 });
    const bids = applySpreadMarkupToBookLevels([{ price: 4425.9, volume: 1, total: 1 }], 'bid', entry, [{ price: 4426.05 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 4426.05, volume: 1, total: 1 }], 'ask', entry, [{ price: 4425.9 }]);
    expect(bids[0].price).toBe(4425.86);
    expect(asks[0].price).toBe(4426.08);
    expect(roundPriceToDigits(asks[0].price - bids[0].price, 2)).toBe(0.22);
  });

  it('half-point mid (fixed S=10, raw 1.10000 / 1.10001): RAM engine float64 gives 1.09995 / 1.10005 for depth and quote', () => {
    // Reconciled to real Go RAM engine (shapeAccountQuoteP at ram_symbol_reload_tcp.go:1193-1211,
    // roundPrice at ram_mt5_phase5.go:29-39; fixture src/utils/__fixtures__/spreadMarkupEngineGolden.jsonl line 11):
    //   unrounded bid = 1.0999549999999998 -> roundPrice(*1e5) = 1.09995
    //   unrounded ask = 1.1000549999999999 -> roundPrice(*1e5) = 1.10005
    const entry = entryOf({ fixedSpreadPoints: 10, spreadBalancePoints: 0, tickSize: 0.00001, digits: 5 });
    const quote = applySpreadMarkupToQuote({ bid: 1.1, ask: 1.10001 }, entry);
    expect(quote.bid).toBe(1.09995);
    expect(quote.ask).toBe(1.10005);
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1, volume: 1, total: 1 }], 'bid', entry, [{ price: 1.10001 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10001, volume: 1, total: 1 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(1.09995);
    expect(asks[0].price).toBe(1.10005);
  });

  it('half-point mid (USDJPY fixed S=10, raw 150.123 / 150.124): RAM engine float64 gives 150.118 / 150.128 for depth and quote', () => {
    // Reconciled to real Go RAM engine (shapeAccountQuoteP at ram_symbol_reload_tcp.go:1193-1211,
    // roundPrice at ram_mt5_phase5.go:29-39; fixture src/utils/__fixtures__/spreadMarkupEngineGolden.jsonl line 12):
    //   unrounded bid = 150.11849999999998 -> roundPrice(*1000) = 150.118
    //   unrounded ask = 150.12849999999997 -> roundPrice(*1000) = 150.128
    const entry = entryOf({ fixedSpreadPoints: 10, spreadBalancePoints: 0, tickSize: 0.001, digits: 3 });
    const quote = applySpreadMarkupToQuote({ bid: 150.123, ask: 150.124 }, entry);
    expect(quote.bid).toBe(150.118);
    expect(quote.ask).toBe(150.128);
    const bids = applySpreadMarkupToBookLevels([{ price: 150.123, volume: 1, total: 1 }], 'bid', entry, [{ price: 150.124 }]);
    expect(bids[0].price).toBe(150.118);
  });

  it('half-point mid (XAUUSD fixed S=10, raw 4425.90 / 4425.93): backend gives 4425.87 / 4425.97 for depth and quote', () => {
    // mid = 4425.915 ; bid = mid - 5 cents = 4425.865 -> 4425.87 ; ask = 4425.865 + 0.10 = 4425.965 -> 4425.97
    const entry = entryOf({ fixedSpreadPoints: 10, spreadBalancePoints: 0, tickSize: 0.01, digits: 2 });
    const quote = applySpreadMarkupToQuote({ bid: 4425.9, ask: 4425.93 }, entry);
    expect(quote.bid).toBe(4425.87);
    expect(quote.ask).toBe(4425.97);
    const bids = applySpreadMarkupToBookLevels([{ price: 4425.9, volume: 1, total: 1 }], 'bid', entry, [{ price: 4425.93 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 4425.93, volume: 1, total: 1 }], 'ask', entry, [{ price: 4425.9 }]);
    expect(bids[0].price).toBe(4425.87);
    expect(asks[0].price).toBe(4425.97);
  });

  it('empty opposite side: the bid levels move like the one-sided quote; empty levels stay empty; no entry returns the same array', () => {
    const entry = entryOf({ spreadMarkup: 5, tickSize: 0.00001, digits: 5 });
    const bids = [{ price: 1.1, volume: 1, total: 1 }, { price: 1.09999, volume: 2, total: 3 }];
    // Bid -3 points with no ask: 1.09997 ; the one-sided quote gives the same bid.
    expect(applySpreadMarkupToBookLevels(bids, 'bid', entry, [])[0].price).toBe(1.09997);
    expect(applySpreadMarkupToQuote({ bid: 1.1, ask: 0 }, entry).bid).toBe(1.09997);
    expect(applySpreadMarkupToBookLevels([], 'ask', entry, bids)).toEqual([]);
    const plain = applySpreadMarkupToBookLevels(bids, 'bid', undefined, []);
    expect(plain).toBe(bids);
  });

  it('order book wrapper: EURUSD m=5 best bid 1.09997, best ask 1.10014, spread 0.00017 and spreadPips 1.7; no markup returns the same object', () => {
    const map = buildSpreadMarkupMap([{ symbol: 'EURUSD', spreadMarkup: 5, tickSize: 0.00001, digits: 5 }]);
    const book = {
      symbol: 'EURUSD',
      bids: [{ price: 1.1, volume: 1, total: 1 }, { price: 1.09999, volume: 2, total: 3 }],
      asks: [{ price: 1.10012, volume: 1, total: 1 }, { price: 1.10013, volume: 4, total: 5 }],
      spread: 0.00012,
      spreadPips: null,
      timestamp: 1,
    };
    const shown = applySpreadMarkupToOrderBook(book, map);
    expect(shown?.bids[0].price).toBe(1.09997);
    expect(shown?.asks[0].price).toBe(1.10014);
    expect(shown?.spread).toBe(0.00017);
    expect(shown?.spreadPips).toBeCloseTo(1.7, 10);
    expect(applySpreadMarkupToOrderBook(book, new Map())).toBe(book);
  });
});
