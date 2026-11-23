import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const benchMocks = vi.hoisted(() => ({
  useMockSend: false,
  mockResp: null as unknown as import('../binaryTcpOrderClient').DecodedBinaryOrderResp,
  sendCalls: 0,
}));

vi.mock('../binaryTcpOrderClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../binaryTcpOrderClient')>();
  return {
    ...actual,
    sendBinaryTcpOrder: (params: import('../binaryTcpOrderClient').BinaryTcpOrderParams) => {
      if (benchMocks.useMockSend) {
        benchMocks.sendCalls++;
        return Promise.resolve(benchMocks.mockResp);
      }
      return actual.sendBinaryTcpOrder(params);
    },
  };
});

vi.mock('../../config/backendTarget.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/backendTarget.js')>();
  return {
    ...actual,
    isDesktopBackendTarget: () => true,
  };
});

vi.mock('../brokerSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../brokerSession')>();
  return {
    ...actual,
    getAccessToken: () => 'bench-jwt-token',
    onSessionChange: () => () => {},
  };
});

import {
  __resetBinaryOrderWsForTests,
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_CODEC_VERSION,
  BINARY_ORDER_SIDE_BUY,
  BINARY_ORDER_SUBTYPE_MARKET,
  encodeBinaryOrderReq,
  ensureBinaryOrderWebSocket,
  RESP_HEADER_SIZE,
  sendBinaryTcpOrder,
  syncBinaryOrderAuthToken,
  WS_FAST_ORDER_FRAME_SIZE,
  WS_REQ_ID_SIZE,
  type BinaryTcpOrderParams,
  type DecodedBinaryOrderResp,
} from '../binaryTcpOrderClient';
import {
  installDealingOrderClientHooks,
  WS_FAST_ORDER_WITH_DEALING_CAPS_SIZE,
} from './dealingOrderClient';
import {
  isDealingWireGateOpen,
  resetDealingCapabilityState,
  setDealingServerAdvertised,
} from './dealingRuntimeHooks';
import { api } from '../api';
import { useAppStore } from '../../store/useAppStore';

