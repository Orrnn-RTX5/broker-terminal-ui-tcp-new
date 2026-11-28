// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commandBus } from '../../../services/commandBus';
import type { IndicatorManager } from '../../../services/indicatorManager';
import { defaultChartProperties } from '../../../store/useChartSettingsStore';
import { DEFAULT_TEMPLATE_COLORS, type ChartTemplate } from '../../../store/useTemplateStore';
import type { ChartType } from '../../../types/chart';
import {
  useTradingChartContextMenuController,
  useTradingChartContextMenuState,
} from './useTradingChartContextMenu';

const renderChartTypeMenuHooks = (initialChartType: ChartType = 'candlestick') => {
  const noop = vi.fn();
  const applyChartTypeInPlace = vi.fn(() => true);
  const chartSettingsRef = { current: { ...defaultChartProperties } };
  const prevTimeframeRef = { current: 'M1' as const };
  const localIndicatorManager = {
    clearAll: noop,
  } as unknown as IndicatorManager;

  const hook = renderHook(
    ({ chartType }: { chartType: ChartType }) => {
      const state = useTradingChartContextMenuState('EURUSD', chartType);
      const controller = useTradingChartContextMenuController({
        activeChartSourceId: 'chart-type-sync-test',
        activeTimeframe: 'M1',
        addLocalIndicator: () => false,
        applyChartTypeInPlace,
        chartSettingsRef,
        clearLocalIndicators: noop,
        loadHistory: async () => undefined,
        localIndicatorManager,
        persistCurrentIndicators: noop,
        prevTimeframeRef,
        refreshCurrentIndicators: noop,
        setCtxAutoScroll: state.setCtxAutoScroll,
        setCtxMenu: state.setCtxMenu,
        setCtxShowTradeHistory: state.setCtxShowTradeHistory,
        setCtxShowTradeHistoryLine: state.setCtxShowTradeHistoryLine,
        setCtxShowTradeLevels: state.setCtxShowTradeLevels,
        setLocalChartType: state.setLocalChartType,
        setTemplateDialogMode: state.setTemplateDialogMode,
        setTemplateDialogOpen: state.setTemplateDialogOpen,
        symbol: 'EURUSD',
        timeframe: 'M1',
      });
      return { state, controller };
    },
    { initialProps: { chartType: initialChartType } },
  );

  return { ...hook, applyChartTypeInPlace };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useTradingChartContextMenuState localChartType sync', () => {
  it('follows chartType back to candlestick via non-menu path after menu selects line', () => {
    vi.useFakeTimers();
    const dispatchSpy = vi.spyOn(commandBus, 'dispatch').mockImplementation(() => undefined);
    const { result, rerender, applyChartTypeInPlace } = renderChartTypeMenuHooks('candlestick');

    expect(result.current.state.localChartType).toBe('candlestick');

    act(() => {
      result.current.controller.handleCtxChartTypeChange('line');
    });

    expect(applyChartTypeInPlace).toHaveBeenCalledWith('line');
    expect(result.current.state.localChartType).toBe('line');

    act(() => {
      vi.runAllTimers();
    });
    expect(dispatchSpy).toHaveBeenCalledWith({
      type: 'SET_CHART_TYPE',
      payload: { chartType: 'line', targetContextId: 'chart-type-sync-test' },
    });

    rerender({ chartType: 'line' });
    expect(result.current.state.localChartType).toBe('line');

    // Non-menu chart type change (e.g. TopToolbar or Alt+2 shortcut) updates the prop directly.
    rerender({ chartType: 'candlestick' });
    expect(result.current.state.localChartType).toBe('candlestick');
  });

  it('follows chartType back to candlestick via non-menu path after template load sets area', () => {
    vi.spyOn(commandBus, 'dispatch').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { result, rerender } = renderChartTypeMenuHooks('candlestick');

    const template: ChartTemplate = {
      id: 'area-template',
      name: 'Area Template',
      chartType: 'area',
      timeframe: 'M1',
      showGrid: true,
      showVolumes: false,
      indicators: [],
      drawingTools: [],
      colors: DEFAULT_TEMPLATE_COLORS,
      createdAt: 1,
    };

    act(() => {
      result.current.controller.handleLoadTemplate(template);
    });
    expect(result.current.state.localChartType).toBe('area');

    rerender({ chartType: 'area' });
    expect(result.current.state.localChartType).toBe('area');

    rerender({ chartType: 'candlestick' });
    expect(result.current.state.localChartType).toBe('candlestick');
  });
});
