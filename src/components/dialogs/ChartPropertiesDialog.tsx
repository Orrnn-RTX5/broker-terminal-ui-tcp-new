import { useUiTranslation } from '../../hooks/useUiTranslation';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getColorSchemeDisplayLabel,
  getEffectiveChartColors,
  getPresetSchemeColors,
  normalizeColorSchemeName,
  useChartSettingsStore,
  type ChartProperties,
  type ColorScheme,
} from '../../store/useChartSettingsStore';
import { getChartGridLineColors } from '../../utils/chartGridStyle';
import { buildChartTheme } from '../../features/trading-chart/presentation/chartTheme';
import { ChartPropertiesPreviewChart } from './ChartPropertiesPreviewChart';
import {
  CHART_GRID_DASH_PATTERN_CSS_PX,
  CHART_GRID_STROKE_CSS_PX,
  FINE_CHART_GRID_CELL_SIZE_PX,
  FINE_CHART_GRID_DASH_PATTERN_CSS_PX,
  FINE_CHART_GRID_OPACITY,
  FINE_CHART_GRID_STROKE_CSS_PX,
  SQUARE_CHART_GRID_CELL_SIZE_PX,
} from '../../utils/squareChartGridPrimitive';
import type { ChartType } from '../../types/chart';
import { commandBus } from '../../services/commandBus';
import { isShortcutOwnedBy, shouldIgnoreShortcutEvent } from '../../services/keyboardShortcutManager';
import { useDraggableSheet } from '../../hooks/useDraggableSheet';
import { isChartBackgroundLogoVisible } from '../../utils/brokerWatermark';
import './chart-properties-dialog.css';

interface ChartPropertiesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  symbol: string;
  timeframe: string;
  currentChartType?: ChartType;
  onChartTypeChange?: (chartType: ChartType) => void;
  targetContextId?: string;
}

const showOptions = [
  { key: 'showTicker', label: 'Show ticker' },
  { key: 'showOHLC', label: 'Show OHLC' },
  { key: 'showQuickTradingButtons', label: 'Show quick trading buttons' },
  { key: 'showBidPriceLine', label: 'Show bid price line' },
  { key: 'showAskPriceLine', label: 'Show ask price line' },
  { key: 'showLastPriceLine', label: 'Show last price line' },
  { key: 'showPeriodSeparators', label: 'Show period separators' },
  { key: 'showGrid', label: 'Show grid' },
  { key: 'showBackgroundLogo', label: 'Show background logo' },
  { key: 'showTickVolumes', label: 'Show tick volumes' },
  { key: 'showRealVolumes', label: 'Show real volumes' },
  { key: 'showTradeLevels', label: 'Show trade levels' },
  { key: 'showTradeHistory', label: 'Show entry/close line' },
  { key: 'showTradeHistoryArrows', label: 'Show entry/close arrows' },
] as const satisfies ReadonlyArray<{
  key: keyof Pick<
    ChartProperties,
    | 'showTicker'
    | 'showOHLC'
    | 'showQuickTradingButtons'
    | 'showBidPriceLine'
    | 'showAskPriceLine'
    | 'showLastPriceLine'
    | 'showPeriodSeparators'
    | 'showGrid'
    | 'showBackgroundLogo'
    | 'showTickVolumes'
    | 'showRealVolumes'
    | 'showTradeLevels'
    | 'showTradeHistory'
    | 'showTradeHistoryArrows'
  >;
  label: string;
}>;

const colorSchemeOptions = [
  'Green and Red',
  'Green and White',
  'Green and Blue',
  'Blue and White',
  'Blue and Red',
  'Gray and White',
  'Yellow and White',
  'Custom',
] as const satisfies ReadonlyArray<ColorScheme>;

const darkColorSchemeOptionStyle: React.CSSProperties = {
  backgroundColor: '#2b2b2b',
  color: '#cccccc',
};

const getIsAdvancedUntitledLight = (): boolean => {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  return root.classList.contains('rtx-advanced-view') && root.classList.contains('rtx-skin-untitled-light');
};

