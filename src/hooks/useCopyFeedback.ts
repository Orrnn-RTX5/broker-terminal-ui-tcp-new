import { useCallback, useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '../utils/clipboard';

export function useCopyFeedback(durationMs = 1600) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const sequenceRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    sequenceRef.current += 1;
    clearTimer();
    setCopied(false);
  }, [clearTimer]);

  const copy = useCallback(async (value: string): Promise<boolean> => {
    if (!value) return false;
    const seq = ++sequenceRef.current;
    clearTimer();
    const ok = await copyTextToClipboard(value);
    if (!mountedRef.current || sequenceRef.current !== seq) return ok;
    if (ok) {
      setCopied(true);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (mountedRef.current && sequenceRef.current === seq) {
          setCopied(false);
        }
      }, durationMs);
    } else {
      setCopied(false);
    }
    return ok;
  }, [clearTimer, durationMs]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sequenceRef.current += 1;
      clearTimer();
    };
  }, [clearTimer]);

  return { copied, copy, reset };
}
