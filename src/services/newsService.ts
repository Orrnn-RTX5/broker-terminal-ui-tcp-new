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

const HTML_TAG_RE = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>|<!--[\s\S]*?-->/i;
const HTML_ENTITY_RE = /&(?:#\d+|#x[\da-f]+|[a-z][a-z0-9]+);/i;
const IGNORED_HTML_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'HEAD',
]);
const BLOCK_HTML_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'MAIN', 'NAV', 'P', 'PRE', 'SECTION', 'TABLE',
]);
const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
};

const decodeHtmlEntitiesFallback = (input: string): string => (
  input.replace(/&(#\d+|#x[\da-f]+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower in NAMED_HTML_ENTITIES) return NAMED_HTML_ENTITIES[lower];
    if (lower.startsWith('#x')) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (lower.startsWith('#')) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return match;
  })
);

const cleanRenderedText = (value: string, singleLine = false): string => {
  const normalized = value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  if (singleLine) {
    return normalized.replace(/\s+/g, ' ').trim();
  }
  return normalized
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const extractDomNodeText = (node: Node, inPre = false): string => {
  if (node.nodeType === 3) {
    const text = (node.textContent ?? '').replace(/\u00a0/g, ' ');
    return inPre ? text : text.replace(/[\r\n\t ]+/g, ' ');
  }
  if (node.nodeType !== 1) return '';

  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  if (IGNORED_HTML_TAGS.has(tag)) return '';
  if (tag === 'BR') return '\n';

  if (tag === 'UL' || tag === 'OL') {
    const ordered = tag === 'OL';
    const lines: string[] = [];
    let index = 1;
    for (const child of Array.from(element.children)) {
      if (child.tagName.toUpperCase() === 'LI') {
        const itemText = cleanRenderedText(
          Array.from(child.childNodes).map((part) => extractDomNodeText(part, false)).join(''),
        );
        if (itemText) {
          lines.push(`${ordered ? `${index}. ` : '• '}${itemText}`);
          index += 1;
        }
      } else {
        const otherText = cleanRenderedText(extractDomNodeText(child, false));
        if (otherText) lines.push(otherText);
      }
    }
    return lines.length > 0 ? `\n\n${lines.join('\n')}\n\n` : '';
  }

  if (tag === 'TR') {
    const cells = Array.from(element.children)
      .map((cell) => cleanRenderedText(extractDomNodeText(cell, false)))
      .filter(Boolean);
    return cells.length > 0 ? `\n${cells.join('  ')}\n` : '';
  }

  const nextPre = inPre || tag === 'PRE';
  const content = Array.from(element.childNodes).map((child) => extractDomNodeText(child, nextPre)).join('');
  return BLOCK_HTML_TAGS.has(tag) ? `\n\n${content}\n\n` : content;
};

const htmlToPlainTextFallback = (input: string): string => {
  const withoutIgnored = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|iframe|object|embed|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|noscript|template|iframe|object|embed|svg|head)\b[^>]*\/?>/gi, '');
  const formatted = withoutIgnored
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>\s*<li\b[^>]*>/gi, '\n• ')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/?(?:address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|ul)\b[^>]*>/gi, '\n\n')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi, '');
  return decodeHtmlEntitiesFallback(formatted);
};

const parseHtmlToPlainText = (input: string, singleLine: boolean): string => {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(input, 'text/html');
    const extracted = doc.body ? extractDomNodeText(doc.body, false) : '';
    return cleanRenderedText(extracted, singleLine);
  }
  return cleanRenderedText(htmlToPlainTextFallback(input), singleLine);
};

/**
 * Safely converts RSS HTML markup and entities into readable plain text
 * without injecting HTML elements into the DOM.
 */
export const formatNewsText = (value: string, options?: { singleLine?: boolean }): string => {
  const singleLine = options?.singleLine ?? false;
  if (!value) return '';

  const hasTags = HTML_TAG_RE.test(value);
  const hasEntities = HTML_ENTITY_RE.test(value);
  if (!hasTags && !hasEntities) {
    return cleanRenderedText(value, singleLine);
  }

  // Decode entity-only plain text while preserving intentional newlines.
  if (!hasTags) {
    const decoded = typeof DOMParser !== 'undefined'
      ? cleanRenderedText(
        value
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((line) => new DOMParser().parseFromString(line, 'text/html').body?.textContent ?? line)
          .join('\n'),
        singleLine,
      )
      : cleanRenderedText(decodeHtmlEntitiesFallback(value), singleLine);
    // Handle double-encoded RSS HTML such as `&lt;p&gt;...&lt;/p&gt;`.
    return HTML_TAG_RE.test(decoded) ? parseHtmlToPlainText(decoded, singleLine) : decoded;
  }

  const parsed = parseHtmlToPlainText(value, singleLine);
  return HTML_TAG_RE.test(parsed) ? parseHtmlToPlainText(parsed, singleLine) : parsed;
};

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
    const title = formatNewsText(toText(record.title, MAX_TITLE_LENGTH), { singleLine: true });
    const url = sanitizeNewsUrl(record.url);
    if (!title || !url) continue;

    const id = toFiniteNumber(record.id) ?? fallbackId(url);
    if (seen.has(id)) continue;
    seen.add(id);

    const priority = toFiniteNumber(record.priority);
    items.push({
      id,
      title,
      body: formatNewsText(toText(record.body, MAX_BODY_LENGTH)).slice(0, MAX_BODY_LENGTH),
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
