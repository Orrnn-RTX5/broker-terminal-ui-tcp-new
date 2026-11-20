import { getRuntimeBrokerConfiguration } from '../config/backendTarget.js';

/**
 * Web-TCP terminal (web-terminal-server serves the UI, `rtx5Electron.platform`
 * is 'web-tcp'): a browser can carry routing and tokens saved by an earlier
 * deployment (another host). config/api.ts snapshots those keys at import, so
 * every REST/WS/feed request would go off-origin and fail. This runs once,
 * before api.ts is evaluated, and only touches off-origin values.
 *
 * Imports backendTarget.js only (never api.ts / brokerSession) so it can run
 * ahead of them. One pass over a handful of localStorage keys, no hot path.
 */

const AUTH_KEYS = ['auth_token', 'refresh_token', 'token_expires_at'] as const;
const IDENTITY_KEYS = [
  'rtx_broker_server',
  'rtx_broker_server_identity_v1',
  'broker_name',
  'logo_url',
  'rtx_broker_presentation_v1',
] as const;
const IDENTITY_STORAGE_KEY = 'rtx_broker_server_identity_v1';
const REMOVE_ONLY_KEYS = ['feed_status_url', 'api_base_url'] as const;
const DYNAMIC_BROKER_LOGO_PATH_RE = /\/api\/v[12]\/brokers\/[^/]+\/logo$/i;

const toHttpOrigin = (value: string): string => {
  const raw = value.trim();
  if (!raw) return '';
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/\//, '')}`);
    const protocol = parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol;
    return `${protocol}//${parsed.host}`;
  } catch {
    return '';
  }
};

const isWebTcp = (): boolean => {
  const platform = (window as Window & { rtx5Electron?: { platform?: unknown } }).rtx5Electron?.platform;
  return platform === 'web-tcp';
};

const readIdentityBrokerId = (storage: Storage): string => {
  try {
    const parsed = JSON.parse(storage.getItem(IDENTITY_STORAGE_KEY) || 'null');
    return parsed && typeof parsed.brokerId === 'string' ? parsed.brokerId.trim() : '';
  } catch {
    return '';
  }
};

/** Returns true when stale off-origin state was rewritten. */
export const reconcileWebTcpRouting = (): boolean => {
  if (typeof window === 'undefined' || !isWebTcp()) return false;
  try {
    const storage = window.localStorage;
    const session = window.sessionStorage;
    const config = getRuntimeBrokerConfiguration() as {
      valid?: boolean; brokerId?: string; apiHost?: string; apiHostExt?: string; wsHost?: string;
    };
    const pageOrigin = window.location.origin;
    if (!config?.valid || !config.apiHost || toHttpOrigin(config.apiHost) !== pageOrigin) return false;

    const stale = (key: string): boolean => {
      const value = storage.getItem(key);
      return Boolean(value) && toHttpOrigin(value as string) !== pageOrigin;
    };
    const apiHost = config.apiHost;
    const wsBase = (config.wsHost || apiHost).replace(/\/+$/, '').replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    const replacements: Record<string, string> = {
      server_url: apiHost,
      backend_url: apiHost,
      market_api_url: config.apiHostExt || apiHost,
      ws_url: `${wsBase}/ws/v2`,
      feed_url: `${wsBase}/ws/feed`,
    };

    let rewritten = false;
    for (const key of Object.keys(replacements)) {
      if (stale(key)) { storage.setItem(key, replacements[key]); rewritten = true; }
    }
    for (const key of REMOVE_ONLY_KEYS) {
      if (stale(key)) { storage.removeItem(key); rewritten = true; }
    }
    // rtx_broker_server is usually a display label, but api.ts/client.ts fall back to it as the
    // server URL when server_url is empty: an explicit off-origin URL there is stale routing too.
    const brokerServer = (storage.getItem('rtx_broker_server') || '').trim();
    if (/^(https?|wss?):\/\//i.test(brokerServer) && toHttpOrigin(brokerServer) !== pageOrigin) {
      storage.removeItem('rtx_broker_server');
      rewritten = true;
    }

    const runtimeBrokerId = String(config.brokerId || '').trim();
    const identityBrokerId = readIdentityBrokerId(storage);
    const identityMismatch = Boolean(runtimeBrokerId && identityBrokerId && identityBrokerId !== runtimeBrokerId);
    if (rewritten) {
      for (const key of AUTH_KEYS) { storage.removeItem(key); session.removeItem(key); }
      if (runtimeBrokerId) {
        storage.setItem('broker_id', runtimeBrokerId);
        storage.setItem('rtx_broker_id', runtimeBrokerId);
      }
    }
    if (rewritten || identityMismatch) {
      for (const key of IDENTITY_KEYS) storage.removeItem(key);
    } else {
      // Clear stale off-origin dynamic broker logo URLs (e.g. old localhost or previous host)
      // without touching valid external CDN logos or active auth tokens.
      const storedLogo = (storage.getItem('logo_url') || '').trim();
      if (storedLogo && /^(https?):\/\//i.test(storedLogo)) {
        try {
          const parsedLogo = new URL(storedLogo);
          const isOffOriginDynamicLogo = parsedLogo.origin !== pageOrigin
            && DYNAMIC_BROKER_LOGO_PATH_RE.test(parsedLogo.pathname);
          const isStaleLoopbackLogo = parsedLogo.origin !== pageOrigin
            && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsedLogo.hostname);
          if (isOffOriginDynamicLogo || isStaleLoopbackLogo) {
            storage.removeItem('logo_url');
            storage.removeItem('rtx_broker_presentation_v1');
          }
        } catch {
          // Ignore malformed logo URLs.
        }
      }
    }
    return rewritten;
  } catch {
    return false;
  }
};
