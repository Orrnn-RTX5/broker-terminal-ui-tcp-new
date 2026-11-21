// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigatorPanel } from './NavigatorPanel';
import { useAppStore, type SavedAccount } from '../../store/useAppStore';
import { clearCachedAccountSessions } from '../../services/accountSessionCache';
import { commitBrokerAccountSessionScope } from '../../services/brokerSession';
import { saveLogin } from '../../services/savedLogins';

const apiMocks = vi.hoisted(() => ({
  login: vi.fn(),
  getServers: vi.fn(),
  getBrokers: vi.fn(),
}));

vi.mock('../../api/trade', () => ({
  authV2Api: { login: apiMocks.login },
  brokerV2Api: {
    getServers: apiMocks.getServers,
    getBrokers: apiMocks.getBrokers,
  },
}));
vi.mock('../../services/api', () => ({ api: { auth: { logout: vi.fn() } } }));
vi.mock('../../services/brokerDirectory', () => ({
  getCachedBrokerDirectory: () => [{
    broker_id: 'alpha-broker',
    broker_name: 'Alpha Markets',
    server_url: 'https://alpha.example',
    backend_url: 'https://alpha.example',
    market_api_url: 'https://alpha.example',
    logo_url: '',
  }],
  loadAppBrokerDirectory: vi.fn().mockResolvedValue([{
    broker_id: 'alpha-broker',
    broker_name: 'Alpha Markets',
    server_url: 'https://alpha.example',
    backend_url: 'https://alpha.example',
    market_api_url: 'https://alpha.example',
    logo_url: '',
  }]),
}));
vi.mock('../../startup/runAfterTerminalReady', () => ({ runAfterTerminalReady: () => () => undefined }));
vi.mock('../../startup/terminalFeatures', () => ({ openAccountFeature: { Component: () => null } }));
vi.mock('../ChangePasswordDialog', () => ({ ChangePasswordDialog: () => null }));

const BROKER_ID = 'alpha-broker';
const BROKER_NAME = 'Alpha Markets';
const SERVER_URL = 'https://alpha.example';

const configureWebBrokerRuntime = () => {
  (window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, string> }).__RTX_RUNTIME_CONFIG__ = {
    CONFIG_SOURCE: 'deployment',
    BACKEND_TARGET: 'web',
    BROKER_ID,
    BROKER_NAME,
    API_HOST: SERVER_URL,
    API_HOST_EXT: SERVER_URL,
    WS_HOST: 'wss://alpha.example',
    DEFAULT_MT5_SERVER: BROKER_NAME,
    DISCOVERY_BASE_URL: 'https://directory.example',
  };
  localStorage.setItem('broker_id', BROKER_ID);
  localStorage.setItem('rtx_broker_id', BROKER_ID);
  localStorage.setItem('broker_name', BROKER_NAME);
  localStorage.setItem('server_url', SERVER_URL);
  localStorage.setItem('backend_url', SERVER_URL);
  localStorage.setItem('rtx_broker_server', BROKER_NAME);
};

