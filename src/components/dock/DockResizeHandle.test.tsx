// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DockContainer as DockContainerType, DockLayout } from '../../services/dockManager';
import { useDockLayoutStore } from '../../store/useDockLayoutStore';
import { DockContainer } from './DockContainer';

const originalLayout = useDockLayoutStore.getState().layout;

const createSplitLayout = (chartRatio = 0.5, toolboxRatio = 0.5): DockLayout => ({
  version: '2.6',
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
        ratio: 0.2,
        children: [
          { id: 'market-watch', title: 'Market Watch', component: 'MarketWatch', ratio: 0.5 },
          { id: 'navigator', title: 'Navigator', component: 'Navigator', ratio: 0.5 },
        ],
      },
      {
        id: 'center-main',
        type: 'split',
        direction: 'vertical',
        ratio: 0.8,
        children: [
          { id: 'chart-default-container', title: 'EURUSD,M1', component: 'Chart', ratio: chartRatio },
          { id: 'toolbox', title: 'Toolbox', component: 'Terminal', ratio: toolboxRatio },
        ],
      },
    ],
  },
});

const mockRect = (el: HTMLElement | null, rect: { left: number; top: number; width: number; height: number }) => {
  if (!el) throw new Error('Expected element to mock bounding rect');
  el.getBoundingClientRect = () => ({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  });
};

