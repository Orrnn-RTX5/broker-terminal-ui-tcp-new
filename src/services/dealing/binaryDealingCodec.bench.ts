import { describe, it } from 'vitest';
import {
  CLIENT_CAP_DEALING_V1,
  DEALING_KIND_OPEN,
  MT_RET_REQUEST_PLACED,
  MT_RET_REQUEST_REQUOTE,
  WIRE_ACTION_PLACE_MARKET,
  WIRE_ACTION_REQUOTE_ACCEPT,
  WIRE_DEALING_STATUS_REQUOTED,
  WIRE_FLAG_HAS_EXTRAS,
  WIRE_SIDE_BUY,
  WIRE_STATUS_ACCEPTED,
  appendClientCapsToExtrasTlv,
  createEmptyTradeEventKind7Envelope,
  decodeExecWireTlvInto,
  decodeOrderRespWithExecWire,
  decodeRequoteActionFrameInto,
  decodeTradeEventKind7EnvelopeInto,
  encodeOrderRespFrame,
  encodeRequoteActionFrameInto,
  encodeTradeEventKind7Envelope,
} from './binaryDealingCodec';

const REQ_UUID = '10203040-5060-4780-8090-a0b0c0d0e061';
const RQ_UUID = '10203040-5060-4780-8090-a0b0c0d0e062';

const scratch0x38 = new Uint8Array(512);
const out0x38 = {
  version: 0,
  action: 0,
  side: 0,
  orderSubType: 0,
  flags: 0,
  accountLogin: 0,
  ticket: 0,
  volume: 0,
  price: 0,
  stopLimitPrice: 0,
  sl: 0,
  tp: 0,
  expiration: 0,
  symbol: '',
  clientOrderId: '',
  authToken: '',
  extras: {
    comment: '',
    magic: 0,
    trailingStop: 0,
    hasTrailingStop: false,
    trailingStep: 0,
    hasTrailingStep: false,
    reason: 0,
    hasReason: false,
    filling: 0,
    hasFilling: false,
    priceDeviation: 0,
    hasPriceDeviation: false,
    dealingRequestUuid: '',
    hasDealingRequest: false,
    dealingRequoteUuid: '',
    hasDealingRequote: false,
    clientCaps: 0,
    hasClientCaps: false,
    hasDealingCap: false,
    isExpert: false,
  },
};

const req0x38Input = {
  action: WIRE_ACTION_REQUOTE_ACCEPT as typeof WIRE_ACTION_REQUOTE_ACCEPT,
  side: WIRE_SIDE_BUY,
  flags: WIRE_FLAG_HAS_EXTRAS,
  accountLogin: 100042,
  volume: 1.5,
  price: 1.0846,
  symbol: 'EURUSD',
  clientOrderId: 'bo-123',
  authToken: 'tok-abc',
  requestId: REQ_UUID,
  requoteId: RQ_UUID,
  clientCaps: CLIENT_CAP_DEALING_V1,
};

const resp0x39Frame = encodeOrderRespFrame({
  action: WIRE_ACTION_PLACE_MARKET,
  status: WIRE_STATUS_ACCEPTED,
  symbol: 'EURUSD',
  clientOrderId: 'bo-123',
  errorCode: 'IN_DEALING',
  message: 'Request placed in dealing queue',
  execWire: {
    retcode: MT_RET_REQUEST_PLACED,
    quotedReqId: 0,
    dealerBid: 1.0845,
    dealerAsk: 1.0846,
    requestId: REQ_UUID,
    expiresAtMs: 1795181005000,
    serverNowMs: 1795180995000,
    dealingKind: DEALING_KIND_OPEN,
    requoteId: RQ_UUID,
    digits: 5,
    hasDigits: true,
  },
});
const resp0x39Tail = resp0x39Frame.subarray(decodeOrderRespWithExecWire(resp0x39Frame).msgEndOffset);
const outExecWire = {
  retcode: 0,
  quotedReqId: 0,
  dealerBid: 0,
  dealerAsk: 0,
  requestId: '',
  hasRequestUuid: false,
  expiresAtMs: 0,
  hasExpiresAtMs: false,
  serverNowMs: 0,
  hasServerNowMs: false,
  dealingKind: 0,
  hasDealingKind: false,
  requoteId: '',
  hasRequoteUuid: false,
  digits: 0,
  hasDigits: false,
  dealingEnabled: false,
  hasDealingEnabled: false,
};

const env0x3AFrame = encodeTradeEventKind7Envelope(100042, 1795180995000, 'dealing.100042', {
  status: WIRE_DEALING_STATUS_REQUOTED,
  kind: DEALING_KIND_OPEN,
  side: WIRE_SIDE_BUY,
  digits: 5,
  retcode: MT_RET_REQUEST_REQUOTE,
  seq: 2,
  volume: 1.5,
  price: 1.0845,
  bid: 1.0846,
  ask: 1.08475,
  expiresAtMs: 1795181000000,
  serverNowMs: 1795180995000,
  requestId: REQ_UUID,
  requoteId: RQ_UUID,
  symbol: 'EURUSD',
  clientOrderId: 'bo-123',
  reasonCode: 'OFF_QUOTES',
  reasonText: 'Off quotes — market price unavailable',
});

const env0x3AOut = createEmptyTradeEventKind7Envelope();

describe('binaryDealingCodec hot-path benchmarks', () => {
  it('measures codec hot paths', async ({ bench }) => {
    await bench(
      'TLV 0x16 empty order capability (0-alloc singleton)',
      () => {
        appendClientCapsToExtrasTlv(null);
      },
    ).run({ time: 200 });

    await bench(
      '0x38 Action 9 encode+decode into preallocated buffer',
      () => {
        const n = encodeRequoteActionFrameInto(scratch0x38, 0, req0x38Input);
        decodeRequoteActionFrameInto(scratch0x38.subarray(0, n), out0x38);
      },
    ).run({ time: 200 });

    await bench(
      '0x39 ExecWire TLV decode into reused object',
      () => {
        decodeExecWireTlvInto(resp0x39Tail, outExecWire);
      },
    ).run({ time: 200 });

    await bench(
      '0x3A EventKind=7 full envelope zero-alloc decodeInto',
      () => {
        decodeTradeEventKind7EnvelopeInto(env0x3AFrame, env0x3AOut);
      },
    ).run({ time: 200 });
  });
});
