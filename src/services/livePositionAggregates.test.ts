import { beforeEach, describe, expect, it } from 'vitest';
import { resolveTradeAccountMetrics } from '../components/BottomDock.trade';
import {
  computeLiveAccountMetricsFromAggregates,
  getLiveBulkCloseCounts,
  getLiveSymbolPnLFromSource,
  getPositionAggregatesForArray,
} from './livePositionAggregates';
import { getLivePositionProfit, getLivePositionRoundedProfit } from './livePositionMetrics';
import { resetLiveQuotesForTests, setLiveQuote } from './liveQuotes';

type Row = Record<string, unknown>;

const row = (id: number, symbol: string, side: 'BUY' | 'SELL', volume: number, open: number, profit: number, extra: Row = {}): Row => ({
  id,
  symbol,
  side,
  volume,
  price_open: open,
  price_current: open,
  profit,
  hasBackendProfit: true,
  hasBackendCurrentPrice: true,
  contractSize: symbol === 'XAUUSD' ? 100 : 100000,
  margin: 50,
  swap: -0.1,
  ...extra,
});

// Deterministic pseudo-random rows over USD-quoted, USD-based and cross symbols.
const buildPositions = (count: number): Row[] => {
  const symbols = ['EURUSD', 'GBPUSD', 'XAUUSD', 'USDJPY', 'EURGBP'];
  const opens: Record<string, number> = { EURUSD: 1.08, GBPUSD: 1.27, XAUUSD: 2000, USDJPY: 150, EURGBP: 0.85 };
  let seed = 7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, (_, index) => {
    const symbol = symbols[index % symbols.length];
    const open = opens[symbol] * (1 + (rand() - 0.5) * 0.01);
    const volume = Math.round((0.01 + rand() * 0.5) * 100) / 100;
    return row(1000 + index, symbol, rand() > 0.5 ? 'BUY' : 'SELL', volume, open, Math.round((rand() - 0.5) * 400) / 100);
  });
};

const QUOTES: Record<string, [number, number]> = {
  EURUSD: [1.0842, 1.0844],
  GBPUSD: [1.2655, 1.2657],
  XAUUSD: [2011.4, 2011.9],
  USDJPY: [149.21, 149.23],
  EURGBP: [0.8561, 0.8563],
};

const applyQuotes = () => {
  for (const [symbol, [bid, ask]] of Object.entries(QUOTES)) setLiveQuote({ symbol, bid, ask });
};

