import { describe, expect, it } from 'vitest';
import {
  CLIENT_CAPS_DEALING_V1_TLV,
  CLIENT_CAP_DEALING_V1,
  DEALING_KIND_CLOSE,
  DEALING_KIND_OPEN,
  DealingWireCodecError,
  MAX_REASON_TEXT_BYTES,
  MT_RET_REQUEST_PLACED,
  MT_RET_REQUEST_REJECTED,
  MT_RET_REQUEST_REQUOTE,
  ORDER_REASON_CLIENT,
  ORDER_REASON_EXPERT,
  WIRE_ACTION_DEALING_SYNC,
  WIRE_ACTION_PLACE_MARKET,
  WIRE_ACTION_REQUOTE_ACCEPT,
  WIRE_ACTION_REQUOTE_DECLINE,
  WIRE_DEALING_EVENT_HEADER_SIZE,
  WIRE_DEALING_EVENT_MIN_SIZE,
  WIRE_DEALING_EVENT_SUB_VERSION,
  WIRE_DEALING_STATUS_IN_DEALING,
  WIRE_DEALING_STATUS_REJECTED,
  WIRE_DEALING_STATUS_REQUOTED,
  WIRE_EXTRA_TAG_CLIENT_CAPS,
  WIRE_EXTRA_TAG_DEALING_REQUEST_UUID,
  WIRE_EXTRA_TAG_DEALING_REQUOTE_UUID,
  WIRE_FLAG_HAS_EXTRAS,
  WIRE_ORDER_EXTRAS_MAX_BYTES,
  WIRE_ORDER_REQ_HEADER_SIZE,
  WIRE_ORDER_RESP_HEADER_SIZE,
  WIRE_RESP_TAG_DEALING_ENABLED,
  WIRE_RESP_TAG_RETCODE,
  WIRE_SIDE_BUY,
  WIRE_SIDE_NONE,
  WIRE_SIDE_SELL,
  WIRE_STATUS_ACCEPTED,
  WIRE_STATUS_OK,
  WIRE_TRADE_EVENT_KIND_DEALING,
  appendClientCapsToExtrasTlv,
  createEmptyDealingStatusEvent,
  createEmptyExecWire,
  createEmptyExtras,
  createEmptyTradeEventKind7Envelope,
  decodeDealingStatusEvent,
  decodeDealingStatusEventInto,
  decodeDealingSyncFrame,
  decodeExecWireTlv,
  decodeExecWireTlvInto,
  decodeOrderRespTrailingExecWire,
  decodeOrderRespWithExecWire,
  decodeReqExtrasBlock,
  decodeReqExtrasBlockInto,
  decodeRequoteActionFrame,
  decodeTradeEventKind7Envelope,
  decodeTradeEventKind7EnvelopeInto,
  decodeTradeEventKind7EnvelopeIntoRange,
  encodeAccountSubFrame0x3B,
  encodeClientCapsTlv,
  encodeDealingStatusEvent,
  encodeDealingSyncFrame,
  encodeDealingSyncRespFrame,
  encodeExecWireTlv,
  encodeOrderRespFrame,
  encodeReqExtrasBlock,
  encodeRequoteActionFrame,
  encodeTradeEventKind7Envelope,
  execWireTlvByteLength,
  formatConfirmClientOrderId,
  formatUuidBytes,
  parseUuidBytes,
} from './binaryDealingCodec';
import { getDealingReasonDefaultMessage } from './dealingReasonMessages';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.byteLength; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Fixed golden hex vectors mirroring Go wire_req.go / wire_resp.go / wire_event.go byte-for-byte.
const GOLDEN_HEX_0X16_CAP = '160401000000';
const GOLDEN_HEX_0X38_ACTION9_BUY =
  '0109010000040000ca8601000000000000000000000000000000000000000440d0b359f5b95af13f'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '45555255534400000000000000000000'
  + '626f2d7265712d310000000000000000000000000000000000000000000000000000000000000000'
  + '0d006a77742d746f6b656e2d6162632d00'
  + '060100141010203040506047808090a0b0c0d0e001151010203040506047808090a0b0c0d0e002160401000000';
const GOLDEN_HEX_0X38_ACTION10_SELL =
  '010a020000040000ca86010000000000000000000000000000000000000004400000000000000000'
  + '0000000000000000000000000000000000000000000000000000000000000000'
  + '45555255534400000000000000000000'
  + '626f2d7265712d310000000000000000000000000000000000000000000000000000000000000000'
  + '0d006a77742d746f6b656e2d6162632d00'
  + '060100141010203040506047808090a0b0c0d0e001151010203040506047808090a0b0c0d0e002160401000000';
const GOLDEN_HEX_0X39_IN_DEALING =
  '0101ca002a0000000000000000000000000000000000000000000000000000000000000000000000'
  + '00000000000004400000000000000000000000000000000000000000000000000000000000000000'
  + '45555255534400000000000000000000'
  + '626f2d636c69656e742d310000000000000000000000000000000000000000000000000000000000'
  + '0a00494e5f4445414c494e471f005265717565737420706c6163656420696e206465616c696e67207175657565'
  + '200418270000210800000000000000002208273108ac1c5af13f2308ed2aa4fca45af13f'
  + '241010203040506047808090a0b0c0d0e021'
  + '2508404920f9a10100002608302220f9a1010000270101281010203040506047808090a0b0c0d0e022290105';
