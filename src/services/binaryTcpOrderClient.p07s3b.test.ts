// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BinaryTcpOrderParams } from './binaryTcpOrderClient';
import * as dealingCodec from './dealing/binaryDealingCodec';
import * as dealingHooks from './dealing/dealingRuntimeHooks';
import {
  CLIENT_CAP_DEALING_V1,
  WIRE_EXTRA_TAG_CLIENT_CAPS,
  WIRE_EXTRA_TAG_FILLING,
  WIRE_ORDER_FILLING_MAX,
  appendClientCapsToExtrasTlv,
  decodeReqExtrasBlock,
} from './dealing/binaryDealingCodec';

vi.mock('../config/backendTarget.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/backendTarget.js')>();
  return {
    ...actual,
    isDesktopBackendTarget: () => true,
  };
});

vi.mock('./brokerSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./brokerSession')>();
  return {
    ...actual,
    getAccessToken: () => 'tok-p07s3',
    onSessionChange: () => () => {},
  };
});

type OrderParamsWithFilling = BinaryTcpOrderParams & { filling?: unknown };

const FIXED_UUID = '123e4567-e89b-42d3-a456-426614174000';
const FIXED_TOKEN = 'tok-p07s3';
const FIXED_TOKEN_LEN = new TextEncoder().encode(FIXED_TOKEN).byteLength;
const FIXED_REQ_ID = 42;
const FILL_FLAG_ENV = 'VITE_BINARY_ORDER_FILLING_TLV_ENABLED';

const ACTION_PLACE_MARKET = 1;
const ACTION_CLOSE_POSITION = 2;
const ACTION_MODIFY_POSITION = 3;
const ACTION_PLACE_PENDING = 4;
const ACTION_MODIFY_PENDING = 5;
const ACTION_CANCEL_PENDING = 6;
const ACTION_CLOSE_BULK = 7;
const ACTION_CLOSE_BY = 8;

const SUBTYPE_BUY_LIMIT = 1;
const FLAG_HAS_EXTRAS = 0x0400;
const HEADER_SIZE = 128;
const RESP_SIZE = 136;
const WS_REQ_ID_LEN = 4;
const WS_FAST_SIZE = WS_REQ_ID_LEN + HEADER_SIZE;
const EXTRAS_MAX_BYTES = 512;
const ORDER_CLIENT_SRC_PATH = path.resolve(process.cwd(), 'src/services/binaryTcpOrderClient.ts');

/**
 * Golden frames captured directly from BASELINE (`tui-p18r-base`, pristine export of
 * terminal commit `994efc5`) by running `logs/capture_baseline_goldens.mjs` (transpiling
 * `tui-p18r-base/src/services/binaryTcpOrderClient.ts` + `dealingRuntimeHooks.ts` with
 * stubbed `backendTarget.js` and `brokerSession`) under Node via the heavy lock.
 */
