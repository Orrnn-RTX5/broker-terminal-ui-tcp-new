// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomDock } from './BottomDock';
import { DockPanel } from './dock/DockPanel';
import { SESSION_VIEW_KEYS } from '../services/sessionViewState';
import { useBulkCloseConfirmStore } from '../store/useBulkCloseConfirmStore';

const toolboxMocks = vi.hoisted(() => ({
    refresh: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../hooks/useToolboxTradeData', () => ({
    useToolboxTradeData: () => ({
        account: null,
        positions: [],
        pendingPositions: [],
        loading: false,
        error: null,
        login: null,
        restBaseUrl: '',
        wsUrl: '',
        wsState: 'connected',
        lastRestAt: null,
        lastWsAt: null,
        debug: [],
        refresh: toolboxMocks.refresh,
        removePosition: vi.fn(),
        removePositionsByMode: vi.fn(),
    }),
}));

// This suite verifies the real dock shell and its controls. Individual tab
// bodies have their own integration tests and should not start downloads,
// account-history subscriptions, or Journal filters when switching sections.
vi.mock('../features/bottom-dock/trade/TradeTab', () => ({ TradeTab: () => null }));
vi.mock('../features/bottom-dock/history/HistoryTab', () => ({ HistoryTab: () => null }));
vi.mock('../features/bottom-dock/exposure/ExposureTab', () => ({ ExposureTab: () => null }));
vi.mock('../features/bottom-dock/toolbox/ToolboxTab', () => ({ ToolboxTab: () => null }));
vi.mock('./HistoryDownloader', () => ({ HistoryDownloader: () => null }));
vi.mock('./layout/JournalTab', () => ({ JournalTab: () => null }));
vi.mock('./layout/NewsTab', () => ({ NewsTab: () => <div data-testid="mock-news-tab" /> }));
vi.mock('./layout/CompanyTab', () => ({ CompanyTab: () => <div data-testid="mock-company-tab" /> }));

const TAB_LABELS = [
    'Trade',
    'History',
    'Exposure',
    'Toolbox',
    'News',
    'Mailbox',
    'Calendar',
    'Company',
    'Alerts',
    'Journal',
];

