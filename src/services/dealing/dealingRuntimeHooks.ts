/**
 * Minimal, zero-dependency dealing runtime hook registry & D18 capability gate.
 *
 * Intentionally imports NOTHING from `binaryDealingCodec`, `dealingEvents`,
 * `dealingReducer`, `dealingOrderClient`, `dealingMarketStreamBridge`, `useDealingStore`,
 * or `useDealingRequest` so `binaryTcpOrderClient.ts` and `binaryTcpMarketStream.ts`
 * add negligible bytes to the eager bundle while all dealing logic stays in lazy chunks.
 */

// ─── Wire Constants (literals matching binaryDealingCodec.ts & API_CONTRACT) ─

export const DEALING_WIRE_ACTION_REQUOTE_ACCEPT = 9;
export const DEALING_WIRE_ACTION_REQUOTE_DECLINE = 10;
/** Capability probe + client-pulled pending state sync (DECISIONS.md D18). */
export const DEALING_WIRE_ACTION_SYNC = 11;

export const DEALING_WIRE_EXTRA_TAG_REQUEST_UUID = 0x14;
export const DEALING_WIRE_EXTRA_TAG_REQUOTE_UUID = 0x15;
export const DEALING_WIRE_EXTRA_TAG_CLIENT_CAPS = 0x16;
export const DEALING_WIRE_CLIENT_CAP_V1 = 0x0000_0001;

/** Response TLV tag returned by Action 11 DealingSync (`1` byte: `1` = enabled). */
export const DEALING_WIRE_RESP_TAG_DEALING_ENABLED = 0x2a;
export const DEALING_WIRE_TRADE_EVENT_KIND = 7;

/** Neutral outcome for a dealing-queued order with no dealer result by its deadline (never a failure claim). */
export const DEALING_OUTCOME_PENDING_CODE = 'DEALING_OUTCOME_PENDING';
export const DEALING_OUTCOME_PENDING_MESSAGE =
  'Your order is still being processed by the dealer. Check Positions for the result and do not place it again.';

/**
 * Enabled: as of this release the `web-terminal-server` bridge (`binary_order_bridge.go` +
 * `rtx5-tcp-protocol`) passes TLV extras and Actions 9/10/11. TLV `0x16` is still sent only after
 * the gateway advertises dealing via DealingSync (Action 11, TLV `0x2A` = 1).
 * Desktop `clientcore` bridge NEVER enables dealing (DECISIONS.md D9 / D18).
 */
export const WEB_TERMINAL_DEALING_BRIDGE_ENABLED = true;

// ─── Runtime / Bridge Detection (R1 BLOCKER-1, D9, D18) ───────────────────────

interface DealingWindowLike {
  electron?: { window?: unknown };
  electronAPI?: { platform?: unknown };
  rtx5Electron?: { platform?: unknown };
  location?: { protocol?: string };
  __RTX5_RUNTIME_CONFIG__?: Record<string, unknown>;
  __RTX_RUNTIME_CONFIG__?: Record<string, unknown>;
  RUNTIME_CONFIG?: Record<string, unknown>;
  __RUNTIME_CONFIG__?: Record<string, unknown>;
}

const DESKTOP_TARGET_RE = /^(desktop|electron|direct)$/i;

function readDealingRuntimeConfig(): Record<string, unknown> | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const g = globalThis as unknown as DealingWindowLike;
  return (
    g.__RTX5_RUNTIME_CONFIG__
    ?? g.__RTX_RUNTIME_CONFIG__
    ?? g.RUNTIME_CONFIG
    ?? g.__RUNTIME_CONFIG__
  );
}

function readConfigTargetValue(config: Record<string, unknown> | undefined): string {
  if (!config) return '';
  const keys = [
    'BACKEND_TARGET',
    'BACKEND_MODE',
    'VITE_BACKEND_TARGET',
    'VITE_BACKEND_MODE',
    'backendTarget',
    'backend_target',
    'backendMode',
    'backend_mode',
  ];
  for (let i = 0; i < keys.length; i++) {
    const val = config[keys[i]];
    if (val !== undefined && val !== null) {
      const s = String(val).trim();
      if (s) return s;
    }
  }
  return '';
}

/** True when running inside the Go `web-terminal-server` browser bridge (`platform === 'web-tcp'`). */
export function isWebTerminalBridgeRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as DealingWindowLike;
  const p1 = w.rtx5Electron?.platform;
  const p2 = w.electronAPI?.platform;
  return (
    (typeof p1 === 'string' && p1.trim().toLowerCase() === 'web-tcp')
    || (typeof p2 === 'string' && p2.trim().toLowerCase() === 'web-tcp')
  );
}

