import type { ComponentProps } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolboxTradePosition } from '../../../hooks/useToolboxTradeData';
import { resetLiveQuotesForTests, setLiveQuote } from '../../../services/liveQuotes';
import { TradeTable } from './TradeTable';
import { DEFAULT_TRADE_COLUMN_WIDTHS, TRADE_COLUMN_DEFS } from './tradeTabModel';

vi.mock('../../../hooks/useUiTranslation', () => ({
  useUiTranslation: () => (source: string, values?: Record<string, unknown>) => source.replace(
    /\{\{(\w+)\}\}/g, (_, key: string) => String(values?.[key] ?? ''),
  ),
}));
vi.mock('../../../components/ui/Icon', () => ({ Icon: () => null }));

const makePosition = (ticket: number): ToolboxTradePosition => ({
  id: ticket, ticket, symbol: 'EURUSD', side: 'BUY', volume: 0.01,
  price_open: 1.08, openPrice: 1.08, price_current: 1.08, currentPrice: 1.08,
  profit: 0, hasBackendProfit: true, hasBackendCurrentPrice: true, contractSize: 100000,
  price_sl: 0, price_tp: 0, sl: 0, tp: 0, time_create: '2026-10-09T10:00:00Z',
} as ToolboxTradePosition);

// Newest ticket first, like the Trade tab.
const makeList = (count: number): ToolboxTradePosition[] => (
  Array.from({ length: count }, (_, index) => makePosition(1000 + count - 1 - index))
);

const createProps = (positions: ToolboxTradePosition[]): ComponentProps<typeof TradeTable> => ({
  account: { currency: 'USD', balance: 1000, equity: 1000, margin: 10, freeMargin: 990, marginLevel: 10000, unrealizedPL: 0 } as unknown as ComponentProps<typeof TradeTable>['account'],
  columnWidths: DEFAULT_TRADE_COLUMN_WIDTHS,
  displayedLivePositions: positions,
  metricsPositions: positions,
  metricsNow: 0,
  totalSwap: 0,
  totalCommission: 0,
  openCount: positions.length,
  formatMarginLevel: value => String(value),
  error: null,
  footerCloseColumnWidth: '32px',
  footerMetricMenuOpen: false,
  footerProfitColumnWidth: '92px',
  formatMoney: value => Number(value ?? 0).toFixed(2),
  formatTradeLevel: value => Number(value) > 0 ? String(value) : '-',
  formatTradePoints: () => '10',
  formatTradePrice: value => String(value),
  formatTradeTime: value => String(value ?? '-'),
  formatTradeVolume: position => position.volume,
  getPositionKey: position => String(position.id),
  getTradePointsValue: () => null,
  handleTradeContextMenu: vi.fn(),
  isColumnVisible: () => true,
  loading: false,
  onClosePosition: vi.fn(),
  openModifyPosition: vi.fn(),
  profitMode: 'money',
  resizingColumn: null,
  selectedPositionKey: null,
  setColumnWidths: vi.fn(),
  setSelectedPositionKey: vi.fn(),
  sortState: null,
  startColumnResize: vi.fn(),
  toggleFooterMetricMenu: vi.fn(),
  toggleSort: vi.fn(),
  visibleFooterMetrics: [],
  visibleOptionalColumnCount: TRADE_COLUMN_DEFS.length,
  visibleTradeColumns: TRADE_COLUMN_DEFS,
  visibleTradeTableWidth: 1400,
});

const renderedRowCount = (container: HTMLElement) => container.querySelectorAll('tbody tr.rtx-trade-row').length;

const scrollTo = (container: HTMLElement, top: number) => {
  const scroller = container.querySelector('.rtx-trade-scroll') as HTMLDivElement;
  Object.defineProperty(scroller, 'clientHeight', { value: 900, configurable: true });
  act(() => {
    scroller.scrollTop = top;
    fireEvent.scroll(scroller);
  });
};

