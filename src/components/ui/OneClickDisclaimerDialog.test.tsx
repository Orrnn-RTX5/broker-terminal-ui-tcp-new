// @vitest-environment jsdom

import '@testing-library/jest-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const orderMocks = vi.hoisted(() => ({
  placeMarketOrder: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  default: { orders: { placeMarketOrder: orderMocks.placeMarketOrder } },
}));

import { useAppStore } from '../../store/useAppStore';
import {
  ONE_CLICK_DISCLAIMER_SESSION_KEY,
  useOneClickDisclaimerStore,
} from '../../store/useOneClickDisclaimerStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { commitBrokerAccountSessionScope } from '../../services/brokerSession';
import { normalizeMarketStatus } from '../../utils/marketStatus';
import { OneClickTrading } from '../OneClickTrading';
import { OptionsDialog } from '../settings/OptionsDialog';
import { OneClickDisclaimerDialog } from './OneClickDisclaimerDialog';

const DIALOG_NAME = 'One Click Trading';
const ACCEPT_LABEL = 'I Accept these Terms and Conditions';

const renderOneClick = (symbol = 'BTCUSD') => render(
  <OneClickTrading
    symbol={symbol}
    timeframe="M1"
    visible
    tradeAllowed
    marketStatus={normalizeMarketStatus({ symbol, status: 'open' })}
  />,
);

