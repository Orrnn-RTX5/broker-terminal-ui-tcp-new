import { describe, expect, it } from 'vitest';
import {
  DARK_CHART_TRADE_COLORS,
  LIGHT_CHART_TRADE_COLORS,
} from '../../../utils/chartTradeControls';
import {
  getEntryLineColor,
  TRADE_ENTRY_LINE_BUY_COLOR,
  TRADE_ENTRY_LINE_SELL_COLOR,
  TRADE_PENDING_BUY_LINE_COLOR,
  TRADE_PENDING_SELL_LINE_COLOR,
} from './tradeOverlayRuntimeConstants';

describe('Pending order chart line and label colors', () => {
  it('uses blue for pending BUY orders and red for pending SELL orders', () => {
    expect(TRADE_PENDING_BUY_LINE_COLOR).toBe('#2962ff');
    expect(TRADE_PENDING_SELL_LINE_COLOR).toBe('#ef4444');
    expect(getEntryLineColor('BUY', 'pending')).toBe(TRADE_ENTRY_LINE_BUY_COLOR);
    expect(getEntryLineColor('SELL', 'pending')).toBe(TRADE_ENTRY_LINE_SELL_COLOR);
    expect(DARK_CHART_TRADE_COLORS.pendingBuy).toBe(DARK_CHART_TRADE_COLORS.buy);
    expect(DARK_CHART_TRADE_COLORS.pendingSell).toBe(DARK_CHART_TRADE_COLORS.sell);
    expect(LIGHT_CHART_TRADE_COLORS.pendingBuy).toBe(LIGHT_CHART_TRADE_COLORS.buy);
    expect(LIGHT_CHART_TRADE_COLORS.pendingSell).toBe(LIGHT_CHART_TRADE_COLORS.sell);
  });
});
