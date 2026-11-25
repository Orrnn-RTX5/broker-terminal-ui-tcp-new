// @vitest-environment jsdom

/**
 * P07-7b / T50d (tests written FIRST): pending-order expiry-type TLV 0x08 in the terminal order encoder.
 *
 * Contract pinned by this file (spec: _pending/mt5-sdk-parity/specs/P07.md, D13 and "Step P07-7b"):
 *  - Wire: 3 bytes `08 01 <v>`, v = uint8 0..3 (0 GTC, 1 DAY, 2 SPECIFIED, 3 SPECIFIED_DAY), at most once per frame,
 *    extras block <= 512 bytes, `HAS_EXTRAS` (0x0400) set, the u16 extras length is little-endian.
 *  - ONE global flag `VITE_BINARY_ORDER_EXPIRY_TYPE_TLV_ENABLED`, default OFF. Flag OFF = every frame byte-identical to today.
 *  - Flag ON: pending PLACE carries 0x08; pending MODIFY carries 0x08 ONLY when the frame has `HAS_EXPIRATION` (0x0080);
 *    market, close and every other action never carry it.
 *  - `binaryTcpOrderClient.ts` must NOT import anything from `dealing/binaryDealingCodec` (P07-3 startup bundle rule).
 *
 * Decisions the spec does NOT fix (this file pins them, change the constant or the test in ONE place if the owner decides otherwise):
 *  - The TS parameter name is `expiryType` (camelCase of the wire name `expiry_type`, EXPIRY_PARAM below), numeric 0..3 only.
 *  - An invalid value (> 3, negative, non-integer, NaN, Infinity, string, boolean) with the flag ON is REFUSED with a
 *    `BinaryTcpOrderError` (status 400, retryable false, code `INVALID_*EXPIR*`), never silently dropped and never sent.
 *    Reason: dropping it would turn a DAY or SPECIFIED order into a GTC order without telling the trader. Same as P07-3 (INVALID_FILLING).
 *    With the flag OFF the parameter is ignored entirely (byte-identical frames).
 *  - The flag is read once at module load (never per frame), same as P07-3.
 *
 * Golden frames below were verified byte-for-byte against the pre-P07-7b baseline `tui-127base`
 * (`src/services/binaryTcpOrderClient.ts`, SHA-256 `6d4ca3e94915976ce1bf840e347ab4b2e86ec954392db7273b003ff20b60cf28`)
 * with every `VITE_*` flag unset (`verify_baseline_goldens.mjs` / `flag_off_identity_check.json`: 15/15 fixtures, 45/45 frames).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderPanelDialog } from '../components/OrderPanelDialog';
import { useAppStore } from '../store/useAppStore';
import type { BinaryTcpOrderParams } from './binaryTcpOrderClient';
import {
  CLIENT_CAP_DEALING_V1,
  WIRE_EXTRA_TAG_CLIENT_CAPS,
  decodeReqExtrasBlock,
} from './dealing/binaryDealingCodec';
import * as dealingHooks from './dealing/dealingRuntimeHooks';

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
    symbol: 'XAUUSD',
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
    bids: [
      { price: 4173.23, volume: 30 },
      { price: 4173.22, volume: 50 },
    ],
    asks: [
      { price: 4173.77, volume: 30 },
      { price: 4173.78, volume: 50 },
    ],
    spread: 0.54,
    timestamp: 1,
  }),
}));

// ─── Constants ───────────────────────────────────────────────────────────────

const EXPIRY_FLAG_ENV = 'VITE_BINARY_ORDER_EXPIRY_TYPE_TLV_ENABLED';
const FILL_FLAG_ENV = 'VITE_BINARY_ORDER_FILLING_TLV_ENABLED';
/** TS parameter name for the expiry type (the spec only names the wire field `expiry_type`). */
const EXPIRY_PARAM = 'expiryType';

const TAG_COMMENT = 0x01;
const TAG_MAGIC = 0x02;
const TAG_TRAILING_STOP = 0x03;
const TAG_TRAILING_STEP = 0x04;
const TAG_FILLING = 0x07;
const TAG_EXPIRY_TYPE = 0x08;

const FLAG_HAS_EXPIRATION = 0x0080;
const FLAG_HAS_EXTRAS = 0x0400;

const FIXED_UUID = '123e4567-e89b-42d3-a456-426614174000';
// Same token string as the P07-3 goldens (explicit authToken override, so the mocked getAccessToken is not read by frames).
const FIXED_TOKEN = 'tok-p07s3';
const FIXED_TOKEN_LEN = new TextEncoder().encode(FIXED_TOKEN).byteLength;
const FIXED_REQ_ID = 42;
const HEADER_SIZE = 128;
const WS_REQ_ID_LEN = 4;
const WS_FAST_SIZE = WS_REQ_ID_LEN + HEADER_SIZE; // 132
const RESP_SIZE = 136;
const EXTRAS_MAX_BYTES = 512;
const ORDER_CLIENT_SRC_PATH = path.resolve(process.cwd(), 'src/services/binaryTcpOrderClient.ts');

const ACTION_PLACE_PENDING = 4;

// ─── Types and fixtures ──────────────────────────────────────────────────────

type Params = Record<string, unknown>;
type Client = typeof import('./binaryTcpOrderClient');
type Kind = 'http' | 'wsA' | 'wsB';
type Triple = Record<Kind, string>;

const KINDS: readonly Kind[] = ['http', 'wsA', 'wsB'];

const common = (): Params => ({ accountLogin: 1001, clientOrderId: FIXED_UUID, authToken: FIXED_TOKEN });
const marketBare = (): Params => ({ action: 1, ...common(), symbol: 'EURUSD', side: 'BUY', volume: 0.1 });
const pendingBare = (): Params => ({
  action: 4, ...common(), symbol: 'EURUSD', side: 'BUY', orderSubType: 1, volume: 0.25, price: 1.085,
});
const modifyPositionBare = (): Params => ({ action: 3, ...common(), ticket: 90001, sl: 1.08, tp: 1.095 });
const modifyPendingWithExp = (): Params => ({
  action: 5, ...common(), ticket: 91002, price: 1.082, sl: 1.075, tp: 1.095, expiration: 1790000000,
});
const modifyPendingNoExp = (): Params => ({
  action: 5, ...common(), ticket: 91002, price: 1.082, sl: 1.075, tp: 1.095,
});

/** One factory per golden frame set (same fixtures as the capture script). */
const FIXTURES = {
  marketBare,
  marketExtras: (): Params => ({ ...marketBare(), comment: 'p07-ref', magic: 42n, trailingStop: 25, trailingStep: 5 }),
  pendingBare,
  pendingWithExp: (): Params => ({ ...pendingBare(), expiration: 1790000000 }),
  pendingExtras: (): Params => ({ ...pendingBare(), comment: 'p07-pend', magic: 99n }),
  closePartial: (): Params => ({ action: 2, ...common(), ticket: 90001, volume: 0.1, partialClose: true }),
  closeFull: (): Params => ({ action: 2, ...common(), ticket: 90001, volume: 0 }),
  modifyPositionBare,
  modifyPendingWithExp,
  modifyPendingNoExp,
  modifyPendingWithExpExtras: (): Params => ({ ...modifyPendingWithExp(), comment: 'mod-pend', magic: 77n }),
  modifyPendingNoExpExtras: (): Params => ({ ...modifyPendingNoExp(), comment: 'mod-pend', magic: 77n }),
  cancelPending: (): Params => ({ action: 6, ...common(), ticket: 91002 }),
  closeBulk: (): Params => ({ action: 7, ...common(), symbol: 'EURUSD', orderSubType: 0 }),
  closeBy: (): Params => ({ action: 8, ...common(), ticket: 90001, otherTicket: 90002, symbol: 'EURUSD' }),
} satisfies Record<string, () => Params>;

type FixtureName = keyof typeof FIXTURES;
const FIXTURE_NAMES = Object.keys(FIXTURES) as FixtureName[];

