// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SymbolsDialog } from './SymbolsDialog';
import { buildSymbolSpecificationSnapshot } from './dialogs/SymbolSpecificationDialog';
import { readSpecificationSectorIndustry } from '../utils/symbolSectorIndustry';
import { normalizeInstrument } from '../features/market-data/marketDataNormalization';
import { updateDynamicUrls } from '../config/api';

const DASH = '—';

const NO_SERVER_SYMBOLS = [
  // Majors
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD',
  // Crosses
  'EURGBP', 'EURJPY', 'GBPJPY', 'AUDCAD', 'CHFJPY', 'EURAUD',
  // Metals
  'XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD', 'XAUEUR', 'GOLD',
  // Energies
  'OIL', 'USOIL', 'UKOIL', 'BRENT', 'WTI', 'XTIUSD', 'NGAS',
  // Crypto
  'BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'LTCUSD', 'DOGEUSD',
  // Indices
  'NAS100', 'SPX500', 'US30', 'US500', 'GER40', 'UK100', 'JP225',
  // Stocks
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN',
  // Suffixes, lowercase, unknown (distinct after normalizeInstrument uppercasing)
  'EURUSD.m', 'XAUUSD_i', 'adausd', 'dotusd.raw', 'audnzd_c', 'UNKNOWN_999', 'FOO.BAR',
] as const;

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

const catalogRows = () => within(screen.getByRole('table', { name: 'Available symbols' })).getAllByRole('row').slice(1);

const readSpecCell = (label: string): string | null | undefined => {
  const spec = screen.getByRole('table', { name: 'Contract specification' });
  const row = within(spec).getByText(label).closest('tr');
  return row?.querySelectorAll('td')[1]?.textContent;
};

const readSectorAndIndustry = () => [readSpecCell('Sector'), readSpecCell('Industry')];

