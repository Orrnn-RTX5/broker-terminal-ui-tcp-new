// @vitest-environment jsdom

import '@testing-library/jest-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

import { ChartContextMenu } from './ChartContextMenu';
import { useSettingsStore } from '../store/useSettingsStore';

const setOneClick = (value: boolean) => {
  act(() => {
    useSettingsStore.setState((s) => ({ trade: { ...s.trade, oneClickTrading: value } }));
  });
};

const renderMenu = (overrides: Partial<ComponentProps<typeof ChartContextMenu>> = {}) => {
  const noop = vi.fn();
  const onOpenNewOrder = vi.fn();
  render(
    <ChartContextMenu
      visible
      x={20}
      y={20}
      symbol="XAUUSD"
      currentChartType="line"
      currentTimeframe="M1"
      onChangeChartType={noop}
      onChangeTimeframe={noop}
      onToggleOneClickTrading={noop}
      onToggleGrid={noop}
      onToggleVolumes={noop}
      onToggleAutoScroll={noop}
      onToggleChartShift={noop}
      onOpenProperties={noop}
      onSaveAsPicture={noop}
      onPrintChart={noop}
      onRefresh={noop}
      onZoomIn={noop}
      onZoomOut={noop}
      onDeleteIndicators={noop}
      onOpenNewOrder={onOpenNewOrder}
      onOpenDOM={noop}
      onOpenTemplateDialog={noop}
      onAddIndicator={noop}
      targetContextId="chart-test"
      onClose={noop}
      clickPrice={901.5}
      {...overrides}
    />,
  );
  return { onOpenNewOrder };
};

const openTradingSubmenu = () => {
  fireEvent.click(screen.getByRole('menuitem', { name: 'Trading' }));
};

type OrderEvent = { symbol?: unknown; side?: unknown };

