import { describe, expect, it } from 'vitest';
import type { Trade } from '../store/useAppStore';
import {
  buildClosedPositionHistory,
  collapseDealHistory,
  collapseTruncatedDealWindow,
  normalizeDeal,
} from './tradeGateway';

const makeUnequalCloseByPair = (closeByEntry: 'entry_out_by' | 'out_by'): Trade[] => [
  normalizeDeal({
    deal: 3101,
    position_ticket: 5501,
    symbol: 'EURUSD',
    action: 'buy',
    entry: 'entry_in',
    volume: 1.0,
    price: 1.1,
    time: 1760000000,
  }),
  normalizeDeal({
    deal: 3102,
    position_ticket: 5502,
    symbol: 'EURUSD',
    action: 'sell',
    entry: 'entry_in',
    volume: 0.4,
    price: 1.105,
    time: 1760000100,
  }),
  normalizeDeal({
    deal: 3103,
    position_ticket: 5501,
    symbol: 'EURUSD',
    action: 'sell',
    entry: closeByEntry,
    volume: 0.4,
    price: 1.105,
    profit: 20,
    time: 1760000300,
  }),
  normalizeDeal({
    deal: 3104,
    position_ticket: 5502,
    symbol: 'EURUSD',
    action: 'buy',
    entry: closeByEntry,
    volume: 0.4,
    price: 1.105,
    profit: 0,
    time: 1760000300,
  }),
];

const makeUnkeyedCloseByDeals = () => {
  const openA = normalizeDeal({
    ticket: 4101,
    symbol: 'EURUSD',
    action: 'buy',
    entry: 'entry_in',
    volume: 0.4,
    price: 1.1,
    time: 1760000000,
  });
  const openB = normalizeDeal({
    ticket: 4102,
    symbol: 'EURUSD',
    action: 'sell',
    entry: 'entry_in',
    volume: 0.4,
    price: 1.105,
    time: 1760000100,
  });
  const closeA = normalizeDeal({
    ticket: 4103,
    symbol: 'EURUSD',
    action: 'sell',
    entry: 'entry_out_by',
    volume: 0.4,
    price: 1.105,
    profit: 20,
    time: 1760000300,
  });
  const closeB = normalizeDeal({
    ticket: 4104,
    symbol: 'EURUSD',
    action: 'buy',
    entry: 'out_by',
    volume: 0.4,
    price: 1.105,
    profit: 0,
    time: 1760000300,
  });
  return { openA, openB, closeA, closeB };
};

const assertNegativeOutDealExcluded = (negDeal: Trade) => {
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
};

