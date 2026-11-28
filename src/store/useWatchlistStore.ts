/**
 * Watchlist Store with Zustand
 * Manages custom symbol watchlists with persistence
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { filterSymbolsExactlyInUniverse } from '../utils/accountSymbolUniverse';

export interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

interface WatchlistState {
  watchlists: Watchlist[];
  activeWatchlistId: string;

  // Actions
  createWatchlist: (name: string, symbols?: string[]) => void;
  deleteWatchlist: (id: string) => void;
  renameWatchlist: (id: string, newName: string) => void;
  setActiveWatchlist: (id: string) => void;
  addSymbolToWatchlist: (watchlistId: string, symbol: string) => void;
  removeSymbolFromWatchlist: (watchlistId: string, symbol: string) => void;
  reorderSymbols: (watchlistId: string, symbols: string[]) => void;
  moveSymbol: (fromWatchlistId: string, toWatchlistId: string, symbol: string) => void;
  sanitizeSymbols: (allowedSymbols: string[]) => void;
  getActiveWatchlist: () => Watchlist | undefined;
  getWatchlistById: (id: string) => Watchlist | undefined;
}

// Default watchlists
const DEFAULT_WATCHLISTS: Watchlist[] = [
  {
    id: 'majors',
    name: 'Majors',
    symbols: [],
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'minors',
    name: 'Minors',
    symbols: [],
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'crypto',
    name: 'Crypto',
    symbols: [],
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'metals',
    name: 'Metals',
    symbols: [],
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

export const useWatchlistStore = create<WatchlistState>()(
  devtools(
    persist(
      (set, get) => ({
        watchlists: DEFAULT_WATCHLISTS,
        activeWatchlistId: 'majors',

        createWatchlist: (name, symbols = []) => {
          const cleanSymbols = symbols.filter(s => typeof s === 'string' && s.length <= 20 && /^[A-Za-z0-9._-]+$/.test(s));
          const id = `watchlist-${Date.now()}`;
          const newWatchlist: Watchlist = {
            id,
            name,
            symbols: cleanSymbols,
            isDefault: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };

          set((state) => ({
            watchlists: [...state.watchlists, newWatchlist],
          }));
        },

        deleteWatchlist: (id) => {
          const watchlist = get().getWatchlistById(id);

          // Prevent deletion of default watchlists
          if (watchlist?.isDefault) {
            console.warn('Cannot delete default watchlist');
            return;
          }

          set((state) => {
            const filtered = state.watchlists.filter((w) => w.id !== id);

            // If deleting active watchlist, switch to first available
            const newActiveId = state.activeWatchlistId === id && filtered.length > 0
              ? filtered[0].id
              : state.activeWatchlistId;

            return {
              watchlists: filtered,
              activeWatchlistId: newActiveId,
            };
          });
        },

        renameWatchlist: (id, newName) => {
          const watchlist = get().getWatchlistById(id);

          // Prevent renaming of default watchlists
          if (watchlist?.isDefault) {
            console.warn('Cannot rename default watchlist');
            return;
          }

          set((state) => ({
            watchlists: state.watchlists.map((w) =>
              w.id === id
                ? { ...w, name: newName, updatedAt: Date.now() }
                : w
            ),
          }));
        },

        setActiveWatchlist: (id) => {
          const watchlist = get().getWatchlistById(id);
          if (watchlist) {
            set({ activeWatchlistId: id });
          }
        },

        addSymbolToWatchlist: (watchlistId, symbol) => {
          if (!symbol || typeof symbol !== 'string' || symbol.length > 20 || !/^[A-Za-z0-9._-]+$/.test(symbol)) {
            console.warn('[Watchlist] Rejected invalid symbol string:', symbol);
            return;
          }
          set((state) => ({
            watchlists: state.watchlists.map((w) =>
              w.id === watchlistId && !w.symbols.includes(symbol)
                ? { ...w, symbols: [...w.symbols, symbol], updatedAt: Date.now() }
                : w
            ),
          }));
        },

        removeSymbolFromWatchlist: (watchlistId, symbol) => {
          set((state) => ({
            watchlists: state.watchlists.map((w) =>
              w.id === watchlistId
                ? { ...w, symbols: w.symbols.filter((s) => s !== symbol), updatedAt: Date.now() }
                : w
            ),
          }));
        },

        reorderSymbols: (watchlistId, symbols) => {
          const cleanSymbols = symbols.filter(s => typeof s === 'string' && s.length <= 20 && /^[A-Za-z0-9._-]+$/.test(s));
          set((state) => ({
            watchlists: state.watchlists.map((w) =>
              w.id === watchlistId
                ? { ...w, symbols: cleanSymbols, updatedAt: Date.now() }
                : w
            ),
          }));
        },

        moveSymbol: (fromWatchlistId, toWatchlistId, symbol) => {
          set((state) => {
            const fromWatchlist = state.watchlists.find((w) => w.id === fromWatchlistId);
            const toWatchlist = state.watchlists.find((w) => w.id === toWatchlistId);

            if (!fromWatchlist || !toWatchlist) return state;
            if (!fromWatchlist.symbols.includes(symbol)) return state;
            if (toWatchlist.symbols.includes(symbol)) return state;

            return {
              watchlists: state.watchlists.map((w) => {
                if (w.id === fromWatchlistId) {
                  return {
                    ...w,
                    symbols: w.symbols.filter((s) => s !== symbol),
                    updatedAt: Date.now(),
                  };
                }
                if (w.id === toWatchlistId) {
                  return {
                    ...w,
                    symbols: [...w.symbols, symbol],
                    updatedAt: Date.now(),
                  };
                }
                return w;
              }),
            };
          });
        },

        // Destructive prune of the persisted (cross-account) watchlists. Market
        // Watch deliberately filters on display instead (see
        // pruneSymbolsToUniverse) so another account's rows and the remote
        // watchlist are never deleted by a narrower group catalogue.
        sanitizeSymbols: (allowedSymbols) => {
          set((state) => {
            let changed = false;
            const watchlists = state.watchlists.map((watchlist) => {
              const symbols = filterSymbolsExactlyInUniverse(watchlist.symbols, allowedSymbols);
              if (symbols.length === watchlist.symbols.length) return watchlist;
              changed = true;
              return { ...watchlist, symbols, updatedAt: Date.now() };
            });
            return changed ? { watchlists } : state;
          });
        },

        getActiveWatchlist: () => {
          const state = get();
          return state.watchlists.find((w) => w.id === state.activeWatchlistId);
        },

        getWatchlistById: (id) => {
          const state = get();
          return state.watchlists.find((w) => w.id === id);
        },
      }),
      {
        name: 'rtx5-watchlists',
        merge: (persisted: unknown, currentState: WatchlistState) => {
          const isPlainObject = (value: unknown): value is Record<string, unknown> => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            const proto = Object.getPrototypeOf(value);
            return proto === Object.prototype || proto === null;
          };

          if (!isPlainObject(persisted)) return currentState;

          const isValidSymbol = (s: unknown): s is string => typeof s === 'string' && s.length <= 20 && /^[A-Za-z0-9._-]+$/.test(s);
          const isValidWatchlistItem = (
            item: unknown
          ): item is Record<string, unknown> & { id: string; name: string } =>
            isPlainObject(item) &&
            typeof item.id === 'string' &&
            item.id.trim().length > 0 &&
            typeof item.name === 'string' &&
            item.name.trim().length > 0;

          const parsedWatchlists: Watchlist[] = Array.isArray(persisted.watchlists)
            ? persisted.watchlists
                .filter(isValidWatchlistItem)
                .map((w) => ({
                  id: w.id,
                  name: w.name,
                  symbols: (Array.isArray(w.symbols) ? w.symbols : []).filter(isValidSymbol),
                  isDefault: typeof w.isDefault === 'boolean' ? w.isDefault : false,
                  createdAt: typeof w.createdAt === 'number' && Number.isFinite(w.createdAt) ? w.createdAt : 0,
                  updatedAt: typeof w.updatedAt === 'number' && Number.isFinite(w.updatedAt) ? w.updatedAt : 0,
                }))
            : [];

          const watchlists = parsedWatchlists.length > 0 ? parsedWatchlists : currentState.watchlists;

          const candidateActiveId = typeof persisted.activeWatchlistId === 'string'
            ? persisted.activeWatchlistId
            : currentState.activeWatchlistId;
          const activeWatchlistId =
            candidateActiveId.trim().length > 0 && watchlists.some((w) => w.id === candidateActiveId)
              ? candidateActiveId
              : watchlists[0]?.id ?? currentState.activeWatchlistId;

          return {
            ...currentState,
            watchlists,
            activeWatchlistId,
          };
        }
      }
    ),
    { name: 'watchlist-store' }
  )
);
