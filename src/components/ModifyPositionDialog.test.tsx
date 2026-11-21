import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markQuoteFeedActivity, clearQuoteFeedActivity } from '../store/quoteFeedActivity';

import { ModifyPositionDialog } from './ModifyPositionDialog';
import { commitBrokerAccountSessionScope } from '../services/brokerSession';
import {
    registerDailyChangePriceModes,
    resetDailyChangePriceModeRegistryForTests,
} from '../services/dailyChangePriceModeRegistry';

// Live feed quotes for these symbols are stamped as alive (the SL/TP local check needs a feed stamp).
beforeEach(() => {
    clearQuoteFeedActivity();
    markQuoteFeedActivity('BTCUSD', Date.now()); markQuoteFeedActivity('GBPUSD', Date.now());
});


const mocks = vi.hoisted(() => ({
    closePosition: vi.fn(),
    modifyPendingOrder: vi.fn(),
    modifyPosition: vi.fn(),
    placeMarketOrder: vi.fn(),
    setPositions: vi.fn(),
    positions: [] as unknown[],
    tick: {
        symbol: 'GBPUSD', bid: 1.33981, ask: 1.33983, spread: 2,
        timestamp: 1_797_341_377_000,
    },
}));

vi.mock('../store/useMarketDataStore', () => ({
    useCurrentTick: () => mocks.tick,
}));

vi.mock('../store/useAppStore', () => ({
    // Shared Market Watch tick source (useTick / resolveTickFromLookup).
    useTick: () => mocks.tick,
    resolveTickFromLookup: () => mocks.tick,
    useAppStore: {
        getState: () => ({
      ticks: mocks.tick ? { [mocks.tick.symbol]: mocks.tick } : {},
      tickLookup: {},
            positions: mocks.positions,
            setPositions: mocks.setPositions,
        }),
    },
}));

vi.mock('../services/api', () => ({
    default: {
        orders: {
            modifyPendingOrder: mocks.modifyPendingOrder,
            placeMarketOrder: mocks.placeMarketOrder,
        },
        positions: {
            closePosition: mocks.closePosition,
            modifyPosition: mocks.modifyPosition,
        },
    },
}));

const makePosition = (id = 165) => ({
    id,
    symbol: 'GBPUSD',
    side: 'BUY' as const,
    volume: 0.01,
    openPrice: 1.33981,
    sl: 0,
    tp: 0,
    comment: '',
});

