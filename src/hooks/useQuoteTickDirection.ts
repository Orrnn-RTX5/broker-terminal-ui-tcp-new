import { useEffect, useState } from 'react';

export type QuoteTickDirection = 'up' | 'down' | 'flat';
export type QuoteTickFlash = 'up' | 'down' | '';

export const MT5_QUOTE_TICK_STALE_MS = 15_000;
const QUOTE_FLASH_MS = 350;

function usePriceTickDirection(symbol: string, price: number): {
    dir: QuoteTickDirection;
    flash: QuoteTickFlash;
} {
    const normalizedPrice = price > 0 ? price : 0;
    const [tickState, setTickState] = useState<{
        symbol: string;
        prevPrice: number;
        dir: QuoteTickDirection;
        flash: QuoteTickFlash;
        seq: number;
    }>({
        symbol,
        prevPrice: normalizedPrice,
        dir: 'flat',
        flash: '',
        seq: 0,
    });

    if (tickState.symbol !== symbol) {
        setTickState({
            symbol,
            prevPrice: normalizedPrice,
            dir: 'flat',
            flash: '',
            seq: tickState.seq + 1,
        });
    } else if (normalizedPrice !== tickState.prevPrice) {
        if (normalizedPrice > 0 && tickState.prevPrice > 0) {
            const nextDir: 'up' | 'down' = normalizedPrice > tickState.prevPrice ? 'up' : 'down';
            setTickState({
                symbol,
                prevPrice: normalizedPrice,
                dir: nextDir,
                flash: nextDir,
                seq: tickState.seq + 1,
            });
        } else {
            setTickState({
                symbol,
                prevPrice: normalizedPrice,
                dir: 'flat',
                flash: '',
                seq: tickState.seq + 1,
            });
        }
    }

    const activeSeq = tickState.seq;
    const activeDir = tickState.dir;
    const activeFlash = tickState.flash;

    useEffect(() => {
        if (activeDir === 'flat') return;
        const staleTimer = setTimeout(() => {
            setTickState((current) => (
                current.seq === activeSeq ? { ...current, dir: 'flat', flash: '' } : current
            ));
        }, MT5_QUOTE_TICK_STALE_MS);
        return () => clearTimeout(staleTimer);
    }, [activeSeq, activeDir]);

    useEffect(() => {
        if (activeFlash === '') return;
        const flashTimer = setTimeout(() => {
            setTickState((current) => (
                current.seq === activeSeq ? { ...current, flash: '' } : current
            ));
        }, QUOTE_FLASH_MS);
        return () => clearTimeout(flashTimer);
    }, [activeSeq, activeFlash]);

    return { dir: activeDir, flash: activeFlash };
}

/**
 * Tracks independent Bid and Ask tick directions matching MT5 One-Click
 * Trading semantics: blue on uptick, red on downtick, gray after 15s unchanged.
 */
export function useQuoteTickDirection(symbol: string, bid: number, ask: number): {
    bidDir: QuoteTickDirection;
    askDir: QuoteTickDirection;
    bidFlash: QuoteTickFlash;
    askFlash: QuoteTickFlash;
} {
    const bidState = usePriceTickDirection(symbol, bid);
    const askState = usePriceTickDirection(symbol, ask);
    return {
        bidDir: bidState.dir,
        askDir: askState.dir,
        bidFlash: bidState.flash,
        askFlash: askState.flash,
    };
}
