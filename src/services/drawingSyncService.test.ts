// @vitest-environment jsdom

import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChartObjectStateStore } from '../store/useChartObjectStateStore';
import { DRAWING_SYNC_CLIENT_ID, drawingApi } from './drawingApi';
import { drawingManager } from './drawingManager';
import { drawingSyncService } from './drawingSyncService';

const createMockChart = () => {
  const timeScale = {
    timeToCoordinate: (time: number) => Number(time) - 100,
    coordinateToTime: (coordinate: number) => coordinate + 100,
    logicalToCoordinate: (logical: number) => logical,
    coordinateToLogical: (coordinate: number) => coordinate,
    height: () => 20,
  };
  const chart = {
    timeScale: () => timeScale,
    priceScale: () => ({ width: () => 40 }),
  } as unknown as IChartApi;
  const series = {
    priceToCoordinate: (price: number) => 220 - price,
    coordinateToPrice: (coordinate: number) => 220 - coordinate,
    data: () => [],
  } as unknown as ISeriesApi<'Candlestick'>;
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 600 });
  Object.defineProperty(container, 'clientHeight', { value: 360 });
  document.body.appendChild(container);
  return { chart, series, container };
};

describe('drawingSyncService real-time multi-device sync', () => {
  let harnessA: ReturnType<typeof createMockChart>;
  let harnessB: ReturnType<typeof createMockChart>;

  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    sessionStorage.clear();
    useChartObjectStateStore.setState({ byContext: {} });
    vi.spyOn(drawingApi, 'loadDrawingState').mockResolvedValue({
      drawings: [],
      authoritative: false,
    });
    vi.spyOn(drawingApi, 'saveDrawing').mockResolvedValue('server-id');
    vi.spyOn(drawingApi, 'deleteDrawing').mockResolvedValue(undefined);
    vi.spyOn(drawingApi, 'clearDrawings').mockResolvedValue(undefined);
    vi.spyOn(drawingApi, 'setDrawingsVisibility').mockResolvedValue({ success: true });

    harnessA = createMockChart();
    harnessB = createMockChart();
    drawingManager.setChart(
      harnessA.chart,
      harnessA.series,
      'EURUSD',
      1,
      harnessA.container,
      'M1',
      'chart-eurusd-m1',
      'orrnn::200010',
    );
    drawingManager.setChart(
      harnessB.chart,
      harnessB.series,
      'BTCUSD',
      1,
      harnessB.container,
      'M1',
      'chart-btcusd-m1',
      'orrnn::200010',
    );
  });

  afterEach(() => {
    drawingManager.setChart(null, null, null, 1, harnessA.container);
    drawingManager.setChart(null, null, null, 1, harnessB.container);
    drawingManager.resetLoadedContexts();
    drawingSyncService.stop();
    vi.restoreAllMocks();
  });

  it('streams remote upsert, update, visibility hide/show, delete, and clear without HTTP echo', () => {
    // 1. Remote device draws a horizontal line on EURUSD M1
    drawingSyncService.handleMessage({
      type: 'drawing_upsert',
      brokerId: 'orrnn',
      accountLogin: 200010,
      revision: 1,
      originClientId: 'other-device-1',
      drawing: {
        id: 'remote-hline-1',
        type: 'hline',
        symbol: 'EURUSD',
        timeframe: 'M1',
        userId: '200010',
        properties: {
          id: 'remote-hline-1',
          points: [{ time: 1700000100, price: 1.095 }],
          color: '#22c55e',
          lineWidth: 2,
          lineStyle: 'solid',
        },
        createdAt: '2026-11-19T05:00:00Z',
        updatedAt: '2026-11-19T05:00:00Z',
      },
    });

    expect(drawingManager.getDrawings('chart-eurusd-m1')).toEqual([
      expect.objectContaining({
        id: 'remote-hline-1',
        serverId: 'remote-hline-1',
        type: 'hline',
        color: '#22c55e',
      }),
    ]);
    // Unrelated symbol panel stays untouched
    expect(drawingManager.getDrawings('chart-btcusd-m1')).toHaveLength(0);
    // Remote sync must not echo back to saveDrawing
    expect(drawingApi.saveDrawing).not.toHaveBeenCalled();

    // 2. Remote device hides drawings account-wide -> hides across every chart logged into 200010
    drawingSyncService.handleMessage({
      type: 'drawing_visibility',
      brokerId: 'orrnn',
      accountLogin: 200010,
      revision: 2,
      originClientId: 'other-device-1',
      symbol: 'EURUSD',
      timeframe: 'M1',
      accountWide: true,
      drawingsHidden: true,
    });
    expect(useChartObjectStateStore.getState().byContext['chart-eurusd-m1']?.drawingsHidden).toBe(true);
    expect(useChartObjectStateStore.getState().byContext['chart-btcusd-m1']?.drawingsHidden).toBe(true);

    // 3. Remote device shows drawings again
    drawingSyncService.handleMessage({
      type: 'drawing_visibility',
      brokerId: 'orrnn',
      accountLogin: 200010,
      revision: 3,
      originClientId: 'other-device-1',
      symbol: 'EURUSD',
      timeframe: 'M1',
      accountWide: true,
      drawingsHidden: false,
    });
    expect(useChartObjectStateStore.getState().byContext['chart-eurusd-m1']?.drawingsHidden).toBe(false);
    expect(useChartObjectStateStore.getState().byContext['chart-btcusd-m1']?.drawingsHidden).toBe(false);

    // 4. Self-origin echo is ignored cleanly
    drawingSyncService.handleMessage({
      type: 'drawing_delete',
      brokerId: 'orrnn',
      accountLogin: 200010,
      revision: 4,
      originClientId: DRAWING_SYNC_CLIENT_ID,
      drawingId: 'remote-hline-1',
      symbol: 'EURUSD',
      timeframe: 'M1',
    });
    expect(drawingManager.getDrawings('chart-eurusd-m1')).toHaveLength(1);

    // 5. Remote delete removes drawing immediately
    drawingSyncService.handleMessage({
      type: 'drawing_delete',
      brokerId: 'orrnn',
      accountLogin: 200010,
      revision: 5,
      originClientId: 'other-device-2',
      drawingId: 'remote-hline-1',
      symbol: 'EURUSD',
      timeframe: 'M1',
    });
    expect(drawingManager.getDrawings('chart-eurusd-m1')).toHaveLength(0);
    expect(drawingApi.deleteDrawing).not.toHaveBeenCalled();
  });

  it('hydrates charts and hidden visibility from initial drawing_snapshot frame', () => {
    drawingSyncService.handleMessage({
      type: 'drawing_snapshot',
      brokerId: 'orrnn',
      accountLogin: 200010,
      revision: 7,
      hiddenMap: { 'EURUSD::M1': true, '*': true },
      drawings: [
        {
          id: 'snap-tl-1',
          type: 'trendline',
          symbol: 'EURUSD',
          timeframe: 'M1',
          userId: '200010',
          properties: {
            id: 'snap-tl-1',
            points: [
              { time: 1700000100, price: 1.09 },
              { time: 1700000200, price: 1.10 },
            ],
            color: '#3b82f6',
          },
          createdAt: '2026-11-19T05:00:00Z',
          updatedAt: '2026-11-19T05:00:00Z',
        },
      ],
    });

    expect(drawingManager.getDrawings('chart-eurusd-m1')).toEqual([
      expect.objectContaining({ id: 'snap-tl-1', type: 'trendline' }),
    ]);
    expect(useChartObjectStateStore.getState().byContext['chart-eurusd-m1']?.drawingsHidden).toBe(true);
  });
});
