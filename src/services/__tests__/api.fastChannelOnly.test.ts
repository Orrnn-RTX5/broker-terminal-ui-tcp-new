import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import {
  BINARY_ORDER_ACTION_CANCEL_PENDING,
  BINARY_ORDER_ACTION_CLOSE_BULK,
  BINARY_ORDER_ACTION_CLOSE_BY,
  BINARY_ORDER_ACTION_CLOSE_POSITION,
  BINARY_ORDER_ACTION_MODIFY_PENDING,
  BINARY_ORDER_ACTION_MODIFY_POSITION,
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_ACTION_PLACE_PENDING,
  BINARY_ORDER_CODEC_VERSION,
  BINARY_ORDER_FLAG_HAS_EXTRAS,
  BINARY_ORDER_FLAG_PARTIAL_CLOSE,
  BinaryTcpOrderError,
  type BinaryTcpOrderParams,
  type DecodedBinaryOrderResp,
} from '../binaryTcpOrderClient';

const mocks = vi.hoisted(() => ({
  isBinaryTcpOrderEnabled: vi.fn<() => boolean>(),
  sendBinaryTcpOrder: vi.fn<(params: BinaryTcpOrderParams) => Promise<DecodedBinaryOrderResp>>(),
  restPlaceOrder: vi.fn(),
  restPlacePendingOrder: vi.fn(),
  restModifyPosition: vi.fn(),
  restModifyPendingOrder: vi.fn(),
  restClosePosition: vi.fn(),
  restCancelOrder: vi.fn(),
  restGetPositions: vi.fn(),
  restGetOrderCommand: vi.fn(),
}));

vi.mock('../binaryTcpOrderClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../binaryTcpOrderClient')>();
  return {
    ...actual,
    isBinaryTcpOrderEnabled: mocks.isBinaryTcpOrderEnabled,
    sendBinaryTcpOrder: mocks.sendBinaryTcpOrder,
  };
});

vi.mock('../../api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints')>();
  return {
    ...actual,
    tradingApi: {
      ...actual.tradingApi,
      placeOrder: mocks.restPlaceOrder,
      placePendingOrder: mocks.restPlacePendingOrder,
      modifyPosition: mocks.restModifyPosition,
      modifyPendingOrder: mocks.restModifyPendingOrder,
      closePosition: mocks.restClosePosition,
      cancelOrder: mocks.restCancelOrder,
      getPositions: mocks.restGetPositions,
      getOrderCommand: mocks.restGetOrderCommand,
    },
  };
});

import {
  api,
  FAST_CHANNEL_NOT_CONFIGURED_MESSAGE,
  FAST_CHANNEL_UNAVAILABLE_MESSAGE,
  FAST_CHANNEL_UNCERTAIN_MESSAGE,
  TRAILING_STOP_REST_EXCEPTION,
} from '../api';
import { useAppStore } from '../../store/useAppStore';

function buildSuccessResp(overrides?: Partial<DecodedBinaryOrderResp>): DecodedBinaryOrderResp {
  return {
    version: BINARY_ORDER_CODEC_VERSION,
    action: BINARY_ORDER_ACTION_PLACE_MARKET,
    status: 200,
    ok: true,
    execMicros: 180,
    orderTicket: 50001,
    positionTicket: 70001,
    dealTicket: 90001,
    fillPrice: 2345.67,
    volume: 0.1,
    profit: 12.5,
    commission: -0.2,
    sl: 0,
    tp: 0,
    symbol: 'XAUUSD',
    clientOrderId: '',
    errorCode: '',
    message: '',
    ...overrides,
  };
}

function expectZeroRestCalls(): void {
  expect(mocks.restPlaceOrder).not.toHaveBeenCalled();
  expect(mocks.restPlacePendingOrder).not.toHaveBeenCalled();
  expect(mocks.restModifyPosition).not.toHaveBeenCalled();
  expect(mocks.restModifyPendingOrder).not.toHaveBeenCalled();
  expect(mocks.restClosePosition).not.toHaveBeenCalled();
  expect(mocks.restCancelOrder).not.toHaveBeenCalled();
  expect(mocks.restGetPositions).not.toHaveBeenCalled();
  expect(mocks.restGetOrderCommand).not.toHaveBeenCalled();
}

