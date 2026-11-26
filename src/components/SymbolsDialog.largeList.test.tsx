// @vitest-environment jsdom

// P20A close-out, review L1. The Symbols dialog reads Sector and Industry only for the selected symbol, not for every row
// of the list. This file renders a 5,000-symbol catalogue and counts the calls that the dialog makes to the shared reader.
// The count must not grow with the list: it must be the same as for a 50-symbol list, and bounded by what is shown (one
// selected symbol).

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SymbolsDialog } from './SymbolsDialog';
import { updateDynamicUrls } from '../config/api';

// Counts every call that SymbolsDialog makes to the shared reader. vi.hoisted keeps the counter visible to the mock.
const readerCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../utils/symbolSectorIndustry', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const reader = actual.readSpecificationSectorIndustry as (instrument?: unknown) => unknown;
  return {
    ...actual,
    readSpecificationSectorIndustry: (instrument?: unknown) => {
      readerCalls.count += 1;
      return reader(instrument);
    },
  };
});

// The dash the Specification rows show for an absent value (EM DASH, U+2014).
const DASH = '—';
const SMALL_LIST = 50;
const LARGE_LIST = 5000;

// Every thousandth row carries a server sector and industry, so a displayed value can be checked.
const buildRows = (count: number) => Array.from({ length: count }, (_, index) => ({
  symbol: `SYM${String(index + 1).padStart(5, '0')}`,
  digits: 5,
  contract_size: 100000,
  enabled: true,
  margin_currency: 'USD',
  ...(index % 1000 === 999 ? { sector: 'Technology', industry: 'Semiconductors' } : {}),
}));

const renderSymbols = (instruments: readonly unknown[], initialSymbol: string) => render(
  <SymbolsDialog
    isOpen
    onClose={vi.fn()}
    onShowSymbol={vi.fn()}
    onOpenChart={vi.fn()}
    instruments={instruments}
    initialSymbol={initialSymbol}
  />,
);

// Direct DOM queries. Role queries walk every row of a 5,000-row table and would dominate the run time.
const catalogueRows = (): HTMLTableRowElement[] => {
  const table = document.querySelector<HTMLTableElement>('table[aria-label="Available symbols"]');
  if (!table) throw new Error('P20A: the Available symbols table is not rendered');
  return Array.from(table.querySelectorAll<HTMLTableRowElement>('tr[data-symbol-row]'));
};

// The value cell of one Contract specification row, found by its label in the first cell (the second cell is the value).
const specificationValue = (label: string): string | null | undefined => {
  const table = document.querySelector<HTMLTableElement>('table[aria-label="Contract specification"]');
  if (!table) throw new Error('P20A: the Contract specification table is not rendered');
  const row = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'))
    .find(candidate => candidate.querySelector('td')?.textContent === label);
  return row?.querySelectorAll('td')[1]?.textContent;
};

describe('SymbolsDialog with a large catalogue (P20A close-out, review L1)', () => {
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
    readerCalls.count = 0;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    updateDynamicUrls();
  });

  it('reads Sector and Industry only for the shown row, so the call count does not grow with the list', async () => {
    renderSymbols(buildRows(SMALL_LIST), 'SYM00001');
    const callsSmallList = readerCalls.count;
    cleanup();

    readerCalls.count = 0;
    renderSymbols(buildRows(LARGE_LIST), 'SYM01000');
    const callsLargeList = readerCalls.count;

    // One symbol is shown, so one call. The bound allows for React running an extra render; it is not a list-length bound.
    expect(callsLargeList).toBeLessThanOrEqual(2);
    expect(callsLargeList).toBe(callsSmallList);
    // The shown row (SYM01000) carries server values, and they are displayed as before.
    expect(specificationValue('Sector')).toBe('Technology');
    expect(specificationValue('Industry')).toBe('Semiconductors');

    // Selecting another row costs exactly one call: the reader runs for the row that is shown.
    const callsBeforeSelect = readerCalls.count;
    const plainRow = catalogueRows().find(row => row.querySelector('span')?.textContent === 'SYM00002');
    expect(plainRow).toBeDefined();
    fireEvent.click(plainRow as HTMLTableRowElement);
    expect(readerCalls.count - callsBeforeSelect).toBe(1);
    expect(specificationValue('Sector')).toBe(DASH);
    expect(specificationValue('Industry')).toBe(DASH);

    // A re-render for another reason (typing in the search box) does not read the selected row again.
    const callsBeforeSearch = readerCalls.count;
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search symbols"]');
    expect(search).not.toBeNull();
    fireEvent.change(search as HTMLInputElement, { target: { value: 'SYM0100' } });
    expect(readerCalls.count).toBe(callsBeforeSearch);
  }, 120_000);
});