describe('MT5-style DockResizeHandle drag preview and atomic resize commit', () => {
  beforeEach(() => {
    useDockLayoutStore.getState().setLayout(createSplitLayout(0.5, 0.5));
  });

  afterAll(() => {
    useDockLayoutStore.getState().setLayout(originalLayout);
  });

  it('shows an ns-resize handle above BottomDock z-index, drags a preview guide line without mid-drag layout churn, and commits atomically on release', () => {
    const { container } = render(
      <DockContainer
        isRoot
        renderPanel={(panel) => <div data-testid={`panel-${panel.id}`}>{panel.title}</div>}
      />,
    );

    const centerMain = container.querySelector<HTMLElement>('[data-dock-container="center-main"]');
    const centerHandle = centerMain?.querySelector<HTMLElement>('[data-dock-resize-handle="horizontal"]') ?? null;
    const hitTarget = centerHandle?.querySelector<HTMLElement>('[data-dock-resize-hit-target="horizontal"]') ?? null;

    expect(centerHandle).not.toBeNull();
    expect(hitTarget).not.toBeNull();
    // Sits above BottomDock (zIndex: 30) and its header (z-40).
    expect(centerHandle?.className).toContain('z-[60]');
    expect(hitTarget?.className).toContain('cursor-ns-resize');

    mockRect(centerMain, { left: 240, top: 80, width: 960, height: 800 });
    mockRect(centerHandle, { left: 240, top: 480, width: 960, height: 0 });

    // Start drag on the divider between Chart and Toolbox
    fireEvent.mouseDown(hitTarget!, { button: 0, clientX: 600, clientY: 480 });
    expect(document.body.style.cursor).toBe('ns-resize');

    const preview = document.body.querySelector<HTMLElement>('[data-dock-resize-preview="horizontal"]');
    expect(preview).not.toBeNull();
    expect(preview?.style.left).toBe('240px');
    expect(preview?.style.width).toBe('960px');

    // Drag down by 200px (25% of 800px height): Chart should become 0.75, Toolbox 0.25 on release
    fireEvent.mouseMove(window, { clientX: 600, clientY: 680 });

    const movedPreview = document.body.querySelector<HTMLElement>('[data-dock-resize-preview="horizontal"]');
    expect(movedPreview?.style.top).toBe('680px');
    expect(movedPreview?.style.height).toBe('1px');

    // Layout has NOT churned mid-drag (MT5 commit-on-release behavior)
    const midCenterMain = (useDockLayoutStore.getState().layout.root.children[1] as DockContainerType);
    expect(midCenterMain.children[0].ratio).toBeCloseTo(0.5, 4);
    expect(midCenterMain.children[1].ratio).toBeCloseTo(0.5, 4);

    // Release commits atomically with zero normalizeRatios drift
    act(() => {
      fireEvent.mouseUp(window);
    });

    expect(document.body.querySelector('[data-dock-resize-preview]')).toBeNull();
    expect(document.body.style.cursor).toBe('');

    const finalCenterMain = (useDockLayoutStore.getState().layout.root.children[1] as DockContainerType);
    expect(finalCenterMain.children[0].ratio).toBeCloseTo(0.75, 4);
    expect(finalCenterMain.children[1].ratio).toBeCloseTo(0.25, 4);
  });

  it('clamps both the preview bar and committed ratios so neither panel collapses below its minimum height', () => {
    const { container } = render(
      <DockContainer
        isRoot
        renderPanel={(panel) => <div>{panel.title}</div>}
      />,
    );

    const centerMain = container.querySelector<HTMLElement>('[data-dock-container="center-main"]');
    const centerHandle = centerMain?.querySelector<HTMLElement>('[data-dock-resize-handle="horizontal"]') ?? null;
    const hitTarget = centerHandle?.querySelector<HTMLElement>('[data-dock-resize-hit-target="horizontal"]') ?? null;

    mockRect(centerMain, { left: 240, top: 80, width: 960, height: 800 });
    mockRect(centerHandle, { left: 240, top: 480, width: 960, height: 0 });

    // Attempt to drag 600px down past the bottom edge (800px height -> min Toolbox height is 100px = 0.125, maxDelta = 300px)
    fireEvent.mouseDown(hitTarget!, { button: 0, clientX: 600, clientY: 480 });
    fireEvent.mouseMove(window, { clientX: 600, clientY: 1080 });

    const clampedPreview = document.body.querySelector<HTMLElement>('[data-dock-resize-preview="horizontal"]');
    // 480 + 300 = 780px
    expect(clampedPreview?.style.top).toBe('780px');

    act(() => {
      fireEvent.mouseUp(window);
    });

    const finalCenterMain = (useDockLayoutStore.getState().layout.root.children[1] as DockContainerType);
    expect(finalCenterMain.children[0].ratio).toBeCloseTo(0.875, 4);
    expect(finalCenterMain.children[1].ratio).toBeCloseTo(0.125, 4);
  });

  it('cancels the resize without changing panel ratios when Escape is pressed mid-drag', () => {
    const { container } = render(
      <DockContainer
        isRoot
        renderPanel={(panel) => <div>{panel.title}</div>}
      />,
    );

    const centerMain = container.querySelector<HTMLElement>('[data-dock-container="center-main"]');
    const centerHandle = centerMain?.querySelector<HTMLElement>('[data-dock-resize-handle="horizontal"]') ?? null;
    const hitTarget = centerHandle?.querySelector<HTMLElement>('[data-dock-resize-hit-target="horizontal"]') ?? null;

    mockRect(centerMain, { left: 240, top: 80, width: 960, height: 800 });
    mockRect(centerHandle, { left: 240, top: 480, width: 960, height: 0 });

    fireEvent.mouseDown(hitTarget!, { button: 0, clientX: 600, clientY: 480 });
    fireEvent.mouseMove(window, { clientX: 600, clientY: 640 });
    expect(document.body.querySelector('[data-dock-resize-preview="horizontal"]')).not.toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(document.body.querySelector('[data-dock-resize-preview]')).toBeNull();
    const finalCenterMain = (useDockLayoutStore.getState().layout.root.children[1] as DockContainerType);
    expect(finalCenterMain.children[0].ratio).toBeCloseTo(0.5, 4);
    expect(finalCenterMain.children[1].ratio).toBeCloseTo(0.5, 4);
  });

  it('aligns the left-sidebar edge pixel-exact to the vertical resize line even when rendered width differs from stored ratio', () => {
    const { container } = render(
      <DockContainer
        isRoot
        renderPanel={(panel) => <div>{panel.title}</div>}
      />,
    );

    const root = container.querySelector<HTMLElement>('[data-dock-container="root"]');
    const sidebarChild = container.querySelector<HTMLElement>('[data-dock-child="left-sidebar"]');
    const centerChild = container.querySelector<HTMLElement>('[data-dock-child="center-main"]');
    const verticalHandle = root?.querySelector<HTMLElement>(':scope > [data-dock-resize-handle="vertical"]') ?? null;
    const hitTarget = verticalHandle?.querySelector<HTMLElement>('[data-dock-resize-hit-target="vertical"]') ?? null;

    expect(verticalHandle).not.toBeNull();
    expect(hitTarget).not.toBeNull();

    // Suppose stored ratio is 0.20 (250px of 1250px), but actual rendered width was 280px (e.g. CSS min-width).
    mockRect(root, { left: 30, top: 80, width: 1250, height: 800 });
    mockRect(sidebarChild, { left: 30, top: 80, width: 280, height: 800 });
    mockRect(centerChild, { left: 310, top: 80, width: 970, height: 800 });
    mockRect(verticalHandle, { left: 310, top: 80, width: 0, height: 800 });

    // Drag right by +150px (drop line at x = 460 -> sidebar width should be 280 + 150 = 430px -> ratio 430/1250 = 0.344).
    fireEvent.mouseDown(hitTarget!, { button: 0, clientX: 310, clientY: 300 });
    fireEvent.mouseMove(window, { clientX: 460, clientY: 300 });

    const preview = document.body.querySelector<HTMLElement>('[data-dock-resize-preview="vertical"]');
    expect(preview?.style.left).toBe('460px');
    expect(preview?.style.width).toBe('1px');

    act(() => {
      fireEvent.mouseUp(window);
    });

    const finalRoot = useDockLayoutStore.getState().layout.root;
    expect(finalRoot.children[0].ratio).toBeCloseTo(430 / 1250, 4);
    expect(finalRoot.children[1].ratio).toBeCloseTo(820 / 1250, 4);
  });

  it('respects a live CSS min-width on the sidebar so the preview line never goes past where the sidebar can shrink', () => {
    const { container } = render(
      <DockContainer
        isRoot
        renderPanel={(panel) => <div>{panel.title}</div>}
      />,
    );

    const root = container.querySelector<HTMLElement>('[data-dock-container="root"]');
    const sidebarChild = container.querySelector<HTMLElement>('[data-dock-child="left-sidebar"]');
    const centerChild = container.querySelector<HTMLElement>('[data-dock-child="center-main"]');
    const verticalHandle = root?.querySelector<HTMLElement>(':scope > [data-dock-resize-handle="vertical"]') ?? null;
    const hitTarget = verticalHandle?.querySelector<HTMLElement>('[data-dock-resize-hit-target="vertical"]') ?? null;

    sidebarChild!.style.minWidth = '240px';
    mockRect(root, { left: 30, top: 80, width: 1250, height: 800 });
    mockRect(sidebarChild, { left: 30, top: 80, width: 300, height: 800 });
    mockRect(centerChild, { left: 330, top: 80, width: 950, height: 800 });
    mockRect(verticalHandle, { left: 330, top: 80, width: 0, height: 800 });

    // Try dragging 200px left (would be 100px wide), must clamp preview & commit at 240px (delta = -60 -> x = 270px).
    fireEvent.mouseDown(hitTarget!, { button: 0, clientX: 330, clientY: 300 });
    fireEvent.mouseMove(window, { clientX: 130, clientY: 300 });

    const preview = document.body.querySelector<HTMLElement>('[data-dock-resize-preview="vertical"]');
    expect(preview?.style.left).toBe('270px');

    act(() => {
      fireEvent.mouseUp(window);
    });

    const finalRoot = useDockLayoutStore.getState().layout.root;
    expect(finalRoot.children[0].ratio).toBeCloseTo(240 / 1250, 4);
    expect(finalRoot.children[1].ratio).toBeCloseTo(1010 / 1250, 4);
  });
});

