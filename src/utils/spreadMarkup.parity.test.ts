/**
 * P01 Part A: the terminal shows the price the engine fills at (owner decision D1).
 *
 * Written before the product change (tests first). Value assertions are expected to FAIL on
 * today's code, which adds the full markup m*tick to BOTH sides. Tests marked "guard" already
 * pass and must keep passing.
 *
 * Rule, with m = spread_markup (points), t = tick size, P = point = 10^-digits:
 *   ask_shown = raw_ask + floor(m/2) * t
 *   bid_shown = raw_bid - (m - floor(m/2)) * t
 *   shown spread = raw spread + m * t              (total, not 2 * m * t)
 *
 * Sources for every expected value (worked out by hand next to each assertion):
 *   released backend (origin/main): services/gateway/handlers/spread_markup.go:41-47 (split),
 *     :49-79 (widen ask/bid), :112-122 (SpreadDiff/Balance split), :144-160 (combined units)
 *   released canonical policy: services/gateway/internal/canonicalpolicy/approved_pricing.go
 *     :326-414 (Layer 1, group fallback), :420-492 (group split)
 *   MT5 SDK help: imtconsymbol_spreadbalance.htm, imtcongroupsymbol_spreaddiffbalance.htm
 *
 * Quote used throughout: EURUSD raw bid 1.10000, ask 1.10012 (raw spread 12 points), digits 5,
 * tick = point = 0.00001.
 */
import { describe, expect, it } from 'vitest';

import {
  buildAccountSpreadMarkupMap,
  normalizeInstrument,
} from '../features/market-data/marketDataNormalization';
import { applySpreadMarkupToOrderBook } from '../features/market-data/useLiveOrderBook';
import * as spreadMarkupModule from './spreadMarkup';
import {
  applySpreadMarkupFromMap,
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  buildSpreadMarkupMap,
  getQuoteAskMarkupOffset,
  getQuoteBidMarkupOffset,
  getSpreadMarkupOffset,
  resolveSpreadMarkupEntry,
  type SpreadMarkupEntry,
  type SpreadMarkupInstrument,
} from './spreadMarkup';

type MarkupInput = Omit<SpreadMarkupInstrument, 'symbol'> & { [key: string]: number | undefined };

/** The entry the production resolver builds for one instrument (null when nothing is active). */
const entryOf = (input: MarkupInput): SpreadMarkupEntry =>
  resolveSpreadMarkupEntry(input) as SpreadMarkupEntry;

/** The per-symbol map the production catalogue builder builds. */
const mapOf = (...rows: Array<Record<string, unknown>>) =>
  buildSpreadMarkupMap(rows as unknown as SpreadMarkupInstrument[]);

const EUR = { tickSize: 0.00001, digits: 5 };
const raw = (bid = 1.1, ask = 1.10012) => ({ bid, ask });
/** Spread of a widened quote. The quote input type has no spread field, so it is read through a cast. */
const spreadOf = (quote: object): number | undefined => (quote as { spread?: number }).spread;

/**
 * Helpers the spec adds (split helpers, SDK split, side offsets, MT5 readers). They do not exist
 * yet. They are read through a namespace object so that a missing one fails at call time with a
 * TypeError ("... is not a function") and `tsc` stays green until the implementation lands.
 */
const newApi = spreadMarkupModule as unknown as Record<string, (...args: unknown[]) => unknown>;

