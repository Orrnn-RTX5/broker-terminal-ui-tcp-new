import {
  appendBrokerLogoVersionParam,
  buildBrokerLogoCandidates,
  getConfiguredBrokerLogoUrl,
  isPlaceholderBrokerLogoUrl,
  normalizeSameOriginHttpsUrl,
  shouldPreferDynamicLogoOverConfigured,
} from '../components/BrokerLogoImage';
import { getRuntimeBrokerConfiguration } from '../config/backendTarget.js';
import { getCachedBrokerDirectory } from '../services/brokerDirectory';
import { BROKER_CHROME_EVENT, getBrokerChrome } from '../services/brokerPresentation';
import { useChartSettingsStore, type ChartProperties } from '../store/useChartSettingsStore';

const BROKER_WATERMARK_STORAGE_KEYS = new Set([
  'logo_url',
  'broker_id',
  'rtx_broker_id',
  'server_url',
  'backend_url',
]);

const readStoredValue = (key: string): string => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return '';
  }
  try {
    return String(window.localStorage.getItem(key) || '').trim();
  } catch {
    return '';
  }
};

const appendUniqueUrl = (target: string[], value: unknown): void => {
  const normalized = normalizeSameOriginHttpsUrl(String(value || '').trim());
  if (!normalized || isPlaceholderBrokerLogoUrl(normalized)) return;
  if (!target.includes(normalized)) target.push(normalized);
};

export const isChartBackgroundLogoVisible = (
  settings: Pick<ChartProperties, 'showBackgroundLogo' | 'backgroundLogoMode'>,
): boolean => settings.showBackgroundLogo === true && settings.backgroundLogoMode !== 'none';

export const setChartBackgroundLogoVisibility = (
  symbol: string | undefined,
  visible: boolean,
): boolean => {
  const store = useChartSettingsStore.getState();
  const normalizedSymbol = symbol?.trim();
  const current = normalizedSymbol
    ? (store.symbolProperties[normalizedSymbol] || store.globalProperties)
    : store.globalProperties;
  const restoredMode = current.backgroundLogoMode && current.backgroundLogoMode !== 'none'
    ? current.backgroundLogoMode
    : 'default';
  const nextMode = visible ? restoredMode : 'none';

  if (normalizedSymbol) {
    store.updateSymbolProperty(normalizedSymbol, 'showBackgroundLogo', visible);
    store.updateSymbolProperty(normalizedSymbol, 'backgroundLogoMode', nextMode);
  } else {
    store.updateGlobalProperty('showBackgroundLogo', visible);
    store.updateGlobalProperty('backgroundLogoMode', nextMode);
  }
  return visible;
};

export const toggleChartBackgroundLogoInStore = (symbol?: string): boolean => {
  const store = useChartSettingsStore.getState();
  const normalizedSymbol = symbol?.trim();
  const current = normalizedSymbol
    ? (store.symbolProperties[normalizedSymbol] || store.globalProperties)
    : store.globalProperties;
  const next = !isChartBackgroundLogoVisible(current);
  return setChartBackgroundLogoVisibility(normalizedSymbol, next);
};

/**
 * Resolves ordered logo URL candidates for the currently active broker without
 * returning placeholder assets, so the chart background watermark uses broker
 * branding first and falls back only on load failure.
 */