describe('livePositionAggregates', () => {
  beforeEach(() => resetLiveQuotesForTests());

  const account = resolveTradeAccountMetrics({
    balance: 100000, credit: 0, equity: 100000, margin: 5000, freeMargin: 95000, marginLevel: 2000, unrealizedPL: 0,
  });

  it('footer floating P/L equals the exact sum of the per-position live profit (+ swap)', () => {
    const positions = buildPositions(150);
    applyQuotes();
    const agg = getPositionAggregatesForArray(positions);
    const live = computeLiveAccountMetricsFromAggregates(account, agg);

    // Reference: exact unrounded per-position value, computed independently per trade.
    let expected = 0;
    let perRowRounded = 0;
    for (const p of positions) {
      const isSell = p.side === 'SELL';
      const [bid, ask] = QUOTES[String(p.symbol)];
      const price = isSell ? ask : bid;
      const units = Number(p.volume) * Number(p.contractSize);
      let raw = (price - Number(p.price_open)) * (isSell ? -1 : 1) * units;
      if (p.symbol === 'USDJPY') raw /= price;
      if (p.symbol !== 'EURGBP') expected += raw;
      else expected += Number(p.profit); // non-USD cross keeps the backend profit verbatim
      perRowRounded += getLivePositionRoundedProfit(p) ?? 0;
      expected += Number(p.swap);
      perRowRounded += Number(p.swap);
    }
    expect(live.floatingPnL).not.toBeNull();
    expect(live.floatingPnL as number).toBeCloseTo(expected, 6);
    expect(live.equity as number).toBeCloseTo(100000 + expected, 6);
    expect(live.freeMargin as number).toBeCloseTo(100000 + expected - 5000, 6);
    expect(live.marginLevel as number).toBeCloseTo(((100000 + expected) / 5000) * 100, 6);

    // Documented owner decision: the exact sum differs from the old per-row cent-rounded sum by at most
    // half a cent per trade.
    expect(Math.abs((live.floatingPnL as number) - perRowRounded)).toBeLessThanOrEqual(0.005 * positions.length + 1e-6);
  });

  it('matches the per-position selector for USD-quoted symbols (exact, no rounding drift)', () => {
    const positions = buildPositions(60).filter((p) => p.symbol === 'EURUSD' || p.symbol === 'GBPUSD' || p.symbol === 'XAUUSD');
    applyQuotes();
    const agg = getPositionAggregatesForArray(positions);
    const live = computeLiveAccountMetricsFromAggregates(account, agg);
    let sum = 0;
    for (const p of positions) sum += (getLivePositionProfit(p) as number) + Number(p.swap);
    expect(live.floatingPnL as number).toBeCloseTo(sum, 6);
  });

  it('falls back to backend profits when a symbol has no quote', () => {
    const positions = buildPositions(40);
    const agg = getPositionAggregatesForArray(positions);
    const live = computeLiveAccountMetricsFromAggregates(account, agg);
    let sum = 0;
    for (const p of positions) sum += Number(p.profit) + Number(p.swap);
    expect(live.floatingPnL as number).toBeCloseTo(sum, 6);
  });

  it('reports no floating P/L when a position has no backend profit', () => {
    const positions = [...buildPositions(10), row(9999, 'EURUSD', 'BUY', 0.1, 1.08, 0, { hasBackendProfit: false, profit: undefined, price_current: undefined, hasBackendCurrentPrice: false })];
    const agg = getPositionAggregatesForArray(positions);
    expect(agg.staticMissingProfitCount + agg.bySymbol.get('EURUSD')!.buyFallbackMissing).toBeGreaterThan(0);
  });

  it('is O(symbols) per quote batch: the aggregate is computed once per positions array', () => {
    const positions = buildPositions(500);
    const first = getPositionAggregatesForArray(positions);
    applyQuotes();
    computeLiveAccountMetricsFromAggregates(account, first);
    expect(getPositionAggregatesForArray(positions)).toBe(first);
    expect(first.bySymbol.size).toBe(5);
    expect(first.heldSymbols.has('XAUUSD')).toBe(true);
  });

  it('Close In-Profit / In-Loss counts equal the per-position counts at the live prices', () => {
    const positions = buildPositions(200);
    applyQuotes();
    const counts = getLiveBulkCloseCounts(positions);
    let profitable = 0;
    let losing = 0;
    for (const p of positions) {
      const profit = getLivePositionRoundedProfit(p);
      if (profit === null) continue;
      if (profit > 0) profitable += 1;
      else if (profit < 0) losing += 1;
    }
    expect(counts).toEqual({ all: 200, profitable, losing });
  });

  it('counts a position that cannot be priced live exactly once (no quote, volume 0, unknown contract)', () => {
    // EURUSD is a live (quote_usd) symbol. One row is live-eligible; two are not: volume 0 and
    // an explicit 0 contract size. All three carry a backend profit > 0.
    const positions = [
      row(9001, 'EURUSD', 'BUY', 0.1, 1.08, 5),
      row(9002, 'EURUSD', 'BUY', 0, 1.08, 7),
      row(9003, 'EURUSD', 'SELL', 0.1, 1.08, 9, { contractSize: 0 }),
    ];
    // Before any tick: every row falls back to its backend profit; each is counted once.
    expect(getLiveBulkCloseCounts(positions)).toEqual({ all: 3, profitable: 3, losing: 0 });
    // After a tick: the eligible row is live-priced; the two ineligible rows still count once.
    setLiveQuote({ symbol: 'EURUSD', bid: 1.07, ask: 1.0702 });
    const counts = getLiveBulkCloseCounts(positions);
    expect(counts.profitable + counts.losing).toBeLessThanOrEqual(counts.all);
    expect(counts).toEqual({ all: 3, profitable: 2, losing: 1 });
  });

  it('per-symbol live P/L equals the sum of the per-position selector', () => {
    const positions = buildPositions(80);
    applyQuotes();
    const result = getLiveSymbolPnLFromSource(positions, 'eurusd');
    const eur = positions.filter((p) => p.symbol === 'EURUSD');
    expect(result.count).toBe(eur.length);
    expect(result.totalPnL).toBeCloseTo(eur.reduce((sum, p) => sum + (getLivePositionProfit(p) as number), 0), 6);
  });

  it('shows no live floating P/L for an empty book', () => {
    const live = computeLiveAccountMetricsFromAggregates({ ...account, floatingPnL: 12, unrealizedPL: 12 }, getPositionAggregatesForArray([]));
    expect(live.floatingPnL).toBe(0);
  });
});
