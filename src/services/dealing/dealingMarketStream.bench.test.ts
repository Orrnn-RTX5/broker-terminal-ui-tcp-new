import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/backendTarget.js', () => ({ isDesktopBackendTarget: () => true }));
vi.mock('../binaryTcpOrderClient', () => ({
  getActiveBinaryTcpOrderCount: () => 0,
  getBinaryTcpOrderActiveDurationMs: () => 0,
  onBinaryTcpOrdersIdle: () => undefined,
  prewarmBinaryOrderSocket: () => undefined,
  syncBinaryOrderAuthToken: () => undefined,
}));
vi.mock('../brokerSession', () => ({
  getAccessToken: () => '',
  getAccountLogin: () => 200001,
  onSessionChange: () => undefined,
}));

import {
  BINARY_TICK_RECORD_SIZE,
  FRAME_BINARY_TICK_BATCH,
  FRAME_BINARY_TRADE_EVENT,
  binaryTcpMarketStream,
} from '../binaryTcpMarketStream';
import { useDealingStore } from '../../store/useDealingStore';
import {
  DEALING_KIND_OPEN,
  MT_RET_REQUEST_PLACED,
  WIRE_DEALING_STATUS_IN_DEALING,
  WIRE_SIDE_BUY,
  encodeTradeEventKind7Envelope,
} from './binaryDealingCodec';
import './dealingMarketStreamBridge';

type StreamBenchInternals = {
  consumeChunk(chunk: Uint8Array): void;
  accumLen: number;
  boundAccountKey: string | null;
};

const internals = binaryTcpMarketStream as unknown as StreamBenchInternals;
const encoder = new TextEncoder();

function buildTickBatchChunk(symbols: readonly string[]): Uint8Array {
  const count = symbols.length;
  const payloadLen = 2 + count * BINARY_TICK_RECORD_SIZE;
  const chunk = new Uint8Array(4 + payloadLen);
  const view = new DataView(chunk.buffer);
  chunk[0] = FRAME_BINARY_TICK_BATCH;
  chunk[1] = 0;
  view.setUint16(2, payloadLen, true);
  view.setUint16(4, count, true);

  let off = 6;
  for (let i = 0; i < count; i++, off += BINARY_TICK_RECORD_SIZE) {
    const sym = symbols[i];
    for (let j = 0; j < sym.length && j < 16; j++) {
      chunk[off + j] = sym.charCodeAt(j);
    }
    view.setBigUint64(off + 16, BigInt(1_700_000_000_000 + i), true);
    view.setFloat64(off + 24, 1.0845 + i * 0.001, true);
    view.setFloat64(off + 32, 1.0847 + i * 0.001, true);
    view.setBigUint64(off + 40, BigInt(i + 1), true);
  }
  return chunk;
}

function buildTradeEventKind1Chunk(channel: string, payload: unknown, login = 200001): Uint8Array {
  const chBytes = encoder.encode(channel);
  const dataBytes = encoder.encode(JSON.stringify(payload));
  const payloadLen = 22 + chBytes.byteLength + dataBytes.byteLength;
  const chunk = new Uint8Array(4 + payloadLen);
  const view = new DataView(chunk.buffer);
  chunk[0] = FRAME_BINARY_TRADE_EVENT;
  chunk[1] = 0;
  view.setUint16(2, payloadLen, true);
  chunk[4] = 1; // Ver = 1
  chunk[5] = 1; // Kind = 1 (positions)
  view.setBigInt64(6, BigInt(login), true);
  view.setBigInt64(14, 1_700_000_000_000n, true);
  view.setUint16(22, chBytes.byteLength, true);
  chunk.set(chBytes, 24);
  view.setUint16(24 + chBytes.byteLength, dataBytes.byteLength, true);
  chunk.set(dataBytes, 26 + chBytes.byteLength);
  return chunk;
}

function wrapStreamFrame(frameType: number, payload: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(chunk.buffer);
  chunk[0] = frameType;
  chunk[1] = 0;
  view.setUint16(2, payload.byteLength, true);
  chunk.set(payload, 4);
  return chunk;
}

