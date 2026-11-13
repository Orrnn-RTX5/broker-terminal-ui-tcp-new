import { afterEach, describe, expect, it } from 'vitest';
import { useAppStore } from './useAppStore';
import { normalizeAccountMetrics } from '../services/accountMetrics';

afterEach(() => useAppStore.setState({ account: null }));

describe('account publication ordering across store writers', () => {
  it('prevents a delayed tokenless REST writer from replacing streamed metrics', () => {
    const latest = normalizeAccountMetrics({ balance: 0, publication_token: '17895582000000000002' }, null, { scope: 'session-a' });
    useAppStore.setState({ account: latest });
    useAppStore.getState().setAccount(normalizeAccountMetrics({ balance: 500 }));
    expect(useAppStore.getState().account).toBe(latest);
    useAppStore.getState().setAccount(normalizeAccountMetrics({ balance: 500, publication_token: '17895582000000000001' }));
    expect(useAppStore.getState().account).toBe(latest);
  });

  it('permits an explicit session reset', () => {
    useAppStore.setState({ account: normalizeAccountMetrics({ balance: 0, publication_token: '17895582000000000002' }) });
    useAppStore.getState().setAccount(null);
    useAppStore.getState().setAccount(normalizeAccountMetrics({ balance: 100, publication_token: '17895582000000000001' }));
    expect(useAppStore.getState().account?.balance).toBe(100);
  });
});

describe('token-less REST answers after a stamped frame locked the token', () => {
  it('stores a REST answer newer than the held stamped frame, and keeps an older one out', () => {
    const at = Date.now();
    const held = normalizeAccountMetrics({
      balance: 89999.95, credit: 0, calculated_at: at - 2_000, source_as_of: at - 2_000, publication_token: '17895582000000000002',
    }, null, { scope: 'session-a' });
    useAppStore.setState({ account: held });
    useAppStore.getState().setAccount(normalizeAccountMetrics({ balance: 89999.78, credit: 0, source_as_of: at - 1_000 }, held, { partial: true, scope: 'session-a' }));
    expect(useAppStore.getState().account?.balance).toBe(89999.78);
    expect(useAppStore.getState().account?.publicationToken).toBe('17895582000000000002');
    const applied = useAppStore.getState().account;
    useAppStore.getState().setAccount(normalizeAccountMetrics({ balance: 1, credit: 0, source_as_of: at - 1_500 }, applied, { partial: true, scope: 'session-a' }));
    expect(useAppStore.getState().account).toBe(applied);
  });
});

describe('time-less held frame and REST answers in the store', () => {
  it('stores a REST answer whose request started after the time-less frame was received', () => {
    const received = Date.now();
    const held = normalizeAccountMetrics({ balance: 100, credit: 0, publication_token: '17895582000000000002' }, null, { scope: 'session-a', now: received });
    useAppStore.setState({ account: held });
    const sent = received + 1_000;
    useAppStore.getState().setAccount(normalizeAccountMetrics(
      { balance: 99.5, credit: 0, calculated_at: sent, source_as_of: sent },
      held,
      { partial: true, scope: 'session-a', now: sent + 500, requestedAt: sent },
    ));
    expect(useAppStore.getState().account?.balance).toBe(99.5);
  });
});

describe('unlocked held value in the store', () => {
  it('keeps the newer value when an older REST answer reaches the store last', () => {
    const at = Date.now();
    const newer = normalizeAccountMetrics({ balance: 100, credit: 0 }, null, { scope: 'session-a', now: at - 500, requestedAt: at - 500 });
    useAppStore.setState({ account: newer });
    const late = normalizeAccountMetrics({ balance: 99, credit: 0 }, null, { scope: 'session-a', now: at, requestedAt: at - 2_000 });
    useAppStore.getState().setAccount(late);
    expect(useAppStore.getState().account).toBe(newer);
  });
});

