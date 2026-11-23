import { useUiTranslation } from '../../hooks/useUiTranslation';
import './journal-status.css';
import './journal-toolbar.css';
/**
 * JournalTab — MT5-style server journal panel
 * Fetches broker/account-scoped logs from GET /api/v2/journal.
 *
 * Filters:
 *   - Type  : All / Config / System / Network / History / User / Trade / API / Notify
 *   - Mode  : Full / Standard / Errors only
 *   - Time  : 2h / Today / Week / All
 *   - Search: Free text filter (matches against log messages)
 *
 * Loads on activation or filter changes and refreshes on explicit user demand.
 */

import React, {
    useCallback,
    useDeferredValue,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { Icon } from '../ui/Icon';
import { journalApi, type JournalLogEntry } from '../../services/api';
import { useBrokerAccountSessionScope } from '../../hooks/useBrokerAccountSessionScope';
import { useAppStore } from '../../store/useAppStore';
import {
    getJournalTradeOrderLatencySamples,
    TRADE_ORDER_LATENCY_EVENT,
    type TradeOrderLatencySample,
    type TradeOrderTerminalStatus,
} from '../../services/orderLatencyTelemetry';
import { copyTextToClipboard } from '../../utils/tradeShareLink';

// ─── Filter Options ──────────────────────────────────────────────────────────

const LOG_TYPES = [
    { value: 0, label: 'All' },
    { value: 1, label: 'Config' },
    { value: 2, label: 'System' },
    { value: 3, label: 'Network' },
    { value: 4, label: 'History' },
    { value: 5, label: 'User' },
    { value: 6, label: 'Trade' },
    { value: 7, label: 'API' },
    { value: 8, label: 'Notify' },
] as const;

const LOG_MODES = [
    { value: 2, label: 'Full' },
    { value: 0, label: 'Standard' },
    { value: 1, label: 'Errors' },
] as const;

const TIME_RANGES: { label: string; hours: number }[] = [
    { label: '2h', hours: 2 },
    { label: 'Today', hours: 24 },
    { label: 'Week', hours: 24 * 7 },
    { label: 'All', hours: 0 },
];

const JOURNAL_HEADER_HEIGHT = 30;
const JOURNAL_ROW_HEIGHT = 30;
const JOURNAL_ROW_OVERSCAN = 8;
const JOURNAL_FALLBACK_VIEWPORT_HEIGHT = 320;

const JOURNAL_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
});

// ─── Type highlight colours ───────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
    config:  'text-zinc-400',
    system:  'text-zinc-300',
    network: 'text-zinc-400',
    history: 'text-zinc-400',
    user:    'text-zinc-300',
    trade:   'text-zinc-300',
    api:     'text-zinc-400',
    notify:  'text-zinc-400',
    all:     'text-zinc-500',
};

function getTypeColor(typeText: string): string {
    return TYPE_COLOR[typeText?.toLowerCase()] || 'text-zinc-400';
}

// MT5-grade millisecond timestamp formatter: YYYY.MM.DD HH:MM:SS.mmm
const pad2 = (n: number): string => String(n).padStart(2, '0');
const pad3 = (n: number): string => String(n).padStart(3, '0');

const formatDateTime = (unixSec: number, unixMs?: number): string => {
    const epochMs = typeof unixMs === 'number' && Number.isFinite(unixMs) && unixMs > 0
        ? unixMs
        : (unixSec > 0 ? unixSec * 1000 : 0);
    if (!epochMs) return '—';
    try {
        const d = new Date(epochMs);
        if (Number.isNaN(d.getTime())) return String(unixSec);
        return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
    } catch {
        return String(unixSec);
    }
};

const formatLatencyMs = (latencyMs: number | undefined): string => {
    if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
        return '\u2014';
    }

    const rounded = Number(latencyMs.toFixed(2));
    return `${Object.is(rounded, -0) ? 0 : rounded} ms`;
};

type ScopedTradeLatency = {
    latencyMs: number;
    sequence: number;
    sessionScope: string;
};

const getTerminalTradeLatency = (
    sample: TradeOrderLatencySample,
    sessionScope: string,
): ScopedTradeLatency | null => {
    if (sample.sessionScope !== sessionScope) return null;

    const isPlacementTerminal = sample.phase === 'placement_terminal';
    const isWebSocketTerminal = sample.transport === 'websocket'
        && (sample.phase === 'order_filled' || sample.phase === 'order_rejected');
    const isRestTerminal = sample.transport === 'rest'
        && (sample.phase === 'rest_completed' || sample.phase === 'rest_failed');
    if (!isPlacementTerminal && !isWebSocketTerminal && !isRestTerminal) return null;

    // The Journal label answers "how long did the order attempt take?". Prefer
    // the complete API-to-terminal duration so a WS recovery followed by REST
    // does not misleadingly show only the final transport leg.
    const transportLatency = isWebSocketTerminal
        ? sample.terminalRttMs
        : isRestTerminal
            ? sample.restRttMs
            : undefined;
    const latencyMs = typeof sample.totalMs === 'number' && Number.isFinite(sample.totalMs)
        ? sample.totalMs
        : transportLatency;
    if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) return null;

    return {
        latencyMs,
        sequence: sample.sequence,
        sessionScope,
    };
};

const getLatestTerminalTradeLatency = (
    samples: readonly TradeOrderLatencySample[],
    sessionScope: string,
): ScopedTradeLatency | null => samples.reduce<ScopedTradeLatency | null>((latest, sample) => {
    const candidate = getTerminalTradeLatency(sample, sessionScope);
    if (!candidate || (latest && latest.sequence >= candidate.sequence)) return latest;
    return candidate;
}, null);

type PlacementTerminalSample = TradeOrderLatencySample & {
    phase: 'placement_terminal';
    terminalStatus: TradeOrderTerminalStatus;
    totalMs: number;
};

const isPlacementTerminalSample = (
    sample: TradeOrderLatencySample,
    sessionScope: string,
): sample is PlacementTerminalSample => (
    sample.phase === 'placement_terminal'
    && sample.sessionScope === sessionScope
    && (
        sample.terminalStatus === 'filled'
        || sample.terminalStatus === 'rejected'
        || sample.terminalStatus === 'expired'
        || sample.terminalStatus === 'failed'
    )
    && typeof sample.totalMs === 'number'
    && Number.isFinite(sample.totalMs)
    && sample.totalMs >= 0
);

const getScopedPlacementTerminalSamples = (
    samples: readonly TradeOrderLatencySample[],
    sessionScope: string,
): PlacementTerminalSample[] => {
    const seenAttempts = new Set<string>();
    return samples
        .filter(sample => isPlacementTerminalSample(sample, sessionScope))
        .sort((left, right) => right.sequence - left.sequence)
        .filter(sample => {
            const attemptKey = sample.clientOrderId
                ? `${sample.sessionScope}:${sample.clientOrderId}`
                : `sequence:${sample.sequence}`;
            if (seenAttempts.has(attemptKey)) return false;
            seenAttempts.add(attemptKey);
            return true;
        });
};

