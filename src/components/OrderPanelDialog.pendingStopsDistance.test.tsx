// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import { OrderPanelDialog } from './OrderPanelDialog';

vi.mock('../hooks/useSymbolMarketStatus', () => ({
  useSymbolMarketStatus: () => ({
    symbol: 'TESTFIX',
    status: 'open',
    isOpen: true,
    isTradeBlocked: false,
    label: 'Market Open',
    loading: false,
    error: null,
    refreshedAt: 1,
  }),
}));

vi.mock('../hooks/useLiveMarketData', () => ({
  useLiveOrderBook: () => ({
    bids: [],
    asks: [],
    spread: 0.1,
    timestamp: 1,
  }),
}));

const ASK = 10;
const BID = 9.9;

const pendingBuyButton = (): HTMLButtonElement => {
  const button = document.querySelector<HTMLButtonElement>('.rtx-order-dialog__action--buy');
  if (!button) throw new Error('pending buy button missing');
  return button;
};

describe('OrderPanelDialog pending stops distance uses points, not the broker tick', () => {
  beforeEach(() => {
    localStorage.setItem('lastLotSize', '0.01');
    useAppStore.getState().reset();
    useAppStore.getState().setTicks({
      TESTFIX: {
        symbol: 'TESTFIX',
        bid: BID,
        ask: ASK,
        spread: ASK - BID,
        timestamp: 1,
        digits: 2,
      },
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().reset();
    localStorage.clear();
  });

  it('enables a pending price 0.50 away and disables 0.49 away when digits are 2, tick is 0.05, and stops level is 50', () => {
    render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="TESTFIX"
        currentPrice={{ bid: BID, ask: ASK }}
        onSubmitOrder={vi.fn()}
        symbols={['TESTFIX']}
        initialOrderType="Buy Limit"
        initialPrice={ASK - 0.5}
        instruments={[{ symbol: 'TESTFIX', digits: 2, tickSize: 0.05, stopsLevel: 50 }]}
      />,
    );

    expect(pendingBuyButton().disabled).toBe(false);
    expect(screen.getByTestId('order-dialog-stops-level')).toHaveTextContent('Min stop distance: 50 pts');

    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '9.51' } });
    expect(pendingBuyButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '9.50' } });
    expect(pendingBuyButton().disabled).toBe(false);

    // The price spinner still steps by the broker tick, not by one point.
    fireEvent.click(screen.getByRole('button', { name: 'Decrease price' }));
    expect((screen.getByLabelText('Price') as HTMLInputElement).value).toBe('9.45');
  });
});
