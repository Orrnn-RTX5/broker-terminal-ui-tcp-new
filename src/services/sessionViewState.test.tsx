// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomDock } from '../components/BottomDock';
import { useFloatingTerminalPanels } from '../app/ui/useFloatingTerminalPanels';
import { useChartObjectStateStore } from '../store/useChartObjectStateStore';
import { useDockLayoutStore } from '../store/useDockLayoutStore';
import { useLastSymbolStore } from '../store/useLastSymbolStore';
import { TIMEFRAME_STORAGE_KEY } from '../utils/chartTimeframePersistence';
import { resetWorkspaceLayout } from './resetLayout';
import {
  APP_SESSION_ALIVE_KEY,
  reconcileFreshAppLaunch,
  SESSION_VIEW_KEYS,
  writeSessionString,
} from './sessionViewState';

vi.mock('../hooks/useToolboxTradeData', () => ({
  useToolboxTradeData: () => ({
    account: null,
    positions: [],
    pendingPositions: [],
    loading: false,
    error: null,
    login: null,
    restBaseUrl: '',
    wsUrl: '',
    wsState: 'connected',
    lastRestAt: null,
    lastWsAt: null,
    debug: [],
    refresh: vi.fn(),
    removePosition: vi.fn(),
    removePositionsByMode: vi.fn(),
  }),
}));

vi.mock('../features/bottom-dock/history/HistoryTab', () => ({
  HistoryTab: () => <div data-testid="mock-history-tab">History content</div>,
}));

vi.mock('../components/layout/JournalTab', () => ({
  JournalTab: () => <div data-testid="mock-journal-tab">Journal content</div>,
}));

describe('session view persistence across refresh vs reset / fresh reopen', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useChartObjectStateStore.getState().resetAll();
    useLastSymbolStore.getState().setPanelVisible(false);
    useDockLayoutStore.getState().resetToDefaultLayout();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    useChartObjectStateStore.getState().resetAll();
    useLastSymbolStore.getState().setPanelVisible(false);
    useDockLayoutStore.getState().resetToDefaultLayout();
    vi.restoreAllMocks();
  });

  it('preserves timeframe, chart type, and session view state across refresh, but resets on fresh app reopen', () => {
    // 1. Fresh app launch marks the session alive and clears stale local view defaults.
    localStorage.setItem(TIMEFRAME_STORAGE_KEY, 'M30');
    localStorage.setItem('rtx5_chart_type', 'line');
    localStorage.setItem('bottomdock-active-tab', 'History');
    expect(reconcileFreshAppLaunch()).toBe(true);
    expect(sessionStorage.getItem(APP_SESSION_ALIVE_KEY)).toBe('1');
    expect(localStorage.getItem(TIMEFRAME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('rtx5_chart_type')).toBeNull();
    expect(localStorage.getItem('bottomdock-active-tab')).toBeNull();

    // 2. User switches timeframe to M30 and bottom tab to History during the active session.
    localStorage.setItem(TIMEFRAME_STORAGE_KEY, 'M30');
    localStorage.setItem('rtx5_chart_type', 'bar');
    writeSessionString(SESSION_VIEW_KEYS.bottomDockTab, 'History');
    writeSessionString(SESSION_VIEW_KEYS.marketWatchView, 'ticks');

    // 3. Page refresh: sessionStorage still has APP_SESSION_ALIVE_KEY === '1'.
    expect(reconcileFreshAppLaunch()).toBe(false);
    expect(localStorage.getItem(TIMEFRAME_STORAGE_KEY)).toBe('M30');
    expect(localStorage.getItem('rtx5_chart_type')).toBe('bar');
    expect(sessionStorage.getItem(SESSION_VIEW_KEYS.bottomDockTab)).toBe('History');
    expect(sessionStorage.getItem(SESSION_VIEW_KEYS.marketWatchView)).toBe('ticks');

    // 4. Close & reopen application: sessionStorage starts empty.
    sessionStorage.clear();
    expect(reconcileFreshAppLaunch()).toBe(true);
    expect(localStorage.getItem(TIMEFRAME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('rtx5_chart_type')).toBeNull();
    expect(sessionStorage.getItem(SESSION_VIEW_KEYS.bottomDockTab)).toBeNull();
  });

  it('restores BottomDock History tab across remount (refresh) and returns to Trade on Reset Layout', () => {
    const first = render(
      <BottomDock height={250} onClosePosition={vi.fn()} onModifyPosition={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('History', { selector: '.rtx-dock-tab' }));
    expect(screen.getByText('History', { selector: '.rtx-dock-tab' })).toHaveClass('active-tab');
    first.unmount();

    // Simulate page refresh (remount with same sessionStorage).
    render(<BottomDock height={250} onClosePosition={vi.fn()} onModifyPosition={vi.fn()} />);
    expect(screen.getByText('History', { selector: '.rtx-dock-tab' })).toHaveClass('active-tab');

    // Trigger Reset Layout -> returns immediately to Trade and clears saved tab.
    act(() => {
      resetWorkspaceLayout();
    });
    expect(screen.getByText('Trade', { selector: '.rtx-dock-tab' })).toHaveClass('active-tab');
  });

  it('restores floating panels across refresh and closes them on Reset Layout', () => {
    const first = renderHook(() => useFloatingTerminalPanels('BTCUSD'));
    act(() => {
      first.result.current.openDOM('XAUUSD');
      first.result.current.setShowDataWindow(true);
    });
    first.unmount();

    // Simulate refresh: both floating panels restore.
    const reloaded = renderHook(() => useFloatingTerminalPanels('BTCUSD'));
    expect(reloaded.result.current.showDOM).toBe(true);
    expect(reloaded.result.current.domSymbol).toBe('XAUUSD');
    expect(reloaded.result.current.showDataWindow).toBe(true);

    // Reset Layout closes them and resets object visibility/lock state.
    act(() => {
      useChartObjectStateStore.getState().setAllHidden('chart-1', true);
      useLastSymbolStore.getState().setPanelVisible(true);
      resetWorkspaceLayout();
    });
    expect(reloaded.result.current.showDOM).toBe(false);
    expect(reloaded.result.current.showDataWindow).toBe(false);
    expect(useChartObjectStateStore.getState().byContext).toEqual({});
    expect(useLastSymbolStore.getState().panelVisible).toBe(false);
  });
});
