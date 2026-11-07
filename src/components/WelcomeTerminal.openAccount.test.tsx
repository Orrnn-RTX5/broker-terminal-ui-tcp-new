import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBrokerChrome } from '../services/brokerPresentation';
import { WelcomeTerminal, type BrokerServerItem } from './WelcomeTerminal';

const feature = vi.hoisted(() => ({ preload: vi.fn(async () => undefined), opened: vi.fn() }));
const runtimeWindow = window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, unknown> };

vi.mock('../hooks/useUiTranslation', () => ({ useUiTranslation: () => (text: string) => text }));
vi.mock('../config/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/api')>(),
  BROKER_DISCOVERY_URL: 'https://directory.example.test',
}));
vi.mock('../startup/loginRuntime', () => ({
  preloadLoginTransportRuntime: async () => ({ authV2Api: { login: vi.fn() }, persistBrokerSessionDiscovery: vi.fn() }),
  loadAuthenticatedLoginStoreRuntime: vi.fn(),
}));
vi.mock('../startup/performanceBudget', () => ({
  beginLoginPerformanceMeasurement: vi.fn(), markAuthenticationAccepted: vi.fn(),
  markAuthenticationRequestStarted: vi.fn(), markPostAuthenticationPhase: vi.fn(),
  scheduleAuthenticatedShellPaintMeasurement: vi.fn(), waitForLoginFeedbackPaint: async () => {},
}));
// The real dialog is the File > Open an Account dialog; here we only check that the login screen opens and closes it.
vi.mock('../startup/terminalFeatures', () => ({
  openAccountFeature: {
    preload: feature.preload,
    Component: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
      feature.opened(isOpen);
      return (
        <div role="dialog" aria-label="Open an Account dialog">
          <button type="button" onClick={onClose}>Close dialog</button>
        </div>
      );
    },
  },
}));

const tradex: BrokerServerItem = {
  broker_id: 'tradex', broker_name: 'Tradex', logo_url: '',
  server_url: 'https://tradex.example.test', active: true, enabled: true,
};
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const openAccountButton = () => screen.queryByRole('button', { name: 'Open an Account' });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (
    url.endsWith('/broker/servers') ? json([tradex]) : json({ status: 'ok' })
  )));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete runtimeWindow.__RTX_RUNTIME_CONFIG__;
  applyBrokerChrome({});
  document.title = '';
});

describe('login screen demo / open account entry', () => {
  it('lets a new desktop user open the Open an Account dialog from the login screen', async () => {
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = { BACKEND_TARGET: 'desktop', BROKER_ID: tradex.broker_id, API_HOST: tradex.server_url };
    render(<WelcomeTerminal onLogin={vi.fn()} />);

    const button = await waitFor(() => {
      const found = openAccountButton();
      expect(found).not.toBeNull();
      return found!;
    });
    expect(screen.queryByRole('dialog', { name: 'Open an Account dialog' })).toBeNull();

    fireEvent.pointerEnter(button);
    expect(feature.preload).toHaveBeenCalled();

    fireEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Open an Account dialog' })).toBeTruthy();
    expect(feature.opened).toHaveBeenLastCalledWith(true);
    // Login stays available behind the dialog.
    expect(screen.getByRole('button', { name: 'Login' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Open an Account dialog' })).toBeNull());
  });

  it('stacks the Open an Account dialog above the login overlay', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/WelcomeTerminal.css'), 'utf8');
    const overlayZ = Number(/\.rtx-login-overlay\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1]);
    const dialogZ = Number(/body:has\(\.rtx-login-overlay\)\s+\.rtx-open-account-backdrop\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1]);
    // Without this rule the dialog (z-index 9999) opened hidden behind the login screen.
    expect(overlayZ).toBeGreaterThan(0);
    expect(dialogZ).toBeGreaterThan(overlayZ);
  });

  it('does not add the entry to the web login screen (web guests use the terminal menus)', async () => {
    runtimeWindow.__RTX_RUNTIME_CONFIG__ = { BACKEND_TARGET: 'web', BROKER_ID: tradex.broker_id, API_HOST: tradex.server_url };
    render(<WelcomeTerminal onLogin={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Login' })).toBeTruthy());
    expect(openAccountButton()).toBeNull();
  });
});