describe('P01 parity: total markup m is split floor(m/2) Ask and the rest Bid (EURUSD)', () => {
  it('even m=10: 5 points on each side, shown spread 22 points', () => {
    // askPts = floor(10/2) = 5; bidPts = 10 - 5 = 5
    // bid = 1.10000 - 5*0.00001 = 1.09995; ask = 1.10012 + 5*0.00001 = 1.10017; spread = 0.00012 + 0.00010 = 0.00022
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 10, ...EUR }));
    expect(shown.bid).toBe(1.09995);
    expect(shown.ask).toBe(1.10017);
    expect(spreadOf(shown)).toBe(0.00022);
  });

  it('odd m=7: Ask gets 3 points, Bid gets 4 points', () => {
    // askPts = floor(7/2) = 3; bidPts = 7 - 3 = 4
    // bid = 1.10000 - 4*0.00001 = 1.09996; ask = 1.10012 + 3*0.00001 = 1.10015; spread = 0.00012 + 0.00007 = 0.00019
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 7, ...EUR }));
    expect(shown.bid).toBe(1.09996);
    expect(shown.ask).toBe(1.10015);
    expect(spreadOf(shown)).toBe(0.00019);
  });

  it('odd m=5: the extra point goes to Bid (-3 / +2), shown spread 17 points', () => {
    // askPts = floor(5/2) = 2; bidPts = 3
    // bid = 1.10000 - 0.00003 = 1.09997; ask = 1.10012 + 0.00002 = 1.10014; spread = 0.00017
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 5, ...EUR }));
    expect(shown.bid).toBe(1.09997);
    expect(shown.ask).toBe(1.10014);
    expect(spreadOf(shown)).toBe(0.00017);
  });

  it('minimal odd m=1: Ask unchanged (+0 points), Bid -1 point', () => {
    // askPts = floor(1/2) = 0; bidPts = 1
    // bid = 1.10000 - 0.00001 = 1.09999; ask = 1.10012 + 0 = 1.10012
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 1, ...EUR }));
    expect(shown.bid).toBe(1.09999);
    expect(shown.ask).toBe(1.10012);
  });

  it('even m=4: -2 / +2, shown spread = raw spread + 4 points (not 2 x 4 points)', () => {
    // askPts = 2; bidPts = 2
    // bid = 1.10000 - 0.00002 = 1.09998; ask = 1.10012 + 0.00002 = 1.10014; spread = 0.00012 + 0.00004 = 0.00016
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 4, ...EUR }));
    expect(shown.bid).toBe(1.09998);
    expect(shown.ask).toBe(1.10014);
    expect(spreadOf(shown)).toBe(0.00016);
  });

  it('guard: markup 0, unset, negative and NaN leave the quote untouched', () => {
    const quote = raw();
    expect(applySpreadMarkupToQuote(quote, entryOf({ spreadMarkup: 0, ...EUR }))).toBe(quote);
    expect(applySpreadMarkupToQuote(quote, entryOf({ ...EUR }))).toBe(quote);
    expect(applySpreadMarkupToQuote(quote, entryOf({ spreadMarkup: -5, ...EUR }))).toBe(quote);
    expect(applySpreadMarkupToQuote(quote, entryOf({ spreadMarkup: Number.NaN, ...EUR }))).toBe(quote);
  });

  it('very large m=2147483647: the bid would go below zero so it keeps the raw bid; the ask widens finitely', () => {
    // askPts = floor(2147483647/2) = 1073741823 -> ask = 1.10012 + 1073741823*0.00001 = 1.10012 + 10737.41823 = 10738.51835
    // bidPts = 2147483647 - 1073741823 = 1073741824 -> 1.10000 - 10737.41824 = -10736.31824 (<= 0) -> keep raw bid 1.10000
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 2147483647, ...EUR }));
    expect(shown.bid).toBe(1.1);
    expect(shown.ask).toBe(10738.51835);
    expect(Number.isFinite(shown.ask)).toBe(true);
  });

  it('a bid that would become non-positive keeps the raw bid (sub-cent price, 5 digits)', () => {
    // m=5: askPts 2, bidPts 3. raw 0.00002 / 0.00010.
    // bid = 0.00002 - 0.00003 = -0.00001 (<= 0) -> keep 0.00002; ask = 0.00010 + 0.00002 = 0.00012
    const shown = applySpreadMarkupToQuote({ bid: 0.00002, ask: 0.0001 }, entryOf({ spreadMarkup: 5, ...EUR }));
    expect(shown.bid).toBe(0.00002);
    expect(shown.ask).toBe(0.00012);
  });

  it('one-sided quotes: only the side that carries a price moves', () => {
    // m=5: ask-only 1.2 -> ask +2 points = 1.20002 ; bid-only 1.2 -> bid -3 points = 1.19997
    const askOnly = applySpreadMarkupToQuote({ bid: 0, ask: 1.2 }, entryOf({ spreadMarkup: 5, ...EUR }));
    expect(askOnly.bid).toBe(0);
    expect(askOnly.ask).toBe(1.20002);
    const bidOnly = applySpreadMarkupToQuote({ bid: 1.2, ask: 0 }, entryOf({ spreadMarkup: 5, ...EUR }));
    expect(bidOnly.bid).toBe(1.19997);
    expect(bidOnly.ask).toBe(0);
  });

  it('idempotent: re-applying the same entry to a widened quote changes nothing', () => {
    const entry = entryOf({ spreadMarkup: 5, ...EUR });
    const once = applySpreadMarkupToQuote(raw(), entry);
    // 1.10000 - 3 points = 1.09997 ; 1.10012 + 2 points = 1.10014
    expect(once.bid).toBe(1.09997);
    expect(once.ask).toBe(1.10014);
    const twice = applySpreadMarkupToQuote(once, entry);
    expect(twice).toEqual(once); // guard: re-application starts from rawBid / rawAsk
  });

  it('a new markup is recomputed from the raw sides (5 -> 10 points, no compounding)', () => {
    const once = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 5, ...EUR }));
    const repriced = applySpreadMarkupToQuote(once, entryOf({ spreadMarkup: 10, ...EUR }));
    // m=10 from raw 1.10000 / 1.10012: bid 1.10000 - 5 pts = 1.09995 ; ask 1.10012 + 5 pts = 1.10017
    expect(repriced.bid).toBe(1.09995);
    expect(repriced.ask).toBe(1.10017);
    expect(repriced.rawBid).toBe(1.1);
    expect(repriced.rawAsk).toBe(1.10012);
  });

  it('guard: removing the markup restores the raw quote and drops the tags', () => {
    const widened = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 5, ...EUR }));
    const restored = applySpreadMarkupToQuote(widened, undefined);
    expect(restored.bid).toBe(1.1);
    expect(restored.ask).toBe(1.10012);
    expect(restored).not.toHaveProperty('rawBid');
    expect(restored).not.toHaveProperty('spreadMarkup');
  });

  it('guard: the total width helper stays m * tick (0.00005 for m=5)', () => {
    expect(getSpreadMarkupOffset(entryOf({ spreadMarkup: 5, ...EUR }))).toBe(0.00005);
  });

  it('symbol lookup normalises case and spaces and uses the mapped entry', () => {
    // m=5 from raw 1.10000 -> bid 1.09997 ; unmapped symbol returns the same object (guard)
    const map = mapOf({ symbol: 'EURUSD', spreadMarkup: 5, ...EUR });
    expect(applySpreadMarkupFromMap(' eurusd ', raw(), map).bid).toBe(1.09997);
    const other = raw(1.3, 1.3001);
    expect(applySpreadMarkupFromMap('GBPUSD', other, map)).toBe(other);
  });
});

