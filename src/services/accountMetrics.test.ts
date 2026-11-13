import { describe, expect, it } from 'vitest';
import { accountMetricAvailable, accountMetricProvided, normalizeAccountMetrics } from './accountMetrics';

const now = 1_789_558_200_000;
const complete = { balance: 100, equity: 90, used_margin: 110, free_margin: -20, floating_pnl: -12, credit: 2, margin_level: 81.81 };
const newer = '17895582000000000002';
const older = '17895582000000000001';

describe('authoritative account metrics', () => {
  it('preserves Money, used margin, credit, and negative free margin', () => {
    const result = normalizeAccountMetrics({ ...complete, balance: { amount: '100.25' } }, null, { now });
    expect(result).toMatchObject({ balance: 100.25, margin: 110, freeMargin: -20, unrealizedPL: -12, credit: 2 });
    expect(accountMetricAvailable(result, 'freeMargin', now)).toBe(true);
  });

  it('carries canonical account-currency digits, including an explicit zero scale', () => {
    const usd = normalizeAccountMetrics({ ...complete, currency: 'USD', currency_digits: 2 }, null, { now });
    const zeroDigit = normalizeAccountMetrics({ ...complete, currency: 'USD', currency_digits: 0 }, null, { now });
    expect(usd.currencyDigits).toBe(2);
    expect(zeroDigit.currencyDigits).toBe(0);
  });

  it('accepts a genuine zero balance after funding', () => {
    const previous = normalizeAccountMetrics(complete, null, { now });
    expect(normalizeAccountMetrics({ ...complete, balance: 0, equity: 0 }, previous, { now }).balance).toBe(0);
  });

  it('does not manufacture missing values or treat blank and boolean fields as money', () => {
    const result = normalizeAccountMetrics({ balance: 100, equity: '', used_margin: true }, null, { now });
    for (const key of ['equity', 'margin', 'freeMargin', 'unrealizedPL', 'marginLevel', 'credit'] as const) {
      expect(accountMetricAvailable(result, key, now)).toBe(false);
    }
  });

  it('unwraps nested metrics without losing the token', () => {
    const result = normalizeAccountMetrics({ channel: 'metrics.7', data: { type: 'metrics_update', publication_token: newer, data: { ...complete, login: 7 } } }, null, { login: 7, now });
    expect(result).toMatchObject({ publicationToken: newer, margin: 110 });
  });

  it('orders REST and WS using exact strings beyond Number precision', () => {
    const result = normalizeAccountMetrics({ ...complete, publication_token: newer }, null, { scope: 'a', now });
    expect(normalizeAccountMetrics({ balance: 999, publication_token: older }, result, { scope: 'a', now })).toBe(result);
    expect(normalizeAccountMetrics({ balance: 999 }, result, { scope: 'a', now })).toBe(result);
    expect(normalizeAccountMetrics({ balance: 999, publication_token: Number(newer) }, result, { scope: 'a', now })).toBe(result);
  });

  it('allows a new account session to start independently', () => {
    const previous = normalizeAccountMetrics({ ...complete, publication_token: newer }, null, { scope: 'a', now });
    expect(normalizeAccountMetrics({ ...complete, balance: 0, publication_token: older }, previous, { scope: 'b', now })).toMatchObject({ balance: 0, publicationToken: older, metricsScope: 'b' });
  });

  it('enriches late profile metadata without rolling back streamed money', () => {
    const previous = normalizeAccountMetrics({ ...complete, publication_token: newer }, null, { scope: 'a', now });
    const result = normalizeAccountMetrics({ balance: 9999, currency: 'INR', leverage: 200 }, previous, { scope: 'a', now });
    expect(result).toMatchObject({ balance: 100, currency: 'INR', leverage: 200, publicationToken: newer });
    expect(result.metricUpdatedAt).toBe(previous.metricUpdatedAt);
  });

  it('rejects payload ownership mismatches', () => {
    const previous = normalizeAccountMetrics(complete, null, { scope: 'a', login: 7, now });
    expect(normalizeAccountMetrics({ ...complete, login: 8 }, previous, { scope: 'a', login: 7, now })).toBe(previous);
    const first = normalizeAccountMetrics({ ...complete, login: 8, publication_token: newer }, null, { scope: 'a', login: 7, now });
    expect(first.publicationToken).toBeUndefined();
    expect(accountMetricAvailable(first, 'balance', now)).toBe(false);
  });

  it('keeps invalid metadata unavailable and preserves calculation versions', () => {
    const result = normalizeAccountMetrics({ ...complete, valid: false, calculation_version: 'mt5-v1', margin_calculation_version: 'legacy-v1', configuration_version: 'legacy-v1' }, null, { now });
    expect(result).toMatchObject({ calculationVersion: 'mt5-v1', marginCalculationVersion: 'legacy-v1', configurationVersion: 'legacy-v1' });
    expect(accountMetricAvailable(result, 'equity', now)).toBe(false);
    expect(accountMetricAvailable(normalizeAccountMetrics({ ...complete, publication_token: '00000000000000000000' }, null, { now }), 'balance', now)).toBe(false);
    expect(accountMetricAvailable(normalizeAccountMetrics({ ...complete, calculated_at: 'invalid' }, null, { now }), 'balance', now)).toBe(false);
  });

  it('preserves omitted partial fields without refreshing their age', () => {
    const previous = normalizeAccountMetrics(complete, null, { now });
    const result = normalizeAccountMetrics({ credit: 0 }, previous, { partial: true, now: now + 31_000 });
    expect(result.equity).toBe(90);
    expect(accountMetricAvailable(result, 'equity', now + 31_000)).toBe(false);
    expect(accountMetricAvailable(result, 'credit', now + 31_000)).toBe(true);
  });

  it('uses calculation time rather than receipt time for stale snapshots', () => {
    const result = normalizeAccountMetrics({ ...complete, calculated_at: now - 31_000 }, null, { now });
    expect(accountMetricAvailable(result, 'equity', now)).toBe(false);
  });

  it('does not refresh an old quote when a newer calculation is published', () => {
    const sourceAsOf = now - 29_000;
    const previous = normalizeAccountMetrics({ ...complete, calculated_at: now - 1_000, source_as_of: sourceAsOf, publication_token: older }, null, { now });
    const recalculated = normalizeAccountMetrics({ ...complete, calculated_at: now, source_as_of: sourceAsOf, publication_token: newer }, previous, { now });
    expect(recalculated.metricUpdatedAt?.equity).toBe(sourceAsOf);
    expect(accountMetricAvailable(recalculated, 'equity', now)).toBe(true);
    expect(accountMetricAvailable(recalculated, 'equity', now + 1_001)).toBe(false);
    expect(accountMetricAvailable(recalculated, 'freeMargin', now + 1_001)).toBe(false);
  });

  it('bounds freshness by calculation time even when source time is newer', () => {
    const result = normalizeAccountMetrics({ ...complete, calculated_at: now - 31_000, source_as_of: now }, null, { now });
    expect(result.metricUpdatedAt?.equity).toBe(now - 31_000);
    expect(accountMetricAvailable(result, 'equity', now)).toBe(false);
    const invalid = normalizeAccountMetrics({ ...complete, calculated_at: now + 5_001, source_as_of: now }, null, { now });
    expect(accountMetricAvailable(invalid, 'equity', now)).toBe(false);
  });

  it.each([null, 0, -1, '', 'invalid', false, NaN, Infinity, now + 5_001, now + 0.5])('marks an invalid explicit source timestamp unavailable: %s', (source_as_of) => {
    const result = normalizeAccountMetrics({ ...complete, calculated_at: now, source_as_of }, null, { now });
    expect(result.metricsStatus).toBe('unavailable');
    expect(accountMetricAvailable(result, 'equity', now)).toBe(false);
  });

  it('retains legacy calculation or receipt freshness when source time is absent', () => {
    const calculated = normalizeAccountMetrics({ ...complete, calculated_at: now - 1_000 }, null, { now });
    const legacy = normalizeAccountMetrics(complete, null, { now });
    expect(calculated.metricUpdatedAt?.equity).toBe(now - 1_000);
    expect(legacy.metricUpdatedAt?.equity).toBe(now);
    expect(accountMetricAvailable(calculated, 'equity', now)).toBe(true);
    expect(accountMetricAvailable(legacy, 'equity', now)).toBe(true);
  });

  it('carries closed-market state without claiming expired values are live', () => {
    const result = normalizeAccountMetrics({ ...complete, market_closed: true, calculated_at: now - 31_000 }, null, { now });
    expect(result.marketClosed).toBe(true);
    expect(accountMetricAvailable(result, 'equity', now)).toBe(false);
  });
});

