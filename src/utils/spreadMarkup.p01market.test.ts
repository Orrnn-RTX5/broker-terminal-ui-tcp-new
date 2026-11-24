/**
 * P01 round 9, step 3 (gate test): compares the terminal's shown quote and top-of-book
 * directly against the Go RAM engine's MARKET-ORDER fill path (`OnLiveTick` Layer-1 round ->
 * `ReadLiveQuoteFast` -> `shapeAccountBaseQuote` -> `roundPrice`, `ram_mt5_views_sync.go:1209-1213`
 * & `ram_mt5_engine.go:3439-3454`).
 *
 * Acceptance rules (owner rulings R1, R2, R3(c)):
 *   - Every row where mBid > 0 and mAsk > 0 must match mBid and mAsk bit-for-bit (`Object.is`).
 *   - Sub-unit rows (digits <= 2, price < 1) are NOT excused (R2).
 *   - R3(c) non-positive rows are excused ONLY when mBid <= 0 or mAsk <= 0 for that side,
 *     and ONLY if the terminal keeps the exact documented positive base or raw price (never <= 0).
 *   - Depth top must equal the shown quote (`Object.is`) on every row.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  resolveSpreadMarkupEntry,
} from './spreadMarkup';

interface MarketGoldenRow {
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
  tBid: string;
  tAsk: string;
}

type FailReason = 'R1_trigger_path' | 'R2_observed_digits' | 'OTHER';

interface FailSample {
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
  tBid: number;
  tAsk: number;
  reason: FailReason;
}

interface GroupStats {
  total: number;
  exact: number;
  checkedR3c: number;
  failed: number;
  byReason: Record<FailReason, number>;
  depthTopMismatch: number;
  smallestFailures: FailSample[];
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
  const out = roundedInt / pow;
  return out === 0 ? 0 : out;
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

const countObservedDecimals = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  for (let d = 0; d <= 10; d += 1) {
    const scaled = value * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return d;
  }
  return 10;
};

const isR2ObservedDigitsActive = (d: number, rb: number, ra: number): boolean => {
  if (d > 2 || !(rb < 1 || ra < 1)) return false;
  const obs = Math.min(6, Math.max(countObservedDecimals(rb), countObservedDecimals(ra)));
  return obs > d;
};

const expectedR3cChecked = (
  rb: number,
  ra: number,
  d: number,
  fixedS: number,
  balanceSB: number,
  mBid: number,
  mAsk: number,
): { bid: number; ask: number } => {
  const stored = goLayer1Stored(rb, ra, d, fixedS, balanceSB);
  const candBid = mBid > 0 ? mBid : (stored.bid > 0 ? stored.bid : goKeptRaw(rb, d));
  const candAsk = mAsk > 0 ? mAsk : (stored.ask > 0 ? stored.ask : goKeptRaw(ra, d));
  if (candBid > candAsk) {
    return { bid: goKeptRaw(rb, d), ask: goKeptRaw(ra, d) };
  }
  return { bid: candBid, ask: candAsk };
};

const makeGroupStats = (): GroupStats => ({
  total: 0,
  exact: 0,
  checkedR3c: 0,
  failed: 0,
  byReason: { R1_trigger_path: 0, R2_observed_digits: 0, OTHER: 0 },
  depthTopMismatch: 0,
  smallestFailures: [],
});

const compareSample = (a: FailSample, b: FailSample): number => {
  const pa = Math.min(a.rb, a.ra);
  const pb = Math.min(b.rb, b.ra);
  if (pa !== pb) return pa - pb;
  if (a.d !== b.d) return a.d - b.d;
  if (a.m !== b.m) return a.m - b.m;
  return a.line - b.line;
};

const insertSmallest3 = (list: FailSample[], sample: FailSample): void => {
  if (list.length < 3) {
    list.push(sample);
    list.sort(compareSample);
    return;
  }
  if (compareSample(sample, list[2]) < 0) {
    list[2] = sample;
    list.sort(compareSample);
  }
};

const formatSample = (s: FailSample): string =>
  `line=${s.line}${s.id ? `(${s.id})` : ''} [${s.reason}] d=${s.d} t=${s.t} rb=${s.rb} ra=${s.ra} m=${s.m} `
  + `S=${s.S} SB=${s.SB} D=${s.D} B=${s.B} | term=${s.termBid}/${s.termAsk} market=${s.mBid}/${s.mAsk} trigger=${s.tBid}/${s.tAsk}`;

describe('P01 round 9 gate: terminal vs Go RAM engine market-order fill path', () => {
  const fixturePath = path.resolve(__dirname, '__fixtures__/spreadMarkupEngineGoldenMarket.jsonl');
  const groups = new Map<string, GroupStats>();
  let totalRows = 0;
  let fixtureBytes = 0;
  let totalFailed = 0;
  let totalDepthTopMismatches = 0;
  let totalR3cChecked = 0;

  beforeAll(() => {
    const rawText = fs.readFileSync(fixturePath, 'utf8');
    fixtureBytes = Buffer.byteLength(rawText, 'utf8');
    const lines = rawText.trim().split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
      const row = JSON.parse(lines[i]) as MarketGoldenRow;
      totalRows += 1;

      let st = groups.get(row.g);
      if (!st) {
        st = makeGroupStats();
        groups.set(row.g, st);
      }
      st.total += 1;

      const t = Number(row.t);
      const rb = Number(row.rb);
      const ra = Number(row.ra);
      const mBid = Number(row.mBid);
      const mAsk = Number(row.mAsk);
      const tBid = Number(row.tBid);
      const tAsk = Number(row.tAsk);

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
          continue;
        }
      } else {
        // R3(c) check: only when engine emits <= 0 for a side, and terminal must match documented positive base/raw.
        const exp = expectedR3cChecked(rb, ra, row.d, row.S, row.SB, mBid, mAsk);
        if (exp.bid > 0 && exp.ask > 0 && Object.is(shown.bid, exp.bid) && Object.is(shown.ask, exp.ask)) {
          st.checkedR3c += 1;
          totalR3cChecked += 1;
          continue;
        }
      }

      let reason: FailReason = 'OTHER';
      if (isR2ObservedDigitsActive(row.d, rb, ra)) {
        reason = 'R2_observed_digits';
      } else if (
        (tBid > 0 && tAsk > 0 && Object.is(shown.bid, tBid) && Object.is(shown.ask, tAsk))
        || (!(tBid > 0) || !(tAsk > 0))
      ) {
        // Trigger path differs from market path (either exact tBid/tAsk match or trigger-path R3(c) non-positive match).
        const r3cTrig = expectedR3cChecked(rb, ra, row.d, row.S, row.SB, tBid, tAsk);
        if (
          (tBid > 0 && tAsk > 0 && Object.is(shown.bid, tBid) && Object.is(shown.ask, tAsk))
          || (r3cTrig.bid > 0 && r3cTrig.ask > 0 && Object.is(shown.bid, r3cTrig.bid) && Object.is(shown.ask, r3cTrig.ask))
        ) {
          reason = 'R1_trigger_path';
        }
      }

      st.failed += 1;
      st.byReason[reason] += 1;
      totalFailed += 1;
      insertSmallest3(st.smallestFailures, {
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
        tBid,
        tAsk,
        reason,
      });
    }

    const out: string[] = [
      `MARKET_GATE_SUMMARY rows=${totalRows} bytes=${fixtureBytes} r3cChecked=${totalR3cChecked} failed=${totalFailed} depthTopMismatches=${totalDepthTopMismatches}`,
    ];
    for (const [name, st] of groups.entries()) {
      out.push(
        `GROUP ${name}: total=${st.total} exact=${st.exact} r3cChecked=${st.checkedR3c} failed=${st.failed} `
        + `(R1=${st.byReason.R1_trigger_path}, R2=${st.byReason.R2_observed_digits}, OTHER=${st.byReason.OTHER}) depthTopMismatch=${st.depthTopMismatch}`,
      );
      for (const s of st.smallestFailures) {
        out.push(`  fail: ${formatSample(s)}`);
      }
    }
    console.log(out.join('\n'));
  });

  it('fixture covers >= 6,000 rows (< 1.5 MB) with required group minimums', () => {
    expect(totalRows).toBeGreaterThanOrEqual(6_000);
    expect(fixtureBytes).toBeLessThan(1_500_000);
    expect(groups.get('fixed_odd_spread')?.total ?? 0).toBeGreaterThanOrEqual(800);
    expect(groups.get('subunit')?.total ?? 0).toBeGreaterThanOrEqual(400);
    expect(groups.get('nonpos')?.total ?? 0).toBeGreaterThanOrEqual(100);
  });

  it('terminal shown bid/ask match Go market-order path bit-for-bit (only verified R3(c) non-positive side fallback allowed)', () => {
    const details = [...groups.values()]
      .flatMap((g) => g.smallestFailures.map(formatSample))
      .join('\n  ');
    expect(totalFailed, `Market-path mismatches (${totalFailed}):\n  ${details}`).toBe(0);
  });

  it('depth top equals shown quote on every fixture row', () => {
    expect(totalDepthTopMismatches).toBe(0);
  });
});
