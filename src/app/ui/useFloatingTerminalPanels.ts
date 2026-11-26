import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from 'react';
import {
  readSessionJson,
  SESSION_VIEW_KEYS,
  subscribeWorkspaceViewReset,
  writeSessionJson,
} from '../../services/sessionViewState';

type Point = { x: number; y: number };
type Size = { w: number; h: number };
export type ResizeMode = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const DOM_EDGE_GAP = 8;

const resolveChartPanelRect = (): DOMRect | null => {
  if (typeof document === 'undefined') return null;
  const chartHost = document.querySelector<HTMLElement>('.rtx-chart-panel[data-chart-panel-active="true"]')
    ?? document.querySelector<HTMLElement>('.rtx-chart-panel');
  const rect = chartHost?.getBoundingClientRect();
  return rect && rect.width > 160 && rect.height > 160 ? rect : null;
};

const resolveDefaultDomSize = (): Size => {
  if (typeof window === 'undefined') return { w: 520, h: 540 };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const isLaptop = vw <= 1720 || vh <= 920;
  if (!isLaptop) {
    return { w: 520, h: 540 };
  }
  const compactLaptop = vw <= 1440 || vh <= 780;
  const targetW = compactLaptop ? 468 : 498;
  const targetH = compactLaptop ? 380 : 426;
  const chartRect = resolveChartPanelRect();
  if (chartRect) {
    return {
      w: Math.min(targetW, Math.max(360, Math.floor(chartRect.width - 24))),
      h: Math.min(targetH, Math.max(260, Math.floor(chartRect.height - 16))),
    };
  }
  return {
    w: Math.min(targetW, Math.max(360, vw - 24)),
    h: Math.min(targetH, Math.max(260, vh - 96)),
  };
};

const clampDomPosition = (pos: Point, size: Size): Point => {
  if (typeof window === 'undefined') return pos;
  const maxX = Math.max(DOM_EDGE_GAP, window.innerWidth - size.w - DOM_EDGE_GAP);
  const maxY = Math.max(DOM_EDGE_GAP, window.innerHeight - size.h - DOM_EDGE_GAP);
  return {
    x: Math.round(Math.max(DOM_EDGE_GAP, Math.min(maxX, pos.x))),
    y: Math.round(Math.max(DOM_EDGE_GAP, Math.min(maxY, pos.y))),
  };
};

const resolveDefaultDomPosition = (size: Size): Point => {
  if (typeof window === 'undefined') return { x: 620, y: 56 };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const isLaptop = vw <= 1720 || vh <= 920;
  const chartRect = resolveChartPanelRect();
  if (chartRect) {
    return clampDomPosition({
      x: chartRect.left + (chartRect.width - size.w) / 2,
      y: chartRect.top + (chartRect.height - size.h) / 2,
    }, size);
  }
  if (!isLaptop) {
    return clampDomPosition({ x: 620, y: 92 }, size);
  }
  return clampDomPosition({
    x: (vw - size.w) / 2,
    y: Math.max(48, (vh - size.h) * 0.36),
  }, size);
};

export interface FloatingTerminalPanelsController {
  showDOM: boolean;
  setShowDOM: Dispatch<SetStateAction<boolean>>;
  domSymbol: string;
  openDOM: (symbol: string) => void;
  domPos: Point;
  domSize: Size;
  handleDomMouseDown: (event: ReactMouseEvent) => void;
  handleDomResizeMouseDown: (event: ReactMouseEvent, mode: ResizeMode) => void;
  showDataWindow: boolean;
  setShowDataWindow: Dispatch<SetStateAction<boolean>>;
  dataWindowPos: Point;
  dataWindowSize: Size;
  handleDataWindowMouseDown: (event: ReactMouseEvent) => void;
  handleDataWindowResizeMouseDown: (event: ReactMouseEvent, mode: ResizeMode) => void;
}

interface PersistedFloatingPanelsState {
  showDOM?: boolean;
  domSymbol?: string;
  domPos?: Point;
  domSize?: Size;
  domHasDraggedOrResized?: boolean;
  showDataWindow?: boolean;
  dataWindowPos?: Point;
  dataWindowSize?: Size;
}

const isValidPoint = (value: unknown): value is Point => (
  Boolean(value) && typeof value === 'object'
  && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y)
);

const isValidSize = (value: unknown): value is Size => (
  Boolean(value) && typeof value === 'object'
  && Number.isFinite((value as Size).w) && (value as Size).w >= 200
  && Number.isFinite((value as Size).h) && (value as Size).h >= 200
);

