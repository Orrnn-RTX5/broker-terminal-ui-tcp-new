import { describe, expect, it, vi } from 'vitest';
import type { Coordinate, IChartApi, Time } from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import {
  computeVolumeBarSpacingBitmap,
  computeVolumeBarVerticalBounds,
  computeVolumeBarWidthBitmap,
  computeVolumeSpikeWidthBitmap,
  createChartVolumeSeries,
  isCurrentChartVolumeSeries,
  Mt5VolumeSeriesView,
  resolveChartVolumeSeriesStyle,
  TradingViewVolumeSeriesView,
  VOLUME_SCALE_MARGINS,
  VOLUME_SPIKE_SCALE_MARGINS,
  type VolumeBarDatum,
} from './chartVolumeSeries';

const createMockRenderHarness = (
  bitmapSize = { width: 800, height: 600 },
  horizontalPixelRatio = 1,
  verticalPixelRatio = 1,
) => {
  const fillRect = vi.fn();
  const fillStyles: string[] = [];
  const context = {
    fillRect,
    set fillStyle(value: string) {
      fillStyles.push(value);
    },
    get fillStyle() {
      return fillStyles[fillStyles.length - 1] ?? '';
    },
  } as unknown as CanvasRenderingContext2D;

  const target = {
    useBitmapCoordinateSpace: (
      callback: (scope: {
        context: CanvasRenderingContext2D;
        bitmapSize: { width: number; height: number };
        horizontalPixelRatio: number;
        verticalPixelRatio: number;
      }) => void,
    ) => {
      callback({
        context,
        bitmapSize,
        horizontalPixelRatio,
        verticalPixelRatio,
      });
    },
  } as unknown as CanvasRenderingTarget2D;

  return { fillRect, fillStyles, target };
};

