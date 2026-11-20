import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ApiError } from '../api/client';
import {
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_CODEC_VERSION,
  BINARY_ORDER_FLAG_HAS_EXTRAS,
  BINARY_ORDER_FLAG_HAS_SL,
  BINARY_ORDER_FLAG_HAS_TP,
  BINARY_ORDER_SIDE_BUY,
  BINARY_ORDER_SIDE_SELL,
  BINARY_ORDER_SUBTYPE_MARKET,
  BinaryTcpOrderError,
  type BinaryTcpOrderParams,
  type DecodedBinaryOrderResp,
} from './binaryTcpOrderClient';

const mocks = vi.hoisted(() => ({
  isBinaryTcpOrderEnabled: vi.fn<() => boolean>(),
  sendBinaryTcpOrder: vi.fn<(params: BinaryTcpOrderParams) => Promise<DecodedBinaryOrderResp>>(),
  restPlaceOrder: vi.fn(),
  restGetOrderCommand: vi.fn(),
}));

vi.mock('./binaryTcpOrderClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./binaryTcpOrderClient')>();
  return {
    ...actual,
    isBinaryTcpOrderEnabled: mocks.isBinaryTcpOrderEnabled,
    sendBinaryTcpOrder: mocks.sendBinaryTcpOrder,
  };
});

vi.mock('../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/endpoints')>();
  return {
    ...actual,
    tradingApi: {
      ...actual.tradingApi,
      placeOrder: mocks.restPlaceOrder,
      getOrderCommand: mocks.restGetOrderCommand,
    },
  };
});

import {
  api,
  FAST_CHANNEL_NOT_CONFIGURED_MESSAGE,
  FAST_CHANNEL_UNAVAILABLE_MESSAGE,
  FAST_CHANNEL_UNCERTAIN_MESSAGE,
} from './api';
import {
  clearTradeOrderLatencySamples,
  getTradeOrderLatencySamples,
} from './orderLatencyTelemetry';
import { MARKET_ORDER_PLACEMENT_STATE_EVENT } from './marketOrderPlacementEvents';

const CLIENT_ORDER_ID = '123e4567-e89b-42d3-a456-426614174000';

const inputOrder = {
  login: 200002,
  symbol: 'BTCUSD',
  side: 'buy' as const,
  volume: 0.01,
  price_sl: 0,
  price_tp: 0,
};

function buildBinaryFill(overrides?: Partial<DecodedBinaryOrderResp>): DecodedBinaryOrderResp {
  return {
    version: BINARY_ORDER_CODEC_VERSION,
    action: BINARY_ORDER_ACTION_PLACE_MARKET,
    status: 200,
    ok: true,
    execMicros: 195,
    orderTicket: 880001,
    positionTicket: 990001,
    dealTicket: 770001,
    fillPrice: 65321.45,
    volume: 0.01,
    profit: 0,
    commission: -0.25,
    sl: 0,
    tp: 0,
    symbol: 'BTCUSD',
    clientOrderId: CLIENT_ORDER_ID,
    errorCode: '',
    message: '',
    ...overrides,
  };
}

