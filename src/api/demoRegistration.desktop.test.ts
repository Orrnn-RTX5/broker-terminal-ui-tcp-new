import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiClient } from './client';
import { authV2Api } from './trade';
import { registerDesktopBrokerDemoAccount, splitDemoAccountName } from './demoRegistration';

vi.mock('./client', () => ({
  ApiError: class ApiError extends Error {},
  apiClient: { post: vi.fn(), get: vi.fn() },
}));
vi.mock('./trade', () => ({ authV2Api: { login: vi.fn() } }));
vi.mock('../config/api', () => ({ API_V2_BASE_URL: 'http://127.0.0.1:18504/api/v2' }));
vi.mock('../config/backendTarget.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/backendTarget.js')>(),
  isDesktopBackendTarget: () => true,
}));

const input = { name: 'Demo  Test User', email: ' demo@example.test ', password: 'Password1', phone: ' +44 20 7946 0000 ' };

describe('desktop demo registration through the broker Manager', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('broker_id', 'tradex');
    vi.mocked(apiClient.post).mockReset();
    vi.mocked(authV2Api.login).mockReset();
  });

  it('creates the account on the Manager public demo route, then logs it in through the trader login', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ login: 300123, Group: 'test' });
    vi.mocked(authV2Api.login).mockResolvedValue({ access_token: 'session-token', refresh_token: 'refresh', account_login: 300123, broker_id: 'tradex' } as never);

    await expect(registerDesktopBrokerDemoAccount(input, 'tradex')).resolves.toMatchObject({
      access_token: 'session-token', token: 'session-token', account_login: 300123, broker_id: 'tradex', name: 'Demo  Test User',
    });
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith('/public/demo-account', {
      master_pass: 'Password1', email: 'demo@example.test', first_name: 'Demo', last_name: 'Test User', phone: '+44 20 7946 0000',
    }, { baseUrl: 'http://127.0.0.1:18504/api/v1', skipDynamicUrl: true, skipAuth: true });
    const body = vi.mocked(apiClient.post).mock.calls[0][1] as Record<string, unknown>;
    // The broker decides group, leverage, currency, balance and mode; the terminal never sends them.
    for (const key of ['group', 'leverage', 'currency', 'initial_balance', 'credit', 'account_mode', 'origin_broker']) {
      expect(body).not.toHaveProperty(key);
    }
    expect(authV2Api.login).toHaveBeenCalledExactlyOnceWith(
      { username: '300123', password: 'Password1', broker_id: 'tradex' },
      { baseUrl: 'http://127.0.0.1:18504/api/v2', skipDynamicUrl: true, persistSession: false },
    );
  });

  it('asks the Manager for a netting account only when netting was chosen', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ login: 300127 });
    vi.mocked(authV2Api.login).mockResolvedValue({ access_token: 'session-token', account_login: 300127 } as never);
    await registerDesktopBrokerDemoAccount({ ...input, accountMode: 'netting' }, 'tradex');
    expect(vi.mocked(apiClient.post).mock.calls[0][1]).toMatchObject({ account_mode: 'netting' });

    vi.mocked(apiClient.post).mockClear();
    await registerDesktopBrokerDemoAccount({ ...input, accountMode: 'hedging' }, 'tradex');
    expect(vi.mocked(apiClient.post).mock.calls[0][1]).not.toHaveProperty('account_mode');
  });

  it.each([
    [503, 'DEMO_NETTING_NOT_CONFIGURED', 'not available from this broker'],
    [409, 'ACCOUNT_MODE_GROUP_MISMATCH', 'Nothing was created'],
  ])('explains a netting refusal %s %s without logging in', async (status, code, text) => {
    vi.mocked(apiClient.post).mockRejectedValue(Object.assign(new ApiError('refused'), { status, data: { code } }));
    await expect(registerDesktopBrokerDemoAccount({ ...input, accountMode: 'netting' }, 'tradex')).rejects.toThrow(text);
    expect(authV2Api.login).not.toHaveBeenCalled();
  });

  it('accepts the commission-approval answer, which carries the login only', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ login: 300124, commission_approval_id: 7 });
    vi.mocked(authV2Api.login).mockResolvedValue({ token: 'session-token', account_login: 300124 } as never);
    await expect(registerDesktopBrokerDemoAccount(input, 'tradex')).resolves.toMatchObject({ account_login: 300124, broker_id: 'tradex' });
  });

  it('refuses a one-word name before sending anything', async () => {
    await expect(registerDesktopBrokerDemoAccount({ ...input, name: 'Demo' }, 'tradex')).rejects.toThrow('first and last name');
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('does not log in when the Manager returns no login', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ opening_funding: 'pending' });
    await expect(registerDesktopBrokerDemoAccount(input, 'tradex')).rejects.toThrow('did not return the new demo account login');
    expect(authV2Api.login).not.toHaveBeenCalled();
  });

  it('names the created login when the following login fails', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ login: 300125 });
    vi.mocked(authV2Api.login).mockRejectedValue(new Error('Invalid credentials'));
    await expect(registerDesktopBrokerDemoAccount(input, 'tradex')).rejects.toThrow(
      'Demo account 300125 was created, but logging in to it failed (Invalid credentials). Log in with account 300125',
    );
  });

  it('refuses a session returned for another broker', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ login: 300126 });
    vi.mocked(authV2Api.login).mockResolvedValue({ access_token: 'other', account_login: 300126, broker_id: 'yo4x' } as never);
    await expect(registerDesktopBrokerDemoAccount(input, 'tradex')).rejects.toThrow('different broker');
  });

  it('splits names on any whitespace', () => {
    expect(splitDemoAccountName('  Ana   Maria  Lopez ')).toEqual({ firstName: 'Ana', lastName: 'Maria Lopez' });
    expect(splitDemoAccountName('Ana')).toBeNull();
    expect(splitDemoAccountName('   ')).toBeNull();
  });
});
