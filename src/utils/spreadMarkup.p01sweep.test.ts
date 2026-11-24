/**
 * P01 round 6 -> round 9 (R1/R2): 60,000-case generated sweep across the whole input space
 * of applySpreadMarkupToQuote and applySpreadMarkupToBookLevels.
 *
 * Uses a fixed-seed Mulberry32 PRNG and an independent float64 reference reproducing the Go RAM
 * engine's MARKET-ORDER fill path (`OnLiveTick` Layer-1 round at `ram_mt5_views_sync.go:1209-1213` ->
 * `shapeAccountBaseQuote` at `ram_mt5_engine.go:3443` -> `roundPrice` at `ram_mt5_engine.go:3447-3448`,
 * `ram_mt5_phase5.go:29-39`), with no observed-digits override (R2).
 *
 * Path independence:
 *   - Path-independent invariants (must always pass): (a), (b), (c), (d), (f), (g), (i).
 *   - R1/R2-dependent value checks (fail on round-8 code where trigger path or observed-digits differs): (e), (h).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  resolveSpreadMarkupEntry,
  type SpreadMarkupEntry,
} from './spreadMarkup';

const TOTAL_CASES = 60_000;
const SEED = 0x50303136;

// Internal exact decimal scale: 10^-10. All generated ticks (down to 0.00001),
// point sizes (down to 10^-5), and /2 midpoints are exact integer multiples at SCALE=10.
const SCALE = 10;
const ONE = 10n ** BigInt(SCALE);

type PropertyKey = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i';
type FailureClass = 'REACHABLE_TODAY' | 'REMOTE';

interface BookLevel {
  price: number;
  volume: number;
  total: number;
  id: number;
}

interface QuoteInput {
  bid?: number;
  ask?: number;
  spread?: number;
}

interface FailRecord {
  caseIndex: number;
  sortTopPrice: number;
  sortLevels: number;
  sortMarkup: number;
  sortDigits: number;
  classification: FailureClass;
  remoteReasons: string[];
  detail: string;
  inputSummary: string;
}

interface PropertyStats {
  total: number;
  reachable: number;
  remote: number;
  smallestAll: FailRecord[];
  smallestReachable: FailRecord[];
  smallestRemote: FailRecord[];
}

const PROPERTY_LABELS: Record<PropertyKey, string> = {
  a: '(a) [path-independent] no shown price is NaN, infinite, zero, or negative',
  b: '(b) [path-independent] each side keeps its shown order (bids non-increasing, asks non-decreasing)',
  c: '(c) [path-independent] depth top equals shown quote side whenever raw side is non-empty',
  d: '(d) [path-independent] shown bid <= shown ask at top whenever both exist (non-crossed raw)',
  e: '(e) [R1/R2] every shown level equals market-path rounded base+delta rounded once at configured digits or kept raw',
  f: '(f) [path-independent] shown level count never exceeds raw level count',
  g: '(g) [path-independent] inputs (quote, levels, entry) are never mutated',
  h: '(h) [R1/R2] unshaped >= 10 ticks above bid share matches market-order float64 engine rule (configured digits)',
  i: '(i) [path-independent] applying quote markup twice equals applying it once',
};

const ALL_DIGITS = [0, 1, 2, 3, 4, 5] as const;

interface TickDef {
  tickSize: number;
  tickUnits: bigint;
}

const TICKS: readonly TickDef[] = [
  { tickSize: 1, tickUnits: 10_000_000_000n },
  { tickSize: 0.5, tickUnits: 5_000_000_000n },
  { tickSize: 0.25, tickUnits: 2_500_000_000n },
  { tickSize: 0.1, tickUnits: 1_000_000_000n },
  { tickSize: 0.05, tickUnits: 500_000_000n },
  { tickSize: 0.01, tickUnits: 100_000_000n },
  { tickSize: 0.005, tickUnits: 50_000_000n },
  { tickSize: 0.001, tickUnits: 10_000_000n },
  { tickSize: 0.0005, tickUnits: 5_000_000n },
  { tickSize: 0.0001, tickUnits: 1_000_000n },
  { tickSize: 0.00001, tickUnits: 100_000n },
];

const EQUAL_TICK_BY_DIGITS: Readonly<Record<number, TickDef>> = {
  0: TICKS[0], // 1
  1: TICKS[3], // 0.1
  2: TICKS[5], // 0.01
  3: TICKS[7], // 0.001
  4: TICKS[9], // 0.0001
  5: TICKS[10], // 0.00001
};

const createPrng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randInt = (rng: () => number, min: number, maxInclusive: number): number =>
  min + Math.floor(rng() * (maxInclusive - min + 1));

const randBigInt = (rng: () => number, min: bigint, maxInclusive: bigint): bigint => {
  if (maxInclusive <= min) return min;
  const span = maxInclusive - min + 1n;
  const hi = BigInt(Math.floor(rng() * 0x100000000));
  const lo = BigInt(Math.floor(rng() * 0x100000000));
  return min + (((hi << 32n) | lo) % span);
};

const pow10Big = (n: number): bigint => 10n ** BigInt(n);

const unitsToNumber = (units: bigint): number => {
  if (units === 0n) return 0;
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const s = abs.toString().padStart(SCALE + 1, '0');
  const intPart = s.slice(0, s.length - SCALE);
  const fracPart = s.slice(s.length - SCALE).replace(/0+$/, '');
  const text = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return Number(neg ? `-${text}` : text);
};

const GO_POW10: readonly number[] = [
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9,
  1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18,
];

const goDecimalPointSize = (digits: number): number => {
  const d = digits < 0 ? 5 : digits;
  return d < GO_POW10.length ? 1 / GO_POW10[d] : 10 ** -d;
};

/** Reproduces Go's `roundPrice` (`ram_mt5_phase5.go:29-39`): `math.Round(price * pow) / pow`. */
const goRoundPrice = (price: number, digits: number): number => {
  const d = digits < 0 ? 5 : digits;
  const pow = d < GO_POW10.length ? GO_POW10[d] : 10 ** d;
  const scaled = price * pow;
  const whole = Math.trunc(scaled);
  const frac = scaled - whole;
  const roundedInt = frac >= 0.5 ? whole + 1 : frac <= -0.5 ? whole - 1 : whole;
  const out = roundedInt / pow;
  return out === 0 ? 0 : out;
};