describe('ordersApi.placeMarketOrder binary-channel-only transport', () => {
  let onNewTrade: Mock<(event: Event) => void>;
  let onPlacementState: Mock<(event: Event) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isBinaryTcpOrderEnabled.mockReturnValue(true);
    clearTradeOrderLatencySamples();

    onNewTrade = vi.fn<(event: Event) => void>();
    onPlacementState = vi.fn<(event: Event) => void>();
    window.addEventListener('rtx:new-trade-placed', onNewTrade);
    window.addEventListener(MARKET_ORDER_PLACEMENT_STATE_EVENT, onPlacementState);
    // Execute requestAnimationFrame callbacks synchronously for deterministic event assertions
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(performance.now());
      return 1;
    });
  });

  afterEach(() => {
    window.removeEventListener('rtx:new-trade-placed', onNewTrade);
    window.removeEventListener(MARKET_ORDER_PLACEMENT_STATE_EVENT, onPlacementState);
    vi.restoreAllMocks();
  });

  it('sends market BUY over binary channel, maps position, and dispatches fill events and telemetry', async () => {
    mocks.sendBinaryTcpOrder.mockResolvedValueOnce(buildBinaryFill());

    const intentAtMs = performance.now();
    const result = await api.orders.placeMarketOrder(
      { ...inputOrder, client_order_id: CLIENT_ORDER_ID },
      { intentAtMs },
    );

    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
    expect(mocks.sendBinaryTcpOrder.mock.calls[0][0]).toMatchObject({
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 200002,
      symbol: 'BTCUSD',
      side: BINARY_ORDER_SIDE_BUY,
      orderSubType: BINARY_ORDER_SUBTYPE_MARKET,
      flags: 0,
      volume: 0.01,
      clientOrderId: CLIENT_ORDER_ID,
    });
    expect(mocks.restPlaceOrder).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ticket: 990001,
      account_login: 200002,
      symbol: 'BTCUSD',
      side: 'buy',
      volume: 0.01,
      price_open: 65321.45,
      commission: -0.25,
      price_current: 0,
      hasBackendCurrentPrice: false,
      hasBackendProfit: false,
    });
    expect(onNewTrade).toHaveBeenCalledTimes(1);
    expect(getTradeOrderLatencySamples()).toContainEqual(
      expect.objectContaining({
        phase: 'placement_terminal',
        transport: 'websocket',
        clientOrderId: CLIENT_ORDER_ID,
        terminalStatus: 'filled',
        symbol: 'BTCUSD',
        side: 'buy',
        volume: 0.01,
      }),
    );
  });

  it('routes SELL with SL/TP and comment/magic extras over the binary channel with HAS_EXTRAS (0x0400)', async () => {
    mocks.sendBinaryTcpOrder.mockResolvedValueOnce(buildBinaryFill());

    const result = await api.orders.placeMarketOrder({
      ...inputOrder,
      side: 'sell',
      price_sl: 66000,
      price_tp: 64000,
      comment: 'scalp-btc',
      magic: 123456,
    });

    expect(result).toMatchObject({
      side: 'sell',
      ticket: 990001,
    });
    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        action: BINARY_ORDER_ACTION_PLACE_MARKET,
        side: BINARY_ORDER_SIDE_SELL,
        flags: BINARY_ORDER_FLAG_HAS_SL | BINARY_ORDER_FLAG_HAS_TP | BINARY_ORDER_FLAG_HAS_EXTRAS,
        sl: 66000,
        tp: 64000,
        comment: 'scalp-btc',
        magic: 123456,
      }),
    );
    expect(mocks.restPlaceOrder).not.toHaveBeenCalled();
  });

  it('retries retryable binary error with the SAME client_order_id and succeeds without calling REST', async () => {
    mocks.sendBinaryTcpOrder
      .mockRejectedValueOnce(
        new BinaryTcpOrderError('Socket temporarily unavailable', {
          status: 503,
          code: 'BINARY_TCP_UNAVAILABLE',
          retryable: true,
        }),
      )
      .mockResolvedValueOnce(buildBinaryFill());

    const result = await api.orders.placeMarketOrder(inputOrder);
    expect(result.ticket).toBe(990001);
    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(2);
    const firstId = mocks.sendBinaryTcpOrder.mock.calls[0][0].clientOrderId;
    const secondId = mocks.sendBinaryTcpOrder.mock.calls[1][0].clientOrderId;
    expect(firstId).toBeTruthy();
    expect(secondId).toBe(firstId);
    expect(mocks.restPlaceOrder).not.toHaveBeenCalled();
  });

  it('throws ApiError("Fast order channel unavailable - order not sent, try again") after 3 failed retryable binary attempts and never calls REST', async () => {
    mocks.sendBinaryTcpOrder.mockRejectedValue(
      new BinaryTcpOrderError('Fast channel unreachable', {
        status: 503,
        code: 'BINARY_TCP_UNAVAILABLE',
        retryable: true,
      }),
    );

    await expect(api.orders.placeMarketOrder(inputOrder)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe(FAST_CHANNEL_UNAVAILABLE_MESSAGE);
      return true;
    });

    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(3);
    const ids = mocks.sendBinaryTcpOrder.mock.calls.map(([p]) => p.clientOrderId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
    expect(mocks.restPlaceOrder).not.toHaveBeenCalled();
  });

  it('throws ApiError("Fast order channel is not configured for this Terminal") when binary channel is disabled', async () => {
    mocks.isBinaryTcpOrderEnabled.mockReturnValue(false);

    await expect(api.orders.placeMarketOrder(inputOrder)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe(FAST_CHANNEL_NOT_CONFIGURED_MESSAGE);
      return true;
    });

    expect(mocks.sendBinaryTcpOrder).not.toHaveBeenCalled();
    expect(mocks.restPlaceOrder).not.toHaveBeenCalled();
  });

  it('does not retry non-retryable 4xx binary rejections and surfaces backend rejection code and message', async () => {
    mocks.sendBinaryTcpOrder.mockRejectedValueOnce(
      new BinaryTcpOrderError('No fresh BTCUSD quote is available.', {
        status: 409,
        code: 'NO_FRESH_QUOTE',
        backendMessage: 'No fresh BTCUSD quote is available.',
        retryable: false,
      }),
    );

    await expect(api.orders.placeMarketOrder(inputOrder)).rejects.toMatchObject({
      status: 409,
      code: 'NO_FRESH_QUOTE',
      backendMessage: 'No fresh BTCUSD quote is available.',
    });

    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
    expect(mocks.restPlaceOrder).not.toHaveBeenCalled();
  });

  it('surfaces uncertain outcome message on 504 timeout without calling REST', async () => {
    mocks.sendBinaryTcpOrder.mockRejectedValueOnce(
      new BinaryTcpOrderError('Binary TCP order timed out after 4000ms', {
        status: 504,
        code: 'BINARY_TCP_TIMEOUT',
        retryable: false,
      }),
    );

    await expect(api.orders.placeMarketOrder(inputOrder)).rejects.toMatchObject({
      status: 504,
      message: FAST_CHANNEL_UNCERTAIN_MESSAGE,
      orderWasSent: true,
    });

    expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
    expect(mocks.restPlaceOrder).not.toHaveBeenCalled();
    expect(mocks.restGetOrderCommand).not.toHaveBeenCalled();
  });

  it('never dispatches a provisional Trade row on slow rejection (>45ms) while still logging to Journal telemetry', async () => {
    vi.useFakeTimers();
    try {
      let rejectOrder!: (err: unknown) => void;
      mocks.sendBinaryTcpOrder.mockImplementationOnce(() => new Promise((_, reject) => {
        rejectOrder = reject;
      }));

      const promise = api.orders.placeMarketOrder({
        ...inputOrder,
        symbol: 'EURAUD',
        side: 'sell',
        volume: 0.01,
        client_order_id: CLIENT_ORDER_ID,
      });

      await vi.advanceTimersByTimeAsync(120);
      expect(onPlacementState).not.toHaveBeenCalled();

      rejectOrder(new BinaryTcpOrderError('Commission calculation failed for EURAUD', {
        status: 400,
        code: 'COMMISSION_CALC_FAILED',
        backendMessage: 'Commission calculation failed for EURAUD',
        retryable: false,
      }));

      await expect(promise).rejects.toMatchObject({
        status: 400,
        code: 'COMMISSION_CALC_FAILED',
        backendMessage: 'Commission calculation failed for EURAUD',
      });

      expect(onPlacementState).not.toHaveBeenCalled();
      expect(onNewTrade).not.toHaveBeenCalled();
      expect(getTradeOrderLatencySamples()).toContainEqual(
        expect.objectContaining({
          phase: 'placement_terminal',
          clientOrderId: CLIENT_ORDER_ID,
          symbol: 'EURAUD',
          side: 'sell',
          volume: 0.01,
          terminalStatus: 'rejected',
          errorCode: 'COMMISSION_CALC_FAILED',
          errorMessage: 'Commission calculation failed for EURAUD',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
