import { readBackendCurrencyDigits } from '../utils/accountCurrency';
import type { Account } from '../store/useAppStore';

export const ACCOUNT_METRICS_MAX_AGE_MS = 30_000;

const aliases = {
  balance: ['balance_amount', 'balance', 'Balance'],
  equity: ['equity_amount', 'equity', 'Equity'],
  margin: ['used_margin', 'margin_used', 'margin', 'marginUsed'],
  freeMargin: ['free_margin_amount', 'freeMargin', 'free_margin', 'margin_free', 'margin_available'],
  unrealizedPL: ['floating_pnl', 'floating', 'profit', 'unrealizedPL', 'unrealized_pl', 'unrealizedPnL'],
  marginLevel: ['marginLevel', 'margin_level'],
  credit: ['credit_amount', 'credit', 'credit_bonus', 'bonus'],
} as const;

export type AccountMetric = keyof typeof aliases;
const flags = {
  balance: 'hasBackendBalance', equity: 'hasBackendEquity', margin: 'hasBackendMargin',
  freeMargin: 'hasBackendFreeMargin', unrealizedPL: 'hasBackendFloatingPnL',
  marginLevel: 'hasBackendMarginLevel', credit: 'hasBackendCredit',
} as const;

export function accountMetricNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'object') return accountMetricNumber((value as { amount?: unknown }).amount);
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

const validAnswerTimeMs = (value: number | null, now: number) => (
  value !== null && Number.isSafeInteger(value) && value > 0 && value <= now + 5_000
);

// The server's calculation time of an answer in ms (calculated_at, else as_of).
// Undefined when the answer carries no valid calculation time.
function answerCalculatedAtMs(raw: Record<string, unknown>, now: number): number | undefined {
  if (raw.calculated_at === undefined && raw.as_of === undefined) return undefined;
  const calculatedAt = accountMetricNumber(raw.calculated_at ?? raw.as_of);
  const timestamp = calculatedAt === null ? null : calculatedAt < 100_000_000_000 ? calculatedAt * 1000 : calculatedAt;
  return validAnswerTimeMs(timestamp, now) ? timestamp! : undefined;
}

// The server's as-of time of an answer in ms: source_as_of, else calculated_at (as_of).
// Undefined when the answer carries no valid time field.
function answerAsOfMs(raw: Record<string, unknown>, now: number): number | undefined {
  if (raw.source_as_of !== undefined) {
    const sourceAsOf = accountMetricNumber(raw.source_as_of);
    return validAnswerTimeMs(sourceAsOf, now) ? sourceAsOf! : undefined;
  }
  return answerCalculatedAtMs(raw, now);
}

// Orders an answer against the held values, for every held value (locked or not).
// - Both sides have server times: compare server times only. Newer source_as_of wins; with an
//   equal source (a quiet symbol keeps it constant) a newer calculated_at wins.
// - Otherwise: compare client clock only. The answer's request start (sentAt) against the held
//   value's own client time (its request start, or its receipt time for a frame).
// This ordering never compares a server time with a client time. The validity and freshness
// gates elsewhere in this file (validAnswerTimeMs, invalidCalculationTime, invalidSourceTime,
// accountMetricAvailable) still compare server times with the browser clock: a follow-up, not
// covered by this ordering. Returns true when newer, false when older or equal, and undefined
// when the two cannot be ordered (no comparable times, or no held value).
export function answerOrder(
  answer: { asOf?: number; calculatedAt?: number; sentAt?: number },
  held: Pick<Account, 'metricsAsOf' | 'metricsCalculatedAt' | 'metricsClientAt'> | null | undefined,
): boolean | undefined {
  if (!held) return undefined;
  if (answer.asOf !== undefined && held.metricsAsOf !== undefined) {
    if (answer.asOf !== held.metricsAsOf) return answer.asOf > held.metricsAsOf;
    if (answer.calculatedAt === undefined || held.metricsCalculatedAt === undefined) return false;
    return answer.calculatedAt > held.metricsCalculatedAt;
  }
  if (answer.sentAt !== undefined && held.metricsClientAt !== undefined) return answer.sentAt > held.metricsClientAt;
  return undefined;
}

