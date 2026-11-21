// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizePersistedTimeframe,
  readPersistedTimeframe,
  TIMEFRAME_STORAGE_KEY,
  writePersistedTimeframe,
} from './chartTimeframePersistence';

const ALL_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN'] as const;

describe('chartTimeframePersistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it.each(ALL_TIMEFRAMES)('persists and restores canonical timeframe %s', (timeframe) => {
    expect(writePersistedTimeframe(timeframe)).toBe(timeframe);
    expect(localStorage.getItem(TIMEFRAME_STORAGE_KEY)).toBe(timeframe);
    expect(readPersistedTimeframe()).toBe(timeframe);
  });

  it('normalizes lowercase values and legacy timeframe aliases', () => {
    expect(normalizePersistedTimeframe(' m15 ')).toBe('M15');
    expect(normalizePersistedTimeframe('15m')).toBe('M15');
    expect(normalizePersistedTimeframe('1h')).toBe('H1');
    expect(normalizePersistedTimeframe('4h')).toBe('H4');
    expect(normalizePersistedTimeframe('1d')).toBe('D1');
    expect(normalizePersistedTimeframe('1w')).toBe('W1');
    expect(normalizePersistedTimeframe('1mn')).toBe('MN');

    localStorage.setItem(TIMEFRAME_STORAGE_KEY, '15m');
    expect(readPersistedTimeframe()).toBe('M15');
  });

  it('ignores invalid or empty values without corrupting storage', () => {
    writePersistedTimeframe('H4');
    for (const invalid of ['', '   ', 'M2', 'S15', 'INVALID', null, undefined, 15]) {
      expect(normalizePersistedTimeframe(invalid)).toBeNull();
      expect(writePersistedTimeframe(invalid)).toBeNull();
    }
    expect(localStorage.getItem(TIMEFRAME_STORAGE_KEY)).toBe('H4');

    localStorage.setItem(TIMEFRAME_STORAGE_KEY, 'M2');
    expect(readPersistedTimeframe()).toBeNull();
  });
});
