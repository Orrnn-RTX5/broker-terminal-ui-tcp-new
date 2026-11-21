// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { defaultChartProperties } from '../../../store/useChartSettingsStore';
import {
  createDockedLevelChip,
  createEntryTradeControlBar,
  createTradeLevelControlBar,
} from '../../../utils/chartTradeControls';
import { TradingChartView } from './TradingChartView';

vi.mock('../../../components/OneClickTrading', () => ({
  OneClickTrading: ({ visible }: { visible: boolean }) => (
    visible ? <div data-testid="mock-one-click" className="rtx-oct z-30" /> : null
  ),
}));
vi.mock('../../../components/ChartContextMenu', () => ({ ChartContextMenu: () => null }));
vi.mock('../../../components/ChartSymbolDropdown', () => ({
  ChartSymbolTrigger: ({ symbol }: { symbol: string }) => <span>{symbol}</span>,
}));
vi.mock('../../../components/ChartTemplateDialog', () => ({ ChartTemplateDialog: () => null }));
vi.mock('../../../components/dialogs/ChartBackgroundImageDialog', () => ({
  ChartBackgroundImageDialog: () => null,
}));
vi.mock('../../../components/DrawingContextMenu', () => ({ DrawingContextMenu: () => null }));

const buildViewProps = (loadingPhase: 'connecting' | 'receiving' | 'ready' | 'hidden') => ({
  activeChartSourceId: 'chart-1',
  activeTimeframe: 'M1' as const,
  addLocalIndicator: () => true,
  bindDrawingManagerToChart: () => true,
  centerRef: createRef<HTMLDivElement>(),
  chartSettings: { ...defaultChartProperties, showQuickTradingButtons: true, showTicker: true, showOHLC: true },
  chartTheme: {
    background: '#000000',
    text: '#e2e8f0',
    axisText: '#94a3b8',
    grid: '#1e293b',
    upColor: '#22c55e',
    downColor: '#ef4444',
    wickUpColor: '#22c55e',
    wickDownColor: '#ef4444',
    borderUpColor: '#22c55e',
    borderDownColor: '#ef4444',
    lineColor: '#3b82f6',
    areaTopColor: 'rgba(59,130,246,0.2)',
    areaBottomColor: 'rgba(59,130,246,0)',
    volumeUpColor: 'rgba(34,197,94,0.35)',
    volumeDownColor: 'rgba(239,68,68,0.35)',
  },
  closeCtxMenu: () => undefined,
  containerRef: createRef<HTMLDivElement>(),
  ctxAutoScroll: true,
  ctxChartShift: false,
  ctxMenu: { visible: false, x: 0, y: 0 },
  ctxShowTradeHistory: true,
  ctxShowTradeHistoryLine: true,
  ctxShowTradeLevels: true,
  currentIndicators: [],
  drawingRuntimeContextRef: {
    current: { contextId: 'chart-1', symbol: 'BTCUSD', timeframe: 'M1' as const },
  },
  handleContextMenu: () => undefined,
  handleCtxChartTypeChange: () => undefined,
  handleCtxGridTypeChange: () => undefined,
  handleCtxGridLineStyleChange: () => undefined,
  handleCtxDeleteIndicators: () => undefined,
  handleCtxOpenDOM: () => undefined,
  handleCtxOpenNewOrder: () => undefined,
  handleCtxOpenProperties: () => undefined,
  handleCtxRefresh: () => undefined,
  handleCtxSaveAsPicture: () => undefined,
  handleCtxTimeframeChange: () => undefined,
  handleCtxToggleAutoScroll: () => undefined,
  handleCtxToggleChartShift: () => undefined,
  handleCtxToggleGrid: () => undefined,
  handleCtxToggleOHLC: () => undefined,
  handleCtxToggleTradeHistory: () => undefined,
  handleCtxToggleTradeHistoryLine: () => undefined,
  handleCtxToggleTradeLevels: () => undefined,
  handleCtxToggleVolumes: () => undefined,
  handleCtxZoomIn: () => undefined,
  handleCtxZoomOut: () => undefined,
  handleLoadTemplate: () => undefined,
  handleOpenTemplateDialog: () => undefined,
  horizLineRef: createRef<HTMLDivElement>(),
  initialLivePriceOverlayColors: {
    lineColor: '#778899',
    badgeBackground: '#778899',
    badgeTextColor: '#ffffff',
  },
  isAdvancedUntitledLight: false,
  livePriceBadgeRef: createRef<HTMLDivElement>(),
  livePriceCountdownRef: createRef<HTMLSpanElement>(),
  livePriceLineRef: createRef<HTMLDivElement>(),
  livePriceValueRef: createRef<HTMLSpanElement>(),
  loadingMessageIdx: 0,
  loadingMessages: ['BTCUSD M1 · Loading…'],
  loadingPhase,
  retainedPublicChartSurface: false,
  localChartType: 'candlestick' as const,
  marketStatus: {
    status: 'open' as const,
    label: 'Open',
    canTrade: true,
    isOpen: true,
    isClosed: false,
    isCloseOnly: false,
    isDisabled: false,
  },
  ohlcCloseRef: createRef<HTMLSpanElement>(),
  ohlcHighRef: createRef<HTMLSpanElement>(),
  ohlcLowRef: createRef<HTMLSpanElement>(),
  ohlcOpenRef: createRef<HTMLSpanElement>(),
  overlayRef: createRef<HTMLDivElement>(),
  priceLabelRef: createRef<HTMLDivElement>(),
  setTemplateDialogOpen: () => undefined,
  setTextInputOverlay: () => undefined,
  setTextInputValue: () => undefined,
  showOneClick: true,
  symbol: 'BTCUSD',
  templateDialogMode: 'load' as const,
  templateDialogOpen: false,
  textInputOverlay: null,
  textInputValue: '',
  timeframe: 'M1' as const,
  timeLabelRef: createRef<HTMLDivElement>(),
  toggleOneClickTrading: () => undefined,
  tradeAllowed: true,
  tr: <T,>(source: T) => source,
  useEnterpriseLightChartPalette: false,
  vertLineRef: createRef<HTMLDivElement>(),
});

