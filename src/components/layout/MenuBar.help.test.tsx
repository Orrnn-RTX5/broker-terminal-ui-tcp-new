// @vitest-environment jsdom

// T14: every Help/Check-For-Updates/About leaf either performs its action or
// is disabled-with-reason (no dead clicks, no hardcoded links).
import '@testing-library/jest-dom';
import { useDrawingSidebarStore } from '../../store/useDrawingSidebarStore';
import { useTerminalBarsStore } from '../../store/useTerminalBarsStore';
import { useTerminalResolutionStore } from '../../store/useTerminalResolutionStore';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DockLayout } from '../../services/dockManager';
import { getAppVersion } from '../../config/appVersion';

// Repeated jsdom accessibility queries run more slowly on Windows.
const menuInteractionTimeoutMs = process.platform === 'win32' ? 30000 : 10000;

vi.mock('react-i18next', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-i18next')>(),
    useTranslation: () => ({
        t: (key: string) => key,
        i18n: { language: 'en', changeLanguage: vi.fn() },
    }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
    useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('../../store/useAppStore', () => {
    const state = {
        isAuthenticated: false,
        selectedSymbol: 'XAUUSD',
        savedAccounts: [{ login: 200002, name: 'Arijit Nayak', server: 'MetaQuotes-Demo', isLive: false }],
    };
    const useAppStore = (selector: (value: typeof state) => unknown) => selector(state);
    useAppStore.getState = () => state;
    return { useAppStore };
});

const openWebTraderMock = vi.hoisted(() => vi.fn().mockResolvedValue({
    status: 'opened',
    brokerId: 'test',
    brokerName: 'Test Broker',
    url: 'https://terminal.example.com',
    openedWith: 'browser',
}));
const closeActiveChartMock = vi.hoisted(() => vi.fn(() => true));
const arrangeChartsMock = vi.hoisted(() => vi.fn());
const tileWindowsMock = vi.hoisted(() => vi.fn());
const dockStoreFixture = vi.hoisted(() => ({
    layout: {
        version: 'menu-help-test',
        root: { id: 'root', type: 'split', ratio: 1, children: [
            { id: 'chart-a', title: 'XAUUSD,M1', component: 'Chart', props: { symbol: 'XAUUSD', timeframe: 'M1' } },
        ] },
        floatingPanels: [],
    } as DockLayout,
    arrangeIcons: vi.fn(() => 1),
    resetWindows: vi.fn(),
    resetToDefaultLayout: vi.fn(),
}));

vi.mock('../../services/webTrader', () => ({
    openWebTrader: openWebTraderMock,
}));

vi.mock('../../store/useDockLayoutStore', () => {
    const getState = () => ({ ...dockStoreFixture, closeActiveChart: closeActiveChartMock, arrangeCharts: arrangeChartsMock, tileWindows: tileWindowsMock });
    const useDockLayoutStore = (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState());
    useDockLayoutStore.getState = getState;
    return { useDockLayoutStore };
});

vi.mock('./FileMenu', () => ({
    FileMenu: ({ shortcutsOnly }: { shortcutsOnly?: boolean }) => (
        shortcutsOnly ? null : <div data-testid="file-menu" />
    ),
}));

vi.mock('../settings/OptionsDialog', () => ({
    OptionsDialog: ({ isOpen }: { isOpen: boolean }) => (
        isOpen ? <div role="dialog" aria-label="Options" /> : null
    ),
}));

vi.mock('../SymbolsDialog', () => ({
    SymbolsDialog: ({ isOpen }: { isOpen: boolean }) => (
        isOpen ? <div role="dialog" aria-label="Symbols dialog" /> : null
    ),
}));

vi.mock('../LoginDialog', () => ({
    LoginDialog: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => (
        isOpen ? (
            <div role="dialog" aria-label="Trade account login">
                <button type="button" onClick={onClose}>Close login</button>
            </div>
        ) : null
    ),
}));

import { MenuBar } from './MenuBar';

type ElectronWindowApi = NonNullable<Window['electron']>['window'];

const installElectronBridge = () => {
    const windowApi: ElectronWindowApi = {
        minimize: vi.fn(),
        maximize: vi.fn(),
        close: vi.fn(),
        isMaximized: vi.fn().mockResolvedValue(false),
        setTitle: vi.fn(),
        onMaximizeChange: vi.fn(() => vi.fn()),
    };

    Object.defineProperty(window, 'electron', {
        configurable: true,
        writable: true,
        value: { window: windowApi, appVersion: '7.7.7-t14' },
    });
};

type UpdateHostWindow = Window & {
    rtx5CheckOTAUpdate?: () => Promise<unknown>;
    rtx5SetOTAChannel?: (channel: string) => Promise<unknown>;
};

// The terminal's host injects these (rtx5-tcp-toolbar.js). Every host can
// check for updates; the desktop app can also switch release channels.
const installUpdateHost = (host: {
    check: () => Promise<unknown>;
    switchChannel?: (channel: string) => Promise<unknown>;
}) => {
    const hostWindow = window as UpdateHostWindow;
    hostWindow.rtx5CheckOTAUpdate = host.check;
    if (host.switchChannel) hostWindow.rtx5SetOTAChannel = host.switchChannel;
};

const feedbackMessages = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map(([event]) => {
    const { message, type } = (event as CustomEvent<{ message: string; type: string }>).detail;
    return { message, type };
});

afterEach(() => {
    cleanup();
    dockStoreFixture.layout.floatingPanels = [];
    useDrawingSidebarStore.setState({ visible: true });
    useTerminalBarsStore.setState({ statusBarVisible: true, chartsBarVisible: true, timeframesVisible: true });
    useTerminalResolutionStore.getState().setResolution('1920x1080');
    delete (window as { electron?: unknown }).electron;
    delete (window as UpdateHostWindow).rtx5CheckOTAUpdate;
    delete (window as UpdateHostWindow).rtx5SetOTAChannel;
    vi.restoreAllMocks();
});

const UPDATES_REASON = 'Updates are available in the installed desktop app';

describe('MenuBar Help updates and About (T14)', () => {
    it('keeps Latest Release Version locked with a reason when the host has no update bridge, and never fires a dead click (desktop Help)', () => {
        installElectronBridge();
        render(<MenuBar />);
        fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'menu.help.checkForUpdates' }));

        const updatesMenu = screen.getByRole('menu', { name: 'menu.help.checkForUpdates menu' });
        const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
        // Latest Release Version is the only update entry: there is no beta entry.
        expect(within(updatesMenu).getAllByRole('menuitem')).toHaveLength(1);
        const item = within(updatesMenu).getByRole('menuitem', { name: 'Latest Release Version' });
        expect(item).toBeDisabled();
        expect(item).toHaveAttribute('aria-disabled', 'true');
        expect(item.getAttribute('aria-description')).toBe(UPDATES_REASON);
        expect(item).toHaveAttribute('title', UPDATES_REASON);
        expect(item.querySelector('.rtx-menu-row__lock')).toBeInTheDocument();
        fireEvent.click(item);
        fireEvent.keyDown(item, { key: 'Enter' });
        expect(dispatchSpy.mock.calls.filter(([event]) => event.type === 'rtx:order-feedback')).toHaveLength(0);
        // The Help menu stays open: nothing happened, nothing closed.
        expect(screen.getByRole('menu', { name: 'Help menu' })).toBeInTheDocument();
    }, menuInteractionTimeoutMs);

    it('unlocks Latest Release Version on a host that can check for updates and reports its answer (web launcher)', async () => {
        const check = vi.fn().mockResolvedValue({
            ok: true,
            ota: { channel: 'production', version: '1.2.18', up_to_date: true },
        });
        installUpdateHost({ check });
        render(<MenuBar />);
        const feedbackSpy = vi.fn();
        window.addEventListener('rtx:order-feedback', feedbackSpy);
        try {
            fireEvent.click(screen.getByRole('button', { name: 'Open application menu' }));
            fireEvent.click(screen.getByRole('menuitem', { name: 'About program' }));
            const aboutMenu = screen.getByRole('menu', { name: 'About program menu' });
            fireEvent.click(within(aboutMenu).getByRole('menuitem', { name: 'menu.help.checkForUpdates' }));
            const updatesMenu = screen.getByRole('menu', { name: 'menu.help.checkForUpdates menu' });

            expect(within(updatesMenu).queryByRole('menuitem', { name: 'Latest Beta Version' })).not.toBeInTheDocument();
            expect(within(updatesMenu).getAllByRole('menuitem')).toHaveLength(1);

            const release = within(updatesMenu).getByRole('menuitem', { name: 'Latest Release Version' });
            expect(release).toBeEnabled();
            expect(release).not.toHaveAttribute('aria-description');
            expect(release.querySelector('.rtx-menu-row__lock')).not.toBeInTheDocument();
            fireEvent.click(release);

            expect(check).toHaveBeenCalledTimes(1);
            expect(screen.queryByRole('menu', { name: 'Application menu' })).not.toBeInTheDocument();
            await waitFor(() => expect(feedbackSpy).toHaveBeenCalledTimes(2));
            expect(feedbackMessages(feedbackSpy)).toEqual([
                { message: 'Latest Release Version: Checking...', type: 'success' },
                { message: 'Latest Release Version: v1.2.18 · Up to date', type: 'success' },
            ]);
        } finally {
            window.removeEventListener('rtx:order-feedback', feedbackSpy);
        }
    }, menuInteractionTimeoutMs);

    it('returns to the release channel from Latest Release Version on a switch-capable host, with no beta entry (desktop Help)', async () => {
        installElectronBridge();
        const hostCalls: string[] = [];
        installUpdateHost({
            switchChannel: async (channel) => {
                hostCalls.push(`switch:${channel}`);
                return { ok: true, channel, ota: { channel } };
            },
            check: async () => {
                hostCalls.push('check');
                return { ok: true, ota: { channel: 'production', version: '1.2.19', up_to_date: true, ui_reload_ready: true } };
            },
        });
        render(<MenuBar />);
        const feedbackSpy = vi.fn();
        window.addEventListener('rtx:order-feedback', feedbackSpy);
        try {
            fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }));
            fireEvent.click(screen.getByRole('menuitem', { name: 'menu.help.checkForUpdates' }));
            const updatesMenu = screen.getByRole('menu', { name: 'menu.help.checkForUpdates menu' });
            // A host that could move to beta still gets no beta entry.
            expect(within(updatesMenu).queryByRole('menuitem', { name: 'Latest Beta Version' })).not.toBeInTheDocument();
            expect(within(updatesMenu).getAllByRole('menuitem')).toHaveLength(1);

            const release = within(updatesMenu).getByRole('menuitem', { name: 'Latest Release Version' });
            expect(release).toBeEnabled();
            expect(release.querySelector('.rtx-menu-row__lock')).not.toBeInTheDocument();
            fireEvent.click(release);

            expect(screen.queryByRole('menu', { name: 'Help menu' })).not.toBeInTheDocument();
            await waitFor(() => expect(feedbackSpy).toHaveBeenCalledTimes(2));
            expect(hostCalls).toEqual(['switch:production', 'check']);
            expect(feedbackMessages(feedbackSpy)).toEqual([
                { message: 'Latest Release Version: Checking...', type: 'success' },
                { message: 'Latest Release Version: v1.2.19 · Update ready', type: 'success' },
            ]);
        } finally {
            window.removeEventListener('rtx:order-feedback', feedbackSpy);
        }
    }, menuInteractionTimeoutMs);

    it('reports a newer release the host has not applied as available (web launcher)', async () => {
        installUpdateHost({
            check: async () => ({ ok: true, ota: { channel: 'production', version: '1.2.19', up_to_date: false } }),
        });
        render(<MenuBar />);
        const feedbackSpy = vi.fn();
        window.addEventListener('rtx:order-feedback', feedbackSpy);
        try {
            fireEvent.click(screen.getByRole('button', { name: 'Open application menu' }));
            fireEvent.click(screen.getByRole('menuitem', { name: 'About program' }));
            fireEvent.click(within(screen.getByRole('menu', { name: 'About program menu' }))
                .getByRole('menuitem', { name: 'menu.help.checkForUpdates' }));
            fireEvent.click(within(screen.getByRole('menu', { name: 'menu.help.checkForUpdates menu' }))
                .getByRole('menuitem', { name: 'Latest Release Version' }));

            await waitFor(() => expect(feedbackSpy).toHaveBeenCalledTimes(2));
            expect(feedbackMessages(feedbackSpy)[1]).toEqual({
                message: 'Latest Release Version: v1.2.19 · Update available',
                type: 'success',
            });
        } finally {
            window.removeEventListener('rtx:order-feedback', feedbackSpy);
        }
    }, menuInteractionTimeoutMs);

    it('reports a failed update check as an error instead of a silent click (web launcher)', async () => {
        installUpdateHost({ check: vi.fn().mockResolvedValue({ ok: false, error: 'offline' }) });
        render(<MenuBar />);
        const feedbackSpy = vi.fn();
        window.addEventListener('rtx:order-feedback', feedbackSpy);
        try {
            fireEvent.click(screen.getByRole('button', { name: 'Open application menu' }));
            fireEvent.click(screen.getByRole('menuitem', { name: 'About program' }));
            fireEvent.click(within(screen.getByRole('menu', { name: 'About program menu' }))
                .getByRole('menuitem', { name: 'menu.help.checkForUpdates' }));
            fireEvent.click(within(screen.getByRole('menu', { name: 'menu.help.checkForUpdates menu' }))
                .getByRole('menuitem', { name: 'Latest Release Version' }));

            await waitFor(() => expect(feedbackSpy).toHaveBeenCalledTimes(2));
            expect(feedbackMessages(feedbackSpy)).toEqual([
                { message: 'Latest Release Version: Checking...', type: 'success' },
                { message: 'Latest Release Version: Update failed', type: 'error' },
            ]);
        } finally {
            window.removeEventListener('rtx:order-feedback', feedbackSpy);
        }
    }, menuInteractionTimeoutMs);

    it('About publishes the build version through the existing feedback toast surface (desktop Help)', () => {
        installElectronBridge();
        render(<MenuBar />);
        const feedbackSpy = vi.fn();
        window.addEventListener('rtx:order-feedback', feedbackSpy);
        try {
            fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }));
            const about = within(screen.getByRole('menu', { name: 'Help menu' }))
                .getByRole('menuitem', { name: 'menu.help.about' });
            expect(about).toBeEnabled();
            fireEvent.click(about);
            expect(feedbackSpy).toHaveBeenCalledTimes(1);
            expect(feedbackSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'rtx:order-feedback',
                    detail: expect.objectContaining({
                        message: `Version ${getAppVersion()}`,
                        type: 'success',
                    }),
                }),
            );
            expect(getAppVersion()).toBe('7.7.7-t14');
            expect(screen.queryByRole('menu', { name: 'Help menu' })).not.toBeInTheDocument();
        } finally {
            window.removeEventListener('rtx:order-feedback', feedbackSpy);
        }
    }, menuInteractionTimeoutMs);

    it('About program submenu carries the same wired About and, without a host update bridge, the locked update entry (web launcher)', () => {
        render(<MenuBar />);
        const feedbackSpy = vi.fn();
        window.addEventListener('rtx:order-feedback', feedbackSpy);
        try {
            fireEvent.click(screen.getByRole('button', { name: 'Open application menu' }));
            fireEvent.click(screen.getByRole('menuitem', { name: 'About program' }));
            const aboutMenu = screen.getByRole('menu', { name: 'About program menu' });

            fireEvent.click(within(aboutMenu).getByRole('menuitem', { name: 'menu.help.checkForUpdates' }));
            const updatesMenu = screen.getByRole('menu', { name: 'menu.help.checkForUpdates menu' });
            expect(within(updatesMenu).queryByRole('menuitem', { name: 'Latest Beta Version' })).not.toBeInTheDocument();
            const release = within(updatesMenu).getByRole('menuitem', { name: 'Latest Release Version' });
            expect(release).toBeDisabled();
            expect(release.getAttribute('aria-description')).toBe(UPDATES_REASON);
            fireEvent.click(release);

            const about = within(aboutMenu).getByRole('menuitem', { name: 'menu.help.about' });
            expect(about).toBeEnabled();
            fireEvent.click(about);
            expect(feedbackSpy).toHaveBeenCalledTimes(1);
            expect(feedbackSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'rtx:order-feedback',
                    detail: expect.objectContaining({
                        message: `Version ${getAppVersion()}`,
                        type: 'success',
                    }),
                }),
            );
            expect(screen.queryByRole('menu', { name: 'Application menu' })).not.toBeInTheDocument();
        } finally {
            window.removeEventListener('rtx:order-feedback', feedbackSpy);
        }
    }, menuInteractionTimeoutMs);
});