describe('Navigator broker double-click add another account flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedAccountSessions();
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        broker_id: BROKER_ID,
        broker_name: BROKER_NAME,
        server_url: SERVER_URL,
        backend_url: SERVER_URL,
        market_api_url: SERVER_URL,
        logo_url: '',
      }],
    }));
    apiMocks.getServers.mockResolvedValue([]);
    apiMocks.getBrokers.mockResolvedValue({ brokers: [], count: 0 });
    configureWebBrokerRuntime();
    useAppStore.setState({
      isAuthenticated: false,
      accountId: null,
      authToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      savedAccounts: [],
    });
    commitBrokerAccountSessionScope({ authenticated: false, accountId: null, brokerId: '', serverUrl: '' });
  });

  afterEach(() => {
    cleanup();
    clearCachedAccountSessions();
    useAppStore.setState({
      isAuthenticated: false,
      accountId: null,
      authToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      savedAccounts: [],
    });
    commitBrokerAccountSessionScope({ authenticated: false, accountId: null, brokerId: '', serverUrl: '' });
    delete (window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, string> }).__RTX_RUNTIME_CONFIG__;
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('shows "Add another account" on broker double-click, opens blank login, and displays demo and live accounts under the same broker', async () => {
    await saveLogin({ brokerId: BROKER_ID, serverUrl: SERVER_URL }, '200001', 'LivePass123');
    localStorage.setItem('rtx_saved_username', '200001');

    const initialLiveAccount: SavedAccount = {
      login: 200001,
      name: 'Primary Live',
      server: BROKER_NAME,
      brokerId: BROKER_ID,
      serverUrl: SERVER_URL,
      accountType: 'real',
      isLive: true,
      lastUsed: 1,
    };
    useAppStore.getState().setAuthenticated(
      true,
      '200001',
      'token-live-200001',
      'refresh-200001',
      Date.now() + 3600_000,
      initialLiveAccount,
    );

    render(<NavigatorPanel />);

    // Broker node is visible with the initial live account
    const brokerLabel = screen.getByText(BROKER_NAME, { selector: '.navigator-tree-item__label' });
    const brokerRow = brokerLabel.closest('.navigator-tree-item__row') as HTMLElement;
    expect(screen.getByText('200001: Primary Live')).toBeInTheDocument();

    // Double-click broker name -> shows "Add another account" menu and keeps accounts expanded
    fireEvent.doubleClick(brokerRow, { clientX: 80, clientY: 90 });
    const menu = screen.getByRole('menu');
    const addAnotherItem = within(menu).getByRole('menuitem', { name: 'Add another account' });
    expect(addAnotherItem).toBeInTheDocument();
    expect(screen.getByText('200001: Primary Live')).toBeInTheDocument();

    // Click "Add another account" -> opens blank LoginDialog (does not prefill existing account 200001)
    fireEvent.click(addAnotherItem);
    const dialog = await screen.findByRole('dialog', { name: 'Add another account' });
    await within(dialog).findByText('Server online');
    const accountInput = within(dialog).getByLabelText('Account ID');
    const passwordInput = within(dialog).getByLabelText('Password');
    expect(accountInput).toHaveValue('');
    expect(passwordInput).toHaveValue('');

    // Log in with a Demo account on the same broker
    apiMocks.login.mockResolvedValueOnce({
      access_token: 'token-demo-200002',
      refresh_token: 'refresh-200002',
      expires_in: 3600,
      account_login: 200002,
      broker_id: BROKER_ID,
      broker_server: 'Alpha-Demo',
      account_type: 'demo',
      user: { name: 'Practice Demo', account_type: 'demo' },
    });

    fireEvent.change(accountInput, { target: { value: '200002' } });
    fireEvent.change(passwordInput, { target: { value: 'DemoPass123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(useAppStore.getState().accountId).toBe('200002'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add another account' })).not.toBeInTheDocument());

    // Both Demo and Live accounts are shown under the SAME single broker node
    expect(screen.getAllByText(BROKER_NAME, { selector: '.navigator-tree-item__label' })).toHaveLength(1);
    const liveRow = screen.getByText('200001: Primary Live').closest('.navigator-tree-item__row') as HTMLElement;
    const demoRow = screen.getByText('200002: Practice Demo').closest('.navigator-tree-item__row') as HTMLElement;
    expect(within(liveRow).queryByText('Live')).not.toBeInTheDocument();
    expect(within(demoRow).queryByText('Demo')).not.toBeInTheDocument();
    expect(liveRow).toHaveAttribute('data-account-active', 'false');
    expect(demoRow).toHaveAttribute('data-account-active', 'true');

    // Even after both Demo and Live accounts exist, double-clicking the broker name STILL lets the user add many more accounts
    fireEvent.doubleClick(
      screen.getByText(BROKER_NAME, { selector: '.navigator-tree-item__label' }).closest('.navigator-tree-item__row')!,
      { clientX: 80, clientY: 90 },
    );
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Add another account' }));

    const secondDialog = await screen.findByRole('dialog', { name: 'Add another account' });
    await within(secondDialog).findByText('Server online');
    expect(within(secondDialog).getByLabelText('Account ID')).toHaveValue('');
    expect(within(secondDialog).getByLabelText('Password')).toHaveValue('');

    apiMocks.login.mockResolvedValueOnce({
      access_token: 'token-live-200003',
      refresh_token: 'refresh-200003',
      expires_in: 3600,
      account_login: 200003,
      broker_id: BROKER_ID,
      broker_server: 'Alpha-Live',
      account_type: 'real',
      user: { name: 'Second Live', account_type: 'real' },
    });

    fireEvent.change(within(secondDialog).getByLabelText('Account ID'), { target: { value: '200003' } });
    fireEvent.change(within(secondDialog).getByLabelText('Password'), { target: { value: 'LivePass456' } });
    fireEvent.click(within(secondDialog).getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(useAppStore.getState().accountId).toBe('200003'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add another account' })).not.toBeInTheDocument());

    // All three accounts (2 Live + 1 Demo) appear under the SAME broker
    expect(screen.getAllByText(BROKER_NAME, { selector: '.navigator-tree-item__label' })).toHaveLength(1);
    expect(screen.getByText('200001: Primary Live')).toBeInTheDocument();
    expect(screen.getByText('200002: Practice Demo')).toBeInTheDocument();
    expect(screen.getByText('200003: Second Live')).toBeInTheDocument();

    // Switching back to the first Live account on double-click works seamlessly without reopening login
    await act(async () => {
      fireEvent.doubleClick(screen.getByText('200001: Primary Live').closest('.navigator-tree-item__row')!);
    });
    expect(useAppStore.getState().accountId).toBe('200001');
    expect(useAppStore.getState().authToken).toBe('token-live-200001');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows "Add another account" when double-clicking the broker name while logged out and when right-clicking the broker name', async () => {
    render(<NavigatorPanel />);

    const placeholderBrokerRow = screen
      .getByText(BROKER_NAME, { selector: '.navigator-tree-item__label' })
      .closest('.navigator-tree-item__row') as HTMLElement;

    // Right-click opens one menu with "Add another account"
    fireEvent.contextMenu(placeholderBrokerRow, { clientX: 60, clientY: 80 });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: 'Add another account' })).toBeInTheDocument();

    // Escape closes it, and double-click reopens it and launches the login dialog
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.doubleClick(placeholderBrokerRow);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Add another account' }));

    const dialog = await screen.findByRole('dialog', { name: 'Add another account' });
    expect(within(dialog).getByLabelText('Account ID')).toHaveValue('');
  });
});