const formatLocalOrderVolume = (volume: number | undefined): string => (
    typeof volume === 'number' && Number.isFinite(volume)
        ? String(Number(volume.toFixed(8)))
        : ''
);

const formatLocalOrderPrice = (price: number | undefined): string => (
    typeof price === 'number' && Number.isFinite(price) && price > 0
        ? String(Number(price.toFixed(8)))
        : ''
);

const createLocalTerminalJournalEntry = (
    sample: PlacementTerminalSample,
): JournalLogEntry => {
    const trimmedErrorCode = typeof sample.errorCode === 'string' ? sample.errorCode.trim() : '';
    const trimmedErrorMessage = typeof sample.errorMessage === 'string' ? sample.errorMessage.trim() : '';
    const errorDetails = trimmedErrorCode && trimmedErrorMessage
        ? (
            trimmedErrorMessage.toUpperCase() === trimmedErrorCode.toUpperCase()
            || trimmedErrorMessage.toUpperCase().startsWith(`${trimmedErrorCode.toUpperCase()}:`)
                ? trimmedErrorMessage
                : `${trimmedErrorCode}: ${trimmedErrorMessage}`
        )
        : (trimmedErrorCode || trimmedErrorMessage);
    const isFilled = sample.terminalStatus === 'filled';

    let message: string;
    const customJournalMessage = sample.journalMessage?.trim();
    const customOperationLabel = sample.operationLabel?.trim();

    if (customJournalMessage) {
        message = !isFilled && errorDetails && !customJournalMessage.includes(errorDetails)
            ? `${customJournalMessage}: ${errorDetails}`
            : customJournalMessage;
    } else if (customOperationLabel) {
        const ticketPart = typeof sample.ticket === 'number' && Number.isFinite(sample.ticket) && sample.ticket > 0
            ? `#${Math.trunc(sample.ticket)}`
            : '';
        const pricePart = formatLocalOrderPrice(sample.price);
        const subject = [
            ticketPart,
            sample.orderSubType || sample.side,
            sample.symbol,
            formatLocalOrderVolume(sample.volume),
            pricePart ? `@ ${pricePart}` : '',
        ].filter(Boolean).join(' ');
        message = `${customOperationLabel}${subject ? ` ${subject}` : ''}${errorDetails ? `: ${errorDetails}` : ''}`;
    } else {
        const subject = [
            sample.side,
            sample.symbol,
            formatLocalOrderVolume(sample.volume),
        ].filter(Boolean).join(' ');
        const prefix = sample.terminalStatus === 'filled'
            ? 'Order executed'
            : sample.terminalStatus === 'rejected'
                ? 'Order rejected'
                : sample.terminalStatus === 'expired'
                    ? 'Order expired'
                    : 'Order failed';
        message = `${prefix}${subject ? ` ${subject}` : ''}${errorDetails ? `: ${errorDetails}` : ''}`;
    }

    return {
        id: `local-order-${sample.clientOrderId || sample.traceId}-${sample.sequence}`,
        ...(sample.clientOrderId ? { client_order_id: sample.clientOrderId } : {}),
        latency_ms: sample.totalMs,
        code: isFilled ? 0 : 1,
        code_text: isFilled ? 'OK' : sample.errorCode || sample.terminalStatus.toUpperCase(),
        type: 6,
        type_text: 'Trade',
        datetime: Math.floor(sample.recordedAtEpochMs / 1000),
        datetime_ms: Math.round(sample.recordedAtEpochMs),
        source: 'Terminal',
        message,
    };
};

// Telemetry samples are frozen after creation, so the derived local Journal row can be built once
// per sample and reused by every later merge (new server rows arrive far more often than samples).
const localTerminalJournalEntryCache = new WeakMap<PlacementTerminalSample, JournalLogEntry>();

const getLocalTerminalJournalEntry = (sample: PlacementTerminalSample): JournalLogEntry => {
    let entry = localTerminalJournalEntryCache.get(sample);
    if (entry === undefined) {
        entry = createLocalTerminalJournalEntry(sample);
        localTerminalJournalEntryCache.set(sample, entry);
    }
    return entry;
};

const getServerTerminalStatus = (
    log: JournalLogEntry,
): TradeOrderTerminalStatus | null => {
    if (log.type !== 6 && log.type_text.trim().toLowerCase() !== 'trade') return null;
    const terminalText = `${log.code_text} ${log.message}`.toLowerCase();
    if (/\b(filled|executed|completed|succeeded|opened|closed|modified|placed|cancelled|canceled)\b/.test(terminalText)) return 'filled';
    if (log.code === 0 && /^(?:timing|close|modify)\b/i.test(log.message.trim())) return 'filled';
    if (/\b(rejected|denied)\b/.test(terminalText)) return 'rejected';
    if (/\b(expired|timed out|timeout)\b/.test(terminalText)) return 'expired';
    if (/\b(failed|error)\b/.test(terminalText)) return 'failed';
    return null;
};

type HeuristicCandidateFacts = {
    messageLower: string;
    hasSide: boolean;
    hasNumber: boolean;
    isLifecycleMessage: boolean;
};

const compareJournalLogsNewestFirst = (left: JournalLogEntry, right: JournalLogEntry): number => {
    const rightMs = right.datetime_ms ?? (right.datetime * 1000);
    const leftMs = left.datetime_ms ?? (left.datetime * 1000);
    return rightMs - leftMs;
};