const goSdkSpreadDiffPoints = (diff: number, balance: number): { bidPoints: number; askPoints: number } => {
  const bidPoints = diff - Math.trunc(diff / 2) + (diff < 0 ? balance : -balance);
  return { bidPoints, askPoints: diff - bidPoints };
};

const goWidenQuoteForSpreadTermsUnits = (
  bid: number,
  ask: number,
  tickSize: number,
  point: number,
  legacyTotal: number,
  spreadDiff: number,
  balance: number,
): { bid: number; ask: number } => {
  const m = legacyTotal > 0 && Number.isFinite(legacyTotal) ? legacyTotal : 0;
  let bidDelta = 0;
  let askDelta = 0;
  if (tickSize === point && spreadDiff >= 0) {
    const total = m + spreadDiff;
    if (total === 0 && balance === 0) return { bid, ask };
    const { bidPoints, askPoints } = goSdkSpreadDiffPoints(total, balance);
    bidDelta = bidPoints * point;
    askDelta = askPoints * point;
  } else {
    if (tickSize > 0 && Number.isFinite(tickSize)) {
      const askPoints = Math.floor(m / 2);
      bidDelta = (m - askPoints) * tickSize;
      askDelta = askPoints * tickSize;
    }
    if (point > 0 && Number.isFinite(point)) {
      const { bidPoints, askPoints } = goSdkSpreadDiffPoints(spreadDiff, balance);
      bidDelta += bidPoints * point;
      askDelta += askPoints * point;
    }
  }
  let outBid = bid - bidDelta;
  const outAsk = ask + askDelta;
  if (!Number.isFinite(outBid) || !Number.isFinite(outAsk)) return { bid, ask };
  if (!(outBid > 0)) outBid = bid;
  if (!(outAsk > 0) || outBid > outAsk) return { bid, ask };
  return { bid: outBid, ask: outAsk };
};

/** Independent reproduction of Go RAM engine MARKET-ORDER path (`OnLiveTick` round -> `shapeAccountBaseQuote` -> `roundPrice`). */
const goMarketAccountQuote = (
  rawBid: number,
  rawAsk: number,
  digits: number,
  tickSize: number,
  m: number,
  fixedS: number,
  balanceSB: number,
  diffD: number,
  diffBalanceB: number,
): { bid: number; ask: number } => {
  const point = goDecimalPointSize(digits);
  let baseBid = rawBid;
  let baseAsk = rawAsk;
  if (fixedS > 0 || balanceSB !== 0) {
    if (fixedS > 0) {
      const fixedSpread = fixedS * point;
      const rawSpread = baseAsk - baseBid;
      if (Math.abs(rawSpread - fixedSpread) <= point * 1e-6) {
        baseBid += balanceSB * point;
      } else {
        const mid = (baseAsk + baseBid) / 2;
        const fixedBidOffset = (Math.trunc(fixedS / 2) - balanceSB) * point;
        baseBid = mid - fixedBidOffset;
      }
      baseAsk = baseBid + fixedSpread;
    } else if (balanceSB !== 0) {
      const bal = balanceSB * point;
      baseBid += bal;
      baseAsk += bal;
    }
    if (baseBid > baseAsk) {
      baseBid = rawBid;
      baseAsk = rawAsk;
    }
  }
  if (digits >= 0) {
    baseBid = goRoundPrice(baseBid, digits);
    baseAsk = goRoundPrice(baseAsk, digits);
  }
  const widened = goWidenQuoteForSpreadTermsUnits(baseBid, baseAsk, tickSize, point, m, diffD, diffBalanceB);
  return {
    bid: goRoundPrice(widened.bid, digits),
    ask: goRoundPrice(widened.ask, digits),
  };
};

const compareFailRecords = (left: FailRecord, right: FailRecord): number => {
  if (left.sortTopPrice !== right.sortTopPrice) return left.sortTopPrice - right.sortTopPrice;
  if (left.sortLevels !== right.sortLevels) return left.sortLevels - right.sortLevels;
  if (left.sortMarkup !== right.sortMarkup) return left.sortMarkup - right.sortMarkup;
  if (left.sortDigits !== right.sortDigits) return left.sortDigits - right.sortDigits;
  return left.caseIndex - right.caseIndex;
};

const insertSmallest = (list: FailRecord[], record: FailRecord): void => {
  if (list.length < 3) {
    list.push(record);
    list.sort(compareFailRecords);
    return;
  }
  if (compareFailRecords(record, list[2]) < 0) {
    list[2] = record;
    list.sort(compareFailRecords);
  }
};

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

interface IndependentExpectation {
  displayDigits: number;
  shaped: boolean;
  bidBaseShift: number;
  askBaseShift: number;
  bidDelta: number;
  askDelta: number;
  baseBidTop: number;
  baseAskTop: number;
  engineAskPts: number;
  engineBidPts: number;
  engineQuoteBid: number | undefined;
  engineQuoteAsk: number | undefined;
}

