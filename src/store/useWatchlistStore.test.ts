import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useWatchlistStore } from './useWatchlistStore';

const PERSIST_KEY = 'rtx5-watchlists';

const snapshotBaseState = () => {
  const state = useWatchlistStore.getState();
  return {
    watchlists: state.watchlists.map((w) => ({ ...w, symbols: [...w.symbols] })),
    activeWatchlistId: state.activeWatchlistId,
  };
};

describe('useWatchlistStore persist merge', () => {
  const initialSnapshot = snapshotBaseState();

  beforeEach(() => {
    useWatchlistStore.setState({
      watchlists: initialSnapshot.watchlists.map((w) => ({ ...w, symbols: [...w.symbols] })),
      activeWatchlistId: initialSnapshot.activeWatchlistId,
    });
    localStorage.removeItem(PERSIST_KEY);
  });

  afterEach(() => {
    useWatchlistStore.setState({
      watchlists: initialSnapshot.watchlists.map((w) => ({ ...w, symbols: [...w.symbols] })),
      activeWatchlistId: initialSnapshot.activeWatchlistId,
    });
    localStorage.removeItem(PERSIST_KEY);
  });

  it('rejects persisted arrays and primitives without corrupting state or adding numeric keys', async () => {
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull();

    const merge = useWatchlistStore.persist.getOptions().merge!;
    const current = useWatchlistStore.getState();

    for (const badPersisted of [['majors'], [1, 2], null, undefined, 'corrupt', 42, true]) {
      const merged = merge(badPersisted, current);
      expect(merged).toBe(current);
      expect('0' in merged).toBe(false);
    }

    localStorage.setItem(PERSIST_KEY, JSON.stringify({ state: ['majors', 'crypto'], version: 0 }));
    await useWatchlistStore.persist.rehydrate();

    const state = useWatchlistStore.getState();
    expect(state.watchlists).toEqual(initialSnapshot.watchlists);
    expect(state.activeWatchlistId).toBe(initialSnapshot.activeWatchlistId);
    expect('0' in state).toBe(false);
    expect(typeof state.createWatchlist).toBe('function');
  });

  it('drops null/non-object/incomplete/whitespace watchlist items and invalid symbols while keeping valid ones', () => {
    const merge = useWatchlistStore.persist.getOptions().merge!;
    const current = useWatchlistStore.getState();

    const merged = merge(
      {
        watchlists: [
          null,
          undefined,
          123,
          'majors',
          [],
          {},
          { id: '', name: 'EmptyId' },
          { id: '   ', name: 'WhitespaceId' },
          { id: 'empty-name', name: '' },
          { id: 'whitespace-name', name: ' \t\n ' },
          { id: 99, name: 'NumericId' },
          { id: 'missing-name', symbols: ['EURUSD'] },
          {
            id: 'custom',
            name: 'Custom',
            symbols: ['EURUSD', null, 42, 'INVALID SYMBOL!', 'BTCUSD'],
            isDefault: 'not-bool',
            createdAt: 'not-number',
            updatedAt: Number.NaN,
            extraItemKey: 'ignored',
          },
        ],
      },
      current,
    );

    expect(merged.watchlists).toEqual([
      {
        id: 'custom',
        name: 'Custom',
        symbols: ['EURUSD', 'BTCUSD'],
        isDefault: false,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    expect(merged.activeWatchlistId).toBe('custom');
    expect('extraItemKey' in merged.watchlists[0]).toBe(false);
  });

  it('keeps default watchlists when persisted watchlists yields zero valid items', async () => {
    const merge = useWatchlistStore.persist.getOptions().merge!;
    const current = useWatchlistStore.getState();

    for (const emptyOrInvalid of [
      [],
      [null, undefined, 42, 'majors', {}, { id: '', name: 'NoId' }, { id: '   ', name: 'Spaces' }, { id: 'no-name', name: '   ' }],
    ]) {
      const merged = merge({ watchlists: emptyOrInvalid, activeWatchlistId: 'deleted-id' }, current);
      expect(merged.watchlists).toEqual(current.watchlists);
      expect(merged.activeWatchlistId).toBe(current.watchlists[0].id);
    }

    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          watchlists: [null, { id: '   ', name: 'Invalid' }, { id: 'missing-name', name: '  ' }],
          activeWatchlistId: 'non-existent',
        },
        version: 0,
      }),
    );

    await useWatchlistStore.persist.rehydrate();
    const state = useWatchlistStore.getState();
    expect(state.watchlists).toEqual(initialSnapshot.watchlists);
    expect(state.activeWatchlistId).toBe(initialSnapshot.watchlists[0].id);
    expect(state.getActiveWatchlist()?.id).toBe(initialSnapshot.watchlists[0].id);
  });

  it('reconciles empty, whitespace, or missing activeWatchlistId to an existing watchlist', () => {
    const merge = useWatchlistStore.persist.getOptions().merge!;
    const current = useWatchlistStore.getState();
    const customLists = [
      { id: 'alpha', name: 'Alpha', symbols: ['EURUSD'], isDefault: false, createdAt: 1, updatedAt: 2 },
      { id: 'beta', name: 'Beta', symbols: ['GBPUSD'], isDefault: false, createdAt: 3, updatedAt: 4 },
    ];

    for (const missingActiveId of ['', '   ', 'non-existent', 999, null]) {
      const merged = merge({ watchlists: customLists, activeWatchlistId: missingActiveId }, current);
      expect(merged.watchlists).toEqual(customLists);
      expect(merged.activeWatchlistId).toBe('alpha');
    }

    const validSelected = merge({ watchlists: customLists, activeWatchlistId: 'beta' }, current);
    expect(validSelected.activeWatchlistId).toBe('beta');

    const fallbackWithExistingDefault = merge({ watchlists: [], activeWatchlistId: 'crypto' }, current);
    expect(fallbackWithExistingDefault.watchlists).toEqual(current.watchlists);
    expect(fallbackWithExistingDefault.activeWatchlistId).toBe('crypto');
  });

  it('keeps current watchlists when persisted watchlists is not an array and rejects non-string activeWatchlistId', () => {
    const merge = useWatchlistStore.persist.getOptions().merge!;
    const current = useWatchlistStore.getState();

    for (const badActiveId of [123, null, {}, ['majors'], false]) {
      const merged = merge({ watchlists: 'not-an-array', activeWatchlistId: badActiveId }, current);
      expect(merged.watchlists).toEqual(current.watchlists);
      expect(merged.activeWatchlistId).toBe(current.activeWatchlistId);
    }

    const validActive = merge({ activeWatchlistId: 'crypto' }, current);
    expect(validActive.watchlists).toEqual(current.watchlists);
    expect(validActive.activeWatchlistId).toBe('crypto');
  });

  it('ignores extra persisted keys and never lets persisted fields overwrite store actions', async () => {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          watchlists: [
            null,
            { id: 'custom', name: 'Custom', symbols: ['EURUSD', 'BAD SYMBOL'], isDefault: false, createdAt: 10, updatedAt: 20 },
            { id: 'secondary', name: 'Secondary', symbols: ['XAUUSD'], isDefault: false, createdAt: 11, updatedAt: 21 },
          ],
          activeWatchlistId: 999,
          createWatchlist: 'overwritten-string',
          getActiveWatchlist: null,
          deleteWatchlist: { bad: true },
          extraInjectedField: 'should-not-exist',
        },
        version: 0,
      }),
    );

    await useWatchlistStore.persist.rehydrate();
    const state = useWatchlistStore.getState();

    expect(state.watchlists).toEqual([
      { id: 'custom', name: 'Custom', symbols: ['EURUSD'], isDefault: false, createdAt: 10, updatedAt: 20 },
      { id: 'secondary', name: 'Secondary', symbols: ['XAUUSD'], isDefault: false, createdAt: 11, updatedAt: 21 },
    ]);
    expect(state.activeWatchlistId).toBe('custom');
    expect(state.getActiveWatchlist()?.id).toBe('custom');
    expect('extraInjectedField' in state).toBe(false);
    expect(typeof state.createWatchlist).toBe('function');
    expect(typeof state.getActiveWatchlist).toBe('function');
    expect(typeof state.deleteWatchlist).toBe('function');

    state.setActiveWatchlist('secondary');
    expect(useWatchlistStore.getState().getActiveWatchlist()?.id).toBe('secondary');
  });
});
