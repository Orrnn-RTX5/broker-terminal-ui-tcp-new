// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DockLayout, DockPanelConfig } from '../../services/dockManager';
import { useDockLayoutStore } from '../../store/useDockLayoutStore';
import { DockContainer, FloatingPanelsLayer, GlobalEdgeIndicators } from './DockContainer';
import { DockPanel } from './DockPanel';

const initialLayout = useDockLayoutStore.getState().layout;

const createFullWorkspaceLayout = (): DockLayout => ({
  version: 'mt5-all-panels-float-test',
  floatingPanels: [],
  root: {
    id: 'root',
    type: 'split',
    direction: 'horizontal',
    ratio: 1,
    children: [
      {
        id: 'left-sidebar',
        type: 'split',
        direction: 'vertical',
        ratio: 0.22,
        children: [
          {
            id: 'market-watch',
            title: 'Market Watch',
            component: 'MarketWatch',
            closable: true,
            floatable: true,
            ratio: 0.62,
          },
          {
            id: 'navigator',
            title: 'Navigator',
            component: 'Navigator',
            closable: true,
            floatable: true,
            ratio: 0.38,
          },
        ],
      },
      {
        id: 'center-main',
        type: 'split',
        direction: 'vertical',
        ratio: 0.78,
        children: [
          {
            id: 'chart',
            title: 'EURUSD,H1',
            component: 'Chart',
            closable: true,
            floatable: true,
            ratio: 0.75,
            props: { symbol: 'EURUSD', timeframe: 'H1' },
          },
          {
            id: 'toolbox',
            title: 'Toolbox',
            component: 'Terminal',
            closable: true,
            floatable: true,
            ratio: 0.25,
          },
        ],
      },
    ],
  },
});

const renderMockWorkspacePanel = (panel: DockPanelConfig, _isActive: boolean, isFloating = false) => {
  if (panel.component === 'MarketWatch') {
    return (
      <div className="rtx-market-watch">
        {!isFloating && (
          <div className="rtx-market-watch__header">
            <span>Market Watch: 12:00:00</span>
            <button type="button" aria-label="Close Market Watch">×</button>
          </div>
        )}
        <div data-testid="body-market-watch">Quotes</div>
      </div>
    );
  }
  if (panel.component === 'Terminal') {
    return (
      <div className="rtx-bottom-dock">
        {!isFloating && (
          <div className="rtx-bottom-dock__header dock-panel__header">
            <span className="dock-panel__title">Toolbox</span>
            <button type="button" aria-label="Close Toolbox">×</button>
          </div>
        )}
        <div data-testid="body-toolbox">Positions</div>
      </div>
    );
  }
  return <div data-testid={`body-${panel.id}`}>{panel.title}</div>;
};

afterEach(() => {
  useDockLayoutStore.getState().setLayout(initialLayout);
});

