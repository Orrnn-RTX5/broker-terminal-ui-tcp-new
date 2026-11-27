// @vitest-environment jsdom

import '@testing-library/jest-dom';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartType, Timeframe } from '../../types/chart';
import { useAppStore } from '../../store/useAppStore';
import { useOneClickDisclaimerStore } from '../../store/useOneClickDisclaimerStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { commitBrokerAccountSessionScope } from '../../services/brokerSession';
import { TRADING_AUTH_REQUEST_EVENT } from '../../services/tradingAuthGate';
import { normalizeMarketStatus } from '../../utils/marketStatus';
import { ChartContextMenu } from '../../components/ChartContextMenu';
import { OneClickTrading } from '../../components/OneClickTrading';
import { OneClickDisclaimerDialog } from '../../components/ui/OneClickDisclaimerDialog';
import {
  useTerminalCommandEvents,
  type ChartObjectsTarget,
  type ChartSymbolPickerState,
} from './useTerminalCommandEvents';

const setter = <T,>(): Dispatch<SetStateAction<T>> => vi.fn();

const DIALOG_NAME = 'One Click Trading';
const ACCEPT_LABEL = 'I Accept these Terms and Conditions';

interface HarnessProps {
  handleOrderPanelSubmit?: ReturnType<typeof vi.fn>;
  openOrderPanelForSymbol?: ReturnType<typeof vi.fn>;
  setSelectedSymbol?: Dispatch<SetStateAction<string>>;
  volume?: number;
  withChartControls?: boolean;
}

const QuickPendingHarness = ({
  handleOrderPanelSubmit,
  openOrderPanelForSymbol = vi.fn(() => true),
  setSelectedSymbol = setter<string>(),
  volume = 0.01,
  withChartControls = false,
}: HarnessProps) => {
  const [showDataWindow, setShowDataWindow] = useState(false);
  const [showAccountPanel, setShowAccountPanel] = useState(false);
  void showDataWindow;
  void showAccountPanel;

  useTerminalCommandEvents({
    selectedSymbol: 'XAUUSD',
    setSelectedSymbol,
    timeframe: 'M1' as Timeframe,
    setTimeframe: setter<Timeframe>(),
    chartType: 'candlestick' as ChartType,
    setChartType: setter<ChartType>(),
    chartEligibleSymbolNames: ['XAUUSD', 'EURUSD'],
    displayToast: vi.fn(),
    placeOrder: vi.fn(),
    volume,
    handleOrderPanelSubmit,
    handleOpenDOM: vi.fn(),
    handleSaveWorkspace: vi.fn(),
    handleOpenDataFolder: vi.fn(),
    handlePrintChart: vi.fn(),
    getAllowedSymbol: (symbol: unknown) => (typeof symbol === 'string' && symbol.trim() ? symbol.trim().toUpperCase() : ''),
    getChartEligibleSymbol: () => 'XAUUSD',
    openOrderPanelForSymbol,
    setShowDataWindow,
    setShowAccountPanel,
    setDockHeight: setter<number>(),
    setChartSymbolPicker: setter<ChartSymbolPickerState | null>(),
    setShowChartProperties: setter<boolean>(),
    setChartPropsSymbol: setter<string>(),
    setChartPropsTimeframe: setter<string>(),
    setChartPropsContextId: setter<string | undefined>(),
    setChartObjectsTarget: setter<ChartObjectsTarget | null>(),
  });

  return (
    <>
      {withChartControls && (
        <>
          <OneClickTrading
            symbol="XAUUSD"
            timeframe="M1"
            visible
            tradeAllowed
            marketStatus={normalizeMarketStatus({ symbol: 'XAUUSD', status: 'open' })}
          />
          <ChartContextMenu
            visible
            x={20}
            y={20}
            symbol="XAUUSD"
            currentChartType="candlestick"
            currentTimeframe="M1"
            onChangeChartType={vi.fn()}
            onChangeTimeframe={vi.fn()}
            onToggleOneClickTrading={vi.fn()}
            onToggleGrid={vi.fn()}
            onToggleVolumes={vi.fn()}
            onToggleAutoScroll={vi.fn()}
            onOpenProperties={vi.fn()}
            onSaveAsPicture={vi.fn()}
            onPrintChart={vi.fn()}
            onRefresh={vi.fn()}
            onOpenZoomControls={vi.fn()}
            onDeleteIndicators={vi.fn()}
            onOpenNewOrder={vi.fn()}
            onOpenDOM={vi.fn()}
            onOpenTemplateDialog={vi.fn()}
            onAddIndicator={vi.fn()}
            targetContextId="chart-test"
            onClose={vi.fn()}
            clickPrice={3868.13}
            livePrice={3868.21}
            priceDigits={2}
            defaultVolume={0.01}
          />
        </>
      )}
      <OneClickDisclaimerDialog globalHost />
    </>
  );
};

