import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Pointer modes from the TradingView Cursors flyout. */
export type ChartCursorMode = 'cross' | 'dot' | 'arrow' | 'demonstration' | 'eraser';

const VALID_CHART_CURSOR_MODES: ReadonlySet<string> = new Set<ChartCursorMode>([
  'cross',
  'dot',
  'arrow',
  'demonstration',
  'eraser',
]);

export interface ChartCursorState {
  mode: ChartCursorMode;
  /** Floating OHLC tooltip while the chart pointer is held down. Default on, matching TradingView. */
  valuesTooltipOnLongPress: boolean;
  setMode: (mode: ChartCursorMode) => void;
  setValuesTooltipOnLongPress: (enabled: boolean) => void;
}

export const chartCursorShowsCrosshair = (mode: ChartCursorMode): boolean =>
  mode === 'cross' || mode === 'dot';

export const useChartCursorStore = create<ChartCursorState>()(
  persist((set) => ({
    mode: 'cross',
    valuesTooltipOnLongPress: true,
    setMode: (mode) => set({ mode }),
    setValuesTooltipOnLongPress: (enabled) => set({ valuesTooltipOnLongPress: enabled }),
  }), {
    name: 'rtx-chart-cursor-mode',
    merge: (persisted, current) => {
      if (!persisted || typeof persisted !== 'object') return current;
      const next = persisted as Partial<ChartCursorState>;
      const mode = typeof next.mode === 'string' && VALID_CHART_CURSOR_MODES.has(next.mode)
        ? (next.mode as ChartCursorMode)
        : current.mode;
      const valuesTooltipOnLongPress = typeof next.valuesTooltipOnLongPress === 'boolean'
        ? next.valuesTooltipOnLongPress
        : current.valuesTooltipOnLongPress;
      return {
        ...current,
        ...next,
        mode,
        valuesTooltipOnLongPress,
      };
    },
  }),
);
