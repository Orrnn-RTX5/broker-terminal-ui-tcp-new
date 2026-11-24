/**
 * P01 round 8 -> round 9 update: compares the terminal against `spreadMarkupEngineGolden.jsonl`,
 * which pins the Go RAM engine's TRIGGER path (`(*RAMMT5Engine).shapeAccountQuoteP`).
 *
 * RETIREMENT NOTE (R1): `spreadMarkupEngineGolden.jsonl` is NO LONGER the parity gate. It pins the engine's TRIGGER path
 * (single rounding; used for SL/TP and pending-order triggers). The terminal deliberately follows the MARKET-ORDER fill path
 * (owner ruling R1: `spreadMarkup.p01market.test.ts` + `spreadMarkupEngineGoldenMarket.jsonl`). A row is compared here only
 * when the JS mirror of the market path (`goMarketQuote`) equals the trigger value. Rows where the two paths differ are
 * SKIPPED here: 268 rows, pinned by the last test in this file. They are NOT covered by the market gate, except the few rows
 * the two fixtures share. Those skipped rows are exactly where a trigger level (SL/TP or pending-order) can differ from the
 * shown price by one point. That gap is not covered by any gate, apart from those shared rows. This file is not a D1 gate.
 *
 * Acceptance rules (tightened per Review A-L3 and Review B-M-3/B-L-1):
 *   - Sub-unit rows (`digits <= 2, price < 1`) are NOT excused (R2).
 *   - R3(c) non-positive rows are excused ONLY per-side when `eb <= 0` or `ea <= 0`, and ONLY
 *     after verifying the terminal keeps the exact documented positive base or raw price.
 *   - R3(b) inactive rows are excused ONLY when all 5 inputs (`m, S, SB, D, B`) are 0 AND the
 *     terminal leaves both raw sides untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applySpreadMarkupToBookLevels,
  applySpreadMarkupToQuote,
  resolveSpreadMarkupEntry,
} from './spreadMarkup';

interface GoldenRow {
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
  eb: string;
  ea: string;
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
  engBid: number;
  engAsk: number;
}

interface GroupStats {
  total: number;
  deferredToMarketPath: number;
  exactMatch: number;
  checkedR3c: number;
  checkedR3b: number;
  unexpected: number;
  depthTopMismatch: number;
  smallestUnexpected: MismatchSample[];
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

const goSdkSpreadDiffPoints = (diff: number, balance: number): { bidPoints: number; askPoints: number } => {
  const bidPoints = diff - Math.trunc(diff / 2) + (diff < 0 ? balance : -balance);
  return { bidPoints, askPoints: diff - bidPoints };
};

const goLayer1 = (
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
  return { bid: baseBid, ask: baseAsk };
};

const goMarketQuote = (row: GoldenRow, rb: number, ra: number, t: number): { bid: number; ask: number; storedBid: number; storedAsk: number } => {
  const point = goDecimalPointSize(row.d);
  const l1 = goLayer1(rb, ra, row.d, row.S, row.SB);
  const storedBid = row.d >= 0 ? goRoundPrice(l1.bid, row.d) : l1.bid;
  const storedAsk = row.d >= 0 ? goRoundPrice(l1.ask, row.d) : l1.ask;

  const m = row.m > 0 ? row.m : 0;
  let bidDelta = 0;
  let askDelta = 0;
  if (t === point && row.D >= 0) {
    const total = m + row.D;
    if (total !== 0 || row.B !== 0) {
      const { bidPoints, askPoints } = goSdkSpreadDiffPoints(total, row.B);
      bidDelta = bidPoints * point;
      askDelta = askPoints * point;
    }
  } else {
    if (t > 0) {
      const askPts = Math.floor(m / 2);
      bidDelta = (m - askPts) * t;
      askDelta = askPts * t;
    }
    const { bidPoints, askPoints } = goSdkSpreadDiffPoints(row.D, row.B);
    bidDelta += bidPoints * point;
    askDelta += askPoints * point;
  }

  let outBid = storedBid - bidDelta;
  let outAsk = storedAsk + askDelta;
  if (!(outBid > 0)) outBid = storedBid;
  if (!(outAsk > 0) || outBid > outAsk) {
    outBid = storedBid;
    outAsk = storedAsk;
  }
  return {
    bid: goRoundPrice(outBid, row.d),
    ask: goRoundPrice(outAsk, row.d),
    storedBid,
    storedAsk,
  };
};

const expectedR3cChecked = (
  rb: number,
  ra: number,
  d: number,
  storedBid: number,
  storedAsk: number,
  eb: number,
  ea: number,
): { bid: number; ask: number } => {
  const candBid = eb > 0 ? eb : (storedBid > 0 ? storedBid : goKeptRaw(rb, d));
  const candAsk = ea > 0 ? ea : (storedAsk > 0 ? storedAsk : goKeptRaw(ra, d));
  if (candBid > candAsk) {
    return { bid: goKeptRaw(rb, d), ask: goKeptRaw(ra, d) };
  }
  return { bid: candBid, ask: candAsk };
};

const makeGroupStats = (): GroupStats => ({
  total: 0,
  deferredToMarketPath: 0,
  exactMatch: 0,
  checkedR3c: 0,
  checkedR3b: 0,
  unexpected: 0,
  depthTopMismatch: 0,
  smallestUnexpected: [],
});

const compareSample = (a: MismatchSample, b: MismatchSample): number => {
  const pa = Math.min(a.rb, a.ra);
  const pb = Math.min(b.rb, b.ra);
  if (pa !== pb) return pa - pb;
  if (a.d !== b.d) return a.d - b.d;
  if (a.m !== b.m) return a.m - b.m;
  return a.line - b.line;
};

const insertSmallest3 = (list: MismatchSample[], sample: MismatchSample): void => {
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

const formatSample = (s: MismatchSample): string =>
  `line=${s.line}${s.id ? `(${s.id})` : ''} d=${s.d} t=${s.t} rb=${s.rb} ra=${s.ra} m=${s.m} `
  + `S=${s.S} SB=${s.SB} D=${s.D} B=${s.B} | term=${s.termBid}/${s.termAsk} vs eng=${s.engBid}/${s.engAsk}`;

describe('P01 round 8 trigger-path fixture (retired gate; tightened R2/R3 checks)', () => {
  const fixturePath = path.resolve(__dirname, '__fixtures__/spreadMarkupEngineGolden.jsonl');
  const groups = new Map<string, GroupStats>();
  let totalRows = 0;
  let fixtureBytes = 0;
  let totalUnexpected = 0;
  let totalDepthTopMismatches = 0;

  beforeAll(() => {
    const rawText = fs.readFileSync(fixturePath, 'utf8');
    fixtureBytes = Buffer.byteLength(rawText, 'utf8');
    const lines = rawText.trim().split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
      const row = JSON.parse(lines[i]) as GoldenRow;
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
      const eb = Number(row.eb);
      const ea = Number(row.ea);

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

      const mq = goMarketQuote(row, rb, ra, t);
      if (!Object.is(mq.bid, eb) || !Object.is(mq.ask, ea)) {
        // Trigger path diverges from the market-order path on this row (R1): skipped, see the header.
        st.deferredToMarketPath += 1;
        continue;
      }

      if (eb > 0 && ea > 0) {
        if (Object.is(shown.bid, eb) && Object.is(shown.ask, ea)) {
          st.exactMatch += 1;
          continue;
        }
      } else {
        const r3c = expectedR3cChecked(rb, ra, row.d, mq.storedBid, mq.storedAsk, eb, ea);
        if (r3c.bid > 0 && r3c.ask > 0 && Object.is(shown.bid, r3c.bid) && Object.is(shown.ask, r3c.ask)) {
          st.checkedR3c += 1;
          continue;
        }
      }

      const trulyInactive = row.m === 0 && row.S === 0 && row.SB === 0 && row.D === 0 && row.B === 0;
      if (trulyInactive && entry === null && Object.is(shown.bid, rb) && Object.is(shown.ask, ra)) {
        st.checkedR3b += 1;
        continue;
      }

      st.unexpected += 1;
      totalUnexpected += 1;
      insertSmallest3(st.smallestUnexpected, {
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
        engBid: eb,
        engAsk: ea,
      });
    }

    const summaryLines: string[] = [
      `GOLDEN_PARITY_SUMMARY rows=${totalRows} bytes=${fixtureBytes} unexpected=${totalUnexpected} depthTopMismatches=${totalDepthTopMismatches}`,
    ];
    for (const [name, st] of groups.entries()) {
      summaryLines.push(
        `GROUP ${name}: total=${st.total} deferredR1=${st.deferredToMarketPath} exact=${st.exactMatch} `
        + `r3cChecked=${st.checkedR3c} r3bChecked=${st.checkedR3b} unexpected=${st.unexpected} depthTopMismatch=${st.depthTopMismatch}`,
      );
      if (st.smallestUnexpected.length > 0) {
        summaryLines.push(`  smallest unexpected (${st.smallestUnexpected.length}):`);
        for (const s of st.smallestUnexpected) summaryLines.push(`    ${formatSample(s)}`);
      }
    }
    console.log(summaryLines.join('\n'));
  });

  it('fixture has at least 6,000 rows and is under 1 MB', () => {
    expect(totalRows).toBeGreaterThanOrEqual(6_000);
    expect(fixtureBytes).toBeLessThan(1_000_000);
  });

  it('matches all trigger-path rows that agree with market-order path (no sub-unit excuse, checked R3(b)/(c))', () => {
    const details = [...groups.values()]
      .flatMap((g) => g.smallestUnexpected.map(formatSample))
      .join('\n  ');
    expect(totalUnexpected, `Unexpected mismatches:\n  ${details}`).toBe(0);
  });

  it('depth top equals shown quote on every fixture row', () => {
    expect(totalDepthTopMismatches).toBe(0);
  });

  it('skips exactly 268 rows, the pinned count where the trigger path and the market path differ', () => {
    const skipped = [...groups.values()].reduce((sum, st) => sum + st.deferredToMarketPath, 0);
    expect(skipped, 'rows skipped because the trigger value differs from the market-path value').toBe(268);
  });
});