describe('MT5 double-click undock, drag-to-move, and double-click redock across all layout panels', () => {
  it('keeps one outer title, only the close button, and triggers onFloat on header double-click for Navigator', () => {
    const onClose = vi.fn();
    const onFloat = vi.fn();

    const { container } = render(
      <DockPanel
        panel={{
          id: 'navigator',
          title: 'Navigator',
          component: 'Navigator',
          closable: true,
          floatable: true,
          ratio: 0.5,
        }}
        onClose={onClose}
        onFloat={onFloat}
      >
        <div className="navigator-panel">
          <div className="navigator-panel__body">Accounts</div>
        </div>
      </DockPanel>,
    );

    expect(screen.getAllByText('Navigator')).toHaveLength(1);
    expect(screen.getByText('Navigator')).toHaveClass('dock-panel__title');
    expect(container.querySelector('.navigator-panel__header')).toBeNull();
    expect(container.querySelector('.navigator-panel__body')).not.toBeNull();
    expect(screen.queryByTitle('Minimize')).toBeNull();

    const header = container.querySelector('.dock-panel__header')!;
    fireEvent.doubleClick(header);
    expect(onFloat).toHaveBeenCalledTimes(1);

    // Double-clicking the close button should not float
    fireEvent.doubleClick(screen.getByTitle('Close'));
    expect(onFloat).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('undocks Navigator on title-bar double-click, moves smoothly when dragged, and redocks to left-sidebar on double-click', () => {
    useDockLayoutStore.getState().setLayout(createFullWorkspaceLayout());

    const { container } = render(
      <>
        <DockContainer isRoot renderPanel={renderMockWorkspacePanel} />
        <FloatingPanelsLayer renderPanel={renderMockWorkspacePanel} />
      </>,
    );

    const dockedNav = container.querySelector<HTMLElement>('[data-dock-child="navigator"]');
    expect(dockedNav).not.toBeNull();
    const dockedHeader = dockedNav!.querySelector<HTMLElement>('.dock-panel__header')!;
    expect(dockedHeader).not.toBeNull();

    // 1. Double-click docked Navigator header -> undocks into floating mini-frame
    act(() => {
      fireEvent.doubleClick(dockedHeader);
    });

    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(1);
    expect(container.querySelector('[data-dock-child="navigator"]')).toBeNull();

    // Market Watch expands to fill 100% of left-sidebar
    const marketWatchSlot = container.querySelector<HTMLElement>('[data-dock-child="market-watch"]');
    expect(marketWatchSlot?.style.flexGrow).toBe('1');

    const floatingNav = container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="navigator"]');
    expect(floatingNav).not.toBeNull();
    expect(floatingNav?.style.left).toBe('16px');
    expect(floatingNav?.style.top).toBe('64px');
    expect(floatingNav?.style.width).toBe('280px');
    expect(floatingNav?.style.height).toBe('320px');

    // 2. Drag floating Navigator header to a new workspace coordinate
    const floatingHeader = floatingNav!.querySelector<HTMLElement>('.dock-panel__header')!;
    act(() => {
      fireEvent.mouseDown(floatingHeader, { clientX: 60, clientY: 75 });
      fireEvent.mouseMove(window, { clientX: 360, clientY: 235 });
      fireEvent.mouseUp(window, { clientX: 360, clientY: 235 });
    });

    const movedFloatingNav = container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="navigator"]');
    expect(movedFloatingNav?.style.left).toBe('316px');
    expect(movedFloatingNav?.style.top).toBe('224px');

    // 3. Double-click floating Navigator header -> redocks back into left-sidebar below Market Watch
    const movedHeader = movedFloatingNav!.querySelector<HTMLElement>('.dock-panel__header')!;
    act(() => {
      fireEvent.doubleClick(movedHeader);
    });

    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(0);
    const redockedMarketWatch = container.querySelector<HTMLElement>('[data-dock-child="market-watch"]');
    const redockedNavigator = container.querySelector<HTMLElement>('[data-dock-child="navigator"]');
    expect(redockedMarketWatch).not.toBeNull();
    expect(redockedNavigator).not.toBeNull();
    expect(Number(redockedMarketWatch?.style.flexGrow)).toBeCloseTo(0.62, 2);
    expect(Number(redockedNavigator?.style.flexGrow)).toBeCloseTo(0.38, 2);

    // 4. Double-clicking again restores the last moved floating position (316, 224)
    act(() => {
      fireEvent.doubleClick(redockedNavigator!.querySelector<HTMLElement>('.dock-panel__header')!);
    });
    const refloatedNav = container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="navigator"]');
    expect(refloatedNav?.style.left).toBe('316px');
    expect(refloatedNav?.style.top).toBe('224px');

    const resizeHandles = refloatedNav!.querySelectorAll<HTMLElement>('[data-dock-floating-resize-handle="true"]');
    expect(resizeHandles.length).toBe(8);
    resizeHandles.forEach((handle) => {
      expect(handle.className).toContain('bg-transparent');
    });
  });

  it('undocks Market Watch on header double-click without duplicate headers or minimize button, moves when dragged, and redocks above Navigator', () => {
    useDockLayoutStore.getState().setLayout(createFullWorkspaceLayout());

    const { container } = render(
      <>
        <DockContainer isRoot renderPanel={renderMockWorkspacePanel} />
        <FloatingPanelsLayer renderPanel={renderMockWorkspacePanel} />
      </>,
    );

    const dockedMw = container.querySelector<HTMLElement>('[data-dock-child="market-watch"]')!;
    const dockedMwHeader = dockedMw.querySelector<HTMLElement>('.rtx-market-watch__header')!;
    expect(dockedMwHeader).not.toBeNull();

    // 1. Double-click docked Market Watch header -> floats Market Watch
    act(() => {
      fireEvent.doubleClick(dockedMwHeader);
    });

    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(1);
    expect(container.querySelector('[data-dock-child="market-watch"]')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-dock-child="navigator"]')?.style.flexGrow).toBe('1');

    const floatingMw = container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="market-watch"]')!;
    expect(floatingMw).not.toBeNull();
    expect(floatingMw.style.left).toBe('16px');
    expect(floatingMw.style.top).toBe('64px');
    expect(floatingMw.style.width).toBe('280px');
    expect(floatingMw.style.height).toBe('320px');

    // Only one header on floating Market Watch, no Minimize button
    expect(floatingMw.querySelectorAll('.dock-panel__header')).toHaveLength(1);
    expect(floatingMw.querySelector('.rtx-market-watch__header')).toBeNull();
    expect(floatingMw.querySelector('[title="Minimize"]')).toBeNull();

    // 2. Drag floating Market Watch header
    const floatingHeader = floatingMw.querySelector<HTMLElement>('.dock-panel__header')!;
    act(() => {
      fireEvent.mouseDown(floatingHeader, { clientX: 50, clientY: 80 });
      fireEvent.mouseMove(window, { clientX: 250, clientY: 180 });
      fireEvent.mouseUp(window, { clientX: 250, clientY: 180 });
    });

    const movedMw = container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="market-watch"]')!;
    expect(movedMw.style.left).toBe('216px');
    expect(movedMw.style.top).toBe('164px');

    // 3. Double-click floating Market Watch header -> redocks above Navigator with original ratios
    act(() => {
      fireEvent.doubleClick(movedMw.querySelector<HTMLElement>('.dock-panel__header')!);
    });

    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(0);
    const leftSidebar = container.querySelector<HTMLElement>('[data-dock-container="left-sidebar"]')!;
    const sidebarChildren = leftSidebar.querySelectorAll<HTMLElement>(':scope > [data-dock-child]');
    expect(sidebarChildren[0]?.getAttribute('data-dock-child')).toBe('market-watch');
    expect(sidebarChildren[1]?.getAttribute('data-dock-child')).toBe('navigator');
    expect(Number(sidebarChildren[0]?.style.flexGrow)).toBeCloseTo(0.62, 2);
    expect(Number(sidebarChildren[1]?.style.flexGrow)).toBeCloseTo(0.38, 2);
  });

  it('undocks Toolbox on header double-click without duplicate headers or minimize button, moves when dragged, and redocks below Chart', () => {
    useDockLayoutStore.getState().setLayout(createFullWorkspaceLayout());

    const { container } = render(
      <>
        <DockContainer isRoot renderPanel={renderMockWorkspacePanel} />
        <FloatingPanelsLayer renderPanel={renderMockWorkspacePanel} />
      </>,
    );

    const dockedToolbox = container.querySelector<HTMLElement>('[data-dock-child="toolbox"]')!;
    const dockedToolboxHeader = dockedToolbox.querySelector<HTMLElement>('.rtx-bottom-dock__header')!;
    expect(dockedToolboxHeader).not.toBeNull();

    // 1. Double-click docked Toolbox header -> floats Toolbox
    act(() => {
      fireEvent.doubleClick(dockedToolboxHeader);
    });

    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(1);
    expect(container.querySelector('[data-dock-child="toolbox"]')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-dock-child="chart"]')?.style.flexGrow).toBe('1');

    const floatingToolbox = container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="toolbox"]')!;
    expect(floatingToolbox).not.toBeNull();
    expect(floatingToolbox.style.width).toBe('680px');
    expect(floatingToolbox.style.height).toBe('240px');

    // Only one header on floating Toolbox, no Minimize button
    expect(floatingToolbox.querySelectorAll('.dock-panel__header')).toHaveLength(1);
    expect(floatingToolbox.querySelector('.rtx-bottom-dock__header')).toBeNull();
    expect(floatingToolbox.querySelector('[title="Minimize"]')).toBeNull();

    // 2. Drag floating Toolbox header
    const floatingHeader = floatingToolbox.querySelector<HTMLElement>('.dock-panel__header')!;
    const startLeft = Number.parseInt(floatingToolbox.style.left, 10);
    const startTop = Number.parseInt(floatingToolbox.style.top, 10);
    act(() => {
      fireEvent.mouseDown(floatingHeader, { clientX: 300, clientY: 380 });
      fireEvent.mouseMove(window, { clientX: 180, clientY: 260 });
      fireEvent.mouseUp(window, { clientX: 180, clientY: 260 });
    });

    const movedToolbox = container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="toolbox"]')!;
    expect(Number.parseInt(movedToolbox.style.left, 10)).toBe(startLeft - 120);
    expect(Number.parseInt(movedToolbox.style.top, 10)).toBe(startTop - 120);

    // 3. Double-click floating Toolbox header -> redocks below Chart with original ratios
    act(() => {
      fireEvent.doubleClick(movedToolbox.querySelector<HTMLElement>('.dock-panel__header')!);
    });

    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(0);
    const redockedChart = container.querySelector<HTMLElement>('[data-dock-child="chart"]');
    const redockedToolbox = container.querySelector<HTMLElement>('[data-dock-child="toolbox"]');
    expect(redockedChart).not.toBeNull();
    expect(redockedToolbox).not.toBeNull();
    expect(Number(redockedChart?.style.flexGrow)).toBeCloseTo(0.75, 2);
    expect(Number(redockedToolbox?.style.flexGrow)).toBeCloseTo(0.25, 2);
  });

  it('undocks Chart on header or symbol-tab double-click while keeping Toolbox docked at bottom, moves when dragged, and redocks above Toolbox', () => {
    useDockLayoutStore.getState().setLayout(createFullWorkspaceLayout());

    const { container } = render(
      <>
        <DockContainer isRoot renderPanel={renderMockWorkspacePanel} />
        <FloatingPanelsLayer renderPanel={renderMockWorkspacePanel} />
      </>,
    );

    const dockedChart = container.querySelector<HTMLElement>('[data-dock-child="chart"]')!;
    const symbolTabButton = dockedChart.querySelector<HTMLElement>('button[role="tab"]') ?? dockedChart.querySelector<HTMLElement>('.dock-panel__header')!;

    // 1. Double-click docked Chart header (or symbol tab) -> floats Chart and keeps Toolbox at 0.25 via EmptyChartArea
    act(() => {
      fireEvent.doubleClick(symbolTabButton);
    });

    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(1);
    expect(container.querySelector('[data-dock-child="chart"]')).toBeNull();
    const dockedToolbox = container.querySelector<HTMLElement>('[data-dock-child="toolbox"]');
    expect(Number(dockedToolbox?.style.flexGrow)).toBeCloseTo(0.25, 2);

    const floatingChart = container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="chart"]')!;
    expect(floatingChart).not.toBeNull();
    expect(floatingChart.style.left).toBe('100px');
    expect(floatingChart.style.top).toBe('100px');
    expect(floatingChart.style.width).toBe('400px');
    expect(floatingChart.style.height).toBe('300px');

    // 2. Drag floating Chart header
    const floatingHeader = floatingChart.querySelector<HTMLElement>('.dock-panel__header')!;
    act(() => {
      fireEvent.mouseDown(floatingHeader, { clientX: 140, clientY: 115 });
      fireEvent.mouseMove(window, { clientX: 290, clientY: 195 });
      fireEvent.mouseUp(window, { clientX: 290, clientY: 195 });
    });

    const movedChart = container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="chart"]')!;
    expect(movedChart.style.left).toBe('250px');
    expect(movedChart.style.top).toBe('180px');

    // 3. Double-click floating Chart header -> removes EmptyChartArea and redocks Chart above Toolbox
    act(() => {
      fireEvent.doubleClick(movedChart.querySelector<HTMLElement>('.dock-panel__header')!);
    });

    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(0);
    expect(container.querySelector('[data-dock-panel-component="emptychartarea"]')).toBeNull();
    const redockedChart = container.querySelector<HTMLElement>('[data-dock-child="chart"]');
    const redockedToolbox = container.querySelector<HTMLElement>('[data-dock-child="toolbox"]');
    expect(redockedChart).not.toBeNull();
    expect(redockedToolbox).not.toBeNull();
    expect(Number(redockedChart?.style.flexGrow)).toBeCloseTo(0.75, 2);
    expect(Number(redockedToolbox?.style.flexGrow)).toBeCloseTo(0.25, 2);
  });

  it('drags docked Toolbox from its inner view bar and bottom tab strip while ignoring toolbar inputs, selects, and action buttons', () => {
    useDockLayoutStore.getState().setLayout(createFullWorkspaceLayout());
    const onPositionsClick = vi.fn();
    const onHistoryTabClick = vi.fn();
    const onCloseAllClick = vi.fn();

    const renderRealLikeToolbox = (panel: DockPanelConfig, _isActive: boolean, isFloating = false) => {
      if (panel.component !== 'Terminal') {
        return renderMockWorkspacePanel(panel, _isActive, isFloating);
      }
      return (
        <div className="rtx-bottom-dock">
          {!isFloating && (
            <div className="rtx-bottom-dock__header dock-panel__header">
              <button type="button" aria-label="Close Toolbox">×</button>
            </div>
          )}
          <div className="rtx-bottom-dock__content">
            <div className="rtx-trade-tab">
              <div className="rtx-trade-view-bar" role="tablist" data-dock-inner-header="true">
                <button type="button" role="tab" onClick={onPositionsClick}>Positions</button>
                <button type="button" role="tab">Pending Orders</button>
                <input aria-label="Filter logs" />
                <select aria-label="Log type"><option value="all">All</option></select>
              </div>
              <div data-testid="body-toolbox">Positions rows</div>
            </div>
          </div>
          <div className="rtx-bottom-dock__tabs" data-dock-inner-header="true">
            <button type="button" data-dock-drag-handle="true" onClick={onHistoryTabClick}>History</button>
            <button type="button" onClick={onCloseAllClick}>Close All</button>
          </div>
        </div>
      );
    };

    const { container } = render(
      <>
        <DockContainer isRoot renderPanel={renderRealLikeToolbox} />
        <FloatingPanelsLayer renderPanel={renderRealLikeToolbox} />
        <GlobalEdgeIndicators />
      </>,
    );

    const dockedToolbox = container.querySelector<HTMLElement>('[data-dock-child="toolbox"]')!;

    // Interactive controls (input, select, action buttons) must not initiate a dock drag
    const filterInput = screen.getByLabelText('Filter logs');
    act(() => {
      fireEvent.mouseDown(filterInput, { button: 0, clientX: 200, clientY: 600 });
      fireEvent.mouseMove(window, { clientX: 260, clientY: 500 });
      fireEvent.mouseUp(window, { clientX: 260, clientY: 500 });
    });
    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(0);

    const typeSelect = screen.getByLabelText('Log type');
    act(() => {
      fireEvent.mouseDown(typeSelect, { button: 0, clientX: 220, clientY: 600 });
      fireEvent.mouseMove(window, { clientX: 280, clientY: 500 });
      fireEvent.mouseUp(window, { clientX: 280, clientY: 500 });
    });
    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(0);

    const closeAllBtn = screen.getByRole('button', { name: 'Close All' });
    act(() => {
      fireEvent.mouseDown(closeAllBtn, { button: 0, clientX: 400, clientY: 740 });
      fireEvent.mouseMove(window, { clientX: 460, clientY: 600 });
      fireEvent.mouseUp(window, { clientX: 460, clientY: 600 });
      fireEvent.click(closeAllBtn);
    });
    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(0);
    expect(onCloseAllClick).toHaveBeenCalledTimes(1);

    // Dragging the top Positions / Pending Orders bar floats Toolbox without rendering a black drag-ghost pill
    const viewBar = dockedToolbox.querySelector<HTMLElement>('.rtx-trade-view-bar')!;
    act(() => {
      fireEvent.mouseDown(viewBar, { button: 0, clientX: 300, clientY: 600 });
      fireEvent.mouseMove(window, { clientX: 340, clientY: 420 });
    });
    expect(useDockLayoutStore.getState().dragState).toBe('dragging');
    expect(document.documentElement.getAttribute('data-dock-dragging')).toBe('true');
    expect(document.body.querySelector('[data-dock-drag-ghost="true"]')).toBeNull();

    act(() => {
      fireEvent.mouseUp(window, { clientX: 340, clientY: 420 });
    });
    expect(useDockLayoutStore.getState().dragState).toBe('idle');
    expect(document.documentElement.getAttribute('data-dock-dragging')).toBeNull();
    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(1);

    // Dragging the inner view bar while floating moves the floating Toolbox
    const floatingToolbox = container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="toolbox"]')!;
    const startLeft = Number.parseInt(floatingToolbox.style.left, 10);
    const startTop = Number.parseInt(floatingToolbox.style.top, 10);
    const floatingViewBar = floatingToolbox.querySelector<HTMLElement>('.rtx-trade-view-bar')!;
    act(() => {
      fireEvent.mouseDown(floatingViewBar, { button: 0, clientX: 340, clientY: 420 });
      fireEvent.mouseMove(window, { clientX: 420, clientY: 360 });
      fireEvent.mouseUp(window, { clientX: 420, clientY: 360 });
    });
    const movedToolbox = container.querySelector<HTMLElement>('[data-dock-floating-panel="true"][data-dock-panel="toolbox"]')!;
    expect(Number.parseInt(movedToolbox.style.left, 10)).toBe(startLeft + 80);
    expect(Number.parseInt(movedToolbox.style.top, 10)).toBe(startTop - 60);

    // Redock Toolbox, then verify dragging from an enabled bottom section tab floats without firing a stray tab click
    act(() => {
      useDockLayoutStore.getState().redockPanel('toolbox');
    });
    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(0);

    const historyTab = screen.getByRole('button', { name: 'History' });
    act(() => {
      fireEvent.mouseDown(historyTab, { button: 0, clientX: 160, clientY: 740 });
      fireEvent.mouseMove(window, { clientX: 220, clientY: 500 });
      fireEvent.mouseUp(window, { clientX: 220, clientY: 500 });
      fireEvent.click(historyTab);
    });
    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(1);
    expect(onHistoryTabClick).not.toHaveBeenCalled();

    // Redock again and verify a normal click (< 4px) on a tab still works
    act(() => {
      useDockLayoutStore.getState().redockPanel('toolbox');
    });
    const positionsTab = screen.getByRole('tab', { name: 'Positions' });
    act(() => {
      fireEvent.mouseDown(positionsTab, { button: 0, clientX: 100, clientY: 600 });
      fireEvent.mouseUp(window, { clientX: 100, clientY: 600 });
      fireEvent.click(positionsTab);
    });
    expect(useDockLayoutStore.getState().layout.floatingPanels).toHaveLength(0);
    expect(onPositionsClick).toHaveBeenCalledTimes(1);
  });
});
