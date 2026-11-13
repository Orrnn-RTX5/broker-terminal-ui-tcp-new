import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gateway = vi.hoisted(() => ({ getAccount: vi.fn() }));
vi.mock('../api/tradeGateway', () => ({
  getStoredAccountLogin: () => 0,
  tradeGatewayApi: { getAccount: gateway.getAccount, getBalanceHistory: vi.fn().mockResolvedValue([]) },
}));

import { AccountPanel } from './AccountPanel';
import { normalizeAccountMetrics } from '../services/accountMetrics';
import { useAppStore } from '../store/useAppStore';

const now = 1_789_558_200_000;
const token = '17895582000000000001';

const rowFor = (label: string): string => {
  const labelNode = screen.getByText(label);
  return labelNode.parentElement?.textContent ?? '';
};

afterEach(() => {
  cleanup();
  gateway.getAccount.mockReset();
});

describe('AccountPanel margin values', () => {
  it('shows the unavailable placeholder, not 0.00, for margin fields the backend could not value', async () => {
    gateway.getAccount.mockResolvedValue({ leverage: 100 });
    const account = normalizeAccountMetrics({
      type: 'metrics_update', publication_token: token, login: 1001, balance: 1000, credit: 0, equity: 1000,
      used_margin: null, free_margin: null, margin_level: null, available: false, reason: 'margin_unavailable',
    }, null, { now, login: 1001 });
    useAppStore.setState({ accountId: '1001', account });

    render(<AccountPanel onClose={() => undefined} />);
    await waitFor(() => expect(gateway.getAccount).toHaveBeenCalled());

    expect(rowFor('Margin')).toContain('\u2014');
    expect(rowFor('Margin')).not.toContain('0.00');
    expect(rowFor('Free Margin')).toContain('\u2014');
    expect(rowFor('Free Margin')).not.toContain('0.00');
    expect(rowFor('Margin Level')).toContain('\u2014');
    expect(rowFor('Margin Level')).not.toContain('0.00');
    expect(rowFor('Equity')).toContain('1,000.00');
  });

  it('renders a valued account with the same figures as before', async () => {
    gateway.getAccount.mockResolvedValue({ leverage: 100 });
    const account = normalizeAccountMetrics({
      type: 'metrics_update', publication_token: token, login: 1001, balance: 100, credit: 0, equity: 90,
      used_margin: 110, free_margin: -20, margin_level: 81.81,
    }, null, { now, login: 1001 });
    useAppStore.setState({ accountId: '1001', account });

    render(<AccountPanel onClose={() => undefined} />);
    await waitFor(() => expect(gateway.getAccount).toHaveBeenCalled());

    expect(rowFor('Margin')).toContain('110.00');
    expect(rowFor('Free Margin')).toContain('-20.00');
    expect(rowFor('Margin Level')).toContain('81.81%');
    expect(rowFor('Equity')).toContain('90.00');
  });
});
