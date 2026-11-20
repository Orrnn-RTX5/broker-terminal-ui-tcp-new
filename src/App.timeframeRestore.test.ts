// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDockLayoutStore } from './store/useDockLayoutStore';
import { findChartPanelById } from './services/chartPanelNavigation';
import { applyChartTimeframeCommand, CHART_TIMEFRAMES } from './services/chartTimeframeCommand';
import { getActiveChartCommandTarget, getPanelIdFromChartContextId } from './services/chartCommandTarget';
import { activateActiveChartSource, clearActiveChartSources, registerActiveChartSource } from './services/activeChartSource';
import { commandBus } from './services/commandBus';
import {
  normalizePersistedTimeframe,
  readPersistedTimeframe,
  TIMEFRAME_STORAGE_KEY,
  writePersistedTimeframe,
} from './utils/chartTimeframePersistence';
import { normalizeSymbolName } from './utils/symbolEligibility';
import { initialToolbarState } from './store/toolbarState';
import { useToolbarState } from './hooks/useToolbarState';

const appSourceText = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const appSourceFile = ts.createSourceFile(
  'App.tsx',
  appSourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

let bootEffectArrow: ts.ArrowFunction | undefined;
let commandBusEffectArrow: ts.ArrowFunction | undefined;

const collectEffects = (node: ts.Node): void => {
  if (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'useEffect'
    && node.arguments[0]
    && ts.isArrowFunction(node.arguments[0])
  ) {
    const text = node.arguments[0].getText(appSourceFile);
    if (text.includes('resetToDefaultLayout()') && text.includes('readPersistedTimeframe()')) {
      bootEffectArrow = node.arguments[0];
    } else if (text.includes("commandBus.subscribe('SET_TIMEFRAME'")) {
      commandBusEffectArrow = node.arguments[0];
    }
  }
  ts.forEachChild(node, collectEffects);
};
collectEffects(appSourceFile);

if (!bootEffectArrow) throw new Error('App boot layout effect was not found');
if (!commandBusEffectArrow) throw new Error('App commandBus SET_TIMEFRAME effect was not found');

const bootEffectJs = ts.transpileModule(
  `const runBootEffect = ${bootEffectArrow.getText(appSourceFile)};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

const commandBusEffectJs = ts.transpileModule(
  `const runCommandBusEffect = ${commandBusEffectArrow.getText(appSourceFile)};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

const runAppBootEffect = (options: {
  isAuthenticated?: boolean;
  accountId?: string;
  preserveGuestLayout?: boolean;
  defaultSymbol?: string;
  defaultTimeframe?: string;
} = {}) => {
  const setSelectedSymbol = vi.fn();
  const setTimeframe = vi.fn();
  const setRestoredLayoutAccountId = vi.fn();
  const hasBootedLayoutRef = { current: false };
  const bindings = {
    guestChartLoginContinuity: { preserveGuestLayout: options.preserveGuestLayout ?? false },
    readPersistedSelectedSymbol: () => normalizeSymbolName(localStorage.getItem('rtx5_selected_symbol')),
    readPersistedTimeframe,
    DEFAULT_CHART_SYMBOL: options.defaultSymbol ?? 'BTCUSD',
    DEFAULT_CHART_TIMEFRAME: options.defaultTimeframe ?? 'M1',
    useDockLayoutStore,
    setSelectedSymbol,
    setTimeframe,
    hasBootedLayoutRef,
    isAuthenticated: options.isAuthenticated ?? false,
    accountId: options.accountId ?? '',
    setRestoredLayoutAccountId,
  };
  const fn = new Function(...Object.keys(bindings), `${bootEffectJs}\nreturn runBootEffect;`)(
    ...Object.values(bindings),
  ) as () => void;
  fn();
  return {
    setSelectedSymbol,
    setTimeframe,
    setRestoredLayoutAccountId,
    hasBootedLayoutRef,
    defaultPanel: findChartPanelById(useDockLayoutStore.getState().layout, 'chart-default-container'),
  };
};

const mountAppCommandBusEffect = () => {
  const setChartType = vi.fn();
  const setTimeframe = vi.fn();
  const commitSelectedTimeframe = vi.fn((next: unknown) => {
    const normalized = writePersistedTimeframe(next);
    if (!normalized) return null;
    setTimeframe(normalized);
    return normalized;
  });
  const bindings = {
    commandBus,
    getActiveChartCommandTarget,
    getPanelIdFromChartContextId,
    useDockLayoutStore,
    setChartType,
    useChartSettingsStore: {
      getState: () => ({ updateSymbolProperty: vi.fn(), updateGlobalProperty: vi.fn() }),
    },
    toSettingsChartType: (value: string) => value,
    applyChartTimeframeCommand,
    commitSelectedTimeframe,
    normalizePersistedTimeframe,
    findChartPanelById,
  };
  const fn = new Function(...Object.keys(bindings), `${commandBusEffectJs}\nreturn runCommandBusEffect;`)(
    ...Object.values(bindings),
  ) as () => () => void;
  const cleanup = fn();
  return { cleanup, setTimeframe, commitSelectedTimeframe };
};

const TEST_SYMBOLS = ['BTCUSD', 'XAUUSD', 'EURUSD', 'ETHUSD', 'GBPUSD', 'BTCUSD.RAW', 'US30'];

beforeEach(() => {
  localStorage.clear();
  clearActiveChartSources();
  useDockLayoutStore.getState().resetToDefaultLayout();
});

afterEach(() => {
  localStorage.clear();
  clearActiveChartSources();
  useDockLayoutStore.getState().resetToDefaultLayout();
  vi.restoreAllMocks();
});

describe('App timeframe restoration across refresh for all symbols', () => {
  it.each(CHART_TIMEFRAMES)('restores %s after refresh for every symbol in guest and authenticated sessions', (timeframe) => {
    for (const symbol of TEST_SYMBOLS) {
      localStorage.setItem('rtx5_selected_symbol', symbol);
      localStorage.setItem(TIMEFRAME_STORAGE_KEY, timeframe);

      const guestBoot = runAppBootEffect({ isAuthenticated: false, accountId: '' });
      expect(guestBoot.setSelectedSymbol).toHaveBeenCalledWith(symbol);
      expect(guestBoot.setTimeframe).toHaveBeenCalledWith(timeframe);
      expect(guestBoot.defaultPanel?.props).toMatchObject({ symbol, timeframe });
      expect(guestBoot.defaultPanel?.title).toBe(`${symbol},${timeframe}`);

      const authBoot = runAppBootEffect({ isAuthenticated: true, accountId: '10001' });
      expect(authBoot.setSelectedSymbol).toHaveBeenCalledWith(symbol);
      expect(authBoot.setTimeframe).toHaveBeenCalledWith(timeframe);
      expect(authBoot.defaultPanel?.props).toMatchObject({ symbol, timeframe });
      expect(authBoot.defaultPanel?.title).toBe(`${symbol},${timeframe}`);
      expect(authBoot.hasBootedLayoutRef.current).toBe(true);
    }
  });

  it('restores the persisted timeframe even when no symbol has been explicitly persisted yet', () => {
    localStorage.setItem(TIMEFRAME_STORAGE_KEY, 'M15');

    const withDefaultSymbol = runAppBootEffect({ defaultSymbol: 'BTCUSD', defaultTimeframe: 'M1' });
    expect(withDefaultSymbol.setSelectedSymbol).toHaveBeenCalledWith('BTCUSD');
    expect(withDefaultSymbol.setTimeframe).toHaveBeenCalledWith('M15');
    expect(withDefaultSymbol.defaultPanel?.props).toMatchObject({ timeframe: 'M15' });
    expect(withDefaultSymbol.defaultPanel?.title).toBe('BTCUSD,M15');

    const unconfiguredTenant = runAppBootEffect({ defaultSymbol: '', defaultTimeframe: 'M1' });
    expect(unconfiguredTenant.setTimeframe).toHaveBeenCalledWith('M15');
    expect(unconfiguredTenant.defaultPanel?.props).toMatchObject({ timeframe: 'M15' });
    expect(unconfiguredTenant.defaultPanel?.title).toBe('Chart,M15');
  });

  it('falls back to DEFAULT_CHART_TIMEFRAME when no valid timeframe is persisted', () => {
    localStorage.setItem('rtx5_selected_symbol', 'XAUUSD');
    localStorage.setItem(TIMEFRAME_STORAGE_KEY, 'INVALID');

    const result = runAppBootEffect({ defaultTimeframe: 'M1' });
    expect(result.setSelectedSymbol).toHaveBeenCalledWith('XAUUSD');
    expect(result.setTimeframe).toHaveBeenCalledWith('M1');
    expect(result.defaultPanel?.props).toMatchObject({ symbol: 'XAUUSD', timeframe: 'M1' });
  });

  it('persists timeframe when changed via SET_TIMEFRAME command (context menu / keyboard shortcut) on active chart without overwriting from inactive siblings', () => {
    const store = useDockLayoutStore.getState();
    store.setLayout({
      version: '2.6',
      floatingPanels: [],
      root: {
        id: 'root',
        type: 'split',
        direction: 'horizontal',
        ratio: 1,
        children: [
          {
            id: 'chart-active',
            title: 'BTCUSD,M1',
            component: 'Chart',
            props: { symbol: 'BTCUSD', timeframe: 'M1', chartType: 'candlestick' },
            ratio: 0.5,
          },
          {
            id: 'chart-sibling',
            title: 'EURUSD,H1',
            component: 'Chart',
            props: { symbol: 'EURUSD', timeframe: 'H1', chartType: 'candlestick' },
            ratio: 0.5,
          },
        ],
      },
    });

    const activeEl = document.createElement('div');
    const siblingEl = document.createElement('div');
    document.body.append(activeEl, siblingEl);
    const offActive = registerActiveChartSource({
      id: 'trading-chart:chart-active',
      getContainer: () => activeEl,
      getSymbol: () => 'BTCUSD',
      getTimeframe: () => findChartPanelById(useDockLayoutStore.getState().layout, 'chart-active')?.props?.timeframe,
    });
    const offSibling = registerActiveChartSource({
      id: 'trading-chart:chart-sibling',
      getContainer: () => siblingEl,
      getSymbol: () => 'EURUSD',
      getTimeframe: () => findChartPanelById(useDockLayoutStore.getState().layout, 'chart-sibling')?.props?.timeframe,
    });
    activateActiveChartSource('trading-chart:chart-active');

    const { cleanup, setTimeframe } = mountAppCommandBusEffect();
    try {
      commandBus.dispatch({
        type: 'SET_TIMEFRAME',
        payload: {
          timeframe: 'M15',
          targetContextId: 'trading-chart:chart-active',
          panelId: 'chart-active',
        },
      });
      expect(findChartPanelById(useDockLayoutStore.getState().layout, 'chart-active')?.props?.timeframe).toBe('M15');
      expect(findChartPanelById(useDockLayoutStore.getState().layout, 'chart-sibling')?.props?.timeframe).toBe('H1');
      expect(localStorage.getItem(TIMEFRAME_STORAGE_KEY)).toBe('M15');
      expect(setTimeframe).toHaveBeenLastCalledWith('M15');

      // Changing an inactive sibling panel must not overwrite the active panel's persisted timeframe.
      commandBus.dispatch({
        type: 'SET_TIMEFRAME',
        payload: {
          timeframe: 'D1',
          targetContextId: 'trading-chart:chart-sibling',
          panelId: 'chart-sibling',
        },
      });
      expect(findChartPanelById(useDockLayoutStore.getState().layout, 'chart-sibling')?.props?.timeframe).toBe('D1');
      expect(localStorage.getItem(TIMEFRAME_STORAGE_KEY)).toBe('M15');

      // Stale/removed panel targets must not overwrite the persisted timeframe.
      commandBus.dispatch({
        type: 'SET_TIMEFRAME',
        payload: {
          timeframe: 'MN',
          targetContextId: 'trading-chart:removed-panel',
          panelId: 'removed-panel',
        },
      });
      expect(localStorage.getItem(TIMEFRAME_STORAGE_KEY)).toBe('M15');
    } finally {
      cleanup();
      offActive();
      offSibling();
      activeEl.remove();
      siblingEl.remove();
    }
  });

  it('hydrates useToolbarState immediately with the restored timeframe while keeping initialToolbarState default', () => {
    expect(initialToolbarState.timeframe).toBe('M1');
    const { result, unmount } = renderHook(() => useToolbarState('M15'));
    expect(result.current.state.timeframe).toBe('M15');
    act(() => {
      result.current.syncState({ type: 'SET_TIMEFRAME', timeframe: 'H4' });
    });
    expect(result.current.state.timeframe).toBe('H4');
    unmount();
  });
});
