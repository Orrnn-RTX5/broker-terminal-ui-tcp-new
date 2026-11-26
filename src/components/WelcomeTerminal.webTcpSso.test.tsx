import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBrokerChrome } from '../services/brokerPresentation';
import { beginLoginPerformanceMeasurement } from '../startup/performanceBudget';
import {
  WEB_TERMINAL_SSO_HANDOFF_KEY,
  captureWebTerminalSsoAtStartup,
  hasPendingWebTerminalSso,
  takePendingWebTerminalSso,
} from '../startup/webTerminalSso';
import { WelcomeTerminal, type BrokerServerItem } from './WelcomeTerminal';

// The web-tcp terminal (web-terminal-server) is a desktop backend target pinned to one broker.
// Its broker comes from the desktop directory and its health check. Real Electron builds never
// start SSO. The directory, health check, exchange and saved-login hook are mocked, so no request
// leaves the test.
const runtime = vi.hoisted(() => ({
  login: vi.fn(),
  exchange: vi.fn(),
  persist: vi.fn(),
  loadStore: vi.fn(),
  restoring: false,
  stable: { noop: () => undefined, persist: async () => undefined },
}));

vi.mock('../hooks/useUiTranslation', () => ({ useUiTranslation: () => (text: string) => text }));
vi.mock('../config/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/api')>(),
  BROKER_DISCOVERY_URL: 'https://directory.example.test',
}));
vi.mock('../hooks/useSavedLogin', () => ({
  useSavedLogin: () => ({
    login: '',
    password: '',
    setLogin: runtime.stable.noop,
    setPassword: runtime.stable.noop,
    savePassword: false,
    setSavePassword: runtime.stable.noop,
    available: true,
    restoring: runtime.restoring,
    storageError: null,
    persistPassword: runtime.stable.persist,
  }),
}));
vi.mock('../startup/loginRuntime', () => ({
  preloadLoginTransportRuntime: async () => ({
    authV2Api: { login: runtime.login, exchangeWebTerminalSso: runtime.exchange },
    persistBrokerSessionDiscovery: runtime.persist,
  }),
  loadAuthenticatedLoginStoreRuntime: () => runtime.loadStore(),
}));
vi.mock('../startup/performanceBudget', () => ({
  beginLoginPerformanceMeasurement: vi.fn(), markAuthenticationAccepted: vi.fn(),
  markAuthenticationRequestStarted: vi.fn(), markPostAuthenticationPhase: vi.fn(),
  scheduleAuthenticatedShellPaintMeasurement: vi.fn(), waitForLoginFeedbackPaint: async () => {},
}));

