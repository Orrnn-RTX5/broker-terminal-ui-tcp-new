import { useUiTranslation } from '../../hooks/useUiTranslation';
/**
 * DockPanel Component
 * MT5-style panel with thin title bar — supports Minimize and Close.
 *
 * Minimize: collapses content, shows only the title bar (click title to restore).
 * Close:    removes the panel from the dock layout entirely.
 */

import { Icon } from '../ui/Icon';
import React, { useState } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { DockPanelConfig } from '../../services/dockManager';
import { X, Minus, Maximize, Minimize } from 'lucide-react';
import { ChartSymbolTabs } from './ChartSymbolTabs';
import { ActiveChartWindowBorder } from './ActiveChartWindowBorder';
import { MarketWatchServerClock } from '../layout/MarketWatchServerClock';
import { useTerminalBarsStore } from '../../store/useTerminalBarsStore';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const NON_MINIMIZABLE_COMPONENTS = new Set(['EmptyChartArea', 'Navigator', 'MarketWatch', 'Terminal']);
const INNER_HEADER_SELECTOR = '.rtx-market-watch__header, .rtx-bottom-dock__header, [data-dock-inner-header="true"]';
const NON_DRAG_INTERACTIVE_SELECTOR = 'button:not([role="tab"]):not([data-dock-drag-handle="true"]), input, select, textarea, a, [role="button"], [contenteditable="true"]';
const NON_FLOAT_DOUBLE_CLICK_SELECTOR = 'button:not([role="tab"]), input, select, textarea, a, [role="button"], [contenteditable="true"]';

export interface DockPanelProps {
  panel: DockPanelConfig;
  isActive?: boolean;
  isFloating?: boolean;
  isMaximized?: boolean;
  isDropTarget?: boolean;
  showHeader?: boolean;
  className?: string;
  children?: React.ReactNode;
  onClose?: () => void;
  onFloat?: () => void;
  onActivate?: () => void;
  onMinimizedChange?: (minimized: boolean) => void;
  onMaximizedChange?: (maximized: boolean) => void;
  onDragStart?: (e: React.MouseEvent | React.TouchEvent) => void;
  style?: React.CSSProperties;
}

