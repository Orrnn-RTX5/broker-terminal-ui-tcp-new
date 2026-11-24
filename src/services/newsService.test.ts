import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: getMock } };
});

import { fetchNews, formatNewsText, mapNewsError, normalizeNewsResponse, NewsServiceError, sanitizeNewsUrl } from './newsService';

const item = (over: Record<string, unknown> = {}) => ({
  id: 1, title: 'Hello', body: 'b', source: 'Src', category: 'Forex', currency: 'usd',
  priority: 1, published_at: 1763860000000, fetched_at: 1763860005000, url: 'https://example.com/a', ...over,
});

describe('normalizeNewsResponse', () => {
  it('maps valid items and coerces numbers', () => {
    const [n] = normalizeNewsResponse({ count: 1, items: [item({ id: '7', priority: '2', published_at: '123' })] });
    expect(n).toMatchObject({ id: 7, priority: 2, publishedAt: 123, category: 'forex', currency: 'USD', url: 'https://example.com/a' });
  });
  it('drops items without title or with non-http urls', () => {
    const out = normalizeNewsResponse({ items: [
      item({ id: 1, title: '  ' }), item({ id: 2, url: 'javascript:alert(1)' }), item({ id: 3, url: 'ftp://x/y' }),
      item({ id: 4, url: '' }), item({ id: 5, url: undefined }), item({ id: 6 }), null, 'x',
    ] });
    expect(out.map((i) => i.id)).toEqual([6]);
  });
  it('caps at 200, dedupes ids and ignores unknown fields', () => {
    const many = Array.from({ length: 300 }, (_, i) => item({ id: i + 1, extra: 'x' }));
    const out = normalizeNewsResponse({ items: [...many, item({ id: 1 })] });
    expect(out).toHaveLength(200);
    expect(out[0]).not.toHaveProperty('extra');
  });
  it('returns [] for malformed payloads', () => {
    expect(normalizeNewsResponse(null)).toEqual([]);
    expect(normalizeNewsResponse({ items: 'x' })).toEqual([]);
  });
  it('sanitizes urls', () => {
    expect(sanitizeNewsUrl('http://a.com/x')).toBe('http://a.com/x');
    expect(sanitizeNewsUrl('data:text/html,1')).toBeNull();
    expect(sanitizeNewsUrl(5)).toBeNull();
  });
  it('converts RSS HTML markup and entities into clean plain text without losing structure', () => {
    const htmlBody = '<ul><li>Germany November Ifo business climate index 90.6 vs 90.5 expected</li><li>Prior 90.2; revised to 90.1</li></ul><p style="text-align: justify" class="text-align-justify">Well, at least Germany is giving the euro something to smile about.</p><p>Of note, Ifo says that the&nbsp;improved situation goes&nbsp;hand in hand.</p>';
    const [n] = normalizeNewsResponse({
      items: [item({ title: 'Fed&apos;s Powell &amp; <b>ECB</b> outlook', body: htmlBody })],
    });
    expect(n.title).toBe("Fed's Powell & ECB outlook");
    expect(n.body).toBe(
      '• Germany November Ifo business climate index 90.6 vs 90.5 expected\n'
      + '• Prior 90.2; revised to 90.1\n\n'
      + 'Well, at least Germany is giving the euro something to smile about.\n\n'
      + 'Of note, Ifo says that the improved situation goes hand in hand.',
    );
    expect(formatNewsText('EUR/USD < 1.10\nUSD/JPY > 150')).toBe('EUR/USD < 1.10\nUSD/JPY > 150');
    expect(formatNewsText('&lt;p&gt;Double &amp;nbsp; encoded&lt;/p&gt;')).toBe('Double encoded');
    expect(formatNewsText('<script>alert(1)</script><style>body{}</style><p>Safe <b>text</b></p>')).toBe('Safe text');
    expect(formatNewsText('<ol><li>First</li><li>Second</li></ol>')).toBe('1. First\n2. Second');

    vi.stubGlobal('DOMParser', undefined);
    try {
      expect(formatNewsText(htmlBody)).toBe(n.body);
      expect(formatNewsText('<script>alert(1)</script><p>Safe &amp; clean&nbsp;copy</p>')).toBe('Safe & clean copy');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('fetchNews', () => {
  beforeEach(() => getMock.mockReset());
  it('requests /api/v1/news with limit and no auth', async () => {
    getMock.mockResolvedValue({ count: 1, items: [item()] });
    const ctrl = new AbortController();
    const out = await fetchNews({ limit: 999, currency: 'EUR', signal: ctrl.signal });
    expect(out).toHaveLength(1);
    const [path, opts] = getMock.mock.calls[0];
    expect(path).toBe('/api/v1/news');
    expect(opts.params).toEqual({ limit: 200, currency: 'EUR' });
    expect(opts.skipAuth).toBe(true);
    expect(opts.signal).toBe(ctrl.signal);
  });
  it.each([404, 502, 503])('maps %i to unavailable', async (status) => {
    getMock.mockRejectedValueOnce(new ApiError(status, 'x'));
    const err = await fetchNews().catch((e) => e);
    expect(err).toBeInstanceOf(NewsServiceError);
    expect(err.kind).toBe('unavailable');
    expect(err.status).toBe(status);
  });
  it('maps 500 and network errors to failed', async () => {
    getMock.mockRejectedValueOnce(new ApiError(500, 'internal'));
    await expect(fetchNews()).rejects.toMatchObject({ kind: 'failed', status: 500 });
    getMock.mockRejectedValueOnce(new Error('net'));
    const err = await fetchNews().catch((e) => e);
    expect(err).toBeInstanceOf(NewsServiceError);
    expect(mapNewsError(err).kind).toBe('failed');
  });
});
