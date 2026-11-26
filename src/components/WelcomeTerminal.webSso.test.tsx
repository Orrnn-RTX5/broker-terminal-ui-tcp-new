import { render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBrokerChrome } from '../services/brokerPresentation';
import {
  WEB_TERMINAL_SSO_HANDOFF_KEY,
  WEB_TERMINAL_SSO_NO_BROKER_MESSAGE,
  captureWebTerminalSsoAtStartup,
  hasPendingWebTerminalSso,
  takePendingWebTerminalSso,
} from '../startup/webTerminalSso';
import { WelcomeTerminal } from './WelcomeTerminal';

// Web-mode login screen with a one-time SSO link. The exchange is mocked, so no request leaves the test.
const runtime = vi.hoisted(() => ({
  login: vi.fn(), exchange: vi.fn(), persist: vi.fn(), loadStore: vi.fn(),
}));
const runtimeWindow = window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, unknown> };
const windowBag = () => window as unknown as Record<string, unknown>;
// 43 characters, the shape the gateway produces.
const TOKEN = 'Xk3_pQ9-vT2bLm8zRw4nYc7hJd1sFg6uAe0iOqN5tKa';
const BROKER_ID = 'test-broker';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

vi.mock('../hooks/useUiTranslation', () => ({ useUiTranslation: () => (text: string) => text }));
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

const webRuntimeConfig = (brokerId?: string): Record<string, unknown> => ({
  BACKEND_TARGET: 'web',
  ...(brokerId ? {
    BROKER_ID: brokerId,
    DEFAULT_MT5_SERVER: 'Configured-Live',
    API_HOST: 'https://service.example.test',
    API_HOST_EXT: 'https://service.example.test',
    WS_HOST: 'wss://service.example.test',
  } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async () => json({ status: 'ok' })));
  runtime.exchange.mockReset();
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  applyBrokerChrome({});
  document.title = '';
});

describe('web SSO link on the login screen', () => {
  it('exchanges the pending token once the configured broker is known', async () => {
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = webRuntimeConfig(BROKER_ID);
    runtime.exchange.mockResolvedValue({ access_token: 'sso-access-token', account_login: 12345, broker_id: BROKER_ID });
    windowBag()[WEB_TERMINAL_SSO_HANDOFF_KEY] = TOKEN;
    captureWebTerminalSsoAtStartup();
    const onLogin = vi.fn();

    render(<WelcomeTerminal onLogin={onLogin} />);

    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    expect(runtime.exchange).toHaveBeenCalledOnce();
    expect(runtime.exchange.mock.calls[0]?.[0]).toBe(TOKEN);
    expect(runtime.login).not.toHaveBeenCalled();
    expect(hasPendingWebTerminalSso()).toBe(false);
  });

  it('keeps the single-use token and shows a message when no broker can be resolved', async () => {
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = webRuntimeConfig();
    windowBag()[WEB_TERMINAL_SSO_HANDOFF_KEY] = TOKEN;
    captureWebTerminalSsoAtStartup();

    render(<WelcomeTerminal onLogin={vi.fn()} />);

    expect(await screen.findByText(WEB_TERMINAL_SSO_NO_BROKER_MESSAGE)).toBeInTheDocument();
    expect(runtime.exchange).not.toHaveBeenCalled();
    expect(hasPendingWebTerminalSso()).toBe(true);
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument();
  });
});
