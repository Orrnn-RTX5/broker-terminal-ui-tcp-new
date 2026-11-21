import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalBarsStore } from '../../store/useTerminalBarsStore';
import { toPublicAssetPath } from '../welcomeHeroAssets';
import { StatusBar } from './StatusBar';
import { useTerminalBrokerInfo } from '../../hooks/useTerminalTitle';

const originalElectronDescriptor = Object.getOwnPropertyDescriptor(window, 'electron');
const originalAppActiveDescriptor = Object.getOwnPropertyDescriptor(window, '__RTX_APP_ACTIVE__');

vi.mock('../../hooks/useUiTranslation', () => ({
  useUiTranslation: () => (value: string) => value,
}));
vi.mock('../../hooks/useTerminalTitle', () => ({
  WEB_TERMINAL_TITLE: 'Web Terminal',
  getWebTerminalTitle: () => 'Web Terminal',
  isSameTerminalLabel: (a: unknown, b: unknown) => {
    const x = String(a ?? '').trim().toLowerCase();
    const y = String(b ?? '').trim().toLowerCase();
    return Boolean(x) && x === y;
  },
  useTerminalBrokerInfo: vi.fn(() => ({
    accountId: '---',
    brokerName: 'Test Broker',
    marginMode: 'Hedge',
    logoUrl: 'https://broker.example/custom-logo.png',
    logoBaseCandidates: ['https://broker.example'],
  })),
  getLogoUrl: (url: string) => url,
  formatTerminalTitle: () => 'Web Terminal',
}));
vi.mock('../../hooks/useDesktopUpdater', () => ({
  useDesktopUpdater: () => ({ updatePhase: 'idle', updateLabel: '' }),
}));
vi.mock('../../store/useWebSocketStore', () => ({
  useWebSocketStore: (selector: (state: unknown) => unknown) => selector({
    connectionState: 'disconnected',
    isStale: false,
    legacyMetrics: { lastLatency: 0 },
  }),
}));
vi.mock('../../store/useAppStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({
    wsConnected: false,
    tradeApiStatus: { loading: false, error: null },
  }),
}));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../LoginDialog', () => ({
  // The real login dialog is portalled outside the status bar as well.
  LoginDialog: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => (
    isOpen ? createPortal(
      <div role="dialog" aria-label="Login">
        <button onClick={onClose}>Close login</button>
      </div>,
      document.body,
    ) : null
  ),
}));

beforeEach(() => {
  useTerminalBarsStore.setState({ statusBarVisible: true, chartsBarVisible: true });
});

afterEach(() => {
  cleanup();
  useTerminalBarsStore.setState({ statusBarVisible: true, chartsBarVisible: true });
  localStorage.removeItem('rtx-terminal-bars');
  if (originalElectronDescriptor) {
    Object.defineProperty(window, 'electron', originalElectronDescriptor);
  } else {
    Reflect.deleteProperty(window, 'electron');
  }
  if (originalAppActiveDescriptor) {
    Object.defineProperty(window, '__RTX_APP_ACTIVE__', originalAppActiveDescriptor);
  } else {
    Reflect.deleteProperty(window, '__RTX_APP_ACTIVE__');
  }
});

