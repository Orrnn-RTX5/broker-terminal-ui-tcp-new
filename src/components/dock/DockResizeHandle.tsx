/**
 * DockResizeHandle Component
 * MT5-style invisible split resize handle — shows ↕/↔ cursor on hover,
 * renders a lightweight preview guide line while dragging, and commits the
 * resize atomically on mouse release so charts and tables never jank mid-drag.
 */

import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface DockResizeDragBounds {
  minDelta: number;
  maxDelta: number;
  /** Exact viewport seam coordinate (first child's right/bottom edge) when measured. */
  originCoord?: number;
  /** Viewport rect of the split container to constrain the preview bar span. */
  containerRect: { left: number; top: number; width: number; height: number };
}

export interface DockResizeHandleProps {
  direction: 'horizontal' | 'vertical';
  /** Legacy incremental delta callback (called per mousemove when onResizeCommit is omitted). */
  onResize?: (delta: number) => void;
  /** MT5-style commit-on-release callback receiving the total clamped drag delta in px. */
  onResizeCommit?: (totalDelta: number) => void;
  /** Returns allowed drag delta range and split container bounds at drag start. */
  getDragBounds?: () => DockResizeDragBounds | null;
  className?: string;
}

interface ActiveDragPreview {
  originCoord: number;
  delta: number;
  minDelta: number;
  maxDelta: number;
  containerRect: { left: number; top: number; width: number; height: number };
}

const clampDelta = (delta: number, minDelta: number, maxDelta: number): number => (
  Math.max(minDelta, Math.min(maxDelta, delta))
);

export const DockResizeHandle: React.FC<DockResizeHandleProps> = ({
  direction,
  onResize,
  onResizeCommit,
  getDragBounds,
  className,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [preview, setPreview] = useState<ActiveDragPreview | null>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const startPosRef = useRef(0);
  const lastDeltaRef = useRef(0);
  const previewRef = useRef<ActiveDragPreview | null>(null);
  const onResizeRef = useRef(onResize);
  const onResizeCommitRef = useRef(onResizeCommit);
  const getDragBoundsRef = useRef(getDragBounds);

  useLayoutEffect(() => {
    onResizeRef.current = onResize;
    onResizeCommitRef.current = onResizeCommit;
    getDragBoundsRef.current = getDragBounds;
  });

  const usePreviewCommit = typeof onResizeCommit === 'function';

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const startCoord = direction === 'vertical' ? e.clientX : e.clientY;
    startPosRef.current = startCoord;
    lastDeltaRef.current = 0;

    if (onResizeCommitRef.current) {
      const handleRect = handleRef.current?.getBoundingClientRect();
      const bounds = getDragBoundsRef.current?.() ?? null;
      const fallbackRect = handleRect
        ? {
          left: handleRect.left,
          top: handleRect.top,
          width: handleRect.width || window.innerWidth,
          height: handleRect.height || window.innerHeight,
        }
        : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

      const measuredOrigin = bounds?.originCoord;
      const handleOrigin = handleRect
        ? (direction === 'vertical' ? handleRect.left : handleRect.top)
        : startCoord;
      const originCoord = typeof measuredOrigin === 'number' && Number.isFinite(measuredOrigin)
        ? measuredOrigin
        : handleOrigin;
      const nextPreview: ActiveDragPreview = {
        originCoord: Number.isFinite(originCoord) && (originCoord > 0 || startCoord === 0)
          ? originCoord
          : startCoord,
        delta: 0,
        minDelta: bounds ? bounds.minDelta : -window.innerHeight,
        maxDelta: bounds ? bounds.maxDelta : window.innerHeight,
        containerRect: bounds ? bounds.containerRect : fallbackRect,
      };
      previewRef.current = nextPreview;
      setPreview(nextPreview);
    }

    setIsDragging(true);
  }, [direction]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = direction === 'vertical' ? e.clientX : e.clientY;
      const rawTotalDelta = currentPos - startPosRef.current;

      if (usePreviewCommit && previewRef.current) {
        const clamped = clampDelta(rawTotalDelta, previewRef.current.minDelta, previewRef.current.maxDelta);
        if (clamped !== previewRef.current.delta) {
          const updated = { ...previewRef.current, delta: clamped };
          previewRef.current = updated;
          setPreview(updated);
        }
        return;
      }

      const delta = rawTotalDelta - lastDeltaRef.current;
      lastDeltaRef.current = rawTotalDelta;
      if (delta !== 0) onResizeRef.current?.(delta);
    };

    const finishDrag = (commit: boolean) => {
      const active = previewRef.current;
      previewRef.current = null;
      setPreview(null);
      setIsDragging(false);
      if (commit && usePreviewCommit && active && active.delta !== 0) {
        onResizeCommitRef.current?.(active.delta);
      }
    };

    const handleMouseUp = () => finishDrag(true);
    const handleBlur = () => finishDrag(false);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finishDrag(false);
      }
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('keydown', handleKeyDown);

    // Prevent text selection and keep resize cursor steady across panels during drag
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = direction === 'vertical' ? 'ew-resize' : 'ns-resize';
    document.documentElement.setAttribute('data-dock-resizing', 'true');

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      document.documentElement.removeAttribute('data-dock-resizing');
    };
  }, [isDragging, direction, usePreviewCommit]);

  const previewNode = isDragging && preview && typeof document !== 'undefined'
    ? createPortal(
      <div
        data-dock-resize-preview={direction}
        aria-hidden="true"
        className="pointer-events-none fixed z-[10050]"
        style={direction === 'horizontal'
          ? {
            left: `${preview.containerRect.left}px`,
            top: `${Math.round(preview.originCoord + preview.delta)}px`,
            width: `${preview.containerRect.width}px`,
            height: '1px',
            background: 'rgba(148, 163, 184, 0.65)',
          }
          : {
            left: `${Math.round(preview.originCoord + preview.delta)}px`,
            top: `${preview.containerRect.top}px`,
            width: '1px',
            height: `${preview.containerRect.height}px`,
            background: 'rgba(148, 163, 184, 0.65)',
          }}
      />,
      document.body,
    )
    : null;

  return (
    <>
      <div
        ref={handleRef}
        data-dock-resize-handle={direction}
        className={cn(
          'dock-resize-handle',
          direction === 'vertical'
            ? 'dock-resize-handle--vertical'
            : 'dock-resize-handle--horizontal',
          isDragging && 'dock-resize-handle--dragging',
          'relative flex-shrink-0',
          // Sit above adjacent panel shells (BottomDock zIndex: 30 / header z-40,
          // chart overlays zIndex: 25) so the seam is always easy to grab.
          isDragging ? 'z-[120]' : 'z-[60]',
          // Reserve no split-layout space. A centered hit target overlaps both
          // adjacent panels so the divider stays easy to drag.
          direction === 'vertical'
            ? 'h-full w-0'
            : 'h-0 w-full',
          className
        )}
      >
        <div
          data-dock-resize-hit-target={direction}
          className={cn(
            'absolute bg-transparent transition-colors duration-75',
            direction === 'vertical'
              ? 'inset-y-0 left-1/2 w-[9px] -translate-x-1/2 cursor-ew-resize'
              : 'inset-x-0 top-1/2 h-[9px] -translate-y-1/2 cursor-ns-resize',
          )}
          onMouseDown={handleMouseDown}
        />
      </div>
      {previewNode}
    </>
  );
};

export default DockResizeHandle;
