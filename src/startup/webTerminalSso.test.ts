import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WEB_TERMINAL_SSO_FAILURE_MESSAGES,
  WEB_TERMINAL_SSO_HANDOFF_KEY,
  WEB_TERMINAL_SSO_NO_BROKER_MESSAGE,
  WebTerminalSsoError,
  captureWebTerminalSso,
  captureWebTerminalSsoAtStartup,
  hasPendingWebTerminalSso,
  isWebTcpTerminal,
  isWebTerminalSsoEnabled,
  isWebTerminalSsoTokenShape,
  resolveWebTerminalSsoStart,
  runWebTerminalSsoExchange,
  takePendingWebTerminalSso,
  type WebTerminalSsoFailureKind,
} from './webTerminalSso';

// 43 characters, the shape the gateway produces (32 random bytes, base64url, no padding).
const TOKEN = 'Xk3_pQ9-vT2bLm8zRw4nYc7hJd1sFg6uAe0iOqN5tKa';
const OTHER_TOKEN = 'Zz9_yY8-xX7wWv6uUt5sSr4qQp3oOn2mMl1kKj0iIhH';
const KEY = WEB_TERMINAL_SSO_HANDOFF_KEY;

type Bag = Record<string, unknown>;
const bag = (): Bag => window as unknown as Bag;

const apiError = (status: number, message = 'Authentication failed') =>
  Object.assign(new Error(message), {
    name: 'ApiError',
    status,
    data: { error: { code: 'SSO_TOKEN_INVALID', message: 'This login link has expired or was already used.' } },
  });

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

const expectFailure = async (error: unknown, kind: WebTerminalSsoFailureKind) => {
  expect(error).toBeInstanceOf(WebTerminalSsoError);
  expect((error as WebTerminalSsoError).kind).toBe(kind);
  expect((error as Error).message).toBe(WEB_TERMINAL_SSO_FAILURE_MESSAGES[kind]);
};

// index.html carries the strip script. Run that exact inline script, not a copy of it.
// Vitest runs from the project root; import.meta.url is an http URL under jsdom, so it cannot be converted to a file path.
const indexHtml = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
const scriptMarker = indexHtml.indexOf('takeWebTerminalSsoFragment');
const inlineScript = indexHtml.slice(
  indexHtml.lastIndexOf('<script>', scriptMarker) + '<script>'.length,
  indexHtml.indexOf('</script>', scriptMarker),
);

const runInlineScript = (hash: string, replaceState = vi.fn()) => {
  const fakeWindow: Bag = {
    location: { hash, pathname: '/terminal/', search: '?lang=en' },
    history: { state: { keep: true }, replaceState },
  };
  new Function('window', inlineScript)(fakeWindow);
  return { fakeWindow, replaceState };
};

afterEach(() => {
  delete bag()[KEY];
  takePendingWebTerminalSso();
  vi.restoreAllMocks();
});

describe('isWebTerminalSsoTokenShape', () => {
  it('accepts the gateway token shape', () => {
    expect(isWebTerminalSsoTokenShape(TOKEN)).toBe(true);
  });

  it('rejects empty, short, long, padded and non-base64url values', () => {
    expect(isWebTerminalSsoTokenShape('')).toBe(false);
    expect(isWebTerminalSsoTokenShape('short')).toBe(false);
    expect(isWebTerminalSsoTokenShape(TOKEN + TOKEN + TOKEN)).toBe(false);
    expect(isWebTerminalSsoTokenShape(`${TOKEN}=`)).toBe(false);
    expect(isWebTerminalSsoTokenShape(TOKEN.replace('X', '+'))).toBe(false);
    expect(isWebTerminalSsoTokenShape(TOKEN.replace('X', '/'))).toBe(false);
    expect(isWebTerminalSsoTokenShape(TOKEN.replace('X', ' '))).toBe(false);
    expect(isWebTerminalSsoTokenShape(undefined)).toBe(false);
    expect(isWebTerminalSsoTokenShape(42)).toBe(false);
  });
});

