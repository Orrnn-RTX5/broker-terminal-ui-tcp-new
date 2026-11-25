/**
 * P07-7b end-to-end UI -> API -> binary codec wiring tests:
 * ModifyPositionDialog (kind="pending-order") -> api.orders.modifyPendingOrder -> binaryTcpOrderClient.
 *
 * Proves:
 * - Switch OFF: TODAY, SPECIFIED, GTC-clear, and price-only modifications produce frames byte-identical to tui-127base
 *   (no 0x08, no HAS_EXTRAS).
 * - Switch ON:
 *   - TODAY (`time_in_force: 'DAY'` + expiry) emits `HAS_EXPIRATION` and TLV `08 01 01`.
 *   - SPECIFIED (`time_in_force: 'GTD'` + expiry) emits `HAS_EXPIRATION` and TLV `08 01 02`.
 *   - Price/SL/TP-only modification (no expiration set) omits `0x08` and `HAS_EXPIRATION`.
 *   - Clear-expiration-to-GTC (`time_in_force: 'GTC', expiry: null`) omits `0x08` and clears `HAS_EXPIRATION`.
 *
 * Notice the switch-ON TODAY and SPECIFIED cases are expected RED until api.ts maps `time_in_force` to `expiryType`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const FLAG_ENV = 'VITE_BINARY_ORDER_EXPIRY_TYPE_TLV_ENABLED';
const FIXED_TOKEN = 'tok-p07s3';
const LOGIN = 1001;
const TICKET = 34671;
const ACTION_MODIFY_PENDING = 5;
const FLAG_HAS_EXPIRATION = 0x0080;
const FLAG_HAS_EXTRAS = 0x0400;
const TAG_EXPIRY_TYPE = 0x08;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readAscii(bytes: Uint8Array, start: number, len: number): string {
  const slice = bytes.subarray(start, start + len);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? slice.subarray(0, end) : slice);
}

function makeBinaryOkResponse(reqFrame: Uint8Array, ticket = BigInt(TICKET)): ArrayBuffer {
  const buf = new ArrayBuffer(136);
  const out = new Uint8Array(buf);
  const view = new DataView(buf);
  out[0] = 1;
  out[1] = reqFrame[1];
  view.setUint16(2, 200, true);
  view.setUint32(4, 12, true);
  view.setBigInt64(8, ticket, true);
  view.setBigInt64(16, 0n, true);
  out.set(reqFrame.subarray(72, 88), 80);
  out.set(reqFrame.subarray(88, 128), 96);
  return buf;
}

/** Builds the pre-P07-7b tui-127base HTTP binary modify-pending frame (no extras). */
function buildTui127BaseModifyFrame(params: {
  login: number;
  ticket: number;
  flags: number;
  price: number;
  sl: number;
  tp: number;
  expiration: number;
  symbol: string;
  clientOrderId: string;
  token: string;
}): Uint8Array {
  const tokenBytes = new TextEncoder().encode(params.token);
  const out = new Uint8Array(128 + 2 + tokenBytes.byteLength);
  const view = new DataView(out.buffer);
  out[0] = 1;
  out[1] = ACTION_MODIFY_PENDING;
  out[2] = 0;
  out[3] = 0;
  view.setUint16(4, params.flags, true);
  view.setUint16(6, 0, true);
  view.setBigInt64(8, BigInt(params.login), true);
  view.setBigInt64(16, BigInt(params.ticket), true);
  view.setFloat64(24, 0, true);
  view.setFloat64(32, params.price, true);
  view.setFloat64(40, 0, true);
  view.setFloat64(48, params.sl, true);
  view.setFloat64(56, params.tp, true);
  view.setBigInt64(64, BigInt(params.expiration), true);
  out.set(new TextEncoder().encode(params.symbol.toUpperCase()).subarray(0, 16), 72);
  out.set(new TextEncoder().encode(params.clientOrderId).subarray(0, 40), 88);
  view.setUint16(128, tokenBytes.byteLength, true);
  out.set(tokenBytes, 130);
  return out;
}

