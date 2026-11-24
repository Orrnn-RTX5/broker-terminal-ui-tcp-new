import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import {
  buildBrokerWsV2Uri,
  onSessionChange,
} from '../../services/brokerSession';
import { getEnhancedWebSocketService } from '../../services/websocket-enhanced';
import { useAppStore } from '../../store/useAppStore';
import {
  applySpreadMarkupToBookLevels,
  normalizeSpreadMarkupSymbol,
  roundPriceToDigits,
  type SpreadMarkupMap,
} from '../../utils/spreadMarkup';
import { fetchMarketDataJson } from './marketDataSession';
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
  const bids = applySpreadMarkupToBookLevels(orderBook.bids, 'bid', entry, orderBook.asks);
  const asks = applySpreadMarkupToBookLevels(orderBook.asks, 'ask', entry, orderBook.bids);
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

interface SessionRevisions {
  all: number;
  owner: number;
}

const useOrderBookSessionRevisions = (): SessionRevisions => {
  const [revisions, setRevisions] = useState<SessionRevisions>({ all: 0, owner: 0 });
  useEffect(() => onSessionChange((reason) => {
    setRevisions((current) => ({
      all: current.all + 1,
      owner: reason === 'token_rotation' ? current.owner : current.owner + 1,
    }));
  }), []);
  return revisions;
};

/** Request key (normalised symbol, authentication state, owner session revision) that the stored book, error and loading belong to. */
interface RequestOwner {
  symbol: string;
  authenticated: boolean;
  session: number;
}

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
  const { all: sessionRevision, owner: ownerSessionRevision } = useOrderBookSessionRevisions();
  // The request key the stored state belongs to. It changes only in the reload effect, when the key changes.
  const [owner, setOwner] = useState<RequestOwner>(() => ({
    symbol: normalizedSymbol,
    authenticated: isAuthenticated,
    session: ownerSessionRevision,
  }));
  const ownerRef = useRef(owner);
  const generationRef = useRef(0);
  const ownsState = owner.symbol === normalizedSymbol
    && owner.authenticated === isAuthenticated
    && owner.session === ownerSessionRevision;
  const requestActive = Boolean(normalizedSymbol) && isAuthenticated;

  const reload = useCallback(async () => {
    void sessionRevision;
    const owned = ownerRef.current;
    if (owned.symbol !== normalizedSymbol
      || owned.authenticated !== isAuthenticated
      || owned.session !== ownerSessionRevision) {
      return;
    }
    const generation = ++generationRef.current;
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
      if (generation !== generationRef.current) return;
      const next = normalizeOrderBook(response, normalizedSymbol);
      if (next) {
        setOrderBook(next);
      }
    } catch (err) {
      if (generation !== generationRef.current) return;
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
      if (generation === generationRef.current) setLoading(false);
    }
  }, [normalizedSymbol, depth, isAuthenticated, sessionRevision, ownerSessionRevision]);

  useEffect(() => {
    const stored = ownerRef.current;
    if (stored.symbol !== normalizedSymbol
      || stored.authenticated !== isAuthenticated
      || stored.session !== ownerSessionRevision) {
      const nextOwner: RequestOwner = {
        symbol: normalizedSymbol,
        authenticated: isAuthenticated,
        session: ownerSessionRevision,
      };
      ownerRef.current = nextOwner;
      setOwner(nextOwner);
      setOrderBook(null);
      setError(null);
      setLoading(Boolean(normalizedSymbol) && isAuthenticated);
    }
    void reload();
    return () => {
      generationRef.current += 1;
    };
  }, [reload, normalizedSymbol, isAuthenticated, ownerSessionRevision]);

  useEffect(() => {
    void sessionRevision;
    if (!normalizedSymbol || !isAuthenticated) return;

    let active = true;
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
        if (!active) return;
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
      if (!active) return;
      const next = normalizeOrderBook(message, normalizedSymbol);
      if (next) setOrderBook(next);
    });

    return () => {
      active = false;
      if (unsubscribeBinaryDepth) unsubscribeBinaryDepth();
      unsubscribeWs();
    };
  }, [normalizedSymbol, depth, isAuthenticated, authToken, sessionRevision]);

  return {
    orderBook: ownsState ? orderBook : null,
    loading: ownsState ? loading : requestActive,
    error: ownsState ? error : null,
    reload,
  };
}