describe('SymbolsDialog P20A tester verification (no guesses anywhere)', () => {
  beforeEach(() => {
    vi.stubGlobal('__RTX_RUNTIME_CONFIG__', {
      CONFIG_SOURCE: 'deployment',
      API_HOST: 'https://broker.example',
      WS_HOST: 'wss://broker.example',
      BROKER_ID: 'test-broker',
      DEFAULT_MT5_SERVER: 'Test Broker-Live',
    });
    updateDynamicUrls();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    updateDynamicUrls();
  });

  it('exported readSpecificationSectorIndustry never throws on invalid/primitive inputs', () => {
    expect(typeof readSpecificationSectorIndustry).toBe('function');

    const circular: Record<string, unknown> = {};
    circular.brokerSpecification = circular;

    for (const input of [undefined, null, 'EURUSD', 123, [], true, false, circular]) {
      expect(() => readSpecificationSectorIndustry(input)).not.toThrow();
      expect(readSpecificationSectorIndustry(input)).toEqual({ sector: null, industry: null });
    }
  });

  it('renders the empty mark for 51 symbol names with no server values on the menu opener', () => {
    expect(NO_SERVER_SYMBOLS.length).toBeGreaterThanOrEqual(40);
    const rawRows = NO_SERVER_SYMBOLS.map(symbol => ({ symbol, digits: 5 }));

    renderMenu(rawRows, NO_SERVER_SYMBOLS[0]);
    const menuRows = catalogRows();
    expect(menuRows).toHaveLength(NO_SERVER_SYMBOLS.length);
    for (let i = 0; i < menuRows.length; i += 1) {
      fireEvent.click(menuRows[i]);
      expect(readSectorAndIndustry()).toEqual([DASH, DASH]);
    }
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it('renders the empty mark for 51 symbol names with no server values on the picker opener (normalizeInstrument)', () => {
    const rawRows = NO_SERVER_SYMBOLS.map(symbol => ({ symbol, digits: 5 }));
    const pickerRows = rawRows.map(row => normalizeInstrument(row)).filter(Boolean);
    expect(pickerRows).toHaveLength(NO_SERVER_SYMBOLS.length);

    renderPicker(pickerRows, NO_SERVER_SYMBOLS[0]);
    const pickerTableRows = catalogRows();
    expect(pickerTableRows).toHaveLength(NO_SERVER_SYMBOLS.length);
    for (let i = 0; i < pickerTableRows.length; i += 1) {
      fireEvent.click(pickerTableRows[i]);
      expect(readSectorAndIndustry()).toEqual([DASH, DASH]);
    }
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it('renders the empty mark for 51 symbol names with no server values on the picker opener (bare { symbol } rows)', () => {
    const bareRows = NO_SERVER_SYMBOLS.map(symbol => ({ symbol }));

    renderPicker(bareRows, NO_SERVER_SYMBOLS[0]);
    const bareTableRows = catalogRows();
    expect(bareTableRows).toHaveLength(NO_SERVER_SYMBOLS.length);
    for (let i = 0; i < bareTableRows.length; i += 1) {
      fireEvent.click(bareTableRows[i]);
      expect(readSectorAndIndustry()).toEqual([DASH, DASH]);
    }
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);

  it('matches SymbolSpecificationDialog snapshot for server values across top-level, nested, conflicting, and fallback-key cases on both openers', () => {
    const serverCases: Array<{ name: string; raw: Record<string, unknown>; expected: [string, string] }> = [
      {
        name: 'top-level exact',
        raw: { symbol: 'AAPL', sector: 'Technology', industry: 'Consumer Electronics' },
        expected: ['Technology', 'Consumer Electronics'],
      },
      {
        name: 'top-level trimmed',
        raw: { symbol: 'NVDA', sector: '  Technology  ', industry: '\tSemiconductors\n' },
        expected: ['Technology', 'Semiconductors'],
      },
      {
        name: 'nested only (brokerSpecification)',
        raw: { symbol: 'XAUUSD', brokerSpecification: { sector: 'Commodities', industry: 'Precious Metals' } },
        expected: ['Commodities', 'Precious Metals'],
      },
      {
        name: 'nested only (specification)',
        raw: { symbol: 'WTI', specification: { sector_name: 'Energy', industryName: 'Crude Oil' } },
        expected: ['Energy', 'Crude Oil'],
      },
      {
        name: 'nested only (metadata/details)',
        raw: { symbol: 'BTCUSD', metadata: { sector: 'Digital Assets' }, details: { industry: 'Crypto Spot' } },
        expected: ['Digital Assets', 'Crypto Spot'],
      },
      {
        name: 'conflicting top-level vs nested (nested wins)',
        raw: {
          symbol: 'EURUSD',
          sector: 'TopLevelSector',
          industry: 'TopLevelIndustry',
          brokerSpecification: { sector: 'NestedSector', industry: 'NestedIndustry' },
        },
        expected: ['NestedSector', 'NestedIndustry'],
      },
      {
        name: 'conflicting depth-1 vs depth-2 (depth-2 wins)',
        raw: {
          symbol: 'SPX500',
          brokerSpecification: {
            sector: 'Depth1Sector',
            specification: { sector: 'Depth2Sector', industry: 'Depth2Industry' },
          },
        },
        expected: ['Depth2Sector', 'Depth2Industry'],
      },
      {
        name: 'empty-then-alternate key',
        raw: { symbol: 'MSFT', sector: '', sector_name: 'Technology', industry: '', industryName: 'Software' },
        expected: ['Technology', 'Software'],
      },
      {
        name: 'whitespace-then-alternate key (whitespace decides -> dash)',
        raw: { symbol: 'TSLA', sector: '   ', sector_name: 'Automotive', industry: ' ', industry_name: 'EV' },
        expected: [DASH, DASH],
      },
      {
        name: 'number-then-alternate key (non-string decides -> dash)',
        raw: { symbol: 'AMZN', sector: 7, sector_name: 'Retail', industry: 99, industry_name: 'E-Commerce' },
        expected: [DASH, DASH],
      },
      {
        name: 'null top-level then nested',
        raw: { symbol: 'GER40', sector: null, industry: null, contract: { sector: 'Indices', industry: 'European' } },
        expected: ['Indices', 'European'],
      },
      {
        name: 'normalized SYMBOL_SECTOR and SYMBOL_INDUSTRY keys',
        raw: { symbol: 'UK100', SYMBOL_SECTOR: 'Equities', SYMBOL_INDUSTRY: 'Broad Market' },
        expected: ['Equities', 'Broad Market'],
      },
      {
        name: 'sector only, industry absent',
        raw: { symbol: 'JPM', sector: 'Financials' },
        expected: ['Financials', DASH],
      },
      {
        name: 'industry only, sector absent',
        raw: { symbol: 'XOM', industry: 'Integrated Oil & Gas' },
        expected: [DASH, 'Integrated Oil & Gas'],
      },
    ];

    for (const testCase of serverCases) {
      const symbol = String(testCase.raw.symbol);
      const snap = buildSymbolSpecificationSnapshot(testCase.raw);
      const expectedDisplay = [snap.sector ?? DASH, snap.industry ?? DASH];

      expect(expectedDisplay, `${testCase.name} (snapshot)`).toEqual(testCase.expected);
      expect(readSpecificationSectorIndustry(testCase.raw)).toEqual({
        sector: snap.sector,
        industry: snap.industry,
      });

      const menu = renderMenu([testCase.raw], symbol);
      expect(readSectorAndIndustry(), `${testCase.name} (menu)`).toEqual(testCase.expected);
      menu.unmount();

      const pickerRow = normalizeInstrument(testCase.raw);
      expect(pickerRow).not.toBeNull();
      const picker = renderPicker([pickerRow], symbol);
      expect(readSectorAndIndustry(), `${testCase.name} (picker)`).toEqual(testCase.expected);
      picker.unmount();
    }

    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);
});
