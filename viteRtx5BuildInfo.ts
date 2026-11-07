// Bakes the build identity into every RTX5 UI bundle (same logic in all 4 UI repos).
//   __RTX5_UI_VERSION__  release version: VITE_APP_VERSION (set by CI from VERSION), else the VERSION file
//   __RTX5_UI_COMMIT__   git commit the bundle was built from: VITE_APP_COMMIT / GITHUB_SHA, else `git rev-parse HEAD`
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import type { Plugin } from 'vite';

const readVersionFile = (): string => {
  try {
    return readFileSync(new URL('./VERSION', import.meta.url), 'utf8');
  } catch {
    return '';
  }
};

const gitHead = (): string => {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return '';
  }
};

export const resolveRtx5BuildInfo = (env: NodeJS.ProcessEnv = process.env): { version: string; commit: string } => ({
  version: String(env.VITE_APP_VERSION || readVersionFile()).trim().replace(/^v/i, '') || 'dev',
  commit: String(env.VITE_APP_COMMIT || env.GITHUB_SHA || gitHead()).trim() || 'unknown',
});

export function rtx5BuildInfo(): Plugin {
  const { version, commit } = resolveRtx5BuildInfo();
  return {
    name: 'rtx5-build-info',
    config: () => ({
      define: {
        __RTX5_UI_VERSION__: JSON.stringify(version),
        __RTX5_UI_COMMIT__: JSON.stringify(commit),
      },
    }),
  };
}