export const useFloatingTerminalPanels = (initialSymbol: string): FloatingTerminalPanelsController => {
  const persistedInitialRef = useRef<PersistedFloatingPanelsState | null>(null);
  if (persistedInitialRef.current === null) {
    persistedInitialRef.current = readSessionJson<PersistedFloatingPanelsState>(SESSION_VIEW_KEYS.floatingPanels, {});
  }
  const persistedInitial = persistedInitialRef.current;

  const [showDOM, setShowDOM] = useState(() => persistedInitial.showDOM === true);
  const [domSymbol, setDomSymbol] = useState(() => (
    typeof persistedInitial.domSymbol === 'string' && persistedInitial.domSymbol.trim()
      ? persistedInitial.domSymbol
      : initialSymbol
  ));
  const [domSize, setDomSize] = useState<Size>(() => (
    isValidSize(persistedInitial.domSize) ? persistedInitial.domSize : resolveDefaultDomSize()
  ));
  const [domPos, setDomPos] = useState<Point>(() => (
    isValidPoint(persistedInitial.domPos)
      ? persistedInitial.domPos
      : resolveDefaultDomPosition(isValidSize(persistedInitial.domSize) ? persistedInitial.domSize : resolveDefaultDomSize())
  ));
  const [showDataWindow, setShowDataWindow] = useState(() => persistedInitial.showDataWindow === true);
  const [dataWindowPos, setDataWindowPos] = useState<Point>(() => (
    isValidPoint(persistedInitial.dataWindowPos) ? persistedInitial.dataWindowPos : { x: 620, y: 56 }
  ));
  const [dataWindowSize, setDataWindowSize] = useState<Size>(() => (
    isValidSize(persistedInitial.dataWindowSize) ? persistedInitial.dataWindowSize : { w: 248, h: 306 }
  ));

  const domHasDraggedOrResizedRef = useRef(persistedInitial.domHasDraggedOrResized === true);
  const domSizeRef = useRef(domSize);
  domSizeRef.current = domSize;
  const domDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const domResizeRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
    origX: number;
    origY: number;
    mode: ResizeMode;
  } | null>(null);
  const dataWindowDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const dataWindowResizeRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
    origX: number;
    origY: number;
    mode: ResizeMode;
  } | null>(null);

  useEffect(() => {
    if (!showDOM || typeof window === 'undefined') return;
    if (!domHasDraggedOrResizedRef.current) {
      const nextSize = resolveDefaultDomSize();
      setDomSize(nextSize);
      setDomPos(resolveDefaultDomPosition(nextSize));
    }
    const handleViewportResize = () => {
      if (!domHasDraggedOrResizedRef.current) {
        const nextSize = resolveDefaultDomSize();
        setDomSize(nextSize);
        setDomPos(resolveDefaultDomPosition(nextSize));
      } else {
        setDomPos((prev) => clampDomPosition(prev, domSizeRef.current));
      }
    };
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, [showDOM]);

  const handleDomMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    domHasDraggedOrResizedRef.current = true;
    domDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origX: domPos.x,
      origY: domPos.y,
    };
    const onMove = (moveEvent: MouseEvent) => {
      const drag = domDragRef.current;
      if (!drag) return;
      setDomPos(clampDomPosition({
        x: drag.origX + moveEvent.clientX - drag.startX,
        y: drag.origY + moveEvent.clientY - drag.startY,
      }, domSizeRef.current));
    };
    const onUp = () => {
      domDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [domPos]);

  const openDOM = useCallback((symbol: string) => {
    domHasDraggedOrResizedRef.current = false;
    const nextSize = resolveDefaultDomSize();
    setDomSymbol(symbol);
    setDomSize(nextSize);
    setDomPos(resolveDefaultDomPosition(nextSize));
    setShowDOM(true);
  }, []);

  const handleDomResizeMouseDown = useCallback((event: ReactMouseEvent, mode: ResizeMode) => {
    event.preventDefault();
    event.stopPropagation();
    domHasDraggedOrResizedRef.current = true;
    domResizeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origW: domSize.w,
      origH: domSize.h,
      origX: domPos.x,
      origY: domPos.y,
      mode,
    };
    const onMove = (moveEvent: MouseEvent) => {
      const resize = domResizeRef.current;
      if (!resize) return;
      const dx = moveEvent.clientX - resize.startX;
      const dy = moveEvent.clientY - resize.startY;
      // Capture values synchronously; the ref may be cleared before React runs the state updater.
      const { mode: resizeMode, origW, origH, origX, origY } = resize;
      setDomSize((previous) => ({
        w: resizeMode.includes('e')
          ? Math.max(360, origW + dx)
          : resizeMode.includes('w')
            ? Math.max(360, origW - dx)
            : previous.w,
        h: resizeMode.includes('s')
          ? Math.max(200, origH + dy)
          : resizeMode.includes('n')
            ? Math.max(200, origH - dy)
            : previous.h,
      }));
      if (resizeMode.includes('w') || resizeMode.includes('n')) {
        setDomPos((previous) => ({
          x: resizeMode.includes('w') ? Math.max(DOM_EDGE_GAP, origX + Math.min(dx, origW - 360)) : previous.x,
          y: resizeMode.includes('n') ? Math.max(DOM_EDGE_GAP, origY + Math.min(dy, origH - 200)) : previous.y,
        }));
      }
    };
    const onUp = () => {
      domResizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [domPos, domSize]);

  const handleDataWindowMouseDown = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    dataWindowDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origX: dataWindowPos.x,
      origY: dataWindowPos.y,
    };
    const onMove = (moveEvent: MouseEvent) => {
      const drag = dataWindowDragRef.current;
      if (!drag) return;
      setDataWindowPos({
        x: drag.origX + moveEvent.clientX - drag.startX,
        y: drag.origY + moveEvent.clientY - drag.startY,
      });
    };
    const onUp = () => {
      dataWindowDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [dataWindowPos]);

  const handleDataWindowResizeMouseDown = useCallback((event: ReactMouseEvent, mode: ResizeMode) => {
    event.preventDefault();
    event.stopPropagation();
    dataWindowResizeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origW: dataWindowSize.w,
      origH: dataWindowSize.h,
      origX: dataWindowPos.x,
      origY: dataWindowPos.y,
      mode,
    };
    const onMove = (moveEvent: MouseEvent) => {
      const resize = dataWindowResizeRef.current;
      if (!resize) return;
      const dx = moveEvent.clientX - resize.startX;
      const dy = moveEvent.clientY - resize.startY;
      const minWidth = 200;
      const minHeight = 200;
      setDataWindowSize((previous) => ({
        w: mode.includes('e') ? Math.max(minWidth, resize.origW + dx)
          : mode.includes('w') ? Math.max(minWidth, resize.origW - dx) : previous.w,
        h: mode.includes('s') ? Math.max(minHeight, resize.origH + dy)
          : mode.includes('n') ? Math.max(minHeight, resize.origH - dy) : previous.h,
      }));
      setDataWindowPos((previous) => ({
        x: mode.includes('w') ? resize.origX + Math.min(dx, resize.origW - minWidth) : previous.x,
        y: mode.includes('n') ? resize.origY + Math.min(dy, resize.origH - minHeight) : previous.y,
      }));
    };
    const onUp = () => {
      dataWindowResizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [dataWindowPos, dataWindowSize]);

  useEffect(() => {
    const isDefaultClosed = !showDOM && !showDataWindow && !domHasDraggedOrResizedRef.current;
    if (isDefaultClosed) {
      writeSessionJson(SESSION_VIEW_KEYS.floatingPanels, null);
      return;
    }
    writeSessionJson(SESSION_VIEW_KEYS.floatingPanels, {
      showDOM,
      domSymbol,
      domPos,
      domSize,
      domHasDraggedOrResized: domHasDraggedOrResizedRef.current,
      showDataWindow,
      dataWindowPos,
      dataWindowSize,
    } satisfies PersistedFloatingPanelsState);
  }, [dataWindowPos, dataWindowSize, domPos, domSize, domSymbol, showDOM, showDataWindow]);

  useEffect(() => subscribeWorkspaceViewReset(() => {
    domHasDraggedOrResizedRef.current = false;
    const nextSize = resolveDefaultDomSize();
    setShowDOM(false);
    setDomSize(nextSize);
    setDomPos(resolveDefaultDomPosition(nextSize));
    setShowDataWindow(false);
    setDataWindowPos({ x: 620, y: 56 });
    setDataWindowSize({ w: 248, h: 306 });
  }), []);

  return {
    showDOM,
    setShowDOM,
    domSymbol,
    openDOM,
    domPos,
    domSize,
    handleDomMouseDown,
    handleDomResizeMouseDown,
    showDataWindow,
    setShowDataWindow,
    dataWindowPos,
    dataWindowSize,
    handleDataWindowMouseDown,
    handleDataWindowResizeMouseDown,
  };
};
