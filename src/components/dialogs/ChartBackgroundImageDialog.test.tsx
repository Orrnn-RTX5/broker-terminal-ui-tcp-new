// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartBackgroundImageDialog } from './ChartBackgroundImageDialog';
import { defaultChartProperties, useChartSettingsStore } from '../../store/useChartSettingsStore';

vi.mock('../../hooks/useUiTranslation', () => ({
  useUiTranslation: () => (source: string) => source,
}));

describe('ChartBackgroundImageDialog', () => {
  beforeEach(() => {
    localStorage.clear();
    useChartSettingsStore.setState({
      globalProperties: { ...defaultChartProperties },
      symbolProperties: {
        BTCUSD: { ...defaultChartProperties },
        EURUSD: { ...defaultChartProperties },
      },
    });
  });

  afterEach(() => {
    document.documentElement.classList.remove('rtx-skin-untitled-light');
    cleanup();
  });

  it('uses light-theme surface and text palette when rtx-skin-untitled-light is active', () => {
    document.documentElement.classList.add('rtx-skin-untitled-light');
    render(
      <ChartBackgroundImageDialog
        isOpen={true}
        symbol="BTCUSD"
        timeframe="M1"
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-theme', 'light');
    expect(dialog).toHaveStyle({ background: '#ffffff' });
  });

  it('transitions safely from closed to open without React hook-order errors (#310)', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <ChartBackgroundImageDialog
        isOpen={false}
        symbol="BTCUSD"
        timeframe="M1"
        onClose={onClose}
      />,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(
      <ChartBackgroundImageDialog
        isOpen={true}
        symbol="BTCUSD"
        timeframe="M1"
        onClose={onClose}
      />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Background image - BTCUSD, m1')).toBeInTheDocument();
    // Opening the dialog must not mutate a default-off chart watermark to on.
    expect(useChartSettingsStore.getState().symbolProperties.BTCUSD.showBackgroundLogo).toBe(false);
    expect(useChartSettingsStore.getState().symbolProperties.BTCUSD.backgroundLogoMode).toBe('none');
  });

  it('renders the cTrader-style Background image dialog, live-previews changes, and reverts on Cancel', () => {
    const onClose = vi.fn();
    render(
      <ChartBackgroundImageDialog
        isOpen={true}
        symbol="BTCUSD"
        timeframe="M1"
        onClose={onClose}
      />,
    );

    expect(screen.getByText('Background image - BTCUSD, m1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Default'));
    expect(useChartSettingsStore.getState().symbolProperties.BTCUSD.showBackgroundLogo).toBe(true);
    expect(useChartSettingsStore.getState().symbolProperties.BTCUSD.backgroundLogoMode).toBe('default');

    fireEvent.click(screen.getByTestId('chart-background-image-cancel'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(useChartSettingsStore.getState().symbolProperties.BTCUSD.showBackgroundLogo).toBe(false);
    expect(useChartSettingsStore.getState().symbolProperties.BTCUSD.backgroundLogoMode).toBe('none');
  });

  it('persists opacity and mode on Save and applies to all open charts when checked', () => {
    const onClose = vi.fn();
    render(
      <ChartBackgroundImageDialog
        isOpen={true}
        symbol="BTCUSD"
        timeframe="M1"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('Default'));
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '28' } });
    fireEvent.click(screen.getByText('Apply changes to all open charts'));
    fireEvent.click(screen.getByTestId('chart-background-image-save'));

    expect(onClose).toHaveBeenCalledOnce();
    const state = useChartSettingsStore.getState();
    expect(state.symbolProperties.BTCUSD.showBackgroundLogo).toBe(true);
    expect(state.symbolProperties.BTCUSD.backgroundLogoOpacity).toBe(28);
    expect(state.symbolProperties.EURUSD.backgroundLogoOpacity).toBe(28);
    expect(state.globalProperties.backgroundLogoOpacity).toBe(28);
  });
});
