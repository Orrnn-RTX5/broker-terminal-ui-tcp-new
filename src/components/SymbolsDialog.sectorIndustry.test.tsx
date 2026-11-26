// @vitest-environment jsdom

// P20A regression tests: the Symbols dialog shows a server sector and industry, or the dash, never a guess.
// They were written first and pass on the product change. The shared reader is loaded with a dynamic import inside
// loadSectorIndustryReader(). The import stays so this file still loads on a tree without the export; there, the tests
// that need the reader fail with a message that names it.
// - The export: `readSpecificationSectorIndustry(instrument?: unknown): { sector: string | null; industry: string | null }`
//   in src/utils/symbolSectorIndustry.ts.
// File:line references in these comments are origin/main f7b09ad (the untouched base), unless a comment says otherwise.
// - Existing exports used unchanged: SymbolsDialog (src/components/SymbolsDialog.tsx), buildSymbolSpecificationSnapshot
//   (src/components/dialogs/SymbolSpecificationDialog.tsx) and normalizeInstrument (src/features/market-data/marketDataNormalization.ts).
// - SymbolsDialog props are unchanged: isOpen, onClose, onShowSymbol, onOpenChart, instruments, initialSymbol, title, chartActionLabel.
// Two openers: "menu" = raw catalogue rows, as MenuBar.tsx:1449-1457 passes them (rows through `instruments` take the same
// normalizer as the fetched list). "picker" = MarketInstrument rows from normalizeInstrument, as App.tsx builds
// chartPickerInstruments (App.tsx:2036-2039), rendered with title and chartActionLabel (App.tsx:2495-2496).

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SymbolsDialog } from './SymbolsDialog';
import { buildSymbolSpecificationSnapshot } from './dialogs/SymbolSpecificationDialog';
import { normalizeInstrument } from '../features/market-data/marketDataNormalization';
import { updateDynamicUrls } from '../config/api';

// The dash the Specification rows show for an absent value (EM DASH, U+2014).
const DASH = '—';

type SectorIndustry = { sector: string | null; industry: string | null };
type SectorIndustryReader = (instrument?: unknown) => SectorIndustry;

const loadSectorIndustryReader = async (): Promise<SectorIndustryReader> => {
  const sectorIndustryModule = (await import('../utils/symbolSectorIndustry')) as unknown as Record<string, unknown>;
  const reader = sectorIndustryModule.readSpecificationSectorIndustry;
  if (typeof reader !== 'function') {
    throw new Error('P20A: readSpecificationSectorIndustry is not exported from src/utils/symbolSectorIndustry.ts');
  }
  return reader as SectorIndustryReader;
};

// The seven raw rows of P20A-T16 (unit) and P20A-T17 (render): the spec's six (O1-O6) plus O7, the "neither" case of the
// brief (no sector or industry key at all). Expected values are worked by hand from the reader's rule
// (SymbolSpecificationDialog.tsx:244-266 records, nested first; :268-288 readRaw, exact keys then normalized spellings
// per record, where undefined, null and '' are skipped; :290-298 readString, which trims and gives null for a non-string
// or an empty result).
type SectorCase = { id: string; row: Record<string, unknown>; sector: string | null; industry: string | null };

const SECTOR_CASES: SectorCase[] = [
  // O1: '' is skipped, so sector_name decides. No industry key.
  { id: 'O1', row: { symbol: 'AAPL', sector: '', sector_name: 'Technology' }, sector: 'Technology', industry: null },
  // O2: '   ' is not skipped. It decides and trims to '', which is null. sector_name is never reached.
  { id: 'O2', row: { symbol: 'AAPL', sector: '   ', sector_name: 'Technology' }, sector: null, industry: null },
  // O3: 6 decides and readString gives null for a non-string. sector_name is never reached.
  { id: 'O3', row: { symbol: 'AAPL', sector: 6, sector_name: 'Technology' }, sector: null, industry: null },
  // O4: both values are in the nested brokerSpecification record.
  { id: 'O4', row: { symbol: 'AAPL', brokerSpecification: { sector: 'Technology', industry: 'Semiconductors' } }, sector: 'Technology', industry: 'Semiconductors' },
  // O5: the nested record is read before the row, so Energy wins over the top-level Technology.
  { id: 'O5', row: { symbol: 'AAPL', sector: 'Technology', brokerSpecification: { sector: 'Energy' } }, sector: 'Energy', industry: null },
  // O6: SYMBOL_SECTOR normalizes to 'sector' (normalizeSpecificationKey removes the symbol_ prefix, :238-242).
  { id: 'O6', row: { symbol: 'AAPL', SYMBOL_SECTOR: 'Technology' }, sector: 'Technology', industry: null },
  // O7: neither label is present anywhere: both null, both show the dash.
  { id: 'O7', row: { symbol: 'AAPL' }, sector: null, industry: null },
];

