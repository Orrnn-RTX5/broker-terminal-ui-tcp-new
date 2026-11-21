import {
  HistogramSeries,
  customSeriesDefaultOptions,
  type CustomConflationContext,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesPricePlotValues,
  type CustomSeriesWhitespaceData,
  type IChartApi,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type ISeriesApi,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

/**
 * Keep chart volume spikes tucked cleanly along the bottom ~13% of the pane
 * (matching MT5's bottom volume overlay proportion) so peaks stay well below
 * candlesticks (`rightPriceScale` bottom margin is 28%) without cluttering price action.
 */
export const VOLUME_SCALE_MARGINS = {
  top: 0.87,
  bottom: 0,
} as const;

export interface VolumeBarDatum extends CustomData<Time> {
  time: Time;
  value: number;
  color?: string;
}

export type VolumeSeriesOptions = CustomSeriesOptions;

const DEFAULT_VOLUME_SERIES_OPTIONS: VolumeSeriesOptions = {
  ...customSeriesDefaultOptions,
  color: '#4597ff',
};

/**
 * Compute crisp integer bitmap pixel width for MT5-style thin vertical volume lines.
 * Stays 1 CSS px (matching candle wick width) across normal and zoomed-out views,
 * stepping up gently to at most 1.5 CSS px when zoomed far in, and never exceeding
 * 25% of effective bar spacing so adjacent sticks always retain clean separation.
 */
export const computeVolumeBarWidthBitmap = (
  barSpacing: number,
  horizontalPixelRatio: number,
  conflationFactor = 1,
): number => {
  const safeHpr = Number.isFinite(horizontalPixelRatio) && horizontalPixelRatio > 0
    ? horizontalPixelRatio
    : 1;
  const safeConflation = Number.isFinite(conflationFactor) && conflationFactor > 0
    ? conflationFactor
    : 1;
  const safeSpacing = Number.isFinite(barSpacing) && barSpacing > 0
    ? barSpacing * safeConflation
    : 1;

  const maxWidthBitmap = Math.max(1, Math.floor(safeSpacing * safeHpr * 0.25));
  const targetCssPx = safeSpacing >= 18 ? 1.5 : 1;
  const desiredBitmap = Math.max(1, Math.round(targetCssPx * safeHpr));
  return Math.max(1, Math.min(desiredBitmap, maxWidthBitmap));
};

export const computeVolumeBarVerticalBounds = (
  valueCoordCss: number,
  baselinePx: number,
  verticalPixelRatio: number,
): { topPx: number; heightPx: number } => {
  const safeVpr = Number.isFinite(verticalPixelRatio) && verticalPixelRatio > 0
    ? verticalPixelRatio
    : 1;
  const minHeightPx = Math.max(1, Math.round(safeVpr));
  const rawTopPx = Math.round(valueCoordCss * safeVpr);
  const clampedTopPx = Math.max(0, Math.min(baselinePx - minHeightPx, rawTopPx));
  return {
    topPx: clampedTopPx,
    heightPx: Math.max(minHeightPx, baselinePx - clampedTopPx),
  };
};

class Mt5VolumeSeriesRenderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<Time, VolumeBarDatum> | null = null;
  private options: VolumeSeriesOptions = DEFAULT_VOLUME_SERIES_OPTIONS;

  update(
    data: PaneRendererCustomData<Time, VolumeBarDatum>,
    options: VolumeSeriesOptions,
  ): void {
    this.data = data;
    this.options = options;
  }

  draw(
    target: CanvasRenderingTarget2D,
    priceConverter: PriceToCoordinateConverter,
  ): void {
    const data = this.data;
    if (!data || data.bars.length === 0 || data.visibleRange === null) {
      return;
    }

    const baseCoord = priceConverter(0);
    if (baseCoord === null || !Number.isFinite(baseCoord)) {
      return;
    }

    const { bars, barSpacing, visibleRange, conflationFactor } = data;
    const fallbackColor = this.options.color;

    target.useBitmapCoordinateSpace(({
      context,
      bitmapSize,
      horizontalPixelRatio,
      verticalPixelRatio,
    }) => {
      const safeHpr = Number.isFinite(horizontalPixelRatio) && horizontalPixelRatio > 0
        ? horizontalPixelRatio
        : 1;
      const safeVpr = Number.isFinite(verticalPixelRatio) && verticalPixelRatio > 0
        ? verticalPixelRatio
        : 1;

      const bottomPaddingPx = Math.max(1, Math.round(safeVpr));
      const maxBaselinePx = Math.max(1, bitmapSize.height - bottomPaddingPx);
      const baselinePx = Math.min(maxBaselinePx, Math.round(baseCoord * safeVpr));
      if (baselinePx <= 0) {
        return;
      }

      const barWidthBitmap = computeVolumeBarWidthBitmap(barSpacing, safeHpr, conflationFactor);
      const halfBarWidth = Math.floor(barWidthBitmap / 2);

      const startIndex = Math.max(0, visibleRange.from);
      const endIndex = Math.min(bars.length, visibleRange.to);
      let prevFillStyle = '';

      for (let i = startIndex; i < endIndex; i += 1) {
        const bar = bars[i];
        if (!bar) continue;

        const value = bar.originalData?.value;
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          continue;
        }

        const valueCoord = priceConverter(value);
        if (valueCoord === null || !Number.isFinite(valueCoord)) {
          continue;
        }

        const color = bar.barColor || bar.originalData.color || fallbackColor;
        if (color !== prevFillStyle) {
          context.fillStyle = color;
          prevFillStyle = color;
        }

        const centerX = Math.round(bar.x * safeHpr);
        const leftPx = centerX - halfBarWidth;
        const { topPx, heightPx } = computeVolumeBarVerticalBounds(
          valueCoord,
          baselinePx,
          safeVpr,
        );

        context.fillRect(leftPx, topPx, barWidthBitmap, heightPx);
      }
    });
  }
}

