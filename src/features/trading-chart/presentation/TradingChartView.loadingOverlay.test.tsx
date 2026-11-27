// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createRef, useState } from 'react';
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
vi.mock('../../../components/ChartSymbolDropdown', () => ({
  ChartSymbolTrigger: ({ symbol }: { symbol: string }) => <span>{symbol}</span>,
}));
vi.mock('../../../components/ChartTemplateDialog', () => ({ ChartTemplateDialog: () => null }));
vi.mock('../../../components/dialogs/ChartBackgroundImageDialog', () => ({
  ChartBackgroundImageDialog: () => null,
}));
vi.mock('../../../components/DrawingContextMenu', () => ({ DrawingContextMenu: () => null }));

const buildViewProps = (loadingPhase: 'connecting' | 'receiving' | 'ready' | 'hidden', activeChartSourceId = 'chart-1') => ({
  activeChartSourceId,
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
  ctxMenu: { visible: false, x: 0, y: 0 },
  ctxShowTradeHistory: true,
  ctxShowTradeHistoryLine: true,
  ctxShowTradeLevels: true,
  currentIndicators: [],
  drawingRuntimeContextRef: {
    current: { contextId: activeChartSourceId, symbol: 'BTCUSD', timeframe: 'M1' as const },
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
  isActive: true,
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

function ZoomChartFixture({ viewProps }: { viewProps: ReturnType<typeof buildViewProps> }) {
  const [menuVisible, setMenuVisible] = useState(false);

  return (
    <TradingChartView
      {...viewProps}
      ctxMenu={{ ...viewProps.ctxMenu, visible: menuVisible }}
      handleContextMenu={(event) => {
        event.preventDefault();
        setMenuVisible(true);
      }}
      closeCtxMenu={() => setMenuVisible(false)}
    />
  );
}

const chooseChartZoom = (chart: HTMLElement) => {
  fireEvent.contextMenu(chart);
  const menu = screen.getByRole('menu', { name: 'Chart context menu' });
  const zoomItems = within(menu).getAllByRole('menuitem', { name: /^Zoom/ });
  expect(zoomItems).toHaveLength(1);
  expect(zoomItems[0]).toHaveAccessibleName('Zoom');
  fireEvent.click(zoomItems[0]);
};

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

  it.each([
    { label: 'light', isAdvancedUntitledLight: true },
    { label: 'dark', isAdvancedUntitledLight: false },
  ])('renders OHLC values with medium weight and no value background pill in $label mode', ({ isAdvancedUntitledLight }) => {
    const props = {
      ...buildViewProps('hidden'),
      isAdvancedUntitledLight,
    };
    const { container } = render(<TradingChartView {...props} />);
    const values = Array.from(container.querySelectorAll<HTMLElement>('.rtx-chart-hud .rtx-chart-hud__ohlc-value'));

    expect(values).toHaveLength(4);
    for (const value of values) {
      expect(value.style.fontWeight).toBe('500');
      expect(value.style.backgroundColor).toBe('transparent');
      expect(value.style.padding).toBe('');
      expect(value.style.borderRadius).toBe('');
    }
  });
});

describe('TradingChartView zoom mode', () => {
  it('opens both controls from one Zoom menu item without applying a zoom step', async () => {
    const viewProps = {
      ...buildViewProps('hidden'),
      handleCtxZoomIn: vi.fn(),
      handleCtxZoomOut: vi.fn(),
    };
    const { rerender } = render(<ZoomChartFixture viewProps={viewProps} />);

    expect(screen.queryByRole('group', { name: 'Zoom In / Zoom Out' })).toBeNull();
    chooseChartZoom(viewProps.containerRef.current!);

    const controls = await screen.findByRole('group', { name: 'Zoom In / Zoom Out' });
    const zoomIn = within(controls).getByRole('button', { name: 'Zoom In' });
    const zoomOut = within(controls).getByRole('button', { name: 'Zoom Out' });
    expect(zoomIn).toHaveFocus();
    expect(screen.queryByRole('menu', { name: 'Chart context menu' })).toBeNull();
    expect(viewProps.handleCtxZoomIn).not.toHaveBeenCalled();
    expect(viewProps.handleCtxZoomOut).not.toHaveBeenCalled();

    fireEvent.click(viewProps.containerRef.current!);
    fireEvent.click(zoomIn);
    fireEvent.click(zoomOut);
    fireEvent.click(zoomIn);
    expect(controls).toBeInTheDocument();
    expect(viewProps.handleCtxZoomIn).toHaveBeenCalledTimes(2);
    expect(viewProps.handleCtxZoomOut).toHaveBeenCalledTimes(1);

    rerender(<ZoomChartFixture viewProps={{ ...viewProps, isActive: false }} />);
    expect(controls).not.toBeVisible();
    rerender(<ZoomChartFixture viewProps={viewProps} />);
    expect(controls).toBeVisible();

    fireEvent.click(within(controls).getByRole('button', { name: 'Close' }));
    expect(controls).not.toBeInTheDocument();
  });

  it('dismisses the focused chart controls with Escape while leaving another chart in zoom mode', async () => {
    const firstChart = buildViewProps('hidden', 'chart-1');
    const secondChart = buildViewProps('hidden', 'chart-2');
    render(
      <>
        <ZoomChartFixture viewProps={firstChart} />
        <ZoomChartFixture viewProps={secondChart} />
      </>,
    );

    chooseChartZoom(firstChart.containerRef.current!);
    const firstControls = await screen.findByRole('group', { name: 'Zoom In / Zoom Out' });
    const secondChartView = within(secondChart.containerRef.current!.parentElement!);
    expect(secondChartView.queryByRole('group', { name: 'Zoom In / Zoom Out' })).toBeNull();

    chooseChartZoom(secondChart.containerRef.current!);
    const secondControls = await secondChartView.findByRole('group', { name: 'Zoom In / Zoom Out' });
    const zoomIn = within(secondControls).getByRole('button', { name: 'Zoom In' });
    expect(zoomIn).toHaveFocus();
    fireEvent.keyDown(zoomIn, { key: 'Escape' });

    expect(secondControls).not.toBeInTheDocument();
    expect(secondChart.containerRef.current).toHaveFocus();
    expect(firstControls).toBeInTheDocument();
  });
});
