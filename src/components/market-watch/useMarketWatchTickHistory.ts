import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { apiClient, type ApiRequestOptions } from '../../api/client';
import { API_V2_BASE_URL, toLocalDevProxyUrl } from '../../config/api';
import { getAccountSpreadMarkupMap, onAccountSpreadMarkupChange } from '../../services/accountSpreadMarkup';
import { getAccessToken, getServerUrl } from '../../services/brokerSession';
import { useAppStore } from '../../store/useAppStore';
import { asUnknownRecord, readBrokerTimestampMs } from '../../utils/brokerStreamSemantics';
import { normalizeExactBrokerSymbol } from '../../utils/exactBrokerSymbol';
import { applySpreadMarkupToQuote, normalizeSpreadMarkupSymbol, type SpreadMarkupMap } from '../../utils/spreadMarkup';
import { MARKET_WATCH_TICK_CHART_LIMIT, type TickChartPoint } from './tickChartGeometry';

const EMPTY_HISTORY: readonly TickChartPoint[] = Object.freeze([]);

/**
 * A loaded history point on the raw feed basis: `bid`/`ask` are the broker's sides. The account markup is applied to it in
 * memory (widenTickHistory) and is never stored in the point.
 */
type RawTickHistoryPoint = TickChartPoint;

const positivePrice = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Parses `/api/v2/ticks/{symbol}` into raw chart points, chronological. Rows for another contract, without broker time,
 * or without both quote sides are skipped rather than repaired.
 */
const parseRawTickHistory = (response: unknown, symbol: string): RawTickHistoryPoint[] => {
  const exactSymbol = normalizeExactBrokerSymbol(symbol);
  const record = asUnknownRecord(response);
  const rows = Array.isArray(response) ? response : record?.ticks ?? record?.data;
  if (!Array.isArray(rows)) return [];
  const points: RawTickHistoryPoint[] = [];
  rows.forEach((value) => {
    const row = asUnknownRecord(value);
    if (!row || (row.symbol && normalizeExactBrokerSymbol(row.symbol) !== exactSymbol)) return;
    const timestamp = readBrokerTimestampMs([row]);
    const rawBid = positivePrice(row.bid);
    const rawAsk = positivePrice(row.ask);
    const rawLast = positivePrice(row.last);
    if (timestamp === undefined || rawBid === null || rawAsk === null) return;
    points.push({
      timestamp,
      bid: rawBid,
      ask: rawAsk,
      ...(rawLast !== null ? { last: rawLast } : {}),
    });
  });
  return points.sort((left, right) => left.timestamp - right.timestamp);
};

/**
 * Widens raw history points with a markup map. History arrives on the raw feed basis; live ticks carry the account's
 * spread markup, so both are shown on the same basis. The symbol's entry is looked up once per run. A symbol with no active
 * entry shows its raw points: the loaded array itself comes back, with no per-point work.
 */
const widenTickHistory = (
  raw: RawTickHistoryPoint[],
  symbol: string,
  markupMap: SpreadMarkupMap,
): TickChartPoint[] => {
  const entry = markupMap.get(normalizeSpreadMarkupSymbol(symbol));
  if (!entry) return raw;
  return raw.map((point) => {
    const quote = applySpreadMarkupToQuote(
      { bid: point.bid, ask: point.ask, spread: point.ask - point.bid },
      entry,
    );
    return {
      timestamp: point.timestamp,
      bid: Number(quote.bid),
      ask: Number(quote.ask),
      ...(point.last !== undefined ? { last: point.last } : {}),
    };
  });
};

/**
 * Parses `/api/v2/ticks/{symbol}` into chronological chart points widened with the account's current markup.
 * Rows for another contract, without broker time, or without both quote sides are skipped rather than repaired.
 */
export const parseMarketWatchTickHistory = (
  response: unknown,
  symbol: string,
): TickChartPoint[] => {
  const exactSymbol = normalizeExactBrokerSymbol(symbol);
  return widenTickHistory(parseRawTickHistory(response, exactSymbol), exactSymbol, getAccountSpreadMarkupMap());
};

/**
 * Recent broker ticks that precede this session's live buffer, loaded once per symbol and broker/account scope. They are
 * display data only and never enter the live tick stores. The raw points are kept as loaded; the account markup is applied
 * to them in memory, so a markup change or a logout widens or restores them at once, with no request and no stale points.
 * The returned array and its point objects may be the very objects held in state (the loaded array itself, when the symbol
 * has no markup entry). Consumers must treat them as read-only: never sort, push or change a field in place.
 */
export function useMarketWatchTickHistory(
  symbol: string,
  scopeKey: string | null | undefined,
): readonly TickChartPoint[] {
  const exactSymbol = normalizeExactBrokerSymbol(symbol);
  const requestKey = exactSymbol && scopeKey ? `${scopeKey}\u0000${exactSymbol}` : null;
  const [loaded, setLoaded] = useState<{ key: string; points: RawTickHistoryPoint[] } | null>(null);
  // The markup is applied in memory; an equal map keeps its identity, so a catalogue refresh with the same markup
  // re-renders nothing. The request depends on the symbol and scope only.
  const markupMap = useSyncExternalStore(onAccountSpreadMarkupChange, getAccountSpreadMarkupMap);

  useEffect(() => {
    if (!requestKey) return undefined;
    const controller = new AbortController();
    const serverUrl = getServerUrl().replace(/\/+$/, '');
    const baseUrl = serverUrl ? `${toLocalDevProxyUrl(serverUrl)}/api/v2` : API_V2_BASE_URL;
    const state = useAppStore.getState();
    const authToken = getAccessToken() || state.authToken;
    // Capture routing and credentials once so a later account switch cannot
    // attach this symbol's history to the next account.
    const options: ApiRequestOptions = {
      baseUrl,
      skipDynamicUrl: true,
      authToken,
      skipAuth: !authToken,
      signal: controller.signal,
      params: { limit: MARKET_WATCH_TICK_CHART_LIMIT },
      requestContext: {
        key: `market-watch-tick-history:${requestKey}`,
        backendOrigin: baseUrl.replace(/\/api\/v2\/?$/, ''),
        refreshEndpoint: `${baseUrl}/auth/refresh`,
        refreshToken: state.refreshToken,
      },
    };
    apiClient.get<unknown>(`/ticks/${encodeURIComponent(exactSymbol)}`, options)
      .then((response) => {
        if (controller.signal.aborted) return;
        setLoaded({ key: requestKey, points: parseRawTickHistory(response, exactSymbol) });
      })
      .catch(() => {
        // Brokers without tick history still chart the live ticks.
      });
    return () => controller.abort();
  }, [exactSymbol, requestKey]);

  return useMemo(() => {
    if (!requestKey || !loaded || loaded.key !== requestKey) return EMPTY_HISTORY;
    return widenTickHistory(loaded.points, exactSymbol, markupMap);
  }, [exactSymbol, loaded, markupMap, requestKey]);
}
