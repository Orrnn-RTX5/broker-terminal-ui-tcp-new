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

describe('tradeOverlayHistory P14-A MT5 deal entry classification', () => {
  it.each<[string | number, string | number]>([
    ['entry_in', 'entry_out'],
    ['0', '1'],
    [0, 1],
    ['entry_in', 'out'],
    ['entry_in', '3'],
    [0, 3],
  ])('builds a closed snapshot for standard MT5 out-deal (%j -> %j)', (openEntry, closeEntry) => {
    expect(build([
      {
        historySource: 'deal',
        positionId: 6100,
        dealTicket: 3001,
        symbol: 'EURUSD',
        entry: openEntry,
        side: 'BUY',
        volume: 0.25,
        price: 1.1,
        time: 1760000000,
      },
      {
        historySource: 'deal',
        positionId: 6100,
        dealTicket: 3002,
        symbol: 'EURUSD',
        entry: closeEntry,
        side: 'SELL',
        volume: 0.25,
        price: 1.105,
        profit: 12.5,
        time: 1760000300,
      },
    ])).toEqual([
      expect.objectContaining({
        key: 'trade:6100',
        symbol: 'EURUSD',
        side: 'BUY',
        volume: 0.25,
        entryPrice: 1.1,
        entryTime: 1760000000,
        exitPrice: 1.105,
        exitTime: 1760000300,
        profit: 12.5,
        source: 'mt5-history',
      }),
    ]);
  });

  it.each<[string, string]>([
    ['entry_in', 'entry_out_by'],
    ['0', 'entry_out_by'],
    ['entry_in', 'out_by'],
    ['entry_in', ' ENTRY_OUT_BY '],
    ['entry_in', ' Out_By '],
  ])('builds a closed snapshot for close-by out-deal (%j -> %j)', (openEntry, closeEntry) => {
    expect(build([
      {
        historySource: 'deal',
        positionId: 6100,
        dealTicket: 3011,
        symbol: 'EURUSD',
        entry: openEntry,
        side: 'BUY',
        volume: 0.25,
        price: 1.1,
        time: 1760000000,
      },
      {
        historySource: 'deal',
        positionId: 6100,
        dealTicket: 3012,
        symbol: 'EURUSD',
        entry: closeEntry,
        side: 'SELL',
        volume: 0.25,
        price: 1.105,
        profit: 12.5,
        time: 1760000300,
      },
    ])).toEqual([
      expect.objectContaining({
        key: 'trade:6100',
        symbol: 'EURUSD',
        side: 'BUY',
        volume: 0.25,
        entryPrice: 1.1,
        entryTime: 1760000000,
        exitPrice: 1.105,
        exitTime: 1760000300,
        profit: 12.5,
        source: 'mt5-history',
      }),
    ]);
  });

  it.each(['entry_out_by', 'out_by'])('falls back to row.type %j when row.entry is omitted', (closeType) => {
    expect(build([
      {
        historySource: 'deal',
        positionId: 6150,
        dealTicket: 3021,
        symbol: 'EURUSD',
        type: 'entry_in',
        side: 'BUY',
        volume: 0.25,
        price: 1.1,
        time: 1760000000,
      },
      {
        historySource: 'deal',
        positionId: 6150,
        dealTicket: 3022,
        symbol: 'EURUSD',
        type: closeType,
        side: 'SELL',
        volume: 0.25,
        price: 1.105,
        profit: 12.5,
        time: 1760000300,
      },
    ])).toEqual([
      expect.objectContaining({
        key: 'trade:6150',
        entryPrice: 1.1,
        exitPrice: 1.105,
        volume: 0.25,
        source: 'mt5-history',
      }),
    ]);
  });

  it.each<string | number>(['entry_inout', '2', 2, 'inout'])('builds closed snapshots for MT5 reversal deal %j', (inOutEntry) => {
    expect(build([
      {
        historySource: 'deal',
        positionId: 6180,
        dealTicket: 3031,
        symbol: 'EURUSD',
        entry: 'entry_in',
        side: 'BUY',
        volume: 0.3,
        price: 1.1,
        time: 1760000000,
      },
      {
        historySource: 'deal',
        positionId: 6180,
        dealTicket: 3032,
        symbol: 'EURUSD',
        entry: inOutEntry,
        side: 'SELL',
        volume: 0.3,
        price: 1.104,
        profit: 12,
        time: 1760000300,
      },
    ])).toEqual([
      expect.objectContaining({
        key: 'trade:6180',
        entryPrice: 1.1,
        exitPrice: 1.104,
        volume: 0.3,
        source: 'mt5-history',
      }),
    ]);

    expect(build([
      {
        historySource: 'deal',
        positionId: 6181,
        dealTicket: 3033,
        symbol: 'EURUSD',
        entry: inOutEntry,
        side: 'SELL',
        volume: 0.3,
        price: 1.104,
        profit: 12,
        time: 1760000300,
      },
    ])).toEqual([
      expect.objectContaining({
        key: 'trade:6181',
        entryPrice: 1.104,
        exitPrice: 1.104,
        volume: 0.3,
        source: 'mt5-history',
      }),
    ]);
  });

  it.each(['entry_out_by', 'out_by'])('sums partial exit volumes across entry_out and %j', (closeByEntry) => {
    const snapshots = build([
      {
        historySource: 'deal',
        positionId: 6190,
        dealTicket: 3041,
        symbol: 'EURUSD',
        entry: 'entry_in',
        side: 'BUY',
        volume: 0.5,
        price: 1.1,
        time: 1760000000,
      },
      {
        historySource: 'deal',
        positionId: 6190,
        dealTicket: 3042,
        symbol: 'EURUSD',
        entry: 'entry_out',
        side: 'SELL',
        volume: 0.2,
        price: 1.102,
        profit: 4,
        time: 1760000200,
      },
      {
        historySource: 'deal',
        positionId: 6190,
        dealTicket: 3043,
        symbol: 'EURUSD',
        entry: closeByEntry,
        side: 'SELL',
        volume: 0.3,
        price: 1.105,
        profit: 15,
        time: 1760000400,
      },
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      key: 'trade:6190',
      exitPrice: 1.105,
      exitTime: 1760000400,
      profit: 19,
      source: 'mt5-history',
    });
    expect(snapshots[0].volume).toBeCloseTo(0.5, 8);
  });

  it('builds closed snapshots for both legs of a two-leg MT5 close-by pair', () => {
    const snapshots = build([
      {
        historySource: 'deal',
        positionId: 6201,
        dealTicket: 3051,
        symbol: 'EURUSD',
        entry: 'entry_in',
        side: 'BUY',
        volume: 0.4,
        price: 1.1,
        time: 1760000000,
      },
      {
        historySource: 'deal',
        positionId: 6202,
        dealTicket: 3052,
        symbol: 'EURUSD',
        entry: 'entry_in',
        side: 'SELL',
        volume: 0.4,
        price: 1.105,
        time: 1760000100,
      },
      {
        historySource: 'deal',
        positionId: 6201,
        dealTicket: 3053,
        symbol: 'EURUSD',
        entry: 'entry_out_by',
        side: 'SELL',
        volume: 0.4,
        price: 1.105,
        profit: 20,
        time: 1760000300,
      },
      {
        historySource: 'deal',
        positionId: 6202,
        dealTicket: 3054,
        symbol: 'EURUSD',
        entry: 'out_by',
        side: 'BUY',
        volume: 0.4,
        price: 1.105,
        profit: 0,
        time: 1760000300,
      },
    ]);

    expect(snapshots).toHaveLength(2);
    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'trade:6201', side: 'BUY', volume: 0.4, source: 'mt5-history' }),
      expect.objectContaining({ key: 'trade:6202', side: 'SELL', volume: 0.4, source: 'mt5-history' }),
    ]));
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
  ])('does not count negative deal entry %j as a closing deal', (negEntry) => {
    const negRow: TradeOverlayHistoryRow = {
      historySource: 'deal',
      positionId: 6300,
      dealTicket: 3062,
      symbol: 'EURUSD',
      ...(negEntry === undefined ? {} : { entry: negEntry }),
      side: 'SELL',
      volume: 0.3,
      price: 1.105,
      profit: 15,
      time: 1760000300,
    };

    expect(build([
      {
        historySource: 'deal',
        positionId: 6300,
        dealTicket: 3061,
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
        positionId: 6301,
        dealTicket: 3071,
        symbol: 'EURUSD',
        entry: 'entry_in',
        side: 'BUY',
        volume: 0.5,
        price: 1.1,
        time: 1760000000,
      },
      {
        historySource: 'deal',
        positionId: 6301,
        dealTicket: 3072,
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
        positionId: 6301,
        dealTicket: 3073,
      },
    ]);

    expect(partialSnapshots).toHaveLength(1);
    expect(partialSnapshots[0].volume).toBe(0.2);
  });
});
