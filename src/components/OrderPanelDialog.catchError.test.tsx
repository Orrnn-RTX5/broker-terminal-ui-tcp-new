// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { OrderPanelDialog } from './OrderPanelDialog';

vi.mock('../hooks/useSymbolMarketStatus', () => ({
  useSymbolMarketStatus: () => ({
    symbol: 'EURUSD',
    status: 'open',
    isOpen: true,
    isTradeBlocked: false,
    label: 'Market Open',
    loading: false,
    error: null,
    refreshedAt: 1,
  }),
}));

const renderDialog = (onSubmitOrder: (order: unknown) => Promise<void> | void) => {
  useAppStore.getState().setTicks({
    EURUSD: {
      symbol: 'EURUSD',
      bid: 1.085,
      ask: 1.0852,
      spread: 0.0002,
      timestamp: Date.now(),
      digits: 5,
    },
  });

  return render(
    <OrderPanelDialog
      isOpen
      onClose={vi.fn()}
      symbol="EURUSD"
      currentPrice={{ bid: 1.085, ask: 1.0852 }}
      onSubmitOrder={onSubmitOrder}
    />,
  );
};

describe('OrderPanelDialog handleSubmit catch error handling (1.2.18 behaviour)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useAppStore.getState().reset();
    useSettingsStore.getState().resetToDefaults();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    useAppStore.getState().reset();
    useSettingsStore.getState().resetToDefaults();
    vi.restoreAllMocks();
  });

  it('falls back to formatOrderError instead of throwing when an Error instance has a non-string message', async () => {
    const err = Object.assign(new Error('original'), { status: 429 });
    Object.defineProperty(err, 'message', { value: undefined, configurable: true });
    const onSubmitOrder = vi.fn().mockRejectedValue(err);

    renderDialog(onSubmitOrder);

    const buyButton = screen.getByRole('button', { name: /buy by market/i }) as HTMLButtonElement;
    fireEvent.click(buyButton);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Order failed: too many requests. Please slow down and try again.');
    await waitFor(() => expect(buyButton.disabled).toBe(false));
  });

  it('reads and trims string .message from thrown function objects identically to 1.2.18', async () => {
    const fnErr = Object.assign(() => undefined, {
      message: '  Order failed: broker custom rejection  ',
    });
    const onSubmitOrder = vi.fn().mockRejectedValue(fnErr);

    renderDialog(onSubmitOrder);

    const buyButton = screen.getByRole('button', { name: /buy by market/i }) as HTMLButtonElement;
    fireEvent.click(buyButton);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Order failed: broker custom rejection');
    await waitFor(() => expect(buyButton.disabled).toBe(false));
  });
});
