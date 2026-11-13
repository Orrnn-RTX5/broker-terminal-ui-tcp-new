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
