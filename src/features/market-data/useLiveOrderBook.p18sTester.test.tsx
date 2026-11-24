// @vitest-environment jsdom

import React, { Profiler, StrictMode } from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { resetAccountSpreadMarkupForTests } from '../../services/accountSpreadMarkup';
import type { DecodedBinaryDepth } from '../../services/binaryTcpMarketStream';
import { emitSessionChange } from '../../services/brokerSession';
import { useAppStore } from '../../store/useAppStore';
import type { LiveOrderBook } from './marketDataTypes';
import { useLiveOrderBook } from './useLiveOrderBook';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const createDeferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

type BinaryDepthCb = (decoded: DecodedBinaryDepth) => void;
type WsDepthCb = (message: unknown) => void;

interface OpenRestEntry {
  id: number;
  requestedSymbol: string;
  payloadSymbol: string;
  deferred: Deferred<unknown>;
  settled: boolean;
}

interface BinarySubEntry {
  id: number;
  symbol: string;
  cb: BinaryDepthCb;
  active: boolean;
}

interface WsSubEntry {
  id: number;
  channel: string;
  requestedSymbol: string;
  cb: WsDepthCb;
  active: boolean;
}

const mocks = vi.hoisted(() => {
  const fetchMarketDataJson = vi.fn();
  const binarySupported = { value: false };
  const binaryLatestDepths = new Map<string, DecodedBinaryDepth>();
  const binarySubs: BinarySubEntry[] = [];
  const wsSubs: WsSubEntry[] = [];
  const wsConnect = vi.fn();
  const openRests: OpenRestEntry[] = [];
  let nextRestId = 1;
  let nextSubId = 1;

  return {
    fetchMarketDataJson,
    binarySupported,
    binaryLatestDepths,
    binarySubs,
    wsSubs,
    wsConnect,
    openRests,
    nextRestId: () => nextRestId++,
    nextSubId: () => nextSubId++,
    resetCounters: () => {
      nextRestId = 1;
      nextSubId = 1;
    },
  };
});

vi.mock('./marketDataSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./marketDataSession')>();
  return {
    ...actual,
    fetchMarketDataJson: mocks.fetchMarketDataJson,
  };
});

vi.mock('../../services/binaryTcpMarketStream', () => ({
  binaryTcpMarketStream: {
    isSupported: () => mocks.binarySupported.value,
    getLatestDepth: (symbol: string) => mocks.binaryLatestDepths.get(symbol.trim().toUpperCase()) ?? null,
    onDepth: (symbol: string, cb: BinaryDepthCb) => {
      const normalized = symbol.trim().toUpperCase();
      const entry: BinarySubEntry = {
        id: mocks.nextSubId(),
        symbol: normalized,
        cb,
        active: true,
      };
      mocks.binarySubs.push(entry);
      return () => {
        entry.active = false;
      };
    },
  },
}));

vi.mock('../../services/websocket-enhanced', () => ({
  getEnhancedWebSocketService: () => ({
    connect: mocks.wsConnect,
    subscribe: (channel: string, cb: WsDepthCb) => {
      const requestedSymbol = channel.startsWith('depth.') ? channel.slice('depth.'.length) : channel;
      const entry: WsSubEntry = {
        id: mocks.nextSubId(),
        channel,
        requestedSymbol,
        cb,
        active: true,
      };
      mocks.wsSubs.push(entry);
      return () => {
        entry.active = false;
      };
    },
  }),
}));

vi.mock('../../services/brokerSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/brokerSession')>();
  return {
    ...actual,
    buildBrokerWsV2Uri: () => 'wss://broker-a.test/ws/v2',
  };
});

const makeRestBook = (symbol: string, priceId: number, volume = 10) => ({
  symbol,
  bids: [{ price: priceId, volume }],
  asks: [{ price: priceId + 0.5, volume }],
  timestamp: 1_700_000_000_000 + priceId,
});

const makeBinaryDepth = (symbol: string, priceId: number, sequence: number, volume = 10): DecodedBinaryDepth => ({
  symbol,
  timestamp: 1_700_000_000_000 + priceId,
  sequence,
  bids: [{ price: priceId, volume, total: volume }],
  asks: [{ price: priceId + 0.5, volume, total: volume }],
  spread: 0.5,
});

const makeWsMessage = (symbol: string, priceId: number, volume = 10) => ({
  symbol,
  bids: [{ price: priceId, volume }],
  asks: [{ price: priceId + 0.5, volume }],
  timestamp: 1_700_000_000_000 + priceId,
});

const payloadSymbolFor = (requestedSymbol: string): string => {
  const norm = requestedSymbol.trim().toUpperCase();
  return norm === 'XAUUSD.VIP' ? 'XAUUSD' : norm;
};

const createMulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface RenderObservation {
  symbol: string;
  authenticated: boolean;
  session: number;
  orderBook: LiveOrderBook | null;
  loading: boolean;
  error: string | null;
}

