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

export const buildTradeEligibleSymbolNames = (
  instrumentSymbols: unknown[],
  activeFeedSymbols: unknown[],
): string[] => {
  const activeFeedSymbolSet = new Set(getUniqueSymbolNames(activeFeedSymbols));
  return getUniqueSymbolNames(instrumentSymbols).filter((symbol) => activeFeedSymbolSet.has(symbol));
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

