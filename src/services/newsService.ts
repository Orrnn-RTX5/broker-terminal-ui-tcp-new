/**
 * News feed client for the broker news service (`GET /api/v1/news`).
 *
 * The request goes through the terminal's shared REST client, so it reaches
 * the broker exactly like the other REST calls (browser relay or desktop
 * bridge). It is never called until the News tab is opened.
 */
import { ApiError, apiClient } from '../api/client';
import { API_V2_BASE_URL } from '../config/api';

export const NEWS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const NEWS_READ_STORAGE_KEY = 'rtx.news.read.v1';
export const NEWS_MAX_ITEMS = 200;
export const NEWS_DEFAULT_LIMIT = 200;

const MAX_TITLE_LENGTH = 500;
const MAX_BODY_LENGTH = 20_000;
const MAX_SHORT_FIELD_LENGTH = 80;
const MAX_URL_LENGTH = 2048;
const NEWS_REQUEST_TIMEOUT_MS = 15_000;

export interface NewsItem {
  id: number;
  title: string;
  body: string;
  source: string;
  category: string;
  currency: string;
  /** 0 = normal, higher = more important. */
  priority: number;
  /** Unix milliseconds. */
  publishedAt: number;
  /** Unix milliseconds. */
  fetchedAt: number;
  /** Always an absolute http(s) URL. */
  url: string;
}

export interface NewsQuery {
  limit?: number;
  currency?: string;
  category?: string;
  source?: string;
  signal?: AbortSignal;
}

/** `unavailable` = the server has no news service (404/502/503); `failed` = anything else. */
export type NewsErrorKind = 'unavailable' | 'failed';

export class NewsServiceError extends Error {
  constructor(public readonly kind: NewsErrorKind, public readonly status?: number) {
    super(kind === 'unavailable' ? 'News is not available' : 'News request failed');
    this.name = 'NewsServiceError';
  }
}

const UNAVAILABLE_STATUSES = new Set([404, 502, 503]);

export const mapNewsError = (error: unknown): NewsServiceError => {
  if (error instanceof NewsServiceError) return error;
  if (error instanceof ApiError) {
    return new NewsServiceError(UNAVAILABLE_STATUSES.has(error.status) ? 'unavailable' : 'failed', error.status);
  }
  return new NewsServiceError('failed');
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const toText = (value: unknown, maxLength: number): string => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

/** Returns the normalized URL only for absolute http/https links. */
export const sanitizeNewsUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
};

/** Stable fallback id (always negative so it can never collide with a server id). */
const fallbackId = (url: string): number => {
  let hash = 5381;
  for (let index = 0; index < url.length; index += 1) {
    hash = ((hash << 5) + hash + url.charCodeAt(index)) | 0;
  }
  return -(Math.abs(hash) + 1);
};

/**
 * Defensive normalization of the `/api/v1/news` payload. Items without a title
 * or a valid http(s) url are dropped; unknown fields are ignored; at most
 * NEWS_MAX_ITEMS unique items are returned in server order.
 */
export const normalizeNewsResponse = (payload: unknown): NewsItem[] => {
  const rawItems = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === 'object' ? (payload as { items?: unknown }).items : undefined);
  if (!Array.isArray(rawItems)) return [];

  const seen = new Set<number>();
  const items: NewsItem[] = [];
  for (const raw of rawItems) {
    if (items.length >= NEWS_MAX_ITEMS) break;
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const title = toText(record.title, MAX_TITLE_LENGTH);
    const url = sanitizeNewsUrl(record.url);
    if (!title || !url) continue;

    const id = toFiniteNumber(record.id) ?? fallbackId(url);
    if (seen.has(id)) continue;
    seen.add(id);

    const priority = toFiniteNumber(record.priority);
    items.push({
      id,
      title,
      body: toText(record.body, MAX_BODY_LENGTH),
      source: toText(record.source, MAX_SHORT_FIELD_LENGTH),
      category: toText(record.category, MAX_SHORT_FIELD_LENGTH).toLowerCase(),
      currency: toText(record.currency, MAX_SHORT_FIELD_LENGTH).toUpperCase(),
      priority: priority === null ? 0 : Math.max(0, Math.trunc(priority)),
      publishedAt: toFiniteNumber(record.published_at) ?? 0,
      fetchedAt: toFiniteNumber(record.fetched_at) ?? 0,
      url,
    });
  }
  return items;
};

const clampLimit = (limit: number | undefined): number => {
  const value = Math.trunc(limit ?? NEWS_DEFAULT_LIMIT);
  if (!Number.isFinite(value) || value < 1) return NEWS_DEFAULT_LIMIT;
  return Math.min(value, NEWS_MAX_ITEMS);
};

export async function fetchNews(query: NewsQuery = {}): Promise<NewsItem[]> {
  const params: Record<string, string | number> = { limit: clampLimit(query.limit) };
  if (query.currency) params.currency = query.currency;
  if (query.category) params.category = query.category;
  if (query.source) params.source = query.source;

  const apiRootBaseUrl = API_V2_BASE_URL.replace(/\/api\/v2\/?$/, '');
  try {
    const payload = await apiClient.get<unknown>('/api/v1/news', {
      ...(apiRootBaseUrl ? { baseUrl: apiRootBaseUrl, skipDynamicUrl: true } : {}),
      skipAuth: true,
      timeoutMs: NEWS_REQUEST_TIMEOUT_MS,
      signal: query.signal,
      params,
      headers: { accept: 'application/json' },
    });
    return normalizeNewsResponse(payload);
  } catch (error) {
    throw mapNewsError(error);
  }
}

/** EURUSD -> [EUR, USD]; XAUUSD.m -> [XAU, USD]; EURUSD-F -> [EUR, USD]. Empty when not a 6-letter pair. */
export function deriveSymbolCurrencies(symbol: string | null | undefined): string[] {
    if (!symbol) return [];
    const head = symbol.trim().toUpperCase().split(/[^A-Z0-9]/, 1)[0] ?? '';
    if (head.length < 6) return [];
    const base = head.slice(0, 3);
    const quote = head.slice(3, 6);
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) return [];
    return [base, quote];
}
