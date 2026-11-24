/**
 * P01 round 7 (independent tester): Engine float parity sweep (>= 200,000 cases).
 *
 * Compares `applySpreadMarkupToQuote` (and `applySpreadMarkupToBookLevels` top) against:
 *   1. Independent JS emulation of the released Go RAM engine (`origin/main`):
 *      - `decimalPointSize(digits)` (`services/gateway/handlers/stops_level_enforce.go:37-45`)
 *      - `widenQuoteForSpreadTermsUnits` -> `widenQuoteForSpread` -> `applySpreadPriceDeltas`
 *        (`services/gateway/handlers/spread_markup.go:107-166`)
 *      - `roundPrice(price, digits)` (`services/gateway/handlers/ram_mt5_phase5.go:24-39`),
 *        used at `ram_mt5_engine.go:3447-3448` and `ram_symbol_reload_tcp.go:1204-1208`
 *   2. Independent exact-decimal half-up reference (`canonicalpolicy.ApprovedEffectiveQuote`,
 *      `services/gateway/internal/canonicalpolicy/approved_pricing.go:522-536,930-942`,
 *      `exactdecimal.RoundHalfUp`)
 *   3. Baseline rounding: the terminal's rounding before this change (`src/utils/spreadMarkup.ts` at the commit before P01) on the same moved prices
 *
 * Fixed seed `0x50303137`. Covers digits 0..5 and 8, tick == point, m in 0..500, prices 0.5..150,000,
 * realistic <=digits decimals, digits+1 non-tie decimals, digits+1 exact .5 decimals, and >= 20,000
 * constructed exact / -1 ulp / +1 ulp half-tie cases after the move.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  resolveSpreadMarkupEntry,
} from './spreadMarkup';

const SEED = 0x50303137;
const CAT1_COUNT = 100_000; // <= digits decimals (realistic feeds)
const CAT2A_COUNT = 40_000; // digits + 1 decimals, last digit != 5
const CAT2B_COUNT = 40_000; // digits + 1 decimals, last digit == 5 (exact half-point tie)
const CAT3_COUNT = 40_000; // constructed exact / -1 ulp / +1 ulp half-point tie after move

const DIGITS_LIST = [0, 1, 2, 3, 4, 5, 8] as const;

// Released Go `pricePow10Table` (`services/gateway/handlers/ram_mt5_phase5.go:24-27`)
const GO_POW10: readonly number[] = [
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9,
  1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18,
];

// --- Mulberry32 PRNG ---
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

// --- IEEE-754 ulp stepping ---
const ulpBuf = new ArrayBuffer(8);
const ulpView = new DataView(ulpBuf);

const stepUlp = (value: number, deltaUlp: number): number => {
  if (deltaUlp === 0 || !Number.isFinite(value)) return value;
  ulpView.setFloat64(0, value, false);
  let bits = ulpView.getBigUint64(0, false);
  const absDelta = BigInt(Math.abs(deltaUlp));
  if (value === 0) {
    bits = absDelta;
    if (deltaUlp < 0) bits |= 1n << 63n;
  } else if ((value > 0 && deltaUlp > 0) || (value < 0 && deltaUlp < 0)) {
    bits += absDelta;
  } else {
    bits -= absDelta;
  }
  ulpView.setBigUint64(0, bits, false);
  return ulpView.getFloat64(0, false);
};

// --- Released Go RAM engine emulation (unshaped, tick == point) ---
const goMathRound = (x: number): number => {
  if (!Number.isFinite(x)) return x;
  const mag = Math.abs(x);
  const whole = Math.floor(mag);
  const r = mag - whole >= 0.5 ? whole + 1 : whole;
  const signed = x < 0 ? -r : r;
  return Object.is(signed, -0) ? 0 : signed;
};

const goRoundPrice = (price: number, digits: number): number => {
  const d = digits < 0 ? 5 : digits;
  const pow = d < GO_POW10.length ? GO_POW10[d] : 10 ** d;
  return goMathRound(price * pow) / pow;
};

const goDecimalPointSize = (digits: number): number => {
  const d = digits < 0 ? 5 : digits;
  return d < GO_POW10.length ? 1 / GO_POW10[d] : 10 ** -d;
};

const emulateGoRamEngineUnshaped = (
  rawBid: number,
  rawAsk: number,
  digits: number,
  m: number,
): { bid: number; ask: number } => {
  const point = goDecimalPointSize(digits);
  // Market-order path (R1): OnLiveTick stores Layer-1 rounded quote first, then ReadLiveQuoteFast feeds Layer 2.
  const storedBid = digits >= 0 ? goRoundPrice(rawBid, digits) : rawBid;
  const storedAsk = digits >= 0 ? goRoundPrice(rawAsk, digits) : rawAsk;
  let outBid = storedBid;
  let outAsk = storedAsk;

  if (m > 0) {
    // sdkSpreadDiffPoints(m, 0) via widenQuoteForSpreadTermsUnits -> widenQuoteForSpread
    const bidPts = m - Math.trunc(m / 2);
    const askPts = m - bidPts;
    const bidDelta = bidPts * point;
    const askDelta = askPts * point;
    outBid = storedBid - bidDelta;
    outAsk = storedAsk + askDelta;
    if (!(outBid > 0)) outBid = storedBid;
    if (!(outAsk > 0) || outBid > outAsk) {
      outBid = storedBid;
      outAsk = storedAsk;
    }
  }

  return {
    bid: goRoundPrice(outBid, digits),
    ask: goRoundPrice(outAsk, digits),
  };
};

// --- Baseline rounding: the terminal's rounding before this change (`src/utils/spreadMarkup.ts` at the commit before P01) ---
const baselineRoundPriceToDigits = (value: number, digits: number): number => {
  if (!Number.isFinite(value)) return value;
  const safeDigits = Math.min(10, Math.max(0, Math.floor(digits)));
  const factor = 10 ** safeDigits;
  const rounded = Math.round((value + Math.sign(value) * Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const emulateBaselineRoundingUnshaped = (
  rawBid: number,
  rawAsk: number,
  digits: number,
  m: number,
): { bid: number; ask: number } => {
  if (m <= 0) return { bid: rawBid, ask: rawAsk };
  const point = 10 ** -digits;
  const askPts = Math.floor(m / 2);
  const bidPts = m - askPts;
  let bid = baselineRoundPriceToDigits(rawBid - bidPts * point, digits);
  let ask = baselineRoundPriceToDigits(rawAsk + askPts * point, digits);
  if (!(bid > 0)) {
    const kept = baselineRoundPriceToDigits(rawBid, digits);
    bid = kept > 0 ? kept : rawBid;
  }
  if (!(ask > 0) || bid > ask) {
    const keptB = baselineRoundPriceToDigits(rawBid, digits);
    const keptA = baselineRoundPriceToDigits(rawAsk, digits);
    bid = keptB > 0 ? keptB : rawBid;
    ask = keptA > 0 ? keptA : rawAsk;
  }
  return { bid, ask };
};

// --- Exact-decimal reference ---
const pow10Big = (n: number): bigint => 10n ** BigInt(n);

const scaledIntToNumber = (scaledInt: bigint, digits: number): number => {
  if (scaledInt === 0n) return 0;
  const neg = scaledInt < 0n;
  const abs = neg ? -scaledInt : scaledInt;
  if (digits === 0) return Number(neg ? `-${abs.toString()}` : abs.toString());
  const s = abs.toString().padStart(digits + 1, '0');
  const intPart = s.slice(0, s.length - digits);
  const fracPart = s.slice(s.length - digits).replace(/0+$/, '');
  const text = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return Number(neg ? `-${text}` : text);
};

// Exact BigInt half-up rounding from an integer decimal scaled by 10^inputScale
const exactDecimalRoundFromUnits = (
  units: bigint,
  inputScale: number,
  targetDigits: number,
): number => {
  if (inputScale <= targetDigits) {
    return scaledIntToNumber(units * pow10Big(targetDigits - inputScale), targetDigits);
  }
  const factor = pow10Big(inputScale - targetDigits);
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const half = factor / 2n;
  const rounded = (abs + half) / factor;
  return scaledIntToNumber(neg ? -rounded : rounded, targetDigits);
};

// Exact BigInt half-up rounding of exact float64 `raw + signedPts * 10^-digits`
const exactFloatPlusPointsRoundHalfUp = (
  raw: number,
  signedPts: number,
  digits: number,
): number => {
  ulpView.setFloat64(0, raw, false);
  const bits = ulpView.getBigUint64(0, false);
  const sign = bits >> 63n === 1n;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const mantBits = bits & ((1n << 52n) - 1n);
  const mant = expBits === 0 ? mantBits : (1n << 52n) | mantBits;
  const exp2 = expBits === 0 ? -1074 : expBits - 1075;
  const signedMant = sign ? -mant : mant;
  const p10 = pow10Big(digits);
  const ptsBig = BigInt(signedPts);

  let roundedScaled: bigint;
  if (exp2 >= 0) {
    roundedScaled = signedMant * (1n << BigInt(exp2)) * p10 + ptsBig;
  } else {
    const den = 1n << BigInt(-exp2);
    const num = signedMant * p10 + ptsBig * den;
    if (num >= 0n) {
      roundedScaled = (2n * num + den) / (2n * den);
    } else {
      roundedScaled = -((2n * -num + den) / (2n * den));
    }
  }
  return scaledIntToNumber(roundedScaled, digits);
};

// Checks whether a float64 represents an exact decimal with <= maxDecimals decimal places
const hasAtMostDecimals = (value: number, maxDecimals: number): boolean => {
  if (!Number.isFinite(value)) return false;
  const pow = maxDecimals < GO_POW10.length ? GO_POW10[maxDecimals] : 10 ** maxDecimals;
  const rounded = Math.round(value * pow) / pow;
  return rounded === value;
};

// --- Mismatch tracking ---
interface MismatchRecord {
  caseIndex: number;
  category: string;
  side: 'bid' | 'ask';
  digits: number;
  m: number;
  rawBid: number;
  rawAsk: number;
  rawSide: number;
  terminal: number;
  engine: number;
  exactDecimal: number;
  baseline: number;
  ulpTag?: string;
}

interface BucketStats {
  checkedCases: number;
  checkedSides: number;
  termVsEngine: number;
  termVsExact: number;
  baseVsEngine: number;
  baseVsExact: number;
  smallestTermVsEngine: MismatchRecord[];
  smallestTermVsExact: MismatchRecord[];
  smallestBaseVsEngine: MismatchRecord[];
}

const makeBucket = (): BucketStats => ({
  checkedCases: 0,
  checkedSides: 0,
  termVsEngine: 0,
  termVsExact: 0,
  baseVsEngine: 0,
  baseVsExact: 0,
  smallestTermVsEngine: [],
  smallestTermVsExact: [],
  smallestBaseVsEngine: [],
});

const compareMismatch = (a: MismatchRecord, b: MismatchRecord): number => {
  if (a.rawSide !== b.rawSide) return a.rawSide - b.rawSide;
  if (a.digits !== b.digits) return a.digits - b.digits;
  if (a.m !== b.m) return a.m - b.m;
  if (a.caseIndex !== b.caseIndex) return a.caseIndex - b.caseIndex;
  return a.side === b.side ? 0 : a.side === 'bid' ? -1 : 1;
};

const insertSmallest3 = (list: MismatchRecord[], rec: MismatchRecord): void => {
  if (list.length < 3) {
    list.push(rec);
    list.sort(compareMismatch);
    return;
  }
  if (compareMismatch(rec, list[2]) < 0) {
    list[2] = rec;
    list.sort(compareMismatch);
  }
};

const formatRecord = (r: MismatchRecord): string =>
  `#${r.caseIndex}[${r.category}${r.ulpTag ? `:${r.ulpTag}` : ''} ${r.side}] d=${r.digits} m=${r.m} raw=${r.rawSide} (bid=${r.rawBid}, ask=${r.rawAsk}) | term=${r.terminal} engine=${r.engine} exact=${r.exactDecimal} base=${r.baseline}`;

// Realistic price magnitude selector across 0.5..150,000
const pickBasePriceTarget = (rng: () => number, digits: number): number => {
  const r = rng();
  if (digits === 8) {
    // Cover FX/crypto from 0.5 up to 150,000, including >= 50,000 where magnitude*1e-14 is large
    if (r < 0.25) return 0.5 + rng() * 1.5;
    if (r < 0.45) return 2 + rng() * 200;
    if (r < 0.65) return 200 + rng() * 9_800;
    if (r < 0.82) return 10_000 + rng() * 40_000;
    return 50_000 + rng() * 100_000;
  }
  if (digits === 4 || digits === 5) {
    if (r < 0.45) return 0.5 + rng() * 1.5;
    if (r < 0.65) return 2 + rng() * 200;
    if (r < 0.85) return 200 + rng() * 10_000;
    return 10_000 + rng() * 140_000;
  }
  if (digits === 2 || digits === 3) {
    if (r < 0.20) return 0.5 + rng() * 0.49;
    if (r < 0.45) return 1 + rng() * 200;
    if (r < 0.70) return 200 + rng() * 4_000;
    return 4_000 + rng() * 146_000;
  }
  // digits 0, 1
  if (r < 0.15) return 0.5 + rng() * 0.49;
  if (r < 0.35) return 10 + rng() * 500;
  if (r < 0.70) return 500 + rng() * 45_000;
  return 45_000 + rng() * 105_000;
};

describe('P01 round 7: Go RAM engine float parity sweep (220,000 cases)', () => {
  const cat1 = makeBucket();
  const cat2aActive = makeBucket();
  const cat2bActive = makeBucket();
  const cat2m0 = makeBucket();
  const cat2SubUnit = makeBucket();
  const cat3UlpOnly = makeBucket();
  const cat3RealAccidental = makeBucket();

  let totalCases = 0;
  let ulpCasesConstructed = 0;
  let bookTopMismatches = 0;
  let cat2m0UntouchedMismatches = 0;
  let elapsedMs = 0;

  beforeAll(() => {
    const startMs = performance.now();
    const rng = createPrng(SEED);

    const recordCase = (
      bucket: BucketStats,
      caseIndex: number,
      category: string,
      digits: number,
      m: number,
      rawBid: number,
      rawAsk: number,
      exactBid: number,
      exactAsk: number,
      ulpTag?: string,
      altRealFeedBucket?: BucketStats,
    ): void => {
      const point = 10 ** -digits;
      const entry = resolveSpreadMarkupEntry({ spreadMarkup: m, tickSize: point, digits });
      const shownQuote = applySpreadMarkupToQuote({ bid: rawBid, ask: rawAsk }, entry);
      const shownBids = applySpreadMarkupToBookLevels([{ price: rawBid }], 'bid', entry, [{ price: rawAsk }]);
      const shownAsks = applySpreadMarkupToBookLevels([{ price: rawAsk }], 'ask', entry, [{ price: rawBid }]);
      if (shownBids[0].price !== shownQuote.bid || shownAsks[0].price !== shownQuote.ask) {
        bookTopMismatches += 1;
      }

      const eng = emulateGoRamEngineUnshaped(rawBid, rawAsk, digits, m);
      const base = emulateBaselineRoundingUnshaped(rawBid, rawAsk, digits, m);

      if (!altRealFeedBucket) {
        bucket.checkedCases += 1;
      }
      if (m === 0 && (shownQuote.bid !== rawBid || shownQuote.ask !== rawAsk)) {
        cat2m0UntouchedMismatches += 1;
      }

      const sides: Array<{
        side: 'bid' | 'ask';
        rawSide: number;
        term: number;
        engine: number;
        exact: number;
        baseline: number;
      }> = [
        {
          side: 'bid',
          rawSide: rawBid,
          term: shownQuote.bid as number,
          engine: eng.bid,
          exact: exactBid,
          baseline: base.bid,
        },
        {
          side: 'ask',
          rawSide: rawAsk,
          term: shownQuote.ask as number,
          engine: eng.ask,
          exact: exactAsk,
          baseline: base.ask,
        },
      ];

      for (const s of sides) {
        const targetBucket = altRealFeedBucket && hasAtMostDecimals(s.rawSide, digits + 1)
          ? altRealFeedBucket
          : bucket;
        if (altRealFeedBucket) {
          targetBucket.checkedCases += 0.5;
        }
        targetBucket.checkedSides += 1;

        const rec: MismatchRecord = {
          caseIndex,
          category,
          side: s.side,
          digits,
          m,
          rawBid,
          rawAsk,
          rawSide: s.rawSide,
          terminal: s.term,
          engine: s.engine,
          exactDecimal: s.exact,
          baseline: s.baseline,
          ulpTag,
        };
        if (s.term !== s.engine) {
          targetBucket.termVsEngine += 1;
          insertSmallest3(targetBucket.smallestTermVsEngine, rec);
        }
        if (s.term !== s.exact) {
          targetBucket.termVsExact += 1;
          insertSmallest3(targetBucket.smallestTermVsExact, rec);
        }
        if (s.baseline !== s.engine) {
          targetBucket.baseVsEngine += 1;
          insertSmallest3(targetBucket.smallestBaseVsEngine, rec);
        }
        if (s.baseline !== s.exact) {
          targetBucket.baseVsExact += 1;
        }
      }
    };

    // Category 1: 100,000 cases with <= digits decimals
    for (let i = 0; i < CAT1_COUNT; i += 1) {
      const digits = DIGITS_LIST[i % DIGITS_LIST.length];
      const m = i % 10 === 0 ? 0 : i % 10 === 1 ? 1 : randInt(rng, 2, 500);
      const bidPts = m > 0 ? m - Math.floor(m / 2) : 0;
      const askPts = m - bidPts;
      const powN = pow10Big(digits);
      const minHalfUnit = BigInt(Math.ceil(0.5 * Number(powN)));
      const minBidStep = BigInt(bidPts + 5);
      const minTicks = minHalfUnit > minBidStep ? minHalfUnit : minBidStep;
      const maxTicks = 150_000n * powN - 50n;

      const target = pickBasePriceTarget(rng, digits);
      let bidTicks = BigInt(Math.round(target * Number(powN)));
      if (bidTicks < minTicks) bidTicks = minTicks;
      if (bidTicks > maxTicks) bidTicks = maxTicks;
      const spreadTicks = BigInt(randInt(rng, 0, 20));
      const askTicks = bidTicks + spreadTicks;

      const rawBid = scaledIntToNumber(bidTicks, digits);
      const rawAsk = scaledIntToNumber(askTicks, digits);
      const exactBid = exactDecimalRoundFromUnits(bidTicks - BigInt(bidPts), digits, digits);
      const exactAsk = exactDecimalRoundFromUnits(askTicks + BigInt(askPts), digits, digits);

      recordCase(cat1, totalCases, 'cat1(<=d)', digits, m, rawBid, rawAsk, exactBid, exactAsk);
      totalCases += 1;
    }

    // Category 2a: 40,000 cases with digits+1 decimals, last digit in {1,2,3,4,6,7,8,9}
    const nonTieLastDigits = [1, 2, 3, 4, 6, 7, 8, 9] as const;
    for (let i = 0; i < CAT2A_COUNT; i += 1) {
      const digits = DIGITS_LIST[i % DIGITS_LIST.length];
      const m = i % 12 === 0 ? 0 : i % 12 === 1 ? 1 : randInt(rng, 2, 500);
      const bidPts = m > 0 ? m - Math.floor(m / 2) : 0;
      const askPts = m - bidPts;
      const extraScale = digits + 1;
      const powExtra = pow10Big(extraScale);
      const minBidStep = BigInt(bidPts + 5) * 10n;
      const minHalfUnit = powExtra / 2n;
      const minUnits = minBidStep > minHalfUnit ? minBidStep : minHalfUnit;
      const maxUnits = 150_000n * powExtra - 500n;

      const target = pickBasePriceTarget(rng, digits);
      const baseInt = BigInt(Math.round(target * Number(pow10Big(digits))));
      const dBid = nonTieLastDigits[randInt(rng, 0, nonTieLastDigits.length - 1)];
      const dAsk = nonTieLastDigits[randInt(rng, 0, nonTieLastDigits.length - 1)];

      let rawBidUnits = baseInt * 10n + BigInt(dBid);
      if (rawBidUnits < minUnits) rawBidUnits = minUnits + BigInt(dBid);
      if (rawBidUnits > maxUnits) rawBidUnits = maxUnits - 10n + BigInt(dBid);
      const spreadExtra = BigInt(randInt(rng, 1, 200));
      let rawAskUnits = rawBidUnits + spreadExtra;
      if (rawAskUnits % 10n === 0n || rawAskUnits % 10n === 5n) {
        rawAskUnits += BigInt(dAsk === 5 ? 1 : 2);
      }

      const rawBid = scaledIntToNumber(rawBidUnits, extraScale);
      const rawAsk = scaledIntToNumber(rawAskUnits, extraScale);
      const subUnitRuleActive = digits <= 2 && (rawBid < 1 || rawAsk < 1);
      const exactBid = exactDecimalRoundFromUnits(rawBidUnits - BigInt(bidPts) * 10n, extraScale, digits);
      const exactAsk = exactDecimalRoundFromUnits(rawAskUnits + BigInt(askPts) * 10n, extraScale, digits);

      const bucket = m === 0 ? cat2m0 : subUnitRuleActive ? cat2SubUnit : cat2aActive;
      const label = m === 0 ? 'cat2a(m=0)' : subUnitRuleActive ? 'cat2a(subUnit)' : 'cat2a(d+1,nonTie)';
      recordCase(bucket, totalCases, label, digits, m, rawBid, rawAsk, exactBid, exactAsk);
      totalCases += 1;
    }

    // Category 2b: 40,000 cases with digits+1 decimals ending in 5 (exact half-point tie)
    for (let i = 0; i < CAT2B_COUNT; i += 1) {
      const digits = DIGITS_LIST[i % DIGITS_LIST.length];
      const m = i % 12 === 0 ? 0 : i % 12 === 1 ? 1 : randInt(rng, 2, 500);
      const bidPts = m > 0 ? m - Math.floor(m / 2) : 0;
      const askPts = m - bidPts;
      const extraScale = digits + 1;
      const powExtra = pow10Big(extraScale);
      const minBidStep = BigInt(bidPts + 5) * 10n;
      const minHalfUnit = powExtra / 2n;
      const minUnits = minBidStep > minHalfUnit ? minBidStep : minHalfUnit;
      const maxUnits = 150_000n * powExtra - 500n;

      const target = pickBasePriceTarget(rng, digits);
      let baseInt = BigInt(Math.round(target * Number(pow10Big(digits))));
      let rawBidUnits = baseInt * 10n + 5n;
      if (rawBidUnits < minUnits) {
        baseInt = minUnits / 10n + 1n;
        rawBidUnits = baseInt * 10n + 5n;
      }
      if (rawBidUnits > maxUnits) {
        baseInt = maxUnits / 10n - 20n;
        rawBidUnits = baseInt * 10n + 5n;
      }
      const rawAskUnits = rawBidUnits + BigInt(randInt(rng, 0, 20)) * 10n;

      const rawBid = scaledIntToNumber(rawBidUnits, extraScale);
      const rawAsk = scaledIntToNumber(rawAskUnits, extraScale);
      const subUnitRuleActive = digits <= 2 && (rawBid < 1 || rawAsk < 1);
      const exactBid = exactDecimalRoundFromUnits(rawBidUnits - BigInt(bidPts) * 10n, extraScale, digits);
      const exactAsk = exactDecimalRoundFromUnits(rawAskUnits + BigInt(askPts) * 10n, extraScale, digits);

      const bucket = m === 0 ? cat2m0 : subUnitRuleActive ? cat2SubUnit : cat2bActive;
      const label = m === 0 ? 'cat2b(m=0)' : subUnitRuleActive ? 'cat2b(subUnit)' : 'cat2b(d+1,.5tie)';
      recordCase(bucket, totalCases, label, digits, m, rawBid, rawAsk, exactBid, exactAsk);
      totalCases += 1;
    }

    // Category 3: 40,000 cases constructed around exact / -1 ulp / +1 ulp of a half-point tie after move
    const ulpOffsets = [-1, 0, 1] as const;
    for (let i = 0; i < CAT3_COUNT; i += 1) {
      const digits = DIGITS_LIST[i % DIGITS_LIST.length];
      const m = i % 8 === 0 ? 1 : randInt(rng, 1, 500);
      const bidPts = m - Math.floor(m / 2);
      const askPts = m - bidPts;
      const pow = digits < GO_POW10.length ? GO_POW10[digits] : 10 ** digits;
      const point = goDecimalPointSize(digits);
      const bidDelta = bidPts * point;
      const askDelta = askPts * point;

      const target = pickBasePriceTarget(rng, digits);
      let nBid = Math.round(target * pow);
      const minNBid = Math.max(Math.ceil(0.5 * pow), bidPts + 5);
      const maxNBid = Math.floor(150_000 * pow) - m - 25;
      if (nBid < minNBid) nBid = minNBid;
      if (nBid > maxNBid) nBid = maxNBid;
      const nAsk = nBid + m + randInt(rng, 2, 15);

      const bidUlpOffset = ulpOffsets[i % 3];
      const askUlpOffset = ulpOffsets[(i + 1) % 3];

      const bidTieCenter = (nBid + 0.5) / pow;
      const askTieCenter = (nAsk + 0.5) / pow;
      const targetMovedBid = stepUlp(bidTieCenter, bidUlpOffset);
      const targetMovedAsk = stepUlp(askTieCenter, askUlpOffset);

      // Find raw float64 whose moved float64 lands on (or nearest possible to) targetMoved
      let rawBid = targetMovedBid + bidDelta;
      if (rawBid - bidDelta < targetMovedBid) rawBid = stepUlp(rawBid, 1);
      else if (rawBid - bidDelta > targetMovedBid) rawBid = stepUlp(rawBid, -1);

      let rawAsk = targetMovedAsk - askDelta;
      if (rawAsk + askDelta < targetMovedAsk) rawAsk = stepUlp(rawAsk, 1);
      else if (rawAsk + askDelta > targetMovedAsk) rawAsk = stepUlp(rawAsk, -1);

      // Avoid triggering sub-unit observed-digits fallback on digits<=2 so we test pure rounding parity
      if (digits <= 2 && (rawBid < 1 || rawAsk < 1)) {
        rawBid += 1;
        rawAsk += 1;
      }

      const exactBid = hasAtMostDecimals(rawBid, digits + 1)
        ? exactDecimalRoundFromUnits(
            BigInt(Math.round(rawBid * Number(pow10Big(digits + 1)))) - BigInt(bidPts) * 10n,
            digits + 1,
            digits,
          )
        : exactFloatPlusPointsRoundHalfUp(rawBid, -bidPts, digits);
      const exactAsk = hasAtMostDecimals(rawAsk, digits + 1)
        ? exactDecimalRoundFromUnits(
            BigInt(Math.round(rawAsk * Number(pow10Big(digits + 1)))) + BigInt(askPts) * 10n,
            digits + 1,
            digits,
          )
        : exactFloatPlusPointsRoundHalfUp(rawAsk, askPts, digits);

      const ulpTag = `b${bidUlpOffset >= 0 ? `+${bidUlpOffset}` : bidUlpOffset}/a${askUlpOffset >= 0 ? `+${askUlpOffset}` : askUlpOffset}`;
      recordCase(cat3UlpOnly, totalCases, 'cat3(ulp)', digits, m, rawBid, rawAsk, exactBid, exactAsk, ulpTag, cat3RealAccidental);
      ulpCasesConstructed += 1;
      totalCases += 1;
    }

    elapsedMs = Math.round(performance.now() - startMs);

    const summarize = (name: string, b: BucketStats): string[] => {
      const out = [
        `BUCKET ${name}: cases=${b.checkedCases} sides=${b.checkedSides} | `
        + `NEW_vs_ENGINE=${b.termVsEngine} NEW_vs_EXACT=${b.termVsExact} | `
        + `BASE_vs_ENGINE=${b.baseVsEngine} BASE_vs_EXACT=${b.baseVsExact}`,
      ];
      if (b.smallestTermVsEngine.length > 0) {
        out.push(`  smallest NEW vs ENGINE (${b.smallestTermVsEngine.length}):`);
        for (const r of b.smallestTermVsEngine) out.push(`    ${formatRecord(r)}`);
      }
      if (b.smallestTermVsExact.length > 0) {
        out.push(`  smallest NEW vs EXACT (${b.smallestTermVsExact.length}):`);
        for (const r of b.smallestTermVsExact) out.push(`    ${formatRecord(r)}`);
      }
      if (b.smallestBaseVsEngine.length > 0) {
        out.push(`  smallest BASELINE vs ENGINE (${b.smallestBaseVsEngine.length}):`);
        for (const r of b.smallestBaseVsEngine) out.push(`    ${formatRecord(r)}`);
      }
      return out;
    };

    const reportLines: string[] = [
      `ENGINE_PARITY_SUMMARY totalCases=${totalCases} ulpCases=${ulpCasesConstructed} bookTopMismatches=${bookTopMismatches} elapsedMs=${elapsedMs}`,
      ...summarize('cat1_le_digits', cat1),
      ...summarize('cat2a_dplus1_nontie_mgt0', cat2aActive),
      ...summarize('cat2b_dplus1_half_mgt0', cat2bActive),
      ...summarize('cat2_m0_dplus1', cat2m0),
      ...summarize('cat2_subunit_observed', cat2SubUnit),
      ...summarize('cat3_ulp_only', cat3UlpOnly),
      ...summarize('cat3_accidental_real_feed', cat3RealAccidental),
    ];
    console.log(reportLines.join('\n'));
  }, 120_000);

  it('runs >= 200,000 total cases and >= 20,000 ULP-tie cases with depth top matching quote', () => {
    expect(totalCases).toBeGreaterThanOrEqual(200_000);
    expect(ulpCasesConstructed).toBeGreaterThanOrEqual(20_000);
    expect(bookTopMismatches).toBe(0);
    expect(elapsedMs).toBeLessThan(120_000);
  });

  it('matches Go RAM engine on realistic prices with <= symbol digits (m=0..500)', () => {
    expect(cat1.termVsEngine).toBe(0);
  });

  it('matches Go RAM engine market-order path on realistic prices with digits+1 decimals (R1: m=1..500)', () => {
    const samples = [
      ...cat2aActive.smallestTermVsEngine,
      ...cat2bActive.smallestTermVsEngine,
      ...cat3RealAccidental.smallestTermVsEngine,
    ]
      .map(formatRecord)
      .join('\n  ');
    expect(
      cat2aActive.termVsEngine + cat2bActive.termVsEngine + cat3RealAccidental.termVsEngine,
      `Real-feed mismatches vs Go RAM engine:\n  ${samples}`,
    ).toBe(0);
  });

  it('matches Go RAM engine market-order path on sub-unit prices (R2: no observed-digits override)', () => {
    const samples = cat2SubUnit.smallestTermVsEngine.map(formatRecord).join('\n  ');
    expect(
      cat2SubUnit.termVsEngine,
      `Sub-unit mismatches vs Go RAM engine:\n  ${samples}`,
    ).toBe(0);
  });

  it('matches Go RAM engine market-order path on constructed ULP ties (R1, Review B L-2)', () => {
    const samples = cat3UlpOnly.smallestTermVsEngine.map(formatRecord).join('\n  ');
    expect(
      cat3UlpOnly.termVsEngine,
      `Constructed ULP mismatches vs Go RAM engine:\n  ${samples}`,
    ).toBe(0);
  });

  it('leaves m=0 unshaped quotes untouched (R3(b), Review B L-2)', () => {
    expect(cat2m0UntouchedMismatches).toBe(0);
  });

  it('market-order unshaped emulation matches unshaped tick==point rows in spreadMarkupEngineGoldenMarket.jsonl bit-for-bit', () => {
    const fixturePath = path.resolve(__dirname, '__fixtures__/spreadMarkupEngineGoldenMarket.jsonl');
    const lines = fs.readFileSync(fixturePath, 'utf8').trim().split(/\r?\n/);
    let checked = 0;
    const mismatches: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const row = JSON.parse(lines[i]) as {
        g: string; d: number; rb: string; ra: string; m: number; S: number; SB: number; D: number; B: number; mBid: string; mAsk: string;
      };
      if (row.g !== 'eq_point' && row.g !== 'd1_nontie' && row.g !== 'd1_half') continue;
      checked += 1;
      const got = emulateGoRamEngineUnshaped(Number(row.rb), Number(row.ra), row.d, row.m);
      const mb = Number(row.mBid);
      const ma = Number(row.mAsk);
      if (!Object.is(got.bid, mb) || !Object.is(got.ask, ma)) {
        if (mismatches.length < 10) {
          mismatches.push(`line ${i + 1}: got=${got.bid}/${got.ask} vs market=${mb}/${ma}`);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2_500);
    expect(mismatches).toEqual([]);
  });
});
