import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';
import { useUiTranslation } from '../../hooks/useUiTranslation';
import {
    deriveSymbolCurrencies,
    fetchNews,
    NEWS_READ_STORAGE_KEY,
    NEWS_REFRESH_INTERVAL_MS,
    type NewsErrorKind,
    type NewsItem,
    NewsServiceError,
} from '../../services/newsService';
import { useAppStore } from '../../store/useAppStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import './news-tab.css';

const MAX_READ_IDS = 500;

const NEWS_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
});

const CATEGORY_FILTERS = [
    { value: 'all', label: 'All' },
    { value: 'forex', label: 'Forex' },
    { value: 'gold', label: 'Gold' },
    { value: 'oil', label: 'Oil' },
    { value: 'market', label: 'Market' },
] as const;

type CategoryFilter = (typeof CATEGORY_FILTERS)[number]['value'];
type ScopeFilter = 'all' | 'symbol';

function loadReadIds(): string[] {
    try {
        const raw = localStorage.getItem(NEWS_READ_STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((value): value is string => typeof value === 'string').slice(-MAX_READ_IDS);
    } catch {
        return [];
    }
}

function saveReadIds(ids: string[]): void {
    try {
        localStorage.setItem(NEWS_READ_STORAGE_KEY, JSON.stringify(ids.slice(-MAX_READ_IDS)));
    } catch {
        // Storage can be unavailable or full; read state then only lasts for this session.
    }
}

function openArticle(url: string): void {
    if (typeof window === 'undefined') return;
    // Re-check the scheme at the point of use; only absolute http(s) links may open.
    try {
        const protocol = new URL(url).protocol;
        if (protocol !== 'http:' && protocol !== 'https:') return;
    } catch {
        return;
    }
    // Desktop shells that expose openExternal use it; otherwise window.open is the real path.
    const openExternal = (window as { electron?: { shell?: { openExternal?: unknown } } }).electron?.shell?.openExternal;
    if (typeof openExternal === 'function') {
        void (openExternal as (target: string) => unknown)(url);
        return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
}

const formatNewsTime = (timestampMs: number): string => (
    timestampMs > 0 ? NEWS_DATE_TIME_FORMATTER.format(new Date(timestampMs)) : ''
);

const capitalize = (value: string): string => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value);

interface NewsTabProps {
    /** True while the News dock tab is the visible one. */
    active?: boolean;
}

export function NewsTab({ active = true }: NewsTabProps) {
    const tr = useUiTranslation();
    const enabled = useSettingsStore((state) => state.server.enableNews);
    const selectedSymbol = useAppStore((state) => state.selectedSymbol);

    const [items, setItems] = useState<NewsItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [errorKind, setErrorKind] = useState<NewsErrorKind | null>(null);
    const [scope, setScope] = useState<ScopeFilter>('all');
    const [category, setCategory] = useState<CategoryFilter>('all');
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [initialReadIds] = useState<string[]>(loadReadIds);
    const [readIds, setReadIds] = useState<Set<string>>(() => new Set(initialReadIds));
    const readOrderRef = useRef<string[]>(initialReadIds);
    const controllerRef = useRef<AbortController | null>(null);
    const lastSuccessRef = useRef(0);

    const load = useCallback(async () => {
        controllerRef.current?.abort();
        const controller = new AbortController();
        controllerRef.current = controller;
        setLoading(true);
        try {
            const next = await fetchNews({ limit: 200, signal: controller.signal });
            if (controller.signal.aborted) return;
            lastSuccessRef.current = Date.now();
            setItems(next.slice().sort((a, b) => b.publishedAt - a.publishedAt));
            setErrorKind(null);
            setLoaded(true);
        } catch (error) {
            if (controller.signal.aborted) return;
            setErrorKind(error instanceof NewsServiceError ? error.kind : 'failed');
            setLoaded(true);
        } finally {
            if (controllerRef.current === controller) {
                controllerRef.current = null;
                if (!controller.signal.aborted) setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (!active || !enabled) return undefined;
        // Fetch-on-show is an external-service sync; load() only sets state around the request.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
        const timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            void load();
        }, NEWS_REFRESH_INTERVAL_MS);
        const onVisibility = () => {
            if (document.visibilityState !== 'visible') return;
            if (controllerRef.current) return; // request already in flight
            if (Date.now() - lastSuccessRef.current < NEWS_REFRESH_INTERVAL_MS) return;
            void load();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisibility);
            controllerRef.current?.abort();
            controllerRef.current = null;
            setLoading(false);
        };
    }, [active, enabled, load]);

    const symbolCurrencies = useMemo(() => deriveSymbolCurrencies(selectedSymbol), [selectedSymbol]);

    const visibleItems = useMemo(() => items.filter((item) => {
        if (category !== 'all' && item.category !== category) return false;
        if (scope === 'symbol' && symbolCurrencies.length > 0 && !symbolCurrencies.includes(item.currency)) return false;
        return true;
    }), [items, category, scope, symbolCurrencies]);

    const selectedItem = useMemo(
        () => (selectedId === null ? null : items.find((item) => item.id === selectedId) ?? null),
        [items, selectedId],
    );

    const openItem = useCallback((item: NewsItem) => {
        setSelectedId(item.id);
        const key = String(item.id);
        if (readOrderRef.current.includes(key)) return;
        readOrderRef.current = [...readOrderRef.current, key].slice(-MAX_READ_IDS);
        saveReadIds(readOrderRef.current);
        setReadIds(new Set(readOrderRef.current));
    }, []);

    if (!enabled) {
        return (
            <div className="rtx-news-tab" data-testid="news-tab">
                <div className="rtx-news-state" role="status">{tr('News is disabled in Options')}</div>
            </div>
        );
    }

    let stateMessage: string | null = null;
    if (!loaded && loading) stateMessage = tr('Loading news…');
    else if (loaded && errorKind === 'unavailable' && items.length === 0) stateMessage = tr('News is not available on this server yet');
    else if (loaded && errorKind === 'failed' && items.length === 0) stateMessage = tr('Could not load news');
    else if (loaded && visibleItems.length === 0) stateMessage = tr('No news');

    const banner = errorKind && items.length > 0
        ? (errorKind === 'unavailable' ? tr('News is not available on this server yet') : tr('Could not load news'))
        : null;

    return (
        <div className="rtx-news-tab" data-testid="news-tab">
            <div className="rtx-news-toolbar">
                <select
                    className="rtx-news-select"
                    aria-label={tr('News scope')}
                    value={scope}
                    onChange={(event) => setScope(event.target.value === 'symbol' ? 'symbol' : 'all')}
                >
                    <option value="all">{tr('All')}</option>
                    <option value="symbol">{tr('Current symbol')}</option>
                </select>
                <select
                    className="rtx-news-select"
                    aria-label={tr('News category')}
                    value={category}
                    onChange={(event) => setCategory(event.target.value as CategoryFilter)}
                >
                    {CATEGORY_FILTERS.map((option) => (
                        <option key={option.value} value={option.value}>{tr(option.label)}</option>
                    ))}
                </select>
                <button
                    type="button"
                    className="rtx-news-refresh"
                    title={tr('Refresh')}
                    aria-label={tr('Refresh')}
                    disabled={loading}
                    onClick={() => { void load(); }}
                >
                    <Icon name="refresh" size="xs" />
                </button>
                {banner ? <span className="rtx-news-banner" role="status">{banner}</span> : null}
            </div>
            <div className="rtx-news-body">
                <div className="rtx-news-scroll">
                    <table className="rtx-news-table">
                        <thead className="rtx-news-head">
                            <tr>
                                <th>{tr('Subject')}</th>
                                <th className="rtx-news-col--source">{tr('Source')}</th>
                                <th className="rtx-news-col--category">{tr('Category')}</th>
                                <th className="rtx-news-col--time">{tr('Time')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleItems.map((item) => {
                                const unread = !readIds.has(String(item.id));
                                return (
                                    <tr
                                        key={item.id}
                                        className="rtx-news-row"
                                        data-unread={unread || undefined}
                                        data-selected={selectedId === item.id || undefined}
                                        data-important={item.priority >= 1 || undefined}
                                        tabIndex={0}
                                        aria-selected={selectedId === item.id}
                                        onClick={() => openItem(item)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                openItem(item);
                                            }
                                        }}
                                    >
                                        <td className="rtx-news-subject" title={item.title}>
                                            {item.priority >= 1 ? (
                                                <span className="rtx-news-important" title={tr('Important')} aria-label={tr('Important')}>
                                                    <Icon name="alert-triangle" size="xs" />
                                                </span>
                                            ) : null}
                                            <span>{item.title}</span>
                                        </td>
                                        <td className="rtx-news-col--source">{item.source}</td>
                                        <td className="rtx-news-col--category">{capitalize(item.category)}</td>
                                        <td className="rtx-news-col--time">{formatNewsTime(item.publishedAt)}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    {stateMessage ? <div className="rtx-news-state" role="status">{stateMessage}</div> : null}
                </div>
                {selectedItem ? (
                    <aside className="rtx-news-reader" aria-label={selectedItem.title}>
                        <div className="rtx-news-reader__head">
                            <h3 className="rtx-news-reader__title">{selectedItem.title}</h3>
                            <button
                                type="button"
                                className="rtx-news-refresh"
                                title={tr('Close')}
                                aria-label={tr('Close')}
                                onClick={() => setSelectedId(null)}
                            >
                                <X size={12} aria-hidden="true" />
                            </button>
                        </div>
                        <div className="rtx-news-reader__meta">
                            {[selectedItem.source, capitalize(selectedItem.category), formatNewsTime(selectedItem.publishedAt)]
                                .filter(Boolean)
                                .join(' · ')}
                        </div>
                        <div className="rtx-news-reader__text" data-testid="news-article-body">{selectedItem.body}</div>
                        <button
                            type="button"
                            className="rtx-news-open"
                            onClick={() => openArticle(selectedItem.url)}
                        >
                            {tr('Open article')}
                        </button>
                    </aside>
                ) : null}
            </div>
        </div>
    );
}