const toColorPickerHexValue = (color: string | undefined): string => {
  const trimmed = color?.trim() ?? '';
  if (/^#[a-f\d]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  const shortHex = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(trimmed);
  if (shortHex) {
    const [, r, g, b] = shortHex;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(trimmed);
  if (rgb) {
    const hex = [rgb[1], rgb[2], rgb[3]]
      .map((channel) => Math.max(0, Math.min(255, Math.round(Number(channel)))).toString(16).padStart(2, '0'))
      .join('');
    return `#${hex}`;
  }
  return '#ffffff';
};

const getGridPreviewImage = (
  colors: { vertical: string; horizontal: string },
  lineStyle: ChartProperties['gridLineStyle'],
  cellSize: { width: number; height: number },
  gridType: ChartProperties['gridType'],
): string => {
  const escapeAttribute = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const dashed = lineStyle !== 'solid';
  const lineOffset = 0.5;
  const strokeWidth = gridType === 'scale'
    ? '1'
    : gridType === 'mt5'
      ? String(FINE_CHART_GRID_STROKE_CSS_PX)
      : String(CHART_GRID_STROKE_CSS_PX);
  const dashPattern = gridType === 'mt5'
    ? FINE_CHART_GRID_DASH_PATTERN_CSS_PX
    : CHART_GRID_DASH_PATTERN_CSS_PX;
  const dashArray = !dashed
    ? ''
    : gridType === 'scale'
      ? ' stroke-dasharray="2 2"'
      : ` stroke-dasharray="${dashPattern[0]} ${dashPattern[1]}"`;
  const strokeOpacity = gridType === 'mt5' && dashed ? ` stroke-opacity="${FINE_CHART_GRID_OPACITY}"` : '';
  const strokeAttrs = ` stroke-width="${strokeWidth}"${strokeOpacity}${dashArray}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellSize.width}" height="${cellSize.height}" fill="none"><path d="M${lineOffset} 0V${cellSize.height}" stroke="${escapeAttribute(colors.vertical)}"${strokeAttrs}/><path d="M0 ${lineOffset}H${cellSize.width}" stroke="${escapeAttribute(colors.horizontal)}"${strokeAttrs}/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};

export const ChartPropertiesDialog: React.FC<ChartPropertiesDialogProps> = ({
  isOpen,
  onClose,
  symbol,
  timeframe,
  currentChartType,
  onChartTypeChange,
  targetContextId,
}) => {
    const tr = useUiTranslation();
  const [activeTab, setActiveTab] = useState<'Common' | 'Show' | 'Colors'>('Common');
  const [isAdvancedUntitledLight, setIsAdvancedUntitledLight] = useState(getIsAdvancedUntitledLight);
  const [previewPanOffset, setPreviewPanOffset] = useState<{ key: string; px: number }>({ key: '', px: 0 });
  
  const {
    globalProperties,
    symbolProperties,
    syncQuoteColorsWithChart,
    updateSymbolColor,
    updateSymbolProperty,
    applySymbolPresetScheme,
    setSyncQuoteColorsWithChart,
    resetSymbolToDefaults,
  } = useChartSettingsStore();
  const state = symbolProperties[symbol] || globalProperties;
  const selectedChartType: ChartType = currentChartType ?? (
    state.chartType === 'Bar'
      ? 'bar'
      : state.chartType === 'Line'
        ? 'line'
        : state.chartType === 'Area'
          ? 'area'
          : 'candlestick'
  );
  const showState = symbolProperties[symbol] || globalProperties;
  const effectiveColors = getEffectiveChartColors(state, { isAdvancedUntitledLight });
  const previewBackground = effectiveColors.background || '#000000';
  const previewGridColors = getChartGridLineColors({
    background: previewBackground,
    grid: effectiveColors.grid,
    showGrid: showState.showGrid,
    lineStyle: showState.gridLineStyle,
    gridType: showState.gridType,
    colorScheme: state.colorScheme,
    preserveConfiguredColor: isAdvancedUntitledLight
      && (state.colorScheme !== 'Custom' || previewBackground.toLowerCase() !== '#000000'),
  });
  const previewTheme = buildChartTheme(
    effectiveColors,
    showState.showGrid,
    isAdvancedUntitledLight && (state.colorScheme !== 'Custom' || previewBackground.toLowerCase() !== '#000000'),
    showState.gridLineStyle,
    showState.gridType,
    state.colorScheme,
  );
  const previewLabelBackground = previewBackground.toLowerCase() === '#ffffff' || previewBackground.toLowerCase() === '#fafbfc'
    ? 'rgba(255, 255, 255, 0.82)'
    : 'rgba(0, 0, 0, 0.72)';
  const previewSquareCellSize = showState.gridType === 'mt5' ? FINE_CHART_GRID_CELL_SIZE_PX : SQUARE_CHART_GRID_CELL_SIZE_PX;
  const previewGridCellSize = showState.gridType === 'scale'
    ? { width: 128, height: 48 }
    : { width: previewSquareCellSize, height: previewSquareCellSize };
  const previewPanKey = `${symbol}:${timeframe}`;
  const previewPanX = previewPanOffset.key === previewPanKey ? Math.round(previewPanOffset.px) : 0;
  const handlePreviewPanOffsetChange = useCallback((px: number) => {
    setPreviewPanOffset({ key: previewPanKey, px });
  }, [previewPanKey]);
  const previewStyle = {
    backgroundColor: previewBackground,
    backgroundImage: getGridPreviewImage(previewGridColors, showState.gridLineStyle, previewGridCellSize, showState.gridType),
    backgroundSize: `${previewGridCellSize.width}px ${previewGridCellSize.height}px`,
    backgroundPosition: previewPanX !== 0
      ? `${previewPanX}px ${showState.gridType === 'mt5' ? 'bottom' : 'top'}`
      : (showState.gridType === 'mt5' ? 'left bottom' : 'left top'),
    '--rtx-cp-preview-bg': previewBackground,
    '--rtx-cp-preview-text': effectiveColors.foreground,
    '--rtx-cp-preview-label-bg': previewLabelBackground,
  } as React.CSSProperties;
  const colorSchemeOptionStyle = isAdvancedUntitledLight ? undefined : darkColorSchemeOptionStyle;
  const initialPropertiesRef = useRef<ChartProperties | null>(null);
  const initialChartTypeRef = useRef<ChartType | null>(null);
  const initialSyncQuoteColorsRef = useRef<boolean>(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { dragStyle, dragHandleProps } = useDraggableSheet({ isOpen, elementRef: dialogRef });

  useEffect(() => {
    if (!isOpen) return;
    const current = useChartSettingsStore.getState();
    const source = symbol
      ? (current.symbolProperties[symbol] || current.globalProperties)
      : current.globalProperties;
    initialPropertiesRef.current = {
      ...source,
      colors: { ...source.colors },
    };
    initialSyncQuoteColorsRef.current = Boolean(current.syncQuoteColorsWithChart);
    initialChartTypeRef.current = currentChartType ?? (
      source.chartType === 'Bar'
        ? 'bar'
        : source.chartType === 'Line'
          ? 'line'
          : source.chartType === 'Area'
            ? 'area'
            : 'candlestick'
    );
  }, [isOpen, symbol]);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const root = document.documentElement;
    const syncSkinState = () => setIsAdvancedUntitledLight(getIsAdvancedUntitledLight());
    const observer = new MutationObserver(syncSkinState);

    syncSkinState();
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });

    return () => observer.disconnect();
  }, []);

  const updateActiveChartProperty = <K extends keyof ChartProperties>(key: K, value: ChartProperties[K]) => {
    if (symbol) {
      updateSymbolProperty(symbol, key, value);
    } else {
      useChartSettingsStore.getState().updateGlobalProperty(key, value);
    }
  };

  const updateActiveGridType = (type: ChartProperties['gridType']) => {
    updateActiveChartProperty('gridType', type);
    if (type === 'mt5') updateActiveChartProperty('gridLineStyle', 'dashed');
  };

  const updateActiveChartType = (settingsType: ChartProperties['chartType'], runtimeType: ChartType) => {
    updateActiveChartProperty('chartType', settingsType);
    onChartTypeChange?.(runtimeType);
  };

  const updateChartShift = (enabled: boolean) => {
    updateActiveChartProperty('chartShift', enabled);
    commandBus.dispatch({
      type: 'SET_CHART_SHIFT',
      payload: { enabled, targetContextId },
    });
  };

  const updateChartAutoScroll = (enabled: boolean) => {
    updateActiveChartProperty('chartAutoScroll', enabled);
    commandBus.dispatch({
      type: 'SET_AUTO_SCROLL',
      payload: { enabled, targetContextId },
    });
  };

  const applyActivePresetScheme = (scheme: ColorScheme) => {
    if (symbol) {
      applySymbolPresetScheme(symbol, scheme);
      return;
    }

    const store = useChartSettingsStore.getState();
    store.updateGlobalProperty('colorScheme', scheme);
    store.updateGlobalProperty('colors', getPresetSchemeColors(scheme, store.globalProperties.colors));
  };

  const updateActiveChartColor = (key: keyof ChartProperties['colors'], value: string) => {
    if (symbol) {
      updateSymbolColor(symbol, key, value);
    } else {
      useChartSettingsStore.getState().updateGlobalColor(key, value);
    }
  };

  const resetActiveChartDefaults = () => {
    if (symbol) {
      resetSymbolToDefaults(symbol);
    } else {
      useChartSettingsStore.getState().resetToDefaults();
    }
  };

  const restoreInitialProperties = () => {
    const initialProperties = initialPropertiesRef.current;
    if (!initialProperties) return;

    useChartSettingsStore.setState((current) => symbol
      ? {
          syncQuoteColorsWithChart: initialSyncQuoteColorsRef.current,
          symbolProperties: {
            ...current.symbolProperties,
            [symbol]: {
              ...initialProperties,
              colors: { ...initialProperties.colors },
            },
          },
        }
      : {
          syncQuoteColorsWithChart: initialSyncQuoteColorsRef.current,
          globalProperties: {
            ...initialProperties,
            colors: { ...initialProperties.colors },
          },
        });

    const originalChartType = initialChartTypeRef.current;
    if (originalChartType) onChartTypeChange?.(originalChartType);
    commandBus.dispatch({
      type: 'SET_CHART_SHIFT',
      payload: { enabled: initialProperties.chartShift, targetContextId },
    });
    commandBus.dispatch({
      type: 'SET_AUTO_SCROLL',
      payload: { enabled: initialProperties.chartAutoScroll, targetContextId },
    });
  };

  const handleCancel = () => {
    restoreInitialProperties();
    onClose();
  };

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();
    return () => {
      if (previousFocus?.isConnected && (document.activeElement === document.body || dialog?.contains(document.activeElement))) previousFocus.focus();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || shouldIgnoreShortcutEvent(event) || !isShortcutOwnedBy(event, dialog)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [isOpen, symbol, targetContextId, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div 
      className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-auto rtx-cp-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div 
        className="absolute inset-0 bg-transparent"
        onClick={onClose}
      />
      
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chart-properties-title"
        style={dragStyle}
        className="rtx-cp-shell relative bg-[#1e1e1e] border border-[#333] rounded shadow-2xl flex flex-col pointer-events-auto select-none animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="rtx-cp-header flex items-center justify-between px-2.5 py-1 border-b border-[#2e2e34]" {...dragHandleProps}>
          <span id="chart-properties-title" className="rtx-cp-title text-[11.5px] font-semibold tracking-tight text-[#e2e2e5] leading-tight">{tr("Properties of ")}{symbol},{timeframe}</span>
          <div className="flex items-center gap-1">
            <button 
              onClick={onClose}
              aria-label={tr("Close chart properties")}
              className="rtx-cp-btn-icon rtx-cp-btn-close w-5 h-5 flex items-center justify-center hover:bg-rose-500/80 hover:text-white rounded text-[#999] transition-colors"
            >
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                <path d="M11 1L1 11M1 1L11 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="rtx-cp-content flex flex-1 overflow-hidden px-3 pt-1 pb-2 gap-2.5 bg-[#1e1e1e]">
          
          {/* Settings apply live to the chart behind this dialog. */}
          <div className="rtx-cp-settings flex-1 flex flex-col">
            <div className="rtx-cp-tabs flex gap-4 border-b border-[#2e2e34] mb-1 pl-0.5" role="tablist" aria-label={tr('Chart properties')}>
              {(['Common', 'Show', 'Colors'] as const).map(tab => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`chart-properties-tab-${tab}`}
                  aria-selected={activeTab === tab}
                  aria-controls="chart-properties-panel"
                  tabIndex={activeTab === tab ? 0 : -1}
                  onClick={() => setActiveTab(tab)}
                  onKeyDown={(event) => {
                    const tabs = ['Common', 'Show', 'Colors'] as const;
                    const index = tabs.indexOf(tab);
                    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length
                      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
                    if (nextIndex === null) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setActiveTab(tabs[nextIndex]);
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
                  }}
                  className={`rtx-cp-tab px-1 py-0.5 text-[11.5px] font-medium transition-colors ${activeTab === tab ? 'rtx-cp-tab-active text-blue-400 border-b-2 border-blue-400 -mb-[1px]' : 'text-[#9ca3af] hover:text-white'}`}
                >
                  {tr(tab)}
                </button>
              ))}
            </div>

            <div className="rtx-cp-tab-content flex-1 overflow-y-auto pr-0.5 custom-scrollbar" role="tabpanel" id="chart-properties-panel" aria-labelledby={`chart-properties-tab-${activeTab}`}>
              <div className="rtx-cp-preview-box" hidden={activeTab !== 'Colors'}>
                <div className="rtx-cp-preview-inner relative rounded overflow-hidden" style={previewStyle}>
                  <ChartPropertiesPreviewChart
                    key={previewPanKey}
                    symbol={symbol}
                    timeframe={timeframe}
                    chartType={selectedChartType}
                    effectiveColors={effectiveColors}
                    previewTheme={previewTheme}
                    colorScheme={state.colorScheme}
                    onPanOffsetPxChange={handlePreviewPanOffsetChange}
                  />
                </div>
              </div>
              {activeTab === 'Show' && (
                <div className="rtx-cp-show-grid py-1">
                  {showOptions.map(({ key, label }) => (
                    <React.Fragment key={key}>
                      <label className="rtx-cp-checkbox-row flex items-center gap-2 cursor-pointer group hover:bg-white/5 px-1.5 py-0.5 rounded transition-colors">
                        <input
                          type="checkbox"
                          className="rtx-cp-checkbox accent-blue-500 bg-[#2b2b2b] border-[#444] cursor-pointer w-3.5 h-3.5"
                          checked={
                            key === 'showBackgroundLogo'
                              ? isChartBackgroundLogoVisible(showState)
                              : (showState[key as keyof typeof showState] as boolean)
                          }
                          onChange={(e) => {
                            updateActiveChartProperty(key, e.target.checked);
                          }}
                        />
                        <span className="rtx-cp-checkbox-label text-[12px] text-[#ccc] group-hover:text-white transition-colors">{tr(label)}</span>
                      </label>
                      {key === 'showGrid' && (
                        <div className="col-span-2 grid grid-cols-2 gap-3 pl-5 pr-1 py-1 my-0.5 bg-white/[0.02] border border-[#2c2c34] rounded">
                          <label className="rtx-cp-label flex items-center gap-2 text-[11.5px] text-[#ccc]">
                            <span className="shrink-0">{tr('Grid type')}</span>
                            <select
                              value={showState.gridType}
                              disabled={!showState.showGrid}
                              onChange={(e) => updateActiveGridType(e.target.value as ChartProperties['gridType'])}
                              className="rtx-cp-select flex-1 min-w-0 bg-[#26262a] border border-[#3e3e46] text-[11.5px] px-2 py-0.5 rounded text-[#e4e4e7] outline-none focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <option value="square" style={colorSchemeOptionStyle}>{tr('Square')}</option>
                              <option value="scale" style={colorSchemeOptionStyle}>{tr('Price/time aligned')}</option>
                              <option value="mt5" style={colorSchemeOptionStyle}>{tr('Fine grid')}</option>
                            </select>
                          </label>
                          <label className="rtx-cp-label flex items-center gap-2 text-[11.5px] text-[#ccc]">
                            <span className="shrink-0">{tr('Grid line style')}</span>
                            <select
                              value={showState.gridLineStyle}
                              disabled={!showState.showGrid}
                              onChange={(e) => updateActiveChartProperty('gridLineStyle', e.target.value as ChartProperties['gridLineStyle'])}
                              className="rtx-cp-select flex-1 min-w-0 bg-[#26262a] border border-[#3e3e46] text-[11.5px] px-2 py-0.5 rounded text-[#e4e4e7] outline-none focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <option value="dashed" style={colorSchemeOptionStyle}>{tr('Dashed')}</option>
                              <option value="solid" style={colorSchemeOptionStyle}>{tr('Solid')}</option>
                            </select>
                          </label>
                        </div>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              )}

              {activeTab === 'Colors' && (
                <div className="rtx-cp-colors-grid">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <label className="flex items-center gap-2 flex-1 min-w-[205px]">
                      <span className="rtx-cp-label text-[11.5px] text-[#bbb] shrink-0">{tr("Scheme:")}</span>
                      <select 
                        value={normalizeColorSchemeName(state.colorScheme)}
                        onChange={(e) => applyActivePresetScheme(e.target.value as ColorScheme)}
                        className="rtx-cp-select flex-1 min-w-0 h-6 bg-[#26262a] border border-[#3e3e46] text-[12px] px-2 rounded text-[#e4e4e7] outline-none focus:border-blue-500 transition-colors"
                      >
                        {colorSchemeOptions.map((scheme) => (
                          <option key={scheme} value={scheme} style={colorSchemeOptionStyle}>
                            {tr(getColorSchemeDisplayLabel(scheme, { isAdvancedUntitledLight }))}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="rtx-cp-checkbox-row flex items-center gap-1.5 cursor-pointer py-0.5 shrink-0">
                      <input
                        type="checkbox"
                        className="rtx-cp-checkbox accent-blue-500 bg-[#2b2b2b] border-[#444]"
                        checked={syncQuoteColorsWithChart}
                        onChange={(e) => setSyncQuoteColorsWithChart(e.target.checked)}
                      />
                      <span className="rtx-cp-checkbox-label text-[11.5px] text-[#ccc]">
                        {tr("Change Bid/Ask price color with chart")}
                      </span>
                    </label>
                  </div>

                  <div className="rtx-cp-divider h-[1px] bg-[#2e2e34]"></div>

                  <div className="rtx-cp-colors-list">
                    {[
                      { label: 'Background', key: 'background' },
                      { label: 'Foreground', key: 'foreground' },
                      { label: 'Grid', key: 'grid' },
                      { label: 'Line chart', key: 'lineChart' },
                      { label: 'Bar up', key: 'barUp' },
                      { label: 'Bar down', key: 'barDown' },
                      { label: 'Bull candle', key: 'bullCandle' },
                      { label: 'Bear candle', key: 'bearCandle' },
                      { label: 'Bid price line', key: 'bidPriceLine' },
                      { label: 'Ask price line', key: 'askPriceLine' },
                      { label: 'Last price line', key: 'lastPriceLine' },
                      { label: 'Volumes', key: 'volumes' },
                      { label: 'Stop levels', key: 'stopLevels' },
                    ].map(c => {
                      const colorVal = effectiveColors[c.key as keyof typeof effectiveColors];
                      const pickerHex = toColorPickerHexValue(colorVal);
                      
                      return (
                        <div key={c.label} className="rtx-cp-color-row">
                          <span className="rtx-cp-label text-[11.5px] text-[#bbb] text-right truncate" title={tr(c.label)}>{tr(c.label)}:</span>
                          <label className="rtx-cp-color-picker h-[22px] flex items-center gap-1.5 bg-[#26262a] border border-[#3e3e46] rounded px-1.5 cursor-pointer hover:border-[#60606b] transition-colors relative">
                            <input 
                              type="color" 
                              aria-label={tr(c.label)}
                              value={pickerHex}
                              onChange={(e) => updateActiveChartColor(c.key as keyof ChartProperties['colors'], e.target.value)}
                              className="absolute opacity-0 w-0 h-0" 
                            />
                            <div className="w-3 h-3 rounded-[2px] border border-black/40 shadow-sm flex-shrink-0" style={{ backgroundColor: colorVal }}></div>
                            <span className="rtx-cp-color-text font-mono text-[11px] text-[#d4d4d8] w-full truncate">{colorVal}</span>
                            <svg width="8" height="5" viewBox="0 0 10 6" fill="none" className="text-[#71717a] flex-shrink-0">
                              <path d="M1 1L5 5L9 1" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </label>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {activeTab === 'Common' && (
                <div className="rtx-cp-common-grid flex gap-2.5 pt-0.5">
                  <div className="flex flex-col gap-2 flex-1">
                    <div className="rtx-cp-fieldset flex flex-col gap-1 p-2 border border-[#38383f] bg-white/[0.015] rounded relative">
                      <label className="rtx-cp-radio-row flex items-center gap-2 cursor-pointer">
                         <input type="radio" name="chartType" className="rtx-cp-radio accent-blue-500 bg-[#2b2b2b]" checked={selectedChartType === 'candlestick'} onChange={() => updateActiveChartType('Candlesticks', 'candlestick')} />
                         <span className="rtx-cp-radio-label text-[12px] text-[#ccc]">{tr("Candlesticks")}</span>
                      </label>
                      <label className="rtx-cp-radio-row flex items-center gap-2 cursor-pointer">
                         <input type="radio" name="chartType" className="rtx-cp-radio accent-blue-500 bg-[#2b2b2b]" checked={selectedChartType === 'bar'} onChange={() => updateActiveChartType('Bar', 'bar')} />
                         <span className="rtx-cp-radio-label text-[12px] text-[#ccc]">{tr("Bar chart")}</span>
                      </label>
                      <label className="rtx-cp-radio-row flex items-center gap-2 cursor-pointer">
                         <input type="radio" name="chartType" className="rtx-cp-radio accent-blue-500 bg-[#2b2b2b]" checked={selectedChartType === 'line'} onChange={() => updateActiveChartType('Line', 'line')} />
                         <span className="rtx-cp-radio-label text-[12px] text-[#ccc]">{tr("Line chart")}</span>
                      </label>
                      <label className="rtx-cp-radio-row flex items-center gap-2 cursor-pointer">
                         <input type="radio" name="chartType" className="rtx-cp-radio accent-blue-500 bg-[#2b2b2b]" checked={selectedChartType === 'area'} onChange={() => updateActiveChartType('Area', 'area')} />
                         <span className="rtx-cp-radio-label text-[12px] text-[#ccc]">{tr("Area chart")}</span>
                      </label>
                    </div>
                    <div className="rtx-cp-fieldset flex flex-col gap-1 p-2 border border-[#38383f] bg-white/[0.015] rounded">
                       <label className="rtx-cp-checkbox-row flex items-center gap-2 cursor-pointer">
                         <input type="checkbox" className="rtx-cp-checkbox accent-blue-500 bg-[#2b2b2b] border-[#444]" checked={state.chartOnForeground} onChange={(e) => updateActiveChartProperty('chartOnForeground', e.target.checked)} />
                         <span className="rtx-cp-checkbox-label text-[12px] text-[#ccc]">{tr("Chart on foreground")}</span>
                      </label>
                      <label className="rtx-cp-checkbox-row flex items-center gap-2 cursor-pointer">
                         <input type="checkbox" className="rtx-cp-checkbox accent-blue-500 bg-[#2b2b2b] border-[#444]" checked={state.chartShift} onChange={(e) => updateChartShift(e.target.checked)} />
                         <span className="rtx-cp-checkbox-label text-[12px] text-[#ccc]">{tr("Chart shift")}</span>
                      </label>
                      <label className="rtx-cp-checkbox-row flex items-center gap-2 cursor-pointer">
                         <input type="checkbox" className="rtx-cp-checkbox accent-blue-500 bg-[#2b2b2b] border-[#444]" checked={state.chartAutoScroll} onChange={(e) => updateChartAutoScroll(e.target.checked)} />
                         <span className="rtx-cp-checkbox-label text-[12px] text-[#ccc]">{tr("Chart auto scroll")}</span>
                      </label>
                    </div>
                  </div>
                  
                  <div className="rtx-cp-fieldset flex flex-col gap-1.5 flex-[1.15] border border-[#38383f] bg-white/[0.015] rounded p-2.5 pt-3.5 relative mt-1.5">
                     <span className="rtx-cp-legend absolute -top-[7px] left-2.5 bg-[#1e1e1e] px-1 text-[11px] font-medium text-[#bbb]">{tr("Scale")}</span>
                     <label className="rtx-cp-checkbox-row flex items-center gap-2 cursor-pointer mt-0">
                        <input type="checkbox" className="rtx-cp-checkbox accent-blue-500 bg-[#2b2b2b] border-[#444]" checked={state.scaleFixOneToOne} onChange={(e) => updateActiveChartProperty('scaleFixOneToOne', e.target.checked)} />
                       <span className="rtx-cp-checkbox-label text-[12px] text-[#ccc]">{tr("Scale fix one to one")}</span>
                     </label>
                     <label className="rtx-cp-checkbox-row flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" className="rtx-cp-checkbox accent-blue-500 bg-[#2b2b2b] border-[#444]" checked={state.scaleFix} onChange={(e) => updateActiveChartProperty('scaleFix', e.target.checked)} />
                       <span className="rtx-cp-checkbox-label text-[12px] text-[#ccc]">{tr("Scale fix")}</span>
                     </label>
                     
                     <div className={`flex flex-col gap-1.5 pl-6 mt-0.5 transition-opacity ${!state.scaleFix ? 'opacity-30 pointer-events-none' : ''}`}>
                       <div className="flex items-center gap-2">
                          <input type="number" value={state.fixedMaximum} onChange={(e) => updateActiveChartProperty('fixedMaximum', Number(e.target.value))} className="rtx-cp-input w-[84px] bg-[#26262a] border border-[#3e3e46] rounded px-1.5 py-0.5 text-[12px] text-[#e4e4e7] focus:outline-none focus:border-blue-500 transition-colors" />
                         <span className="rtx-cp-label text-[12px] text-[#ccc]">{tr("Fixed maximum")}</span>
                       </div>
                       <div className="flex items-center gap-2">
                          <input type="number" value={state.fixedMinimum} onChange={(e) => updateActiveChartProperty('fixedMinimum', Number(e.target.value))} className="rtx-cp-input w-[84px] bg-[#26262a] border border-[#3e3e46] rounded px-1.5 py-0.5 text-[12px] text-[#e4e4e7] focus:outline-none focus:border-blue-500 transition-colors" />
                         <span className="rtx-cp-label text-[12px] text-[#ccc]">{tr("Fixed minimum")}</span>
                       </div>
                     </div>
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Footer Buttons */}
        <div className="rtx-cp-footer flex items-center justify-between px-3 py-2 border-t border-[#2e2e34] rounded-b-lg">
          <button 
            onClick={resetActiveChartDefaults}
            className="rtx-cp-btn px-3 py-1 text-[12px] bg-[#26262a] hover:bg-rose-500/15 border border-[#3e3e46] hover:border-rose-500/50 text-[#ccc] hover:text-rose-400 rounded transition-colors"
          >
            {tr("Reset to Defaults")}</button>
          <div className="flex gap-2">
            <button 
              onClick={handleCancel}
              className="rtx-cp-btn px-4 py-1 text-[12px] bg-[#26262a] hover:bg-[#323238] border border-[#3e3e46] hover:border-[#5a5a66] text-[#d4d4d8] hover:text-white rounded transition-colors"
            >
              {tr("Cancel")}</button>
            <button 
              onClick={onClose}
              className="rtx-cp-btn rtx-cp-btn-primary px-5 py-1 text-[12px] font-medium bg-[#2563eb] hover:bg-[#1d4ed8] border border-[#3b82f6] text-white rounded transition-colors"
            >
              {tr("OK")}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
