import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '../../store/useAppStore';
import { buildSymbolSpecificationSnapshot, SymbolSpecificationDialog } from './SymbolSpecificationDialog';

const DASH = '—';

const readMainRows = (dialog: HTMLElement): Array<[string, string]> => {
  const list = dialog.querySelector('dl.rtx-symbol-specification__rows');
  if (!list) throw new Error('P20A: main specification list not rendered');
  return Array.from(list.children).map((row) => [
    row.querySelector('dt > span:last-child')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? '',
  ]);
};

const readSwapRows = (dialog: HTMLElement): Array<[string, string]> => {
  const region = within(dialog).getByRole('region', { name: 'Swap rates' });
  const list = region.querySelector('dl.rtx-symbol-specification__rows');
  if (!list) throw new Error('P20A: swap rate rows not rendered');
  return Array.from(list.children).map((row) => [
    row.querySelector('dt > span:last-child')?.textContent ?? '',
    row.querySelector('dd')?.textContent ?? '',
  ]);
};

const BASELINE_EMPTY_MAIN_ROWS: ReadonlyArray<[string, string]> = [
  ['Exchange', DASH],
  ['Sector', DASH],
  ['Digits', DASH],
  ['Contract size', DASH],
  ['Spread', DASH],
  ['Stops level', DASH],
  ['Margin currency', DASH],
  ['Profit currency', DASH],
  ['Calculation', DASH],
  ['Hedged margin', DASH],
  ['Chart mode', DASH],
  ['Trade', DASH],
  ['Execution', DASH],
  ['GTC mode', DASH],
  ['Filling', DASH],
  ['Expiration', DASH],
  ['Orders', DASH],
  ['Minimal volume', DASH],
  ['Maximal volume', DASH],
  ['Volume step', DASH],
  ['Swap type', DASH],
  ['Swap long', DASH],
  ['Swap short', DASH],
];

const BASELINE_EMPTY_SWAP_ROWS: ReadonlyArray<[string, string]> = [
  ['Monday', DASH],
  ['Tuesday', DASH],
  ['Wednesday', DASH],
  ['Thursday', DASH],
  ['Friday', DASH],
];

const withSectorIndustry = (
  sectorValue: string,
  industryValue: string | null,
): Array<[string, string]> => {
  const rows: Array<[string, string]> = [];
  for (const [label, value] of BASELINE_EMPTY_MAIN_ROWS) {
    if (label === 'Sector') {
      rows.push(['Sector', sectorValue]);
      if (industryValue !== null) rows.push(['Industry', industryValue]);
    } else {
      rows.push([label, value]);
    }
  }
  return rows;
};

