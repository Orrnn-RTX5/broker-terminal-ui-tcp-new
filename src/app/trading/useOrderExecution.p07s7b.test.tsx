/**
 * P07-7b end-to-end UI -> hook -> API -> binary codec wiring tests:
 * OrderPanelDialog -> handleOrderPanelSubmit (useOrderExecution.ts) -> api.orders.placePendingOrder -> binaryTcpOrderClient.
 *
 * Proves all four expiration modes ('GTC', 'Today', 'Specified', 'Specified day'):
 * - Switch OFF: emitted frames carry NO 0x08 / HAS_EXTRAS and match the pre-P07-7b baseline header+token wire layout
 *   (tui-127base byte layout for version, action, side, subType, flags, expiration, symbol, token, zero extras).
 * - Switch ON: exact same UI submissions emit extras TLV `08 01 00` .. `08 01 03`, with `HAS_EXPIRATION` set iff expiry > 0.
 *
 * Notice the switch-ON cases are expected RED until useOrderExecution.ts and api.ts forward the expiration mode to
 * sendBinaryTcpOrder.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const FLAG_ENV = 'VITE_BINARY_ORDER_EXPIRY_TYPE_TLV_ENABLED';
const FIXED_TOKEN = 'tok-p07s3';
const LOGIN = 1001;
const ACTION_PLACE_PENDING = 4;
const SIDE_BUY = 1;
const SUBTYPE_BUY_LIMIT = 1;
const FLAG_HAS_PRICE = 0x0020;
const FLAG_HAS_EXPIRATION = 0x0080;
const FLAG_HAS_EXTRAS = 0x0400;
const TAG_EXPIRY_TYPE = 0x08;

type ExpirationChoice = 'GTC' | 'Today' | 'Specified' | 'Specified day';

interface ModeExpectation {
  choice: ExpirationChoice;
  expiryCode: 0 | 1 | 2 | 3;
  expectedTimestamp: number;
  hasExpiration: boolean;
}

const MODES: readonly ModeExpectation[] = [
  {
    choice: 'GTC',
    expiryCode: 0,
    expectedTimestamp: 0,
    hasExpiration: false,
  },
  {
    choice: 'Today',
    expiryCode: 1,
    // 2026-06-10 23:59:59 local (system clock frozen at 2026-06-10 12:00:00)
    expectedTimestamp: Math.floor(new Date(2026, 5, 10, 23, 59, 59, 0).getTime() / 1000),
    hasExpiration: true,
  },
  {
    choice: 'Specified',
    expiryCode: 2,
    // Input '15.06.26 14:30' -> 2026-06-15 14:30:00 local
    expectedTimestamp: Math.floor(new Date(2026, 5, 15, 14, 30, 0, 0).getTime() / 1000),
    hasExpiration: true,
  },
  {
    choice: 'Specified day',
    expiryCode: 3,
    // Input '15.06.26 14:30' with Specified day -> 2026-06-15 23:59:59 local
    expectedTimestamp: Math.floor(new Date(2026, 5, 15, 23, 59, 59, 0).getTime() / 1000),
    hasExpiration: true,
  },
];

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readAscii(bytes: Uint8Array, start: number, len: number): string {
  const slice = bytes.subarray(start, start + len);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? slice.subarray(0, end) : slice);
}

/** Builds a minimal valid 136-byte HTTP binary order response matching decodeBinaryOrderResp. */
function makeBinaryOkResponse(reqFrame: Uint8Array, ticket = 5001n): ArrayBuffer {
  const buf = new ArrayBuffer(136);
  const out = new Uint8Array(buf);
  const view = new DataView(buf);
  out[0] = 1; // codec version
  out[1] = reqFrame[1]; // action
  view.setUint16(2, 200, true); // HTTP 200
  view.setUint32(4, 15, true); // execMicros
  view.setBigInt64(8, ticket, true); // orderTicket > 0 avoids REST poll
  view.setBigInt64(16, 0n, true);
  view.setFloat64(32, 4170, true);
  view.setFloat64(40, 0.01, true);
  out.set(reqFrame.subarray(72, 88), 80); // symbol
  out.set(reqFrame.subarray(88, 128), 96); // clientOrderId
  return buf;
}

