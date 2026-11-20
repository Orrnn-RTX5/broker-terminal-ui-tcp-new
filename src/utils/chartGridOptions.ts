import { LineStyle, type GridOptions } from 'lightweight-charts';
import { isLightChartBackground } from '../features/trading-chart/presentation/chartTheme';
import type { ChartProperties } from '../store/useChartSettingsStore';
import type { TradingViewChartTheme } from '../types/chart';
import {
  CHART_GRID_DASH_PATTERN_CSS_PX,
  FINE_CHART_GRID_CELL_SIZE_PX,
  SQUARE_CHART_GRID_CELL_SIZE_PX,
  type SquareChartGridOptions,
} from './squareChartGridPrimitive';
import { isChartBackgroundLogoVisible, resolveActiveBrokerWatermarkCandidates } from './brokerWatermark';

/** Select one background grid; scale guides track the chart's price/time ticks. */
export const getChartGridRenderingOptions = (
  settings: Pick<ChartProperties, 'showGrid' | 'gridType' | 'gridLineStyle'> & Partial<Pick<
    ChartProperties,
    | 'showBackgroundLogo'
    | 'backgroundLogoMode'
    | 'backgroundLogoOpacity'
    | 'backgroundLogoUrl'
    | 'backgroundLogoFileDataUrl'
  >>,
  colors: Pick<TradingViewChartTheme, 'gridVertical' | 'gridHorizontal'> & Partial<Pick<TradingViewChartTheme, 'background'>>,
): { nativeGrid: GridOptions; squareVisible: boolean; fixedGrid: SquareChartGridOptions } => {
  const scaleAligned = settings.gridType === 'scale';
  const style = settings.gridLineStyle === 'solid' ? LineStyle.Solid : LineStyle.Dashed;
  const visible = settings.showGrid && scaleAligned;
  const squareVisible = settings.showGrid && !scaleAligned;
  const customLogoSrc = settings.backgroundLogoMode === 'url'
    ? settings.backgroundLogoUrl?.trim()
    : settings.backgroundLogoMode === 'file'
      ? settings.backgroundLogoFileDataUrl?.trim()
      : undefined;
  const showLogo = isChartBackgroundLogoVisible({
    showBackgroundLogo: settings.showBackgroundLogo === true,
    backgroundLogoMode: settings.backgroundLogoMode,
  });
  const brokerCandidates = showLogo && !customLogoSrc
    ? resolveActiveBrokerWatermarkCandidates()
    : [];
  const resolvedLogoSrc = customLogoSrc || brokerCandidates[0];
  const fallbackLogoSrcs = !customLogoSrc && brokerCandidates.length > 1
    ? brokerCandidates.slice(1)
    : undefined;
  return {
    nativeGrid: {
      vertLines: { color: colors.gridVertical, style, visible },
      horzLines: { color: colors.gridHorizontal, style, visible },
    },
    squareVisible,
    fixedGrid: {
      visible: squareVisible,
      ...(settings.showBackgroundLogo !== undefined || settings.backgroundLogoMode !== undefined
        ? {
            showBackgroundLogo: showLogo,
            ...(settings.backgroundLogoOpacity !== undefined
              ? { backgroundLogoOpacity: settings.backgroundLogoOpacity }
              : {}),
            ...(resolvedLogoSrc ? { backgroundLogoSrc: resolvedLogoSrc } : {}),
            ...(fallbackLogoSrcs ? { backgroundLogoFallbacks: fallbackLogoSrcs } : {}),
          }
        : {}),
      ...(colors.background !== undefined
        ? { isLightBackground: isLightChartBackground(colors.background) }
        : {}),
      lineStyle: settings.gridLineStyle,
      profile: settings.gridType === 'mt5' ? 'fine' : 'square',
      cellSizeCssPx: settings.gridType === 'mt5' ? FINE_CHART_GRID_CELL_SIZE_PX : SQUARE_CHART_GRID_CELL_SIZE_PX,
      dashPatternCssPx: [...CHART_GRID_DASH_PATTERN_CSS_PX],
      verticalColor: colors.gridVertical,
      horizontalColor: colors.gridHorizontal,
    },
  };
};
