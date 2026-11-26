import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DepthOfMarket } from './DepthOfMarket';
import { readDepthTypography } from './depthOfMarketModel';
import { defaultChartProperties, useChartSettingsStore } from '../store/useChartSettingsStore';

const market = vi.hoisted(() => ({
  tick: { bid: 100, ask: 100.1, timestamp: 1, volume: 2 },
}));

vi.mock('../store/useMarketDataStore', () => ({ useCurrentTick: () => market.tick }));
vi.mock('../hooks/useLiveMarketData', () => ({
  useLiveOrderBook: () => ({
    orderBook: { asks: [{ price: 100.1, volume: 2 }], bids: [{ price: 100, volume: 2 }] },
    loading: false,
    error: null,
  }),
}));
vi.mock('../hooks/useUiTranslation', () => ({ useUiTranslation: () => (text: string) => text }));

describe('Depth of Market typography', () => {
  beforeEach(() => {
    market.tick = { bid: 100, ask: 100.1, timestamp: 1, volume: 2 };
    document.documentElement.style.cssText = '';
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.style.cssText = '';
  });

  it('resolves shared size, weights and family for canvas with readable fallbacks', () => {
    expect(readDepthTypography()).toMatchObject({
      fontSize: 14, bodyWeight: 400, controlWeight: 400, headingWeight: 500, rowHeight: 26,
    });
    const root = document.documentElement;
    root.style.setProperty('--rtx-ui-font-size', '15px');
    root.style.setProperty('--font-mono', 'Consolas, monospace');
    root.style.setProperty('--rtx-font-weight-control', '550');
    expect(readDepthTypography()).toMatchObject({
      fontSize: 15, controlWeight: 550, fontFamily: 'Consolas, monospace', rowHeight: 28,
    });
    root.style.setProperty('--rtx-ui-font-size', '-1px');
    expect(readDepthTypography().fontSize).toBe(14);
  });

  it('draws shared-size text and resizes ladder rows when the font preference changes', async () => {
    vi.useFakeTimers();
    const drawnFonts: string[] = [];
    const context = {
      font: '',
      scale: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
      beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(), setLineDash: vi.fn(), roundRect: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 8 }),
      fillText() { drawnFonts.push(this.font); },
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    document.documentElement.style.setProperty('--font-mono', 'Consolas, monospace');

    const view = render(<DepthOfMarket symbol="BTCUSD" />);
    market.tick = { ...market.tick, timestamp: 2, bid: 100.01 };
    view.rerender(<DepthOfMarket symbol="BTCUSD" />);
    act(() => vi.advanceTimersByTime(100));
    expect(drawnFonts).toContain('400 14px Consolas, monospace');
    expect(drawnFonts.every(font => !font.includes('var('))).toBe(true);
    expect(view.container.querySelector<HTMLElement>('.rtx-depth-of-market__row')?.style.height).toBe('26px');

    await act(async () => {
      document.documentElement.style.setProperty('--rtx-ui-font-size', '15px');
    });
    act(() => vi.advanceTimersByTime(100));
    expect(drawnFonts).toContain('400 15px Consolas, monospace');
    expect(view.container.querySelector<HTMLElement>('.rtx-depth-of-market__row')?.style.height).toBe('28px');
  });

  it('uses the terminal reading face for the light canvas while retaining the dark canvas face', () => {
    const root = document.documentElement;
    root.style.setProperty('--rtx-ui-font-family', 'Segoe UI, Tahoma, sans-serif');
    root.style.setProperty('--font-mono', 'Consolas, monospace');
    root.classList.add('rtx-skin-untitled-light');
    try {
      expect(readDepthTypography().fontFamily).toBe('Segoe UI, Tahoma, sans-serif');
    } finally {
      root.classList.remove('rtx-skin-untitled-light');
    }
    expect(readDepthTypography().fontFamily).toBe('Consolas, monospace');
  });

  it('hides Depth of Market chart volume bars by default and renders them when chart volumes are enabled', () => {
    const initialSettings = useChartSettingsStore.getState();
    const fillRectCalls: Array<{ args: number[]; fillStyle: string }> = [];
    const context = {
      font: '',
      fillStyle: '',
      scale: vi.fn(),
      fillRect: vi.fn(function (this: { fillStyle: string }, ...args: number[]) {
        fillRectCalls.push({ args, fillStyle: this.fillStyle });
      }),
      strokeRect: vi.fn(),
      beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(), setLineDash: vi.fn(), roundRect: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 8 }),
      fillText: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);

    try {
      useChartSettingsStore.setState({
        globalProperties: { ...defaultChartProperties, showTickVolumes: false, showRealVolumes: false },
        symbolProperties: {},
      });

      const view = render(<DepthOfMarket symbol="BTCUSD" />);
      const defaultVolumeBarFills = fillRectCalls.filter((call) => call.fillStyle.includes('0.26') || call.fillStyle.includes('0.24'));
      expect(defaultVolumeBarFills).toHaveLength(0);

      fillRectCalls.length = 0;
      act(() => {
        useChartSettingsStore.getState().updateSymbolProperty('BTCUSD', 'showTickVolumes', true);
      });
      view.rerender(<DepthOfMarket symbol="BTCUSD" />);
      const enabledVolumeBarFills = fillRectCalls.filter((call) => call.fillStyle.includes('0.26') || call.fillStyle.includes('0.24'));
      expect(enabledVolumeBarFills.length).toBeGreaterThan(0);
    } finally {
      useChartSettingsStore.setState(initialSettings);
    }
  });

  it('renders the title bar without status dot or drag-grip clutter, places SL/Volume/TP above toolbar, and aligns sticky column headers with the ladder', () => {
    const view = render(<DepthOfMarket symbol="EURUSD" />);

    expect(view.container.querySelector('.rtx-dom-titlebar .rtx-depth-of-market__heading')?.textContent).toBe('EURUSD');
    expect(view.container.querySelector('.rtx-dom-status-dot')).toBeNull();
    expect(view.container.querySelector('.rtx-dom-drag-hint')).toBeNull();
    expect(view.container.querySelector('.rtx-dom-ladder-scroll .rtx-depth-of-market__columns')).not.toBeNull();
    expect(view.container.querySelector('.rtx-dom-toolbar .rtx-dom-toolbar-group')).not.toBeNull();
    expect(view.container.querySelector('.rtx-dom-param-divider')).toBeNull();
    expect(view.container.querySelector<HTMLCanvasElement>('canvas')?.style.height).toBe('100%');

    const paramsBar = view.container.querySelector('.rtx-dom-params-bar');
    const toolbar = view.container.querySelector('.rtx-dom-toolbar');
    const footer = view.container.querySelector('.rtx-dom-exec-footer');
    expect(paramsBar && toolbar && (paramsBar.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    expect(toolbar && footer && (toolbar.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
  });

  it('draws the default tick chart without scatter-dot markers', () => {
    const arc = vi.fn();
    const context = {
      font: '',
      fillStyle: '',
      strokeStyle: '',
      scale: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
      beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      stroke: vi.fn(), fill: vi.fn(), arc, setLineDash: vi.fn(), roundRect: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 8 }),
      fillText: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);

    render(<DepthOfMarket symbol="BTCUSD" />);
    expect(arc).not.toHaveBeenCalled();
  });

  it('renders ask and bid ladder rows without row backgrounds or volume fill bars, preserving colored text', () => {
    const view = render(<DepthOfMarket symbol="BTCUSD" />);
    const askRow = view.container.querySelector<HTMLElement>('.rtx-dom-level--ask');
    const bidRow = view.container.querySelector<HTMLElement>('.rtx-dom-level--bid');
    const askPrice = view.container.querySelector<HTMLElement>('.rtx-dom-price--ask');
    const bidPrice = view.container.querySelector<HTMLElement>('.rtx-dom-price--bid');

    expect(askRow?.style.background).toBe('');
    expect(bidRow?.style.background).toBe('');
    expect(view.container.querySelector('.rtx-dom-volbar')).toBeNull();
    expect(askPrice?.style.color).toBe('rgb(255, 88, 88)');
    expect(bidPrice?.style.color).toBe('rgb(69, 151, 255)');
  });
});