// ─── Golden frames (flag OFF = pre-P07-7b baseline tui-127base) ───────────────
// Verified 2026-11-25 against the pre-P07-7b baseline `tui-127base/src/services/binaryTcpOrderClient.ts`
// (SHA-256 `6d4ca3e94915976ce1bf840e347ab4b2e86ec954392db7273b003ff20b60cf28`) with NO `VITE_*` flag set
// (`P07S7b-tests2/logs/verify_baseline_goldens.mjs` and `P07S7b-gate/logs/flag_off_identity_check.json`: 15/15 fixtures,
// 45/45 frames match). Each entry is the HTTP body, the WS Mode A frame and the WS Mode B frame (reqId 42) as lowercase hex.
// The 12 fixtures shared with P07-3 plus `pendingWithExp`, `modifyPendingNoExp` and `modifyPendingNoExpExtras` are
// byte-identical to `tui-127base`.
const GOLDEN: Record<FixtureName, Triple> = {
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
  pendingWithExp: {
    http: '01040101a0000000e9030000000000000000000000000000000000000000d03f5c8fc2f5285cf13f000000000000000000000000000000000000000000000000803bb16a000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a00000001040101a0000000e9030000000000000000000000000000000000000000d03f5c8fc2f5285cf13f000000000000000000000000000000000000000000000000803bb16a000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a00000001040101a0000000e9030000000000000000000000000000000000000000d03f5c8fc2f5285cf13f000000000000000000000000000000000000000000000000803bb16a000000004555525553440000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
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
  modifyPositionBare: {
    http: '0103000003000000e903000000000000915f01000000000000000000000000000000000000000000000000000000000048e17a14ae47f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a0000000103000003000000e903000000000000915f01000000000000000000000000000000000000000000000000000000000048e17a14ae47f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a0000000103000003000000e903000000000000915f01000000000000000000000000000000000000000000000000000000000048e17a14ae47f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
  modifyPendingWithExp: {
    http: '01050000a3000000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a00000001050000a3000000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a00000001050000a3000000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
  modifyPendingNoExp: {
    http: '0105000023000000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
    wsA: '2a0000000105000023000000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000',
    wsB: '2a0000000105000023000000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333',
  },
  modifyPendingWithExpExtras: {
    http: '01050000a3040000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333140001086d6f642d70656e6402084d00000000000000',
    wsA: '2a00000001050000a3040000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000140001086d6f642d70656e6402084d00000000000000',
    wsB: '2a00000001050000a3040000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f803bb16a000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333140001086d6f642d70656e6402084d00000000000000',
  },
  modifyPendingNoExpExtras: {
    http: '0105000023040000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333140001086d6f642d70656e6402084d00000000000000',
    wsA: '2a0000000105000023040000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d34323636313431373430303000000000140001086d6f642d70656e6402084d00000000000000',
    wsB: '2a0000000105000023040000e9030000000000007a6301000000000000000000000000001d5a643bdf4ff13f0000000000000000333333333333f13f85eb51b81e85f13f00000000000000000000000000000000000000000000000031323365343536372d653839622d343264332d613435362d343236363134313734303030000000000900746f6b2d7030377333140001086d6f642d70656e6402084d00000000000000',
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
};

// ─── Byte and frame helpers ──────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function flagsOffsetOf(kind: Kind): number {
  return kind === 'http' ? 4 : 8;
}

function extrasOffsetOf(kind: Kind, tokenLen = FIXED_TOKEN_LEN): number {
  if (kind === 'http') return HEADER_SIZE + 2 + tokenLen;
  if (kind === 'wsA') return WS_FAST_SIZE;
  return WS_FAST_SIZE + 2 + tokenLen;
}

interface TlvEntry {
  tag: number;
  len: number;
  value: Uint8Array;
  raw: Uint8Array;
}

function parseTlvEntries(extrasBlock: Uint8Array): TlvEntry[] {
  expect(extrasBlock.byteLength).toBeGreaterThanOrEqual(2);
  const view = new DataView(extrasBlock.buffer, extrasBlock.byteOffset, extrasBlock.byteLength);
  const declaredLen = view.getUint16(0, true); // little-endian u16
  expect(declaredLen).toBe(extrasBlock.byteLength - 2);
  expect(declaredLen).toBeLessThanOrEqual(EXTRAS_MAX_BYTES);

  const entries: TlvEntry[] = [];
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

interface FrameInfo {
  flags: number;
  hasExtras: boolean;
  extrasLen: number;
  extrasBlock: Uint8Array | null;
  entries: TlvEntry[];
  tags: number[];
}

/**
 * Splits a frame into header flags and the TLV extras block, and asserts the invariants that hold for EVERY frame:
 * HAS_EXTRAS is set exactly when an extras block follows, the u16 LE length matches, extras <= 512 bytes,
 * and no tag appears twice.
 */
function inspect(frame: Uint8Array, kind: Kind): FrameInfo {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const flags = view.getUint16(flagsOffsetOf(kind), true);
  const hasExtras = (flags & FLAG_HAS_EXTRAS) !== 0;
  const offset = extrasOffsetOf(kind);
  const extrasBlock = frame.byteLength > offset ? frame.subarray(offset) : null;
  expect(hasExtras, `HAS_EXTRAS flag must match presence of an extras block (${kind})`).toBe(extrasBlock !== null);
  const entries = extrasBlock ? parseTlvEntries(extrasBlock) : [];
  const tags = entries.map((e) => e.tag);
  expect(new Set(tags).size, `each TLV tag at most once per frame (${kind})`).toBe(tags.length);
  return {
    flags,
    hasExtras,
    extrasLen: extrasBlock ? view.getUint16(offset, true) : 0,
    extrasBlock,
    entries,
    tags,
  };
}

function rawOf(entries: TlvEntry[], tag: number): number[] | undefined {
  const entry = entries.find((e) => e.tag === tag);
  return entry ? Array.from(entry.raw) : undefined;
}

/** Entries of the extras block of a golden frame (hex), in wire order. */
function goldenEntries(golden: Triple, kind: Kind): TlvEntry[] {
  return inspect(hexToBytes(golden[kind]), kind).entries;
}

/**
 * Expected frame = golden frame (which has NO extras) + HAS_EXTRAS flag + `[u16 LE len][tlv]` appended at the very end.
 * Extras are the last bytes of the HTTP, WS Mode A and WS Mode B frames, so this is exact for all three layouts.
 */
function withExtrasTlv(golden: Triple, tlv: readonly number[]): Triple {
  const out = {} as Triple;
  for (const kind of KINDS) {
    const base = hexToBytes(golden[kind]);
    const view = new DataView(base.buffer);
    const flags = view.getUint16(flagsOffsetOf(kind), true);
    expect(flags & FLAG_HAS_EXTRAS, `golden ${kind} must have no extras to derive from`).toBe(0);
    view.setUint16(flagsOffsetOf(kind), flags | FLAG_HAS_EXTRAS, true);
    const full = new Uint8Array(base.length + 2 + tlv.length);
    full.set(base, 0);
    full[base.length] = tlv.length & 0xff; // u16 little-endian
    full[base.length + 1] = (tlv.length >> 8) & 0xff;
    full.set(tlv, base.length + 2);
    out[kind] = toHex(full);
  }
  return out;
}

function expectFramesEqualGolden(frames: Record<Kind, Uint8Array>, golden: Triple, label: string): void {
  for (const kind of KINDS) {
    expect(toHex(frames[kind]), `${label} [${kind}]`).toBe(golden[kind]);
  }
}

function encodeAll(client: Client, params: Params): Record<Kind, Uint8Array> {
  const p = params as unknown as BinaryTcpOrderParams;
  return {
    http: client.encodeBinaryOrderReq(p).packet,
    wsA: client.encodeBinaryOrderWsModeAFrame(FIXED_REQ_ID, p),
    wsB: client.encodeBinaryOrderWsModeBFrame(FIXED_REQ_ID, p),
  };
}

const withExpiry = (base: Params, value: unknown): Params => ({ ...base, [EXPIRY_PARAM]: value });

/** Asserts a frame carries exactly the single extras TLV `08 01 <v>` (and nothing else), little-endian length 3. */
function expectOnlyExpiryTlv(frames: Record<Kind, Uint8Array>, v: number, label: string): void {
  for (const kind of KINDS) {
    const info = inspect(frames[kind], kind);
    expect(info.hasExtras, `${label} [${kind}] HAS_EXTRAS`).toBe(true);
    expect(info.extrasLen, `${label} [${kind}] extras length`).toBe(3);
    expect(Array.from(info.extrasBlock!), `${label} [${kind}] extras block`).toEqual([3, 0, TAG_EXPIRY_TYPE, 1, v]);
  }
}

// ─── Client loaders ──────────────────────────────────────────────────────────

interface FlagEnv {
  expiry?: string;
  fill?: string;
}

function stubFlags(env: FlagEnv): void {
  vi.unstubAllEnvs();
  if (env.expiry !== undefined) vi.stubEnv(EXPIRY_FLAG_ENV, env.expiry);
  if (env.fill !== undefined) vi.stubEnv(FILL_FLAG_ENV, env.fill);
}

async function loadClient(env: FlagEnv = {}): Promise<Client> {
  stubFlags(env);
  vi.resetModules();
  return import('./binaryTcpOrderClient');
}

async function loadClientWithDealing(env: FlagEnv = {}) {
  stubFlags(env);
  vi.resetModules();
  const [client, hooks, dealingClient] = await Promise.all([
    import('./binaryTcpOrderClient'),
    import('./dealing/dealingRuntimeHooks'),
    import('./dealing/dealingOrderClient'),
  ]);
  return { client, hooks, dealingClient };
}

/**
 * Loads the REAL source as CommonJS with `import.meta.env` replaced by `metaEnv` (to test raw boolean / undefined env values).
 * The loader only hands out the three modules the client may use; ANY other require (for example binaryDealingCodec) throws.
 */
function loadClientWithRawMetaEnv(metaEnv: Record<string, unknown> | undefined): Client {
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
  const mockRequire = (specifier: string): unknown => {
    if (specifier === '../config/backendTarget.js') {
      return { isDesktopBackendTarget: () => false };
    }
    if (specifier === './brokerSession') {
      return { getAccessToken: () => FIXED_TOKEN, onSessionChange: () => () => {} };
    }
    if (specifier === './dealing/dealingRuntimeHooks') {
      return dealingHooks;
    }
    throw new Error(`Unexpected require in raw-env test loader: ${specifier}`);
  };

  const fn = new Function('exports', 'require', 'module', '__testMetaEnv', transpiled);
  fn(moduleObj.exports, mockRequire, moduleObj, metaEnv);
  return moduleObj.exports as unknown as Client;
}

// ─── Transport mocks (copied from the P07-3 suites) ──────────────────────────

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
  bytes.set(new TextEncoder().encode(clientOrderId).subarray(0, 40), 96);
  return bytes;
}

function wrapWsResp(reqId: number, respBytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(WS_REQ_ID_LEN + respBytes.byteLength);
  new DataView(buf).setUint32(0, reqId >>> 0, true);
  new Uint8Array(buf, WS_REQ_ID_LEN).set(respBytes);
  return buf;
}

function createMockOrderWsClass(sentFrames: Uint8Array[]) {
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

function createClosedWsClass() {
  return class ClosedWs {
    readyState = 3;
    binaryType = 'arraybuffer';
    onopen: (() => void) | null = null;
    onmessage: ((ev: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send = vi.fn();
    close = vi.fn();
  };
}

function enableRuntime(
  hooks: Awaited<ReturnType<typeof loadClientWithDealing>>['hooks'] | null,
  dealing: boolean,
): void {
  (window as unknown as Record<string, unknown>).rtx5Electron = { platform: 'web-tcp' };
  (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = {
    BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
    ...(dealing ? { DEALING_BRIDGE_V1: true } : {}),
  };
  if (dealing && hooks) {
    hooks.__setDealingTransportSupportedForTests(true);
    hooks.setDealingServerAdvertised(true);
  }
}

const orderFrameOf = (sentFrames: Uint8Array[]): Uint8Array =>
  sentFrames.find((f) => new DataView(f.buffer, f.byteOffset, 4).getUint32(0, true) !== 0)!;

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Flag OFF (default) ──────────────────────────────────────────────────────

describe('P07-7b T50d flag OFF (default): every frame is byte-identical to today and carries no 0x08', () => {
  it('all 15 fixtures equal the goldens with the flag unset or "false": pending place, pending modify with and without expiration, market, close, modify position, cancel, bulk close, close-by', async () => {
    for (const expiry of [undefined, 'false'] as const) {
      const client = await loadClient({ expiry });
      for (const name of FIXTURE_NAMES) {
        expectFramesEqualGolden(encodeAll(client, FIXTURES[name]()), GOLDEN[name], `${name} (flag ${String(expiry)})`);
      }
    }
  });

  it('a supplied expiryType (valid 0..3 or junk) is ignored on every action: frames stay byte-identical, no throw', async () => {
    const ignoredValues: unknown[] = [0, 1, 2, 3, 4, 255, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'x', '1', true, null];
    for (const expiry of [undefined, 'false'] as const) {
      const client = await loadClient({ expiry });
      for (const name of FIXTURE_NAMES) {
        for (const value of ignoredValues) {
          expectFramesEqualGolden(
            encodeAll(client, withExpiry(FIXTURES[name](), value)),
            GOLDEN[name],
            `${name} expiryType=${String(value)} (flag ${String(expiry)})`,
          );
        }
      }
    }
  });

  it('with only the P07-3 fill flag ON, 0x07 is emitted exactly as today and expiryType still adds no 0x08', async () => {
    const client = await loadClient({ fill: 'true' });
    for (const v of [0, 1, 2, 3]) {
      const frames = encodeAll(client, { ...pendingBare(), filling: 1, [EXPIRY_PARAM]: v });
      for (const kind of KINDS) {
        const info = inspect(frames[kind], kind);
        expect(Array.from(info.extrasBlock!)).toEqual([3, 0, TAG_FILLING, 1, 1]);
        expect(info.tags).not.toContain(TAG_EXPIRY_TYPE);
      }
    }
    expectFramesEqualGolden(encodeAll(client, withExpiry(pendingBare(), 2)), GOLDEN.pendingBare, 'pending, expiryType only');
  });

  it('the public encodeBinaryOrderExtrasTlv keeps its 7-argument contract and never emits 0x08 (flag OFF and ON)', async () => {
    for (const expiry of [undefined, 'true'] as const) {
      const client = await loadClient({ expiry });
      expect(Array.from(client.encodeBinaryOrderExtrasTlv('abc', 5n, FIXED_UUID, ACTION_PLACE_PENDING))).toEqual([
        TAG_COMMENT, 3, 97, 98, 99,
        TAG_MAGIC, 8, 5, 0, 0, 0, 0, 0, 0, 0,
      ]);
      expect(
        Array.from(client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_PENDING, 25, 5)),
      ).toEqual([TAG_TRAILING_STOP, 4, 25, 0, 0, 0, TAG_TRAILING_STEP, 4, 5, 0, 0, 0]);
      expect(
        Array.from(
          client.encodeBinaryOrderExtrasTlv(undefined, undefined, FIXED_UUID, ACTION_PLACE_PENDING, undefined, undefined, 2),
        ),
      ).toEqual([TAG_FILLING, 1, 2]);
      expect(client.encodeBinaryOrderExtrasTlv().byteLength).toBe(0);
    }
  });
});

// ─── Flag semantics ──────────────────────────────────────────────────────────

describe('P07-7b flag semantics: one global flag, default OFF, read once at module load', () => {
  it.each(['true', '1', ' TRUE ', ' true ', '1 '])('string env value %j is ON', async (value) => {
    const client = await loadClient({ expiry: value });
    expectFramesEqualGolden(
      encodeAll(client, withExpiry(pendingBare(), 1)),
      withExtrasTlv(GOLDEN.pendingBare, [TAG_EXPIRY_TYPE, 1, 1]),
      `flag ${JSON.stringify(value)}`,
    );
  });

  it.each(['false', '', 'yes', '0', 'on', 'true1'])('string env value %j is OFF', async (value) => {
    const client = await loadClient({ expiry: value });
    expectFramesEqualGolden(
      encodeAll(client, withExpiry(pendingBare(), 1)),
      GOLDEN.pendingBare,
      `flag ${JSON.stringify(value)}`,
    );
  });

  it('raw boolean true is ON; boolean false, a missing key and an undefined import.meta.env are OFF (loader hands out no binaryDealingCodec)', () => {
    const on = loadClientWithRawMetaEnv({ MODE: 'test', [EXPIRY_FLAG_ENV]: true });
    expectFramesEqualGolden(
      encodeAll(on, withExpiry(pendingBare(), 1)),
      withExtrasTlv(GOLDEN.pendingBare, [TAG_EXPIRY_TYPE, 1, 1]),
      'raw boolean true',
    );

    const offEnvs: Array<[string, Record<string, unknown> | undefined]> = [
      ['raw boolean false', { MODE: 'test', [EXPIRY_FLAG_ENV]: false }],
      ['missing key', { MODE: 'test' }],
      ['undefined import.meta.env', undefined],
    ];
    for (const [label, env] of offEnvs) {
      const off = loadClientWithRawMetaEnv(env);
      expectFramesEqualGolden(encodeAll(off, withExpiry(pendingBare(), 1)), GOLDEN.pendingBare, label);
    }
  });

  it('is read once at module load: changing the env after the module is loaded changes nothing', async () => {
    const loadedOn = await loadClient({ expiry: 'true' });
    vi.stubEnv(EXPIRY_FLAG_ENV, 'false');
    expectFramesEqualGolden(
      encodeAll(loadedOn, withExpiry(pendingBare(), 1)),
      withExtrasTlv(GOLDEN.pendingBare, [TAG_EXPIRY_TYPE, 1, 1]),
      'loaded ON, env flipped to false afterwards',
    );

    const loadedOff = await loadClient({ expiry: 'false' });
    vi.stubEnv(EXPIRY_FLAG_ENV, 'true');
    expectFramesEqualGolden(
      encodeAll(loadedOff, withExpiry(pendingBare(), 1)),
      GOLDEN.pendingBare,
      'loaded OFF, env flipped to true afterwards',
    );
  });

  it('the source reads the flag by its literal name and defines exactly two global VITE_ flags (fill type, expiry type), none per broker', () => {
    const src = readFileSync(ORDER_CLIENT_SRC_PATH, 'utf8');
    expect(
      /import\.meta\.env\??\.VITE_BINARY_ORDER_EXPIRY_TYPE_TLV_ENABLED/.test(src),
      'source must read import.meta.env?.VITE_BINARY_ORDER_EXPIRY_TYPE_TLV_ENABLED by its literal name',
    ).toBe(true);
    expect(/import\.meta\.env\s*\|\|\s*\{\s*\}/.test(src), 'no whole-object import.meta.env || {} read').toBe(false);
    const names = [...new Set(src.match(/VITE_[A-Z0-9_]+/g) ?? [])].sort();
    expect(names).toEqual([EXPIRY_FLAG_ENV, FILL_FLAG_ENV].sort());
  });
});

// ─── Startup bundle rule ─────────────────────────────────────────────────────

describe('P07-7b startup bundle rule (P07-3): binaryTcpOrderClient.ts has no import from binaryDealingCodec', () => {
  it('has no static import, re-export, dynamic import() or require() of binaryDealingCodec (checked on the parsed source)', () => {
    const src = readFileSync(ORDER_CLIENT_SRC_PATH, 'utf8');
    const sf = ts.createSourceFile(ORDER_CLIENT_SRC_PATH, src, ts.ScriptTarget.ES2022, true);
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
          specifiers.push(node.arguments[0].text);
        }
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        specifiers.push(node.argument.literal.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    // Sanity: the parser really sees the file's imports.
    expect(specifiers).toContain('./dealing/dealingRuntimeHooks');
    expect(specifiers.filter((s) => /binaryDealingCodec/.test(s))).toEqual([]);
  });

  it('has no import-like text naming binaryDealingCodec (regex guard, same pattern as the P07-3 suite)', () => {
    const src = readFileSync(ORDER_CLIENT_SRC_PATH, 'utf8');
    const match = /\b(?:from|import|require)\s*(?:\(\s*)?['"][^'"]*binaryDealingCodec[^'"]*['"]/.exec(src);
    expect(match === null ? null : match[0]).toBeNull();
  });
});

// ─── Flag ON: pending PLACE ──────────────────────────────────────────────────

describe('P07-7b T50d flag ON: pending place carries exactly 08 01 <v> for v = 0..3', () => {
  const PLACE_CASES = [
    { v: 0, label: 'GTC (no expiration)', fixture: 'pendingBare' },
    { v: 1, label: 'DAY (no expiration)', fixture: 'pendingBare' },
    { v: 1, label: 'DAY (with expiration)', fixture: 'pendingWithExp' },
    { v: 2, label: 'SPECIFIED (with expiration)', fixture: 'pendingWithExp' },
    { v: 3, label: 'SPECIFIED_DAY (with expiration)', fixture: 'pendingWithExp' },
  ] as const;

  it.each(PLACE_CASES)('value $v, $label: frame = golden + HAS_EXTRAS + [03 00][08 01 v] on HTTP, WS Mode A and WS Mode B', async ({ v, label, fixture }) => {
    const client = await loadClient({ expiry: 'true' });
    const frames = encodeAll(client, withExpiry(FIXTURES[fixture](), v));

    // Whole-frame byte equality against the golden (flag-OFF) frame with only the extras added.
    expectFramesEqualGolden(frames, withExtrasTlv(GOLDEN[fixture], [TAG_EXPIRY_TYPE, 1, v]), label);

    // Structural view of the same bytes: tag/len/value, little-endian u16 length 3, HAS_EXTRAS set, HAS_EXPIRATION as before.
    expectOnlyExpiryTlv(frames, v, label);
    for (const kind of KINDS) {
      const info = inspect(frames[kind], kind);
      expect(info.entries).toHaveLength(1);
      expect(info.entries[0].tag).toBe(TAG_EXPIRY_TYPE);
      expect(info.entries[0].len).toBe(1);
      expect(info.entries[0].value[0]).toBe(v);
      expect((info.flags & FLAG_HAS_EXPIRATION) !== 0).toBe(fixture === 'pendingWithExp');
    }
  });

  it('value 0 (GTC) is emitted, not dropped as falsy', async () => {
    const client = await loadClient({ expiry: 'true' });
    expectOnlyExpiryTlv(encodeAll(client, withExpiry(pendingBare(), 0)), 0, 'GTC');
    expectOnlyExpiryTlv(encodeAll(client, withExpiry(pendingBare(), -0)), 0, '-0');
  });

  it('every pending order type (buy/sell limit, buy/sell stop, buy/sell stop-limit) carries it', async () => {
    const client = await loadClient({ expiry: 'true' });
    const types: Array<[string, number, string, boolean]> = [
      ['BUY_LIMIT', 1, 'BUY', false],
      ['SELL_LIMIT', 2, 'SELL', false],
      ['BUY_STOP', 3, 'BUY', false],
      ['SELL_STOP', 4, 'SELL', false],
      ['BUY_STOP_LIMIT', 5, 'BUY', true],
      ['SELL_STOP_LIMIT', 6, 'SELL', true],
    ];
    for (const [name, subType, side, needsStopLimit] of types) {
      const base: Params = {
        ...pendingBare(),
        orderSubType: subType,
        side,
        expiration: 1_790_000_000,
        ...(needsStopLimit ? { stopLimitPrice: 1.084 } : {}),
      };
      expectOnlyExpiryTlv(encodeAll(client, withExpiry(base, 2)), 2, name);
    }
  });

  it('omitting expiryType (undefined or null) with the flag ON leaves the frame byte-identical to today', async () => {
    const client = await loadClient({ expiry: 'true' });
    for (const value of [undefined, null]) {
      for (const name of ['pendingBare', 'pendingWithExp', 'pendingExtras'] as const) {
        expectFramesEqualGolden(
          encodeAll(client, withExpiry(FIXTURES[name](), value)),
          GOLDEN[name],
          `${name} expiryType=${String(value)}`,
        );
      }
    }
  });

  it('coexists with comment and magic: both are unchanged, 0x08 appears once, header bytes are unchanged', async () => {
    const offClient = await loadClient({});
    const client = await loadClient({ expiry: 'true' });
    for (const v of [1, 2]) {
      const base = v === 2
        ? { ...FIXTURES.pendingExtras(), expiration: 1_790_000_000 }
        : FIXTURES.pendingExtras();
      const params = withExpiry(base, v);
      const frames = encodeAll(client, params);
      const offFrames = encodeAll(offClient, base);
      for (const kind of KINDS) {
        const info = inspect(frames[kind], kind);
        const before = goldenEntries(GOLDEN.pendingExtras, kind);
        expect(info.entries.filter((e) => e.tag === TAG_EXPIRY_TYPE).map((e) => Array.from(e.raw))).toEqual([
          [TAG_EXPIRY_TYPE, 1, v],
        ]);
        expect(info.entries.filter((e) => e.tag !== TAG_EXPIRY_TYPE).map((e) => Array.from(e.raw))).toEqual(
          before.map((e) => Array.from(e.raw)),
        );
        expect(info.extrasLen).toBe(20 + 3); // comment(2+8) + magic(2+8) + 0x08(3)
        // Everything before the extras block (header + token) is byte-identical to the flag-OFF frame (and GOLDEN for v=1).
        const baselineBytes = v === 1 ? hexToBytes(GOLDEN.pendingExtras[kind]) : offFrames[kind];
        const headerEnd = extrasOffsetOf(kind);
        expect(toHex(frames[kind].subarray(0, headerEnd))).toBe(toHex(baselineBytes.subarray(0, headerEnd)));
      }
    }
  });

  it('the old dealing decoder skips the unknown tag: decoded comment and magic equal the frame without 0x08 (T50b, terminal side)', async () => {
    const withTlv = await loadClient({ expiry: 'true' });
    const frames = encodeAll(withTlv, withExpiry({ ...FIXTURES.pendingExtras(), expiration: 1_790_000_000 }, 3));
    const without = decodeReqExtrasBlock(inspect(hexToBytes(GOLDEN.pendingExtras.wsA), 'wsA').extrasBlock!).extras;
    for (const kind of KINDS) {
      const info = inspect(frames[kind], kind);
      expect(info.tags, `0x08 must really be on the wire [${kind}]`).toContain(TAG_EXPIRY_TYPE);
      const decoded = decodeReqExtrasBlock(info.extrasBlock!).extras;
      expect(decoded).toEqual(without);
      expect(decoded.comment).toBe('p07-pend');
      expect(decoded.magic).toBe(99);
    }
  });

  it('mutating a returned frame does not corrupt later frames (no shared mutable extras buffer)', async () => {
    const client = await loadClient({ expiry: 'true' });
    const first = encodeAll(client, withExpiry(pendingBare(), 1));
    for (const kind of KINDS) first[kind].fill(0xee);
    const second = encodeAll(client, withExpiry({ ...pendingBare(), expiration: 1_790_000_000 }, 2));
    const third = encodeAll(client, withExpiry(pendingBare(), 1));
    expectOnlyExpiryTlv(second, 2, 'second');
    expectFramesEqualGolden(third, withExtrasTlv(GOLDEN.pendingBare, [TAG_EXPIRY_TYPE, 1, 1]), 'third');
  });
});

// ─── Flag ON: pending MODIFY ─────────────────────────────────────────────────

describe('P07-7b T50d flag ON: pending modify carries 0x08 ONLY together with HAS_EXPIRATION', () => {
  it.each([1, 2, 3])('modify WITH expiration and expiryType %i: HAS_EXPIRATION set and 08 01 <v> present (HTTP, WS A, WS B)', async (v) => {
    const client = await loadClient({ expiry: 'true' });
    const frames = encodeAll(client, withExpiry(modifyPendingWithExp(), v));
    expectFramesEqualGolden(frames, withExtrasTlv(GOLDEN.modifyPendingWithExp, [TAG_EXPIRY_TYPE, 1, v]), `modify with expiration v=${v}`);
    expectOnlyExpiryTlv(frames, v, `modify with expiration v=${v}`);
    for (const kind of KINDS) {
      expect(inspect(frames[kind], kind).flags & FLAG_HAS_EXPIRATION).toBe(FLAG_HAS_EXPIRATION);
    }
  });

  it.each([0, 1, 2, 3])('modify WITHOUT expiration (price/SL/TP only) and expiryType %i: frame is byte-identical to today, no 0x08, no HAS_EXPIRATION', async (v) => {
    const client = await loadClient({ expiry: 'true' });
    const frames = encodeAll(client, withExpiry(modifyPendingNoExp(), v));
    expectFramesEqualGolden(frames, GOLDEN.modifyPendingNoExp, `modify without expiration v=${v}`);
    for (const kind of KINDS) {
      const info = inspect(frames[kind], kind);
      expect(info.flags & FLAG_HAS_EXPIRATION).toBe(0);
      expect(info.hasExtras).toBe(false);
      expect(info.tags).not.toContain(TAG_EXPIRY_TYPE);
    }
  });

  it('modify without expiration but with comment and magic: extras unchanged, still no 0x08', async () => {
    const client = await loadClient({ expiry: 'true' });
    for (const v of [0, 1, 2, 3]) {
      expectFramesEqualGolden(
        encodeAll(client, withExpiry(FIXTURES.modifyPendingNoExpExtras(), v)),
        GOLDEN.modifyPendingNoExpExtras,
        `modify, comment+magic, no expiration, v=${v}`,
      );
    }
  });

  it('an explicit HAS_EXPIRATION flag without an expiration value (or expiration 0 / null) does not make the modify carry 0x08', async () => {
    const client = await loadClient({ expiry: 'true' });
    const variants: Array<[string, Params]> = [
      ['flags only', { ...modifyPendingNoExp(), flags: FLAG_HAS_EXPIRATION }],
      ['expiration 0', { ...modifyPendingNoExp(), flags: FLAG_HAS_EXPIRATION, expiration: 0 }],
      ['expiration null', { ...modifyPendingNoExp(), flags: FLAG_HAS_EXPIRATION, expiration: null }],
    ];
    for (const [label, base] of variants) {
      const frames = encodeAll(client, withExpiry(base, 2));
      for (const kind of KINDS) {
        const info = inspect(frames[kind], kind);
        // Whatever the encoder does with the stray flag, the rule is: 0x08 present  <=>  HAS_EXPIRATION set in the frame.
        expect(info.tags.includes(TAG_EXPIRY_TYPE), `${label} [${kind}]`).toBe((info.flags & FLAG_HAS_EXPIRATION) !== 0);
      }
      expectFramesEqualGolden(frames, GOLDEN.modifyPendingNoExp, `${label}: today the encoder drops the stray flag`);
    }
  });

  it('modify with expiration plus comment and magic: all three TLVs present, 0x08 once, the other two unchanged', async () => {
    const client = await loadClient({ expiry: 'true' });
    for (const v of [1, 2, 3]) {
      const frames = encodeAll(client, withExpiry(FIXTURES.modifyPendingWithExpExtras(), v));
      for (const kind of KINDS) {
        const info = inspect(frames[kind], kind);
        const before = goldenEntries(GOLDEN.modifyPendingWithExpExtras, kind);
        expect(info.entries.filter((e) => e.tag === TAG_EXPIRY_TYPE).map((e) => Array.from(e.raw))).toEqual([
          [TAG_EXPIRY_TYPE, 1, v],
        ]);
        expect(info.entries.filter((e) => e.tag !== TAG_EXPIRY_TYPE).map((e) => Array.from(e.raw))).toEqual(
          before.map((e) => Array.from(e.raw)),
        );
        expect(info.flags & FLAG_HAS_EXPIRATION).toBe(FLAG_HAS_EXPIRATION);
        expect(info.extrasLen).toBe(20 + 3); // comment(2+8) + magic(2+8) + 0x08(3)
      }
    }
  });

  it('invariant sweep: for every modify shape, 0x08 is present exactly when the frame has HAS_EXPIRATION', async () => {
    const client = await loadClient({ expiry: 'true' });
    const m = (extra: Params): Params => ({ action: 5, ...common(), ticket: 91002, ...extra });
    const shapes: Array<[string, Params, boolean]> = [
      ['price only', m({ price: 1.082 }), false],
      ['sl only', m({ sl: 1.075 }), false],
      ['tp only', m({ tp: 1.095 }), false],
      ['price+sl+tp', m({ price: 1.082, sl: 1.075, tp: 1.095 }), false],
      ['clear sl', m({ clearSl: true }), false],
      ['clear tp', m({ clearTp: true }), false],
      ['stop-limit price', m({ price: 1.082, stopLimitPrice: 1.081 }), false],
      ['trailing stop+step', m({ trailingStop: 30, trailingStep: 5 }), false],
      ['clear trailing', m({ clearTrailing: true }), false],
      ['comment+magic', m({ comment: 'c', magic: 5n }), false],
      ['expiration (s)', m({ expiration: 1790000000 }), true],
      ['expiration (ms, converted to s)', m({ expiration: 1790000000000 }), true],
      ['expiration + price', m({ price: 1.082, expiration: 1790000000 }), true],
      ['expiration + trailing', m({ expiration: 1790000000, trailingStop: 30 }), true],
      ['expiration + comment', m({ expiration: 1790000000, comment: 'c' }), true],
    ];
    for (const [label, base, hasExpiration] of shapes) {
      for (const v of [1, 2, 3]) {
        const frames = encodeAll(client, withExpiry(base, v));
        for (const kind of KINDS) {
          const info = inspect(frames[kind], kind);
          expect((info.flags & FLAG_HAS_EXPIRATION) !== 0, `${label} [${kind}] HAS_EXPIRATION`).toBe(hasExpiration);
          expect(info.tags.includes(TAG_EXPIRY_TYPE), `${label} v=${v} [${kind}] 0x08 present`).toBe(hasExpiration);
          if (hasExpiration) {
            expect(rawOf(info.entries, TAG_EXPIRY_TYPE), `${label} v=${v} [${kind}]`).toEqual([TAG_EXPIRY_TYPE, 1, v]);
          }
        }
      }
    }
  });
});

// ─── Flag ON: every other action never carries 0x08 ──────────────────────────

describe('P07-7b T50d flag ON: market, close and every non-pending-place/modify action never carry 0x08', () => {
  const NEVER = [
    'marketBare',
    'marketExtras',
    'closePartial',
    'closeFull',
    'modifyPositionBare',
    'cancelPending',
    'closeBulk',
    'closeBy', // close-by sets HAS_EXPIRATION (it carries the counterpart ticket in the expiration field): must still not emit 0x08
  ] as const;

  it.each([
    ['expiry flag ON', { expiry: 'true' }],
    ['both flags ON', { expiry: 'true', fill: 'true' }],
  ] as const)('%s: frames equal the flag-OFF goldens for every action that is not pending place/modify', async (_label, env) => {
    const client = await loadClient(env);
    for (const name of NEVER) {
      for (const v of [0, 1, 2, 3]) {
        const frames = encodeAll(client, withExpiry(FIXTURES[name](), v));
        expectFramesEqualGolden(frames, GOLDEN[name], `${name} expiryType=${v}`);
        for (const kind of KINDS) {
          expect(inspect(frames[kind], kind).tags).not.toContain(TAG_EXPIRY_TYPE);
        }
      }
    }
  });

  it('modify position with an expiration value (HAS_EXPIRATION set) still carries no 0x08', async () => {
    const client = await loadClient({ expiry: 'true' });
    for (const v of [1, 2, 3]) {
      const frames = encodeAll(client, withExpiry({ ...modifyPositionBare(), expiration: 1790000000 }, v));
      for (const kind of KINDS) {
        const info = inspect(frames[kind], kind);
        expect(info.tags).not.toContain(TAG_EXPIRY_TYPE);
        expect(info.hasExtras).toBe(false);
      }
    }
  });

  it('a market order with an expiration value still carries no 0x08', async () => {
    const client = await loadClient({ expiry: 'true' });
    const frames = encodeAll(client, withExpiry({ ...marketBare(), expiration: 1790000000 }, 2));
    for (const kind of KINDS) {
      const info = inspect(frames[kind], kind);
      expect(info.tags).not.toContain(TAG_EXPIRY_TYPE);
      expect(info.hasExtras).toBe(false);
    }
  });

  it('invalid expiryType values on market orders (bare and with extras) are ignored, do not throw, and stay byte-identical to golden', async () => {
    const client = await loadClient({ expiry: 'true' });
    for (const bad of [4, -1, 1.5, Number.NaN, 'DAY', true]) {
      expectFramesEqualGolden(
        encodeAll(client, withExpiry(marketBare(), bad)),
        GOLDEN.marketBare,
        `marketBare, expiryType=${String(bad)}`,
      );
      expectFramesEqualGolden(
        encodeAll(client, withExpiry(FIXTURES.marketExtras(), bad)),
        GOLDEN.marketExtras,
        `marketExtras, expiryType=${String(bad)}`,
      );
    }
  });

  it('invalid expiryType values on a pending modify without expiration (HAS_EXPIRATION unset) are ignored, do not throw, and stay byte-identical to golden', async () => {
    const client = await loadClient({ expiry: 'true' });
    for (const bad of [4, -1, 1.5, Number.NaN, 'DAY', true]) {
      expectFramesEqualGolden(
        encodeAll(client, withExpiry(FIXTURES.modifyPendingNoExp(), bad)),
        GOLDEN.modifyPendingNoExp,
        `modifyPendingNoExp, expiryType=${String(bad)}`,
      );
      expectFramesEqualGolden(
        encodeAll(client, withExpiry(FIXTURES.modifyPendingNoExpExtras(), bad)),
        GOLDEN.modifyPendingNoExpExtras,
        `modifyPendingNoExpExtras, expiryType=${String(bad)}`,
      );
    }
  });
});

// ─── Flag ON: invalid values ─────────────────────────────────────────────────

describe('P07-7b flag ON: an invalid expiryType is refused with the typed client error and never sent', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    delete (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__;
    delete (window as unknown as Record<string, unknown>).rtx5Electron;
  });

  const INVALID: Array<[string, unknown]> = [
    ['4 (above 3)', 4],
    ['255', 255],
    ['256 (wraps to 0 in a byte)', 256],
    ['257 (wraps to 1 in a byte)', 257],
    ['65537', 65537],
    ['-1', -1],
    ['-0.5', -0.5],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ["string '1'", '1'],
    ["string 'DAY'", 'DAY'],
    ['boolean true', true],
  ];

  function expectInvalidExpiryTypeError(fn: () => unknown, client: Client, label: string): void {
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught, `${label}: must throw`).toBeInstanceOf(client.BinaryTcpOrderError);
    const typed = caught as InstanceType<Client['BinaryTcpOrderError']>;
    expect(typed.status, `${label}: status`).toBe(400);
    expect(typed.retryable, `${label}: retryable`).toBe(false);
    expect(typed.code, `${label}: code`).toMatch(/^INVALID_.*EXPIR/);
  }

  it.each(INVALID)('value %s: pending place and pending modify with expiration throw BinaryTcpOrderError (400, not retryable) on every encoder', async (_label, bad) => {
    const client = await loadClient({ expiry: 'true' });
    const targets: Array<[string, Params]> = [
      ['pending place', pendingBare()],
      ['pending place with expiration', FIXTURES.pendingWithExp()],
      ['pending modify with expiration', modifyPendingWithExp()],
    ];
    for (const [name, base] of targets) {
      const params = withExpiry(base, bad) as unknown as BinaryTcpOrderParams;
      expectInvalidExpiryTypeError(() => client.encodeBinaryOrderReq(params), client, `${name} HTTP`);
      expectInvalidExpiryTypeError(() => client.encodeBinaryOrderWsModeAFrame(FIXED_REQ_ID, params), client, `${name} WS A`);
      expectInvalidExpiryTypeError(() => client.encodeBinaryOrderWsModeBFrame(FIXED_REQ_ID, params), client, `${name} WS B`);
    }
  });

  it('valid boundary values 0 and 3 are accepted (the refusal is a range check, not a blanket)', async () => {
    const client = await loadClient({ expiry: 'true' });
    expectOnlyExpiryTlv(encodeAll(client, withExpiry(pendingBare(), 0)), 0, 'v=0');
    expectOnlyExpiryTlv(encodeAll(client, withExpiry(FIXTURES.pendingWithExp(), 3)), 3, 'v=3');
  });

  it('sendBinaryTcpOrder rejects invalid values (4, -1, 1.5, NaN, "1", true) with the typed error and never calls fetch or WebSocket.send', async () => {
    const client = await loadClient({ expiry: 'true' });
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
    (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = {
      BINARY_ORDER_URL: 'http://127.0.0.1:18404/__rtx5_binary_order',
      BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
    };

    try {
      for (const bad of [4, -1, 1.5, Number.NaN, '1', true]) {
        let caught: unknown;
        try {
          await client.sendBinaryTcpOrder({ ...withExpiry(pendingBare(), bad), timeoutMs: 50 } as unknown as BinaryTcpOrderParams);
        } catch (err) {
          caught = err;
        }
        expect(caught, `value ${String(bad)}`).toBeInstanceOf(client.BinaryTcpOrderError);
        const typed = caught as InstanceType<Client['BinaryTcpOrderError']>;
        expect(typed.status).toBe(400);
        expect(typed.retryable).toBe(false);
        expect(typed.code).toMatch(/^INVALID_.*EXPIR/);
      }

      expect(wsSendSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      client.__resetBinaryOrderWsForTests();
    }
  });

  it('flag OFF: the same invalid values are ignored, no error, byte-identical frame', async () => {
    const client = await loadClient({});
    for (const [label, bad] of INVALID) {
      expectFramesEqualGolden(encodeAll(client, withExpiry(pendingBare(), bad)), GOLDEN.pendingBare, `flag OFF, ${label}`);
    }
  });
});

// ─── Flag ON: cross-field (expiryType, expiration) validation ────────────────

describe('P07-7b flag ON: cross-field (expiryType, expiration) invariants throw BinaryTcpOrderError(400, INVALID_EXPIRY_TYPE) and never send', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    delete (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__;
  });

  function expectCrossFieldInvalidError(fn: () => unknown, client: Client, label: string): void {
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught, `${label}: must throw`).toBeInstanceOf(client.BinaryTcpOrderError);
    const typed = caught as InstanceType<Client['BinaryTcpOrderError']>;
    expect(typed.status, `${label}: status`).toBe(400);
    expect(typed.code, `${label}: code`).toBe('INVALID_EXPIRY_TYPE');
    expect(typed.retryable, `${label}: retryable`).toBe(false);
  }

  async function expectSendRefusedWithoutIo(client: Client, params: Params, label: string): Promise<void> {
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
    (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__ = {
      BINARY_ORDER_URL: 'http://127.0.0.1:18404/__rtx5_binary_order',
      BINARY_ORDER_WS_URL: 'ws://127.0.0.1:18404/__rtx5_binary_order_ws',
    };

    try {
      let caught: unknown;
      try {
        await client.sendBinaryTcpOrder({ ...params, timeoutMs: 50 } as unknown as BinaryTcpOrderParams);
      } catch (err) {
        caught = err;
      }
      expect(caught, `${label}: must reject`).toBeInstanceOf(client.BinaryTcpOrderError);
      const typed = caught as InstanceType<Client['BinaryTcpOrderError']>;
      expect(typed.status, `${label}: status`).toBe(400);
      expect(typed.code, `${label}: code`).toBe('INVALID_EXPIRY_TYPE');
      expect(typed.retryable, `${label}: retryable`).toBe(false);
      expect(wsSendSpy, `${label}: WebSocket.send must not run`).not.toHaveBeenCalled();
      expect(fetchSpy, `${label}: fetch must not run`).not.toHaveBeenCalled();
    } finally {
      client.__resetBinaryOrderWsForTests();
    }
  }

  it('refuses placePending with expiryType=0 (GTC) when expiration > 0 across all encoders and sendBinaryTcpOrder', async () => {
    const client = await loadClient({ expiry: 'true' });
    const badCases: Array<[string, Params]> = [
      ['GTC with expiration=1', withExpiry({ ...pendingBare(), expiration: 1 }, 0)],
      ['GTC with pendingWithExp', withExpiry(FIXTURES.pendingWithExp(), 0)],
    ];

    for (const [label, params] of badCases) {
      expectCrossFieldInvalidError(
        () => client.encodeBinaryOrderReq(params as unknown as BinaryTcpOrderParams),
        client,
        `${label} HTTP`,
      );
      expectCrossFieldInvalidError(
        () => client.encodeBinaryOrderWsModeAFrame(FIXED_REQ_ID, params as unknown as BinaryTcpOrderParams),
        client,
        `${label} WS A`,
      );
      expectCrossFieldInvalidError(
        () => client.encodeBinaryOrderWsModeBFrame(FIXED_REQ_ID, params as unknown as BinaryTcpOrderParams),
        client,
        `${label} WS B`,
      );
      await expectSendRefusedWithoutIo(client, params, `${label} send`);
    }
  });

  it('refuses placePending with expiryType=2 (SPECIFIED) or 3 (SPECIFIED_DAY) when expiration <= 0 or omitted', async () => {
    const client = await loadClient({ expiry: 'true' });
    for (const v of [2, 3] as const) {
      const badExps: Array<[string, unknown]> = [
        ['omitted', undefined],
        ['zero', 0],
        ['negative', -10],
      ];
      for (const [expLabel, expValue] of badExps) {
        const base = pendingBare();
        if (expValue !== undefined) {
          base.expiration = expValue;
        }
        const params = withExpiry(base, v);
        const label = `expiryType=${v} with ${expLabel} expiration`;
        expectCrossFieldInvalidError(
          () => client.encodeBinaryOrderReq(params as unknown as BinaryTcpOrderParams),
          client,
          `${label} HTTP`,
        );
        expectCrossFieldInvalidError(
          () => client.encodeBinaryOrderWsModeAFrame(FIXED_REQ_ID, params as unknown as BinaryTcpOrderParams),
          client,
          `${label} WS A`,
        );
        expectCrossFieldInvalidError(
          () => client.encodeBinaryOrderWsModeBFrame(FIXED_REQ_ID, params as unknown as BinaryTcpOrderParams),
          client,
          `${label} WS B`,
        );
        await expectSendRefusedWithoutIo(client, params, `${label} send`);
      }
    }
  });

  it('refuses expiry-setting modifyPending (HAS_EXPIRATION / expiration > 0) with expiryType=0 (GTC)', async () => {
    const client = await loadClient({ expiry: 'true' });
    const params = withExpiry(FIXTURES.modifyPendingWithExp(), 0);
    expectCrossFieldInvalidError(
      () => client.encodeBinaryOrderReq(params as unknown as BinaryTcpOrderParams),
      client,
      'modifyPendingWithExp expiryType=0 HTTP',
    );
    expectCrossFieldInvalidError(
      () => client.encodeBinaryOrderWsModeAFrame(FIXED_REQ_ID, params as unknown as BinaryTcpOrderParams),
      client,
      'modifyPendingWithExp expiryType=0 WS A',
    );
    expectCrossFieldInvalidError(
      () => client.encodeBinaryOrderWsModeBFrame(FIXED_REQ_ID, params as unknown as BinaryTcpOrderParams),
      client,
      'modifyPendingWithExp expiryType=0 WS B',
    );
    await expectSendRefusedWithoutIo(client, params, 'modifyPendingWithExp expiryType=0 send');
  });

  it('positive valid combinations remain accepted: GTC+0, DAY+0, DAY+>0, SPECIFIED+>0, SPECIFIED_DAY+>0, modifyWithExp+(1|2|3)', async () => {
    const client = await loadClient({ expiry: 'true' });
    expectOnlyExpiryTlv(encodeAll(client, withExpiry(pendingBare(), 0)), 0, 'place GTC + 0');
    expectOnlyExpiryTlv(encodeAll(client, withExpiry(pendingBare(), 1)), 1, 'place DAY + 0');
    expectOnlyExpiryTlv(encodeAll(client, withExpiry(FIXTURES.pendingWithExp(), 1)), 1, 'place DAY + >0');
    expectOnlyExpiryTlv(encodeAll(client, withExpiry(FIXTURES.pendingWithExp(), 2)), 2, 'place SPECIFIED + >0');
    expectOnlyExpiryTlv(encodeAll(client, withExpiry(FIXTURES.pendingWithExp(), 3)), 3, 'place SPECIFIED_DAY + >0');
    for (const v of [1, 2, 3] as const) {
      expectOnlyExpiryTlv(encodeAll(client, withExpiry(FIXTURES.modifyPendingWithExp(), v)), v, `modifyWithExp v=${v}`);
    }
  });

  it('flag OFF: inconsistent (expiryType, expiration) pairs are ignored, no error, byte-identical to golden', async () => {
    const client = await loadClient({});
    expectFramesEqualGolden(
      encodeAll(client, withExpiry(FIXTURES.pendingWithExp(), 0)),
      GOLDEN.pendingWithExp,
      'flag OFF GTC + pendingWithExp',
    );
    expectFramesEqualGolden(
      encodeAll(client, withExpiry(pendingBare(), 2)),
      GOLDEN.pendingBare,
      'flag OFF SPECIFIED + expiration=0',
    );
    expectFramesEqualGolden(
      encodeAll(client, withExpiry(pendingBare(), 3)),
      GOLDEN.pendingBare,
      'flag OFF SPECIFIED_DAY + expiration=0',
    );
    expectFramesEqualGolden(
      encodeAll(client, withExpiry(FIXTURES.modifyPendingWithExp(), 0)),
      GOLDEN.modifyPendingWithExp,
      'flag OFF GTC + modifyPendingWithExp',
    );
  });
});

// ─── 0x07 and 0x08 together ──────────────────────────────────────────────────

describe('P07-7b with the P07-3 fill-type TLV 0x07: both flags ON', () => {
  const BOTH = { expiry: 'true', fill: 'true' } as const;
  const byTag = (a: number, b: number): number => a - b;

  it('pending place carries 0x07 and 0x08 once each: HAS_EXTRAS, u16 LE length 6, for every fill x expiry pair', async () => {
    const client = await loadClient(BOTH);
    for (const filling of [0, 1, 2]) {
      for (const v of [0, 1, 2, 3]) {
        const base = v >= 2 ? FIXTURES.pendingWithExp() : pendingBare();
        const frames = encodeAll(client, { ...base, filling, [EXPIRY_PARAM]: v });
        for (const kind of KINDS) {
          const info = inspect(frames[kind], kind);
          expect(info.flags & FLAG_HAS_EXTRAS).toBe(FLAG_HAS_EXTRAS);
          expect(info.extrasLen).toBe(6);
          expect(Array.from(info.extrasBlock!.subarray(0, 2))).toEqual([6, 0]);
          expect([...info.tags].sort(byTag)).toEqual([TAG_FILLING, TAG_EXPIRY_TYPE]);
          expect(rawOf(info.entries, TAG_FILLING)).toEqual([TAG_FILLING, 1, filling]);
          expect(rawOf(info.entries, TAG_EXPIRY_TYPE)).toEqual([TAG_EXPIRY_TYPE, 1, v]);
        }
      }
    }
  });

  it('with the maximum other extras (64-byte comment, magic, trailing stop and step) the block is 94 bytes, <= 512, every tag once', async () => {
    const client = await loadClient(BOTH);
    const frames = encodeAll(client, {
      ...FIXTURES.pendingWithExp(),
      comment: 'c'.repeat(64),
      magic: 777n,
      trailingStop: 50,
      trailingStep: 10,
      filling: 2,
      [EXPIRY_PARAM]: 3,
    });
    for (const kind of KINDS) {
      const info = inspect(frames[kind], kind);
      // (2+64) + (2+8) + (2+4) + (2+4) + (2+1) + (2+1)
      expect(info.extrasLen).toBe(94);
      expect(info.extrasLen).toBeLessThanOrEqual(EXTRAS_MAX_BYTES);
      expect([...info.tags].sort(byTag)).toEqual([
        TAG_COMMENT, TAG_MAGIC, TAG_TRAILING_STOP, TAG_TRAILING_STEP, TAG_FILLING, TAG_EXPIRY_TYPE,
      ]);
      expect(rawOf(info.entries, TAG_FILLING)).toEqual([TAG_FILLING, 1, 2]);
      expect(rawOf(info.entries, TAG_EXPIRY_TYPE)).toEqual([TAG_EXPIRY_TYPE, 1, 3]);
      expect(decodeReqExtrasBlock(info.extrasBlock!).extras.comment).toBe('c'.repeat(64));
    }
  });

  it('market carries only 0x07 (never 0x08); modify with expiration carries only 0x08 (0x07 is place-only); modify without expiration carries neither', async () => {
    const client = await loadClient(BOTH);

    const market = encodeAll(client, { ...marketBare(), filling: 2, [EXPIRY_PARAM]: 1 });
    for (const kind of KINDS) {
      expect(Array.from(inspect(market[kind], kind).extrasBlock!)).toEqual([3, 0, TAG_FILLING, 1, 2]);
    }

    const modifyWith = encodeAll(client, { ...modifyPendingWithExp(), filling: 1, [EXPIRY_PARAM]: 2 });
    expectOnlyExpiryTlv(modifyWith, 2, 'modify with expiration + filling');

    const modifyWithout = encodeAll(client, { ...modifyPendingNoExp(), filling: 1, [EXPIRY_PARAM]: 2 });
    expectFramesEqualGolden(modifyWithout, GOLDEN.modifyPendingNoExp, 'modify without expiration + filling');
  });

  it('the two flags are independent: expiry flag alone never adds 0x07, fill flag alone never adds 0x08', async () => {
    const expiryOnly = await loadClient({ expiry: 'true' });
    const a = encodeAll(expiryOnly, { ...FIXTURES.pendingWithExp(), filling: 1, [EXPIRY_PARAM]: 2 });
    expectOnlyExpiryTlv(a, 2, 'expiry flag only');

    const fillOnly = await loadClient({ fill: 'true' });
    const b = encodeAll(fillOnly, { ...FIXTURES.pendingWithExp(), filling: 1, [EXPIRY_PARAM]: 2 });
    for (const kind of KINDS) {
      expect(Array.from(inspect(b[kind], kind).extrasBlock!)).toEqual([3, 0, TAG_FILLING, 1, 1]);
    }
  });

  it('the dealing decoder skips the unknown 0x08 and still decodes 0x07, comment and magic (T50b, terminal side)', async () => {
    const both = await loadClient(BOTH);
    const fillOnly = await loadClient({ fill: 'true' });
    const params = { ...FIXTURES.pendingExtras(), filling: 1 };
    const withTlv = encodeAll(both, { ...params, [EXPIRY_PARAM]: 1 });
    const without = encodeAll(fillOnly, params);
    for (const kind of KINDS) {
      const infoWith = inspect(withTlv[kind], kind);
      expect(infoWith.tags, `0x08 must really be on the wire [${kind}]`).toContain(TAG_EXPIRY_TYPE);
      const a = decodeReqExtrasBlock(infoWith.extrasBlock!).extras;
      const b = decodeReqExtrasBlock(inspect(without[kind], kind).extrasBlock!).extras;
      expect(a).toEqual(b);
      expect(a.hasFilling).toBe(true);
      expect(a.filling).toBe(1);
      expect(a.comment).toBe('p07-pend');
    }
  });
});

// ─── sendBinaryTcpOrder (the bytes that actually go out) ─────────────────────

describe('P07-7b sendBinaryTcpOrder: the transmitted bytes carry 0x08 (HTTP fallback, no dealing)', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    delete (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__;
    delete (window as unknown as Record<string, unknown>).rtx5Electron;
    vi.restoreAllMocks();
  });

  async function sendOverHttp(client: Client, params: Params): Promise<Uint8Array> {
    const box: { body?: Uint8Array } = {};
    globalThis.WebSocket = createClosedWsClass() as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      box.body = new Uint8Array(init?.body as ArrayBuffer).slice();
      return new Response(buildOkRespBytes(Number(params.action)).slice().buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }) as unknown as typeof fetch;
    client.__resetBinaryOrderWsForTests();
    enableRuntime(null, false);
    try {
      await client.sendBinaryTcpOrder(params as unknown as BinaryTcpOrderParams);
    } finally {
      client.__resetBinaryOrderWsForTests();
    }
    return box.body!;
  }

  it('flag ON: pending place body = golden + 08 01 v; pending modify with expiration carries it; modify without expiration and market do not', async () => {
    const client = await loadClient({ expiry: 'true' });

    const place = await sendOverHttp(client, withExpiry(FIXTURES.pendingWithExp(), 2));
    expect(toHex(place)).toBe(withExtrasTlv(GOLDEN.pendingWithExp, [TAG_EXPIRY_TYPE, 1, 2]).http);

    const modifyWith = await sendOverHttp(client, withExpiry(modifyPendingWithExp(), 3));
    expect(toHex(modifyWith)).toBe(withExtrasTlv(GOLDEN.modifyPendingWithExp, [TAG_EXPIRY_TYPE, 1, 3]).http);

    const modifyWithout = await sendOverHttp(client, withExpiry(modifyPendingNoExp(), 3));
    expect(toHex(modifyWithout)).toBe(GOLDEN.modifyPendingNoExp.http);

    const market = await sendOverHttp(client, withExpiry(marketBare(), 3));
    expect(toHex(market)).toBe(GOLDEN.marketBare.http);
  });

  it('flag OFF: the transmitted body is the unchanged golden even when expiryType is supplied', async () => {
    const client = await loadClient({});
    const place = await sendOverHttp(client, withExpiry(FIXTURES.pendingWithExp(), 2));
    expect(toHex(place)).toBe(GOLDEN.pendingWithExp.http);
    const modifyWith = await sendOverHttp(client, withExpiry(modifyPendingWithExp(), 3));
    expect(toHex(modifyWith)).toBe(GOLDEN.modifyPendingWithExp.http);
  });
});

describe('P07-7b with the dealing client-caps TLV 0x16 present (dealing gate open)', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    delete (window as unknown as Record<string, unknown>).__RTX5_RUNTIME_CONFIG__;
    delete (window as unknown as Record<string, unknown>).rtx5Electron;
    vi.restoreAllMocks();
  });

  const CAPS_RAW = [WIRE_EXTRA_TAG_CLIENT_CAPS, 4, 1, 0, 0, 0];

  it('pre-bound WS: pending place and expiry-setting modify carry 0x08 then the caps TLV; frames with nothing to carry keep the 140-byte dealing fast path', async () => {
    const { client, hooks, dealingClient } = await loadClientWithDealing({ expiry: 'true' });
    const unreg = dealingClient.installDealingOrderClientHooks();
    const sentFrames: Uint8Array[] = [];
    globalThis.WebSocket = createMockOrderWsClass(sentFrames) as unknown as typeof WebSocket;

    const sendAndGetFrame = async (params: Params): Promise<Uint8Array> => {
      sentFrames.length = 0;
      await client.sendBinaryTcpOrder(params as unknown as BinaryTcpOrderParams);
      return orderFrameOf(sentFrames);
    };

    try {
      client.__resetBinaryOrderWsForTests();
      enableRuntime(hooks, true);
      client.ensureBinaryOrderWebSocket();
      client.syncBinaryOrderAuthToken(FIXED_TOKEN);

      // Control: no extras at all -> 140-byte dealing fast path (header + caps).
      expect((await sendAndGetFrame(marketBare())).byteLength).toBe(140);

      for (const v of [0, 1, 2, 3]) {
        const frame = await sendAndGetFrame(withExpiry(v >= 2 ? FIXTURES.pendingWithExp() : pendingBare(), v));
        expect(frame.byteLength).toBe(WS_FAST_SIZE + 2 + 3 + 6); // 143
        const info = inspect(frame, 'wsA');
        expect(info.extrasLen).toBe(9);
        expect(info.tags).toEqual([TAG_EXPIRY_TYPE, WIRE_EXTRA_TAG_CLIENT_CAPS]);
        expect(Array.from(info.entries[0].raw)).toEqual([TAG_EXPIRY_TYPE, 1, v]);
        expect(Array.from(info.entries[1].raw)).toEqual(CAPS_RAW);
        const decoded = decodeReqExtrasBlock(info.extrasBlock!).extras;
        expect(decoded.hasDealingCap).toBe(true);
        expect(decoded.clientCaps).toBe(CLIENT_CAP_DEALING_V1);
      }

      const modifyFrame = await sendAndGetFrame(withExpiry(modifyPendingWithExp(), 3));
      expect(modifyFrame.byteLength).toBe(143);
      const modifyInfo = inspect(modifyFrame, 'wsA');
      expect(modifyInfo.tags).toEqual([TAG_EXPIRY_TYPE, WIRE_EXTRA_TAG_CLIENT_CAPS]);
      expect(Array.from(modifyInfo.entries[0].raw)).toEqual([TAG_EXPIRY_TYPE, 1, 3]);

      // Flag ON but nothing to carry (market, close, modify without expiration): still the zero-extras 140-byte fast path.
      for (const params of [
        withExpiry(marketBare(), 1),
        withExpiry(FIXTURES.closeFull(), 3),
        withExpiry(modifyPendingNoExp(), 2),
        withExpiry(FIXTURES.cancelPending(), 2),
      ]) {
        const frame = await sendAndGetFrame(params);
        expect(frame.byteLength, `action ${String(params.action)}`).toBe(140);
        expect(inspect(frame, 'wsA').tags).toEqual([WIRE_EXTRA_TAG_CLIENT_CAPS]);
      }
    } finally {
      unreg();
      hooks.resetDealingCapabilityState();
      client.__resetBinaryOrderWsForTests();
    }
  });

  it('flag OFF: a supplied expiryType changes nothing, pending place keeps the 140-byte dealing fast path', async () => {
    const { client, hooks, dealingClient } = await loadClientWithDealing({});
    const unreg = dealingClient.installDealingOrderClientHooks();
    const sentFrames: Uint8Array[] = [];
    globalThis.WebSocket = createMockOrderWsClass(sentFrames) as unknown as typeof WebSocket;

    try {
      client.__resetBinaryOrderWsForTests();
      enableRuntime(hooks, true);
      client.ensureBinaryOrderWebSocket();
      client.syncBinaryOrderAuthToken(FIXED_TOKEN);

      for (const params of [
        withExpiry(FIXTURES.pendingWithExp(), 2),
        withExpiry(modifyPendingWithExp(), 3),
        withExpiry(pendingBare(), 1),
      ]) {
        sentFrames.length = 0;
        await client.sendBinaryTcpOrder(params as unknown as BinaryTcpOrderParams);
        const frame = orderFrameOf(sentFrames);
        expect(frame.byteLength, `action ${String(params.action)}`).toBe(140);
        expect(inspect(frame, 'wsA').tags).toEqual([WIRE_EXTRA_TAG_CLIENT_CAPS]);
      }
    } finally {
      unreg();
      hooks.resetDealingCapabilityState();
      client.__resetBinaryOrderWsForTests();
    }
  });

  it('repeated sends with different expiry types never leak one call into the next (1, 2, 1, then 3, then none)', async () => {
    const { client, hooks, dealingClient } = await loadClientWithDealing({ expiry: 'true' });
    const unreg = dealingClient.installDealingOrderClientHooks();
    const sentFrames: Uint8Array[] = [];
    globalThis.WebSocket = createMockOrderWsClass(sentFrames) as unknown as typeof WebSocket;

    try {
      client.__resetBinaryOrderWsForTests();
      enableRuntime(hooks, true);
      client.ensureBinaryOrderWebSocket();
      client.syncBinaryOrderAuthToken(FIXED_TOKEN);

      const extrasRaw: number[][] = [];
      for (const v of [1, 2, 1, 3]) {
        sentFrames.length = 0;
        await client.sendBinaryTcpOrder(
          withExpiry(FIXTURES.pendingWithExp(), v) as unknown as BinaryTcpOrderParams,
        );
        extrasRaw.push(Array.from(inspect(orderFrameOf(sentFrames), 'wsA').extrasBlock!));
      }
      const caps = CAPS_RAW;
      expect(extrasRaw[0]).toEqual([9, 0, TAG_EXPIRY_TYPE, 1, 1, ...caps]);
      expect(extrasRaw[1]).toEqual([9, 0, TAG_EXPIRY_TYPE, 1, 2, ...caps]);
      expect(extrasRaw[2]).toEqual(extrasRaw[0]);
      expect(extrasRaw[3]).toEqual([9, 0, TAG_EXPIRY_TYPE, 1, 3, ...caps]);

      // After carrying 0x08, a plain pending order (no expiryType) carries nothing but the caps.
      sentFrames.length = 0;
      await client.sendBinaryTcpOrder(pendingBare() as unknown as BinaryTcpOrderParams);
      const plain = orderFrameOf(sentFrames);
      expect(plain.byteLength).toBe(140);
      expect(inspect(plain, 'wsA').tags).toEqual([WIRE_EXTRA_TAG_CLIENT_CAPS]);
    } finally {
      unreg();
      hooks.resetDealingCapabilityState();
      client.__resetBinaryOrderWsForTests();
    }
  });

  it('HTTP fallback with the dealing gate open: 0x08 and the caps TLV are both in the body, and the dealing decoder skips 0x08', async () => {
    const { client, hooks, dealingClient } = await loadClientWithDealing({ expiry: 'true' });
    const unreg = dealingClient.installDealingOrderClientHooks();
    globalThis.WebSocket = createClosedWsClass() as unknown as typeof WebSocket;

    const box: { body?: Uint8Array } = {};
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      box.body = new Uint8Array(init?.body as ArrayBuffer).slice();
      return new Response(buildOkRespBytes(ACTION_PLACE_PENDING).slice().buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }) as unknown as typeof fetch;

    try {
      client.__resetBinaryOrderWsForTests();
      enableRuntime(hooks, true);
      await client.sendBinaryTcpOrder(withExpiry(FIXTURES.pendingWithExp(), 2) as unknown as BinaryTcpOrderParams);

      const info = inspect(box.body!, 'http');
      expect(info.extrasLen).toBe(9);
      expect(info.tags).toEqual([TAG_EXPIRY_TYPE, WIRE_EXTRA_TAG_CLIENT_CAPS]);
      expect(Array.from(info.entries[0].raw)).toEqual([TAG_EXPIRY_TYPE, 1, 2]);
      expect(Array.from(info.entries[1].raw)).toEqual(CAPS_RAW);
      const decoded = decodeReqExtrasBlock(info.extrasBlock!).extras;
      expect(decoded.hasDealingCap).toBe(true);
      expect(decoded.clientCaps).toBe(CLIENT_CAP_DEALING_V1);
    } finally {
      unreg();
      hooks.resetDealingCapabilityState();
      client.__resetBinaryOrderWsForTests();
    }
  });
});

