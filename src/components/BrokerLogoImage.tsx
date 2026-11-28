import { useMemo, useState, type ReactEventHandler, type ReactNode } from 'react';
import { normalizeBrokerServerUrl } from '../config/api';
import {
  getBackendTarget,
  getRuntimeDiscoveryBaseUrl,
  getRuntimeBrokerConfiguration,
  isDesktopBackendTarget,
} from '../config/backendTarget.js';
import { toPublicAssetPath } from './welcomeHeroAssets';

export interface BrokerLogoSource {
  broker_id?: string | number;
  broker_name?: string;
  logo_url?: string;
  server_url?: string;
  backend_url?: string;
  market_api_url?: string;
  public_backend_url?: string;
  public_ext_api_url?: string;
  web_backend_url?: string;
  web_ext_api_url?: string;
  API_HOST?: string;
  API_HOST_EXT?: string;
  api_host?: string;
  api_host_ext?: string;
}

// Neutral generic app icon (no vendor brand); a configured broker logo always comes first.
// eslint-disable-next-line react-refresh/only-export-components -- shared fallback logo constant co-located with BrokerLogoImage
export const APP_FALLBACK_LOGO_SRC = toPublicAssetPath('brand/terminal-icon.png');
const ABSOLUTE_IMAGE_URL = /^(?:https?:|data:|blob:)/i;

const appendUnique = (values: string[], value: unknown): void => {
  const normalized = String(value || '').trim();
  if (normalized && !values.includes(normalized)) values.push(normalized);
};

const normalizeLogoBaseUrl = (value: unknown): string => {
  const normalized = normalizeBrokerServerUrl(String(value || '').trim());
  return normalized.replace(/\/+$/, '');
};

// eslint-disable-next-line react-refresh/only-export-components -- logo URL helper co-located with BrokerLogoImage for non-component callers
export const isPlaceholderBrokerLogoUrl = (value: unknown): boolean =>
  /(?:^|\/)(?:assets\/logo\.png|brand\/terminal-icon\.png|brand\/rtx5-app-icon\.png)(?:[?#].*)?$/i.test(String(value || '').trim());

/** Deployment branding belongs only to its configured web broker. */
// eslint-disable-next-line react-refresh/only-export-components -- configured broker logo lookup helper co-located with BrokerLogoImage
export const getConfiguredBrokerLogoUrl = (brokerId: string | number | null | undefined): string => {
  if (isDesktopBackendTarget()) return '';
  const config = getRuntimeBrokerConfiguration();
  const logoUrl = config.valid && String(brokerId || '').trim() === config.brokerId
    ? config.brokerLogoUrl : '';
  return isPlaceholderBrokerLogoUrl(logoUrl) ? '' : logoUrl;
};

// eslint-disable-next-line react-refresh/only-export-components -- broker directory logo URL builder co-located with BrokerLogoImage
export const buildBrokerDirectoryLogoUrl = (
  brokerId: string | number | null | undefined,
  discoveryBaseUrl = getRuntimeDiscoveryBaseUrl(),
): string => {
  const normalizedBrokerId = String(brokerId || '').trim();
  const discoveryBase = normalizeLogoBaseUrl(discoveryBaseUrl);
  if (!normalizedBrokerId || !discoveryBase) return '';
  return `${discoveryBase}/api/v1/brokers/${encodeURIComponent(normalizedBrokerId)}/logo`;
};

const DYNAMIC_BROKER_LOGO_PATH_RE = /\/api\/v[12]\/brokers\/[^/]+\/logo$/i;

/** Upgrade same-host http:// asset URLs to https:// on TLS pages (e.g. behind reverse proxies). */
// eslint-disable-next-line react-refresh/only-export-components -- URL protocol normalizer helper co-located with BrokerLogoImage
export const normalizeSameOriginHttpsUrl = (value: string): string => {
  const trimmed = String(value || '').trim();
  if (!trimmed || typeof window === 'undefined' || window.location?.protocol !== 'https:') {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' && parsed.host === window.location.host) {
      parsed.protocol = 'https:';
      return parsed.toString();
    }
  } catch {
    // Keep non-URL values unchanged.
  }
  return trimmed;
};

const hasLogoVersionQuery = (parsed: URL): boolean =>
  Boolean(parsed.searchParams.get('v') || parsed.searchParams.get('version') || parsed.searchParams.get('t'));

/** Append `?v=<version>` to dynamic/remote broker logo URLs when not already versioned. */
// eslint-disable-next-line react-refresh/only-export-components -- cache-busting logo URL helper co-located with BrokerLogoImage
export const appendBrokerLogoVersionParam = (rawUrl: unknown, versionHint?: unknown): string => {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed || isPlaceholderBrokerLogoUrl(trimmed)) return '';
  const version = String(versionHint || '').trim();
  if (!version || /^(?:data:|blob:)/i.test(trimmed)) return trimmed;
  try {
    const base = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://broker.local';
    const parsed = new URL(trimmed, base);
    if (hasLogoVersionQuery(parsed)) return trimmed;
    const sep = trimmed.includes('?') ? '&' : '?';
    return `${trimmed}${sep}v=${encodeURIComponent(version)}`;
  } catch {
    return trimmed;
  }
};

