import { TIMEFRAME_STORAGE_KEY } from '../utils/chartTimeframePersistence';

/**
 * Session-scoped workspace view persistence.
 *
 * - Survives page refreshes (F5 / Cmd+R) via `sessionStorage`.
 * - Automatically clears when the browser tab or desktop app is closed and
 *   reopened (empty `sessionStorage` triggers `reconcileFreshAppLaunch()`).
 * - Explicitly resets to defaults when the user triggers Reset Layout.
 */
export const APP_SESSION_ALIVE_KEY = 'rtx5_app_session_alive';
export const WORKSPACE_VIEW_RESET_EVENT = 'rtx:reset-workspace-view';

export const SESSION_VIEW_KEYS = {
  bottomDockTab: 'rtx5_session_bottomdock_tab',
  tradeView: 'rtx5_session_trade_view',
  historyView: 'rtx5_session_history_view',
  historyPeriod: 'rtx5_session_history_period',
  historySymbolFilter: 'rtx5_session_history_symbol_filter',
  historyCustomPeriod: 'rtx5_session_history_custom_period',
  marketWatchView: 'rtx5_session_mw_view',
  marketWatchSort: 'rtx5_session_mw_sort',
  oneClickHidden: 'rtx5_session_one_click_hidden',
  chartObjectState: 'rtx5_session_chart_object_state',
  maximizedPanelId: 'rtx5_session_maximized_panel_id',
  navigatorSections: 'rtx5_session_navigator_sections',
  floatingPanels: 'rtx5_session_floating_panels',
  lastSymbolPanelVisible: 'rtx5_session_last_symbol_panel_visible',
} as const;

const RESETTABLE_LOCAL_VIEW_KEYS = [
  TIMEFRAME_STORAGE_KEY,
  'rtx5_chart_type',
  'bottomdock-active-tab',
] as const;

const getSessionStorage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
};

const getLocalStorage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

export const readSessionString = <T extends string>(
  key: string,
  allowedValues: readonly T[],
  fallback: T,
): T => {
  const storage = getSessionStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (raw !== null && (allowedValues as readonly string[]).includes(raw)) {
      return raw as T;
    }
  } catch {
    // Ignore storage read errors
  }
  return fallback;
};

export const readSessionRaw = (key: string): string | null => {
  const storage = getSessionStorage();
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

export const writeSessionString = (key: string, value: string | null): void => {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    if (value === null) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, value);
    }
  } catch {
    // Ignore storage write errors
  }
};

export const readSessionBoolean = (key: string, fallback: boolean): boolean => {
  const raw = readSessionRaw(key);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
};

export const writeSessionBoolean = (key: string, value: boolean): void => {
  writeSessionString(key, String(value));
};

export const readSessionJson = <T>(key: string, fallback: T): T => {
  const raw = readSessionRaw(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return fallback;
  }
};

export const writeSessionJson = (key: string, value: unknown): void => {
  if (value === null || value === undefined) {
    writeSessionString(key, null);
    return;
  }
  try {
    writeSessionString(key, JSON.stringify(value));
  } catch {
    // Ignore serialization errors
  }
};

export const clearAllSessionViewState = (): void => {
  const storage = getSessionStorage();
  if (!storage) return;
  for (const key of Object.values(SESSION_VIEW_KEYS)) {
    try {
      storage.removeItem(key);
    } catch {
      // Ignore storage removal errors
    }
  }
};

export const clearResettableLocalViewState = (): void => {
  const storage = getLocalStorage();
  if (!storage) return;
  for (const key of RESETTABLE_LOCAL_VIEW_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Ignore storage removal errors
    }
  }
};

/**
 * Runs once on application startup (`src/main.tsx`).
 *
 * - Page refresh: `sessionStorage` already holds `APP_SESSION_ALIVE_KEY === '1'`,
 *   so all active view state (tabs, timeframe, chart type, toggles, floating panels)
 *   is preserved.
 * - Fresh launch / close & reopen: `sessionStorage` is empty, so transient view
 *   defaults in `localStorage` (`rtx5_timeframe`, `rtx5_chart_type`,
 *   `bottomdock-active-tab`) are cleared and the terminal opens in its default view.
 */
export const reconcileFreshAppLaunch = (): boolean => {
  const storage = getSessionStorage();
  if (!storage) return false;
  try {
    if (storage.getItem(APP_SESSION_ALIVE_KEY) === '1') {
      return false;
    }
    storage.setItem(APP_SESSION_ALIVE_KEY, '1');
  } catch {
    return false;
  }
  clearAllSessionViewState();
  clearResettableLocalViewState();
  return true;
};

export const dispatchWorkspaceViewReset = (): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_VIEW_RESET_EVENT));
};

export const subscribeWorkspaceViewReset = (handler: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(WORKSPACE_VIEW_RESET_EVENT, handler);
  return () => window.removeEventListener(WORKSPACE_VIEW_RESET_EVENT, handler);
};