const computeIndependentReference = (
  digits: number,
  tickSize: number,
  m: number,
  fixedS: number,
  balanceSB: number,
  diffD: number,
  diffBalanceB: number,
  rawBidTop: number | undefined,
  rawAskTop: number | undefined,
  rawBidUnits: bigint | null,
  rawAskUnits: bigint | null,
): IndependentExpectation => {
  const hasBid = rawBidUnits !== null && rawBidTop !== undefined;
  const hasAsk = rawAskUnits !== null && rawAskTop !== undefined;

  // R2: always use configured symbol digits and tickSize (no observed-digits override).
  const effDigits = digits;
  const effPoint = goDecimalPointSize(digits);
  const effTick = tickSize;

  // Layer 1 (symbol shaping in float64, mirroring shapeInstrumentBaseQuote + OnLiveTick roundPrice)
  const shaped = fixedS > 0 || balanceSB !== 0;
  let baseBidTop = rawBidTop ?? 0;
  let baseAskTop = rawAskTop ?? 0;
  let bidBaseShift = 0;
  let askBaseShift = 0;
  if (shaped) {
    if (fixedS > 0) {
      if (hasBid && hasAsk) {
        const fixedSpread = fixedS * effPoint;
        const spread = rawAskTop - rawBidTop;
        if (Math.abs(spread - fixedSpread) <= effPoint * 1e-6) {
          bidBaseShift = balanceSB * effPoint;
          baseBidTop = rawBidTop + bidBaseShift;
        } else {
          const offset = (Math.trunc(fixedS / 2) - balanceSB) * effPoint;
          bidBaseShift = spread / 2 - offset;
          baseBidTop = (rawAskTop + rawBidTop) / 2 - offset;
        }
        baseAskTop = baseBidTop + fixedSpread;
        askBaseShift = bidBaseShift + (fixedSpread - spread);
      }
    } else {
      if (hasBid) {
        bidBaseShift = balanceSB * effPoint;
        baseBidTop = rawBidTop + bidBaseShift;
      }
      if (hasAsk) {
        askBaseShift = balanceSB * effPoint;
        baseAskTop = rawAskTop + askBaseShift;
      }
    }
    if (hasBid && hasAsk && baseBidTop > baseAskTop) {
      baseBidTop = rawBidTop;
      baseAskTop = rawAskTop;
      bidBaseShift = 0;
      askBaseShift = 0;
    }
  }
  if (hasBid) baseBidTop = goRoundPrice(baseBidTop, effDigits);
  if (hasAsk) baseAskTop = goRoundPrice(baseAskTop, effDigits);

  // Layer 2 (group share in float64, mirroring widenQuoteForSpreadTermsUnits)
  let bidDelta: number;
  let askDelta: number;
  if (diffD >= 0 && effTick === effPoint) {
    const total = m + diffD;
    const askPts = Math.floor(total / 2) + diffBalanceB;
    const bidPts = total - askPts;
    bidDelta = bidPts * effPoint;
    askDelta = askPts * effPoint;
  } else {
    const legacyAskPts = m > 0 ? Math.floor(m / 2) : 0;
    const legacyBidPts = m > 0 ? m - legacyAskPts : 0;
    const { bidPoints: sdkBidPts, askPoints: sdkAskPts } = goSdkSpreadDiffPoints(diffD, diffBalanceB);
    bidDelta = legacyBidPts * effTick + sdkBidPts * effPoint;
    askDelta = legacyAskPts * effTick + sdkAskPts * effPoint;
  }

  // Independent float64 market-order RAM engine rule for unshaped entries (R1: round stored base first)
  const engineAskPts = m > 0 ? Math.floor(m / 2) : 0;
  const engineBidPts = m > 0 ? m - engineAskPts : 0;
  const normZero = (v: number): number => (v === 0 ? 0 : v);
  const storedBid = hasBid ? goRoundPrice(rawBidTop, digits) : 0;
  const storedAsk = hasAsk ? goRoundPrice(rawAskTop, digits) : 0;
  const engineBidRounded = hasBid
    ? normZero(goRoundPrice(storedBid - engineBidPts * tickSize, digits))
    : undefined;
  const engineAskRounded = hasAsk
    ? normZero(goRoundPrice(storedAsk + engineAskPts * tickSize, digits))
    : undefined;

  return {
    displayDigits: effDigits,
    shaped,
    bidBaseShift,
    askBaseShift,
    bidDelta,
    askDelta,
    baseBidTop,
    baseAskTop,
    engineAskPts,
    engineBidPts,
    engineQuoteBid: engineBidRounded,
    engineQuoteAsk: engineAskRounded,
  };
};

const pickBookBaseTicks = (
  rng: () => number,
  tickUnits: bigint,
  bucket: number,
): bigint => {
  const maxAllTicks = (100_000n * ONE) / tickUnits;
  if (bucket === 0) {
    // TINY: 1..30 ticks (and ensure deep levels stay >= 1 tick; caller enforces floor)
    return randBigInt(rng, 1n, 30n);
  }
  if (bucket === 1 && tickUnits < ONE) {
    // Sub-unit: < 1, but >= 10 ticks when possible so we test both sub-unit >= 10 and < 10 ticks
    const oneMinusOne = ONE / tickUnits - 1n;
    const minT = oneMinusOne >= 10n ? 10n : 1n;
    return randBigInt(rng, minT, oneMinusOne > minT ? oneMinusOne : minT);
  }
  if (bucket === 2) {
    // Small: max(10 ticks, 1.0) .. 10.0
    const low = ONE / tickUnits > 10n ? ONE / tickUnits : 10n;
    const high = (10n * ONE) / tickUnits;
    return randBigInt(rng, low, high > low ? high : low);
  }
  if (bucket === 3) {
    // Medium: 10.0 .. 1,000.0
    const low = (10n * ONE) / tickUnits;
    const high = (1_000n * ONE) / tickUnits;
    return randBigInt(rng, low > 10n ? low : 10n, high);
  }
  // Large: 1,000.0 .. 100,000.0 (leave headroom for ask levels)
  const low = (1_000n * ONE) / tickUnits;
  const high = maxAllTicks > low + 100n ? maxAllTicks - 100n : maxAllTicks;
  return randBigInt(rng, low > 10n ? low : 10n, high > low ? high : low);
};