const renderMenu = (instruments: readonly unknown[], initialSymbol?: string) => render(
  <SymbolsDialog
    isOpen
    onClose={vi.fn()}
    onShowSymbol={vi.fn()}
    onOpenChart={vi.fn()}
    instruments={instruments}
    initialSymbol={initialSymbol}
  />,
);

const renderPicker = (instruments: readonly unknown[], initialSymbol?: string) => render(
  <SymbolsDialog
    isOpen
    onClose={vi.fn()}
    onOpenChart={vi.fn()}
    title="Change chart symbol"
    chartActionLabel="Apply"
    instruments={instruments}
    initialSymbol={initialSymbol}
  />,
);

const catalogTable = () => screen.getByRole('table', { name: 'Available symbols' });
const specificationTable = () => screen.getByRole('table', { name: 'Contract specification' });

// Catalogue data rows. The first row is the header (SymbolsDialog.tsx:1320-1326).
const catalogDataRows = (): HTMLElement[] => within(catalogTable()).getAllByRole('row').slice(1);
// The symbol name is the first span of a row (SymbolsDialog.tsx:1379-1380). The $ icon is an svg, not a span.
const rowSymbolName = (row: HTMLElement): string | null | undefined => row.querySelector('span')?.textContent;

// Text of one cell of the Contract specification table, found by its label in the first column (SymbolsDialog.tsx:1404-1415).
const specificationCell = (label: string, column: 0 | 1 = 1): string | null | undefined => {
  const row = within(specificationTable()).getByText(label).closest('tr');
  return row?.querySelectorAll('td')[column]?.textContent;
};

const sectorAndIndustry = (): Array<string | null | undefined> => [
  specificationCell('Sector'),
  specificationCell('Industry'),
];

