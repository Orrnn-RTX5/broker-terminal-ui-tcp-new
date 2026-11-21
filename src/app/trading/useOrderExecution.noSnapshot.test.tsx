import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../services/api';
import {
  createTradeOperationContext,
  type TradeOperationContext,
} from '../../features/trading/session/tradeOperationContext';
import type { SymbolMarketStatusState } from '../../hooks/useSymbolMarketStatus';
import { useOrderExecution } from './useOrderExecution';

vi.mock('../../services/tradingAuthGate', () => ({
  requireTradingAuth: vi.fn(() => true),
}));

vi.mock('../../services/api', () => ({
  api: {
    orders: {
      placeMarketOrder: vi.fn(),
      placePendingOrder: vi.fn(),
    },
  },
}));

vi.mock('./positionRuntime', () => ({
  getChartEntryPriceForSymbol: vi.fn(() => 1.101),
  normalizePositions: vi.fn(() => [{ id: 71, symbol: 'EURUSD' }]),
  upsertImmediatePosition: vi.fn(),
}));

const openMarketStatus: SymbolMarketStatusState = {
  symbol: 'EURUSD',
  status: 'open',
  isOpen: true,
  isTradeBlocked: false,
  label: 'Market Open',
  loading: false,
  error: null,
  refreshedAt: Date.now(),
};

const mountController = (captureTradeOperationContext: (expectedLogin?: number) => TradeOperationContext | null) => {
  const refreshPositions = vi.fn().mockResolvedValue(undefined);
  const refreshOrdersAndHistory = vi.fn().mockResolvedValue(undefined);
  const result = renderHook(() => useOrderExecution({
    selectedMarketStatus: openMarketStatus,
    selectedSymbol: 'EURUSD',
    volume: 0.1,
    setVolume: vi.fn(),
    domSymbol: 'EURUSD',
    orderPanelSymbol: 'EURUSD',
    getAllowedSymbol: (symbol) => String(symbol),
    getLiveTradingLogin: () => 123,
    captureTradeOperationContext,
    isTradeOperationContextCurrent: () => true,
    refreshPositions,
    refreshOrdersAndHistory,
  }));
  return { ...result, refreshOrdersAndHistory };
};

describe('useOrderExecution without a loaded positions snapshot', () => {
  const context = createTradeOperationContext('broker:123', 123, 4);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(api.orders.placeMarketOrder).mockResolvedValue({ ticket: 71 } as never);
  });

  // No setPositions(..., { readStartedAt }) call in this file: the broker snapshot is not ready,
  // so the open-position list cannot prove the fill is a pure open and history is still refreshed.
  it('keeps the closed-history refresh for a market fill', async () => {
    const controller = mountController(() => context);
    await act(() => controller.result.current.placeOrder('BUY'));
    expect(controller.refreshOrdersAndHistory).toHaveBeenCalledTimes(1);
    const [login, options] = controller.refreshOrdersAndHistory.mock.calls[0];
    expect(login).toBe(123);
    expect(options?.skipHistory).not.toBe(true);
  });
});
