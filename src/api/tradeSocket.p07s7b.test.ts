/**
 * P07-7b end-to-end TradeWebSocketClient -> binary codec wiring tests:
 * - TradeWebSocketClient.placePendingOrder -> binaryTcpOrderClient
 * - TradeWebSocketClient.modifyPendingOrder -> binaryTcpOrderClient
 *
 * Contract tested:
 * - `placePendingOrder` accepts `expiryType` (`0 | 1 | 2 | 3`) alongside pending order fields.
 * - `modifyPendingOrder` accepts `time_in_force: 'DAY' | 'GTD' | 'GTC'` alongside `expiry` / `price` / `price_sl` / `price_tp`.
 * - Switch OFF: every call produces exact pre-P07-7b baseline `tui-127base` frames (no 0x08, no HAS_EXTRAS).
 * - Switch ON:
 *   - `placePendingOrder` emits `08 01 00` .. `08 01 03` for expiryType 0..3 and rejects inconsistent `(expiryType, expiration)`
 *     pairs (`0` with `expiration > 0`, `2|3` with `expiration <= 0`) with `TradeSocketOrderRejectedError` (`INVALID_EXPIRY_TYPE`)
 *     without sending any binary frame.
 *   - `modifyPendingOrder` emits `08 01 01` (`DAY`) / `08 01 02` (`GTD`) ONLY when an expiration is set (`HAS_EXPIRATION`),
 *     and omits `0x08` on price/SL/TP-only or clear-to-GTC modifies.
 *
 * Switch-ON wiring tests here are expected RED until tradeSocket.ts forwards `expiryType` (on place) and mapped
 * `time_in_force` (`DAY` -> 1, `GTD` -> 2 when `expirationParam > 0`) on modify.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const FLAG_ENV = 'VITE_BINARY_ORDER_EXPIRY_TYPE_TLV_ENABLED';
const FIXED_UUID = '123e4567-e89b-42d3-a456-426614174000';
const FIXED_TOKEN = 'tok-p07s3';
const LOGIN = 1001;
const PENDING_TICKET = 90002;
const EXPIRY_TS = 1_790_000_000;
const EXPIRY_EOD_TS = 1_790_035_199;
const ACTION_PLACE_PENDING = 4;
const ACTION_MODIFY_PENDING = 5;
const FLAG_HAS_SL = 0x0001;
const FLAG_HAS_TP = 0x0002;
const FLAG_HAS_PRICE = 0x0020;
const FLAG_HAS_EXPIRATION = 0x0080;
const FLAG_HAS_EXTRAS = 0x0400;
const TAG_EXPIRY_TYPE = 0x08;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function makeBinaryOkResponse(reqFrame: Uint8Array, ticket = 5002n): ArrayBuffer {
  const buf = new ArrayBuffer(136);
  const out = new Uint8Array(buf);
  const view = new DataView(buf);
  out[0] = 1;
  out[1] = reqFrame[1];
  view.setUint16(2, 200, true);
  view.setUint32(4, 9, true);
  view.setBigInt64(8, ticket, true);
  view.setBigInt64(16, 0n, true);
  out.set(reqFrame.subarray(72, 88), 80);
  out.set(reqFrame.subarray(88, 128), 96);
  return buf;
}

function buildTui127BaseFrame(opts: {
  action: number;
  side: number;
  subType: number;
  flags: number;
  login: number;
  ticket: number;
  volume: number;
  price: number;
  sl: number;
  tp: number;
  expiration: number;
  symbol: string;
  clientOrderId: string;
  token: string;
}): Uint8Array {
  const tokenBytes = new TextEncoder().encode(opts.token);
  const out = new Uint8Array(128 + 2 + tokenBytes.byteLength);
  const view = new DataView(out.buffer);
  out[0] = 1;
  out[1] = opts.action;
  out[2] = opts.side;
  out[3] = opts.subType;
  view.setUint16(4, opts.flags, true);
  view.setUint16(6, 0, true);
  view.setBigInt64(8, BigInt(opts.login), true);
  view.setBigInt64(16, BigInt(opts.ticket), true);
  view.setFloat64(24, opts.volume, true);
  view.setFloat64(32, opts.price, true);
  view.setFloat64(40, 0, true);
  view.setFloat64(48, opts.sl, true);
  view.setFloat64(56, opts.tp, true);
  view.setBigInt64(64, BigInt(opts.expiration), true);
  out.set(new TextEncoder().encode(opts.symbol.toUpperCase()).subarray(0, 16), 72);
  out.set(new TextEncoder().encode(opts.clientOrderId).subarray(0, 40), 88);
  view.setUint16(128, tokenBytes.byteLength, true);
  out.set(tokenBytes, 130);
  return out;
}

function appendTlv(baseFrame: Uint8Array, tlv: readonly number[]): Uint8Array {
  const copy = new Uint8Array(baseFrame.byteLength + 2 + tlv.length);
  copy.set(baseFrame, 0);
  const view = new DataView(copy.buffer);
  view.setUint16(4, view.getUint16(4, true) | FLAG_HAS_EXTRAS, true);
  copy[baseFrame.byteLength] = tlv.length & 0xff;
  copy[baseFrame.byteLength + 1] = (tlv.length >> 8) & 0xff;
  copy.set(tlv, baseFrame.byteLength + 2);
  return copy;
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  const w = window as unknown as Record<string, unknown>;
  delete w.__RTX5_RUNTIME_CONFIG__;
  delete w.__RTX_RUNTIME_CONFIG__;
  delete w.rtx5Electron;
});

async function loadConnectedSocket(flagEnabled: boolean) {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (flagEnabled) {
    vi.stubEnv(FLAG_ENV, 'true');
  }

  const w = window as unknown as Record<string, unknown>;
  const runtimeCfg = {
    BACKEND_TARGET: 'desktop',
    API_URL: 'https://broker.example',
    WS_URL: 'wss://broker.example',
    BINARY_ORDER_URL: 'http://127.0.0.1:18404/__rtx5_binary_order',
  };
  w.__RTX5_RUNTIME_CONFIG__ = runtimeCfg;
  w.__RTX_RUNTIME_CONFIG__ = runtimeCfg;
  w.rtx5Electron = { platform: 'win32' };
  globalThis.WebSocket = undefined as unknown as typeof WebSocket;

  const sentFrames: Uint8Array[] = [];
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = String(init?.method || 'GET').toUpperCase();
    if (url.includes('/__rtx5_binary_order') && method === 'POST') {
      const body = init?.body;
      const raw = body instanceof Uint8Array
        ? new Uint8Array(body)
        : body instanceof ArrayBuffer
          ? new Uint8Array(body.slice(0))
          : ArrayBuffer.isView(body)
            ? new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
            : new Uint8Array(0);
      sentFrames.push(raw);
      const respBuf = makeBinaryOkResponse(raw);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        arrayBuffer: async () => respBuf,
      } as unknown as Response;
    }
    return new Response(new ArrayBuffer(0), { status: 200 });
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;

  vi.doMock('../services/brokerSession', async () => {
    const actual = await vi.importActual<typeof import('../services/brokerSession')>('../services/brokerSession');
    return {
      ...actual,
      getAccessToken: () => FIXED_TOKEN,
      getAccountLogin: () => LOGIN,
    };
  });
  vi.doMock('../services/binaryTcpMarketStream', () => ({
    binaryTcpMarketStream: {
      start: vi.fn(),
      stop: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      syncAccountSubscription: vi.fn(),
      subscribeTradeEvents: vi.fn(() => () => {}),
      onTick: vi.fn(() => () => {}),
      onDirectChartTick: vi.fn(() => () => {}),
      onCandle: vi.fn(() => () => {}),
    },
  }));

  const mod = await import('./tradeSocket');
  const client = new mod.TradeWebSocketClient({
    url: 'wss://broker.example/ws/v2',
    token: FIXED_TOKEN,
    reconnect: false,
  });
  client.connect();

  return { client, sentFrames, ...mod };
}

describe('P07-7b T50d E2E: TradeWebSocketClient -> binaryTcpOrderClient', () => {
  const PLACE_CASES = [
    { label: 'GTC', expiryType: 0 as const, expiration: 0 },
    { label: 'DAY', expiryType: 1 as const, expiration: EXPIRY_EOD_TS },
    { label: 'SPECIFIED', expiryType: 2 as const, expiration: EXPIRY_TS },
    { label: 'SPECIFIED_DAY', expiryType: 3 as const, expiration: EXPIRY_EOD_TS },
  ];

  it.each(PLACE_CASES)(
    'placePendingOrder switch OFF ($label): frame is byte-identical to tui-127base (no 0x08)',
    async (c) => {
      const { client, sentFrames } = await loadConnectedSocket(false);
      await client.placePendingOrder({
        account_login: LOGIN,
        symbol: 'EURUSD',
        type: 'buy_limit',
        volume: 0.1,
        price: 1.085,
        expiration: c.expiration > 0 ? c.expiration : undefined,
        client_order_id: FIXED_UUID,
        expiryType: c.expiryType,
      } as unknown as Parameters<typeof client.placePendingOrder>[0]);

      expect(sentFrames).toHaveLength(1);
      const expected = buildTui127BaseFrame({
        action: ACTION_PLACE_PENDING,
        side: 1,
        subType: 1,
        flags: FLAG_HAS_PRICE | (c.expiration > 0 ? FLAG_HAS_EXPIRATION : 0),
        login: LOGIN,
        ticket: 0,
        volume: 0.1,
        price: 1.085,
        sl: 0,
        tp: 0,
        expiration: c.expiration,
        symbol: 'EURUSD',
        clientOrderId: FIXED_UUID,
        token: FIXED_TOKEN,
      });
      expect(toHex(sentFrames[0])).toBe(toHex(expected));
    },
  );

  it.each(PLACE_CASES)(
    'placePendingOrder switch ON ($label): frame carries exact TLV 08 01 0$expiryType',
    async (c) => {
      const { client, sentFrames } = await loadConnectedSocket(true);
      await client.placePendingOrder({
        account_login: LOGIN,
        symbol: 'EURUSD',
        type: 'buy_limit',
        volume: 0.1,
        price: 1.085,
        expiration: c.expiration > 0 ? c.expiration : undefined,
        client_order_id: FIXED_UUID,
        expiryType: c.expiryType,
      } as unknown as Parameters<typeof client.placePendingOrder>[0]);

      expect(sentFrames).toHaveLength(1);
      const baseline = buildTui127BaseFrame({
        action: ACTION_PLACE_PENDING,
        side: 1,
        subType: 1,
        flags: FLAG_HAS_PRICE | (c.expiration > 0 ? FLAG_HAS_EXPIRATION : 0),
        login: LOGIN,
        ticket: 0,
        volume: 0.1,
        price: 1.085,
        sl: 0,
        tp: 0,
        expiration: c.expiration,
        symbol: 'EURUSD',
        clientOrderId: FIXED_UUID,
        token: FIXED_TOKEN,
      });
      expect(toHex(sentFrames[0])).toBe(toHex(appendTlv(baseline, [TAG_EXPIRY_TYPE, 1, c.expiryType])));
    },
  );

  it('placePendingOrder switch ON: rejects inconsistent (expiryType, expiration) pairs with INVALID_EXPIRY_TYPE without sending', async () => {
    const { client, sentFrames, TradeSocketOrderRejectedError } = await loadConnectedSocket(true);
    const badPairs: Array<{ expiryType: number; expiration?: number }> = [
      { expiryType: 0, expiration: EXPIRY_TS },
      { expiryType: 2, expiration: 0 },
      { expiryType: 3, expiration: 0 },
    ];

    for (const pair of badPairs) {
      let caught: unknown;
      try {
        await client.placePendingOrder({
          account_login: LOGIN,
          symbol: 'EURUSD',
          type: 'buy_limit',
          volume: 0.1,
          price: 1.085,
          expiration: pair.expiration,
          client_order_id: FIXED_UUID,
          expiryType: pair.expiryType,
        } as unknown as Parameters<typeof client.placePendingOrder>[0]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TradeSocketOrderRejectedError);
      const rejected = caught as InstanceType<typeof TradeSocketOrderRejectedError>;
      expect(rejected.code).toBe('INVALID_EXPIRY_TYPE');
    }
    expect(sentFrames).toHaveLength(0);
  });

  const MODIFY_CASES = [
    {
      label: 'DAY with expiration',
      data: {
        account_login: LOGIN,
        client_order_id: FIXED_UUID,
        price: 1.0875,
        price_sl: 1.08,
        price_tp: 1.095,
        time_in_force: 'DAY' as const,
        expiry: EXPIRY_TS,
      },
      expectedFlags: FLAG_HAS_PRICE | FLAG_HAS_SL | FLAG_HAS_TP | FLAG_HAS_EXPIRATION,
      expectedExp: EXPIRY_TS,
      expectedSl: 1.08,
      expectedTp: 1.095,
      expectedTlv: [TAG_EXPIRY_TYPE, 1, 1] as const,
    },
    {
      label: 'GTD with expiration',
      data: {
        account_login: LOGIN,
        client_order_id: FIXED_UUID,
        price: 1.0875,
        price_sl: 1.08,
        price_tp: 1.095,
        time_in_force: 'GTD' as const,
        expiry: EXPIRY_TS,
      },
      expectedFlags: FLAG_HAS_PRICE | FLAG_HAS_SL | FLAG_HAS_TP | FLAG_HAS_EXPIRATION,
      expectedExp: EXPIRY_TS,
      expectedSl: 1.08,
      expectedTp: 1.095,
      expectedTlv: [TAG_EXPIRY_TYPE, 1, 2] as const,
    },
    {
      label: 'price/SL/TP only (no expiration)',
      data: {
        account_login: LOGIN,
        client_order_id: FIXED_UUID,
        price: 1.0875,
        price_sl: 1.08,
        price_tp: 1.095,
      },
      expectedFlags: FLAG_HAS_PRICE | FLAG_HAS_SL | FLAG_HAS_TP,
      expectedExp: 0,
      expectedSl: 1.08,
      expectedTp: 1.095,
      expectedTlv: null,
    },
    {
      label: 'clear-to-GTC (no expiration set)',
      data: {
        account_login: LOGIN,
        client_order_id: FIXED_UUID,
        price: 1.0875,
        price_sl: 1.08,
        price_tp: 1.095,
        time_in_force: 'GTC' as const,
        expiry: null,
      },
      expectedFlags: FLAG_HAS_PRICE | FLAG_HAS_SL | FLAG_HAS_TP,
      expectedExp: 0,
      expectedSl: 1.08,
      expectedTp: 1.095,
      expectedTlv: null,
    },
  ];

  it.each(MODIFY_CASES)(
    'modifyPendingOrder switch OFF ($label): byte-identical to tui-127base (no 0x08)',
    async (c) => {
      const { client, sentFrames } = await loadConnectedSocket(false);
      await client.modifyPendingOrder(PENDING_TICKET, c.data);

      expect(sentFrames).toHaveLength(1);
      const expected = buildTui127BaseFrame({
        action: ACTION_MODIFY_PENDING,
        side: 0,
        subType: 0,
        flags: c.expectedFlags,
        login: LOGIN,
        ticket: PENDING_TICKET,
        volume: 0,
        price: 1.0875,
        sl: c.expectedSl,
        tp: c.expectedTp,
        expiration: c.expectedExp,
        symbol: '',
        clientOrderId: FIXED_UUID,
        token: FIXED_TOKEN,
      });
      expect(toHex(sentFrames[0])).toBe(toHex(expected));
    },
  );

  it.each(MODIFY_CASES)(
    'modifyPendingOrder switch ON ($label): 0x08 emitted ONLY when HAS_EXPIRATION is set',
    async (c) => {
      const { client, sentFrames } = await loadConnectedSocket(true);
      await client.modifyPendingOrder(PENDING_TICKET, c.data);

      expect(sentFrames).toHaveLength(1);
      const baseline = buildTui127BaseFrame({
        action: ACTION_MODIFY_PENDING,
        side: 0,
        subType: 0,
        flags: c.expectedFlags,
        login: LOGIN,
        ticket: PENDING_TICKET,
        volume: 0,
        price: 1.0875,
        sl: c.expectedSl,
        tp: c.expectedTp,
        expiration: c.expectedExp,
        symbol: '',
        clientOrderId: FIXED_UUID,
        token: FIXED_TOKEN,
      });
      const expected = c.expectedTlv ? appendTlv(baseline, c.expectedTlv) : baseline;
      expect(toHex(sentFrames[0])).toBe(toHex(expected));
    },
  );
});