describe('SymbolsDialog sector and industry (P20A)', () => {
  beforeEach(() => {
    vi.stubGlobal('__RTX_RUNTIME_CONFIG__', {
      CONFIG_SOURCE: 'deployment',
      API_HOST: 'https://broker.example',
      WS_HOST: 'wss://broker.example',
      BROKER_ID: 'test-broker',
      DEFAULT_MT5_SERVER: 'Test Broker-Live',
    });
    updateDynamicUrls();
    // Every test passes `instruments`, so the dialog must not fetch.
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    updateDynamicUrls();
  });

  // Expected values in each test are worked by hand from the code, not copied from a run.
  // "Today" notes what origin/main shows (origin/main SymbolsDialog.tsx:135-153 and :915-916).

  it('P20A-T01 menu shape, present: a server sector and industry are shown', () => {
    // By hand: top-level keys decide (records = [the row]); sector 'Technology', industry 'Semiconductors'.
    // Today: Forex and Currency Pairs (no prefix match in the origin/main name map, origin/main SymbolsDialog.tsx:152).
    renderMenu([{ symbol: 'AAPL', sector: 'Technology', industry: 'Semiconductors' }], 'AAPL');
    expect(sectorAndIndustry()).toEqual(['Technology', 'Semiconductors']);
  });

  it('P20A-T02 menu shape, none: a row without server values shows the dash for both rows', () => {
    // By hand: no sector or industry key anywhere, so both reads give null and the view shows the dash (D1, D2).
    // Today: Forex and Currency Pairs.
    renderMenu([{ symbol: 'MSFT' }], 'MSFT');
    expect(sectorAndIndustry()).toEqual([DASH, DASH]);
  });

  it('P20A-T03 picker shape, present: the server values are read from brokerSpecification', () => {
    // Fixture check: normalizeInstrument keeps the raw row in brokerSpecification (marketDataNormalization.ts:224-240).
    const pickerRow = normalizeInstrument({ symbol: 'AAPL', sector: 'Technology', industry: 'Semiconductors' });
    expect(pickerRow?.brokerSpecification).toMatchObject({ sector: 'Technology', industry: 'Semiconductors' });
    // By hand: the top-level MarketInstrument has no sector or industry key, so brokerSpecification decides
    // (D6 step 1). Technology and Semiconductors. Today: Forex and Currency Pairs.
    renderPicker([pickerRow], 'AAPL');
    expect(sectorAndIndustry()).toEqual(['Technology', 'Semiconductors']);
  });

  it('P20A-T04a picker shape, none: a picker row without server values shows the dash', () => {
    // By hand: brokerSpecification has no sector or industry key, so both are null and show the dash.
    // Today: Forex and Currency Pairs.
    renderPicker([normalizeInstrument({ symbol: 'MSFT' })], 'MSFT');
    expect(sectorAndIndustry()).toEqual([DASH, DASH]);
  });

  it('P20A-T04b picker shape, bare row: the { symbol } row of App.tsx:2038 shows the dash and does not throw', () => {
    // By hand: no brokerSpecification at all. The reader gets a plain object with no server keys, so both are null.
    // Today: Forex and Currency Pairs.
    renderPicker([{ symbol: 'MSFT' }], 'MSFT');
    expect(sectorAndIndustry()).toEqual([DASH, DASH]);
  });

  it('P20A-T05 both openers agree for the same server facts', () => {
    // AAPL with values, on the menu opener, then on the picker opener.
    const menu = renderMenu([{ symbol: 'AAPL', sector: 'Technology', industry: 'Semiconductors' }], 'AAPL');
    expect(sectorAndIndustry()).toEqual(['Technology', 'Semiconductors']);
    menu.unmount();

    const picker = renderPicker(
      [normalizeInstrument({ symbol: 'AAPL', sector: 'Technology', industry: 'Semiconductors' })],
      'AAPL',
    );
    expect(sectorAndIndustry()).toEqual(['Technology', 'Semiconductors']);
    picker.unmount();

    // MSFT without values, on both openers: the dash on both.
    const menuEmpty = renderMenu([{ symbol: 'MSFT' }], 'MSFT');
    expect(sectorAndIndustry()).toEqual([DASH, DASH]);
    menuEmpty.unmount();

    renderPicker([normalizeInstrument({ symbol: 'MSFT' })], 'MSFT');
    expect(sectorAndIndustry()).toEqual([DASH, DASH]);
    expect(fetch).not.toHaveBeenCalled();
  });

  // Today: the guessed label in each case is the name-map result (SymbolsDialog.tsx:136-152).
  it.each(['EURUSD', 'XAUUSD', 'BTCUSD', 'NAS100', 'US30'])(
    'P20A-T06 %s with no server sector or industry shows the dash',
    (symbol) => {
      renderMenu([{ symbol }], symbol);
      expect(sectorAndIndustry()).toEqual([DASH, DASH]);
    },
  );

  it('P20A-T07 a category is not a sector: a category-only row shows the dash', () => {
    // By hand: category feeds the tree only (SymbolsDialog.tsx:235, :305). No sector or industry key: the dash.
    // Today: Forex and Major Pairs.
    renderMenu([{ symbol: 'EURUSD', category: 'Forex.Majors' }], 'EURUSD');
    expect(sectorAndIndustry()).toEqual([DASH, DASH]);
  });

  it('P20A-T08 sector_name and industry_name are read, and the sector is trimmed', () => {
    // By hand: sector_name is an exact key (origin/main SymbolSpecificationDialog.tsx:1027); '  Technology ' trims to 'Technology'. industry_name gives 'Semiconductors'.
    renderMenu([{ symbol: 'AAPL', sector_name: '  Technology ', industry_name: 'Semiconductors' }], 'AAPL');
    expect(sectorAndIndustry()).toEqual(['Technology', 'Semiconductors']);
  });

  it('P20A-T09a a blank sector and a whitespace industry give the dash', () => {
    // By hand: sector '' is skipped (:275), and there is no other sector key, so the sector is null.
    // industry '   ' is not skipped: it decides and trims to '', which is null. Both show the dash.
    renderMenu([{ symbol: 'AAPL', sector: '', industry: '   ' }], 'AAPL');
    expect(sectorAndIndustry()).toEqual([DASH, DASH]);
  });

  it('P20A-T09b a null sector and a number industry give the dash', () => {
    // By hand: sector null is skipped, and there is no other sector key, so the sector is null.
    // industry 6 decides (not undefined, null or ''), and readString gives null for a non-string (:295). Both show the dash.
    renderMenu([{ symbol: 'MSFT', sector: null, industry: 6 }], 'MSFT');
    expect(sectorAndIndustry()).toEqual([DASH, DASH]);
  });

  it('P20A-T10a a blank sector key is skipped, so sector_name decides', () => {
    // By hand: sector '' is skipped (:275). sector_name 'Technology' decides.
    renderMenu([{ symbol: 'AAPL', sector: '', sector_name: 'Technology' }], 'AAPL');
    expect(specificationCell('Sector')).toBe('Technology');
  });

  it('P20A-T10b a number sector key decides and gives the dash, even with sector_name present', () => {
    // By hand: sector 6 is the first value that is not undefined, null or '', so it decides (:273-276).
    // readString gives null for a non-string (:295). sector_name is never reached.
    renderMenu([{ symbol: 'MSFT', sector: 6, sector_name: 'Technology' }], 'MSFT');
    expect(specificationCell('Sector')).toBe(DASH);
  });

  // The nested record is read before the row (SymbolSpecificationDialog.tsx:253-261). The industry is null in every case.
  const nestedCases: Array<[string, Record<string, unknown>, string]> = [
    ['a', { symbol: 'AAPL', sector: 'Technology', brokerSpecification: { sector: 'Energy' } }, 'Energy'],
    ['b', { symbol: 'AAPL', sector: '', brokerSpecification: { sector: 'Technology' } }, 'Technology'],
    ['c', { symbol: 'AAPL', sector: '   ', brokerSpecification: { sector: 'Technology' } }, 'Technology'],
    ['d', { symbol: 'AAPL', sector: 6, brokerSpecification: { sector: 'Technology' } }, 'Technology'],
    ['e', { symbol: 'AAPL', sector: null, brokerSpecification: { sector: 'Technology' } }, 'Technology'],
    ['f', { symbol: 'AAPL', brokerSpecification: { sector: '  Technology  ' } }, 'Technology'],
  ];

  it.each(nestedCases)('P20A-T11%s nested brokerSpecification is read before the row', (_case, row, expected) => {
    // Expected sector, by hand: (a) Energy, because the nested record comes first. (b) to (f) Technology, because the
    // nested record decides before the row's blank, whitespace, number or null is looked at. (f) is trimmed.
    renderMenu([row], 'AAPL');
    expect(specificationCell('Sector')).toBe(expected);
    expect(specificationCell('Industry')).toBe(DASH);
  });

  it('P20A-T12 the category tree is unchanged: symbols without a server category stay in the Forex folder', () => {
    // Regression guard. category is unchanged (SymbolsDialog.tsx:235, :305), so both symbols sit in Forex (no server category).
    renderMenu([{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }]);
    const tree = screen.getByRole('group', { name: 'Instrument categories' });
    expect(within(tree).getByRole('button', { name: 'Forex' })).toBeInTheDocument();
    expect(within(tree).queryByRole('button', { name: 'Commodities' })).not.toBeInTheDocument();
    expect(within(tree).queryByRole('button', { name: 'Precious Metals' })).not.toBeInTheDocument();
  });

  it('P20A-T13 search is unchanged: the sector is not searched, the symbol name is', () => {
    // Regression guard. The search keys are name and description only (SymbolsDialog.tsx:640-648).
    renderMenu([{ symbol: 'AAPL', sector: 'Technology' }, { symbol: 'MSFT' }]);
    const search = screen.getByRole('textbox', { name: 'Search symbols' });

    fireEvent.change(search, { target: { value: 'Technology' } });
    expect(within(catalogTable()).getByText('No symbols found')).toBeInTheDocument();
    expect(within(catalogTable()).queryByText('AAPL')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'AAPL' } });
    const rows = catalogDataRows();
    expect(rows).toHaveLength(1);
    expect(rowSymbolName(rows[0])).toBe('AAPL');
  });

  it('P20A-T14 the specification rows keep their labels and order', () => {
    // Regression guard. Labels and order are at origin/main SymbolsDialog.tsx:915-923.
    renderMenu([{ symbol: 'AAPL' }], 'AAPL');
    const labels = Array.from(
      specificationTable().querySelectorAll('tr'),
      (row) => row.querySelector('td')?.textContent,
    );
    expect(labels).toEqual([
      'Sector', 'Industry', 'Digits', 'Contract size', 'Spread', 'Stops level', 'Margin currency', 'Tick size', 'Trading enabled',
    ]);
  });

  it('P20A-T15 bare strings are dropped before any read and nothing throws', () => {
    // Regression guard. The name guard at SymbolsDialog.tsx:214-215 drops a string, so no key is read from it.
    renderMenu(['AAPL', 'MSFT']);
    expect(within(catalogTable()).getByText('No symbols found')).toBeInTheDocument();
    expect(screen.getByText('Select a symbol to view specification')).toBeInTheDocument();
  });

  it.each(SECTOR_CASES)('P20A-T16 $id the shared reader gives the hand-worked values and equals the snapshot', async ({ row, sector, industry }) => {
    const readSectorIndustry = await loadSectorIndustryReader();
    expect(readSectorIndustry(row)).toEqual({ sector, industry });
    const snapshot = buildSymbolSpecificationSnapshot(row);
    expect({ sector: snapshot.sector, industry: snapshot.industry }).toEqual(readSectorIndustry(row));
  });

  it.each(SECTOR_CASES)('P20A-T17 $id both openers show the same text as the snapshot', ({ row, sector, industry }) => {
    // Expected cell text is the snapshot's value, or the dash. The hand-worked values are checked first.
    const snapshot = buildSymbolSpecificationSnapshot(row);
    const expected = [snapshot.sector ?? DASH, snapshot.industry ?? DASH];
    expect(expected).toEqual([sector ?? DASH, industry ?? DASH]);

    const menu = renderMenu([row], 'AAPL');
    expect(sectorAndIndustry(), 'menu opener').toEqual(expected);
    menu.unmount();

    renderPicker([normalizeInstrument(row)], 'AAPL');
    expect(sectorAndIndustry(), 'picker opener').toEqual(expected);
  });
});