describe('captureWebTerminalSso', () => {
  it('returns null and leaves the target alone when no SSO handoff is parked', () => {
    const target: Bag = { other: 1 };
    expect(captureWebTerminalSso(target)).toBeNull();
    expect(target).toEqual({ other: 1 });
  });

  it('takes a valid token once and removes the parked value', () => {
    const target: Bag = { [KEY]: TOKEN };
    expect(captureWebTerminalSso(target)).toEqual({ token: TOKEN });
    expect(KEY in target).toBe(false);
    expect(captureWebTerminalSso(target)).toBeNull();
  });

  it('reports a malformed or empty token as null and still removes it', () => {
    const malformed: Bag = { [KEY]: 'not a token' };
    expect(captureWebTerminalSso(malformed)).toEqual({ token: null });
    expect(KEY in malformed).toBe(false);

    const empty: Bag = { [KEY]: '' };
    expect(captureWebTerminalSso(empty)).toEqual({ token: null });
  });
});

describe('resolveWebTerminalSsoStart', () => {
  it('waits while the broker lookup is still loading and no broker is known', () => {
    expect(resolveWebTerminalSsoStart({ hasBroker: false, brokerDirectorySettled: false })).toBe('wait');
  });

  it('starts as soon as a broker is known, whether or not the lookup has settled', () => {
    expect(resolveWebTerminalSsoStart({ hasBroker: true, brokerDirectorySettled: false })).toBe('start');
    expect(resolveWebTerminalSsoStart({ hasBroker: true, brokerDirectorySettled: true })).toBe('start');
  });

  it('reports no-broker once the lookup settles without a broker, so the token is kept', () => {
    expect(resolveWebTerminalSsoStart({ hasBroker: false, brokerDirectorySettled: true })).toBe('no-broker');
  });
});

describe('WEB_TERMINAL_SSO_NO_BROKER_MESSAGE', () => {
  it('is fixed copy that does not carry the token', () => {
    expect(WEB_TERMINAL_SSO_NO_BROKER_MESSAGE).toMatch(/no broker configured/);
    expect(WEB_TERMINAL_SSO_NO_BROKER_MESSAGE).not.toContain(TOKEN);
  });
});

describe('pending SSO capture at startup', () => {
  it('moves the window handoff into module state and clears the global', () => {
    bag()[KEY] = TOKEN;
    captureWebTerminalSsoAtStartup();
    expect(KEY in window).toBe(false);
    expect(hasPendingWebTerminalSso()).toBe(true);
    expect(takePendingWebTerminalSso()).toEqual({ token: TOKEN });
    expect(hasPendingWebTerminalSso()).toBe(false);
    expect(takePendingWebTerminalSso()).toBeNull();
  });

  it('does nothing when the page was not opened from an SSO link', () => {
    captureWebTerminalSsoAtStartup();
    expect(hasPendingWebTerminalSso()).toBe(false);
  });
});