const buildLevelTicks = (
  rng: () => number,
  count: number,
  topTicks: bigint,
  direction: 'bid' | 'ask',
  minAllowedTicks: bigint,
  maxAllowedTicks: bigint,
): bigint[] => {
  if (count === 0) return [];
  const out: bigint[] = [topTicks];
  let curr = topTicks;
  for (let i = 1; i < count; i += 1) {
    const r = rng();
    const step = r < 0.25 ? 0n : r < 0.65 ? 1n : BigInt(randInt(rng, 2, 5));
    if (direction === 'bid') {
      curr = curr - step;
      if (curr < minAllowedTicks) curr = minAllowedTicks;
    } else {
      curr = curr + step;
      if (curr > maxAllowedTicks) curr = maxAllowedTicks;
    }
    out.push(curr);
  }
  return out;
};

describe('P01 round 6: 60,000-case generated sweep across the whole input space', () => {
  const stats = {} as Record<PropertyKey, PropertyStats>;
  const propKeys: readonly PropertyKey[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  for (const k of propKeys) {
    stats[k] = {
      total: 0,
      reachable: 0,
      remote: 0,
      smallestAll: [],
      smallestReachable: [],
      smallestRemote: [],
    };
  }

  let reachableCount = 0;
  let remoteCount = 0;
  let unshapedCount = 0;
  let shapedCount = 0;
  let elapsedMs = 0;

  beforeAll(() => {
    const startMs = performance.now();
    const rng = createPrng(SEED);

    for (let idx = 0; idx < TOTAL_CASES; idx += 1) {
      const digits = ALL_DIGITS[idx % ALL_DIGITS.length];
      // 30% equal tick for digits, 70% uniform across all 11 ticks (finer, equal, coarser)
      const tickDef = rng() < 0.30
        ? EQUAL_TICK_BY_DIGITS[digits]
        : TICKS[randInt(rng, 0, TICKS.length - 1)];
      const tickUnits = tickDef.tickUnits;
      const pointUnits = pow10Big(SCALE - digits);

      // Price bucket: 25% tiny (1..30 ticks), 20% sub-unit, 20% small, 20% medium, 15% large
      const pRoll = rng();
      const bucket = pRoll < 0.25 ? 0 : pRoll < 0.45 ? 1 : pRoll < 0.65 ? 2 : pRoll < 0.85 ? 3 : 4;
      const baseTicks = pickBookBaseTicks(rng, tickUnits, bucket);

      // Books: 0..12 levels, deliberate share of one-sided, 1-level, 2-level, equal adjacent
      const sideRoll = rng();
      const hasBidSide = sideRoll < 0.82;
      const hasAskSide = sideRoll >= 0.18;
      const pickLevelCount = (): number => {
        const r = rng();
        if (r < 0.20) return 1;
        if (r < 0.40) return 2;
        return randInt(rng, 3, 12);
      };
      const bidCount = hasBidSide ? pickLevelCount() : 0;
      const askCount = hasAskSide ? pickLevelCount() : 0;

      // In tiny bucket allow bids down to 1 tick; in non-tiny buckets keep all levels >= 10 ticks
      // so REACHABLE_TODAY vs REMOTE (< 10 ticks) has no ambiguity from deep levels.
      const minBidLevelTicks = bucket === 0 ? 1n : 10n;
      const spreadRoll = rng();
      const rawSpreadTicks = spreadRoll < 0.25 ? 0n : spreadRoll < 0.50 ? 1n : BigInt(randInt(rng, 2, 25));

      const rawBidTopTicks = hasBidSide
        ? (bucket === 0 ? baseTicks : (baseTicks < 10n ? 10n : baseTicks))
        : 0n;
      const rawAskTopTicks = hasAskSide
        ? (hasBidSide ? rawBidTopTicks + rawSpreadTicks : (bucket === 0 ? baseTicks : (baseTicks < 10n ? 10n : baseTicks)))
        : 0n;

      const maxAllTicks = (100_000n * ONE) / tickUnits;
      const bidTicksArr = buildLevelTicks(rng, bidCount, rawBidTopTicks, 'bid', minBidLevelTicks, maxAllTicks);
      const askTicksArr = buildLevelTicks(rng, askCount, rawAskTopTicks, 'ask', minBidLevelTicks, maxAllTicks);

      // Markup m in 0..500, with deliberate share larger than price in ticks
      const mRoll = rng();
      let m: number;
      if (mRoll < 0.12) {
        m = 0;
      } else if (mRoll < 0.24) {
        m = 1;
      } else if (mRoll < 0.50 && baseTicks <= 250n) {
        // Deliberately larger than (or close to 2x) price in ticks
        const bNum = Number(baseTicks);
        m = randInt(rng, Math.min(500, bNum + 1), Math.min(500, Math.max(bNum + 2, bNum * 2 + 20)));
      } else {
        m = randInt(rng, 2, 500);
      }

      // Unshaped (~50%) vs Shaped (~50%)
      const isShaped = rng() >= 0.50;
      let fixedS = 0;
      let balanceSB = 0;
      let diffD = 0;
      let diffBalanceB = 0;
      if (isShaped) {
        // Guarantee at least one non-zero shaping field while allowing each to be zero sometimes
        do {
          fixedS = rng() < 0.45 ? randInt(rng, 1, 40) : 0;
          balanceSB = rng() < 0.45 ? randInt(rng, -20, 20) : 0;
          diffD = rng() < 0.55 ? (rng() < 0.5 ? randInt(rng, 1, 80) : randInt(rng, -80, -1)) : 0;
          diffBalanceB = rng() < 0.45 ? randInt(rng, -40, 40) : 0;
        } while (fixedS === 0 && balanceSB === 0 && diffD === 0 && diffBalanceB === 0);
        shapedCount += 1;
      } else {
        unshapedCount += 1;
      }

      const rawBidUnitsArr = bidTicksArr.map((t) => t * tickUnits);
      const rawAskUnitsArr = askTicksArr.map((t) => t * tickUnits);
      const rawBidTopUnits = rawBidUnitsArr.length > 0 ? rawBidUnitsArr[0] : null;
      const rawAskTopUnits = rawAskUnitsArr.length > 0 ? rawAskUnitsArr[0] : null;

      const rawBidTop = rawBidTopUnits !== null ? unitsToNumber(rawBidTopUnits) : undefined;
      const rawAskTop = rawAskTopUnits !== null ? unitsToNumber(rawAskTopUnits) : undefined;
      const rawBids: BookLevel[] = rawBidUnitsArr.map((u, i) => ({
        price: unitsToNumber(u),
        volume: i + 1,
        total: i + 1,
        id: i,
      }));
      const rawAsks: BookLevel[] = rawAskUnitsArr.map((u, i) => ({
        price: unitsToNumber(u),
        volume: i + 1,
        total: i + 1,
        id: i,
      }));

      const quoteInput: QuoteInput = rawBidTop !== undefined && rawAskTop !== undefined
        ? { bid: rawBidTop, ask: rawAskTop, spread: unitsToNumber(rawAskTopUnits! - rawBidTopUnits!) }
        : rawBidTop !== undefined
          ? { bid: rawBidTop }
          : { ask: rawAskTop };

      const entryInput = isShaped
        ? {
            spreadMarkup: m,
            tickSize: tickDef.tickSize,
            digits,
            fixedSpreadPoints: fixedS,
            spreadBalancePoints: balanceSB,
            spreadDiffPoints: diffD,
            spreadDiffBalancePoints: diffBalanceB,
          }
        : rng() < 0.5
          ? { spreadMarkup: m, tickSize: tickDef.tickSize, digits }
          : {
              spreadMarkup: m,
              tickSize: tickDef.tickSize,
              digits,
              fixedSpreadPoints: 0,
              spreadBalancePoints: 0,
              spreadDiffPoints: 0,
              spreadDiffBalancePoints: 0,
            };

      const entry: SpreadMarkupEntry | null = resolveSpreadMarkupEntry(entryInput);

      // Pre-call snapshots for Property (g) immutability
      const snapQuoteBid = quoteInput.bid;
      const snapQuoteAsk = quoteInput.ask;
      const snapQuoteSpread = quoteInput.spread;
      const snapQuoteKeys = Object.keys(quoteInput).length;
      const snapBidsPrices = rawBids.map((l) => l.price);
      const snapAsksPrices = rawAsks.map((l) => l.price);
      const snapEntry = entry ? { ...entry } : null;

      const shownQuote = applySpreadMarkupToQuote(quoteInput, entry);
      const shownBids = applySpreadMarkupToBookLevels(rawBids, 'bid', entry, rawAsks);
      const shownAsks = applySpreadMarkupToBookLevels(rawAsks, 'ask', entry, rawBids);
      const twiceQuote = applySpreadMarkupToQuote(shownQuote, entry);

      // Classification: REACHABLE_TODAY vs REMOTE
      let minTicks = 0n;
      for (const t of bidTicksArr) {
        if (minTicks === 0n || t < minTicks) minTicks = t;
      }
      for (const t of askTicksArr) {
        if (minTicks === 0n || t < minTicks) minTicks = t;
      }
      const remoteReasons: string[] = [];
      if (isShaped) remoteReasons.push('shaped');
      if (minTicks < 10n) remoteReasons.push('price<10ticks');
      if (tickUnits < pointUnits) remoteReasons.push('tick<point');
      const classification: FailureClass = remoteReasons.length > 0 ? 'REMOTE' : 'REACHABLE_TODAY';
      if (classification === 'REACHABLE_TODAY') reachableCount += 1;
      else remoteCount += 1;

      const sortTopPrice = rawBidTop ?? rawAskTop ?? 0;
      const tickDecimalsNote = tickUnits >= pointUnits && tickUnits % pointUnits !== 0n ? ' [tickDecimals>digits]' : '';
      const inputSummary =
        `digits=${digits} tick=${tickDef.tickSize}${tickDecimalsNote} m=${m} S=${fixedS} SB=${balanceSB} D=${diffD} B=${diffBalanceB} `
        + `bids=[${rawBids.map((l) => l.price).join(',')}] asks=[${rawAsks.map((l) => l.price).join(',')}]`;

      const recordFailure = (prop: PropertyKey, detail: string): void => {
        const st = stats[prop];
        st.total += 1;
        const rec: FailRecord = {
          caseIndex: idx,
          sortTopPrice,
          sortLevels: rawBids.length + rawAsks.length,
          sortMarkup: m,
          sortDigits: digits,
          classification,
          remoteReasons,
          detail,
          inputSummary,
        };
        insertSmallest(st.smallestAll, rec);
        if (classification === 'REACHABLE_TODAY') {
          st.reachable += 1;
          insertSmallest(st.smallestReachable, rec);
        } else {
          st.remote += 1;
          insertSmallest(st.smallestRemote, rec);
        }
      };

      // (a) No shown price is NaN, infinite, zero, or negative
      let failA: string | null = null;
      if (rawBidTop !== undefined && !isPositiveFinite(shownQuote.bid)) {
        failA = `quote.bid=${String(shownQuote.bid)}`;
      } else if (rawAskTop !== undefined && !isPositiveFinite(shownQuote.ask)) {
        failA = `quote.ask=${String(shownQuote.ask)}`;
      } else {
        for (let i = 0; i < shownBids.length; i += 1) {
          if (!isPositiveFinite(shownBids[i].price)) {
            failA = `shownBids[${i}].price=${String(shownBids[i].price)}`;
            break;
          }
        }
        if (failA === null) {
          for (let i = 0; i < shownAsks.length; i += 1) {
            if (!isPositiveFinite(shownAsks[i].price)) {
              failA = `shownAsks[${i}].price=${String(shownAsks[i].price)}`;
              break;
            }
          }
        }
      }
      if (failA !== null) recordFailure('a', failA);

      // (b) Each side's shown order is kept (bids non-increasing, asks non-decreasing)
      let failB: string | null = null;
      for (let i = 1; i < shownBids.length; i += 1) {
        if (shownBids[i].price > shownBids[i - 1].price || shownBids[i].price > shownBids[0].price) {
          failB = `bids[${i}]=${shownBids[i].price} > prev=${shownBids[i - 1].price}`;
          break;
        }
      }
      if (failB === null) {
        for (let i = 1; i < shownAsks.length; i += 1) {
          if (shownAsks[i].price < shownAsks[i - 1].price || shownAsks[i].price < shownAsks[0].price) {
            failB = `asks[${i}]=${shownAsks[i].price} < prev=${shownAsks[i - 1].price}`;
            break;
          }
        }
      }
      if (failB !== null) recordFailure('b', failB);

      // (c) Depth top equals shown quote's side whenever that side has a top level
      let failC: string | null = null;
      if (rawBids.length > 0) {
        if (shownBids.length === 0 || shownBids[0].price !== shownQuote.bid) {
          failC = `bids[0]=${String(shownBids[0]?.price)} != quote.bid=${String(shownQuote.bid)}`;
        }
      } else if (shownBids.length !== 0) {
        failC = `empty rawBids produced ${shownBids.length} shownBids`;
      }
      if (failC === null) {
        if (rawAsks.length > 0) {
          if (shownAsks.length === 0 || shownAsks[0].price !== shownQuote.ask) {
            failC = `asks[0]=${String(shownAsks[0]?.price)} != quote.ask=${String(shownQuote.ask)}`;
          }
        } else if (shownAsks.length !== 0) {
          failC = `empty rawAsks produced ${shownAsks.length} shownAsks`;
        }
      }
      if (failC !== null) recordFailure('c', failC);

      // (d) Shown bid <= shown ask at top whenever both exist (raw book is never crossed)
      let failD: string | null = null;
      if (rawBidTop !== undefined && rawAskTop !== undefined) {
        if (
          typeof shownQuote.bid === 'number'
          && typeof shownQuote.ask === 'number'
          && shownQuote.bid > shownQuote.ask
        ) {
          failD = `quote crossed: ${shownQuote.bid} > ${shownQuote.ask}`;
        } else if (
          shownBids.length > 0
          && shownAsks.length > 0
          && shownBids[0].price > shownAsks[0].price
        ) {
          failD = `depth crossed: ${shownBids[0].price} > ${shownAsks[0].price}`;
        }
      }
      if (failD !== null) recordFailure('d', failD);

      // Compute independent float64 Go-engine reference once for (e) and (h)
      const ref = computeIndependentReference(
        digits,
        tickDef.tickSize,
        m,
        fixedS,
        balanceSB,
        diffD,
        diffBalanceB,
        rawBidTop,
        rawAskTop,
        rawBidTopUnits,
        rawAskTopUnits,
      );

      // (e) Every shown level's price equals its raw level moved by side's share (or kept at base/raw
      // by fallback) and rounded once at display digits with Go's float64 roundPrice
      let failE: string | null;
      const checkLevelsE = (
        sideName: 'bid' | 'ask',
        shownLevels: readonly BookLevel[],
        rawLevels: readonly BookLevel[],
        baseShift: number,
        delta: number,
        baseTop: number,
      ): string | null => {
        let prevId = -1;
        for (let i = 0; i < shownLevels.length; i += 1) {
          const lvl = shownLevels[i];
          const srcIdx = lvl.id;
          if (!Number.isInteger(srcIdx) || srcIdx <= prevId || srcIdx >= rawLevels.length) {
            return `${sideName}[${i}] unexpected source id=${String(srcIdx)}`;
          }
          prevId = srcIdx;
          const rawLvlPrice = rawLevels[srcIdx].price;
          if (entry === null) {
            if (lvl.price !== rawLvlPrice) {
              return `${sideName}[${i}]=${lvl.price} != raw=${rawLvlPrice} (inactive entry)`;
            }
            continue;
          }
          const baseVal = srcIdx === 0 ? baseTop : goRoundPrice(rawLvlPrice + baseShift, ref.displayDigits);
          const movedVal = sideName === 'bid' ? baseVal - delta : baseVal + delta;
          const movedRoundedRaw = goRoundPrice(movedVal, ref.displayDigits);
          const movedRounded = movedRoundedRaw > 0 ? movedRoundedRaw : null;
          const baseRoundedRaw = goRoundPrice(baseVal, ref.displayDigits);
          const baseRounded = baseRoundedRaw > 0 ? baseRoundedRaw : null;
          const keptRoundedRaw = goRoundPrice(rawLvlPrice, ref.displayDigits);
          const keptRounded = keptRoundedRaw > 0 ? keptRoundedRaw : rawLvlPrice;
          if (
            lvl.price !== movedRounded
            && (baseRounded === null || lvl.price !== baseRounded)
            && lvl.price !== rawLvlPrice
            && lvl.price !== keptRounded
          ) {
            return (
              `${sideName}[${i}]=${lvl.price} not in {movedRounded=${String(movedRounded)}, `
              + `baseRounded=${String(baseRounded)}, keptRounded=${keptRounded}, raw=${rawLvlPrice}}`
            );
          }
        }
        return null;
      };
      failE = checkLevelsE('bid', shownBids, rawBids, ref.bidBaseShift, ref.bidDelta, ref.baseBidTop);
      if (failE === null) {
        failE = checkLevelsE('ask', shownAsks, rawAsks, ref.askBaseShift, ref.askDelta, ref.baseAskTop);
      }
      if (failE !== null) recordFailure('e', failE);

      // (f) Number of shown levels never exceeds raw number
      if (shownBids.length > rawBids.length || shownAsks.length > rawAsks.length) {
        recordFailure(
          'f',
          `bids ${shownBids.length}/${rawBids.length}, asks ${shownAsks.length}/${rawAsks.length}`,
        );
      }

      // (g) Inputs are not mutated
      let failG: string | null = null;
      if (
        quoteInput.bid !== snapQuoteBid
        || quoteInput.ask !== snapQuoteAsk
        || quoteInput.spread !== snapQuoteSpread
        || Object.keys(quoteInput).length !== snapQuoteKeys
      ) {
        failG = 'quoteInput mutated';
      } else if (
        rawBids.some((l, i) => l.price !== snapBidsPrices[i] || l.volume !== i + 1 || l.total !== i + 1)
        || rawAsks.some((l, i) => l.price !== snapAsksPrices[i] || l.volume !== i + 1 || l.total !== i + 1)
      ) {
        failG = 'book levels mutated';
      } else if (
        entry
        && snapEntry
        && (
          entry.points !== snapEntry.points
          || entry.tickSize !== snapEntry.tickSize
          || entry.digits !== snapEntry.digits
          || entry.fixedSpreadPoints !== snapEntry.fixedSpreadPoints
          || entry.spreadBalancePoints !== snapEntry.spreadBalancePoints
          || entry.spreadDiffPoints !== snapEntry.spreadDiffPoints
          || entry.spreadDiffBalancePoints !== snapEntry.spreadDiffBalancePoints
        )
      ) {
        failG = 'entry mutated';
      }
      if (failG !== null) recordFailure('g', failG);

      // (h) For unshaped entries with a positive stored price and >= 10 ticks above bid share (no sub-unit
      // observed-digits exception, R2), matches independent float64 market-order Go-engine rule (R1)
      if (!isShaped) {
        const minRequiredTicks = BigInt(ref.engineBidPts) + 10n;
        const bidOk = !hasBidSide || (rawBidTopTicks >= minRequiredTicks && goRoundPrice(rawBidTop!, digits) > 0);
        const askOk = !hasAskSide || (rawAskTopTicks >= minRequiredTicks && goRoundPrice(rawAskTop!, digits) > 0);
        if (entry === null) {
          // m=0, unshaped (R3(b)): spreadMarkup.ts returns raw quote and levels untouched
          let failH: string | null = null;
          if (hasBidSide && shownQuote.bid !== rawBidTop) {
            failH = `quote.bid=${String(shownQuote.bid)} != raw=${String(rawBidTop)}`;
          } else if (hasAskSide && shownQuote.ask !== rawAskTop) {
            failH = `quote.ask=${String(shownQuote.ask)} != raw=${String(rawAskTop)}`;
          } else if (
            shownBids.length !== rawBids.length
            || shownBids.some((l, i) => l.price !== rawBids[i].price)
          ) {
            failH = `bids=[${shownBids.map((l) => l.price).join(',')}] != raw=[${rawBids.map((l) => l.price).join(',')}]`;
          } else if (
            shownAsks.length !== rawAsks.length
            || shownAsks.some((l, i) => l.price !== rawAsks[i].price)
          ) {
            failH = `asks=[${shownAsks.map((l) => l.price).join(',')}] != raw=[${rawAsks.map((l) => l.price).join(',')}]`;
          }
          if (failH !== null) recordFailure('h', failH);
        } else if (
          bidOk
          && askOk
          && (!hasBidSide || (ref.engineQuoteBid ?? 0) > 0)
          && (!hasAskSide || (ref.engineQuoteAsk ?? 0) > 0)
        ) {
          let failH: string | null = null;
          if (hasBidSide && shownQuote.bid !== ref.engineQuoteBid) {
            failH = `quote.bid=${String(shownQuote.bid)} != engine=${String(ref.engineQuoteBid)}`;
          } else if (hasAskSide && shownQuote.ask !== ref.engineQuoteAsk) {
            failH = `quote.ask=${String(shownQuote.ask)} != engine=${String(ref.engineQuoteAsk)}`;
          } else if (hasBidSide && (shownBids.length === 0 || shownBids[0].price !== ref.engineQuoteBid)) {
            failH = `bids[0]=${String(shownBids[0]?.price)} != engine=${String(ref.engineQuoteBid)}`;
          } else if (hasAskSide && (shownAsks.length === 0 || shownAsks[0].price !== ref.engineQuoteAsk)) {
            failH = `asks[0]=${String(shownAsks[0]?.price)} != engine=${String(ref.engineQuoteAsk)}`;
          }
          if (failH === null) {
            // Also check all depth levels against the float64 market-order rule (round base first, then shift & round; drop <= 0)
            const expectedBids: number[] = [];
            for (const lvl of rawBids) {
              const r = goRoundPrice(goRoundPrice(lvl.price, digits) - ref.engineBidPts * tickDef.tickSize, digits);
              if (r > 0) expectedBids.push(r === 0 ? 0 : r);
            }
            const expectedAsks: number[] = [];
            for (const lvl of rawAsks) {
              const r = goRoundPrice(goRoundPrice(lvl.price, digits) + ref.engineAskPts * tickDef.tickSize, digits);
              if (r > 0) expectedAsks.push(r === 0 ? 0 : r);
            }
            if (
              shownBids.length !== expectedBids.length
              || shownBids.some((l, i) => l.price !== expectedBids[i])
            ) {
              failH = `bids=[${shownBids.map((l) => l.price).join(',')}] != engine=[${expectedBids.join(',')}]`;
            } else if (
              shownAsks.length !== expectedAsks.length
              || shownAsks.some((l, i) => l.price !== expectedAsks[i])
            ) {
              failH = `asks=[${shownAsks.map((l) => l.price).join(',')}] != engine=[${expectedAsks.join(',')}]`;
            }
          }
          if (failH !== null) recordFailure('h', failH);
        }
      }

      // (i) Applying quote markup twice equals applying it once
      if (
        twiceQuote.bid !== shownQuote.bid
        || twiceQuote.ask !== shownQuote.ask
        || twiceQuote.spread !== shownQuote.spread
        || twiceQuote.rawBid !== shownQuote.rawBid
        || twiceQuote.rawAsk !== shownQuote.rawAsk
        || twiceQuote.spreadMarkup !== shownQuote.spreadMarkup
      ) {
        recordFailure(
          'i',
          `once=${JSON.stringify(shownQuote)} vs twice=${JSON.stringify(twiceQuote)}`,
        );
      }
    }

    elapsedMs = Math.round(performance.now() - startMs);

    const lines: string[] = [
      `SWEEP_SUMMARY cases=${TOTAL_CASES} seed=0x${SEED.toString(16)} elapsedMs=${elapsedMs} `
      + `unshaped=${unshapedCount} shaped=${shapedCount} reachableCases=${reachableCount} remoteCases=${remoteCount}`,
    ];
    for (const k of propKeys) {
      const st = stats[k];
      lines.push(
        `PROP_${k.toUpperCase()} total=${st.total} reachable=${st.reachable} remote=${st.remote} :: ${PROPERTY_LABELS[k]}`,
      );
      if (st.smallestReachable.length > 0) {
        lines.push(`  smallest REACHABLE_TODAY (${st.smallestReachable.length}):`);
        for (const rec of st.smallestReachable) {
          lines.push(`    #${rec.caseIndex} [${rec.detail}] ${rec.inputSummary}`);
        }
      }
      if (st.smallestRemote.length > 0) {
        lines.push(`  smallest REMOTE (${st.smallestRemote.length}):`);
        for (const rec of st.smallestRemote) {
          lines.push(`    #${rec.caseIndex} (${rec.remoteReasons.join('+')}) [${rec.detail}] ${rec.inputSummary}`);
        }
      }
    }
    console.log(lines.join('\n'));
  });

  const formatFailureMsg = (key: PropertyKey): string => {
    const st = stats[key];
    const samples = st.smallestAll
      .map((r) => `#${r.caseIndex} [${r.classification}:${r.remoteReasons.join('+') || 'none'}] ${r.detail} | ${r.inputSummary}`)
      .join('\n  ');
    return `${PROPERTY_LABELS[key]} failed ${st.total} times (REACHABLE_TODAY=${st.reachable}, REMOTE=${st.remote}):\n  ${samples}`;
  };

  it('property (a): no shown price is NaN, infinite, zero, or negative', () => {
    expect(stats.a.total, formatFailureMsg('a')).toBe(0);
  });

  it('property (b): each side keeps its shown order (bids non-increasing, asks non-decreasing)', () => {
    expect(stats.b.total, formatFailureMsg('b')).toBe(0);
  });

  it('property (c): depth top equals shown quote side whenever raw side has a top level', () => {
    expect(stats.c.total, formatFailureMsg('c')).toBe(0);
  });

  it('property (d): shown bid <= shown ask at top whenever both exist (non-crossed raw)', () => {
    expect(stats.d.total, formatFailureMsg('d')).toBe(0);
  });

  it('property (e): every shown level equals moved+rounded once at display digits or kept raw', () => {
    expect(stats.e.total, formatFailureMsg('e')).toBe(0);
  });

  it('property (f): shown level count never exceeds raw level count', () => {
    expect(stats.f.total, formatFailureMsg('f')).toBe(0);
  });

  it('property (g): inputs are never mutated', () => {
    expect(stats.g.total, formatFailureMsg('g')).toBe(0);
  });

  it('property (h): unshaped >= 10 ticks above bid share matches independent float64 Go-engine rule', () => {
    expect(stats.h.total, formatFailureMsg('h')).toBe(0);
  });

  it('property (i): applying quote markup twice equals applying it once', () => {
    expect(stats.i.total, formatFailureMsg('i')).toBe(0);
  });

  it('independent float64 market-order Go-engine reference matches spreadMarkupEngineGoldenMarket.jsonl bit-for-bit', () => {
    const fixturePath = path.resolve(__dirname, '__fixtures__/spreadMarkupEngineGoldenMarket.jsonl');
    const lines = fs.readFileSync(fixturePath, 'utf8').trim().split(/\r?\n/);
    expect(lines.length).toBeGreaterThanOrEqual(6_000);
    const mismatches: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const row = JSON.parse(lines[i]) as {
        d: number; t: string; rb: string; ra: string; m: number; S: number; SB: number; D: number; B: number; mBid: string; mAsk: string;
      };
      const got = goMarketAccountQuote(
        Number(row.rb), Number(row.ra), row.d, Number(row.t), row.m, row.S, row.SB, row.D, row.B,
      );
      const mb = Number(row.mBid);
      const ma = Number(row.mAsk);
      if (!Object.is(got.bid, mb) || !Object.is(got.ask, ma)) {
        if (mismatches.length < 10) {
          mismatches.push(`line ${i + 1}: got=${got.bid}/${got.ask} vs golden=${mb}/${ma}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