describe('SymbolSpecificationDialog Industry-hidden and Sector placeholder parity (P20A)', () => {
  afterEach(() => {
    act(() => useAppStore.getState().setTicks({}));
  });

  const cases: ReadonlyArray<{
    name: string;
    instrument: unknown;
    fallbackInstrument?: unknown;
    expectedSnapshotSector: string | null;
    expectedSnapshotIndustry: string | null;
    expectedSectorCell: string;
    expectedIndustryCell: string | null;
  }> = [
    {
      name: 'sector and industry present (top-level)',
      instrument: { symbol: 'NVDA', sector: 'Technology', industry: 'Semiconductors' },
      expectedSnapshotSector: 'Technology',
      expectedSnapshotIndustry: 'Semiconductors',
      expectedSectorCell: 'Technology',
      expectedIndustryCell: 'Semiconductors',
    },
    {
      name: 'sector and industry present (nested + trimmed)',
      instrument: {
        symbol: 'NVDA',
        brokerSpecification: { sector_name: '  Technology  ', industryName: '\tSemiconductors\n' },
      },
      expectedSnapshotSector: 'Technology',
      expectedSnapshotIndustry: 'Semiconductors',
      expectedSectorCell: 'Technology',
      expectedIndustryCell: 'Semiconductors',
    },
    {
      name: 'industry missing while sector is present',
      instrument: { symbol: 'EURUSD', sector: 'Currency' },
      expectedSnapshotSector: 'Currency',
      expectedSnapshotIndustry: null,
      expectedSectorCell: 'Currency',
      expectedIndustryCell: null,
    },
    {
      name: 'industry explicitly undefined while sector is present',
      instrument: { symbol: 'EURUSD', sector: 'Currency', industry: undefined },
      expectedSnapshotSector: 'Currency',
      expectedSnapshotIndustry: null,
      expectedSectorCell: 'Currency',
      expectedIndustryCell: null,
    },
    {
      name: 'both sector and industry missing from object',
      instrument: { symbol: 'EURUSD' },
      expectedSnapshotSector: null,
      expectedSnapshotIndustry: null,
      expectedSectorCell: DASH,
      expectedIndustryCell: null,
    },
    {
      name: 'instrument omitted (undefined)',
      instrument: undefined,
      expectedSnapshotSector: null,
      expectedSnapshotIndustry: null,
      expectedSectorCell: DASH,
      expectedIndustryCell: null,
    },
    {
      name: 'server null values for both sector and industry',
      instrument: { symbol: 'AAPL', sector: null, industry: null },
      expectedSnapshotSector: null,
      expectedSnapshotIndustry: null,
      expectedSectorCell: DASH,
      expectedIndustryCell: null,
    },
    {
      name: 'server empty strings for both sector and industry',
      instrument: { symbol: 'AAPL', sector: '', industry: '' },
      expectedSnapshotSector: null,
      expectedSnapshotIndustry: null,
      expectedSectorCell: DASH,
      expectedIndustryCell: null,
    },
    {
      name: 'server whitespace-only strings for both sector and industry',
      instrument: { symbol: 'AAPL', sector: '   ', industry: '\t\n' },
      expectedSnapshotSector: null,
      expectedSnapshotIndustry: null,
      expectedSectorCell: DASH,
      expectedIndustryCell: null,
    },
    {
      name: 'sector present with server null industry',
      instrument: { symbol: 'AAPL', sector: 'Technology', industry: null },
      expectedSnapshotSector: 'Technology',
      expectedSnapshotIndustry: null,
      expectedSectorCell: 'Technology',
      expectedIndustryCell: null,
    },
    {
      name: 'sector present with server empty string industry',
      instrument: { symbol: 'AAPL', sector: 'Technology', industry: '' },
      expectedSnapshotSector: 'Technology',
      expectedSnapshotIndustry: null,
      expectedSectorCell: 'Technology',
      expectedIndustryCell: null,
    },
    {
      name: 'sector present with server whitespace-only industry',
      instrument: { symbol: 'AAPL', sector: 'Technology', industry: '   ' },
      expectedSnapshotSector: 'Technology',
      expectedSnapshotIndustry: null,
      expectedSectorCell: 'Technology',
      expectedIndustryCell: null,
    },
    {
      name: 'server null sector with present industry shows dash for Sector and renders Industry',
      instrument: { symbol: 'AAPL', sector: null, industry: 'Semiconductors' },
      expectedSnapshotSector: null,
      expectedSnapshotIndustry: 'Semiconductors',
      expectedSectorCell: DASH,
      expectedIndustryCell: 'Semiconductors',
    },
    {
      name: 'server empty sector with present industry shows dash for Sector and renders Industry',
      instrument: { symbol: 'AAPL', sector: '', industry: 'Semiconductors' },
      expectedSnapshotSector: null,
      expectedSnapshotIndustry: 'Semiconductors',
      expectedSectorCell: DASH,
      expectedIndustryCell: 'Semiconductors',
    },
    {
      name: 'fallbackInstrument never supplies Sector or unhides Industry when instrument has null/empty',
      instrument: { symbol: 'AAPL', sector: null, industry: '' },
      fallbackInstrument: { symbol: 'AAPL', sector: 'Technology', industry: 'Semiconductors' },
      expectedSnapshotSector: null,
      expectedSnapshotIndustry: null,
      expectedSectorCell: DASH,
      expectedIndustryCell: null,
    },
  ];

  it.each(cases)(
    '$name',
    ({
      instrument,
      fallbackInstrument,
      expectedSnapshotSector,
      expectedSnapshotIndustry,
      expectedSectorCell,
      expectedIndustryCell,
    }) => {
      const snapshot = buildSymbolSpecificationSnapshot(instrument, fallbackInstrument);
      expect(snapshot.sector).toBe(expectedSnapshotSector);
      expect(snapshot.industry).toBe(expectedSnapshotIndustry);

      const view = render(
        <SymbolSpecificationDialog
          isOpen
          symbol="TEST"
          instrument={instrument}
          fallbackInstrument={fallbackInstrument}
          onClose={vi.fn()}
        />,
      );

      const dialog = screen.getByTestId('symbol-specification-dialog');
      const mainRows = readMainRows(dialog);
      const swapRows = readSwapRows(dialog);

      expect(mainRows).toEqual(withSectorIndustry(expectedSectorCell, expectedIndustryCell));
      expect(swapRows).toEqual(BASELINE_EMPTY_SWAP_ROWS);

      if (expectedIndustryCell === null) {
        expect(within(dialog).queryByText('Industry')).toBeNull();
      } else {
        expect(within(dialog).getByText('Industry')).toBeInTheDocument();
      }

      view.unmount();
    },
  );
});
