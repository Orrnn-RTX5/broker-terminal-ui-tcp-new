import { describe, expect, it } from 'vitest';
import { removeSolidBackgroundFromRgba } from './watermarkBackgroundRemoval';

const createRgbaBuffer = (
  width: number,
  height: number,
  fill: readonly [number, number, number, number],
): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  return data;
};

const fillRect = (
  data: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgba: readonly [number, number, number, number],
): void => {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const off = (y * width + x) * 4;
      data[off] = rgba[0];
      data[off + 1] = rgba[1];
      data[off + 2] = rgba[2];
      data[off + 3] = rgba[3];
    }
  }
};

describe('removeSolidBackgroundFromRgba', () => {
  it('removes a dark rounded-square app-icon card background and tightly crops the broker emblem', () => {
    const w = 64;
    const h = 64;
    const data = createRgbaBuffer(w, h, [35, 37, 45, 255]);
    // Transparent rounded corners (like terminal-icon.png)
    fillRect(data, w, 0, 0, 6, 6, [0, 0, 0, 0]);
    fillRect(data, w, w - 6, 0, 6, 6, [0, 0, 0, 0]);
    fillRect(data, w, 0, h - 6, 6, 6, [0, 0, 0, 0]);
    fillRect(data, w, w - 6, h - 6, 6, 6, [0, 0, 0, 0]);
    // Blue candlestick emblem in center with a 1px anti-aliased fringe
    fillRect(data, w, 20, 16, 24, 32, [79, 140, 255, 255]);
    // Simulate 50% anti-aliased left edge pixel blended with dark card bg
    for (let y = 16; y < 48; y += 1) {
      const off = (y * w + 19) * 4;
      data[off] = Math.round((79 + 35) / 2);
      data[off + 1] = Math.round((140 + 37) / 2);
      data[off + 2] = Math.round((255 + 45) / 2);
      data[off + 3] = 255;
    }

    const result = removeSolidBackgroundFromRgba(data, w, h, { isLightBackground: false });
    expect(result.removed).toBe(true);
    // Tightly cropped around the 25x32 emblem (+2px pad on each side -> ~29x36)
    expect(result.width).toBeLessThan(40);
    expect(result.height).toBeLessThan(44);
    // Corners of the cropped canvas are fully transparent (no dark card remaining)
    expect(result.data[3]).toBe(0);
    // Center pixel keeps original bright blue brand color
    const centerOff = (Math.floor(result.height / 2) * result.width + Math.floor(result.width / 2)) * 4;
    expect(result.data[centerOff]).toBe(79);
    expect(result.data[centerOff + 1]).toBe(140);
    expect(result.data[centerOff + 2]).toBe(255);
    expect(result.data[centerOff + 3]).toBe(255);
    // Anti-aliased edge pixel is color-decontaminated (pure blue RGB with partial alpha, zero dark halo)
    const fringeOff = (Math.floor(result.height / 2) * result.width + 2) * 4;
    expect(result.data[fringeOff]).toBe(79);
    expect(result.data[fringeOff + 2]).toBe(255);
    expect(result.data[fringeOff + 3]).toBeGreaterThan(90);
    expect(result.data[fringeOff + 3]).toBeLessThan(165);
  });

  it('removes a white rectangular background and enclosed letter counters (e.g. O/R)', () => {
    const w = 64;
    const h = 64;
    const data = createRgbaBuffer(w, h, [255, 255, 255, 255]);
    // Draw a blue hollow "O" ring: outer 28x28, inner 10x10 white hole (100/4096 = 2.4% < 8%)
    fillRect(data, w, 18, 18, 28, 28, [37, 99, 235, 255]);
    fillRect(data, w, 27, 27, 10, 10, [255, 255, 255, 255]);

    const result = removeSolidBackgroundFromRgba(data, w, h, { isLightBackground: false });
    expect(result.removed).toBe(true);
    // Center of the hollow "O" must now be transparent!
    const centerOff = (Math.floor(result.height / 2) * result.width + Math.floor(result.width / 2)) * 4;
    expect(result.data[centerOff + 3]).toBe(0);
    // Ring body stays opaque blue
    const ringOff = (Math.floor(result.height / 2) * result.width + 4) * 4;
    expect(result.data[ringOff]).toBe(37);
    expect(result.data[ringOff + 1]).toBe(99);
    expect(result.data[ringOff + 2]).toBe(235);
    expect(result.data[ringOff + 3]).toBe(255);
  });

  it('keeps already-transparent logos completely untouched', () => {
    const w = 64;
    const h = 64;
    const data = createRgbaBuffer(w, h, [0, 0, 0, 0]);
    fillRect(data, w, 20, 20, 24, 24, [255, 255, 255, 255]);

    const result = removeSolidBackgroundFromRgba(data, w, h, { isLightBackground: false });
    expect(result.removed).toBe(false);
    expect(result.width).toBe(w);
    expect(result.height).toBe(h);
  });

  it('lifts monochrome black-on-white logos for dark charts and adapts white-on-dark logos for light charts', () => {
    const w = 48;
    const h = 48;
    const blackOnWhite = createRgbaBuffer(w, h, [255, 255, 255, 255]);
    fillRect(blackOnWhite, w, 14, 14, 20, 20, [10, 10, 10, 255]);

    const darkChartResult = removeSolidBackgroundFromRgba(blackOnWhite, w, h, { isLightBackground: false });
    expect(darkChartResult.removed).toBe(true);
    const darkCenter = (Math.floor(darkChartResult.height / 2) * darkChartResult.width + Math.floor(darkChartResult.width / 2)) * 4;
    expect(darkChartResult.data[darkCenter]).toBeGreaterThan(200);
    expect(darkChartResult.data[darkCenter + 3]).toBe(255);

    const whiteOnDark = createRgbaBuffer(w, h, [18, 20, 26, 255]);
    fillRect(whiteOnDark, w, 14, 14, 20, 20, [250, 250, 250, 255]);

    const lightChartResult = removeSolidBackgroundFromRgba(whiteOnDark, w, h, { isLightBackground: true });
    expect(lightChartResult.removed).toBe(true);
    const lightCenter = (Math.floor(lightChartResult.height / 2) * lightChartResult.width + Math.floor(lightChartResult.width / 2)) * 4;
    expect(lightChartResult.data[lightCenter]).toBeLessThan(120);
    expect(lightChartResult.data[lightCenter + 3]).toBe(255);
  });

  it('never erases a solid single-color placeholder image', () => {
    const w = 32;
    const h = 32;
    const solid = createRgbaBuffer(w, h, [255, 255, 255, 255]);

    const result = removeSolidBackgroundFromRgba(solid, w, h);
    expect(result.removed).toBe(false);
  });

  it('removes a solid card background even when surrounded by a transparent outer margin', () => {
    const w = 64;
    const h = 64;
    const data = createRgbaBuffer(w, h, [0, 0, 0, 0]);
    // 56x56 solid white card centered inside 4px transparent margin (total opaque ~76.5% >= 62%)
    fillRect(data, w, 4, 4, 56, 56, [255, 255, 255, 255]);
    // Green broker emblem inside the white card
    fillRect(data, w, 20, 20, 24, 24, [16, 185, 129, 255]);

    const result = removeSolidBackgroundFromRgba(data, w, h, { isLightBackground: false });
    expect(result.removed).toBe(true);
    expect(result.width).toBeLessThan(34);
    expect(result.height).toBeLessThan(34);
    const centerOff = (Math.floor(result.height / 2) * result.width + Math.floor(result.width / 2)) * 4;
    expect(result.data[centerOff]).toBe(16);
    expect(result.data[centerOff + 1]).toBe(185);
    expect(result.data[centerOff + 2]).toBe(129);
  });
});
