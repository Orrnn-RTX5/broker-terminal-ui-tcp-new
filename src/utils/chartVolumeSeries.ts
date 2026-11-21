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
import type { ChartType } from '../types/chart';

/**
 * Keep chart volume along the bottom ~13% of the pane (matching the compact
 * bottom volume proportion of Line/Bar charts) so Candlestick TradingView
 * volume columns and Bar/Line vertical volume lines share the same clean
 * height well below candlesticks (`rightPriceScale` bottom margin is 28%).
 */
export const VOLUME_SCALE_MARGINS = {
  top: 0.87,
  bottom: 0,
} as const;

export const VOLUME_SPIKE_SCALE_MARGINS = VOLUME_SCALE_MARGINS;

export interface VolumeBarDatum extends CustomData<Time> {
  time: Time;
  value: number;
  color?: string;
}

export type VolumeSeriesOptions = CustomSeriesOptions;

const DEFAULT_VOLUME_SERIES_OPTIONS: VolumeSeriesOptions = {
  ...customSeriesDefaultOptions,
  color: 'rgba(69, 151, 255, 0.5)',
};

const DEFAULT_SPIKE_VOLUME_SERIES_OPTIONS: VolumeSeriesOptions = {
  ...customSeriesDefaultOptions,
  color: '#4597ff',
};

const SHOW_SPACING_MINIMAL_BAR_WIDTH_BITMAP = 1;

/**
 * Compute the crisp inter-column gap in bitmap pixels (matching TradingView's
 * HistogramSeries: 1 CSS px when bar slots exceed 1 bitmap px, collapsing to 0
 * when ultra-zoomed-out so dense bars pack seamlessly without disappearing).
 */
export const computeVolumeBarSpacingBitmap = (
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

  return Math.ceil(safeSpacing * safeHpr) <= SHOW_SPACING_MINIMAL_BAR_WIDTH_BITMAP
    ? 0
    : Math.max(1, Math.floor(safeHpr));
};

/**
 * Compute crisp integer bitmap pixel width for TradingView-style bottom volume
 * histogram columns. Each column fills its bar slot minus a crisp 1 CSS px
 * separator gap across all zoom levels, conflation factors, and pixel ratios.
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

  const gapBitmap = computeVolumeBarSpacingBitmap(barSpacing, safeHpr, safeConflation);
  return Math.max(1, Math.round(safeSpacing * safeHpr) - gapBitmap);
};

/**
 * Compute crisp integer bitmap pixel width for MT5-style thin vertical volume
 * lines (used for Bar and Line charts). Stays 1 CSS px across normal and
 * zoomed-out views, stepping up gently to at most 1.5 CSS px when zoomed far
 * in, and never exceeding 25% of effective bar spacing.
 */
export const computeVolumeSpikeWidthBitmap = (
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

class TradingViewVolumeSeriesRenderer implements ICustomSeriesPaneRenderer {
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

      const baselinePx = Math.min(bitmapSize.height, Math.round(baseCoord * safeVpr));
      if (baselinePx <= 0) {
        return;
      }

      const gapBitmap = computeVolumeBarSpacingBitmap(barSpacing, safeHpr, conflationFactor);
      const barWidthBitmap = computeVolumeBarWidthBitmap(barSpacing, safeHpr, conflationFactor);
      const halfBarWidth = Math.floor(barWidthBitmap / 2);

      const startIndex = Math.max(0, visibleRange.from);
      const endIndex = Math.min(bars.length, visibleRange.to);
      let prevFillStyle = '';
      let prevRightPx: number | null = null;
      let prevColumnTopPx = baselinePx;

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
        let leftPx = centerX - halfBarWidth;
        const rightPx = leftPx + barWidthBitmap - 1;
        const { topPx, heightPx } = computeVolumeBarVerticalBounds(
          valueCoord,
          baselinePx,
          safeVpr,
        );

        // Prevent adjacent semi-transparent columns from overlapping and
        // creating dark double-alpha seams under fractional bar spacing.
        if (prevRightPx !== null) {
          const preferredMinLeft = prevRightPx + gapBitmap + 1;
          if (leftPx < preferredMinLeft) {
            if (preferredMinLeft <= rightPx) {
              leftPx = preferredMinLeft;
            } else {
              leftPx = Math.max(leftPx, prevRightPx + 1);
            }
          }
        }

        if (leftPx > rightPx) {
          // Sub-pixel bar spacing (< 1 bitmap px): if a taller spike shares the
          // exact same 1px column, paint only above the already-filled height so
          // spikes stay visible without double-blending translucent fills.
          if (centerX === prevRightPx && topPx < prevColumnTopPx) {
            context.fillRect(centerX, topPx, 1, prevColumnTopPx - topPx);
            prevColumnTopPx = topPx;
          }
          continue;
        }

        const drawWidthPx = rightPx - leftPx + 1;
        context.fillRect(leftPx, topPx, drawWidthPx, heightPx);
        prevRightPx = rightPx;
        prevColumnTopPx = topPx;
      }
    });
  }
}

