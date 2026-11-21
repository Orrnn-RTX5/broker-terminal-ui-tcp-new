import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const orderHarness = vi.hoisted(() => ({ active: 0 }));

vi.mock('../config/backendTarget.js', () => ({ isDesktopBackendTarget: () => true }));
vi.mock('./binaryTcpOrderClient', () => ({
  getActiveBinaryTcpOrderCount: () => orderHarness.active,
  getBinaryTcpOrderActiveDurationMs: () => 0,
  onBinaryTcpOrdersIdle: () => undefined,
  prewarmBinaryOrderSocket: () => undefined,
  syncBinaryOrderAuthToken: () => undefined,
}));
vi.mock('./brokerSession', () => ({
  getAccessToken: () => '',
  getAccountLogin: () => 0,
  onSessionChange: () => undefined,
}));

import {
  binaryTcpMarketStream,
  getTradeEventCoalesceKey,
  type DecodedBinaryTradeEvent,
} from './binaryTcpMarketStream';

const encoder = new TextEncoder();

const encodeTradeEvent = (channel: string, payload: unknown, eventKind = 1, login = 200001): Uint8Array => {
  const channelBytes = encoder.encode(channel);
  const dataBytes = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(22 + channelBytes.length + dataBytes.length);
  const view = new DataView(out.buffer);
  out[0] = 1;
  out[1] = eventKind;
  view.setBigInt64(2, BigInt(login), true);
  view.setBigInt64(10, 1_700_000_000_000n, true);
  view.setUint16(18, channelBytes.length, true);
  out.set(channelBytes, 20);
  view.setUint16(20 + channelBytes.length, dataBytes.length, true);
  out.set(dataBytes, 22 + channelBytes.length);
  return out;
};

type StreamInternals = {
  decodeTradeEventFrame(buf: Uint8Array, offset: number, len: number): void;
  flushDeferredNotifications(): void;
  deferredTradeEvents: DecodedBinaryTradeEvent[];
};

const internals = binaryTcpMarketStream as unknown as StreamInternals;

const pnl = (ticket: number, profit: number, extra: Record<string, unknown> = {}) => ({
  type: 'position_update',
  data: [{ ticket, update_kind: 'pnl', profit, price_current: 1 + profit, ...extra }],
});