describe('BinaryTcpMarketStream hot-path micro-benchmark', () => {
  it('measures 0x21 tick-batch decode, 0x3A non-dealing Kind 1, and 0x3A Kind 7 dealing routing', () => {
    (binaryTcpMarketStream as unknown as { ensureStarted: () => void }).ensureStarted = () => {};

    const tickChunk = buildTickBatchChunk([
      'EURUSD',
      'GBPUSD',
      'USDJPY',
      'XAUUSD',
      'BTCUSD',
      'AUDUSD',
      'USDCAD',
      'NZDUSD',
      'EURJPY',
      'GBPJPY',
    ]);

    let tickCount = 0;
    const offTick = binaryTcpMarketStream.onTick(() => {
      tickCount++;
    });

    const TICK_WARMUP = 1_000;
    const TICK_ITERS = 10_000;
    internals.accumLen = 0;
    for (let i = 0; i < TICK_WARMUP; i++) {
      internals.consumeChunk(tickChunk);
    }
    tickCount = 0;
    const t0 = performance.now();
    for (let i = 0; i < TICK_ITERS; i++) {
      internals.consumeChunk(tickChunk);
    }
    const tickElapsedMs = performance.now() - t0;
    offTick();

    expect(tickCount).toBe(TICK_ITERS * 10);
    const tickNsPerBatch = (tickElapsedMs * 1_000_000) / TICK_ITERS;
    const tickNsPerTick = (tickElapsedMs * 1_000_000) / (TICK_ITERS * 10);
    const tickBatchesPerSec = Math.round((TICK_ITERS / tickElapsedMs) * 1_000);
    console.log(
      `[BENCH 0x21 tick-batch] batches=${TICK_ITERS} ticks=${tickCount} totalMs=${tickElapsedMs.toFixed(3)} ns/batch=${tickNsPerBatch.toFixed(1)} ns/tick=${tickNsPerTick.toFixed(1)} batches/s=${tickBatchesPerSec}`,
    );

    // Alternating payloads prevent the 25ms duplicate-signature coalescer from skipping frames.
    const kind1A = buildTradeEventKind1Chunk('positions.200001', {
      type: 'position_update',
      data: [{ ticket: 101, update_kind: 'pnl', profit: 1.25 }],
    });
    const kind1B = buildTradeEventKind1Chunk('positions.200001', {
      type: 'position_update',
      data: [{ ticket: 101, update_kind: 'pnl', profit: 1.5 }],
    });

    let tradeEventCount = 0;
    const offTrade = binaryTcpMarketStream.subscribeTradeEvents(() => {
      tradeEventCount++;
    });

    const TRADE_WARMUP = 1_000;
    const TRADE_ITERS = 10_000;
    internals.accumLen = 0;
    for (let i = 0; i < TRADE_WARMUP; i++) {
      internals.consumeChunk((i & 1) === 0 ? kind1A : kind1B);
    }
    tradeEventCount = 0;
    const t1 = performance.now();
    for (let i = 0; i < TRADE_ITERS; i++) {
      internals.consumeChunk((i & 1) === 0 ? kind1A : kind1B);
    }
    const tradeElapsedMs = performance.now() - t1;
    offTrade();

    expect(tradeEventCount).toBe(TRADE_ITERS);
    const tradeNsPerOp = (tradeElapsedMs * 1_000_000) / TRADE_ITERS;
    const tradeOpsPerSec = Math.round((TRADE_ITERS / tradeElapsedMs) * 1_000);
    console.log(
      `[BENCH 0x3A kind-1] frames=${TRADE_ITERS} delivered=${tradeEventCount} totalMs=${tradeElapsedMs.toFixed(3)} ns/op=${tradeNsPerOp.toFixed(1)} ops/s=${tradeOpsPerSec}`,
    );

    // 0x3A Kind 7 dealing routing micro-benchmark (scoped to active account 200001)
    useDealingStore.getState().reset();
    internals.boundAccountKey = '200001:bench-token';
    const KIND7_FRAMES = 2_000;
    const kind7Chunks: Uint8Array[] = [];
    for (let i = 0; i < KIND7_FRAMES; i++) {
      const suffix = i.toString(16).padStart(4, '0');
      const env = encodeTradeEventKind7Envelope(200001, 1_700_000_000_000 + i, 'dealing.200001', {
        status: WIRE_DEALING_STATUS_IN_DEALING,
        kind: DEALING_KIND_OPEN,
        side: WIRE_SIDE_BUY,
        digits: 5,
        retcode: MT_RET_REQUEST_PLACED,
        seq: 1,
        volume: 0.1,
        price: 1.0845,
        requestId: `10203040-5060-4780-8090-a0b0c0d0${suffix}`,
        symbol: 'EURUSD',
        clientOrderId: `bo-bench-${i}`,
      });
      kind7Chunks.push(wrapStreamFrame(FRAME_BINARY_TRADE_EVENT, env));
    }

    const t2 = performance.now();
    for (let i = 0; i < KIND7_FRAMES; i++) {
      internals.consumeChunk(kind7Chunks[i]);
    }
    const kind7ElapsedMs = performance.now() - t2;
    const routedCount = Object.keys(useDealingStore.getState().requests).length;
    internals.boundAccountKey = null;
    useDealingStore.getState().reset();

    expect(routedCount).toBe(KIND7_FRAMES);
    const kind7NsPerOp = (kind7ElapsedMs * 1_000_000) / KIND7_FRAMES;
    const kind7OpsPerSec = Math.round((KIND7_FRAMES / kind7ElapsedMs) * 1_000);
    console.log(
      `[BENCH 0x3A kind-7] frames=${KIND7_FRAMES} routed=${routedCount} totalMs=${kind7ElapsedMs.toFixed(3)} ns/op=${kind7NsPerOp.toFixed(1)} ops/s=${kind7OpsPerSec}`,
    );

    // Steady-state 0x3A Kind 7 benchmark: 10 active requests updated 200 times each (2,000 frames)
    useDealingStore.getState().reset();
    internals.boundAccountKey = '200001:bench-token';
    const STEADY_IDS = 10;
    const STEADY_ROUNDS = 200;
    const steadyChunks: Uint8Array[] = [];
    for (let r = 0; r < STEADY_ROUNDS; r++) {
      for (let k = 0; k < STEADY_IDS; k++) {
        const suffix = k.toString(16).padStart(4, '0');
        const env = encodeTradeEventKind7Envelope(200001, 1_700_000_000_000 + r, 'dealing.200001', {
          status: WIRE_DEALING_STATUS_IN_DEALING,
          kind: DEALING_KIND_OPEN,
          side: WIRE_SIDE_BUY,
          digits: 5,
          retcode: MT_RET_REQUEST_PLACED,
          seq: r + 1,
          volume: 0.1,
          price: 1.0845,
          requestId: `20203040-5060-4780-8090-a0b0c0d0${suffix}`,
          symbol: 'EURUSD',
          clientOrderId: `bo-steady-${k}`,
        });
        steadyChunks.push(wrapStreamFrame(FRAME_BINARY_TRADE_EVENT, env));
      }
    }

    const t3 = performance.now();
    for (let i = 0; i < steadyChunks.length; i++) {
      internals.consumeChunk(steadyChunks[i]);
    }
    const steadyElapsedMs = performance.now() - t3;
    const steadyCount = Object.keys(useDealingStore.getState().requests).length;
    internals.boundAccountKey = null;
    useDealingStore.getState().reset();

    expect(steadyCount).toBe(STEADY_IDS);
    const steadyNsPerOp = (steadyElapsedMs * 1_000_000) / steadyChunks.length;
    const steadyOpsPerSec = Math.round((steadyChunks.length / steadyElapsedMs) * 1_000);
    console.log(
      `[BENCH 0x3A kind-7 steady-state] frames=${steadyChunks.length} active=${steadyCount} totalMs=${steadyElapsedMs.toFixed(3)} ns/op=${steadyNsPerOp.toFixed(1)} ops/s=${steadyOpsPerSec}`,
    );
  }, 30_000);
});
