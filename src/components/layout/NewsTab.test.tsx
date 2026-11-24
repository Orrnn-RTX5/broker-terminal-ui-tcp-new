// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/newsService', async () => {
    const actual = await vi.importActual<typeof import('../../services/newsService')>('../../services/newsService');
    return { ...actual, fetchNews: fetchMock };
});

import { NewsTab } from './NewsTab';
import { deriveSymbolCurrencies, NEWS_READ_STORAGE_KEY, NEWS_REFRESH_INTERVAL_MS, NewsServiceError, type NewsItem } from '../../services/newsService';
import { useAppStore } from '../../store/useAppStore';
import { useSettingsStore } from '../../store/useSettingsStore';

const mk = (over: Partial<NewsItem> = {}): NewsItem => ({
    id: 1, title: 'Title 1', body: 'Body <b>bold</b>', source: 'Src', category: 'forex', currency: 'USD',
    priority: 0, publishedAt: 1000, fetchedAt: 1000, url: 'https://example.com/1', ...over,
});

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('NewsTab', () => {
    beforeEach(() => {
        localStorage.clear();
        fetchMock.mockReset();
        useSettingsStore.getState().updateServerSettings({ enableNews: true });
        useAppStore.setState({ selectedSymbol: 'EURUSD' });
    });
    afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

    it('renders rows newest first and marks unread bold until opened', async () => {
        fetchMock.mockResolvedValue([mk({ id: 1, title: 'Old', publishedAt: 1000 }), mk({ id: 2, title: 'New', publishedAt: 5000, priority: 2 })]);
        render(<NewsTab />);
        await flush();
        const rows = screen.getAllByRole('row').slice(1);
        expect(rows[0]).toHaveTextContent('New');
        expect(rows[1]).toHaveTextContent('Old');
        expect(rows[0]).toHaveAttribute('data-unread', 'true');
        expect(screen.getByLabelText('Important')).toBeInTheDocument();
        fireEvent.click(rows[0]);
        expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('data-unread');
        expect(JSON.parse(localStorage.getItem(NEWS_READ_STORAGE_KEY) ?? '[]')).toEqual(['2']);
    });

    it('renders clean plain text without raw HTML tags and omits the Open article button', async () => {
        fetchMock.mockResolvedValue([mk({
            body: '<ul><li>Item 1</li><li>Item 2</li></ul><p style="text-align: justify">Body <b>bold</b>&nbsp;text</p>',
            url: 'https://example.com/story',
        })]);
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        render(<NewsTab />);
        await flush();
        fireEvent.click(screen.getAllByRole('row')[1]);
        const body = screen.getByTestId('news-article-body');
        expect(body.textContent).toBe('• Item 1\n• Item 2\n\nBody bold text');
        expect(body.textContent).not.toContain('<ul>');
        expect(body.textContent).not.toContain('&nbsp;');
        expect(body.querySelector('b, ul, li, p')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Open article' })).toBeNull();
        expect(screen.queryByTestId('news-article-iframe')).toBeNull();
        expect(open).not.toHaveBeenCalled();
    });

    it('filters by current symbol currencies and category', async () => {
        fetchMock.mockResolvedValue([
            mk({ id: 1, title: 'UsdNews', currency: 'USD', category: 'forex' }),
            mk({ id: 2, title: 'JpyNews', currency: 'JPY', category: 'forex' }),
            mk({ id: 3, title: 'GoldNews', currency: 'XAU', category: 'gold' }),
        ]);
        render(<NewsTab />);
        await flush();
        expect(screen.getAllByRole('row')).toHaveLength(4);
        fireEvent.change(screen.getByLabelText('News scope'), { target: { value: 'symbol' } });
        expect(screen.getByText('UsdNews')).toBeInTheDocument();
        expect(screen.queryByText('JpyNews')).toBeNull();
        fireEvent.change(screen.getByLabelText('News scope'), { target: { value: 'all' } });
        fireEvent.change(screen.getByLabelText('News category'), { target: { value: 'gold' } });
        expect(screen.getByText('GoldNews')).toBeInTheDocument();
        expect(screen.queryByText('UsdNews')).toBeNull();
    });

    it('derives currencies from symbols with broker suffixes', () => {
        expect(deriveSymbolCurrencies('EURUSD')).toEqual(['EUR', 'USD']);
        expect(deriveSymbolCurrencies('XAUUSD.m')).toEqual(['XAU', 'USD']);
        expect(deriveSymbolCurrencies('GBPJPY-F')).toEqual(['GBP', 'JPY']);
        expect(deriveSymbolCurrencies('US30')).toEqual([]);
    });

    it('polls only while active and aborts on hide', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(() => new Promise(() => undefined));
        const { rerender } = render(<NewsTab active={false} />);
        await act(async () => { vi.advanceTimersByTime(NEWS_REFRESH_INTERVAL_MS * 2); });
        expect(fetchMock).not.toHaveBeenCalled();
        rerender(<NewsTab active />);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0].limit).toBe(200);
        await act(async () => { vi.advanceTimersByTime(NEWS_REFRESH_INTERVAL_MS); });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const lastSignal = fetchMock.mock.calls[1][0].signal as AbortSignal;
        rerender(<NewsTab active={false} />);
        expect(lastSignal.aborted).toBe(true);
        await act(async () => { vi.advanceTimersByTime(NEWS_REFRESH_INTERVAL_MS * 3); });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not fetch and explains when news is disabled', async () => {
        useSettingsStore.getState().updateServerSettings({ enableNews: false });
        render(<NewsTab />);
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.getByText('News is disabled in Options')).toBeInTheDocument();
    });

    it('shows unavailable and generic error states, keeping the last good list', async () => {
        fetchMock.mockRejectedValueOnce(new NewsServiceError('unavailable', 404));
        const view = render(<NewsTab />);
        await flush();
        expect(screen.getByText('News is not available on this server yet')).toBeInTheDocument();
        view.unmount();

        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce([mk({ title: 'Keep me' })]).mockRejectedValueOnce(new NewsServiceError('failed', 500));
        render(<NewsTab />);
        await flush();
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        await flush();
        expect(screen.getByText('Keep me')).toBeInTheDocument();
        expect(screen.getByText('Could not load news')).toBeInTheDocument();
    });

    it('shows an empty state', async () => {
        fetchMock.mockResolvedValue([]);
        render(<NewsTab />);
        await flush();
        expect(screen.getByText('No news')).toBeInTheDocument();
    });
    it('uses a non-error icon for high-priority news and never opens external article links', async () => {
        fetchMock.mockResolvedValue([mk({ priority: 2, url: 'https://example.com/1' })]);
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        const openExternal = vi.fn();
        (window as { electron?: { shell?: { openExternal?: (url: string) => void } } }).electron = {
            shell: { openExternal },
        };
        try {
            render(<NewsTab />);
            await flush();
            const importantBadge = screen.getByLabelText('Important');
            expect(importantBadge.querySelector('polygon')).not.toBeNull();
            expect(importantBadge.innerHTML).not.toContain('M8 2L1.5 13.5');
            fireEvent.click(screen.getAllByRole('row')[1]);
            expect(screen.queryByRole('button', { name: 'Open article' })).toBeNull();
            expect(screen.queryByTestId('news-article-iframe')).toBeNull();
            expect(open).not.toHaveBeenCalled();
            expect(openExternal).not.toHaveBeenCalled();
        } finally {
            delete (window as { electron?: unknown }).electron;
        }
    });

    it('refetches on becoming visible only when stale and not in flight', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        fetchMock.mockResolvedValue([mk()]);
        let visibility: DocumentVisibilityState = 'visible';
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
        render(<NewsTab active />);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Fresh data: becoming visible does nothing.
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Stale while hidden (interval ticks are skipped), then visible again: one refetch.
        visibility = 'hidden';
        await act(async () => { vi.advanceTimersByTime(NEWS_REFRESH_INTERVAL_MS + 1000); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        fetchMock.mockImplementation(() => new Promise(() => undefined));
        visibility = 'visible';
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Request in flight: no double fetch.
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('opens rows from the keyboard (Enter and Space) and marks the open row selected', async () => {
        fetchMock.mockResolvedValue([mk({ id: 1, title: 'A', publishedAt: 2000 }), mk({ id: 2, title: 'B', publishedAt: 1000 })]);
        render(<NewsTab />);
        await flush();
        const rows = screen.getAllByRole('row').slice(1);
        expect(rows[0]).toHaveAttribute('tabindex', '0');
        expect(rows[0]).toHaveAttribute('aria-selected', 'false');
        fireEvent.keyDown(rows[0], { key: 'Enter' });
        expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-selected', 'true');
        expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('data-unread');
        fireEvent.keyDown(screen.getAllByRole('row')[2], { key: ' ' });
        expect(screen.getAllByRole('row')[2]).toHaveAttribute('aria-selected', 'true');
        expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-selected', 'false');
        expect(screen.getByTestId('news-article-body')).toBeInTheDocument();
    });
});