const GOLDEN_HEX_0X3A_KIND7_ENV =
  '0107ca86010000000000302220f9a10100000e006465616c696e672e3130303034320b01'
  + '01020101050000001427000002000000'
  + '0000000000000000000000000000000000000000000000000000000000000000000000000000fc3f'
  + '0ababda4315af13f98dd9387855af13f4260e5d0225bf13f000000000000000000000000000015c0'
  + '48e17a14ae47f13f46b6f3fdd478f13fb83520f9a1010000302220f9a1010000'
  + '10203040506047808090a0b0c0d0e03110203040506047808090a0b0c0d0e032'
  + '45555255534400000000000000000000'
  + '626f2d636c692d373700000000000000000000000000000000000000000000000000000000000000'
  + '0a4f46465f51554f544553'
  + '274f66662071756f74657320e28094206d61726b657420707269636520756e617661696c61626c65';
const GOLDEN_HEX_0X3B_ACCOUNT_SUB = 'ca8601000000000007006a77742d616263';

// Mirrors wire_codec_test.go:testUUID(b)
function testUuidBytes(b: number): Uint8Array {
  return new Uint8Array([
    0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x47, 0x80,
    0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0, b & 0xff,
  ]);
}

function testUuid(b: number): string {
  return formatUuidBytes(testUuidBytes(b), 0);
}

