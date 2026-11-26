// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { readSpecificationSectorIndustry } from '../../utils/symbolSectorIndustry';
import { buildSymbolSpecificationSnapshot } from './SymbolSpecificationDialog';

const NESTED_KEYS = [
  'brokerSpecification',
  'instrument',
  'specification',
  'spec',
  'contract',
  'trading_conditions',
  'tradingConditions',
  'volume',
  'costs',
  'metadata',
  'details',
] as const;

const SECTOR_EXACT_KEYS = ['sector', 'sector_name', 'sectorName'] as const;
const INDUSTRY_EXACT_KEYS = ['industry', 'industry_name', 'industryName'] as const;

const SECTOR_NORMALIZED_KEYS = [
  'Sector',
  'SECTOR',
  'SYMBOL_SECTOR',
  'symbol-sector',
  'symbol_sector_name',
  'SYMBOL_SECTORNAME',
  '  sector  ',
  'symbol_sector__name',
] as const;

const INDUSTRY_NORMALIZED_KEYS = [
  'Industry',
  'INDUSTRY',
  'SYMBOL_INDUSTRY',
  'symbol-industry',
  'symbol_industry_name',
  'SYMBOL_INDUSTRYNAME',
  '  industry  ',
  'symbol_industry__name',
] as const;

const DECOY_KEYS = ['category', 'asset_class', 'type', 'symbol', 'sector_id', 'industry_code'] as const;

const VALUE_POOL: ReadonlyArray<() => unknown> = [
  () => 'Technology',
  () => 'Energy',
  () => 'Semiconductors',
  () => 'Metals',
  () => 'Health Care',
  () => '  Finance  ',
  () => '\tUtilities\n',
  () => '',
  () => '   ',
  () => '\t\n',
  () => undefined,
  () => null,
  () => 0,
  () => 6,
  () => Number.NaN,
  () => true,
  () => false,
  () => ({ label: 'Obj' }),
  () => ['ArrayVal'],
  () => () => 'fn',
];

const createMulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T,>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

const populateRecord = (rng: () => number, target: Record<string, unknown>, id: number) => {
  target.symbol = `SYM${id}`;

  const allCandidateKeys = [
    ...SECTOR_EXACT_KEYS,
    ...INDUSTRY_EXACT_KEYS,
    ...SECTOR_NORMALIZED_KEYS,
    ...INDUSTRY_NORMALIZED_KEYS,
    ...DECOY_KEYS,
  ];

  const keyCount = Math.floor(rng() * 6);
  for (let i = 0; i < keyCount; i += 1) {
    const key = pick(rng, allCandidateKeys);
    target[key] = pick(rng, VALUE_POOL)();
  }
};

const generateFixedSeedCases = (count: number): unknown[] => {
  const rng = createMulberry32(0x20a05eed);
  const cases: unknown[] = [];

  // Hand-crafted boundary / conflict cases first
  const sharedChild = { sector: 'SharedEnergy', industry: 'SharedOil' };
  const circular: Record<string, unknown> = { symbol: 'CIRC', sector: 'CircularTop' };
  circular.brokerSpecification = circular;

  const deep4: Record<string, unknown> = {
    symbol: 'DEEP4',
    sector: 'TopLevel',
    brokerSpecification: {
      instrument: {
        specification: {
          // depth 3 -> visited when parent depth is 2 (< 3)
          sector: 'Depth3Wins',
          details: {
            // depth 4 -> beyond depth < 3 cutoff
            sector: 'Depth4Ignored',
            industry: 'Depth4IndustryIgnored',
          },
        },
      },
    },
  };

  cases.push(
    { symbol: 'C1', sector: '', sector_name: 'Technology', industry: '   ', industry_name: 'Software' },
    { symbol: 'C2', sector: 6, sector_name: 'Technology', industry: '', industryName: 'Chips' },
    { symbol: 'C3', SYMBOL_SECTOR: 'NormalizedSec', sector: '', brokerSpecification: { sector: 'NestedSec' } },
    { symbol: 'C4', brokerSpecification: sharedChild, instrument: sharedChild, sector: 'Outer' },
    circular,
    deep4,
  );

  while (cases.length < count) {
    const root: Record<string, unknown> = {};
    populateRecord(rng, root, cases.length);

    // Build up to depth 4 nested containers
    let cursor: Record<string, unknown> = root;
    const depth = Math.floor(rng() * 5); // 0..4
    for (let d = 0; d < depth; d += 1) {
      if (rng() < 0.12) {
        // Non-object nested value to confirm asRecord ignores primitives/arrays
        const nestedKey = pick(rng, NESTED_KEYS);
        cursor[nestedKey] = pick(rng, [null, 'NotARecord', 42, ['arr']]);
        break;
      }
      const nestedKey = pick(rng, NESTED_KEYS);
      const child: Record<string, unknown> = {};
      populateRecord(rng, child, cases.length * 10 + d);
      cursor[nestedKey] = child;

      // Occasionally add a sibling nested container at depth 0
      if (d === 0 && rng() < 0.35) {
        const siblingKey = pick(rng, NESTED_KEYS);
        if (siblingKey !== nestedKey) {
          const sibling: Record<string, unknown> = {};
          populateRecord(rng, sibling, cases.length * 10 + 9);
          cursor[siblingKey] = sibling;
        }
      }
      cursor = child;
    }

    cases.push(root);
  }

  return cases;
};

