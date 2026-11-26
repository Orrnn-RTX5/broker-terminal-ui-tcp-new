import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '../../store/useAppStore';
import { buildSymbolSpecificationSnapshot, SymbolSpecificationDialog } from './SymbolSpecificationDialog';

// P20A pin. It must PASS before the P20A change and still pass after it.
// It records what the Specification dialog shows today for the seven raw rows (O1-O7) that
// src/components/SymbolsDialog.sectorIndustry.test.tsx uses in T16 and T17. P20A exports the shared reader
// readSpecificationSectorIndustry from src/utils/symbolSectorIndustry.ts and must not change any value pinned here (a pure move).
// Expected values are worked by hand from the code, not copied from a run. File:line references are origin/main f7b09ad.
// - snapshot.sector and snapshot.industry: in origin/main, readString(records, [...]) over records = collectSpecificationRecords(instrument)
//   (origin/main SymbolSpecificationDialog.tsx:996, :1027-1028). The export reads both with readSpecificationSectorIndustry, the
//   same rule. Records are nested first, and '' is skipped (origin/main :244-288).
// - Rendered rows: Sector = { value: snapshot.sector ?? '—' } and Industry = { value: snapshot.industry } (origin/main :1803-1804).
// - A row whose value is null is not rendered (the origin/main PropertyRows filter at :1241). So Industry is absent when it is null.

const DASH = '—';

type PinCase = {
  id: string;
  row: Record<string, unknown>;
  /** [sector, industry] of buildSymbolSpecificationSnapshot(row). null is a null field. */
  snapshot: [string | null, string | null];
  /** [Sector row text, Industry row text]. null means the row is not rendered. */
  rendered: [string | null, string | null];
};

const PIN_CASES: PinCase[] = [
  // O1: '' is skipped, so sector_name decides. No industry key: the Industry row is not rendered.
  { id: 'O1', row: { symbol: 'AAPL', sector: '', sector_name: 'Technology' }, snapshot: ['Technology', null], rendered: ['Technology', null] },
  // O2: '   ' decides and trims to null. The Sector row shows the dash; the Industry row is not rendered.
  { id: 'O2', row: { symbol: 'AAPL', sector: '   ', sector_name: 'Technology' }, snapshot: [null, null], rendered: [DASH, null] },
  // O3: 6 decides and readString gives null for a non-string. The Sector row shows the dash.
  { id: 'O3', row: { symbol: 'AAPL', sector: 6, sector_name: 'Technology' }, snapshot: [null, null], rendered: [DASH, null] },
  // O4: both values come from the nested brokerSpecification record.
  {
    id: 'O4',
    row: { symbol: 'AAPL', brokerSpecification: { sector: 'Technology', industry: 'Semiconductors' } },
    snapshot: ['Technology', 'Semiconductors'],
    rendered: ['Technology', 'Semiconductors'],
  },
  // O5: the nested record is read before the row, so Energy wins over the top-level Technology.
  {
    id: 'O5',
    row: { symbol: 'AAPL', sector: 'Technology', brokerSpecification: { sector: 'Energy' } },
    snapshot: ['Energy', null],
    rendered: ['Energy', null],
  },
  // O6: SYMBOL_SECTOR normalizes to 'sector' (normalizeSpecificationKey, :238-242).
  { id: 'O6', row: { symbol: 'AAPL', SYMBOL_SECTOR: 'Technology' }, snapshot: ['Technology', null], rendered: ['Technology', null] },
  // O7: neither label present: the snapshot is null and the Sector row shows the dash; Industry is not rendered.
  { id: 'O7', row: { symbol: 'AAPL' }, snapshot: [null, null], rendered: [DASH, null] },
];

// The value text of a property row (the dd beside the dt with this label), or null when the row is not rendered.
const rowValue = (dialog: HTMLElement, label: string): string | null => {
  const labelElement = within(dialog).queryByText(label);
  return labelElement?.closest('div')?.querySelector('dd')?.textContent ?? null;
};

describe('SymbolSpecificationDialog sector and industry pin (P20A)', () => {
  afterEach(() => {
    act(() => useAppStore.getState().setTicks({}));
  });

  it.each(PIN_CASES)('P20A-PIN $id: the snapshot and the Sector and Industry rows are as pinned', ({ row, snapshot, rendered }) => {
    expect(buildSymbolSpecificationSnapshot(row)).toMatchObject({ sector: snapshot[0], industry: snapshot[1] });

    const view = render(
      <SymbolSpecificationDialog isOpen symbol="AAPL" instrument={row} onClose={vi.fn()} />,
    );
    const dialog = screen.getByTestId('symbol-specification-dialog');
    expect(rowValue(dialog, 'Sector')).toBe(rendered[0]);
    expect(rowValue(dialog, 'Industry')).toBe(rendered[1]);
    view.unmount();
  });
});