// Differential-tested against the original O(M x N) findIndex/some version:
// identical output and ordering, but every sample resolves through Map/Set
// indexes (exact clientOrderId queue, per-status per-second buckets).
// eslint-disable-next-line react-refresh/only-export-components
export const mergeTerminalTradeJournalLogs = (
    serverLogs: readonly JournalLogEntry[],
    terminalSamples: readonly PlacementTerminalSample[],
): JournalLogEntry[] => {
    const mergedServerLogs = serverLogs.map(log => ({ ...log }));
    if (terminalSamples.length === 0) {
        return mergedServerLogs.sort(compareJournalLogsNewestFirst);
    }
    const claimedServerRows = new Set<number>();
    const localRows: JournalLogEntry[] = [];

    // Exact client order id -> ascending indexes of terminal server rows.
    const exactQueues = new Map<string, number[]>();
    const exactHeads = new Map<string, number>();
    // Heuristic candidates (no client id, no latency, terminal status):
    // status -> floor(datetime) -> ascending indexes, plus the full ordered list.
    const heuristicBuckets = new Map<TradeOrderTerminalStatus, Map<number, number[]>>();
    const heuristicAll = new Map<TradeOrderTerminalStatus, number[]>();
    // Per-candidate message facts, computed once instead of once per (row, sample) pair.
    const candidateFacts = new Map<number, HeuristicCandidateFacts>();

    for (let index = 0; index < mergedServerLogs.length; index += 1) {
        const log = mergedServerLogs[index];
        const status = getServerTerminalStatus(log);
        if (status === null) continue;
        const rawClientId = log.client_order_id;
        const trimmedClientId = rawClientId !== undefined ? String(rawClientId).trim() : '';
        if (rawClientId !== undefined && trimmedClientId !== '') {
            const queue = exactQueues.get(trimmedClientId);
            if (queue) queue.push(index);
            else exactQueues.set(trimmedClientId, [index]);
            continue;
        }
        if (log.latency_ms !== undefined) continue;
        if (!Number.isFinite(log.datetime)) continue;
        let byStatus = heuristicBuckets.get(status);
        let all = heuristicAll.get(status);
        if (!byStatus || !all) {
            byStatus = new Map();
            all = [];
            heuristicBuckets.set(status, byStatus);
            heuristicAll.set(status, all);
        }
        const messageTrimmed = log.message.trim();
        const messageLower = messageTrimmed.toLowerCase();
        candidateFacts.set(index, {
            messageLower,
            hasSide: /\b(buy|sell)\b/.test(messageLower),
            hasNumber: /\b\d+(?:\.\d+)?\b/.test(messageLower),
            isLifecycleMessage: /^(?:position\s+opened|order\s+(?:filled|executed|completed|succeeded|rejected|expired|failed))\b/i.test(messageTrimmed),
        });
        const second = Math.floor(log.datetime);
        const bucket = byStatus.get(second);
        if (bucket) bucket.push(index);
        else byStatus.set(second, [index]);
        all.push(index);
    }

    for (const sample of terminalSamples) {
        let matchingIndex = -1;
        if (sample.clientOrderId) {
            const queue = exactQueues.get(sample.clientOrderId);
            if (queue) {
                const head = exactHeads.get(sample.clientOrderId) ?? 0;
                if (head < queue.length) {
                    matchingIndex = queue[head];
                    exactHeads.set(sample.clientOrderId, head + 1);
                }
            }
        }
        if (matchingIndex < 0) {
            localRows.push(getLocalTerminalJournalEntry(sample));
            continue;
        }

        claimedServerRows.add(matchingIndex);
        const serverTerminalStatus = getServerTerminalStatus(mergedServerLogs[matchingIndex]);
        if (
            mergedServerLogs[matchingIndex].latency_ms === undefined
            && serverTerminalStatus === sample.terminalStatus
        ) {
            mergedServerLogs[matchingIndex] = {
                ...mergedServerLogs[matchingIndex],
                latency_ms: sample.totalMs,
            };
        }
    }

    // id -> ascending positions in localRows (positions, not objects: cached rows may repeat).
    const localRowsById = new Map<string, number[]>();
    for (let position = 0; position < localRows.length; position += 1) {
        const rowId = String(localRows[position].id);
        const positions = localRowsById.get(rowId);
        if (positions) positions.push(position);
        else localRowsById.set(rowId, [position]);
    }
    const removedLocalRows = new Set<number>();

    const matchesHeuristic = (
        index: number,
        sample: PlacementTerminalSample,
        sampleSec: number,
        symbolLower: string,
        sideLower: string,
        volumeStrings: readonly [string, string] | null,
    ): boolean => {
        const log = mergedServerLogs[index];
        if (!Number.isFinite(log.datetime) || Math.abs(log.datetime - sampleSec) > 15) return false;

        const facts = candidateFacts.get(index)!;
        const messageLower = facts.messageLower;
        if (symbolLower && messageLower.includes(symbolLower)) {
            if (sideLower && facts.hasSide && !messageLower.includes(sideLower)) {
                return false;
            }
            if (volumeStrings !== null) {
                const [normalizedVol, fixedVol] = volumeStrings;
                if (
                    normalizedVol
                    && facts.hasNumber
                    && !messageLower.includes(normalizedVol)
                    && !messageLower.includes(fixedVol)
                ) {
                    return false;
                }
            }
            return true;
        }

        return Math.abs(log.datetime - sampleSec) <= 5 && facts.isLifecycleMessage;
    };

    for (const sample of terminalSamples) {
        if (sample.clientOrderId && exactQueues.has(sample.clientOrderId)) {
            continue;
        }
        if (!sample.symbol && !sample.side && !sample.clientOrderId) continue;
        const byStatus = heuristicBuckets.get(sample.terminalStatus);
        if (!byStatus) continue;

        const sampleSec = Math.floor(sample.recordedAtEpochMs / 1000);
        const symbolLower = sample.symbol ? sample.symbol.toLowerCase() : '';
        const sideLower = sample.side ? sample.side.toLowerCase() : '';
        const volumeStrings: readonly [string, string] | null = (
            typeof sample.volume === 'number' && Number.isFinite(sample.volume)
        )
            ? [formatLocalOrderVolume(sample.volume), sample.volume.toFixed(2)]
            : null;
        let heuristicIndex = -1;
        if (Number.isNaN(sampleSec)) {
            // NaN never fails the original window check; keep the linear scan.
            const all = heuristicAll.get(sample.terminalStatus) ?? [];
            for (const index of all) {
                if (claimedServerRows.has(index)) continue;
                if (matchesHeuristic(index, sample, sampleSec, symbolLower, sideLower, volumeStrings)) {
                    heuristicIndex = index;
                    break;
                }
            }
        } else if (Number.isFinite(sampleSec)) {
            for (let second = sampleSec - 15; second <= sampleSec + 15; second += 1) {
                const bucket = byStatus.get(second);
                if (!bucket) continue;
                for (const index of bucket) {
                    if (heuristicIndex >= 0 && index >= heuristicIndex) break;
                    if (claimedServerRows.has(index)) continue;
                    if (matchesHeuristic(index, sample, sampleSec, symbolLower, sideLower, volumeStrings)) {
                        heuristicIndex = index;
                        break;
                    }
                }
            }
        }
        if (heuristicIndex < 0) continue;

        claimedServerRows.add(heuristicIndex);
        mergedServerLogs[heuristicIndex] = {
            ...mergedServerLogs[heuristicIndex],
            latency_ms: sample.totalMs,
        };
        const localPosition = localRowsById.get(
            `local-order-${sample.clientOrderId || sample.traceId}-${sample.sequence}`,
        )?.shift();
        if (localPosition !== undefined) removedLocalRows.add(localPosition);
    }

    const finalLocalRows = removedLocalRows.size === 0
        ? localRows
        : localRows.filter((_, position) => !removedLocalRows.has(position));
    return [...finalLocalRows, ...mergedServerLogs].sort(compareJournalLogsNewestFirst);
};

type ServerTradeLatency = {
    latencyMs: number;
    datetime: number;
    sessionScope: string;
};

