// @vitest-environment jsdom

/**
 * P01 round 4 (B5): markup map identity stability and logout/account-switch clearing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import { EMPTY_SPREAD_MARKUP_MAP, buildSpreadMarkupMap } from '../utils/spreadMarkup';
import {
  getAccountSpreadMarkupMap,
  onAccountSpreadMarkupChange,
  resetAccountSpreadMarkupForTests,
  setAccountSpreadMarkups,
} from './accountSpreadMarkup';

const signIn = (accountId = '1001') => {
  useAppStore.setState({ isAuthenticated: true, accountId });
};

describe('P01 round 4 (B5): accountSpreadMarkup map identity and clearing', () => {
  beforeEach(() => {
    resetAccountSpreadMarkupForTests();
    useAppStore.setState({ isAuthenticated: false, accountId: null });
  });

  afterEach(() => {
    resetAccountSpreadMarkupForTests();
    useAppStore.setState({ isAuthenticated: false, accountId: null });
  });

  it('keeps map identity and emits no change when committing an equal map, and updates on real changes', () => {
    signIn('1001');
    const listener = vi.fn();
    const unsubscribe = onAccountSpreadMarkupChange(listener);

    const map1 = buildSpreadMarkupMap([
      { symbol: 'EURUSD', spreadMarkup: 5, tickSize: 0.00001, digits: 5 },
    ]);
    setAccountSpreadMarkups('1001', map1);
    const ref1 = getAccountSpreadMarkupMap();
    expect(ref1).toBe(map1);
    expect(listener).toHaveBeenCalledTimes(1);

    // Equal new Map instance: keeps exact same identity and does not notify.
    const map2 = buildSpreadMarkupMap([
      { symbol: 'EURUSD', spreadMarkup: 5, tickSize: 0.00001, digits: 5 },
    ]);
    expect(map2).not.toBe(map1);
    setAccountSpreadMarkups('1001', map2);
    expect(getAccountSpreadMarkupMap()).toBe(ref1);
    expect(listener).toHaveBeenCalledTimes(1);

    // Different markup: identity changes and notifies once.
    const map3 = buildSpreadMarkupMap([
      { symbol: 'EURUSD', spreadMarkup: 10, tickSize: 0.00001, digits: 5 },
    ]);
    setAccountSpreadMarkups('1001', map3);
    expect(getAccountSpreadMarkupMap()).not.toBe(ref1);
    expect(getAccountSpreadMarkupMap()).toBe(map3);
    expect(getAccountSpreadMarkupMap().get('EURUSD')?.points).toBe(10);
    expect(listener).toHaveBeenCalledTimes(2);

    // Equal map with shaping fields keeps identity; changed shaping field updates it.
    const shaped1 = buildSpreadMarkupMap([
      { symbol: 'EURUSD', spreadMarkup: 5, fixedSpreadPoints: 10, tickSize: 0.00001, digits: 5 },
    ]);
    setAccountSpreadMarkups('1001', shaped1);
    expect(listener).toHaveBeenCalledTimes(3);
    const shapedEqual = buildSpreadMarkupMap([
      { symbol: 'EURUSD', spreadMarkup: 5, fixedSpreadPoints: 10, tickSize: 0.00001, digits: 5 },
    ]);
    setAccountSpreadMarkups('1001', shapedEqual);
    expect(getAccountSpreadMarkupMap()).toBe(shaped1);
    expect(listener).toHaveBeenCalledTimes(3);

    const shapedDiff = buildSpreadMarkupMap([
      { symbol: 'EURUSD', spreadMarkup: 5, fixedSpreadPoints: 12, tickSize: 0.00001, digits: 5 },
    ]);
    setAccountSpreadMarkups('1001', shapedDiff);
    expect(getAccountSpreadMarkupMap()).toBe(shapedDiff);
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
  });

  it('clears the map to EMPTY_SPREAD_MARKUP_MAP on logout and account switch', () => {
    signIn('1001');
    const listener = vi.fn();
    const unsubscribe = onAccountSpreadMarkupChange(listener);

    setAccountSpreadMarkups('1001', buildSpreadMarkupMap([
      { symbol: 'EURUSD', spreadMarkup: 5, tickSize: 0.00001, digits: 5 },
    ]));
    expect(getAccountSpreadMarkupMap().size).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    // Logout clears synchronously.
    useAppStore.setState({ isAuthenticated: false });
    expect(getAccountSpreadMarkupMap()).toBe(EMPTY_SPREAD_MARKUP_MAP);
    expect(getAccountSpreadMarkupMap().size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);

    // Re-login and switch account clears synchronously.
    signIn('1001');
    setAccountSpreadMarkups('1001', buildSpreadMarkupMap([
      { symbol: 'EURUSD', spreadMarkup: 5, tickSize: 0.00001, digits: 5 },
    ]));
    expect(getAccountSpreadMarkupMap().size).toBe(1);
    expect(listener).toHaveBeenCalledTimes(3);

    useAppStore.setState({ accountId: '2002' });
    expect(getAccountSpreadMarkupMap()).toBe(EMPTY_SPREAD_MARKUP_MAP);
    expect(getAccountSpreadMarkupMap().size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
  });
});
