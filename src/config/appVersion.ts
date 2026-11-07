// Injected at build time: __RTX5_UI_VERSION__ by viteRtx5BuildInfo (VERSION file / CI),
// __APP_VERSION__ by vite.config.ts from package.json. Both are absent in plain Vitest runs.
declare const __RTX5_UI_VERSION__: string | undefined;
declare const __APP_VERSION__: string | undefined;

/** Version of this terminal build: the RTX5 release version, else the desktop app's or package version. */
export const getAppVersion = (): string => (
  (typeof __RTX5_UI_VERSION__ === 'string' && __RTX5_UI_VERSION__ && __RTX5_UI_VERSION__ !== 'dev' ? __RTX5_UI_VERSION__ : '')
  || (typeof window !== 'undefined' ? window.electron?.appVersion : undefined)
  || (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '')
  || '1.0.0'
);
