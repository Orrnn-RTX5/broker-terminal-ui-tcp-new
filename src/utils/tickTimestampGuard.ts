/**
 * Future-dated tick guard.
 *
 * compareCanonicalTickFreshness / the live tick dispatcher treat any tick with a
 * lower timestamp than the stored one as stale. One tick carrying a wrong
 * (future) server timestamp therefore froze its symbol until reload, because
 * every later normal tick looked "older". The chart path had the same problem
 * (a future candle makes `ts < currentCandle.time` drop every real tick).
 *
 * The guard runs once at the source (stream decode), so the dispatcher, stores
 * and chart all receive a sane timestamp. Ordering semantics for normal ticks
 * are unchanged: their timestamp is returned untouched.
 *
 * Rule. A tick is a "jump" only if its timestamp is BOTH
 *   - more than FUTURE_TICK_TOLERANCE_MS ahead of the last accepted timestamp
 *     (per symbol; falls back to the newest accepted timestamp of any symbol
 *     from the same feed when the symbol is new), AND
 *   - more than FUTURE_TICK_TOLERANCE_MS ahead of the client clock CORRECTED by
 *     the learned client/server offset.
 * The raw server timestamp is never compared with the raw client clock, because
 * clients are often minutes off (unsynced PCs/phones). Instead the guard learns
 * offset = rawTs - Date.now() from accepted ticks as a sliding-window minimum
 * (two OFFSET_BUCKET_MS buckets, so it adapts within ~2 buckets if the client
 * clock is corrected). The minimum is used because a poison tick can only raise
 * an offset, never lower it. Consequences:
 *   - any constant client skew (behind or ahead): normal ticks, however sparse,
 *     sit at the learned offset and pass untouched.
 *   - weekend / market-open gap: large gap vs last, but consistent with the
 *     learned offset -> passes untouched.
 *   - hours-ahead tick: far above the learned offset -> clamped.
 * A jump tick is clamped to the reference timestamp itself: the price is still
 * accepted as an equal-time update, and the reference does not move, so the next
 * normal tick passes. If the next tick for that symbol is itself a jump within
 * JUMP_CONFIRM_WINDOW_MS of the pending one, the feed really moved (new source
 * with a different clock, server clock corrected, client clock stepped by NTP)
 * and the jump is accepted from then on; the learned offset is re-based on it.
 * Offsets are only learned from accepted ticks, never from clamped ones.
 *
 * Known limit: the very first tick of the whole stream has no reference and is
 * accepted as is (it also seeds the offset; later, lower offsets replace it).
 */

export const FUTURE_TICK_TOLERANCE_MS = 2_000;
export const JUMP_CONFIRM_WINDOW_MS = 60_000;
export const OFFSET_BUCKET_MS = 30_000;

interface SymbolTimeState {
  /** Last accepted (post-guard) timestamp. */
  last: number;
  /** Raw timestamp of an unconfirmed jump tick, or 0. */
  pendingJump: number;
}

export class TickTimestampGuard {
  private readonly bySymbol = new Map<string, SymbolTimeState>();
  private newestAny = 0;
  // Sliding-window minimum of (rawTs - clientNow): current and previous bucket.
  private bucketStart = 0;
  private curMinOffset = Infinity;
  private prevMinOffset = Infinity;

  /** `now` is injectable for tests; it is called once per tick (Date.now is cheap). */
  constructor(private readonly now: () => number = Date.now) {}

  /** Returns the timestamp to use for this tick (O(1), no allocation in steady state). */
  resolve(symbol: string, rawTsMs: number): number {
    const state = this.bySymbol.get(symbol);
    const reference = state !== undefined ? state.last : this.newestAny;
    const now = this.now();
    const offset = rawTsMs - now;
    let rebase = false;

    if (reference > 0
      && rawTsMs > reference + FUTURE_TICK_TOLERANCE_MS
      && offset > (this.curMinOffset < this.prevMinOffset ? this.curMinOffset : this.prevMinOffset) + FUTURE_TICK_TOLERANCE_MS) {
      const pending = state !== undefined ? state.pendingJump : 0;
      const confirmed = pending > 0 && Math.abs(rawTsMs - pending) <= JUMP_CONFIRM_WINDOW_MS;
      if (!confirmed) {
        // Equal-time update: the price is still delivered, ordering is not poisoned.
        if (state !== undefined) state.pendingJump = rawTsMs;
        else this.bySymbol.set(symbol, { last: reference, pendingJump: rawTsMs });
        return reference;
      }
      rebase = true;
    }

    if (rebase) {
      this.prevMinOffset = offset;
      this.curMinOffset = offset;
      this.bucketStart = now;
    } else if (now - this.bucketStart >= OFFSET_BUCKET_MS || now < this.bucketStart) {
      this.prevMinOffset = this.curMinOffset;
      this.curMinOffset = offset;
      this.bucketStart = now;
    } else if (offset < this.curMinOffset) {
      this.curMinOffset = offset;
    }

    if (state !== undefined) {
      state.last = rawTsMs;
      state.pendingJump = 0;
    } else {
      this.bySymbol.set(symbol, { last: rawTsMs, pendingJump: 0 });
    }
    if (rawTsMs > this.newestAny) this.newestAny = rawTsMs;
    return rawTsMs;
  }

  clear(): void {
    this.bySymbol.clear();
    this.newestAny = 0;
    this.bucketStart = 0;
    this.curMinOffset = Infinity;
    this.prevMinOffset = Infinity;
  }
}
