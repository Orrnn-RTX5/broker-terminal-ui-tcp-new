// @vitest-environment jsdom
// Independent tester gap tests for NewsTab / newsService (added by hydrogen-tester).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/newsService', async () => {
    const actual = await vi.importActual<typeof import('../../services/newsService')>('../../services/newsService');
    return { ...actual, fetchNews: fetchMock };
});

import { NewsTab } from './NewsTab';
import {
    deriveSymbolCurrencies,
    NEWS_READ_STORAGE_KEY,
    NEWS_REFRESH_INTERVAL_MS,
    normalizeNewsResponse,
    sanitizeNewsUrl,
    type NewsItem,
} from '../../services/newsService';
import { useAppStore } from '../../store/useAppStore';
import { useSettingsStore } from '../../store/useSettingsStore';

const mk = (over: Partial<NewsItem> = {}): NewsItem => ({
    id: 1, title: 'Title 1', body: 'Body', source: 'Src', category: 'forex', currency: 'USD',
    priority: 0, publishedAt: 1000, fetchedAt: 1000, url: 'https://example.com/1', ...over,
});
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const raw = (over: Record<string, unknown>) => ({
    id: 1, title: 'T', body: 'B', source: 'S', category: 'forex', currency: 'USD', priority: 0,
    published_at: 1000, fetched_at: 1000, url: 'https://example.com/a', ...over,
});

