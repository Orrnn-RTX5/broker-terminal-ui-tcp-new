// @vitest-environment jsdom

import React, { useEffect } from 'react';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockManager, type DockPanelConfig } from '../../services/dockManager';
import { useDockLayoutStore } from '../../store/useDockLayoutStore';
import { DockContainer, FloatingPanelsLayer } from './DockContainer';

const initialLayout = useDockLayoutStore.getState().layout;

afterEach(() => {
  cleanup();
  useDockLayoutStore.getState().clearMaximizedPanel();
  useDockLayoutStore.getState().setLayout(initialLayout);
  vi.restoreAllMocks();
});

describe('Chart header Fullscreen / Maximize & Exit Fullscreen / Restore Down controls', () => {
  it('places the Fullscreen button immediately before Minimize and Close on Chart panels only', () => {
    const manager = new DockManager();
    manager.updatePanelProps('chart-default-container', {
      title: 'BTCUSD,M1',
      props: { symbol: 'BTCUSD', timeframe: 'M1' },
    });
    useDockLayoutStore.getState().setLayout(manager.getLayout());

    const view = render(<DockContainer isRoot renderPanel={panel => <div>{panel.title}</div>} />);

    // Chart panel header has: [Fullscreen] [Minimize] [Close] in exact order
    const chartPanel = view.container.querySelector<HTMLElement>('[data-dock-panel="chart-default-container"]')!;
    const chartActions = Array.from(chartPanel.querySelectorAll<HTMLButtonElement>('.dock-panel__header > button.dock-panel__action'));
    expect(chartActions.map(btn => btn.getAttribute('title'))).toEqual(['Fullscreen', 'Minimize', 'Close']);
    expect(chartActions[0]).toHaveAttribute('data-dock-action', 'maximize');
    expect(chartActions[0]).toHaveAttribute('aria-pressed', 'false');
    expect(chartActions[0]).toHaveAttribute('aria-label', 'Fullscreen chart BTCUSD');

    // Non-chart panels (Navigator, MarketWatch, Toolbox) must NOT get a Fullscreen button
    for (const nonChartId of ['navigator', 'market-watch', 'toolbox']) {
      const panelEl = view.container.querySelector<HTMLElement>(`[data-dock-panel="${nonChartId}"]`);
      expect(panelEl?.querySelector('[data-dock-action="maximize"]')).toBeNull();
    }
  });

  it('toggles Fullscreen <-> Exit Fullscreen in the exact same header slot without unmounting the chart', () => {
    const manager = new DockManager();
    manager.updatePanelProps('chart-default-container', {
      title: 'BTCUSD,M1',
      props: { symbol: 'BTCUSD', timeframe: 'M1' },
    });
    manager.addChartPanel({ symbol: 'XAUUSD', timeframe: 'H1' });
    useDockLayoutStore.getState().setLayout(manager.getLayout());
    act(() => useDockLayoutStore.getState().arrangeCharts('horizontal'));

    const unmounted = vi.fn();
    const ChartProbe = ({ panel }: { panel: DockPanelConfig }) => {
      useEffect(() => () => unmounted(panel.id), [panel.id]);
      return <div data-test-chart={panel.id}>{panel.props?.symbol}</div>;
    };

    const view = render(
      <DockContainer
        isRoot
        renderPanel={panel => panel.component === 'Chart' ? <ChartProbe panel={panel} /> : <div>{panel.title}</div>}
      />,
    );

    const chartPanel = view.container.querySelector<HTMLElement>('[data-dock-panel="chart-default-container"]')!;
    expect(chartPanel).toHaveAttribute('data-dock-maximized', 'false');

    // Click Fullscreen
    const fullscreenBtn = within(chartPanel).getByRole('button', { name: 'Fullscreen chart BTCUSD' });
    fireEvent.click(fullscreenBtn);

    expect(useDockLayoutStore.getState().maximizedPanelId).toBe('chart-default-container');
    expect(chartPanel).toHaveAttribute('data-dock-maximized', 'true');

    // Same header slot now renders Exit Fullscreen button
    const chartActionsMax = Array.from(chartPanel.querySelectorAll<HTMLButtonElement>('.dock-panel__header > button.dock-panel__action'));
    expect(chartActionsMax.map(btn => btn.getAttribute('title'))).toEqual(['Exit Fullscreen', 'Minimize', 'Close']);
    expect(chartActionsMax[0]).toHaveAttribute('aria-pressed', 'true');
    expect(chartActionsMax[0]).toHaveAttribute('aria-label', 'Exit fullscreen chart BTCUSD');
    expect(unmounted).not.toHaveBeenCalled();

    // Click Exit Fullscreen in the exact same place
    fireEvent.click(chartActionsMax[0]);

    expect(useDockLayoutStore.getState().maximizedPanelId).toBeNull();
    expect(chartPanel).toHaveAttribute('data-dock-maximized', 'false');
    const chartActionsRestored = Array.from(chartPanel.querySelectorAll<HTMLButtonElement>('.dock-panel__header > button.dock-panel__action'));
    expect(chartActionsRestored.map(btn => btn.getAttribute('title'))).toEqual(['Fullscreen', 'Minimize', 'Close']);
    expect(unmounted).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll('[data-test-chart]')).toHaveLength(2);
  });

  it('un-minimizes when maximizing a minimized chart, exits fullscreen on Minimize/Escape/Close/arrangeCharts, and supports floating charts', () => {
    const manager = new DockManager();
    manager.updatePanelProps('chart-default-container', {
      title: 'EURUSD,M15',
      props: { symbol: 'EURUSD', timeframe: 'M15' },
    });
    manager.addChartPanel({ symbol: 'GBPUSD', timeframe: 'H4' });
    useDockLayoutStore.getState().setLayout(manager.getLayout());
    act(() => useDockLayoutStore.getState().arrangeCharts('cascade'));

    const unmounted = vi.fn();
    const ChartProbe = ({ panel }: { panel: DockPanelConfig }) => {
      useEffect(() => () => unmounted(panel.id), [panel.id]);
      return <div data-test-chart={panel.id}>{panel.props?.symbol}</div>;
    };

    const view = render(
      <>
        <DockContainer isRoot renderPanel={panel => panel.component === 'Chart' ? <ChartProbe panel={panel} /> : <div>{panel.title}</div>} />
        <FloatingPanelsLayer renderPanel={panel => panel.component === 'Chart' ? <ChartProbe panel={panel} /> : <div>{panel.title}</div>} />
      </>,
    );

    const floatingChart = view.container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="chart-default-container"]')!;
    expect(floatingChart).toBeTruthy();

    // Minimize first, then click Fullscreen -> must auto-restore from minimized and enter fullscreen
    fireEvent.click(within(floatingChart).getByRole('button', { name: 'Minimize chart EURUSD' }));
    expect(floatingChart).toHaveAttribute('data-dock-minimized', 'true');

    fireEvent.click(within(floatingChart).getByRole('button', { name: 'Fullscreen chart EURUSD' }));
    expect(floatingChart).toHaveAttribute('data-dock-minimized', 'false');
    expect(floatingChart).toHaveAttribute('data-dock-maximized', 'true');
    // Resize handles are hidden while maximized
    expect(floatingChart.querySelectorAll('[data-dock-floating-resize-handle="true"]')).toHaveLength(0);

    // Pressing Escape exits fullscreen cleanly
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useDockLayoutStore.getState().maximizedPanelId).toBeNull();
    expect(floatingChart).toHaveAttribute('data-dock-maximized', 'false');
    expect(floatingChart.querySelectorAll('[data-dock-floating-resize-handle="true"]')).toHaveLength(8);

    // Maximize again, then click Minimize -> exits fullscreen and minimizes
    fireEvent.click(within(floatingChart).getByRole('button', { name: 'Fullscreen chart EURUSD' }));
    expect(floatingChart).toHaveAttribute('data-dock-maximized', 'true');
    fireEvent.click(within(floatingChart).getByRole('button', { name: 'Minimize chart EURUSD' }));
    expect(useDockLayoutStore.getState().maximizedPanelId).toBeNull();
    expect(floatingChart).toHaveAttribute('data-dock-maximized', 'false');
    expect(floatingChart).toHaveAttribute('data-dock-minimized', 'true');

    // Maximize again, then arrangeCharts -> clears maximized state
    fireEvent.click(within(floatingChart).getByRole('button', { name: 'Fullscreen chart EURUSD' }));
    expect(useDockLayoutStore.getState().maximizedPanelId).toBe('chart-default-container');
    act(() => useDockLayoutStore.getState().arrangeCharts('grid'));
    expect(useDockLayoutStore.getState().maximizedPanelId).toBeNull();
    expect(unmounted).not.toHaveBeenCalled();

    // Maximize in docked grid, then Close -> clears maximized state cleanly
    const dockedChart = view.container.querySelector<HTMLElement>('[data-dock-panel="chart-default-container"]')!;
    fireEvent.click(within(dockedChart).getByRole('button', { name: 'Fullscreen chart EURUSD' }));
    expect(useDockLayoutStore.getState().maximizedPanelId).toBe('chart-default-container');
    fireEvent.click(within(dockedChart).getByRole('button', { name: 'Close chart EURUSD' }));
    expect(useDockLayoutStore.getState().maximizedPanelId).toBeNull();
  });
});
