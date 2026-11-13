import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDemoRegistrationModes, registerDesktopBrokerDemoAccount } from '../api/demoRegistration';
import { TradeAuthDialog } from './TradeAuthDialog';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  persist: vi.fn(),
  loadDirectory: vi.fn(),
  webPolicy: vi.fn(),
  setToken: vi.fn(),
  setAuthTokens: vi.fn(),
  setAuthenticated: vi.fn(),
  addSavedAccount: vi.fn(),
  setActiveAccount: vi.fn(),
  saveLogin: vi.fn(),
  savedLoginsOn: false,
}));

vi.mock('../hooks/useUiTranslation', () => ({ useUiTranslation: () => (text: string) => text }));
vi.mock('../hooks/useBrokerLoginPolicy', () => ({ useBrokerLoginPolicy: mocks.webPolicy }));
vi.mock('../api/trade', () => ({ authV2Api: { login: mocks.login } }));
vi.mock('../api/demoRegistration', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api/demoRegistration')>(),
  registerRuntimeBrokerDemoAccount: vi.fn(),
  registerDesktopBrokerDemoAccount: vi.fn(),
  loadDemoRegistrationModes: vi.fn().mockResolvedValue({ hedging: null, netting: false }),
}));
vi.mock('../api/client', () => ({
  setToken: mocks.setToken,
  setRefreshToken: vi.fn(),
  removeToken: vi.fn(),
  parseTokenExpiresAt: vi.fn(),
}));
vi.mock('../services/savedLogins', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/savedLogins')>(),
  supportsSavedLogins: () => mocks.savedLoginsOn,
  saveLogin: mocks.saveLogin,
}));
vi.mock('../services/brokerSession', () => ({ persistBrokerSessionDiscovery: mocks.persist }));
vi.mock('../services/brokerDirectory', () => ({ loadAppBrokerDirectory: mocks.loadDirectory }));
vi.mock('../services/brokerPresentation', () => ({
  applyBrokerChrome: vi.fn(),
  loadBrokerPresentation: vi.fn().mockResolvedValue(null),
  mergeBrokerPresentation: (broker: unknown) => broker,
}));
vi.mock('../store/useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      accountId: '200001',
      setAuthTokens: mocks.setAuthTokens,
      setAuthenticated: mocks.setAuthenticated,
      addSavedAccount: mocks.addSavedAccount,
      setActiveAccount: mocks.setActiveAccount,
    }),
  },
}));
vi.mock('../config/api', () => ({
  BROKER_DISCOVERY_URL: 'https://directory.test',
  normalizeBrokerServerUrl: (url: string) => url,
  toLocalDevProxyUrl: (url: string) => url,
  updateDynamicUrls: vi.fn(),
}));
vi.mock('../config/backendTarget.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/backendTarget.js')>(),
  isElectronRuntime: () => true,
  isDesktopBackendTarget: () => true,
  getBackendTarget: () => 'https://environment-broker.test',
  normalizeBrokerInfoForTarget: (broker: unknown) => broker,
  resolveBrokerBackendUrl: () => 'https://environment-broker.test',
  resolveBrokerExtApiUrl: () => 'https://environment-broker.test',
}));
vi.mock('./WelcomeTerminal', () => ({
  LAST_AUTHENTICATED_BROKER_ID_KEY: 'rtx_last_authenticated_broker_id',
  pickDiscoveryBroker: (rows: Array<{ broker_id: string }>, options: { savedBrokerId: string }) =>
    rows.find(row => row.broker_id === options.savedBrokerId) || rows[0],
}));

const brokers = [
  { broker_id: 'achiever', broker_name: 'Achiever Financials', server_url: 'https://achiever.test' },
  { broker_id: 'Nexa', broker_name: 'Nexa', server_url: 'https://nexa.test' },
];
const intent = { source: 'quick-trade', side: 'BUY', symbol: 'BTCUSD', volume: 0.1 } as const;
const fetchMock = vi.fn();

