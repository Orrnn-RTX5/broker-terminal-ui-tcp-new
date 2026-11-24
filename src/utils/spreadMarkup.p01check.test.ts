/**
 * P01 round 9, step 2 (independent tester): compares the terminal against a second,
 * independent 3,000-row Go engine ground-truth fixture generated via OnLiveTick ->
 * ReadLiveQuoteFast -> shapeAccountBaseQuote -> roundPrice (plus ExecuteBinaryOrder
 * cross-check).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  resolveSpreadMarkupEntry,
} from './spreadMarkup';

interface GoldenCheckRow {
  g: string;
  id?: string;
  d: number;
  t: string;
  rb: string;
  ra: string;
  m: number;
  S: number;
  SB: number;
  D: number;
  B: number;
  mBid: string;
  mAsk: string;
  storedBid: string;
  storedAsk: string;
}

interface MismatchSample {
  line: number;
  g: string;
  id?: string;
  d: number;
  t: string;
  rb: number;
  ra: number;
  m: number;
  S: number;
  SB: number;
  D: number;
  B: number;
  termBid: number;
  termAsk: number;
  mBid: number;
  mAsk: number;
}

interface GroupStats {
  total: number;
  exact: number;
  r3cChecked: number;
  failed: number;
  depthTopMismatch: number;
}

const GO_POW10: readonly number[] = [
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9,
  1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18,
];

const goDecimalPointSize = (digits: number): number => {
  const d = digits < 0 ? 5 : digits;
  return d < GO_POW10.length ? 1 / GO_POW10[d] : 10 ** -d;
};

const goRoundPrice = (price: number, digits: number): number => {
  const d = digits < 0 ? 5 : digits;
  const pow = d < GO_POW10.length ? GO_POW10[d] : 10 ** d;
  const scaled = price * pow;
  const whole = Math.trunc(scaled);
  const frac = scaled - whole;
  const roundedInt = frac >= 0.5 ? whole + 1 : frac <= -0.5 ? whole - 1 : whole;
  // Go's math.Round keeps the sign of zero (math.Round(-0.3) is -0), so a stored -0 of the engine is reproduced as -0 here.
  return roundedInt / pow;
};

const goKeptRaw = (raw: number, digits: number): number => {
  const r = goRoundPrice(raw, digits);
  return r > 0 ? r : raw;
};

const goLayer1Stored = (
  rawBid: number,
  rawAsk: number,
  digits: number,
  fixedS: number,
  balanceSB: number,
): { bid: number; ask: number } => {
  let baseBid = rawBid;
  let baseAsk = rawAsk;
  if (fixedS > 0 || balanceSB !== 0) {
    const point = goDecimalPointSize(digits);
    if (fixedS > 0) {
      const fixedSpread = fixedS * point;
      const spread = rawAsk - rawBid;
      if (Math.abs(spread - fixedSpread) <= point * 1e-6) {
        baseBid = rawBid + balanceSB * point;
      } else {
        const mid = (rawAsk + rawBid) / 2;
        const offset = (Math.trunc(fixedS / 2) - balanceSB) * point;
        baseBid = mid - offset;
      }
      baseAsk = baseBid + fixedSpread;
    } else {
      const bal = balanceSB * point;
      baseBid = rawBid + bal;
      baseAsk = rawAsk + bal;
    }
    if (baseBid > baseAsk) {
      baseBid = rawBid;
      baseAsk = rawAsk;
    }
  }
  return {
    bid: digits >= 0 ? goRoundPrice(baseBid, digits) : baseBid,
    ask: digits >= 0 ? goRoundPrice(baseAsk, digits) : baseAsk,
  };
};

// The R3(c) rule of spreadMarkup.p01market.test.ts, with the ENGINE's stored pair (storedBid/storedAsk, the value the tick
// stored) in place of a JS copy of Layer 1. goLayer1Stored is checked against that pair on every row, separately.
const expectedR3cChecked = (
  rb: number,
  ra: number,
  d: number,
  engineStoredBid: number,
  engineStoredAsk: number,
  mBid: number,
  mAsk: number,
): { bid: number; ask: number } => {
  const candBid = mBid > 0 ? mBid : (engineStoredBid > 0 ? engineStoredBid : goKeptRaw(rb, d));
  const candAsk = mAsk > 0 ? mAsk : (engineStoredAsk > 0 ? engineStoredAsk : goKeptRaw(ra, d));
  if (candBid > candAsk) {
    return { bid: goKeptRaw(rb, d), ask: goKeptRaw(ra, d) };
  }
  return { bid: candBid, ask: candAsk };
};

const compareMismatch = (a: MismatchSample, b: MismatchSample): number => {
  const pa = Math.min(a.rb, a.ra);
  const pb = Math.min(b.rb, b.ra);
  if (pa !== pb) return pa - pb;
  if (a.d !== b.d) return a.d - b.d;
  if (a.m !== b.m) return a.m - b.m;
  return a.line - b.line;
};

const formatMismatch = (s: MismatchSample): string =>
  `line=${s.line}${s.id ? `(${s.id})` : ''} g=${s.g} d=${s.d} t=${s.t} rb=${s.rb} ra=${s.ra} m=${s.m} `
  + `S=${s.S} SB=${s.SB} D=${s.D} B=${s.B} | term=${s.termBid}/${s.termAsk} engine=${s.mBid}/${s.mAsk}`;

describe('P01 round 9 step 2: independent 3,000-row Go engine ground truth check', () => {
  const fixturePath = path.resolve(__dirname, '__fixtures__/spreadMarkupEngineGoldenCheck.jsonl');
  const groups = new Map<string, GroupStats>();
  const smallestMismatches: MismatchSample[] = [];
  let totalRows = 0;
  let fixtureBytes = 0;
  let totalExact = 0;
  let totalR3cChecked = 0;
  let totalFailed = 0;
  let totalDepthTopMismatches = 0;
  let storedMirrorMismatches = 0;
  let step3Row: GoldenCheckRow | undefined;

  beforeAll(() => {
    const rawText = fs.readFileSync(fixturePath, 'utf8');
    fixtureBytes = Buffer.byteLength(rawText, 'utf8');
    const lines = rawText.trim().split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
      const row = JSON.parse(lines[i]) as GoldenCheckRow;
      totalRows += 1;
      if (row.id === 'step3_parity_220') step3Row = row;

      let st = groups.get(row.g);
      if (!st) {
        st = { total: 0, exact: 0, r3cChecked: 0, failed: 0, depthTopMismatch: 0 };
        groups.set(row.g, st);
      }
      st.total += 1;

      const t = Number(row.t);
      const rb = Number(row.rb);
      const ra = Number(row.ra);
      const mBid = Number(row.mBid);
      const mAsk = Number(row.mAsk);
      const engineStoredBid = Number(row.storedBid);
      const engineStoredAsk = Number(row.storedAsk);
      // The JS Layer 1 copy must reproduce the engine's stored pair on every row; a row that differs is counted here.
      const mirror = goLayer1Stored(rb, ra, row.d, row.S, row.SB);
      if (!Object.is(mirror.bid, engineStoredBid) || !Object.is(mirror.ask, engineStoredAsk)) {
        storedMirrorMismatches += 1;
      }

      const entry = resolveSpreadMarkupEntry({
        spreadMarkup: row.m,
        tickSize: t,
        digits: row.d,
        fixedSpreadPoints: row.S,
        spreadBalancePoints: row.SB,
        spreadDiffPoints: row.D,
        spreadDiffBalancePoints: row.B,
      });

      const shown = applySpreadMarkupToQuote({ bid: rb, ask: ra }, entry);
      const bids = applySpreadMarkupToBookLevels([{ price: rb }], 'bid', entry, [{ price: ra }]);
      const asks = applySpreadMarkupToBookLevels([{ price: ra }], 'ask', entry, [{ price: rb }]);

      if (!Object.is(bids[0]?.price, shown.bid) || !Object.is(asks[0]?.price, shown.ask)) {
        st.depthTopMismatch += 1;
        totalDepthTopMismatches += 1;
      }

      if (mBid > 0 && mAsk > 0) {
        if (Object.is(shown.bid, mBid) && Object.is(shown.ask, mAsk)) {
          st.exact += 1;
          totalExact += 1;
          continue;
        }
      } else {
        const exp = expectedR3cChecked(rb, ra, row.d, engineStoredBid, engineStoredAsk, mBid, mAsk);
        if (exp.bid > 0 && exp.ask > 0 && Object.is(shown.bid, exp.bid) && Object.is(shown.ask, exp.ask)) {
          st.r3cChecked += 1;
          totalR3cChecked += 1;
          continue;
        }
      }

      st.failed += 1;
      totalFailed += 1;
      smallestMismatches.push({
        line: i + 1,
        g: row.g,
        id: row.id,
        d: row.d,
        t: row.t,
        rb,
        ra,
        m: row.m,
        S: row.S,
        SB: row.SB,
        D: row.D,
        B: row.B,
        termBid: shown.bid as number,
        termAsk: shown.ask as number,
        mBid,
        mAsk,
      });
      smallestMismatches.sort(compareMismatch);
      if (smallestMismatches.length > 3) smallestMismatches.length = 3;
    }

    const out: string[] = [
      `CHECK_SUMMARY rows=${totalRows} bytes=${fixtureBytes} exact=${totalExact} r3cChecked=${totalR3cChecked} failed=${totalFailed} depthTopMismatches=${totalDepthTopMismatches} storedMirrorMismatches=${storedMirrorMismatches}`,
    ];
    for (const [name, st] of groups.entries()) {
      out.push(
        `GROUP ${name}: total=${st.total} exact=${st.exact} r3cChecked=${st.r3cChecked} failed=${st.failed} depthTopMismatch=${st.depthTopMismatch}`,
      );
    }
    for (const m of smallestMismatches) {
      out.push(`  mismatch: ${formatMismatch(m)}`);
    }
    console.log(out.join('\n'));
  });

  it('fixture has 3,000 rows and is under 1 MB', () => {
    expect(totalRows).toBe(3000);
    expect(fixtureBytes).toBeLessThan(1_000_000);
  });

  it('Step 3 parity anchor (d=2, t=0.01, m=5, raw 0.12345/0.12355) yields 0.09 / 0.14 in the Go engine', () => {
    expect(step3Row).toBeDefined();
    expect(Number(step3Row?.mBid)).toBe(0.09);
    expect(Number(step3Row?.mAsk)).toBe(0.14);
  });

  it('matches the independent Go engine table bit-for-bit (Object.is) with R3(c) excuse checked', () => {
    expect(totalFailed, smallestMismatches.map(formatMismatch).join('\n')).toBe(0);
  });

  it('depth top equals shown quote (Object.is) on all 3,000 rows', () => {
    expect(totalDepthTopMismatches).toBe(0);
  });

  it('the JS Layer 1 copy equals the engine stored pair (Object.is) on all 3,000 rows', () => {
    expect(storedMirrorMismatches).toBe(0);
  });
});
