import { describe, expect, it } from 'vitest';
import {
  buildClosedTradeHistorySnapshots,
  type TradeOverlayHistoryRow,
} from './tradeOverlayHistory';

const mapTimestamp = (value: unknown): number => {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') {
    return numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
};

const build = (rows: TradeOverlayHistoryRow[]) =>
  buildClosedTradeHistorySnapshots({
    rows,
    symbol: 'EURUSD',
    mapTimestamp,
  });

const assertNegativeClosingExcluded = (negRow: TradeOverlayHistoryRow) => {
  expect(build([
    {
      historySource: 'deal',
      positionId: 6400,
      dealTicket: 3081,
      symbol: 'EURUSD',
      entry: 'entry_in',
      side: 'BUY',
      volume: 0.3,
      price: 1.1,
      time: 1760000000,
    },
    negRow,
  ])).toEqual([]);

  const partialSnapshots = build([
    {
      historySource: 'deal',
      positionId: 6401,
      dealTicket: 3091,
      symbol: 'EURUSD',
      entry: 'entry_in',
      side: 'BUY',
      volume: 0.5,
      price: 1.1,
      time: 1760000000,
    },
    {
      historySource: 'deal',
      positionId: 6401,
      dealTicket: 3092,
      symbol: 'EURUSD',
      entry: 'entry_out',
      side: 'SELL',
      volume: 0.2,
      price: 1.102,
      profit: 4,
      time: 1760000200,
    },
    {
      ...negRow,
      positionId: 6401,
      dealTicket: 3093,
    },
  ]);

  expect(partialSnapshots).toHaveLength(1);
  expect(partialSnapshots[0]).toMatchObject({
    key: 'trade:6401',
    volume: 0.2,
  });
};

describe('tradeOverlayHistory P14-A round 2 (L1 negative entries)', () => {
  it.each(['in_by', ' IN_BY '])(
    'does not count negative deal entry %j as a closing deal',
    (negEntry) => {
      assertNegativeClosingExcluded({
        historySource: 'deal',
        positionId: 6400,
        dealTicket: 3082,
        symbol: 'EURUSD',
        entry: negEntry,
        side: 'SELL',
        volume: 0.3,
        price: 1.105,
        profit: 15,
        time: 1760000300,
      });
    },
  );

  it.each(['in_by', ' IN_BY '])(
    'does not count negative type fallback %j as a closing deal when entry is omitted',
    (negType) => {
      assertNegativeClosingExcluded({
        historySource: 'deal',
        positionId: 6400,
        dealTicket: 3082,
        symbol: 'EURUSD',
        type: negType,
        side: 'SELL',
        volume: 0.3,
        price: 1.105,
        profit: 15,
        time: 1760000300,
      });
    },
  );
});