describe('Dealing Binary TCP Order Hot-Path Micro-Benchmarks (Gate OFF 132B vs Gate ON 140B)', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalRequestAnimationFrame = globalThis.window?.requestAnimationFrame;
  let unregDealingHooks: (() => void) | null = null;

  beforeEach(() => {
    benchMocks.useMockSend = false;
    benchMocks.sendCalls = 0;
    resetDealingCapabilityState();
    __resetBinaryOrderWsForTests();
    unregDealingHooks = installDealingOrderClientHooks();
    (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = {
      BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
    };
    useAppStore.setState({
      accountId: '5058375',
      positions: [
        {
          id: '7001',
          ticket: 7001,
          symbol: 'EURUSD',
          side: 'BUY',
          volume: 0.1,
          openPrice: 1.1,
          currentPrice: 1.1005,
          sl: 0,
          tp: 0,
          profit: 5,
        } as never,
      ],
    });
  });

  afterEach(() => {
    benchMocks.useMockSend = false;
    unregDealingHooks?.();
    unregDealingHooks = null;
    resetDealingCapabilityState();
    __resetBinaryOrderWsForTests();
    globalThis.WebSocket = originalWebSocket;
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      delete (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__;
      delete (window as unknown as Record<string, unknown>).rtx5Electron;
    }
    vi.restoreAllMocks();
  });

  it('benchmarks Gate OFF 132B Mode A, Gate ON 140B Mode A + TLV 0x16, and placeMarketOrder / closePosition paths', async () => {
    const prebuiltWsResp = new ArrayBuffer(WS_REQ_ID_SIZE + RESP_HEADER_SIZE);
    const respBytes = new Uint8Array(prebuiltWsResp);
    const respView = new DataView(prebuiltWsResp);
    respBytes[WS_REQ_ID_SIZE + 0] = BINARY_ORDER_CODEC_VERSION;
    respBytes[WS_REQ_ID_SIZE + 1] = BINARY_ORDER_ACTION_PLACE_MARKET;
    respView.setUint16(WS_REQ_ID_SIZE + 2, 200, true);
    respView.setUint32(WS_REQ_ID_SIZE + 4, 180, true);
    respView.setBigInt64(WS_REQ_ID_SIZE + 8, 5001n, true);
    respView.setBigInt64(WS_REQ_ID_SIZE + 16, 7001n, true);
    respView.setBigInt64(WS_REQ_ID_SIZE + 24, 9001n, true);
    respView.setFloat64(WS_REQ_ID_SIZE + 32, 1.08542, true);
    respView.setFloat64(WS_REQ_ID_SIZE + 40, 0.1, true);

    let lastSentByteLength = 0;
    let lastTailHex = '';

    class BenchWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      readyState = BenchWebSocket.OPEN;
      binaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(public url: string) {}

      send(frame: Uint8Array | ArrayBuffer): void {
        const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const reqId = view.getUint32(0, true);
        if (reqId === 0) return;
        lastSentByteLength = bytes.byteLength;
        lastTailHex = Array.from(bytes.subarray(132))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        respView.setUint32(0, reqId, true);
        this.onmessage?.({ data: prebuiltWsResp });
      }

      close(): void {
        this.readyState = 3;
      }
    }

    globalThis.WebSocket = BenchWebSocket as unknown as typeof WebSocket;
    const sock = ensureBinaryOrderWebSocket();
    sock?.onopen?.(new Event('open'));
    syncBinaryOrderAuthToken('bench-jwt-token');

    const wsParams: BinaryTcpOrderParams = {
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      accountLogin: 5058375,
      symbol: 'EURUSD',
      side: BINARY_ORDER_SIDE_BUY,
      orderSubType: BINARY_ORDER_SUBTYPE_MARKET,
      volume: 0.1,
      clientOrderId: 'bo-00000001-1',
    };

    for (let i = 0; i < 2000; i++) {
      encodeBinaryOrderReq(wsParams);
    }
    const encodeIterations = 10000;
    const encodeRoundNs: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      for (let i = 0; i < encodeIterations; i++) {
        encodeBinaryOrderReq(wsParams);
      }
      encodeRoundNs.push(((performance.now() - t0) * 1_000_000) / encodeIterations);
    }
    encodeRoundNs.sort((a, b) => a - b);
    const medianEncodeNs = encodeRoundNs[2];

    expect(isDealingWireGateOpen()).toBe(false);
    for (let i = 0; i < 1000; i++) {
      await sendBinaryTcpOrder(wsParams);
    }
    expect(lastSentByteLength).toBe(WS_FAST_ORDER_FRAME_SIZE);
    expect(lastTailHex).toBe('');

    const wsIterations = 3000;
    const ws132RoundNs: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      for (let i = 0; i < wsIterations; i++) {
        await sendBinaryTcpOrder(wsParams);
      }
      ws132RoundNs.push(((performance.now() - t0) * 1_000_000) / wsIterations);
    }
    ws132RoundNs.sort((a, b) => a - b);
    const medianWsModeA132Ns = ws132RoundNs[2];

    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'web-tcp' };
    (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = {
      BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
      DEALING_BRIDGE_V1: true,
    };
    setDealingServerAdvertised(true);
    expect(isDealingWireGateOpen()).toBe(true);

    for (let i = 0; i < 1000; i++) {
      await sendBinaryTcpOrder(wsParams);
    }
    expect(lastSentByteLength).toBe(WS_FAST_ORDER_WITH_DEALING_CAPS_SIZE);
    expect(lastTailHex).toBe('0600160401000000');

    const wsRoundNs: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      for (let i = 0; i < wsIterations; i++) {
        await sendBinaryTcpOrder(wsParams);
      }
      wsRoundNs.push(((performance.now() - t0) * 1_000_000) / wsIterations);
    }
    wsRoundNs.sort((a, b) => a - b);
    const medianWsModeA140Ns = wsRoundNs[2];

    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(performance.now());
      return 1;
    }) as typeof window.requestAnimationFrame;

    const mockedDecodedResp: DecodedBinaryOrderResp = {
      version: 1,
      action: BINARY_ORDER_ACTION_PLACE_MARKET,
      status: 200,
      ok: true,
      execMicros: 180,
      orderTicket: 5001,
      positionTicket: 7001,
      dealTicket: 9001,
      fillPrice: 1.08542,
      volume: 0.1,
      profit: 12.5,
      commission: -0.2,
      sl: 0,
      tp: 0,
      symbol: 'EURUSD',
      clientOrderId: 'bo-00000001-1',
      errorCode: '',
      message: '',
      completedAtPerfMs: performance.now(),
    };

    benchMocks.mockResp = mockedDecodedResp;
    benchMocks.useMockSend = true;

    const marketOrderReq = {
      login: 5058375,
      symbol: 'EURUSD',
      side: 'buy' as const,
      volume: 0.1,
      price_sl: 0,
      price_tp: 0,
    };

    for (let i = 0; i < 500; i++) {
      await api.orders.placeMarketOrder(marketOrderReq);
    }

    const apiIterations = 1500;
    const placeMarketRoundNs: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      for (let i = 0; i < apiIterations; i++) {
        await api.orders.placeMarketOrder(marketOrderReq);
      }
      placeMarketRoundNs.push(((performance.now() - t0) * 1_000_000) / apiIterations);
    }
    placeMarketRoundNs.sort((a, b) => a - b);
    const medianPlaceMarketNs = placeMarketRoundNs[2];

    for (let i = 0; i < 500; i++) {
      await api.positions.closePosition(7001);
    }

    const closePosRoundNs: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      for (let i = 0; i < apiIterations; i++) {
        await api.positions.closePosition(7001);
      }
      closePosRoundNs.push(((performance.now() - t0) * 1_000_000) / apiIterations);
    }
    closePosRoundNs.sort((a, b) => a - b);
    const medianClosePositionNs = closePosRoundNs[2];

    const summary =
      `[DEALING BENCHMARK] encodeReq_ns=${medianEncodeNs.toFixed(1)} (${encodeRoundNs.map((n) => n.toFixed(0)).join(',')}) | ` +
      `wsModeA132_ns=${medianWsModeA132Ns.toFixed(1)} (${ws132RoundNs.map((n) => n.toFixed(0)).join(',')}) | ` +
      `wsModeA140_ns=${medianWsModeA140Ns.toFixed(1)} (${wsRoundNs.map((n) => n.toFixed(0)).join(',')}) | ` +
      `placeMarketOrder_ns=${medianPlaceMarketNs.toFixed(1)} (${placeMarketRoundNs.map((n) => n.toFixed(0)).join(',')}) | ` +
      `closePosition_ns=${medianClosePositionNs.toFixed(1)} (${closePosRoundNs.map((n) => n.toFixed(0)).join(',')})\n`;
    process.stderr.write(summary);

    expect(benchMocks.sendCalls).toBeGreaterThan(0);
    expect(medianEncodeNs).toBeGreaterThan(0);
    expect(medianWsModeA132Ns).toBeGreaterThan(0);
    expect(medianWsModeA140Ns).toBeGreaterThan(0);
    expect(medianPlaceMarketNs).toBeGreaterThan(0);
    expect(medianClosePositionNs).toBeGreaterThan(0);
  }, 30000);
});
