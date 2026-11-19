import {
  buildBrokerLogoCandidates,
  getConfiguredBrokerLogoUrl,
  isPlaceholderBrokerLogoUrl,
} from '../components/BrokerLogoImage';
import { getRuntimeBrokerConfiguration } from '../config/backendTarget.js';
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
  const normalized = String(value || '').trim();
  if (!normalized || isPlaceholderBrokerLogoUrl(normalized)) return;
  if (!target.includes(normalized)) target.push(normalized);
};

export const isChartBackgroundLogoVisible = (
  settings: Pick<ChartProperties, 'showBackgroundLogo' | 'backgroundLogoMode'>,
): boolean => settings.showBackgroundLogo !== false && settings.backgroundLogoMode !== 'none';

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
  const configuredLogoUrl = getConfiguredBrokerLogoUrl(brokerId);

  const hasExplicitBrokerIdentity = Boolean(
    chromeLogoUrl
    || storedLogoUrl
    || configuredLogoUrl
    || runtimeConfigLogoUrl
    || chromeBrokerId
    || storedBrokerId,
  );
  if (!hasExplicitBrokerIdentity) {
    return [];
  }

  const candidates: string[] = [];
  appendUniqueUrl(candidates, configuredLogoUrl);
  appendUniqueUrl(candidates, runtimeConfigLogoUrl);

  const sharedSource = {
    broker_id: brokerId,
    server_url: serverUrl || undefined,
    backend_url: backendUrl || undefined,
  };

  if (chromeLogoUrl) {
    for (const candidate of buildBrokerLogoCandidates({ ...sharedSource, logo_url: chromeLogoUrl }, undefined, '')) {
      appendUniqueUrl(candidates, candidate);
    }
  }
  if (storedLogoUrl && storedLogoUrl !== chromeLogoUrl) {
    for (const candidate of buildBrokerLogoCandidates({ ...sharedSource, logo_url: storedLogoUrl }, undefined, '')) {
      appendUniqueUrl(candidates, candidate);
    }
  }
  if (!chromeLogoUrl && !storedLogoUrl && brokerId) {
    for (const candidate of buildBrokerLogoCandidates(sharedSource, undefined, '')) {
      appendUniqueUrl(candidates, candidate);
    }
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
