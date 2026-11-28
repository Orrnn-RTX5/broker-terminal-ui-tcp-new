import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type RuntimeTestWindow = {
  location: { protocol: string };
  electron?: { window: Record<string, unknown> };
  RUNTIME_CONFIG?: Record<string, unknown>;
  __RTX_RUNTIME_CONFIG__?: Record<string, unknown>;
};

const source = readFileSync(resolve(process.cwd(), 'public/runtime-config.js'), 'utf8');
const runRuntimeConfig = (
  runtimeWindow: RuntimeTestWindow,
  userAgent = 'Mozilla/5.0',
) => new Function('window', 'navigator', source)(runtimeWindow, { userAgent });

describe('deployed runtime configuration', () => {
  it('leaves broker selection to the environment-generated configuration', () => {
    const runtimeWindow: RuntimeTestWindow = { location: { protocol: 'https:' } };

    runRuntimeConfig(runtimeWindow);

    expect(runtimeWindow.RUNTIME_CONFIG).toBeUndefined();
    expect(source).not.toContain('fxtrustbrokerbackend.orrnn.com');
    expect(source).not.toContain('service.achieverfinancials.com');
    expect(source).not.toContain('service.orrnn.com');
    expect(source).not.toContain('superadmin-prod.orrnn.com');
  });

  const electronCases: Array<[RuntimeTestWindow, string]> = [
    [{ location: { protocol: 'file:' } }, 'Mozilla/5.0'],
    [{ location: { protocol: 'http:' }, electron: { window: {} } }, 'Mozilla/5.0'],
    [{ location: { protocol: 'http:' } }, 'Mozilla/5.0 Electron/40.8.0'],
  ];

  it.each(electronCases)('does not overwrite the broker session in Electron', (runtimeWindow, userAgent) => {
    runtimeWindow.RUNTIME_CONFIG = { existing: true };

    runRuntimeConfig(runtimeWindow, userAgent);

    expect(runtimeWindow.RUNTIME_CONFIG).toEqual({ existing: true });
    expect(runtimeWindow.__RTX_RUNTIME_CONFIG__).toBeUndefined();
  });
});
