// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTradingChartTradeRuntime } from './useTradingChartTradeRuntime';

vi.mock('./useTradingChartTradeOverlayRenderer', () => ({ useTradingChartTradeOverlayRenderer: vi.fn() }));
vi.mock('./useTradingChartTradeLevelDrag', () => ({ useTradingChartTradeLevelDrag: vi.fn() }));
vi.mock('../../../services/drawingManager', () => ({ drawingManager: {} }));

const ref = <T,>(current: T) => ({ current });

const ro = vi.hoisted(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

let frames: FrameRequestCallback[] = [];
const flushFrames = async () => {
  // MutationObserver callbacks are microtasks; let them queue their frame first.
  await Promise.resolve();
  await Promise.resolve();
  let guard = 0;
  while (frames.length > 0 && guard++ < 50) frames.shift()!(16);
};

beforeEach(() => {
  frames = [];
  ro.observe.mockClear();
  ro.unobserve.mockClear();
  ro.disconnect.mockClear();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  vi.stubGlobal('ResizeObserver', class {
    observe(...args: unknown[]) { ro.observe(...args); }
    unobserve(...args: unknown[]) { ro.unobserve(...args); }
    disconnect() { ro.disconnect(); }
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const mount = () => {
  const wrapper = document.createElement('div');
  const container = document.createElement('div');
  const overlay = document.createElement('div');
  wrapper.append(container, overlay);
  document.body.append(wrapper);
  const options = {
    activeChartSourceId: 'chart-a', brokerAccountSessionScope: 'account-a', symbol: 'EURUSD', timeframe: 'M1',
    activeTradeSnapshotsRef: ref(new Map()), containerRef: ref(container), overlayRef: ref(overlay),
    candlesRef: ref([]), currentCandleRef: ref(null), candlesLoadedRev: 0,
    chartRef: ref({ timeScale: () => ({ height: () => 20, getVisibleLogicalRange: () => null, timeToCoordinate: () => null }) }),
    seriesRef: ref({ priceScale: () => ({ width: () => 60 }), priceToCoordinate: () => 100 }),
    chartSettingsRef: ref({ showBidPriceLine: false }), postInteractionCallbacksRef: ref({}),
    hideLivePriceOverlay: vi.fn(),
    repaintTradeOverlayGeometryRef: ref(() => undefined), tr: <T,>(source: T) => source,
  } as unknown as Parameters<typeof useTradingChartTradeRuntime>[0];
  const view = renderHook(() => useTradingChartTradeRuntime(options));
  return { wrapper, view };
};

const control = () => {
  const el = document.createElement('div');
  el.className = 'rtx-trade-controls';
  return el;
};
const observedControls = () => ro.observe.mock.calls
  .map(([element]) => element as HTMLElement)
  .filter((element) => element.classList?.contains('rtx-trade-controls'));

describe('trade controls ResizeObserver bookkeeping', () => {
  it('observes only the newly added control and never disconnects while trades open and close', async () => {
    const { wrapper, view } = mount();
    await flushFrames();
    const initial = Array.from({ length: 100 }, control);
    wrapper.append(...initial);
    await flushFrames();
    expect(observedControls()).toHaveLength(100);
    expect(ro.disconnect).not.toHaveBeenCalled();

    // Trade #101 opens: exactly one more observe call, no disconnect, no re-observe of the other 100.
    ro.observe.mockClear();
    const opened = control();
    wrapper.append(opened);
    await flushFrames();
    expect(ro.observe).toHaveBeenCalledTimes(1);
    expect(ro.observe.mock.calls[0][0]).toBe(opened);
    expect(ro.disconnect).not.toHaveBeenCalled();
    expect(ro.unobserve).not.toHaveBeenCalled();

    // A trade closes: only that control is unobserved.
    ro.observe.mockClear();
    initial[7].remove();
    await flushFrames();
    expect(ro.unobserve).toHaveBeenCalledTimes(1);
    expect(ro.unobserve.mock.calls[0][0]).toBe(initial[7]);
    expect(ro.observe).not.toHaveBeenCalled();
    expect(ro.disconnect).not.toHaveBeenCalled();

    // Real teardown disconnects once.
    view.unmount();
    expect(ro.disconnect).toHaveBeenCalledTimes(1);
  });
});
