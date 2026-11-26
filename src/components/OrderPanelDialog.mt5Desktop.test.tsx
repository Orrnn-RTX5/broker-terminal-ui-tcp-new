// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import { formatPendingOrderBadgeLabel, OrderPanelDialog } from './OrderPanelDialog';
import { tradeApi } from '../api/trade';

vi.mock('../hooks/useSymbolMarketStatus', () => ({
  useSymbolMarketStatus: () => ({
    symbol: 'XAUUSD',
    status: 'open',
    isOpen: true,
    isTradeBlocked: false,
    label: 'Market Open',
    loading: false,
    error: null,
    refreshedAt: 1,
  }),
}));

const mockUseLiveOrderBook = vi.fn<() => unknown>();

vi.mock('../hooks/useLiveMarketData', () => ({
  useLiveOrderBook: () => mockUseLiveOrderBook(),
}));

describe('OrderPanelDialog MT5 Desktop layout and behavior', () => {
  beforeEach(() => {
    mockUseLiveOrderBook.mockReturnValue({
      bids: [
        { price: 4173.23, volume: 30 },
        { price: 4173.22, volume: 50 },
        { price: 4173.21, volume: 100 },
        { price: 4173.19, volume: 200 },
        { price: 4173.17, volume: 300 },
        { price: 4173.16, volume: 500 },
      ],
      asks: [
        { price: 4173.77, volume: 30 },
        { price: 4173.78, volume: 50 },
        { price: 4173.79, volume: 100 },
        { price: 4173.81, volume: 200 },
        { price: 4173.84, volume: 300 },
        { price: 4173.87, volume: 500 },
      ],
      spread: 0.54,
      timestamp: Date.now(),
    });
    localStorage.setItem('lastLotSize', '0.01');
    useAppStore.getState().reset();
    useAppStore.getState().setTicks({
      XAUUSD: {
        symbol: 'XAUUSD',
        bid: 4173.23,
        ask: 4173.77,
        spread: 0.54,
        timestamp: Date.now(),
        digits: 2,
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders MT5 header, contract quantity, fill policy tabs, tick chart, and DOM + One Click Trading', () => {
    const { container } = render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 4173.23, ask: 4173.77 }}
        onSubmitOrder={vi.fn()}
        symbols={['XAUUSD', 'EURUSD']}
        instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
      />,
    );

    expect(container.querySelector('[data-testid="order-dialog-sidebar-emblem"]')).toBeNull();
    expect(screen.getByText('Order: XAUUSD - Gold vs US Dollar')).not.toBeNull();
    // Contract units come from the broker catalog contract size (0.01 x 100).
    expect(screen.getByText('1 XAUUSD')).not.toBeNull();
    expect(screen.getByText('4 173.23 / 4 173.77')).not.toBeNull();
    expect(screen.getByRole('tab', { name: 'Fill or Kill' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Immediate or Cancel' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('order-mini-tick-chart')).not.toBeNull();
    expect(screen.getByTestId('order-dom-pane')).not.toBeNull();
    // Duplicate SL/TP/Vol spinners and bottom-right Sell/Close/Buy bar are omitted from the DOM pane
    expect(screen.queryByTestId('order-dom-oct')).toBeNull();
    expect(screen.queryByLabelText('DOM SL points')).toBeNull();
    expect(screen.queryByLabelText('DOM TP points')).toBeNull();
  });

  it('switches between Market Execution, Limit Order, Stop Order, and Stop Limit Order modes', () => {
    const onSubmitOrder = vi.fn();
    render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 4173.23, ask: 4173.77 }}
        onSubmitOrder={onSubmitOrder}
      />,
    );

    // Switch to Limit Order -> Price automatically shows the live quote (4173.77) and stays editable
    fireEvent.click(screen.getByTestId('order-mode-limit'));
    const priceInput = screen.getByLabelText('Price') as HTMLInputElement;
    const stopLimitInput = screen.getByLabelText('Stop Limit price') as HTMLInputElement;
    const expirationSelect = screen.getByLabelText('Expiration') as HTMLSelectElement;
    const expirationDateInput = screen.getByLabelText(/Expiration date/i) as HTMLInputElement;

    expect(priceInput.disabled).toBe(false);
    expect(priceInput.value).toBe('4173.77');
    expect(stopLimitInput.disabled).toBe(true);
    expect(expirationSelect.value).toBe('GTC');
    expect(expirationDateInput.disabled).toBe(true);

    // At the live ask (4173.77), Buy Limit requires price < ask so Buy is disabled
    const sellButtons = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Sell' });
    const buyButtons = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Buy' });
    expect(buyButtons[0].disabled).toBe(true);

    // Enter a valid Buy Limit price (< ask 4173.77) -> Buy enables, Sell stays disabled
    fireEvent.change(priceInput, { target: { value: '4170.00' } });
    expect(buyButtons[0].disabled).toBe(false);
    expect(sellButtons[0].disabled).toBe(true);

    // Enter a valid Sell Limit price (> bid 4173.23 and >= ask 4173.77) -> Sell enables, Buy disables
    fireEvent.change(priceInput, { target: { value: '4175.00' } });
    expect(sellButtons[0].disabled).toBe(false);
    expect(buyButtons[0].disabled).toBe(true);

    // Switch to Stop Limit Order (Price = 4175.00 > ask) -> Stop Limit price shows live price (4173.77) and is editable
    fireEvent.click(screen.getByTestId('order-mode-stop-limit'));
    expect((screen.getByLabelText('Stop Limit price') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Stop Limit price') as HTMLInputElement).value).toBe('4173.77');

    fireEvent.change(screen.getByLabelText('Stop Limit price'), { target: { value: '4176.00' } });
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'Buy' })[0].disabled).toBe(false);

    // Submit Stop Limit Buy order
    fireEvent.click(screen.getAllByRole<HTMLButtonElement>('button', { name: 'Buy' })[0]);
    expect(onSubmitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'buy',
        symbol: 'XAUUSD',
        volume: 0.01,
        orderType: 'Stop Limit Order',
        price: 4175,
        stopLimitPrice: 4176,
        expiration: 'GTC',
      }),
    );
  });

  it('toggles left sidebar labels, Tick Chart, Depth of Market, and One Click Trading panels', () => {
    render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 4173.23, ask: 4173.77 }}
        onSubmitOrder={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('data-sidebar-expanded')).toBe('false');

    fireEvent.click(screen.getByTestId('order-toggle-sidebar'));
    expect(dialog.getAttribute('data-sidebar-expanded')).toBe('true');
    expect(screen.getByText('Market Execution')).not.toBeNull();
    expect(screen.getByText('Limit Order')).not.toBeNull();
    expect(screen.getByText('Stop Order')).not.toBeNull();
    expect(screen.getByText('Stop Limit Order')).not.toBeNull();

    // Toggle Tick Chart off and back on
    fireEvent.click(screen.getByTestId('order-toggle-tick-chart'));
    expect(screen.queryByTestId('order-mini-tick-chart')).toBeNull();
    fireEvent.click(screen.getByTestId('order-toggle-tick-chart'));
    expect(screen.getByTestId('order-mini-tick-chart')).not.toBeNull();

    // Toggle One Click Trading off
    fireEvent.click(screen.getByTestId('order-toggle-oct'));
    expect(screen.queryByTestId('order-dom-oct')).toBeNull();

    // Toggle Depth of Market off
    fireEvent.click(screen.getByTestId('order-toggle-dom'));
    expect(screen.queryByTestId('order-dom-pane')).toBeNull();
  });

  it('shows an honest unknown for contract units when the broker catalog has no contract size', () => {
    const { container } = render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 4173.23, ask: 4173.77 }}
        onSubmitOrder={vi.fn()}
      />,
    );

    const units = container.querySelector('.rtx-order-dialog__contract-units');
    expect(units?.textContent).toBe('—');
    // No name-table lot sizes (100 for XAU, 100000 for FX).
    expect(screen.queryByText('1 XAUUSD')).toBeNull();
    expect(screen.queryByText('1 000 XAUUSD')).toBeNull();
  });

  it('renders raw prices (no guessed precision) when no broker digits are known', () => {
    useAppStore.getState().setTicks({
      TESTFIX: {
        symbol: 'TESTFIX',
        bid: 1.2345678,
        ask: 1.2346,
        spread: 0.0000322,
        timestamp: Date.now(),
      },
    });
    expect(() => render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="TESTFIX"
        currentPrice={{ bid: 1.2345678, ask: 1.2346 }}
        onSubmitOrder={vi.fn()}
      />,
    )).not.toThrow();

    // Header quote is the raw broker value: no 5-digit/2-digit default.
    expect(screen.getByText('1.2345678 / 1.2346')).not.toBeNull();
    expect(screen.getByLabelText('Bid 1.2345678, Ask 1.2346')).not.toBeNull();
    // The mocked live book (6 levels) is shown verbatim, unrounded.
    expect(screen.getAllByText('4173.23').length).toBeGreaterThan(0);
  });

  it('uses catalog digits over the tick payload for the header quote', () => {
    render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 4173.23, ask: 4173.77 }}
        onSubmitOrder={vi.fn()}
        instruments={[{ symbol: 'xauusd', digits: 3 }]}
      />,
    );

    expect(screen.getByText('4 173.230 / 4 173.770')).not.toBeNull();
  });

  it('switches from Market to Buy Limit and Sell Limit via the Type selector', () => {
    const onSubmitOrder = vi.fn();
    render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 4173.23, ask: 4173.77 }}
        onSubmitOrder={onSubmitOrder}
      />,
    );

    const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
    expect(typeSelect.value).toBe('Market Execution');
    expect(typeSelect.selectedOptions[0]?.textContent).toBe('Market');

    fireEvent.change(typeSelect, { target: { value: 'Buy Limit' } });
    expect(typeSelect.value).toBe('Buy Limit');
    expect(screen.getByRole('dialog').getAttribute('data-side')).toBe('buy');

    const priceInput = screen.getByLabelText('Price') as HTMLInputElement;
    expect(priceInput.value).toBe('4173.77');
    // At price === ask (4173.77), Buy Limit price is not yet valid (< ask), so Buy and Sell are disabled
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'Buy' })[0].disabled).toBe(true);
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'Sell' })[0].disabled).toBe(true);

    fireEvent.change(priceInput, { target: { value: '4170.00' } });
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'Buy' })[0].disabled).toBe(false);
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'Sell' })[0].disabled).toBe(true);
    fireEvent.click(screen.getAllByRole<HTMLButtonElement>('button', { name: 'Buy' })[0]);
    expect(onSubmitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'buy',
        symbol: 'XAUUSD',
        volume: 0.01,
        orderType: 'Buy Limit',
        price: 4170,
        expiration: 'GTC',
      }),
    );
  });

  it('routes DOM trade chevrons to Stop Order above ask and Limit Order at or below ask', () => {
    render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 4173.23, ask: 4173.77 }}
        onSubmitOrder={vi.fn()}
        instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
      />,
    );

    const dialog = screen.getByRole('dialog');
    // Clicking Buy at 4173.81 (above ask 4173.77) selects Stop Order
    fireEvent.click(screen.getByTitle('Buy at 4173.81'));
    expect(dialog.getAttribute('data-order-mode')).toBe('Stop Order');
    expect((screen.getByLabelText('Price') as HTMLInputElement).value).toBe('4173.81');

    // Clicking Buy at 4173.22 (below ask 4173.77) selects Limit Order
    fireEvent.click(screen.getByTitle('Buy at 4173.22'));
    expect(dialog.getAttribute('data-order-mode')).toBe('Limit Order');
    expect((screen.getByLabelText('Price') as HTMLInputElement).value).toBe('4173.22');
  });

  it('replaces the legacy 5 mini-chart toolbar icons with the 6-option Chart Type dropdown', () => {
    render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 4173.23, ask: 4173.77 }}
        onSubmitOrder={vi.fn()}
        instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
      />,
    );

    // The 5 legacy buttons are removed
    expect(screen.queryByTitle('Show price lines')).toBeNull();
    expect(screen.queryByTitle('Auto scroll')).toBeNull();
    expect(screen.queryByTitle('Tick lines')).toBeNull();
    expect(screen.queryByTitle('Tick points')).toBeNull();
    expect(screen.queryByTitle('Shift end of the chart from the right border')).toBeNull();

    // Chart type trigger defaults to Candlestick chart and opens the 6-item menu
    const trigger = screen.getByTestId('order-mini-chart-type-trigger');
    expect(trigger.getAttribute('title')).toBe('Candlestick chart');
    expect(screen.queryByTestId('order-mini-chart-type-menu')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByTestId('order-mini-chart-type-menu')).not.toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'Bar chart' })).not.toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'Candlestick chart' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'Line chart' })).not.toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'Dot chart' })).not.toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'Area chart' })).not.toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'HLC chart' })).not.toBeNull();

    // Selecting Area chart updates the active chart type and closes the menu
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Area chart' }));
    expect(screen.queryByTestId('order-mini-chart-type-menu')).toBeNull();
    expect(trigger.getAttribute('title')).toBe('Area chart');
  });

  it('omits the sidebar candlestick emblem in light theme as well', () => {
    document.documentElement.classList.add('rtx-advanced-view', 'rtx-skin-untitled-light');
    try {
      render(
        <OrderPanelDialog
          isOpen
          onClose={vi.fn()}
          symbol="XAUUSD"
          currentPrice={{ bid: 4173.23, ask: 4173.77 }}
          onSubmitOrder={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('order-dialog-sidebar-emblem')).toBeNull();
    } finally {
      document.documentElement.classList.remove('rtx-advanced-view', 'rtx-skin-untitled-light');
    }
  });

  it('pads partial depth books to 6 ladder rows per side and uses tick top-of-book volume when no depth book is available', () => {
    mockUseLiveOrderBook.mockReturnValue({
      orderBook: {
        bids: [{ price: 3897.83, volume: 75 }],
        asks: [{ price: 3897.98, volume: 90 }],
        spread: 0.15,
        timestamp: Date.now(),
      },
    });
    useAppStore.getState().setTicks({
      XAUUSD: {
        symbol: 'XAUUSD',
        bid: 3897.83,
        ask: 3897.98,
        spread: 0.15,
        timestamp: Date.now(),
        digits: 2,
      },
    });

    const { container, unmount } = render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 3897.83, ask: 3897.98 }}
        onSubmitOrder={vi.fn()}
        instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
      />,
    );

    const askRows = container.querySelectorAll('.rtx-order-dialog__dom-row--ask');
    const bidRows = container.querySelectorAll('.rtx-order-dialog__dom-row--bid');
    expect(askRows.length).toBe(6);
    expect(bidRows.length).toBe(6);
    expect(container.querySelector('.rtx-order-dialog__dom-row--best-ask .rtx-order-dialog__dom-vol-text')?.textContent).toBe('90');
    expect(container.querySelector('.rtx-order-dialog__dom-row--best-bid .rtx-order-dialog__dom-vol-text')?.textContent).toBe('75');
    // Outer padded ladder rows do not invent fake volume numbers
    expect(askRows[0]?.querySelector('.rtx-order-dialog__dom-vol-text')).toBeNull();
    expect(bidRows[5]?.querySelector('.rtx-order-dialog__dom-vol-text')).toBeNull();

    unmount();

    // When the depth book is null but the live tick carries real top-of-book bidVolume/askVolume:
    mockUseLiveOrderBook.mockReturnValue({ orderBook: null });
    useAppStore.getState().setTicks({
      XAUUSD: {
        symbol: 'XAUUSD',
        bid: 3897.83,
        ask: 3897.98,
        bidVolume: 120,
        askVolume: 140,
        spread: 0.15,
        timestamp: Date.now(),
        digits: 2,
      },
    });

    const { container: fallbackContainer } = render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 3897.83, ask: 3897.98 }}
        onSubmitOrder={vi.fn()}
        instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
      />,
    );

    expect(fallbackContainer.querySelector('.rtx-order-dialog__dom-row--best-ask .rtx-order-dialog__dom-vol-text')?.textContent).toBe('140');
    expect(fallbackContainer.querySelector('.rtx-order-dialog__dom-row--best-bid .rtx-order-dialog__dom-vol-text')?.textContent).toBe('120');
  });

  it('shows live price in Price / Stop Limit price when Limit, Stop, or Stop-Limit order is selected and keeps it editable', () => {
    render(
      <OrderPanelDialog
        isOpen
        onClose={vi.fn()}
        symbol="XAUUSD"
        currentPrice={{ bid: 4173.23, ask: 4173.77 }}
        onSubmitOrder={vi.fn()}
        instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
      />,
    );

    // 1. Select Limit order -> live price (4173.77) is shown and tracks live ticks until edited
    fireEvent.click(screen.getByTestId('order-mode-limit'));
    const priceInput = screen.getByLabelText('Price') as HTMLInputElement;
    expect(priceInput.value).toBe('4173.77');

    act(() => {
      useAppStore.getState().setTicks({
        XAUUSD: {
          symbol: 'XAUUSD',
          bid: 4173.40,
          ask: 4173.95,
          spread: 0.55,
          timestamp: Date.now() + 100,
          digits: 2,
        },
      });
    });
    expect(priceInput.value).toBe('4173.95');

    // User edits Price -> subsequent live ticks do not overwrite the edited value
    fireEvent.change(priceInput, { target: { value: '4170.50' } });
    expect(priceInput.value).toBe('4170.50');

    act(() => {
      useAppStore.getState().setTicks({
        XAUUSD: {
          symbol: 'XAUUSD',
          bid: 4173.60,
          ask: 4174.10,
          spread: 0.50,
          timestamp: Date.now() + 200,
          digits: 2,
        },
      });
    });
    expect(priceInput.value).toBe('4170.50');

    // 2. Switch to Market order and then Stop order -> Price resets to current live price (4174.10) and is editable
    fireEvent.click(screen.getByTestId('order-mode-market'));
    fireEvent.click(screen.getByTestId('order-mode-stop'));
    expect((screen.getByLabelText('Price') as HTMLInputElement).value).toBe('4174.10');

    // 3. Switch to Stop-limit order -> both Price and Stop Limit price show live price (4174.10) and are editable
    fireEvent.click(screen.getByTestId('order-mode-stop-limit'));
    const stopLimitInput = screen.getByLabelText('Stop Limit price') as HTMLInputElement;
    expect((screen.getByLabelText('Price') as HTMLInputElement).value).toBe('4174.10');
    expect(stopLimitInput.value).toBe('4174.10');

    fireEvent.change(stopLimitInput, { target: { value: '4176.25' } });
    expect(stopLimitInput.value).toBe('4176.25');
  });

  it('keeps the zero-balance notice when balance is 0 and free margin is unavailable', async () => {
    vi.useFakeTimers();
    try {
      useAppStore.setState({
        account: {
          balance: 0,
          equity: 0,
          margin: 0,
          freeMargin: 0,
          marginLevel: 0,
          leverage: 100,
          currency: 'USD',
          hasBackendFreeMargin: false,
          metricsMarginUnavailable: true,
          metricsStatus: 'unavailable',
        },
      });

      render(
        <OrderPanelDialog
          isOpen
          onClose={vi.fn()}
          symbol="XAUUSD"
          currentPrice={{ bid: 4173.23, ask: 4173.77 }}
          onSubmitOrder={vi.fn()}
          instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
        />,
      );

      await act(async () => {
        vi.advanceTimersByTime(20);
      });

      expect(screen.getByTestId('order-insufficient-margin-notice').textContent).toContain(
        'Insufficient account balance (0.00) to open a new order.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the insufficient-margin block for a VALUED account whose free-margin flag is false (5ad2aa97 reading)', async () => {
    vi.useFakeTimers();
    const marginSpy = vi.spyOn(tradeApi.market, 'calculateMargin')
      .mockResolvedValue({ required_margin: 208.69, currency: 'USD' } as never);
    const previousAccountId = useAppStore.getState().accountId;
    try {
      // A valued account (no not-valued marker) with a small numeric free margin and the flag false:
      // the dialog reads the number as 5ad2aa97 did and blocks (required 208.69 USD > 10 USD).
      useAppStore.setState({
        accountId: '900001',
        account: {
          balance: 10,
          equity: 10,
          margin: 0,
          freeMargin: 10,
          marginLevel: 0,
          leverage: 100,
          currency: 'USD',
          hasBackendFreeMargin: false,
        },
      });

      render(
        <OrderPanelDialog
          isOpen
          onClose={vi.fn()}
          symbol="XAUUSD"
          currentPrice={{ bid: 4173.23, ask: 4173.77 }}
          onSubmitOrder={vi.fn()}
          instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
        />,
      );

      await act(async () => {
        vi.advanceTimersByTime(20);
      });

      expect(screen.getByTestId('order-required-margin').getAttribute('data-insufficient-margin')).toBe('true');
      expect(marginSpy).toHaveBeenCalled();
      expect(screen.getByTestId('order-insufficient-margin-notice').textContent).toContain('Insufficient free margin');
    } finally {
      marginSpy.mockRestore();
      useAppStore.setState({ accountId: previousAccountId });
      vi.useRealTimers();
    }
  });

  it('renders sufficient balance, zero/insufficient balance, and rejected order states cleanly without shifting controls', async () => {
    vi.useFakeTimers();
    try {
      // 1. Sufficient balance (5,000 USD free margin vs 208.69 USD required margin)
      useAppStore.setState({
        account: {
          balance: 5000,
          equity: 5000,
          margin: 0,
          freeMargin: 5000,
          marginLevel: 0,
          leverage: 100,
          currency: 'USD',
        },
      });

      const onSubmitOrder = vi.fn().mockRejectedValueOnce(
        new Error('Encrypted Binary TCP Server (185.126.217.108:4443) unreachable: dial tcp 185.126.217.108:4443: connectex'),
      );

      const { container } = render(
        <OrderPanelDialog
          isOpen
          onClose={vi.fn()}
          symbol="XAUUSD"
          currentPrice={{ bid: 4173.23, ask: 4173.77 }}
          onSubmitOrder={onSubmitOrder}
          instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
        />,
      );

      await act(async () => {
        vi.advanceTimersByTime(20);
      });

      const marginEl = screen.getByTestId('order-required-margin');
      expect(marginEl.getAttribute('data-insufficient-margin')).toBe('false');
      expect(screen.queryByTestId('order-insufficient-margin-notice')).toBeNull();

      // Message slot reserves space even before any error/warning appears
      const messageSlot = container.querySelector('.rtx-order-dialog__message-slot');
      expect(messageSlot).not.toBeNull();
      expect(messageSlot?.getAttribute('data-has-message')).toBe('false');

      // 2. Zero balance / insufficient free margin state
      await act(async () => {
        useAppStore.setState({
          account: {
            balance: 0,
            equity: 0,
            margin: 0,
            freeMargin: 0,
            marginLevel: 0,
            leverage: 100,
            currency: 'USD',
          },
        });
      });

      expect(marginEl.getAttribute('data-insufficient-margin')).toBe('true');
      expect(screen.getByTestId('order-insufficient-margin-notice').textContent).toContain(
        'Insufficient account balance (0.00) to open a new order.',
      );
      expect(messageSlot?.getAttribute('data-has-message')).toBe('true');

      // 3. Rejected order (backend down) formats exact reason inside the same reserved message slot
      const buyBtn = container.querySelector('.rtx-order-dialog__action--buy') as HTMLButtonElement;
      const sellBtn = container.querySelector('.rtx-order-dialog__action--sell') as HTMLButtonElement;
      expect(buyBtn).not.toBeNull();
      expect(sellBtn).not.toBeNull();

      await act(async () => {
        fireEvent.click(buyBtn);
      });

      const alertEl = screen.getByRole('alert');
      expect(alertEl.textContent).toBe(
        'Order failed: trading backend server is unreachable. Check that the backend service is running and try again.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws only a single live price line and axis tag on the order mini-chart instead of both bid and ask', () => {
    const drawnTexts: string[] = [];
    const mockCtx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
      fillText: vi.fn((text: string) => {
        drawnTexts.push(String(text));
      }),
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      globalAlpha: 1,
      textAlign: 'left',
      textBaseline: 'alphabetic',
    };

    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      mockCtx as unknown as CanvasRenderingContext2D,
    );
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    try {
      render(
        <OrderPanelDialog
          isOpen
          onClose={vi.fn()}
          symbol="XAUUSD"
          currentPrice={{ bid: 4173.23, ask: 4173.77 }}
          onSubmitOrder={vi.fn()}
          instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
        />,
      );

      expect(drawnTexts).toContain('4173.23');
      expect(drawnTexts).not.toContain('4173.77');
    } finally {
      getContextSpy.mockRestore();
      rafSpy.mockRestore();
      cancelRafSpy.mockRestore();
    }
  });

  it('formats pending order chart badges without duplicating side and switches timeframes cleanly', () => {
    expect(formatPendingOrderBadgeLabel('SELL', 'SELL_LIMIT', 0.01)).toBe('SELL LIMIT 0.01');
    expect(formatPendingOrderBadgeLabel('BUY', 'BUY_STOP_LIMIT', 0.25)).toBe('BUY STOP LIMIT 0.25');
    expect(formatPendingOrderBadgeLabel('SELL', 'LIMIT', 0.1)).toBe('SELL LIMIT 0.1');

    const drawnCalls: Array<{ text: string; x: number; y: number }> = [];
    const mockCtx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
      fillText: vi.fn((text: string, x: number, y: number) => {
        drawnCalls.push({ text: String(text), x, y });
      }),
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      globalAlpha: 1,
      textAlign: 'left',
      textBaseline: 'alphabetic',
    };

    useAppStore.getState().setPositions([
      {
        id: 101,
        ticket: 101,
        symbol: 'XAUUSD',
        side: 'SELL',
        volume: 0.01,
        openPrice: 4173.25,
        currentPrice: 4173.23,
        profit: 0.2,
        sl: 0,
        tp: 0,
        openTime: Date.now() - 60_000,
      } as any,
      {
        id: 102,
        ticket: 102,
        symbol: 'XAUUSD',
        side: 'SELL',
        volume: 0.01,
        openPrice: 4173.24,
        currentPrice: 4173.23,
        profit: 0.1,
        sl: 0,
        tp: 0,
        openTime: Date.now() - 30_000,
      } as any,
    ]);
    useAppStore.getState().setOrders([
      {
        id: 'o1',
        symbol: 'XAUUSD',
        side: 'SELL',
        type: 'SELL_LIMIT',
        volume: 0.01,
        price: 4173.50,
        status: 'PENDING',
      } as any,
    ]);

    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      mockCtx as unknown as CanvasRenderingContext2D,
    );
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    try {
      const { container } = render(
        <OrderPanelDialog
          isOpen
          onClose={vi.fn()}
          symbol="XAUUSD"
          currentPrice={{ bid: 4173.23, ask: 4173.77 }}
          onSubmitOrder={vi.fn()}
          instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
        />,
      );

      // Pending order bar uses main-chart style strip without duplicating side (TP SL SELL LIMIT 0.01 ×)
      const pendingBar = container.querySelector<HTMLElement>('[data-order-chart-bar-id="ord-o1"]');
      expect(pendingBar).not.toBeNull();
      expect(pendingBar?.textContent).toContain('TP');
      expect(pendingBar?.textContent).toContain('SL');
      expect(pendingBar?.textContent).toContain('SELL LIMIT');
      expect(pendingBar?.textContent).toContain('0.01');
      expect(pendingBar?.textContent).not.toContain('SELL SELL LIMIT');

      // Open position bars use main-chart style strip (TP SL SELL 0.01 +0.20 ×) and stay vertically separated
      const posBar1 = container.querySelector<HTMLElement>('[data-order-chart-bar-id="pos-101"]');
      const posBar2 = container.querySelector<HTMLElement>('[data-order-chart-bar-id="pos-102"]');
      expect(posBar1).not.toBeNull();
      expect(posBar2).not.toBeNull();
      expect(posBar1?.textContent).toContain('TP');
      expect(posBar1?.textContent).toContain('SL');
      expect(posBar1?.textContent).toContain('SELL');
      expect(posBar1?.textContent).toContain('0.01');
      expect(posBar1?.textContent).toContain('+0.20');
      expect(posBar1?.querySelector('.rtx-order-dialog__trade-bar-close')).not.toBeNull();
      const top1 = Number.parseFloat(posBar1?.style.top || '0');
      const top2 = Number.parseFloat(posBar2?.style.top || '0');
      expect(Math.abs(top1 - top2)).toBeGreaterThanOrEqual(20);

      // Timeframe buttons show all M1..MN and switch HUD symbol/timeframe label cleanly
      const expectedTimeframes = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN'] as const;
      const timeframeGroup = screen.getByRole('group', { name: 'Timeframe' });
      const renderedTimeframes = Array.from(timeframeGroup.querySelectorAll('button')).map((btn) => btn.textContent);
      expect(renderedTimeframes).toEqual(expectedTimeframes);

      const hudSymbol = container.querySelector('.rtx-order-dialog__chart-hud-symbol');
      expect(hudSymbol?.textContent).toBe('XAUUSD, M1');
      for (const tf of expectedTimeframes) {
        const tfBtn = screen.getByTestId(`order-mini-chart-tf-${tf}`);
        fireEvent.click(tfBtn);
        expect(hudSymbol?.textContent).toBe(`XAUUSD, ${tf}`);
        expect(tfBtn.getAttribute('aria-pressed')).toBe('true');
      }
    } finally {
      getContextSpy.mockRestore();
      rafSpy.mockRestore();
      cancelRafSpy.mockRestore();
    }
  });

  it('loads cached and backend historical candles for M1..MN and formats calendar axis labels', async () => {
    const { candleCache } = await import('../services/candleCache');
    const { API_V2_BASE_URL, RTX5_API_URL, toLocalDevProxyUrl } = await import('../config/api');
    const { buildBrokerApiV2 } = await import('../services/brokerSession');

    const brokerBase = toLocalDevProxyUrl(buildBrokerApiV2()).replace(/\/$/, '');
    const apiV2Base = API_V2_BASE_URL.replace(/\/$/, '');
    const configBase = RTX5_API_URL.replace(/\/$/, '');
    const scope = brokerBase || apiV2Base || (configBase ? `${configBase}/api/v2` : '/api/v2') || 'default';

    const drawnTexts: string[] = [];
    const mockCtx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
      fillText: vi.fn((text: string) => {
        drawnTexts.push(String(text));
      }),
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      globalAlpha: 1,
      textAlign: 'left',
      textBaseline: 'alphabetic',
    };

    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      mockCtx as unknown as CanvasRenderingContext2D,
    );
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    const mnCandles = Array.from({ length: 18 }, (_, i) => ({
      time: Math.floor(Date.UTC(2025, i, 1) / 1000),
      open: 4100 + i,
      high: 4120 + i,
      low: 4090 + i,
      close: 4110 + i,
      volume: 100 + i,
    }));
    const mnKey = candleCache.createKey({ scope, symbol: 'XAUUSD', timeframe: 'MN', limit: 500 });
    candleCache.setLatest(mnKey, mnCandles, { scope, symbol: 'XAUUSD', timeframe: 'MN', limit: 500, source: 'backend' });

    const d1Candles = Array.from({ length: 24 }, (_, i) => ({
      time: Math.floor(Date.UTC(2026, 9, 1 + i) / 1000),
      open: 4150 + i,
      high: 4160 + i,
      low: 4140 + i,
      close: 4155 + i,
      volume: 50 + i,
    }));
    const prevRuntimeCfg = (window as { __RTX_RUNTIME_CONFIG__?: unknown }).__RTX_RUNTIME_CONFIG__;
    (window as { __RTX_RUNTIME_CONFIG__?: unknown }).__RTX_RUNTIME_CONFIG__ = { BACKEND_TARGET: 'desktop' };
    const getCandlesSpy = vi.spyOn(tradeApi.market, 'getCandles').mockResolvedValue(d1Candles as never);

    try {
      render(
        <OrderPanelDialog
          isOpen
          onClose={vi.fn()}
          symbol="XAUUSD"
          currentPrice={{ bid: 4173.23, ask: 4173.77 }}
          onSubmitOrder={vi.fn()}
          instruments={[{ symbol: 'XAUUSD', digits: 2, contractSize: 100 }]}
        />,
      );

      drawnTexts.length = 0;
      fireEvent.click(screen.getByTestId('order-mini-chart-tf-MN'));
      expect(drawnTexts.some((txt) => /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) 202[56]$/.test(txt))).toBe(true);

      drawnTexts.length = 0;
      await act(async () => {
        fireEvent.click(screen.getByTestId('order-mini-chart-tf-D1'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(getCandlesSpy).toHaveBeenCalledWith('XAUUSD', { timeframe: 'D1', limit: 120 });
      expect(drawnTexts.some((txt) => /^\d{2} (Oct|Nov) 2026$/.test(txt))).toBe(true);
    } finally {
      (window as { __RTX_RUNTIME_CONFIG__?: unknown }).__RTX_RUNTIME_CONFIG__ = prevRuntimeCfg;
      candleCache.clearAll();
      getCandlesSpy.mockRestore();
      getContextSpy.mockRestore();
      rafSpy.mockRestore();
      cancelRafSpy.mockRestore();
    }
  });
});