export const DockPanel: React.FC<DockPanelProps> = ({
  panel,
  isActive = true,
  isFloating = false,
  isMaximized = false,
  isDropTarget,
  showHeader = true,
  className,
  children,
  onClose,
  onFloat,
  onActivate,
  onMinimizedChange,
  onMaximizedChange,
  onDragStart,
  style,
}) => {
    const tr = useUiTranslation();
  // Docked windows use layout state; standalone panels keep local control.
  const [localMinimized, setLocalMinimized] = useState(false);
  const [localMaximized, setLocalMaximized] = useState(false);
  const minimized = onMinimizedChange ? Boolean(panel.minimized) : localMinimized;
  const maximized = onMaximizedChange ? Boolean(isMaximized) : localMaximized;
  const isChart = panel.component === 'Chart';
  const chartsBarVisible = useTerminalBarsStore(state => state.chartsBarVisible);
  const chartSymbol = typeof panel.props?.symbol === 'string' ? panel.props.symbol : panel.title.split(',')[0];
  const setMinimized = (value: boolean) => {
    if (onMinimizedChange) onMinimizedChange(value);
    else {
      setLocalMinimized(value);
      if (value) setLocalMaximized(false);
    }
  };
  const setMaximized = (value: boolean) => {
    if (onMaximizedChange) onMaximizedChange(value);
    else {
      setLocalMaximized(value);
      if (value) setLocalMinimized(false);
    }
  };

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden relative',
        panel.component === 'EmptyChartArea' ? 'bg-[#0d0d11]' : 'bg-[#131316]',
        minimized ? 'h-[26px]' : 'h-full',
        isFloating && 'shadow-2xl border border-zinc-600/40',
        !isFloating && panel.component !== 'EmptyChartArea' && 'border border-[#28282e]/60',
        isDropTarget && 'ring-2 ring-[#8a8a8f]/40 ring-inset',
        className
      )}
      style={style}
      onMouseDown={(e) => {
        onActivate?.();
        if (!showHeader || isFloating) {
          const target = e.target as HTMLElement | null;
          if (
            target?.closest(INNER_HEADER_SELECTOR) &&
            !(showHeader && target.closest('.dock-panel__header')) &&
            !target.closest(NON_DRAG_INTERACTIVE_SELECTOR)
          ) {
            onDragStart?.(e);
          }
        }
      }}
      onDoubleClick={(e) => {
        if (!showHeader || isFloating) {
          const target = e.target as HTMLElement | null;
          if (
            target?.closest(INNER_HEADER_SELECTOR) &&
            !(showHeader && target.closest('.dock-panel__header')) &&
            !target.closest(NON_FLOAT_DOUBLE_CLICK_SELECTOR)
          ) {
            if (panel.floatable === false) return;
            e.preventDefault();
            e.stopPropagation();
            onFloat?.();
          }
        }
      }}
    >
      {isChart && isActive && !minimized && !maximized && <ActiveChartWindowBorder panelId={panel.id} />}
      {/* ── MT5-style thin title bar ── */}
      {showHeader && (
        <div
          className={cn(
            'dock-panel__header flex items-center h-[26px] select-none flex-shrink-0',
            isChart && chartsBarVisible ? 'pl-0 pr-1.5' : 'px-1.5',
            // Make cursor a pointer when minimized (click to restore)
            minimized ? 'cursor-pointer' : 'cursor-default',
            isActive
              ? 'dock-panel__header--active bg-[#202126] border-b border-[#34363d]'
              : 'dock-panel__header--inactive bg-[#17181c] border-b border-[#27282d]',
          )}
          onMouseDown={(e) => {
            // Click on empty header area while minimized → restore
            const target = e.target as HTMLElement;
            if (target.closest(NON_DRAG_INTERACTIVE_SELECTOR)) return;
            if (minimized) {
              setMinimized(false);
              return;
            }
            if (maximized) return;
            onDragStart?.(e);
          }}
          onDoubleClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest(NON_FLOAT_DOUBLE_CLICK_SELECTOR)) return;
            if (maximized) {
              e.preventDefault();
              e.stopPropagation();
              setMaximized(false);
              return;
            }
            if (panel.floatable === false) return;
            e.preventDefault();
            e.stopPropagation();
            onFloat?.();
          }}
          title={minimized ? tr("Click to restore {{value0}}", { value0: panel.title }) : undefined}
        >
          {/* Title */}
          <span className="dock-panel__title flex-1 min-w-0 h-full overflow-hidden flex items-center gap-1 text-[14px] font-normal text-zinc-300 truncate leading-[30px]">
            {isChart && chartsBarVisible ? (
              <ChartSymbolTabs panel={panel} />
            ) : panel.component === 'MarketWatch' ? (
              <MarketWatchServerClock variant="header" />
            ) : (
              tr(panel.title)
            )}
            {minimized && (
              <span className="ml-1 text-[12px] font-normal text-zinc-600 italic">{tr("(minimized)")}</span>
            )}
          </span>

          {/* ── Fullscreen / Maximize ↔ Exit Fullscreen / Restore Down button (charts only) ── */}
          {isChart && (
            <button
              type="button"
              data-dock-action="maximize"
              data-dock-maximized-button={maximized ? 'true' : 'false'}
              aria-pressed={maximized}
              aria-label={tr(
                maximized ? 'Exit fullscreen chart {{symbol}}' : 'Fullscreen chart {{symbol}}',
                { symbol: chartSymbol },
              )}
              onClick={(e) => {
                e.stopPropagation();
                setMaximized(!maximized);
              }}
              className={cn(
                'dock-panel__action dock-panel__action--maximize shrink-0 flex items-center justify-center w-6 h-6 rounded-sm hover:bg-zinc-600/80 text-zinc-400 hover:text-white transition-colors mr-0.5',
                maximized && 'dock-panel__action--maximized text-zinc-200',
              )}
              title={maximized ? tr("Exit Fullscreen") : tr("Fullscreen")}
            >
              {maximized ? <Minimize className="w-3 h-3" /> : <Maximize className="w-3 h-3" />}
            </button>
          )}

          {/* ── Minimize button ── */}
          {!NON_MINIMIZABLE_COMPONENTS.has(panel.component) && (
            <button
              type="button"
              aria-label={isChart ? tr(minimized ? 'Restore chart {{symbol}}' : 'Minimize chart {{symbol}}', { symbol: chartSymbol }) : `${tr(minimized ? 'Restore' : 'Minimize')} ${tr(panel.title)}`}
              onClick={(e) => {
                e.stopPropagation();
                setMinimized(!minimized);
              }}
              className="dock-panel__action shrink-0 flex items-center justify-center w-6 h-6 rounded-sm hover:bg-zinc-600/80 text-zinc-400 hover:text-white transition-colors mr-0.5"
              title={minimized ? tr("Restore") : tr("Minimize")}
            >
              {minimized ? <Icon name="chevron-up" size="xs" /> : <Minus className="w-2.5 h-2.5" />
              }
            </button>
          )}

          {/* ── Close button ── */}
          {panel.closable !== false && (
            <button
              type="button"
              aria-label={isChart ? tr('Close chart {{symbol}}', { symbol: chartSymbol }) : `${tr('Close')} ${tr(panel.title)}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose?.();
              }}
              className="dock-panel__action dock-panel__action--close shrink-0 flex items-center justify-center w-6 h-6 rounded-sm hover:bg-red-500/80 text-zinc-400 hover:text-white transition-colors"
              title={tr("Close")}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* Keep chart state mounted while its window is minimized. */}
        <div hidden={minimized} className={cn('dock-panel__content flex-1 overflow-hidden min-h-0 min-w-0 relative', !minimized && 'flex flex-col')}>
          {children || (
            <div className="flex items-center justify-center h-full text-zinc-500 p-4">
              <p className="text-xs">{tr(panel.title)}</p>
            </div>
          )}
        </div>
    </div>
  );
};

export default DockPanel;
