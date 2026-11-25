import type { ChartProperties } from '../../../store/useChartSettingsStore';
import type { TradingViewChartTheme } from '../../../types/chart';
import { getChartGridLineColors } from '../../../utils/chartGridStyle';

export type ChartColorPalette = ChartProperties['colors'];

export const MINUTE_SEPARATOR_PIXEL_DEDUP_DISTANCE = 10;
export const CHART_AXIS_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Plus Jakarta Sans Variable", "Segoe UI", Arial, sans-serif';
export const LIGHT_CHART_AXIS_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Plus Jakarta Sans Variable", "Segoe UI", Arial, sans-serif';
export const CHART_AXIS_FONT_SIZE = 12;
export const CHART_PRICE_SCALE_MIN_WIDTH = 72;

const parseCssColor = (value: string): { r: number; g: number; b: number } | null => {
  const color = value.trim();
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hexMatch) {
    const hex = hexMatch[1].length === 3
      ? hexMatch[1].split('').map((part) => `${part}${part}`).join('')
      : hexMatch[1];
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    };
  }

  const rgbMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(color);
  if (!rgbMatch) return null;
  return {
    r: Math.min(255, Math.max(0, Number(rgbMatch[1]))),
    g: Math.min(255, Math.max(0, Number(rgbMatch[2]))),
    b: Math.min(255, Math.max(0, Number(rgbMatch[3]))),
  };
};

export const isLightChartBackground = (background: string): boolean => {
  const color = parseCssColor(background);
  if (!color) return false;
  return (0.2126 * color.r) + (0.7152 * color.g) + (0.0722 * color.b) >= 180;
};

export const readChartAxisFontSize = (): number => {
  if (typeof document === 'undefined') return CHART_AXIS_FONT_SIZE;
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const axisSize = Number.parseFloat(styles.getPropertyValue('--rtx-chart-axis-font-size'));
  if (Number.isFinite(axisSize) && axisSize > 0) return axisSize;
  const size = Number.parseFloat(styles.getPropertyValue('--rtx-ui-font-size'));
  return Number.isFinite(size) && size > 0 ? size : CHART_AXIS_FONT_SIZE;
};

export const readChartPriceScaleMinWidth = (): number => {
  if (typeof document === 'undefined') return CHART_PRICE_SCALE_MIN_WIDTH;
  const root = document.documentElement;
  const width = Number.parseFloat(getComputedStyle(root).getPropertyValue('--rtx-chart-price-scale-min-width'));
  return Number.isFinite(width) && width > 0 ? width : CHART_PRICE_SCALE_MIN_WIDTH;
};

export const clampAlpha = (alpha: number): number => Math.max(0, Math.min(1, alpha));

