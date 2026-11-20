/**
 * Proactive access-token renewal.
 *
 * Token refresh used to be reactive only (after a REST 401), so a terminal that
 * only streams quotes (no REST traffic) kept its old token until the gateway
 * expired it, and the quote permission stopped. This schedules one renewal per
 * token BEFORE it expires and reuses the normal refresh flow (BrokerAPI), so the
 * new token propagates exactly like a reactive refresh: setAuthTokens ->
 * `auth:token-updated` -> new binary tunnel / quote subscription.
 *
 * Timing rule (R = remaining lifetime when the token is first seen):
 *   delay = min(0.8 * R, R - 5 min), but never below min(0.5 * R, 60 s)
 * i.e. at ~80% of the lifetime or 5 minutes before expiry, whichever is
 * earlier. The floor stops a refresh loop if a server issues very short tokens
 * or a refresh response carries no new expiry. Token values are never logged.
 */

export const PROACTIVE_REFRESH_LEAD_MS = 5 * 60_000;
export const PROACTIVE_REFRESH_LIFETIME_FRACTION = 0.8;
export const PROACTIVE_REFRESH_MIN_SPACING_MS = 60_000;
export const PROACTIVE_REFRESH_RETRY_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Returns the delay until the renewal should fire, or null if already expired. */
export const computeProactiveRefreshDelayMs = (expiryMs: number, nowMs: number): number | null => {
  const remaining = expiryMs - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const candidate = Math.min(
    remaining * PROACTIVE_REFRESH_LIFETIME_FRACTION,
    remaining - PROACTIVE_REFRESH_LEAD_MS,
  );
  const floor = Math.min(remaining * 0.5, PROACTIVE_REFRESH_MIN_SPACING_MS);
  return Math.min(Math.max(candidate, floor), MAX_TIMEOUT_MS);
};

export interface ProactiveTokenRefreshDeps {
  getExpiryMs: () => number | null;
  getToken: () => string | null;
  /** Runs the normal refresh flow; must reject on failure. */
  refresh: () => Promise<unknown>;
  now?: () => number;
}

/**
 * Starts the timer for the current token. Returns a stop function that clears
 * it (call on logout / account switch / token change; the caller restarts it
 * for the new token).
 */
export const startProactiveTokenRefresh = (deps: ProactiveTokenRefreshDeps): (() => void) => {
  const now = deps.now ?? Date.now;
  const scheduledToken = deps.getToken();
  const initialExpiry = deps.getExpiryMs();
  if (!scheduledToken || !initialExpiry) return () => undefined;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number) => {
    timer = setTimeout(fire, delayMs);
  };

  const fire = () => {
    timer = null;
    if (stopped || deps.getToken() !== scheduledToken) return;
    deps.refresh().catch(() => {
      if (stopped || deps.getToken() !== scheduledToken) return;
      const expiry = deps.getExpiryMs();
      if (!expiry || expiry - now() <= PROACTIVE_REFRESH_RETRY_MS) return;
      schedule(PROACTIVE_REFRESH_RETRY_MS);
    });
  };

  const delay = computeProactiveRefreshDelayMs(initialExpiry, now());
  if (delay === null) return () => undefined;
  schedule(delay);

  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
};