const dispatchQuickPendingOrder = (detail: {
  symbol?: unknown;
  side?: 'BUY' | 'SELL';
  orderType?: string;
  price?: number;
  volume?: number;
}) => {
  act(() => {
    window.dispatchEvent(new CustomEvent('quickPendingOrder', { detail }));
  });
};

describe('useTerminalCommandEvents quickPendingOrder One-Click disclaimer gate', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useAppStore.getState().reset();
    useSettingsStore.getState().resetToDefaults();
    useOneClickDisclaimerStore.getState().resetSessionAcceptance();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '900001',
      authToken: 'quick-pending-token',
      tokenExpiresAt: Date.now() + 60_000,
    });
    useAppStore.getState().setTicks({
      XAUUSD: {
        symbol: 'XAUUSD',
        bid: 3868.21,
        ask: 3868.31,
        spread: 0.1,
        digits: 2,
        timestamp: Date.now(),
      },
    });
    commitBrokerAccountSessionScope({
      authenticated: true,
      accountId: '900001',
      brokerId: 'test-broker',
      serverUrl: 'https://test-broker.invalid',
    });
  });

  afterEach(() => {
    cleanup();
    useOneClickDisclaimerStore.getState().resetSessionAcceptance();
    useSettingsStore.getState().resetToDefaults();
    useAppStore.getState().reset();
    commitBrokerAccountSessionScope({ authenticated: false, brokerId: '', serverUrl: '' });
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('requires One-Click disclaimer acceptance before placing a quick Buy Limit pending order', async () => {
    const handleOrderPanelSubmit = vi.fn().mockResolvedValue(undefined);
    const openOrderPanelForSymbol = vi.fn(() => true);
    render(
      <QuickPendingHarness
        handleOrderPanelSubmit={handleOrderPanelSubmit}
        openOrderPanelForSymbol={openOrderPanelForSymbol}
      />,
    );

    dispatchQuickPendingOrder({
      symbol: 'XAUUSD',
      side: 'BUY',
      orderType: 'Buy Limit',
      price: 3868.13,
      volume: 0.05,
    });

    const dialog = await screen.findByRole('dialog', { name: DIALOG_NAME });
    expect(dialog).toBeInTheDocument();
    expect(handleOrderPanelSubmit).not.toHaveBeenCalled();
    expect(openOrderPanelForSymbol).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: ACCEPT_LABEL }));

    await waitFor(() => {
      expect(handleOrderPanelSubmit).toHaveBeenCalledTimes(1);
    });
    expect(handleOrderPanelSubmit).toHaveBeenCalledWith({
      type: 'buy',
      orderKind: 'pending',
      pendingType: 'buy_limit',
      orderType: 'Buy Limit',
      symbol: 'XAUUSD',
      volume: 0.05,
      price: 3868.13,
    });
    expect(useOneClickDisclaimerStore.getState().acceptedInSession).toBe(true);
    expect(useOneClickDisclaimerStore.getState().declinedInSession).toBe(false);
    expect(useSettingsStore.getState().trade.oneClickTrading).toBe(true);
  });

  it('aborts quick pending order without placing or opening Order sheet when user clicks Cancel on disclaimer', async () => {
    const handleOrderPanelSubmit = vi.fn().mockResolvedValue(undefined);
    const openOrderPanelForSymbol = vi.fn(() => true);
    render(
      <QuickPendingHarness
        handleOrderPanelSubmit={handleOrderPanelSubmit}
        openOrderPanelForSymbol={openOrderPanelForSymbol}
      />,
    );

    dispatchQuickPendingOrder({
      symbol: 'XAUUSD',
      side: 'SELL',
      orderType: 'Sell Limit',
      price: 3875.5,
      volume: 0.02,
    });

    const dialog = await screen.findByRole('dialog', { name: DIALOG_NAME });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
    });
    expect(handleOrderPanelSubmit).not.toHaveBeenCalled();
    expect(openOrderPanelForSymbol).not.toHaveBeenCalled();
    expect(useOneClickDisclaimerStore.getState().acceptedInSession).toBe(false);
    expect(useOneClickDisclaimerStore.getState().declinedInSession).toBe(true);
  });

  it('still shows One-Click disclaimer for chart quick pending orders even after user previously canceled One-Click', async () => {
    const handleOrderPanelSubmit = vi.fn().mockResolvedValue(undefined);
    const openOrderPanelForSymbol = vi.fn(() => true);
    useOneClickDisclaimerStore.getState().closeDisclaimer();
    act(() => {
      useOneClickDisclaimerStore.setState({ declinedInSession: true, acceptedInSession: false });
    });

    render(
      <QuickPendingHarness
        handleOrderPanelSubmit={handleOrderPanelSubmit}
        openOrderPanelForSymbol={openOrderPanelForSymbol}
      />,
    );

    dispatchQuickPendingOrder({
      symbol: 'XAUUSD',
      side: 'SELL',
      orderType: 'Sell Limit',
      price: 3880.25,
      volume: 0.01,
    });

    const dialog = await screen.findByRole('dialog', { name: DIALOG_NAME });
    expect(handleOrderPanelSubmit).not.toHaveBeenCalled();
    expect(openOrderPanelForSymbol).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: ACCEPT_LABEL }));

    await waitFor(() => {
      expect(handleOrderPanelSubmit).toHaveBeenCalledWith({
        type: 'sell',
        orderKind: 'pending',
        pendingType: 'sell_limit',
        orderType: 'Sell Limit',
        symbol: 'XAUUSD',
        volume: 0.01,
        price: 3880.25,
      });
    });
    expect(useOneClickDisclaimerStore.getState().declinedInSession).toBe(false);
  });

  it('places quick pending orders immediately without showing disclaimer once One-Click is accepted', async () => {
    const handleOrderPanelSubmit = vi.fn().mockResolvedValue(undefined);
    act(() => {
      useOneClickDisclaimerStore.getState().onAccept();
    });

    render(<QuickPendingHarness handleOrderPanelSubmit={handleOrderPanelSubmit} />);

    dispatchQuickPendingOrder({
      symbol: 'XAUUSD',
      side: 'BUY',
      orderType: 'Buy Limit',
      price: 3860.0,
      volume: 0.03,
    });

    await waitFor(() => {
      expect(handleOrderPanelSubmit).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
  });

  it('requires authentication before opening One-Click disclaimer on quick pending order', () => {
    const handleOrderPanelSubmit = vi.fn().mockResolvedValue(undefined);
    const authRequests: Array<Record<string, unknown>> = [];
    const onAuth = (event: Event) => authRequests.push((event as CustomEvent).detail ?? {});
    window.addEventListener(TRADING_AUTH_REQUEST_EVENT, onAuth);
    useAppStore.setState({ isAuthenticated: false, accountId: '', authToken: '' });

    try {
      render(<QuickPendingHarness handleOrderPanelSubmit={handleOrderPanelSubmit} />);

      dispatchQuickPendingOrder({
        symbol: 'XAUUSD',
        side: 'BUY',
        orderType: 'Buy Limit',
        price: 3868.13,
        volume: 0.01,
      });

      expect(authRequests).toEqual([
        expect.objectContaining({
          source: 'quick-trade',
          side: 'BUY',
          symbol: 'XAUUSD',
          volume: 0.01,
        }),
      ]);
      expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
      expect(handleOrderPanelSubmit).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(TRADING_AUTH_REQUEST_EVENT, onAuth);
    }
  });

  it('aborts pending order if broker account session scope changes while disclaimer is open', async () => {
    const handleOrderPanelSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuickPendingHarness handleOrderPanelSubmit={handleOrderPanelSubmit} />);

    dispatchQuickPendingOrder({
      symbol: 'XAUUSD',
      side: 'BUY',
      orderType: 'Buy Limit',
      price: 3868.13,
      volume: 0.01,
    });

    const dialog = await screen.findByRole('dialog', { name: DIALOG_NAME });
    act(() => {
      commitBrokerAccountSessionScope({
        authenticated: true,
        accountId: '900002',
        brokerId: 'test-broker',
        serverUrl: 'https://test-broker.invalid',
      });
    });

    fireEvent.click(within(dialog).getByRole('button', { name: ACCEPT_LABEL }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
    });
    expect(handleOrderPanelSubmit).not.toHaveBeenCalled();
  });

  it('falls back to opening the Order sheet when price is invalid or submit handler is missing', () => {
    const openOrderPanelForSymbol = vi.fn(() => true);
    render(<QuickPendingHarness openOrderPanelForSymbol={openOrderPanelForSymbol} />);

    dispatchQuickPendingOrder({
      symbol: 'XAUUSD',
      side: 'BUY',
      orderType: 'Buy Limit',
      price: 3868.13,
    });

    expect(openOrderPanelForSymbol).toHaveBeenCalledWith('XAUUSD', undefined, {
      orderType: 'Buy Limit',
      side: 'BUY',
      price: 3868.13,
    });
    expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
  });

  it('integrates ChartContextMenu Buy Limit with OneClickTrading cancel flow -> shows disclaimer and submits on Accept', async () => {
    const handleOrderPanelSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <QuickPendingHarness
        handleOrderPanelSubmit={handleOrderPanelSubmit}
        withChartControls
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^BUY XAUUSD/ }));
    const firstDialog = await screen.findByRole('dialog', { name: DIALOG_NAME });
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Buy Limit 0.01' }));

    const secondDialog = await screen.findByRole('dialog', { name: DIALOG_NAME });
    expect(handleOrderPanelSubmit).not.toHaveBeenCalled();

    fireEvent.click(within(secondDialog).getByRole('button', { name: ACCEPT_LABEL }));

    await waitFor(() => {
      expect(handleOrderPanelSubmit).toHaveBeenCalledWith({
        type: 'buy',
        orderKind: 'pending',
        pendingType: 'buy_limit',
        orderType: 'Buy Limit',
        symbol: 'XAUUSD',
        volume: 0.01,
        price: 3868.13,
      });
    });
  });
});