describe('ChartContextMenu one-click gate + prefill (SUI-T9/T10)', () => {
  beforeEach(() => {
    setOneClick(false);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setOneClick(false);
  });

  it('one-click OFF: Buy Market opens the order dialog, never an instant order', async () => {
    const trades: OrderEvent[] = [];
    const dialogs: OrderEvent[] = [];
    const onTrade = (e: Event) => trades.push((e as CustomEvent).detail ?? {});
    const onDialog = (e: Event) => dialogs.push((e as CustomEvent).detail ?? {});
    window.addEventListener('quickTrade', onTrade);
    window.addEventListener('openNewOrder', onDialog);
    try {
      renderMenu();
      openTradingSubmenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Buy Market' }));

      await waitFor(() => {
        expect(dialogs).toEqual([{ symbol: 'XAUUSD', side: 'BUY' }]);
      });
      expect(trades).toEqual([]);
    } finally {
      window.removeEventListener('quickTrade', onTrade);
      window.removeEventListener('openNewOrder', onDialog);
    }
  });

  it('one-click ON: Buy Market sends instantly with no dialog', async () => {
    setOneClick(true);
    const trades: OrderEvent[] = [];
    const dialogs: OrderEvent[] = [];
    const onTrade = (e: Event) => trades.push((e as CustomEvent).detail ?? {});
    const onDialog = (e: Event) => dialogs.push((e as CustomEvent).detail ?? {});
    window.addEventListener('quickTrade', onTrade);
    window.addEventListener('openNewOrder', onDialog);
    try {
      renderMenu();
      openTradingSubmenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Buy Market' }));
      await waitFor(() => {
        expect(trades).toEqual([{ side: 'BUY', symbol: 'XAUUSD' }]);
      });
      expect(dialogs).toEqual([]);
    } finally {
      window.removeEventListener('quickTrade', onTrade);
      window.removeEventListener('openNewOrder', onDialog);
    }
  });

  it('limit items fast-apply directly via quickPendingOrder without opening the popup dialog', async () => {
    const quickPending: Array<Record<string, unknown>> = [];
    const onQuickPending = (e: Event) => quickPending.push((e as CustomEvent).detail ?? {});
    window.addEventListener('quickPendingOrder', onQuickPending);
    try {
      const { onOpenNewOrder } = renderMenu();
      openTradingSubmenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Buy Limit' }));
      await waitFor(() => {
        expect(quickPending).toEqual([{
          symbol: 'XAUUSD',
          orderType: 'Buy Limit',
          side: 'BUY',
          price: 901.5,
          volume: 0.01,
        }]);
      });
      expect(onOpenNewOrder).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('quickPendingOrder', onQuickPending);
    }
  });

  it('stop items open prefilled with stop type', async () => {
    const { onOpenNewOrder } = renderMenu();
    openTradingSubmenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sell Stop' }));
    await waitFor(() => {
      expect(onOpenNewOrder).toHaveBeenCalledWith({
        symbol: 'XAUUSD',
        orderType: 'Sell Stop',
        side: 'SELL',
        price: 901.5,
      });
    });
  });

  it('shows Buy Limit at top and fast-applies directly on the chart without opening a popup when right-clicking below live price', async () => {
    const quickPending: Array<Record<string, unknown>> = [];
    const onQuickPending = (e: Event) => quickPending.push((e as CustomEvent).detail ?? {});
    window.addEventListener('quickPendingOrder', onQuickPending);
    try {
      const { onOpenNewOrder } = renderMenu({
        clickPrice: 3868.13,
        livePrice: 3868.21,
        priceDigits: 2,
        defaultVolume: 0.01,
      });

      const topItem = screen.getByRole('menuitem', { name: 'Buy Limit 0.01' });
      expect(topItem).toHaveTextContent('3868.13');
      openTradingSubmenu();
      expect(screen.getByRole('menuitem', { name: 'Sell Stop 0.01' })).toHaveTextContent('3868.13');
      expect(screen.getByRole('menuitem', { name: 'New Order' })).toBeInTheDocument();

      fireEvent.click(topItem);
      await waitFor(() => {
        expect(quickPending).toEqual([{
          symbol: 'XAUUSD',
          orderType: 'Buy Limit',
          side: 'BUY',
          price: 3868.13,
          volume: 0.01,
        }]);
      });
      expect(onOpenNewOrder).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('quickPendingOrder', onQuickPending);
    }
  });

  it('shows Sell Limit at top and fast-applies Sell Limit directly while Buy Stop still opens prefilled dialog', async () => {
    const quickPending: Array<Record<string, unknown>> = [];
    const onQuickPending = (e: Event) => quickPending.push((e as CustomEvent).detail ?? {});
    window.addEventListener('quickPendingOrder', onQuickPending);
    try {
      const { onOpenNewOrder } = renderMenu({
        clickPrice: 3868.86,
        livePrice: 3868.21,
        priceDigits: 2,
        defaultVolume: 0.01,
      });

      const topItem = screen.getByRole('menuitem', { name: 'Sell Limit 0.01' });
      expect(topItem).toHaveTextContent('3868.86');
      fireEvent.click(topItem);
      await waitFor(() => {
        expect(quickPending).toEqual([{
          symbol: 'XAUUSD',
          orderType: 'Sell Limit',
          side: 'SELL',
          price: 3868.86,
          volume: 0.01,
        }]);
      });
      expect(onOpenNewOrder).not.toHaveBeenCalled();

      openTradingSubmenu();
      const buyStop = screen.getByRole('menuitem', { name: 'Buy Stop 0.01' });
      expect(buyStop).toHaveTextContent('3868.86');

      fireEvent.click(buyStop);
      await waitFor(() => {
        expect(onOpenNewOrder).toHaveBeenCalledWith({
          symbol: 'XAUUSD',
          orderType: 'Buy Stop',
          side: 'BUY',
          price: 3868.86,
        });
      });
    } finally {
      window.removeEventListener('quickPendingOrder', onQuickPending);
    }
  });
});
