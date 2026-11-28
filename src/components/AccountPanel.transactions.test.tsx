// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gateway = vi.hoisted(() => ({
  getAccount: vi.fn(),
  getBalanceHistory: vi.fn(),
}));

vi.mock('../api/tradeGateway', () => ({
  getStoredAccountLogin: () => 0,
  tradeGatewayApi: {
    getAccount: gateway.getAccount,
    getBalanceHistory: gateway.getBalanceHistory,
  },
}));

import { AccountPanel } from './AccountPanel';
import { useAppStore } from '../store/useAppStore';

afterEach(() => {
  cleanup();
  gateway.getAccount.mockReset();
  gateway.getBalanceHistory.mockReset();
  useAppStore.getState().reset();
  vi.restoreAllMocks();
});

describe('AccountPanel transaction time mapping (1.2.18 behaviour)', () => {
  it('throws RangeError and clears transactions when a row has an ISO timestamp string instead of substituting today', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    gateway.getAccount.mockResolvedValue({ leverage: 100 });
    gateway.getBalanceHistory.mockResolvedValue([
      { id: 'tx-valid', time: 1_700_050_000, type: 'deposit', amount: 100, comment: 'wire' },
      { id: 'tx-iso', time: '2026-01-15T10:00:00Z', type: 'deposit', amount: 250, comment: 'card' },
    ]);
    useAppStore.setState({ accountId: '1001' });

    render(<AccountPanel onClose={() => undefined} wsConnection={null} />);

    await waitFor(() => expect(gateway.getBalanceHistory).toHaveBeenCalledWith(1001, 10));
    await waitFor(() => expect(screen.getByText('No transactions yet')).toBeInTheDocument());

    expect(screen.queryByText('+$250.00')).toBeNull();
    expect(screen.queryByText('+$100.00')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('Failed to fetch transactions:', expect.any(RangeError));
  });

  it('throws RangeError and clears transactions when a row has non-numeric truthy time such as Infinity or text', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    gateway.getAccount.mockResolvedValue({ leverage: 100 });
    gateway.getBalanceHistory.mockResolvedValue([
      { id: 'tx-bad', time: 'bad', type: 'withdrawal', amount: 75 },
    ]);
    useAppStore.setState({ accountId: '1001' });

    render(<AccountPanel onClose={() => undefined} wsConnection={null} />);

    await waitFor(() => expect(gateway.getBalanceHistory).toHaveBeenCalledWith(1001, 10));
    await waitFor(() => expect(screen.getByText('No transactions yet')).toBeInTheDocument());

    expect(screen.queryByText('-$75.00')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('Failed to fetch transactions:', expect.any(RangeError));
  });

  it('renders numeric epoch seconds, numeric epoch strings, and falsy zero timestamps identically to 1.2.18', async () => {
    gateway.getAccount.mockResolvedValue({ leverage: 100 });
    gateway.getBalanceHistory.mockResolvedValue([
      { id: 'tx-num', time: 1_700_050_000, type: 'deposit', amount: 100, comment: 42 },
      { id: 'tx-str-num', time: '1700050000', type: 'withdrawal', amount: 50 },
      { id: 'tx-zero', time: 0, type: 'deposit', amount: 25 },
    ]);
    useAppStore.setState({ accountId: '1001' });

    render(<AccountPanel onClose={() => undefined} wsConnection={null} />);

    await waitFor(() => expect(screen.getByText('+$100.00')).toBeInTheDocument());
    expect(screen.getByText('-$50.00')).toBeInTheDocument();
    expect(screen.getByText('+$25.00')).toBeInTheDocument();
    expect(screen.getAllByText(/2023/).length).toBeGreaterThanOrEqual(2);
  });
});
