/**
 * Pure Binary TCP Market-Data & Trade-Event Stream (MT5-Style Zero-WebSocket, Zero-JSON Fast Path)
 *
 * Reads raw fixed-width Little-Endian binary frames directly from the local Go
 * Desktop Client (`GET /__rtx5_binary_stream`, multiplexed over `:4443` AES-256-GCM Binary TCP):
 *   - Frame 0x21 (FrameBinaryTickBatch):   [Count:u16_le][48-byte BinaryTick * Count]
 *   - Frame 0x22 (FrameBinaryCandleBatch): [Count:u16_le][64-byte BinaryCandle * Count]
 *   - Frame 0x24 (FrameBinaryDepthBatch):  [Count:u16_le][360-byte BinaryDepth * Count]
 *   - Frame 0x3A (FrameBinaryTradeEvent):  [Ver:u8][Kind:u8][Login:i64_le][TsMs:i64_le][ChLen:u16_le][Ch][DataLen:u16_le][Data]
 *
 * Binds authenticated real-time account/trade push events via `POST /__rtx5_binary_account_sub`
 * ([AccountLogin:i64_le][TokenLen:u16_le][Token UTF-8]) with zero WebSockets.
 *
 * Also provides `fetchBinaryCandles()` against `GET /api/v2/binary-candles/{symbol}`
 * ([Count:u32_le][64-byte BinaryCandle * Count]) for zero-JSON historical OHLCV loading.
 */

import type { OHLCData } from '../types/chartData';
import { isDesktopBackendTarget } from '../config/backendTarget.js';
import { decodeJwtPayload } from '../utils/jwt';
import { TickTimestampGuard } from '../utils/tickTimestampGuard';
import {
  getActiveBinaryTcpOrderCount,
  getBinaryTcpOrderActiveDurationMs,
  onBinaryTcpOrdersIdle,
  prewarmBinaryOrderSocket,
  syncBinaryOrderAuthToken,
} from './binaryTcpOrderClient';
import { getAccessToken, getAccountLogin, onSessionChange } from './brokerSession';
// dealing begin
import {
  DEALING_WIRE_TRADE_EVENT_KIND,
  dispatchDealingTradeEventHook,
  notifyDealingAccountSubscribedHook,
  notifyDealingStreamDisconnectedHook,
} from './dealing/dealingRuntimeHooks';
// dealing end

const MAX_BINARY_ORDER_STREAM_DEFER_MS = 250;
const MAX_CONSECUTIVE_STREAM_DEFER_MS = 200;

/**
 * Silence watchdog. Tracks actual market-data frames (0x21 ticks, 0x22 candles, 0x23, 0x24 depth)
 * separately from 0x05 keepalive pings, so a dead upstream tick feed with live 10s keepalive pings
 * still triggers a clean reconnect after 30 s.
 */
export const STREAM_SILENCE_RECONNECT_MS = 30_000;
const STREAM_SILENCE_CHECK_MS = 5_000;
/** An access token this close to (or past) its `exp` is refreshed before the account subscription is re-bound. */
export const STREAM_TOKEN_REFRESH_LEAD_MS = 60_000;
/** Longest a silence re-bind waits for a stale-token refresh before binding with the stored token. */
export const STREAM_TOKEN_REFRESH_WAIT_MS = 3_000;
const VISIBILITY_RECOVERY_STALE_MS = 15_000;

export const FRAME_BINARY_TICK_BATCH = 0x21;
export const FRAME_BINARY_CANDLE_BATCH = 0x22;
export const FRAME_BINARY_MARKET_DATA_EXT = 0x23;
export const FRAME_BINARY_DEPTH_BATCH = 0x24;
export const FRAME_BINARY_TRADE_EVENT = 0x3A;

export const BINARY_SYMBOL_MAX_BYTES = 16;
export const BINARY_TICK_RECORD_SIZE = 48;
export const BINARY_CANDLE_RECORD_SIZE = 64;
export const BINARY_DEPTH_MAX_LEVELS = 10;
export const BINARY_DEPTH_HEADER_SIZE = 40;
export const BINARY_DEPTH_LEVEL_SIZE = 16;
export const BINARY_DEPTH_RECORD_SIZE = 360;
export const BINARY_TRADE_EVENT_MIN_SIZE = 22;
export const CANDLE_FLAG_CLOSED = 0x01;

export type BinaryCandleTimeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1' | 'W1' | 'MN';

export interface DecodedBinaryTick {
  symbol: string;
  bid: number;
  ask: number;
  spread: number;
  timestamp: number;
  sourceTimestamp: number;
  sequence: number;
  dailyOpen?: number;
  high24h?: number;
  low24h?: number;
  dailyChange?: number;
}

export interface DecodedBinaryCandle extends OHLCData {
  symbol: string;
  timeframe: BinaryCandleTimeframe;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tickVolume: number;
  closed: boolean;
}

export interface DecodedBinaryDepthLevel {
  price: number;
  volume: number;
  total: number;
}

export interface DecodedBinaryDepth {
  symbol: string;
  timestamp: number;
  sequence: number;
  bids: DecodedBinaryDepthLevel[];
  asks: DecodedBinaryDepthLevel[];
  spread: number;
}

export interface DecodedBinaryTradeEvent {
  eventKind: number; // 1=positions, 2=orders, 3=account, 4=metrics, 5=deals, 6=state
  accountLogin: number;
  timestampMs: number;
  channel: string;   // e.g. "positions.200001"
  payload: unknown;  // parsed object from UTF-8 Data bytes (or raw string if non-JSON)
  rawText: string;
}

type BinaryTickListener = (tick: DecodedBinaryTick) => void;
type BinaryCandleListener = (candle: DecodedBinaryCandle) => void;
type BinaryDepthListener = (depth: DecodedBinaryDepth) => void;
export type BinaryTradeEventListener = (ev: DecodedBinaryTradeEvent) => void;
type StreamStateListener = (connected: boolean) => void;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const TWO_POW_32 = 4294967296;
const UTC_DAY_MS = 86_400_000;

const TF_CODE_TO_STRING: Record<number, BinaryCandleTimeframe> = {
  1: 'M1',
  2: 'M5',
  3: 'M15',
  4: 'M30',
  5: 'H1',
  6: 'H4',
  7: 'D1',
  8: 'W1',
  9: 'MN',
};

