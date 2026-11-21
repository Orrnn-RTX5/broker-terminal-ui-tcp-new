import { collapseDealHistory, collapseTruncatedDealWindow, tradeGatewayApi } from '../../api/tradeGateway';
import type { Trade } from '../../store/useAppStore';

export const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
};

const mergeOrderHistory = (parts: Trade[][]): Trade[] => {
  const seen = new Set<string>();
  return parts
    .flat()
    .filter((trade) => {
      const key = `${trade?.type}:${trade?.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(b?.closeTime ?? b?.openTime) - Date.parse(a?.closeTime ?? a?.openTime))
    .slice(0, 500);
};

export interface OrderHistoryRefreshResult {
  trades: Trade[];
  warning: string | null;
  /**
   * Limited reads only: rows built from a truncated deal page whose entry deal is not provably
   * in the page. They must not be stored as history; the caller merges them only onto a row it
   * already holds, otherwise it schedules one full read.
   */
  unverified?: Trade[];
}

export interface OrderHistoryFetchOptions {
  /** Background refresh: read only the newest rows per source. Omit for the full load. */
  limit?: number;
}

export const fetchOrderHistory = async (
  login: number,
  options?: OrderHistoryFetchOptions,
): Promise<OrderHistoryRefreshResult> => {
  const limit = options?.limit;
  const [closedPositionsResult, dealsResult] = await Promise.allSettled([
    tradeGatewayApi.getClosedPositions(login, limit === undefined ? undefined : { limit }),
    tradeGatewayApi.getDeals(login, limit === undefined ? undefined : { limit }),
  ]);

  if (dealsResult.status === 'rejected') {
    throw new Error(getErrorMessage(dealsResult.reason, 'Deals history endpoint failed'));
  }

  const closedPositions = closedPositionsResult.status === 'fulfilled'
    ? closedPositionsResult.value
    : [];
  const rawDeals = dealsResult.value;
  // A limited read that filled its page may have cut off older entry deals.
  const truncated = limit !== undefined && rawDeals.length >= limit;
  const window = truncated ? collapseTruncatedDealWindow(rawDeals) : null;
  const closedDeals = window ? window.safe : collapseDealHistory(rawDeals);
  const usesDeals = closedDeals.length > 0;
  // A truncated page whose rows are all unverifiable (e.g. a stop-out: only exits of older
  // positions) must not fall back to closed-position rows: they are keyed differently from the
  // deal-built rows already held and would add the same position twice. The caller asks for one
  // gated full read instead.
  const onlyUnverified = !usesDeals && window !== null && window.unverified.length > 0;
  const unverified = window ? window.unverified : [];
  const source = usesDeals ? closedDeals : (onlyUnverified ? [] : closedPositions);
  const warning = closedPositionsResult.status === 'rejected'
    ? getErrorMessage(closedPositionsResult.reason, 'Closed-position history endpoint failed')
    : null;

  return {
    trades: mergeOrderHistory([source]),
    warning,
    ...(unverified.length > 0 ? { unverified } : {}),
  };
};