describe('Toolbox header close control', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        toolboxMocks.refresh.mockClear();
    });

    afterEach(() => {
        cleanup();
        localStorage.clear();
        vi.clearAllMocks();
    });

    it('closes the whole Toolbox from every available section without invoking trade actions', async () => {
        const onClose = vi.fn();
        const onCloseBulk = vi.fn();
        const onClosePosition = vi.fn();
        const onModifyPosition = vi.fn();
        const onCancelOrder = vi.fn();

        const { container } = render(
            <DockPanel
                panel={{
                    id: 'toolbox',
                    title: 'Toolbox',
                    component: 'Terminal',
                    closable: true,
                    ratio: 0.25,
                }}
                showHeader={false}
                onClose={onClose}
            >
                <BottomDock
                    height={300}
                    onClose={onClose}
                    onClosePosition={onClosePosition}
                    onModifyPosition={onModifyPosition}
                    onCancelOrder={onCancelOrder}
                    onCloseBulk={onCloseBulk}
                />
            </DockPanel>,
        );

        expect(screen.getByRole('button', { name: 'Close In-Profit' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Close In-Loss' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Close All' })).toBeInTheDocument();

        const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
        const tabStrip = within(container.querySelector<HTMLElement>('.rtx-bottom-dock__tabs')!);
        let sectionsClosed = 0;
        for (const tabLabel of TAB_LABELS) {
            const tab = tabStrip.getByText(tabLabel, { selector: '.rtx-dock-tab' });
            if ((tab as HTMLButtonElement).disabled) continue;
            await act(async () => { fireEvent.click(tab); });

            const closeButton = screen.getByRole('button', { name: 'Close Toolbox' });
            expect(closeButton.closest('.rtx-bottom-dock__header')).not.toBeNull();
            expect(tabStrip.queryByRole('button', { name: 'Close Toolbox' })).toBeNull();
            expect(tabStrip.queryByRole('button', { name: 'Minimize Toolbox' })).toBeNull();
            expect(tabStrip.queryByRole('button', { name: 'Restore Toolbox' })).toBeNull();
            expect(container.querySelectorAll('.dock-panel__header')).toHaveLength(1);

            fireEvent.click(closeButton);
            sectionsClosed += 1;
            expect(onClose).toHaveBeenCalledTimes(sectionsClosed);
        }

        expect(sectionsClosed).toBe(6);
        expect(openSpy).not.toHaveBeenCalled();
        expect(onCloseBulk).not.toHaveBeenCalled();
        expect(onClosePosition).not.toHaveBeenCalled();
        expect(onModifyPosition).not.toHaveBeenCalled();
        expect(onCancelOrder).not.toHaveBeenCalled();
    });

    it('removes Historical Data, Articles, Code Base, and Experts, opens Company in-app like News, and keeps Exposure/Mailbox/Calendar/Alerts locked', async () => {
        const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
        const { container } = render(
            <BottomDock
                height={300}
                onClosePosition={vi.fn()}
                onModifyPosition={vi.fn()}
            />,
        );

        for (const removed of ['Historical Data', 'Articles', 'Code Base', 'Experts']) {
            expect(screen.queryByRole('button', { name: new RegExp(`^${removed}`) })).not.toBeInTheDocument();
        }

        const lockedTabs = [
            'Exposure',
            'Mailbox',
            'Calendar',
            'Alerts',
        ];

        for (const label of lockedTabs) {
            const tab = screen.getByRole('button', { name: label });
            expect(tab).toBeDisabled();
            expect(tab).toHaveClass('rtx-dock-tab--locked');
            expect(tab.querySelector('[aria-hidden="true"]')).toBeTruthy();
            expect(tab.getAttribute('aria-description')).toContain('currently unavailable');
            fireEvent.click(tab);
        }

        const contentArea = container.querySelector<HTMLElement>('.rtx-bottom-dock__content')!;
        expect(screen.getByRole('button', { name: /^News/ })).toBeEnabled();
        expect(within(contentArea).queryByTestId('mock-company-tab')).toBeNull();

        const companyTab = screen.getByRole('button', { name: 'Company — Broker company information' });
        expect(companyTab).toBeEnabled();
        await act(async () => { fireEvent.click(companyTab); });

        expect(openSpy).not.toHaveBeenCalled();
        expect(companyTab).toHaveClass('active-tab');
        const companyContent = await within(contentArea).findByTestId('mock-company-tab');
        expect(companyContent.parentElement).not.toHaveAttribute('hidden');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'News — Market news messages' }));
        });
        expect(screen.getByRole('button', { name: 'News — Market news messages' })).toHaveClass('active-tab');
        expect(companyContent.parentElement).toHaveAttribute('hidden');
        const newsContent = await within(contentArea).findByTestId('mock-news-tab');
        expect(newsContent.parentElement).not.toHaveAttribute('hidden');
        expect(newsContent.parentElement?.parentElement).toBe(companyContent.parentElement?.parentElement);

        fireEvent.click(screen.getByRole('button', { name: 'Journal — Terminal logs and connection events' }));
        expect(screen.getByRole('button', { name: 'Journal — Terminal logs and connection events' })).toHaveClass('active-tab');

        window.dispatchEvent(new CustomEvent('rtx:open-bottom-dock-tab', { detail: { tab: 'Calendar' } }));
        expect(screen.getByRole('button', { name: 'Journal — Terminal logs and connection events' })).toHaveClass('active-tab');
        expect(screen.getByRole('button', { name: 'Calendar' })).toBeDisabled();
    });

    it('marks the active bulk-close tab with active-tab while its confirmation sheet is open and restores Trade on close', () => {
        render(
            <BottomDock
                onClosePosition={vi.fn()}
                onModifyPosition={vi.fn()}
                onCloseBulk={vi.fn()}
            />,
        );

        const tradeTab = screen.getByRole('button', { name: 'Trade — Open positions and live account summary' });
        const winnersBtn = screen.getByRole('button', { name: 'Close In-Profit' });
        const losersBtn = screen.getByRole('button', { name: 'Close In-Loss' });
        const allBtn = screen.getByRole('button', { name: 'Close All' });

        expect(tradeTab).toHaveClass('active-tab');
        expect(winnersBtn).not.toHaveClass('active-tab');

        act(() => {
            void useBulkCloseConfirmStore.getState().showBulkCloseConfirm({
                type: 'WINNERS',
                positions: [],
                combinedPnL: 10,
            });
        });
        expect(winnersBtn).toHaveClass('active-tab');
        expect(tradeTab).not.toHaveClass('active-tab');

        act(() => {
            void useBulkCloseConfirmStore.getState().showBulkCloseConfirm({
                type: 'LOSERS',
                positions: [],
                combinedPnL: -5,
            });
        });
        expect(losersBtn).toHaveClass('active-tab');
        expect(winnersBtn).not.toHaveClass('active-tab');

        act(() => {
            void useBulkCloseConfirmStore.getState().showBulkCloseConfirm({
                type: 'ALL',
                positions: [],
                combinedPnL: 5,
            });
        });
        expect(allBtn).toHaveClass('active-tab');
        expect(losersBtn).not.toHaveClass('active-tab');

        act(() => {
            useBulkCloseConfirmStore.getState().closeBulkCloseConfirm();
        });
        expect(allBtn).not.toHaveClass('active-tab');
        expect(tradeTab).toHaveClass('active-tab');
    });

    it('embeds Company in-app (iframe pane, no new window) in both the web terminal and the desktop .exe runtime', async () => {
        const w = window as unknown as {
            rtx5Electron?: { isDesktop?: boolean; platform?: string };
            electronAPI?: { isDesktop?: boolean; platform?: string };
        };
        const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

        try {
            // 1. Web terminal (web-tcp on https://webterminal.orrnn.com): opens Company in-app, no redirect.
            w.rtx5Electron = { isDesktop: true, platform: 'web-tcp' };
            w.electronAPI = { isDesktop: true, platform: 'web-tcp' };
            const webView = render(
                <BottomDock
                    height={300}
                    onClosePosition={vi.fn()}
                    onModifyPosition={vi.fn()}
                />,
            );
            const webCompanyTab = screen.getByRole('button', { name: 'Company — Broker company information' });
            await act(async () => { fireEvent.click(webCompanyTab); });
            expect(openSpy).not.toHaveBeenCalled();
            expect(webCompanyTab).toHaveClass('active-tab');
            expect(await screen.findByTestId('mock-company-tab')).toBeInTheDocument();
            webView.unmount();

            // 2. Desktop .exe (clientcore platform='win32'): Company also stays in-app (iframe pane), never a new window.
            w.rtx5Electron = { isDesktop: true, platform: 'win32' };
            w.electronAPI = { isDesktop: true, platform: 'win32' };
            sessionStorage.setItem(SESSION_VIEW_KEYS.bottomDockTab, 'Company');
            const exeView = render(
                <BottomDock
                    height={300}
                    onClosePosition={vi.fn()}
                    onModifyPosition={vi.fn()}
                />,
            );
            const tradeTab = screen.getByRole('button', { name: 'Trade — Open positions and live account summary' });
            const exeCompanyTab = screen.getByRole('button', { name: 'Company — Broker company information' });
            // A restored Company selection is kept on the desktop too.
            expect(exeCompanyTab).toHaveClass('active-tab');
            expect(await screen.findByTestId('mock-company-tab')).toBeInTheDocument();

            await act(async () => { fireEvent.click(tradeTab); });
            expect(tradeTab).toHaveClass('active-tab');

            await act(async () => { fireEvent.click(exeCompanyTab); });
            expect(exeCompanyTab).toHaveClass('active-tab');
            expect(tradeTab).not.toHaveClass('active-tab');

            await act(async () => { fireEvent.click(tradeTab); });
            await act(async () => {
                window.dispatchEvent(new CustomEvent('rtx:open-bottom-dock-tab', { detail: { tab: 'Company' } }));
            });
            expect(exeCompanyTab).toHaveClass('active-tab');
            expect(openSpy).not.toHaveBeenCalled();
            exeView.unmount();
        } finally {
            delete w.rtx5Electron;
            delete w.electronAPI;
        }
    });
});
