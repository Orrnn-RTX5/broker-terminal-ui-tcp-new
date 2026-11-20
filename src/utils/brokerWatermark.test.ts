import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storageShim = vi.hoisted(() => {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
  };
  const prevStorage = globalThis.localStorage;
  const prevWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true, writable: true });
  if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: memoryStorage, location: { protocol: 'https:', origin: 'https://terminal.example' } },
      configurable: true,
      writable: true,
    });
  }
  return { memoryStorage, prevStorage, prevWindow };
});

import { applyBrokerChrome } from '../services/brokerPresentation';
import {
  applyBackgroundLogoOpacityDefaultMigration,
  defaultChartProperties,
  useChartSettingsStore,
} from '../store/useChartSettingsStore';
import { getChartGridRenderingOptions } from './chartGridOptions';
import {
  getPrimaryBrokerWatermarkUrl,
  isChartBackgroundLogoVisible,
  resolveActiveBrokerWatermarkCandidates,
  setChartBackgroundLogoVisibility,
  toggleChartBackgroundLogoInStore,
} from './brokerWatermark';
import {
  DEFAULT_WATERMARK_OPACITY_PERCENT,
  SquareChartGridPrimitive,
  SQUARE_CHART_GRID_CELL_SIZE_PX,
} from './squareChartGridPrimitive';

const readSource = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');

