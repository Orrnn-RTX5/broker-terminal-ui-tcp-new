import { describe, expect, it, vi } from 'vitest';
import type { Coordinate, IChartApi, Time } from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import {
  computeVolumeBarVerticalBounds,
  computeVolumeBarWidthBitmap,
  createChartVolumeSeries,
  isCurrentChartVolumeSeries,
  Mt5VolumeSeriesView,
  VOLUME_SCALE_MARGINS,
  type VolumeBarDatum,
} from './chartVolumeSeries';

describe('chartVolumeSeries', () => {
  it('computes crisp thin MT5-style vertical spike widths across DPR and zoom levels', () => {
    // Default TARGET_BAR_PX = 7
    expect(computeVolumeBarWidthBitmap(7, 1)).toBe(1);
    expect(computeVolumeBarWidthBitmap(7, 2)).toBe(2);
    expect(computeVolumeBarWidthBitmap(7, 1.5)).toBe(2);

    // Zoomed far out: never wider than 25% of bar spacing (floor >= 1px)
    expect(computeVolumeBarWidthBitmap(2, 2)).toBe(1);
    expect(computeVolumeBarWidthBitmap(0.5, 2)).toBe(1);

    // Zoomed far in: stays sleek (<= 1.5 CSS px) instead of bulky bricks
    expect(computeVolumeBarWidthBitmap(20, 1)).toBe(2);
    expect(computeVolumeBarWidthBitmap(20, 2)).toBe(3);
    expect(computeVolumeBarWidthBitmap(40, 2)).toBe(3);
  });

  it('anchors positive bars cleanly above the baseline with at least a 1 CSS px tick', () => {
    expect(computeVolumeBarVerticalBounds(520, 598, 1)).toEqual({ topPx: 520, heightPx: 78 });
    // Very tiny volume that converts right to baseline still renders a 1 CSS px tick
    expect(computeVolumeBarVerticalBounds(599, 598, 1)).toEqual({ topPx: 597, heightPx: 1 });
    expect(computeVolumeBarVerticalBounds(599, 1196, 2)).toEqual({ topPx: 1194, heightPx: 2 });
  });

  it('builds [0, value] plot values and detects whitespace cleanly', () => {
    const view = new Mt5VolumeSeriesView();

    expect(view.priceValueBuilder({ time: 100 as Time, value: 420 })).toEqual([0, 420]);
    expect(view.priceValueBuilder({ time: 100 as Time, value: 0 })).toEqual([0, 0]);
    expect(view.priceValueBuilder({ time: 100 as Time, value: -5 })).toEqual([0, 0]);

    expect(view.isWhitespace({ time: 100 as Time })).toBe(true);
    expect(view.isWhitespace({ time: 100 as Time, value: Number.NaN })).toBe(true);
    expect(view.isWhitespace({ time: 100 as Time, value: 0 })).toBe(false);
    expect(view.isWhitespace({ time: 100 as Time, value: 12 })).toBe(false);
  });

  it('renders crisp centered vertical bars using each bar dynamic candle color and skips zero volume', () => {
    const view = new Mt5VolumeSeriesView();
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
          bitmapSize: { width: 800, height: 600 },
          horizontalPixelRatio: 1,
          verticalPixelRatio: 1,
        });
      },
    } as unknown as CanvasRenderingTarget2D;

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

    // Skipped the zero-volume bar at index 1
    expect(fillRect).toHaveBeenCalledTimes(3);
    // 1px crisp bars centered on x, ending at y = 599 (1px breathing gap above axis border)
    expect(fillRect).toHaveBeenNthCalledWith(1, 100, 522, 1, 77);
    expect(fillRect).toHaveBeenNthCalledWith(2, 114, 561, 1, 38);
    // Tiny positive volume still draws a crisp 1px tick above the baseline
    expect(fillRect).toHaveBeenNthCalledWith(3, 121, 598, 1, 1);
    expect(fillStyles).toEqual(['#4597ff', '#ff5858', '#4597ff']);
  });

  it('registers the custom volume series with compact MT5 bottom scale margins', () => {
    const applyScaleOptions = vi.fn();
    const fakeSeries = {
      priceScale: () => ({ applyOptions: applyScaleOptions }),
    };
    const addCustomSeries = vi.fn(() => fakeSeries);
    const chart = { addCustomSeries } as unknown as IChartApi;

    const created = createChartVolumeSeries(chart, { color: '#4597ff', visible: true });

    expect(created).toBe(fakeSeries);
    expect(isCurrentChartVolumeSeries(created)).toBe(true);
    expect(isCurrentChartVolumeSeries({} as never)).toBe(false);
    expect(isCurrentChartVolumeSeries(null)).toBe(false);
    expect(addCustomSeries).toHaveBeenCalledTimes(1);
    expect(addCustomSeries.mock.calls[0]?.[0]).toBeInstanceOf(Mt5VolumeSeriesView);
    expect(addCustomSeries.mock.calls[0]?.[1]).toEqual({
      color: '#4597ff',
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
      visible: true,
    });
    expect(applyScaleOptions).toHaveBeenCalledWith({ scaleMargins: VOLUME_SCALE_MARGINS });
    expect(VOLUME_SCALE_MARGINS).toEqual({ top: 0.87, bottom: 0 });
  });
});