describe('inline strip in index.html', () => {
  it('parks the token and strips the fragment before anything else runs', () => {
    const { fakeWindow, replaceState } = runInlineScript(`#token=${TOKEN}`);
    expect(fakeWindow[KEY]).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith({ keep: true }, '', '/terminal/?lang=en');
  });

  it('finds the token among other fragment parameters', () => {
    const { fakeWindow } = runInlineScript(`#lang=en&token=${TOKEN}`);
    expect(fakeWindow[KEY]).toBe(TOKEN);
  });

  it('leaves an unrelated fragment untouched', () => {
    const { fakeWindow, replaceState } = runInlineScript('#/chart/EURUSD');
    expect(KEY in fakeWindow).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('does not treat a parameter that only ends in "token" as the token', () => {
    const { fakeWindow, replaceState } = runInlineScript(`#mytoken=${TOKEN}`);
    expect(KEY in fakeWindow).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('parks an empty value for an undecodable token and still strips the fragment', () => {
    const { fakeWindow, replaceState } = runInlineScript('#token=%E0%A4%A');
    expect(fakeWindow[KEY]).toBe('');
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('keeps the token parked when the history API refuses the rewrite', () => {
    const replaceState = vi.fn(() => {
      throw new Error('SecurityError');
    });
    const { fakeWindow } = runInlineScript(`#token=${TOKEN}`, replaceState);
    expect(fakeWindow[KEY]).toBe(TOKEN);
  });
});

describe('runWebTerminalSsoExchange', () => {
  it('returns the exchange result for the captured token', async () => {
    const exchange = vi.fn(async (token: string) => ({ access_token: `session-for-${token.length}` }));
    const result = await runWebTerminalSsoExchange({ token: TOKEN }, exchange);
    expect(result).toEqual({ access_token: 'session-for-43' });
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith(TOKEN);
  });

  it('refuses a malformed capture without making any request', async () => {
    const exchange = vi.fn(async () => ({}));
    const error = await captureRejection(runWebTerminalSsoExchange({ token: null }, exchange));
    await expectFailure(error, 'expired');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('maps a 401 to the expired message', async () => {
    const error = await captureRejection(runWebTerminalSsoExchange({ token: TOKEN }, async () => {
      throw apiError(401);
    }));
    await expectFailure(error, 'expired');
  });

  it('maps a 429 to the rate-limited message', async () => {
    const error = await captureRejection(runWebTerminalSsoExchange({ token: TOKEN }, async () => {
      throw apiError(429, 'Too Many Requests');
    }));
    await expectFailure(error, 'rate_limited');
  });

  it('maps every other failure to the generic message', async () => {
    for (const status of [0, 403, 500, 502, 503]) {
      const error = await captureRejection(runWebTerminalSsoExchange({ token: TOKEN }, async () => {
        throw apiError(status);
      }));
      await expectFailure(error, 'unavailable');
    }
    const networkError = await captureRejection(runWebTerminalSsoExchange({ token: TOKEN }, async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expectFailure(networkError, 'unavailable');
  });

  it('never shows or keeps the token in the error it throws', async () => {
    const leaky = new Error(`request failed for ${TOKEN}`);
    const error = await captureRejection(runWebTerminalSsoExchange({ token: TOKEN }, async () => {
      throw leaky;
    }));
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String((error as Error).stack ?? '')).not.toContain(TOKEN);
  });

  it('does not write the token or the error to the console on any path', async () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    await runWebTerminalSsoExchange({ token: TOKEN }, async () => ({ ok: true }));
    await captureRejection(runWebTerminalSsoExchange({ token: TOKEN }, async () => {
      throw apiError(401);
    }));
    await captureRejection(runWebTerminalSsoExchange({ token: OTHER_TOKEN }, async () => {
      throw new Error(`boom ${OTHER_TOKEN}`);
    }));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('web-tcp and desktop gating for SSO', () => {
  afterEach(() => {
    delete bag().rtx5Electron;
  });

  it('recognises only the web-tcp platform as the browser web terminal', () => {
    bag().rtx5Electron = { isDesktop: true, platform: 'web-tcp' };
    expect(isWebTcpTerminal()).toBe(true);
    bag().rtx5Electron = { isDesktop: true, platform: 'win32' };
    expect(isWebTcpTerminal()).toBe(false);
    delete bag().rtx5Electron;
    expect(isWebTcpTerminal()).toBe(false);
  });

  it('allows SSO in browser web mode and on web-tcp, but never in a real Electron build', () => {
    delete bag().rtx5Electron;
    expect(isWebTerminalSsoEnabled(false)).toBe(true);
    expect(isWebTerminalSsoEnabled(true)).toBe(false);
    bag().rtx5Electron = { isDesktop: true, platform: 'web-tcp' };
    expect(isWebTerminalSsoEnabled(true)).toBe(true);
    expect(isWebTerminalSsoEnabled(false)).toBe(true);
    bag().rtx5Electron = { isDesktop: true, platform: 'win32' };
    expect(isWebTerminalSsoEnabled(true)).toBe(false);
  });
});