/** Builds the exact pre-P07-7b tui-127base HTTP binary frame (no extras) for an extracted clientOrderId. */
function buildTui127BasePlaceFrame(params: {
  login: number;
  subType: number;
  side: number;
  flags: number;
  volume: number;
  price: number;
  expiration: number;
  symbol: string;
  clientOrderId: string;
  token: string;
}): Uint8Array {
  const tokenBytes = new TextEncoder().encode(params.token);
  const out = new Uint8Array(128 + 2 + tokenBytes.byteLength);
  const view = new DataView(out.buffer);
  out[0] = 1;
  out[1] = ACTION_PLACE_PENDING;
  out[2] = params.side;
  out[3] = params.subType;
  view.setUint16(4, params.flags, true);
  view.setUint16(6, 0, true);
  view.setBigInt64(8, BigInt(params.login), true);
  view.setBigInt64(16, 0n, true);
  view.setFloat64(24, params.volume, true);
  view.setFloat64(32, params.price, true);
  view.setFloat64(40, 0, true);
  view.setFloat64(48, 0, true);
  view.setFloat64(56, 0, true);
  view.setBigInt64(64, BigInt(params.expiration), true);
  out.set(new TextEncoder().encode(params.symbol.toUpperCase()).subarray(0, 16), 72);
  out.set(new TextEncoder().encode(params.clientOrderId).subarray(0, 40), 88);
  view.setUint16(128, tokenBytes.byteLength, true);
  out.set(tokenBytes, 130);
  return out;
}

function inspectHttpOrderFrame(frame: Uint8Array) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const flags = view.getUint16(4, true);
  const tokenLen = view.getUint16(128, true);
  const extrasOffset = 130 + tokenLen;
  const hasExtras = (flags & FLAG_HAS_EXTRAS) !== 0;
  const extrasBlock = frame.byteLength > extrasOffset ? frame.subarray(extrasOffset) : null;
  const tlvEntries: number[][] = [];
  if (extrasBlock && extrasBlock.byteLength >= 2) {
    const declaredLen = new DataView(extrasBlock.buffer, extrasBlock.byteOffset, extrasBlock.byteLength).getUint16(0, true);
    let pos = 2;
    while (pos < 2 + declaredLen) {
      const len = extrasBlock[pos + 1];
      tlvEntries.push(Array.from(extrasBlock.subarray(pos, pos + 2 + len)));
      pos += 2 + len;
    }
  }
  return {
    version: frame[0],
    action: frame[1],
    side: frame[2],
    subType: frame[3],
    flags,
    hasExpiration: (flags & FLAG_HAS_EXPIRATION) !== 0,
    hasExtras,
    login: Number(view.getBigInt64(8, true)),
    volume: view.getFloat64(24, true),
    price: view.getFloat64(32, true),
    expiration: Number(view.getBigInt64(64, true)),
    symbol: readAscii(frame, 72, 16),
    clientOrderId: readAscii(frame, 88, 40),
    token: readAscii(frame, 130, tokenLen),
    extrasBlock: extrasBlock ? Array.from(extrasBlock) : null,
    tlvEntries,
  };
}

let cleanupFn: (() => void) | undefined;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  const w = window as unknown as Record<string, unknown>;
  delete w.__RTX5_RUNTIME_CONFIG__;
  delete w.__RTX_RUNTIME_CONFIG__;
  delete w.rtx5Electron;
});

