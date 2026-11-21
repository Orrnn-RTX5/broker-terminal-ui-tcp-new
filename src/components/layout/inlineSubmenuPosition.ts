import { useLayoutEffect, useState, type RefObject } from 'react';

export interface InlineSubmenuRect {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
}

export interface InlineSubmenuPlacement {
    topOffset: number;
    alignLeft: boolean;
}

const SUBMENU_VIEWPORT_PADDING = 8;

/**
 * Places a side-by-side submenu inline with its triggering row (`topOffset: 0`
 * on the right edge) and applies minimal viewport clamping only when the
 * submenu would overflow the visible viewport.
 */
export function computeInlineSubmenuPlacement(
    anchorRect: InlineSubmenuRect,
    submenuWidth: number,
    submenuHeight: number,
    viewportWidth: number,
    viewportHeight: number,
): InlineSubmenuPlacement {
    if (submenuWidth <= 0 && submenuHeight <= 0) {
        return { topOffset: 0, alignLeft: false };
    }

    let topOffset = 0;
    if (submenuHeight > 0 && viewportHeight > 0) {
        const maxBottom = viewportHeight - SUBMENU_VIEWPORT_PADDING;
        if (anchorRect.top + submenuHeight > maxBottom) {
            const clampedScreenTop = Math.max(SUBMENU_VIEWPORT_PADDING, maxBottom - submenuHeight);
            topOffset = Math.round(clampedScreenTop - anchorRect.top);
        } else if (anchorRect.top < SUBMENU_VIEWPORT_PADDING) {
            topOffset = Math.round(SUBMENU_VIEWPORT_PADDING - anchorRect.top);
        }
    }

    let alignLeft = false;
    if (submenuWidth > 0 && viewportWidth > 0) {
        const availableRight = viewportWidth - SUBMENU_VIEWPORT_PADDING - anchorRect.right;
        const availableLeft = anchorRect.left - SUBMENU_VIEWPORT_PADDING;
        if (submenuWidth > availableRight && availableLeft > availableRight) {
            alignLeft = true;
        }
    }

    return { topOffset, alignLeft };
}

export function useInlineSubmenuPlacement(
    enabled: boolean,
    anchorRef: RefObject<HTMLElement | null>,
    submenuRef: RefObject<HTMLElement | null>,
    resetKey?: string | number,
): InlineSubmenuPlacement {
    const [placement, setPlacement] = useState<InlineSubmenuPlacement>({ topOffset: 0, alignLeft: false });

    useLayoutEffect(() => {
        if (!enabled) {
            setPlacement((prev) => (prev.topOffset === 0 && !prev.alignLeft ? prev : { topOffset: 0, alignLeft: false }));
            return;
        }

        const updatePlacement = (event?: Event) => {
            const anchor = anchorRef.current;
            const submenu = submenuRef.current;
            if (!anchor || !submenu) return;
            if (event?.type === 'scroll' && event.target instanceof Node && submenu.contains(event.target)) return;

            const anchorRect = anchor.getBoundingClientRect();
            const submenuRect = submenu.getBoundingClientRect();
            const submenuWidth = submenu.offsetWidth || submenuRect.width;
            const submenuHeight = submenu.offsetHeight || submenuRect.height;

            const next = computeInlineSubmenuPlacement(
                anchorRect,
                submenuWidth,
                submenuHeight,
                window.innerWidth,
                window.innerHeight,
            );

            setPlacement((prev) => (
                prev.topOffset === next.topOffset && prev.alignLeft === next.alignLeft ? prev : next
            ));
        };

        updatePlacement();
        window.addEventListener('resize', updatePlacement);
        window.addEventListener('scroll', updatePlacement, true);
        return () => {
            window.removeEventListener('resize', updatePlacement);
            window.removeEventListener('scroll', updatePlacement, true);
        };
    }, [enabled, anchorRef, submenuRef, resetKey]);

    return placement;
}