describe('ModifyPositionDialog chart toolbar', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.positions = [];
        mocks.tick = {
            symbol: 'GBPUSD', bid: 1.33981, ask: 1.33983, spread: 2,
            timestamp: 1_797_341_377_000,
        };
        mocks.modifyPosition.mockResolvedValue(undefined);
        mocks.modifyPendingOrder.mockResolvedValue(undefined);
        mocks.placeMarketOrder.mockResolvedValue(undefined);
        mocks.closePosition.mockResolvedValue(undefined);
        commitBrokerAccountSessionScope({
            authenticated: true,
            accountId: '77',
            brokerId: 'broker-a',
            serverUrl: 'https://broker.example',
        });
        // Broker catalog precision for the fixture symbol (spec data, never the name table).
        resetDailyChangePriceModeRegistryForTests();
        registerDailyChangePriceModes([{ symbol: 'GBPUSD', digits: 5 }]);
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        commitBrokerAccountSessionScope({ authenticated: false, brokerId: '', serverUrl: '' });
        resetDailyChangePriceModeRegistryForTests();
    });

    it('commits only the opening ticket values on first open, ticket switch, and reopen', () => {
        const commits: Array<{ title: string; sl: string; tp: string; volume: string; comment: string }> = [];
        const recordCommit = () => {
            const dialog = document.querySelector('[role="dialog"]');
            if (!dialog) return;
            const value = (field: string) => dialog.querySelector<HTMLInputElement>(`input[id$="-${field}"]`)!.value;
            commits.push({
                title: document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent!,
                sl: value('sl'), tp: value('tp'), volume: value('volume'), comment: value('comment'),
            });
        };
        const first = { ...makePosition(165), sl: 1.31, tp: 1.37, volume: 0.02, comment: 'First position' };
        const second = { ...makePosition(166), comment: 'Second position' };
        const renderDialog = (position: typeof first, isOpen = true) => (
            <Profiler id="modify-dialog" onRender={recordCommit}>
                <ModifyPositionDialog isOpen={isOpen} onClose={vi.fn()} position={position} />
            </Profiler>
        );
        const { rerender } = render(renderDialog(first));
        expect(commits[0]).toEqual({
            title: expect.stringContaining('#165'), sl: '1.31000', tp: '1.37000', volume: '0.02', comment: 'First position',
        });
        commits.length = 0;
        rerender(renderDialog(second));
        expect(commits.length).toBeGreaterThan(0);
        // Empty SL/TP seed to the valid side of the live quote (BUY GBPUSD
        // bid 1.33981, 5 digits, default 5pt standoff), never '0.00'.
        expect(commits.every(commit => commit.title.includes('#166') && commit.sl === '1.33976' && commit.tp === '1.33986'
            && commit.volume === '0.01' && commit.comment === 'Second position')).toBe(true);

        fireEvent.change(screen.getByLabelText(/stop loss:$/i), { target: { value: '1.28' } });
        rerender(renderDialog(second, false));
        commits.length = 0;
        rerender(renderDialog({ ...second, sl: 1.32, tp: 1.38 }));
        expect(commits[0]).toEqual({
            title: expect.stringContaining('#166'), sl: '1.32000', tp: '1.38000', volume: '0.01', comment: 'Second position',
        });
        expect(mocks.modifyPosition).not.toHaveBeenCalled();
    });

    it('preserves an edited draft when quotes and the same position object refresh', async () => {
        const position = { ...makePosition(167), sl: 1.31, tp: 1.37, comment: 'Original' };
        const { rerender } = render(<ModifyPositionDialog isOpen onClose={vi.fn()} position={position} />);
        fireEvent.change(screen.getByLabelText(/stop loss:$/i), { target: { value: '1.30' } });
        fireEvent.change(screen.getByLabelText(/comment/i), { target: { value: 'My draft' } });
        mocks.tick = { ...mocks.tick, bid: 1.34, ask: 1.34002, timestamp: mocks.tick.timestamp + 1_000 };
        rerender(<ModifyPositionDialog isOpen onClose={vi.fn()} position={{ ...position }} />);
        expect(screen.getByLabelText(/stop loss:$/i)).toHaveValue(1.3);
        expect(screen.getByLabelText(/take profit:$/i)).toHaveValue(1.37);
        expect(screen.getByLabelText(/comment/i)).toHaveValue('My draft');
        fireEvent.click(screen.getByRole('button', { name: 'Buy by Market' }));
        await waitFor(() => expect(mocks.placeMarketOrder).toHaveBeenCalledWith(
            expect.objectContaining({ symbol: 'GBPUSD', side: 'BUY', price_sl: 1.3, price_tp: 1.37, comment: 'My draft' }),
            expect.anything(),
        ));
    });

    it('does not close or move focus when Escape/Tab belongs to a newer local dialog', async () => {
        const onClose = vi.fn();
        render(<ModifyPositionDialog isOpen onClose={onClose} position={{
            id: 164, symbol: 'GBPUSD', side: 'BUY', volume: 0.01,
            openPrice: 1.33981, sl: 0, tp: 0, comment: '',
        }} />);
        const dialog = screen.getByRole('dialog');
        await waitFor(() => expect(dialog).toHaveFocus());
        const help = document.createElement('div'); help.setAttribute('role', 'dialog'); help.dataset.shortcutScope = 'local';
        const button = document.createElement('button'); help.append(button); document.body.append(help); button.focus();
        const local = vi.fn(); help.addEventListener('keydown', local);
        try {
            fireEvent.keyDown(button, { key: 'Escape', cancelable: true });
            fireEvent.keyDown(button, { key: 'Tab', shiftKey: true, cancelable: true });
            expect(local).toHaveBeenCalledTimes(2);
            expect(button).toHaveFocus(); expect(onClose).not.toHaveBeenCalled();
        } finally { help.remove(); }
        dialog.focus(); fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
        expect(mocks.closePosition).not.toHaveBeenCalled();
        expect(mocks.modifyPosition).not.toHaveBeenCalled();
        expect(mocks.placeMarketOrder).not.toHaveBeenCalled();
    });

    it('hides and restores the mini chart from the chart toolbar button', async () => {
        const user = userEvent.setup();

        render(
            <ModifyPositionDialog
                isOpen
                onClose={vi.fn()}
                position={{
                    id: 164,
                    symbol: 'GBPUSD',
                    side: 'BUY',
                    volume: 0.01,
                    openPrice: 1.33981,
                    sl: 1.34004,
                    tp: 1.33931,
                    comment: '',
                }}
            />
        );

        expect(screen.getByRole('img', { name: /gbpusd bid and ask tick chart/i })).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Hide chart' }));
        expect(screen.queryByRole('img', { name: /gbpusd bid and ask tick chart/i })).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Show chart' }));
        expect(screen.getByRole('img', { name: /gbpusd bid and ask tick chart/i })).toBeInTheDocument();
    });

    it('opens and closes the embedded market depth ladder from the first toolbar button', async () => {
        const user = userEvent.setup();

        render(
            <ModifyPositionDialog
                isOpen
                onClose={vi.fn()}
                position={{
                    id: 164,
                    symbol: 'GBPUSD',
                    side: 'BUY',
                    volume: 0.01,
                    openPrice: 1.33981,
                    sl: 1.34004,
                    tp: 1.33931,
                    comment: '',
                }}
            />
        );

        expect(screen.queryByRole('region', { name: /gbpusd market depth/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Pointer' })).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Show market depth' }));
        expect(screen.getByRole('region', { name: /gbpusd market depth/i })).toBeInTheDocument();
        expect(screen.getByText('Trade')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Hide market depth' }));
        expect(screen.queryByRole('region', { name: /gbpusd market depth/i })).not.toBeInTheDocument();
    });

    it('sends typed comments when placing a market order from the position dialog', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();

        render(
            <ModifyPositionDialog
                isOpen
                onClose={onClose}
                position={{
                    id: 165,
                    symbol: 'GBPUSD',
                    side: 'BUY',
                    volume: 0.01,
                    openPrice: 1.33981,
                    sl: 0,
                    tp: 0,
                    comment: '',
                }}
            />
        );

        await user.type(screen.getByLabelText(/comment/i), 'hiiii');
        await user.click(screen.getByRole('button', { name: 'Buy by Market' }));

        await waitFor(() => {
            expect(mocks.placeMarketOrder).toHaveBeenCalledWith(expect.objectContaining({
                symbol: 'GBPUSD',
                side: 'BUY',
                comment: 'hiiii',
            }), expect.anything());
        });
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    });

    it('blocks submission after the dialog trading scope becomes stale', () => {
        render(<ModifyPositionDialog isOpen onClose={vi.fn()} position={makePosition(168)} />);

        act(() => commitBrokerAccountSessionScope({
            authenticated: true,
            accountId: '88',
            brokerId: 'broker-a',
            serverUrl: 'https://broker.example',
        }));
        fireEvent.click(screen.getByRole('button', { name: 'Buy by Market' }));

        expect(mocks.placeMarketOrder).not.toHaveBeenCalled();
        expect(mocks.setPositions).not.toHaveBeenCalled();
        expect(screen.getByText('Trading session changed. Reopen the position and try again.')).toBeInTheDocument();
    });

    it('omits Modify # and Close # buttons and broker stops notice for positions while keeping Sell/Buy by Market and plain BUY text in header', () => {
        const { rerender } = render(
            <ModifyPositionDialog
                isOpen
                onClose={vi.fn()}
                position={makePosition(171)}
            />
        );

        expect(screen.queryByRole('button', { name: /modify #171/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /close #171 buy .* by market/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/Stops processing is performed on the broker side\./i)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Sell by Market' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Buy by Market' })).toBeInTheDocument();
        expect(screen.getByText('BUY')).toHaveClass('rtx-modify-badge-side');
        expect(screen.queryByText(/GBPUSD @/i)).not.toBeInTheDocument();

        rerender(
            <ModifyPositionDialog
                isOpen
                kind="pending-order"
                onClose={vi.fn()}
                position={makePosition(171)}
            />
        );
        expect(screen.getByRole('button', { name: /modify #171/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Sell by Market' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Buy by Market' })).not.toBeInTheDocument();
    });

    it('ignores a market order acknowledgement that resolves after the trading scope changes', async () => {
        let resolveOrder: (() => void) | null = null;
        const pendingOrder = new Promise<void>(resolve => { resolveOrder = resolve; });
        const position = makePosition(169);
        mocks.positions = [position];
        mocks.placeMarketOrder.mockReturnValueOnce(pendingOrder);
        const onClose = vi.fn();
        const forceRefresh = vi.fn();
        window.addEventListener('rtx:force-refresh-positions', forceRefresh);

        try {
            render(<ModifyPositionDialog isOpen onClose={onClose} position={position} />);
            fireEvent.click(screen.getByRole('button', { name: 'Buy by Market' }));
            expect(mocks.placeMarketOrder).toHaveBeenCalledOnce();

            act(() => commitBrokerAccountSessionScope({
                authenticated: true,
                accountId: '88',
                brokerId: 'broker-a',
                serverUrl: 'https://broker.example',
            }));
            await act(async () => {
                resolveOrder?.();
                await pendingOrder;
            });

            expect(mocks.setPositions).not.toHaveBeenCalled();
            expect(forceRefresh).not.toHaveBeenCalled();
            expect(onClose).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('rtx:force-refresh-positions', forceRefresh);
        }
    });

    it('cancels the delayed saved close when the trading scope changes', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const onClose = vi.fn();
        const position = makePosition(170);
        mocks.positions = [position];
        render(<ModifyPositionDialog isOpen onClose={onClose} position={position} />);
        act(() => vi.runOnlyPendingTimers());

        fireEvent.click(screen.getByRole('button', { name: 'Buy by Market' }));
        await act(async () => {
            await Promise.resolve();
        });
        // Moving focus makes jsdom fire `selectionchange` from its own 0ms
        // setTimeout; drain it so only the dialog's delayed close is counted.
        act(() => vi.advanceTimersByTime(0));
        expect(vi.getTimerCount()).toBe(1);

        act(() => commitBrokerAccountSessionScope({
            authenticated: true,
            accountId: '88',
            brokerId: 'broker-a',
            serverUrl: 'https://broker.example',
        }));
        act(() => vi.advanceTimersByTime(0));
        expect(vi.getTimerCount()).toBe(0);
        act(() => vi.advanceTimersByTime(600));
        expect(onClose).not.toHaveBeenCalled();
    });

    it.each([
        { label: /stop loss:$/i, value: '1.32', expected: { price_sl: 1.32 } },
        { label: /take profit:$/i, value: '1.38', expected: { price_tp: 1.38 } },
        { label: /stop loss:$/i, value: '0', expected: { price_sl: 0 } },
        { label: /take profit:$/i, value: '0', expected: { price_tp: 0 } },
    ])('sends the edited level for pending order modification: $expected', async ({ label, value, expected }) => {
        const user = userEvent.setup();
        const position = {
            id: 166, symbol: 'GBPUSD', side: 'BUY' as const, volume: 0.01,
            openPrice: 1.34, sl: 1.31, tp: 1.37, comment: '',
            price_sl: 1.31, price_tp: 1.37,
            stopLoss: 1.31, stop_loss: 1.31, takeProfit: 1.37, take_profit: 1.37,
        };
        mocks.positions = [position];
        render(<ModifyPositionDialog isOpen kind="pending-order" onClose={vi.fn()} position={position} />);
        const input = screen.getByLabelText(label);
        await user.clear(input);
        await user.type(input, value);
        await user.click(screen.getByRole('button', { name: /modify #166/i }));
        await waitFor(() => expect(mocks.modifyPendingOrder).toHaveBeenCalledWith(166, expect.objectContaining(expected)));
    });

    it('does not render a minimum points distance notice and renders enhanced left chart elements', () => {
        render(
            <ModifyPositionDialog
                isOpen
                onClose={vi.fn()}
                position={{
                    id: 167,
                    symbol: 'BTCUSD',
                    side: 'BUY',
                    volume: 0.01,
                    openPrice: 85981.44,
                    sl: 0,
                    tp: 0,
                    comment: '',
                }}
            />
        );

        // Requirement 1 (owner ruling): no minimum-distance hint. The gateway
        // checks side + grid only, so no "at least N points" notice is shown.
        expect(screen.queryByText(/must differ from market price by at least/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/at least \d+ points/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Stops processing is performed on the broker side\./i)).not.toBeInTheDocument();

        // Requirement 2: Left side chart elements (redundant header strip & zoom controls omitted)
        expect(screen.queryByText('TICK')).not.toBeInTheDocument();
        expect(screen.getByRole('img', { name: /btcusd bid and ask tick chart/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Zoom out' })).not.toBeInTheDocument();
        expect(screen.queryByText('1.00x')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Fit chart' })).toBeInTheDocument();
    });
});