async function runOrderPanelSubmissionE2E(flagEnabled: boolean, mode: ModeExpectation) {
  cleanupFn?.();
  cleanupFn = undefined;
  vi.resetModules();
  vi.unstubAllEnvs();
  if (flagEnabled) {
    vi.stubEnv(FLAG_ENV, 'true');
  }

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 5, 10, 12, 0, 0, 0));

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

  // Keep WS disabled so sendBinaryTcpOrder deterministically emits the full HTTP frame containing header + token + TLV.
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
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;

  vi.doMock('../../services/brokerSession', async () => {
    const actual = await vi.importActual<typeof import('../../services/brokerSession')>('../../services/brokerSession');
    return { ...actual, getAccessToken: () => FIXED_TOKEN };
  });
  vi.doMock('../../utils/audio', () => ({ playSystemSound: vi.fn() }));
  vi.doMock('./tradeHistoryFreshness', () => ({
    createHistoryFreshnessOwner: () => ({ cancelled: false }),
    disposeHistoryFreshnessOwner: vi.fn(),
    refreshHistoryAfterFill: vi.fn(),
  }));

  const React = await import('react');
  const rtl = await import('@testing-library/react');
  cleanupFn = rtl.cleanup;

  const { useAppStore } = await import('../../store/useAppStore');
  useAppStore.setState({
    isAuthenticated: true,
    accountId: String(LOGIN),
    authToken: FIXED_TOKEN,
    tokenExpiresAt: 0,
    ticks: {
      XAUUSD: {
        symbol: 'XAUUSD',
        bid: 4173.23,
        ask: 4173.77,
        spread: 0.54,
        timestamp: Date.now(),
      },
    },
  });

  const { OrderPanelDialog } = await import('../../components/OrderPanelDialog');
  const { useOrderExecution } = await import('./useOrderExecution');

  const refreshOrdersAndHistory = vi.fn(async () => {});
  function Harness() {
    const [volume, setVolume] = React.useState(0.01);
    const exec = useOrderExecution({
      selectedMarketStatus: {
        symbol: 'XAUUSD',
        status: 'open',
        isOpen: true,
        isTradeBlocked: false,
        label: 'Market Open',
        loading: false,
        error: null,
        refreshedAt: Date.now(),
      },
      selectedSymbol: 'XAUUSD',
      volume,
      setVolume,
      domSymbol: 'XAUUSD',
      orderPanelSymbol: 'XAUUSD',
      getAllowedSymbol: (sym) => String(sym || 'XAUUSD').trim().toUpperCase(),
      getLiveTradingLogin: () => LOGIN,
      captureTradeOperationContext: () => ({
        sessionScope: `broker-a::${LOGIN}`,
        login: LOGIN,
        authGeneration: 1,
      }),
      isTradeOperationContextCurrent: () => true,
      refreshPositions: vi.fn(async () => {}),
      refreshOrdersAndHistory,
    });

    return React.createElement(OrderPanelDialog, {
      isOpen: true,
      onClose: vi.fn(),
      symbol: 'XAUUSD',
      currentPrice: { bid: 4173.23, ask: 4173.77 },
      onSubmitOrder: exec.handleOrderPanelSubmit,
      symbols: ['XAUUSD'],
    });
  }

  rtl.render(React.createElement(Harness));

  rtl.fireEvent.change(rtl.screen.getByLabelText('Type'), { target: { value: 'Buy Limit' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Price'), { target: { value: '4170.00' } });
  if (mode.choice !== 'GTC') {
    rtl.fireEvent.change(rtl.screen.getByLabelText('Expiration'), { target: { value: mode.choice } });
  }
  if (mode.choice === 'Specified' || mode.choice === 'Specified day') {
    rtl.fireEvent.change(rtl.screen.getByLabelText('Expiration date:'), { target: { value: '15.06.26 14:30' } });
  }

  rtl.fireEvent.click(rtl.screen.getAllByRole<HTMLButtonElement>('button', { name: 'Buy' })[0]);

  await rtl.waitFor(() => {
    expect(sentFrames).toHaveLength(1);
  });
  await rtl.act(async () => {
    await Promise.resolve();
  });

  return sentFrames[0];
}

describe('P07-7b T50d E2E: OrderPanelDialog -> handleOrderPanelSubmit -> api.orders.placePendingOrder -> binaryTcpOrderClient', () => {
  it.each(MODES)(
    'switch OFF: $choice emits a frame byte-identical to tui-127base (no 0x08)',
    async (mode) => {
      const frame = await runOrderPanelSubmissionE2E(false, mode);
      const decoded = inspectHttpOrderFrame(frame);

      expect(decoded.version).toBe(1);
      expect(decoded.action).toBe(ACTION_PLACE_PENDING);
      expect(decoded.side).toBe(SIDE_BUY);
      expect(decoded.subType).toBe(SUBTYPE_BUY_LIMIT);
      expect(decoded.login).toBe(LOGIN);
      expect(decoded.symbol).toBe('XAUUSD');
      expect(decoded.price).toBe(4170);
      expect(decoded.token).toBe(FIXED_TOKEN);
      expect(decoded.expiration).toBe(mode.expectedTimestamp);
      expect(decoded.hasExpiration).toBe(mode.hasExpiration);
      expect(decoded.hasExtras).toBe(false);
      expect(decoded.extrasBlock).toBeNull();

      const expectedBaseline = buildTui127BasePlaceFrame({
        login: LOGIN,
        subType: SUBTYPE_BUY_LIMIT,
        side: SIDE_BUY,
        flags: FLAG_HAS_PRICE | (mode.hasExpiration ? FLAG_HAS_EXPIRATION : 0),
        volume: decoded.volume,
        price: 4170,
        expiration: mode.expectedTimestamp,
        symbol: 'XAUUSD',
        clientOrderId: decoded.clientOrderId,
        token: FIXED_TOKEN,
      });
      expect(toHex(frame)).toBe(toHex(expectedBaseline));
    },
  );

  it.each(MODES)(
    'switch ON: $choice emits TLV 08 01 0$expiryCode matching mode',
    async (mode) => {
      const frame = await runOrderPanelSubmissionE2E(true, mode);
      const decoded = inspectHttpOrderFrame(frame);

      expect(decoded.action).toBe(ACTION_PLACE_PENDING);
      expect(decoded.expiration).toBe(mode.expectedTimestamp);
      expect(decoded.hasExpiration).toBe(mode.hasExpiration);
      expect(decoded.hasExtras).toBe(true);
      expect(decoded.tlvEntries).toEqual([[TAG_EXPIRY_TYPE, 1, mode.expiryCode]]);
      expect(decoded.extrasBlock).toEqual([3, 0, TAG_EXPIRY_TYPE, 1, mode.expiryCode]);
    },
  );
});
