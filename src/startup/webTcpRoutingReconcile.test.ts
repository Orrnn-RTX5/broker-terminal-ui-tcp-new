import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileWebTcpRouting } from './webTcpRoutingReconcile';

type W = Window & { __RTX_RUNTIME_CONFIG__?: Record<string, unknown>; rtx5Electron?: unknown; electronAPI?: unknown };
const w = window as W;
const ORIGIN = window.location.origin;
const OLD = 'https://old-host.example.net';
const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws');

const configure = (platform: string | null) => {
  w.__RTX_RUNTIME_CONFIG__ = {
    BACKEND_TARGET: 'desktop', BROKER_ID: 'broker-a', API_HOST: ORIGIN, WS_HOST: WS_ORIGIN, DEFAULT_MT5_SERVER: 'Srv',
  };
  if (platform) w.rtx5Electron = { platform };
};
const seedOld = () => {
  localStorage.setItem('server_url', OLD);
  localStorage.setItem('market_api_url', OLD);
  localStorage.setItem('ws_url', `wss://old-host.example.net/ws/v2`);
  localStorage.setItem('auth_token', 'tok');
  localStorage.setItem('refresh_token', 'ref');
  sessionStorage.setItem('auth_token', 'stok');
  localStorage.setItem('broker_id', 'broker-old');
  localStorage.setItem('rtx_broker_server_identity_v1', JSON.stringify({ brokerId: 'broker-old', serverName: 'Old Broker' }));
};

describe('reconcileWebTcpRouting', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
  afterEach(() => {
    localStorage.clear(); sessionStorage.clear();
    delete w.__RTX_RUNTIME_CONFIG__; delete w.rtx5Electron; vi.resetModules();
  });

  it('rewrites off-origin routing to the page origin and clears tokens and identity', () => {
    configure('web-tcp'); seedOld();
    expect(reconcileWebTcpRouting()).toBe(true);
    expect(localStorage.getItem('server_url')).toBe(ORIGIN);
    expect(localStorage.getItem('market_api_url')).toBe(ORIGIN);
    expect(localStorage.getItem('ws_url')).toBe(`${WS_ORIGIN}/ws/v2`);
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('refresh_token')).toBeNull();
    expect(sessionStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('rtx_broker_server_identity_v1')).toBeNull();
    expect(localStorage.getItem('broker_id')).toBe('broker-a');
  });

  it('leaves same-origin values and tokens untouched', () => {
    configure('web-tcp');
    localStorage.setItem('server_url', ORIGIN);
    localStorage.setItem('ws_url', `${WS_ORIGIN}/ws/v2`);
    localStorage.setItem('auth_token', 'tok');
    localStorage.setItem('rtx_broker_server_identity_v1', JSON.stringify({ brokerId: 'broker-a', serverName: 'S' }));
    expect(reconcileWebTcpRouting()).toBe(false);
    expect(localStorage.getItem('server_url')).toBe(ORIGIN);
    expect(localStorage.getItem('auth_token')).toBe('tok');
    expect(localStorage.getItem('rtx_broker_server_identity_v1')).not.toBeNull();
  });

  it('drops a stale identity of another broker without touching routing or tokens', () => {
    configure('web-tcp');
    localStorage.setItem('server_url', ORIGIN);
    localStorage.setItem('auth_token', 'tok');
    localStorage.setItem('rtx_broker_server_identity_v1', JSON.stringify({ brokerId: 'broker-old', serverName: 'Old' }));
    reconcileWebTcpRouting();
    expect(localStorage.getItem('rtx_broker_server_identity_v1')).toBeNull();
    expect(localStorage.getItem('auth_token')).toBe('tok');
  });

  it('removes an off-origin URL left only in rtx_broker_server but keeps a display label', () => {
    configure('web-tcp');
    localStorage.setItem('rtx_broker_server', OLD);
    localStorage.setItem('auth_token', 'tok');
    expect(reconcileWebTcpRouting()).toBe(true);
    expect(localStorage.getItem('rtx_broker_server')).toBeNull();
    expect(localStorage.getItem('auth_token')).toBeNull();

    localStorage.setItem('rtx_broker_server', 'Broker Live (10.0.0.1:4443)');
    localStorage.setItem('auth_token', 'tok');
    expect(reconcileWebTcpRouting()).toBe(false);
    expect(localStorage.getItem('rtx_broker_server')).toBe('Broker Live (10.0.0.1:4443)');
    expect(localStorage.getItem('auth_token')).toBe('tok');
  });

  it('does nothing outside web-tcp (native desktop)', () => {
    configure('win32'); seedOld();
    expect(reconcileWebTcpRouting()).toBe(false);
    expect(localStorage.getItem('server_url')).toBe(OLD);
    expect(localStorage.getItem('auth_token')).toBe('tok');
  });

  it('does nothing without rtx5Electron', () => {
    configure(null); seedOld();
    expect(reconcileWebTcpRouting()).toBe(false);
    expect(localStorage.getItem('server_url')).toBe(OLD);
  });

  it('makes config/api.ts bases resolve to the page origin', async () => {
    configure('web-tcp'); seedOld();
    reconcileWebTcpRouting();
    vi.resetModules();
    const api = await import('../config/api');
    expect(api.API_V2_BASE_URL.startsWith(ORIGIN)).toBe(true);
    expect(api.MARKET_WS_URL.startsWith(WS_ORIGIN)).toBe(true);
  });

  it('clears stale off-origin dynamic or loopback logo_url without disturbing active tokens or CDN logos', () => {
    configure('web-tcp');
    localStorage.setItem('server_url', ORIGIN);
    localStorage.setItem('auth_token', 'tok');
    localStorage.setItem('logo_url', `${OLD}/api/v1/brokers/broker-a/logo?v=old`);
    localStorage.setItem('rtx_broker_presentation_v1', JSON.stringify({ version: 1, brokerId: 'broker-a', logoUrl: `${OLD}/api/v1/brokers/broker-a/logo` }));

    expect(reconcileWebTcpRouting()).toBe(false);
    expect(localStorage.getItem('logo_url')).toBeNull();
    expect(localStorage.getItem('rtx_broker_presentation_v1')).toBeNull();
    expect(localStorage.getItem('auth_token')).toBe('tok');

    localStorage.setItem('logo_url', 'http://127.0.0.1:18403/custom/logo.png');
    localStorage.setItem('rtx_broker_presentation_v1', JSON.stringify({ version: 1, brokerId: 'broker-a' }));
    expect(reconcileWebTcpRouting()).toBe(false);
    expect(localStorage.getItem('logo_url')).toBeNull();
    expect(localStorage.getItem('rtx_broker_presentation_v1')).toBeNull();
    expect(localStorage.getItem('auth_token')).toBe('tok');

    // External non-loopback CDN logo URL stays untouched.
    localStorage.setItem('logo_url', 'https://cdn.broker.example/brand/logo.png');
    expect(reconcileWebTcpRouting()).toBe(false);
    expect(localStorage.getItem('logo_url')).toBe('https://cdn.broker.example/brand/logo.png');
  });

  it('clears cached logo_url and broker presentation on off-origin routing rewrite', () => {
    configure('web-tcp'); seedOld();
    localStorage.setItem('logo_url', `${OLD}/brand-logo.png`);
    localStorage.setItem('rtx_broker_presentation_v1', JSON.stringify({ version: 1, brokerId: 'broker-old' }));
    expect(reconcileWebTcpRouting()).toBe(true);
    expect(localStorage.getItem('logo_url')).toBeNull();
    expect(localStorage.getItem('rtx_broker_presentation_v1')).toBeNull();
  });
});
