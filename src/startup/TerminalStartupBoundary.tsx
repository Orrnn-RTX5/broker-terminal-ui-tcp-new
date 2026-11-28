import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { TerminalLoadFallback } from './TerminalLoadFallback';
import { useDesktopStartupReady } from './useDesktopStartupReady';

type StartupPart = 'chart' | 'marketWatch';
const StartupReadyContext = createContext<((part: StartupPart) => void) | null>(null);

/** Report the first usable result (including an explicit empty/error state). */
// eslint-disable-next-line react-refresh/only-export-components -- keep useTerminalStartupReady co-located with TerminalStartupBoundary for existing importers
export function useTerminalStartupReady(part: StartupPart, ready: boolean) {
  const reportReady = useContext(StartupReadyContext);
  useEffect(() => {
    if (ready) reportReady?.(part);
  }, [part, ready, reportReady]);
}

// The chart keeps its own loading surface. Do not leave the whole terminal
// on the startup screen for a slow candle response; once the single logo splash
// finishes (550ms–600ms), show the workspace and let the remaining data fill in.
const STARTUP_REVEAL_CAP_MS = 600;
const MIN_LOGO_SPLASH_MS = 550;

function readRemainingLogoSplashMs(): number {
  if (typeof window === 'undefined' || typeof performance === 'undefined') return 0;
  const startedAt = (window as Window & { __RTX_SPLASH_STARTED_AT_MS__?: unknown }).__RTX_SPLASH_STARTED_AT_MS__;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return 0;
  const elapsed = Math.max(0, performance.now() - startedAt);
  return Math.max(0, Math.ceil(MIN_LOGO_SPLASH_MS - elapsed));
}

/** Keep the real workspace mounted and measured while its first data arrives. */
export function TerminalStartupBoundary({
  dataReady,
  waitForChart,
  children,
}: {
  dataReady: boolean;
  waitForChart: boolean;
  children: ReactNode;
}) {
  const [parts, setParts] = useState({ chart: false, marketWatch: false });
  const [revealed, setRevealed] = useState(false);
  const [splashComplete, setSplashComplete] = useState(() => readRemainingLogoSplashMs() <= 0);
  const reportReady = useCallback((part: StartupPart) => {
    setParts(previous => previous[part] ? previous : { ...previous, [part]: true });
  }, []);
  const ready = dataReady && parts.marketWatch && (!waitForChart || parts.chart);
  const canReveal = ready && splashComplete;
  const pending = !revealed && !canReveal;
  useDesktopStartupReady(!pending);

  useEffect(() => {
    if (splashComplete) return;
    const remaining = readRemainingLogoSplashMs();
    const timer = window.setTimeout(() => setSplashComplete(true), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [splashComplete]);

  useEffect(() => {
    if (canReveal) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- latches one-way reveal after readiness without changing render timing
      setRevealed(true);
    }
  }, [canReveal]);

  // A slow or unreachable backend must not trap the user on the loading
  // screen: open the terminal anyway and let data stream in when it arrives.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setRevealed(true), STARTUP_REVEAL_CAP_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  return (
    <StartupReadyContext.Provider value={reportReady}>
      <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0 }}
        data-terminal-startup-data-ready={dataReady}
        data-terminal-startup-chart-ready={!waitForChart || parts.chart}
        data-terminal-startup-market-watch-ready={parts.marketWatch}
        data-terminal-startup={pending ? 'pending' : 'ready'}>
        <div aria-hidden={pending || undefined} inert={pending || undefined}
          style={{ width: '100%', height: '100%', visibility: pending ? 'hidden' : undefined }}>
          {children}
        </div>
        {pending && (
          <div style={{ position: 'absolute', inset: 0 }}>
            <TerminalLoadFallback />
          </div>
        )}
      </div>
    </StartupReadyContext.Provider>
  );
}