describe.each(['web', 'packaged desktop'] as const)('StatusBar in %s', (runtime) => {
  beforeEach(() => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      writable: true,
      value: runtime === 'packaged desktop' ? {
        appVersion: '1.0.25',
        isPackaged: true,
        updater: { isSupported: false },
      } : undefined,
    });
  });

  it('passes its shown symbol to the broker info hook (account-mode read)', () => {
    render(<StatusBar wsRef={{ current: null }} symbol="WIRESYM" timeframe="m15" />);
    expect(vi.mocked(useTerminalBrokerInfo)).toHaveBeenCalledWith('WIRESYM');
  });

  it('offers the RTX5 version badge a slot and has no desktop download shortcut', () => {
    const { container } = render(<StatusBar wsRef={{ current: null }} />);
    const download = screen.queryByRole('button', { name: 'Desktop App' });
    expect(download).toBeNull();
    // The version is shown only by Rtx5VersionBadge, which docks into this slot.
    const slot = container.querySelector('[data-rtx5-version-slot]');
    expect(slot).not.toBeNull();
    expect(slot?.textContent).toBe('');
    expect(screen.queryByText(runtime === 'web' ? 'v1.0.0' : 'v1.0.25')).toBeNull();
  });

  it('renders the broker logo in the bottom-left status bar and falls back when unavailable', () => {
    localStorage.setItem('broker_id', 'custom-broker');
    const { container } = render(<StatusBar wsRef={{ current: null }} />);
    const logo = container.querySelector('.rtx-status-bar__identity .rtx-status-bar__logo');
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute('src', 'https://broker.example/custom-logo.png');

    vi.mocked(useTerminalBrokerInfo).mockReturnValueOnce({
      accountId: '---',
      accountName: '',
      serverName: 'Test Broker',
      brokerName: 'Test Broker',
      marginMode: 'Hedge',
      logoUrl: '',
      logoBaseCandidates: [],
    });
    localStorage.removeItem('broker_id');
    const fallbackRender = render(<StatusBar wsRef={{ current: null }} />);
    const fallbackLogo = fallbackRender.container.querySelector('.rtx-status-bar__identity .rtx-status-bar__logo');
    expect(fallbackLogo).toHaveAttribute('src', toPublicAssetPath('favicon.png'));
  });

  it('shows Demo in green, Real in yellow, and Contest in blue matching account colors without background and separated by a hyphen', () => {
    const brokerInfoMock = vi.mocked(useTerminalBrokerInfo);
    const defaultImpl = brokerInfoMock.getMockImplementation();
    const statusBarCss = readFileSync(resolve(process.cwd(), 'src/components/layout/StatusBar.css'), 'utf8');
    try {
      brokerInfoMock.mockReturnValue({
        accountId: '500123',
        accountName: 'Trader',
        accountType: 'demo',
        accountTypeLabel: 'Demo',
        serverName: 'Broker-Demo',
        brokerName: 'Test Broker',
        marginMode: 'Hedge',
        logoUrl: 'https://broker.example/custom-logo.png',
        logoBaseCandidates: ['https://broker.example'],
      });
      const demoView = render(<StatusBar wsRef={{ current: null }} />);
      const demoBadge = demoView.container.querySelector('.rtx-status-bar__identity .rtx-status-bar__account-type');
      const demoSep = demoView.container.querySelector('.rtx-status-bar__identity .rtx-status-bar__account-type-sep');
      expect(demoSep).toHaveTextContent('-');
      expect(demoBadge).toHaveTextContent('Demo');
      expect(demoBadge).toHaveAttribute('data-account-type', 'demo');
      demoView.unmount();

      brokerInfoMock.mockReturnValue({
        accountId: '900456',
        accountName: 'Trader',
        accountType: 'real',
        accountTypeLabel: 'Real',
        serverName: 'Broker-Live',
        brokerName: 'Test Broker',
        marginMode: 'Hedge',
        logoUrl: 'https://broker.example/custom-logo.png',
        logoBaseCandidates: ['https://broker.example'],
      });
      const realView = render(<StatusBar wsRef={{ current: null }} />);
      const realBadge = realView.container.querySelector('.rtx-status-bar__identity .rtx-status-bar__account-type');
      const realSep = realView.container.querySelector('.rtx-status-bar__identity .rtx-status-bar__account-type-sep');
      expect(realSep).toHaveTextContent('-');
      expect(realBadge).toHaveTextContent('Real');
      expect(realBadge).toHaveAttribute('data-account-type', 'real');
      realView.unmount();

      brokerInfoMock.mockReturnValue({
        accountId: '700789',
        accountName: 'Trader',
        accountType: 'contest',
        accountTypeLabel: 'Contest',
        serverName: 'Broker-Contest',
        brokerName: 'Test Broker',
        marginMode: 'Hedge',
        logoUrl: 'https://broker.example/custom-logo.png',
        logoBaseCandidates: ['https://broker.example'],
      });
      const contestView = render(<StatusBar wsRef={{ current: null }} />);
      const contestBadge = contestView.container.querySelector('.rtx-status-bar__identity .rtx-status-bar__account-type');
      const contestSep = contestView.container.querySelector('.rtx-status-bar__identity .rtx-status-bar__account-type-sep');
      expect(contestSep).toHaveTextContent('-');
      expect(contestBadge).toHaveTextContent('Contest');
      expect(contestBadge).toHaveAttribute('data-account-type', 'contest');

      // Account labels use transparent text matching the Navigator account colors in dark and light themes.
      expect(statusBarCss).toMatch(/html:root \.rtx-status-bar \.rtx-status-bar__account-type\[data-account-type='demo'\]\s*\{[^}]*border:\s*none;[^}]*background-color:\s*transparent;[^}]*color:\s*#4ade80;/);
      expect(statusBarCss).toMatch(/html:root \.rtx-status-bar \.rtx-status-bar__account-type\[data-account-type='real'\]\s*\{[^}]*border:\s*none;[^}]*background-color:\s*transparent;[^}]*color:\s*#facc15;/);
      expect(statusBarCss).toMatch(/html:root \.rtx-status-bar \.rtx-status-bar__account-type\[data-account-type='contest'\]\s*\{[^}]*border:\s*none;[^}]*background-color:\s*transparent;[^}]*color:\s*#60a5fa;/);
      expect(statusBarCss).toMatch(/html:root\.rtx-skin-untitled-light \.rtx-status-bar \.rtx-status-bar__account-type\[data-account-type='demo'\]\s*\{[^}]*border:\s*none;[^}]*background-color:\s*transparent;[^}]*color:\s*#15803d;/);
      expect(statusBarCss).toMatch(/html:root\.rtx-skin-untitled-light \.rtx-status-bar \.rtx-status-bar__account-type\[data-account-type='real'\]\s*\{[^}]*border:\s*none;[^}]*background-color:\s*transparent;[^}]*color:\s*#a16207;/);
      expect(statusBarCss).toMatch(/html:root\.rtx-skin-untitled-light \.rtx-status-bar \.rtx-status-bar__account-type\[data-account-type='contest'\]\s*\{[^}]*border:\s*none;[^}]*background-color:\s*transparent;[^}]*color:\s*#2563eb;/);
    } finally {
      if (defaultImpl) brokerInfoMock.mockImplementation(defaultImpl);
    }
  });

  it('hides and restores the bar while preserving the mounted connection control', () => {
    const { container } = render(<StatusBar wsRef={{ current: null }} />);
    const statusBar = container.querySelector('.rtx-status-bar');
    const connectionButton = screen.getByRole('button', { name: 'Disconnected' });
    expect(statusBar).toBeVisible();

    fireEvent.click(connectionButton);
    const networkRescan = screen.getByRole('button', { name: 'Network Rescan' });

    act(() => useTerminalBarsStore.getState().toggleStatusBar());
    expect(statusBar).not.toBeVisible();
    expect(connectionButton).toBeInTheDocument();
    expect(networkRescan).toBeInTheDocument();
    expect(networkRescan).not.toBeVisible();

    act(() => useTerminalBarsStore.getState().toggleStatusBar());
    expect(statusBar).toBeVisible();
    expect(screen.getByRole('button', { name: 'Disconnected' })).toBe(connectionButton);
    expect(screen.getByRole('button', { name: 'Network Rescan' })).toBe(networkRescan);
    expect(useTerminalBarsStore.getState().chartsBarVisible).toBe(true);
  });

  it('opens the external login dialog while the status bar is hidden', async () => {
    const { container } = render(<StatusBar wsRef={{ current: null }} />);
    act(() => useTerminalBarsStore.getState().toggleStatusBar());
    expect(container.querySelector('.rtx-status-bar')).not.toBeVisible();

    await act(async () => { window.dispatchEvent(new CustomEvent('rtx:openLoginDialog')); });
    const dialog = await screen.findByRole('dialog', { name: 'Login' }, { timeout: 5000 });
    expect(dialog).toBeVisible();
    expect(container).not.toContainElement(dialog);
    expect(useTerminalBarsStore.getState().statusBarVisible).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Close login' }));
    expect(screen.queryByRole('dialog', { name: 'Login' })).toBeNull();
  });

  it('leaves external login to the active App without opening a duplicate dialog', async () => {
    Object.defineProperty(window, '__RTX_APP_ACTIVE__', {
      configurable: true,
      writable: true,
      value: true,
    });
    const appLoginHandler = vi.fn();
    window.addEventListener('rtx:openLoginDialog', appLoginHandler);
    try {
      const { container } = render(<StatusBar wsRef={{ current: null }} />);
      act(() => useTerminalBarsStore.getState().toggleStatusBar());

      await act(async () => { window.dispatchEvent(new CustomEvent('rtx:openLoginDialog')); });

      expect(appLoginHandler).toHaveBeenCalledOnce();
      expect(screen.queryByRole('dialog', { name: 'Login' })).toBeNull();
      expect(container.querySelector('.rtx-status-bar')).not.toBeVisible();
    } finally {
      window.removeEventListener('rtx:openLoginDialog', appLoginHandler);
    }
  });
});