describe('P01 parity: symbol digits and sub-unit prices', () => {
  it('3-digit symbol (USDJPY, digits 3, tick 0.001): m=5 gives -3 / +2 points', () => {
    // askPts 2 -> ask = 150.135 + 0.002 = 150.137 ; bidPts 3 -> bid = 150.123 - 0.003 = 150.120 ; spread 0.017
    const shown = applySpreadMarkupToQuote(
      { bid: 150.123, ask: 150.135 },
      entryOf({ spreadMarkup: 5, tickSize: 0.001, digits: 3 }),
    );
    expect(shown.bid).toBe(150.12);
    expect(shown.ask).toBe(150.137);
    expect(spreadOf(shown)).toBe(0.017);
  });

  it('2-digit symbol (XAUUSD, digits 2, tick 0.01): m=7 gives +3 cents Ask, -4 cents Bid', () => {
    // askPts 3 -> ask = 4426.05 + 0.03 = 4426.08 ; bidPts 4 -> bid = 4425.90 - 0.04 = 4425.86 ; spread 0.22
    const shown = applySpreadMarkupToQuote(
      { bid: 4425.9, ask: 4426.05 },
      entryOf({ spreadMarkup: 7, tickSize: 0.01, digits: 2 }),
    );
    expect(shown.bid).toBe(4425.86);
    expect(shown.ask).toBe(4426.08);
    expect(spreadOf(shown)).toBe(0.22);
  });

  it('sub-unit price (digits 2, tick 0.01, 5 feed decimals): R2 uses configured digits and tick (0.09 / 0.14)', () => {
    // Owner ruling R2: observed-digits rule removed; active entries always use configured digits and tickSize.
    // Engine market-order path (spreadMarkupEngineGoldenMarket.jsonl line 15; spreadMarkupEngineGoldenCheck.jsonl line 1):
    //   storedBid = round(0.12345, 2) = 0.12, storedAsk = round(0.12355, 2) = 0.12
    //   m=5: bidPts=3 (-0.03) -> 0.09, askPts=2 (+0.02) -> 0.14, spread 0.05.
    const shown = applySpreadMarkupToQuote(
      { bid: 0.12345, ask: 0.12355 },
      entryOf({ spreadMarkup: 5, tickSize: 0.01, digits: 2 }),
    );
    expect(shown.bid).toBe(0.09);
    expect(shown.ask).toBe(0.14);
    expect(spreadOf(shown)).toBe(0.05);
  });
});

