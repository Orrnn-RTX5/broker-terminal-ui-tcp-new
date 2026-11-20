import type { Timeframe } from '../types/chart';

export const TIMEFRAME_STORAGE_KEY = 'rtx5_timeframe';

const CANONICAL_TIMEFRAMES: ReadonlySet<string> = new Set<Timeframe>([
  'M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN',
]);

const TIMEFRAME_ALIASES: Readonly<Record<string, Timeframe>> = {
  '1M': 'M1',
  '5M': 'M5',
  '15M': 'M15',
  '30M': 'M30',
  '1H': 'H1',
  '4H': 'H4',
  '1D': 'D1',
  '1W': 'W1',
  '1MN': 'MN',
};

export const normalizePersistedTimeframe = (value: unknown): Timeframe | null => {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toUpperCase();
  if (!candidate) return null;
  if (CANONICAL_TIMEFRAMES.has(candidate)) return candidate as Timeframe;
  return TIMEFRAME_ALIASES[candidate] ?? null;
};

export const readPersistedTimeframe = (): Timeframe | null => {
  try {
    if (typeof localStorage === 'undefined') return null;
    return normalizePersistedTimeframe(localStorage.getItem(TIMEFRAME_STORAGE_KEY));
  } catch {
    return null;
  }
};

export const writePersistedTimeframe = (value: unknown): Timeframe | null => {
  const normalized = normalizePersistedTimeframe(value);
  if (!normalized) return null;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TIMEFRAME_STORAGE_KEY, normalized);
    }
  } catch {
    // Ignore storage write errors
  }
  return normalized;
};
