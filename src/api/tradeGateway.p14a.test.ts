import { describe, expect, it } from 'vitest';
import type { Trade } from '../store/useAppStore';
import {
  buildClosedPositionHistory,
  collapseDealHistory,
  collapseTruncatedDealWindow,
  normalizeDeal,
} from './tradeGateway';

const makeNegTrade = (negEntry: string | number | undefined, dealTicket = 1502, positionId = 5400): Trade => {
  if (negEntry === '' || negEntry === undefined) {
    return {
      ...normalizeDeal({
        deal: dealTicket,
        position_ticket: positionId,
        symbol: 'EURUSD',
        action: 'sell',
        volume: 0.3,
        price: 1.105,
        profit: 15,
        time: 1760000300,
      }),
      entry: negEntry,
      type: '',
    };
  }

  return normalizeDeal({
    deal: dealTicket,
    position_ticket: positionId,
    symbol: 'EURUSD',
    action: 'sell',
    entry: negEntry,
    volume: 0.3,
    price: 1.105,
    profit: 15,
    time: 1760000300,
  });
};

describe('tradeGateway P14-A MT5 deal entry classification', () => {
  it.each<[string | number, string | number]>([
    ['entry_in', 'entry_out'],
    ['0', '1'],
    [0, 1],
    ['entry_in', 'out'],
    ['entry_in', '3'],
    [0, 3],
  ])('pairs standard MT5 out-deal (%j -> %j) with opening deal', (openEntry, closeEntry) => {
    const open = normalizeDeal({
      deal: 1001,
      position_ticket: 5100,
      symbol: 'EURUSD',
      action: 'buy',
      entry: openEntry,
      volume: 0.25,
      price: 1.1,
      time: 1760000000,
    });
    const close = normalizeDeal({
      deal: 1002,
      position_ticket: 5100,
      symbol: 'EURUSD',
      action: 'sell',
      entry: closeEntry,
      volume: 0.25,
      price: 1.105,
      profit: 12.5,
      time: 1760000300,
    });

    const expected = [
      expect.objectContaining({
        id: 5100,
        symbol: 'EURUSD',
        type: 'closed',
        status: 'closed',
        side: 'BUY',
        volume: 0.25,
        openPrice: 1.1,
        closePrice: 1.105,
        profit: 12.5,
        historySource: 'deal',
      }),
    ];

    expect(collapseDealHistory([open, close])).toEqual(expected);
    expect(buildClosedPositionHistory([], [open, close], 100001)).toEqual(expected);
  });

  it.each<[string, string]>([
    ['entry_in', 'entry_out_by'],
    ['0', 'entry_out_by'],
    ['entry_in', 'out_by'],
    ['entry_in', ' ENTRY_OUT_BY '],
    ['entry_in', ' Out_By '],
  ])('pairs close-by out-deal (%j -> %j) with opening deal', (openEntry, closeEntry) => {
    const open = normalizeDeal({
      deal: 1011,
      position_ticket: 5100,
      symbol: 'EURUSD',
      action: 'buy',
      entry: openEntry,
      volume: 0.25,
      price: 1.1,
      time: 1760000000,
    });
    const close = normalizeDeal({
      deal: 1012,
      position_ticket: 5100,
      symbol: 'EURUSD',
      action: 'sell',
      entry: closeEntry,
      volume: 0.25,
      price: 1.105,
      profit: 12.5,
      time: 1760000300,
    });

    const expected = [
      expect.objectContaining({
        id: 5100,
        symbol: 'EURUSD',
        type: 'closed',
        status: 'closed',
        side: 'BUY',
        volume: 0.25,
        openPrice: 1.1,
        closePrice: 1.105,
        profit: 12.5,
        historySource: 'deal',
      }),
    ];

    expect(collapseDealHistory([open, close])).toEqual(expected);
    expect(buildClosedPositionHistory([], [open, close], 100001)).toEqual(expected);
  });

  it.each(['entry_out_by', 'out_by'])('falls back to trade.type %j when trade.entry is omitted', (closeType) => {
    const open: Trade = {
      ...normalizeDeal({
        deal: 1101,
        position_ticket: 5150,
        symbol: 'EURUSD',
        action: 'buy',
        volume: 0.25,
        price: 1.1,
        time: 1760000000,
      }),
      entry: undefined,
      type: 'entry_in',
    };
    const close: Trade = {
      ...normalizeDeal({
        deal: 1102,
        position_ticket: 5150,
        symbol: 'EURUSD',
        action: 'sell',
        volume: 0.25,
        price: 1.105,
        profit: 12.5,
        time: 1760000300,
      }),
      entry: undefined,
      type: closeType,
    };

    const expected = [
      expect.objectContaining({
        id: 5150,
        type: 'closed',
        status: 'closed',
        volume: 0.25,
        openPrice: 1.1,
        closePrice: 1.105,
      }),
    ];

    expect(collapseDealHistory([open, close])).toEqual(expected);
    expect(buildClosedPositionHistory([], [open, close], 100001)).toEqual(expected);
  });

  it.each<string | number>(['entry_inout', '2', 2, 'inout'])('classifies MT5 reversal deal %j as closed history', (inOutEntry) => {
    const open = normalizeDeal({
      deal: 1151,
      position_ticket: 5180,
      symbol: 'EURUSD',
      action: 'buy',
      entry: 'entry_in',
      volume: 0.3,
      price: 1.1,
      time: 1760000000,
    });
    const pairedRev = normalizeDeal({
      deal: 1152,
      position_ticket: 5180,
      symbol: 'EURUSD',
      action: 'sell',
      entry: inOutEntry,
      volume: 0.3,
      price: 1.104,
      profit: 12,
      time: 1760000300,
    });

    const pairedExpected = [
      expect.objectContaining({
        id: 5180,
        type: 'closed',
        status: 'closed',
        openPrice: 1.1,
        closePrice: 1.104,
        volume: 0.3,
      }),
    ];

    expect(collapseDealHistory([open, pairedRev])).toEqual(pairedExpected);
    expect(buildClosedPositionHistory([], [open, pairedRev], 100001)).toEqual(pairedExpected);

    const standaloneRev = normalizeDeal({
      deal: 1153,
      position_ticket: 5181,
      symbol: 'EURUSD',
      action: 'sell',
      entry: inOutEntry,
      volume: 0.3,
      price: 1.104,
      profit: 12,
      time: 1760000300,
    });

    const standaloneExpected = [
      expect.objectContaining({
        id: 5181,
        type: 'closed',
        status: 'closed',
      }),
    ];

    expect(collapseDealHistory([standaloneRev])).toEqual(standaloneExpected);
    expect(buildClosedPositionHistory([], [standaloneRev], 100001)).toEqual(standaloneExpected);
  });

  it.each(['entry_out_by', 'out_by'])('accumulates scaled exit combining entry_out and %j', (closeByEntry) => {
    const deals = [
      normalizeDeal({
        deal: 1181,
        position_ticket: 5190,
        symbol: 'EURUSD',
        action: 'buy',
        entry: 'entry_in',
        volume: 0.5,
        price: 1.1,
        time: 1760000000,
      }),
      normalizeDeal({
        deal: 1182,
        position_ticket: 5190,
        symbol: 'EURUSD',
        action: 'sell',
        entry: 'entry_out',
        volume: 0.2,
        price: 1.102,
        profit: 4,
        time: 1760000200,
      }),
      normalizeDeal({
        deal: 1183,
        position_ticket: 5190,
        symbol: 'EURUSD',
        action: 'sell',
        entry: closeByEntry,
        volume: 0.3,
        price: 1.105,
        profit: 15,
        time: 1760000400,
      }),
    ];

    const collapsed = collapseDealHistory(deals);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({
      id: 5190,
      type: 'closed',
      status: 'closed',
      profit: 19,
    });
    expect(collapsed[0].volume).toBeCloseTo(0.5, 8);
    expect(collapsed[0].openPrice).toBeCloseTo(1.1, 8);
    expect(collapsed[0].closePrice).toBeCloseTo(1.1038, 8);
  });

  it('closes both opposite hedging positions in a two-leg close-by pair', () => {
    const deals = [
      normalizeDeal({
        deal: 1191,
        position_ticket: 5201,
        symbol: 'EURUSD',
        action: 'buy',
        entry: 'entry_in',
        volume: 0.4,
        price: 1.1,
        time: 1760000000,
      }),
      normalizeDeal({
        deal: 1192,
        position_ticket: 5202,
        symbol: 'EURUSD',
        action: 'sell',
        entry: 'entry_in',
        volume: 0.4,
        price: 1.105,
        time: 1760000100,
      }),
      normalizeDeal({
        deal: 1193,
        position_ticket: 5201,
        symbol: 'EURUSD',
        action: 'sell',
        entry: 'entry_out_by',
        volume: 0.4,
        price: 1.105,
        profit: 20,
        time: 1760000300,
      }),
      normalizeDeal({
        deal: 1194,
        position_ticket: 5202,
        symbol: 'EURUSD',
        action: 'buy',
        entry: 'out_by',
        volume: 0.4,
        price: 1.105,
        profit: 0,
        time: 1760000300,
      }),
    ];

    const history = buildClosedPositionHistory([], deals, 100001);
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 5201, side: 'BUY', type: 'closed', status: 'closed', volume: 0.4 }),
      expect.objectContaining({ id: 5202, side: 'SELL', type: 'closed', status: 'closed', volume: 0.4 }),
    ]));
  });

  it.each(['entry_out', '1', 'out', '3'])('keeps standalone keyed standard out-deal %j as closed history', (entry) => {
    const deal = normalizeDeal({
      deal: 1201,
      position_ticket: 7001,
      symbol: 'USDJPY',
      action: 'sell',
      entry,
      volume: 0.03,
      price: 156.25,
      profit: 8.5,
      time: 1760003600,
    });

    const expected = [
      expect.objectContaining({
        id: 1201,
        status: 'closed',
        historySource: 'deal',
        closePrice: 156.25,
        profit: 8.5,
      }),
    ];

    expect(collapseDealHistory([deal])).toEqual(expected);
    expect(buildClosedPositionHistory([], [deal], 100001)).toEqual(expected);
  });

  it.each(['entry_out_by', 'out_by'])('keeps standalone keyed close-by out-deal %j as closed history', (entry) => {
    const deal = normalizeDeal({
      deal: 1201,
      position_ticket: 7001,
      symbol: 'USDJPY',
      action: 'sell',
      entry,
      volume: 0.03,
      price: 156.25,
      profit: 8.5,
      time: 1760003600,
    });

    const expected = [
      expect.objectContaining({
        id: 1201,
        status: 'closed',
        historySource: 'deal',
        closePrice: 156.25,
        profit: 8.5,
      }),
    ];

    expect(collapseDealHistory([deal])).toEqual(expected);
    expect(buildClosedPositionHistory([], [deal], 100001)).toEqual(expected);
  });

  it.each(['entry_out', '1', '3'])('pairs unkeyed standard out-deal %j with compatible opening deal', (closeEntry) => {
    const open = normalizeDeal({
      ticket: 1301,
      symbol: 'GBPUSD',
      action: 'buy',
      entry: 'entry_in',
      volume: 0.1,
      price: 1.3398,
      time: 1760000000,
    });
    const close = normalizeDeal({
      ticket: 1302,
      symbol: 'GBPUSD',
      action: 'sell',
      entry: closeEntry,
      volume: 0.1,
      price: 1.3412,
      profit: 14,
      time: 1760000300,
    });

    expect(collapseDealHistory([open, close])).toEqual([
      expect.objectContaining({
        id: open.id,
        type: 'closed',
        status: 'closed',
        openPrice: 1.3398,
        closePrice: 1.3412,
        volume: 0.1,
      }),
    ]);
  });

  it.each(['entry_out_by', 'out_by'])('pairs unkeyed close-by out-deal %j with compatible opening deal', (closeEntry) => {
    const open = normalizeDeal({
      ticket: 1301,
      symbol: 'GBPUSD',
      action: 'buy',
      entry: 'entry_in',
      volume: 0.1,
      price: 1.3398,
      time: 1760000000,
    });
    const close = normalizeDeal({
      ticket: 1302,
      symbol: 'GBPUSD',
      action: 'sell',
      entry: closeEntry,
      volume: 0.1,
      price: 1.3412,
      profit: 14,
      time: 1760000300,
    });

    expect(collapseDealHistory([open, close])).toEqual([
      expect.objectContaining({
        id: open.id,
        type: 'closed',
        status: 'closed',
        openPrice: 1.3398,
        closePrice: 1.3412,
        volume: 0.1,
      }),
    ]);
  });

  it.each(['entry_out_by', 'out_by'])('keeps standalone unkeyed close-by deal %j as closed history', (closeEntry) => {
    const deal = normalizeDeal({
      ticket: 1402,
      symbol: 'USDJPY',
      action: 'sell',
      entry: closeEntry,
      volume: 0.01,
      price: 156.25,
      profit: 0.8,
      time: 1760000300,
    });

    const expected = [
      expect.objectContaining({
        id: 1402,
        status: 'closed',
        historySource: 'deal',
      }),
    ];

    expect(collapseDealHistory([deal])).toEqual(expected);
    expect(buildClosedPositionHistory([], [deal], 100001)).toEqual(expected);
  });

  describe('collapseTruncatedDealWindow', () => {
    it.each(['entry_out', '1', 'out', '3'])('marks balanced standard exit %j as safe', (closeEntry) => {
      const result = collapseTruncatedDealWindow([
        normalizeDeal({
          deal: 2001,
          position_ticket: 5300,
          symbol: 'EURUSD',
          action: 'buy',
          entry: 'entry_in',
          volume: 0.25,
          price: 1.1,
          time: 1760000000,
        }),
        normalizeDeal({
          deal: 2002,
          position_ticket: 5300,
          symbol: 'EURUSD',
          action: 'sell',
          entry: closeEntry,
          volume: 0.25,
          price: 1.105,
          profit: 12.5,
          time: 1760000300,
        }),
      ]);

      expect(result.safe).toEqual([
        expect.objectContaining({
          id: 5300,
          type: 'closed',
          status: 'closed',
          volume: 0.25,
        }),
      ]);
      expect(result.unverified).toEqual([]);
    });

    it.each(['entry_out_by', 'out_by'])('marks balanced close-by exit %j as safe', (closeEntry) => {
      const result = collapseTruncatedDealWindow([
        normalizeDeal({
          deal: 2011,
          position_ticket: 5300,
          symbol: 'EURUSD',
          action: 'buy',
          entry: 'entry_in',
          volume: 0.25,
          price: 1.1,
          time: 1760000000,
        }),
        normalizeDeal({
          deal: 2012,
          position_ticket: 5300,
          symbol: 'EURUSD',
          action: 'sell',
          entry: closeEntry,
          volume: 0.25,
          price: 1.105,
          profit: 12.5,
          time: 1760000300,
        }),
      ]);

      expect(result.safe).toEqual([
        expect.objectContaining({
          id: 5300,
          type: 'closed',
          status: 'closed',
          volume: 0.25,
        }),
      ]);
      expect(result.unverified).toEqual([]);
    });

    it.each(['entry_out_by', 'out_by'])('places partial close-by exit %j in unverified', (closeEntry) => {
      const result = collapseTruncatedDealWindow([
        normalizeDeal({
          deal: 2021,
          position_ticket: 5301,
          symbol: 'EURUSD',
          action: 'buy',
          entry: 'entry_in',
          volume: 1.0,
          price: 1.1,
          time: 1760000000,
        }),
        normalizeDeal({
          deal: 2022,
          position_ticket: 5301,
          symbol: 'EURUSD',
          action: 'sell',
          entry: closeEntry,
          volume: 0.4,
          price: 1.105,
          profit: 20,
          time: 1760000300,
        }),
      ]);

      expect(result.safe).toEqual([]);
      expect(result.unverified).toEqual([
        expect.objectContaining({
          id: 5301,
          type: 'closed',
          status: 'closed',
          volume: 0.4,
        }),
      ]);
    });

    it.each(['entry_out', '3'])('places standalone standard exit %j in unverified', (closeEntry) => {
      const result = collapseTruncatedDealWindow([
        normalizeDeal({
          deal: 2031,
          position_ticket: 5302,
          symbol: 'EURUSD',
          action: 'sell',
          entry: closeEntry,
          volume: 0.25,
          price: 1.105,
          profit: 12.5,
          time: 1760000300,
        }),
      ]);

      expect(result.safe).toEqual([]);
      expect(result.unverified).toEqual([
        expect.objectContaining({
          status: 'closed',
        }),
      ]);
    });

    it.each(['entry_out_by', 'out_by'])('places standalone close-by exit %j in unverified', (closeEntry) => {
      const result = collapseTruncatedDealWindow([
        normalizeDeal({
          deal: 2041,
          position_ticket: 5302,
          symbol: 'EURUSD',
          action: 'sell',
          entry: closeEntry,
          volume: 0.25,
          price: 1.105,
          profit: 12.5,
          time: 1760000300,
        }),
      ]);

      expect(result.safe).toEqual([]);
      expect(result.unverified).toEqual([
        expect.objectContaining({
          status: 'closed',
        }),
      ]);
    });

    it.each(['entry_inout', '2'])('marks standalone reversal %j as safe', (inOutEntry) => {
      const result = collapseTruncatedDealWindow([
        normalizeDeal({
          deal: 2051,
          position_ticket: 5305,
          symbol: 'EURUSD',
          action: 'sell',
          entry: inOutEntry,
          volume: 0.25,
          price: 1.105,
          profit: 12.5,
          time: 1760000300,
        }),
      ]);

      expect(result.safe).toEqual([
        expect.objectContaining({
          id: 5305,
          type: 'closed',
          status: 'closed',
          volume: 0.25,
        }),
      ]);
      expect(result.unverified).toEqual([]);
    });
  });

  it.each<string | number | undefined>([
    'entry_in',
    'in',
    '0',
    0,
    'unknown_entry',
    '',
    undefined,
    'entry_in_by',
    'settled_by',
    'cancel_by',
    'out_by_extra',
  ])('does not count negative deal entry %j as an out-deal', (negEntry) => {
    const openDeal = normalizeDeal({
      deal: 1501,
      position_ticket: 5400,
      symbol: 'EURUSD',
      action: 'buy',
      entry: 'entry_in',
      volume: 0.5,
      price: 1.1,
      time: 1760000000,
    });
    const negDeal = makeNegTrade(negEntry, 1502, 5400);

    expect(buildClosedPositionHistory([], [openDeal, negDeal], 100001)).toEqual([]);
    expect(buildClosedPositionHistory([], [negDeal], 100001)).toEqual([]);

    const partialOutDeal = normalizeDeal({
      deal: 1503,
      position_ticket: 5400,
      symbol: 'EURUSD',
      action: 'sell',
      entry: 'entry_out',
      volume: 0.2,
      price: 1.102,
      profit: 4,
      time: 1760000200,
    });

    const truncated = collapseTruncatedDealWindow([openDeal, partialOutDeal, negDeal]);
    expect(truncated.safe.find((row) => row.id === 5400)).toBeUndefined();
    expect(truncated.unverified).toEqual([
      expect.objectContaining({
        id: 5400,
        type: 'closed',
        status: 'closed',
        volume: 0.2,
      }),
    ]);
  });
});