export const colorWithAlpha = (
  color: string | undefined,
  alpha: number,
  fallback: string,
): string => {
  if (!color) return fallback;
  const nextAlpha = clampAlpha(alpha);
  const trimmed = color.trim();
  const shortHex = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(trimmed);
  if (shortHex) {
    const [, r, g, b] = shortHex;
    return `rgba(${parseInt(r + r, 16)}, ${parseInt(g + g, 16)}, ${parseInt(b + b, 16)}, ${nextAlpha})`;
  }

  const longHex = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(trimmed);
  if (longHex) {
    const [, r, g, b] = longHex;
    return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${nextAlpha})`;
  }

  const rgb = /^rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(trimmed);
  if (rgb) {
    const [, r, g, b] = rgb;
    return `rgba(${r}, ${g}, ${b}, ${nextAlpha})`;
  }

  const rgba = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*[\d.]+\s*\)$/i.exec(trimmed);
  if (rgba) {
    const [, r, g, b] = rgba;
    return `rgba(${r}, ${g}, ${b}, ${nextAlpha})`;
  }

  return fallback;
};

const getColorLuminance = (color: string | undefined): number | null => {
  if (!color) return null;
  const trimmed = color.trim();
  const shortHex = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(trimmed);
  if (shortHex) {
    const [, r, g, b] = shortHex;
    return ((parseInt(r + r, 16) * 0.2126) + (parseInt(g + g, 16) * 0.7152) + (parseInt(b + b, 16) * 0.0722)) / 255;
  }

  const longHex = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(trimmed);
  if (longHex) {
    const [, r, g, b] = longHex;
    return ((parseInt(r, 16) * 0.2126) + (parseInt(g, 16) * 0.7152) + (parseInt(b, 16) * 0.0722)) / 255;
  }

  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:,\s*[\d.]+\s*)?\)$/i.exec(trimmed);
  if (rgb) {
    const [, r, g, b] = rgb;
    return ((Number(r) * 0.2126) + (Number(g) * 0.7152) + (Number(b) * 0.0722)) / 255;
  }

  return null;
};

const getRelativeLuminance = (color: string | undefined): number | null => {
  const parsed = color ? parseCssColor(color) : null;
  if (!parsed) return null;
  const toLinear = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * toLinear(parsed.r)) + (0.7152 * toLinear(parsed.g)) + (0.0722 * toLinear(parsed.b));
};

const getColorContrastRatio = (first: string, second: string): number | null => {
  const l1 = getRelativeLuminance(first);
  const l2 = getRelativeLuminance(second);
  if (l1 === null || l2 === null) return null;
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

// TradingView's built-in Volume overlay renders columns at 50% opacity so wide
// volume bars remain legible without obscuring candlesticks drawn above them.
export const TRADINGVIEW_VOLUME_OPACITY = 0.5;

// Derive crisp directional base volume colors directly from the active candle
// colors without hardcoding any scheme hues. When a hollow candle body matches
// the chart background (e.g. black bull body on a black canvas, or white bull
// body on a light canvas), fall back to its visible candle outline/bar color.
// Bar & Line charts use these solid colors for thin 1px vertical volume lines,
// while Candlestick charts apply TradingView's 50% opacity to wide columns.
const resolveCandleVolumeBaseColor = (
  candleColor: string,
  barColor: string,
  background: string,
  foreground: string,
): string => {
  const candleContrast = getColorContrastRatio(candleColor, background);
  if (candleContrast === null || candleContrast >= 1.8) {
    return candleColor;
  }
  const barContrast = getColorContrastRatio(barColor, background);
  if (barContrast === null || barContrast >= 1.8) {
    return barColor;
  }
  return foreground;
};

export const buildChartTheme = (
  colors: ChartColorPalette,
  showGrid: boolean,
  useReferenceLightSurface = false,
  gridLineStyle: ChartProperties['gridLineStyle'] = 'dashed',
  gridType: ChartProperties['gridType'] = 'mt5',
  colorScheme?: ChartProperties['colorScheme'],
): TradingViewChartTheme => {
  const fallbackCandleUp = useReferenceLightSurface ? '#2563eb' : '#4597ff';
  const fallbackCandleDown = useReferenceLightSurface ? '#dc2626' : '#ff5858';
  const fallbackUpRgb = useReferenceLightSurface ? '37, 99, 235' : '69, 151, 255';
  const fallbackDownRgb = useReferenceLightSurface ? '220, 38, 38' : '255, 88, 88';
  const candleUp = colors.bullCandle || colors.barUp || fallbackCandleUp;
  const candleDown = colors.bearCandle || colors.barDown || fallbackCandleDown;
  const barUp = colors.barUp || candleUp;
  const barDown = colors.barDown || candleDown;
  const backgroundLuminance = getColorLuminance(colors.background) ?? 0;
  const backgroundIsDark = backgroundLuminance < 0.45;
  const isHollowLightFill = (c: string): boolean => {
    const n = c.trim().toLowerCase();
    return n === '#ffffff' || n === '#fff' || n === '#f8fafc' || n === '#fafbfc';
  };
  const areaUp = colorScheme === 'Green and White' || (!backgroundIsDark && isHollowLightFill(candleUp))
    ? barUp
    : candleUp;
  const areaDown = (useReferenceLightSurface && colorScheme === 'Blue and White') || (!backgroundIsDark && isHollowLightFill(candleDown))
    ? barDown
    : candleDown;
  const line = colors.lineChart || '#2962ff';
  const configuredGrid = colors.grid || 'rgba(120, 144, 156, 0.28)';
  const isDefaultReferenceLightGrid = useReferenceLightSurface
    && configuredGrid.replace(/\s+/g, '').toLowerCase() === 'rgba(71,85,105,0.07)';
  const rawGrid = isDefaultReferenceLightGrid
    ? (gridLineStyle === 'solid'
      ? 'rgba(100, 116, 139, 0.14)'
      : 'rgba(100, 116, 139, 0.05)')
    : configuredGrid;
  // A pale canvas needs less tint; dark canvases need enough fill to separate
  // the area from the grid. Follow the configured chart surface, not app chrome.
  const areaFillOpacity = backgroundIsDark ? 0.32 : 0.16;
  const gridLines = getChartGridLineColors({
    background: colors.background || '#0e0e12',
    grid: rawGrid,
    showGrid,
    lineStyle: gridLineStyle,
    gridType,
    colorScheme,
    preserveConfiguredColor: useReferenceLightSurface,
  });

  const background = colors.background || '#0e0e12';
  const foreground = colors.foreground || '#ffffff';
  const volumeLineUp = resolveCandleVolumeBaseColor(candleUp, barUp, background, foreground);
  const volumeLineDown = resolveCandleVolumeBaseColor(candleDown, barDown, background, foreground);
  const volumeUp = colorWithAlpha(volumeLineUp, TRADINGVIEW_VOLUME_OPACITY, volumeLineUp);
  const volumeDown = colorWithAlpha(volumeLineDown, TRADINGVIEW_VOLUME_OPACITY, volumeLineDown);

  return {
    background,
    text: foreground,
    axisText: backgroundIsDark
      ? colorWithAlpha(colors.foreground, 0.72, 'rgba(226, 232, 240, 0.72)')
      : (colors.foreground || '#25313c'),
    gridVertical: gridLines.vertical,
    gridHorizontal: gridLines.horizontal,
    scaleBorder: useReferenceLightSurface
      ? '#64748b'
      : colorWithAlpha(colors.foreground, 0.24, 'rgba(255, 255, 255, 0.24)'),
    crosshair: useReferenceLightSurface
      ? '#64748b'
      : colorWithAlpha(colors.foreground, 0.58, 'rgba(255, 255, 255, 0.58)'),
    candleUp,
    candleDown,
    barUp,
    barDown,
    wickUp: barUp,
    wickDown: barDown,
    line,
    areaTop: colorWithAlpha(line, areaFillOpacity, `rgba(41, 98, 255, ${areaFillOpacity})`),
    areaBottom: colorWithAlpha(line, 0, 'rgba(41, 98, 255, 0)'),
    areaUpLine: areaUp,
    areaUpTop: colorWithAlpha(areaUp, areaFillOpacity, `rgba(${fallbackUpRgb}, ${areaFillOpacity})`),
    areaUpBottom: colorWithAlpha(areaUp, 0, `rgba(${fallbackUpRgb}, 0)`),
    areaDownLine: areaDown,
    areaDownTop: colorWithAlpha(areaDown, areaFillOpacity, `rgba(${fallbackDownRgb}, ${areaFillOpacity})`),
    areaDownBottom: colorWithAlpha(areaDown, 0, `rgba(${fallbackDownRgb}, 0)`),
    volumeUp,
    volumeDown,
    volumeLineUp,
    volumeLineDown,
  };
};