describe('Terminal UI fast-channel-only order routing (LANE M2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isBinaryTcpOrderEnabled.mockReturnValue(true);
    useAppStore.setState({ accountId: '100001', positions: [] } as any);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected REST fetch on fast channel'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('when isBinaryTcpOrderEnabled() is false -> throws ApiError, zero REST calls', () => {
    beforeEach(() => {
      mocks.isBinaryTcpOrderEnabled.mockReturnValue(false);
    });

    it.each([
      ['closePosition', () => api.positions.closePosition(70001)],
      ['closePosition (partial)', () => api.positions.closePosition(70001, 0.05)],
      ['modifyPosition', () => api.positions.modifyPosition(70001, { price_sl: 2300, price_tp: 2400 })],
      ['closeBulk', () => api.positions.closeBulk(100001, 'ALL')],
      ['closeBy', () => api.positions.closeBy(70001, 70002)],
      ['placeMarketOrder', () => api.orders.placeMarketOrder({ login: 100001, symbol: 'XAUUSD', side: 'buy', volume: 0.1 })],
      ['placePendingOrder', () => api.orders.placePendingOrder({ login: 100001, symbol: 'XAUUSD', side: 'buy', type: 'buy_limit', volume: 0.1, price: 2300 })],
      ['cancelOrder', () => api.orders.cancelOrder(50001)],
      ['modifyPendingOrder', () => api.orders.modifyPendingOrder(50001, { price: 2310 })],
    ])('%s throws ApiError("Fast order channel is not configured for this Terminal") without calling REST', async (_label, invoke) => {
      await expect(invoke()).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).message).toBe(FAST_CHANNEL_NOT_CONFIGURED_MESSAGE);
        return true;
      });
      expect(mocks.sendBinaryTcpOrder).not.toHaveBeenCalled();
      expectZeroRestCalls();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('retryable binary errors -> retries on binary channel with SAME clientOrderId, never calls REST', () => {
    it.each([
      [
        'closePosition (partial)',
        () => api.positions.closePosition(70001, 0.05),
        BINARY_ORDER_ACTION_CLOSE_POSITION,
      ],
      [
        'modifyPosition',
        () => api.positions.modifyPosition(70001, { price_sl: 2300, price_tp: 2400 }),
        BINARY_ORDER_ACTION_MODIFY_POSITION,
      ],
      [
        'closeBulk',
        () => api.positions.closeBulk(100001, 'WINNERS', 'XAUUSD'),
        BINARY_ORDER_ACTION_CLOSE_BULK,
      ],
      [
        'closeBy',
        () => api.positions.closeBy(70001, 70002),
        BINARY_ORDER_ACTION_CLOSE_BY,
      ],
      [
        'placeMarketOrder',
        () => api.orders.placeMarketOrder({ login: 100001, symbol: 'XAUUSD', side: 'buy', volume: 0.1 }),
        BINARY_ORDER_ACTION_PLACE_MARKET,
      ],
      [
        'placePendingOrder',
        () => api.orders.placePendingOrder({ login: 100001, symbol: 'XAUUSD', side: 'buy', type: 'buy_limit', volume: 0.1, price: 2300 }),
        BINARY_ORDER_ACTION_PLACE_PENDING,
      ],
      [
        'cancelOrder',
        () => api.orders.cancelOrder(50001),
        BINARY_ORDER_ACTION_CANCEL_PENDING,
      ],
      [
        'modifyPendingOrder',
        () => api.orders.modifyPendingOrder(50001, { price: 2310, price_sl: 2290 }),
        BINARY_ORDER_ACTION_MODIFY_PENDING,
      ],
    ])('%s: fails once then succeeds on retry #2 with identical clientOrderId and zero REST calls', async (_name, invoke, expectedAction) => {
      mocks.sendBinaryTcpOrder
        .mockRejectedValueOnce(
          new BinaryTcpOrderError('Socket temporarily unreachable', {
            status: 503,
            code: 'BINARY_TRANSPORT_UNREACHABLE',
            retryable: true,
          }),
        )
        .mockImplementationOnce(async (params) => buildSuccessResp({
          action: expectedAction,
          clientOrderId: params.clientOrderId || '',
        }));

      await invoke();

      expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(2);
      const firstCall = mocks.sendBinaryTcpOrder.mock.calls[0][0];
      const secondCall = mocks.sendBinaryTcpOrder.mock.calls[1][0];
      expect(firstCall.action).toBe(expectedAction);
      expect(firstCall.clientOrderId).toBeTruthy();
      expect(secondCall.clientOrderId).toBe(firstCall.clientOrderId);
      expectZeroRestCalls();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['closePosition', () => api.positions.closePosition(70001)],
      ['modifyPosition', () => api.positions.modifyPosition(70001, { price_sl: 2300 })],
      ['closeBulk', () => api.positions.closeBulk(100001, 'ALL')],
      ['closeBy', () => api.positions.closeBy(70001, 70002)],
      ['placeMarketOrder', () => api.orders.placeMarketOrder({ login: 100001, symbol: 'XAUUSD', side: 'buy', volume: 0.1 })],
      ['placePendingOrder', () => api.orders.placePendingOrder({ login: 100001, symbol: 'XAUUSD', side: 'buy', type: 'buy_limit', volume: 0.1, price: 2300 })],
      ['cancelOrder', () => api.orders.cancelOrder(50001)],
      ['modifyPendingOrder', () => api.orders.modifyPendingOrder(50001, { price: 2310 })],
    ])('%s: fails 3x on retryable error -> throws ApiError("Fast order channel unavailable - order not sent, try again"), 0 REST calls', async (_name, invoke) => {
      mocks.sendBinaryTcpOrder.mockRejectedValue(
        new BinaryTcpOrderError('Binary TCP socket closed', {
          status: 503,
          code: 'BINARY_TCP_UNAVAILABLE',
          retryable: true,
        }),
      );

      await expect(invoke()).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).message).toBe(FAST_CHANNEL_UNAVAILABLE_MESSAGE);
        return true;
      });

      expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(3);
      const ids = mocks.sendBinaryTcpOrder.mock.calls.map(([p]) => p.clientOrderId);
      expect(ids[0]).toBeTruthy();
      expect(ids[1]).toBe(ids[0]);
      expect(ids[2]).toBe(ids[0]);
      expectZeroRestCalls();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('surfaces uncertain outcome message ("check history, do not repeat") when timeout (504) occurs without calling REST', async () => {
      mocks.sendBinaryTcpOrder.mockRejectedValueOnce(
        new BinaryTcpOrderError('Binary TCP order timed out after 4000ms', {
          status: 504,
          code: 'BINARY_TCP_TIMEOUT',
          retryable: false,
        }),
      );

      await expect(
        api.orders.placeMarketOrder({ login: 100001, symbol: 'XAUUSD', side: 'buy', volume: 0.1 }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(504);
        expect((err as ApiError).message).toBe(FAST_CHANNEL_UNCERTAIN_MESSAGE);
        return true;
      });

      expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
      expectZeroRestCalls();
    });

    it('respects AbortSignal during retry backoff and stops retrying immediately', async () => {
      const controller = new AbortController();
      mocks.sendBinaryTcpOrder.mockImplementationOnce(async () => {
        setTimeout(() => controller.abort(), 2);
        throw new BinaryTcpOrderError('Transient socket drop', {
          status: 503,
          code: 'BINARY_TRANSPORT_UNREACHABLE',
          retryable: true,
        });
      });

      await expect(
        api.positions.closePosition(70001, { signal: controller.signal }),
      ).rejects.toThrow(/aborted/i);

      expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledTimes(1);
      expectZeroRestCalls();
    });
  });

  describe('HAS_EXTRAS (0x0400) routing for comment & magic on placeMarketOrder, placePendingOrder, modifyPendingOrder', () => {
    it('sends comment and magic on binary channel with HAS_EXTRAS (0x0400) for placeMarketOrder, placePendingOrder, and modifyPendingOrder', async () => {
      mocks.sendBinaryTcpOrder.mockImplementation(async (params) => buildSuccessResp({
        action: params.action,
        clientOrderId: params.clientOrderId || '',
      }));

      await api.orders.placeMarketOrder({
        login: 100001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 0.25,
        comment: '  alpha-entry  ',
        magic: 777,
      });
      expect(mocks.sendBinaryTcpOrder).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: BINARY_ORDER_ACTION_PLACE_MARKET,
          flags: BINARY_ORDER_FLAG_HAS_EXTRAS,
          comment: 'alpha-entry',
          magic: 777,
        }),
      );

      await api.orders.placePendingOrder({
        login: 100001,
        symbol: 'EURUSD',
        side: 'buy',
        type: 'buy_limit',
        volume: 0.25,
        price: 1.08,
        comment: 'pending-note',
        magic: 888,
      });
      expect(mocks.sendBinaryTcpOrder).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: BINARY_ORDER_ACTION_PLACE_PENDING,
          comment: 'pending-note',
          magic: 888,
        }),
      );
      expect(
        (mocks.sendBinaryTcpOrder.mock.calls.at(-1)?.[0].flags ?? 0) & BINARY_ORDER_FLAG_HAS_EXTRAS,
      ).toBe(BINARY_ORDER_FLAG_HAS_EXTRAS);

      await api.orders.modifyPendingOrder(50001, {
        comment: 'modified-comment',
      });
      expect(mocks.sendBinaryTcpOrder).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: BINARY_ORDER_ACTION_MODIFY_PENDING,
          ticket: 50001,
          flags: BINARY_ORDER_FLAG_HAS_EXTRAS,
          comment: 'modified-comment',
        }),
      );

      expectZeroRestCalls();
    });

    it('rejects comment > 64 UTF-8 bytes with ApiError before touching binary transport', async () => {
      const tooLongAscii = 'x'.repeat(65);
      const tooLongUtf8 = '€'.repeat(22); // 66 UTF-8 bytes

      for (const badComment of [tooLongAscii, tooLongUtf8]) {
        await expect(
          api.orders.placeMarketOrder({
            login: 100001,
            symbol: 'EURUSD',
            side: 'buy',
            volume: 0.1,
            comment: badComment,
          }),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(ApiError);
          expect((err as ApiError).status).toBe(400);
          expect((err as ApiError).message).toMatch(/64 UTF-8 bytes/);
          return true;
        });
      }

      expect(mocks.sendBinaryTcpOrder).not.toHaveBeenCalled();
      expectZeroRestCalls();
    });

    it('sets BINARY_ORDER_FLAG_PARTIAL_CLOSE on partial closePosition', async () => {
      useAppStore.setState({
        accountId: '100001',
        positions: [{ id: 70001, ticket: 70001, symbol: 'XAUUSD', side: 'BUY', volume: 1.0 }],
      } as any);
      mocks.sendBinaryTcpOrder.mockResolvedValueOnce(buildSuccessResp({
        action: BINARY_ORDER_ACTION_CLOSE_POSITION,
        volume: 0.4,
      }));

      const res = await api.positions.closePosition(70001, 0.4);
      expect(res).toMatchObject({
        ticket: 70001,
        closed_volume: 0.4,
        status: 'partial_closed',
      });
      expect(mocks.sendBinaryTcpOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          action: BINARY_ORDER_ACTION_CLOSE_POSITION,
          ticket: 70001,
          volume: 0.4,
          flags: BINARY_ORDER_FLAG_PARTIAL_CLOSE,
          partialClose: true,
        }),
      );
      expectZeroRestCalls();
    });
  });

  describe('TRAILING_STOP_REST_EXCEPTION (only allowed REST exception)', () => {
    it('routes trailing_stop / trailing_step orders to REST when TRAILING_STOP_REST_EXCEPTION is enabled', async () => {
      expect(TRAILING_STOP_REST_EXCEPTION).toBe(true);
      mocks.restPlaceOrder.mockResolvedValueOnce({
        id: '9001',
        ticket: 9001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 0.1,
        price_open: 1.085,
      });
      mocks.restPlacePendingOrder.mockResolvedValueOnce({
        id: '9002',
        ticket: 9002,
        symbol: 'EURUSD',
        side: 'buy',
        type: 'buy_limit',
        volume: 0.1,
        price: 1.08,
      });
      mocks.restModifyPosition.mockResolvedValueOnce({
        id: '70001',
        ticket: 70001,
        symbol: 'EURUSD',
      });
      mocks.restModifyPendingOrder.mockResolvedValueOnce({
        id: '50001',
        ticket: 50001,
        symbol: 'EURUSD',
      });

      await api.orders.placeMarketOrder({
        login: 100001,
        symbol: 'EURUSD',
        side: 'buy',
        volume: 0.1,
        trailing_stop: 15,
      });
      expect(mocks.restPlaceOrder).toHaveBeenCalledTimes(1);

      await api.orders.placePendingOrder({
        login: 100001,
        symbol: 'EURUSD',
        side: 'buy',
        type: 'buy_limit',
        volume: 0.1,
        price: 1.08,
        trailing_step: 5,
      });
      expect(mocks.restPlacePendingOrder).toHaveBeenCalledTimes(1);

      await api.positions.modifyPosition(70001, { trailing_stop: 20 });
      expect(mocks.restModifyPosition).toHaveBeenCalledTimes(1);

      await api.orders.modifyPendingOrder(50001, { trailing_stop: 25 });
      expect(mocks.restModifyPendingOrder).toHaveBeenCalledTimes(1);

      expect(mocks.sendBinaryTcpOrder).not.toHaveBeenCalled();
    });
  });
});