export class Mt5VolumeSeriesView
  implements ICustomSeriesPaneView<Time, VolumeBarDatum, VolumeSeriesOptions>
{
  private readonly paneRenderer = new Mt5VolumeSeriesRenderer();

  renderer(): ICustomSeriesPaneRenderer {
    return this.paneRenderer;
  }

  update(
    data: PaneRendererCustomData<Time, VolumeBarDatum>,
    seriesOptions: VolumeSeriesOptions,
  ): void {
    this.paneRenderer.update(data, seriesOptions);
  }

  priceValueBuilder(plotRow: VolumeBarDatum): CustomSeriesPricePlotValues {
    const value = typeof plotRow.value === 'number' && Number.isFinite(plotRow.value) && plotRow.value > 0
      ? plotRow.value
      : 0;
    return [0, value];
  }

  isWhitespace(
    data: VolumeBarDatum | CustomSeriesWhitespaceData<Time>,
  ): data is CustomSeriesWhitespaceData<Time> {
    const candidate = (data as Partial<VolumeBarDatum>).value;
    return typeof candidate !== 'number' || !Number.isFinite(candidate);
  }

  defaultOptions(): VolumeSeriesOptions {
    return { ...DEFAULT_VOLUME_SERIES_OPTIONS };
  }

  conflationReducer(
    item1: CustomConflationContext<Time, VolumeBarDatum>,
    item2: CustomConflationContext<Time, VolumeBarDatum>,
  ): VolumeBarDatum {
    const v1 = Number.isFinite(item1.data.value) ? item1.data.value : 0;
    const v2 = Number.isFinite(item2.data.value) ? item2.data.value : 0;
    const dominant = v2 >= v1 ? item2.data : item1.data;
    return {
      time: item2.originalTime,
      value: Math.max(v1, v2),
      ...(dominant.color ? { color: dominant.color } : {}),
    };
  }
}

const currentVolumeSeriesInstances = new WeakSet<object>();

export const isCurrentChartVolumeSeries = (
  series: ISeriesApi<SeriesType> | null | undefined,
): boolean => Boolean(series && currentVolumeSeriesInstances.has(series));

export const createChartVolumeSeries = (
  chart: IChartApi,
  options: {
    color: string;
    visible: boolean;
  },
): ISeriesApi<SeriesType> => {
  const seriesOptions = {
    color: options.color,
    priceScaleId: '',
    priceFormat: { type: 'volume' as const },
    lastValueVisible: false,
    priceLineVisible: false,
    visible: options.visible,
  };

  const volSeries: ISeriesApi<SeriesType> = typeof chart.addCustomSeries === 'function'
    ? chart.addCustomSeries(new Mt5VolumeSeriesView(), seriesOptions)
    : chart.addSeries(HistogramSeries, seriesOptions);

  currentVolumeSeriesInstances.add(volSeries);
  volSeries.priceScale().applyOptions({ scaleMargins: VOLUME_SCALE_MARGINS });
  return volSeries;
};
