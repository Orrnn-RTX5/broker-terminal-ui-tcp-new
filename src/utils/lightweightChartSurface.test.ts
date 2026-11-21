import { describe, expect, it, vi } from 'vitest';
import { refreshLightweightChartSurface } from './lightweightChartSurface';

describe('refreshLightweightChartSurface', () => {
  it('forces a same-size repaint while preserving active autoSize', () => {
    const chart = {
      autoSizeActive: vi.fn(() => true),
      applyOptions: vi.fn(),
      resize: vi.fn(),
      chartElement: () => ({ style: { width: '900px', height: '502px' } }),
    };

    expect(refreshLightweightChartSurface(chart as never, 901.8, 503.4)).toBe(true);
    expect(chart.applyOptions.mock.calls).toEqual([
      [{ autoSize: false, width: 901, height: 503 }],
      [{}],
      [{ autoSize: true }],
    ]);
    expect(chart.resize).toHaveBeenCalledWith(901, 503, true);
  });

  it('forces repaint directly when autoSize is already inactive', () => {
    const chart = {
      autoSizeActive: vi.fn(() => false),
      applyOptions: vi.fn(),
      resize: vi.fn(),
    };

    expect(refreshLightweightChartSurface(chart as never, 800, 420)).toBe(true);
    expect(chart.resize).toHaveBeenCalledWith(800, 420, true);
    expect(chart.applyOptions).toHaveBeenCalledOnce();
    expect(chart.applyOptions).toHaveBeenCalledWith({});
  });

  it('leaves an already-sized surface and its ResizeObserver alone during repeated activation checks', () => {
    const chart = {
      autoSizeActive: vi.fn(() => true),
      applyOptions: vi.fn(),
      resize: vi.fn(),
      chartElement: () => ({ style: { width: '900px', height: '502px' } }),
    };

    for (let pass = 0; pass < 5; pass++) {
      expect(refreshLightweightChartSurface(chart as never, 901.8, 503.4, { forceRepaint: false })).toBe(true);
    }
    expect(chart.autoSizeActive).not.toHaveBeenCalled();
    expect(chart.applyOptions).not.toHaveBeenCalled();
    expect(chart.resize).not.toHaveBeenCalled();
  });

  it('does not oscillate when offsetWidth rounds a fractional box 2px above ResizeObserver even flooring', () => {
    const chart = {
      autoSizeActive: vi.fn(() => true),
      applyOptions: vi.fn(),
      resize: vi.fn(),
      chartElement: () => ({ style: { width: '1104px', height: '596px' } }),
    };

    expect(refreshLightweightChartSurface(chart as never, 1106, 596, { forceRepaint: false })).toBe(true);
    expect(chart.autoSizeActive).not.toHaveBeenCalled();
    expect(chart.applyOptions).not.toHaveBeenCalled();
    expect(chart.resize).not.toHaveBeenCalled();
  });

  it('repairs changed dimensions once, then skips unchanged follow-up frames', () => {
    const style = { width: '900px', height: '502px' };
    const chart = {
      autoSizeActive: vi.fn(() => true),
      applyOptions: vi.fn(),
      resize: vi.fn((width: number, height: number) => {
        style.width = `${width - width % 2}px`;
        style.height = `${height - height % 2}px`;
      }),
      chartElement: () => ({ style }),
    };

    expect(refreshLightweightChartSurface(chart as never, 450, 300, { forceRepaint: false })).toBe(true);
    expect(chart.resize).toHaveBeenCalledExactlyOnceWith(450, 300, true);
    expect(chart.applyOptions).toHaveBeenLastCalledWith({ autoSize: true });
    chart.resize.mockClear();
    chart.applyOptions.mockClear();
    expect(refreshLightweightChartSurface(chart as never, 450, 300, { forceRepaint: false })).toBe(true);
    expect(chart.resize).not.toHaveBeenCalled();
    expect(chart.applyOptions).not.toHaveBeenCalled();

    // Theme changes still repaint an unchanged canvas, including after a
    // successful ordinary resize. They must never use the dimension shortcut.
    expect(refreshLightweightChartSurface(chart as never, 450, 300, { forceRepaint: true })).toBe(true);
    expect(chart.resize).toHaveBeenCalledExactlyOnceWith(450, 300, true);
    expect(chart.applyOptions).toHaveBeenCalledTimes(3);
  });

  it('retains the repair path if chart dimensions are unavailable', () => {
    const chart = {
      autoSizeActive: vi.fn(() => true),
      applyOptions: vi.fn(),
      resize: vi.fn(),
    };

    expect(refreshLightweightChartSurface(chart as never, 900, 500, { forceRepaint: false })).toBe(true);
    expect(chart.resize).toHaveBeenCalledExactlyOnceWith(900, 500, true);
    expect(chart.applyOptions).toHaveBeenLastCalledWith({ autoSize: true });
  });

  it('ignores zero-size containers without touching the chart', () => {
    const chart = {
      autoSizeActive: vi.fn(() => true),
      applyOptions: vi.fn(),
      resize: vi.fn(),
    };

    expect(refreshLightweightChartSurface(chart as never, 0, 420)).toBe(false);
    expect(chart.autoSizeActive).not.toHaveBeenCalled();
    expect(chart.resize).not.toHaveBeenCalled();
  });

  it('restores autoSize when repaint races with chart disposal', () => {
    const chart = {
      autoSizeActive: vi.fn(() => true),
      applyOptions: vi.fn(),
      resize: vi.fn(() => { throw new Error('disposed'); }),
    };

    expect(refreshLightweightChartSurface(chart as never, 900, 500)).toBe(false);
    expect(chart.applyOptions).toHaveBeenLastCalledWith({ autoSize: true });
  });

  it('keeps outer 100%/100% autoSize host untouched on mount when child table already matches', () => {
    const outerStyle = { width: '100%', height: '100%' };
    const tableStyle = { width: '1118px', height: '624px' };
    const chart = {
      autoSizeActive: vi.fn(() => true),
      applyOptions: vi.fn(),
      resize: vi.fn(),
      chartElement: () => ({ style: outerStyle, firstElementChild: { style: tableStyle } }),
    };

    expect(refreshLightweightChartSurface(chart as never, 1118, 624, { forceRepaint: false })).toBe(true);
    expect(chart.autoSizeActive).not.toHaveBeenCalled();
    expect(chart.applyOptions).not.toHaveBeenCalled();
    expect(chart.resize).not.toHaveBeenCalled();
    expect(outerStyle).toEqual({ width: '100%', height: '100%' });
  });

  it('restores outer 100%/100% host dimensions after forced repaint or stale-outer clipping repair', () => {
    const outerStyle = { width: '100%', height: '100%' };
    const tableStyle = { width: '1118px', height: '624px' };
    const chart = {
      autoSizeActive: vi.fn(() => true),
      applyOptions: vi.fn(),
      resize: vi.fn((width: number, height: number) => {
        // Simulates lightweight-charts stamping fixed px onto both outer host and table while autoSize=false
        const w = `${width - width % 2}px`;
        const h = `${height - height % 2}px`;
        outerStyle.width = w;
        outerStyle.height = h;
        tableStyle.width = w;
        tableStyle.height = h;
      }),
      chartElement: () => ({ style: outerStyle, firstElementChild: { style: tableStyle } }),
    };

    expect(refreshLightweightChartSurface(chart as never, 1118, 624, { forceRepaint: true })).toBe(true);
    expect(outerStyle).toEqual({ width: '100%', height: '100%' });
    expect(tableStyle).toEqual({ width: '1118px', height: '624px' });

    // Even if the outer host was stuck at stale pixels while autoSize already resized the table, repair restores 100%/100%
    outerStyle.width = '1118px';
    outerStyle.height = '624px';
    tableStyle.width = '1440px';
    tableStyle.height = '874px';
    chart.resize.mockImplementationOnce(() => {
      // Simulates lightweight-charts early-returning when _width/_height already match 1440x874
    });

    expect(refreshLightweightChartSurface(chart as never, 1440, 874, { forceRepaint: false })).toBe(true);
    expect(outerStyle).toEqual({ width: '100%', height: '100%' });
  });
});