// Zero-allocation symbol intern table keyed by the first two 32-bit words when <= 8 chars,
// or full 16-byte signature for 9..16 char symbols (max symbol len in DB is 11).
const shortSymbolIntern = new Map<number, string>();
const longSymbolIntern = new Map<string, string>();

export function decodeFixedAsciiSymbol(bytes: Uint8Array, offset: number): string {
  let len = 0;
  while (len < BINARY_SYMBOL_MAX_BYTES && bytes[offset + len] !== 0) {
    len++;
  }
  if (len === 0) return '';

  // Fast path for <= 6 ASCII uppercase chars (covers EURUSD, XAUUSD, BTCUSD, US30, NAS100, DE40, etc.)
  if (len <= 6) {
    let key = len;
    for (let i = 0; i < len; i++) {
      key = key * 97 + bytes[offset + i];
    }
    const cached = shortSymbolIntern.get(key);
    if (cached !== undefined) {
      // Verify exact match against hash collision
      let match = cached.length === len;
      for (let i = 0; match && i < len; i++) {
        if (cached.charCodeAt(i) !== bytes[offset + i]) match = false;
      }
      if (match) return cached;
    }
    let s = '';
    for (let i = 0; i < len; i++) {
      s += String.fromCharCode(bytes[offset + i]);
    }
    const upper = s.toUpperCase();
    shortSymbolIntern.set(key, upper);
    return upper;
  }

  let s = '';
  for (let i = 0; i < len; i++) {
    s += String.fromCharCode(bytes[offset + i]);
  }
  const upper = s.toUpperCase();
  const existing = longSymbolIntern.get(upper);
  if (existing !== undefined) return existing;
  longSymbolIntern.set(upper, upper);
  return upper;
}

function readUint64LE(view: DataView, byteOffset: number): number {
  const lo = view.getUint32(byteOffset, true);
  const hi = view.getUint32(byteOffset + 4, true);
  return lo + hi * TWO_POW_32;
}

export function decodeRawBinaryCandlesBuffer(
  buffer: ArrayBuffer,
  requestedTimeframe?: string,
): OHLCData[] {
  if (buffer.byteLength < 4) return [];
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  const available = Math.min(count, Math.floor((buffer.byteLength - 4) / BINARY_CANDLE_RECORD_SIZE));
  if (available <= 0) return [];

  const isD1 = String(requestedTimeframe ?? '').toUpperCase() === 'D1';
  const out: OHLCData[] = new Array(available);
  let writeIdx = 0;
  let off = 4;

  for (let i = 0; i < available; i++, off += BINARY_CANDLE_RECORD_SIZE) {
    const time = readUint64LE(view, off + 16);
    const open = view.getFloat64(off + 24, true);
    const high = view.getFloat64(off + 32, true);
    const low = view.getFloat64(off + 40, true);
    const close = view.getFloat64(off + 48, true);
    const tickVolume = view.getUint32(off + 56, true);
    const flags = bytes[off + 60];
    const closed = (flags & CANDLE_FLAG_CLOSED) !== 0;

    if (
      time > 0
      && Number.isFinite(open) && open > 0
      && Number.isFinite(high) && high > 0
      && Number.isFinite(low) && low > 0
      && Number.isFinite(close) && close > 0
    ) {
      out[writeIdx++] = {
        time,
        ...(isD1 ? { sourceTime: time } : {}),
        open,
        high,
        low,
        close,
        volume: tickVolume,
        tickVolume,
        closed,
      };
    }
  }

  if (writeIdx < available) {
    out.length = writeIdx;
  }
  return out;
}