describe('deferred trade event coalescing while a binary order is in flight', () => {
  let received: DecodedBinaryTradeEvent[];
  let off: () => void;

  const push = (channel: string, payload: unknown, eventKind = 1) => {
    const frame = encodeTradeEvent(channel, payload, eventKind);
    internals.decodeTradeEventFrame(frame, 0, frame.byteLength);
  };
  const flush = () => {
    orderHarness.active = 0;
    internals.flushDeferredNotifications();
  };
  const summary = () => received.map((ev) => {
    const p = ev.payload as { type?: string; data?: unknown };
    const rows = Array.isArray(p.data) ? (p.data as Array<Record<string, unknown>>) : [];
    return `${ev.channel}:${p.type}:${rows[0]?.ticket ?? ''}:${rows[0]?.profit ?? (p as Record<string, unknown>).equity ?? (p as Record<string, unknown>).seq ?? ''}`;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    received = [];
    orderHarness.active = 1;
    off = binaryTcpMarketStream.subscribeTradeEvents((ev) => { received.push(ev); });
  });

  afterEach(() => {
    off();
    orderHarness.active = 0;
    internals.flushDeferredNotifications();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps only the latest metrics_update per channel, in place', () => {
    push('metrics.200001', { type: 'metrics_update', equity: 1 }, 4);
    push('metrics.200001', { type: 'metrics_update', equity: 2 }, 4);
    push('metrics.200002', { type: 'metrics_update', equity: 7 }, 4);
    push('metrics.200001', { type: 'metrics_update', equity: 3 }, 4);
    expect(received).toHaveLength(0);
    expect(internals.deferredTradeEvents).toHaveLength(2);
    flush();
    expect(summary()).toEqual([
      'metrics.200001:metrics_update::3',
      'metrics.200002:metrics_update::7',
    ]);
  });

  it('keeps only the latest tick-driven position update per (channel, ticket)', () => {
    push('positions.200001', pnl(5, 1));
    push('positions.200001', pnl(6, 10));
    push('positions.200001', pnl(5, 2));
    push('positions.200002', pnl(5, 99));
    push('positions.200001', pnl(5, 3));
    flush();
    expect(summary()).toEqual([
      'positions.200001:position_update:5:3',
      'positions.200001:position_update:6:10',
      'positions.200002:position_update:5:99',
    ]);
  });

  it('never merges an update across that ticket close: update, close, update stay in order', () => {
    push('positions.200001', pnl(5, 1));
    push('positions.200001', { type: 'position_closed', ticket: 5, seq: 1 });
    push('positions.200001', pnl(5, 2));
    flush();
    expect(summary()).toEqual([
      'positions.200001:position_update:5:1',
      'positions.200001:position_closed::1',
      'positions.200001:position_update:5:2',
    ]);
  });

  it('coalesces updates before a close and delivers the latest one before the close', () => {
    push('positions.200001', pnl(5, 1));
    push('positions.200001', pnl(5, 2));
    push('positions.200001', { type: 'position_closed', ticket: 5, seq: 9 });
    flush();
    expect(summary()).toEqual([
      'positions.200001:position_update:5:2',
      'positions.200001:position_closed::9',
    ]);
  });

  it('a close for a different ticket also acts as an ordering barrier (conservative)', () => {
    push('positions.200001', pnl(5, 1));
    push('positions.200001', { type: 'position_closed', ticket: 6, seq: 1 });
    push('positions.200001', pnl(5, 2));
    flush();
    expect(summary()).toHaveLength(3);
  });

  it('a close announced on the account channel is a barrier for the positions channel of the same login', () => {
    push('positions.200001', pnl(5, 1));
    push('account.200001', { type: 'position_closed', ticket: 5, seq: 2 }, 3);
    push('positions.200001', pnl(5, 2));
    flush();
    expect(summary()).toEqual([
      'positions.200001:position_update:5:1',
      'account.200001:position_closed::2',
      'positions.200001:position_update:5:2',
    ]);
  });

  it('never drops or reorders opened, order, deal and unknown events around snapshots', () => {
    push('positions.200001', { type: 'position_opened', ticket: 5, seq: 1 });
    push('positions.200001', pnl(5, 1));
    push('orders.200001', { type: 'order_filled', seq: 2 }, 2);
    push('positions.200001', pnl(5, 2));
    push('deals.200001', { type: 'deal_added', seq: 3 }, 5);
    push('positions.200001', { type: 'position_modified', ticket: 5, seq: 4 });
    push('positions.200001', pnl(5, 3));
    push('metrics.200001', { type: 'metrics_update', equity: 1 }, 4);
    push('orders.200001', { type: 'order_rejected', seq: 5 }, 2);
    push('metrics.200001', { type: 'metrics_update', equity: 2 }, 4);
    push('state.200001', { entity: 'groups' }, 6);
    flush();
    expect(summary()).toEqual([
      'positions.200001:position_opened::1',
      'positions.200001:position_update:5:1',
      'orders.200001:order_filled::2',
      'positions.200001:position_update:5:2',
      'deals.200001:deal_added::3',
      'positions.200001:position_modified::4',
      'positions.200001:position_update:5:3',
      'metrics.200001:metrics_update::1',
      'orders.200001:order_rejected::5',
      'metrics.200001:metrics_update::2',
      'state.200001:undefined::',
    ]);
  });

  it('does not coalesce multi-row, structural or closed-ticket position payloads', () => {
    push('positions.200001', { type: 'position_update', data: [
      { ticket: 5, update_kind: 'pnl', profit: 1 }, { ticket: 6, update_kind: 'pnl', profit: 1 },
    ] });
    push('positions.200001', { type: 'position_update', data: [
      { ticket: 5, update_kind: 'pnl', profit: 2 }, { ticket: 6, update_kind: 'pnl', profit: 2 },
    ] });
    push('positions.200001', { type: 'position_update', data: [{ ticket: 7, profit: 1 }] });
    push('positions.200001', { type: 'position_update', data: [{ ticket: 7, profit: 2 }] });
    push('positions.200001', { type: 'position_update', closed_tickets: [7], data: [{ ticket: 8, update_kind: 'pnl', profit: 1 }] });
    flush();
    expect(received).toHaveLength(5);
  });

  it('does not coalesce pnl updates that carry different state versions', () => {
    push('positions.200001', pnl(5, 1, { state_version: '10' }));
    push('positions.200001', pnl(5, 2, { state_version: '11' }));
    flush();
    expect(received).toHaveLength(2);
  });

  it('delivers immediately and untouched when no order is in flight', () => {
    orderHarness.active = 0;
    push('positions.200001', pnl(5, 1));
    push('positions.200001', pnl(5, 2));
    expect(summary()).toEqual([
      'positions.200001:position_update:5:1',
      'positions.200001:position_update:5:2',
    ]);
    expect(internals.deferredTradeEvents).toHaveLength(0);
  });

  it('classifier only returns keys for provable snapshots', () => {
    const ev = (channel: string, payload: unknown): DecodedBinaryTradeEvent => ({
      eventKind: 1, accountLogin: 200001, timestampMs: 1, channel, payload, rawText: '',
    });
    expect(getTradeEventCoalesceKey(ev('positions.1', pnl(5, 1)))).not.toBeNull();
    expect(getTradeEventCoalesceKey(ev('rtx5.positions.1', pnl(5, 1)))).toBe(getTradeEventCoalesceKey(ev('positions.1', pnl(5, 1))));
    expect(getTradeEventCoalesceKey(ev('metrics.1', { type: 'metrics_update' }))).not.toBeNull();
    expect(getTradeEventCoalesceKey(ev('positions.1', { type: 'position_closed', ticket: 5 }))).toBeNull();
    expect(getTradeEventCoalesceKey(ev('positions.1', { type: 'position_opened', ticket: 5 }))).toBeNull();
    expect(getTradeEventCoalesceKey(ev('positions.1', pnl(5, 1, { closed: true })))).toBeNull();
    expect(getTradeEventCoalesceKey(ev('positions.1', 'not json'))).toBeNull();
    expect(getTradeEventCoalesceKey(ev('positions.1', { type: 'position_update', data: [{ ticket: 0, update_kind: 'pnl' }] }))).toBeNull();
    expect(getTradeEventCoalesceKey(ev('orders.1', { type: 'order_filled' }))).toBeNull();
  });
});
