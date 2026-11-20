// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveBrokerBrand } from './useActiveBrokerBrand';
import { applyBrokerChrome } from '../services/brokerPresentation';
import { brokerV2Api } from '../api/trade';
import { configApi } from '../services/api';

const originalRuntimeConfig = (window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, unknown> }).__RTX_RUNTIME_CONFIG__;

describe('useActiveBrokerBrand', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    applyBrokerChrome({});
    vi.spyOn(configApi, 'getConfig').mockResolvedValue({
      brokerName: 'Broker',
      priceFeedLP: '',
      executionMode: '',
      defaultLeverage: 100,
      defaultBalance: 0,
      marginMode: '',
      maxTicksPerSymbol: 0,
    } as never);
    vi.spyOn(brokerV2Api, 'getServers').mockResolvedValue([]);
    vi.spyOn(brokerV2Api, 'getBrokers').mockResolvedValue({ brokers: [], count: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    applyBrokerChrome({});
    if (originalRuntimeConfig === undefined) {
      delete (window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, unknown> }).__RTX_RUNTIME_CONFIG__;
    } else {
      (window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, unknown> }).__RTX_RUNTIME_CONFIG__ = originalRuntimeConfig;
    }
  });

  it('updates live when broker chrome broadcasts a new logo and ignores cross-broker chrome', async () => {
    localStorage.setItem('broker_id', 'orrnn');
    localStorage.setItem('broker_name', 'Orrnn');
    localStorage.setItem('logo_url', 'https://orrnn.example/api/v1/brokers/orrnn/logo?v=111111');

    const { result } = renderHook(() => useActiveBrokerBrand({ symbol: 'BTCUSD' }));
    expect(result.current.logoUrl).toBe('https://orrnn.example/api/v1/brokers/orrnn/logo?v=111111');

    act(() => {
      applyBrokerChrome({
        brokerId: 'orrnn',
        brokerName: 'Orrnn',
        logoUrl: 'https://orrnn.example/api/v1/brokers/orrnn/logo?v=222222',
      });
    });

    await waitFor(() => {
      expect(result.current.logoUrl).toBe('https://orrnn.example/api/v1/brokers/orrnn/logo?v=222222');
    });
  });

  it('updates live in deployed web mode (BACKEND_TARGET=web) when server metadata changes even with unversioned BROKER_LOGO_URL', async () => {
    (window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, unknown> }).__RTX_RUNTIME_CONFIG__ = {
      CONFIG_SOURCE: 'deployment',
      BACKEND_TARGET: 'web',
      API_HOST: 'https://broker.example',
      WS_HOST: 'wss://broker.example',
      BROKER_ID: 'orrnn',
      BROKER_NAME: 'Orrnn',
      DEFAULT_MT5_SERVER: 'Orrnn-Live',
      BROKER_LOGO_URL: 'https://broker.example/api/v1/brokers/orrnn/logo',
    };
    localStorage.setItem('broker_id', 'orrnn');
    localStorage.setItem('logo_url', 'https://broker.example/api/v1/brokers/orrnn/logo?v=oldhash');
    let currentServerLogo = 'https://broker.example/api/v1/brokers/orrnn/logo?v=oldhash';
    vi.mocked(brokerV2Api.getServers).mockImplementation(async () => [{
      broker_id: 'orrnn',
      broker_name: 'Orrnn',
      server: 'Orrnn',
      server_url: 'https://broker.example',
      logo_url: currentServerLogo,
    } as never]);

    const { result } = renderHook(() => useActiveBrokerBrand({ symbol: 'BTCUSD' }));
    await waitFor(() => {
      expect(result.current.logoUrl).toBe('https://broker.example/api/v1/brokers/orrnn/logo?v=oldhash');
    });

    currentServerLogo = 'https://broker.example/api/v1/brokers/orrnn/logo?v=newhash';
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 240_000);
    try {
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => {
        expect(result.current.logoUrl).toBe('https://broker.example/api/v1/brokers/orrnn/logo?v=newhash');
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
