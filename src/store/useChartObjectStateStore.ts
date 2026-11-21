import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { SESSION_VIEW_KEYS } from '../services/sessionViewState';

export interface ChartObjectState {
  drawingsHidden: boolean;
  indicatorsHidden: boolean;
  tradesHidden: boolean;
  drawingsLocked: boolean;
  indicatorsLocked: boolean;
}

export const defaultChartObjectState: ChartObjectState = {
  drawingsHidden: false,
  indicatorsHidden: false,
  tradesHidden: false,
  drawingsLocked: false,
  indicatorsLocked: false,
};

interface ChartObjectStateStore {
  byContext: Record<string, ChartObjectState>;
  setDrawingsHidden: (contextId: string, hidden: boolean) => void;
  setIndicatorsHidden: (contextId: string, hidden: boolean) => void;
  setTradesHidden: (contextId: string, hidden: boolean) => void;
  setAllHidden: (contextId: string, hidden: boolean) => void;
  setDrawingsLocked: (contextId: string, locked: boolean) => void;
  setIndicatorsLocked: (contextId: string, locked: boolean) => void;
  setAllLocked: (contextId: string, locked: boolean) => void;
  resetAll: () => void;
}

const patchContext = (
  byContext: Record<string, ChartObjectState>,
  contextId: string,
  patch: Partial<ChartObjectState>,
): Record<string, ChartObjectState> => ({
  ...byContext,
  [contextId]: {
    ...defaultChartObjectState,
    ...byContext[contextId],
    ...patch,
  },
});

export const getChartObjectState = (
  byContext: Record<string, ChartObjectState>,
  contextId: string | null | undefined,
): ChartObjectState => (contextId ? byContext[contextId] ?? defaultChartObjectState : defaultChartObjectState);

export const useChartObjectStateStore = create<ChartObjectStateStore>()(
  persist(
    (set) => ({
      byContext: {},
      setDrawingsHidden: (contextId, drawingsHidden) =>
        set((state) => ({ byContext: patchContext(state.byContext, contextId, { drawingsHidden }) })),
      setIndicatorsHidden: (contextId, indicatorsHidden) =>
        set((state) => ({ byContext: patchContext(state.byContext, contextId, { indicatorsHidden }) })),
      setTradesHidden: (contextId, tradesHidden) =>
        set((state) => ({ byContext: patchContext(state.byContext, contextId, { tradesHidden }) })),
      setAllHidden: (contextId, hidden) =>
        set((state) => ({
          byContext: patchContext(state.byContext, contextId, {
            drawingsHidden: hidden,
            indicatorsHidden: hidden,
            tradesHidden: hidden,
          }),
        })),
      setDrawingsLocked: (contextId, drawingsLocked) =>
        set((state) => ({ byContext: patchContext(state.byContext, contextId, { drawingsLocked }) })),
      setIndicatorsLocked: (contextId, indicatorsLocked) =>
        set((state) => ({ byContext: patchContext(state.byContext, contextId, { indicatorsLocked }) })),
      setAllLocked: (contextId, locked) =>
        set((state) => ({
          byContext: patchContext(state.byContext, contextId, {
            drawingsLocked: locked,
            indicatorsLocked: locked,
          }),
        })),
      resetAll: () => set({ byContext: {} }),
    }),
    {
      name: SESSION_VIEW_KEYS.chartObjectState,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ byContext: state.byContext }),
    },
  ),
);