describe('TradingChartView loading overlay stacking order', () => {
  it('covers price-anchored trade control bars while keeping the HUD and One-Click panel above it', () => {
    const { container } = render(<TradingChartView {...buildViewProps('receiving')} />);
    const loader = container.querySelector<HTMLElement>('[data-rtx-chart-loading="receiving"]');
    const hud = container.querySelector<HTMLElement>('.rtx-chart-hud');
    const oneClick = container.querySelector<HTMLElement>('[data-testid="mock-one-click"]');

    expect(loader).not.toBeNull();
    expect(hud).not.toBeNull();
    expect(oneClick).not.toBeNull();

    const loaderZ = Number(loader!.style.zIndex);
    const hudZ = Number(hud!.style.zIndex);
    const entryControlZ = Number(
      createEntryTradeControlBar({
        tradeKey: 'trade:2949359',
        ticket: 2949359,
        symbol: 'BTCUSD',
        side: 'BUY',
        volume: 0.01,
        isLightSurface: false,
        leftInset: 16,
        plainLabel: true,
      }).root.style.zIndex,
    );
    const levelControlZ = Number(
      createTradeLevelControlBar({
        tradeKey: 'trade:2949359',
        role: 'SL',
        side: 'BUY',
        label: 'SL',
        pips: -10,
        money: -1,
        isLightSurface: false,
        leftInset: 16,
        onRemove: () => undefined,
      }).style.zIndex,
    );
    const dockChipZ = Number(
      createDockedLevelChip({
        tradeKey: 'trade:2949359',
        role: 'TP',
        label: 'TP',
        isLightSurface: false,
        leftInset: 16,
      }).style.zIndex,
    );

    expect(loaderZ).toBeGreaterThan(entryControlZ);
    expect(loaderZ).toBeGreaterThan(levelControlZ);
    expect(loaderZ).toBeGreaterThan(dockChipZ);
    expect(loaderZ).toBeLessThan(hudZ);
    expect(loader!.className).toContain('pointer-events-auto');
    expect(loader!.className).not.toContain('pointer-events-none');
  });

  it('releases pointer events during the ready fade-out and unmounts when hidden', () => {
    const { container, rerender } = render(<TradingChartView {...buildViewProps('connecting')} />);
    const connectingLoader = container.querySelector<HTMLElement>('[data-rtx-chart-loading="connecting"]');
    expect(connectingLoader?.className).toContain('pointer-events-auto');
    expect(connectingLoader?.className).toContain('opacity-100');

    rerender(<TradingChartView {...buildViewProps('ready')} />);
    const readyLoader = container.querySelector<HTMLElement>('[data-rtx-chart-loading="ready"]');
    expect(readyLoader?.className).toContain('pointer-events-none');
    expect(readyLoader?.className).toContain('opacity-0');

    rerender(<TradingChartView {...buildViewProps('hidden')} />);
    expect(container.querySelector('[data-rtx-chart-loading]')).toBeNull();
  });
});