describe('margin unavailable (available:false)', () => {
  const unavailable = { balance: 1000, credit: 0, equity: 1000, used_margin: null, free_margin: null, margin_level: null, available: false, reason: 'margin_unavailable' };

  it('marks margin, free margin and margin level unavailable with no 0 exposed', () => {
    const result = normalizeAccountMetrics({ ...unavailable, publication_token: older }, null, { now });
    for (const key of ['margin', 'freeMargin', 'marginLevel'] as const) {
      expect(accountMetricProvided(result, key)).toBeNull();
      expect(accountMetricAvailable(result, key, now)).toBe(false);
    }
    expect(result.metricsStatus).toBe('unavailable');
  });

  it('keeps real balance, equity and credit available', () => {
    const result = normalizeAccountMetrics({ ...unavailable, credit: 2, publication_token: older }, null, { now });
    expect(accountMetricProvided(result, 'equity')).toBe(1000);
    for (const key of ['balance', 'equity', 'credit'] as const) {
      expect(accountMetricAvailable(result, key, now)).toBe(true);
    }
  });

  it('treats numeric margin fields as unavailable when the event says available:false', () => {
    const result = normalizeAccountMetrics({ ...complete, available: false, publication_token: older }, null, { now });
    expect(accountMetricProvided(result, 'margin')).toBeNull();
    expect(accountMetricProvided(result, 'freeMargin')).toBeNull();
    expect(accountMetricProvided(result, 'marginLevel')).toBeNull();
  });

  it('reads available:false nested inside data', () => {
    const result = normalizeAccountMetrics({ type: 'metrics_update', publication_token: older, data: { ...unavailable } }, null, { now });
    expect(accountMetricProvided(result, 'marginLevel')).toBeNull();
    expect(accountMetricAvailable(result, 'equity', now)).toBe(true);
  });

  it('restores margin fields from a later normal event', () => {
    const blocked = normalizeAccountMetrics({ ...unavailable, publication_token: older }, null, { now });
    const restored = normalizeAccountMetrics({ ...complete, publication_token: newer }, blocked, { now });
    expect(accountMetricProvided(restored, 'margin')).toBe(110);
    expect(accountMetricAvailable(restored, 'freeMargin', now)).toBe(true);
    expect(restored.metricsStatus).toBe('valid');
  });
});


