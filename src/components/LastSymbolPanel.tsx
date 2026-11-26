import { useUiTranslation } from '../hooks/useUiTranslation';
import i18n from '../i18n';
/**
 * Last Symbol Trading Panel
 * Floating panel that follows the selected chart immediately, with the last
 * traded symbol as a fallback when no chart selection is supplied.
 * 
 * Features:
 * - Live BID/ASK display for the selected symbol
 * - One-click BUY LAST / SELL LAST 
 * - Close all positions on last symbol
 * - Volume control with risk-based sizing option
 * - Auto SL/TP (fixed pips)
 * - Keyboard shortcuts: Shift+B (Buy), Shift+S (Sell), Shift+X (Close)
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { getLiveQuotesVersion, subscribeLiveQuotes } from '../services/liveQuotes';
import { getLiveSymbolPnLFromSource } from '../services/livePositionAggregates';
import { useFloatingPanelDrag } from '../hooks/useFloatingPanelDrag';
import { useQuoteTickDirection } from '../hooks/useQuoteTickDirection';
import { Icon } from './ui/Icon';
import { DailyChangeSummary } from './market-watch/DailyChangeSummary';
import { useLastSymbolStore } from '../store/useLastSymbolStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAppStore } from '../store/useAppStore';
import { refreshHistoryAfterFill } from '../app/trading/tradeHistoryFreshness';
import { api } from '../services/api';
import { isBinaryTcpOrderEnabled } from '../services/binaryTcpOrderClient';
import { captureTradeOrderIntent } from '../services/orderLatencyTelemetry';
import { isShortcutInput, isShortcutLocalScope, isShortcutOverlay, shouldIgnoreShortcutEvent } from '../services/keyboardShortcutManager';
import { formatSpreadDisplayWithUnit } from '../utils/spread';
import { formatOrderError } from '../utils/orderError';
import { accountMetricProvided } from '../services/accountMetrics';
import { METRIC_UNAVAILABLE } from '../features/bottom-dock/trade/tradeTabModel';
import { resolveAccountCurrencyDigits } from '../utils/accountCurrency';
import { hasAuthenticatedTradingSession, requireTradingAuth } from '../services/tradingAuthGate';
import { useSymbolMarketStatus } from '../hooks/useSymbolMarketStatus';
import {
    getMarketStatusTradeBlockMessage,
    shouldBlockSymbolTrading,
} from '../utils/marketStatus';
import {
    normalizeExactBrokerSymbol,
    resolveExactBrokerSymbolValue,
} from '../utils/exactBrokerSymbol';
import { getPipSizeFromDigits, resolveSpecDigits } from '../utils/symbolUtils';
import { handleStalePositionRefusal } from '../utils/stalePositionRefusal';
import { readRegisteredSymbolContractSpec, readRegisteredSymbolPriceSpec } from '../services/dailyChangePriceModeRegistry';

const PANEL_WIDTH = 368;
const PANEL_EDGE_GAP = 12;
const snapToPixel = (value: number) => {
    const scale = window.devicePixelRatio || 1;
    return Math.round(value * scale) / scale;
};
const ACCOUNT_VALUE_FORMATTER = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});
const clampPanelPosition = (position: { x: number; y: number }, panel: HTMLDivElement | null) => ({
    x: snapToPixel(Math.max(
        PANEL_EDGE_GAP,
        Math.min(Math.max(PANEL_EDGE_GAP, window.innerWidth - (panel?.offsetWidth || PANEL_WIDTH) - PANEL_EDGE_GAP), position.x),
    )),
    y: snapToPixel(Math.max(
        PANEL_EDGE_GAP,
        Math.min(Math.max(PANEL_EDGE_GAP, window.innerHeight - (panel?.offsetHeight || 96) - PANEL_EDGE_GAP), position.y),
    )),
});

// Fail-closed: any unreadable setting disables instant send and forces confirm.
const isOneClickTradingEnabledFailClosed = (): boolean => {
    try {
        const trade = useSettingsStore.getState()?.trade as { oneClickTrading?: unknown } | undefined;
        return trade?.oneClickTrading === true;
    } catch {
        return false;
    }
};

const noopSubscribe = () => () => {};
const zeroSnapshot = () => 0;

export function LastSymbolPanel({ symbol }: { symbol?: string } = {}) {
    const tr = useUiTranslation();
    const {
        lastSymbol: lastTradedSymbol,
        lastTradeSide: recordedTradeSide,
        lastTradeTime: recordedTradeTime,
        volume,
        useRiskSizing,
        riskPercent,
        autoSLTP,
        slPips,
        tpPips,
        setLastSymbol,
        setPanelVisible,
        setVolume,
        setUseRiskSizing,
        setRiskPercent,
        setAutoSLTP,
        setSLPips,
        setTPPips,
    } = useLastSymbolStore();

    const lastSymbol = (symbol ?? lastTradedSymbol).trim();
    const exactLastSymbol = normalizeExactBrokerSymbol(lastSymbol);
    const matchesLastTrade = exactLastSymbol === normalizeExactBrokerSymbol(lastTradedSymbol);
    const lastTradeSide = matchesLastTrade ? recordedTradeSide : null;
    const lastTradeTime = matchesLastTrade ? recordedTradeTime : 0;
    // Resolve only the exact broker contract; unrelated ticks do not render
    // the entire trader panel and suffixes never borrow another quote.
    const tick = useAppStore((s) => resolveExactBrokerSymbolValue(s.ticks, exactLastSymbol) ?? null);
    const account = useAppStore((s) => s.account);
const accountCurrencyDigits = resolveAccountCurrencyDigits(account);
    const positions = useAppStore((s) => s.positions);
    const accountId = useAppStore((s) => s.accountId);
    const authIdentity = useAppStore((s) => `${s.isAuthenticated}:${s.accountId}:${s.authToken}`);
    const hasTradingSession = Boolean(authIdentity) && hasAuthenticatedTradingSession();

    const [isClosing, setIsClosing] = useState(false);
    const [statusMessage, setStatusMessage] = useState('');
    const [statusType, setStatusType] = useState<'success' | 'error' | 'info'>('info');
    const [showSettings, setShowSettings] = useState(false);
    // Measure before paint so centering never transforms the text onto fractional pixels.
    const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
    const hasDragged = useRef(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const { isDragging, dragHandleProps } = useFloatingPanelDrag(panelRef, (next) => {
        hasDragged.current = true;
        setPosition(clampPanelPosition(next, panelRef.current));
    });
    const marketStatus = useSymbolMarketStatus(lastSymbol, {
        enabled: Boolean(lastSymbol),
    });

    const bid = tick?.bid ?? 0;
    const ask = tick?.ask ?? 0;
    const spread = ask - bid;

    // TERM-DIGITS-WL: spec digits only — the broker instrument catalog first,
    // then broker tick metadata (resolveSpecDigits). No symbol-name table, no
    // fallback constant. Unknown precision stays null: prices render raw
    // (String(value)), and pip-size math that cannot run without precision
    // degrades honestly (see below).
    const digits = resolveSpecDigits(readRegisteredSymbolPriceSpec(lastSymbol).digits, tick?.digits);
    // Pip from broker digits via the terminal's single pip rule
    // (getPipSizeFromDigits, shared with spread and chart controls).
    // Null when precision is unknown: no invented pip.
    const pipSize = getPipSizeFromDigits(digits);
    // Spread pips from the same catalog-first spec digits as the prices.
    const spreadDisplay = formatSpreadDisplayWithUnit(lastSymbol, tick?.spread ?? spread, bid, ask, digits);

    // FIX: Closing/summary ownership follows the same exact contract identity
    // as its quote; case/whitespace may differ but punctuation never aliases.
    const lastSymbolPositions = positions.filter(
        (position) => normalizeExactBrokerSymbol(position.symbol) === exactLastSymbol,
    );
    const hasSymbolPositions = lastSymbolPositions.length > 0;
    useSyncExternalStore(
        hasSymbolPositions ? subscribeLiveQuotes : noopSubscribe,
        hasSymbolPositions ? getLiveQuotesVersion : zeroSnapshot,
        zeroSnapshot,
    );
    const symbolLiveSummary = hasSymbolPositions
        ? getLiveSymbolPnLFromSource(lastSymbolPositions, exactLastSymbol)
        : { count: 0, totalPnL: 0 };
    const openSymbolCount = symbolLiveSummary.count;
    const totalPnL = symbolLiveSummary.totalPnL;

    // Broker contract size from the instrument catalog; null when the
    // catalog does not publish it (never guessed from the symbol name).
    const contractSize = readRegisteredSymbolContractSpec(lastSymbol).contractSize;

    // Calculate risk-based lot
    const calculateRiskLot = useCallback(() => {
        if (!useRiskSizing || !account) return volume;
        // Without broker precision or contract size no pip value can be
        // estimated honestly; keep the manual volume instead of guessing.
        if (pipSize === null || contractSize === null) return volume;
        const balance = account.balance || 0;
        const riskAmount = (balance * riskPercent) / 100;
        const slDistance = slPips * pipSize;
        if (slDistance <= 0) return volume;

        // Pip value per standard lot from broker data only: contract size x
        // pip size, in the symbol's quote currency (no cross-rate conversion).
        const pipValue = contractSize * pipSize;
        if (!(pipValue > 0)) return volume;
        const lot = riskAmount / (slPips * pipValue);
        return Math.max(0.01, Math.round(lot * 100) / 100);
    }, [useRiskSizing, account, volume, riskPercent, slPips, pipSize, contractSize]);

    const effectiveLot = useRiskSizing ? calculateRiskLot() : volume;
    const tradeBlockedMessage = getMarketStatusTradeBlockMessage(marketStatus, lastSymbol);
    const canPlaceTrade = Boolean(lastSymbol) && !shouldBlockSymbolTrading(marketStatus, lastSymbol);
    const sellDisabled = hasTradingSession && (!canPlaceTrade || bid === 0);
    const buyDisabled = hasTradingSession && (!canPlaceTrade || ask === 0);
    const { bidDir, askDir } = useQuoteTickDirection(lastSymbol, bid, ask);

    // Flash status message
    const flash = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'info') => {
        setStatusMessage(msg);
        setStatusType(type);
        setTimeout(() => setStatusMessage(''), 5000);
    }, []);

    // Place order via MT5 Sync API
    const placeOrder = useCallback(
        async (side: 'BUY' | 'SELL') => {
            if (!requireTradingAuth({
                source: 'last-symbol-panel',
                side,
                symbol: lastSymbol,
                volume: effectiveLot,
                bid,
                ask,
            })) return;
            if (!lastSymbol) {
                flash(tr('Missing symbol'), 'error');
                return;
            }
            const intentAtMs = captureTradeOrderIntent();
            const login = Number(accountId) || 0;
            if (!login) {
                flash('No trading account is selected. Please sign in again.', 'error');
                return;
            }
            // Status polling already keeps this rendered gate current. A forced
            // HTTP check here previously added a complete network RTT per click.
            if (!canPlaceTrade) {
                flash(tradeBlockedMessage, 'error');
                return;
            }
            const executionPrice = side === 'BUY' ? ask : bid;
            if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
                flash(tr('Awaiting quote'), 'info');
                return;
            }
            // SUI-T9: one-click OFF opens the order dialog, never an instant
            // order. The dialog carries symbol/side context via the event.
            if (!isOneClickTradingEnabledFailClosed()) {
                window.dispatchEvent(new CustomEvent('openNewOrder', { detail: { symbol: lastSymbol, side } }));
                return;
            }

            try {
                const orderData: {
                    symbol: string;
                    side: 'buy' | 'sell';
                    volume: number;
                    login: number;
                    price_sl?: number;
                    price_tp?: number;
                } = {
                    // FIX: Send the canonical exact contract while retaining
                    // all broker punctuation and suffixes.
                    symbol: exactLastSymbol,
                    side: side === 'BUY' ? 'buy' : 'sell',
                    volume: effectiveLot,
                    login,
                };

                // Deliberately omit the old informational REST-only comment so
                // standard Last Symbol orders can use the fixed low-latency WS
                // contract. User-authored comments elsewhere are still kept on REST.

                // Auto SL/TP needs broker precision; with unknown digits the
                // order submits unprotected (no guessed pip, no fallback).
                if (autoSLTP && slPips > 0 && pipSize !== null) {
                    const basePrice = side === 'BUY' ? ask : bid;
                    if (basePrice > 0) {
                        orderData.price_sl =
                            side === 'BUY'
                                ? basePrice - slPips * pipSize
                                : basePrice + slPips * pipSize;
                        if (tpPips > 0) {
                            orderData.price_tp =
                                side === 'BUY'
                                    ? basePrice + tpPips * pipSize
                                    : basePrice - tpPips * pipSize;
                        }
                    }
                }

                const orderPromise = api.orders.placeMarketOrder(orderData, { intentAtMs });
                // Do not serialize deliberate one-click orders behind a prior
                // terminal fill; every call owns separate durable correlation IDs.
                await orderPromise;
                import('../utils/audio').then((m) => m.playSystemSound(side === 'SELL' ? 'sell' : 'buy')).catch(() => undefined);
                refreshHistoryAfterFill(Number(accountId));
                setLastSymbol(exactLastSymbol, side);
                window.dispatchEvent(new Event('rtx:force-refresh-positions'));
                flash(`${tr(side)} ${effectiveLot} ${lastSymbol} ✓`, 'success');
            } catch (err: unknown) {
                console.error('LastSymbolPanel order failed:', err);
                flash(formatOrderError(err), 'error');
            }
        },
        [lastSymbol, exactLastSymbol, effectiveLot, autoSLTP, slPips, tpPips, pipSize, bid, ask, accountId, canPlaceTrade, tradeBlockedMessage, setLastSymbol, flash, tr]
    );

    // Close positions on last symbol via MT5 Sync API
    const closeLastPositions = useCallback(async () => {
        const targetPositions = lastSymbolPositions;
        if (isClosing || !lastSymbol || targetPositions.length === 0) {
            if (targetPositions.length === 0) flash(`${tr('No open positions')} · ${lastSymbol}`, 'info');
            return;
        }

        const intentAtMs = captureTradeOrderIntent();
        setIsClosing(true);
        try {
            if (isBinaryTcpOrderEnabled() && accountId) {
                const candidateIds = targetPositions.map((pos) => pos.id);
                const closedIdSet = new Set<number>(candidateIds);
                await api.positions.closeBulk(Number(accountId), 'ALL', exactLastSymbol, {
                    intentAtMs,
                    expectedCount: targetPositions.length,
                });
                useAppStore.getState().setPositions(
                    useAppStore.getState().positions.filter((position) => !closedIdSet.has(position.id)),
                    { removedTickets: candidateIds, closedTickets: candidateIds },
                );
                import('../utils/audio')
                    .then((m) => m.playSystemSound(candidateIds.length > 1 ? 'close-all' : 'close-single'))
                    .catch(() => undefined);
                refreshHistoryAfterFill(Number(accountId));
                flash(`${tr('closed')}: ${candidateIds.length} · ${lastSymbol} ✓`, 'success');
                return;
            }

            // Only positions the backend confirmed closed leave the list; a
            // rejected close keeps its row open.
            const closedIds = new Set<number>();
            let staleMessage: string | null = null;
            for (const pos of targetPositions) {
                try {
                    await api.positions.closePosition(String(pos.id));
                    closedIds.add(pos.id);
                } catch (e) {
                    // Already closed on the broker: the row is gone, with a plain message.
                    const message = handleStalePositionRefusal(e, pos.id, { refresh: () => undefined, tr });
                    if (message !== null) {
                        closedIds.add(pos.id);
                        if (staleMessage === null) staleMessage = message;
                    } else {
                        console.error('Failed to close position', pos.id, e);
                    }
                }
            }
            useAppStore.getState().setPositions(useAppStore.getState().positions.filter(
                (position) => !closedIds.has(position.id),
            ));
            if (closedIds.size > 0) {
                import('../utils/audio')
                    .then((m) => m.playSystemSound(closedIds.size > 1 ? 'close-all' : 'close-single'))
                    .catch(() => undefined);
                refreshHistoryAfterFill(Number(useAppStore.getState().accountId));
            }
            window.dispatchEvent(new Event('rtx:force-refresh-positions'));
            if (staleMessage !== null) flash(staleMessage, 'error');
            else flash(`${tr('closed')}: ${closedIds.size} · ${lastSymbol} ✓`, 'success');
        } catch (err: unknown) {
            flash(err instanceof Error ? err.message : `${tr('Close positions')}: ${tr('Failed')}`, 'error');
        } finally {
            setIsClosing(false);
        }
    }, [isClosing, lastSymbol, exactLastSymbol, lastSymbolPositions, accountId, flash, tr]);

    // Keyboard shortcuts
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            // These are exact, deliberate Shift-only trading shortcuts.
            // Composing text, held keys and other shortcut chords must never
            // submit an order or close a position through this raw listener.
            if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || shouldIgnoreShortcutEvent(e)) return;
            if (isShortcutInput(e) || isShortcutLocalScope(e) || isShortcutOverlay(e)) return;

            if (e.key === 'B' || e.key === 'b') {
                e.preventDefault();
                placeOrder('BUY');
            } else if (e.key === 'S' || e.key === 's') {
                e.preventDefault();
                placeOrder('SELL');
            } else if (e.key === 'X' || e.key === 'x') {
                e.preventDefault();
                closeLastPositions();
            }
        };

        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [placeOrder, closeLastPositions]);

    useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!panel) return;
        const resolveChartHost = () => (
            typeof document !== 'undefined'
                ? (document.querySelector<HTMLElement>('.rtx-chart-panel[data-chart-panel-active="true"]')
                    ?? document.querySelector<HTMLElement>('.rtx-chart-panel'))
                : null
        );
        const updatePosition = () => {
            const bounds = panel.getBoundingClientRect();
            const isLaptopViewport = window.innerWidth <= 1720 || window.innerHeight <= 920;
            const chartHost = isLaptopViewport ? resolveChartHost() : null;
            const chartRect = chartHost?.getBoundingClientRect();
            const hasValidChartRect = Boolean(chartRect && chartRect.width > 120 && chartRect.height > 120);
            const defaultX = hasValidChartRect && chartRect
                ? chartRect.left + (chartRect.width - bounds.width) / 2
                : (window.innerWidth - bounds.width) / 2;
            const defaultY = hasValidChartRect && chartRect
                ? chartRect.top + (chartRect.height - bounds.height) / 2
                : isLaptopViewport
                    ? Math.max(42, (window.innerHeight - bounds.height) * 0.3)
                    : (window.innerHeight - bounds.height) / 2;
            setPosition((current) => {
                const next = clampPanelPosition(hasDragged.current && current ? current : {
                    x: defaultX,
                    y: defaultY,
                }, panel);
                return current?.x === next.x && current.y === next.y ? current : next;
            });
        };
        updatePosition();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
        observer?.observe(panel);
        const chartHost = resolveChartHost();
        if (chartHost) observer?.observe(chartHost);
        window.addEventListener('resize', updatePosition);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', updatePosition);
        };
    }, []);

    // Time since last trade
    const timeSince = lastTradeTime
        ? (() => {
            const diff = Math.max(0, Math.floor((Date.now() - lastTradeTime) / 1000));
            const formatter = new Intl.RelativeTimeFormat(i18n.resolvedLanguage || i18n.language || 'en', { numeric: 'auto', style: 'short' });
            if (diff < 60) return formatter.format(-diff, 'second');
            if (diff < 3600) return formatter.format(-Math.floor(diff / 60), 'minute');

            return formatter.format(-Math.floor(diff / 3600), 'hour');
        })()
        : '';

    return (
        <div
            ref={panelRef}
            className={`rtx-last-symbol-panel${isDragging ? ' is-dragging' : ''}`}
            style={{ left: position?.x ?? 0, top: position?.y ?? 0, visibility: position ? 'visible' : 'hidden' }}
            onPointerDown={event => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()}
            role="region"
            aria-label={tr("Last symbol trader")}
        >
            <div className="last-symbol-card">
                <header className="last-symbol-header" {...dragHandleProps}>
                    <div className="last-symbol-brand">
                        <span className="last-symbol-brand__icon" aria-hidden="true">
                            <Icon name="zap" size="sm" />
                        </span>
                        <span>
                            <strong>{tr("Last Symbol Trader")}</strong>
                        </span>
                    </div>
                    <div className="last-symbol-header__actions">
                        <button
                            type="button"
                            onClick={() => setShowSettings(!showSettings)}
                            className={`last-symbol-icon-button${showSettings ? ' is-active' : ''}`}
                            title={tr("Execution settings")}
                            aria-label={tr("Execution settings")}
                            aria-expanded={showSettings}
                            aria-controls="last-symbol-settings"
                        >
                            <Icon name="settings" size="sm" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setPanelVisible(false)}
                            className="last-symbol-icon-button last-symbol-icon-button--close"
                            title={tr("Close trader panel")}
                            aria-label={tr("Close trader panel")}
                        >
                            <Icon name="x-close" size="sm" />
                        </button>
                    </div>
                </header>

                <section className="last-symbol-summary" aria-label={tr(symbol === undefined ? "Last traded symbol" : "Selected symbol")}>
                    <div className="last-symbol-section-heading">
                        <span>{tr(symbol === undefined ? "Last traded symbol" : "Selected symbol")}</span>
                    </div>
                    <div className="last-symbol-summary__row">
                        <div>
                            <div className="last-symbol-value" data-empty={!lastSymbol}>
                                {lastSymbol || tr('Missing symbol')}
                            </div>
                            {lastSymbol && <DailyChangeSummary symbol={lastSymbol} digits={digits} />}
                        </div>
                        {lastTradeSide ? (
                            <div className="last-symbol-history">
                                <span className="last-symbol-side" data-side={lastTradeSide.toLowerCase()}>
                                     {tr(lastTradeSide)}
                                </span>
                                <span>{timeSince}</span>
                            </div>
                        ) : null}
                    </div>
                </section>

                <section className="last-symbol-volume" aria-labelledby="last-symbol-volume-title">
                    <div className="last-symbol-section-heading">
                        <span id="last-symbol-volume-title">{tr("Volume")}</span>
                        <span className="last-symbol-unit">
                            {useRiskSizing ? tr("{{value0}}% risk", { value0: riskPercent }) : tr("Lots")}
                        </span>
                    </div>
                    <div className="last-symbol-stepper">
                        <button
                            type="button"
                            onClick={() => setVolume(volume - 0.01)}
                            disabled={volume <= 0.01 || useRiskSizing}
                            aria-label={tr("Decrease order volume")}
                        >
                            <Icon name="minus" size="sm" />
                        </button>
                        <input
                            type="number"
                            step={0.01}
                            min={0.01}
                            value={(useRiskSizing ? effectiveLot : volume).toFixed(2)}
                            onChange={(e) => {
                                const val = parseFloat(e.target.value);
                                if (!isNaN(val) && val >= 0.01) setVolume(val);
                            }}
                            disabled={useRiskSizing}
                            aria-label={tr("Order volume in lots")}
                        />
                        <button
                            type="button"
                            onClick={() => setVolume(volume + 0.01)}
                            disabled={useRiskSizing}
                            aria-label={tr("Increase order volume")}
                        >
                            <Icon name="plus" size="sm" />
                        </button>
                    </div>
                    <div className="last-symbol-presets" aria-label={tr("Volume presets")}>
                        {[0.01, 0.05, 0.1, 0.5, 1.0].map((preset) => {
                            const isSelected = Math.abs(volume - preset) < 0.001;
                            return (
                                <button
                                    type="button"
                                    key={preset}
                                    onClick={() => setVolume(preset)}
                                    disabled={useRiskSizing}
                                    className={isSelected ? 'is-selected' : ''}
                                    aria-pressed={isSelected}
                                    aria-label={tr("Set order volume to {{value0}} lots", { value0: preset })}
                                >
                                    {preset.toFixed(2)}
                                </button>
                            );
                        })}
                    </div>
                </section>

                {autoSLTP && (
                    <div className="last-symbol-protection-summary">
                        <span><Icon name="shield" size="xs" /> {tr(" Protection on")}</span>
                        <span className="last-symbol-protection-summary__sl">{tr("SL ")}{slPips}</span>
                        <span className="last-symbol-protection-summary__tp">{tr("TP ")}{tpPips}</span>
                    </div>
                )}
                {canPlaceTrade === false && lastSymbol && !statusMessage && (
                    <div className="last-symbol-notice" role="status">
                        {tradeBlockedMessage || marketStatus.label}
                    </div>
                )}

                <section className="last-symbol-execution" aria-labelledby="last-symbol-execution-title">
                    <div className="last-symbol-section-heading">
                        <span id="last-symbol-execution-title">{tr("Market order")}</span>
                        <span className="last-symbol-unit">
                            {lastSymbol ? tr("Spread {{value0}}", { value0: spreadDisplay }) : ''}
                        </span>
                    </div>
                    <div className="last-symbol-actions">
                        <button
                            type="button"
                            onClick={() => placeOrder('SELL')}
                            disabled={sellDisabled}
                            className="last-symbol-trade-button last-symbol-trade-button--sell"
                            data-side="sell"
                            data-dir={bidDir}
                            aria-label={tr("Sell {{value0}} at market", { value0: lastSymbol || tr('Last Symbol') })}
                            title={tr("Sell at market (Shift+S)")}
                        >
                            <span className="last-symbol-trade-button__price">
                                {bid > 0 ? (digits === null ? String(bid) : bid.toFixed(digits)) : '—'}
                            </span>
                            <span className="last-symbol-trade-button__label">{tr("SELL")}</span>
                        </button>

                        <button
                            type="button"
                            onClick={() => placeOrder('BUY')}
                            disabled={buyDisabled}
                            className="last-symbol-trade-button last-symbol-trade-button--buy"
                            data-side="buy"
                            data-dir={askDir}
                            aria-label={tr("Buy {{value0}} at market", { value0: lastSymbol || tr('Last Symbol') })}
                            title={tr("Buy at market (Shift+B)")}
                        >
                            <span className="last-symbol-trade-button__label">{tr("BUY")}</span>
                            <span className="last-symbol-trade-button__price">
                                {ask > 0 ? (digits === null ? String(ask) : ask.toFixed(digits)) : '—'}
                            </span>
                        </button>
                    </div>
                </section>

                {statusMessage && (
                    <div
                        className="last-symbol-alert"
                        data-tone={statusType}
                        role={statusType === 'error' ? 'alert' : 'status'}
                    >
                        {tr(statusMessage)}
                    </div>
                )}

                <div className="last-symbol-close-row">
                    <button
                        type="button"
                        onClick={closeLastPositions}
                        disabled={isClosing || openSymbolCount === 0}
                        className="last-symbol-close-button"
                        aria-label={tr("Close all {{value0}} positions", { value0: lastSymbol || tr('Last Symbol') })}
                        title={tr("Close positions (Shift+X)")}
                    >
                        <span className="last-symbol-close-button__label">
                            <Icon name="x-close" size="xs" />
                            {isClosing ? tr("Closing positions") : tr("Close positions")}
                        </span>
                        <span className="last-symbol-close-button__value">
                            {openSymbolCount > 0 ? (
                                <>
                                    {openSymbolCount}
                                    <strong data-tone={totalPnL >= 0 ? 'profit' : 'loss'}>
                                        {totalPnL >= 0 ? '+' : ''}{totalPnL.toFixed(accountCurrencyDigits)}
                                    </strong>
                                </>
                            ) : tr("None open")}
                        </span>
                    </button>
                </div>

                {showSettings && (
                    <section id="last-symbol-settings" className="last-symbol-settings" aria-label={tr("Execution settings panel")}>
                        <div className="last-symbol-settings__heading">
                            <span>{tr("Execution settings")}</span>
                            <small>{tr("Applied to the next order")}</small>
                        </div>

                        <label className="last-symbol-setting-row">
                            <span>
                                <strong>{tr("Risk-based sizing")}</strong>
                                <small>{tr("Calculate lots from account balance")}</small>
                            </span>
                            <span className="last-symbol-toggle">
                                <input
                                    type="checkbox"
                                    checked={useRiskSizing}
                                    onChange={(e) => setUseRiskSizing(e.target.checked)}
                                />
                                <span aria-hidden="true" />
                            </span>
                        </label>
                        {useRiskSizing && (
                            <label className="last-symbol-field">
                                <span>{tr("Account risk ")}<small>%</small></span>
                                <input
                                    type="number"
                                    step={0.1}
                                    min={0.1}
                                    max={100}
                                    value={riskPercent}
                                    onChange={(e) => setRiskPercent(parseFloat(e.target.value) || 1)}
                                />
                            </label>
                        )}

                        <label className="last-symbol-setting-row">
                            <span>
                                <strong>{tr("Automatic protection")}</strong>
                                <small>{tr("Add stop loss and take profit")}</small>
                            </span>
                            <span className="last-symbol-toggle">
                                <input
                                    type="checkbox"
                                    checked={autoSLTP}
                                    onChange={(e) => setAutoSLTP(e.target.checked)}
                                />
                                <span aria-hidden="true" />
                            </span>
                        </label>
                        {autoSLTP && (
                            <div className="last-symbol-protection-fields">
                                <label className="last-symbol-field last-symbol-field--loss">
                                    <span>{tr("Stop loss ")}<small>{tr("pips")}</small></span>
                                    <input
                                        type="number"
                                        min={1}
                                        value={slPips}
                                        onChange={(e) => setSLPips(parseInt(e.target.value) || 30)}
                                    />
                                </label>
                                <label className="last-symbol-field last-symbol-field--profit">
                                    <span>{tr("Take profit ")}<small>{tr("pips")}</small></span>
                                    <input
                                        type="number"
                                        min={1}
                                        value={tpPips}
                                        onChange={(e) => setTPPips(parseInt(e.target.value) || 60)}
                                    />
                                </label>
                            </div>
                        )}
                    </section>
                )}

                {account && (
                    <dl className="last-symbol-account-summary">
                        <div>
                            <dt>{tr("Balance")}</dt>
                            <dd>{ACCOUNT_VALUE_FORMATTER.format(account.balance ?? 0)}</dd>
                        </div>
                        <div>
                            <dt>{tr("Equity")}</dt>
                            <dd>{accountMetricProvided(account, 'equity') === null ? METRIC_UNAVAILABLE : ACCOUNT_VALUE_FORMATTER.format(accountMetricProvided(account, 'equity') ?? 0)} {account.currency || 'USD'}</dd>
                        </div>
                    </dl>
                )}

            </div>
        </div>
    );
}
