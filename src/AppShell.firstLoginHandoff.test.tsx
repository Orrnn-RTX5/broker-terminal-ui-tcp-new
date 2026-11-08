// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppShell from './AppShell';

vi.mock('./config/backendTarget.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./config/backendTarget.js')>(),
  // Desktop build: it opens the public workspace like the web terminal (no login boundary in AppShell).
  isElectronRuntime: () => true,
  isDesktopBackendTarget: () => true,
}));

const shellMocks = vi.hoisted(() => {
  let releaseTerminalImport: (() => void) | null = null;
  const terminalImportGate = new Promise<void>((resolve) => {
    releaseTerminalImport = resolve;
  });

  return {
    terminalImportGate,
    releaseTerminalImport: () => releaseTerminalImport?.(),
    terminalModuleImport: vi.fn(),
    preloadDockWorkspaceViewport: vi.fn(async () => undefined),
    preloadTradingChartRuntime: vi.fn(async () => undefined),
    terminalRender: vi.fn(),
  };
});

vi.mock('./App', async () => {
  shellMocks.terminalModuleImport();
  await shellMocks.terminalImportGate;

  return {
    default: ({ initialSessionHandoff }: { initialSessionHandoff?: unknown }) => {
      shellMocks.terminalRender(initialSessionHandoff);
      return <div data-testid="authenticated-terminal" />;
    },
  };
});

vi.mock('./i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('./i18n')>(),
  i18nReady: Promise.resolve(),
}));
vi.mock('./authenticatedStyles', () => ({}));
vi.mock('./startup/tradingChartRuntime', () => ({
  preloadTradingChartRuntime: shellMocks.preloadTradingChartRuntime,
}));
vi.mock('./components/dock/DockWorkspace', () => ({
  preloadDockWorkspaceViewport: shellMocks.preloadDockWorkspaceViewport,
}));

vi.mock('./components/WelcomeTerminal', () => ({
  WelcomeTerminal: ({ onLogin, onPrepareTerminal }: {
    onLogin: (accountId: string, handoff: {
      accountId: string;
      token: string;
      expiresAt: number;
      committedAt: number;
    }) => void;
    onPrepareTerminal?: () => Promise<unknown> | void;
  }) => {
    const [preparing, setPreparing] = React.useState(false);

    const finishLogin = () => {
      setPreparing(true);
      void Promise.resolve(onPrepareTerminal?.()).then(() => {
        onLogin('200002', {
          accountId: '200002',
          token: 'fresh-token',
          expiresAt: Date.now() + 60_000,
          committedAt: Date.now(),
        });
      });
    };

    return (
      <div data-testid="login-screen">
        <button data-testid="login-success" onClick={finishLogin}>Login</button>
        {preparing && <span data-testid="login-preparing">Preparing terminal</span>}
      </div>
    );
  },
}));

describe('AppShell first-login handoff', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('opens the public workspace on desktop in StrictMode without a login screen', async () => {
    // The desktop app no longer has a login boundary in AppShell: like the web terminal it mounts the
    // terminal as a guest (public quotes and charts), and login happens in the trade/login dialog.
    const view = render(
      <React.StrictMode>
        <AppShell />
      </React.StrictMode>,
    );

    expect(view.queryByTestId('login-screen')).toBeNull();
    shellMocks.releaseTerminalImport();

    await waitFor(
      () => expect(view.getByTestId('authenticated-terminal')).toBeTruthy(),
      { timeout: 5_000 },
    );
    await Promise.resolve();

    expect(view.queryByTestId('login-screen')).toBeNull();
    expect(shellMocks.terminalModuleImport).toHaveBeenCalledTimes(1);
    expect(shellMocks.preloadTradingChartRuntime).toHaveBeenCalledTimes(1);
    // App owns DockWorkspace; only its heavy chart runtime is warmed beside
    // the shell and must not trigger a second workspace import.
    expect(shellMocks.preloadDockWorkspaceViewport).not.toHaveBeenCalled();
    expect(shellMocks.terminalRender).toHaveBeenCalled();
    for (const [handoff] of shellMocks.terminalRender.mock.calls) {
      expect(handoff).toBeNull();
    }
  });
});