/**
 * True when running inside the desktop `clientcore` WebView2 / Electron wrapper.
 * Always `false` for the `web-tcp` Web Terminal bridge.
 */
export function isDesktopClientCoreBridgeRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  if (isWebTerminalBridgeRuntime()) return false;
  const w = window as unknown as DealingWindowLike;
  if (
    w.electron?.window
    || w.electronAPI
    || w.rtx5Electron
    || w.location?.protocol === 'file:'
    || (typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron'))
  ) {
    return true;
  }
  const cfg = readDealingRuntimeConfig();
  if (cfg && cfg.CONFIG_SOURCE === 'deployment') {
    return false;
  }
  return DESKTOP_TARGET_RE.test(readConfigTargetValue(cfg));
}

let transportSupportedOverride: boolean | null = null;

/**
 * True ONLY when the local transport bridge supports passing TLV `0x16` + Actions 9/10/11.
 * Never returns `true` for the desktop `clientcore` bridge (D9/D18).
 */
export function isDealingTransportSupported(): boolean {
  if (transportSupportedOverride !== null) {
    return transportSupportedOverride;
  }
  if (isDesktopClientCoreBridgeRuntime()) {
    return false;
  }
  if (!isWebTerminalBridgeRuntime()) {
    return false;
  }
  if (WEB_TERMINAL_DEALING_BRIDGE_ENABLED) {
    return true;
  }
  const cfg = readDealingRuntimeConfig();
  return cfg?.DEALING_BRIDGE_V1 === true || cfg?.DEALING_BRIDGE_V1 === 'true';
}

// ─── Cached Session Capability Gate ──────────────────────────────────────────

let dealingServerAdvertised = false;
let dealingWireGateOpen = false;

function recomputeGate(): boolean {
  dealingWireGateOpen = dealingServerAdvertised && isDealingTransportSupported();
  dealingOrderHooks.wireGateOpen = dealingWireGateOpen;
  return dealingWireGateOpen;
}

export function isDealingWireGateOpen(): boolean {
  return dealingWireGateOpen;
}

export function isDealingServerAdvertised(): boolean {
  return dealingServerAdvertised;
}

export function setDealingServerAdvertised(enabled: boolean): boolean {
  dealingServerAdvertised = Boolean(enabled);
  return recomputeGate();
}

export function refreshDealingWireGate(): boolean {
  return recomputeGate();
}

/** Test-only transport override (used in unit tests to exercise gate-on flows cleanly). */
export function __setDealingTransportSupportedForTests(supported: boolean | null): void {
  transportSupportedOverride = supported;
  recomputeGate();
}

// ─── Minimal Transport & Hook Pointers (populated lazily by DealingShellHost) ─

export interface DealingOrderErrorOptions {
  status: number;
  code?: string;
  retryable?: boolean;
  clientOrderId?: string;
  execMicros?: number;
  action?: number;
  backendMessage?: string;
}

export interface DealingRawFrameTransport {
  isEnabled: () => boolean;
  getAccessToken: () => string;
  getOpenWebSocket: () => WebSocket | null;
  ensureWebSocket: () => WebSocket | null;
  allocateWsReqId: () => number;
  acquireActiveSlot: () => () => void;
  resolveHttpEndpoint: () => string;
  fallbackHttpEndpoint: string;
  markFastEndpointUnreachable: () => void;
  defaultTimeoutMs: number;
  createOrderError: (message: string, options: DealingOrderErrorOptions) => Error;
}

export interface DealingOrderClientHooks {
  wireGateOpen: boolean;
  applyClientCaps: ((validated: { flags: number; extrasBytes: Uint8Array }) => void) | null;
  tryPrepareFastWsModeAWithCaps: ((
    reqId: number,
    extrasBytes: Uint8Array,
  ) => { packet: Uint8Array<ArrayBuffer>; view: DataView } | null) | null;
  ingestOrderResp: ((
    rawBuffer: ArrayBuffer,
    byteOffset: number,
    decoded: { action: number; status: number; clientOrderId: string },
    validated: {
      action: number;
      side: number;
      login: number;
      volume: number;
      price: number;
      sl: number;
      tp: number;
      extrasBytes: Uint8Array;
    },
    effectiveClientOrderId: string,
    msgEndOffset?: number,
  ) => void) | null;
  resolveRawWsOrder: ((reqId: number, raw: ArrayBuffer) => boolean) | null;
  failAllRawWsOrders: ((reason: string) => void) | null;
}