describe('P01 parity: depth-of-market levels', () => {
  it('bids move down by the Bid share and asks up by the Ask share (m=5), not m on both sides', () => {
    // bids: 1.10000 - 3 points = 1.09997 ; 1.09999 - 3 points = 1.09996
    // asks: 1.10012 + 2 points = 1.10014 ; 1.10013 + 2 points = 1.10015
    const entry = entryOf({ spreadMarkup: 5, ...EUR });
    const bids = [{ price: 1.1, volume: 1, total: 1 }, { price: 1.09999, volume: 2, total: 3 }];
    const asks = [{ price: 1.10012, volume: 1, total: 1 }, { price: 1.10013, volume: 4, total: 5 }];
    expect(applySpreadMarkupToBookLevels(bids, 'bid', entry, asks).map((level) => level.price)).toEqual([1.09997, 1.09996]);
    expect(applySpreadMarkupToBookLevels(asks, 'ask', entry, bids).map((level) => level.price)).toEqual([1.10014, 1.10015]);
  });

  it('a bid level that would become non-positive keeps its raw price', () => {
    // level 0.00002 - 3 points (0.00003) = -0.00001 (<= 0) -> keep 0.00002
    // Opposite ask top 0.0001 (+2 points = 0.00012) does not cross, so the top stays at the raw 0.00002.
    const levels = applySpreadMarkupToBookLevels(
      [{ price: 0.00002, volume: 1, total: 1 }],
      'bid',
      entryOf({ spreadMarkup: 5, ...EUR }),
      [{ price: 0.0001 }],
    );
    expect(levels[0].price).toBe(0.00002);
  });

  it('order book: best bid/ask, spread and spreadPips follow the shown quote; no markup returns the same object', () => {
    const map = mapOf({ symbol: 'EURUSD', spreadMarkup: 5, tickSize: 0.00001, digits: 5 });
    const book = {
      symbol: 'EURUSD',
      bids: [{ price: 1.1, volume: 1, total: 1 }, { price: 1.09999, volume: 2, total: 3 }],
      asks: [{ price: 1.10012, volume: 1, total: 1 }, { price: 1.10013, volume: 4, total: 5 }],
      spread: 0.00012,
      spreadPips: null,
      timestamp: 1,
    };
    const shown = applySpreadMarkupToOrderBook(book, map);
    expect(shown?.bids.map((level) => level.price)).toEqual([1.09997, 1.09996]);
    expect(shown?.asks.map((level) => level.price)).toEqual([1.10014, 1.10015]);
    // best ask 1.10014 - best bid 1.09997 = 0.00017 = 17 points; 17 points / 0.0001 pip = 1.7 pips
    expect(shown?.spread).toBe(0.00017);
    expect(shown?.spreadPips).toBeCloseTo(1.7, 10);
    expect(applySpreadMarkupToOrderBook(book, new Map())).toBe(book); // guard
  });

  it('shaped group markup (D=4, B=-1) moves the levels like the top of book: bids -3, asks +1', () => {
    // top of book: bid 1.10000 - 3 points = 1.09997 ; ask 1.10012 + 1 point = 1.10013
    const entry = entryOf({ spreadDiffPoints: 4, spreadDiffBalancePoints: -1, ...EUR });
    const bids = applySpreadMarkupToBookLevels([{ price: 1.1, volume: 1, total: 1 }], 'bid', entry, [{ price: 1.10012 }]);
    const asks = applySpreadMarkupToBookLevels([{ price: 1.10012, volume: 1, total: 1 }], 'ask', entry, [{ price: 1.1 }]);
    expect(bids[0].price).toBe(1.09997);
    expect(asks[0].price).toBe(1.10013);
  });
});

describe('P01 parity: MT5 shaping fields at zero give exactly the plain split', () => {
  it('fixed spread, spread balance, spread diff and spread diff balance all 0 change nothing (m=5 -> 1.09997 / 1.10014)', () => {
    const entry = entryOf({
      spreadMarkup: 5,
      fixedSpreadPoints: 0,
      spreadBalancePoints: 0,
      spreadDiffPoints: 0,
      spreadDiffBalancePoints: 0,
      ...EUR,
    });
    const shown = applySpreadMarkupToQuote(raw(), entry);
    expect(shown.bid).toBe(1.09997);
    expect(shown.ask).toBe(1.10014);
  });
});

