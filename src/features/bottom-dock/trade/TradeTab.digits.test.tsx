// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TradeTab } from './TradeTab';
import { PendingOrdersPanel } from './PendingOrdersPanel';
import { useAppStore } from '../../../store/useAppStore';
import {
  registerDailyChangePriceModes,
  resetDailyChangePriceModeRegistryForTests,
} from '../../../services/dailyChangePriceModeRegistry';
import {
  commitBrokerAccountSessionScope,
} from '../../../services/brokerSession';

const makeBtcPosition = (overrides: Record<string, unknown>) => ({
  id: 1048609,
  ticket: 1048609,
  account_login: 200003,
  symbol: 'BTCUSD',
  side: 'BUY',
  volume: 0.01,
  openPrice: 75755.51000000001,
  price_open: 75755.51000000001,
  open_price: 75755.51000000001,
  currentPrice: 75736.48,
  price_current: 75736.48,
  current_price: 75736.48,
  hasBackendCurrentPrice: true,
  profit: -0.19,
  unrealizedPnL: -0.19,
  hasBackendProfit: true,
  openTime: '2026-04-17T07:10:35.091Z',
  time_create: '2026-04-17T07:10:35.091Z',
  sl: 75500.5,
  price_sl: 75500.5,
  tp: 76100.1,
  price_tp: 76100.1,
  swap: 0,
  commission: 0,
  ...overrides,
});

describe('TradeTab & PendingOrdersPanel — exact symbol digits formatting', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    commitBrokerAccountSessionScope({
      authenticated: true,
      accountId: '200003',
      brokerId: 'tradex',
      serverUrl: 'https://tradex.example',
    });
    resetDailyChangePriceModeRegistryForTests();
    // Binary TCP tick in store without .digits field (48-byte 0x21 frame shape)
    useAppStore.setState({
      accountId: '200003',
      ticks: {
        BTCUSD: {
          symbol: 'BTCUSD',
          bid: 75736.48,
          ask: 75755.5,
          spread: 19.02,
          timestamp: 1776409835000,
        } as never,
      },
      positions: [],
      orders: [],
    });
  });

  afterEach(() => {
    cleanup();
    commitBrokerAccountSessionScope({ authenticated: false, brokerId: '', serverUrl: '' });
    resetDailyChangePriceModeRegistryForTests();
    useAppStore.setState({ accountId: null, ticks: {}, positions: [], orders: [] });
  });

  it('formats BTCUSD Positions row PRICE OPEN, CURRENT PRICE, S/L, T/P to exact symbol digits from registered instrument catalog when tick.digits is absent', () => {
    registerDailyChangePriceModes([
      {
        symbol: 'BTCUSD',
        digits: 2,
        tickSize: 0.01,
        contractSize: 1,
        brokerSpecification: { chart_mode: 'bid' },
      },
    ]);

    const rows = [
      makeBtcPosition({ id: 1048603, ticket: 1048603, openPrice: 75758.68000000001, price_open: 75758.68000000001 }),
      makeBtcPosition({ id: 1048605, ticket: 1048605, openPrice: 75756.12000000001, price_open: 75756.12000000001 }),
      makeBtcPosition({ id: 1048607, ticket: 1048607, openPrice: 75756.03, price_open: 75756.03 }),
      makeBtcPosition({ id: 1048609, ticket: 1048609, openPrice: 75755.51000000001, price_open: 75755.51000000001 }),
      makeBtcPosition({ id: 1048611, ticket: 1048611, openPrice: 75755.5, price_open: 75755.5 }),
    ];

    render(
      <TradeTab
        positions={rows as never}
        account={null}
        onClosePosition={vi.fn()}
        onModifyPosition={vi.fn()}
        formatMoney={(value) => (value == null ? '—' : value.toFixed(2))}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByTitle('Open price: 75758.68')).toHaveTextContent('75758.68');
    expect(screen.getByTitle('Open price: 75756.12')).toHaveTextContent('75756.12');
    expect(screen.getByTitle('Open price: 75756.03')).toHaveTextContent('75756.03');
    expect(screen.getByTitle('Open price: 75755.51')).toHaveTextContent('75755.51');
    expect(screen.getByTitle('Open price: 75755.50')).toHaveTextContent('75755.50');

    expect(screen.getAllByTitle('Current price: 75736.48')).toHaveLength(5);
    expect(screen.getAllByText('75500.50').length).toBeGreaterThanOrEqual(5);
    expect(screen.getAllByText('76100.10').length).toBeGreaterThanOrEqual(5);

    expect(screen.queryByText(/00000001/)).toBeNull();
  });

  it('formats BTCUSD Positions row using position.digits when neither tick.digits nor catalog is populated yet', () => {
    const rows = [
      makeBtcPosition({
        id: 1048609,
        ticket: 1048609,
        digits: 2,
        openPrice: 75755.51000000001,
        price_open: 75755.51000000001,
        currentPrice: 75736.5,
        price_current: 75736.5,
      }),
    ];

    render(
      <TradeTab
        positions={rows as never}
        account={null}
        onClosePosition={vi.fn()}
        onModifyPosition={vi.fn()}
        formatMoney={(value) => (value == null ? '—' : value.toFixed(2))}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByTitle('Open price: 75755.51')).toHaveTextContent('75755.51');
    expect(screen.getByTitle('Current price: 75736.50')).toHaveTextContent('75736.50');
  });

  it('formats PendingOrdersPanel Price, SL, TP using registered symbol digits when tick.digits is absent', () => {
    registerDailyChangePriceModes([
      {
        symbol: 'BTCUSD',
        digits: 2,
        tickSize: 0.01,
        contractSize: 1,
      },
    ]);

    useAppStore.setState({
      orders: [
        {
          ticket: 5001,
          symbol: 'BTCUSD',
          type: 'buy_limit',
          volume: 0.01,
          price: 75755.5,
          price_sl: 75500.1,
          price_tp: 76000.8,
          status: 'pending',
        } as never,
      ],
    });

    render(
      <PendingOrdersPanel
        onModifyOrder={vi.fn()}
        onCancelOrder={vi.fn()}
      />,
    );

    expect(screen.getByText('75755.50')).toBeInTheDocument();
    expect(screen.getByText('75500.10')).toBeInTheDocument();
    expect(screen.getByText('76000.80')).toBeInTheDocument();
  });
});