describe('SymbolSpecificationDialog pure move equivalence (P20A tester)', () => {
  it('produces an identical snapshot sector/industry digest across 5,500 fixed-seed objects and matches exported reader', () => {
    const cases = generateFixedSeedCases(5500);
    expect(cases.length).toBeGreaterThanOrEqual(5000);

    const hash = createHash('sha256');
    let nonNullSector = 0;
    let nonNullIndustry = 0;

    for (const obj of cases) {
      const snap = buildSymbolSpecificationSnapshot(obj);
      if (snap.sector !== null) nonNullSector += 1;
      if (snap.industry !== null) nonNullIndustry += 1;
      hash.update(`${JSON.stringify([snap.sector, snap.industry])}\n`);

      const got = readSpecificationSectorIndustry(obj);
      if (got.sector !== snap.sector || got.industry !== snap.industry) {
        expect(got).toEqual({ sector: snap.sector, industry: snap.industry });
      }
    }

    const digest = hash.digest('hex');
    expect(nonNullSector).toBeGreaterThan(1000);
    expect(nonNullIndustry).toBeGreaterThan(1000);

    // The expected digest is the P20A_STEP2_DIGEST that the independent tester recorded in P20A-test.md (step 2). It was
    // identical in tui-base (origin/main f7b09ad, untouched) and in tui-work. It may only be regenerated from an untouched
    // release tree, never from a tree that carries the P20A change, and a new value must name the tree it came from.
    expect({
      count: cases.length,
      sha256: digest,
      nonNullSector,
      nonNullIndustry,
    }).toEqual({
      count: 5500,
      sha256: '236292da4ab3e76800c3c5d4cda6425eb6309e6f7c2b5f349e43e9c3964d3e8d',
      nonNullSector: 1766,
      nonNullIndustry: 1792,
    });
    // The exported reader must exist in this tree. The base tree has none, so the tester recorded false there.
    expect(typeof readSpecificationSectorIndustry).toBe('function');
  }, 60_000);

  it('never throws on primitives, arrays, null-prototype objects, symbols, functions, or circular graphs', () => {
    const circular: Record<string, unknown> = { sector: 'CircSector' };
    circular.instrument = circular;

    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.sector = 'NullProtoSector';
    nullProto.industry = 'NullProtoIndustry';

    const edgeInputs: unknown[] = [
      undefined,
      null,
      '',
      'EURUSD',
      0,
      42,
      Number.NaN,
      true,
      false,
      [],
      ['sector'],
      () => 'fn',
      Symbol('s'),
      circular,
      nullProto,
    ];

    for (const input of edgeInputs) {
      const snap = buildSymbolSpecificationSnapshot(input);
      expect(() => readSpecificationSectorIndustry(input)).not.toThrow();
      expect(readSpecificationSectorIndustry(input)).toEqual({ sector: snap.sector, industry: snap.industry });
    }

    for (const primitive of [undefined, null, '', 'EURUSD', 0, 42, Number.NaN, true, false, [], ['sector'], () => 'fn', Symbol('s')]) {
      expect(readSpecificationSectorIndustry(primitive)).toEqual({ sector: null, industry: null });
    }
  });
});
