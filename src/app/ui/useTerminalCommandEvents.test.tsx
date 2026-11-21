import { useState, type Dispatch, type SetStateAction } from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChartType, Timeframe } from '../../types/chart';
import {
  useTerminalCommandEvents,
  type ChartObjectsTarget,
  type ChartSymbolPickerState,
} from './useTerminalCommandEvents';

const setter = <T,>(): Dispatch<SetStateAction<T>> => vi.fn();

describe('useTerminalCommandEvents', () => {
  it('owns floating-window toggle listeners and removes them on cleanup', () => {
    const useHarness = () => {
      const [showDataWindow, setShowDataWindow] = useState(false);
      const [showAccountPanel, setShowAccountPanel] = useState(false);
      useTerminalCommandEvents({
        selectedSymbol: 'EURUSD',
        setSelectedSymbol: setter<string>(),
        timeframe: 'M1' as Timeframe,
        setTimeframe: setter<Timeframe>(),
        chartType: 'candlestick' as ChartType,
        setChartType: setter<ChartType>(),
        chartEligibleSymbolNames: ['EURUSD'],
        displayToast: vi.fn(),
        placeOrder: vi.fn(),
        handleOpenDOM: vi.fn(),
        handleSaveWorkspace: vi.fn(),
        handleOpenDataFolder: vi.fn(),
        handlePrintChart: vi.fn(),
        getAllowedSymbol: () => 'EURUSD',
        getChartEligibleSymbol: () => 'EURUSD',
        openOrderPanelForSymbol: vi.fn(),
        setShowDataWindow,
        setShowAccountPanel,
        setDockHeight: setter<number>(),
        setChartSymbolPicker: setter<ChartSymbolPickerState | null>(),
        setShowChartProperties: setter<boolean>(),
        setChartPropsSymbol: setter<string>(),
        setChartPropsTimeframe: setter<string>(),
        setChartPropsContextId: setter<string | undefined>(),
        setChartObjectsTarget: setter<ChartObjectsTarget | null>(),
      });
      return { showDataWindow, showAccountPanel };
    };

    const { result, unmount } = renderHook(useHarness);
    act(() => {
      window.dispatchEvent(new Event('openDataWindow'));
      window.dispatchEvent(new Event('toggleAccountPanel'));
    });
    expect(result.current).toEqual({ showDataWindow: true, showAccountPanel: true });

    unmount();
    expect(() => {
      window.dispatchEvent(new Event('openDataWindow'));
      window.dispatchEvent(new Event('toggleAccountPanel'));
    }).not.toThrow();
  });

  it('persists the active symbol and timeframe in localStorage on chart events so hard refresh and reopen restore them for all symbols', () => {
    localStorage.clear();
    const setSelectedSymbol = vi.fn();
    const setTimeframe = vi.fn();
    const symbols = ['BTCUSD', 'XAUUSD', 'EURUSD', 'ETHUSD'];

    const useHarness = () => {
      useTerminalCommandEvents({
        selectedSymbol: 'BTCUSD',
        setSelectedSymbol,
        timeframe: 'M1' as Timeframe,
        setTimeframe,
        chartType: 'candlestick' as ChartType,
        setChartType: setter<ChartType>(),
        chartEligibleSymbolNames: symbols,
        displayToast: vi.fn(),
        placeOrder: vi.fn(),
        handleOpenDOM: vi.fn(),
        handleSaveWorkspace: vi.fn(),
        handleOpenDataFolder: vi.fn(),
        handlePrintChart: vi.fn(),
        getAllowedSymbol: (symbol) => String(symbol || '').trim().toUpperCase(),
        getChartEligibleSymbol: (symbol) => {
          const normalized = String(symbol || '').trim().toUpperCase();
          return symbols.includes(normalized) ? normalized : '';
        },
        openOrderPanelForSymbol: vi.fn(),
        setShowDataWindow: setter<boolean>(),
        setShowAccountPanel: setter<boolean>(),
        setDockHeight: setter<number>(),
        setChartSymbolPicker: setter<ChartSymbolPickerState | null>(),
        setShowChartProperties: setter<boolean>(),
        setChartPropsSymbol: setter<string>(),
        setChartPropsTimeframe: setter<string>(),
        setChartPropsContextId: setter<string | undefined>(),
        setChartObjectsTarget: setter<ChartObjectsTarget | null>(),
      });
    };

    const { unmount } = renderHook(useHarness);
    act(() => {
      window.dispatchEvent(new CustomEvent('chartSymbolChanged', {
        detail: { symbol: 'xauusd', timeframe: 'M15' },
      }));
    });

    expect(setSelectedSymbol).toHaveBeenCalledWith('XAUUSD');
    expect(localStorage.getItem('rtx5_selected_symbol')).toBe('XAUUSD');
    expect(setTimeframe).toHaveBeenCalledWith('M15');
    expect(localStorage.getItem('rtx5_timeframe')).toBe('M15');

    act(() => {
      window.dispatchEvent(new CustomEvent('change-timeframe', {
        detail: { timeframe: 'H4' },
      }));
    });

    expect(setTimeframe).toHaveBeenLastCalledWith('H4');
    expect(localStorage.getItem('rtx5_timeframe')).toBe('H4');

    act(() => {
      window.dispatchEvent(new CustomEvent('openChart', {
        detail: { symbol: 'eurusd' },
      }));
    });

    expect(setSelectedSymbol).toHaveBeenLastCalledWith('EURUSD');
    expect(localStorage.getItem('rtx5_selected_symbol')).toBe('EURUSD');
    unmount();
  });
});