describe('token-less REST answers after a stamped frame locked the token', () => {
  const stampedAt = now - 2_000;
  const stampedFrame = {
    balance: 89999.95, equity: 89999.95, credit: 0, calculated_at: stampedAt, source_as_of: stampedAt, publication_token: older,
  };
  const heldFrame = () => normalizeAccountMetrics(stampedFrame, null, { now });

  it('applies a REST answer newer than the held stamped frame (owner case: 89999.95 then 89999.78)', () => {
    const rest = { balance: 89999.78, equity: 89999.78, credit: 0, calculated_at: now - 1_000, source_as_of: now - 1_000 };
    const result = normalizeAccountMetrics(rest, heldFrame(), { partial: true, now });
    expect(result).toMatchObject({ balance: 89999.78, equity: 89999.78, publicationToken: older });
    expect(accountMetricAvailable(result, 'balance', now)).toBe(true);
  });

  it('ignores a REST answer whose source_as_of is not newer than the held value', () => {
    const held = heldFrame();
    expect(normalizeAccountMetrics({ balance: 89999.78, credit: 0, source_as_of: stampedAt }, held, { partial: true, now })).toBe(held);
    expect(normalizeAccountMetrics({ balance: 89999.78, credit: 0, source_as_of: stampedAt - 500 }, held, { partial: true, now })).toBe(held);
    expect(normalizeAccountMetrics({ balance: 89999.78, credit: 0, calculated_at: stampedAt }, held, { partial: true, now })).toBe(held);
  });

  it('uses calculated_at when a REST answer has no source_as_of, and never rolls back an applied answer', () => {
    const held = heldFrame();
    const applied = normalizeAccountMetrics({ balance: 89999.78, credit: 0, calculated_at: now - 1_000 }, held, { partial: true, now });
    expect(applied.balance).toBe(89999.78);
    expect(normalizeAccountMetrics({ balance: 89999.90, credit: 0, source_as_of: now - 1_500 }, applied, { partial: true, now })).toBe(applied);
  });

  it('ignores a token-less answer that carries no time field', () => {
    const held = heldFrame();
    expect(normalizeAccountMetrics({ balance: 89999.78, credit: 0 }, held, { partial: true, now })).toBe(held);
  });

  it('still applies a later stamped frame with a newer token and ignores an older token', () => {
    const restApplied = normalizeAccountMetrics({ balance: 89999.78, credit: 0, source_as_of: now - 1_000 }, heldFrame(), { partial: true, now });
    const newerFrame = normalizeAccountMetrics({ balance: 89999.60, credit: 0, calculated_at: now - 500, source_as_of: now - 500, publication_token: newer }, restApplied, { now });
    expect(newerFrame).toMatchObject({ balance: 89999.60, publicationToken: newer });
    expect(normalizeAccountMetrics({ balance: 1, credit: 0, source_as_of: now, publication_token: older }, newerFrame, { now })).toBe(newerFrame);
  });
});

