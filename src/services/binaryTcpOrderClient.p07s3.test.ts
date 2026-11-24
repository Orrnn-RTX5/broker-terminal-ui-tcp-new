// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderPanelDialog } from '../components/OrderPanelDialog';
import { useAppStore } from '../store/useAppStore';
import {
  BINARY_ORDER_ACTION_CLOSE_POSITION,
  BINARY_ORDER_ACTION_PLACE_MARKET,
  BINARY_ORDER_ACTION_PLACE_PENDING,
  BINARY_ORDER_EXTRAS_MAX_BYTES,
  BINARY_ORDER_EXTRA_TAG_COMMENT,
  BINARY_ORDER_EXTRA_TAG_MAGIC,
  BINARY_ORDER_EXTRA_TAG_TRAILING_STEP,
  BINARY_ORDER_EXTRA_TAG_TRAILING_STOP,
  BINARY_ORDER_FLAG_HAS_EXTRAS,
  BINARY_ORDER_SUBTYPE_BUY_LIMIT,
  REQ_HEADER_SIZE,
  type BinaryTcpOrderParams,
} from './binaryTcpOrderClient';
import {
  decodeReqExtrasBlock,
  encodeReqExtrasBlock,
  WIRE_EXTRA_TAG_FILLING,
  WIRE_ORDER_FILLING_MAX,
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

vi.mock('../hooks/useSymbolMarketStatus', () => ({
  useSymbolMarketStatus: () => ({
    symbol: 'EURUSD',
    status: 'open',
    isOpen: true,
    isTradeBlocked: false,
    label: 'Market Open',
    loading: false,
    error: null,
    refreshedAt: 1,
  }),
}));

vi.mock('../hooks/useLiveMarketData', () => ({
  useLiveOrderBook: () => ({
    bids: [{ price: 1.085, volume: 100 }],
    asks: [{ price: 1.0852, volume: 100 }],
    spread: 0.0002,
    timestamp: Date.now(),
  }),
}));

type OrderParamsWithFilling = BinaryTcpOrderParams & { filling?: number | null };

const FIXED_UUID = '123e4567-e89b-42d3-a456-426614174000';
const FIXED_TOKEN = 'tok-p07s3';
const FIXED_TOKEN_LEN = new TextEncoder().encode(FIXED_TOKEN).byteLength;
const FIXED_REQ_ID = 42;
const FILL_FLAG_ENV = 'VITE_BINARY_ORDER_FILLING_TLV_ENABLED';
const UNSUPPORTED_FILL_REASON =
  'Fill policy is not supported by the execution venue and is not sent';

// Golden frames captured from unmodified origin/main (994efc5 / v1.2.5) with flag OFF.
const GOLDEN_FRAMES = {
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
  pendingExtras: {
    http: '0104010120040000e9030000000000000000000000000000000000000000d03f5c8fc2f5285cf13f00000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333140001087030372d70656e6402086300000000000000',
    wsA: '2a0000000104010120040000e9030000000000000000000000000000000000000000d03f5c8fc2f5285cf13f00000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000140001087030372d70656e6402086300000000000000',
    wsB: '2a0000000104010120040000e9030000000000000000000000000000000000000000d03f5c8fc2f5285cf13f00000000000000000000000000000000000000000000000000000000000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333140001087030372d70656e6402086300000000000000',
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
} as const;

const marketBareBase = (): OrderParamsWithFilling => ({
  action: BINARY_ORDER_ACTION_PLACE_MARKET,
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
  action: BINARY_ORDER_ACTION_PLACE_PENDING,
  accountLogin: 1001,
  symbol: 'EURUSD',
  side: 'BUY',
  orderSubType: BINARY_ORDER_SUBTYPE_BUY_LIMIT,
  volume: 0.25,
  price: 1.085,
  clientOrderId: FIXED_UUID,
  authToken: FIXED_TOKEN,
});

const pendingExtrasBase = (): OrderParamsWithFilling => ({
  ...pendingBareBase(),
  comment: 'p07-pend',
  magic: 99n,
});

const closePartialBase = (): OrderParamsWithFilling => ({
  action: BINARY_ORDER_ACTION_CLOSE_POSITION,
  accountLogin: 1001,
  ticket: 90001,
  volume: 0.1,
  partialClose: true,
  clientOrderId: FIXED_UUID,
  authToken: FIXED_TOKEN,
});

const closeFullBase = (): OrderParamsWithFilling => ({
  action: BINARY_ORDER_ACTION_CLOSE_POSITION,
  accountLogin: 1001,
  ticket: 90001,
  volume: 0,
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
  const hasExtras = (flags & BINARY_ORDER_FLAG_HAS_EXTRAS) !== 0;

  const extrasOffset =
    kind === 'http'
      ? REQ_HEADER_SIZE + 2 + tokenByteLen
      : kind === 'wsA'
        ? 4 + REQ_HEADER_SIZE
        : 4 + REQ_HEADER_SIZE + 2 + tokenByteLen;

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
  expect(declaredLen).toBeLessThanOrEqual(BINARY_ORDER_EXTRAS_MAX_BYTES);

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

function encodeAllFrames(
  client: Awaited<ReturnType<typeof loadOrderClient>>,
  params: OrderParamsWithFilling,
) {
  return {
    http: client.encodeBinaryOrderReq(params).packet,
    wsA: client.encodeBinaryOrderWsModeAFrame(FIXED_REQ_ID, params),
    wsB: client.encodeBinaryOrderWsModeBFrame(FIXED_REQ_ID, params),
  };
}

describe('P07-3 flag OFF (default): byte-identical frames and no 0x07 TLV', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('market bare frames (HTTP, WS Mode A, WS Mode B) are byte-identical to today with flag unset or "false", with or without filling (0, 1, 2)', async () => {
    for (const envValue of [undefined, 'false'] as const) {
      if (envValue === undefined) {
        vi.unstubAllEnvs();
      } else {
        vi.stubEnv(FILL_FLAG_ENV, envValue);
      }
      const client = await loadOrderClient();
      const baseline = encodeAllFrames(client, marketBareBase());
      expect(toHex(baseline.http)).toBe(GOLDEN_FRAMES.marketBare.http);
      expect(toHex(baseline.wsA)).toBe(GOLDEN_FRAMES.marketBare.wsA);
      expect(toHex(baseline.wsB)).toBe(GOLDEN_FRAMES.marketBare.wsB);

      for (const filling of [0, 1, 2] as const) {
        const frames = encodeAllFrames(client, { ...marketBareBase(), filling });
        expect(toHex(frames.http)).toBe(GOLDEN_FRAMES.marketBare.http);
        expect(toHex(frames.wsA)).toBe(GOLDEN_FRAMES.marketBare.wsA);
        expect(toHex(frames.wsB)).toBe(GOLDEN_FRAMES.marketBare.wsB);

        for (const kind of ['http', 'wsA', 'wsB'] as const) {
          const parsed = extractExtrasSlice(frames[kind], kind);
          expect(parsed.hasExtras).toBe(false);
          expect(parsed.extrasBlock).toBeNull();
        }
      }
    }
  });

  it('market frames with existing extras (comment, magic, trailingStop, trailingStep) are byte-identical to today with flag OFF and contain no 0x07 tag', async () => {
    vi.stubEnv(FILL_FLAG_ENV, 'false');
    const client = await loadOrderClient();

    for (const filling of [undefined, 0, 1, 2] as const) {
      const frames = encodeAllFrames(client, { ...marketExtrasBase(), filling });
      expect(toHex(frames.http)).toBe(GOLDEN_FRAMES.marketExtras.http);
      expect(toHex(frames.wsA)).toBe(GOLDEN_FRAMES.marketExtras.wsA);
      expect(toHex(frames.wsB)).toBe(GOLDEN_FRAMES.marketExtras.wsB);

      for (const kind of ['http', 'wsA', 'wsB'] as const) {
        const parsed = extractExtrasSlice(frames[kind], kind);
        expect(parsed.hasExtras).toBe(true);
        expect(parsed.extrasBlock).not.toBeNull();
        const tlvs = parseTlvEntries(parsed.extrasBlock!);
        expect(tlvs.some((t) => t.tag === WIRE_EXTRA_TAG_FILLING)).toBe(false);
      }
    }
  });

  it('pending frames (bare and with existing extras) are byte-identical to today with flag OFF for filling omitted, 0, 1, and 2', async () => {
    vi.unstubAllEnvs();
    const client = await loadOrderClient();

    for (const filling of [undefined, 0, 1, 2] as const) {
      const bare = encodeAllFrames(client, { ...pendingBareBase(), filling });
      expect(toHex(bare.http)).toBe(GOLDEN_FRAMES.pendingBare.http);
      expect(toHex(bare.wsA)).toBe(GOLDEN_FRAMES.pendingBare.wsA);
      expect(toHex(bare.wsB)).toBe(GOLDEN_FRAMES.pendingBare.wsB);
      for (const kind of ['http', 'wsA', 'wsB'] as const) {
        const parsed = extractExtrasSlice(bare[kind], kind);
        expect(parsed.hasExtras).toBe(false);
        expect(parsed.extrasBlock).toBeNull();
      }

      const withExtras = encodeAllFrames(client, { ...pendingExtrasBase(), filling });
      expect(toHex(withExtras.http)).toBe(GOLDEN_FRAMES.pendingExtras.http);
      expect(toHex(withExtras.wsA)).toBe(GOLDEN_FRAMES.pendingExtras.wsA);
      expect(toHex(withExtras.wsB)).toBe(GOLDEN_FRAMES.pendingExtras.wsB);
      for (const kind of ['http', 'wsA', 'wsB'] as const) {
        const parsed = extractExtrasSlice(withExtras[kind], kind);
        expect(parsed.hasExtras).toBe(true);
        const tlvs = parseTlvEntries(parsed.extrasBlock!);
        expect(tlvs.some((t) => t.tag === WIRE_EXTRA_TAG_FILLING)).toBe(false);
      }
    }
  });

  it('close frames (full and partial) are byte-identical to today with flag OFF for filling omitted, 0, 1, and 2', async () => {
    vi.stubEnv(FILL_FLAG_ENV, 'false');
    const client = await loadOrderClient();

    for (const filling of [undefined, 0, 1, 2] as const) {
      const partial = encodeAllFrames(client, { ...closePartialBase(), filling });
      expect(toHex(partial.http)).toBe(GOLDEN_FRAMES.closePartial.http);
      expect(toHex(partial.wsA)).toBe(GOLDEN_FRAMES.closePartial.wsA);
      expect(toHex(partial.wsB)).toBe(GOLDEN_FRAMES.closePartial.wsB);

      const full = encodeAllFrames(client, { ...closeFullBase(), filling });
      expect(toHex(full.http)).toBe(GOLDEN_FRAMES.closeFull.http);
      expect(toHex(full.wsA)).toBe(GOLDEN_FRAMES.closeFull.wsA);
      expect(toHex(full.wsB)).toBe(GOLDEN_FRAMES.closeFull.wsB);

      for (const frames of [partial, full]) {
        for (const kind of ['http', 'wsA', 'wsB'] as const) {
          const parsed = extractExtrasSlice(frames[kind], kind);
          expect(parsed.hasExtras).toBe(false);
          expect(parsed.extrasBlock).toBeNull();
        }
      }
    }
  });
});

describe('P07-3 flag ON: TLV 0x07 encoding for valid filling 0, 1, 2', () => {
  beforeEach(() => {
    vi.stubEnv(FILL_FLAG_ENV, 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('market order with filling 0 (FOK), 1 (IOC), 2 (RETURN) emits exact 3-byte TLV 07 01 <v> matching binaryDealingCodec across HTTP, WS Mode A, and WS Mode B', async () => {
    const client = await loadOrderClient();

    for (const filling of [0, 1, 2] as const) {
      const codecExpected = encodeReqExtrasBlock({ hasFilling: true, filling });
      expect(Array.from(codecExpected)).toEqual([3, 0, WIRE_EXTRA_TAG_FILLING, 1, filling]);

      const frames = encodeAllFrames(client, { ...marketBareBase(), filling });
      for (const kind of ['http', 'wsA', 'wsB'] as const) {
        const parsed = extractExtrasSlice(frames[kind], kind);
        expect(parsed.hasExtras).toBe(true);
        expect(parsed.extrasLen).toBe(3);
        expect(parsed.extrasLen).toBeLessThanOrEqual(BINARY_ORDER_EXTRAS_MAX_BYTES);
        expect(parsed.extrasBlock).not.toBeNull();
        expect(Array.from(parsed.extrasBlock!)).toEqual(Array.from(codecExpected));

        const tlvs = parseTlvEntries(parsed.extrasBlock!);
        const fillingTlvs = tlvs.filter((t) => t.tag === WIRE_EXTRA_TAG_FILLING);
        expect(fillingTlvs).toHaveLength(1);
        expect(Array.from(fillingTlvs[0].raw)).toEqual([0x07, 0x01, filling]);

        const decoded = decodeReqExtrasBlock(parsed.extrasBlock!);
        expect(decoded.extras.hasFilling).toBe(true);
        expect(decoded.extras.filling).toBe(filling);
      }
    }
  });

  it('pending order with filling 0, 1, 2 emits exact 3-byte TLV 07 01 <v> matching binaryDealingCodec across HTTP, WS Mode A, and WS Mode B', async () => {
    const client = await loadOrderClient();

    for (const filling of [0, 1, 2] as const) {
      const codecExpected = encodeReqExtrasBlock({ hasFilling: true, filling });
      const frames = encodeAllFrames(client, { ...pendingBareBase(), filling });

      for (const kind of ['http', 'wsA', 'wsB'] as const) {
        const parsed = extractExtrasSlice(frames[kind], kind);
        expect(parsed.hasExtras).toBe(true);
        expect(parsed.extrasLen).toBe(3);
        expect(parsed.extrasLen).toBeLessThanOrEqual(BINARY_ORDER_EXTRAS_MAX_BYTES);
        expect(Array.from(parsed.extrasBlock!)).toEqual(Array.from(codecExpected));

        const decoded = decodeReqExtrasBlock(parsed.extrasBlock!);
        expect(decoded.extras.hasFilling).toBe(true);
        expect(decoded.extras.filling).toBe(filling);
      }
    }
  });

  it('combines TLV 0x07 with existing TLVs (comment, magic, trailingStop, trailingStep) without corrupting other TLVs and keeps extras <= 512 bytes', async () => {
    const client = await loadOrderClient();

    for (const filling of [0, 1, 2] as const) {
      const codecSingle = encodeReqExtrasBlock({ hasFilling: true, filling }).subarray(2);

      const mktFrames = encodeAllFrames(client, { ...marketExtrasBase(), filling });
      const mktBaseLen = 31; // comment(2+7) + magic(2+8) + trailingStop(2+4) + trailingStep(2+4)
      for (const kind of ['http', 'wsA', 'wsB'] as const) {
        const parsed = extractExtrasSlice(mktFrames[kind], kind);
        expect(parsed.hasExtras).toBe(true);
        expect(parsed.extrasLen).toBe(mktBaseLen + 3);
        expect(parsed.extrasLen).toBeLessThanOrEqual(BINARY_ORDER_EXTRAS_MAX_BYTES);

        const tlvs = parseTlvEntries(parsed.extrasBlock!);
        expect(tlvs.filter((t) => t.tag === WIRE_EXTRA_TAG_FILLING)).toHaveLength(1);
        expect(Array.from(tlvs.find((t) => t.tag === WIRE_EXTRA_TAG_FILLING)!.raw)).toEqual(
          Array.from(codecSingle),
        );
        expect(tlvs.some((t) => t.tag === BINARY_ORDER_EXTRA_TAG_COMMENT)).toBe(true);
        expect(tlvs.some((t) => t.tag === BINARY_ORDER_EXTRA_TAG_MAGIC)).toBe(true);
        expect(tlvs.some((t) => t.tag === BINARY_ORDER_EXTRA_TAG_TRAILING_STOP)).toBe(true);
        expect(tlvs.some((t) => t.tag === BINARY_ORDER_EXTRA_TAG_TRAILING_STEP)).toBe(true);

        const decoded = decodeReqExtrasBlock(parsed.extrasBlock!);
        expect(decoded.extras.comment).toBe('p07-ref');
        expect(decoded.extras.magic).toBe(42);
        expect(decoded.extras.hasTrailingStop).toBe(true);
        expect(decoded.extras.trailingStop).toBe(25);
        expect(decoded.extras.hasTrailingStep).toBe(true);
        expect(decoded.extras.trailingStep).toBe(5);
        expect(decoded.extras.hasFilling).toBe(true);
        expect(decoded.extras.filling).toBe(filling);
      }

      const pendFrames = encodeAllFrames(client, { ...pendingExtrasBase(), filling });
      const pendBaseLen = 20; // comment(2+8) + magic(2+8)
      for (const kind of ['http', 'wsA', 'wsB'] as const) {
        const parsed = extractExtrasSlice(pendFrames[kind], kind);
        expect(parsed.hasExtras).toBe(true);
        expect(parsed.extrasLen).toBe(pendBaseLen + 3);
        expect(parsed.extrasLen).toBeLessThanOrEqual(BINARY_ORDER_EXTRAS_MAX_BYTES);

        const tlvs = parseTlvEntries(parsed.extrasBlock!);
        expect(tlvs.filter((t) => t.tag === WIRE_EXTRA_TAG_FILLING)).toHaveLength(1);
        const decoded = decodeReqExtrasBlock(parsed.extrasBlock!);
        expect(decoded.extras.comment).toBe('p07-pend');
        expect(decoded.extras.magic).toBe(99);
        expect(decoded.extras.hasFilling).toBe(true);
        expect(decoded.extras.filling).toBe(filling);
      }
    }
  });

  it('max-length 64-byte comment + magic + trailing + filling stays within BINARY_ORDER_EXTRAS_MAX_BYTES (512)', async () => {
    const client = await loadOrderClient();
    const maxComment = 'c'.repeat(64);
    const frame = client.encodeBinaryOrderWsModeAFrame(FIXED_REQ_ID, {
      ...marketBareBase(),
      comment: maxComment,
      magic: 777n,
      trailingStop: 50,
      trailingStep: 10,
      filling: WIRE_ORDER_FILLING_MAX,
    } as OrderParamsWithFilling);

    const parsed = extractExtrasSlice(frame, 'wsA');
    expect(parsed.hasExtras).toBe(true);
    expect(parsed.extrasLen).toBe(91); // (2+64) + (2+8) + (2+4) + (2+4) + (2+1)
    expect(parsed.extrasLen).toBeLessThanOrEqual(BINARY_ORDER_EXTRAS_MAX_BYTES);
    const decoded = decodeReqExtrasBlock(parsed.extrasBlock!);
    expect(decoded.extras.comment).toBe(maxComment);
    expect(decoded.extras.hasFilling).toBe(true);
    expect(decoded.extras.filling).toBe(WIRE_ORDER_FILLING_MAX);
  });

  it('omitting filling (undefined or null) with flag ON remains byte-identical to today with no 0x07 TLV', async () => {
    const client = await loadOrderClient();
    for (const filling of [undefined, null] as const) {
      const market = encodeAllFrames(client, { ...marketBareBase(), filling });
      expect(toHex(market.http)).toBe(GOLDEN_FRAMES.marketBare.http);
      expect(toHex(market.wsA)).toBe(GOLDEN_FRAMES.marketBare.wsA);
      expect(toHex(market.wsB)).toBe(GOLDEN_FRAMES.marketBare.wsB);

      const pending = encodeAllFrames(client, { ...pendingBareBase(), filling });
      expect(toHex(pending.http)).toBe(GOLDEN_FRAMES.pendingBare.http);
      expect(toHex(pending.wsA)).toBe(GOLDEN_FRAMES.pendingBare.wsA);
      expect(toHex(pending.wsB)).toBe(GOLDEN_FRAMES.pendingBare.wsB);
    }
  });
});

describe('P07-3 flag ON: invalid filling values (> 2, negative, non-integer) are refused and never sent', () => {
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

  it.each([3, 4, 255, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses invalid filling %s on market and pending frame encoders',
    async (badFilling) => {
      const client = await loadOrderClient();

      for (const base of [marketBareBase(), pendingBareBase()]) {
        const params = { ...base, filling: badFilling };
        expect(() => client.encodeBinaryOrderReq(params)).toThrow();
        expect(() => client.encodeBinaryOrderWsModeAFrame(FIXED_REQ_ID, params)).toThrow();
        expect(() => client.encodeBinaryOrderWsModeBFrame(FIXED_REQ_ID, params)).toThrow();
      }
    },
  );

  it('sendBinaryTcpOrder rejects invalid filling (3, -1, 1.5) when flag is ON and never calls fetch or WebSocket.send', async () => {
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

    for (const badFilling of [3, -1, 1.5] as const) {
      await expect(
        Promise.resolve().then(() =>
          client.sendBinaryTcpOrder({
            ...marketBareBase(),
            filling: badFilling,
            timeoutMs: 50,
          }),
        ),
      ).rejects.toThrow();
    }

    expect(wsSendSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    client.__resetBinaryOrderWsForTests();
  });
});

describe('P07-3 guardrails: endpoints.ts strips fill_policy and OrderPanelDialog keeps fill control disabled (flag OFF and ON)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    delete (window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, unknown> }).__RTX_RUNTIME_CONFIG__;
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('endpoints.ts tradingApi.modifyPendingOrder strips fill_policy with flag OFF and with flag ON', async () => {
    for (const flagValue of ['false', 'true'] as const) {
      vi.stubEnv(FILL_FLAG_ENV, flagValue);
      vi.resetModules();

      const fetchMock = vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      localStorage.clear();
      sessionStorage.clear();
      (window as Window & { __RTX_RUNTIME_CONFIG__?: Record<string, unknown> }).__RTX_RUNTIME_CONFIG__ = {
        BACKEND_TARGET: 'web',
        API_HOST: 'https://test-venue.invalid',
        WS_HOST: 'wss://test-venue.invalid',
        BROKER_ID: 'test-tenant',
        DEFAULT_MT5_SERVER: 'Test-Server',
      };
      localStorage.setItem('server_url', 'https://test-venue.invalid');
      localStorage.setItem('broker_id', 'test-tenant');

      const { updateDynamicUrls } = await import('../config/api');
      const { removeToken, setToken } = await import('../api/client');
      const { tradingApi } = await import('../api/endpoints');

      removeToken();
      updateDynamicUrls();
      setToken('test-access-token');

      await tradingApi.modifyPendingOrder(12345, {
        price: 1.1234,
        sl: 1.12,
        tp: 1.13,
        fill_policy: 'FOK',
      } as Record<string, unknown>);

      const [, init] = fetchMock.mock.calls.at(-1) ?? [];
      const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(sent.price).toBe(1.1234);
      expect(sent).not.toHaveProperty('fill_policy');
    }
  });

  it('OrderPanelDialog keeps Fill policy tabs and select disabled with unsupported-venue reason when flag is OFF and when flag is ON', () => {
    for (const flagValue of ['false', 'true'] as const) {
      vi.stubEnv(FILL_FLAG_ENV, flagValue);
      localStorage.setItem('lastLotSize', '0.01');
      useAppStore.getState().reset();
      useAppStore.getState().setTicks({
        EURUSD: {
          symbol: 'EURUSD',
          bid: 1.085,
          ask: 1.0852,
          spread: 0.0002,
          timestamp: Date.now(),
          digits: 5,
        },
      });

      render(
        createElement(OrderPanelDialog, {
          isOpen: true,
          onClose: vi.fn(),
          symbol: 'EURUSD',
          currentPrice: { bid: 1.085, ask: 1.0852 },
          onSubmitOrder: vi.fn(),
          symbols: ['EURUSD'],
        }),
      );

      expect(screen.getByText(UNSUPPORTED_FILL_REASON)).toBeTruthy();

      const select = screen.getByLabelText('Fill policy', {
        selector: 'select',
      }) as HTMLSelectElement;
      expect(select).toBeDisabled();

      for (const tabLabel of ['Fill or Kill', 'Immediate or Cancel', 'Return'] as const) {
        expect(screen.getByRole('tab', { name: tabLabel })).toBeDisabled();
      }

      cleanup();
    }
  });
});