describe('NewsTab extra', () => {
    beforeEach(() => {
        localStorage.clear();
        fetchMock.mockReset();
        useSettingsStore.getState().updateServerSettings({ enableNews: true });
        useAppStore.setState({ selectedSymbol: 'EURUSD' });
    });
    afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

    it('drops javascript:/data:/vbscript:/file:/relative/protocol-relative urls in the service', () => {
        for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///c:/x', '/relative', '//evil.com/x', 'ftp://a/b', '', null, 5]) {
            expect(sanitizeNewsUrl(bad), String(bad)).toBeNull();
        }
        expect(sanitizeNewsUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
        const items = normalizeNewsResponse({ items: [raw({ id: 1, url: 'javascript:alert(1)' }), raw({ id: 2, url: 'data:text/html,x' }), raw({ id: 3 })] });
        expect(items.map((i) => i.id)).toEqual([3]);
    });

    it('never renders an anchor/href for hostile payloads and never opens them', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        fetchMock.mockResolvedValue(normalizeNewsResponse({
            items: [raw({ id: 1, title: 'Evil', url: 'javascript:alert(1)' }), raw({ id: 2, title: 'Good', url: 'https://example.com/g' })],
        }));
        const { container } = render(<NewsTab />);
        await flush();
        expect(screen.queryByText('Evil')).toBeNull();
        expect(container.querySelector('a[href]')).toBeNull();
        expect(container.innerHTML).not.toMatch(/javascript:/i);
        fireEvent.click(screen.getByText('Good'));
        expect(container.querySelector('a[href]')).toBeNull();
        expect(open).not.toHaveBeenCalled();
    });

    it('strips html/script in title and body into safe inert text', async () => {
        fetchMock.mockResolvedValue([mk({ title: '<img src=x onerror=alert(1)>Safe title', body: '<script>window.__pwn=1</script><a href="javascript:1">x</a>' })]);
        const { container } = render(<NewsTab />);
        await flush();
        expect(container.querySelector('img')).toBeNull();
        expect(screen.getByText('Safe title')).toBeInTheDocument();
        fireEvent.click(screen.getAllByRole('row')[1]);
        const body = screen.getByTestId('news-article-body');
        expect(body.textContent).toBe('x');
        expect(body.textContent).not.toContain('<script>');
        expect(body.querySelector('script, a')).toBeNull();
        expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
    });

    it('renders 200 items quickly', async () => {
        fetchMock.mockResolvedValue(Array.from({ length: 200 }, (_, i) => mk({ id: i + 1, title: `N${i + 1}`, publishedAt: i })));
        render(<NewsTab />);
        await flush();
        const rows = screen.getAllByRole('row');
        expect(rows).toHaveLength(201);
        expect(rows[1]).toHaveTextContent('N200');
    });

    it('survives localStorage that throws (get and set)', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
        fetchMock.mockResolvedValue([mk({ id: 7, title: 'Seven' })]);
        render(<NewsTab />);
        await flush();
        const row = screen.getAllByRole('row')[1];
        expect(row).toHaveAttribute('data-unread', 'true');
        expect(() => fireEvent.click(row)).not.toThrow();
        expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('data-unread');
        expect(screen.getByTestId('news-article-body')).toBeInTheDocument();
    });

    it('survives corrupt / non-array stored read ids', async () => {
        localStorage.setItem(NEWS_READ_STORAGE_KEY, '{"a":1}');
        fetchMock.mockResolvedValue([mk()]);
        render(<NewsTab />);
        await flush();
        expect(screen.getAllByRole('row')[1]).toHaveAttribute('data-unread', 'true');
        localStorage.setItem(NEWS_READ_STORAGE_KEY, 'not json');
        cleanup();
        render(<NewsTab />);
        await flush();
        expect(screen.getAllByRole('row')[1]).toHaveAttribute('data-unread', 'true');
    });

    it('caps stored read ids at 500', async () => {
        fetchMock.mockResolvedValue(Array.from({ length: 3 }, (_, i) => mk({ id: 10_000 + i, title: `X${i}`, publishedAt: i })));
        localStorage.setItem(NEWS_READ_STORAGE_KEY, JSON.stringify(Array.from({ length: 700 }, (_, i) => String(i))));
        render(<NewsTab />);
        await flush();
        fireEvent.click(screen.getByText('X0'));
        const stored = JSON.parse(localStorage.getItem(NEWS_READ_STORAGE_KEY) ?? '[]') as string[];
        expect(stored.length).toBeLessThanOrEqual(500);
        expect(stored[stored.length - 1]).toBe('10000');
    });

    it('rapid active toggling aborts every in-flight request and never leaks a timer', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(() => new Promise(() => undefined));
        const { rerender, unmount } = render(<NewsTab active={false} />);
        const signals: AbortSignal[] = [];
        for (let i = 0; i < 6; i += 1) {
            rerender(<NewsTab active />);
            signals.push(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0].signal as AbortSignal);
            rerender(<NewsTab active={false} />);
        }
        expect(fetchMock).toHaveBeenCalledTimes(6);
        expect(signals.every((s) => s.aborted)).toBe(true);
        await act(async () => { vi.advanceTimersByTime(NEWS_REFRESH_INTERVAL_MS * 4); });
        expect(fetchMock).toHaveBeenCalledTimes(6);
        rerender(<NewsTab active />);
        const last = fetchMock.mock.calls[6][0].signal as AbortSignal;
        unmount();
        expect(last.aborted).toBe(true);
        await act(async () => { vi.advanceTimersByTime(NEWS_REFRESH_INTERVAL_MS * 4); });
        expect(fetchMock).toHaveBeenCalledTimes(7);
    });

    it('a late response from an aborted request does not overwrite newer state', async () => {
        const resolvers: Array<(v: NewsItem[]) => void> = [];
        fetchMock.mockImplementation(() => new Promise<NewsItem[]>((res) => { resolvers.push(res); }));
        const { rerender } = render(<NewsTab active />);
        rerender(<NewsTab active={false} />);
        rerender(<NewsTab active />);
        expect(resolvers).toHaveLength(2);
        await act(async () => { resolvers[0]([mk({ id: 1, title: 'STALE' })]); await Promise.resolve(); });
        expect(screen.queryByText('STALE')).toBeNull();
        await act(async () => { resolvers[1]([mk({ id: 2, title: 'FRESH' })]); await Promise.resolve(); });
        expect(screen.getByText('FRESH')).toBeInTheDocument();
    });

    it('stops polling when enableNews is switched off and resumes when on', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValue([mk()]);
        render(<NewsTab active />);
        await act(async () => { await Promise.resolve(); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        act(() => { useSettingsStore.getState().updateServerSettings({ enableNews: false }); });
        await act(async () => { vi.advanceTimersByTime(NEWS_REFRESH_INTERVAL_MS * 3); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(screen.getByText('News is disabled in Options')).toBeInTheDocument();
        act(() => { useSettingsStore.getState().updateServerSettings({ enableNews: true }); });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('skips timer refresh while document is hidden', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValue([mk()]);
        render(<NewsTab active />);
        await act(async () => { await Promise.resolve(); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        await act(async () => { vi.advanceTimersByTime(NEWS_REFRESH_INTERVAL_MS * 2); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        spy.mockReturnValue('visible');
        await act(async () => { vi.advanceTimersByTime(NEWS_REFRESH_INTERVAL_MS); });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['XAUUSD', ['XAU', 'USD']],
        ['EURUSD.m', ['EUR', 'USD']],
        ['EURUSD', ['EUR', 'USD']],
        ['BTCUSD', ['BTC', 'USD']],
        ['eurusd#', ['EUR', 'USD']],
        ['US30', []],
        ['', []],
        [null, []],
        ['123456', []],
    ])('deriveSymbolCurrencies(%s)', (symbol, expected) => {
        expect(deriveSymbolCurrencies(symbol as string | null)).toEqual(expected);
    });

    it.each([
        ['XAUUSD', ['XAU', 'USD'], 'JPY'],
        ['EURUSD.m', ['EUR', 'USD'], 'JPY'],
        ['BTCUSD', ['BTC', 'USD'], 'EUR'],
    ])('Current symbol filter for %s keeps %j and hides %s', async (symbol, keep, hide) => {
        useAppStore.setState({ selectedSymbol: symbol });
        fetchMock.mockResolvedValue([
            ...keep.map((c, i) => mk({ id: i + 1, title: `keep-${c}`, currency: c })),
            mk({ id: 99, title: `hide-${hide}`, currency: hide }),
        ]);
        render(<NewsTab />);
        await flush();
        fireEvent.change(screen.getByLabelText('News scope'), { target: { value: 'symbol' } });
        for (const c of keep) expect(screen.getByText(`keep-${c}`)).toBeInTheDocument();
        expect(screen.queryByText(`hide-${hide}`)).toBeNull();
    });

    it('Current symbol with a non-pair symbol (US30) falls back to showing everything', async () => {
        useAppStore.setState({ selectedSymbol: 'US30' });
        fetchMock.mockResolvedValue([mk({ id: 1, title: 'A', currency: 'USD' }), mk({ id: 2, title: 'B', currency: 'JPY' })]);
        render(<NewsTab />);
        await flush();
        fireEvent.change(screen.getByLabelText('News scope'), { target: { value: 'symbol' } });
        expect(screen.getByText('A')).toBeInTheDocument();
        expect(screen.getByText('B')).toBeInTheDocument();
    });

    it('unknown / empty category shows under All, hides under named category filters, no crash', async () => {
        fetchMock.mockResolvedValue([
            mk({ id: 1, title: 'Crypto thing', category: 'crypto' }),
            mk({ id: 2, title: 'No cat', category: '' }),
            mk({ id: 3, title: 'Forex thing', category: 'forex' }),
        ]);
        render(<NewsTab />);
        await flush();
        expect(screen.getAllByRole('row')).toHaveLength(4);
        expect(screen.getByText('Crypto')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('News category'), { target: { value: 'forex' } });
        expect(screen.queryByText('Crypto thing')).toBeNull();
        expect(screen.queryByText('No cat')).toBeNull();
        expect(screen.getByText('Forex thing')).toBeInTheDocument();
    });

    it('normalizes odd payloads: bare array, missing items, duplicates, >200, bad numbers', () => {
        expect(normalizeNewsResponse(null)).toEqual([]);
        expect(normalizeNewsResponse({})).toEqual([]);
        expect(normalizeNewsResponse({ items: 'x' })).toEqual([]);
        expect(normalizeNewsResponse([raw({ id: 1 }), raw({ id: 1 })])).toHaveLength(1);
        const many = normalizeNewsResponse({ items: Array.from({ length: 450 }, (_, i) => raw({ id: i + 1, url: `https://e.com/${i}` })) });
        expect(many).toHaveLength(200);
        const [odd] = normalizeNewsResponse({ items: [raw({ priority: -3, published_at: 'abc', id: '12' })] });
        expect(odd.priority).toBe(0);
        expect(odd.publishedAt).toBe(0);
        expect(odd.id).toBe(12);
    });
});