describe('P01 parity: MT5 Layer 1, IMTConSymbol Spread (S) and SpreadBalance (SB); Point = tick = 0.00001', () => {
  it('fixed even spread S=10, SB=0 re-centres the raw mid: 1.09997 / 1.10007', () => {
    // raw 1.10000 / 1.10004: raw spread 4 points != S -> mid 1.10002
    // bid = mid - P*(Int(10/2) - 0) = 1.10002 - 0.00005 = 1.09997 ; ask = bid + 10P = 1.10007 (spread 10 points)
    const shown = applySpreadMarkupToQuote(
      { bid: 1.1, ask: 1.10004 },
      entryOf({ fixedSpreadPoints: 10, spreadBalancePoints: 0, ...EUR }),
    );
    expect(shown.bid).toBe(1.09997);
    expect(shown.ask).toBe(1.10007);
    expect(spreadOf(shown)).toBe(0.0001);
  });

  it('fixed odd spread S=3, SB=0: -1 Bid / +2 Ask (help: spread 3 -> -1 Bid / +2 Ask)', () => {
    // raw 1.10000 / 1.10000: raw spread 0 != 3 points -> mid 1.10000
    // bid = 1.10000 - P*(Int(3/2) - 0) = 1.10000 - 0.00001 = 1.09999 ; ask = bid + 3P = 1.10002
    const shown = applySpreadMarkupToQuote(
      { bid: 1.1, ask: 1.1 },
      entryOf({ fixedSpreadPoints: 3, spreadBalancePoints: 0, ...EUR }),
    );
    expect(shown.bid).toBe(1.09999);
    expect(shown.ask).toBe(1.10002);
  });

  it('fixed spread equal to the incoming spread, SB=-2: Bid -2 points, width stays 10 points', () => {
    // raw 1.10000 / 1.10010: raw spread 10 points == S -> bid = 1.10000 + P*(-2) = 1.09998 ; ask = bid + 10P = 1.10008
    const shown = applySpreadMarkupToQuote(
      { bid: 1.1, ask: 1.1001 },
      entryOf({ fixedSpreadPoints: 10, spreadBalancePoints: -2, ...EUR }),
    );
    expect(shown.bid).toBe(1.09998);
    expect(shown.ask).toBe(1.10008);
  });

  it('fixed spread S=10, SB=-1: -6 Bid / +4 Ask around the mid (help: balance -1 = -6 / +4)', () => {
    // raw 1.10000 / 1.10004: mid 1.10002 ; bid = 1.10002 - P*(5 - (-1)) = 1.10002 - 0.00006 = 1.09996 ; ask = 1.09996 + 0.00010 = 1.10006
    const shown = applySpreadMarkupToQuote(
      { bid: 1.1, ask: 1.10004 },
      entryOf({ fixedSpreadPoints: 10, spreadBalancePoints: -1, ...EUR }),
    );
    expect(shown.bid).toBe(1.09996);
    expect(shown.ask).toBe(1.10006);
  });

  it('floating spread (S=0) with SB=+3 shifts both sides up 3 points: 1.10003 / 1.10015', () => {
    // bid = 1.10000 + 0.00003 = 1.10003 ; ask = 1.10012 + 0.00003 = 1.10015
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ fixedSpreadPoints: 0, spreadBalancePoints: 3, ...EUR }));
    expect(shown.bid).toBe(1.10003);
    expect(shown.ask).toBe(1.10015);
  });

  it('floating spread (S=0) with SB=-3 shifts both sides down 3 points: 1.09997 / 1.10009', () => {
    // bid = 1.10000 - 0.00003 = 1.09997 ; ask = 1.10012 - 0.00003 = 1.10009
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ fixedSpreadPoints: 0, spreadBalancePoints: -3, ...EUR }));
    expect(shown.bid).toBe(1.09997);
    expect(shown.ask).toBe(1.10009);
  });
});