describe('binaryDealingCodec (byte-exact parity with Go wire_codec.go)', () => {
  it('parses/formats UUIDs and builds D3 deterministic confirm ClientOrderID (dl-<uuid>)', () => {
    const uuid = testUuid(0x7f);
    expect(uuid).toBe('10203040-5060-4780-8090-a0b0c0d0e07f');
    expect(Array.from(parseUuidBytes(uuid))).toEqual(Array.from(testUuidBytes(0x7f)));

    const confirmId = formatConfirmClientOrderId(uuid);
    expect(confirmId).toBe('dl-10203040-5060-4780-8090-a0b0c0d0e07f');
    expect(confirmId.length).toBe(39);
  });

  it('encodes capability TLV 0x16 as zero-alloc 6-byte singleton and appends cleanly to existing extras', () => {
    const capTlv = encodeClientCapsTlv();
    expect(capTlv).toBe(CLIENT_CAPS_DEALING_V1_TLV);
    expect(Array.from(capTlv)).toEqual([WIRE_EXTRA_TAG_CLIENT_CAPS, 4, 1, 0, 0, 0]);

    expect(appendClientCapsToExtrasTlv(null)).toBe(CLIENT_CAPS_DEALING_V1_TLV);
    expect(appendClientCapsToExtrasTlv(new Uint8Array(0))).toBe(CLIENT_CAPS_DEALING_V1_TLV);

    // Existing comment TLV [0x01, 2, 'h', 'i'] + 0x16 cap
    const base = new Uint8Array([0x01, 2, 0x68, 0x69]);
    const withCap = appendClientCapsToExtrasTlv(base);
    expect(Array.from(withCap)).toEqual([0x01, 2, 0x68, 0x69, 0x16, 4, 1, 0, 0, 0]);

    // Idempotent when exact same 0x16 already present
    expect(appendClientCapsToExtrasTlv(withCap)).toBe(withCap);

    // Exceeding 512-byte cap throws WIRE_FRAME_TOO_LARGE
    const oversized = new Uint8Array([0x7a, 250, ...new Array(250).fill(1), 0x7b, 255, ...new Array(255).fill(2)]);
    expect(() => appendClientCapsToExtrasTlv(oversized)).toThrow(DealingWireCodecError);
  });

  it('round-trips 0x38 Actions 9 (Accept) and 10 (Decline) matching Go TestRequoteActions9And10RoundTrip', () => {
    const reqUuid = testUuid(0x01);
    const rqUuid = testUuid(0x02);

    const cases = [
      { name: 'accept_buy', action: WIRE_ACTION_REQUOTE_ACCEPT, side: WIRE_SIDE_BUY, price: 1.08465 },
      { name: 'decline_sell', action: WIRE_ACTION_REQUOTE_DECLINE, side: WIRE_SIDE_SELL, price: 0 },
    ] as const;

    for (const tc of cases) {
      const frame = encodeRequoteActionFrame({
        action: tc.action,
        side: tc.side,
        flags: WIRE_FLAG_HAS_EXTRAS,
        accountLogin: 100042,
        ticket: 0,
        volume: 2.5,
        price: tc.price,
        expiration: 0,
        symbol: 'eurusd',
        clientOrderId: 'bo-req-1',
        authToken: 'jwt-token-abc',
        requestId: reqUuid,
        requoteId: rqUuid,
        reason: ORDER_REASON_CLIENT,
        clientCaps: CLIENT_CAP_DEALING_V1,
      });

      // Verify exact byte positions against Go AppendRequoteActionFrame
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      expect(frame[0], tc.name).toBe(1);
      expect(frame[1], tc.name).toBe(tc.action);
      expect(frame[2], tc.name).toBe(tc.side);
      expect(view.getUint16(4, true) & WIRE_FLAG_HAS_EXTRAS, tc.name).toBe(WIRE_FLAG_HAS_EXTRAS);
      expect(Number(view.getBigInt64(8, true)), tc.name).toBe(100042);
      expect(Number(view.getBigInt64(16, true)), tc.name).toBe(0); // Ticket=0 (D4)
      expect(view.getFloat64(24, true), tc.name).toBe(2.5);
      expect(view.getFloat64(32, true), tc.name).toBe(tc.price);
      expect(Number(view.getBigInt64(64, true)), tc.name).toBe(0); // Expiration=0 (D4)

      const decoded = decodeRequoteActionFrame(frame);
      expect(decoded.action).toBe(tc.action);
      expect(decoded.side).toBe(tc.side);
      expect(decoded.accountLogin).toBe(100042);
      expect(decoded.ticket).toBe(0);
      expect(decoded.expiration).toBe(0);
      expect(decoded.price).toBe(tc.price);
      expect(decoded.symbol).toBe('EURUSD');
      expect(decoded.clientOrderId).toBe('bo-req-1');
      expect(decoded.authToken).toBe('jwt-token-abc');
      expect(decoded.extras.dealingRequestUuid).toBe(reqUuid);
      expect(decoded.extras.dealingRequoteUuid).toBe(rqUuid);
      expect(decoded.extras.hasDealingCap).toBe(true);
      expect(decoded.extras.reason).toBe(ORDER_REASON_CLIENT);
    }
  });

  it('enforces D4 validation on 0x38 Actions 9/10 (Ticket=0, Expiration=0, Price, 0x14/0x15)', () => {
    const base = {
      action: WIRE_ACTION_REQUOTE_ACCEPT,
      side: WIRE_SIDE_BUY,
      accountLogin: 100042,
      volume: 1.0,
      price: 1.0846,
      requestId: testUuid(0x11),
      requoteId: testUuid(0x12),
    } as const;

    expect(() => encodeRequoteActionFrame(base)).not.toThrow();
    expect(() => encodeRequoteActionFrame({ ...base, ticket: 999 })).toThrow(DealingWireCodecError);
    expect(() => encodeRequoteActionFrame({ ...base, expiration: 123456 })).toThrow(DealingWireCodecError);
    expect(() => encodeRequoteActionFrame({ ...base, price: 0 })).toThrow(DealingWireCodecError);
    expect(() => encodeRequoteActionFrame({ ...base, price: Number.NaN })).toThrow(DealingWireCodecError);
    expect(() => encodeRequoteActionFrame({ ...base, action: WIRE_ACTION_REQUOTE_DECLINE, price: 1.0846 })).toThrow(DealingWireCodecError);
    expect(() => encodeRequoteActionFrame({ ...base, requestId: '00000000-0000-0000-0000-000000000000' })).toThrow(DealingWireCodecError);
    expect(() => encodeRequoteActionFrame({ ...base, requoteId: 'bad-uuid' })).toThrow(DealingWireCodecError);
  });

  it('skips unknown 0x38 extra TLVs and rejects duplicate tags', () => {
    const blk = encodeReqExtrasBlock({
      reason: ORDER_REASON_EXPERT,
      hasReason: true,
      priceDeviation: 15,
      hasPriceDeviation: true,
      clientCaps: CLIENT_CAP_DEALING_V1,
      hasClientCaps: true,
      comment: 'algo-entry',
    });

    const { extras, bytesRead } = decodeReqExtrasBlock(blk);
    expect(bytesRead).toBe(blk.byteLength);
    expect(extras.isExpert).toBe(true);
    expect(extras.hasDealingCap).toBe(true);
    expect(extras.priceDeviation).toBe(15);
    expect(extras.comment).toBe('algo-entry');

    // Inject unknown tag 0x7A (len 3) — decoder skips cleanly
    const origPayload = blk.subarray(2);
    const withUnknown = new Uint8Array(2 + origPayload.byteLength + 5);
    new DataView(withUnknown.buffer).setUint16(0, origPayload.byteLength + 5, true);
    withUnknown.set(origPayload, 2);
    withUnknown.set([0x7a, 3, 1, 2, 3], 2 + origPayload.byteLength);
    expect(() => decodeReqExtrasBlock(withUnknown)).not.toThrow();

    // Duplicate tag 0x16 fails with INVALID_WIRE_FRAME
    const withDup = new Uint8Array(2 + origPayload.byteLength + 5 + 6);
    new DataView(withDup.buffer).setUint16(0, origPayload.byteLength + 5 + 6, true);
    withDup.set(withUnknown.subarray(2), 2);
    withDup.set([WIRE_EXTRA_TAG_CLIENT_CAPS, 4, 1, 0, 0, 0], 2 + origPayload.byteLength + 5);
    expect(() => decodeReqExtrasBlock(withDup)).toThrow(DealingWireCodecError);
  });

  it('decodes 0x39 trailing ExecWire TLVs 0x20..0x29 and preserves msgEnd legacy parser boundary', () => {
    const reqId = testUuid(0x21);
    const rqId = testUuid(0x22);

    const execWire = {
      retcode: MT_RET_REQUEST_PLACED,
      quotedReqId: 0,
      dealerBid: 1.0845,
      dealerAsk: 1.08463,
      requestId: reqId,
      expiresAtMs: 1795181005120,
      serverNowMs: 1795180995120,
      dealingKind: DEALING_KIND_OPEN,
      requoteId: rqId,
      digits: 5,
      hasDigits: true,
    };
    const frame = encodeOrderRespFrame({
      action: WIRE_ACTION_PLACE_MARKET,
      status: WIRE_STATUS_ACCEPTED,
      execMicros: 42,
      orderTicket: 0,
      volume: 2.5,
      symbol: 'EURUSD',
      clientOrderId: 'bo-client-1',
      errorCode: 'IN_DEALING',
      message: 'Request placed in dealing queue',
      execWire,
    });

    const decoded = decodeOrderRespWithExecWire(frame);
    expect(decoded.status).toBe(WIRE_STATUS_ACCEPTED);
    expect(decoded.ok).toBe(true);
    expect(decoded.orderTicket).toBe(0);
    expect(decoded.errorCode).toBe('IN_DEALING');
    expect(decoded.message).toBe('Request placed in dealing queue');
    expect(decoded.msgEndOffset).toBeGreaterThan(WIRE_ORDER_RESP_HEADER_SIZE);
    expect(frame[decoded.msgEndOffset]).toBe(WIRE_RESP_TAG_RETCODE);
    expect(execWireTlvByteLength(execWire)).toBe(98);
    expect(frame.byteLength - decoded.msgEndOffset).toBe(98);

    expect(decoded.execWire).not.toBeNull();
    expect(decoded.execWire!.retcode).toBe(MT_RET_REQUEST_PLACED);
    expect(decoded.execWire!.quotedReqId).toBe(0);
    expect(decoded.execWire!.dealerBid).toBe(1.0845);
    expect(decoded.execWire!.dealerAsk).toBe(1.08463);
    expect(decoded.execWire!.requestId).toBe(reqId);
    expect(decoded.execWire!.expiresAtMs).toBe(1795181005120);
    expect(decoded.execWire!.serverNowMs).toBe(1795180995120);
    expect(decoded.execWire!.dealingKind).toBe(DEALING_KIND_OPEN);
    expect(decoded.execWire!.requoteId).toBe(rqId);
    expect(decoded.execWire!.digits).toBe(5);
    expect(decoded.execWire!.hasDigits).toBe(true);

    expect(decodeOrderRespTrailingExecWire(frame)).toEqual(decoded.execWire);

    // Frame without trailing TLVs returns null execWire
    const plain = encodeOrderRespFrame({
      action: WIRE_ACTION_PLACE_MARKET,
      status: 200,
      orderTicket: 1001,
      symbol: 'EURUSD',
      clientOrderId: 'bo-plain',
    });
    expect(decodeOrderRespTrailingExecWire(plain)).toBeNull();

    // Unknown trailing TLV skipped cleanly
    const withUnknown = new Uint8Array(frame.byteLength + 4);
    withUnknown.set(frame);
    withUnknown.set([0x7f, 2, 0xaa, 0xbb], frame.byteLength);
    expect(decodeOrderRespTrailingExecWire(withUnknown)?.retcode).toBe(MT_RET_REQUEST_PLACED);
  });

  it('round-trips 0x3A EventKind=7 (216B header + strings) for sides 0, 1, 2', () => {
    const reqId = testUuid(0x31);
    const rqId = testUuid(0x32);
    const reasonText = getDealingReasonDefaultMessage('OFF_QUOTES');

    for (const side of [WIRE_SIDE_NONE, WIRE_SIDE_BUY, WIRE_SIDE_SELL]) {
      const evInput = {
        subVersion: WIRE_DEALING_EVENT_SUB_VERSION,
        status: WIRE_DEALING_STATUS_REQUOTED,
        kind: DEALING_KIND_OPEN,
        side,
        digits: 5,
        retcode: MT_RET_REQUEST_REQUOTE,
        seq: 2,
        quotedReqId: 0,
        orderTicket: 0,
        positionTicket: 0,
        dealTicket: 0,
        volume: 1.75,
        price: 1.08452,
        bid: 1.0846,
        ask: 1.08475,
        profit: 0,
        commission: -5.25,
        sl: 1.08,
        tp: 1.092,
        expiresAtMs: 1795181000120,
        serverNowMs: 1795180995120,
        requestId: reqId,
        requoteId: rqId,
        symbol: 'EURUSD',
        clientOrderId: 'bo-cli-77',
        reasonCode: 'OFF_QUOTES',
        reasonText,
      };

      const raw = encodeDealingStatusEvent(evInput);
      const rcLen = new TextEncoder().encode('OFF_QUOTES').byteLength;
      const rtLen = new TextEncoder().encode(reasonText).byteLength;
      expect(raw.byteLength).toBe(WIRE_DEALING_EVENT_MIN_SIZE + rcLen + rtLen);
      expect(raw[0]).toBe(1);
      expect(raw[1]).toBe(WIRE_DEALING_STATUS_REQUOTED);
      expect(raw[3]).toBe(side);
      expect(raw[216]).toBe(rcLen);

      const decoded = decodeDealingStatusEvent(raw);
      expect(decoded.subVersion).toBe(1);
      expect(decoded.status).toBe(WIRE_DEALING_STATUS_REQUOTED);
      expect(decoded.kind).toBe(DEALING_KIND_OPEN);
      expect(decoded.side).toBe(side);
      expect(decoded.digits).toBe(5);
      expect(decoded.retcode).toBe(MT_RET_REQUEST_REQUOTE);
      expect(decoded.seq).toBe(2);
      expect(decoded.volume).toBe(1.75);
      expect(decoded.price).toBe(1.08452);
      expect(decoded.bid).toBe(1.0846);
      expect(decoded.ask).toBe(1.08475);
      expect(decoded.commission).toBe(-5.25);
      expect(decoded.expiresAtMs).toBe(1795181000120);
      expect(decoded.serverNowMs).toBe(1795180995120);
      expect(decoded.requestId).toBe(reqId);
      expect(decoded.requoteId).toBe(rqId);
      expect(decoded.hasRequoteId).toBe(true);
      expect(decoded.symbol).toBe('EURUSD');
      expect(decoded.clientOrderId).toBe('bo-cli-77');
      expect(decoded.reasonCode).toBe('OFF_QUOTES');
      expect(decoded.reasonText).toBe(reasonText);

      const env = encodeTradeEventKind7Envelope(100042, 1795180995120, 'dealing.100042', evInput);
      const decodedEnv = decodeTradeEventKind7Envelope(env);
      expect(decodedEnv.version).toBe(1);
      expect(decodedEnv.eventKind).toBe(WIRE_TRADE_EVENT_KIND_DEALING);
      expect(decodedEnv.accountLogin).toBe(100042);
      expect(decodedEnv.timestampMs).toBe(1795180995120);
      expect(decodedEnv.channel).toBe('dealing.100042');
      expect(decodedEnv.event).toEqual(decoded);
    }
  });

  it('rejects truncated/malformed frames across 0x38, 0x39 ExecWire, and 0x3A Kind 7 (fuzz table)', () => {
    // 1. Exhaustive truncation for 0x38 Action 9 frame
    const reqFrame = encodeRequoteActionFrame({
      action: WIRE_ACTION_REQUOTE_ACCEPT,
      side: WIRE_SIDE_BUY,
      accountLogin: 555,
      volume: 1.0,
      price: 1.25,
      symbol: 'GBPUSD',
      clientOrderId: 'c1',
      authToken: 'tok',
      requestId: testUuid(0x41),
      requoteId: testUuid(0x42),
    });
    for (let cut = 0; cut < reqFrame.byteLength; cut++) {
      expect(() => decodeRequoteActionFrame(reqFrame.subarray(0, cut)), `0x38 cut=${cut}`).toThrow();
    }
    const badVer = new Uint8Array(reqFrame);
    badVer[0] = 99;
    expect(() => decodeRequoteActionFrame(badVer)).toThrow(/version/i);

    // 2. Exhaustive truncation for 0x39 ExecWire TLV (matches Go wire_codec_test.go:426-437)
    const execTail = encodeExecWireTlv({
      retcode: MT_RET_REQUEST_REQUOTE,
      quotedReqId: 0,
      dealerBid: 1.2,
      dealerAsk: 1.21,
      requestId: testUuid(0x43),
      expiresAtMs: 1000,
      serverNowMs: 500,
      dealingKind: DEALING_KIND_OPEN,
      requoteId: testUuid(0x44),
      digits: 5,
      hasDigits: true,
    });
    const validBoundaryCuts = new Set([6, 16, 26, 36, 54, 64, 74, 77, 95]);
    for (let cut = 0; cut < execTail.byteLength; cut++) {
      if (validBoundaryCuts.has(cut)) {
        expect(() => decodeExecWireTlv(execTail.subarray(0, cut)), `0x39 cut=${cut}`).not.toThrow();
      } else {
        expect(() => decodeExecWireTlv(execTail.subarray(0, cut)), `0x39 cut=${cut}`).toThrow(DealingWireCodecError);
      }
    }

    // 3. Exhaustive truncation for 0x3A Kind 7 envelope + payload
    const envFrame = encodeTradeEventKind7Envelope(100042, 1700000000000, 'dealing.100042', {
      status: WIRE_DEALING_STATUS_REJECTED,
      kind: DEALING_KIND_CLOSE,
      side: WIRE_SIDE_SELL,
      digits: 2,
      retcode: MT_RET_REQUEST_REJECTED,
      requestId: testUuid(0x45),
      symbol: 'XAUUSD',
      reasonCode: 'RISK_LIMIT',
      reasonText: getDealingReasonDefaultMessage('RISK_LIMIT'),
    });
    for (let cut = 0; cut < envFrame.byteLength; cut++) {
      expect(() => decodeTradeEventKind7Envelope(envFrame.subarray(0, cut)), `0x3A env cut=${cut}`).toThrow();
    }

    // Invalid Side = 3 on 0x3A payload
    const rawEv = encodeDealingStatusEvent({
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      requestId: testUuid(0x46),
    });
    expect(WIRE_DEALING_EVENT_HEADER_SIZE).toBe(216);
    rawEv[3] = 3;
    expect(() => decodeDealingStatusEvent(rawEv)).toThrow(DealingWireCodecError);

    // ReasonText > 200 bytes rejected
    expect(() => encodeDealingStatusEvent({
      status: WIRE_DEALING_STATUS_REJECTED,
      requestId: testUuid(0x47),
      reasonText: 'a'.repeat(MAX_REASON_TEXT_BYTES + 1),
    })).toThrow(DealingWireCodecError);

    // Zero UUIDs allowed in EventKind 7 RequoteUUID slot -> hasRequoteId=false
    const zeroRqRaw = encodeDealingStatusEvent({
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      requestId: testUuid(0x48),
      symbol: 'EURUSD',
    });
    const decodedZeroRq = decodeDealingStatusEvent(zeroRqRaw);
    expect(decodedZeroRq.hasRequoteId).toBe(false);
    expect(decodedZeroRq.requoteId).toBe('');
  });

  it('encodes 0x3B binary account subscription frame ([i64 login][u16 tokenLen][token])', () => {
    const pkt = encodeAccountSubFrame0x3B(100042, 'jwt-abc');
    expect(pkt.byteLength).toBe(10 + 7);
    const view = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(Number(view.getBigInt64(0, true))).toBe(100042);
    expect(view.getUint16(8, true)).toBe(7);
    expect(new TextDecoder().decode(pkt.subarray(10))).toBe('jwt-abc');

    const unbind = encodeAccountSubFrame0x3B(0);
    expect(unbind.byteLength).toBe(10);
    expect(WIRE_ORDER_EXTRAS_MAX_BYTES).toBe(512);
    expect(WIRE_ORDER_REQ_HEADER_SIZE).toBe(128);
    expect(WIRE_EXTRA_TAG_DEALING_REQUEST_UUID).toBe(0x14);
    expect(WIRE_EXTRA_TAG_DEALING_REQUOTE_UUID).toBe(0x15);
  });

  it('matches all 6 cross-language Go golden hex vectors byte-for-byte on encode and decode', () => {
    // 1. 0x16 capability TLV
    const capTlv = encodeClientCapsTlv(CLIENT_CAP_DEALING_V1);
    expect(bytesToHex(capTlv)).toBe(GOLDEN_HEX_0X16_CAP);

    // 2. 0x38 Action 9 BUY
    const f0x38Buy = encodeRequoteActionFrame({
      action: WIRE_ACTION_REQUOTE_ACCEPT,
      side: WIRE_SIDE_BUY,
      flags: WIRE_FLAG_HAS_EXTRAS,
      accountLogin: 100042,
      ticket: 0,
      volume: 2.5,
      price: 1.08465,
      expiration: 0,
      symbol: 'eurusd',
      clientOrderId: 'bo-req-1',
      authToken: 'jwt-token-abc',
      reason: ORDER_REASON_CLIENT,
      requestId: testUuid(0x01),
      requoteId: testUuid(0x02),
      clientCaps: CLIENT_CAP_DEALING_V1,
    });
    expect(bytesToHex(f0x38Buy)).toBe(GOLDEN_HEX_0X38_ACTION9_BUY);
    const decBuy = decodeRequoteActionFrame(hexToBytes(GOLDEN_HEX_0X38_ACTION9_BUY));
    expect(decBuy.action).toBe(WIRE_ACTION_REQUOTE_ACCEPT);
    expect(decBuy.price).toBe(1.08465);
    expect(decBuy.symbol).toBe('EURUSD');
    expect(decBuy.extras.dealingRequestUuid).toBe(testUuid(0x01));

    // 3. 0x38 Action 10 SELL
    const f0x38Sell = encodeRequoteActionFrame({
      action: WIRE_ACTION_REQUOTE_DECLINE,
      side: WIRE_SIDE_SELL,
      flags: WIRE_FLAG_HAS_EXTRAS,
      accountLogin: 100042,
      ticket: 0,
      volume: 2.5,
      price: 0,
      expiration: 0,
      symbol: 'eurusd',
      clientOrderId: 'bo-req-1',
      authToken: 'jwt-token-abc',
      reason: ORDER_REASON_CLIENT,
      requestId: testUuid(0x01),
      requoteId: testUuid(0x02),
      clientCaps: CLIENT_CAP_DEALING_V1,
    });
    expect(bytesToHex(f0x38Sell)).toBe(GOLDEN_HEX_0X38_ACTION10_SELL);
    const decSell = decodeRequoteActionFrame(hexToBytes(GOLDEN_HEX_0X38_ACTION10_SELL));
    expect(decSell.action).toBe(WIRE_ACTION_REQUOTE_DECLINE);
    expect(decSell.price).toBe(0);

    // 4. 0x39 202 IN_DEALING + ExecWire 0x20..0x29
    const f0x39 = encodeOrderRespFrame({
      action: WIRE_ACTION_PLACE_MARKET,
      status: WIRE_STATUS_ACCEPTED,
      execMicros: 42,
      orderTicket: 0,
      volume: 2.5,
      symbol: 'EURUSD',
      clientOrderId: 'bo-client-1',
      errorCode: 'IN_DEALING',
      message: 'Request placed in dealing queue',
      execWire: {
        retcode: MT_RET_REQUEST_PLACED,
        quotedReqId: 0,
        dealerBid: 1.0845,
        dealerAsk: 1.08463,
        requestId: testUuid(0x21),
        expiresAtMs: 1795181005120,
        serverNowMs: 1795180995120,
        dealingKind: DEALING_KIND_OPEN,
        requoteId: testUuid(0x22),
        digits: 5,
        hasDigits: true,
      },
    });
    expect(bytesToHex(f0x39)).toBe(GOLDEN_HEX_0X39_IN_DEALING);
    const dec0x39 = decodeOrderRespWithExecWire(hexToBytes(GOLDEN_HEX_0X39_IN_DEALING));
    expect(dec0x39.status).toBe(WIRE_STATUS_ACCEPTED);
    expect(dec0x39.execWire?.requestId).toBe(testUuid(0x21));
    expect(dec0x39.execWire?.requoteId).toBe(testUuid(0x22));

    // 5. 0x3A EventKind=7 full envelope
    const f0x3A = encodeTradeEventKind7Envelope(100042, 1795180995120, 'dealing.100042', {
      subVersion: WIRE_DEALING_EVENT_SUB_VERSION,
      status: WIRE_DEALING_STATUS_REQUOTED,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      digits: 5,
      retcode: MT_RET_REQUEST_REQUOTE,
      seq: 2,
      quotedReqId: 0,
      orderTicket: 0,
      positionTicket: 0,
      dealTicket: 0,
      volume: 1.75,
      price: 1.08452,
      bid: 1.0846,
      ask: 1.08475,
      profit: 0,
      commission: -5.25,
      sl: 1.08,
      tp: 1.092,
      expiresAtMs: 1795181000120,
      serverNowMs: 1795180995120,
      requestId: testUuid(0x31),
      requoteId: testUuid(0x32),
      symbol: 'EURUSD',
      clientOrderId: 'bo-cli-77',
      reasonCode: 'OFF_QUOTES',
      reasonText: getDealingReasonDefaultMessage('OFF_QUOTES'),
    });
    expect(bytesToHex(f0x3A)).toBe(GOLDEN_HEX_0X3A_KIND7_ENV);
    const dec0x3A = decodeTradeEventKind7Envelope(hexToBytes(GOLDEN_HEX_0X3A_KIND7_ENV));
    expect(dec0x3A.accountLogin).toBe(100042);
    expect(dec0x3A.event.reasonText).toBe('Off quotes — market price unavailable');

    // 6. 0x3B AccountSub
    const f0x3B = encodeAccountSubFrame0x3B(100042, 'jwt-abc');
    expect(bytesToHex(f0x3B)).toBe(GOLDEN_HEX_0X3B_ACCOUNT_SUB);
  });

  it('handles edge cases: long & UTF-8 symbols, UTF-8 reason text, 200B reason cap, max 512B extras, and *Into field resets', () => {
    // 1. Long symbol (> 16 bytes) truncates cleanly to 16 bytes; UTF-8 symbol preserves UTF-8 bytes + uppercases ASCII
    const longSymEv = encodeDealingStatusEvent({
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      requestId: testUuid(0x61),
      symbol: 'very_long_symbol_name_2026',
    });
    expect(decodeDealingStatusEvent(longSymEv).symbol).toBe('VERY_LONG_SYMBOL');

    const utf8SymEv = encodeDealingStatusEvent({
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      requestId: testUuid(0x62),
      symbol: 'xau€',
    });
    expect(Array.from(utf8SymEv.subarray(160, 166))).toEqual([0x58, 0x41, 0x55, 0xe2, 0x82, 0xac]);
    expect(decodeDealingStatusEvent(utf8SymEv).symbol).toBe('XAU€');

    // Non-ASCII symbol > 16 UTF-8 bytes fails explicitly instead of silently truncating mid-rune (m3)
    expect(() => encodeDealingStatusEvent({
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      requestId: testUuid(0x66),
      symbol: '€'.repeat(6),
    })).toThrow(/Non-ASCII symbol exceeds 16 UTF-8 bytes/i);

    expect(() => encodeDealingStatusEvent({
      status: WIRE_DEALING_STATUS_IN_DEALING,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      requestId: testUuid(0x67),
      symbol: 'ABCDEFGHIJKLMNOP€',
    })).toThrow(/Non-ASCII symbol exceeds 16 UTF-8 bytes/i);

    // 2. UTF-8 reason text & exact 200-byte reason cap
    const utf8Reason = 'Цена изменена — new € quote';
    const utf8ReasonEv = encodeDealingStatusEvent({
      status: WIRE_DEALING_STATUS_REJECTED,
      kind: DEALING_KIND_OPEN,
      side: WIRE_SIDE_BUY,
      requestId: testUuid(0x63),
      reasonCode: 'CUSTOM',
      reasonText: utf8Reason,
    });
    expect(decodeDealingStatusEvent(utf8ReasonEv).reasonText).toBe(utf8Reason);

    const exact198Utf8 = '€'.repeat(66); // 66 * 3 = 198 bytes <= 200
    expect(decodeDealingStatusEvent(encodeDealingStatusEvent({
      status: WIRE_DEALING_STATUS_REJECTED,
      requestId: testUuid(0x64),
      reasonText: exact198Utf8,
    })).reasonText).toBe(exact198Utf8);

    const over201Utf8 = '€'.repeat(67); // 201 bytes > 200
    expect(() => encodeDealingStatusEvent({
      status: WIRE_DEALING_STATUS_REJECTED,
      requestId: testUuid(0x65),
      reasonText: over201Utf8,
    })).toThrow(DealingWireCodecError);

    // 3. Exact 512-byte max extras TLV succeeds; 513 bytes rejects
    const exact512Base = new Uint8Array([
      0x7a, 250, ...new Array<number>(250).fill(1),
      0x7b, 252, ...new Array<number>(252).fill(2),
    ]); // (2+250)+(2+252) = 506; + 6B 0x16 cap = 512 bytes exact
    expect(exact512Base.byteLength).toBe(506);
    const exact512 = appendClientCapsToExtrasTlv(exact512Base);
    expect(exact512.byteLength).toBe(WIRE_ORDER_EXTRAS_MAX_BYTES);
    const wrapped512 = new Uint8Array(2 + WIRE_ORDER_EXTRAS_MAX_BYTES);
    new DataView(wrapped512.buffer).setUint16(0, WIRE_ORDER_EXTRAS_MAX_BYTES, true);
    wrapped512.set(exact512, 2);
    expect(decodeReqExtrasBlock(wrapped512).extras.hasDealingCap).toBe(true);

    const willBe513Base = new Uint8Array([
      0x7a, 250, ...new Array<number>(250).fill(1),
      0x7b, 253, ...new Array<number>(253).fill(2),
    ]); // 507 + 6 = 513 bytes
    expect(() => appendClientCapsToExtrasTlv(willBe513Base)).toThrow(DealingWireCodecError);

    // 4. *Into decoders reset omitted fields in place with zero leakage from previous decode
    const dirtyExtras = createEmptyExtras();
    dirtyExtras.comment = 'stale-comment';
    dirtyExtras.magic = 999999;
    dirtyExtras.hasDealingCap = true;
    const minExtras = encodeReqExtrasBlock({ reason: ORDER_REASON_CLIENT, hasReason: true });
    decodeReqExtrasBlockInto(minExtras, dirtyExtras);
    expect(dirtyExtras.comment).toBe('');
    expect(dirtyExtras.magic).toBe(0);
    expect(dirtyExtras.hasDealingCap).toBe(false);
    expect(dirtyExtras.hasReason).toBe(true);

    const dirtyExec = createEmptyExecWire();
    dirtyExec.requestId = testUuid(0x70);
    dirtyExec.hasRequestUuid = true;
    dirtyExec.requoteId = testUuid(0x71);
    dirtyExec.hasRequoteUuid = true;
    dirtyExec.digits = 5;
    dirtyExec.hasDigits = true;
    const legacyExec = encodeExecWireTlv({ retcode: MT_RET_REQUEST_PLACED, quotedReqId: 12, dealerBid: 1.1, dealerAsk: 1.2 });
    decodeExecWireTlvInto(legacyExec, dirtyExec);
    expect(dirtyExec.hasRequestUuid).toBe(false);
    expect(dirtyExec.requestId).toBe('');
    expect(dirtyExec.hasRequoteUuid).toBe(false);
    expect(dirtyExec.hasDigits).toBe(false);
    expect(dirtyExec.digits).toBe(0);

    const dirtyEvent = createEmptyDealingStatusEvent();
    dirtyEvent.requoteId = testUuid(0x72);
    dirtyEvent.hasRequoteId = true;
    dirtyEvent.reasonCode = 'OLD_CODE';
    dirtyEvent.reasonText = 'Old reason';
    decodeDealingStatusEventInto(utf8SymEv, dirtyEvent);
    expect(dirtyEvent.hasRequoteId).toBe(false);
    expect(dirtyEvent.requoteId).toBe('');
    expect(dirtyEvent.reasonCode).toBe('');
    expect(dirtyEvent.reasonText).toBe('');

    const dirtyEnv = createEmptyTradeEventKind7Envelope();
    dirtyEnv.channel = 'stale.ch';
    dirtyEnv.event.reasonText = 'stale reason';
    decodeTradeEventKind7EnvelopeInto(
      encodeTradeEventKind7Envelope(42, 999, '', {
        status: WIRE_DEALING_STATUS_IN_DEALING,
        requestId: testUuid(0x73),
      }),
      dirtyEnv,
    );
    expect(dirtyEnv.channel).toBe('');
    expect(dirtyEnv.event.reasonText).toBe('');
  });

  it('D18: encodes/decodes 0x38 Action 11 (DealingSync), 0x39 TLV 0x2A, and zero-alloc envelope range decode', () => {
    const syncFrame = encodeDealingSyncFrame({ accountLogin: 200042, authToken: 'jwt-sync-1' });
    expect(syncFrame[0]).toBe(1);
    expect(syncFrame[1]).toBe(WIRE_ACTION_DEALING_SYNC);
    expect(syncFrame.byteLength).toBe(WIRE_ORDER_REQ_HEADER_SIZE + 2 + 'jwt-sync-1'.length);

    const decodedSync = decodeDealingSyncFrame(syncFrame);
    expect(decodedSync.action).toBe(11);
    expect(decodedSync.accountLogin).toBe(200042);
    expect(decodedSync.authToken).toBe('jwt-sync-1');

    expect(() => encodeDealingSyncFrame({ accountLogin: 0 })).toThrow(DealingWireCodecError);

    // 0x39 standalone TLV 0x2A (1 byte, 1 = dealing enabled)
    const syncRespOn = encodeDealingSyncRespFrame({ status: WIRE_STATUS_OK, dealingEnabled: true });
    const parsedOn = decodeOrderRespWithExecWire(syncRespOn);
    expect(parsedOn.action).toBe(WIRE_ACTION_DEALING_SYNC);
    expect(parsedOn.status).toBe(200);
    expect(parsedOn.execWire?.hasDealingEnabled).toBe(true);
    expect(parsedOn.execWire?.dealingEnabled).toBe(true);

    const syncRespOff = encodeDealingSyncRespFrame({ status: WIRE_STATUS_OK, dealingEnabled: false });
    const parsedOff = decodeOrderRespWithExecWire(syncRespOff);
    expect(parsedOff.execWire?.hasDealingEnabled).toBe(true);
    expect(parsedOff.execWire?.dealingEnabled).toBe(false);

    // Bad 0x2A length (2 instead of 1) rejects explicitly
    expect(() => decodeExecWireTlv(new Uint8Array([WIRE_RESP_TAG_DEALING_ENABLED, 2, 1, 0]))).toThrow(
      DealingWireCodecError,
    );

    // Range decode inside larger stream buffer matches standalone envelope decode
    const env = encodeTradeEventKind7Envelope(200042, 1_700_000_000_000, 'dealing.200042', {
      status: WIRE_DEALING_STATUS_IN_DEALING,
      requestId: testUuid(0x74),
      symbol: 'EURUSD',
    });
    const padded = new Uint8Array(12 + env.byteLength + 8);
    padded.set(env, 12);
    const rangeOut = createEmptyTradeEventKind7Envelope();
    decodeTradeEventKind7EnvelopeIntoRange(padded, 12, env.byteLength, rangeOut);
    expect(rangeOut.accountLogin).toBe(200042);
    expect(rangeOut.event.requestId).toBe(testUuid(0x74));
  });
});