describe('tradeGateway P14-A round 2 (L1/L2 test gaps)', () => {
  it.each(['in_by', ' IN_BY '])(
    'does not count negative deal entry %j as an out-deal',
    (negEntry) => {
      const negDeal = normalizeDeal({
        deal: 1502,
        position_ticket: 5400,
        symbol: 'EURUSD',
        action: 'sell',
        entry: negEntry,
        volume: 0.3,
        price: 1.105,
        profit: 15,
        time: 1760000300,
      });

      assertNegativeOutDealExcluded(negDeal);
    },
  );

  it.each(['in_by', ' IN_BY '])(
    'does not count negative type fallback %j as an out-deal when entry is omitted',
    (negType) => {
      const negDeal: Trade = {
        ...normalizeDeal({
          deal: 1502,
          position_ticket: 5400,
          symbol: 'EURUSD',
          action: 'sell',
          volume: 0.3,
          price: 1.105,
          profit: 15,
          time: 1760000300,
        }),
        entry: undefined,
        type: negType,
      };

      assertNegativeOutDealExcluded(negDeal);
    },
  );

  it.each(['entry_out_by', 'out_by'] as const)(
    'builds partially closed larger leg (0.4) and fully closed smaller leg (0.4) for unequal close-by %j',
    (closeByEntry) => {
      const history = buildClosedPositionHistory([], makeUnequalCloseByPair(closeByEntry), 100001);
      expect(history).toHaveLength(2);
      expect(history).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 5501,
          side: 'BUY',
          type: 'closed',
          status: 'closed',
          volume: 0.4,
          openPrice: 1.1,
          closePrice: 1.105,
          profit: 20,
          historySource: 'deal',
        }),
        expect.objectContaining({
          id: 5502,
          side: 'SELL',
          type: 'closed',
          status: 'closed',
          volume: 0.4,
          openPrice: 1.105,
          closePrice: 1.105,
          profit: 0,
          historySource: 'deal',
        }),
      ]));
    },
  );

  it.each(['entry_out_by', 'out_by'] as const)(
    'marks larger unequal close-by leg unverified and smaller leg safe for %j',
    (closeByEntry) => {
      const result = collapseTruncatedDealWindow(makeUnequalCloseByPair(closeByEntry));
      expect(result.safe).toEqual([
        expect.objectContaining({
          id: 5502,
          side: 'SELL',
          type: 'closed',
          status: 'closed',
          volume: 0.4,
          openPrice: 1.105,
          closePrice: 1.105,
          profit: 0,
          historySource: 'deal',
        }),
      ]);
      expect(result.unverified).toEqual([
        expect.objectContaining({
          id: 5501,
          side: 'BUY',
          type: 'closed',
          status: 'closed',
          volume: 0.4,
          openPrice: 1.1,
          closePrice: 1.105,
          profit: 20,
          historySource: 'deal',
        }),
      ]);
    },
  );

  it.each<['AB' | 'BA']>(['AB', 'BA'])(
    'pairs each unkeyed close-by exit at the same timestamp with its opposite-side opening without double use (exit order %s)',
    (exitOrder) => {
      const { openA, openB, closeA, closeB } = makeUnkeyedCloseByDeals();
      const deals = exitOrder === 'AB'
        ? [openA, openB, closeA, closeB]
        : [openA, openB, closeB, closeA];

      const expected = [
        expect.objectContaining({
          id: 4101,
          side: 'BUY',
          type: 'closed',
          status: 'closed',
          volume: 0.4,
          openPrice: 1.1,
          closePrice: 1.105,
          profit: 20,
          historySource: 'deal',
        }),
        expect.objectContaining({
          id: 4102,
          side: 'SELL',
          type: 'closed',
          status: 'closed',
          volume: 0.4,
          openPrice: 1.105,
          closePrice: 1.105,
          profit: 0,
          historySource: 'deal',
        }),
      ];

      for (const rows of [
        collapseDealHistory(deals),
        buildClosedPositionHistory([], deals, 100001),
      ]) {
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.id).sort((a, b) => a - b)).toEqual([4101, 4102]);
        expect(rows).toEqual(expect.arrayContaining(expected));
      }
    },
  );

  it('does not reuse a consumed unkeyed opening deal for an extra same-timestamp close-by exit', () => {
    const { openA, openB, closeA, closeB } = makeUnkeyedCloseByDeals();
    const extraCloseSell = normalizeDeal({
      ticket: 4105,
      symbol: 'EURUSD',
      action: 'sell',
      entry: 'entry_out_by',
      volume: 0.4,
      price: 1.106,
      profit: 24,
      time: 1760000300,
    });

    const collapsed = collapseDealHistory([openA, openB, closeA, closeB, extraCloseSell]);
    expect(collapsed).toHaveLength(3);
    expect(collapsed.filter((row) => row.id === 4101)).toHaveLength(1);
    expect(collapsed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 4101,
        side: 'BUY',
        type: 'closed',
        status: 'closed',
        volume: 0.4,
        openPrice: 1.1,
        closePrice: 1.105,
        profit: 20,
        historySource: 'deal',
      }),
      expect.objectContaining({
        id: 4102,
        side: 'SELL',
        type: 'closed',
        status: 'closed',
        volume: 0.4,
        openPrice: 1.105,
        closePrice: 1.105,
        profit: 0,
        historySource: 'deal',
      }),
      expect.objectContaining({
        id: 4105,
        side: 'SELL',
        status: 'closed',
        openPrice: 1.106,
        closePrice: 1.106,
        profit: 24,
        historySource: 'deal',
      }),
    ]));
  });
});