class Mt5VolumeSeriesRenderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<Time, VolumeBarDatum> | null = null;
  private options: VolumeSeriesOptions = DEFAULT_SPIKE_VOLUME_SERIES_OPTIONS;

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

      const barWidthBitmap = computeVolumeSpikeWidthBitmap(barSpacing, safeHpr, conflationFactor);
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

abstract class BaseVolumeSeriesView
  implements ICustomSeriesPaneView<Time, VolumeBarDatum, VolumeSeriesOptions>
{
  abstract renderer(): ICustomSeriesPaneRenderer;
  abstract update(
    data: PaneRendererCustomData<Time, VolumeBarDatum>,
    seriesOptions: VolumeSeriesOptions,
  ): void;
  abstract defaultOptions(): VolumeSeriesOptions;

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

export class TradingViewVolumeSeriesView extends BaseVolumeSeriesView {
  private readonly paneRenderer = new TradingViewVolumeSeriesRenderer();

  renderer(): ICustomSeriesPaneRenderer {
    return this.paneRenderer;
  }

  update(
    data: PaneRendererCustomData<Time, VolumeBarDatum>,
    seriesOptions: VolumeSeriesOptions,
  ): void {
    this.paneRenderer.update(data, seriesOptions);
  }

  defaultOptions(): VolumeSeriesOptions {
    return { ...DEFAULT_VOLUME_SERIES_OPTIONS };
  }
}

export class Mt5VolumeSeriesView extends BaseVolumeSeriesView {
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

  defaultOptions(): VolumeSeriesOptions {
    return { ...DEFAULT_SPIKE_VOLUME_SERIES_OPTIONS };
  }
}

export type ChartVolumeSeriesStyle = 'columns' | 'spikes' | 'none';

export const resolveChartVolumeSeriesStyle = (
  chartType: ChartType | undefined,
): ChartVolumeSeriesStyle => {
  if (chartType === 'area') return 'none';
  if (chartType === 'bar' || chartType === 'line') return 'spikes';
  return 'columns';
};

const currentVolumeSeriesStyles = new WeakMap<object, ChartVolumeSeriesStyle>();

export const isCurrentChartVolumeSeries = (
  series: ISeriesApi<SeriesType> | null | undefined,
  expectedStyle?: ChartVolumeSeriesStyle,
): boolean => {
  if (!series) return false;
  const registeredStyle = currentVolumeSeriesStyles.get(series);
  if (!registeredStyle) return false;
  return expectedStyle ? registeredStyle === expectedStyle : true;
};

export const createChartVolumeSeries = (
  chart: IChartApi,
  options: {
    color: string;
    visible: boolean;
    style?: ChartVolumeSeriesStyle;
  },
): ISeriesApi<SeriesType> => {
  const style: ChartVolumeSeriesStyle = options.style ?? 'columns';
  const seriesOptions = {
    color: options.color,
    priceScaleId: '',
    priceFormat: { type: 'volume' as const },
    lastValueVisible: false,
    priceLineVisible: false,
    visible: style === 'none' ? false : options.visible,
  };

  const view = style === 'spikes'
    ? new Mt5VolumeSeriesView()
    : new TradingViewVolumeSeriesView();

  const volSeries: ISeriesApi<SeriesType> = typeof chart.addCustomSeries === 'function'
    ? chart.addCustomSeries(view, seriesOptions)
    : chart.addSeries(HistogramSeries, seriesOptions);

  currentVolumeSeriesStyles.set(volSeries, style);
  volSeries.priceScale().applyOptions({
    scaleMargins: style === 'spikes' ? VOLUME_SPIKE_SCALE_MARGINS : VOLUME_SCALE_MARGINS,
  });
  return volSeries;
};
