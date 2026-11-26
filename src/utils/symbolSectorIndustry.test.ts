// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  asRecord,
  collectSpecificationRecords,
  normalizeSpecificationKey,
  readRaw,
  readSpecificationSectorIndustry,
  readString,
} from './symbolSectorIndustry';

describe('symbolSectorIndustry helpers (P20A)', () => {
  it('asRecord accepts plain and null-prototype objects and rejects primitives, arrays, and functions', () => {
    const plain = { sector: 'Technology' };
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.sector = 'Energy';

    expect(asRecord(plain)).toBe(plain);
    expect(asRecord(nullProto)).toBe(nullProto);

    for (const invalid of [
      undefined,
      null,
      '',
      'sector',
      0,
      42,
      Number.NaN,
      true,
      false,
      [],
      ['Technology'],
      () => ({ sector: 'Fn' }),
      Symbol('sym'),
    ]) {
      expect(asRecord(invalid)).toBeNull();
    }
  });

  it('normalizeSpecificationKey strips a single leading symbol prefix, lowercases, and strips punctuation', () => {
    expect(normalizeSpecificationKey('sector')).toBe('sector');
    expect(normalizeSpecificationKey('SECTOR_NAME')).toBe('sectorname');
    expect(normalizeSpecificationKey('sectorName')).toBe('sectorname');
    expect(normalizeSpecificationKey('SYMBOL_SECTOR')).toBe('sector');
    expect(normalizeSpecificationKey('symbol-sector_name')).toBe('sectorname');
    expect(normalizeSpecificationKey('  Symbol_IndustryName  ')).toBe('industryname');
    expect(normalizeSpecificationKey('___---')).toBe('');
  });

  it('collectSpecificationRecords walks nested records before parents, respects depth < 3, and guards cycles', () => {
    const level4 = { level: 4 };
    const level3 = { level: 3, details: level4 };
    const level2 = { level: 2, specification: level3 };
    const level1 = { level: 1, instrument: level2 };
    const root: Record<string, unknown> = {
      level: 0,
      brokerSpecification: level1,
      metadata: { level: 'meta' },
      spec: 'ignored-string',
      contract: ['ignored-array'],
      details: null,
    };

    const records = collectSpecificationRecords(root);
    expect(records.map(record => record.level)).toEqual([3, 2, 1, 'meta', 0]);

    // Circular and shared-reference deduplication
    const shared = { tag: 'shared' };
    const circular: Record<string, unknown> = {
      tag: 'root',
      brokerSpecification: shared,
      instrument: shared,
    };
    circular.details = circular;
    expect(collectSpecificationRecords(circular).map(record => record.tag)).toEqual(['shared', 'root']);

    expect(collectSpecificationRecords(null)).toEqual([]);
    expect(collectSpecificationRecords(['a'])).toEqual([]);
  });

  it('readRaw distinguishes skipped empty values from falsy/whitespace values and matches normalized aliases', () => {
    const records = [
      { sector: '', sector_name: undefined, SYMBOL_SECTOR: null, symbol_sector_name: 'Energy' },
    ];
    expect(readRaw(records, ['sector', 'sector_name', 'sectorName'])).toBe('Energy');

    const precomputed = new Set(['sector', 'sectorname']);
    expect(readRaw(records, ['sector', 'sector_name', 'sectorName'], precomputed)).toBe('Energy');

    // Exact whitespace or falsy non-nullish values (0, false, NaN) are returned directly without skipping
    expect(readRaw([{ sector: '   ', sector_name: 'Fallback' }], ['sector', 'sector_name'])).toBe('   ');
    expect(readRaw([{ sector: 0, sector_name: 'Fallback' }], ['sector', 'sector_name'])).toBe(0);
    expect(readRaw([{ sector: false, sector_name: 'Fallback' }], ['sector', 'sector_name'])).toBe(false);
    expect(Number.isNaN(readRaw([{ sector: Number.NaN, sector_name: 'Fallback' }], ['sector', 'sector_name']))).toBe(true);
    expect(readRaw([{}], ['sector'])).toBeUndefined();
  });

  it('readString trims valid strings and returns null for empty, whitespace-only, or non-string values', () => {
    expect(readString([{ sector: '  Financials \t\n' }], ['sector'])).toBe('Financials');
    expect(readString([{ sector: '   \t\r\n' }], ['sector'])).toBeNull();
    expect(readString([{ sector: '' }], ['sector'])).toBeNull();
    expect(readString([{ sector: null }], ['sector'])).toBeNull();
    expect(readString([{ sector: 0 }], ['sector'])).toBeNull();
    expect(readString([{ sector: false }], ['sector'])).toBeNull();
    expect(readString([{ sector: ['Technology'] }], ['sector'])).toBeNull();
    expect(readString([{ sector: { name: 'Technology' } }], ['sector'])).toBeNull();
  });

  it('readSpecificationSectorIndustry handles missing, null, empty, whitespace, nested priority, and edge inputs', () => {
    expect(readSpecificationSectorIndustry()).toEqual({ sector: null, industry: null });
    expect(readSpecificationSectorIndustry(null)).toEqual({ sector: null, industry: null });
    expect(readSpecificationSectorIndustry({})).toEqual({ sector: null, industry: null });
    expect(readSpecificationSectorIndustry({ sector: null, industry: null })).toEqual({ sector: null, industry: null });
    expect(readSpecificationSectorIndustry({ sector: '', industry: '' })).toEqual({ sector: null, industry: null });
    expect(readSpecificationSectorIndustry({ sector: '  \t ', industry: '\r\n' })).toEqual({ sector: null, industry: null });

    expect(readSpecificationSectorIndustry({
      sector: '',
      sector_name: null,
      sectorName: '  Industrials  ',
      industry: '   ',
      industry_name: 'Aerospace',
    })).toEqual({ sector: 'Industrials', industry: null });

    expect(readSpecificationSectorIndustry({
      SYMBOL_SECTOR: '  Healthcare ',
      symbol_industry_name: 'Biotechnology',
    })).toEqual({ sector: 'Healthcare', industry: 'Biotechnology' });

    // Earlier NESTED_SPECIFICATION_KEYS entry takes precedence over later sibling entries
    expect(readSpecificationSectorIndustry({
      brokerSpecification: { sector: 'BrokerSector' },
      details: { sector: 'DetailsSector', industry: 'DetailsIndustry' },
    })).toEqual({ sector: 'BrokerSector', industry: 'DetailsIndustry' });

    // Depth 3 is included; depth 4 is ignored
    expect(readSpecificationSectorIndustry({
      brokerSpecification: {
        instrument: {
          specification: {
            sector: 'Depth3Sector',
            details: {
              sector: 'Depth4Sector',
              industry: 'Depth4Industry',
            },
          },
        },
      },
    })).toEqual({ sector: 'Depth3Sector', industry: null });
  });

  it('covers additional edge inputs: prefix boundaries, exact-over-normalized order, nested nullifiers, all nested keys, and non-plain objects', () => {
    // Only a single leading symbol[_-]? prefix is stripped; trailing "symbol" stays intact.
    expect(normalizeSpecificationKey('symbolSector')).toBe('sector');
    expect(normalizeSpecificationKey('symbol_symbol_sector')).toBe('symbolsector');
    expect(normalizeSpecificationKey('sector_symbol')).toBe('sectorsymbol');

    // Exact keys on a record are checked before normalized aliases on that same record, regardless of insertion order.
    expect(readRaw([{ SYMBOL_SECTOR: 'NormalizedFirst', sector_name: 'ExactSecond' }], ['sector', 'sector_name'])).toBe('ExactSecond');

    // A nested whitespace or non-string value decides first and returns null rather than falling back to the parent record.
    expect(readSpecificationSectorIndustry({
      sector: 'OuterSector',
      industry: 'OuterIndustry',
      brokerSpecification: { sector: '   ', industry: 42 },
    })).toEqual({ sector: null, industry: null });

    // Industry-only record leaves sector null.
    expect(readSpecificationSectorIndustry({ industry: '  Semiconductors  ' })).toEqual({
      sector: null,
      industry: 'Semiconductors',
    });

    // Non-plain object instances do not throw and return null fields.
    expect(readSpecificationSectorIndustry(new Date(0))).toEqual({ sector: null, industry: null });
    expect(readSpecificationSectorIndustry(/sector/)).toEqual({ sector: null, industry: null });

    // All 11 nested container keys are traversed in declaration order.
    const nestedKeysInOrder = [
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
    const allNested: Record<string, unknown> = { sector: 'Root' };
    for (const key of nestedKeysInOrder) {
      allNested[key] = { sector: `S_${key}` };
    }
    expect(collectSpecificationRecords(allNested).map((record) => record.sector)).toEqual([
      ...nestedKeysInOrder.map((key) => `S_${key}`),
      'Root',
    ]);
  });
});
