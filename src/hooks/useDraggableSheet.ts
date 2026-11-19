import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

export interface DragOffset {
  x: number;
  y: number;
}

export interface UseDraggableSheetOptions {
  /** Resets drag offset when a modal/sheet closes. */
  isOpen?: boolean;
  /** Disables dragging while true. */
  disabled?: boolean;
  /** Optional external ref to the movable dialog/sheet element for viewport clamping. */
  elementRef?: RefObject<HTMLElement | null>;
}

const NON_DRAGGABLE_TARGET_SELECTOR =
  'button, input, select, textarea, a, label, [role="button"], [role="tab"], [data-no-drag]';

const clampDragOffset = (
  nextX: number,
  nextY: number,
  bounds: { naturalLeft: number; naturalTop: number; width: number; height: number } | null,
): DragOffset => {
  if (
    !bounds
    || bounds.width <= 0
    || bounds.height <= 0
    || typeof window === 'undefined'
    || window.innerWidth <= 0
    || window.innerHeight <= 0
  ) {
    return { x: nextX, y: nextY };
  }

  const visibleMarginX = Math.min(64, bounds.width);
  const minX = visibleMarginX - bounds.width - bounds.naturalLeft;
  const maxX = window.innerWidth - visibleMarginX - bounds.naturalLeft;
  const minY = -bounds.naturalTop;
  const maxY = Math.max(minY, window.innerHeight - 36 - bounds.naturalTop);

  return {
    x: Math.round(Math.min(Math.max(nextX, minX), maxX)),
    y: Math.round(Math.min(Math.max(nextY, minY), maxY)),
  };
};

export function useDraggableSheet(options: UseDraggableSheetOptions = {}) {
  const { isOpen = true, disabled = false, elementRef } = options;
  const [offset, setOffset] = useState<DragOffset>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);

  if (prevIsOpen !== isOpen) {
    setPrevIsOpen(isOpen);
    if (!isOpen) {
      setIsDragging(false);
      setOffset({ x: 0, y: 0 });
    }
  }

  const internalElementRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const stopDragging = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  const reset = useCallback(() => {
    stopDragging();
    setIsDragging(false);
    setOffset({ x: 0, y: 0 });
  }, [stopDragging]);

  useEffect(() => {
    if (!isOpen) {
      stopDragging();
    }
  }, [isOpen, stopDragging]);

  useEffect(() => stopDragging, [stopDragging]);

  const setSheetElement = useCallback((element: HTMLElement | null) => {
    internalElementRef.current = element;
  }, []);

  const handleMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (disabled || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(NON_DRAGGABLE_TARGET_SELECTOR)) return;

    stopDragging();

    const startX = event.clientX;
    const startY = event.clientY;
    const origX = offset.x;
    const origY = offset.y;
    const activeEl = elementRef?.current ?? internalElementRef.current;

    let bounds: { naturalLeft: number; naturalTop: number; width: number; height: number } | null = null;
    if (activeEl && typeof activeEl.getBoundingClientRect === 'function') {
      const rect = activeEl.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        bounds = {
          naturalLeft: rect.left - origX,
          naturalTop: rect.top - origY,
          width: rect.width,
          height: rect.height,
        };
      }
    }

    event.preventDefault();
    setIsDragging(true);

    const onMouseMove = (moveEvent: MouseEvent) => {
      const next = clampDragOffset(
        origX + (moveEvent.clientX - startX),
        origY + (moveEvent.clientY - startY),
        bounds,
      );
      setOffset(next);
    };

    const onMouseUp = () => {
      stopDragging();
      setIsDragging(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onMouseUp);
    cleanupRef.current = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onMouseUp);
    };
  }, [disabled, elementRef, offset.x, offset.y, stopDragging]);

  const dragStyle: CSSProperties = offset.x !== 0 || offset.y !== 0
    ? { transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }
    : {};

  const dragHandleProps = {
    onMouseDown: handleMouseDown,
    style: {
      cursor: disabled ? undefined : (isDragging ? 'grabbing' : 'move'),
      userSelect: 'none' as const,
    },
  };

  return {
    offset,
    isDragging,
    dragStyle,
    dragHandleProps,
    setSheetElement,
    reset,
  };
}