// ─── OrderPanelDialog (flag OFF) ─────────────────────────────────────────────

describe('P07-7b T50d OrderPanelDialog with the flag OFF (default): the submit payload is unchanged and has no expiry-type key', () => {
  beforeEach(() => {
    localStorage.setItem('lastLotSize', '0.01');
    useAppStore.getState().reset();
    useAppStore.getState().setTicks({
      XAUUSD: {
        symbol: 'XAUUSD',
        bid: 4173.23,
        ask: 4173.77,
        spread: 0.54,
        timestamp: Date.now(),
        digits: 2,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
  });

  // Keys the dialog hands to onSubmitOrder for a pending Buy Limit today (read from OrderPanelDialog.tsx handleSubmit).
  const TODAY_KEYS_GTC = [
    'comment', 'expiration', 'intentAtMs', 'orderType', 'price', 'stopLimitPrice', 'symbol', 'type', 'volume',
  ];

  it.each(['GTC', 'Today', 'Specified', 'Specified day'] as const)(
    'Buy Limit with expiration %s submits exactly today\'s keys; only expiration and expirationTimestamp describe the expiry',
    async (choice) => {
      vi.unstubAllEnvs(); // flag unset
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 5, 10, 12, 0, 0, 0));

      const onSubmitOrder = vi.fn();
      render(
        createElement(OrderPanelDialog, {
          isOpen: true,
          onClose: vi.fn(),
          symbol: 'XAUUSD',
          currentPrice: { bid: 4173.23, ask: 4173.77 },
          onSubmitOrder,
          symbols: ['XAUUSD'],
        }),
      );

      fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'Buy Limit' } });
      fireEvent.change(screen.getByLabelText('Price'), { target: { value: '4170.00' } });
      if (choice !== 'GTC') {
        fireEvent.change(screen.getByLabelText('Expiration'), { target: { value: choice } });
      }
      if (choice === 'Specified' || choice === 'Specified day') {
        fireEvent.change(screen.getByLabelText('Expiration date:'), { target: { value: '15.06.26 14:30' } });
      }
      fireEvent.click(screen.getAllByRole<HTMLButtonElement>('button', { name: 'Buy' })[0]);
      // Let the async submit handler finish its post-await state updates inside act().
      await act(async () => {
        await Promise.resolve();
      });

      expect(onSubmitOrder).toHaveBeenCalledTimes(1);
      const payload = onSubmitOrder.mock.calls[0][0] as Record<string, unknown>;
      const expectedKeys = choice === 'GTC' ? TODAY_KEYS_GTC : [...TODAY_KEYS_GTC, 'expirationTimestamp'];
      expect(Object.keys(payload).sort()).toEqual([...expectedKeys].sort());
      expect(payload.expiration).toBe(choice);
      expect(payload.orderType).toBe('Buy Limit');
      expect(payload.price).toBe(4170);
      if (choice === 'Today') {
        expect(payload.expirationTimestamp).toBe(Math.floor(new Date(2026, 5, 10, 23, 59, 59, 0).getTime() / 1000));
      } else if (choice === 'Specified') {
        expect(payload.expirationTimestamp).toBe(Math.floor(new Date(2026, 5, 15, 14, 30, 0, 0).getTime() / 1000));
      } else if (choice === 'Specified day') {
        expect(payload.expirationTimestamp).toBe(Math.floor(new Date(2026, 5, 15, 23, 59, 59, 0).getTime() / 1000));
      }
      expect(Object.keys(payload).filter((k) => /expir|expiry/i.test(k)).sort()).toEqual(
        choice === 'GTC' ? ['expiration'] : ['expiration', 'expirationTimestamp'],
      );
    },
  );
});
