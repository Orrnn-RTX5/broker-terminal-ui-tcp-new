import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

export type ChartOverlayLivePriceRenderer = (
  target: CanvasRenderingTarget2D,
  series: ISeriesApi<SeriesType>,
) => void;

/**
 * Reproject DOM overlays and paint the live bid price line inside the exact
 * same Lightweight Charts canvas frame as the forming candle so price line and
 * live candle move in lockstep on every tick, DPI scale, and platform.
 */
export class ChartOverlayGeometryPrimitive implements ISeriesPrimitive<Time> {
  private attachedToChart = false;
  private dirty = true;
  private attachedSeries: ISeriesApi<SeriesType> | null = null;
  private requestUpdateFn: (() => void) | null = null;
  private readonly paneRenderer: IPrimitivePaneRenderer = {
    draw: (target: CanvasRenderingTarget2D) => {
      if (!this.attachedToChart) return;
      if (this.dirty) {
        this.dirty = false;
        this.repaintGeometry();
      }
      if (this.attachedSeries && this.renderLivePrice) {
        this.renderLivePrice(target, this.attachedSeries);
      }
    },
  };
  private readonly views: readonly IPrimitivePaneView[] = [{
    zOrder: () => 'top',
    renderer: () => this.paneRenderer,
  }];

  constructor(
    private readonly repaintGeometry: () => void,
    private readonly renderLivePrice?: ChartOverlayLivePriceRenderer,
  ) {}

  attached(param?: SeriesAttachedParameter<Time>): void {
    this.attachedToChart = true;
    this.dirty = true;
    this.attachedSeries = (param?.series as ISeriesApi<SeriesType> | undefined) ?? null;
    this.requestUpdateFn = param?.requestUpdate ?? null;
  }

  detached(): void {
    this.attachedToChart = false;
    this.attachedSeries = null;
    this.requestUpdateFn = null;
  }

  requestUpdate(): void {
    if (!this.attachedToChart) return;
    this.dirty = true;
    try {
      this.requestUpdateFn?.();
    } catch {
      // Ignore disposed chart updates.
    }
  }

  updateAllViews(): void {
    this.dirty = true;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }
}
