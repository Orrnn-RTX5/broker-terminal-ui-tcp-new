import { resolveMarketWatchSymbolInput } from './marketWatchSource';

export const normalizeSymbolName = (value: unknown): string => String(value ?? '').trim().toUpperCase();

export const getInstrumentSymbolName = (instrument: unknown): string => {
  if (instrument && typeof instrument === 'object') {
    const record = instrument as Record<string, unknown>;
    return normalizeSymbolName(record.symbol ?? record.name ?? record.id);
  }
  return normalizeSymbolName(instrument);
};

export const getUniqueSymbolNames = (symbols: unknown[]): string[] => {
  return Array.from(new Set((Array.isArray(symbols) ? symbols : []).map(getInstrumentSymbolName).filter(Boolean)));
};

export const buildChartEligibleSymbolNames = (
  instrumentSymbols: unknown[],
  activeFeedSymbols: unknown[],
): string[] => {
  return getUniqueSymbolNames([...instrumentSymbols, ...activeFeedSymbols]);
};

/**
 * MT5-exact trade eligibility:
 * Any instrument authorized in the trader account's broker catalogue is eligible
 * for One-Click BUY/SELL and F9 Order Ticket submission. Never disable trading
 * buttons in the UI based on 30-second background `/ws/feed/status` REST polling;
 * real-time quote validation occurs atomically at order execution time on the server.
 */
export const buildTradeEligibleSymbolNames = (
  instrumentSymbols: unknown[],
  activeFeedSymbols: unknown[],
): string[] => {
  const authorized = getUniqueSymbolNames(instrumentSymbols);
  if (authorized.length > 0) {
    return authorized;
  }
  return getUniqueSymbolNames(activeFeedSymbols);
};

export const resolveAuthorizedChartSymbol = (
  requestedSymbol: unknown,
  authorizedSymbols: unknown[],
): string => {
  const normalizedRequest = normalizeSymbolName(requestedSymbol);
  if (!normalizedRequest) return '';

  return resolveMarketWatchSymbolInput(
    getUniqueSymbolNames(authorizedSymbols),
    normalizedRequest,
  ) ?? '';
};

export const pickPreferredChartSymbol = (
  authorizedSymbols: unknown[],
  liveFeedSymbols: unknown[] = [],
  requestedSymbol?: unknown,
  preferLiveSymbol = true,
): string => {
  const authorized = getUniqueSymbolNames(authorizedSymbols);
  const live = getUniqueSymbolNames(liveFeedSymbols).filter((symbol) => (
    authorized.length === 0 || authorized.includes(symbol)
  ));
  const requested = resolveAuthorizedChartSymbol(requestedSymbol, authorized.length > 0 ? authorized : live);

  if (requested && (!preferLiveSymbol || live.length === 0 || live.includes(requested))) {
    return requested;
  }

  if (live[0]) return live[0];
  if (requested) return requested;
  return authorized[0] || '';
};

