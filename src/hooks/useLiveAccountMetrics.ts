import { useMemo, useSyncExternalStore } from 'react';
import {
  resolveTradeAccountMetrics,
  type TradeAccountMetricInput,
  type TradeAccountMetricResolution,
  type TradeProfitInput,
} from '../components/BottomDock.trade';
import { getLiveQuotesVersion, subscribeLiveQuotes } from '../services/liveQuotes';
import {
  computeLiveAccountMetricsFromAggregates,
  getPositionAggregatesForArray,
} from '../services/livePositionAggregates';

const noopSubscribe = () => () => {};
const zeroSnapshot = () => 0;

/**
 * Backend account metrics, kept live between snapshots in O(numSymbols) from the per-symbol
 * position aggregates and the latest live quotes (no per-position work per tick).
 */
export function useLiveAccountMetrics(
  account: TradeAccountMetricInput | null | undefined,
  positions: readonly TradeProfitInput[],
  now: number,
): TradeAccountMetricResolution {
  const agg = useMemo(() => getPositionAggregatesForArray(positions), [positions]);
  const liveActive = Boolean(account && agg.totalCount > 0);
  const quotesVersion = useSyncExternalStore(
    liveActive ? subscribeLiveQuotes : noopSubscribe,
    liveActive ? getLiveQuotesVersion : zeroSnapshot,
    zeroSnapshot,
  );
  const resolved = useMemo(() => resolveTradeAccountMetrics(account, now), [account, now]);
  // quotesVersion is the change signal for the live quotes read inside the aggregate math.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => computeLiveAccountMetricsFromAggregates(resolved, agg), [resolved, agg, quotesVersion]);
}
