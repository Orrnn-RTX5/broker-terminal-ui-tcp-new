import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChartPropertiesDialog } from './ChartPropertiesDialog';
import { candleAggregationService } from '../../services/candleAggregationService';
import { defaultChartProperties, getPresetSchemeColors, useChartSettingsStore } from '../../store/useChartSettingsStore';
import { useMarketDataStore } from '../../store/useMarketDataStore';

describe('Chart Properties keyboard ownership', () => {
  it('exposes keyboard-operated tabs and renders the live color preview without help chrome', () => {
    render(<ChartPropertiesDialog isOpen symbol="EURUSD" timeframe="M1" onClose={vi.fn()} />);
    expect(screen.queryByText('?') ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Help' })).not.toBeInTheDocument();
    const common = screen.getByRole('tab', { name: 'Common', selected: true });
    common.focus();
    fireEvent.keyDown(common, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Show', selected: true })).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'Show' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Show' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Colors', selected: true })).toHaveFocus();
    expect(screen.queryByText('Background and grid preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('cp-color-preview-chart')).toBeVisible();
    expect(screen.queryByText(/Demo Asset/)).not.toBeInTheDocument();
    const backgroundColor = screen.getByLabelText('Background');
    backgroundColor.focus();
    expect(backgroundColor).toHaveFocus();
    expect(backgroundColor.closest('.rtx-cp-color-picker')).not.toBeNull();
  });

  it('leaves a newer help dialog focused and closes only for its own Escape', () => {
    const onClose = vi.fn(); const nextClose = vi.fn();
    const { rerender } = render(<ChartPropertiesDialog isOpen symbol="EURUSD" timeframe="M1" onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();
    const help = document.createElement('div'); help.setAttribute('role', 'dialog'); help.dataset.shortcutScope = 'local';
    const button = document.createElement('button'); help.append(button); document.body.append(help); button.focus();
    const local = vi.fn(); help.addEventListener('keydown', local);
    try {
      rerender(<ChartPropertiesDialog isOpen symbol="EURUSD" timeframe="M1" onClose={nextClose} />);
      expect(button).toHaveFocus();
      fireEvent.keyDown(button, { key: 'Escape', cancelable: true });
      expect(local).toHaveBeenCalledOnce();
      expect(onClose).not.toHaveBeenCalled(); expect(nextClose).not.toHaveBeenCalled();
    } finally { help.remove(); }
    dialog.focus(); fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(nextClose).toHaveBeenCalledOnce();
  });
});

describe('Chart Properties grid settings', () => {
  it.each(['Green and White', 'Green and Blue', 'Blue and White'] as const)('previews %s on the active symbol and restores the original scheme on Cancel', (preset) => {
    const initial = useChartSettingsStore.getState();
    useChartSettingsStore.setState({ globalProperties: { ...defaultChartProperties }, symbolProperties: {} });
    const { unmount } = render(<ChartPropertiesDialog isOpen symbol="EURUSD" timeframe="M1" onClose={vi.fn()} />);
    try {
      fireEvent.click(screen.getByRole('tab', { name: 'Colors' }));
      const scheme = screen.getByDisplayValue('Blue and Red');
      fireEvent.change(scheme, { target: { value: preset } });
      expect(scheme).toHaveValue(preset);
      expect(useChartSettingsStore.getState().symbolProperties.EURUSD.colors).toEqual(getPresetSchemeColors(preset));
      const preview = screen.getByRole('dialog').querySelector<HTMLElement>('.rtx-cp-preview-inner')!;
      expect(preview.style.backgroundColor).toBe('rgb(0, 0, 0)');
      if (preset !== 'Blue and White') {
        expect(decodeURIComponent(preview.style.backgroundImage)).toContain('#778899');
      }
      expect(useChartSettingsStore.getState().globalProperties.colorScheme).toBe('Blue and Red');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(useChartSettingsStore.getState().symbolProperties.EURUSD.colorScheme).toBe('Blue and Red');
    } finally {
      unmount();
      useChartSettingsStore.setState(initial);
    }
  });
  it('displays Black instead of White for white color templates and black candle fills in Light Theme', () => {
    const initial = useChartSettingsStore.getState();
    const root = document.documentElement;
    root.classList.add('rtx-advanced-view', 'rtx-skin-untitled-light');
    useChartSettingsStore.setState({ globalProperties: { ...defaultChartProperties }, symbolProperties: {} });
    const { unmount } = render(<ChartPropertiesDialog isOpen symbol="EURUSD" timeframe="M1" onClose={vi.fn()} />);
    try {
      fireEvent.click(screen.getByRole('tab', { name: 'Colors' }));
      expect(screen.getByRole('option', { name: 'Green and Black' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Blue and Black' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'White and Black' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Yellow and Black' })).toBeInTheDocument();

      const scheme = screen.getByDisplayValue('Blue and Red');
      fireEvent.change(scheme, { target: { value: 'Blue and White' } });
      expect(screen.getByLabelText('Bear candle')).toHaveValue('#000000');
    } finally {
      unmount();
      root.classList.remove('rtx-advanced-view', 'rtx-skin-untitled-light');
      useChartSettingsStore.setState(initial);
    }
  });
  it('previews independent symbol grid choices while Cancel restores the initial settings', () => {
    const initial = useChartSettingsStore.getState();
    useChartSettingsStore.setState({ globalProperties: { ...defaultChartProperties }, symbolProperties: {} });
    const onClose = vi.fn();
    const { unmount } = render(<ChartPropertiesDialog isOpen symbol="EURUSD" timeframe="M1" onClose={onClose} />);
    try {
      fireEvent.click(screen.getByRole('tab', { name: 'Show' }));
      const selector = screen.getByRole('combobox', { name: 'Grid line style' });
      const typeSelector = screen.getByRole('combobox', { name: 'Grid type' });
      const preview = screen.getByRole('dialog').querySelector<HTMLElement>('.rtx-cp-preview-inner')!;
      expect(selector).toHaveValue('dashed');
      expect(typeSelector).toHaveValue('mt5');
      expect(preview.style.backgroundSize).toBe('32px 32px');
      expect(screen.getByRole('option', { name: 'Dashed' })).toBeInTheDocument();
      expect(decodeURIComponent(preview.style.backgroundImage)).toContain('stroke-width="1" stroke-opacity="0.5" stroke-dasharray="1 2"');

      fireEvent.change(typeSelector, { target: { value: 'square' } });
      expect(preview.style.backgroundSize).toBe('64px 64px');
      expect(decodeURIComponent(preview.style.backgroundImage)).toContain('stroke-width="1" stroke-dasharray="1 2"');

      fireEvent.change(typeSelector, { target: { value: 'scale' } });
      expect(useChartSettingsStore.getState().symbolProperties.EURUSD).toMatchObject({
        gridType: 'scale',
        gridLineStyle: 'dashed',
      });
      expect(useChartSettingsStore.getState().globalProperties.gridType).toBe('mt5');
      expect(preview.style.backgroundSize).toBe('128px 48px');
      expect(decodeURIComponent(preview.style.backgroundImage)).toContain('width="128" height="48"');
      expect(decodeURIComponent(preview.style.backgroundImage)).toContain('stroke-width="1" stroke-dasharray="2 2"');

      fireEvent.change(selector, { target: { value: 'solid' } });
      expect(useChartSettingsStore.getState().symbolProperties.EURUSD.gridLineStyle).toBe('solid');
      expect(typeSelector).toHaveValue('scale');
      expect(useChartSettingsStore.getState().globalProperties.gridLineStyle).toBe('dashed');
      expect(decodeURIComponent(preview.style.backgroundImage)).not.toContain('stroke-dasharray');

      fireEvent.click(screen.getByRole('checkbox', { name: 'Show grid' }));
      expect(selector).toBeDisabled();
      expect(typeSelector).toBeDisabled();
      expect(useChartSettingsStore.getState().symbolProperties.EURUSD.gridLineStyle).toBe('solid');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(useChartSettingsStore.getState().symbolProperties.EURUSD).toMatchObject({
        showGrid: true,
        gridType: 'mt5',
        gridLineStyle: 'dashed',
      });
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      unmount();
      useChartSettingsStore.setState(initial);
    }
  });

  it('updates the global grid choices when properties are opened without a symbol', () => {
    const initial = useChartSettingsStore.getState();
    useChartSettingsStore.setState({ globalProperties: { ...defaultChartProperties }, symbolProperties: {} });
    const { unmount } = render(<ChartPropertiesDialog isOpen symbol="" timeframe="M1" onClose={vi.fn()} />);
    try {
      fireEvent.click(screen.getByRole('tab', { name: 'Show' }));
      fireEvent.change(screen.getByRole('combobox', { name: 'Grid line style' }), { target: { value: 'solid' } });
      fireEvent.change(screen.getByRole('combobox', { name: 'Grid type' }), { target: { value: 'scale' } });
      expect(useChartSettingsStore.getState().globalProperties.gridLineStyle).toBe('solid');
      expect(useChartSettingsStore.getState().globalProperties.gridType).toBe('scale');
      fireEvent.change(screen.getByRole('combobox', { name: 'Grid type' }), { target: { value: 'mt5' } });
      expect(useChartSettingsStore.getState().globalProperties).toMatchObject({ gridType: 'mt5', gridLineStyle: 'dashed' });
      expect(useChartSettingsStore.getState().symbolProperties).toEqual({});
    } finally {
      unmount();
      useChartSettingsStore.setState(initial);
    }
  });

  it('previews the dense MT5 grid, starts with short dashes, and preserves subsequent style choices and Cancel', () => {
    const initial = useChartSettingsStore.getState();
    const original = { ...defaultChartProperties, gridType: 'scale' as const, gridLineStyle: 'solid' as const };
    useChartSettingsStore.setState({ globalProperties: original, symbolProperties: {} });
    const { unmount } = render(<ChartPropertiesDialog isOpen symbol="EURUSD" timeframe="M1" onClose={vi.fn()} />);
    try {
      fireEvent.click(screen.getByRole('tab', { name: 'Show' }));
      const type = screen.getByRole('combobox', { name: 'Grid type' });
      const style = screen.getByRole('combobox', { name: 'Grid line style' });
      const preview = screen.getByRole('dialog').querySelector<HTMLElement>('.rtx-cp-preview-inner')!;
      fireEvent.change(type, { target: { value: 'mt5' } });
      expect(type).toHaveValue('mt5');
      expect(screen.getByRole('option', { name: 'Fine grid' })).toBeInTheDocument();
      expect(style).toHaveValue('dashed');
      expect(preview.style.backgroundSize).toBe('32px 32px');
      expect(decodeURIComponent(preview.style.backgroundImage)).toContain('stroke-width="1" stroke-opacity="0.5" stroke-dasharray="1 2"');
      expect(useChartSettingsStore.getState().symbolProperties.EURUSD.colors).toEqual(original.colors);

      fireEvent.change(style, { target: { value: 'solid' } });
      expect(useChartSettingsStore.getState().symbolProperties.EURUSD).toMatchObject({ gridType: 'mt5', gridLineStyle: 'solid' });
      expect(decodeURIComponent(preview.style.backgroundImage)).not.toContain('stroke-dasharray');
      fireEvent.change(type, { target: { value: 'square' } });
      expect(style).toHaveValue('solid');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(useChartSettingsStore.getState().symbolProperties.EURUSD).toEqual(original);
    } finally {
      unmount();
      useChartSettingsStore.setState(initial);
    }
  });

  it('reflects live color edits simultaneously in the short preview chart and active chart settings store', () => {
    const initial = useChartSettingsStore.getState();
    useChartSettingsStore.setState({ globalProperties: { ...defaultChartProperties }, symbolProperties: {} });
    const { unmount } = render(<ChartPropertiesDialog isOpen symbol="EURUSD" timeframe="M1" onClose={vi.fn()} />);
    try {
      fireEvent.click(screen.getByRole('tab', { name: 'Colors' }));

      const previewChart = screen.getByTestId('cp-color-preview-chart');
      expect(previewChart).toBeVisible();
      expect(screen.getByLabelText('Volumes')).toHaveValue('#4597ff');

      fireEvent.change(screen.getByLabelText('Background'), { target: { value: '#111827' } });
      fireEvent.change(screen.getByLabelText('Foreground'), { target: { value: '#e2e8f0' } });
      fireEvent.change(screen.getByLabelText('Bull candle'), { target: { value: '#10b981' } });
      fireEvent.change(screen.getByLabelText('Bear candle'), { target: { value: '#f43f5e' } });
      fireEvent.change(screen.getByLabelText('Line chart'), { target: { value: '#a855f7' } });
      fireEvent.change(screen.getByLabelText('Volumes'), { target: { value: '#f59e0b' } });
      fireEvent.change(screen.getByLabelText('Bid price line'), { target: { value: '#22d3ee' } });
      fireEvent.change(screen.getByLabelText('Ask price line'), { target: { value: '#fb7185' } });
      fireEvent.change(screen.getByLabelText('Last price line'), { target: { value: '#facc15' } });
      fireEvent.change(screen.getByLabelText('Stop levels'), { target: { value: '#ef4444' } });

      const preview = screen.getByRole('dialog').querySelector<HTMLElement>('.rtx-cp-preview-inner')!;
      expect(preview.style.backgroundColor).toBe('rgb(17, 24, 39)');

      const firstBullCandleRect = screen.getByTestId('cp-preview-candles').querySelector('rect[data-trend="bull"]')!;
      const firstBearCandleRect = screen.getByTestId('cp-preview-candles').querySelector('rect[data-trend="bear"]')!;
      expect(firstBullCandleRect).toHaveAttribute('fill', '#10b981');
      expect(firstBearCandleRect).toHaveAttribute('fill', '#f43f5e');
      expect(screen.queryByTestId('cp-preview-line')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cp-preview-volumes')).not.toBeInTheDocument();
      expect(screen.getByTestId('cp-preview-bid-line')).toHaveAttribute('stroke', '#22d3ee');
      expect(screen.queryByTestId('cp-preview-ask-line')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cp-preview-last-line')).not.toBeInTheDocument();
      expect(screen.queryByTestId('cp-preview-stop-line')).not.toBeInTheDocument();
      expect(screen.queryByText(/\bSL\b/)).not.toBeInTheDocument();

      expect(useChartSettingsStore.getState().symbolProperties.EURUSD).toMatchObject({
        colorScheme: 'Custom',
        colors: {
          background: '#111827',
          foreground: '#e2e8f0',
          bullCandle: '#10b981',
          bearCandle: '#f43f5e',
          lineChart: '#a855f7',
          volumes: '#f59e0b',
          bidPriceLine: '#22d3ee',
          askPriceLine: '#fb7185',
          lastPriceLine: '#facc15',
          stopLevels: '#ef4444',
        },
      });

      fireEvent.click(screen.getByRole('tab', { name: 'Common' }));
      fireEvent.click(screen.getByRole('radio', { name: 'Line chart' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Colors' }));
      expect(screen.getByTestId('cp-preview-line')).toHaveAttribute('stroke', '#a855f7');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(useChartSettingsStore.getState().symbolProperties.EURUSD.colorScheme).toBe('Blue and Red');
    } finally {
      unmount();
      useChartSettingsStore.setState(initial);
    }
  });

  it('streams live market bars/ticks into the preview chart and supports chart-like pan, wheel zoom, price scale zoom, crosshair hover, and reset', () => {
    const initialSettings = useChartSettingsStore.getState();
    candleAggregationService.clearAll();
    useMarketDataStore.getState().clearAllData();

    const baseTimeSec = Math.floor(Date.now() / 60_000) * 60 - 40 * 60;
    for (let i = 0; i < 36; i += 1) {
      const open = 3570 + i * 0.12;
      const close = open + (i % 2 === 0 ? 0.25 : -0.15);
      candleAggregationService.addCompletedCandle('XAUUSD', 'M1', {
        time: baseTimeSec + i * 60,
        open,
        high: Math.max(open, close) + 0.18,
        low: Math.min(open, close) - 0.14,
        close,
        volume: 100 + i * 5,
        isComplete: true,
      });
    }
    useMarketDataStore.getState().updateTick('XAUUSD', {
      symbol: 'XAUUSD',
      bid: 3574.65,
      ask: 3574.80,
      spread: 0.15,
      timestamp: Date.now(),
    });

    const { unmount } = render(<ChartPropertiesDialog isOpen symbol="XAUUSD" timeframe="M1" onClose={vi.fn()} />);
    try {
      fireEvent.click(screen.getByRole('tab', { name: 'Colors' }));

      const previewChart = screen.getByTestId('cp-color-preview-chart');
      expect(previewChart).toHaveAttribute('data-live-source', 'live');
      expect(previewChart).toHaveAttribute('data-symbol', 'XAUUSD');
      expect(previewChart).toHaveAttribute('data-timeframe', 'M1');
      expect(previewChart).toHaveAttribute('data-pan-bars', '0.00');
      expect(previewChart).toHaveAttribute('data-visible-bars', '24');
      expect(previewChart).toHaveAttribute('data-price-zoom', '1.00');
      expect(screen.getByText('3,574.65')).toBeInTheDocument();

      act(() => {
        useMarketDataStore.getState().updateTick('XAUUSD', {
          symbol: 'XAUUSD',
          bid: 3575.40,
          ask: 3575.55,
          spread: 0.15,
          timestamp: Date.now() + 500,
        });
      });
      expect(screen.getByText('3,575.40')).toBeInTheDocument();
      expect(screen.getByTestId('cp-preview-ohlc').textContent).toContain('3,575.40');

      const surface = previewChart.closest('.rtx-cp-preview-chart-surface')!;
      fireEvent.pointerMove(surface, { clientX: 150, clientY: 60 });
      expect(screen.getByTestId('cp-preview-crosshair')).toBeInTheDocument();

      // Pan horizontally/vertically inside the main plot area (x < 312)
      fireEvent.pointerDown(surface, { pointerId: 1, clientX: 140, clientY: 65 });
      fireEvent.pointerMove(surface, { pointerId: 1, clientX: 220, clientY: 45 });
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 220, clientY: 45 });
      expect(Number(previewChart.getAttribute('data-pan-bars'))).toBeGreaterThan(0);

      // Wheel zoom in & out
      fireEvent.wheel(surface, { deltaY: -120 });
      expect(previewChart).toHaveAttribute('data-visible-bars', '21');

      // Right price axis vertical drag zoom (x >= plotRight 428)
      fireEvent.pointerDown(surface, { pointerId: 2, clientX: 460, clientY: 50 });
      fireEvent.pointerMove(surface, { pointerId: 2, clientX: 460, clientY: 10 });
      fireEvent.pointerUp(surface, { pointerId: 2, clientX: 460, clientY: 10 });
      expect(Number(previewChart.getAttribute('data-price-zoom'))).toBeGreaterThan(1);

      // Double click resets pan, bar zoom, and price zoom
      fireEvent.doubleClick(surface);
      expect(previewChart).toHaveAttribute('data-pan-bars', '0.00');
      expect(previewChart).toHaveAttribute('data-visible-bars', '24');
      expect(previewChart).toHaveAttribute('data-price-zoom', '1.00');
    } finally {
      unmount();
      candleAggregationService.clearAll();
      useMarketDataStore.getState().clearAllData();
      useChartSettingsStore.setState(initialSettings);
    }
  });
});