const getLatestServerTradeLatency = (
    logs: readonly JournalLogEntry[],
    sessionScope: string,
): ServerTradeLatency | null => logs.reduce<ServerTradeLatency | null>((latest, log) => {
    if (getServerTerminalStatus(log) === null
        || typeof log.latency_ms !== 'number'
        || !Number.isFinite(log.latency_ms)
        || log.latency_ms < 0
        || !Number.isFinite(log.datetime)
        || (latest && latest.datetime >= log.datetime)) return latest;
    return { latencyMs: log.latency_ms, datetime: log.datetime, sessionScope };
}, null);

const sanitizeClipboardCell = (value: unknown): string => String(value ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .trim();

const serializeJournalLogs = (logs: JournalLogEntry[]): string => {
    const header = ['Time', 'Code', 'Type', 'Source', 'Latency', 'Message'].join('\t');
    const rows = logs.map(log => [
        formatDateTime(log.datetime, log.datetime_ms),
        log.code_text || (log.code === 0 ? 'OK' : String(log.code ?? '')),
        log.type_text || 'All',
        log.source,
        formatLatencyMs(log.latency_ms),
        log.message,
    ].map(sanitizeClipboardCell).join('\t'));

    return [header, ...rows].join('\n');
};

const getJournalLogKey = (log: JournalLogEntry, index: number): React.Key => (
    log.id
    ?? log.client_order_id
    ?? log.request_id
    ?? log.position_ticket
    ?? log.order_ticket
    ?? `${log.datetime}-${log.code}-${log.type}-${index}`
);

type JournalLogTableProps = {
    logs: JournalLogEntry[];
    autoScroll: boolean;
    onAutoScrollChange: (enabled: boolean) => void;
};

const JournalLogTable = React.memo(function JournalLogTable({
    logs,
    autoScroll,
    onAutoScrollChange,
}: JournalLogTableProps) {
    const tr = useUiTranslation();
    const scrollViewportRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLTableSectionElement>(null);
    const firstRowRef = useRef<HTMLTableRowElement | null>(null);
    const [rowGeometry, setRowGeometry] = useState({
        rowHeight: JOURNAL_ROW_HEIGHT,
        headerHeight: JOURNAL_HEADER_HEIGHT,
    });
    const [viewport, setViewport] = useState({
        scrollTop: 0,
        height: JOURNAL_FALLBACK_VIEWPORT_HEIGHT,
    });
    const [selectedLogKey, setSelectedLogKey] = useState<string | null>(null);

    useLayoutEffect(() => {
        const element = scrollViewportRef.current;
        if (!element) return;

        const measure = () => {
            const height = element.clientHeight || JOURNAL_FALLBACK_VIEWPORT_HEIGHT;
            setViewport(current => current.height === height ? current : { ...current, height });
        };

        measure();
        if (typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useLayoutEffect(() => {
        if (!autoScroll) return;
        const element = scrollViewportRef.current;
        if (element) element.scrollTop = 0;
        setViewport(current => current.scrollTop === 0 ? current : { ...current, scrollTop: 0 });
    }, [autoScroll, logs]);

    const handleScroll = useCallback(() => {
        const element = scrollViewportRef.current;
        if (!element) return;

        const scrollTop = element.scrollTop;
        const height = element.clientHeight || JOURNAL_FALLBACK_VIEWPORT_HEIGHT;
        setViewport(current => (
            current.scrollTop === scrollTop && current.height === height
                ? current
                : { scrollTop, height }
        ));

        const shouldAutoScroll = scrollTop < 40;
        if (shouldAutoScroll !== autoScroll) onAutoScrollChange(shouldAutoScroll);
    }, [autoScroll, onAutoScrollChange]);

    const virtualWindow = useMemo(() => {
        const { rowHeight, headerHeight } = rowGeometry;
        const rowViewportHeight = Math.max(
            rowHeight,
            viewport.height - headerHeight,
        );
        const maxScrollTop = Math.max(
            0,
            headerHeight + logs.length * rowHeight - viewport.height,
        );
        const effectiveScrollTop = Math.min(viewport.scrollTop, maxScrollTop);
        const startIndex = Math.max(
            0,
            Math.floor(effectiveScrollTop / rowHeight) - JOURNAL_ROW_OVERSCAN,
        );
        const endIndex = Math.min(
            logs.length,
            Math.ceil((effectiveScrollTop + rowViewportHeight) / rowHeight)
                + JOURNAL_ROW_OVERSCAN,
        );

        return {
            startIndex,
            endIndex,
            topSpacerHeight: startIndex * rowHeight,
            bottomSpacerHeight: (logs.length - endIndex) * rowHeight,
        };
    }, [logs.length, viewport, rowGeometry]);

    // Density, text preferences and font loading can change the real table
    // heights. Use those same heights for the virtual window and its spacers.
    // The observer is created once; the first-row element changes whenever a
    // new log arrives, so it is re-observed from a callback ref instead of
    // recreating the observer (and forcing a sync layout read) per log row.
    const geometryObserverRef = useRef<ResizeObserver | null>(null);
    const observedFirstRowRef = useRef<HTMLTableRowElement | null>(null);
    const measureGeometryRef = useRef<(() => void) | null>(null);
    const setFirstRowElement = useCallback((node: HTMLTableRowElement | null) => {
        firstRowRef.current = node;
        const observer = geometryObserverRef.current;
        const previous = observedFirstRowRef.current;
        if (previous === node) return;
        if (observer && previous) observer.unobserve?.(previous);
        observedFirstRowRef.current = node;
        if (observer && node) observer.observe(node);
        // The first row appearing (empty -> populated) is measured once synchronously; later row swaps
        // are covered by the observer, which reports each newly observed element.
        if (node && previous === null) measureGeometryRef.current?.();
    }, []);

    useLayoutEffect(() => {
        const header = headerRef.current;
        const measure = () => {
            const firstRow = firstRowRef.current;
            const rowHeight = firstRow?.getBoundingClientRect().height || JOURNAL_ROW_HEIGHT;
            const headerHeight = header?.getBoundingClientRect().height || JOURNAL_HEADER_HEIGHT;
            setRowGeometry(current => (
                current.rowHeight === rowHeight && current.headerHeight === headerHeight
                    ? current
                    : { rowHeight, headerHeight }
            ));
        };

        measureGeometryRef.current = measure;
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        geometryObserverRef.current = observer;
        if (header) observer.observe(header);
        if (observedFirstRowRef.current) observer.observe(observedFirstRowRef.current);
        return () => {
            observer.disconnect();
            geometryObserverRef.current = null;
            measureGeometryRef.current = null;
        };
    }, []);

    const visibleLogs = logs.slice(virtualWindow.startIndex, virtualWindow.endIndex);

    return (
        <div
            ref={scrollViewportRef}
            data-testid="journal-scroll-viewport"
            onScroll={handleScroll}
            className="virtualized-list flex-1 overflow-auto scrollbar-thin scrollbar-thumb-zinc-700"
        >
            <table
                aria-rowcount={logs.length + 1}
                className="rtx-journal-table w-full table-fixed text-center border-collapse"
                style={{ fontFamily: '"Segoe UI", Tahoma, Arial, sans-serif', fontVariantNumeric: 'tabular-nums' }}
            >
                <thead ref={headerRef} className="rtx-journal-table__head sticky top-0 bg-[#17181c] text-[#c9cfdb] z-10 font-normal text-[12px] uppercase tracking-normal border-y border-zinc-700/70 select-none">
                    <tr className="h-[30px]">
                        <th className="px-1.5 py-[3px] w-48 whitespace-nowrap">{tr("Time")}</th>
                        <th className="px-1.5 py-[3px] w-16">{tr("Code")}</th>
                        <th className="px-1.5 py-[3px] w-20">{tr("Type")}</th>
                        <th className="px-1.5 py-[3px] w-28">{tr("Source")}</th>
                        <th className="px-1.5 py-[3px] w-24 whitespace-nowrap">{tr("Latency")}</th>
                        <th className="px-1.5 py-[3px] text-left">{tr("Message")}</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/90 text-zinc-100 text-[13px] leading-[19.5px] font-normal">
                    {virtualWindow.topSpacerHeight > 0 && (
                        <tr aria-hidden="true" className="rtx-journal-spacer-row" style={{ height: virtualWindow.topSpacerHeight }}>
                            <td colSpan={6} className="rtx-journal-spacer-cell p-0 border-0" style={{ padding: 0, border: 0, lineHeight: 0 }} />
                        </tr>
                    )}
                    {visibleLogs.map((log, visibleIndex) => {
                        const absoluteIndex = virtualWindow.startIndex + visibleIndex;
                        const rowKey = getJournalLogKey(log, absoluteIndex);
                        return (
                            <tr
                                key={rowKey}
                                ref={visibleIndex === 0 ? setFirstRowElement : undefined}
                                data-testid="journal-rendered-row"
                                data-row-parity={absoluteIndex % 2 === 0 ? 'odd' : 'even'}
                                aria-selected={selectedLogKey === rowKey}
                                aria-rowindex={absoluteIndex + 2}
                                onClick={() => setSelectedLogKey(rowKey)}
                                className="rtx-journal-row h-[30px] bg-[#131316] transition-colors hover:bg-[#202126]"
                            >
                                <td className="px-1.5 py-[2px] text-center text-zinc-100 whitespace-nowrap">
                                    {formatDateTime(log.datetime, log.datetime_ms)}
                                </td>
                                <td
                                    className={`px-1.5 py-[2px] text-center truncate whitespace-nowrap font-normal ${Number(log.code) ? 'text-red-400' : 'text-zinc-100'}`}
                                    title={log.code_text || (log.code === 0 ? 'OK' : String(log.code ?? ''))}
                                >
                                    {log.code_text || (log.code === 0 ? 'OK' : String(log.code ?? ''))}
                                </td>
                                <td className="px-1.5 py-[2px] text-center truncate whitespace-nowrap" title={log.type_text || 'All'}>
                                    <span className={`font-normal uppercase ${getTypeColor(log.type_text)}`}>
                                        {log.type_text || 'All'}
                                    </span>
                                </td>
                                <td className="px-1.5 py-[2px] text-center text-zinc-100 truncate max-w-[110px]" title={log.source}>
                                    {log.source}
                                </td>
                                <td className="px-1.5 py-[2px] text-center text-zinc-100 whitespace-nowrap">
                                    {formatLatencyMs(log.latency_ms)}
                                </td>
                                <td
                                    className={`px-1.5 py-[2px] text-left truncate whitespace-nowrap ${getTypeColor(log.type_text)} leading-snug`}
                                    title={log.message}
                                >
                                    {log.message}
                                </td>
                            </tr>
                        );
                    })}
                    {virtualWindow.bottomSpacerHeight > 0 && (
                        <tr aria-hidden="true" className="rtx-journal-spacer-row" style={{ height: virtualWindow.bottomSpacerHeight }}>
                            <td colSpan={6} className="rtx-journal-spacer-cell p-0 border-0" style={{ padding: 0, border: 0, lineHeight: 0 }} />
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
});

type CopyStatus = 'idle' | 'copied' | 'error';

// ─── Component ────────────────────────────────────────────────────────────────

type JournalTabSurfaceProps = {
    isAuthenticated: boolean;
    sessionScope: string;
};

function JournalTabSurface({ isAuthenticated, sessionScope }: JournalTabSurfaceProps) {
    const tr = useUiTranslation();
    const [lastTradeLatency, setLastTradeLatency] = useState<ScopedTradeLatency | null>(() => (
        getLatestTerminalTradeLatency(getJournalTradeOrderLatencySamples(), sessionScope)
    ));
    const [serverTradeLatency, setServerTradeLatency] = useState<ServerTradeLatency | null>(null);
    const [serverLogs, setServerLogs] = useState<JournalLogEntry[]>([]);
    const [terminalTradeSamples, setTerminalTradeSamples] = useState<PlacementTerminalSample[]>(() => (
        getScopedPlacementTerminalSamples(getJournalTradeOrderLatencySamples(), sessionScope)
    ));
    const [hasLoaded, setHasLoaded] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [loadedRequestKey, setLoadedRequestKey] = useState<string | null>(null);
    const [loadedSessionScope, setLoadedSessionScope] = useState<string | null>(null);
    const [errorRequestKey, setErrorRequestKey] = useState<string | null>(null);

    // Filters
    const [logType, setLogType] = useState(0);   // 0 = All
    const [logMode, setLogMode] = useState(2);   // 2 = Full
    const [timeRange, setTimeRange] = useState(0);  // 0 = All, matching the terminal-history default
    const [search, setSearch] = useState('');
    const [autoScroll, setAutoScroll] = useState(true);
    const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
    const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');

    // Keep the controls urgent. React can apply the heavier table/query update
    // immediately after the selected pill or native select has painted.
    const deferredLogType = useDeferredValue(logType);
    const deferredLogMode = useDeferredValue(logMode);
    const deferredTimeRange = useDeferredValue(timeRange);
    const deferredSearch = useDeferredValue(search);
    const isFilterSettling = logType !== deferredLogType
        || logMode !== deferredLogMode
        || timeRange !== deferredTimeRange
        || search !== deferredSearch;

    const requestKey = JSON.stringify([sessionScope, deferredLogMode, deferredLogType]);

    const manualRefreshRef = useRef<() => void>(() => undefined);
    const loadedSessionScopeRef = useRef<string | null>(null);
    const cachedResponsesRef = useRef(new Map<string, JournalLogEntry[]>());
    const cacheSessionScopeRef = useRef(sessionScope);
    const copyFeedbackTimerRef = useRef<number | null>(null);
    const copySequenceRef = useRef(0);

    useEffect(() => {
        const acceptSample = (sample: TradeOrderLatencySample): void => {
            const candidate = getTerminalTradeLatency(sample, sessionScope);
            if (candidate) {
                setLastTradeLatency(current => (
                    current?.sessionScope === sessionScope && current.sequence >= candidate.sequence
                        ? current
                        : candidate
                ));
            }
            if (!isPlacementTerminalSample(sample, sessionScope)) return;
            setTerminalTradeSamples(current => getScopedPlacementTerminalSamples(
                [...current, sample],
                sessionScope,
            ).slice(0, 200));
        };
        const handleLatency = (event: Event): void => {
            acceptSample((event as CustomEvent<TradeOrderLatencySample>).detail);
        };

        window.addEventListener(TRADE_ORDER_LATENCY_EVENT, handleLatency);
        const retainedSamples = getJournalTradeOrderLatencySamples();
        setLastTradeLatency(getLatestTerminalTradeLatency(retainedSamples, sessionScope));
        setTerminalTradeSamples(getScopedPlacementTerminalSamples(retainedSamples, sessionScope));

        return () => window.removeEventListener(TRADE_ORDER_LATENCY_EVENT, handleLatency);
    }, [sessionScope]);

    useEffect(() => {
        let disposed = false;
        let activeController: AbortController | null = null;
        let requestSequence = 0;

        if (cacheSessionScopeRef.current !== sessionScope) {
            cachedResponsesRef.current.clear();
            cacheSessionScopeRef.current = sessionScope;
        }

        const cachedLogs = isAuthenticated
            ? cachedResponsesRef.current.get(requestKey)
            : undefined;
        const canReuseCurrentResponse = isAuthenticated
            && loadedSessionScopeRef.current === sessionScope;
        let hasSuccessfulResponse = cachedLogs !== undefined || canReuseCurrentResponse;

        const loadJournal = async (): Promise<void> => {
            if (disposed || !isAuthenticated) return;

            const sequence = ++requestSequence;
            activeController?.abort();
            const controller = new AbortController();
            activeController = controller;

            if (hasSuccessfulResponse) {
                setIsRefreshing(true);
            } else {
                setIsLoading(true);
            }
            setFetchError(null);
            setErrorRequestKey(null);

            try {
                const data = await journalApi.getLogs(
                    { mode: deferredLogMode, type: deferredLogType },
                    { signal: controller.signal },
                );
                if (disposed || controller.signal.aborted || sequence !== requestSequence) return;

                hasSuccessfulResponse = true;
                cachedResponsesRef.current.set(requestKey, data.logs);
                loadedSessionScopeRef.current = sessionScope;
                setServerLogs(data.logs);
                const candidate = getLatestServerTradeLatency(data.logs, sessionScope);
                if (candidate) {
                    setServerTradeLatency(current => (
                        current?.sessionScope === sessionScope && current.datetime >= candidate.datetime
                            ? current
                            : candidate
                    ));
                }
                setHasLoaded(true);
                setLoadedRequestKey(requestKey);
                setLoadedSessionScope(sessionScope);
                setFetchError(null);
                setErrorRequestKey(null);
            } catch (err) {
                if (disposed || controller.signal.aborted || sequence !== requestSequence) return;
                setFetchError(err instanceof Error ? err.message : 'Failed to load journal');
                setErrorRequestKey(requestKey);
            } finally {
                if (!disposed && sequence === requestSequence) {
                    if (activeController === controller) activeController = null;
                    setIsLoading(false);
                    setIsRefreshing(false);
                }
            }
        };

        setFetchError(null);
        setErrorRequestKey(null);
        setIsRefreshing(false);

        if (cachedLogs !== undefined) {
            loadedSessionScopeRef.current = sessionScope;
            setServerLogs(cachedLogs);
            setHasLoaded(true);
            setLoadedRequestKey(requestKey);
            setLoadedSessionScope(sessionScope);
            setIsLoading(false);
        } else if (!canReuseCurrentResponse) {
            loadedSessionScopeRef.current = null;
            setServerLogs([]);
            setHasLoaded(false);
            setLoadedRequestKey(null);
            setLoadedSessionScope(null);
            setIsLoading(isAuthenticated);
        } else {
            // Keep the last response mounted while a new Type/Mode query loads.
            // This avoids a full table teardown and gives immediate filter feedback.
            setIsLoading(false);
        }

        const requestRefresh = () => { void loadJournal(); };
        manualRefreshRef.current = requestRefresh;
        if (isAuthenticated) void loadJournal();

        return () => {
            disposed = true;
            requestSequence += 1;
            activeController?.abort();
            if (manualRefreshRef.current === requestRefresh) {
                manualRefreshRef.current = () => undefined;
            }
        };
    }, [isAuthenticated, requestKey, deferredLogMode, deferredLogType, sessionScope]);

    const refreshJournal = useCallback(() => {
        manualRefreshRef.current();
    }, []);

    const scopeHasLoaded = hasLoaded && loadedSessionScope === sessionScope;
    const ownsCurrentRequest = scopeHasLoaded
        && loadedRequestKey === requestKey
        && !isFilterSettling;
    const scopeFetchError = !isFilterSettling && errorRequestKey === requestKey
        ? fetchError
        : null;
    // Scope again during render so an account switch cannot briefly expose the
    // previous account's retained samples before the synchronization effect runs.
    const scopedTerminalTradeSamples = useMemo(
        () => getScopedPlacementTerminalSamples(terminalTradeSamples, sessionScope),
        [terminalTradeSamples, sessionScope],
    );
    const hasLocalJournalData = scopedTerminalTradeSamples.length > 0;
    const canRenderJournalContent = scopeHasLoaded || hasLocalJournalData;
    const canUseFilteredLogs = ownsCurrentRequest
        || (!scopeHasLoaded && hasLocalJournalData && !isFilterSettling);

    // Client-side filtering
    const filteredLogs = useMemo(() => {
        const scopedServerLogs = loadedSessionScope === sessionScope ? serverLogs : [];
        const scopedLogs = mergeTerminalTradeJournalLogs(scopedServerLogs, scopedTerminalTradeSamples);
        if (scopedLogs.length === 0) return scopedLogs;

        let filtered = scopedLogs;

        // Time filter
        if (deferredTimeRange) {
            const cutoff = Math.floor(Date.now() / 1000) - deferredTimeRange * 3600;
            filtered = filtered.filter(l => l.datetime >= cutoff);
        }

        // Type filter
        if (loadedRequestKey === requestKey && deferredLogType !== 0) {
            filtered = filtered.filter(l => l.type === deferredLogType);
        }

        // The server applies Mode before returning its rows. Mirror Errors mode
        // for local terminal rows so successful orders do not leak into it.
        if (loadedRequestKey === requestKey && deferredLogMode === 1) {
            filtered = filtered.filter(l => l.code !== 0);
        }

        // Search filter
        if (deferredSearch.trim()) {
            const query = deferredSearch.toLowerCase();
            filtered = filtered.filter(l => l.message.toLowerCase().includes(query) || l.source.toLowerCase().includes(query));
        }

        return filtered;
    }, [loadedRequestKey, requestKey, loadedSessionScope, sessionScope, serverLogs, scopedTerminalTradeSamples, deferredTimeRange, deferredLogType, deferredLogMode, deferredSearch]);

    useEffect(() => () => {
        copySequenceRef.current += 1;
        if (copyFeedbackTimerRef.current !== null) {
            window.clearTimeout(copyFeedbackTimerRef.current);
        }
    }, []);

    useEffect(() => {
        copySequenceRef.current += 1;
        if (copyFeedbackTimerRef.current !== null) {
            window.clearTimeout(copyFeedbackTimerRef.current);
            copyFeedbackTimerRef.current = null;
        }
        setCopyStatus('idle');
    }, [sessionScope, logMode, logType, timeRange, search]);

    const copyFilteredJournal = useCallback(async () => {
        if (filteredLogs.length === 0) return;

        const sequence = ++copySequenceRef.current;
        if (copyFeedbackTimerRef.current !== null) {
            window.clearTimeout(copyFeedbackTimerRef.current);
        }

        const copied = await copyTextToClipboard(serializeJournalLogs(filteredLogs));
        if (sequence !== copySequenceRef.current) return;
        setCopyStatus(copied ? 'copied' : 'error');

        copyFeedbackTimerRef.current = window.setTimeout(() => {
            if (sequence === copySequenceRef.current) setCopyStatus('idle');
        }, 2000);
    }, [filteredLogs]);

    const handleAutoScrollChange = useCallback((enabled: boolean) => {
        setAutoScroll(current => current === enabled ? current : enabled);
    }, []);

    const hasLocalTradeLatency = lastTradeLatency?.sessionScope === sessionScope;
    const scopedLastTradeLatency = hasLocalTradeLatency
        ? lastTradeLatency?.latencyMs
        : serverTradeLatency?.sessionScope === sessionScope
            ? serverTradeLatency.latencyMs
            : undefined;

    // ── Render ─────────────────────────────────────────────────────────────
    return (
        <div
            aria-busy={isFilterSettling || isLoading || isRefreshing}
            className="rtx-journal-tab h-full flex flex-col bg-[#131316] text-[13px] font-normal font-sans"
        >

            {/* ── Toolbar ─────────────────────────────────────────────────── */}
            <div className={`rtx-journal-toolbar rtx-trade-view-bar ${showAdvancedFilters ? 'rtx-journal-toolbar--expanded' : ''}`} style={{ gap: '8px', paddingLeft: '6px', paddingRight: '6px' }}>

                {/* Type filter */}
                <div className="rtx-journal-advanced-control flex items-center gap-1.5 shrink-0">
                    <span className="rtx-journal-toolbar__label text-[13px] font-medium text-zinc-400 uppercase tracking-[0.02em]">{tr("Type")}</span>
                    <select
                        aria-label={tr("Journal type")}
                        value={logType}
                        onChange={e => setLogType(Number(e.target.value))}
                        className="rtx-journal-control h-7 min-w-[94px] cursor-pointer border border-zinc-600 bg-zinc-800 px-2 py-0 text-[13px] font-medium text-zinc-200 outline-none hover:border-zinc-500"
                    >
                        {LOG_TYPES.map(t => (
                            <option key={t.value} value={t.value}>{tr(t.label)}</option>
                        ))}
                    </select>
                </div>

                {/* Mode filter */}
                <div className="rtx-journal-advanced-control flex items-center gap-1.5 shrink-0">
                    <span className="rtx-journal-toolbar__label text-[13px] font-medium text-zinc-400 uppercase tracking-[0.02em]">{tr("Mode")}</span>
                    <select
                        aria-label={tr("Journal mode")}
                        value={logMode}
                        onChange={e => setLogMode(Number(e.target.value))}
                        className="rtx-journal-control h-7 min-w-[112px] cursor-pointer border border-zinc-600 bg-zinc-800 px-2 py-0 text-[13px] font-medium text-zinc-200 outline-none hover:border-zinc-500"
                    >
                        {LOG_MODES.map(m => (
                            <option key={m.value} value={m.value}>{tr(m.label)}</option>
                        ))}
                    </select>
                </div>

                {/* Time range pills */}
                <div className="rtx-journal-periods flex items-center shrink-0" role="tablist" aria-label="Journal time filters">
                    {TIME_RANGES.map(t => (
                        <button
                            key={tr(t.label)}
                            type="button"
                            role="tab"
                            aria-selected={timeRange === t.hours}
                            onClick={() => setTimeRange(t.hours)}
                            className="rtx-journal-control rtx-journal-time-btn rtx-trade-subtab-btn"
                        >
                            {tr(t.label)}
                        </button>
                    ))}
                </div>

                <button
                    type="button"
                    onClick={() => { void copyFilteredJournal(); }}
                    disabled={!canUseFilteredLogs || filteredLogs.length === 0}
                    aria-label={tr("Copy filtered journal")}
                    title={tr("Copy {{value0}} filtered journal {{value1}}", { value0: filteredLogs.length, value1: filteredLogs.length === 1 ? tr('entry') : tr('entries') })}
                    className={`rtx-journal-control rtx-journal-primary-action flex h-[22px] min-w-[72px] shrink-0 items-center justify-center gap-1.5 border px-2 py-0 text-[12px] font-normal transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${copyStatus === 'copied'
                        ? 'border-emerald-700 text-emerald-400'
                        : copyStatus === 'error'
                            ? 'border-red-800 text-red-400'
                            : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                        }`}
                >
                    <Icon name={copyStatus === 'copied' ? 'check' : 'copy'} size="sm" />
                    {copyStatus === 'copied' ? tr("Copied") : copyStatus === 'error' ? tr("Failed") : tr("Copy")}
                </button>
                <span role="status" aria-live="polite" className="sr-only">
                    {copyStatus === 'copied' ? tr("{{value0}} filtered journal {{value1}} copied", { value0: filteredLogs.length, value1: filteredLogs.length === 1 ? tr('entry') : tr('entries') }) : copyStatus === 'error' ? tr("Unable to copy the filtered journal") : ''}
                </span>

                <button
                    type="button"
                    aria-expanded={showAdvancedFilters}
                    onClick={() => setShowAdvancedFilters(current => !current)}
                    className="rtx-journal-control h-[22px] border border-transparent px-2 text-[12px] font-normal text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200"
                >
                    {tr("Filters")}</button>

                {/* Text search */}
                <div className="rtx-journal-advanced-control rtx-journal-toolbar__search relative h-7 min-w-[220px] max-w-[400px] flex-[1_1_260px]">
                    <Icon name="search" size="sm" className="pointer-events-none absolute left-2 top-1/2 z-[1] -translate-y-1/2 text-zinc-500" />
                    <input
                        type="text"
                        aria-label={tr("Filter journal messages")}
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder={tr("Filter messages…")}
                        className="rtx-journal-control h-7 w-full border border-zinc-600 bg-zinc-800 py-0 pl-7 pr-2 text-[13px] font-normal text-zinc-200 outline-none placeholder:text-zinc-500 hover:border-zinc-500"
                    />
                </div>

                <div className="rtx-journal-toolbar__summary ml-auto flex max-w-full shrink-0 flex-nowrap items-center justify-end gap-2">

                {/* Log count */}
                <span className="rtx-journal-toolbar__count min-w-[88px] text-right text-[13px] font-normal text-zinc-400 whitespace-nowrap">
                    {filteredLogs.length} {tr(" records")}</span>

                <span
                    data-testid="last-trade-latency"
                    role="status"
                    aria-live="polite"
                    className="rtx-journal-toolbar__latency min-w-[196px] border-l border-zinc-700/50 pl-3 text-[13px] font-normal text-zinc-400 whitespace-nowrap"
                    title={hasLocalTradeLatency
                        ? tr("Latest locally measured total order-attempt time for this broker and account")
                        : "Latest server-recorded trade execution time for this broker and account"}
                >
                    {tr("Last trade latency: ")}{formatLatencyMs(scopedLastTradeLatency)}
                </span>

                <button
                    type="button"
                    onClick={() => setAutoScroll(current => !current)}
                    aria-pressed={autoScroll}
                    title={tr("Toggle auto-follow newest entries")}
                    className={`rtx-journal-control rtx-journal-advanced-control rtx-journal-auto h-7 min-w-[68px] border px-2.5 py-0 text-[13px] font-medium transition-colors ${autoScroll
                        ? 'border-zinc-600 bg-blue-950/30 text-blue-400'
                        : 'border-zinc-700 text-zinc-500 hover:border-zinc-500'
                        }`}
                >
                    {tr("↑ Auto")}</button>

                <button
                    type="button"
                    onClick={refreshJournal}
                    disabled={!isAuthenticated || isFilterSettling || isLoading || isRefreshing}
                    aria-label={tr("Refresh journal")}
                    className="rtx-journal-control rtx-journal-refresh flex h-[22px] items-center justify-center gap-1 border border-transparent bg-zinc-800 px-2 py-0 text-[12px] font-normal text-zinc-300 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <Icon name="refresh" size="sm" className={isLoading || isRefreshing ? 'animate-spin' : ''} />
                    {isLoading ? tr("Loading…") : isRefreshing ? tr("Refreshing…") : tr("Refresh")}
                </button>
                </div>
            </div>

            {/* ── Status rows ──────────────────────────────────────────────── */}
            {!isAuthenticated && (
                <div className="flex flex-1 items-center justify-center text-xs text-zinc-500">
                    {tr("Sign in to view the server journal")}</div>
            )}

            {isAuthenticated && scopeHasLoaded && scopeFetchError && (
                <div role="status" className="rtx-journal-status-warning flex shrink-0 items-center justify-between gap-3 border-b border-amber-900/60 bg-amber-950/30 px-3 py-1 text-[12px] font-normal text-amber-300">
                    <span>{tr("Refresh failed. Showing the latest response for this account.")}</span>
                    <button type="button" onClick={refreshJournal} className="underline underline-offset-2 hover:text-amber-100">
                        {tr("Retry")}</button>
                </div>
            )}

            {isAuthenticated && !scopeHasLoaded && !hasLocalJournalData && (isLoading || !scopeFetchError) && (
                <div role="status" className="flex flex-1 items-center justify-center gap-2 text-xs text-zinc-500">
                    <Icon name="refresh" size="sm" className="animate-spin" />
                    {tr("Loading server journal…")}</div>
            )}

            {isAuthenticated && !scopeHasLoaded && hasLocalJournalData && (isLoading || !scopeFetchError) && (
                <div role="status" className="rtx-journal-status-loading flex shrink-0 items-center gap-2 border-b border-zinc-700 bg-zinc-900/70 px-3 py-1 text-[12px] font-normal text-zinc-400">
                    <Icon name="refresh" size="sm" className="animate-spin" />
                    <span>{tr("Loading server journal. Showing local trade diagnostics.")}</span>
                </div>
            )}

            {isAuthenticated && !scopeHasLoaded && !hasLocalJournalData && !isLoading && scopeFetchError && (
                <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
                    <span className="text-xs text-red-400">{tr("Unable to load the server journal")}</span>
                    <span className="max-w-xl text-[12px] font-normal text-zinc-500">{tr(scopeFetchError)}</span>
                    <button type="button" onClick={refreshJournal} className="rounded bg-zinc-700 px-3 py-1 text-[12px] font-normal text-zinc-200 hover:bg-zinc-600">
                        {tr("Retry")}</button>
                </div>
            )}

            {isAuthenticated && !scopeHasLoaded && hasLocalJournalData && !isLoading && scopeFetchError && (
                <div role="alert" className="rtx-journal-status-warning flex shrink-0 items-center justify-between gap-3 border-b border-amber-900/60 bg-amber-950/30 px-3 py-1 text-[12px] font-normal text-amber-300">
                    <span>{tr("Unable to load the server journal. Showing local trade diagnostics.")}</span>
                    <button type="button" onClick={refreshJournal} className="underline underline-offset-2 hover:text-amber-100">
                        {tr("Retry")}</button>
                </div>
            )}

            {isAuthenticated && canRenderJournalContent && filteredLogs.length === 0 && (
                <div className="flex-1 flex items-center justify-center text-zinc-600 text-xs italic">
                    {tr("No journal entries for the selected filters")}</div>
            )}

            {/* ── Log table ────────────────────────────────────────────────── */}
            {isAuthenticated && canRenderJournalContent && filteredLogs.length > 0 && (
                <JournalLogTable
                    logs={filteredLogs}
                    autoScroll={autoScroll}
                    onAutoScrollChange={handleAutoScrollChange}
                />
            )}
        </div>
    );
}

const MemoizedJournalTabSurface = React.memo(JournalTabSurface);
MemoizedJournalTabSurface.displayName = 'JournalTabSurface';

export function JournalTab() {
    const isAuthenticated = useAppStore(state => state.isAuthenticated);
    const sessionScope = useBrokerAccountSessionScope();

    return (
        <MemoizedJournalTabSurface
            isAuthenticated={isAuthenticated}
            sessionScope={sessionScope}
        />
    );
}
