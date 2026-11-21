import { describe, expect, it } from 'vitest';
import type { JournalLogEntry } from '../../services/api';
import type { TradeOrderLatencySample, TradeOrderTerminalStatus } from '../../services/orderLatencyTelemetry';
import { mergeTerminalTradeJournalLogs } from './JournalTab';

type PlacementTerminalSample = TradeOrderLatencySample & {
    phase: 'placement_terminal';
    terminalStatus: TradeOrderTerminalStatus;
    totalMs: number;
};

// ──────────────── REFERENCE: verbatim copy of the pre-optimisation implementation (HEAD 631a9d0) ────────────────
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

const hasExactServerAttemptId = (
    log: JournalLogEntry,
    sample: PlacementTerminalSample,
): boolean => (
    Boolean(sample.clientOrderId)
    && log.client_order_id !== undefined
    && String(log.client_order_id).trim() === sample.clientOrderId
);

const isMatchingServerTerminalRow = (
    log: JournalLogEntry,
    sample: PlacementTerminalSample,
): boolean => {
    if (!hasExactServerAttemptId(log, sample)) return false;
    return getServerTerminalStatus(log) !== null;
};

const referenceMerge = (
    serverLogs: readonly JournalLogEntry[],
    terminalSamples: readonly PlacementTerminalSample[],
): JournalLogEntry[] => {
    const mergedServerLogs = serverLogs.map(log => ({ ...log }));
    const claimedServerRows = new Set<number>();
    const localRows: JournalLogEntry[] = [];

    for (const sample of terminalSamples) {
        const matchingIndex = mergedServerLogs.findIndex((log, index) => (
            !claimedServerRows.has(index) && isMatchingServerTerminalRow(log, sample)
        ));
        if (matchingIndex < 0) {
            localRows.push(createLocalTerminalJournalEntry(sample));
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

    for (const sample of terminalSamples) {
        if (sample.clientOrderId && mergedServerLogs.some(log => isMatchingServerTerminalRow(log, sample))) {
            continue;
        }
        const heuristicIndex = mergedServerLogs.findIndex((log, index) => {
            if (claimedServerRows.has(index)) return false;
            if (log.client_order_id !== undefined && String(log.client_order_id).trim() !== '') return false;
            if (log.latency_ms !== undefined) return false;
            if (getServerTerminalStatus(log) !== sample.terminalStatus) return false;
            if (!sample.symbol && !sample.side && !sample.clientOrderId) return false;

            const sampleSec = Math.floor(sample.recordedAtEpochMs / 1000);
            if (!Number.isFinite(log.datetime) || Math.abs(log.datetime - sampleSec) > 15) return false;

            const messageLower = log.message.trim().toLowerCase();
            if (sample.symbol && messageLower.includes(sample.symbol.toLowerCase())) {
                if (sample.side && /\b(buy|sell)\b/.test(messageLower) && !messageLower.includes(sample.side.toLowerCase())) {
                    return false;
                }
                if (typeof sample.volume === 'number' && Number.isFinite(sample.volume)) {
                    const normalizedVol = formatLocalOrderVolume(sample.volume);
                    const fixedVol = sample.volume.toFixed(2);
                    if (
                        normalizedVol
                        && /\b\d+(?:\.\d+)?\b/.test(messageLower)
                        && !messageLower.includes(normalizedVol)
                        && !messageLower.includes(fixedVol)
                    ) {
                        return false;
                    }
                }
                return true;
            }

            return Math.abs(log.datetime - sampleSec) <= 5
                && /^(?:position\s+opened|order\s+(?:filled|executed|completed|succeeded|rejected|expired|failed))\b/i.test(log.message.trim());
        });
        if (heuristicIndex < 0) continue;

        claimedServerRows.add(heuristicIndex);
        mergedServerLogs[heuristicIndex] = {
            ...mergedServerLogs[heuristicIndex],
            latency_ms: sample.totalMs,
        };
        const localRowIndex = localRows.findIndex(
            row => row.id === `local-order-${sample.clientOrderId || sample.traceId}-${sample.sequence}`,
        );
        if (localRowIndex >= 0) {
            localRows.splice(localRowIndex, 1);
        }
    }

    return [...localRows, ...mergedServerLogs].sort((left, right) => {
        const rightMs = right.datetime_ms ?? (right.datetime * 1000);
        const leftMs = left.datetime_ms ?? (left.datetime * 1000);
        return rightMs - leftMs;
    });
};


// ───────────────────────── differential + performance tests ─────────────────────────

// Deterministic PRNG (mulberry32) so failures are reproducible.
const makeRng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const SYMBOLS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'US30'];
const SIDES = ['buy', 'sell'] as const;
const STATUSES: TradeOrderTerminalStatus[] = ['filled', 'rejected', 'expired', 'failed'];
const BASE_SEC = 1_700_000_000;

const pick = <T,>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

const makeServerLog = (rng: () => number, index: number, idPool: string[], spreadSec = 40): JournalLogEntry => {
    const status = pick(rng, STATUSES);
    const symbol = pick(rng, SYMBOLS);
    const side = pick(rng, SIDES);
    const volume = pick(rng, ['0.1', '0.10', '1', '2.5', '0.01']);
    const wordByStatus: Record<string, string> = {
        filled: 'executed', rejected: 'rejected', expired: 'expired', failed: 'failed',
    };
    const templates = [
        `Order ${wordByStatus[status]} ${side} ${symbol} ${volume}`,
        `Order ${wordByStatus[status]} ${symbol}`,
        `position opened ${symbol} ${volume}`,
        `Order ${wordByStatus[status]}`,
        `${side} ${symbol} ${wordByStatus[status]}`,
        `Position opened`,
        `Network ping ok`,
        `  Timing ${symbol}  `,
    ];
    const log: JournalLogEntry = {
        id: `srv-${index}`,
        code: rng() < 0.2 ? 0 : 1,
        code_text: pick(rng, ['OK', 'ERR', '']),
        type: rng() < 0.85 ? 6 : 2,
        type_text: rng() < 0.9 ? 'Trade' : 'System',
        datetime: BASE_SEC + Math.floor(rng() * spreadSec) - spreadSec / 2 + (rng() < 0.1 ? rng() : 0),
        source: 'Server',
        message: pick(rng, templates),
    };
    if (rng() < 0.15) log.datetime_ms = Math.round(log.datetime * 1000) + Math.floor(rng() * 999);
    if (rng() < 0.03) log.datetime = Number.NaN;
    const idRoll = rng();
    if (idRoll < 0.35) log.client_order_id = pick(rng, idPool);
    else if (idRoll < 0.4) log.client_order_id = `  ${pick(rng, idPool)} `;
    else if (idRoll < 0.45) log.client_order_id = '';
    else if (idRoll < 0.48) log.client_order_id = '   ';
    else if (idRoll < 0.5) log.client_order_id = 12345;
    if (rng() < 0.2) log.latency_ms = Math.floor(rng() * 100);
    return log;
};

const makeSample = (rng: () => number, sequence: number, idPool: string[], spreadSec = 40): PlacementTerminalSample => {
    const sample: PlacementTerminalSample = {
        version: 1,
        sequence: rng() < 0.05 ? Math.floor(sequence / 2) : sequence,
        recordedAtEpochMs: (BASE_SEC + Math.floor(rng() * spreadSec) - spreadSec / 2) * 1000 + Math.floor(rng() * 1000),
        phase: 'placement_terminal',
        transport: 'websocket',
        traceId: rng() < 0.1 ? 'trace-shared' : `trace-${sequence}`,
        terminalStatus: pick(rng, STATUSES),
        totalMs: Math.floor(rng() * 500),
    };
    if (rng() < 0.5) sample.clientOrderId = pick(rng, idPool);
    if (rng() < 0.8) sample.symbol = pick(rng, SYMBOLS);
    if (rng() < 0.7) sample.side = pick(rng, SIDES);
    if (rng() < 0.7) sample.volume = pick(rng, [0.1, 1, 2.5, 0.01, 3]);
    if (rng() < 0.02) sample.recordedAtEpochMs = Number.NaN;
    if (rng() < 0.01) sample.recordedAtEpochMs = Number.POSITIVE_INFINITY;
    if (rng() < 0.3) sample.operationLabel = pick(rng, ['Position closed', 'Position modified']);
    if (rng() < 0.2) {
        sample.errorCode = pick(rng, ['E1', 'REJ']);
        sample.errorMessage = pick(rng, ['E1: bad', 'nope']);
    }
    return sample;
};

describe('mergeTerminalTradeJournalLogs (Map/Set indexed) vs original O(MxN) reference', () => {
    it('produces identical output on 4000 randomized inputs', () => {
        let differences = 0;
        let heuristicHits = 0;
        let exactHits = 0;
        for (let seed = 1; seed <= 4000; seed += 1) {
            const rng = makeRng(seed);
            const idPool = Array.from({ length: 1 + Math.floor(rng() * 8) }, (_, i) => `cid-${seed % 7}-${i}`);
            const serverCount = Math.floor(rng() * 40);
            const sampleCount = Math.floor(rng() * 40);
            const server = Array.from({ length: serverCount }, (_, i) => makeServerLog(rng, i, idPool));
            const samples = Array.from({ length: sampleCount }, (_, i) => makeSample(rng, i + 1, idPool));

            const expected = referenceMerge(server, samples);
            const actual = mergeTerminalTradeJournalLogs(server, samples);
            if (JSON.stringify(expected) !== JSON.stringify(actual)) {
                differences += 1;
                expect(actual, `seed ${seed}`).toEqual(expected);
            }
            for (const row of expected) {
                if (!String(row.id).startsWith('local-') && row.latency_ms !== undefined && row.client_order_id === undefined) heuristicHits += 1;
                if (!String(row.id).startsWith('local-') && row.client_order_id !== undefined && row.latency_ms !== undefined) exactHits += 1;
            }
        }
        expect(differences).toBe(0);
        // The generator must actually exercise both matching paths.
        expect(heuristicHits).toBeGreaterThan(200);
        expect(exactHits).toBeGreaterThan(200);
    });

    it('does not mutate its inputs', () => {
        const rng = makeRng(99);
        const idPool = ['a', 'b'];
        const server = Array.from({ length: 20 }, (_, i) => makeServerLog(rng, i, idPool));
        const samples = Array.from({ length: 20 }, (_, i) => makeSample(rng, i + 1, idPool));
        const serverBefore = JSON.stringify(server);
        const samplesBefore = JSON.stringify(samples);
        mergeTerminalTradeJournalLogs(server, samples);
        expect(JSON.stringify(server)).toBe(serverBefore);
        expect(JSON.stringify(samples)).toBe(samplesBefore);
    });

    const measureMedianMs = (
        server: JournalLogEntry[],
        samples: PlacementTerminalSample[],
    ): { median: number; min: number; max: number } => {
        for (let i = 0; i < 5; i += 1) mergeTerminalTradeJournalLogs(server, samples);
        const timings: number[] = [];
        for (let i = 0; i < 21; i += 1) {
            const start = performance.now();
            mergeTerminalTradeJournalLogs(server, samples);
            timings.push(performance.now() - start);
        }
        timings.sort((a, b) => a - b);
        return { median: timings[Math.floor(timings.length / 2)], min: timings[0], max: timings[timings.length - 1] };
    };

    it('merges 200 server x 1,000 local rows in under 5 ms (median), spread over one hour', () => {
        const rng = makeRng(2024);
        const idPool = Array.from({ length: 300 }, (_, i) => `perf-${i}`);
        const server = Array.from({ length: 200 }, (_, i) => makeServerLog(rng, i, idPool, 3600));
        const samples = Array.from({ length: 1000 }, (_, i) => makeSample(rng, i + 1, idPool, 3600));
        expect(mergeTerminalTradeJournalLogs(server, samples)).toEqual(referenceMerge(server, samples));

        const timing = measureMedianMs(server, samples);
        const refStart = performance.now();
        referenceMerge(server, samples);
        const refMs = performance.now() - refStart;
        console.log(`[journal-merge-perf] spread=1h new median=${timing.median.toFixed(3)}ms (min ${timing.min.toFixed(3)}, max ${timing.max.toFixed(3)}); original single run=${refMs.toFixed(3)}ms`);
        expect(timing.median).toBeLessThan(5);
    });

    it('reports the adversarial case: 200 server x 1,000 local rows all inside one 40 s window', () => {
        const rng = makeRng(2025);
        const idPool = Array.from({ length: 300 }, (_, i) => `dense-${i}`);
        const server = Array.from({ length: 200 }, (_, i) => makeServerLog(rng, i, idPool));
        const samples = Array.from({ length: 1000 }, (_, i) => makeSample(rng, i + 1, idPool));
        expect(mergeTerminalTradeJournalLogs(server, samples)).toEqual(referenceMerge(server, samples));
        const timing = measureMedianMs(server, samples);
        const refStart = performance.now();
        referenceMerge(server, samples);
        const refMs = performance.now() - refStart;
        console.log(`[journal-merge-perf] dense-40s new median=${timing.median.toFixed(3)}ms (min ${timing.min.toFixed(3)}, max ${timing.max.toFixed(3)}); original single run=${refMs.toFixed(3)}ms`);
        expect(timing.median).toBeLessThan(refMs);
    });
});