export async function fetchBinaryCandles(
  url: string,
  timeframe: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<OHLCData[]> {
  const response = await fetch(url, {
    method: 'GET',
    signal,
    headers: {
      Accept: 'application/octet-stream',
      ...(headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  return decodeRawBinaryCandlesBuffer(buffer, timeframe);
}

export function decodeBinaryTradeEvent(payload: Uint8Array): DecodedBinaryTradeEvent | null {
  if (!payload || payload.byteLength < BINARY_TRADE_EVENT_MIN_SIZE || payload[0] !== 1) {
    return null;
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const eventKind = payload[1];
  // dealing begin
  if (eventKind === DEALING_WIRE_TRADE_EVENT_KIND) {
    return null;
  }
  // dealing end
  const accountLogin = Number(view.getBigInt64(2, true));
  const timestampMs = Number(view.getBigInt64(10, true));
  const channelLen = view.getUint16(18, true);

  if (BINARY_TRADE_EVENT_MIN_SIZE + channelLen > payload.byteLength) {
    return null;
  }

  const channel = textDecoder.decode(payload.subarray(20, 20 + channelLen));
  const dataLen = view.getUint16(20 + channelLen, true);

  if (BINARY_TRADE_EVENT_MIN_SIZE + channelLen + dataLen > payload.byteLength) {
    return null;
  }

  const rawText = textDecoder.decode(
    payload.subarray(22 + channelLen, 22 + channelLen + dataLen),
  );
  // eslint-disable-next-line no-useless-assignment -- kept byte-identical to the shipped hot path (0x3A decode); value is overwritten in both branches
  let parsedPayload: unknown = rawText;
  try {
    parsedPayload = JSON.parse(rawText);
  } catch {
    parsedPayload = rawText;
  }

  return {
    eventKind,
    accountLogin,
    timestampMs,
    channel,
    payload: parsedPayload,
    rawText,
  };
}

const COALESCE_METRICS_TYPES = new Set(['metrics_update', 'account_metrics', 'account_snapshot']);
const COALESCE_POSITION_TYPES = new Set(['position_update', 'position_updated']);

const normalizeTradeEventChannel = (channel: string): string => {
  const trimmed = channel.trim().toLowerCase();
  return trimmed.startsWith('rtx5.') ? trimmed.slice(5) : trimmed;
};

/** Account scope of an event (login segment of its channel), shared by positions/orders/account/deals channels. */
export function getTradeEventScope(ev: DecodedBinaryTradeEvent): string {
  const channel = normalizeTradeEventChannel(ev.channel);
  const dot = channel.lastIndexOf('.');
  const tail = dot >= 0 ? channel.slice(dot + 1) : '';
  return tail || String(ev.accountLogin);
}

/**
 * Returns a coalescing key when the event is a pure "latest state wins" snapshot
 * (account/metrics snapshot, or a single-ticket tick-driven position pnl patch),
 * otherwise null. Anything not provably a snapshot (open/close/modify, orders,
 * deals, batches, closed-ticket lists, unknown shapes) returns null and is never
 * merged or dropped.
 */
export function getTradeEventCoalesceKey(ev: DecodedBinaryTradeEvent): string | null {
  const payload = ev.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
  if (type === '') return null;
  const channel = normalizeTradeEventChannel(ev.channel);

  if (COALESCE_METRICS_TYPES.has(type)) {
    if (record.closed_tickets !== undefined || record.closedTickets !== undefined) return null;
    return `m|${channel}|${type}`;
  }

  if (COALESCE_POSITION_TYPES.has(type)) {
    if (record.closed_tickets !== undefined || record.closedTickets !== undefined || record.tickets !== undefined) {
      return null;
    }
    const data = record.data;
    let row: unknown = data;
    if (Array.isArray(data)) {
      if (data.length !== 1) return null;
      row = data[0];
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
    const rowRecord = row as Record<string, unknown>;
    if (rowRecord.update_kind !== 'pnl' || rowRecord.closed === true) return null;
    const ticket = rowRecord.ticket ?? rowRecord.position_id ?? rowRecord.id ?? rowRecord.position_ticket;
    if (typeof ticket !== 'number' && typeof ticket !== 'string') return null;
    const ticketKey = String(ticket).trim();
    if (!/^\d+$/.test(ticketKey) || ticketKey === '0') return null;
    const version = rowRecord.state_version ?? '';
    return `p|${channel}|${ticketKey}|${String(version)}`;
  }
  return null;
}

function safeGetLocalStorageItem(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function parsePositiveFiniteInt(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isInteger(value) && value > 0
      ? value
      : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return 0;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && Number.isSafeInteger(parsed) && parsed > 0
      ? parsed
      : 0;
  }
  return 0;
}

function resolveActiveAccountLogin(explicitLogin: number | undefined, token: string): number {
  if (typeof explicitLogin === 'number' && Number.isFinite(explicitLogin) && explicitLogin <= 0) {
    return 0;
  }

  if (!token) {
    return 0;
  }

  // 1) Explicit login override (if positive finite integer)
  const explicit = parsePositiveFiniteInt(explicitLogin);
  if (explicit > 0) {
    return explicit;
  }

  // 2) Active JWT claims (`account_login` / `login`, if positive finite integer)
  const jwtPayload = decodeJwtPayload(token);
  if (jwtPayload) {
    const jwtAccountLogin =
      parsePositiveFiniteInt(jwtPayload.account_login)
      || parsePositiveFiniteInt(jwtPayload.login);
    if (jwtAccountLogin > 0) {
      return jwtAccountLogin;
    }
  }

  // 3) Active session / Zustand account login (`getAccountLogin()`, if positive finite integer)
  const sessionLogin = parsePositiveFiniteInt(getAccountLogin());
  if (sessionLogin > 0) {
    return sessionLogin;
  }

  // 4) localStorage fallback ONLY when JWT has no single `account_login` claim and `getAccountLogin()` is unset
  const storedKeys = ['account_login', 'rtx_last_login', 'rtx_saved_username'] as const;
  for (const key of storedKeys) {
    const parsed = parsePositiveFiniteInt(safeGetLocalStorageItem(key));
    if (parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

export function encodeBinaryAccountSub(accountLogin: number, token: string): Uint8Array {
  const cleanLogin = Number.isFinite(accountLogin) && accountLogin > 0 ? Math.trunc(accountLogin) : 0;
  const effectiveToken = cleanLogin > 0 && token ? token : '';
  const encodedToken = effectiveToken ? textEncoder.encode(effectiveToken) : new Uint8Array(0);
  const tokenBytes = encodedToken.byteLength > 65_535
    ? encodedToken.subarray(0, 65_535)
    : encodedToken;

  const rawBuf = new ArrayBuffer(10 + tokenBytes.byteLength);
  const buf = new Uint8Array(rawBuf);
  const view = new DataView(rawBuf);
  view.setBigInt64(0, BigInt(cleanLogin), true);
  view.setUint16(8, tokenBytes.byteLength, true);
  if (tokenBytes.byteLength > 0) {
    buf.set(tokenBytes, 10);
  }
  return buf;
}

interface SymbolDayStats {
  utcDay: number;
  openBid: number;
  highBid: number;
  lowBid: number;
}

class BinaryTcpMarketStream {
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private running = false;
  private connected = false;
  private boundAccountKey: string | null = null;
  private inFlightAccountKey: string | null = null;
  private accountSubSeq = 0;

  private readonly latestTicks = new Map<string, DecodedBinaryTick>();
  private readonly dayStats = new Map<string, SymbolDayStats>();
  private readonly tickTimestampGuard = new TickTimestampGuard();
  private readonly latestM1Candles = new Map<string, DecodedBinaryCandle>();
  private readonly latestDepths = new Map<string, DecodedBinaryDepth>();

  private readonly tickListeners = new Set<BinaryTickListener>();
  private readonly directChartTickListeners = new Map<string, Set<BinaryTickListener>>();
  private readonly candleListeners = new Map<string, Set<BinaryCandleListener>>();
  private readonly depthListeners = new Map<string, Set<BinaryDepthListener>>();
  private readonly tradeEventListeners = new Set<BinaryTradeEventListener>();
  private readonly stateListeners = new Set<StreamStateListener>();

  // While a Binary TCP order is in flight, coalesce UI listener notifications
  // so background tick/candle/NATS store updates never block Chromium's JS
  // main thread right when the binary fill response arrives.
  private readonly deferredTicks = new Map<string, DecodedBinaryTick>();
  private readonly deferredCandles = new Map<string, DecodedBinaryCandle>();
  private readonly deferredDepths = new Map<string, DecodedBinaryDepth>();
  private deferredTradeEvents: DecodedBinaryTradeEvent[] = [];
  // Coalescing of deferred snapshot events: key -> slot in deferredTradeEvents (+ scope epoch when queued).
  // A non-snapshot event bumps its account scope's epoch, so a snapshot arriving after it never
  // overwrites a slot queued before it (keeps open/close/order/deal ordering intact).
  private readonly deferredTradeCoalesce = new Map<string, { index: number; epoch: number }>();
  private readonly deferredTradeScopeEpoch = new Map<string, number>();
  private deferredFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Set by the silence watchdog: the next successful stream open refreshes a stale JWT before re-binding 0x3B.
  private refreshTokenOnNextBind = false;
  private tokenRefreshInFlight: Promise<void> | null = null;
  private deferredSinceMs = 0;
  private lastTradeEventSig = '';
  private lastTradeEventAtMs = 0;

  // Growable sliding byte accumulator for chunk boundary reassembly (zero alloc steady-state)
  private accumBuf = new Uint8Array(131_072);
  private accumLen = 0;

  // Market-data frames (0x21/0x22/0x23/0x24) received on the current stream; read by the silence watchdog
  // so 0x05 keepalive pings alone never mask a dead upstream tick feed.
  private marketDataFramesReceived = 0;
  private lastMarketDataAt = 0;
  private latestTickTimestampMs = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      onBinaryTcpOrdersIdle(() => {
        this.flushDeferredNotifications();
      });

      onSessionChange((reason) => {
        if (reason === 'broker_url_change') {
          this.latestTicks.clear();
          this.dayStats.clear();
          this.tickTimestampGuard.clear();
          this.latestTickTimestampMs = 0;
          this.latestM1Candles.clear();
          this.latestDepths.clear();
          this.deferredTicks.clear();
          this.deferredCandles.clear();
          this.deferredDepths.clear();
          this.deferredTradeEvents = [];
          this.deferredTradeCoalesce.clear();
          this.deferredTradeScopeEpoch.clear();
          this.deferredSinceMs = 0;
          this.boundAccountKey = null;
          this.inFlightAccountKey = null;
          this.syncAccountSubscription(undefined, true);
          this.forceReconnect();
          return;
        }
        this.syncAccountSubscription();
      });

      window.addEventListener('auth:token-updated', () => {
        this.syncAccountSubscription();
      });

      window.addEventListener('online', () => {
        if (this.hasConsumers()) this.forceReconnect();
      });

      const handleWakeRecovery = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        if (!this.hasConsumers() || !this.isSupported()) return;
        if (!this.connected || !this.running) {
          this.forceReconnect();
          return;
        }
        if (this.lastMarketDataAt > 0 && Date.now() - this.lastMarketDataAt >= VISIBILITY_RECOVERY_STALE_MS) {
          this.forceReconnect();
          return;
        }
        this.flushDeferredNotifications();
      };

      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', handleWakeRecovery);
      }
      window.addEventListener('focus', handleWakeRecovery);
    }
  }

  public isSupported(): boolean {
    return typeof window !== 'undefined' && isDesktopBackendTarget();
  }

  public start(): void {
    this.ensureStarted();
  }

  public ensureStarted(): void {
    if (!this.isSupported() || this.running) return;
    this.running = true;
    void this.connectStreamLoop();
  }

  public syncAccountSubscription(explicitLogin?: number, force = false): void {
    if (!this.isSupported()) return;

    const token = (getAccessToken() ?? '').trim();
    const accountLogin = resolveActiveAccountLogin(explicitLogin, token);
    const effectiveToken = accountLogin > 0 ? token : '';
    const nextKey = `${accountLogin}:${effectiveToken}`;

    syncBinaryOrderAuthToken(effectiveToken);
    if (accountLogin > 0 && effectiveToken) {
      prewarmBinaryOrderSocket();
    }

    if (!force && (this.boundAccountKey === nextKey || this.inFlightAccountKey === nextKey)) {
      return;
    }

    if (force) {
      this.boundAccountKey = null;
    }
    this.inFlightAccountKey = nextKey;
    const seq = ++this.accountSubSeq;
    const buf = encodeBinaryAccountSub(accountLogin, effectiveToken);

    void fetch('/__rtx5_binary_account_sub', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: buf as BodyInit,
      cache: 'no-store',
    })
      .then((resp) => {
        if (this.accountSubSeq !== seq) return;
        this.inFlightAccountKey = null;
        this.boundAccountKey = resp.ok ? nextKey : null;
        // dealing begin
        if (resp.ok && accountLogin > 0) {
          notifyDealingAccountSubscribedHook(accountLogin, effectiveToken);
        }
        // dealing end
      })
      .catch(() => {
        if (this.accountSubSeq !== seq) return;
        this.inFlightAccountKey = null;
        this.boundAccountKey = null;
      });
  }

  public forceReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.boundAccountKey = null;
    this.inFlightAccountKey = null;
    if (this.abortController) {
      try { this.abortController.abort(); } catch { /* ignore */ }
      this.abortController = null;
    }
    this.running = false;
    this.accumLen = 0;
    if (this.hasConsumers()) {
      this.ensureStarted();
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getLatestTick(symbol: string): DecodedBinaryTick | undefined {
    const key = symbol.trim().toUpperCase();
    return this.latestTicks.get(key);
  }

  public getAllLatestTicks(): ReadonlyMap<string, DecodedBinaryTick> {
    return this.latestTicks;
  }

  public getLatestM1Candle(symbol: string): DecodedBinaryCandle | undefined {
    return this.latestM1Candles.get(symbol.trim().toUpperCase());
  }

  public getLatestDepth(symbol: string): DecodedBinaryDepth | undefined {
    return this.latestDepths.get(symbol.trim().toUpperCase());
  }

  public onTick(listener: BinaryTickListener): () => void {
    this.tickListeners.add(listener);
    this.ensureStarted();
    return () => {
      this.tickListeners.delete(listener);
    };
  }

  /**
   * Direct ultra-low-latency per-symbol chart listener.
   * Fires synchronously the instant a binary 0x21 packet arrives from Go,
   * bypassing store batching and 50 ms timers completely.
   */
  public onDirectChartTick(symbol: string, listener: BinaryTickListener): () => void {
    const key = symbol.trim().toUpperCase();
    let set = this.directChartTickListeners.get(key);
    if (!set) {
      set = new Set();
      this.directChartTickListeners.set(key, set);
    }
    set.add(listener);
    this.ensureStarted();

    // Immediately deliver warm cached tick if already present
    const warm = this.latestTicks.get(key);
    if (warm) {
      queueMicrotask(() => {
        if (set?.has(listener)) {
          try { listener(warm); } catch { /* ignore */ }
        }
      });
    }

    return () => {
      const current = this.directChartTickListeners.get(key);
      if (current) {
        current.delete(listener);
        if (current.size === 0) this.directChartTickListeners.delete(key);
      }
    };
  }

  public onCandle(symbol: string, listener: BinaryCandleListener): () => void {
    const key = symbol.trim().toUpperCase();
    let set = this.candleListeners.get(key);
    if (!set) {
      set = new Set();
      this.candleListeners.set(key, set);
    }
    set.add(listener);
    this.ensureStarted();

    return () => {
      const current = this.candleListeners.get(key);
      if (current) {
        current.delete(listener);
        if (current.size === 0) this.candleListeners.delete(key);
      }
    };
  }

  public onDepth(symbol: string, listener: BinaryDepthListener): () => void {
    const key = symbol.trim().toUpperCase();
    let set = this.depthListeners.get(key);
    if (!set) {
      set = new Set();
      this.depthListeners.set(key, set);
    }
    set.add(listener);
    this.ensureStarted();

    const warm = this.latestDepths.get(key);
    if (warm) {
      queueMicrotask(() => {
        if (set?.has(listener)) {
          try { listener(warm); } catch { /* ignore */ }
        }
      });
    }

    return () => {
      const current = this.depthListeners.get(key);
      if (current) {
        current.delete(listener);
        if (current.size === 0) this.depthListeners.delete(key);
      }
    };
  }

  public subscribeTradeEvents(listener: BinaryTradeEventListener): () => void {
    const wasEmpty = this.tradeEventListeners.size === 0;
    this.tradeEventListeners.add(listener);
    this.start();
    if (wasEmpty && this.connected) {
      this.syncAccountSubscription();
    }
    return () => {
      this.tradeEventListeners.delete(listener);
    };
  }

  public onStateChange(listener: StreamStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.connected);
    this.ensureStarted();
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private hasConsumers(): boolean {
    return (
      this.tickListeners.size > 0
      || this.directChartTickListeners.size > 0
      || this.candleListeners.size > 0
      || this.depthListeners.size > 0
      || this.tradeEventListeners.size > 0
      || this.stateListeners.size > 0
    );
  }

  private setConnected(next: boolean): void {
    if (this.connected === next) return;
    this.connected = next;
    this.stateListeners.forEach((cb) => {
      try { cb(next); } catch { /* ignore */ }
    });
    // dealing begin
    if (!next) {
      notifyDealingStreamDisconnectedHook();
    }
    // dealing end
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || !this.hasConsumers()) {
      this.running = false;
      return;
    }
    const delay = Math.min(150 * Math.pow(1.6, Math.min(this.reconnectAttempts, 8)), 2_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.running = false;
      if (this.hasConsumers()) {
        this.ensureStarted();
      }
    }, delay);
  }

  private async connectStreamLoop(): Promise<void> {
    if (!this.isSupported()) {
      this.running = false;
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;
    this.accumLen = 0;

    // Silence watchdog: started before the request so it also covers a server that never answers.
    // Tracks actual market-data frames (0x21/0x22/0x23/0x24) rather than raw chunks so 0x05 keepalive
    // pings alone cannot prevent reconnect when the upstream tick feed dies.
    let silenced = false;
    let lastSeenMarketDataFrames = this.marketDataFramesReceived;
    let lastProgressAt = Date.now();
    const silenceWatchdog = setInterval(() => {
      const now = Date.now();
      if (this.marketDataFramesReceived !== lastSeenMarketDataFrames) {
        lastSeenMarketDataFrames = this.marketDataFramesReceived;
        lastProgressAt = now;
        return;
      }
      if (now - lastProgressAt >= STREAM_SILENCE_RECONNECT_MS && !controller.signal.aborted) {
        silenced = true;
        this.refreshTokenOnNextBind = true;
        console.warn(`[BinaryTcpMarketStream] no market data frames for ${Math.round((now - lastProgressAt) / 1000)}s; reconnecting the stream`);
        try { controller.abort(); } catch { /* ignore */ }
      }
    }, STREAM_SILENCE_CHECK_MS);

    try {
      const response = await fetch('/__rtx5_binary_stream', {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
        cache: 'no-store',
      });

      if (!response.ok || !response.body) {
        throw new Error(`Binary TCP stream HTTP ${response.status}`);
      }

      // Reset cached account-sub deduplication guard and force re-POST onto the
      // newly opened `/__rtx5_binary_stream` connection so local Go DesktopClient
      // restarts while WebView2 stays open always re-bind `0x3B`.
      this.boundAccountKey = null;
      this.inFlightAccountKey = null;
      this.reconnectAttempts = 0;
      this.setConnected(true);
      if (this.refreshTokenOnNextBind) {
        this.refreshTokenOnNextBind = false;
        void this.refreshStaleTokenThenBindAccount(controller);
      } else {
        this.syncAccountSubscription(undefined, true);
      }

      const reader = response.body.getReader();
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          this.consumeChunk(value);
        }
      }
    } catch {
      // Stream interrupted or aborted — reconnect cleanly below
    } finally {
      clearInterval(silenceWatchdog);
      // A newer stream already started (forceReconnect): this one must not schedule a second one.
      const superseded = this.abortController !== null && this.abortController !== controller;
      if (this.abortController === controller) {
        this.abortController = null;
      }
      this.boundAccountKey = null;
      this.inFlightAccountKey = null;
      this.setConnected(false);
      // An abort by forceReconnect() starts its own new stream; an abort by the silence watchdog must reconnect here.
      if ((!controller.signal.aborted || silenced) && !superseded) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * After a silence reconnect, an idle session may hold an expired access token whose server-side quote
   * gate was cleared by a 401. Refresh first (single-flight, through the existing BrokerAPI refresh flow),
   * then re-POST the 0x3B account subscription. A failed refresh keeps the previous behaviour: re-bind
   * with whatever token is stored; no retry loop.
   */
  private async refreshStaleTokenThenBindAccount(controller: AbortController): Promise<void> {
    const tokenBefore = (getAccessToken() ?? '').trim();
    // Never leave the account unbound behind a hung refresh: after STREAM_TOKEN_REFRESH_WAIT_MS bind with the
    // stored token anyway. A refresh that lands later re-binds through `auth:token-updated`.
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.refreshTokenIfStale(tokenBefore),
        new Promise<void>((resolve) => {
          waitTimer = setTimeout(resolve, STREAM_TOKEN_REFRESH_WAIT_MS);
        }),
      ]);
    } catch {
      /* keep today's behaviour: bind with the stored token */
    } finally {
      if (waitTimer !== undefined) clearTimeout(waitTimer);
    }
    if (controller.signal.aborted) return;
    const tokenAfter = (getAccessToken() ?? '').trim();
    // A refreshed token already triggers a non-forced bind through `auth:token-updated`; the
    // non-forced call below is then a no-op. Unchanged token => force the re-bind on the new stream.
    this.syncAccountSubscription(undefined, tokenAfter === tokenBefore);
  }

  private refreshTokenIfStale(token: string): Promise<void> {
    if (this.tokenRefreshInFlight) return this.tokenRefreshInFlight;
    const exp = Number(decodeJwtPayload(token)?.exp);
    if (!Number.isFinite(exp) || exp * 1000 - Date.now() > STREAM_TOKEN_REFRESH_LEAD_MS) {
      return Promise.resolve();
    }
    const run = (async () => {
      const { brokerApi } = await import('../api/brokerApi');
      await brokerApi.refreshTokenAhead();
    })().finally(() => {
      this.tokenRefreshInFlight = null;
    });
    this.tokenRefreshInFlight = run;
    return run;
  }

  private consumeChunk(chunk: Uint8Array): void {
    const required = this.accumLen + chunk.byteLength;
    if (required > this.accumBuf.byteLength) {
      let nextCap = this.accumBuf.byteLength * 2;
      while (nextCap < required) nextCap *= 2;
      const grown = new Uint8Array(nextCap);
      if (this.accumLen > 0) {
        grown.set(this.accumBuf.subarray(0, this.accumLen), 0);
      }
      this.accumBuf = grown;
    }

    this.accumBuf.set(chunk, this.accumLen);
    this.accumLen += chunk.byteLength;

    const buf = this.accumBuf;
    const view = new DataView(buf.buffer, buf.byteOffset, this.accumLen);
    let offset = 0;

    while (this.accumLen - offset >= 4) {
      const frameType = buf[offset];
      const payloadLen = view.getUint16(offset + 2, true);
      const frameEnd = offset + 4 + payloadLen;
      if (frameEnd > this.accumLen) {
        break;
      }

      const payloadOffset = offset + 4;
      if (frameType === FRAME_BINARY_TICK_BATCH && payloadLen >= 2) {
        this.marketDataFramesReceived++;
        this.lastMarketDataAt = Date.now();
        this.decodeTickBatch(buf, view, payloadOffset, payloadLen);
      } else if (frameType === FRAME_BINARY_CANDLE_BATCH && payloadLen >= 2) {
        this.marketDataFramesReceived++;
        this.lastMarketDataAt = Date.now();
        this.decodeCandleBatch(buf, view, payloadOffset, payloadLen);
      } else if (frameType === FRAME_BINARY_MARKET_DATA_EXT) {
        this.marketDataFramesReceived++;
        this.lastMarketDataAt = Date.now();
      } else if (frameType === FRAME_BINARY_DEPTH_BATCH && payloadLen >= 2) {
        this.marketDataFramesReceived++;
        this.lastMarketDataAt = Date.now();
        this.decodeDepthBatch(buf, view, payloadOffset, payloadLen);
      } else if (frameType === FRAME_BINARY_TRADE_EVENT && payloadLen >= BINARY_TRADE_EVENT_MIN_SIZE) {
        this.decodeTradeEventFrame(buf, payloadOffset, payloadLen);
      }
      // 0x00 (initial pad) and 0x05 (FramePing keepalive) are skipped in O(1) without resetting market-data silence.
      offset = frameEnd;
    }

    if (offset > 0) {
      const remaining = this.accumLen - offset;
      if (remaining > 0) {
        buf.copyWithin(0, offset, this.accumLen);
      }
      this.accumLen = remaining;
    }
  }

  private shouldDeferForActiveBinaryOrder(): boolean {
    if (
      getActiveBinaryTcpOrderCount() <= 0
      || getBinaryTcpOrderActiveDurationMs() >= MAX_BINARY_ORDER_STREAM_DEFER_MS
    ) {
      return false;
    }
    const now = Date.now();
    if (this.deferredSinceMs === 0) {
      this.deferredSinceMs = now;
      return true;
    }
    return now - this.deferredSinceMs < MAX_CONSECUTIVE_STREAM_DEFER_MS;
  }

  private scheduleDeferredFlushSafety(): void {
    if (this.deferredFlushTimer !== null) return;
    this.deferredFlushTimer = setTimeout(() => {
      this.deferredFlushTimer = null;
      this.flushDeferredNotifications();
    }, 45);
  }

  private flushDeferredNotifications(): void {
    if (this.deferredFlushTimer !== null) {
      clearTimeout(this.deferredFlushTimer);
      this.deferredFlushTimer = null;
    }

    if (this.shouldDeferForActiveBinaryOrder()) {
      if (
        this.deferredTicks.size > 0
        || this.deferredCandles.size > 0
        || this.deferredDepths.size > 0
        || this.deferredTradeEvents.length > 0
      ) {
        this.scheduleDeferredFlushSafety();
      }
      return;
    }

    this.deferredSinceMs = 0;

    if (this.deferredTicks.size > 0) {
      const pendingTicks = Array.from(this.deferredTicks.values());
      this.deferredTicks.clear();
      for (let i = 0; i < pendingTicks.length; i++) {
        const tick = pendingTicks[i];
        const chartListeners = this.directChartTickListeners.get(tick.symbol);
        if (chartListeners && chartListeners.size > 0) {
          chartListeners.forEach((cb) => {
            try { cb(tick); } catch { /* ignore */ }
          });
        }
        if (this.tickListeners.size > 0) {
          this.tickListeners.forEach((cb) => {
            try { cb(tick); } catch { /* ignore */ }
          });
        }
      }
    }

    if (this.deferredCandles.size > 0) {
      const pendingCandles = Array.from(this.deferredCandles.values());
      this.deferredCandles.clear();
      for (let i = 0; i < pendingCandles.length; i++) {
        const candle = pendingCandles[i];
        const listeners = this.candleListeners.get(candle.symbol);
        if (listeners && listeners.size > 0) {
          listeners.forEach((cb) => {
            try { cb(candle); } catch { /* ignore */ }
          });
        }
      }
    }

    if (this.deferredDepths.size > 0) {
      const pendingDepths = Array.from(this.deferredDepths.values());
      this.deferredDepths.clear();
      for (let i = 0; i < pendingDepths.length; i++) {
        const depth = pendingDepths[i];
        const listeners = this.depthListeners.get(depth.symbol);
        if (listeners && listeners.size > 0) {
          listeners.forEach((cb) => {
            try { cb(depth); } catch { /* ignore */ }
          });
        }
      }
    }

    if (this.deferredTradeEvents.length > 0) {
      const events = this.deferredTradeEvents;
      this.deferredTradeEvents = [];
      this.deferredTradeCoalesce.clear();
      this.deferredTradeScopeEpoch.clear();
      if (this.tradeEventListeners.size > 0) {
        for (let i = 0; i < events.length; i++) {
          const ev = events[i];
          this.tradeEventListeners.forEach((cb) => {
            try { cb(ev); } catch { /* ignore */ }
          });
        }
      }
    }
  }

  private enqueueDeferredTradeEvent(ev: DecodedBinaryTradeEvent): void {
    const scope = getTradeEventScope(ev);
    const key = getTradeEventCoalesceKey(ev);
    if (key === null) {
      this.deferredTradeScopeEpoch.set(scope, (this.deferredTradeScopeEpoch.get(scope) ?? 0) + 1);
      this.deferredTradeEvents.push(ev);
      return;
    }
    const epoch = this.deferredTradeScopeEpoch.get(scope) ?? 0;
    const prior = this.deferredTradeCoalesce.get(key);
    if (prior !== undefined && prior.epoch === epoch) {
      this.deferredTradeEvents[prior.index] = ev;
      return;
    }
    this.deferredTradeCoalesce.set(key, { index: this.deferredTradeEvents.length, epoch });
    this.deferredTradeEvents.push(ev);
  }

  // dealing begin
  private resolveActiveDealingLogin(): number {
    const key = this.boundAccountKey ?? this.inFlightAccountKey;
    if (key) {
      const colon = key.indexOf(':');
      if (colon > 0) {
        const parsed = parsePositiveFiniteInt(key.slice(0, colon));
        if (parsed > 0) return parsed;
      }
    }
    const token = (getAccessToken() ?? '').trim();
    return resolveActiveAccountLogin(undefined, token);
  }
  // dealing end

  private decodeTradeEventFrame(
    buf: Uint8Array,
    payloadOffset: number,
    payloadLen: number,
  ): void {
    // dealing begin
    if (buf[payloadOffset + 1] === DEALING_WIRE_TRADE_EVENT_KIND && buf[payloadOffset] === 1) {
      dispatchDealingTradeEventHook(buf, payloadOffset, payloadLen, this.resolveActiveDealingLogin());
      return;
    }
    // dealing end
    if (this.tradeEventListeners.size === 0) return;
    const decoded = decodeBinaryTradeEvent(buf.subarray(payloadOffset, payloadOffset + payloadLen));
    if (!decoded) return;

    const nowMs = Date.now();
    const sig = `${decoded.channel}|${decoded.rawText}`;
    if (sig === this.lastTradeEventSig && nowMs - this.lastTradeEventAtMs < 25) {
      return;
    }
    this.lastTradeEventSig = sig;
    this.lastTradeEventAtMs = nowMs;

    if (this.shouldDeferForActiveBinaryOrder()) {
      this.enqueueDeferredTradeEvent(decoded);
      this.scheduleDeferredFlushSafety();
      return;
    }

    this.tradeEventListeners.forEach((cb) => {
      try { cb(decoded); } catch { /* ignore */ }
    });
  }

  private decodeTickBatch(
    buf: Uint8Array,
    view: DataView,
    payloadOffset: number,
    payloadLen: number,
  ): void {
    const count = view.getUint16(payloadOffset, true);
    const maxRecords = Math.min(count, Math.floor((payloadLen - 2) / BINARY_TICK_RECORD_SIZE));
    const deferUIListeners = this.shouldDeferForActiveBinaryOrder();
    let off = payloadOffset + 2;

    for (let i = 0; i < maxRecords; i++, off += BINARY_TICK_RECORD_SIZE) {
      const symbol = decodeFixedAsciiSymbol(buf, off);
      if (!symbol) continue;

      const rawTsMs = readUint64LE(view, off + 16);
      const bid = view.getFloat64(off + 24, true);
      const askRaw = view.getFloat64(off + 32, true);
      const sequence = readUint64LE(view, off + 40);

      if (!Number.isFinite(bid) || bid <= 0) continue;
      const ask = Number.isFinite(askRaw) && askRaw > 0 ? askRaw : bid;
      // A wrong/future server timestamp must not make every later tick look older (see tickTimestampGuard).
      const timestamp = rawTsMs > 0 ? this.tickTimestampGuard.resolve(symbol, rawTsMs) : Date.now();
      if (timestamp > this.latestTickTimestampMs) this.latestTickTimestampMs = timestamp;
      const utcDay = Math.floor(timestamp / UTC_DAY_MS);

      let stats = this.dayStats.get(symbol);
      if (!stats || stats.utcDay !== utcDay) {
        stats = { utcDay, openBid: bid, highBid: bid, lowBid: bid };
        this.dayStats.set(symbol, stats);
      } else {
        if (bid > stats.highBid) stats.highBid = bid;
        if (bid < stats.lowBid) stats.lowBid = bid;
      }

      const dailyChange = stats.openBid > 0
        ? ((bid - stats.openBid) / stats.openBid) * 100
        : 0;

      const decoded: DecodedBinaryTick = {
        symbol,
        bid,
        ask,
        spread: ask - bid,
        timestamp,
        sourceTimestamp: timestamp,
        sequence,
        dailyOpen: stats.openBid,
        high24h: stats.highBid,
        low24h: stats.lowBid,
        dailyChange,
      };

      this.latestTicks.set(symbol, decoded);

      if (deferUIListeners) {
        if (this.tickListeners.size > 0 || this.directChartTickListeners.has(symbol)) {
          this.deferredTicks.set(symbol, decoded);
        }
        continue;
      }

      // 1. Direct per-symbol chart listeners (zero-delay VSync fast path)
      const chartListeners = this.directChartTickListeners.get(symbol);
      if (chartListeners && chartListeners.size > 0) {
        chartListeners.forEach((cb) => {
          try { cb(decoded); } catch { /* ignore */ }
        });
      }

      // 2. General tick subscribers (QuoteSocketManager active demand filter)
      if (this.tickListeners.size > 0) {
        this.tickListeners.forEach((cb) => {
          try { cb(decoded); } catch { /* ignore */ }
        });
      }
    }

    if (deferUIListeners && this.deferredTicks.size > 0) {
      this.scheduleDeferredFlushSafety();
    }
  }

  private decodeCandleBatch(
    buf: Uint8Array,
    view: DataView,
    payloadOffset: number,
    payloadLen: number,
  ): void {
    const count = view.getUint16(payloadOffset, true);
    const maxRecords = Math.min(count, Math.floor((payloadLen - 2) / BINARY_CANDLE_RECORD_SIZE));
    const deferUIListeners = this.shouldDeferForActiveBinaryOrder();
    let off = payloadOffset + 2;

    for (let i = 0; i < maxRecords; i++, off += BINARY_CANDLE_RECORD_SIZE) {
      const symbol = decodeFixedAsciiSymbol(buf, off);
      if (!symbol) continue;

      const rawTime = readUint64LE(view, off + 16);
      const open = view.getFloat64(off + 24, true);
      const high = view.getFloat64(off + 32, true);
      const low = view.getFloat64(off + 40, true);
      const close = view.getFloat64(off + 48, true);
      const tickVolume = view.getUint32(off + 56, true);
      const flags = buf[off + 60];
      const tfCode = buf[off + 61];

      if (
        rawTime <= 0
        || !Number.isFinite(open) || open <= 0
        || !Number.isFinite(high) || high <= 0
        || !Number.isFinite(low) || low <= 0
        || !Number.isFinite(close) || close <= 0
      ) {
        continue;
      }

      // Guard future-skewed 0x22 candle timestamps so a clock-skewed candle cannot
      // advance chart time into the future and permanently freeze subsequent 0x21 ticks.
      const isMs = rawTime >= 1_000_000_000_000;
      const rawTimeMs = isMs ? rawTime : rawTime * 1000;
      const symbolRefMs = this.latestTicks.get(symbol)?.timestamp ?? this.latestTickTimestampMs;
      let time = rawTime;
      if (symbolRefMs > 0 && rawTimeMs > symbolRefMs) {
        const guardedMs = this.tickTimestampGuard.resolve(symbol, rawTimeMs);
        time = isMs ? guardedMs : Math.floor(guardedMs / 1000);
      }

      const timeframe = TF_CODE_TO_STRING[tfCode] ?? 'M1';
      const closed = (flags & CANDLE_FLAG_CLOSED) !== 0;

      const candle: DecodedBinaryCandle = {
        symbol,
        timeframe,
        time,
        open,
        high,
        low,
        close,
        volume: tickVolume,
        tickVolume,
        closed,
      };

      if (timeframe === 'M1') {
        this.latestM1Candles.set(symbol, candle);
      }

      if (deferUIListeners) {
        if (this.candleListeners.has(symbol)) {
          this.deferredCandles.set(`${symbol}|${timeframe}`, candle);
        }
        continue;
      }

      const listeners = this.candleListeners.get(symbol);
      if (listeners && listeners.size > 0) {
        listeners.forEach((cb) => {
          try { cb(candle); } catch { /* ignore */ }
        });
      }
    }

    if (deferUIListeners && this.deferredCandles.size > 0) {
      this.scheduleDeferredFlushSafety();
    }
  }

  private decodeDepthBatch(
    buf: Uint8Array,
    view: DataView,
    payloadOffset: number,
    payloadLen: number,
  ): void {
    const count = view.getUint16(payloadOffset, true);
    const maxRecords = Math.min(count, Math.floor((payloadLen - 2) / BINARY_DEPTH_RECORD_SIZE));
    const deferUIListeners = this.shouldDeferForActiveBinaryOrder();
    let off = payloadOffset + 2;

    for (let i = 0; i < maxRecords; i++, off += BINARY_DEPTH_RECORD_SIZE) {
      const symbol = decodeFixedAsciiSymbol(buf, off);
      if (!symbol) continue;

      const rawTsMs = readUint64LE(view, off + 16);
      const sequence = readUint64LE(view, off + 24);
      const bidCount = Math.min(buf[off + 32], BINARY_DEPTH_MAX_LEVELS);
      const askCount = Math.min(buf[off + 33], BINARY_DEPTH_MAX_LEVELS);

      const bids: DecodedBinaryDepthLevel[] = [];
      let bidTotal = 0;
      const bidsBase = off + BINARY_DEPTH_HEADER_SIZE;
      for (let b = 0; b < bidCount; b++) {
        const levelOff = bidsBase + b * BINARY_DEPTH_LEVEL_SIZE;
        const price = view.getFloat64(levelOff, true);
        const volume = view.getFloat64(levelOff + 8, true);
        if (Number.isFinite(price) && price > 0 && Number.isFinite(volume) && volume > 0) {
          bidTotal += volume;
          bids.push({ price, volume, total: bidTotal });
        }
      }

      const asks: DecodedBinaryDepthLevel[] = [];
      let askTotal = 0;
      const asksBase = off + BINARY_DEPTH_HEADER_SIZE + BINARY_DEPTH_MAX_LEVELS * BINARY_DEPTH_LEVEL_SIZE;
      for (let a = 0; a < askCount; a++) {
        const levelOff = asksBase + a * BINARY_DEPTH_LEVEL_SIZE;
        const price = view.getFloat64(levelOff, true);
        const volume = view.getFloat64(levelOff + 8, true);
        if (Number.isFinite(price) && price > 0 && Number.isFinite(volume) && volume > 0) {
          askTotal += volume;
          asks.push({ price, volume, total: askTotal });
        }
      }

      if (bids.length === 0 && asks.length === 0) continue;

      const bestBid = bids[0]?.price ?? 0;
      const bestAsk = asks[0]?.price ?? 0;
      const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0;
      const timestamp = rawTsMs > 0 ? rawTsMs : Date.now();

      const decoded: DecodedBinaryDepth = {
        symbol,
        timestamp,
        sequence,
        bids,
        asks,
        spread,
      };

      this.latestDepths.set(symbol, decoded);

      if (deferUIListeners) {
        if (this.depthListeners.has(symbol)) {
          this.deferredDepths.set(symbol, decoded);
        }
        continue;
      }

      const listeners = this.depthListeners.get(symbol);
      if (listeners && listeners.size > 0) {
        listeners.forEach((cb) => {
          try { cb(decoded); } catch { /* ignore */ }
        });
      }
    }

    if (deferUIListeners && this.deferredDepths.size > 0) {
      this.scheduleDeferredFlushSafety();
    }
  }
}

export const binaryTcpMarketStream = new BinaryTcpMarketStream();

export function subscribeTradeEvents(
  listener: (ev: DecodedBinaryTradeEvent) => void,
): () => void {
  return binaryTcpMarketStream.subscribeTradeEvents(listener);
}