describe('P01 parity: MT5 Layer 2, IMTConGroupSymbol SpreadDiff (D) and SpreadDiffBalance (B)', () => {
  it('D=4, B=-1: -3 Bid / +1 Ask (help example: balance -1)', () => {
    // total 4 (tick == point, D >= 0): askPts = floor(4/2) + B = 1 ; bidPts = 4 - 1 = 3
    // bid = 1.10000 - 3P = 1.09997 ; ask = 1.10012 + 1P = 1.10013
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadDiffPoints: 4, spreadDiffBalancePoints: -1, ...EUR }));
    expect(shown.bid).toBe(1.09997);
    expect(shown.ask).toBe(1.10013);
  });

  it('D=4, B=+1: -1 Bid / +3 Ask', () => {
    // askPts = 2 + 1 = 3 ; bidPts = 4 - 3 = 1 ; bid = 1.09999 ; ask = 1.10015
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadDiffPoints: 4, spreadDiffBalancePoints: 1, ...EUR }));
    expect(shown.bid).toBe(1.09999);
    expect(shown.ask).toBe(1.10015);
  });

  it('D=3, B=0: the odd point goes to Bid (-2 / +1)', () => {
    // askPts = floor(3/2) = 1 ; bidPts = 3 - 1 = 2 ; bid = 1.10000 - 0.00002 = 1.09998 ; ask = 1.10012 + 0.00001 = 1.10013
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadDiffPoints: 3, spreadDiffBalancePoints: 0, ...EUR }));
    expect(shown.bid).toBe(1.09998);
    expect(shown.ask).toBe(1.10013);
  });

  it('D=-3, B=0: narrowing, +2 Bid / -1 Ask', () => {
    // D < 0: bidPts = D - Int(D/2) + B = -3 - (-1) + 0 = -2 ; askPts = D - bidPts = -1
    // bid = 1.10000 + 2P = 1.10002 ; ask = 1.10012 - 1P = 1.10011
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadDiffPoints: -3, spreadDiffBalancePoints: 0, ...EUR }));
    expect(shown.bid).toBe(1.10002);
    expect(shown.ask).toBe(1.10011);
  });

  it('D=-4, B=+1: the balance sign reverses for negative D (+1 Bid / -3 Ask)', () => {
    // bidPts = -4 - (-2) + 1 = -1 ; askPts = -4 - (-1) = -3
    // bid = 1.10000 + 1P = 1.10001 ; ask = 1.10012 - 3P = 1.10009
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadDiffPoints: -4, spreadDiffBalancePoints: 1, ...EUR }));
    expect(shown.bid).toBe(1.10001);
    expect(shown.ask).toBe(1.10009);
  });

  it('D=0, B=+2: balance alone shifts both sides up 2 points, width unchanged (spec D >= 0 branch)', () => {
    // bidPts = 0 - 0 - 2 = -2 ; askPts = 2 ; bid = 1.10000 + 2P = 1.10002 ; ask = 1.10012 + 2P = 1.10014 (width 12 points)
    // The MT5 help does not define D = 0; this follows the spec / backend (balance-only extension, spread_markup.go:112-113).
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadDiffPoints: 0, spreadDiffBalancePoints: 2, ...EUR }));
    expect(shown.bid).toBe(1.10002);
    expect(shown.ask).toBe(1.10014);
  });

  it('crossing narrowing (m=5, D=-20): the combined shift would cross, so the base quote is kept', () => {
    // legacy m=5: bidDelta +3P, askDelta +2P. SDK D=-20: bidPts = -20 - (-10) = -10 -> -10P ; askPts = -10 -> -10P
    // sum: bid' = 1.10000 - (3P - 10P) = 1.10007 ; ask' = 1.10012 + (2P - 10P) = 1.10004 ; bid' > ask' -> keep 1.10000 / 1.10012
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 5, spreadDiffPoints: -20, ...EUR }));
    expect(shown.bid).toBe(1.1);
    expect(shown.ask).toBe(1.10012);
  });
});

