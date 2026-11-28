import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetBinaryOrderWsForTests,
  BINARY_ORDER_ACTION_MODIFY_PENDING,
  BINARY_ORDER_ACTION_MODIFY_POSITION,
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_ACTION_PLACE_PENDING,
  BINARY_ORDER_CODEC_VERSION,
  BINARY_ORDER_EXTRA_TAG_TRAILING_STEP,
  BINARY_ORDER_EXTRA_TAG_TRAILING_STOP,
  BINARY_ORDER_FLAG_CLEAR_TRAILING,
  BINARY_ORDER_FLAG_HAS_EXTRAS,
  BINARY_ORDER_FLAG_HAS_TRAILING,
  REQ_HEADER_SIZE,
  RESP_HEADER_SIZE,
} from '../binaryTcpOrderClient';
import { api } from '../api';
import { useAppStore, type Account, type Order, type Position } from '../../store/useAppStore';

type TrailingTestWindow = Window & {
  rtx5Electron?: Record<string, unknown>;
  __RTX5_RUNTIME_CONFIG__?: Record<string, unknown>;
  __RTX_RUNTIME_CONFIG__?: Record<string, unknown>;
};

type TrailingFields = {
  trailing_stop?: number;
  trailing_step?: number;
  expiration?: number;
};

function buildBinaryRespBuffer(overrides?: {
  action?: number;
  status?: number;
  orderTicket?: number;
  positionTicket?: number;
  dealTicket?: number;
  fillPrice?: number;
  volume?: number;
  sl?: number;
  tp?: number;
}): ArrayBuffer {
  const buf = new ArrayBuffer(RESP_HEADER_SIZE);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes[0] = BINARY_ORDER_CODEC_VERSION;
  bytes[1] = overrides?.action ?? BINARY_ORDER_ACTION_PLACE_MARKET;
  view.setUint16(2, overrides?.status ?? 200, true);
  view.setUint32(4, 180, true);
  view.setBigInt64(8, BigInt(overrides?.orderTicket ?? 5001), true);
  view.setBigInt64(16, BigInt(overrides?.positionTicket ?? 7001), true);
  view.setBigInt64(24, BigInt(overrides?.dealTicket ?? 9001), true);
  view.setFloat64(32, overrides?.fillPrice ?? 1.10025, true);
  view.setFloat64(40, overrides?.volume ?? 0.1, true);
  view.setFloat64(64, overrides?.sl ?? 0, true);
  view.setFloat64(72, overrides?.tp ?? 0, true);
  return buf;
}