describe('TradeTable row windowing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLiveQuotesForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders every row below the threshold without spacers', () => {
    const view = render(<TradeTable {...createProps(makeList(100))} />);
    expect(renderedRowCount(view.container)).toBe(100);
    expect(view.container.querySelector('[data-rtx-spacer]')).toBeNull();
  });

  it('renders only the visible window of a long list, with spacers keeping the scroll height', () => {
    const view = render(<TradeTable {...createProps(makeList(1000))} />);
    const count = renderedRowCount(view.container);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(80);
    const bottomSpacer = view.container.querySelector('tbody tr[data-rtx-spacer]:last-child') as HTMLElement;
    expect(bottomSpacer).not.toBeNull();
    // Real rows are 30 px; the spacer stands for every row that is not rendered.
    expect(parseFloat(bottomSpacer.style.height)).toBeCloseTo((1000 - count) * 30, 0);
  });

  it('moves the window when the container scrolls', () => {
    const view = render(<TradeTable {...createProps(makeList(1000))} />);
    scrollTo(view.container, 600 * 30);
    const rows = Array.from(view.container.querySelectorAll('tbody tr.rtx-trade-row'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(80);
    // Row 600 of a list whose ticket 1999 is first is ticket 1399.
    expect(rows.some((row) => row.textContent?.includes('1399'))).toBe(true);
    expect(rows.some((row) => row.textContent?.includes('1999'))).toBe(false);
  });

  it('clamps the window when the list shrinks while scrolled (never renders an empty table)', () => {
    const props = createProps(makeList(1000));
    const view = render(<TradeTable {...props} />);
    scrollTo(view.container, 950 * 30);
    expect(renderedRowCount(view.container)).toBeGreaterThan(0);

    // Close 800 of 1000 trades: 200 rows remain, still windowed, scroll position is now past the end.
    const shrunk = makeList(200);
    view.rerender(<TradeTable {...props} displayedLivePositions={shrunk} metricsPositions={shrunk} openCount={200} />);
    const rows = Array.from(view.container.querySelectorAll('tbody tr.rtx-trade-row'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1].textContent).toContain('1000');

    // Shrink below the window threshold: all rows render, no spacers.
    const small = makeList(50);
    view.rerender(<TradeTable {...props} displayedLivePositions={small} metricsPositions={small} openCount={50} />);
    expect(renderedRowCount(view.container)).toBe(50);
    expect(view.container.querySelector('[data-rtx-spacer]')).toBeNull();

    view.rerender(<TradeTable {...props} displayedLivePositions={[]} metricsPositions={[]} openCount={0} />);
    expect(renderedRowCount(view.container)).toBe(0);
    expect(view.container.querySelector('.rtx-trade-empty-state')).not.toBeNull();
  });

  it('applies the latest quote to the visible rows at render time without new props', () => {
    const props = createProps(makeList(300));
    const view = render(<TradeTable {...props} />);
    expect(view.container.querySelector('tbody tr.rtx-trade-row')?.textContent).toContain('1.08');
    act(() => {
      setLiveQuote({ symbol: 'EURUSD', bid: 1.0901, ask: 1.0903 });
      vi.advanceTimersByTime(150);
    });
    const firstRow = view.container.querySelector('tbody tr.rtx-trade-row') as HTMLElement;
    // 0.01 lot x 100000 x (1.0901 - 1.08) = 10.10
    expect(firstRow.textContent).toContain('1.0901');
    expect(firstRow.textContent).toContain('10.10');
  });

  it('keeps the live footer equal to the sum of all positions, including those outside the window', () => {
    const props = createProps(makeList(400));
    const view = render(<TradeTable {...props} />);
    act(() => {
      setLiveQuote({ symbol: 'EURUSD', bid: 1.0801, ask: 1.0803 });
      vi.advanceTimersByTime(150);
    });
    // 400 trades x 0.01 lot x 100000 x 0.0001 = 40.00 (exact, not per-row rounded)
    expect(view.container.querySelector('.rtx-trade-footer-floating')).toHaveTextContent('40.00USD');
  });

  it('keeps the scroll-container context menu', () => {
    const props = createProps(makeList(300));
    const view = render(<TradeTable {...props} />);
    const scroller = view.container.querySelector('.rtx-trade-scroll') as HTMLDivElement;
    fireEvent.contextMenu(scroller);
    expect(props.handleTradeContextMenu).toHaveBeenCalledTimes(1);
    expect((props.handleTradeContextMenu as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBeUndefined();
  });

  it('does not measure layout while quotes arrive', () => {
    const view = render(<TradeTable {...createProps(makeList(300))} />);
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(30);
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        setLiveQuote({ symbol: 'EURUSD', bid: 1.081 + i / 10000, ask: 1.0812 + i / 10000 });
        vi.advanceTimersByTime(150);
      });
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    view.unmount();
  });
});