export const resolveActiveBrokerWatermarkCandidates = (): string[] => {
  const chrome = getBrokerChrome();
  const chromeLogoUrl = isPlaceholderBrokerLogoUrl(chrome.logoUrl) ? '' : String(chrome.logoUrl || '').trim();
  const chromeBrokerId = String(chrome.brokerId || '').trim();
  const storedBrokerId = readStoredValue('broker_id') || readStoredValue('rtx_broker_id');
  const storedLogoUrlRaw = readStoredValue('logo_url');
  const storedLogoUrl = isPlaceholderBrokerLogoUrl(storedLogoUrlRaw) ? '' : storedLogoUrlRaw;
  const serverUrl = readStoredValue('server_url');
  const backendUrl = readStoredValue('backend_url');

  let runtimeConfigLogoUrl = '';
  let runtimeBrokerId = '';
  try {
    const config = getRuntimeBrokerConfiguration() as {
      valid?: boolean;
      brokerId?: string;
      brokerLogoUrl?: string;
    } | null;
    if (config?.valid) {
      runtimeBrokerId = String(config.brokerId || '').trim();
      const rawLogo = String(config.brokerLogoUrl || '').trim();
      runtimeConfigLogoUrl = isPlaceholderBrokerLogoUrl(rawLogo) ? '' : rawLogo;
    }
  } catch {
    // Runtime broker configuration can be absent in isolated unit tests.
  }

  const brokerId = chromeBrokerId || storedBrokerId || runtimeBrokerId;
  const configuredLogoUrl = normalizeSameOriginHttpsUrl(getConfiguredBrokerLogoUrl(brokerId));
  const normalizedRuntimeLogoUrl = normalizeSameOriginHttpsUrl(runtimeConfigLogoUrl);

  const cachedDirectory = (() => {
    try {
      return getCachedBrokerDirectory() || [];
    } catch {
      return [];
    }
  })();
  const matchedDirectoryBroker = brokerId
    ? cachedDirectory.find((entry) => String(entry.broker_id || '').trim() === brokerId)
    : undefined;
  const directoryLogoUrl = appendBrokerLogoVersionParam(
    matchedDirectoryBroker?.logo_url,
    (matchedDirectoryBroker as { logo_version?: string; logo_updated_at?: string } | undefined)?.logo_version
    || (matchedDirectoryBroker as { logo_updated_at?: string } | undefined)?.logo_updated_at,
  );

  const hasExplicitBrokerIdentity = Boolean(
    chromeLogoUrl
    || storedLogoUrl
    || directoryLogoUrl
    || configuredLogoUrl
    || normalizedRuntimeLogoUrl
    || chromeBrokerId
    || storedBrokerId
    || runtimeBrokerId,
  );
  if (!hasExplicitBrokerIdentity) {
    return [];
  }

  const sharedSource = {
    broker_id: brokerId,
    server_url: serverUrl || matchedDirectoryBroker?.server_url || undefined,
    backend_url: backendUrl || undefined,
  };

  const liveDynamicCandidates: string[] = [];
  for (const liveLogo of [chromeLogoUrl, directoryLogoUrl, storedLogoUrl]) {
    if (!liveLogo) continue;
    for (const candidate of buildBrokerLogoCandidates({ ...sharedSource, logo_url: liveLogo }, undefined, '')) {
      appendUniqueUrl(liveDynamicCandidates, candidate);
    }
  }
  if (liveDynamicCandidates.length === 0 && brokerId) {
    for (const candidate of buildBrokerLogoCandidates(sharedSource, undefined, '')) {
      appendUniqueUrl(liveDynamicCandidates, candidate);
    }
  }

  const staticConfigured = configuredLogoUrl || normalizedRuntimeLogoUrl;
  const preferLiveOverConfigured = liveDynamicCandidates.some(
    (candidate) => shouldPreferDynamicLogoOverConfigured(staticConfigured, candidate),
  );

  const candidates: string[] = [];
  if (preferLiveOverConfigured) {
    liveDynamicCandidates.forEach((candidate) => appendUniqueUrl(candidates, candidate));
    appendUniqueUrl(candidates, configuredLogoUrl);
    appendUniqueUrl(candidates, normalizedRuntimeLogoUrl);
  } else {
    appendUniqueUrl(candidates, configuredLogoUrl);
    appendUniqueUrl(candidates, normalizedRuntimeLogoUrl);
    liveDynamicCandidates.forEach((candidate) => appendUniqueUrl(candidates, candidate));
  }

  return candidates;
};

export const getPrimaryBrokerWatermarkUrl = (): string | undefined =>
  resolveActiveBrokerWatermarkCandidates()[0];

export const subscribeBrokerWatermarkChanges = (listener: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const handleChromeChange = () => listener();
  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === null || BROKER_WATERMARK_STORAGE_KEYS.has(event.key)) {
      listener();
    }
  };
  window.addEventListener(BROKER_CHROME_EVENT, handleChromeChange);
  window.addEventListener('storage', handleStorageChange);
  return () => {
    window.removeEventListener(BROKER_CHROME_EVENT, handleChromeChange);
    window.removeEventListener('storage', handleStorageChange);
  };
};