// Keep metadata from every envelope while unwrapping account/metrics channel frames.
export function extractAccountMetrics(payload: unknown): Record<string, unknown> {
  let value = payload;
  let result: Record<string, unknown> = {};
  for (let depth = 0; depth < 6; depth++) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { break; }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) break;
    const record = value as Record<string, unknown>;
    result = { ...result, ...record };
    value = record.account ?? record.data;
  }
  return result;
}

export function normalizeAccountMetrics(
  payload: unknown,
  previous?: Account | null,
  options: { partial?: boolean; scope?: string; login?: number; now?: number; requestedAt?: number } = {},
): Account {
  const raw = extractAccountMetrics(payload);
  const now = options.now ?? Date.now();
  const scope = options.scope ?? previous?.metricsScope;
  const current = previous?.metricsScope && previous.metricsScope !== scope ? null : previous;
  const incomingLogin = raw.login ?? raw.account_login;
  if (options.login && incomingLogin !== undefined && Number(incomingLogin) !== options.login) {
    return current ?? normalizeAccountMetrics({}, null, { ...options, login: undefined });
  }
  const token = raw.publication_token;
  const validToken = typeof token === 'string' && /^[0-9]{20}$/.test(token) && !/^0+$/.test(token);
  // options.requestedAt is the client time the REST request was sent (captured before the call).
  const answerAsOf = answerAsOfMs(raw, now);
  const answerCalculatedAt = answerCalculatedAtMs(raw, now);
  const sentAt = options.requestedAt;
  const order = answerOrder({ asOf: answerAsOf, calculatedAt: answerCalculatedAt, sentAt }, current);
  // Locked (a publication token is held): a token-less answer applies only when newer, so a
  // stamped frame cannot freeze the tab on its last balance; stamped frames keep token ordering.
  // Unlocked: a token-less answer is ignored only when provably older or equal. An unorderable
  // answer, and the first value (no held value), are accepted as before.
  const stale = current?.publicationToken
    ? (token === undefined ? order !== true : !validToken || (token as string) <= current.publicationToken)
    : Boolean(current) && token === undefined && order === false;
  if (stale && current) {
    // The profile endpoint may finish after a newer metrics event. It can
    // supply account identity, but must not roll back any financial value.
    if (token === undefined) {
      const currency = typeof raw.currency === 'string' && raw.currency.trim() ? raw.currency : current.currency;
      const currencyDigits = readBackendCurrencyDigits(raw) ?? current.currencyDigits;
      const leverageValue = accountMetricNumber(raw.leverage);
      const leverage = leverageValue !== null && leverageValue > 0 ? leverageValue : current.leverage;
      if (currency !== current.currency || currencyDigits !== current.currencyDigits || leverage !== current.leverage) return { ...current, currency, currencyDigits, leverage };
    }
    return current;
  }
  if (token !== undefined && !validToken && current) return current;

  const next: Account = {
    balance: 0, equity: 0, margin: 0, freeMargin: 0, unrealizedPL: 0, marginLevel: 0, credit: 0,
    currency: String(raw.currency ?? current?.currency ?? 'USD'),
    currencyDigits: readBackendCurrencyDigits(raw) ?? current?.currencyDigits,
    leverage: accountMetricNumber(raw.leverage) ?? current?.leverage ?? 100,
    metricsScope: scope,
    publicationToken: validToken ? (token as string) : current?.publicationToken,
    calculationVersion: typeof raw.calculation_version === 'string' ? raw.calculation_version : current?.calculationVersion,
    marginCalculationVersion: typeof raw.margin_calculation_version === 'string' ? raw.margin_calculation_version : current?.marginCalculationVersion,
    configurationVersion: typeof raw.configuration_version === 'string' ? raw.configuration_version : current?.configurationVersion,
    metricsStatus: String(raw.status ?? (raw.valid === false ? 'unavailable' : raw.stale === true ? 'stale' : 'valid')),
    marketClosed: raw.market_closed === true || raw.market_status === 'closed',
    metricUpdatedAt: {},
    // Server times only when the answer carries them; never a client time in these fields.
    metricsAsOf: answerAsOf,
    metricsCalculatedAt: answerCalculatedAt,
    metricsSentAt: sentAt,
    // The held value's own client time: its request start, or its receipt time (frames).
    metricsClientAt: sentAt ?? now,
  };
  const calculatedAt = accountMetricNumber(raw.calculated_at ?? raw.as_of);
  const calculationTimestamp = calculatedAt === null ? now : calculatedAt < 100_000_000_000 ? calculatedAt * 1000 : calculatedAt;
  const invalidCalculationTime = (raw.calculated_at !== undefined || raw.as_of !== undefined)
    && (calculatedAt === null || !Number.isSafeInteger(calculationTimestamp) || calculationTimestamp <= 0 || calculationTimestamp > now + 5_000);
  const hasSourceTime = raw.source_as_of !== undefined;
  const sourceAsOf = accountMetricNumber(raw.source_as_of);
  const invalidSourceTime = hasSourceTime && (sourceAsOf === null || !Number.isSafeInteger(sourceAsOf) || sourceAsOf <= 0 || sourceAsOf > now + 5_000);
  // Recalculation must not extend the life of the oldest quote/FX dependency.
  const timestamp = hasSourceTime && !invalidSourceTime ? Math.min(calculationTimestamp, sourceAsOf!) : calculationTimestamp;
  const invalid = raw.valid === false || raw.stale === true || ['stale', 'unavailable', 'invalid'].includes(next.metricsStatus!)
    || (token !== undefined && !validToken)
    || invalidCalculationTime
    || invalidSourceTime
    || (options.login !== undefined && incomingLogin !== undefined && Number(incomingLogin) !== options.login);
  if (invalid) next.metricsStatus = 'unavailable';
  // The backend says margin cannot be valued: margin, free margin and margin level are
  // unavailable, never 0. Equity, balance and credit that arrive as numbers stay available.
  const marginUnavailable = raw.available === false || raw.reason === 'margin_unavailable';
  if (marginUnavailable) {
    next.metricsStatus = 'unavailable';
    if (!invalid) next.metricsMarginUnavailable = true;
  }
  for (const field of Object.keys(aliases) as AccountMetric[]) {
    const keys = aliases[field];
    const key = keys.find((candidate) => Object.prototype.hasOwnProperty.call(raw, candidate));
    const value = key ? accountMetricNumber(raw[key]) : null;
    const blocked = marginUnavailable && (field === 'margin' || field === 'freeMargin' || field === 'marginLevel');
    const preserve = !blocked && options.partial && key === undefined && current;
    next[field] = blocked ? 0 : value ?? (preserve ? current[field] ?? 0 : 0);
    next[flags[field]] = !invalid && !blocked && (value !== null || Boolean(preserve && current[flags[field]] !== false && Number.isFinite(current[field])));
    next.metricUpdatedAt![field] = blocked ? 0 : value !== null ? timestamp : preserve ? current.metricUpdatedAt?.[field] ?? 0 : 0;
  }
  if (next.margin < 0) next.hasBackendMargin = false;
  return next;
}

// The stored figure only when the backend supplied it (hasBackend* provenance), with no age or status gate.
// Readers that must not show or compute with an unvalued margin figure use this instead of the raw field.
export function accountMetricProvided(
  account: Partial<Account> | null | undefined,
  field: AccountMetric,
): number | null {
  if (!account || account[flags[field]] === false) return null;
  return accountMetricNumber(account[field]);
}

export function accountMetricAvailable(
  account: Partial<Account> | null | undefined,
  field: AccountMetric,
  now = Date.now(),
  maxAgeMs = ACCOUNT_METRICS_MAX_AGE_MS,
): boolean {
  if (!account || account[flags[field]] === false) return false;
  // A margin-only unavailability (available:false) must not hide the real equity, balance or credit.
  if (['stale', 'unavailable', 'invalid'].includes(account.metricsStatus ?? '') && !account.metricsMarginUnavailable) return false;
  const at = account.metricUpdatedAt?.[field];
  if (at !== undefined && (at <= 0 || now - at > maxAgeMs || at - now > 5_000)) return false;
  return accountMetricNumber(account[field]) !== null;
}