describe('chartVolumeSeries', () => {
  it('maps candlestick to columns, bar/line to thin vertical spikes, and area to hidden', () => {
    expect(resolveChartVolumeSeriesStyle('candlestick')).toBe('columns');
    expect(resolveChartVolumeSeriesStyle('bar')).toBe('spikes');
    expect(resolveChartVolumeSeriesStyle('line')).toBe('spikes');
    expect(resolveChartVolumeSeriesStyle('area')).toBe('none');
  });

  it('computes TradingView-style full histogram column widths and 1 CSS px spacing across DPR and zoom levels', () => {
    // 4 CSS px bar pitch (TradingView daily overview) -> 3px column + 1px gap
    expect(computeVolumeBarSpacingBitmap(4, 1)).toBe(1);
    expect(computeVolumeBarWidthBitmap(4, 1)).toBe(3);
    expect(computeVolumeBarSpacingBitmap(4, 2)).toBe(2);
    expect(computeVolumeBarWidthBitmap(4, 2)).toBe(6);

    // Default TARGET_BAR_PX = 7 -> 6 CSS px column + 1 CSS px gap
    expect(computeVolumeBarSpacingBitmap(7, 1)).toBe(1);
    expect(computeVolumeBarWidthBitmap(7, 1)).toBe(6);
    expect(computeVolumeBarSpacingBitmap(7, 2)).toBe(2);
    expect(computeVolumeBarWidthBitmap(7, 2)).toBe(12);
    expect(computeVolumeBarSpacingBitmap(7, 1.5)).toBe(1);
    expect(computeVolumeBarWidthBitmap(7, 1.5)).toBe(10);

    // Zoomed in -> columns scale smoothly with bar spacing while preserving a crisp 1 CSS px gap
    expect(computeVolumeBarWidthBitmap(20, 1)).toBe(19);
    expect(computeVolumeBarWidthBitmap(20, 2)).toBe(38);
    expect(computeVolumeBarWidthBitmap(40, 2)).toBe(78);

    // Zoomed out -> collapses cleanly to 1 bitmap px without disappearing
    expect(computeVolumeBarSpacingBitmap(2, 1)).toBe(1);
    expect(computeVolumeBarWidthBitmap(2, 1)).toBe(1);
    expect(computeVolumeBarSpacingBitmap(0.5, 1)).toBe(0);
    expect(computeVolumeBarWidthBitmap(0.5, 1)).toBe(1);
    expect(computeVolumeBarSpacingBitmap(0.5, 2)).toBe(0);
    expect(computeVolumeBarWidthBitmap(0.5, 2)).toBe(1);

    // Conflation scales effective spacing before computing column width
    expect(computeVolumeBarSpacingBitmap(0.5, 2, 4)).toBe(2);
    expect(computeVolumeBarWidthBitmap(0.5, 2, 4)).toBe(2);
  });

  it('computes crisp thin MT5-style vertical volume line widths for bar and line charts', () => {
    // Default TARGET_BAR_PX = 7
    expect(computeVolumeSpikeWidthBitmap(7, 1)).toBe(1);
    expect(computeVolumeSpikeWidthBitmap(7, 2)).toBe(2);
    expect(computeVolumeSpikeWidthBitmap(7, 1.5)).toBe(2);

    // Zoomed far out: never wider than 25% of bar spacing (floor >= 1px)
    expect(computeVolumeSpikeWidthBitmap(2, 2)).toBe(1);
    expect(computeVolumeSpikeWidthBitmap(0.5, 2)).toBe(1);

    // Zoomed far in: stays sleek (<= 1.5 CSS px)
    expect(computeVolumeSpikeWidthBitmap(20, 1)).toBe(2);
    expect(computeVolumeSpikeWidthBitmap(20, 2)).toBe(3);
    expect(computeVolumeSpikeWidthBitmap(40, 2)).toBe(3);
  });

  it('anchors positive bars cleanly above the baseline with at least a 1 CSS px tick', () => {
    expect(computeVolumeBarVerticalBounds(450, 600, 1)).toEqual({ topPx: 450, heightPx: 150 });
    // Very tiny volume that converts right to baseline still renders a 1 CSS px tick
    expect(computeVolumeBarVerticalBounds(600, 600, 1)).toEqual({ topPx: 599, heightPx: 1 });
    expect(computeVolumeBarVerticalBounds(600, 1200, 2)).toEqual({ topPx: 1198, heightPx: 2 });
  });

  it('builds [0, value] plot values and detects whitespace cleanly across both views', () => {
    for (const view of [new TradingViewVolumeSeriesView(), new Mt5VolumeSeriesView()]) {
      expect(view.priceValueBuilder({ time: 100 as Time, value: 420 })).toEqual([0, 420]);
      expect(view.priceValueBuilder({ time: 100 as Time, value: 0 })).toEqual([0, 0]);
      expect(view.priceValueBuilder({ time: 100 as Time, value: -5 })).toEqual([0, 0]);

      expect(view.isWhitespace({ time: 100 as Time })).toBe(true);
      expect(view.isWhitespace({ time: 100 as Time, value: Number.NaN })).toBe(true);
      expect(view.isWhitespace({ time: 100 as Time, value: 0 })).toBe(false);
      expect(view.isWhitespace({ time: 100 as Time, value: 12 })).toBe(false);
    }
  });

  it('renders flush TradingView-style histogram columns for candlestick charts and skips zero volume', () => {
    const view = new TradingViewVolumeSeriesView();
    const { fillRect, fillStyles, target } = createMockRenderHarness();

    const bars: Array<{
      x: number;
      time: number;
      originalData: VolumeBarDatum;
      barColor: string;
    }> = [
      { x: 100, time: 1, originalData: { time: 1 as Time, value: 100 }, barColor: 'rgba(8, 153, 129, 0.5)' },
      { x: 107, time: 2, originalData: { time: 2 as Time, value: 0 }, barColor: 'rgba(242, 54, 69, 0.5)' },
      { x: 114, time: 3, originalData: { time: 3 as Time, value: 50 }, barColor: 'rgba(242, 54, 69, 0.5)' },
      { x: 121, time: 4, originalData: { time: 4 as Time, value: 1 }, barColor: 'rgba(8, 153, 129, 0.5)' },
    ];

    view.update(
      {
        bars,
        barSpacing: 7,
        visibleRange: { from: 0, to: bars.length },
        conflationFactor: 1,
      },
      view.defaultOptions(),
    );

    // 0 -> bottom (600), 100 -> 522 (78px band at bottom = 13% of 600px pane, matching line chart height)
    const priceConverter = (price: number): Coordinate | null => (600 - (price / 100) * 78) as Coordinate;
    view.renderer().draw(target, priceConverter, false);

    // Skipped the zero-volume bar at index 1
    expect(fillRect).toHaveBeenCalledTimes(3);
    // 6px wide columns centered on x (left = x - 3), anchored flush to y = 600
    expect(fillRect).toHaveBeenNthCalledWith(1, 97, 522, 6, 78);
    expect(fillRect).toHaveBeenNthCalledWith(2, 111, 561, 6, 39);
    expect(fillRect).toHaveBeenNthCalledWith(3, 118, 599, 6, 1);
    expect(fillStyles).toEqual([
      'rgba(8, 153, 129, 0.5)',
      'rgba(242, 54, 69, 0.5)',
      'rgba(8, 153, 129, 0.5)',
    ]);
  });

  it('renders crisp 1px MT5-style vertical volume lines for bar and line charts and skips zero volume', () => {
    const view = new Mt5VolumeSeriesView();
    const { fillRect, fillStyles, target } = createMockRenderHarness();

    const bars: Array<{
      x: number;
      time: number;
      originalData: VolumeBarDatum;
      barColor: string;
    }> = [
      { x: 100, time: 1, originalData: { time: 1 as Time, value: 100 }, barColor: '#4597ff' },
      { x: 107, time: 2, originalData: { time: 2 as Time, value: 0 }, barColor: '#ff5858' },
      { x: 114, time: 3, originalData: { time: 3 as Time, value: 50 }, barColor: '#ff5858' },
      { x: 121, time: 4, originalData: { time: 4 as Time, value: 1 }, barColor: '#4597ff' },
    ];

    view.update(
      {
        bars,
        barSpacing: 7,
        visibleRange: { from: 0, to: bars.length },
        conflationFactor: 1,
      },
      view.defaultOptions(),
    );

    // 0 -> bottom (600), 100 -> 522 (78px band at bottom = 13% of 600px pane)
    const priceConverter = (price: number): Coordinate | null => (600 - (price / 100) * 78) as Coordinate;
    view.renderer().draw(target, priceConverter, false);

    expect(fillRect).toHaveBeenCalledTimes(3);
    // 1px crisp bars centered on x, ending at y = 599 (1px breathing gap above axis border)
    expect(fillRect).toHaveBeenNthCalledWith(1, 100, 522, 1, 77);
    expect(fillRect).toHaveBeenNthCalledWith(2, 114, 561, 1, 38);
    expect(fillRect).toHaveBeenNthCalledWith(3, 121, 598, 1, 1);
    expect(fillStyles).toEqual(['#4597ff', '#ff5858', '#4597ff']);
  });

  it('prevents overlapping semi-transparent columns under fractional bar spacing and preserves sub-pixel spikes', () => {
    const view = new TradingViewVolumeSeriesView();
    const { fillRect, target } = createMockRenderHarness();

    view.update(
      {
        bars: [
          { x: 100.0, time: 1, originalData: { time: 1 as Time, value: 100 }, barColor: 'rgba(8, 153, 129, 0.5)' },
          { x: 103.6, time: 2, originalData: { time: 2 as Time, value: 80 }, barColor: 'rgba(242, 54, 69, 0.5)' },
          { x: 107.2, time: 3, originalData: { time: 3 as Time, value: 60 }, barColor: 'rgba(8, 153, 129, 0.5)' },
        ],
        barSpacing: 3.6,
        visibleRange: { from: 0, to: 3 },
        conflationFactor: 1,
      },
      view.defaultOptions(),
    );

    const priceConverter = (price: number): Coordinate | null => (600 - price) as Coordinate;
    view.renderer().draw(target, priceConverter, false);

    const calls = fillRect.mock.calls as Array<[number, number, number, number]>;
    expect(calls).toHaveLength(3);
    for (let i = 1; i < calls.length; i += 1) {
      const prevRight = calls[i - 1][0] + calls[i - 1][2] - 1;
      const currLeft = calls[i][0];
      expect(currLeft).toBeGreaterThan(prevRight + 1);
    }

    const subPixel = createMockRenderHarness();
    view.update(
      {
        bars: [
          { x: 100.0, time: 1, originalData: { time: 1 as Time, value: 20 }, barColor: 'rgba(8, 153, 129, 0.5)' },
          { x: 100.3, time: 2, originalData: { time: 2 as Time, value: 100 }, barColor: 'rgba(242, 54, 69, 0.5)' },
        ],
        barSpacing: 0.5,
        visibleRange: { from: 0, to: 2 },
        conflationFactor: 1,
      },
      view.defaultOptions(),
    );
    view.renderer().draw(subPixel.target, priceConverter, false);
    expect(subPixel.fillRect).toHaveBeenNthCalledWith(1, 100, 580, 1, 20);
    expect(subPixel.fillRect).toHaveBeenNthCalledWith(2, 100, 500, 1, 80);
  });

  it('registers columns (candlestick), spikes (bar/line), and hidden (area) volume series with matching scale margins', () => {
    const createMockChart = () => {
      const applyScaleOptions = vi.fn();
      const fakeSeries = {
        priceScale: () => ({ applyOptions: applyScaleOptions }),
      };
      const addCustomSeries = vi.fn(() => fakeSeries);
      return {
        applyScaleOptions,
        fakeSeries,
        addCustomSeries,
        chart: { addCustomSeries } as unknown as IChartApi,
      };
    };

    // Candlestick -> TradingView columns using the same 13% bottom height as Line/Bar charts
    const candleMock = createMockChart();
    const candleVol = createChartVolumeSeries(candleMock.chart, {
      color: 'rgba(69, 151, 255, 0.5)',
      visible: true,
      style: 'columns',
    });
    expect(candleVol).toBe(candleMock.fakeSeries);
    expect(isCurrentChartVolumeSeries(candleVol, 'columns')).toBe(true);
    expect(isCurrentChartVolumeSeries(candleVol, 'spikes')).toBe(false);
    expect(isCurrentChartVolumeSeries({} as never)).toBe(false);
    expect(isCurrentChartVolumeSeries(null)).toBe(false);
    expect(candleMock.addCustomSeries.mock.calls[0]?.[0]).toBeInstanceOf(TradingViewVolumeSeriesView);
    expect(candleMock.addCustomSeries.mock.calls[0]?.[1]).toEqual({
      color: 'rgba(69, 151, 255, 0.5)',
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
      visible: true,
    });
    expect(candleMock.applyScaleOptions).toHaveBeenCalledWith({ scaleMargins: VOLUME_SCALE_MARGINS });
    expect(VOLUME_SCALE_MARGINS).toEqual({ top: 0.87, bottom: 0 });

    // Bar & Line -> MT5 thin vertical lines (13% bottom overlay)
    const spikeMock = createMockChart();
    const spikeVol = createChartVolumeSeries(spikeMock.chart, {
      color: '#4597ff',
      visible: true,
      style: 'spikes',
    });
    expect(isCurrentChartVolumeSeries(spikeVol, 'spikes')).toBe(true);
    expect(isCurrentChartVolumeSeries(spikeVol, 'columns')).toBe(false);
    expect(spikeMock.addCustomSeries.mock.calls[0]?.[0]).toBeInstanceOf(Mt5VolumeSeriesView);
    expect(spikeMock.addCustomSeries.mock.calls[0]?.[1]).toMatchObject({
      color: '#4597ff',
      visible: true,
    });
    expect(spikeMock.applyScaleOptions).toHaveBeenCalledWith({ scaleMargins: VOLUME_SPIKE_SCALE_MARGINS });
    expect(VOLUME_SPIKE_SCALE_MARGINS).toEqual({ top: 0.87, bottom: 0 });

    // Area -> always hidden even if visible: true is passed
    const areaMock = createMockChart();
    const areaVol = createChartVolumeSeries(areaMock.chart, {
      color: 'rgba(69, 151, 255, 0.5)',
      visible: true,
      style: 'none',
    });
    expect(isCurrentChartVolumeSeries(areaVol, 'none')).toBe(true);
    expect(areaMock.addCustomSeries.mock.calls[0]?.[1]).toMatchObject({
      visible: false,
    });
  });
});
