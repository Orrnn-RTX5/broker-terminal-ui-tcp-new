import { describe, expect, it, vi } from 'vitest';
import {
  CHART_GRID_DASH_PATTERN_CSS_PX,
  CHART_GRID_STROKE_CSS_PX,
  FINE_CHART_GRID_DASH_PATTERN_CSS_PX,
  FINE_CHART_GRID_OPACITY,
  FINE_CHART_GRID_STROKE_CSS_PX,
  SQUARE_CHART_GRID_CELL_SIZE_PX,
  FINE_CHART_GRID_CELL_SIZE_PX,
  SquareChartGridPrimitive,
  getSquareGridLinePositions,
  getFineGridHorizontalPositions,
  getSquareGridTimeAxisPositions,
  resolveFineGridBitmapDash,
  resolveFineGridBitmapOpacity,
  resolveFineGridBitmapStroke,
} from './squareChartGridPrimitive';

describe('square chart grid geometry', () => {
  it('uses the same fixed pitch for both axes', () => {
    const horizontal = getSquareGridLinePositions(420, SQUARE_CHART_GRID_CELL_SIZE_PX);
    const vertical = getSquareGridLinePositions(290, SQUARE_CHART_GRID_CELL_SIZE_PX);

    expect(horizontal).toEqual([64, 128, 192, 256, 320, 384]);
    expect(vertical).toEqual([64, 128, 192, 256]);
  });

  it('returns no geometry for an invalid extent', () => {
    expect(getSquareGridLinePositions(0)).toEqual([]);
    expect(getSquareGridLinePositions(Number.NaN)).toEqual([]);
  });

  it('uses twice the guide density for the Fine profile', () => {
    expect(getSquareGridLinePositions(150, FINE_CHART_GRID_CELL_SIZE_PX)).toEqual([32, 64, 96, 128]);
  });

  it('anchors Fine horizontal rows to the bottom when the pane is resized', () => {
    expect(getFineGridHorizontalPositions(150)).toEqual([21, 53, 85, 117, 149]);
    expect(getFineGridHorizontalPositions(160)).toEqual([31, 63, 95, 127, 159]);
    expect(getFineGridHorizontalPositions(Number.NaN)).toEqual([]);
  });

  it('clamps unsafe cell sizes to a professional readable range', () => {
    expect(getSquareGridLinePositions(100, 2)).toEqual([24, 48, 72, 96]);
    expect(getSquareGridLinePositions(350, 500)).toEqual([160, 320]);
  });

  it('computes MT5 grid-aligned time axis tick positions starting at x=0 with 64px intervals', () => {
    expect(getSquareGridTimeAxisPositions(320, SQUARE_CHART_GRID_CELL_SIZE_PX, 'square')).toEqual([0, 64, 128, 192, 256]);
    expect(getSquareGridTimeAxisPositions(320, FINE_CHART_GRID_CELL_SIZE_PX, 'fine')).toEqual([0, 64, 128, 192, 256]);
    expect(getSquareGridTimeAxisPositions(0)).toEqual([]);
  });
});