describe('P01 parity: combined legacy markup and MT5 shaping (backend approvedGroupSpreadDeltas)', () => {
  it('m=3 with D=1 and tick == point: one total of 4 split -2 / +2 (not two odd remainders on Bid)', () => {
    // total = 3 + 1 = 4 ; askPts = 2 ; bidPts = 2 ; bid = 1.09998 ; ask = 1.10014
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 3, spreadDiffPoints: 1, ...EUR }));
    expect(shown.bid).toBe(1.09998);
    expect(shown.ask).toBe(1.10014);
  });

  it('m=5 with D=3 and tick == point: one total of 8 split -4 / +4', () => {
    // total = 5 + 3 = 8 ; askPts = 4 ; bidPts = 4 ; bid = 1.10000 - 0.00004 = 1.09996 ; ask = 1.10012 + 0.00004 = 1.10016
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 5, spreadDiffPoints: 3, ...EUR }));
    expect(shown.bid).toBe(1.09996);
    expect(shown.ask).toBe(1.10016);
  });

  it('m=5 with negative D=-3: the legacy split and the SDK split are summed before the fallback', () => {
    // legacy m=5: bidDelta 3P (down), askDelta 2P (up). SDK D=-3: bidPts -2 -> bidDelta -2P ; askPts -1 -> askDelta -1P
    // total: bid = 1.10000 - (3P - 2P) = 1.09999 ; ask = 1.10012 + (2P - 1P) = 1.10013 (width 14 points)
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 5, spreadDiffPoints: -3, ...EUR }));
    expect(shown.bid).toBe(1.09999);
    expect(shown.ask).toBe(1.10013);
  });

  it('S=10, SB=0 with D=3: Layer 1 re-centres first, then Layer 2 (-2 Bid / +1 Ask)', () => {
    // Layer 1 on raw 1.10000 / 1.10004 -> 1.09997 / 1.10007 ; Layer 2 total 3: askPts 1, bidPts 2
    // bid = 1.09997 - 0.00002 = 1.09995 ; ask = 1.10007 + 0.00001 = 1.10008
    const shown = applySpreadMarkupToQuote(
      { bid: 1.1, ask: 1.10004 },
      entryOf({ fixedSpreadPoints: 10, spreadBalancePoints: 0, spreadDiffPoints: 3, spreadDiffBalancePoints: 0, ...EUR }),
    );
    expect(shown.bid).toBe(1.09995);
    expect(shown.ask).toBe(1.10008);
  });

  it('US30 (digits 1, Point 0.1, tick 0.5): legacy and SDK splits stay separate (m=3, D=2, B=0)', () => {
    // legacy m=3 on tick 0.5: askPts 1 -> +0.5 ; bidPts 2 -> -1.0 ; SDK D=2 on Point 0.1: bidPts 1 -> -0.1 ; askPts 1 -> +0.1
    // bid = 40000.0 - 1.0 - 0.1 = 39998.9 ; ask = 40002.0 + 0.5 + 0.1 = 40002.6
    const shown = applySpreadMarkupToQuote(
      { bid: 40000, ask: 40002 },
      entryOf({ spreadMarkup: 3, spreadDiffPoints: 2, spreadDiffBalancePoints: 0, tickSize: 0.5, digits: 1 }),
    );
    expect(shown.bid).toBe(39998.9);
    expect(shown.ask).toBe(40002.6);
  });
});

describe('P01 parity: Market Watch Details offsets are per side and signed', () => {
  it('m=5: bid offset 0.00003 and ask offset 0.00002 (not 0.00005 on both sides)', () => {
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadMarkup: 5, ...EUR }));
    expect(getQuoteBidMarkupOffset(shown)).toBe(0.00003);
    expect(getQuoteAskMarkupOffset(shown)).toBe(0.00002);
  });

  it('negative SpreadDiff D=-3: signed bid offset -0.00002 and ask offset -0.00001', () => {
    // shown bid 1.10002 -> rawBid - bid = -0.00002 ; shown ask 1.10011 -> ask - rawAsk = -0.00001
    const shown = applySpreadMarkupToQuote(raw(), entryOf({ spreadDiffPoints: -3, spreadDiffBalancePoints: 0, ...EUR }));
    expect(getQuoteBidMarkupOffset(shown)).toBe(-0.00002);
    expect(getQuoteAskMarkupOffset(shown)).toBe(-0.00001);
  });
});

describe('P01 parity: catalogue markup map', () => {
  it('a row whose only active fields are MT5 shaping (spread_markup 0) is mapped', () => {
    const map = mapOf({ symbol: 'eurusd', spreadMarkup: 0, fixedSpreadPoints: 10, tickSize: 0.00001, digits: 5 });
    expect(map.has('EURUSD')).toBe(true);
  });

  it('authenticated rows carry all MT5 fields; public catalogue markup and shaping are never used', () => {
    const authorized = [normalizeInstrument({
      symbol: 'EURUSD',
      digits: 5,
      tick_size: 0.00001,
      spread_markup: 5,
      fixed_spread_points: 10,
      spread_balance_points: -2,
      spread_diff_points: 3,
      spread_diff_balance_points: 1,
    })!];
    const publicUniverse = [normalizeInstrument({
      symbol: 'EURUSD',
      digits: 5,
      tick_size: 0.00001,
      spread_markup: 9,
      fixed_spread_points: 4,
      spread_diff_points: -7,
    })!];
    const map = buildAccountSpreadMarkupMap(authorized, publicUniverse);
    expect(map.get('EURUSD')).toMatchObject({
      points: 5,
      tickSize: 0.00001,
      digits: 5,
      fixedSpreadPoints: 10,
      spreadBalancePoints: -2,
      spreadDiffPoints: 3,
      spreadDiffBalancePoints: 1,
    });
  });

  it('guard: public catalogue markup is ignored when the account row has none', () => {
    const authorized = [normalizeInstrument({ symbol: 'EURUSD', digits: 5, tick_size: 0.00001 })!];
    const publicUniverse = [normalizeInstrument({
      symbol: 'EURUSD',
      digits: 5,
      tick_size: 0.00001,
      spread_markup: 9,
      fixed_spread_points: 4,
    })!];
    expect(buildAccountSpreadMarkupMap(authorized, publicUniverse).has('EURUSD')).toBe(false);
  });
});

