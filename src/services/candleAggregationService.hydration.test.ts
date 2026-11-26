import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandleAggregationService, SymbolCandleBuilder, candleAggregationService, type OHLCV } from './candleAggregationService';
import { emitSessionChange } from './brokerSession';

const minute = Math.floor(Date.UTC(2026, 9, 9, 10, 0) / 1000);
const history: OHLCV[] = [
  { time: minute - 60, open: 100, high: 101, low: 99, close: 100, volume: 3, isComplete: true },
  { time: minute, open: 100, high: 102, low: 100, close: 101, volume: 2, isComplete: false },
];

afterEach(() => { candleAggregationService.clearAll(); vi.restoreAllMocks(); });

describe('aggregation handoff to another chart pane', () => {
  it('keeps the live tail and tick deduplication when another pane hydrates an older presentation cache', () => {
    const service = new CandleAggregationService();
    service.loadHistoricalCandles('BTCUSD', 'M1', history);
    const latestTick = { symbol: 'BTCUSD', bid: 105, ask: 106, volume: 4, timestamp: minute + 20 };
    service.processTick(latestTick);
    const before = service.getCandles('BTCUSD', 'M1');
    const reseed = vi.spyOn(SymbolCandleBuilder.prototype, 'loadHistoricalCandles');

    service.hydrateHistoricalCandles('BTCUSD', 'M1', history);

    expect(reseed).not.toHaveBeenCalled();
    expect(service.getCandles('BTCUSD', 'M1')).toEqual(before);
    expect(before.at(-1)).toMatchObject({ close: 105, high: 105, isComplete: false });
    expect(service.processTick(latestTick).size).toBe(0);
    expect(service.getCandles('BTCUSD', 'M1')).toEqual(before);
  });

  it('seeds an empty runtime and still accepts subsequent authoritative broker corrections', () => {
    const service = new CandleAggregationService();
    service.hydrateHistoricalCandles('BTCUSD', 'M1', history);
    expect(service.getCandles('BTCUSD', 'M1')).toEqual(history);
    const corrected = history.map(row => ({ ...row, high: 101, close: 100, isComplete: true }));
    service.loadHistoricalCandles('BTCUSD', 'M1', corrected);
    expect(service.getCandles('BTCUSD', 'M1')).toEqual(corrected);
  });

  it('keeps exact symbols and explicit boundary offsets separate during handoff', () => {
    const service = new CandleAggregationService();
    service.loadHistoricalCandles('BTCUSD.r', 'M1', history, 3600);
    expect(service.getCandlesForHydration('BTCUSD.r', 'M1', 3600)).toEqual(history);
    expect(service.getCandlesForHydration('BTCUSDr', 'M1', 3600)).toEqual([]);
    expect(service.getCandlesForHydration('BTCUSD.r', 'M1', 0)).toEqual([]);
    service.hydrateHistoricalCandles('BTCUSD.r', 'M1', history, 0);
    expect(service.getCandlesForHydration('BTCUSD.r', 'M1', 0)).toEqual(history);
  });

  it.each(['login', 'logout', 'account_change', 'broker_url_change'] as const)('clears retained candles on %s', reason => {
    candleAggregationService.loadHistoricalCandles('BTCUSD', 'M1', history);
    emitSessionChange(reason);
    expect(candleAggregationService.getCandlesForHydration('BTCUSD', 'M1')).toEqual([]);
  });

  it('retains candles during token rotation within the same session', () => {
    candleAggregationService.loadHistoricalCandles('BTCUSD', 'M1', history);
    emitSessionChange('token_rotation');
    expect(candleAggregationService.getCandlesForHydration('BTCUSD', 'M1')).toEqual(history);
  });

  it('retains enough derived H1 bars from M1 history to satisfy initial chart viewport caching', () => {
    const service = new CandleAggregationService();
    const startHour = Math.floor(Date.UTC(2026, 9, 1, 0, 0) / 1000);
    const m1Candles: OHLCV[] = Array.from({ length: 35 * 60 }, (_, index) => ({
      time: startHour + index * 60,
      open: 100 + index * 0.01,
      high: 101 + index * 0.01,
      low: 99 + index * 0.01,
      close: 100.5 + index * 0.01,
      volume: 1,
      isComplete: index < 35 * 60 - 1,
    }));

    service.loadHistoricalCandles('BTCUSD', 'M1', m1Candles);
    expect(service.getCandles('BTCUSD', 'H1', true, false).length).toBeGreaterThanOrEqual(30);
  });
});
