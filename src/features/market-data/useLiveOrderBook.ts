import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { ApiError } from '../../api/client';
import { MARKET_WS_URL } from '../../config/api';
import {
  getAccountSpreadMarkupMap,
  onAccountSpreadMarkupChange,
} from '../../services/accountSpreadMarkup';
import {
  binaryTcpMarketStream,
  type DecodedBinaryDepth,
} from '../../services/binaryTcpMarketStream';
import { buildBrokerWsV2Uri } from '../../services/brokerSession';
import { getEnhancedWebSocketService } from '../../services/websocket-enhanced';
import { useAppStore } from '../../store/useAppStore';
import {
  applySpreadMarkupToBookLevels,
  normalizeSpreadMarkupSymbol,
  roundPriceToDigits,
  type SpreadMarkupMap,
} from '../../utils/spreadMarkup';
import {
  fetchMarketDataJson,
  useBrokerSessionRevision,
} from './marketDataSession';
import {
  getSpreadPips,
  normalizeOrderBook,
  normalizeSymbol,
} from './marketDataNormalization';
import type { LiveOrderBook, OrderBookLevel } from './marketDataTypes';

/** Depth levels widened like the account's top-of-book quote. */
export const applySpreadMarkupToOrderBook = (
  orderBook: LiveOrderBook | null,
  markupMap: SpreadMarkupMap,
): LiveOrderBook | null => {
  if (!orderBook) return orderBook;
  const entry = markupMap.get(normalizeSpreadMarkupSymbol(orderBook.symbol));
  if (!entry) return orderBook;
  const bids = applySpreadMarkupToBookLevels(orderBook.bids, 'bid', entry);
  const asks = applySpreadMarkupToBookLevels(orderBook.asks, 'ask', entry);
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const spread = bestBid > 0 && bestAsk > 0
    ? roundPriceToDigits(bestAsk - bestBid, entry.digits)
    : 0;
  return {
    ...orderBook,
    bids,
    asks,
    spread,
    spreadPips: getSpreadPips(orderBook.symbol, spread, entry.digits),
  };
};

const useAccountSpreadMarkupMap = (): SpreadMarkupMap =>
  useSyncExternalStore(onAccountSpreadMarkupChange, getAccountSpreadMarkupMap, getAccountSpreadMarkupMap);

export const decodedBinaryDepthToLiveOrderBook = (
  decoded: DecodedBinaryDepth,
  fallbackSymbol: string,
  maxLevels: number,
): LiveOrderBook | null => {
  const symbol = normalizeSymbol(decoded.symbol) || fallbackSymbol;
  if (!symbol) return null;
  const limit = Number.isFinite(maxLevels) && maxLevels > 0 ? Math.floor(maxLevels) : 10;

  let bidTotal = 0;
  const bids: OrderBookLevel[] = [];
  const rawBids = decoded.bids.slice(0, limit);
  for (let i = 0; i < rawBids.length; i++) {
    const level = rawBids[i];
    if (Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.volume) && level.volume > 0) {
      bidTotal += level.volume;
      bids.push({
        price: level.price,
        volume: level.volume,
        total: bidTotal,
      });
    }
  }

  let askTotal = 0;
  const asks: OrderBookLevel[] = [];
  const rawAsks = decoded.asks.slice(0, limit);
  for (let i = 0; i < rawAsks.length; i++) {
    const level = rawAsks[i];
    if (Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.volume) && level.volume > 0) {
      askTotal += level.volume;
      asks.push({
        price: level.price,
        volume: level.volume,
        total: askTotal,
      });
    }
  }

  if (bids.length === 0 && asks.length === 0) return null;

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0;

  return {
    symbol,
    bids,
    asks,
    spread,
    spreadPips: getSpreadPips(symbol, spread),
    timestamp: decoded.timestamp > 0 ? decoded.timestamp : Date.now(),
  };
};

export function useLiveOrderBook(symbol: string, depth: number) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const [rawOrderBook, setOrderBook] = useState<LiveOrderBook | null>(null);
  const spreadMarkupMap = useAccountSpreadMarkupMap();
  const orderBook = useMemo(
    () => applySpreadMarkupToOrderBook(rawOrderBook, spreadMarkupMap),
    [rawOrderBook, spreadMarkupMap],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAuthenticated = useAppStore((state) => state.isAuthenticated);
  const authToken = useAppStore((state) => state.authToken);
  const sessionRevision = useBrokerSessionRevision();

  const reload = useCallback(async () => {
    void sessionRevision;
    if (!normalizedSymbol || !isAuthenticated) {
      setOrderBook(null);
      setError(null);
      setLoading(false);
      return;
    }

    if (binaryTcpMarketStream.isSupported()) {
      const cachedDepth = binaryTcpMarketStream.getLatestDepth(normalizedSymbol);
      if (cachedDepth) {
        const warmBook = decodedBinaryDepthToLiveOrderBook(cachedDepth, normalizedSymbol, depth);
        if (warmBook) {
          setOrderBook(warmBook);
          setError(null);
        }
      }
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetchMarketDataJson<unknown>(`/api/v2/depth/${encodeURIComponent(normalizedSymbol)}`, {
        limit: depth,
        levels: depth,
      });
      const next = normalizeOrderBook(response, normalizedSymbol);
      if (next) {
        setOrderBook(next);
      }
    } catch (err) {
      if (binaryTcpMarketStream.isSupported()) {
        const cachedDepth = binaryTcpMarketStream.getLatestDepth(normalizedSymbol);
        const warmBook = cachedDepth
          ? decodedBinaryDepthToLiveOrderBook(cachedDepth, normalizedSymbol, depth)
          : null;
        if (warmBook) {
          setOrderBook(warmBook);
          setError(null);
          return;
        }
      }
      setError(err instanceof ApiError ? err.message : 'Failed to load order book');
      setOrderBook(null);
    } finally {
      setLoading(false);
    }
  }, [normalizedSymbol, depth, isAuthenticated, sessionRevision]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void sessionRevision;
    if (!normalizedSymbol || !isAuthenticated) return;

    let unsubscribeBinaryDepth: (() => void) | null = null;
    if (binaryTcpMarketStream.isSupported()) {
      const cached = binaryTcpMarketStream.getLatestDepth(normalizedSymbol);
      if (cached) {
        const warm = decodedBinaryDepthToLiveOrderBook(cached, normalizedSymbol, depth);
        if (warm) {
          setOrderBook(warm);
          setError(null);
          setLoading(false);
        }
      }
      unsubscribeBinaryDepth = binaryTcpMarketStream.onDepth(normalizedSymbol, (decoded) => {
        const next = decodedBinaryDepthToLiveOrderBook(decoded, normalizedSymbol, depth);
        if (next) {
          setOrderBook(next);
          setError(null);
          setLoading(false);
        }
      });
    }

    const wsUrl = buildBrokerWsV2Uri(null) || MARKET_WS_URL;
    const ws = getEnhancedWebSocketService(wsUrl);
    ws.connect();
    const channel = `depth.${normalizedSymbol}`;
    const unsubscribeWs = ws.subscribe(channel, (message) => {
      const next = normalizeOrderBook(message, normalizedSymbol);
      if (next) setOrderBook(next);
    });

    return () => {
      if (unsubscribeBinaryDepth) unsubscribeBinaryDepth();
      unsubscribeWs();
    };
  }, [normalizedSymbol, depth, isAuthenticated, authToken, sessionRevision]);

  return { orderBook, loading, error, reload };
}
