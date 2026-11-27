// The terminal's saved theme choice. Light is the default theme: with no saved
// choice the terminal starts light, and an install that still carries a theme
// saved before light became the default is moved to light once. Every choice
// made after that is kept.
//
// Earlier builds wrote their dark default into storage on first load, so a
// stored "dark" from before the move cannot be told apart from a deliberate
// choice; that is why the move replaces it instead of reading it.
//
// index.html repeats this logic inline so the first paint already has the
// right theme. Keep the two in step (savedTheme.test.ts checks the keys).

export const SAVED_THEME_LIGHT_KEY = 'rtx5-advanced-view-enabled';
export const SAVED_THEME_NAME_KEY = 'rtx5-theme';
export const THEME_APPEARANCE_STORAGE_KEY = 'rtx5-theme-appearance';
export const LIGHT_DEFAULT_ADOPTED_KEY = 'rtx5-default-light-theme-v1';

const adoptLightDefaultOnce = (storage: Storage): void => {
  if (storage.getItem(LIGHT_DEFAULT_ADOPTED_KEY) === '1') return;

  storage.setItem(SAVED_THEME_LIGHT_KEY, 'true');
  storage.setItem(SAVED_THEME_NAME_KEY, 'light');

  // The appearance record carries its own mode; leave its colours untouched.
  const rawAppearance = storage.getItem(THEME_APPEARANCE_STORAGE_KEY);
  if (rawAppearance) {
    try {
      const appearance = JSON.parse(rawAppearance) as { state?: unknown } | null;
      const record = appearance && typeof appearance.state === 'object' && appearance.state !== null
        ? appearance.state
        : appearance;
      if (record && typeof record === 'object') {
        (record as { themeMode?: string }).themeMode = 'light';
        storage.setItem(THEME_APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
      }
    } catch {
      // An unreadable record already loads as the defaults.
    }
  }

  // Last, so an interrupted move runs again on the next read.
  storage.setItem(LIGHT_DEFAULT_ADOPTED_KEY, '1');
};

/** Whether the terminal should be in the light theme. Light unless dark was chosen. */
export const isSavedThemeLight = (): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    adoptLightDefaultOnce(localStorage);
    const savedLight = localStorage.getItem(SAVED_THEME_LIGHT_KEY);
    const savedName = localStorage.getItem(SAVED_THEME_NAME_KEY);
    if (savedLight === 'true' || savedName === 'light') return true;
    return savedLight === null && savedName === null;
  } catch {
    // Storage can be unavailable in hardened browser contexts.
    return true;
  }
};
