import type { IChartApi } from 'lightweight-charts';

type RefreshableChart = Pick<IChartApi, 'applyOptions' | 'autoSizeActive' | 'resize'>
  & Partial<Pick<IChartApi, 'chartElement'>>;

type ChartElementLike = {
  style?: Partial<CSSStyleDeclaration>;
  firstElementChild?: Element | null;
};

const isEvenSurfaceMatch = (
  style: Partial<CSSStyleDeclaration> | undefined,
  targetEvenWidth: number,
  targetEvenHeight: number,
): boolean => {
  if (!style) return false;
  const rawWidth = style.width ?? '';
  const rawHeight = style.height ?? '';
  // Percentage values (e.g. "100%" in autoSize mode) are relative container
  // fills, never pixel surface dimensions.
  if (rawWidth.endsWith('%') || rawHeight.endsWith('%')) {
    return false;
  }
  const currentWidth = Number.parseFloat(rawWidth);
  const currentHeight = Number.parseFloat(rawHeight);
  return (
    Number.isFinite(currentWidth)
    && Number.isFinite(currentHeight)
    && currentWidth > 0
    && currentHeight > 0
    && currentWidth % 2 === 0
    && currentHeight % 2 === 0
    && Math.abs(currentWidth - targetEvenWidth) <= 2
    && Math.abs(currentHeight - targetEvenHeight) <= 2
  );
};

export const refreshLightweightChartSurface = (
  chart: RefreshableChart,
  width: number,
  height: number,
  { forceRepaint = true }: { forceRepaint?: boolean } = {},
): boolean => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }

  const nextWidth = Math.floor(width);
  const nextHeight = Math.floor(height);
  const chartEl = chart.chartElement?.() as ChartElementLike | undefined;
  const outerStyle = chartEl?.style;
  const tableEl = chartEl && 'firstElementChild' in chartEl && chartEl.firstElementChild
    ? (chartEl.firstElementChild as HTMLElement)
    : null;
  const tableStyle = tableEl?.style;
  let restoreAutoSize = false;

  try {
    if (!forceRepaint) {
      // Lightweight Charts keeps the outer `.tv-lightweight-charts` host at
      // 100%/100% while `autoSize` is active and stamps the applied even-pixel
      // dimensions onto its child `<table>`. When the container has a fractional
      // CSS box (e.g. 1105.59px), ResizeObserver contentRect floors to 1104px
      // while offsetWidth rounds to 1106px. Treat an already-sized even surface
      // within one even step (<= 2px) as matching so autoSize is not detached
      // and oscillated.
      const targetEvenWidth = nextWidth - nextWidth % 2;
      const targetEvenHeight = nextHeight - nextHeight % 2;
      const outerFillsContainer = outerStyle?.width === '100%' && outerStyle?.height === '100%';
      const outerMatchesPixels = isEvenSurfaceMatch(outerStyle, targetEvenWidth, targetEvenHeight);

      if (tableStyle) {
        const tableMatchesPixels = isEvenSurfaceMatch(tableStyle, targetEvenWidth, targetEvenHeight);
        if ((outerFillsContainer || outerMatchesPixels) && tableMatchesPixels) {
          return true;
        }
      } else if (outerMatchesPixels) {
        return true;
      }
    }

    restoreAutoSize = chart.autoSizeActive();
    if (restoreAutoSize) {
      // Lightweight Charts ignores explicit dimensions while autoSize is active.
      // Briefly detach its ResizeObserver so a same-size theme transition can
      // force a real canvas repaint instead of leaving a cleared surface behind.
      chart.applyOptions({ autoSize: false, width: nextWidth, height: nextHeight });
    }

    chart.resize(nextWidth, nextHeight, true);
    chart.applyOptions({});
    return true;
  } catch {
    return false;
  } finally {
    if (restoreAutoSize) {
      try {
        chart.applyOptions({ autoSize: true });
      } catch {
        // The chart may have been disposed during a fast workspace switch.
      }
      // Lightweight Charts writes fixed px dimensions onto `.tv-lightweight-charts`
      // while autoSize is temporarily off, and does not reset them to 100%/100%
      // when autoSize is re-enabled. Restore 100%/100% so future autoSize
      // expansions (such as entering chart Fullscreen) are never clipped.
      if (outerStyle && tableStyle) {
        outerStyle.width = '100%';
        outerStyle.height = '100%';
      }
    }
  }
};