const TOKEN = 'Xk3_pQ9-vT2bLm8zRw4nYc7hJd1sFg6uAe0iOqN5tKa';
const BROKER_ID = 'test-broker';
const SERVER_URL = 'https://service.example.test';
const webTcpBroker: BrokerServerItem = {
  broker_id: BROKER_ID,
  broker_name: 'Test Broker',
  logo_url: '',
  server_url: SERVER_URL,
  active: true,
  enabled: true,
};
const webTcpRuntimeConfig = (): Record<string, unknown> => ({
  CONFIG_SOURCE: 'runtime',
  BACKEND_TARGET: 'desktop',
  BACKEND_MODE: 'desktop',
  BROKER_ID,
  DEFAULT_MT5_SERVER: 'Configured-Live',
  API_HOST: SERVER_URL,
  API_HOST_EXT: SERVER_URL,
  WS_HOST: 'wss://service.example.test',
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const runtimeWindow = window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, unknown> };
const windowBag = () => window as unknown as Record<string, unknown>;
const fetchMock = vi.fn();
let healthStatus = 200;

const serveWebTcpBroker = () => fetchMock.mockImplementation(async (url: string) => {
  if (url.endsWith('/broker/servers')) return json([webTcpBroker]);
  if (url.endsWith('/health')) return json({ status: 'ok' }, healthStatus);
  return json({}, 404);
});

const armLink = () => {
  windowBag()[WEB_TERMINAL_SSO_HANDOFF_KEY] = TOKEN;
  captureWebTerminalSsoAtStartup();
};

const waitForHealthCheck = () => waitFor(() => expect(
  fetchMock.mock.calls.some(([url]) => String(url).endsWith('/health')),
).toBe(true));

const settle = () => act(async () => {
  await new Promise(resolve => setTimeout(resolve, 20));
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', fetchMock);
  healthStatus = 200;
  runtime.restoring = false;
  runtimeWindow.__RTX_RUNTIME_CONFIG__ = webTcpRuntimeConfig();
  windowBag().rtx5Electron = { isDesktop: true, platform: 'web-tcp' };
  serveWebTcpBroker();
  runtime.exchange.mockReset().mockResolvedValue({ access_token: 'sso-access-token', account_login: 12345, broker_id: BROKER_ID });
  runtime.login.mockReset();
  runtime.persist.mockReset();
  runtime.loadStore.mockReset().mockResolvedValue({
    useAppStore: { getState: () => ({ setAuthenticated: vi.fn() }) },
  });
});

afterEach(() => {
  delete windowBag()[WEB_TERMINAL_SSO_HANDOFF_KEY];
  takePendingWebTerminalSso();
  delete runtimeWindow.__RTX_RUNTIME_CONFIG__;
  delete windowBag().rtx5Electron;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  applyBrokerChrome({});
  document.title = '';
});

describe('web-tcp SSO link on the login screen', () => {
  it('exchanges the link once, with the broker the terminal selected', async () => {
    armLink();
    const onLogin = vi.fn();

    render(<WelcomeTerminal onLogin={onLogin} />);

    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    expect(runtime.exchange).toHaveBeenCalledOnce();
    expect(runtime.exchange).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ skipDynamicUrl: true }), BROKER_ID);
    expect(runtime.login).not.toHaveBeenCalled();
    expect(hasPendingWebTerminalSso()).toBe(false);
  });

  it('does not spend the link while the broker health check has not passed', async () => {
    healthStatus = 500;
    armLink();

    render(<WelcomeTerminal onLogin={vi.fn()} />);

    await waitForHealthCheck();
    await settle();
    expect(runtime.exchange).not.toHaveBeenCalled();
    expect(hasPendingWebTerminalSso()).toBe(true);
  });

  it('keeps the link pending when a broker guard fails, then exchanges it once the guard passes', async () => {
    // The health check is held open so the broker search text can change after the broker is
    // selected and before the check passes. The guard then sees a search text that does not match.
    let releaseHealth: () => void = () => undefined;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/broker/servers')) return json([webTcpBroker]);
      if (url.endsWith('/health')) {
        await new Promise<void>(resolve => { releaseHealth = resolve; });
        return json({ status: 'ok' }, 200);
      }
      return json({}, 404);
    });
    armLink();

    render(<WelcomeTerminal onLogin={vi.fn()} />);

    await waitForHealthCheck();
    const search = screen.getByRole('combobox');
    fireEvent.change(search, { target: { value: 'Another broker' } });
    await act(async () => { releaseHealth(); });
    await settle();

    expect(runtime.exchange).not.toHaveBeenCalled();
    expect(hasPendingWebTerminalSso()).toBe(true);

    // Each guard pass starts with beginLoginPerformanceMeasurement. The failed pass sets loading and
    // error state, which re-renders the form. That must not start another pass while the search text
    // still mismatches, so the count stays at one after a wait.
    const passesAfterFailure = vi.mocked(beginLoginPerformanceMeasurement).mock.calls.length;
    expect(passesAfterFailure).toBe(1);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
    });
    expect(vi.mocked(beginLoginPerformanceMeasurement).mock.calls.length).toBe(passesAfterFailure);
    expect(runtime.exchange).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: webTcpBroker.broker_name } });

    await waitFor(() => expect(runtime.exchange).toHaveBeenCalledOnce());
    expect(runtime.exchange).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ skipDynamicUrl: true }), BROKER_ID);
    expect(hasPendingWebTerminalSso()).toBe(false);
  });

  it('still signs in from the link while a saved-login restore is in flight', async () => {
    runtime.restoring = true;
    armLink();
    const onLogin = vi.fn();

    render(<WelcomeTerminal onLogin={onLogin} />);

    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    expect(runtime.exchange).toHaveBeenCalledOnce();
    expect(runtime.exchange.mock.calls[0]?.[0]).toBe(TOKEN);
  });

  it('does not start SSO on a real Electron desktop build', async () => {
    windowBag().rtx5Electron = { isDesktop: true, platform: 'win32' };
    armLink();

    render(<WelcomeTerminal onLogin={vi.fn()} />);

    await waitForHealthCheck();
    await settle();
    expect(runtime.exchange).not.toHaveBeenCalled();
    expect(hasPendingWebTerminalSso()).toBe(true);
  });
});
