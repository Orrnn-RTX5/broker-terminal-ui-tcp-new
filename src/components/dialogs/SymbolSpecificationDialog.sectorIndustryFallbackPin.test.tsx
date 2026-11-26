import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '../../store/useAppStore';
import { buildSymbolSpecificationSnapshot, SymbolSpecificationDialog } from './SymbolSpecificationDialog';

// P20A close-out, review L3. A pin for the one input the sector and industry pin file does not cover: a value that exists
// only in fallbackInstrument. The snapshot reads sector and industry from the records of `instrument` alone (the export's
// readSpecificationSectorIndustry(instrument), called from buildSymbolSpecificationSnapshot). The fallback only feeds the
// identity fields (description, page URL). Expected values are worked by hand from that rule.

const DASH = '—';

// The value text of a property row (the dd beside the dt with this label), or null when the row is not rendered.
const rowValue = (dialog: HTMLElement, label: string): string | null => {
  const labelElement = within(dialog).queryByText(label);
  return labelElement?.closest('div')?.querySelector('dd')?.textContent ?? null;
};

describe('SymbolSpecificationDialog sector and industry from the fallback (P20A close-out)', () => {
  afterEach(() => {
    act(() => useAppStore.getState().setTicks({}));
  });

  it('P20A-FALLBACK-1 a sector and industry that exist only in fallbackInstrument are not shown', () => {
    const instrument = { symbol: 'AAPL' };
    const fallbackInstrument = { symbol: 'AAPL', sector: 'Technology', industry: 'Semiconductors' };
    // By hand: the records of `instrument` have neither key, so both fields are null. The fallback is not read for them.
    expect(buildSymbolSpecificationSnapshot(instrument, fallbackInstrument)).toMatchObject({ sector: null, industry: null });

    const view = render(
      <SymbolSpecificationDialog
        isOpen
        symbol="AAPL"
        instrument={instrument}
        fallbackInstrument={fallbackInstrument}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByTestId('symbol-specification-dialog');
    // Sector shows the dash. Industry is not rendered, because a null value hides that row.
    expect(rowValue(dialog, 'Sector')).toBe(DASH);
    expect(rowValue(dialog, 'Industry')).toBeNull();
    view.unmount();
  });

  it('P20A-FALLBACK-2 the instrument sector is shown, and the fallback sector does not replace it', () => {
    const instrument = { symbol: 'AAPL', sector: 'Energy' };
    const fallbackInstrument = { symbol: 'AAPL', sector: 'Technology' };
    // By hand: the sector comes from `instrument` (Energy). The industry key is absent from both, so it is null.
    expect(buildSymbolSpecificationSnapshot(instrument, fallbackInstrument)).toMatchObject({ sector: 'Energy', industry: null });

    const view = render(
      <SymbolSpecificationDialog
        isOpen
        symbol="AAPL"
        instrument={instrument}
        fallbackInstrument={fallbackInstrument}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByTestId('symbol-specification-dialog');
    expect(rowValue(dialog, 'Sector')).toBe('Energy');
    expect(rowValue(dialog, 'Industry')).toBeNull();
    view.unmount();
  });
});
