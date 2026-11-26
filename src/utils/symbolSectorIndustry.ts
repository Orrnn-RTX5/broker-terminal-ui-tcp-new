// Broker symbol specification readers shared by SymbolSpecificationDialog and SymbolsDialog.
// SymbolsDialog needs only the sector/industry reader. It lives here, not in the specification dialog module, so SymbolsDialog
// does not load that ~2,200-line dialog, which the market watch panel lazy-loads.
const NESTED_SPECIFICATION_KEYS = [
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

export const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

export const normalizeSpecificationKey = (value: string): string => value
  .trim()
  .toLowerCase()
  .replace(/^symbol[_-]?/, '')
  .replace(/[^a-z0-9]/g, '');

export const collectSpecificationRecords = (value: unknown): Record<string, unknown>[] => {
  const root = asRecord(value);
  if (!root) return [];

  const records: Record<string, unknown>[] = [];
  const seen = new Set<Record<string, unknown>>([root]);
  const visit = (record: Record<string, unknown>, depth: number) => {
    // Rich nested broker snapshots are authoritative over normalized catalog
    // fields on their wrapper. Traverse them first and keep the walk bounded.
    if (depth < 3) {
      NESTED_SPECIFICATION_KEYS.forEach((key) => {
        const nested = asRecord(record[key]);
        if (!nested || seen.has(nested)) return;
        seen.add(nested);
        visit(nested, depth + 1);
      });
    }
    records.push(record);
  };
  visit(root, 0);

  return records;
};

export const readRaw = (
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  // The normalized spellings of `keys`, when the caller already has them (a module constant). Built here otherwise.
  normalizedKeysOf?: ReadonlySet<string>,
): unknown => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }

    // Some MT5 adapters expose the native SYMBOL_* property names while the
    // HTTP catalog uses snake_case or camelCase. Match those spellings without
    // making the rest of the parser depend on a particular adapter.
    const normalizedKeys = normalizedKeysOf ?? new Set(keys.map(normalizeSpecificationKey));
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined || value === null || value === '') continue;
      if (normalizedKeys.has(normalizeSpecificationKey(key))) return value;
    }
  }
  return undefined;
};

export const readString = (
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  normalizedKeysOf?: ReadonlySet<string>,
): string | null => {
  const value = readRaw(records, keys, normalizedKeysOf);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const SECTOR_SPECIFICATION_KEYS = ['sector', 'sector_name', 'sectorName'] as const;
const INDUSTRY_SPECIFICATION_KEYS = ['industry', 'industry_name', 'industryName'] as const;
// The normalized spellings of the two lists, built once when the module loads. readRaw would otherwise rebuild them on
// every call.
const SECTOR_NORMALIZED_KEYS: ReadonlySet<string> = new Set(SECTOR_SPECIFICATION_KEYS.map(normalizeSpecificationKey));
const INDUSTRY_NORMALIZED_KEYS: ReadonlySet<string> = new Set(INDUSTRY_SPECIFICATION_KEYS.map(normalizeSpecificationKey));

// Read by the Symbols dialog for the selected row only and by the specification dialog for its snapshot, so both show the
// same sector and industry for a symbol.
export const readSpecificationSectorIndustry = (
  instrument?: unknown,
): { sector: string | null; industry: string | null } => {
  const records = collectSpecificationRecords(instrument);
  return {
    sector: readString(records, SECTOR_SPECIFICATION_KEYS, SECTOR_NORMALIZED_KEYS),
    industry: readString(records, INDUSTRY_SPECIFICATION_KEYS, INDUSTRY_NORMALIZED_KEYS),
  };
};