describe('OneClickDisclaimerDialog (flat short MT5 sheet with session-default behavior)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useAppStore.getState().reset();
    useSettingsStore.getState().resetToDefaults();
    useOneClickDisclaimerStore.getState().resetSessionAcceptance();
    orderMocks.placeMarketOrder.mockReset().mockResolvedValue({ ticket: 5001, symbol: 'BTCUSD' });
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '900001',
      authToken: 'oct-disclaimer-token',
      tokenExpiresAt: Date.now() + 60_000,
    });
    useAppStore.getState().setTicks({
      BTCUSD: {
        symbol: 'BTCUSD',
        bid: 57952.35,
        ask: 57967.43,
        spread: 15.08,
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

  it('shows the short flat MT5-style disclaimer popup by default on BUY or SELL and submits no order', () => {
    expect(useOneClickDisclaimerStore.getState().acceptedInSession).toBe(false);
    renderOneClick();

    fireEvent.click(screen.getByRole('button', { name: /^BUY BTCUSD/ }));

    const dialog = screen.getByRole('dialog', { name: DIALOG_NAME });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('Disclaimer')).toBeInTheDocument();
    expect(within(dialog).getByText(/activate One Click Trading mode for this session/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/1\. Default mode is a two-step process/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/2\. One Click Trading mode is a one-step process/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/THERE WILL BE NO FURTHER CONFIRMATION PROMPT/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Options → Trade/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: ACCEPT_LABEL })).toBeInTheDocument();
    // Flat document UI — no nested inner card/callout boxes
    expect(dialog.querySelector('.rtx-oct-disclaimer-dialog__points')).toBeNull();
    expect(dialog.querySelector('.rtx-oct-disclaimer-dialog__notice')).toBeNull();
    expect(orderMocks.placeMarketOrder).not.toHaveBeenCalled();
  });

  it.each(['Cancel', 'Close dialog', 'Escape', 'backdrop'] as const)(
    're-shows the disclaimer on the next trade click when dismissed via %s',
    (dismissal) => {
      renderOneClick();

      fireEvent.click(screen.getByRole('button', { name: /^SELL BTCUSD/ }));
      expect(screen.getByRole('dialog', { name: DIALOG_NAME })).toBeInTheDocument();

      if (dismissal === 'Escape') {
        fireEvent.keyDown(screen.getByRole('dialog', { name: DIALOG_NAME }), { key: 'Escape' });
      } else if (dismissal === 'backdrop') {
        fireEvent.pointerDown(screen.getByTestId('one-click-disclaimer-backdrop'));
      } else {
        fireEvent.click(screen.getByRole('button', { name: dismissal }));
      }

      expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
      expect(useOneClickDisclaimerStore.getState().acceptedInSession).toBe(false);
      expect(orderMocks.placeMarketOrder).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /^BUY BTCUSD/ }));
      expect(screen.getByRole('dialog', { name: DIALOG_NAME })).toBeInTheDocument();
    },
  );

  it('preserves acceptance across page refresh / hard refresh (sessionStorage), and re-shows disclaimer when page or app is closed and reopened', () => {
    const view = renderOneClick();

    // 1. Fresh app open: first click shows the disclaimer without placing a trade
    fireEvent.click(screen.getByRole('button', { name: /^BUY BTCUSD/ }));
    expect(screen.getByRole('dialog', { name: DIALOG_NAME })).toBeInTheDocument();
    expect(sessionStorage.getItem(ONE_CLICK_DISCLAIMER_SESSION_KEY)).toBeNull();
    expect(orderMocks.placeMarketOrder).not.toHaveBeenCalled();

    // 2. Accept: stores session acceptance in sessionStorage without executing the triggering click
    fireEvent.click(screen.getByRole('button', { name: ACCEPT_LABEL }));
    expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(ONE_CLICK_DISCLAIMER_SESSION_KEY)).toBe('1');
    expect(useOneClickDisclaimerStore.getState().acceptedInSession).toBe(true);
    expect(useSettingsStore.getState().trade.oneClickTrading).toBe(true);
    expect(orderMocks.placeMarketOrder).not.toHaveBeenCalled();

    // 3. Subsequent click in the same session executes immediately
    fireEvent.click(screen.getByRole('button', { name: /^SELL BTCUSD/ }));
    expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
    expect(orderMocks.placeMarketOrder).toHaveBeenCalledTimes(1);
    expect(orderMocks.placeMarketOrder).toHaveBeenCalledWith(
      { side: 'sell', symbol: 'BTCUSD', volume: 0.01, login: 900001 },
      { intentAtMs: expect.any(Number) },
    );

    // 4. Simulate page refresh / hard refresh: JS runtime resets while browser preserves
    //    both `sessionStorage` and `localStorage` -> disclaimer MUST NOT show again
    view.unmount();
    act(() => {
      useOneClickDisclaimerStore.setState({ acceptedInSession: false });
      useOneClickDisclaimerStore.getState().syncSessionAcceptanceFromStorage();
    });
    expect(useOneClickDisclaimerStore.getState().acceptedInSession).toBe(true);

    const afterRefresh = renderOneClick();
    fireEvent.click(screen.getByRole('button', { name: /^BUY BTCUSD/ }));
    expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
    expect(orderMocks.placeMarketOrder).toHaveBeenCalledTimes(2);

    // 5. Simulate closing the tab/page or closing the application and reopening it:
    //    browser/Electron clears `sessionStorage` while `localStorage` remains -> disclaimer SHOWS again
    afterRefresh.unmount();
    sessionStorage.clear();
    act(() => {
      useOneClickDisclaimerStore.getState().syncSessionAcceptanceFromStorage();
    });
    expect(useSettingsStore.getState().trade.oneClickTrading).toBe(true);
    expect(useOneClickDisclaimerStore.getState().acceptedInSession).toBe(false);

    renderOneClick();
    fireEvent.click(screen.getByRole('button', { name: /^BUY BTCUSD/ }));
    expect(screen.getByRole('dialog', { name: DIALOG_NAME })).toBeInTheDocument();
    expect(orderMocks.placeMarketOrder).toHaveBeenCalledTimes(2);
  });

  it('renders only one disclaimer dialog when globalHost is mounted alongside multiple OneClickTrading panels', () => {
    render(
      <>
        <OneClickDisclaimerDialog globalHost />
        <OneClickTrading symbol="BTCUSD" timeframe="M1" visible tradeAllowed marketStatus={normalizeMarketStatus({ symbol: 'BTCUSD', status: 'open' })} />
        <OneClickTrading symbol="BTCUSD" timeframe="M5" visible tradeAllowed marketStatus={normalizeMarketStatus({ symbol: 'BTCUSD', status: 'open' })} />
      </>,
    );

    const buyButtons = screen.getAllByRole('button', { name: /^BUY BTCUSD/ });
    fireEvent.click(buyButtons[0]);

    expect(screen.getAllByRole('dialog', { name: DIALOG_NAME })).toHaveLength(1);
  });

  it('uses the dynamic white-label broker name with a generic fallback', () => {
    renderOneClick();
    fireEvent.click(screen.getByRole('button', { name: /^BUY BTCUSD/ }));
    expect(screen.getByText(/indemnify the broker from related losses/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    act(() => {
      localStorage.setItem('broker_name', 'Acme Markets Ltd');
      useSettingsStore.getState().updateServerSettings({ serverName: 'Acme Markets Ltd' });
    });
    fireEvent.click(screen.getByRole('button', { name: /^BUY BTCUSD/ }));
    expect(screen.getByText(/indemnify Acme Markets Ltd from related losses/i)).toBeInTheDocument();
  });

  it('prompts the disclaimer when enabling One Click Trading from Options -> Trade and turns it off immediately without prompting', () => {
    render(<OptionsDialog isOpen onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Trade' }));

    const toggle = screen.getByLabelText('One Click Trading');
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(screen.getByRole('dialog', { name: DIALOG_NAME })).toBeInTheDocument();
    expect(toggle).not.toBeChecked();

    // Escape closes only the disclaimer, keeping Options open
    fireEvent.keyDown(screen.getByRole('dialog', { name: DIALOG_NAME }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Options' })).toBeInTheDocument();
    expect(toggle).not.toBeChecked();

    // Accepting activates One Click Trading in Options for the session
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: ACCEPT_LABEL }));
    expect(toggle).toBeChecked();
    expect(useOneClickDisclaimerStore.getState().acceptedInSession).toBe(true);
    expect(useSettingsStore.getState().trade.oneClickTrading).toBe(true);

    // Turning OFF disables immediately without showing the disclaimer
    fireEvent.click(toggle);
    expect(screen.queryByRole('dialog', { name: DIALOG_NAME })).not.toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    expect(useOneClickDisclaimerStore.getState().acceptedInSession).toBe(false);
    expect(useSettingsStore.getState().trade.oneClickTrading).toBe(false);
  });

  it('styles the flat sheet at the same compact size without scrolling using application theme tokens', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/one-click-disclaimer-dialog.css'), 'utf8');
    expect(css).toContain('width: min(540px, calc(100vw - 32px));');
    expect(css).toContain('max-height: min(440px, calc(100dvh - 32px));');
    expect(css).toMatch(/\.rtx-oct-disclaimer-dialog__body\s*\{[^}]*overflow: hidden;/);
    expect(css).toContain('var(--bg-secondary, #131316)');
    expect(css).toContain('var(--bg-tertiary, #191a1e)');
    expect(css).toContain('background: #4597ff;');
    expect(css).toContain('var(--rtx-light-elevated, #ffffff)');
    expect(css).toContain('var(--rtx-light-buy, #2563eb)');
    expect(css).not.toContain('.rtx-oct-disclaimer-dialog__points');
    expect(css).not.toContain('.rtx-oct-disclaimer-dialog__notice');
  });
});
