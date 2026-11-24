export const DEFAULT_COMPANY_URL = 'https://orrnn.com';

const MAX_COMPANY_URL_LENGTH = 2048;

interface DesktopBridgeWindow extends Window {
    rtx5Electron?: { isDesktop?: unknown; platform?: unknown };
    electronAPI?: { isDesktop?: unknown; platform?: unknown };
    electron?: { shell?: { openExternal?: unknown }; window?: unknown };
}

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

/**
 * Returns true only inside the native desktop executable (.exe / desktop clientcore / Electron),
 * and false on the web terminal (including web-tcp at https://webterminal.orrnn.com) and normal browsers.
 */
export function isDesktopExeRuntime(): boolean {
    if (typeof window === 'undefined') return false;
    const w = window as DesktopBridgeWindow;
    const platform = w.rtx5Electron?.platform ?? w.electronAPI?.platform;
    if (platform === 'web-tcp') return false;
    if (typeof platform === 'string' && platform.trim() !== '') {
        return true;
    }
    if (typeof w.electron?.shell?.openExternal === 'function') {
        return true;
    }
    if (w.location?.protocol === 'file:') {
        return true;
    }
    if (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)) {
        return true;
    }
    return false;
}

/** Opens the company website in a new browser page/window (used in desktop .exe runtime). */
export function openCompanyInNewPage(url: string = DEFAULT_COMPANY_URL): void {
    if (typeof window === 'undefined') return;
    const safeUrl = sanitizeCompanyUrl(url);
    if (!safeUrl) return;
    const openExternal = (window as DesktopBridgeWindow).electron?.shell?.openExternal;
    if (typeof openExternal === 'function') {
        void (openExternal as (target: string) => unknown)(safeUrl);
        return;
    }
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
}