const BASELINE_GOLDEN_FRAMES = {
  marketBare: {
    http: '0101010000000000e90300000000000000000000000000009a9999999999b93f000000000000000000000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a0000000101010000000000e90300000000000000000000000000009a9999999999b93f000000000000000000000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a0000000101010000000000e90300000000000000000000000000009a9999999999b93f000000000000000000000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
  marketExtras: {
    http: '0101010000050000e90300000000000000000000000000009a9999999999b93f000000000000000000000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d70303773331f0001077030372d72656602082a00000000000000030419000000040405000000',
    wsA: '2a0000000101010000050000e90300000000000000000000000000009a9999999999b93f000000000000000000000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000001f0001077030372d72656602082a00000000000000030419000000040405000000',
    wsB: '2a0000000101010000050000e90300000000000000000000000000009a9999999999b93f000000000000000000000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d70303773331f0001077030372d72656602082a00000000000000030419000000040405000000',
  },
  pendingBare: {
    http: '0104010120000000e9030000000000000000000000000000000000000000d03f5c8fc2f5285cf13f00000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a0000000104010120000000e9030000000000000000000000000000000000000000d03f5c8fc2f5285cf13f00000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a0000000104010120000000e9030000000000000000000000000000000000000000d03f5c8fc2f5285cf13f00000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
  closePartial: {
    http: '0102000004000000e903000000000000915f0100000000009a9999999999b93f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a0000000102000004000000e903000000000000915f0100000000009a9999999999b93f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a0000000102000004000000e903000000000000915f0100000000009a9999999999b93f000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
  closeFull: {
    http: '0102000000000000e903000000000000915f0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a0000000102000000000000e903000000000000915f0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a0000000102000000000000e903000000000000915f0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
  modifyPositionBare: {
    http: '0103000003000000e903000000000000915f01000000000000000000000000000000000000000000000000000000000048e17a14ae47f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a0000000103000003000000e903000000000000915f01000000000000000000000000000000000000000000000000000000000048e17a14ae47f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a0000000103000003000000e903000000000000915f01000000000000000000000000000000000000000000000000000000000048e17a14ae47f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
  modifyPositionExtras: {
    http: '0103000003050000e903000000000000915f01000000000000000000000000000000000000000000000000000000000048e17a14ae47f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d70303773330c0003041e000000040405000000',
    wsA: '2a0000000103000003050000e903000000000000915f01000000000000000000000000000000000000000000000000000000000048e17a14ae47f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000c0003041e000000040405000000',
    wsB: '2a0000000103000003050000e903000000000000915f01000000000000000000000000000000000000000000000000000000000048e17a14ae47f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d70303773330c0003041e000000040405000000',
  },
  modifyPendingBare: {
    http: '01050000a3000000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a00000001050000a3000000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a00000001050000a3000000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
  modifyPendingExtras: {
    http: '01050000a3040000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333140001086d6f642d70656e6402084d00000000000000',
    wsA: '2a00000001050000a3040000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000140001086d6f642d70656e6402084d00000000000000',
    wsB: '2a00000001050000a3040000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333140001086d6f642d70656e6402084d00000000000000',
  },
  cancelPending: {
    http: '0106000000000000e9030000000000007a630100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a0000000106000000000000e9030000000000007a630100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a0000000106000000000000e9030000000000007a630100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
  closeBulk: {
    http: '0107000000000000e90300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a0000000107000000000000e90300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a0000000107000000000000e90300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
  closeBy: {
    http: '0108000080000000e903000000000000915f01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000925f0100000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a0000000108000080000000e903000000000000915f01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000925f0100000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a0000000108000080000000e903000000000000915f01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000925f0100000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
} as const;

const marketBareBase = (): OrderParamsWithFilling => ({
  action: ACTION_PLACE_MARKET,
  accountLogin: 1001,
  symbol: 'EURUSD',
  side: 'BUY',
  volume: 0.1,
  clientOrderId: FIXED_UUID,
  authToken: FIXED_TOKEN,
});

const marketExtrasBase = (): OrderParamsWithFilling => ({
  ...marketBareBase(),
  comment: 'p07-ref',
  magic: 42n,
  trailingStop: 25,
  trailingStep: 5,
});

const pendingBareBase = (): OrderParamsWithFilling => ({
  action: ACTION_PLACE_PENDING,
  accountLogin: 1001,
  symbol: 'EURUSD',
  side: 'BUY',
  orderSubType: SUBTYPE_BUY_LIMIT,
  volume: 0.25,
  price: 1.085,
  clientOrderId: FIXED_UUID,
  authToken: FIXED_TOKEN,
});

const closePartialBase = (): OrderParamsWithFilling => ({
  action: ACTION_CLOSE_POSITION,
  accountLogin: 1001,
  ticket: 90001,
  volume: 0.1,
  partialClose: true,
  clientOrderId: FIXED_UUID,
  authToken: FIXED_TOKEN,
});

const closeFullBase = (): OrderParamsWithFilling => ({
  action: ACTION_CLOSE_POSITION,
  accountLogin: 1001,
  ticket: 90001,
  volume: 0,
  clientOrderId: FIXED_UUID,
  authToken: FIXED_TOKEN,
});

const modifyPositionBareBase = (): OrderParamsWithFilling => ({
  action: ACTION_MODIFY_POSITION,
  accountLogin: 1001,
  ticket: 90001,
  sl: 1.08,
  tp: 1.095,
  clientOrderId: FIXED_UUID,
  authToken: FIXED_TOKEN,
});

const modifyPositionExtrasBase = (): OrderParamsWithFilling => ({
  ...modifyPositionBareBase(),
  trailingStop: 30,
  trailingStep: 5,
});

const modifyPendingBareBase = (): OrderParamsWithFilling => ({
  action: ACTION_MODIFY_PENDING,
  accountLogin: 1001,
  ticket: 91002,
  price: 1.082,
  sl: 1.075,
  tp: 1.095,
  expiration: 1790000000,
  clientOrderId: FIXED_UUID,
  authToken: FIXED_TOKEN,
});

const modifyPendingExtrasBase = (): OrderParamsWithFilling => ({
  ...modifyPendingBareBase(),
  comment: 'mod-pend',
  magic: 77n,
});

const cancelPendingBase = (): OrderParamsWithFilling => ({
  action: ACTION_CANCEL_PENDING,
  accountLogin: 1001,
  ticket: 91002,
  clientOrderId: FIXED_UUID,
  authToken: FIXED_TOKEN,
});

const closeBulkBase = (): OrderParamsWithFilling => ({
  action: ACTION_CLOSE_BULK,
  accountLogin: 1001,
  symbol: 'EURUSD',
  orderSubType: 0,
  clientOrderId: FIXED_UUID,
  authToken: FIXED_TOKEN,
});

const closeByBase = (): OrderParamsWithFilling => ({
  action: ACTION_CLOSE_BY,
  accountLogin: 1001,
  ticket: 90001,
  otherTicket: 90002,
  symbol: 'EURUSD',
  clientOrderId: FIXED_UUID,
  authToken: FIXED_TOKEN,
});

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function extractExtrasSlice(
  frame: Uint8Array,
  kind: 'http' | 'wsA' | 'wsB',
  tokenByteLen = FIXED_TOKEN_LEN,
): { flags: number; hasExtras: boolean; extrasBlock: Uint8Array | null; extrasLen: number } {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const flagsOffset = kind === 'http' ? 4 : 8;
  const flags = view.getUint16(flagsOffset, true);
  const hasExtras = (flags & FLAG_HAS_EXTRAS) !== 0;

  const extrasOffset =
    kind === 'http'
      ? HEADER_SIZE + 2 + tokenByteLen
      : kind === 'wsA'
        ? WS_REQ_ID_LEN + HEADER_SIZE
        : WS_REQ_ID_LEN + HEADER_SIZE + 2 + tokenByteLen;

  if (frame.byteLength <= extrasOffset) {
    return { flags, hasExtras, extrasBlock: null, extrasLen: 0 };
  }

  const extrasBlock = frame.subarray(extrasOffset);
  const extrasLen = view.getUint16(extrasOffset, true);
  return { flags, hasExtras, extrasBlock, extrasLen };
}

function parseTlvEntries(
  extrasBlock: Uint8Array,
): Array<{ tag: number; len: number; value: Uint8Array; raw: Uint8Array }> {
  expect(extrasBlock.byteLength).toBeGreaterThanOrEqual(2);
  const view = new DataView(extrasBlock.buffer, extrasBlock.byteOffset, extrasBlock.byteLength);
  const declaredLen = view.getUint16(0, true);
  expect(declaredLen).toBe(extrasBlock.byteLength - 2);
  expect(declaredLen).toBeLessThanOrEqual(EXTRAS_MAX_BYTES);

  const entries: Array<{ tag: number; len: number; value: Uint8Array; raw: Uint8Array }> = [];
  let pos = 2;
  while (pos < extrasBlock.byteLength) {
    expect(pos + 2).toBeLessThanOrEqual(extrasBlock.byteLength);
    const tag = extrasBlock[pos];
    const len = extrasBlock[pos + 1];
    expect(pos + 2 + len).toBeLessThanOrEqual(extrasBlock.byteLength);
    entries.push({
      tag,
      len,
      value: extrasBlock.subarray(pos + 2, pos + 2 + len),
      raw: extrasBlock.subarray(pos, pos + 2 + len),
    });
    pos += 2 + len;
  }
  expect(pos).toBe(extrasBlock.byteLength);
  return entries;
}

async function loadOrderClient() {
  vi.resetModules();
  return import('./binaryTcpOrderClient');
}

function loadOrderClientWithRawMetaEnv(
  metaEnv: Record<string, unknown> | undefined,
): Awaited<ReturnType<typeof loadOrderClient>> {
  const src = readFileSync(ORDER_CLIENT_SRC_PATH, 'utf8');
  const patched = src.replace(/\bimport\.meta\.env\b/g, '__testMetaEnv');
  const transpiled = ts.transpileModule(patched, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;

  const moduleObj = { exports: {} as Record<string, unknown> };
  const mockRequire = (specifier: string) => {
    if (specifier === '../config/backendTarget.js') {
      return { isDesktopBackendTarget: () => false };
    }
    if (specifier === './brokerSession') {
      return { getAccessToken: () => FIXED_TOKEN, onSessionChange: () => () => {} };
    }
    if (specifier === './dealing/dealingRuntimeHooks') {
      return dealingHooks;
    }
    if (specifier === './dealing/binaryDealingCodec') {
      return dealingCodec;
    }
    throw new Error(`Unexpected require in raw-env test loader: ${specifier}`);
  };

  const fn = new Function('exports', 'require', 'module', '__testMetaEnv', transpiled);
  fn(moduleObj.exports, mockRequire, moduleObj, metaEnv);
  return moduleObj.exports as unknown as Awaited<ReturnType<typeof loadOrderClient>>;
}

async function loadOrderClientWithDealing() {
  vi.resetModules();
  const [client, hooks, dealingClient] = await Promise.all([
    import('./binaryTcpOrderClient'),
    import('./dealing/dealingRuntimeHooks'),
    import('./dealing/dealingOrderClient'),
  ]);
  return { client, hooks, dealingClient };
}

function encodeAllFrames(
  client: Awaited<ReturnType<typeof loadOrderClient>>,
  params: OrderParamsWithFilling,
) {
  const p = params as BinaryTcpOrderParams;
  return {
    http: client.encodeBinaryOrderReq(p).packet,
    wsA: client.encodeBinaryOrderWsModeAFrame(FIXED_REQ_ID, p),
    wsB: client.encodeBinaryOrderWsModeBFrame(FIXED_REQ_ID, p),
  };
}

function expectInvalidFillingError(
  fn: () => unknown,
  ErrorCtor: Awaited<ReturnType<typeof loadOrderClient>>['BinaryTcpOrderError'],
): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ErrorCtor);
  const typed = caught as InstanceType<typeof ErrorCtor>;
  expect(typed.code).toBe('INVALID_FILLING');
  expect(typed.status).toBe(400);
  expect(typed.retryable).toBe(false);
}

function buildOkRespBytes(action: number, clientOrderId = FIXED_UUID): Uint8Array {
  const buf = new ArrayBuffer(RESP_SIZE);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes[0] = 1;
  bytes[1] = action;
  view.setUint16(2, 200, true);
  view.setUint32(4, 150, true);
  view.setBigInt64(8, 5001n, true);
  view.setBigInt64(16, 7001n, true);
  view.setBigInt64(24, 9001n, true);
  view.setFloat64(32, 1.0845, true);
  view.setFloat64(40, 0.1, true);
  const coidBytes = new TextEncoder().encode(clientOrderId);
  bytes.set(coidBytes.subarray(0, 40), 96);
  return bytes;
}

function wrapWsResp(reqId: number, respBytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(WS_REQ_ID_LEN + respBytes.byteLength);
  new DataView(buf).setUint32(0, reqId >>> 0, true);
  new Uint8Array(buf, WS_REQ_ID_LEN).set(respBytes);
  return buf;
}

describe('P07-3 R2 (M1): constants pin and zero dealing-codec import in binaryTcpOrderClient.ts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('pins BINARY_ORDER_EXTRA_TAG_FILLING and BINARY_ORDER_FILLING_MAX equal to binaryDealingCodec constants', async () => {
    const client = await loadOrderClient();
    expect(client.BINARY_ORDER_EXTRA_TAG_FILLING).toBe(WIRE_EXTRA_TAG_FILLING);
    expect(client.BINARY_ORDER_EXTRA_TAG_FILLING).toBe(0x07);
    expect(client.BINARY_ORDER_FILLING_MAX).toBe(WIRE_ORDER_FILLING_MAX);
    expect(client.BINARY_ORDER_FILLING_MAX).toBe(2);
  });

  it('binaryTcpOrderClient.ts source has no import or require from binaryDealingCodec', () => {
    const src = readFileSync(ORDER_CLIENT_SRC_PATH, 'utf8');
    expect(src).not.toMatch(/\b(?:from|import|require)\s*(?:\(\s*)?['"][^'"]*binaryDealingCodec[^'"]*['"]/);
  });
});

describe('P07-3 R2 (L4a, L4b): flag ON invalid filling errors and -0 handling', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv(FILL_FLAG_ENV, 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    delete (globalThis as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__;
  });

  it.each([
    ['3', 3],
    ['-1', -1],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ["'1'", '1'],
    ['true', true],
  ])(
    'refuses invalid filling %s with BinaryTcpOrderError(code=INVALID_FILLING, status=400) across all encoders',
    async (_label, badFilling) => {
      const client = await loadOrderClient();

      for (const base of [marketBareBase(), pendingBareBase()]) {
        const params = { ...base, filling: badFilling } as BinaryTcpOrderParams;
        expectInvalidFillingError(() => client.encodeBinaryOrderReq(params), client.BinaryTcpOrderError);
        expectInvalidFillingError(
          () => client.encodeBinaryOrderWsModeAFrame(FIXED_REQ_ID, params),
          client.BinaryTcpOrderError,
        );
        expectInvalidFillingError(
          () => client.encodeBinaryOrderWsModeBFrame(FIXED_REQ_ID, params),
          client.BinaryTcpOrderError,
        );
      }

      expectInvalidFillingError(
        () => client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, badFilling as number),
        client.BinaryTcpOrderError,
      );
    },
  );

  it('sendBinaryTcpOrder rejects invalid filling (3, -1, 1.5, NaN, Infinity, "1", true) with BinaryTcpOrderError(INVALID_FILLING, 400) and sends no frame', async () => {
    const client = await loadOrderClient();
    client.__resetBinaryOrderWsForTests();

    const wsSendSpy = vi.fn();
    class SpyWebSocket {
      static readonly OPEN = 1;
      readyState = 1;
      binaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      send = wsSendSpy;
      close = vi.fn();
      constructor(public url: string) {}
    }
    const fetchSpy = vi.fn(async () => {
      throw new Error('unexpected fetch call');
    });
    globalThis.WebSocket = SpyWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    (globalThis as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = {
      BINARY_ORDER_URL: 'http://127.0.0.1:18404/__rtx5_binary_order',
      BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
    };

    for (const badFilling of [3, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', true]) {
      let caught: unknown;
      try {
        await client.sendBinaryTcpOrder({
          ...marketBareBase(),
          filling: badFilling,
          timeoutMs: 50,
        } as BinaryTcpOrderParams);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(client.BinaryTcpOrderError);
      const typed = caught as InstanceType<typeof client.BinaryTcpOrderError>;
      expect(typed.code).toBe('INVALID_FILLING');
      expect(typed.status).toBe(400);
      expect(typed.retryable).toBe(false);
    }

    expect(wsSendSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    client.__resetBinaryOrderWsForTests();
  });

  it('accepts -0 as 0 and encodes exact 0x07 0x01 0x00 TLV matching filling=0', async () => {
    const client = await loadOrderClient();

    for (const base of [marketBareBase(), pendingBareBase()]) {
      const zeroFrames = encodeAllFrames(client, { ...base, filling: 0 });
      const negZeroFrames = encodeAllFrames(client, { ...base, filling: -0 });

      for (const kind of ['http', 'wsA', 'wsB'] as const) {
        expect(Array.from(negZeroFrames[kind])).toEqual(Array.from(zeroFrames[kind]));
        const parsed = extractExtrasSlice(negZeroFrames[kind], kind);
        expect(parsed.hasExtras).toBe(true);
        expect(parsed.extrasLen).toBe(3);
        expect(Array.from(parsed.extrasBlock!)).toEqual([3, 0, WIRE_EXTRA_TAG_FILLING, 1, 0]);
        const decoded = decodeReqExtrasBlock(parsed.extrasBlock!);
        expect(decoded.extras.hasFilling).toBe(true);
        expect(Object.is(decoded.extras.filling, 0)).toBe(true);
      }
    }

    const directNegZero = client.encodeBinaryOrderExtrasTlv(
      undefined,
      undefined,
      FIXED_UUID,
      ACTION_PLACE_MARKET,
      undefined,
      undefined,
      -0,
    );
    expect(Array.from(directNegZero)).toEqual([WIRE_EXTRA_TAG_FILLING, 1, 0]);
    expect(Object.is(directNegZero[2], 0)).toBe(true);
  });
});

describe('P07-3 R2 (L4c, L4d): flag OFF ignores invalid values and matches BASELINE goldens for all non-deal actions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('flag OFF ignores invalid filling values (3, NaN, "x") and matches BASELINE golden frames', async () => {
    for (const envValue of [undefined, 'false'] as const) {
      if (envValue === undefined) {
        vi.unstubAllEnvs();
      } else {
        vi.stubEnv(FILL_FLAG_ENV, envValue);
      }
      const client = await loadOrderClient();

      const cases: Array<{ key: keyof typeof BASELINE_GOLDEN_FRAMES; base: OrderParamsWithFilling }> = [
        { key: 'marketBare', base: marketBareBase() },
        { key: 'marketExtras', base: marketExtrasBase() },
        { key: 'pendingBare', base: pendingBareBase() },
        { key: 'modifyPositionBare', base: modifyPositionBareBase() },
      ];

      for (const badFilling of [3, Number.NaN, 'x']) {
        for (const tc of cases) {
          const frames = encodeAllFrames(client, { ...tc.base, filling: badFilling });
          expect(toHex(frames.http)).toBe(BASELINE_GOLDEN_FRAMES[tc.key].http);
          expect(toHex(frames.wsA)).toBe(BASELINE_GOLDEN_FRAMES[tc.key].wsA);
          expect(toHex(frames.wsB)).toBe(BASELINE_GOLDEN_FRAMES[tc.key].wsB);
          for (const kind of ['http', 'wsA', 'wsB'] as const) {
            const parsed = extractExtrasSlice(frames[kind], kind);
            if (parsed.extrasBlock) {
              const tlvs = parseTlvEntries(parsed.extrasBlock);
              expect(tlvs.some((t) => t.tag === WIRE_EXTRA_TAG_FILLING)).toBe(false);
            }
          }
        }
      }
    }
  });

  it('flag OFF matches BASELINE golden frames for modify position, modify pending, cancel, close bulk, and close-by', async () => {
    const cases: Array<{
      key: keyof typeof BASELINE_GOLDEN_FRAMES;
      base: OrderParamsWithFilling;
      expectExtras: boolean;
    }> = [
      { key: 'modifyPositionBare', base: modifyPositionBareBase(), expectExtras: false },
      { key: 'modifyPositionExtras', base: modifyPositionExtrasBase(), expectExtras: true },
      { key: 'modifyPendingBare', base: modifyPendingBareBase(), expectExtras: false },
      { key: 'modifyPendingExtras', base: modifyPendingExtrasBase(), expectExtras: true },
      { key: 'cancelPending', base: cancelPendingBase(), expectExtras: false },
      { key: 'closeBulk', base: closeBulkBase(), expectExtras: false },
      { key: 'closeBy', base: closeByBase(), expectExtras: false },
    ];

    for (const envValue of [undefined, 'false'] as const) {
      if (envValue === undefined) {
        vi.unstubAllEnvs();
      } else {
        vi.stubEnv(FILL_FLAG_ENV, envValue);
      }
      const client = await loadOrderClient();

      for (const tc of cases) {
        for (const filling of [undefined, 0, 1, 2] as const) {
          const frames = encodeAllFrames(client, { ...tc.base, filling });
          expect(toHex(frames.http)).toBe(BASELINE_GOLDEN_FRAMES[tc.key].http);
          expect(toHex(frames.wsA)).toBe(BASELINE_GOLDEN_FRAMES[tc.key].wsA);
          expect(toHex(frames.wsB)).toBe(BASELINE_GOLDEN_FRAMES[tc.key].wsB);

          for (const kind of ['http', 'wsA', 'wsB'] as const) {
            const parsed = extractExtrasSlice(frames[kind], kind);
            expect(parsed.hasExtras).toBe(tc.expectExtras);
            if (tc.expectExtras) {
              const tlvs = parseTlvEntries(parsed.extrasBlock!);
              expect(tlvs.some((t) => t.tag === WIRE_EXTRA_TAG_FILLING)).toBe(false);
            } else {
              expect(parsed.extrasBlock).toBeNull();
            }
          }
        }
      }
    }
  });
});

describe('P07-3 R2 (L1): flag ON attaches 0x07 ONLY to PLACE_MARKET and PLACE_PENDING, never non-deal actions', () => {
  beforeEach(() => {
    vi.stubEnv(FILL_FLAG_ENV, 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('non-deal actions (modify position, modify pending, cancel, close, close bulk, close-by) carry NO 0x07 even with flag ON and filling set', async () => {
    const client = await loadOrderClient();

    const nonDealCases: Array<{
      key: keyof typeof BASELINE_GOLDEN_FRAMES;
      base: OrderParamsWithFilling;
      expectExtras: boolean;
    }> = [
      { key: 'modifyPositionBare', base: modifyPositionBareBase(), expectExtras: false },
      { key: 'modifyPositionExtras', base: modifyPositionExtrasBase(), expectExtras: true },
      { key: 'modifyPendingBare', base: modifyPendingBareBase(), expectExtras: false },
      { key: 'modifyPendingExtras', base: modifyPendingExtrasBase(), expectExtras: true },
      { key: 'cancelPending', base: cancelPendingBase(), expectExtras: false },
      { key: 'closePartial', base: closePartialBase(), expectExtras: false },
      { key: 'closeFull', base: closeFullBase(), expectExtras: false },
      { key: 'closeBulk', base: closeBulkBase(), expectExtras: false },
      { key: 'closeBy', base: closeByBase(), expectExtras: false },
    ];

    for (const tc of nonDealCases) {
      for (const filling of [0, 1, 2] as const) {
        const frames = encodeAllFrames(client, { ...tc.base, filling });
        expect(toHex(frames.http)).toBe(BASELINE_GOLDEN_FRAMES[tc.key].http);
        expect(toHex(frames.wsA)).toBe(BASELINE_GOLDEN_FRAMES[tc.key].wsA);
        expect(toHex(frames.wsB)).toBe(BASELINE_GOLDEN_FRAMES[tc.key].wsB);

        for (const kind of ['http', 'wsA', 'wsB'] as const) {
          const parsed = extractExtrasSlice(frames[kind], kind);
          expect(parsed.hasExtras).toBe(tc.expectExtras);
          if (tc.expectExtras) {
            const tlvs = parseTlvEntries(parsed.extrasBlock!);
            expect(tlvs.some((t) => t.tag === WIRE_EXTRA_TAG_FILLING)).toBe(false);
          } else {
            expect(parsed.extrasBlock).toBeNull();
          }
        }
      }
    }
  });
});

describe('P07-3 R2 (L2, L4e): shared-buffer safety on encodeBinaryOrderExtrasTlv and order frames', () => {
  beforeEach(() => {
    vi.stubEnv(FILL_FLAG_ENV, 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('encodeBinaryOrderExtrasTlv preserves earlier and later values across filling 1, 2, 1, and combo', async () => {
    const client = await loadOrderClient();

    const e1 = client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 1);
    const e2 = client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 2);
    const e3 = client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 1);
    const eCombo = client.encodeBinaryOrderExtrasTlv('buf-test', 123n, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 1);
    const e0 = client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 0);

    expect(Array.from(e1)).toEqual([WIRE_EXTRA_TAG_FILLING, 1, 1]);
    expect(Array.from(e2)).toEqual([WIRE_EXTRA_TAG_FILLING, 1, 2]);
    expect(Array.from(e3)).toEqual([WIRE_EXTRA_TAG_FILLING, 1, 1]);
    expect(Array.from(e0)).toEqual([WIRE_EXTRA_TAG_FILLING, 1, 0]);

    const comboBlock = new Uint8Array(2 + eCombo.byteLength);
    new DataView(comboBlock.buffer).setUint16(0, eCombo.byteLength, true);
    comboBlock.set(eCombo, 2);
    const decodedCombo = decodeReqExtrasBlock(comboBlock);
    expect(decodedCombo.extras.comment).toBe('buf-test');
    expect(decodedCombo.extras.magic).toBe(123);
    expect(decodedCombo.extras.hasFilling).toBe(true);
    expect(decodedCombo.extras.filling).toBe(1);
  });

  it('mutating an array returned by encodeBinaryOrderExtrasTlv does not corrupt earlier results or later frames (L2)', async () => {
    const client = await loadOrderClient();

    const e1 = client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 1);
    const e2 = client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 2);
    const e3 = client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 1);
    const e0 = client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 0);

    expect(e3).not.toBe(e1);

    // Mutate returned arrays in place; previously returned slices and subsequent encodes must stay intact.
    e1.fill(0xff);
    e2.fill(0xee);
    e0.fill(0xdd);

    expect(Array.from(e3)).toEqual([WIRE_EXTRA_TAG_FILLING, 1, 1]);
    expect(
      Array.from(client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 0)),
    ).toEqual([WIRE_EXTRA_TAG_FILLING, 1, 0]);
    expect(
      Array.from(client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 1)),
    ).toEqual([WIRE_EXTRA_TAG_FILLING, 1, 1]);
    expect(
      Array.from(client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 2)),
    ).toEqual([WIRE_EXTRA_TAG_FILLING, 1, 2]);

    for (const filling of [0, 1, 2] as const) {
      const frames = encodeAllFrames(client, { ...marketBareBase(), filling });
      for (const kind of ['http', 'wsA', 'wsB'] as const) {
        const parsed = extractExtrasSlice(frames[kind], kind);
        expect(Array.from(parsed.extrasBlock!)).toEqual([3, 0, WIRE_EXTRA_TAG_FILLING, 1, filling]);
      }
    }
  });

  it('sequential frame encoding (filling 1, 2, 1, combo, and caps append) preserves earlier and later frames under mutation', async () => {
    const client = await loadOrderClient();

    const f1 = encodeAllFrames(client, { ...marketBareBase(), filling: 1 });
    const f2 = encodeAllFrames(client, { ...marketBareBase(), filling: 2 });
    const f3 = encodeAllFrames(client, { ...marketBareBase(), filling: 1 });
    const fCombo = encodeAllFrames(client, { ...marketExtrasBase(), filling: 1 });
    const withCaps = appendClientCapsToExtrasTlv(
      client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_MARKET, undefined, undefined, 1),
      CLIENT_CAP_DEALING_V1,
    );

    expect(Array.from(withCaps)).toEqual([WIRE_EXTRA_TAG_FILLING, 1, 1, WIRE_EXTRA_TAG_CLIENT_CAPS, 4, 1, 0, 0, 0]);

    f1.http.fill(0xaa);
    f1.wsA.fill(0xbb);
    f1.wsB.fill(0xcc);

    expect(Array.from(extractExtrasSlice(f2.wsA, 'wsA').extrasBlock!)).toEqual([3, 0, WIRE_EXTRA_TAG_FILLING, 1, 2]);
    expect(Array.from(extractExtrasSlice(f3.wsA, 'wsA').extrasBlock!)).toEqual([3, 0, WIRE_EXTRA_TAG_FILLING, 1, 1]);
    const comboDecoded = decodeReqExtrasBlock(extractExtrasSlice(fCombo.http, 'http').extrasBlock!);
    expect(comboDecoded.extras.comment).toBe('p07-ref');
    expect(comboDecoded.extras.filling).toBe(1);

    const fresh1 = encodeAllFrames(client, { ...marketBareBase(), filling: 1 });
    expect(Array.from(fresh1.http)).toEqual(Array.from(f3.http));
    expect(Array.from(fresh1.wsA)).toEqual(Array.from(f3.wsA));
    expect(Array.from(fresh1.wsB)).toEqual(Array.from(f3.wsB));
  });
});

describe('P07-3 R2 (L4f): flag ON with dealing client-caps TLV 0x16 present', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv(FILL_FLAG_ENV, 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    delete (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__;
    delete (window as unknown as Record<string, unknown>).rtx5Electron;
    vi.restoreAllMocks();
  });

  function setupDealingMockWs(sentFrames: Uint8Array[]) {
    class MockOrderWs {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState = MockOrderWs.OPEN;
      binaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(public url: string) {}

      send = vi.fn((raw: Uint8Array | ArrayBuffer) => {
        const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const copy = src.slice();
        sentFrames.push(copy);
        const reqId = new DataView(copy.buffer, copy.byteOffset, copy.byteLength).getUint32(0, true);
        if (reqId === 0) return;
        const action = copy[5];
        this.onmessage?.({ data: wrapWsResp(reqId, buildOkRespBytes(action)) });
      });

      close = vi.fn(() => {
        this.readyState = MockOrderWs.CLOSED;
      });
    }
    return MockOrderWs;
  }

  function enableDealingRuntime(hooks: Awaited<ReturnType<typeof loadOrderClientWithDealing>>['hooks']) {
    (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'web-tcp' };
    (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = {
      BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
      DEALING_BRIDGE_V1: true,
    };
    hooks.__setDealingTransportSupportedForTests(true);
    hooks.setDealingServerAdvertised(true);
  }

  it('appends both 0x07 and 0x16 over pre-bound WS and skips the 140-byte dealing fast path when filling is set', async () => {
    const { client, hooks, dealingClient } = await loadOrderClientWithDealing();
    const unreg = dealingClient.installDealingOrderClientHooks();
    const sentFrames: Uint8Array[] = [];
    globalThis.WebSocket = setupDealingMockWs(sentFrames) as unknown as typeof WebSocket;

    try {
      client.__resetBinaryOrderWsForTests();
      enableDealingRuntime(hooks);
      client.ensureBinaryOrderWebSocket();
      client.syncBinaryOrderAuthToken(FIXED_TOKEN);

      // Control: no filling -> uses 140-byte fast path with only 0x16.
      sentFrames.length = 0;
      await client.sendBinaryTcpOrder(marketBareBase() as BinaryTcpOrderParams);
      const controlFrame = sentFrames.find((f) => new DataView(f.buffer, f.byteOffset, 4).getUint32(0, true) !== 0)!;
      expect(controlFrame.byteLength).toBe(dealingClient.WS_FAST_ORDER_WITH_DEALING_CAPS_SIZE);
      expect(controlFrame.byteLength).toBe(140);

      const fastPathSpy = vi.spyOn(hooks.dealingOrderHooks, 'tryPrepareFastWsModeAWithCaps');

      for (const filling of [0, 1, 2] as const) {
        sentFrames.length = 0;
        fastPathSpy.mockClear();

        await client.sendBinaryTcpOrder({ ...marketBareBase(), filling } as BinaryTcpOrderParams);

        const orderFrame = sentFrames.find((f) => new DataView(f.buffer, f.byteOffset, 4).getUint32(0, true) !== 0)!;
        expect(fastPathSpy).toHaveBeenCalledTimes(1);
        expect(fastPathSpy.mock.results[0]?.value).toBeNull();
        expect(orderFrame.byteLength).toBe(WS_FAST_SIZE + 2 + 3 + 6); // 143 bytes, not 140

        const parsed = extractExtrasSlice(orderFrame, 'wsA');
        expect(parsed.hasExtras).toBe(true);
        expect(parsed.extrasLen).toBe(9);
        const tlvs = parseTlvEntries(parsed.extrasBlock!);
        expect(tlvs.map((t) => t.tag)).toEqual([WIRE_EXTRA_TAG_FILLING, WIRE_EXTRA_TAG_CLIENT_CAPS]);
        expect(Array.from(tlvs[0].raw)).toEqual([WIRE_EXTRA_TAG_FILLING, 1, filling]);
        expect(Array.from(tlvs[1].raw)).toEqual([WIRE_EXTRA_TAG_CLIENT_CAPS, 4, 1, 0, 0, 0]);

        const decoded = decodeReqExtrasBlock(parsed.extrasBlock!);
        expect(decoded.extras.hasFilling).toBe(true);
        expect(decoded.extras.filling).toBe(filling);
        expect(decoded.extras.hasDealingCap).toBe(true);
        expect(decoded.extras.clientCaps).toBe(CLIENT_CAP_DEALING_V1);
      }

      // Also check PLACE_PENDING with filling + 0x16.
      sentFrames.length = 0;
      fastPathSpy.mockClear();
      await client.sendBinaryTcpOrder({ ...pendingBareBase(), filling: 1 } as BinaryTcpOrderParams);
      const pendFrame = sentFrames.find((f) => new DataView(f.buffer, f.byteOffset, 4).getUint32(0, true) !== 0)!;
      expect(fastPathSpy.mock.results[0]?.value).toBeNull();
      expect(pendFrame.byteLength).toBe(143);
      const pendDecoded = decodeReqExtrasBlock(extractExtrasSlice(pendFrame, 'wsA').extrasBlock!);
      expect(pendDecoded.extras.hasFilling).toBe(true);
      expect(pendDecoded.extras.filling).toBe(1);
      expect(pendDecoded.extras.hasDealingCap).toBe(true);
    } finally {
      unreg();
      hooks.resetDealingCapabilityState();
      client.__resetBinaryOrderWsForTests();
    }
  });

  it('appends both 0x07 and 0x16 over HTTP fallback when WS is closed and dealing gate is open', async () => {
    const { client, hooks, dealingClient } = await loadOrderClientWithDealing();
    const unreg = dealingClient.installDealingOrderClientHooks();
    globalThis.WebSocket = class ClosedWs {
      readyState = 3;
      binaryType = 'arraybuffer';
      onopen: (() => void) | null = null;
      onmessage: ((ev: unknown) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();
    } as unknown as typeof WebSocket;

    let capturedBody!: Uint8Array;
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = new Uint8Array(init?.body as ArrayBuffer).slice();
      return new Response(buildOkRespBytes(ACTION_PLACE_MARKET).slice().buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }) as unknown as typeof fetch;

    try {
      client.__resetBinaryOrderWsForTests();
      enableDealingRuntime(hooks);
      await client.sendBinaryTcpOrder({ ...marketBareBase(), filling: 2 } as BinaryTcpOrderParams);

      const parsed = extractExtrasSlice(capturedBody, 'http');
      expect(parsed.hasExtras).toBe(true);
      expect(parsed.extrasLen).toBe(9);
      const decoded = decodeReqExtrasBlock(parsed.extrasBlock!);
      expect(decoded.extras.hasFilling).toBe(true);
      expect(decoded.extras.filling).toBe(2);
      expect(decoded.extras.hasDealingCap).toBe(true);
      expect(decoded.extras.clientCaps).toBe(CLIENT_CAP_DEALING_V1);
    } finally {
      unreg();
      hooks.resetDealingCapabilityState();
      client.__resetBinaryOrderWsForTests();
    }
  });

  it('non-deal actions with filling set and dealing gate open carry ONLY 0x16 and still use the 140-byte fast path (L1 + dealing)', async () => {
    const { client, hooks, dealingClient } = await loadOrderClientWithDealing();
    const unreg = dealingClient.installDealingOrderClientHooks();
    const sentFrames: Uint8Array[] = [];
    globalThis.WebSocket = setupDealingMockWs(sentFrames) as unknown as typeof WebSocket;

    try {
      client.__resetBinaryOrderWsForTests();
      enableDealingRuntime(hooks);
      client.ensureBinaryOrderWebSocket();
      client.syncBinaryOrderAuthToken(FIXED_TOKEN);

      for (const params of [
        { ...modifyPositionBareBase(), filling: 1 },
        { ...closeFullBase(), filling: 2 },
      ]) {
        sentFrames.length = 0;
        await client.sendBinaryTcpOrder(params as BinaryTcpOrderParams);
        const orderFrame = sentFrames.find((f) => new DataView(f.buffer, f.byteOffset, 4).getUint32(0, true) !== 0)!;
        expect(orderFrame.byteLength).toBe(140);
        const parsed = extractExtrasSlice(orderFrame, 'wsA');
        expect(parsed.extrasLen).toBe(6);
        const tlvs = parseTlvEntries(parsed.extrasBlock!);
        expect(tlvs.map((t) => t.tag)).toEqual([WIRE_EXTRA_TAG_CLIENT_CAPS]);
      }
    } finally {
      unreg();
      hooks.resetDealingCapabilityState();
      client.__resetBinaryOrderWsForTests();
    }
  });
});

describe('P07-3 R2 (L3, L4g): flag parsing and direct import.meta.env?. access', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['true', '1', ' TRUE ', ' true ', '1 '])(
    'parses string env value %j as ON',
    async (envVal) => {
      vi.stubEnv(FILL_FLAG_ENV, envVal);
      const client = await loadOrderClient();
      const frames = encodeAllFrames(client, { ...marketBareBase(), filling: 1 });
      for (const kind of ['http', 'wsA', 'wsB'] as const) {
        const parsed = extractExtrasSlice(frames[kind], kind);
        expect(parsed.hasExtras).toBe(true);
        expect(Array.from(parsed.extrasBlock!)).toEqual([3, 0, WIRE_EXTRA_TAG_FILLING, 1, 1]);
      }
    },
  );

  it('parses boolean true as ON, boolean false as OFF, and undefined import.meta.env as OFF', () => {
    const envTrue: Record<string, unknown> = { MODE: 'test', [FILL_FLAG_ENV]: true };
    expect(typeof envTrue[FILL_FLAG_ENV]).toBe('boolean');
    const clientOn = loadOrderClientWithRawMetaEnv(envTrue);
    const onFrames = encodeAllFrames(clientOn, { ...marketBareBase(), filling: 2 });
    for (const kind of ['http', 'wsA', 'wsB'] as const) {
      const parsed = extractExtrasSlice(onFrames[kind], kind);
      expect(parsed.hasExtras).toBe(true);
      expect(Array.from(parsed.extrasBlock!)).toEqual([3, 0, WIRE_EXTRA_TAG_FILLING, 1, 2]);
    }

    const envFalse: Record<string, unknown> = { MODE: 'test', [FILL_FLAG_ENV]: false };
    expect(typeof envFalse[FILL_FLAG_ENV]).toBe('boolean');
    const clientOff = loadOrderClientWithRawMetaEnv(envFalse);
    const offFrames = encodeAllFrames(clientOff, { ...marketBareBase(), filling: 2 });
    expect(toHex(offFrames.http)).toBe(BASELINE_GOLDEN_FRAMES.marketBare.http);
    expect(toHex(offFrames.wsA)).toBe(BASELINE_GOLDEN_FRAMES.marketBare.wsA);
    expect(toHex(offFrames.wsB)).toBe(BASELINE_GOLDEN_FRAMES.marketBare.wsB);

    const clientUndefinedEnv = loadOrderClientWithRawMetaEnv(undefined);
    const undefFrames = encodeAllFrames(clientUndefinedEnv, { ...marketBareBase(), filling: 2 });
    expect(toHex(undefFrames.http)).toBe(BASELINE_GOLDEN_FRAMES.marketBare.http);
    expect(toHex(undefFrames.wsA)).toBe(BASELINE_GOLDEN_FRAMES.marketBare.wsA);
    expect(toHex(undefFrames.wsB)).toBe(BASELINE_GOLDEN_FRAMES.marketBare.wsB);
  });

  it.each(['false', '', 'yes', '0', 'on', 'true1'])(
    'parses non-enabled string env value %j as OFF',
    async (envVal) => {
      vi.stubEnv(FILL_FLAG_ENV, envVal);
      const client = await loadOrderClient();
      const frames = encodeAllFrames(client, { ...marketBareBase(), filling: 1 });
      expect(toHex(frames.http)).toBe(BASELINE_GOLDEN_FRAMES.marketBare.http);
      expect(toHex(frames.wsA)).toBe(BASELINE_GOLDEN_FRAMES.marketBare.wsA);
      expect(toHex(frames.wsB)).toBe(BASELINE_GOLDEN_FRAMES.marketBare.wsB);
    },
  );

  it('binaryTcpOrderClient.ts reads import.meta.env?.VITE_BINARY_ORDER_FILLING_TLV_ENABLED directly without whole-object import.meta.env || {}', () => {
    const src = readFileSync(ORDER_CLIENT_SRC_PATH, 'utf8');
    expect(src).toMatch(/import\.meta\.env\?\.VITE_BINARY_ORDER_FILLING_TLV_ENABLED/);
    expect(src).not.toMatch(/import\.meta\.env\s*\|\|\s*\{\s*\}/);
  });
});
