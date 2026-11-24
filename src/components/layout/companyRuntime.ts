export const DEFAULT_COMPANY_URL = 'https://orrnn.com';

const MAX_COMPANY_URL_LENGTH = 2048;

/** Returns the normalized URL only for absolute http(s) links without embedded credentials. */
export function sanitizeCompanyUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_COMPANY_URL_LENGTH) return null;
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
        return parsed.href;
    } catch {
        return null;
    }
}