describe('token-less answers with an unchanged source_as_of (quiet symbol)', () => {
  const quietSource = now - 60_000;
  const held = () => normalizeAccountMetrics({
    balance: 89999.95, credit: 0, calculated_at: now - 2_000, source_as_of: quietSource, publication_token: older,
  }, null, { now });

  it('applies an answer with the same source_as_of and a newer calculated_at', () => {
    const later = { balance: 89999.78, credit: 0, calculated_at: now - 1_000, source_as_of: quietSource };
    const applied = normalizeAccountMetrics(later, held(), { partial: true, now });
    expect(applied.balance).toBe(89999.78);
    expect(applied.metricsCalculatedAt).toBe(now - 1_000);
    expect(applied.metricsAsOf).toBe(quietSource);
    expect(applied.publicationToken).toBe(older);
  });

  it('ignores an answer with the same source_as_of and the same calculated_at', () => {
    const previous = held();
    const same = { balance: 1, credit: 0, calculated_at: now - 2_000, source_as_of: quietSource };
    expect(normalizeAccountMetrics(same, previous, { partial: true, now })).toBe(previous);
  });
});

describe('time-less held frame (no server times) and client clock skew', () => {
  // The server clock is the true clock (now). The client clock is offset by `skew` ms.
  const restAnswer = (serverAt: number) => ({ balance: 99.5, credit: 0, calculated_at: serverAt, source_as_of: serverAt });
  const frame = (receivedAt: number) => normalizeAccountMetrics(
    { balance: 100, credit: 0, publication_token: older }, null, { now: receivedAt },
  );

  it('applies a REST answer whose request started after the time-less frame was received', () => {
    const held = frame(now);
    const result = normalizeAccountMetrics(restAnswer(now + 1_000), held, { partial: true, now: now + 2_000, requestedAt: now + 1_000 });
    expect(result).toMatchObject({ balance: 99.5, publicationToken: older });
  });

  it('ignores a REST answer whose request started before the time-less frame was received', () => {
    const held = frame(now);
    expect(normalizeAccountMetrics(restAnswer(now - 1_000), held, { partial: true, now: now + 500, requestedAt: now - 1_000 })).toBe(held);
  });

  it.each([0, 60_000, -3_000])('client clock offset %i ms: no freeze and no rollback', (skew) => {
    const held = frame(now + skew);
    // Sent 1 s after the frame arrived: must apply, whatever the client clock says.
    const after = normalizeAccountMetrics(restAnswer(now + 1_000), held, { partial: true, now: now + 2_000 + skew, requestedAt: now + 1_000 + skew });
    expect(after.balance).toBe(99.5);
    // Sent 1 s before the frame arrived (answer older than the frame): must stay ignored.
    expect(normalizeAccountMetrics(restAnswer(now - 1_000), held, { partial: true, now: now + 500 + skew, requestedAt: now - 1_000 + skew })).toBe(held);
  });
});

describe('unlocked held value (no publication token): out-of-order REST answers never roll back', () => {
  it('with server times: an older answer that arrives last is ignored', () => {
    const newer = normalizeAccountMetrics({ balance: 100, credit: 0, calculated_at: now - 500, source_as_of: now - 500 }, null, { now, requestedAt: now - 500 });
    const late = normalizeAccountMetrics({ balance: 99, credit: 0, calculated_at: now - 2_000, source_as_of: now - 2_000 }, newer, { partial: true, now, requestedAt: now - 2_000 });
    expect(late).toBe(newer);
    expect(late.balance).toBe(100);
  });

  it('without server times: an answer whose request started before the held one is ignored', () => {
    const newer = normalizeAccountMetrics({ balance: 100, credit: 0 }, null, { now: now - 500, requestedAt: now - 500 });
    const late = normalizeAccountMetrics({ balance: 99, credit: 0 }, newer, { partial: true, now, requestedAt: now - 2_000 });
    expect(late).toBe(newer);
  });

  it('accepts the first answer, and a later answer whose request started after it', () => {
    const first = normalizeAccountMetrics({ balance: 99, credit: 0, calculated_at: now - 2_000, source_as_of: now - 2_000 }, null, { now, requestedAt: now - 2_000 });
    expect(first.balance).toBe(99);
    const newer = normalizeAccountMetrics({ balance: 100, credit: 0, calculated_at: now - 500, source_as_of: now - 500 }, first, { partial: true, now, requestedAt: now - 500 });
    expect(newer.balance).toBe(100);
  });

  it('never compares a server time with a client time: a server-timed answer sent later applies over a time-less held value', () => {
    const held = normalizeAccountMetrics({ balance: 100, credit: 0 }, null, { now: now - 2_000, requestedAt: now - 2_000 });
    // The server time is older than the held client time, but the request was sent after it.
    const later = normalizeAccountMetrics({ balance: 99, credit: 0, calculated_at: now - 3_000, source_as_of: now - 3_000 }, held, { partial: true, now, requestedAt: now - 1_000 });
    expect(later.balance).toBe(99);
  });
});