export const dealingOrderHooks: DealingOrderClientHooks = {
  wireGateOpen: false,
  applyClientCaps: null,
  tryPrepareFastWsModeAWithCaps: null,
  ingestOrderResp: null,
  resolveRawWsOrder: null,
  failAllRawWsOrders: null,
};

export function registerDealingOrderClientHooks(
  hooks: Omit<DealingOrderClientHooks, 'wireGateOpen'>,
): () => void {
  dealingOrderHooks.applyClientCaps = hooks.applyClientCaps;
  dealingOrderHooks.tryPrepareFastWsModeAWithCaps = hooks.tryPrepareFastWsModeAWithCaps;
  dealingOrderHooks.ingestOrderResp = hooks.ingestOrderResp;
  dealingOrderHooks.resolveRawWsOrder = hooks.resolveRawWsOrder;
  dealingOrderHooks.failAllRawWsOrders = hooks.failAllRawWsOrders;

  return () => {
    if (dealingOrderHooks.applyClientCaps === hooks.applyClientCaps) {
      dealingOrderHooks.applyClientCaps = null;
    }
    if (dealingOrderHooks.tryPrepareFastWsModeAWithCaps === hooks.tryPrepareFastWsModeAWithCaps) {
      dealingOrderHooks.tryPrepareFastWsModeAWithCaps = null;
    }
    if (dealingOrderHooks.ingestOrderResp === hooks.ingestOrderResp) {
      dealingOrderHooks.ingestOrderResp = null;
    }
    if (dealingOrderHooks.resolveRawWsOrder === hooks.resolveRawWsOrder) {
      dealingOrderHooks.resolveRawWsOrder = null;
    }
    if (dealingOrderHooks.failAllRawWsOrders === hooks.failAllRawWsOrders) {
      dealingOrderHooks.failAllRawWsOrders = null;
    }
  };
}

// ─── Market Stream Kind 7 & Post-Subscribe Hooks ─────────────────────────────

export type DealingTradeEventHook = (
  buf: Uint8Array,
  payloadOffset: number,
  payloadLen: number,
  activeAccountLogin: number,
) => void;

export interface DealingSubscribedAccountInfo {
  accountLogin: number;
  authToken: string;
  connectionEpoch: number;
}

export type DealingAccountSubscribedHook = (info: DealingSubscribedAccountInfo) => void;

let tradeEventHook: DealingTradeEventHook | null = null;
let accountSubscribedHook: DealingAccountSubscribedHook | null = null;
let lastSubscribedAccount: DealingSubscribedAccountInfo | null = null;
let streamConnectionEpoch = 0;

export function registerDealingTradeEventHook(handler: DealingTradeEventHook | null): () => void {
  tradeEventHook = handler;
  return () => {
    if (tradeEventHook === handler) {
      tradeEventHook = null;
    }
  };
}

export function dispatchDealingTradeEventHook(
  buf: Uint8Array,
  payloadOffset: number,
  payloadLen: number,
  activeAccountLogin: number,
): void {
  if (tradeEventHook !== null) {
    tradeEventHook(buf, payloadOffset, payloadLen, activeAccountLogin);
  }
}

export function registerDealingAccountSubscribedHook(
  handler: DealingAccountSubscribedHook | null,
): () => void {
  accountSubscribedHook = handler;
  return () => {
    if (accountSubscribedHook === handler) {
      accountSubscribedHook = null;
    }
  };
}

export function notifyDealingAccountSubscribedHook(
  accountLogin: number,
  authToken: string,
): void {
  if (!Number.isSafeInteger(accountLogin) || accountLogin <= 0) {
    lastSubscribedAccount = null;
    return;
  }
  const info: DealingSubscribedAccountInfo = {
    accountLogin,
    authToken,
    connectionEpoch: streamConnectionEpoch,
  };
  lastSubscribedAccount = info;
  if (accountSubscribedHook !== null) {
    accountSubscribedHook(info);
  }
}

export function notifyDealingStreamDisconnectedHook(): void {
  streamConnectionEpoch++;
  lastSubscribedAccount = null;
  setDealingServerAdvertised(false);
}

export function getLastSubscribedDealingAccount(): DealingSubscribedAccountInfo | null {
  return lastSubscribedAccount;
}

export function resetDealingCapabilityState(): void {
  dealingServerAdvertised = false;
  dealingWireGateOpen = false;
  dealingOrderHooks.wireGateOpen = false;
  transportSupportedOverride = null;
  lastSubscribedAccount = null;
  streamConnectionEpoch = 0;
}