describe('api trailing stop over fast binary channel (TRAILING_STOP_REST_EXCEPTION removed)', () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    __resetBinaryOrderWsForTests();
    localStorage.clear();
    localStorage.setItem('auth_token', 'tok-trail');
    useAppStore.setState({
      account: {
        id: '100001',
        login: 100001,
        balance: 10000,
        equity: 10000,
        margin: 0,
        freeMargin: 10000,
        marginLevel: 0,
        leverage: 100,
        currency: 'USD',
      } as unknown as Account,
      positions: [
        {
          id: 7001,
          ticket: 7001,
          symbol: 'EURUSD',
          side: 'BUY',
          volume: 0.1,
          openPrice: 1.1,
          currentPrice: 1.1005,
          sl: 1.095,
          tp: 1.11,
          trailing_stop: 50,
          trailing_step: 10,
        } as unknown as Position,
      ],
      orders: [
        {
          id: '5001',
          ticket: 5001,
          symbol: 'EURUSD',
          type: 'BUY_LIMIT',
          side: 'BUY',
          volume: 0.1,
          price: 1.095,
          sl: 1.09,
          tp: 1.105,
        } as unknown as Order,
      ],
    });
  });

  afterEach(() => {
    __resetBinaryOrderWsForTests();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    delete (window as TrailingTestWindow).rtx5Electron;
    delete (window as TrailingTestWindow).__RTX5_RUNTIME_CONFIG__;
    delete (window as TrailingTestWindow).__RTX_RUNTIME_CONFIG__;
  });

  it('rejects all trailing stop trade actions when fast binary channel is disabled and never calls REST', async () => {
    delete (window as TrailingTestWindow).rtx5Electron;
    delete (window as TrailingTestWindow).__RTX5_RUNTIME_CONFIG__;
    const spyFetch = vi.fn();
    globalThis.fetch = spyFetch as unknown as typeof fetch;

    await expect(
      api.orders.placeMarketOrder({
        login: 100001,
        symbol: 'EURUSD',
        side: 'buy',
        type: 'market',
        volume: 0.1,
        trailing_stop: 50,
        trailing_step: 10,
      }),
    ).rejects.toThrow('Fast order channel is not configured for this Terminal');

    await expect(
      api.positions.modifyPosition(7001, {
        trailing_stop: 60,
        trailing_step: 15,
      }),
    ).rejects.toThrow('Fast order channel is not configured for this Terminal');

    await expect(
      api.orders.placePendingOrder({
        login: 100001,
        symbol: 'EURUSD',
        side: 'buy',
        type: 'buy_limit',
        volume: 0.1,
        price: 1.095,
        trailing_stop: 40,
        trailing_step: 5,
      }),
    ).rejects.toThrow('Fast order channel is not configured for this Terminal');

    await expect(
      api.orders.modifyPendingOrder(5001, {
        price: 1.094,
        trailing_stop: 45,
        trailing_step: 5,
      }),
    ).rejects.toThrow('Fast order channel is not configured for this Terminal');

    expect(spyFetch).not.toHaveBeenCalled();
  });

  it('sends placeMarketOrder, modifyPosition, placePendingOrder, and modifyPendingOrder with trailing_stop/trailing_step over the fast binary channel', async () => {
    (window as TrailingTestWindow).__RTX_RUNTIME_CONFIG__ = { BACKEND_TARGET: 'desktop' };
    (window as TrailingTestWindow).rtx5Electron = {};

    class ClosedWebSocket {
      readyState = 3;
      binaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(public url: string) {}
      send = vi.fn();
      close = vi.fn();
    }
    globalThis.WebSocket = ClosedWebSocket as unknown as typeof WebSocket;

    const capturedFrames: { url: string; bytes: Uint8Array }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const bodyBuf = init?.body as ArrayBuffer;
      const bytes = new Uint8Array(bodyBuf);
      capturedFrames.push({ url, bytes });
      const action = bytes[1];
      return new Response(
        buildBinaryRespBuffer({
          action,
          status: 200,
          orderTicket: 5001,
          positionTicket: 7001,
          fillPrice: 1.10025,
          volume: 0.1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/octet-stream' } },
      );
    }) as unknown as typeof fetch;

    // 1. placeMarketOrder with trailing_stop=55, trailing_step=10
    const mktPos = await api.orders.placeMarketOrder({
      login: 100001,
      symbol: 'EURUSD',
      side: 'buy',
      type: 'market',
      volume: 0.1,
      trailing_stop: 55,
      trailing_step: 10,
    });
    expect((mktPos as typeof mktPos & TrailingFields).trailing_stop).toBe(55);
    expect((mktPos as typeof mktPos & TrailingFields).trailing_step).toBe(10);

    // 2. modifyPosition with trailing_stop=75, trailing_step=15
    const modPos = await api.positions.modifyPosition(7001, {
      trailing_stop: 75,
      trailing_step: 15,
    });
    expect((modPos as typeof modPos & TrailingFields).trailing_stop).toBe(75);
    expect((modPos as typeof modPos & TrailingFields).trailing_step).toBe(15);

    // 3. modifyPosition clearing trailing_stop=0
    const clearedPos = await api.positions.modifyPosition(7001, {
      trailing_stop: 0,
      trailing_step: 0,
    });
    expect((clearedPos as typeof clearedPos & TrailingFields).trailing_stop).toBe(0);

    // 4. placePendingOrder with expiration + trailing_stop=40, trailing_step=5
    const pendOrd = await api.orders.placePendingOrder({
      login: 100001,
      symbol: 'EURUSD',
      side: 'buy',
      type: 'buy_limit',
      volume: 0.1,
      price: 1.095,
      expiration: 1770000000,
      trailing_stop: 40,
      trailing_step: 5,
    });
    expect((pendOrd as typeof pendOrd & TrailingFields).trailing_stop).toBe(40);
    expect((pendOrd as typeof pendOrd & TrailingFields).trailing_step).toBe(5);
    expect((pendOrd as typeof pendOrd & TrailingFields).expiration).toBe(1770000000);

    // 5. modifyPendingOrder with trailing_stop=60, trailing_step=10
    const modPend = await api.orders.modifyPendingOrder(5001, {
      price: 1.094,
      trailing_stop: 60,
      trailing_step: 10,
    });
    expect((modPend as typeof modPend & TrailingFields).trailing_stop).toBe(60);
    expect((modPend as typeof modPend & TrailingFields).trailing_step).toBe(10);

    expect(capturedFrames.length).toBe(5);
    for (const frame of capturedFrames) {
      expect(frame.url).toContain('/__rtx5_binary_order');
      expect(frame.url).not.toContain('/api/v2/');
    }

    // Verify frame 0 (placeMarketOrder): action=1, flags has HAS_TRAILING | HAS_EXTRAS, TLV has 0x03=55, 0x04=10
    {
      const { bytes } = capturedFrames[0];
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(bytes[1]).toBe(BINARY_ORDER_ACTION_PLACE_MARKET);
      const flags = view.getUint16(4, true);
      expect(flags & BINARY_ORDER_FLAG_HAS_TRAILING).toBe(BINARY_ORDER_FLAG_HAS_TRAILING);
      expect(flags & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(BINARY_ORDER_FLAG_HAS_EXTRAS);
      const tokenLen = view.getUint16(REQ_HEADER_SIZE, true);
      const extrasOffset = REQ_HEADER_SIZE + 2 + tokenLen;
      expect(Array.from(bytes.subarray(extrasOffset))).toEqual([
        12, 0,
        BINARY_ORDER_EXTRA_TAG_TRAILING_STOP, 4, 55, 0, 0, 0,
        BINARY_ORDER_EXTRA_TAG_TRAILING_STEP, 4, 10, 0, 0, 0,
      ]);
    }

    // Verify frame 2 (modifyPosition clear): action=3, flags has CLEAR_TRAILING | HAS_EXTRAS, TLV has 0x03=0, 0x04=0
    {
      const { bytes } = capturedFrames[2];
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(bytes[1]).toBe(BINARY_ORDER_ACTION_MODIFY_POSITION);
      const flags = view.getUint16(4, true);
      expect(flags & BINARY_ORDER_FLAG_CLEAR_TRAILING).toBe(BINARY_ORDER_FLAG_CLEAR_TRAILING);
      expect(flags & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(BINARY_ORDER_FLAG_HAS_EXTRAS);
      const tokenLen = view.getUint16(REQ_HEADER_SIZE, true);
      const extrasOffset = REQ_HEADER_SIZE + 2 + tokenLen;
      expect(Array.from(bytes.subarray(extrasOffset))).toEqual([
        12, 0,
        BINARY_ORDER_EXTRA_TAG_TRAILING_STOP, 4, 0, 0, 0, 0,
        BINARY_ORDER_EXTRA_TAG_TRAILING_STEP, 4, 0, 0, 0, 0,
      ]);
    }

    // Verify frame 3 (placePendingOrder): action=4, expiration preserved in header [64..72] AND TLV has 0x03=40, 0x04=5
    {
      const { bytes } = capturedFrames[3];
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(bytes[1]).toBe(BINARY_ORDER_ACTION_PLACE_PENDING);
      expect(Number(view.getBigInt64(64, true))).toBe(1770000000);
      const tokenLen = view.getUint16(REQ_HEADER_SIZE, true);
      const extrasOffset = REQ_HEADER_SIZE + 2 + tokenLen;
      expect(Array.from(bytes.subarray(extrasOffset))).toEqual([
        12, 0,
        BINARY_ORDER_EXTRA_TAG_TRAILING_STOP, 4, 40, 0, 0, 0,
        BINARY_ORDER_EXTRA_TAG_TRAILING_STEP, 4, 5, 0, 0, 0,
      ]);
    }

    // Verify frame 4 (modifyPendingOrder): action=5, TLV has 0x03=60, 0x04=10
    {
      const { bytes } = capturedFrames[4];
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(bytes[1]).toBe(BINARY_ORDER_ACTION_MODIFY_PENDING);
      const tokenLen = view.getUint16(REQ_HEADER_SIZE, true);
      const extrasOffset = REQ_HEADER_SIZE + 2 + tokenLen;
      expect(Array.from(bytes.subarray(extrasOffset))).toEqual([
        12, 0,
        BINARY_ORDER_EXTRA_TAG_TRAILING_STOP, 4, 60, 0, 0, 0,
        BINARY_ORDER_EXTRA_TAG_TRAILING_STEP, 4, 10, 0, 0, 0,
      ]);
    }
  });
});