function inspectModifyFrame(frame: Uint8Array) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const flags = view.getUint16(4, true);
  const tokenLen = view.getUint16(128, true);
  const extrasOffset = 130 + tokenLen;
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
    flags,
    hasExpiration: (flags & FLAG_HAS_EXPIRATION) !== 0,
    hasExtras: (flags & FLAG_HAS_EXTRAS) !== 0,
    login: Number(view.getBigInt64(8, true)),
    ticket: Number(view.getBigInt64(16, true)),
    price: view.getFloat64(32, true),
    sl: view.getFloat64(48, true),
    tp: view.getFloat64(56, true),
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

type Scenario = 'TODAY' | 'SPECIFIED' | 'PRICE_ONLY' | 'CLEAR_TO_GTC';

async function runModifyDialogE2E(flagEnabled: boolean, scenario: Scenario) {
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
    return new Response(JSON.stringify({ orders: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;

  vi.doMock('../services/brokerSession', async () => {
    const actual = await vi.importActual<typeof import('../services/brokerSession')>('../services/brokerSession');
    return { ...actual, getAccessToken: () => FIXED_TOKEN };
  });

  const React = await import('react');
  const rtl = await import('@testing-library/react');
  cleanupFn = rtl.cleanup;

  const { useAppStore } = await import('../store/useAppStore');
  const { markQuoteFeedActivity } = await import('../store/quoteFeedActivity');
  markQuoteFeedActivity('XAUUSD', Date.now());
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

  const { ModifyPositionDialog } = await import('./ModifyPositionDialog');

  const initialExpiry = scenario === 'CLEAR_TO_GTC'
    ? Math.floor(new Date(2026, 5, 20, 12, 0, 0, 0).getTime() / 1000)
    : undefined;

  rtl.render(
    React.createElement(ModifyPositionDialog, {
      isOpen: true,
      onClose: vi.fn(),
      kind: 'pending-order',
      position: {
        id: TICKET,
        symbol: 'XAUUSD',
        side: 'BUY',
        orderType: 'BUY_LIMIT',
        volume: 0.1,
        openPrice: 4170,
        sl: 4160,
        tp: 4185,
        ...(initialExpiry !== undefined ? { expiry: initialExpiry, timeInForce: 'GTD' as const } : {}),
      },
    }),
  );

  if (scenario === 'TODAY') {
    rtl.fireEvent.change(rtl.screen.getByLabelText('Expiration mode'), { target: { value: 'TODAY' } });
  } else if (scenario === 'SPECIFIED') {
    rtl.fireEvent.change(rtl.screen.getByLabelText('Expiration mode'), { target: { value: 'SPECIFIED' } });
    rtl.fireEvent.change(rtl.screen.getByTestId('modify-pending-expiry-picker'), { target: { value: '2026-06-15T14:30' } });
  } else if (scenario === 'CLEAR_TO_GTC') {
    rtl.fireEvent.change(rtl.screen.getByLabelText('Expiration mode'), { target: { value: 'GTC' } });
  } else if (scenario === 'PRICE_ONLY') {
    rtl.fireEvent.change(rtl.screen.getByLabelText(/^Price:/i), { target: { value: '4165.00' } });
  }

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: new RegExp(`Modify #${TICKET}`, 'i') }));

  await rtl.waitFor(() => {
    expect(sentFrames).toHaveLength(1);
  });
  await rtl.act(async () => {
    await Promise.resolve();
  });

  const expectedExpiration =
    scenario === 'TODAY'
      ? Math.floor(new Date(2026, 5, 10, 23, 59, 59, 0).getTime() / 1000)
      : scenario === 'SPECIFIED'
        ? Math.floor(new Date(2026, 5, 15, 14, 30, 0, 0).getTime() / 1000)
        : 0;

  return { frame: sentFrames[0], expectedExpiration };
}

