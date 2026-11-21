import { describe, expect, it } from 'vitest';
import { computeInlineSubmenuPlacement } from './inlineSubmenuPosition';

const rect = (top: number, height = 38, left = 42, width = 256) => ({
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
});

describe('computeInlineSubmenuPlacement', () => {
    it('aligns flush on the same line (topOffset 0) and to the right when layout is unmeasured', () => {
        expect(computeInlineSubmenuPlacement(rect(0, 0, 0, 0), 0, 0, 1280, 800)).toEqual({
            topOffset: 0,
            alignLeft: false,
        });
    });

    it('opens side by side on the exact same line when the submenu fits in the viewport', () => {
        expect(computeInlineSubmenuPlacement(rect(247, 38, 42, 256), 260, 120, 1280, 800)).toEqual({
            topOffset: 0,
            alignLeft: false,
        });
    });

    it('shifts up minimally when a lower row submenu would overflow the viewport bottom while staying adjacent to the row', () => {
        const placement = computeInlineSubmenuPlacement(rect(533, 38, 42, 256), 260, 400, 1280, 800);
        // maxBottom = 792; clampedScreenTop = 792 - 400 = 392; topOffset = 392 - 533 = -141
        expect(placement).toEqual({
            topOffset: -141,
            alignLeft: false,
        });
        // Screen span [392, 792] still covers row [533, 571]
        const screenTop = 533 + placement.topOffset;
        expect(screenTop).toBeLessThanOrEqual(533);
        expect(screenTop + 400).toBeGreaterThanOrEqual(533 + 38);
    });

    it('clamps to top viewport padding when a tall submenu exceeds viewport height', () => {
        const placement = computeInlineSubmenuPlacement(rect(500, 38, 42, 256), 260, 760, 1280, 700);
        expect(placement).toEqual({
            topOffset: -492, // 8 - 500
            alignLeft: false,
        });
    });

    it('flips to the left side when overflowing the right edge and more space is available on the left', () => {
        expect(computeInlineSubmenuPlacement(rect(200, 32, 820, 260), 260, 160, 1280, 800)).toEqual({
            topOffset: 0,
            alignLeft: true,
        });
    });
});
