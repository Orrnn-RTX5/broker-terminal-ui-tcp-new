import React, { useLayoutEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { getLiveQuotesVersion, subscribeLiveQuotes } from '../../services/liveQuotes';
import { getLivePositionProfit } from '../../services/livePositionMetrics';
import { useBulkCloseConfirmStore } from '../../store/useBulkCloseConfirmStore';
import { useAppStore, type Position } from '../../store/useAppStore';
import { useUiTranslation } from '../../hooks/useUiTranslation';
import { useDialogFocusScope } from '../../hooks/useDialogFocusScope';
import { useDraggableSheet } from '../../hooks/useDraggableSheet';
import { resolveAccountCurrencyDigits } from '../../utils/accountCurrency';
import { readBackendPositionProfit, resolveTradeProfit } from '../BottomDock.trade';

const EMPTY_STORE_POSITIONS: Position[] = [];
const noopSubscribe = () => () => {};
const zeroSnapshot = () => 0;

export function BulkCloseConfirmDialog() {
    const tr = useUiTranslation();
    const {
        isOpen,
        type,
        positions,
        onConfirm,
        onCancel,
    } = useBulkCloseConfirmStore();
    const accountCurrencyDigits = resolveAccountCurrencyDigits(useAppStore(state => state.account));
    const storePositions = useAppStore(state => (isOpen ? state.positions : EMPTY_STORE_POSITIONS));
    const quotesVersion = useSyncExternalStore(
        isOpen ? subscribeLiveQuotes : noopSubscribe,
        isOpen ? getLiveQuotesVersion : zeroSnapshot,
        zeroSnapshot,
    );

    const backdropRef = useRef<HTMLDivElement>(null);
    const cancelBtnRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    useDialogFocusScope({ isOpen, dialogRef, onClose: onCancel, initialFocusRef: cancelBtnRef });

    // Keep the dialog top at or below the bottom dock's top border so it never
    // rises over the chart or its time axis, regardless of the user's dock height.
    useLayoutEffect(() => {
        if (!isOpen) return;
        const backdropEl = backdropRef.current;
        if (!backdropEl) return;

        const syncDockMaxHeight = () => {
            const dockEl = document.querySelector<HTMLElement>('.rtx-bottom-dock');
            if (!dockEl) {
                backdropEl.style.removeProperty('--rtx-bulk-close-max-height');
                return;
            }
            const dockRect = dockEl.getBoundingClientRect();
            if (!(dockRect.height > 0) || !(dockRect.top > 0)) {
                backdropEl.style.removeProperty('--rtx-bulk-close-max-height');
                return;
            }
            const bottomPadding = Number.parseFloat(window.getComputedStyle(backdropEl).paddingBottom) || 36;
            const backdropRect = backdropEl.getBoundingClientRect();
            const dialogBottom = backdropRect.bottom > 0
                ? backdropRect.bottom - bottomPadding
                : window.innerHeight - bottomPadding;
            const availableHeight = Math.floor(dialogBottom - dockRect.top) - 2;
            if (!Number.isFinite(availableHeight) || availableHeight <= 0) {
                backdropEl.style.removeProperty('--rtx-bulk-close-max-height');
                return;
            }
            backdropEl.style.setProperty('--rtx-bulk-close-max-height', `${Math.max(120, availableHeight)}px`);
        };

        syncDockMaxHeight();
        window.addEventListener('resize', syncDockMaxHeight);
        const dockEl = document.querySelector<HTMLElement>('.rtx-bottom-dock');
        const resizeObserver = dockEl && typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(syncDockMaxHeight)
            : null;
        if (dockEl && resizeObserver) resizeObserver.observe(dockEl);

        return () => {
            window.removeEventListener('resize', syncDockMaxHeight);
            resizeObserver?.disconnect();
            backdropEl.style.removeProperty('--rtx-bulk-close-max-height');
        };
    }, [isOpen]);

    const livePositions = useMemo(() => {
        if (!isOpen || storePositions.length === 0 || positions.length === 0) {
            return positions;
        }

        const liveById = new Map<number, Position>();
        for (const rawPosition of storePositions) {
            const ticketId = Number(
                rawPosition.id
                ?? (rawPosition as Position & { ticket?: unknown; position_id?: unknown }).ticket
                ?? (rawPosition as Position & { ticket?: unknown; position_id?: unknown }).position_id,
            );
            if (Number.isFinite(ticketId) && ticketId > 0) {
                liveById.set(ticketId, rawPosition);
            }
        }

        let hasLiveMatch = false;
        const nextPositions = positions.map((pos) => {
            const livePos = liveById.get(pos.id);
            if (!livePos) return pos;
            hasLiveMatch = true;
            const resolvedProfit = getLivePositionProfit(livePos) ?? resolveTradeProfit(livePos).value ?? readBackendPositionProfit(livePos);
            const liveVolume = Number(livePos.volume ?? livePos.quantity);
            const liveOpenPrice = Number(livePos.openPrice ?? livePos.price_open ?? livePos.open_price);
            return {
                ...pos,
                volume: Number.isFinite(liveVolume) && liveVolume > 0 ? liveVolume : pos.volume,
                openPrice: Number.isFinite(liveOpenPrice) && liveOpenPrice > 0 ? liveOpenPrice : pos.openPrice,
                pnl: resolvedProfit !== null && Number.isFinite(resolvedProfit) ? resolvedProfit : pos.pnl,
            };
        });

        return hasLiveMatch ? nextPositions : positions;
    // quotesVersion is the change signal for the live quotes read by getLivePositionProfit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, positions, storePositions, quotesVersion]);

    // Sort positions by P&L descending
    const sortedPositions = useMemo(() =>
        [...livePositions].sort((a, b) => b.pnl - a.pnl),
        [livePositions],
    );
    const { dragStyle, dragHandleProps } = useDraggableSheet({ isOpen, elementRef: dialogRef });

    if (!isOpen) return null;

    const modeKey = type === 'WINNERS' ? 'winners' : type === 'LOSERS' ? 'losers' : 'all';
    const modeLabel = type === 'ALL'
        ? tr('Close All Positions')
        : type === 'WINNERS'
            ? tr('Close In-Profit Positions')
            : tr('Close In-Loss Positions');
    const confirmButtonLabel = livePositions.length === 1
        ? `${tr('Close')} 1 ${tr('Position')}`
        : `${tr('Close')} ${livePositions.length} ${tr('Positions')}`;

    return (
        <div
            ref={backdropRef}
            className="rtx-bulk-close-backdrop"
            onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
            onContextMenuCapture={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onContextMenu={(e) => e.stopPropagation()}
        >
            <div
                ref={dialogRef}
                tabIndex={-1}
                className="rtx-bulk-close-dialog"
                data-mode={modeKey}
                role="dialog"
                aria-modal="true"
                aria-label={modeLabel}
                style={dragStyle}
            >

                {/* ─── Position Preview Table ─── */}
                <div className="rtx-bulk-close-dialog__table-wrapper">
                    <table className="rtx-bulk-close-dialog__table">
                        <colgroup>
                            <col style={{ width: '18%' }} />
                            <col style={{ width: '18%' }} />
                            <col style={{ width: '14%' }} />
                            <col style={{ width: '13%' }} />
                            <col style={{ width: '20%' }} />
                            <col style={{ width: '17%' }} />
                        </colgroup>
                        <thead {...dragHandleProps}>
                            <tr>
                                <th>{tr('Ticket')}</th>
                                <th>{tr('Symbol')}</th>
                                <th>{tr('Direction')}</th>
                                <th className="rtx-bulk-close-dialog__th-right">{tr('Volume')}</th>
                                <th className="rtx-bulk-close-dialog__th-right">{tr('Open Price')}</th>
                                <th className="rtx-bulk-close-dialog__th-right">{tr('P&L')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedPositions.map((pos) => {
                                const rowPnlTone = pos.pnl > 0 ? 'profit' : pos.pnl < 0 ? 'loss' : 'neutral';
                                const rowPnlSign = pos.pnl > 0 ? '+' : '';
                                return (
                                    <tr key={pos.id} className="rtx-bulk-close-dialog__row">
                                        <td className="rtx-bulk-close-dialog__cell-ticket">#{pos.id}</td>
                                        <td className="rtx-bulk-close-dialog__cell-symbol">{pos.symbol}</td>
                                        <td>
                                            <span className={`rtx-bulk-close-dialog__direction rtx-bulk-close-dialog__direction--${pos.side.toLowerCase()}`}>
                                                {pos.side}
                                            </span>
                                        </td>
                                        <td className="rtx-bulk-close-dialog__cell-right">{pos.volume.toFixed(2)}</td>
                                        <td className="rtx-bulk-close-dialog__cell-right">{pos.openPrice.toFixed(pos.openPrice >= 100 ? 2 : 5)}</td>
                                        <td className={`rtx-bulk-close-dialog__cell-right rtx-bulk-close-dialog__cell-pnl rtx-bulk-close-dialog__cell-pnl--${rowPnlTone}`}>
                                            {rowPnlSign}{pos.pnl.toFixed(accountCurrencyDigits)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* ─── Footer ─── */}
                <div className="rtx-bulk-close-dialog__footer">
                    <button ref={cancelBtnRef} type="button" onClick={onCancel} className="rtx-bulk-close-dialog__btn-cancel">
                        {tr('Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="rtx-bulk-close-dialog__btn-confirm"
                    >
                        {confirmButtonLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