describe('P07-7b T50d E2E: ModifyPositionDialog -> api.orders.modifyPendingOrder -> binaryTcpOrderClient', () => {
  it.each<Scenario>(['TODAY', 'SPECIFIED', 'PRICE_ONLY', 'CLEAR_TO_GTC'])(
    'switch OFF: %s modify emits a frame byte-identical to tui-127base (no 0x08)',
    async (scenario) => {
      const { frame, expectedExpiration } = await runModifyDialogE2E(false, scenario);
      const decoded = inspectModifyFrame(frame);

      expect(decoded.version).toBe(1);
      expect(decoded.action).toBe(ACTION_MODIFY_PENDING);
      expect(decoded.login).toBe(LOGIN);
      expect(decoded.ticket).toBe(TICKET);
      expect(decoded.symbol).toBe('');
      expect(decoded.token).toBe(FIXED_TOKEN);
      expect(decoded.expiration).toBe(expectedExpiration);
      expect(decoded.hasExpiration).toBe(expectedExpiration > 0);
      expect(decoded.hasExtras).toBe(false);
      expect(decoded.extrasBlock).toBeNull();

      const expectedBaseline = buildTui127BaseModifyFrame({
        login: LOGIN,
        ticket: TICKET,
        flags: decoded.flags & ~FLAG_HAS_EXTRAS,
        price: decoded.price,
        sl: decoded.sl,
        tp: decoded.tp,
        expiration: expectedExpiration,
        symbol: '',
        clientOrderId: decoded.clientOrderId,
        token: FIXED_TOKEN,
      });
      expect(toHex(frame)).toBe(toHex(expectedBaseline));
    },
  );

  it('switch ON: TODAY modify sets HAS_EXPIRATION and emits TLV 08 01 01', async () => {
    const { frame, expectedExpiration } = await runModifyDialogE2E(true, 'TODAY');
    const decoded = inspectModifyFrame(frame);
    expect(decoded.action).toBe(ACTION_MODIFY_PENDING);
    expect(decoded.expiration).toBe(expectedExpiration);
    expect(decoded.hasExpiration).toBe(true);
    expect(decoded.hasExtras).toBe(true);
    expect(decoded.tlvEntries).toEqual([[TAG_EXPIRY_TYPE, 1, 1]]);
    expect(decoded.extrasBlock).toEqual([3, 0, TAG_EXPIRY_TYPE, 1, 1]);
  });

  it('switch ON: SPECIFIED modify sets HAS_EXPIRATION and emits TLV 08 01 02', async () => {
    const { frame, expectedExpiration } = await runModifyDialogE2E(true, 'SPECIFIED');
    const decoded = inspectModifyFrame(frame);
    expect(decoded.action).toBe(ACTION_MODIFY_PENDING);
    expect(decoded.expiration).toBe(expectedExpiration);
    expect(decoded.hasExpiration).toBe(true);
    expect(decoded.hasExtras).toBe(true);
    expect(decoded.tlvEntries).toEqual([[TAG_EXPIRY_TYPE, 1, 2]]);
    expect(decoded.extrasBlock).toEqual([3, 0, TAG_EXPIRY_TYPE, 1, 2]);
  });

  it('switch ON: price/SL/TP-only modify sets NO HAS_EXPIRATION and emits NO 0x08', async () => {
    const { frame } = await runModifyDialogE2E(true, 'PRICE_ONLY');
    const decoded = inspectModifyFrame(frame);
    expect(decoded.action).toBe(ACTION_MODIFY_PENDING);
    expect(decoded.price).toBe(4165);
    expect(decoded.expiration).toBe(0);
    expect(decoded.hasExpiration).toBe(false);
    expect(decoded.hasExtras).toBe(false);
    expect(decoded.extrasBlock).toBeNull();
  });

  it('switch ON: clearing expiry back to GTC omits HAS_EXPIRATION and emits NO 0x08', async () => {
    const { frame } = await runModifyDialogE2E(true, 'CLEAR_TO_GTC');
    const decoded = inspectModifyFrame(frame);
    expect(decoded.action).toBe(ACTION_MODIFY_PENDING);
    expect(decoded.expiration).toBe(0);
    expect(decoded.hasExpiration).toBe(false);
    expect(decoded.hasExtras).toBe(false);
    expect(decoded.extrasBlock).toBeNull();
  });
});
