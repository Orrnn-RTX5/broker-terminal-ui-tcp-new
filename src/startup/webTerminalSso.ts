/**
 * Web-terminal one-time login (SSO).
 *
 * A CRM "Web Terminal" button opens https://<terminal host>/#token=<opaque>.
 * The token is single use and lives 60 seconds on the gateway.
 *
 * index.html runs first. It moves the token out of the URL fragment and parks it on
 * window under WEB_TERMINAL_SSO_HANDOFF_KEY, before any other script or request.
 * This module then takes the value once, checks its shape, and hands it to the
 * login screen, which exchanges it for a session.
 *
 * Nothing here logs, prints or reports the token. The module imports nothing, so it
 * can be evaluated before any API, analytics or error-reporting code.
 */

export const WEB_TERMINAL_SSO_FRAGMENT_PARAM = 'token';
export const WEB_TERMINAL_SSO_HANDOFF_KEY = '__RTX_WEB_TERMINAL_SSO_TOKEN__';

// The gateway mints 32 random bytes and encodes them as base64url without padding.
const SSO_TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

export type WebTerminalSsoFailureKind = 'expired' | 'rate_limited' | 'unavailable';

export const WEB_TERMINAL_SSO_FAILURE_MESSAGES: Readonly<Record<WebTerminalSsoFailureKind, string>> = {
  expired: 'This login link has expired or was already used.',
  rate_limited: 'Too many sign-in attempts. Please try again in a minute.',
  unavailable: 'Unable to sign in from this link. Try again, or sign in with your login and password.',
};

/** Shown on the login form when an SSO link opens on a terminal that has no resolvable broker. */
export const WEB_TERMINAL_SSO_NO_BROKER_MESSAGE =
  'This sign-in link cannot be used because this terminal has no broker configured. Sign in with your login and password, or contact your broker.';

export class WebTerminalSsoError extends Error {
  readonly kind: WebTerminalSsoFailureKind;

  constructor(kind: WebTerminalSsoFailureKind) {
    super(WEB_TERMINAL_SSO_FAILURE_MESSAGES[kind]);
    this.name = 'WebTerminalSsoError';
    this.kind = kind;
  }
}

/** A page opened from an SSO link. `token` is null when the link's token is malformed or empty. */
export interface WebTerminalSsoCapture {
  readonly token: string | null;
}

export const isWebTerminalSsoTokenShape = (value: unknown): value is string =>
  typeof value === 'string' && SSO_TOKEN_SHAPE.test(value);

/**
 * Takes the handoff value out of `target` (window in the browser). Returns null when
 * the page was not opened from an SSO link. The value is removed, so later code
 * cannot read it back from the global.
 */
export const captureWebTerminalSso = (target: Record<string, unknown>): WebTerminalSsoCapture | null => {
  if (!(WEB_TERMINAL_SSO_HANDOFF_KEY in target)) return null;
  const raw = target[WEB_TERMINAL_SSO_HANDOFF_KEY];
  delete target[WEB_TERMINAL_SSO_HANDOFF_KEY];
  return { token: isWebTerminalSsoTokenShape(raw) ? raw : null };
};

let pendingCapture: WebTerminalSsoCapture | null = null;

/** Called once from main.tsx, before any other module is evaluated. */
export const captureWebTerminalSsoAtStartup = (): void => {
  if (typeof window === 'undefined') return;
  const capture = captureWebTerminalSso(window as unknown as Record<string, unknown>);
  if (capture) pendingCapture = capture;
};

export const hasPendingWebTerminalSso = (): boolean => pendingCapture !== null;

/** Returns the pending capture once, then clears it. */
export const takePendingWebTerminalSso = (): WebTerminalSsoCapture | null => {
  const capture = pendingCapture;
  pendingCapture = null;
  return capture;
};

export type WebTerminalSsoStart = 'wait' | 'start' | 'no-broker';

/**
 * Decides whether the pending token may be taken now. The token is single use, so it is
 * taken only once a broker is known. `brokerDirectorySettled` is true once the broker
 * lookup has finished, with or without a result. A settled lookup with no broker means
 * the terminal can never sign in from this link, so the token must be left untouched.
 */
export const resolveWebTerminalSsoStart = (state: {
  readonly hasBroker: boolean;
  readonly brokerDirectorySettled: boolean;
}): WebTerminalSsoStart => {
  if (state.hasBroker) return 'start';
  return state.brokerDirectorySettled ? 'no-broker' : 'wait';
};

/**
 * Maps an exchange failure to one of the fixed messages. The original error is
 * dropped on purpose, so no server text or request detail reaches the screen.
 */
export const toWebTerminalSsoError = (error: unknown): WebTerminalSsoError => {
  if (error instanceof WebTerminalSsoError) return error;
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined;
  if (status === 401) return new WebTerminalSsoError('expired');
  if (status === 429) return new WebTerminalSsoError('rate_limited');
  return new WebTerminalSsoError('unavailable');
};

/**
 * Runs `exchange` with the captured token. A malformed token is refused before any
 * request is made. Every failure comes back as a WebTerminalSsoError with fixed copy.
 */
export const runWebTerminalSsoExchange = async <T>(
  capture: WebTerminalSsoCapture,
  exchange: (token: string) => Promise<T>,
): Promise<T> => {
  if (!capture.token) throw new WebTerminalSsoError('expired');
  try {
    return await exchange(capture.token);
  } catch (error) {
    throw toWebTerminalSsoError(error);
  }
};

/**
 * True in the browser web terminal that web-terminal-server serves. That server reports
 * the platform as 'web-tcp' and also declares a desktop backend target, so the desktop
 * check alone cannot tell it apart from a real Electron build.
 */
export const isWebTcpTerminal = (): boolean => {
  if (typeof window === 'undefined') return false;
  const platform = (window as unknown as { rtx5Electron?: { platform?: unknown } }).rtx5Electron?.platform;
  return platform === 'web-tcp';
};

/**
 * Whether a CRM SSO link can sign in on this runtime. Browser terminals can, and so can the
 * web-tcp terminal, which is a desktop backend target. Real Electron desktop builds never can.
 */
export const isWebTerminalSsoEnabled = (desktopBackendTarget: boolean): boolean =>
  !desktopBackendTarget || isWebTcpTerminal();