// eslint-disable-next-line react-refresh/only-export-components -- logo version query check helper co-located with BrokerLogoImage
export const hasBrokerLogoVersionQuery = (rawUrl: unknown): boolean =>
  /[?&](?:v|version|t)=[^&]+/i.test(String(rawUrl || '').trim());

/**
 * Prefer a live versioned server/directory logo over a static deploy-time
 * BROKER_LOGO_URL when both target the same broker logo route or the live URL
 * adds a cache-busting version token to an unversioned dynamic endpoint.
 */
// eslint-disable-next-line react-refresh/only-export-components -- logo precedence helper co-located with BrokerLogoImage
export const shouldPreferDynamicLogoOverConfigured = (
  configuredUrl: unknown,
  dynamicUrl: unknown,
): boolean => {
  const configured = String(configuredUrl || '').trim();
  const dynamic = String(dynamicUrl || '').trim();
  if (!configured || !dynamic || isPlaceholderBrokerLogoUrl(dynamic)) return false;
  if (configured === dynamic) return false;

  try {
    const base = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://broker.local';
    const parsedConfigured = new URL(configured, base);
    const parsedDynamic = new URL(dynamic, base);
    const samePathname = parsedConfigured.pathname.replace(/\/+$/, '').toLowerCase()
      === parsedDynamic.pathname.replace(/\/+$/, '').toLowerCase();
    if (samePathname && parsedDynamic.search !== parsedConfigured.search) {
      return hasLogoVersionQuery(parsedDynamic) || !hasLogoVersionQuery(parsedConfigured);
    }
    if (
      DYNAMIC_BROKER_LOGO_PATH_RE.test(parsedDynamic.pathname)
      && hasLogoVersionQuery(parsedDynamic)
      && DYNAMIC_BROKER_LOGO_PATH_RE.test(parsedConfigured.pathname)
      && !hasLogoVersionQuery(parsedConfigured)
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
};

// eslint-disable-next-line react-refresh/only-export-components -- logo candidate list builder co-located with BrokerLogoImage
export const buildBrokerLogoCandidates = (
  broker: BrokerLogoSource | null | undefined,
  discoveryBaseUrl = getRuntimeDiscoveryBaseUrl(),
  appFallbackUrl = APP_FALLBACK_LOGO_SRC,
): string[] => {
  if (!broker) return appFallbackUrl ? [appFallbackUrl] : [];

  const configuredLogoUrl = normalizeSameOriginHttpsUrl(getConfiguredBrokerLogoUrl(broker.broker_id));
  const explicitUrls: string[] = [];
  const rawLogoUrl = String(broker.logo_url || '').trim();
  const hasUsableLogoUrl = Boolean(rawLogoUrl) && !isPlaceholderBrokerLogoUrl(rawLogoUrl);

  const baseCandidates = [
    broker.server_url,
    broker.backend_url,
    broker.market_api_url,
    broker.public_backend_url,
    broker.public_ext_api_url,
    broker.web_backend_url,
    broker.web_ext_api_url,
    broker.API_HOST,
    broker.API_HOST_EXT,
    broker.api_host,
    broker.api_host_ext,
  ].filter(value => String(value || '').trim());
  if (baseCandidates.length === 0) baseCandidates.push(getBackendTarget());

  if (hasUsableLogoUrl && ABSOLUTE_IMAGE_URL.test(rawLogoUrl)) {
    appendUnique(explicitUrls, normalizeSameOriginHttpsUrl(rawLogoUrl));
  } else if (hasUsableLogoUrl && rawLogoUrl.startsWith('//')) {
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'http:' ? 'http:' : 'https:';
    appendUnique(explicitUrls, `${protocol}${rawLogoUrl}`);
  } else if (hasUsableLogoUrl) {
    for (const baseValue of baseCandidates) {
      const baseUrl = normalizeLogoBaseUrl(baseValue);
      if (!baseUrl) continue;
      try {
        appendUnique(explicitUrls, normalizeSameOriginHttpsUrl(new URL(rawLogoUrl, `${baseUrl}/`).toString()));
      } catch {
        // Try the next broker base before falling back to directory branding.
      }
    }
  }

  const candidates: string[] = [];
  const preferExplicitOverConfigured = explicitUrls.some(
    url => shouldPreferDynamicLogoOverConfigured(configuredLogoUrl, url),
  );
  if (preferExplicitOverConfigured) {
    explicitUrls.forEach(url => appendUnique(candidates, url));
    appendUnique(candidates, configuredLogoUrl);
  } else {
    appendUnique(candidates, configuredLogoUrl);
    explicitUrls.forEach(url => appendUnique(candidates, url));
  }

  const directoryLogoUrl = normalizeSameOriginHttpsUrl(
    buildBrokerDirectoryLogoUrl(broker.broker_id, discoveryBaseUrl),
  );
  appendUnique(candidates, directoryLogoUrl);
  if (!directoryLogoUrl && String(broker.broker_id || '').trim()) {
    const encodedId = encodeURIComponent(String(broker.broker_id || '').trim());
    for (const baseValue of baseCandidates) {
      const baseUrl = normalizeLogoBaseUrl(baseValue);
      if (!baseUrl) continue;
      appendUnique(candidates, normalizeSameOriginHttpsUrl(`${baseUrl}/api/v1/brokers/${encodedId}/logo`));
    }
    if (
      candidates.length === 0
      && typeof window !== 'undefined'
      && window.location?.origin
      && /^https?:/i.test(window.location.protocol)
    ) {
      appendUnique(candidates, `${window.location.origin}/api/v1/brokers/${encodedId}/logo`);
    }
  }

  appendUnique(candidates, appFallbackUrl);
  return candidates;
};

interface BrokerLogoImageProps {
  broker: BrokerLogoSource | null | undefined;
  alt?: string;
  className?: string;
  decoding?: 'async' | 'auto' | 'sync';
  fallback?: ReactNode;
  appFallbackUrl?: string;
  onLoad?: ReactEventHandler<HTMLImageElement>;
  onExhausted?: () => void;
}

export function BrokerLogoImage({
  broker,
  alt = '',
  className,
  decoding = 'async',
  fallback = null,
  appFallbackUrl,
  onLoad,
  onExhausted,
}: BrokerLogoImageProps) {
  const candidates = useMemo(() => buildBrokerLogoCandidates(broker, undefined, appFallbackUrl), [broker, appFallbackUrl]);
  const candidateSignature = candidates.join('\n');
  const [attempt, setAttempt] = useState({ signature: candidateSignature, index: 0 });
  const candidateIndex = attempt.signature === candidateSignature ? attempt.index : 0;

  const src = candidates[candidateIndex];
  if (!src) return fallback;

  return (
    <img
      key={src}
      src={src}
      alt={alt}
      className={className}
      decoding={decoding}
      draggable={false}
      onLoad={onLoad}
      onError={() => {
        const nextIndex = candidateIndex + 1;
        setAttempt({ signature: candidateSignature, index: nextIndex });
        if (!candidates[nextIndex]) {
          onExhausted?.();
        }
      }}
    />
  );
}