describe('SquareChartGridPrimitive', () => {
  const createDrawTarget = (horizontalPixelRatio = 1, verticalPixelRatio = 1) => {
    const strokeWidths: number[] = [];
    const strokeAlphas: number[] = [];
    const context = {
      save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      stroke: vi.fn(() => {
        strokeWidths.push(context.lineWidth);
        strokeAlphas.push(context.globalAlpha);
      }),
      lineWidth: 1, lineCap: 'butt', lineDashOffset: 0, strokeStyle: '', globalAlpha: 1,
    };
    return {
      context,
      strokeWidths,
      strokeAlphas,
      target: {
        useBitmapCoordinateSpace: (draw: (scope: unknown) => void) => draw({
          context,
          bitmapSize: { width: 150 * horizontalPixelRatio, height: 150 * verticalPixelRatio },
          horizontalPixelRatio,
          verticalPixelRatio,
        }),
      },
    };
  };

  it.each([[1, 1], [2, 2], [2, 1]])('draws crisp 1px micro-dotted segments at pixel ratios %s/%s', (horizontalPixelRatio, verticalPixelRatio) => {
    const primitive = new SquareChartGridPrimitive({
      visible: true, cellSizeCssPx: 64,
      verticalColor: '#222', horizontalColor: '#333',
    });
    const { context, target, strokeWidths } = createDrawTarget(horizontalPixelRatio, verticalPixelRatio);
    primitive.paneViews()[0]!.renderer()!.draw(target as never);

    expect(context.setLineDash.mock.calls).toEqual([
      [[CHART_GRID_DASH_PATTERN_CSS_PX[0] * verticalPixelRatio, CHART_GRID_DASH_PATTERN_CSS_PX[1] * verticalPixelRatio]],
      [[CHART_GRID_DASH_PATTERN_CSS_PX[0] * horizontalPixelRatio, CHART_GRID_DASH_PATTERN_CSS_PX[1] * horizontalPixelRatio]],
    ]);
    expect(strokeWidths).toEqual([
      CHART_GRID_STROKE_CSS_PX * horizontalPixelRatio,
      CHART_GRID_STROKE_CSS_PX * verticalPixelRatio,
    ]);
    expect(context.stroke).toHaveBeenCalledTimes(2);
    expect(context.moveTo).toHaveBeenCalledTimes(4);
    expect(context.save).toHaveBeenCalledOnce();
    expect(context.restore).toHaveBeenCalledOnce();
  });

  it('clears the dash pattern when switching to solid, keeps the thin stroke, and stops drawing while hidden', () => {
    const primitive = new SquareChartGridPrimitive({
      visible: true, lineStyle: 'dashed', cellSizeCssPx: 64,
      verticalColor: '#222', horizontalColor: '#333',
    });
    const requestUpdate = vi.fn();
    primitive.attached({ requestUpdate } as never);
    primitive.applyOptions({ lineStyle: 'solid' });
    const { context, target } = createDrawTarget();
    primitive.paneViews()[0]!.renderer()!.draw(target as never);
    expect(context.setLineDash.mock.calls).toEqual([[[]], [[]]]);
    expect(context.lineWidth).toBe(CHART_GRID_STROKE_CSS_PX);
    expect(requestUpdate).toHaveBeenCalledOnce();

    context.stroke.mockClear();
    primitive.applyOptions({ visible: false });
    primitive.paneViews()[0]!.renderer()!.draw(target as never);
    expect(context.stroke).not.toHaveBeenCalled();
  });

  it('does not halve Fine solid grid opacity with the dashed dot multiplier', () => {
    const primitive = new SquareChartGridPrimitive({
      visible: true,
      lineStyle: 'solid',
      profile: 'fine',
      cellSizeCssPx: FINE_CHART_GRID_CELL_SIZE_PX,
      verticalColor: '#778899',
      horizontalColor: '#778899',
    });
    const { context, target, strokeAlphas } = createDrawTarget(1, 1);
    primitive.paneViews()[0]!.renderer()!.draw(target as never);
    expect(context.setLineDash.mock.calls).toEqual([[[]], [[]]]);
    expect(strokeAlphas).toEqual([1, 1]);
  });

  it.each([[1, 1], [1.25, 1.25], [1.5, 1.5], [1.75, 1.75], [2, 2], [2, 1]])('keeps Fine cells, pixel-snapped strokes, crisp MT5 dots, and equal visual opacity across desktop and laptop pixel ratios %s/%s', (horizontalPixelRatio, verticalPixelRatio) => {
    const primitive = new SquareChartGridPrimitive({
      visible: true, lineStyle: 'dashed', cellSizeCssPx: FINE_CHART_GRID_CELL_SIZE_PX,
      profile: 'fine', verticalColor: '#778899', horizontalColor: '#778899',
    });
    const { context, target, strokeWidths, strokeAlphas } = createDrawTarget(horizontalPixelRatio, verticalPixelRatio);
    primitive.paneViews()[0]!.renderer()!.draw(target as never);
    expect(context.setLineDash.mock.calls).toEqual([
      [resolveFineGridBitmapDash(FINE_CHART_GRID_DASH_PATTERN_CSS_PX[0], FINE_CHART_GRID_DASH_PATTERN_CSS_PX[1], verticalPixelRatio)],
      [resolveFineGridBitmapDash(FINE_CHART_GRID_DASH_PATTERN_CSS_PX[0], FINE_CHART_GRID_DASH_PATTERN_CSS_PX[1], horizontalPixelRatio)],
    ]);
    const expectedVerticalStrokeWidth = resolveFineGridBitmapStroke(FINE_CHART_GRID_STROKE_CSS_PX, horizontalPixelRatio);
    const expectedHorizontalStrokeWidth = resolveFineGridBitmapStroke(FINE_CHART_GRID_STROKE_CSS_PX, verticalPixelRatio);
    const expectedVerticalAlpha = resolveFineGridBitmapOpacity(
      FINE_CHART_GRID_OPACITY,
      FINE_CHART_GRID_STROKE_CSS_PX,
      horizontalPixelRatio,
      expectedVerticalStrokeWidth,
    );
    const expectedHorizontalAlpha = resolveFineGridBitmapOpacity(
      FINE_CHART_GRID_OPACITY,
      FINE_CHART_GRID_STROKE_CSS_PX,
      verticalPixelRatio,
      expectedHorizontalStrokeWidth,
    );
    expect(strokeWidths).toEqual([
      expectedVerticalStrokeWidth,
      expectedHorizontalStrokeWidth,
    ]);
    expect(strokeAlphas).toEqual([
      expectedVerticalAlpha,
      expectedHorizontalAlpha,
    ]);
    // Effective CSS ink density (cssStrokeWidth * alpha) must stay equal to Mac 2x / Windows 1x at every Windows scaling factor.
    expect((expectedVerticalStrokeWidth / horizontalPixelRatio) * expectedVerticalAlpha).toBeCloseTo(
      FINE_CHART_GRID_STROKE_CSS_PX * FINE_CHART_GRID_OPACITY,
      3,
    );
    expect((expectedHorizontalStrokeWidth / verticalPixelRatio) * expectedHorizontalAlpha).toBeCloseTo(
      FINE_CHART_GRID_STROKE_CSS_PX * FINE_CHART_GRID_OPACITY,
      3,
    );
    expect(Number.isInteger(expectedVerticalStrokeWidth)).toBe(true);
    expect(Number.isInteger(expectedHorizontalStrokeWidth)).toBe(true);
    expect(context.moveTo).toHaveBeenCalledTimes(9);
    expect(context.moveTo).toHaveBeenCalledWith(
      0,
      Math.round(21 * verticalPixelRatio) + (expectedHorizontalStrokeWidth % 2) / 2,
    );

    // A hot switch must restore the wider Square pitch, thin stroke, and dash pattern.
    primitive.applyOptions({ profile: 'square', cellSizeCssPx: SQUARE_CHART_GRID_CELL_SIZE_PX, dashPatternCssPx: [8, 4] });
    context.moveTo.mockClear();
    context.setLineDash.mockClear();
    strokeWidths.length = 0;
    primitive.paneViews()[0]!.renderer()!.draw(target as never);
    expect(context.moveTo).toHaveBeenCalledTimes(4);
    expect(strokeWidths).toEqual([
      CHART_GRID_STROKE_CSS_PX * horizontalPixelRatio,
      CHART_GRID_STROKE_CSS_PX * verticalPixelRatio,
    ]);
    expect(context.setLineDash.mock.calls).toEqual([
      [[8 * verticalPixelRatio, 4 * verticalPixelRatio]],
      [[8 * horizontalPixelRatio, 4 * horizontalPixelRatio]],
    ]);
  });

  it('labels every Fine row with its actual price and MT5 tick marks and releases the price axis when hidden or switched', () => {
    const labelAt = vi.fn((y: number) => `price ${y}`);
    const primitive = new SquareChartGridPrimitive({
      visible: true, profile: 'fine', cellSizeCssPx: 32,
      verticalColor: '#778899', horizontalColor: '#778899',
    }, { labelAt, appearance: () => ({ color: '#ccc', fontSize: 12, fontFamily: 'Arial' }) });
    const context = { save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), font: '', fillStyle: '', textBaseline: '', textAlign: '' };
    const target = { useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context, mediaSize: { width: 80, height: 150 } }) };
    const pane = primitive.priceAxisPaneViews()[0]!;
    expect(pane.zOrder?.()).toBe('normal'); // live/trade labels paint above these guides
    pane.renderer()!.draw(target as never);
    expect(labelAt.mock.calls).toEqual([[21], [53], [85], [117]]);
    expect(context.fillRect.mock.calls).toEqual([
      [0, 21, 4, 1], [0, 53, 4, 1], [0, 85, 4, 1], [0, 117, 4, 1],
    ]);
    expect(context.fillText.mock.calls).toEqual([
      ['price 21', 8, 21.5], ['price 53', 8, 53.5], ['price 85', 8, 85.5], ['price 117', 8, 117.5],
    ]);
    context.fillRect.mockClear();
    context.fillText.mockClear();
    primitive.applyOptions({ visible: false });
    pane.renderer()!.draw(target as never);
    primitive.applyOptions({ visible: true, profile: 'square' });
    pane.renderer()!.draw(target as never);
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(context.fillText).not.toHaveBeenCalled();
  });

  it('renders in the bottom layer and requests a redraw after option changes', () => {
    const requestUpdate = vi.fn();
    const primitive = new SquareChartGridPrimitive({
      visible: true,
      cellSizeCssPx: SQUARE_CHART_GRID_CELL_SIZE_PX,
      verticalColor: 'rgba(255, 255, 255, 0.10)',
      horizontalColor: 'rgba(255, 255, 255, 0.14)',
    });

    primitive.attached({ requestUpdate } as never);
    const [paneView] = primitive.paneViews();

    expect(paneView?.zOrder?.()).toBe('bottom');
    expect(paneView?.renderer()).toBeTruthy();

    primitive.applyOptions({ visible: false });
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    primitive.detached();
    primitive.applyOptions({ visible: true });
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it('draws MT5 grid-aligned tick marks and left-aligned labels on the time axis when visible', () => {
    const labelAt = vi.fn((x: number, isFirstTick: boolean) =>
      isFirstTick ? '12 Oct 2026' : `12 Oct ${16 + x / 64}:00`,
    );
    const timeKeyAt = vi.fn((x: number) => `t-${x}`);
    const primitive = new SquareChartGridPrimitive(
      {
        visible: true,
        profile: 'fine',
        cellSizeCssPx: FINE_CHART_GRID_CELL_SIZE_PX,
        verticalColor: '#778899',
        horizontalColor: '#778899',
      },
      undefined,
      {
        labelAt,
        timeKeyAt,
        appearance: () => ({
          color: '#cccccc',
          fontSize: 11,
          fontFamily: 'Arial',
          backgroundColor: '#000000',
          borderColor: '#555555',
        }),
      },
    );
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 5 })),
      font: '',
      fillStyle: '',
      textBaseline: '',
      textAlign: '',
    };
    const target = {
      useMediaCoordinateSpace: (draw: (scope: unknown) => void) =>
        draw({ context, mediaSize: { width: 220, height: 26 } }),
    };

    const timePane = primitive.timeAxisPaneViews()[0]!;
    expect(timePane.zOrder?.()).toBe('normal');
    timePane.renderer()!.draw(target as never);

    expect(labelAt.mock.calls).toEqual([
      [0, true],
      [64, false],
      [128, false],
      [192, false],
    ]);
    expect(context.fillText.mock.calls).toEqual([
      ['12 Oct 2026', 2, 13.5],
      ['12 Oct 17:00', 65, 13.5],
      ['12 Oct 18:00', 129, 13.5],
    ]);

    context.fillText.mockClear();
    primitive.applyOptions({ visible: false });
    timePane.renderer()!.draw(target as never);
    expect(context.fillText).not.toHaveBeenCalled();
  });

  it('uses high-contrast 12px medium typography and clean label spacing on light chart surfaces', () => {
    const labelAt = vi.fn((x: number, isFirstTick: boolean) =>
      isFirstTick ? '29 Oct 2026' : `29 Oct 11:${String(14 + x / 64).padStart(2, '0')}`,
    );
    const primitive = new SquareChartGridPrimitive(
      {
        visible: true,
        isLightBackground: true,
        profile: 'square',
        cellSizeCssPx: SQUARE_CHART_GRID_CELL_SIZE_PX,
        verticalColor: '#cbd5e1',
        horizontalColor: '#cbd5e1',
      },
      undefined,
      {
        labelAt,
        timeKeyAt: (x: number) => `t-${x}`,
        appearance: () => ({
          color: '#334155',
          fontSize: 12,
          fontFamily: '"Segoe UI", Tahoma, Arial, sans-serif',
          backgroundColor: '#ffffff',
          borderColor: '#64748b',
        }),
      },
    );
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
      font: '',
      fillStyle: '',
      textBaseline: '',
      textAlign: '',
    };
    const target = {
      useMediaCoordinateSpace: (draw: (scope: unknown) => void) =>
        draw({ context, mediaSize: { width: 320, height: 28 } }),
    };

    primitive.timeAxisPaneViews()[0]!.renderer()!.draw(target as never);
    expect(context.font).toBe('12px "Segoe UI", Tahoma, Arial, sans-serif');
    expect(context.fillStyle).toBe('#0f172a');
    expect(context.fillText.mock.calls).toEqual([
      ['29 Oct 2026', 4, 14.5],
      ['29 Oct 11:16', 131, 14.5],
    ]);
  });

  it('draws the centered RTX5 background watermark logo in the bottom layer even when grid is hidden, and hides it when showBackgroundLogo is false', () => {
    const fillStyles: string[] = [];
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(() => { fillStyles.push(context.fillStyle); }),
      stroke: vi.fn(),
      lineWidth: 1,
      lineCap: 'butt',
      lineDashOffset: 0,
      strokeStyle: '',
      fillStyle: '',
    };
    const target = {
      useBitmapCoordinateSpace: (draw: (scope: unknown) => void) => draw({
        context,
        bitmapSize: { width: 800, height: 500 },
        horizontalPixelRatio: 1,
        verticalPixelRatio: 1,
      }),
    };

    const primitive = new SquareChartGridPrimitive({
      visible: false,
      showBackgroundLogo: true,
      isLightBackground: false,
      cellSizeCssPx: SQUARE_CHART_GRID_CELL_SIZE_PX,
      verticalColor: '#222',
      horizontalColor: '#333',
    });

    primitive.paneViews()[0]!.renderer()!.draw(target as never);
    expect(context.fill).toHaveBeenCalledTimes(2);
    expect(fillStyles).toEqual([
      'rgba(255, 255, 255, 0.360)',
      'rgba(128, 195, 66, 0.414)',
    ]);
    expect(context.stroke).not.toHaveBeenCalled();

    context.fill.mockClear();
    fillStyles.length = 0;
    primitive.applyOptions({ isLightBackground: true });
    primitive.paneViews()[0]!.renderer()!.draw(target as never);
    expect(context.fill).toHaveBeenCalledTimes(2);
    expect(fillStyles).toEqual([
      'rgba(51, 65, 85, 0.281)',
      'rgba(56, 142, 20, 0.450)',
    ]);

    context.fill.mockClear();
    primitive.applyOptions({ showBackgroundLogo: false });
    primitive.paneViews()[0]!.renderer()!.draw(target as never);
    expect(context.fill).not.toHaveBeenCalled();
  });

  it('loads cross-origin broker logos via CORS fetch -> blob: URL so canvas background removal is never tainted, and prefers CORS-readable fallbacks', async () => {
    const prevWindow = (globalThis as { window?: unknown }).window;
    const prevDocument = (globalThis as { document?: unknown }).document;
    const prevImage = globalThis.Image;
    const prevFetch = globalThis.fetch;
    const prevCreateObjectURL = URL.createObjectURL;
    const prevRevokeObjectURL = URL.revokeObjectURL;

    const width = 32;
    const height = 32;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const off = (y * width + x) * 4;
        const isMark = x >= 8 && x < 24 && y >= 12 && y < 20;
        rgba[off] = isMark ? 20 : 255;
        rgba[off + 1] = isMark ? 20 : 255;
        rgba[off + 2] = isMark ? 24 : 255;
        rgba[off + 3] = 255;
      }
    }

    const workCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: rgba })),
    };
    let outputImageData: { data: Uint8ClampedArray } | null = null;
    const outCtx = {
      createImageData: vi.fn((w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })),
      putImageData: vi.fn((imgData: { data: Uint8ClampedArray }) => { outputImageData = imgData; }),
    };
    const createdCanvases: Array<{ width: number; height: number; tag: string }> = [];
    const mockDocument = {
      baseURI: 'http://127.0.0.1:5173/',
      createElement: vi.fn(() => {
        const idx = createdCanvases.length;
        const canvas = { width: 0, height: 0, tag: idx === 0 ? 'work' : 'out', getContext: () => (idx === 0 ? workCtx : outCtx) };
        createdCanvases.push(canvas);
        return canvas;
      }),
    };
    const createdImages: MockBlobImage[] = [];
    class MockBlobImage {
      decoding = '';
      crossOrigin: string | null = null;
      complete = false;
      naturalWidth = 0;
      naturalHeight = 0;
      onload?: () => void;
      onerror?: () => void;
      private _src = '';
      set src(value: string) {
        this._src = value;
        if (value.startsWith('blob:')) {
          this.complete = true;
          this.naturalWidth = width;
          this.naturalHeight = height;
        }
      }
      get src() { return this._src; }
      get currentSrc() { return this._src; }
      constructor() { createdImages.push(this); }
    }

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('non-cors.example')) {
        throw new TypeError('CORS blocked');
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
      };
    });

    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'http://127.0.0.1:5173', protocol: 'http:', hostname: '127.0.0.1' } },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', { value: mockDocument, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'Image', { value: MockBlobImage, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true, writable: true });
    URL.createObjectURL = vi.fn(() => 'blob:http://127.0.0.1:5173/logo-blob-1');
    URL.revokeObjectURL = vi.fn();

    try {
      const requestUpdate = vi.fn();
      const primitive = new SquareChartGridPrimitive({
        visible: false,
        showBackgroundLogo: true,
        isLightBackground: false,
        backgroundLogoSrc: 'https://non-cors.example/logo.png?v=1',
        backgroundLogoFallbacks: ['http://127.0.0.1:18403/api/v1/brokers/orrnn/logo?v=1'],
        cellSizeCssPx: SQUARE_CHART_GRID_CELL_SIZE_PX,
        verticalColor: '#222',
        horizontalColor: '#333',
      });
      primitive.attached({ requestUpdate } as never);
      await vi.waitFor(() => expect(requestUpdate).toHaveBeenCalledTimes(1));

      const drawContext = {
        save: vi.fn(),
        restore: vi.fn(),
        drawImage: vi.fn(),
        fill: vi.fn(),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        globalAlpha: 1,
      };
      const drawTarget = {
        useBitmapCoordinateSpace: (cb: (scope: unknown) => void) => cb({
          context: drawContext,
          bitmapSize: { width: 800, height: 500 },
          horizontalPixelRatio: 1,
          verticalPixelRatio: 1,
        }),
      };

      // Primary URL blocked CORS -> draw triggers fallback CORS-isolated fetch to directory endpoint.
      primitive.paneViews()[0]!.renderer()!.draw(drawTarget as never);
      await vi.waitFor(() => expect(createdImages.length).toBe(1));
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:18403/api/v1/brokers/orrnn/logo?v=1',
        { mode: 'cors', credentials: 'omit', cache: 'no-cache' },
      );
      expect(createdImages[0]?.src).toBe('blob:http://127.0.0.1:5173/logo-blob-1');

      // Second draw processes the same-origin blob image and renders the background-stripped output canvas!
      primitive.paneViews()[0]!.renderer()!.draw(drawTarget as never);
      expect(drawContext.drawImage).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'out' }),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      );
      expect(outputImageData).toBeTruthy();
      expect(outputImageData!.data[3]).toBe(0);
    } finally {
      Object.defineProperty(globalThis, 'window', { value: prevWindow, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'document', { value: prevDocument, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'Image', { value: prevImage, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'fetch', { value: prevFetch, configurable: true, writable: true });
      URL.createObjectURL = prevCreateObjectURL;
      URL.revokeObjectURL = prevRevokeObjectURL;
    }
  });

  it('fetches same-origin extensionless broker watermarks via blob: URL with same-origin credentials and strips their background', async () => {
    const prevWindow = (globalThis as { window?: unknown }).window;
    const prevDocument = (globalThis as { document?: unknown }).document;
    const prevImage = globalThis.Image;
    const prevFetch = globalThis.fetch;
    const prevCreateObjectURL = URL.createObjectURL;
    const prevRevokeObjectURL = URL.revokeObjectURL;

    const width = 32;
    const height = 32;
    const buildRgba = (w: number, h: number): Uint8ClampedArray => {
      const buf = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const off = (y * w + x) * 4;
          const isMark = x >= w * 0.2 && x < w * 0.8 && y >= h * 0.35 && y < h * 0.65;
          buf[off] = isMark ? 15 : 248;
          buf[off + 1] = isMark ? 15 : 248;
          buf[off + 2] = isMark ? 18 : 250;
          buf[off + 3] = 255;
        }
      }
      return buf;
    };

    const workCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: buildRgba(w, h) })),
    };
    let outputImageData: { data: Uint8ClampedArray } | null = null;
    const outCtx = {
      createImageData: vi.fn((w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })),
      putImageData: vi.fn((imgData: { data: Uint8ClampedArray }) => { outputImageData = imgData; }),
    };
    const createdCanvases: Array<{ width: number; height: number; tag: string }> = [];
    const mockDocument = {
      baseURI: 'https://terminal.orrnn.com/',
      createElement: vi.fn(() => {
        const idx = createdCanvases.length;
        const canvas = { width: 0, height: 0, tag: idx === 0 ? 'work' : 'out', getContext: () => (idx === 0 ? workCtx : outCtx) };
        createdCanvases.push(canvas);
        return canvas;
      }),
    };
    const createdImages: MockSameOriginBlobImage[] = [];
    class MockSameOriginBlobImage {
      decoding = '';
      crossOrigin: string | null = null;
      complete = false;
      naturalWidth = 0;
      naturalHeight = 0;
      onload?: () => void;
      onerror?: () => void;
      private _src = '';
      set src(value: string) {
        this._src = value;
        if (value.startsWith('blob:')) {
          this.complete = true;
          this.naturalWidth = width;
          this.naturalHeight = height;
        }
      }
      get src() { return this._src; }
      get currentSrc() { return this._src; }
      constructor() { createdImages.push(this); }
    }

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/svg+xml; charset=utf-8' : null) },
      blob: async () => new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/svg+xml' }),
    }));

    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'https://terminal.orrnn.com', protocol: 'https:', hostname: 'terminal.orrnn.com' } },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', { value: mockDocument, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'Image', { value: MockSameOriginBlobImage, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true, writable: true });
    URL.createObjectURL = vi.fn(() => 'blob:https://terminal.orrnn.com/same-origin-logo-2');
    URL.revokeObjectURL = vi.fn();

    try {
      const requestUpdate = vi.fn();
      const primitive = new SquareChartGridPrimitive({
        visible: false,
        showBackgroundLogo: true,
        isLightBackground: false,
        backgroundLogoSrc: 'https://terminal.orrnn.com/api/v1/brokers/orrnn/logo?v=2',
        cellSizeCssPx: SQUARE_CHART_GRID_CELL_SIZE_PX,
        verticalColor: '#222',
        horizontalColor: '#333',
      });
      primitive.attached({ requestUpdate } as never);
      await vi.waitFor(() => expect(createdImages.length).toBe(1));

      expect(fetchMock).toHaveBeenCalledWith(
        'https://terminal.orrnn.com/api/v1/brokers/orrnn/logo?v=2',
        { credentials: 'same-origin', cache: 'no-cache' },
      );
      expect(createdImages[0]?.src).toBe('blob:https://terminal.orrnn.com/same-origin-logo-2');

      const drawContext = {
        save: vi.fn(),
        restore: vi.fn(),
        drawImage: vi.fn(),
        fill: vi.fn(),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        globalAlpha: 1,
      };
      const drawTarget = {
        useBitmapCoordinateSpace: (cb: (scope: unknown) => void) => cb({
          context: drawContext,
          bitmapSize: { width: 800, height: 500 },
          horizontalPixelRatio: 1,
          verticalPixelRatio: 1,
        }),
      };

      primitive.paneViews()[0]!.renderer()!.draw(drawTarget as never);
      expect(drawContext.drawImage).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'out' }),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      );
      expect(outputImageData).toBeTruthy();
      expect(outputImageData!.data[3]).toBe(0);
      // Verify extensionless SVG content-type triggered high-res vector upscaling before bg removal.
      expect(createdCanvases[0]?.width).toBe(256);
      expect(createdCanvases[0]?.height).toBe(256);
    } finally {
      Object.defineProperty(globalThis, 'window', { value: prevWindow, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'document', { value: prevDocument, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'Image', { value: prevImage, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'fetch', { value: prevFetch, configurable: true, writable: true });
      URL.createObjectURL = prevCreateObjectURL;
      URL.revokeObjectURL = prevRevokeObjectURL;
    }
  });
});
