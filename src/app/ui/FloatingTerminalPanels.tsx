import { depthOfMarketFeature, dataWindowFeature } from '../../startup/terminalFeatures';
import { Suspense, type CSSProperties } from 'react';
import type { DepthOrderRequest } from '../../components/DepthOfMarket';
import type { FloatingTerminalPanelsController, ResizeMode } from './useFloatingTerminalPanels';

const LazyDepthOfMarket = depthOfMarketFeature.Component;
const LazyDataWindow = dataWindowFeature.Component;

interface FloatingTerminalPanelsProps {
  panels: FloatingTerminalPanelsController;
  onCloseBulk: (type: 'ALL' | 'WINNERS' | 'LOSERS', symbol?: string) => void | Promise<void>;
  onPlaceOrder: (request: DepthOrderRequest) => void | Promise<void>;
}

const resizeEdges: Array<{
  mode: ResizeMode;
  style: CSSProperties;
}> = [
  { mode: 'n', style: { top: 0, left: 6, right: 6, height: 5, cursor: 'ns-resize' } },
  { mode: 's', style: { bottom: 0, left: 6, right: 6, height: 5, cursor: 'ns-resize' } },
  { mode: 'w', style: { top: 6, left: 0, bottom: 6, width: 5, cursor: 'ew-resize' } },
  { mode: 'e', style: { top: 6, right: 0, bottom: 6, width: 5, cursor: 'ew-resize' } },
  { mode: 'nw', style: { top: 0, left: 0, width: 10, height: 10, cursor: 'nwse-resize', zIndex: 21 } },
  { mode: 'ne', style: { top: 0, right: 0, width: 10, height: 10, cursor: 'nesw-resize', zIndex: 21 } },
  { mode: 'sw', style: { bottom: 0, left: 0, width: 10, height: 10, cursor: 'nesw-resize', zIndex: 21 } },
];

export const FloatingTerminalPanels = ({ panels, onCloseBulk, onPlaceOrder }: FloatingTerminalPanelsProps) => (
  <>
    {panels.showDOM && (
      <div
        className="rtx-dom-dialog fixed z-[1200] flex flex-col overflow-hidden"
        style={{
          left: panels.domPos.x,
          top: panels.domPos.y,
          width: panels.domSize.w,
          height: panels.domSize.h,
          minWidth: 360,
          minHeight: 200,
          borderRadius: 6,
          boxShadow: '0 14px 38px rgba(0, 0, 0, 0.58), 0 0 0 1px var(--border-primary, #444444)',
          background: 'var(--bg-secondary, #1f1f1f)',
        }}
      >
        <Suspense fallback={<div className="h-full w-full" style={{ background: 'var(--bg-secondary, #1f1f1f)' }} />}>
          <LazyDepthOfMarket
            symbol={panels.domSymbol}
            onClose={() => panels.setShowDOM(false)}
            onCloseBulk={onCloseBulk}
            onDragHandleMouseDown={panels.handleDomMouseDown}
            onPlaceOrder={onPlaceOrder}
          />
        </Suspense>
        {resizeEdges.map(({ mode, style }) => (
          <div
            key={mode}
            onMouseDown={(event) => panels.handleDomResizeMouseDown(event, mode)}
            style={{ position: 'absolute', zIndex: 10, ...style }}
          />
        ))}
        <div
          onMouseDown={(event) => panels.handleDomResizeMouseDown(event, 'se')}
          style={{
            position: 'absolute',
            bottom: 1,
            right: 1,
            width: 11,
            height: 11,
            cursor: 'nwse-resize',
            zIndex: 11,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '0 0 5px 0',
            color: 'var(--text-tertiary, #66666e)',
          }}
        >
          <svg width="7" height="7" viewBox="0 0 8 8" fill="none" aria-hidden="true">
            <path d="M7 1.5L1.5 7M7 4.5L4.5 7" stroke="currentColor" strokeOpacity="0.65" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    )}

    {panels.showDataWindow && (
      <div
        className="fixed z-[1200]"
        style={{
          left: panels.dataWindowPos.x,
          top: panels.dataWindowPos.y,
          width: panels.dataWindowSize.w,
          height: panels.dataWindowSize.h,
          minWidth: 200,
          minHeight: 200,
          overflow: 'hidden',
        }}
      >
        <Suspense fallback={<div className="h-full w-full bg-[#131316]" />}>
          <LazyDataWindow
            onClose={() => panels.setShowDataWindow(false)}
            onDragHandleMouseDown={panels.handleDataWindowMouseDown}
          />
        </Suspense>
        {resizeEdges.map(({ mode, style }) => (
          <div
            key={mode}
            onMouseDown={(event) => panels.handleDataWindowResizeMouseDown(event, mode)}
            style={{ position: 'absolute', zIndex: 20, ...style }}
          />
        ))}
        <div
          onMouseDown={(event) => panels.handleDataWindowResizeMouseDown(event, 'se')}
          style={{ position: 'absolute', bottom: 0, right: 0, width: 14, height: 14, cursor: 'nwse-resize', zIndex: 21, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
            <path d="M7 1L1 7M7 4L4 7M7 7L7 7" stroke="#505060" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    )}
  </>
);