describe('P01 parity: helper names from the spec (missing until implemented, TypeError expected today)', () => {
  it('split helpers: ask floor(m/2), bid m - floor(m/2), both 0 for m <= 0', () => {
    expect(newApi.getSpreadMarkupAskPoints(5)).toBe(2);
    expect(newApi.getSpreadMarkupBidPoints(5)).toBe(3);
    expect(newApi.getSpreadMarkupAskPoints(7)).toBe(3);
    expect(newApi.getSpreadMarkupBidPoints(7)).toBe(4);
    expect(newApi.getSpreadMarkupAskPoints(1)).toBe(0);
    expect(newApi.getSpreadMarkupBidPoints(1)).toBe(1);
    expect(newApi.getSpreadMarkupAskPoints(-5)).toBe(0);
    expect(newApi.getSpreadMarkupBidPoints(-5)).toBe(0);
    expect(newApi.getSpreadMarkupAskPoints(2147483647)).toBe(1073741823);
    expect(newApi.getSpreadMarkupBidPoints(2147483647)).toBe(1073741824);
  });

  it('computeSdkSpreadDiffPoints follows IMTConGroupSymbol::SpreadDiffBalance (help: D=4, B=-1 -> -3 / +1)', () => {
    expect(newApi.computeSdkSpreadDiffPoints(4, -1)).toEqual({ bidPoints: 3, askPoints: 1 });
    expect(newApi.computeSdkSpreadDiffPoints(4, 1)).toEqual({ bidPoints: 1, askPoints: 3 });
    expect(newApi.computeSdkSpreadDiffPoints(3, 0)).toEqual({ bidPoints: 2, askPoints: 1 });
    expect(newApi.computeSdkSpreadDiffPoints(5, 0)).toEqual({ bidPoints: 3, askPoints: 2 });
    expect(newApi.computeSdkSpreadDiffPoints(-3, 0)).toEqual({ bidPoints: -2, askPoints: -1 });
    expect(newApi.computeSdkSpreadDiffPoints(-4, 1)).toEqual({ bidPoints: -1, askPoints: -3 });
  });

  it('getSpreadMarkupSideOffsets gives per-side price deltas (bid subtracts bidOffset, ask adds askOffset)', () => {
    const m5 = newApi.getSpreadMarkupSideOffsets(entryOf({ spreadMarkup: 5, ...EUR })) as { bidOffset: number; askOffset: number };
    expect(m5.bidOffset).toBeCloseTo(0.00003, 10);
    expect(m5.askOffset).toBeCloseTo(0.00002, 10);
    const d4 = newApi.getSpreadMarkupSideOffsets(
      entryOf({ spreadDiffPoints: 4, spreadDiffBalancePoints: -1, ...EUR }),
    ) as { bidOffset: number; askOffset: number };
    expect(d4.bidOffset).toBeCloseTo(0.00003, 10);
    expect(d4.askOffset).toBeCloseTo(0.00001, 10);
    const dNeg3 = newApi.getSpreadMarkupSideOffsets(
      entryOf({ spreadDiffPoints: -3, spreadDiffBalancePoints: 0, ...EUR }),
    ) as { bidOffset: number; askOffset: number };
    expect(dNeg3.bidOffset).toBeCloseTo(-0.00002, 10);
    expect(dNeg3.askOffset).toBeCloseTo(-0.00001, 10);
  });

  it('MT5 readers: signed values clamp to [-2147483647, 2147483647]; non-negative values clamp to [0, 2147483647]', () => {
    const signedKeys = ['spread_balance_points', 'spreadBalancePoints'];
    const nonNegKeys = ['fixed_spread_points', 'fixedSpreadPoints'];
    expect(newApi.readSignedSpreadPoints({ spread_balance_points: -3 }, signedKeys)).toBe(-3);
    expect(newApi.readSignedSpreadPoints({ spreadBalancePoints: 3e9 }, signedKeys)).toBe(2147483647);
    expect(newApi.readSignedSpreadPoints({ spread_balance_points: -3e9 }, signedKeys)).toBe(-2147483647);
    expect(newApi.readNonNegativeSpreadPoints({ fixed_spread_points: -4 }, nonNegKeys)).toBe(0);
    expect(newApi.readNonNegativeSpreadPoints({ fixedSpreadPoints: 10 }, nonNegKeys)).toBe(10);
    expect(newApi.readNonNegativeSpreadPoints({ fixed_spread_points: 3e9 }, nonNegKeys)).toBe(2147483647);
  });
});