describe('P18S independent tester suite', () => {
  beforeEach(() => {
    mocks.fetchMarketDataJson.mockReset();
    mocks.wsConnect.mockReset();
    mocks.binarySupported.value = false;
    mocks.binaryLatestDepths.clear();
    mocks.binarySubs.length = 0;
    mocks.wsSubs.length = 0;
    mocks.openRests.length = 0;
    mocks.resetCounters();

    resetAccountSpreadMarkupForTests();
    useAppStore.setState({
      isAuthenticated: true,
      accountId: '1001',
      authToken: 'tester-token-0',
    });
  });

  afterEach(() => {
    cleanup();
    resetAccountSpreadMarkupForTests();
    useAppStore.setState({
      isAuthenticated: false,
      accountId: null,
      authToken: null,
    });
    vi.restoreAllMocks();
  });

  describe('Step 3(a): generated sequence property test against independent rules model', () => {
    it('maintains S1\'-S5 invariants across 420 generated sequences over EURUSD, XAUUSD, XAUUSD.VIP, and empty symbol', async () => {
      const rand = createMulberry32(0x5018_5001);
      const symbols = ['EURUSD', 'XAUUSD', 'XAUUSD.VIP', ''] as const;
      const depths = [5, 10, 20] as const;
      let nextPriceId = 1000;
      const allocPriceId = () => nextPriceId++;

      interface ModelState {
        symbol: string;
        depth: number;
        authenticated: boolean;
        session: number;
        activeRestId: number | null;
        activeBinarySubId: number | null;
        activeWsSubId: number | null;
        allowedPriceIds: Set<number>;
        expectedPriceId: number | null;
        expectedPayloadSymbol: string | null;
        expectedLoading: boolean;
        expectedError: string | null;
        restMeta: Map<number, {
          ownerKey: string;
          requestedSymbol: string;
          payloadSymbol: string;
        }>;
        binarySubMeta: Map<number, {
          ownerKey: string;
          requestedSymbol: string;
        }>;
        wsSubMeta: Map<number, {
          ownerKey: string;
          requestedSymbol: string;
        }>;
        cachePriceBySym: Map<string, number>;
      }

      const ownerKeyOf = (sym: string, auth: boolean, sess: number) => `${sym}|${auth ? 1 : 0}|${sess}`;

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const SEQUENCE_COUNT = 420;
      for (let seq = 0; seq < SEQUENCE_COUNT; seq += 1) {
        mocks.fetchMarketDataJson.mockReset();
        mocks.binaryLatestDepths.clear();
        mocks.binarySubs.length = 0;
        mocks.wsSubs.length = 0;
        mocks.openRests.length = 0;
        mocks.binarySupported.value = seq % 2 === 1;

        let sessionCounter = 0;
        const initSym = symbols[Math.floor(rand() * 3)]; // start on a real symbol
        const initDepth = depths[Math.floor(rand() * depths.length)];
        let currentAuth = true;
        let currentSession = sessionCounter;

        useAppStore.setState({
          isAuthenticated: true,
          accountId: '1001',
          authToken: `seq-${seq}-tok-0`,
        });

        const model: ModelState = {
          symbol: initSym,
          depth: initDepth,
          authenticated: true,
          session: 0,
          activeRestId: null,
          activeBinarySubId: null,
          activeWsSubId: null,
          allowedPriceIds: new Set<number>(),
          expectedPriceId: null,
          expectedPayloadSymbol: null,
          expectedLoading: false,
          expectedError: null,
          restMeta: new Map(),
          binarySubMeta: new Map(),
          wsSubMeta: new Map(),
          cachePriceBySym: new Map(),
        };

        // Optionally seed binary cache before initial mount
        if (mocks.binarySupported.value && rand() < 0.35) {
          const cid = allocPriceId();
          model.cachePriceBySym.set(initSym, cid);
          mocks.binaryLatestDepths.set(initSym, makeBinaryDepth(payloadSymbolFor(initSym), cid, cid));
        }

        const ownerAllowedSets = new Map<string, Set<number>>();
        const getAllowedSet = (key: string) => {
          let set = ownerAllowedSets.get(key);
          if (!set) {
            set = new Set<number>();
            ownerAllowedSets.set(key, set);
          }
          return set;
        };

        mocks.fetchMarketDataJson.mockImplementation((url: string) => {
          const prefix = '/api/v2/depth/';
          const encodedSym = url.startsWith(prefix) ? url.slice(prefix.length) : url;
          const reqSym = decodeURIComponent(encodedSym).trim().toUpperCase();
          const deferred = createDeferred<unknown>();
          const id = mocks.nextRestId();
          mocks.openRests.push({
            id,
            requestedSymbol: reqSym,
            payloadSymbol: payloadSymbolFor(reqSym),
            deferred,
            settled: false,
          });
          return deferred.promise;
        });

        const observations: RenderObservation[] = [];
        const savedReloads: Array<{ ownerKey: string; fn: () => Promise<void> }> = [];

        const syncSubscriptionsToModel = (binaryCountBefore: number, wsCountBefore: number) => {
          if (model.authenticated && model.symbol) {
            const oKey = ownerKeyOf(model.symbol, model.authenticated, model.session);
            if (mocks.binarySupported.value && mocks.binarySubs.length > binaryCountBefore) {
              const latestBin = mocks.binarySubs[mocks.binarySubs.length - 1];
              model.activeBinarySubId = latestBin.id;
              model.binarySubMeta.set(latestBin.id, { ownerKey: oKey, requestedSymbol: model.symbol });
            }
            if (mocks.wsSubs.length > wsCountBefore) {
              const latestWs = mocks.wsSubs[mocks.wsSubs.length - 1];
              model.activeWsSubId = latestWs.id;
              model.wsSubMeta.set(latestWs.id, { ownerKey: oKey, requestedSymbol: model.symbol });
            }
          } else {
            model.activeBinarySubId = null;
            model.activeWsSubId = null;
          }
        };

        const syncRestToModel = (restCountBefore: number) => {
          if (model.authenticated && model.symbol && mocks.openRests.length > restCountBefore) {
            const latestRest = mocks.openRests[mocks.openRests.length - 1];
            model.activeRestId = latestRest.id;
            model.restMeta.set(latestRest.id, {
              ownerKey: ownerKeyOf(model.symbol, model.authenticated, model.session),
              requestedSymbol: model.symbol,
              payloadSymbol: latestRest.payloadSymbol,
            });
          } else if (!model.authenticated || !model.symbol) {
            model.activeRestId = null;
          }
        };

        // Initial render
        const initOwnerKey = ownerKeyOf(initSym, true, 0);
        model.allowedPriceIds = getAllowedSet(initOwnerKey);
        const initCacheId = mocks.binarySupported.value ? model.cachePriceBySym.get(initSym) : undefined;
        if (initCacheId !== undefined) {
          model.allowedPriceIds.add(initCacheId);
          model.expectedPriceId = initCacheId;
          model.expectedPayloadSymbol = payloadSymbolFor(initSym);
          model.expectedLoading = false;
          model.expectedError = null;
        } else {
          model.expectedPriceId = null;
          model.expectedPayloadSymbol = null;
          model.expectedLoading = true;
          model.expectedError = null;
        }

        const hookRef = renderHook(
          ({ sym, d }: { sym: string; d: number }) => {
            const value = useLiveOrderBook(sym, d);
            observations.push({
              symbol: sym.trim().toUpperCase(),
              authenticated: currentAuth,
              session: currentSession,
              orderBook: value.orderBook,
              loading: value.loading,
              error: value.error,
            });
            return value;
          },
          { initialProps: { sym: initSym, d: initDepth } },
        );

        syncRestToModel(0);
        syncSubscriptionsToModel(0, 0);
        savedReloads.push({ ownerKey: initOwnerKey, fn: hookRef.result.current.reload });

        const checkRenderObservations = (startIdx: number, context: string) => {
          for (let i = startIdx; i < observations.length; i += 1) {
            const obs = observations[i];
            const oKey = ownerKeyOf(obs.symbol, obs.authenticated, obs.session);
            const allowed = getAllowedSet(oKey);
            if (obs.orderBook !== null) {
              const bidPrice = obs.orderBook.bids[0]?.price;
              expect(
                allowed.has(bidPrice),
                `[seq=${seq} ${context}] render #${i} leaked book price=${bidPrice} (${obs.orderBook.symbol}) under owner ${oKey}`,
              ).toBe(true);
              expect(obs.orderBook.symbol).toBe(payloadSymbolFor(obs.symbol));
            }
            if (!obs.authenticated || !obs.symbol) {
              expect(obs.orderBook, `[seq=${seq} ${context}] unauth/empty book must be null`).toBeNull();
              expect(obs.error, `[seq=${seq} ${context}] unauth/empty error must be null`).toBeNull();
              expect(obs.loading, `[seq=${seq} ${context}] unauth/empty loading must be false`).toBe(false);
            }
          }
        };

        const checkPostStepModel = (context: string) => {
          const cur = hookRef.result.current;
          if (model.expectedPriceId === null) {
            expect(cur.orderBook, `[seq=${seq} ${context}] expected null orderBook`).toBeNull();
          } else {
            expect(cur.orderBook, `[seq=${seq} ${context}] expected non-null orderBook`).not.toBeNull();
            expect(cur.orderBook?.bids[0]?.price, `[seq=${seq} ${context}] expected bid price`).toBe(model.expectedPriceId);
            expect(cur.orderBook?.symbol, `[seq=${seq} ${context}] expected payload symbol`).toBe(model.expectedPayloadSymbol);
          }
          expect(cur.loading, `[seq=${seq} ${context}] loading mismatch`).toBe(model.expectedLoading);
          expect(cur.error, `[seq=${seq} ${context}] error mismatch`).toBe(model.expectedError);
        };

        checkRenderObservations(0, 'mount');
        checkPostStepModel('mount');

        const stepsCount = 10 + Math.floor(rand() * 5);
        for (let step = 0; step < stepsCount; step += 1) {
          const obsStart = observations.length;
          const restBefore = mocks.openRests.length;
          const binBefore = mocks.binarySubs.length;
          const wsBefore = mocks.wsSubs.length;

          const pendingRests = mocks.openRests.filter((r) => !r.settled);
          const pick = rand();
          let stepLabel: string;

          if (pick < 0.22) {
            // switch_symbol (always pick a different symbol or same-family parent<->derived)
            const candidates = symbols.filter((s) => s !== model.symbol);
            const nextSym = candidates[Math.floor(rand() * candidates.length)];
            stepLabel = `switch(${model.symbol}->${nextSym})`;

            const nextOwnerKey = ownerKeyOf(nextSym, model.authenticated, model.session);
            // New owner resets allowed set cleanly (S1'/S2)
            const freshAllowed = new Set<number>();
            ownerAllowedSets.set(nextOwnerKey, freshAllowed);
            model.symbol = nextSym;
            model.allowedPriceIds = freshAllowed;
            model.activeRestId = null;
            model.activeBinarySubId = null;
            model.activeWsSubId = null;

            if (!model.authenticated || !nextSym) {
              model.expectedPriceId = null;
              model.expectedPayloadSymbol = null;
              model.expectedLoading = false;
              model.expectedError = null;
            } else {
              const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(nextSym) : undefined;
              if (cid !== undefined) {
                freshAllowed.add(cid);
                model.expectedPriceId = cid;
                model.expectedPayloadSymbol = payloadSymbolFor(nextSym);
                model.expectedLoading = false;
                model.expectedError = null;
              } else {
                model.expectedPriceId = null;
                model.expectedPayloadSymbol = null;
                model.expectedLoading = true;
                model.expectedError = null;
              }
            }

            hookRef.rerender({ sym: nextSym, d: model.depth });
            await flushMicrotasks();
            // Verify pre-effect first render cleared previous symbol immediately
            const firstRenderAfterSwitch = observations[obsStart];
            expect(firstRenderAfterSwitch.orderBook, `[seq=${seq} ${stepLabel}] first render must clear`).toBeNull();
            expect(firstRenderAfterSwitch.error, `[seq=${seq} ${stepLabel}] first render error must clear`).toBeNull();
            expect(
              firstRenderAfterSwitch.loading,
              `[seq=${seq} ${stepLabel}] first render loading`,
            ).toBe(Boolean(nextSym) && model.authenticated);

            syncRestToModel(restBefore);
            syncSubscriptionsToModel(binBefore, wsBefore);
            savedReloads.push({ ownerKey: nextOwnerKey, fn: hookRef.result.current.reload });
          } else if (pick < 0.30) {
            // change_depth
            const otherDepths = depths.filter((d) => d !== model.depth);
            const nextDepth = otherDepths[Math.floor(rand() * otherDepths.length)];
            stepLabel = `depth(${model.depth}->${nextDepth})`;
            model.depth = nextDepth;

            if (model.authenticated && model.symbol) {
              model.activeRestId = null;
              const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
              if (cid !== undefined) {
                model.allowedPriceIds.add(cid);
                model.expectedPriceId = cid;
                model.expectedPayloadSymbol = payloadSymbolFor(model.symbol);
                model.expectedLoading = false;
                model.expectedError = null;
              } else {
                model.expectedError = null;
                model.expectedLoading = true;
              }
            }

            hookRef.rerender({ sym: model.symbol, d: nextDepth });
            await flushMicrotasks();
            syncRestToModel(restBefore);
            syncSubscriptionsToModel(binBefore, wsBefore);
          } else if (pick < 0.48 && pendingRests.length > 0) {
            // rest_resolve (any open request in any order)
            const chosen = pendingRests[Math.floor(rand() * pendingRests.length)];
            chosen.settled = true;
            const pid = allocPriceId();
            const isActive = chosen.id === model.activeRestId;
            stepLabel = `rest_resolve(id=${chosen.id},active=${isActive},sym=${chosen.requestedSymbol})`;

            if (isActive) {
              model.allowedPriceIds.add(pid);
              model.expectedPriceId = pid;
              model.expectedPayloadSymbol = chosen.payloadSymbol;
              model.expectedLoading = false;
            }

            chosen.deferred.resolve(makeRestBook(chosen.payloadSymbol, pid));
            await flushMicrotasks();
          } else if (pick < 0.60 && pendingRests.length > 0) {
            // rest_reject (any open request in any order)
            const chosen = pendingRests[Math.floor(rand() * pendingRests.length)];
            chosen.settled = true;
            const isActive = chosen.id === model.activeRestId;
            const errMsg = `REST fail ${chosen.id}`;
            stepLabel = `rest_reject(id=${chosen.id},active=${isActive},sym=${chosen.requestedSymbol})`;

            if (isActive) {
              const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
              if (cid !== undefined) {
                model.allowedPriceIds.add(cid);
                model.expectedPriceId = cid;
                model.expectedPayloadSymbol = payloadSymbolFor(model.symbol);
                model.expectedError = null;
                model.expectedLoading = false;
              } else {
                model.expectedPriceId = null;
                model.expectedPayloadSymbol = null;
                model.expectedError = errMsg;
                model.expectedLoading = false;
              }
            }

            chosen.deferred.reject(new ApiError(501, errMsg));
            await flushMicrotasks();
          } else if (pick < 0.72 && mocks.wsSubs.length > 0) {
            // ws_message on any WS sub ever created
            const sub = mocks.wsSubs[Math.floor(rand() * mocks.wsSubs.length)];
            const pid = allocPriceId();
            const isActive = sub.id === model.activeWsSubId;
            const payloadSym = payloadSymbolFor(sub.requestedSymbol);
            stepLabel = `ws(sub=${sub.id},active=${isActive},ch=${sub.channel})`;

            if (isActive) {
              model.allowedPriceIds.add(pid);
              model.expectedPriceId = pid;
              model.expectedPayloadSymbol = payloadSym;
            }

            act(() => {
              sub.cb(makeWsMessage(payloadSym, pid));
            });
          } else if (pick < 0.80 && mocks.binarySubs.length > 0) {
            // binary_update on any binary sub ever created
            const sub = mocks.binarySubs[Math.floor(rand() * mocks.binarySubs.length)];
            const pid = allocPriceId();
            const isActive = sub.id === model.activeBinarySubId;
            const payloadSym = payloadSymbolFor(sub.symbol);
            stepLabel = `binary(sub=${sub.id},active=${isActive},sym=${sub.symbol})`;

            if (isActive) {
              model.allowedPriceIds.add(pid);
              model.expectedPriceId = pid;
              model.expectedPayloadSymbol = payloadSym;
              model.expectedError = null;
              model.expectedLoading = false;
            }

            act(() => {
              sub.cb(makeBinaryDepth(payloadSym, pid, pid));
            });
          } else if (pick < 0.86) {
            // cache_set or cache_clear
            const targetSym = symbols[Math.floor(rand() * 3)];
            if (rand() < 0.7) {
              const cid = allocPriceId();
              stepLabel = `cache_set(${targetSym})`;
              model.cachePriceBySym.set(targetSym, cid);
              mocks.binaryLatestDepths.set(targetSym, makeBinaryDepth(payloadSymbolFor(targetSym), cid, cid));
            } else {
              stepLabel = `cache_clear(${targetSym})`;
              model.cachePriceBySym.delete(targetSym);
              mocks.binaryLatestDepths.delete(targetSym);
            }
          } else if (pick < 0.91) {
            if (rand() < 0.45) {
              // token_rotation: NOT a change of owner (book, loading, error preserved pre-effect; reload & resubscribe without clearing)
              stepLabel = 'token_rotation';
              const bookBeforeRotation = hookRef.result.current.orderBook;
              const loadingBeforeRotation = hookRef.result.current.loading;
              const errorBeforeRotation = hookRef.result.current.error;

              if (model.authenticated && model.symbol) {
                model.activeRestId = null;
                model.activeBinarySubId = null;
                model.activeWsSubId = null;
                const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
                if (cid !== undefined) {
                  model.allowedPriceIds.add(cid);
                  model.expectedPriceId = cid;
                  model.expectedPayloadSymbol = payloadSymbolFor(model.symbol);
                  model.expectedLoading = false;
                  model.expectedError = null;
                } else {
                  model.expectedError = null;
                  model.expectedLoading = true;
                }
              }

              act(() => {
                emitSessionChange('token_rotation');
              });
              await flushMicrotasks();

              const afterRotObs = observations.slice(obsStart);
              expect(afterRotObs.length, `[seq=${seq} ${stepLabel}] must render on rotation`).toBeGreaterThanOrEqual(1);
              expect(afterRotObs[0].orderBook, `[seq=${seq} ${stepLabel}] pre-effect book unchanged`).toBe(bookBeforeRotation);
              expect(afterRotObs[0].loading, `[seq=${seq} ${stepLabel}] pre-effect loading unchanged`).toBe(loadingBeforeRotation);
              expect(afterRotObs[0].error, `[seq=${seq} ${stepLabel}] pre-effect error unchanged`).toBe(errorBeforeRotation);
              if (bookBeforeRotation !== null) {
                for (const obs of afterRotObs) {
                  expect(obs.orderBook, `[seq=${seq} ${stepLabel}] must never clear loaded book`).not.toBeNull();
                  if (!mocks.binarySupported.value || !model.cachePriceBySym.has(model.symbol)) {
                    expect(obs.orderBook, `[seq=${seq} ${stepLabel}] same book object stays returned`).toBe(bookBeforeRotation);
                  }
                }
              }

              syncRestToModel(restBefore);
              syncSubscriptionsToModel(binBefore, wsBefore);
            } else {
              // non-rotation session change: ALWAYS a change of owner (clears previous book immediately)
              const reasons = ['broker_url_change', 'account_change', 'logout', 'login'] as const;
              const reason = reasons[Math.floor(rand() * reasons.length)];
              stepLabel = `session_change(${reason})`;
              sessionCounter += 1;
              currentSession = sessionCounter;
              model.session = sessionCounter;
              const nextOwnerKey = ownerKeyOf(model.symbol, model.authenticated, model.session);
              const freshAllowed = new Set<number>();
              ownerAllowedSets.set(nextOwnerKey, freshAllowed);
              model.allowedPriceIds = freshAllowed;
              model.activeRestId = null;
              model.activeBinarySubId = null;
              model.activeWsSubId = null;

              if (!model.authenticated || !model.symbol) {
                model.expectedPriceId = null;
                model.expectedPayloadSymbol = null;
                model.expectedLoading = false;
                model.expectedError = null;
              } else {
                const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
                if (cid !== undefined) {
                  freshAllowed.add(cid);
                  model.expectedPriceId = cid;
                  model.expectedPayloadSymbol = payloadSymbolFor(model.symbol);
                  model.expectedLoading = false;
                  model.expectedError = null;
                } else {
                  model.expectedPriceId = null;
                  model.expectedPayloadSymbol = null;
                  model.expectedLoading = true;
                  model.expectedError = null;
                }
              }

              act(() => {
                emitSessionChange(reason);
              });
              await flushMicrotasks();
              const firstAfterSessionChange = observations[obsStart];
              expect(firstAfterSessionChange.orderBook, `[seq=${seq} ${stepLabel}] first render must clear`).toBeNull();
              expect(firstAfterSessionChange.error, `[seq=${seq} ${stepLabel}] first render error must clear`).toBeNull();
              expect(
                firstAfterSessionChange.loading,
                `[seq=${seq} ${stepLabel}] first render loading`,
              ).toBe(Boolean(model.symbol) && model.authenticated);

              syncRestToModel(restBefore);
              syncSubscriptionsToModel(binBefore, wsBefore);
              savedReloads.push({ ownerKey: nextOwnerKey, fn: hookRef.result.current.reload });
            }
          } else if (pick < 0.95) {
            // toggle auth (logout / login) or refresh authToken
            if (model.authenticated && rand() < 0.5) {
              stepLabel = 'logout';
              currentAuth = false;
              model.authenticated = false;
              const nextOwnerKey = ownerKeyOf(model.symbol, false, model.session);
              const freshAllowed = new Set<number>();
              ownerAllowedSets.set(nextOwnerKey, freshAllowed);
              model.allowedPriceIds = freshAllowed;
              model.activeRestId = null;
              model.activeBinarySubId = null;
              model.activeWsSubId = null;
              model.expectedPriceId = null;
              model.expectedPayloadSymbol = null;
              model.expectedLoading = false;
              model.expectedError = null;

              act(() => {
                useAppStore.setState({ isAuthenticated: false, authToken: null });
              });
              await flushMicrotasks();
            } else if (!model.authenticated) {
              stepLabel = 'login';
              currentAuth = true;
              model.authenticated = true;
              const nextOwnerKey = ownerKeyOf(model.symbol, true, model.session);
              const freshAllowed = new Set<number>();
              ownerAllowedSets.set(nextOwnerKey, freshAllowed);
              model.allowedPriceIds = freshAllowed;
              model.activeRestId = null;
              model.activeBinarySubId = null;
              model.activeWsSubId = null;

              if (!model.symbol) {
                model.expectedPriceId = null;
                model.expectedPayloadSymbol = null;
                model.expectedLoading = false;
                model.expectedError = null;
              } else {
                const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
                if (cid !== undefined) {
                  freshAllowed.add(cid);
                  model.expectedPriceId = cid;
                  model.expectedPayloadSymbol = payloadSymbolFor(model.symbol);
                  model.expectedLoading = false;
                  model.expectedError = null;
                } else {
                  model.expectedPriceId = null;
                  model.expectedPayloadSymbol = null;
                  model.expectedLoading = true;
                  model.expectedError = null;
                }
              }

              act(() => {
                useAppStore.setState({ isAuthenticated: true, authToken: `seq-${seq}-step-${step}` });
              });
              await flushMicrotasks();
              syncRestToModel(restBefore);
              syncSubscriptionsToModel(binBefore, wsBefore);
              savedReloads.push({ ownerKey: nextOwnerKey, fn: hookRef.result.current.reload });
            } else {
              // authToken refresh within same session
              stepLabel = 'auth_token_refresh';
              if (model.symbol) {
                const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
                if (cid !== undefined) {
                  model.allowedPriceIds.add(cid);
                  model.expectedPriceId = cid;
                  model.expectedPayloadSymbol = payloadSymbolFor(model.symbol);
                  model.expectedError = null;
                  model.expectedLoading = false;
                }
              }
              act(() => {
                useAppStore.setState({ authToken: `seq-${seq}-refresh-${step}` });
              });
              await flushMicrotasks();
              syncSubscriptionsToModel(binBefore, wsBefore);
            }
          } else {
            // reload (either current reload or stale saved reload)
            const currentOwnerKey = ownerKeyOf(model.symbol, model.authenticated, model.session);
            const useStale = savedReloads.length > 1 && rand() < 0.25;
            const staleCandidate = useStale
              ? savedReloads.find((entry) => entry.ownerKey !== currentOwnerKey)
              : undefined;

            if (staleCandidate) {
              stepLabel = `stale_reload(${staleCandidate.ownerKey})`;
              await act(async () => {
                await staleCandidate.fn();
              });
            } else {
              stepLabel = 'reload';
              if (!model.authenticated || !model.symbol) {
                model.expectedPriceId = null;
                model.expectedPayloadSymbol = null;
                model.expectedError = null;
                model.expectedLoading = false;
              } else {
                model.activeRestId = null;
                const cid = mocks.binarySupported.value ? model.cachePriceBySym.get(model.symbol) : undefined;
                if (cid !== undefined) {
                  model.allowedPriceIds.add(cid);
                  model.expectedPriceId = cid;
                  model.expectedPayloadSymbol = payloadSymbolFor(model.symbol);
                }
                model.expectedError = null;
                model.expectedLoading = true;
              }
              act(() => {
                void hookRef.result.current.reload();
              });
              await flushMicrotasks();
              syncRestToModel(restBefore);
            }
          }

          checkRenderObservations(obsStart, `step=${step} ${stepLabel}`);
          checkPostStepModel(`step=${step} ${stepLabel}`);
        }

        // Unmount at end of sequence, then settle any leftover pending REST/WS/binary and confirm 0 warnings
        hookRef.unmount();
        const leftoverRest = mocks.openRests.find((r) => !r.settled);
        if (leftoverRest) {
          leftoverRest.settled = true;
          leftoverRest.deferred.resolve(makeRestBook(leftoverRest.payloadSymbol, allocPriceId()));
          await flushMicrotasks();
        }
        const lastWs = mocks.wsSubs[mocks.wsSubs.length - 1];
        if (lastWs) {
          expect(lastWs.active).toBe(false);
          act(() => {
            lastWs.cb(makeWsMessage(payloadSymbolFor(lastWs.requestedSymbol), allocPriceId()));
          });
        }
        cleanup();
      }

      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    }, 60_000);
  });

  describe('Step 2 targeted edge-case checks', () => {
    it('stale reload closure from previous symbol does nothing after switch', async () => {
      const restA = createDeferred<unknown>();
      const restB = createDeferred<unknown>();
      mocks.fetchMarketDataJson
        .mockReturnValueOnce(restA.promise)
        .mockReturnValueOnce(restB.promise);

      const { result, rerender } = renderHook(
        ({ sym }: { sym: string }) => useLiveOrderBook(sym, 10),
        { initialProps: { sym: 'EURUSD' } },
      );
      const staleReloadA = result.current.reload;

      rerender({ sym: 'GBPUSD' });
      await flushMicrotasks();
      expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(2);

      // Invoke stale reload captured while on EURUSD
      await act(async () => {
        await staleReloadA();
      });
      expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(2);
      expect(result.current.orderBook).toBeNull();
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();

      restB.resolve(makeRestBook('GBPUSD', 1.27));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.bids[0]?.price).toBe(1.27);
    });

    it('depth change (10 -> 20) invalidates in-flight depth=10 REST and keeps latest depth=20 result', async () => {
      const rest10 = createDeferred<unknown>();
      const rest20 = createDeferred<unknown>();
      mocks.fetchMarketDataJson
        .mockReturnValueOnce(rest10.promise)
        .mockReturnValueOnce(rest20.promise);

      const { result, rerender } = renderHook(
        ({ sym, d }: { sym: string; d: number }) => useLiveOrderBook(sym, d),
        { initialProps: { sym: 'EURUSD', d: 10 } },
      );
      expect(result.current.loading).toBe(true);

      rerender({ sym: 'EURUSD', d: 20 });
      await flushMicrotasks();
      expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(2);

      // Late depth=10 resolves -> dropped
      rest10.resolve(makeRestBook('EURUSD', 111));
      await flushMicrotasks();
      expect(result.current.orderBook).toBeNull();
      expect(result.current.loading).toBe(true);

      // depth=20 resolves -> accepted
      rest20.resolve(makeRestBook('EURUSD', 222));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.bids[0]?.price).toBe(222);
    });

    it('authToken refresh keeps pending REST alive while invalidating old binary/WS subscriptions', async () => {
      mocks.binarySupported.value = true;
      const rest1 = createDeferred<unknown>();
      mocks.fetchMarketDataJson.mockReturnValueOnce(rest1.promise);

      const { result } = renderHook(() => useLiveOrderBook('EURUSD', 10));
      expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(1);
      const oldBin = mocks.binarySubs[0];
      const oldWs = mocks.wsSubs[0];

      act(() => {
        useAppStore.setState({ authToken: 'refreshed-token-2' });
      });
      await flushMicrotasks();

      // Same session & symbol -> REST was NOT re-issued
      expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(1);
      expect(oldBin.active).toBe(false);
      expect(oldWs.active).toBe(false);
      expect(mocks.binarySubs).toHaveLength(2);
      expect(mocks.wsSubs).toHaveLength(2);

      // Old callbacks are ignored
      act(() => {
        oldBin.cb(makeBinaryDepth('EURUSD', 901, 1));
        oldWs.cb(makeWsMessage('EURUSD', 902));
      });
      expect(result.current.orderBook).toBeNull();
      expect(result.current.loading).toBe(true);

      // Original REST resolves cleanly
      rest1.resolve(makeRestBook('EURUSD', 903));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.bids[0]?.price).toBe(903);

      // New WS callback works
      act(() => {
        mocks.wsSubs[1].cb(makeWsMessage('EURUSD', 904));
      });
      expect(result.current.orderBook?.bids[0]?.price).toBe(904);
    });

    it('symbol going loaded -> empty -> back to same symbol clears immediately and reloads cleanly', async () => {
      const rest1 = createDeferred<unknown>();
      const rest2 = createDeferred<unknown>();
      mocks.fetchMarketDataJson
        .mockReturnValueOnce(rest1.promise)
        .mockReturnValueOnce(rest2.promise);

      const observations: RenderObservation[] = [];
      const { result, rerender } = renderHook(
        ({ sym }: { sym: string }) => {
          const val = useLiveOrderBook(sym, 10);
          observations.push({
            symbol: sym.trim().toUpperCase(),
            authenticated: true,
            session: 0,
            orderBook: val.orderBook,
            loading: val.loading,
            error: val.error,
          });
          return val;
        },
        { initialProps: { sym: 'EURUSD' } },
      );

      rest1.resolve(makeRestBook('EURUSD', 301));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.bids[0]?.price).toBe(301);

      const beforeEmptyIdx = observations.length;
      rerender({ sym: '' });
      await flushMicrotasks();
      for (const obs of observations.slice(beforeEmptyIdx)) {
        expect(obs.orderBook).toBeNull();
        expect(obs.loading).toBe(false);
        expect(obs.error).toBeNull();
      }

      const beforeBackIdx = observations.length;
      rerender({ sym: 'EURUSD' });
      await flushMicrotasks();
      expect(observations[beforeBackIdx].orderBook).toBeNull();
      expect(observations[beforeBackIdx].loading).toBe(true);
      expect(observations[beforeBackIdx].error).toBeNull();

      rest2.resolve(makeRestBook('EURUSD', 302));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.bids[0]?.price).toBe(302);
    });

    it('WS message arriving before REST answer shows book immediately while keeping loading=true until REST finishes', async () => {
      const rest = createDeferred<unknown>();
      mocks.fetchMarketDataJson.mockReturnValueOnce(rest.promise);

      const { result } = renderHook(() => useLiveOrderBook('EURUSD', 10));
      expect(result.current.loading).toBe(true);
      expect(result.current.orderBook).toBeNull();

      act(() => {
        mocks.wsSubs[0].cb(makeWsMessage('EURUSD', 401));
      });
      expect(result.current.orderBook?.bids[0]?.price).toBe(401);
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();

      rest.resolve(makeRestBook('EURUSD', 402));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.bids[0]?.price).toBe(402);
    });

    it('binary cache appearing mid-flight serves fallback on error for current request, never for superseded request', async () => {
      mocks.binarySupported.value = true;
      const req1 = createDeferred<unknown>();
      const req2 = createDeferred<unknown>();
      mocks.fetchMarketDataJson
        .mockReturnValueOnce(req1.promise)
        .mockReturnValueOnce(req2.promise);

      const { result } = renderHook(() => useLiveOrderBook('EURUSD', 10));
      act(() => {
        void result.current.reload();
      });
      await flushMicrotasks();

      // Cache appears mid-flight
      mocks.binaryLatestDepths.set('EURUSD', makeBinaryDepth('EURUSD', 501, 1));

      // Superseded req1 fails -> must NOT fall back or clear loading while req2 is pending
      req1.reject(new ApiError(501, 'old failed'));
      await flushMicrotasks();
      expect(result.current.orderBook).toBeNull();
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();

      // Current req2 fails -> falls back to current symbol's cached binary depth
      req2.reject(new ApiError(501, 'DEPTH_UNSUPPORTED'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.bids[0]?.price).toBe(501);
      expect(result.current.error).toBeNull();
    });
  });

  describe('Step 3(b): React.StrictMode behavior', () => {
    it('drops first-mount REST/callbacks and accepts remount REST/callbacks on mount, prop switch, and keyed remount under StrictMode', async () => {
      mocks.binarySupported.value = true;
      const mount1Rest = createDeferred<unknown>();
      const mount2Rest = createDeferred<unknown>();
      const switchRest = createDeferred<unknown>();
      const derived1Rest = createDeferred<unknown>();
      const derived2Rest = createDeferred<unknown>();
      mocks.fetchMarketDataJson
        .mockReturnValueOnce(mount1Rest.promise)
        .mockReturnValueOnce(mount2Rest.promise)
        .mockReturnValueOnce(switchRest.promise)
        .mockReturnValueOnce(derived1Rest.promise)
        .mockReturnValueOnce(derived2Rest.promise);

      let probeMounts = 0;
      let probeCleanups = 0;
      const observations: RenderObservation[] = [];
      const { result, rerender, unmount } = renderHook(
        ({ sym }: { sym: string }) => {
          React.useEffect(() => {
            probeMounts += 1;
            return () => {
              probeCleanups += 1;
            };
          }, []);
          const val = useLiveOrderBook(sym, 10);
          observations.push({
            symbol: sym.trim().toUpperCase(),
            authenticated: true,
            session: 0,
            orderBook: val.orderBook,
            loading: val.loading,
            error: val.error,
          });
          return val;
        },
        { initialProps: { sym: 'EURUSD' }, reactStrictMode: true },
      );

      await flushMicrotasks();
      expect(probeMounts).toBe(2);
      expect(probeCleanups).toBe(1);
      expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(2);
      expect(mocks.binarySubs).toHaveLength(2);
      expect(mocks.wsSubs).toHaveLength(2);
      expect(mocks.binarySubs[0].active).toBe(false);
      expect(mocks.binarySubs[1].active).toBe(true);
      expect(mocks.wsSubs[0].active).toBe(false);
      expect(mocks.wsSubs[1].active).toBe(true);

      // First-mount REST reject & callbacks must be dropped
      mount1Rest.reject(new ApiError(500, 'strict mount1 error'));
      await flushMicrotasks();
      act(() => {
        mocks.binarySubs[0].cb(makeBinaryDepth('EURUSD', 7001, 1));
        mocks.wsSubs[0].cb(makeWsMessage('EURUSD', 7002));
      });
      expect(result.current.orderBook).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(true);

      // Second-mount REST resolves
      mount2Rest.resolve(makeRestBook('EURUSD', 7003));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.bids[0]?.price).toBe(7003);

      // Prop switch EURUSD -> XAUUSD under StrictMode clears immediately and accepts new REST
      const switchObsStart = observations.length;
      rerender({ sym: 'XAUUSD' });
      await flushMicrotasks();
      for (const obs of observations.slice(switchObsStart)) {
        expect(obs.orderBook === null || obs.orderBook.bids[0]?.price !== 7003).toBe(true);
        expect(obs.error).toBeNull();
      }
      expect(result.current.orderBook).toBeNull();
      expect(result.current.loading).toBe(true);

      switchRest.resolve(makeRestBook('XAUUSD', 7004));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.orderBook?.bids[0]?.price).toBe(7004);

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      unmount();

      // Keyed remount to derived XAUUSD.VIP under <StrictMode>: double-mount drops first pass and accepts second pass
      let latestDerived: ReturnType<typeof useLiveOrderBook> | null = null;
      function KeyedHarness({ sym }: { sym: string }) {
        const val = useLiveOrderBook(sym, 10);
        latestDerived = val;
        return null;
      }

      const derivedView = render(
        <StrictMode>
          <KeyedHarness key="XAUUSD.VIP" sym="XAUUSD.VIP" />
        </StrictMode>,
      );
      await flushMicrotasks();
      expect(mocks.fetchMarketDataJson).toHaveBeenCalledTimes(5);

      derived1Rest.resolve(makeRestBook('XAUUSD', 7006));
      await flushMicrotasks();
      expect(latestDerived?.orderBook).toBeNull();
      expect(latestDerived?.loading).toBe(true);

      derived2Rest.resolve(makeRestBook('XAUUSD', 7007));
      await waitFor(() => expect(latestDerived?.loading).toBe(false));
      expect(latestDerived?.orderBook?.symbol).toBe('XAUUSD');
      expect(latestDerived?.orderBook?.bids[0]?.price).toBe(7007);

      derivedView.unmount();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('handles warm binary cache switch under StrictMode', async () => {
      mocks.binarySupported.value = true;
      mocks.binaryLatestDepths.set('EURUSD', makeBinaryDepth('EURUSD', 8001, 1));
      mocks.binaryLatestDepths.set('GBPUSD', makeBinaryDepth('GBPUSD', 8002, 2));
      mocks.fetchMarketDataJson.mockImplementation(() => createDeferred<unknown>().promise);

      const observations: RenderObservation[] = [];
      const { result, rerender } = renderHook(
        ({ sym }: { sym: string }) => {
          const val = useLiveOrderBook(sym, 10);
          observations.push({
            symbol: sym.trim().toUpperCase(),
            authenticated: true,
            session: 0,
            orderBook: val.orderBook,
            loading: val.loading,
            error: val.error,
          });
          return val;
        },
        { initialProps: { sym: 'EURUSD' }, reactStrictMode: true },
      );

      await flushMicrotasks();
      expect(result.current.orderBook?.bids[0]?.price).toBe(8001);
      expect(result.current.loading).toBe(false);

      const switchIdx = observations.length;
      rerender({ sym: 'GBPUSD' });
      await flushMicrotasks();
      expect(observations[switchIdx].orderBook).toBeNull();
      expect(observations[switchIdx].loading).toBe(true);
      for (const obs of observations.slice(switchIdx)) {
        expect(obs.orderBook === null || obs.orderBook.bids[0]?.price === 8002).toBe(true);
      }
      expect(result.current.orderBook?.bids[0]?.price).toBe(8002);
      expect(result.current.loading).toBe(false);
    });
  });

  describe('P18S tester hot-path driver', () => {
    it('binary path: 2,000 consecutive current-symbol updates', async () => {
      mocks.binarySupported.value = true;
      const restInit = createDeferred<unknown>();
      mocks.fetchMarketDataJson.mockReturnValueOnce(restInit.promise);

      let renders = 0;
      let commits = 0;
      let latestBook: LiveOrderBook | null = null;

      function Harness({ sym, tick }: { sym: string; tick: number }) {
        void tick;
        renders += 1;
        const value = useLiveOrderBook(sym, 10);
        latestBook = value.orderBook;
        return null;
      }

      const view = render(
        <Profiler
          id="p18s-tester-binary"
          onRender={() => {
            commits += 1;
          }}
        >
          <Harness sym="EURUSD" tick={0} />
        </Profiler>,
      );

      restInit.resolve(makeRestBook('EURUSD', 1.1));
      await waitFor(() => expect(latestBook?.symbol).toBe('EURUSD'));

      const binaryCb = mocks.binarySubs.find((s) => s.active && s.symbol === 'EURUSD')?.cb;
      expect(binaryCb).toBeDefined();

      const count = 2000;
      const frames: DecodedBinaryDepth[] = Array.from({ length: count }, (_, i) =>
        makeBinaryDepth('EURUSD', Number((1.1 + (i % 100) * 0.00001).toFixed(5)), i + 1),
      );

      renders = 0;
      commits = 0;
      const seenBookRefs = new Set<LiveOrderBook>();

      const start = performance.now();
      for (let i = 0; i < count; i += 1) {
        act(() => {
          binaryCb!(frames[i]);
        });
        if (latestBook) {
          seenBookRefs.add(latestBook);
        }
      }
      const totalMs = performance.now() - start;
      const usPerUpdate = (totalMs * 1000) / count;

      expect(renders).toBe(count);
      expect(commits).toBe(count);
      expect(seenBookRefs.size).toBe(count);

      const bookBeforeNoop = latestBook;
      view.rerender(
        <Profiler
          id="p18s-tester-binary"
          onRender={() => {
            commits += 1;
          }}
        >
          <Harness sym="EURUSD" tick={1} />
        </Profiler>,
      );
      expect(latestBook).toBe(bookBeforeNoop);

      console.log(
        `[P18S-TESTER-HOTPATH][binary] updates=${count} renders=${renders} commits=${commits} stateUpdates=${seenBookRefs.size} totalMs=${totalMs.toFixed(3)} usPerUpdate=${usPerUpdate.toFixed(3)}`,
      );
    }, 60_000);

    it('ws path: 2,000 consecutive current-symbol updates', async () => {
      const restInit = createDeferred<unknown>();
      mocks.fetchMarketDataJson.mockReturnValueOnce(restInit.promise);

      let renders = 0;
      let commits = 0;
      let latestBook: LiveOrderBook | null = null;

      function Harness({ sym, tick }: { sym: string; tick: number }) {
        void tick;
        renders += 1;
        const value = useLiveOrderBook(sym, 10);
        latestBook = value.orderBook;
        return null;
      }

      const view = render(
        <Profiler
          id="p18s-tester-ws"
          onRender={() => {
            commits += 1;
          }}
        >
          <Harness sym="EURUSD" tick={0} />
        </Profiler>,
      );

      restInit.resolve(makeRestBook('EURUSD', 1.1));
      await waitFor(() => expect(latestBook?.symbol).toBe('EURUSD'));

      const wsCb = mocks.wsSubs.find((s) => s.active && s.channel === 'depth.EURUSD')?.cb;
      expect(wsCb).toBeDefined();

      const count = 2000;
      const messages = Array.from({ length: count }, (_, i) =>
        makeWsMessage('EURUSD', Number((1.1 + (i % 100) * 0.00001).toFixed(5)), 10 + (i % 5)),
      );

      renders = 0;
      commits = 0;
      const seenBookRefs = new Set<LiveOrderBook>();

      const start = performance.now();
      for (let i = 0; i < count; i += 1) {
        act(() => {
          wsCb!(messages[i]);
        });
        if (latestBook) {
          seenBookRefs.add(latestBook);
        }
      }
      const totalMs = performance.now() - start;
      const usPerUpdate = (totalMs * 1000) / count;

      expect(renders).toBe(count);
      expect(commits).toBe(count);
      expect(seenBookRefs.size).toBe(count);

      const bookBeforeNoop = latestBook;
      view.rerender(
        <Profiler
          id="p18s-tester-ws"
          onRender={() => {
            commits += 1;
          }}
        >
          <Harness sym="EURUSD" tick={1} />
        </Profiler>,
      );
      expect(latestBook).toBe(bookBeforeNoop);

      console.log(
        `[P18S-TESTER-HOTPATH][ws] updates=${count} renders=${renders} commits=${commits} stateUpdates=${seenBookRefs.size} totalMs=${totalMs.toFixed(3)} usPerUpdate=${usPerUpdate.toFixed(3)}`,
      );
    }, 60_000);
  });
});