describe('broker watermark, logo toggle persistence, blur removal, draggable sheets, and contextual menus', () => {
  const originalImage = globalThis.Image;

  beforeEach(() => {
    storageShim.memoryStorage.clear();
    applyBrokerChrome({});
    useChartSettingsStore.getState().resetToDefaults();
  });

  afterEach(() => {
    applyBrokerChrome({});
    Object.defineProperty(globalThis, 'Image', { value: originalImage, configurable: true, writable: true });
    vi.restoreAllMocks();
  });

  afterAll(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: storageShim.prevStorage, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'window', { value: storageShim.prevWindow, configurable: true, writable: true });
  });

  it('keeps showBackgroundLogo and backgroundLogoMode synchronized across toggles and persistence', async () => {
    expect(isChartBackgroundLogoVisible({ showBackgroundLogo: true, backgroundLogoMode: 'default' })).toBe(true);
    expect(isChartBackgroundLogoVisible({ showBackgroundLogo: true, backgroundLogoMode: 'none' })).toBe(false);
    expect(isChartBackgroundLogoVisible({ showBackgroundLogo: false, backgroundLogoMode: 'default' })).toBe(false);

    toggleChartBackgroundLogoInStore('XAUUSD');
    expect(useChartSettingsStore.getState().symbolProperties.XAUUSD.showBackgroundLogo).toBe(false);
    expect(useChartSettingsStore.getState().symbolProperties.XAUUSD.backgroundLogoMode).toBe('none');

    // Persisted settings survive rehydration (simulating browser refresh).
    const persistedRaw = globalThis.localStorage.getItem('rtx-chart-settings');
    expect(persistedRaw).toBeTruthy();
    await useChartSettingsStore.persist.rehydrate();
    expect(useChartSettingsStore.getState().symbolProperties.XAUUSD.showBackgroundLogo).toBe(false);
    expect(useChartSettingsStore.getState().symbolProperties.XAUUSD.backgroundLogoMode).toBe('none');

    // Updating showBackgroundLogo directly keeps backgroundLogoMode synchronized too.
    useChartSettingsStore.getState().updateSymbolProperty('XAUUSD', 'showBackgroundLogo', true);
    expect(useChartSettingsStore.getState().symbolProperties.XAUUSD.backgroundLogoMode).toBe('default');

    setChartBackgroundLogoVisibility('XAUUSD', false);
    expect(useChartSettingsStore.getState().symbolProperties.XAUUSD.showBackgroundLogo).toBe(false);
    expect(useChartSettingsStore.getState().symbolProperties.XAUUSD.backgroundLogoMode).toBe('none');
  });

  it('hot-applies background logo properties and broker watermark updates in TradingChart', () => {
    const chartSource = readSource('src/components/TradingChart.tsx');
    const menuBarSource = readSource('src/components/layout/MenuBar.tsx');
    const propertiesSource = readSource('src/components/dialogs/ChartPropertiesDialog.tsx');

    expect(chartSource).toContain('chartSettings.showBackgroundLogo,');
    expect(chartSource).toContain('chartSettings.backgroundLogoMode,');
    expect(chartSource).toContain('chartSettings.backgroundLogoOpacity,');
    expect(chartSource).toContain('chartSettings.backgroundLogoUrl,');
    expect(chartSource).toContain('chartSettings.backgroundLogoFileDataUrl,');
    expect(chartSource).toContain('brokerWatermarkVersion,');
    expect(chartSource).toContain('subscribeBrokerWatermarkChanges');
    expect(menuBarSource).toContain('toggleChartBackgroundLogoInStore');
    expect(propertiesSource).toContain('isChartBackgroundLogoVisible(showState)');
  });

  it('resolves active broker logo candidates for chart watermark while ignoring placeholders', () => {
    expect(resolveActiveBrokerWatermarkCandidates()).toEqual([]);

    globalThis.localStorage.setItem('logo_url', '/assets/logo.png');
    expect(resolveActiveBrokerWatermarkCandidates()).toEqual([]);

    globalThis.localStorage.setItem('logo_url', 'http://127.0.0.1:18403/brand/terminal-icon.png');
    expect(resolveActiveBrokerWatermarkCandidates()).toEqual([]);

    applyBrokerChrome({
      brokerId: 'broker-alpha',
      brokerName: 'Alpha Markets',
      logoUrl: 'https://cdn.alpha.example/brand-mark.svg',
    });
    expect(getPrimaryBrokerWatermarkUrl()).toBe('https://cdn.alpha.example/brand-mark.svg');
    expect(resolveActiveBrokerWatermarkCandidates()).toContain('https://cdn.alpha.example/brand-mark.svg');

    const gridOptions = getChartGridRenderingOptions(
      {
        showGrid: true,
        gridType: 'square',
        gridLineStyle: 'dashed',
        showBackgroundLogo: true,
        backgroundLogoMode: 'default',
        backgroundLogoOpacity: 20,
      },
      { gridVertical: '#222', gridHorizontal: '#333', background: '#000000' },
    );
    expect(gridOptions.fixedGrid.showBackgroundLogo).toBe(true);
    expect(gridOptions.fixedGrid.backgroundLogoSrc).toBe('https://cdn.alpha.example/brand-mark.svg');

    const hiddenGridOptions = getChartGridRenderingOptions(
      {
        showGrid: true,
        gridType: 'square',
        gridLineStyle: 'dashed',
        showBackgroundLogo: false,
        backgroundLogoMode: 'none',
      },
      { gridVertical: '#222', gridHorizontal: '#333', background: '#000000' },
    );
    expect(hiddenGridOptions.fixedGrid.showBackgroundLogo).toBe(false);
    expect(hiddenGridOptions.fixedGrid.backgroundLogoSrc).toBeUndefined();
  });

  it('falls back through secondary broker watermark candidates if primary logo fails to load', () => {
    const createdImages: Array<{
      src: string;
      complete: boolean;
      naturalWidth: number;
      naturalHeight: number;
      onload?: () => void;
      onerror?: () => void;
    }> = [];

    class MockImage {
      decoding = '';
      complete = false;
      naturalWidth = 0;
      naturalHeight = 0;
      onload?: () => void;
      onerror?: () => void;
      private _src = '';
      set src(value: string) {
        this._src = value;
      }
      get src() {
        return this._src;
      }
      constructor() {
        createdImages.push(this);
      }
    }

    Object.defineProperty(globalThis, 'Image', { value: MockImage, configurable: true, writable: true });

    const requestUpdate = vi.fn();
    const primitive = new SquareChartGridPrimitive({
      visible: false,
      showBackgroundLogo: true,
      backgroundLogoSrc: 'https://broken.example/logo.png',
      backgroundLogoFallbacks: ['https://backup.example/logo.png'],
      isLightBackground: true,
      cellSizeCssPx: SQUARE_CHART_GRID_CELL_SIZE_PX,
      verticalColor: '#222',
      horizontalColor: '#333',
    });

    primitive.attached({ requestUpdate } as never);
    expect(createdImages).toHaveLength(1);
    expect(createdImages[0]?.src).toBe('https://broken.example/logo.png');

    // Primary fails -> listener fires -> next draw/applyOptions attempts backup.
    createdImages[0]?.onerror?.();
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      drawImage: vi.fn(),
      fill: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      globalAlpha: 1,
    };
    const target = {
      useBitmapCoordinateSpace: (cb: (args: {
        context: typeof context;
        bitmapSize: { width: number; height: number };
        horizontalPixelRatio: number;
        verticalPixelRatio: number;
      }) => void) => cb({
        context,
        bitmapSize: { width: 800, height: 600 },
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
      }),
    };

    primitive.paneViews()[0]!.renderer()!.draw(target as never);
    expect(createdImages).toHaveLength(2);
    expect(createdImages[1]?.src).toBe('https://backup.example/logo.png');

    createdImages[1]!.complete = true;
    createdImages[1]!.naturalWidth = 128;
    createdImages[1]!.naturalHeight = 64;
    primitive.paneViews()[0]!.renderer()!.draw(target as never);
    expect(context.drawImage).toHaveBeenCalledWith(createdImages[1], expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number));
  });

  it('removes backdrop blur from modal action sheets and dialog backdrops', () => {
    const cssFiles = [
      'src/styles/order-panel-dialog.css',
      'src/styles/modify-position-dialog.css',
      'src/styles/trade-auth-dialog.css',
      'src/styles/action-feedback-toast.css',
      'src/styles/login-dialog.css',
      'src/components/settings/options-dialog.css',
      'src/components/dialogs/open-account-dialog.css',
    ];
    for (const file of cssFiles) {
      expect(readSource(file)).not.toMatch(/backdrop-filter:\s*blur\(/i);
    }

    const tsxFiles = [
      'src/components/dialogs/ChartPropertiesDialog.tsx',
      'src/components/dialogs/ChartObjectsDialog.tsx',
      'src/components/ChangePasswordDialog.tsx',
      'src/components/dialogs/SavePictureDialog.tsx',
      'src/components/ChartTemplateDialog.tsx',
      'src/components/layout/UpdateBanner.tsx',
    ];
    for (const file of tsxFiles) {
      expect(readSource(file)).not.toMatch(/backdrop-blur-/);
    }

    expect(readSource('src/components/ChartContextMenu.tsx')).not.toMatch(/blur\(/i);
    expect(readSource('src/components/ui/ContextMenu.tsx')).not.toMatch(/blur\(/i);

    const transparentBackdropFiles = [
      'src/components/TradeUnavailableDialog.tsx',
      'src/components/ui/ConfirmDialog.tsx',
      'src/components/market-watch/MarketWatchSaveSetDialog.tsx',
      'src/components/ChangePasswordDialog.tsx',
      'src/components/dialogs/ChartObjectsDialog.tsx',
      'src/components/dialogs/PrintSetupDialog.tsx',
      'src/components/dialogs/ExitConfirmDialog.tsx',
      'src/components/dialogs/SaveWorkspaceDialog.tsx',
      'src/components/dialogs/ChartPropertiesDialog.tsx',
      'src/components/dialogs/SavePictureDialog.tsx',
      'src/features/bottom-dock/history/HistoryTab.tsx',
    ];
    for (const file of transparentBackdropFiles) {
      expect(readSource(file)).not.toMatch(/inset-0[^"]*bg-black\//);
    }
    expect(readSource('src/index.css')).toContain('background-color: transparent !important;');
    expect(readSource('src/index.css')).toContain('backdrop-filter: none !important;');
    expect(readSource('src/styles/mt5-toolbox-surfaces.css')).not.toContain('rgb(0 0 0 / 60%)');
    expect(readSource('src/styles/mt5-toolbox-surfaces.css')).toContain('background: transparent !important;');
  });

  it('attaches dragging support to all action sheets and opens Trade & History context menus on blank space', () => {
    const draggableDialogs = [
      'src/components/dialogs/ChartPropertiesDialog.tsx',
      'src/components/dialogs/ChartObjectsDialog.tsx',
      'src/components/dialogs/ChartBackgroundImageDialog.tsx',
      'src/components/dialogs/SavePictureDialog.tsx',
      'src/components/dialogs/SaveWorkspaceDialog.tsx',
      'src/components/dialogs/PrintSetupDialog.tsx',
      'src/components/dialogs/PrintPreviewDialog.tsx',
      'src/components/dialogs/ExitConfirmDialog.tsx',
      'src/components/dialogs/OpenAccountDialog.tsx',
      'src/components/settings/OptionsDialog.tsx',
      'src/components/settings/ThemeAppearanceSettings.tsx',
      'src/components/ui/ConfirmDialog.tsx',
      'src/components/ui/BulkCloseConfirmDialog.tsx',
      'src/components/TradeUnavailableDialog.tsx',
      'src/components/ModifyPositionDialog.tsx',
      'src/components/TradeAuthDialog.tsx',
      'src/components/LoginDialog.tsx',
      'src/components/ChangePasswordDialog.tsx',
      'src/components/BugReportDialog.tsx',
      'src/components/ShortcutHelpDialog.tsx',
      'src/components/IndicatorNavigator.tsx',
      'src/components/notifications/ActionFeedbackToast.tsx',
      'src/components/notifications/MarketWatchExportSheet.tsx',
      'src/components/market-watch/MarketWatchSaveSetDialog.tsx',
      'src/drawing-tools/AnnotationEditor.tsx',
    ];
    for (const file of draggableDialogs) {
      expect(readSource(file)).toContain('useDraggableSheet');
    }

    const tradeTabSource = readSource('src/features/bottom-dock/trade/TradeTab.tsx');
    const tradeTableSource = readSource('src/features/bottom-dock/trade/TradeTable.tsx');
    const pendingPanelSource = readSource('src/features/bottom-dock/trade/PendingOrdersPanel.tsx');
    const historyTabSource = readSource('src/features/bottom-dock/history/HistoryTab.tsx');

    expect(tradeTabSource).toContain('position?: ToolboxTradePosition');
    expect(tradeTabSource).toContain('onContextMenu={(event) => handleTradeContextMenu(event)}');
    expect(tradeTableSource).toContain('onContextMenu={(event) => handleTradeContextMenu(event)}');
    expect(pendingPanelSource).toContain('onContextMenu={onEmptyContextMenu}');
    expect(historyTabSource).toContain('onContextMenu={(event) => handleHistoryContextMenu(event)}');
  });

  it('wires ChartContextMenu contextual above/below livePrice pending order options', () => {
    const controllerSource = readSource('src/features/trading-chart/runtime/useTradingChartContextMenu.ts');
    const viewSource = readSource('src/features/trading-chart/presentation/TradingChartView.tsx');
    const menuSource = readSource('src/components/ChartContextMenu.tsx');

    expect(controllerSource).toContain('livePrice?: number;');
    expect(controllerSource).toContain('rawLivePrice = livePriceRef?.current');
    expect(viewSource).toContain('livePrice={ctxMenu.livePrice}');
    expect(menuSource).toContain('isAboveLivePrice');
    expect(menuSource).toContain("orderType: 'Sell Limit'");
    expect(menuSource).toContain("orderType: 'Buy Limit'");
    expect(menuSource).toContain("orderType: 'Buy Stop'");
    expect(menuSource).toContain("orderType: 'Sell Stop'");
    expect(menuSource).toContain('label={tr("New Order")}');
  });

  it('uses increased default background logo opacity and migrates legacy 18% while preserving custom opacity', () => {
    expect(defaultChartProperties.backgroundLogoOpacity).toBe(36);
    expect(DEFAULT_WATERMARK_OPACITY_PERCENT).toBe(36);

    const migrated = applyBackgroundLogoOpacityDefaultMigration(
      { ...defaultChartProperties, backgroundLogoOpacity: 18 },
      {
        EURUSD: { ...defaultChartProperties, backgroundLogoOpacity: 18 },
        XAUUSD: { ...defaultChartProperties, backgroundLogoOpacity: 62 },
      },
      0,
    );
    expect(migrated.backgroundLogoOpacityDefaultMigrationVersion).toBe(1);
    expect(migrated.globalProperties.backgroundLogoOpacity).toBe(36);
    expect(migrated.symbolProperties.EURUSD.backgroundLogoOpacity).toBe(36);
    expect(migrated.symbolProperties.XAUUSD.backgroundLogoOpacity).toBe(62);
  });

  it('resolves runtime-configured broker watermark on a fresh guest web session and prefers live versioned logos over static BROKER_LOGO_URL', () => {
    const win = globalThis.window as unknown as { __RTX_RUNTIME_CONFIG__?: Record<string, unknown> };
    const prevCfg = win.__RTX_RUNTIME_CONFIG__;
    try {
      win.__RTX_RUNTIME_CONFIG__ = {
        CONFIG_SOURCE: 'deployment',
        BACKEND_TARGET: 'web',
        BROKER_ID: 'fresh-web-broker',
        API_HOST: 'https://terminal.example',
        WS_HOST: 'wss://terminal.example',
        DEFAULT_MT5_SERVER: 'Fresh-Live',
        DISCOVERY_BASE_URL: 'https://terminal.example',
      };
      // Empty localStorage and empty chrome -> must still resolve the runtime broker's dynamic logo endpoint.
      const freshCandidates = resolveActiveBrokerWatermarkCandidates();
      expect(freshCandidates).toContain('https://terminal.example/api/v1/brokers/fresh-web-broker/logo');

      // When runtime config pins an unversioned BROKER_LOGO_URL, a newer versioned live chrome URL must win.
      win.__RTX_RUNTIME_CONFIG__.BROKER_LOGO_URL = 'https://terminal.example/api/v1/brokers/fresh-web-broker/logo';
      applyBrokerChrome({
        brokerId: 'fresh-web-broker',
        brokerName: 'Fresh Broker',
        logoUrl: 'https://terminal.example/api/v1/brokers/fresh-web-broker/logo?v=live999',
      });
      const updatedCandidates = resolveActiveBrokerWatermarkCandidates();
      expect(updatedCandidates[0]).toBe('https://terminal.example/api/v1/brokers/fresh-web-broker/logo?v=live999');
    } finally {
      if (prevCfg === undefined) {
        delete win.__RTX_RUNTIME_CONFIG__;
      } else {
        win.__RTX_RUNTIME_CONFIG__ = prevCfg;
      }
    }
  });
});
