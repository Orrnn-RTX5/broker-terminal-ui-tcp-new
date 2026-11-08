import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BINARY_ORDER_ACTION_MODIFY_PENDING,
  BINARY_ORDER_ACTION_PLACE_PENDING,
  BINARY_ORDER_CODEC_VERSION,
  BINARY_ORDER_EXTRA_TAG_COMMENT,
  BINARY_ORDER_FLAG_HAS_EXPIRATION,
  BINARY_ORDER_FLAG_HAS_EXTRAS,
  BINARY_ORDER_FLAG_HAS_PRICE,
  BINARY_ORDER_FLAG_HAS_SL,
  BINARY_ORDER_FLAG_HAS_STOP_LIMIT,
  BINARY_ORDER_FLAG_HAS_TP,
  BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT,
  type BinaryTcpOrderParams,
  type DecodedBinaryOrderResp,
} from './binaryTcpOrderClient';

const mocks = vi.hoisted(() => ({
  isBinaryTcpOrderEnabled: vi.fn<() => boolean>(),
  sendBinaryTcpOrder: vi.fn<(params: BinaryTcpOrderParams) => Promise<DecodedBinaryOrderResp>>(),
}));

vi.mock('./binaryTcpOrderClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./binaryTcpOrderClient')>();
  return {
    ...actual,
    isBinaryTcpOrderEnabled: mocks.isBinaryTcpOrderEnabled,
    sendBinaryTcpOrder: mocks.sendBinaryTcpOrder,
  };
});

import { api } from './api';
import { encodeBinaryOrderWsModeAFrame } from './binaryTcpOrderClient';

function buildPendingResp(action: number, clientOrderId: string): DecodedBinaryOrderResp {
  return {
    version: BINARY_ORDER_CODEC_VERSION,
    action,
    status: 200,
    ok: true,
    execMicros: 210,
    orderTicket: 112233,
    positionTicket: 0,
    dealTicket: 0,
    fillPrice: 4170,
    volume: 0.1,
    profit: 0,
    commission: 0,
    sl: 4160,
    tp: 4185,
    symbol: 'XAUUSD',
    clientOrderId,
    errorCode: '',
    message: '',
  };
}

describe('pending order sweep wire (binary channel stop-limit / expiry / comment TLV, never REST fallback)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isBinaryTcpOrderEnabled.mockReturnValue(true);
    mocks.sendBinaryTcpOrder.mockImplementation(async (params) =>
      buildPendingResp(params.action, params.clientOrderId || 'bo-test-1'),
    );
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected REST call on pending order path'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a stop-limit place over binary channel with stopLimitPrice, epoch int expiration, and HAS_EXTRAS comment TLV', async () => {
    await api.orders.placePendingOrder({
      login: 100001,
      symbol: 'XAUUSD',
      side: 'buy',
      volume: 0.1,
      type: 'buy_stop_limit',
      price: 4170,
      price_limit: 4171,
      price_sl: 4160,
      price_tp: 4185,
      expiration: 1770000000,
      comment: 'sweep-stop-limit',
    });

    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
    const params = mocks.sendBinaryTcpOrder.mock.calls[0][0];
    expect(params).toMatchObject({
      action: BINARY_ORDER_ACTION_PLACE_PENDING,
      accountLogin: 100001,
      symbol: 'XAUUSD',
      orderSubType: BINARY_ORDER_SUBTYPE_BUY_STOP_LIMIT,
      volume: 0.1,
      price: 4170,
      stopLimitPrice: 4171,
      sl: 4160,
      tp: 4185,
      expiration: 1770000000,
      comment: 'sweep-stop-limit',
    });
    expect(params.flags).toBe(
      BINARY_ORDER_FLAG_HAS_PRICE
      | BINARY_ORDER_FLAG_HAS_STOP_LIMIT
      | BINARY_ORDER_FLAG_HAS_SL
      | BINARY_ORDER_FLAG_HAS_TP
      | BINARY_ORDER_FLAG_HAS_EXPIRATION
      | BINARY_ORDER_FLAG_HAS_EXTRAS,
    );

    // Verify wire TLV bytes for the comment
    const modeAFrame = encodeBinaryOrderWsModeAFrame(1, params);
    const commentBytes = Array.from(new TextEncoder().encode('sweep-stop-limit'));
    expect(Array.from(modeAFrame.subarray(132))).toEqual([
      commentBytes.length + 2, 0,
      BINARY_ORDER_EXTRA_TAG_COMMENT, commentBytes.length,
      ...commentBytes,
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unknown pending types and stop-limit orders without a stop-limit price', async () => {
    await expect(api.orders.placePendingOrder({
      login: 100001,
      symbol: 'XAUUSD',
      side: 'buy',
      volume: 0.1,
      type: 'buy_stop_limit',
      price: 4170,
    })).rejects.toThrow('Pending order stop-limit price must be greater than zero');

    await expect(api.orders.placePendingOrder({
      login: 100001,
      symbol: 'XAUUSD',
      side: 'buy',
      volume: 0.1,
      type: 'buy_take_profit' as unknown as 'buy_limit',
      price: 4170,
    })).rejects.toThrow('Pending order type must be');
  });

  it('rejects non-date/non-numeric expiration strings like GTC', async () => {
    await expect(api.orders.placePendingOrder({
      login: 100001,
      symbol: 'XAUUSD',
      side: 'buy',
      volume: 0.1,
      type: 'buy_limit',
      price: 4170,
      expiration: 'GTC' as unknown as number,
    })).rejects.toThrow('Invalid pending order expiration');
  });

  it('sends pending order modify with comment over the binary channel using HAS_EXTRAS (0x0400) and never calls REST', async () => {
    await api.orders.modifyPendingOrder(112233, {
      price: 2301,
      price_sl: 2291,
      price_tp: 2326,
      comment: 'updated-pending-comment',
    });

    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
    const params = mocks.sendBinaryTcpOrder.mock.calls[0][0];
    expect(params).toMatchObject({
      action: BINARY_ORDER_ACTION_MODIFY_PENDING,
      ticket: 112233,
      price: 2301,
      sl: 2291,
      tp: 2326,
      comment: 'updated-pending-comment',
    });
    expect((params.flags ?? 0) & BINARY_ORDER_FLAG_HAS_EXTRAS).toBe(BINARY_ORDER_FLAG_HAS_EXTRAS);
    expect(fetch).not.toHaveBeenCalled();
  });
});