describe('desktop trading authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('broker_id', 'Nexa');
    mocks.webPolicy.mockReturnValue({
      status: 'error', brokerId: '', displayName: '', locked: true, local: false,
      error: 'The active broker session does not match this terminal deployment URL.',
    });
    mocks.loadDirectory.mockResolvedValue(brokers);
    // account_type: 'real' makes the login classifiable so isLive is set
    // (ba43e98c: typeless logins intentionally omit isLive/accountType).
    mocks.login.mockResolvedValue({ access_token: 'desktop-test-token', account_login: 200001, broker_id: 'achiever', account_type: 'real' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'ok' })));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('electron', { window: {} });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('opens the server-selecting desktop login without evaluating the web deployment policy', async () => {
    render(<TradeAuthDialog isOpen initialMode="login" intent={null} onClose={vi.fn()} onAuthenticated={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Log in to trade' })).toBeVisible();
    expect(screen.queryByText('Account required to trade')).not.toBeInTheDocument();
    expect(screen.queryByText(/terminal deployment URL/)).not.toBeInTheDocument();
    await screen.findByText('Server online');
    const server = screen.getByRole('combobox', { name: /Server/i });
    expect(server).toBeEnabled();
    expect(server).toHaveValue('Nexa');
    expect(screen.getByRole('option', { name: 'Achiever Financials' })).toBeEnabled();
    expect(screen.getByRole('option', { name: 'Nexa' })).toBeEnabled();
    expect(mocks.webPolicy).not.toHaveBeenCalled();
    expect(mocks.loadDirectory).toHaveBeenCalledWith({ forceRefresh: true, desktop: true });
  });

  it('authenticates with a different selected broker and reports completion to the pending trade owner', async () => {
    const onClose = vi.fn();
    const onAuthenticated = vi.fn();
    render(<TradeAuthDialog isOpen intent={intent} onClose={onClose} onAuthenticated={onAuthenticated} />);
    // The login does not wait for the broker a demo account would use.
    expect(screen.getByText('Account required to trade')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /log in to live account/i }));
    await screen.findByText('Server online');

    fireEvent.change(screen.getByRole('combobox', { name: /Server/i }), { target: { value: 'achiever' } });
    await screen.findByText('Server online');
    fireEvent.change(screen.getByLabelText('Password', { exact: true }), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('200001'));
    expect(mocks.login).toHaveBeenCalledWith(
      { username: '200001', password: 'test-password', broker_id: 'achiever' },
      { baseUrl: 'https://achiever.test/api/v2', skipDynamicUrl: true, persistSession: false },
    );
    expect(mocks.persist).toHaveBeenLastCalledWith(expect.objectContaining({
      broker_id: 'achiever', server_url: 'https://achiever.test', access_token: 'desktop-test-token',
    }), { notifySessionChange: false });
    expect(mocks.setAuthenticated).toHaveBeenCalledExactlyOnceWith(
      true, '200001', 'desktop-test-token', undefined, undefined,
      expect.objectContaining({ login: 200001, server: 'Achiever Financials', isLive: true }),
    );
    expect(mocks.setAuthTokens).not.toHaveBeenCalled();
    expect(mocks.addSavedAccount).not.toHaveBeenCalled();
    expect(mocks.setActiveAccount).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.webPolicy).not.toHaveBeenCalled();
  });

  it('lets the user close desktop trade login without authenticating', async () => {
    const onClose = vi.fn();
    const onAuthenticated = vi.fn();
    render(<TradeAuthDialog isOpen intent={intent} onClose={onClose} onAuthenticated={onAuthenticated} />);
    fireEvent.click(screen.getByRole('button', { name: /log in to live account/i }));
    await screen.findByText('Server online');

    expect(screen.getByText(/No order has been placed/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Continue viewing' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('does not load either broker flow while the authentication dialog is closed', () => {
    render(<TradeAuthDialog isOpen={false} intent={null} onClose={vi.fn()} onAuthenticated={vi.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.loadDirectory).not.toHaveBeenCalled();
    expect(mocks.webPolicy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('desktop demo account from the trade login', () => {
  // The desktop terminal serves every directory broker from its own local
  // address and reaches one of them over the TCP link.
  const tcpBrokers = [
    { broker_id: 'achiever', broker_name: 'Achiever Financials', server_url: 'http://127.0.0.1:18504', tcp_addr: '10.0.0.1:4443' },
    { broker_id: 'Nexa', broker_name: 'Nexa', server_url: 'http://127.0.0.1:18504', tcp_addr: '10.0.0.2:4443', ws_url: 'ws://127.0.0.1:18504/ws/v2' },
  ];
  type TcpStatus = { connected?: boolean; broker_id?: string; target_tcp?: string };
  const tcpWindow = window as unknown as { __RTX5_TCP_STATUS__?: TcpStatus };
  let liveTcpStatus: TcpStatus;

  const fillDemoForm = () => {
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Demo User' } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'demo@example.com' } });
    fireEvent.change(screen.getByLabelText(/^phone$/i), { target: { value: '+44 20 7946 0000' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'Password1' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'Password1' } });
  };
  const openDemoForm = async () => {
    const demo = screen.getByRole('button', { name: /create demo account/i });
    await waitFor(() => expect(demo).toBeEnabled());
    fireEvent.click(demo);
    fillDemoForm();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    liveTcpStatus = { connected: true, broker_id: 'Nexa', target_tcp: '10.0.0.2:4443' };
    tcpWindow.__RTX5_TCP_STATUS__ = { ...liveTcpStatus };
    mocks.loadDirectory.mockResolvedValue(tcpBrokers);
    vi.mocked(loadDemoRegistrationModes).mockResolvedValue({ hedging: true, netting: false });
    vi.mocked(registerDesktopBrokerDemoAccount).mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(liveTcpStatus)));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('electron', { window: {} });
  });

  afterEach(() => {
    delete tcpWindow.__RTX5_TCP_STATUS__;
    vi.unstubAllGlobals();
  });

  it('offers login and a demo account at the connected broker', async () => {
    render(<TradeAuthDialog isOpen intent={intent} onClose={vi.fn()} onAuthenticated={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Account required to trade' })).toBeVisible();
    expect(screen.getByText(/order will not be sent automatically/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /log in to live account/i })).toBeEnabled();
    const demo = screen.getByRole('button', { name: /create demo account/i });
    await waitFor(() => expect(demo).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(loadDemoRegistrationModes).toHaveBeenCalledWith('Nexa', expect.anything(), { brokerId: 'Nexa', serverUrl: 'http://127.0.0.1:18504' }));
    expect(mocks.webPolicy).not.toHaveBeenCalled();

    fireEvent.click(demo);
    expect(screen.getByRole('dialog', { name: 'Create demo account' })).toBeVisible();
    expect(screen.getByText('Nexa')).toBeVisible();
  });

  it('creates the demo account at the connected broker and stores the session like the desktop login', async () => {
    const onAuthenticated = vi.fn();
    vi.mocked(registerDesktopBrokerDemoAccount).mockResolvedValue({
      access_token: 'demo-token', account_login: 300001, broker_id: 'Nexa', name: 'Demo User',
    });
    render(<TradeAuthDialog isOpen intent={intent} onClose={vi.fn()} onAuthenticated={onAuthenticated} />);
    await openDemoForm();
    fireEvent.click(screen.getByRole('button', { name: /create and continue/i }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('300001'));
    expect(fetchMock).toHaveBeenCalledWith('/api/tcp-client/status', { cache: 'no-store' });
    expect(registerDesktopBrokerDemoAccount).toHaveBeenCalledExactlyOnceWith(
      { name: 'Demo User', email: 'demo@example.com', password: 'Password1', phone: '+44 20 7946 0000' }, { brokerId: 'Nexa', serverUrl: 'http://127.0.0.1:18504' },
    );
    const routing = {
      broker_id: 'Nexa', broker_name: 'Nexa', tcp_addr: '10.0.0.2:4443',
      display_server: 'Nexa (10.0.0.2:4443)', broker_server: 'Nexa (10.0.0.2:4443)',
      server_url: 'http://127.0.0.1:18504', backend_url: 'http://127.0.0.1:18504',
      market_api_url: 'http://127.0.0.1:18504', ws_url: 'ws://127.0.0.1:18504/ws/v2',
    };
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    expect(mocks.persist).toHaveBeenNthCalledWith(1, expect.objectContaining(routing), { notifySessionChange: 'routing-changes' });
    expect(mocks.persist.mock.calls[0][0]).not.toHaveProperty('access_token');
    expect(mocks.persist).toHaveBeenNthCalledWith(
      2, expect.objectContaining({ ...routing, access_token: 'demo-token' }), { notifySessionChange: false },
    );
    expect(mocks.setToken).toHaveBeenCalledExactlyOnceWith('demo-token');
    expect(localStorage.getItem('rtx_broker_server')).toBe('Nexa (10.0.0.2:4443)');
    expect(localStorage.getItem('rtx_last_authenticated_broker_id')).toBe('Nexa');
    expect(localStorage.getItem('rtx_last_login')).toBe('300001');
    expect(mocks.setAuthenticated).toHaveBeenCalledExactlyOnceWith(
      true, '300001', 'demo-token', undefined, undefined,
      expect.objectContaining({
        login: 300001, name: 'Demo User', server: 'Nexa (10.0.0.2:4443)', accountType: 'demo', isLive: false,
      }),
    );
    expect(mocks.setAuthTokens).not.toHaveBeenCalled();
    expect(mocks.setActiveAccount).not.toHaveBeenCalled();
    expect(mocks.webPolicy).not.toHaveBeenCalled();
  });

  it('creates nothing when the terminal has moved to another broker server', async () => {
    const onAuthenticated = vi.fn();
    render(<TradeAuthDialog isOpen intent={intent} onClose={vi.fn()} onAuthenticated={onAuthenticated} />);
    await openDemoForm();
    liveTcpStatus = { connected: true, broker_id: 'achiever', target_tcp: '10.0.0.1:4443' };
    fireEvent.click(screen.getByRole('button', { name: /create and continue/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/connected to a different broker server/i);
    expect(registerDesktopBrokerDemoAccount).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.setAuthenticated).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /create and continue/i })).toBeEnabled();
  });

  it.each([
    ['is not connected', () => { liveTcpStatus = { connected: false, broker_id: 'Nexa' }; }],
    ['cannot report its connection', () => { fetchMock.mockRejectedValue(new Error('offline')); }],
  ])('creates nothing when the terminal %s', async (_label, breakLink) => {
    render(<TradeAuthDialog isOpen intent={intent} onClose={vi.fn()} onAuthenticated={vi.fn()} />);
    await openDemoForm();
    breakLink();
    fireEvent.click(screen.getByRole('button', { name: /create and continue/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not connected to the broker server/i);
    expect(registerDesktopBrokerDemoAccount).not.toHaveBeenCalled();
    expect(mocks.setAuthenticated).not.toHaveBeenCalled();
  });

  it('does not store the session when the terminal moved to another broker during the request', async () => {
    const onAuthenticated = vi.fn();
    vi.mocked(registerDesktopBrokerDemoAccount).mockImplementation(async () => {
      liveTcpStatus = { connected: true, broker_id: 'achiever', target_tcp: '10.0.0.1:4443' };
      return { access_token: 'demo-token', account_login: 300009, broker_id: 'Nexa' };
    });
    render(<TradeAuthDialog isOpen intent={intent} onClose={vi.fn()} onAuthenticated={onAuthenticated} />);
    await openDemoForm();
    fireEvent.click(screen.getByRole('button', { name: /create and continue/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Demo account 300009 was created');
    expect(alert).toHaveTextContent('you were not logged in');
    // The request went to the shared local address, so the message names both possible brokers.
    expect(alert).toHaveTextContent('at Nexa or at the broker server you switched to');
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.setToken).not.toHaveBeenCalled();
    expect(mocks.setAuthenticated).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('never saves the demo password on the desktop terminal', async () => {
    mocks.savedLoginsOn = true;
    try {
      const onAuthenticated = vi.fn();
      vi.mocked(registerDesktopBrokerDemoAccount).mockResolvedValue({ access_token: 'demo-token', account_login: 300010, broker_id: 'Nexa' });
      render(<TradeAuthDialog isOpen intent={null} onClose={vi.fn()} onAuthenticated={onAuthenticated} />);
      await openDemoForm();
      fireEvent.click(screen.getByRole('button', { name: /create and continue/i }));
      await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('300010'));
      expect(mocks.saveLogin).not.toHaveBeenCalled();
    } finally {
      mocks.savedLoginsOn = false;
    }
  });

  it('does not log in with a demo account returned for a different broker', async () => {
    const onAuthenticated = vi.fn();
    vi.mocked(registerDesktopBrokerDemoAccount).mockResolvedValue({
      access_token: 'wrong-token', account_login: 300002, broker_id: 'achiever',
    });
    render(<TradeAuthDialog isOpen intent={intent} onClose={vi.fn()} onAuthenticated={onAuthenticated} />);
    await openDemoForm();
    fireEvent.click(screen.getByRole('button', { name: /create and continue/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/different broker/i);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.setToken).not.toHaveBeenCalled();
    expect(mocks.setAuthenticated).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('does not offer a demo account at a broker that has none, and keeps the login', async () => {
    vi.mocked(loadDemoRegistrationModes).mockResolvedValue({ hedging: false, netting: false });
    render(<TradeAuthDialog isOpen intent={null} onClose={vi.fn()} onAuthenticated={vi.fn()} />);

    expect(await screen.findByText('This broker does not offer demo accounts')).toBeVisible();
    expect(screen.getByRole('button', { name: /create demo account/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /log in to live account/i })).toBeEnabled();
  });

  it('offers a netting demo account when the connected broker has one', async () => {
    vi.mocked(loadDemoRegistrationModes).mockResolvedValue({ hedging: true, netting: true });
    vi.mocked(registerDesktopBrokerDemoAccount).mockResolvedValue({
      access_token: 'netting-token', account_login: 300003, broker_id: 'Nexa',
    });
    const onAuthenticated = vi.fn();
    render(<TradeAuthDialog isOpen intent={null} onClose={vi.fn()} onAuthenticated={onAuthenticated} />);
    await openDemoForm();
    fireEvent.click(await screen.findByRole('radio', { name: 'Netting' }));
    fireEvent.click(screen.getByRole('button', { name: /create and continue/i }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith('300003'));
    expect(registerDesktopBrokerDemoAccount).toHaveBeenCalledExactlyOnceWith(
      { name: 'Demo User', email: 'demo@example.com', password: 'Password1', phone: '+44 20 7946 0000', accountMode: 'netting' }, { brokerId: 'Nexa', serverUrl: 'http://127.0.0.1:18504' },
    );
  });

  it('does not offer netting when the connected broker has no netting demo group', async () => {
    vi.mocked(loadDemoRegistrationModes).mockResolvedValue({ hedging: true, netting: false });
    render(<TradeAuthDialog isOpen intent={null} onClose={vi.fn()} onAuthenticated={vi.fn()} />);
    await openDemoForm();
    await waitFor(() => expect(loadDemoRegistrationModes).toHaveBeenCalled());

    expect(screen.queryByRole('radio', { name: 'Netting' })).not.toBeInTheDocument();
  });

  it('asks for a first and last name and a phone number before sending anything', async () => {
    render(<TradeAuthDialog isOpen intent={null} onClose={vi.fn()} onAuthenticated={vi.fn()} />);
    await openDemoForm();
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Demo' } });
    fireEvent.click(screen.getByRole('button', { name: /create and continue/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please enter your first and last name.');

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Demo User' } });
    fireEvent.change(screen.getByLabelText(/^phone$/i), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: /create and continue/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Phone number is required.');
    expect(registerDesktopBrokerDemoAccount).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/tcp-client/status', expect.anything());
  });

  it('keeps the login available when the connected broker cannot be named for a demo account', async () => {
    mocks.loadDirectory.mockRejectedValue(new Error('directory offline'));
    render(<TradeAuthDialog isOpen intent={null} onClose={vi.fn()} onAuthenticated={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/broker servers could not be loaded/i);
    expect(screen.getByRole('button', { name: /create demo account/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /log in to live account/i })).toBeEnabled();

    mocks.loadDirectory.mockResolvedValue(tcpBrokers);
    fireEvent.click(screen.getByRole('button', { name: /log in to live account/i }));
    expect(await screen.findByRole('dialog', { name: 'Log in to trade' })).toBeVisible();
  });

  it('follows the terminal to the broker server it is switched to', async () => {
    render(<TradeAuthDialog isOpen initialMode="demo" intent={null} onClose={vi.fn()} onAuthenticated={vi.fn()} />);
    expect(await screen.findByText('Nexa')).toBeVisible();

    act(() => {
      tcpWindow.__RTX5_TCP_STATUS__ = { connected: true, broker_id: 'achiever', target_tcp: '10.0.0.1:4443' };
      window.dispatchEvent(new CustomEvent('rtx5-tcp-status'));
    });
    expect(await screen.findByText('Achiever Financials')).toBeVisible();
    await waitFor(() => expect(loadDemoRegistrationModes).toHaveBeenLastCalledWith('achiever', expect.anything(), { brokerId: 'achiever', serverUrl: 'http://127.0.0.1:18504' }));
  });
});
