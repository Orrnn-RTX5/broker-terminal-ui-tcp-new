// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSavedThemeLight,
  LIGHT_DEFAULT_ADOPTED_KEY,
  SAVED_THEME_LIGHT_KEY,
  SAVED_THEME_NAME_KEY,
  THEME_APPEARANCE_STORAGE_KEY,
} from './savedTheme';
import { RTX_THEME_APPEARANCE_STORAGE_KEY } from './themePresets';

const useStorage = (entries: Record<string, string>) => {
  const store = new Map(Object.entries(entries));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
  });
  return store;
};

const adopted = { [LIGHT_DEFAULT_ADOPTED_KEY]: '1' };
const savedDark = { [SAVED_THEME_LIGHT_KEY]: 'false', [SAVED_THEME_NAME_KEY]: 'dark' };
const darkAppearance = {
  themeMode: 'dark',
  contrast: 'strong',
  light: { preset: 'solarized-light', background: '#FDF6E3', foreground: '#586E75', accent: '#268BD2' },
  dark: { preset: 'vesper', background: '#101010', foreground: '#FFFFFF', accent: '#FFC799' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saved theme: Light is the default', () => {
  it('is light with nothing saved, and saves light as the choice', () => {
    const store = useStorage({});

    expect(isSavedThemeLight()).toBe(true);
    expect(Object.fromEntries(store)).toEqual({
      [SAVED_THEME_LIGHT_KEY]: 'true',
      [SAVED_THEME_NAME_KEY]: 'light',
      [LIGHT_DEFAULT_ADOPTED_KEY]: '1',
    });
  });

  it('moves a theme saved before the light default to light once, then keeps a dark choice', () => {
    const store = useStorage(savedDark);

    expect(isSavedThemeLight()).toBe(true);
    expect(store.get(SAVED_THEME_NAME_KEY)).toBe('light');

    // Choosing dark afterwards sticks, however many times it is read.
    store.set(SAVED_THEME_LIGHT_KEY, 'false');
    store.set(SAVED_THEME_NAME_KEY, 'dark');
    expect(isSavedThemeLight()).toBe(false);
    expect(isSavedThemeLight()).toBe(false);
    expect(store.get(SAVED_THEME_NAME_KEY)).toBe('dark');
  });

  it('switches the saved appearance record to light without touching its colours or contrast', () => {
    const store = useStorage({ ...savedDark, [THEME_APPEARANCE_STORAGE_KEY]: JSON.stringify(darkAppearance) });

    expect(isSavedThemeLight()).toBe(true);
    expect(JSON.parse(store.get(THEME_APPEARANCE_STORAGE_KEY)!)).toEqual({ ...darkAppearance, themeMode: 'light' });
  });

  it('switches a wrapped appearance record and a system-following one to light too', () => {
    const wrapped = { state: { ...darkAppearance, themeMode: 'system' }, version: 0 };
    const store = useStorage({ [THEME_APPEARANCE_STORAGE_KEY]: JSON.stringify(wrapped) });

    expect(isSavedThemeLight()).toBe(true);
    expect(JSON.parse(store.get(THEME_APPEARANCE_STORAGE_KEY)!)).toEqual({
      state: { ...darkAppearance, themeMode: 'light' },
      version: 0,
    });
  });

  it('leaves an unreadable appearance record alone and still adopts light', () => {
    const store = useStorage({ ...savedDark, [THEME_APPEARANCE_STORAGE_KEY]: '{not json' });

    expect(isSavedThemeLight()).toBe(true);
    expect(store.get(THEME_APPEARANCE_STORAGE_KEY)).toBe('{not json');
    expect(store.get(LIGHT_DEFAULT_ADOPTED_KEY)).toBe('1');
  });

  it('keeps choices made after the move: dark, custom and light', () => {
    useStorage({ ...adopted, ...savedDark });
    expect(isSavedThemeLight()).toBe(false);

    useStorage({ ...adopted, [SAVED_THEME_LIGHT_KEY]: 'false', [SAVED_THEME_NAME_KEY]: 'custom' });
    expect(isSavedThemeLight()).toBe(false);

    useStorage({ ...adopted, [SAVED_THEME_LIGHT_KEY]: 'true', [SAVED_THEME_NAME_KEY]: 'light' });
    expect(isSavedThemeLight()).toBe(true);
  });

  it('does not touch the appearance record once the move has happened', () => {
    const store = useStorage({ ...adopted, ...savedDark, [THEME_APPEARANCE_STORAGE_KEY]: JSON.stringify(darkAppearance) });

    expect(isSavedThemeLight()).toBe(false);
    expect(JSON.parse(store.get(THEME_APPEARANCE_STORAGE_KEY)!)).toEqual(darkAppearance);
  });

  it('is light again when the saved choice is cleared', () => {
    useStorage(adopted);
    expect(isSavedThemeLight()).toBe(true);
  });

  it('is light when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage blocked'); },
      setItem: () => { throw new Error('storage blocked'); },
      removeItem: () => { throw new Error('storage blocked'); },
    });
    expect(isSavedThemeLight()).toBe(true);
  });

  it('shares its appearance record key with the appearance store', () => {
    expect(THEME_APPEARANCE_STORAGE_KEY).toBe(RTX_THEME_APPEARANCE_STORAGE_KEY);
  });
});

describe('index.html pre-paint theme script', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  const start = html.indexOf('var isLightTheme = true;');
  const end = html.indexOf('if (isLightTheme) {', start);
  // The page decides the theme before the app loads; run that exact code.
  const runPageScript = () => new Function(`${html.slice(start, end)}\nreturn isLightTheme;`)() as boolean;

  it('starts from light and carries no dark default', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(html).not.toContain('var isLightTheme = false');
  });

  it.each<[string, Record<string, string>]>([
    ['nothing saved', {}],
    ['a dark theme saved before the light default', savedDark],
    ['a dark appearance record saved before the light default', { ...savedDark, [THEME_APPEARANCE_STORAGE_KEY]: JSON.stringify(darkAppearance) }],
    ['a wrapped appearance record', { [THEME_APPEARANCE_STORAGE_KEY]: JSON.stringify({ state: { ...darkAppearance, themeMode: 'system' } }) }],
    ['an unreadable appearance record', { ...savedDark, [THEME_APPEARANCE_STORAGE_KEY]: '{not json' }],
    ['dark chosen after the move', { ...adopted, ...savedDark }],
    ['light chosen after the move', { ...adopted, [SAVED_THEME_LIGHT_KEY]: 'true', [SAVED_THEME_NAME_KEY]: 'light' }],
    ['a custom theme chosen after the move', { ...adopted, [SAVED_THEME_LIGHT_KEY]: 'false', [SAVED_THEME_NAME_KEY]: 'custom' }],
    ['the saved choice cleared after the move', adopted],
    ['only the theme name saved as light', { ...adopted, [SAVED_THEME_LIGHT_KEY]: 'false', [SAVED_THEME_NAME_KEY]: 'light' }],
  ])('answers and stores the same as the app with %s', (_name, entries) => {
    const pageStore = useStorage(entries);
    const pageAnswer = runPageScript();
    const pageStorage = Object.fromEntries(pageStore);

    const appStore = useStorage(entries);
    expect(pageAnswer).toBe(isSavedThemeLight());
    expect(pageStorage).toEqual(Object.fromEntries(appStore));
  });

  it('is light when storage is unavailable, like the app', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage blocked'); },
      setItem: () => { throw new Error('storage blocked'); },
    });
    expect(runPageScript()).toBe(true);
    expect(isSavedThemeLight()).toBe(true);
  });
});
