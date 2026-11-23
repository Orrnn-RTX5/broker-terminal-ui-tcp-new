// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { defaultChartProperties } from '../../../store/useChartSettingsStore';
import { useChartZoomStore } from '../../../store/useChartZoomStore';
import type { Timeframe } from '../../../types/chart';
import type { LogicalRangeLike } from '../../../utils/candleHistory';
import { shouldScrollToRealtime } from './chartRuntime';
import { useTradingChartViewportReset } from './useTradingChartViewportReset';

afterEach(() => {
  cleanup();
  useChartZoomStore.setState({ byContext: {} });
});

const createFixture = (chartShift: boolean, timeframe: Timeframe = 'M1') => {
  let latestIndex = 499;
  let range: LogicalRangeLike = { from: 460, to: 499 };
  const timeScale = {
    applyOptions: vi.fn(),
    getVisibleLogicalRange: () => range,
    setVisibleLogicalRange: vi.fn((next: LogicalRangeLike) => { range = next; }),
    scrollPosition: () => range.to - latestIndex,
  };
  const chart = { timeScale: () => timeScale, priceScale: () => ({ width: () => 60 }) } as unknown as IChartApi;
  const settingsRef = { current: { ...defaultChartProperties, chartShift } };
  const remembered = { current: null as LogicalRangeLike | null };
  const { result } = renderHook(() => useTradingChartViewportReset({
    chartRef: { current: chart },
    chartSettingsRef: settingsRef,
    containerRef: { current: { offsetWidth: 1000 } as HTMLDivElement },
    contextId: 'viewport-test',
    isDisposedRef: { current: false },
    lastRenderedCandlesRef: { current: [] },
    lastVisibleLogicalRangeRef: remembered,
    seriesRef: { current: null },
    timeframe,
  }));
  return { result, chart, timeScale, settingsRef, remembered, getRange: () => range, setLatestIndex: (index: number) => { latestIndex = index; } };
};

describe('latest candle viewport', () => {
  it.each(['M1', 'H1', 'D1', 'W1', 'MN'] as Timeframe[])('starts %s at the latest candle and follows live updates with either shift setting', (timeframe) => {
    for (const chartShift of [false, true]) {
      const fixture = createFixture(chartShift, timeframe);
      act(() => {
        expect(fixture.result.current.applyInitialVisibleLogicalRange(fixture.chart, 500, timeframe)).toBe(true);
      });
      expect(fixture.timeScale.scrollPosition()).toBe(chartShift ? 8 : 0);
      expect(fixture.getRange().from).toBeLessThan(499);
      expect(fixture.getRange().to).toBeGreaterThanOrEqual(499);
      expect(fixture.remembered.current).toEqual(fixture.getRange());
      expect(shouldScrollToRealtime(fixture.chart, true, true, chartShift ? 8 : 0)).toBe(true);
    }
  });

  it('uses a changed Chart Shift setting when the viewport resets again', () => {
    const fixture = createFixture(false);
    act(() => { fixture.result.current.applyInitialVisibleLogicalRange(fixture.chart, 500, 'M1'); });
    const originalSpan = fixture.getRange().to - fixture.getRange().from;
    fixture.settingsRef.current = { ...fixture.settingsRef.current, chartShift: true };
    act(() => { fixture.result.current.applyInitialVisibleLogicalRange(fixture.chart, 500, 'M1'); });
    expect(fixture.timeScale.scrollPosition()).toBe(8);
    expect(fixture.getRange().to - fixture.getRange().from).toBe(originalSpan + 8);
  });

  it('keeps the first sparse live candle inside the plot and leaves an empty chart alone', () => {
    const fixture = createFixture(false);
    fixture.setLatestIndex(0);
    act(() => { fixture.result.current.applyInitialVisibleLogicalRange(fixture.chart, 1, 'M1'); });
    expect(fixture.getRange().to).toBe(0);
    expect(fixture.getRange().from).toBeLessThan(0);
    fixture.timeScale.setVisibleLogicalRange.mockClear();
    act(() => { expect(fixture.result.current.applyInitialVisibleLogicalRange(fixture.chart, 0, 'M1')).toBe(false); });
    expect(fixture.timeScale.setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('uses the default 10px candle density on initial load, wide viewports, and Reset Layout', () => {
    const fixture = createFixture(false, 'M1');
    act(() => { fixture.result.current.applyInitialVisibleLogicalRange(fixture.chart, 500, 'M1'); });
    // (1000px container - 60px price scale) / 10px TARGET_BAR_PX = 94 visible bars
    expect(fixture.getRange()).toEqual({ from: 406, to: 499 });

    // barSpacing must be explicitly reset to TARGET_BAR_PX (10) AFTER
    // setVisibleLogicalRange so the candle width is always the same on
    // initial load, Reset Layout, and viewport reset.
    expect(fixture.timeScale.applyOptions).toHaveBeenCalledWith({ barSpacing: 10 });
    const applyOrder = fixture.timeScale.applyOptions.mock.invocationCallOrder[0];
    const rangeOrder = fixture.timeScale.setVisibleLogicalRange.mock.invocationCallOrder[0];
    expect(applyOrder).toBeGreaterThan(rangeOrder);

    // Wide desktop charts must stay at 10px candle density rather than clamping at 200 bars.
    const wideFixture = renderHook(() => useTradingChartViewportReset({
      chartRef: { current: fixture.chart },
      chartSettingsRef: fixture.settingsRef,
      containerRef: { current: { offsetWidth: 1920 } as HTMLDivElement },
      contextId: 'viewport-wide-test',
      isDisposedRef: { current: false },
      lastRenderedCandlesRef: { current: Array.from({ length: 500 }, (_, i) => ({ time: i + 1, open: 1, high: 1, low: 1, close: 1, volume: 1 })) },
      lastVisibleLogicalRangeRef: { current: null },
      seriesRef: { current: null },
      timeframe: 'M1',
    }));
    act(() => { wideFixture.result.current.applyInitialVisibleLogicalRange(fixture.chart, 500, 'M1'); });
    // (1920px container - 60px price scale) / 10px TARGET_BAR_PX = 186 visible bars
    expect(fixture.getRange()).toEqual({ from: 314, to: 499 });

    // Zooming away and triggering Reset Layout restores the exact same 10px candle density.
    act(() => { fixture.timeScale.setVisibleLogicalRange({ from: 470, to: 499 }); });
    act(() => { window.dispatchEvent(new Event('resetLayout')); });
    expect(fixture.getRange()).toEqual({ from: 314, to: 499 });
  });
});
