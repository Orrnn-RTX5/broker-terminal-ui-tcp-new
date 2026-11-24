/**
 * Account-group spread markup and MT5 spread shaping.
 *
 * The authenticated `/api/v2/instruments` catalogue carries, per symbol:
 *   - `spread_markup` (m): the total visible markup in integer points >= 0
 *     (`spread_markup_semantics: "mt5_total_v1"`);
 *   - when present, the MT5 shaping fields `fixed_spread_points` (S) and
 *     `spread_balance_points` (SB) (symbol level), and `spread_diff_points` (D)
 *     and `spread_diff_balance_points` (B) (account group level).
 *
 * The terminal shows the price a market order fills at (owner decision D1), on the market-order path, operation for
 * operation, in float64 at the symbol's configured digits, with no tolerance:
 *   1. the tick stores the quote (ram_mt5_views_sync.go:1209-1213): Layer 1 (S, SB; ram_symbol_reload_tcp.go
 *      shapeInstrumentBaseQuote), then roundPrice at the digits;
 *   2. the market fill (ram_mt5_engine.go:3443, 3447-3448) applies the account layer to the stored pair (the group share
 *      from m, D, B, with the applySpreadPriceDeltas fallbacks) and rounds again. Nothing after that rounding is checked
 *      for crossing; a side the engine would fill at non-positive keeps a positive price (see marketSides, R3(c)).
 *
 * The total markup is split ask floor(m / 2), bid m - floor(m / 2) ticks; with tick == point and D >= 0 the total m + D is
 * split once. The legacy share needs a positive tick, as the engine's widenQuoteForSpreadTermsUnits does. The symbol-level
 * SpreadDiff base (instruments.spread_diff) is not part of the terminal yet (it needs a backend change).
 *
 * Quote feeds stay raw. An adjusted quote keeps its raw sides in `rawBid`/`rawAsk` and its markup in `spreadMarkup`, which
 * makes re-application idempotent and lets raw-bid consumers (chart candles) opt out.
 */

export interface SpreadMarkupEntry {
  /** Total visible markup m in instrument points (ticks), >= 0. Zero for a shaping-only entry. */
  points: number;
  /** Price value of one point (tick size). */
  tickSize: number;
  /** Price digits used to round adjusted prices. */
  digits: number;
  /** MT5 IMTConSymbol::Spread (S) in points; 0 = floating spread. */
  fixedSpreadPoints?: number;
  /** MT5 IMTConSymbol::SpreadBalance (SB) in points, signed. */
  spreadBalancePoints?: number;
  /** MT5 IMTConGroupSymbol::SpreadDiff (D) in points, signed. */
  spreadDiffPoints?: number;
  /** MT5 IMTConGroupSymbol::SpreadDiffBalance (B) in points, signed. */
  spreadDiffBalancePoints?: number;
  /*
   * Hot-path values. resolveSpreadMarkupEntry precomputes them once when the
   * catalogue loads; they are not enumerable and the entry is frozen. A copy (a spread)
   * keeps only the inputs and is prepared again on use.
   */
  /** Price value of one digit step: 1 / 10^digits, the engine's decimalPointSize. */
  pointSize?: number;
  /** True when S > 0 or SB != 0, so Layer 1 must run for every quote. */
  hasSymbolShaping?: boolean;
  /** Group price move of the bid (positive moves the bid down). */
  groupBidDelta?: number;
  /** Group price move of the ask (positive moves the ask up). */
  groupAskDelta?: number;
}

export type SpreadMarkupMap = ReadonlyMap<string, SpreadMarkupEntry>;

export const EMPTY_SPREAD_MARKUP_MAP: SpreadMarkupMap = new Map();

/** Fields a widened quote carries in addition to the effective bid/ask. */
export interface SpreadMarkupQuoteTag {
  rawBid?: number;
  rawAsk?: number;
  spreadMarkup?: number;
}

export interface SpreadMarkupInstrument {
  symbol: string;
  spreadMarkup?: number;
  tickSize?: number;
  digits?: number;
  fixedSpreadPoints?: number;
  spreadBalancePoints?: number;
  spreadDiffPoints?: number;
  spreadDiffBalancePoints?: number;
}

type QuoteLike = {
  bid?: unknown;
  ask?: unknown;
  spread?: unknown;
} & SpreadMarkupQuoteTag;

/**
 * The highest price digits a symbol can use. The engine's pricePow10Table (POW10, below) holds 0..18, and every index into
 * that table is clamped to 0..MAX_DIGITS. Digits above it are clamped to it; negative digits count as not given (normalizeDigits).
 */
const MAX_DIGITS = 18;
/**
 * The digit cap from before MAX_DIGITS was raised to 18. The tick-size digit inference (countDecimals) and the markup offset
 * helpers keep it, so their results do not change.
 */
const LEGACY_MAX_DIGITS = 10;
/** MT5 point fields are 32-bit integers. */
const MAX_POINTS = 2147483647;

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export const normalizeSpreadMarkupSymbol = (symbol: unknown): string =>
  typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';

/** Parses a catalogue row's markup; anything but a finite value >= 0 is 0. */
export const readSpreadMarkupPoints = (raw: unknown): number | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  for (const key of ['spread_markup', 'spreadMarkup']) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.round(parsed));
  }
  return undefined;
};

/** First present key as a whole number of points; undefined when absent, 0 when not finite. */
const readSpreadPointsValue = (raw: unknown, keys: readonly string[]): number | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  }
  return undefined;
};

const clampPoints = (value: number, min: number): number => Math.min(MAX_POINTS, Math.max(min, value));

/** Signed MT5 shaping value (SpreadBalance, SpreadDiff, SpreadDiffBalance), clamped to int32. */
export const readSignedSpreadPoints = (raw: unknown, keys: readonly string[]): number | undefined => {
  const value = readSpreadPointsValue(raw, keys);
  return value === undefined ? undefined : clampPoints(value, -MAX_POINTS);
};

/** Non-negative MT5 shaping value (fixed spread), clamped to [0, int32]. */
export const readNonNegativeSpreadPoints = (raw: unknown, keys: readonly string[]): number | undefined => {
  const value = readSpreadPointsValue(raw, keys);
  return value === undefined ? undefined : clampPoints(value, 0);
};

const countDecimals = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  for (let digits = 0; digits <= LEGACY_MAX_DIGITS; digits += 1) {
    const scaled = value * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return digits;
  }
  return LEGACY_MAX_DIGITS;
};

/**
 * Instrument digits as a whole number. Above 18 they are clamped to 18 (the engine uses 10^d beyond its table, so it differs
 * there). Negative digits, and any value that converts to NaN, are undefined (not given): the digits then come from the tick
 * size (countDecimals). Broker digits reach this function unchanged from the catalogue mapping (marketDataNormalization.ts),
 * so an out-of-range value can arrive here and is clamped or dropped at this point. The engine fixtures (golden, market and
 * check) cover digits 0 to 5 and 8 only, so digits 9 to 18 rest on the literal port and hand-worked tests.
 */
const normalizeDigits = (digits: unknown): number | undefined => {
  const parsed = Number(digits);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.min(MAX_DIGITS, Math.floor(parsed));
};

/** The RAM engine's pricePow10Table (ram_mt5_phase5.go:24-27): exact powers of ten, indexed by digits. */
const POW10: readonly number[] = [
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9,
  1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18,
];

/**
 * Go's math.Round, which the engine's roundPrice uses: the nearest integer, halves away from zero. The fraction of a double
 * is exact, so the half test is exact for every finite value. Negative zero becomes zero.
 */
const goRound = (value: number): number => {
  const whole = Math.trunc(value);
  const fraction = value - whole;
  if (fraction >= 0.5) return whole + 1;
  if (fraction <= -0.5) return whole - 1;
  return whole === 0 ? 0 : whole;
};

/**
 * The RAM engine's roundPrice (ram_mt5_phase5.go:24-39), literally: goRound(price * 10^digits) / 10^digits in float64,
 * with no tolerance and no nudge, so the terminal shows the price the engine fills at (owner decision D1). Digits are
 * clamped to 0..MAX_DIGITS; a non-finite value passes through.
 * Out-of-range digits: above 18 they are used as 18, and negative digits as 0. The engine differs there: it uses 10^d beyond
 * its table, and 5 digits for negative input. No product caller passes such values: each passes a prepared entry's digits
 * (0..18), resolveSpecDigits' 0..8, or LEGACY_MAX_DIGITS (10). The engine fixtures (golden, market and check) cover digits 0
 * to 5 and 8 only, so digits 9 to 18 rest on the literal port and hand-worked tests.
 */
export const roundPriceToDigits = (value: number, digits: number): number => {
  if (!Number.isFinite(value)) return value;
  const pow = POW10[Math.min(MAX_DIGITS, Math.max(0, Math.floor(digits)))];
  const rounded = goRound(value * pow) / pow;
  return rounded === 0 ? 0 : rounded;
};

/**
 * A price that would round to zero keeps its raw side: the raw side rounded when that is positive, else the raw side
 * itself. Used by the positive-price rule (R3(c)); a shown price is never zero or negative.
 */
const keptRaw = (raw: number, digits: number): number => {
  const rounded = roundPriceToDigits(raw, digits);
  return rounded > 0 ? rounded : raw;
};

/** Ask share of a total markup: floor(m / 2) points, 0 for m <= 0. */
export const getSpreadMarkupAskPoints = (points: number): number => (points > 0 ? Math.floor(points / 2) : 0);

/** Bid share of a total markup: the rest, m - floor(m / 2) points, 0 for m <= 0. */
export const getSpreadMarkupBidPoints = (points: number): number => (
  points > 0 ? points - Math.floor(points / 2) : 0
);

/** Bid part of the MT5 SpreadDiff/SpreadDiffBalance split, in points. */
const sdkBidPoints = (diff: number, balance: number): number => {
  const bidPoints = diff - Math.trunc(diff / 2);
  return diff < 0 ? bidPoints + balance : bidPoints - balance;
};

/**
 * IMTConGroupSymbol::SpreadDiffBalance split in points. Int(D / 2) truncates toward
 * zero and the balance sign reverses for D < 0. For D = 0 the balance is a two-sided shift.
 */
export const computeSdkSpreadDiffPoints = (
  diff: number,
  balance: number,
): { bidPoints: number; askPoints: number } => {
  const bidPoints = sdkBidPoints(diff, balance);
  return { bidPoints, askPoints: diff - bidPoints };
};

/** Tick size equal to the digit point, compared exactly as the engine compares them: both splits then share one unit. */
const isTickAtPoint = (tickSize: number, pointSize: number): boolean => tickSize === pointSize;

/**
 * Group price move of one side (bid: positive moves it down; ask: positive moves it up), not rounded: the stored side
 * adds it and rounds once, as the engine does. With tick == point and D >= 0 the total m + D is split once, so two odd
 * remainders never both land on the Bid. Otherwise the legacy share (tick units) and the MT5 D/B split (point units) are
 * summed; the legacy share needs a positive finite tick, as widenQuoteForSpreadTermsUnits does.
 */
const groupSideDelta = (
  side: 'bid' | 'ask',
  points: number,
  tickSize: number,
  pointSize: number,
  diff: number,
  diffBalance: number,
): number => {
  if (diff >= 0 && isTickAtPoint(tickSize, pointSize)) {
    const total = points + diff;
    const askPoints = Math.floor(total / 2) + diffBalance;
    return (side === 'ask' ? askPoints : total - askPoints) * pointSize;
  }
  const sdkBid = sdkBidPoints(diff, diffBalance);
  const legacyPoints = side === 'ask' ? getSpreadMarkupAskPoints(points) : getSpreadMarkupBidPoints(points);
  const sdkPoints = side === 'ask' ? diff - sdkBid : sdkBid;
  const legacyDelta = tickSize > 0 && Number.isFinite(tickSize) ? legacyPoints * tickSize : 0;
  return legacyDelta + sdkPoints * pointSize;
};

/**
 * Marks an entry that prepareEntry built. The mark is module-private and non-enumerable, so a spread
 * copy of a prepared entry never carries it and is prepared again from its own inputs.
 */
const PREPARED: unique symbol = Symbol('spreadMarkup.prepared');

/** An entry with every hot-path value computed. */
type PreparedEntry = SpreadMarkupEntry & {
  fixedSpreadPoints: number;
  spreadBalancePoints: number;
  spreadDiffPoints: number;
  spreadDiffBalancePoints: number;
  pointSize: number;
  hasSymbolShaping: boolean;
  groupBidDelta: number;
  groupAskDelta: number;
  readonly [PREPARED]: true;
};

type MarkedEntry = SpreadMarkupEntry & { readonly [PREPARED]?: true };

interface SpreadTerms {
  points: number;
  tickSize: number;
  digits: number;
  fixedSpreadPoints: number;
  spreadBalancePoints: number;
  spreadDiffPoints: number;
  spreadDiffBalancePoints: number;
}

/**
 * Computes the hot-path values; null when no markup or shaping is active or the digits are unusable. A tick that is
 * not positive is kept (the legacy share is then zero, as in the engine). forceShaping keeps Layer 1 on for a copy that
 * asks for it (a no-op when S = 0 and SB = 0).
 */
const prepareEntry = (terms: SpreadTerms, forceShaping = false): PreparedEntry | null => {
  const points = Number.isFinite(terms.points) && terms.points > 0 ? Math.round(terms.points) : 0;
  const fixedSpreadPoints = Number.isFinite(terms.fixedSpreadPoints) && terms.fixedSpreadPoints > 0
    ? Math.round(terms.fixedSpreadPoints)
    : 0;
  const spreadBalancePoints = Number.isFinite(terms.spreadBalancePoints) ? Math.round(terms.spreadBalancePoints) : 0;
  const spreadDiffPoints = Number.isFinite(terms.spreadDiffPoints) ? Math.round(terms.spreadDiffPoints) : 0;
  const spreadDiffBalancePoints = Number.isFinite(terms.spreadDiffBalancePoints)
    ? Math.round(terms.spreadDiffBalancePoints)
    : 0;
  const hasSymbolShaping = forceShaping || fixedSpreadPoints > 0 || spreadBalancePoints !== 0;
  if (points === 0 && !hasSymbolShaping && spreadDiffPoints === 0 && spreadDiffBalancePoints === 0) return null;
  const { tickSize, digits } = terms;
  if (!Number.isFinite(tickSize) || !Number.isInteger(digits) || digits < 0 || digits > MAX_DIGITS) return null;

  const pointSize = 1 / POW10[digits];
  const prepared = {
    points,
    tickSize,
    digits,
    fixedSpreadPoints,
    spreadBalancePoints,
    spreadDiffPoints,
    spreadDiffBalancePoints,
  } as PreparedEntry;
  // The hot-path values are hidden from spreads (see PREPARED). The object is frozen, so a write throws.
  Object.defineProperties(prepared, {
    pointSize: { value: pointSize },
    hasSymbolShaping: { value: hasSymbolShaping },
    groupBidDelta: { value: groupSideDelta('bid', points, tickSize, pointSize, spreadDiffPoints, spreadDiffBalancePoints) },
    groupAskDelta: { value: groupSideDelta('ask', points, tickSize, pointSize, spreadDiffPoints, spreadDiffBalancePoints) },
    [PREPARED]: { value: true },
  });
  return Object.freeze(prepared);
};

const isPrepared = (entry: SpreadMarkupEntry): entry is PreparedEntry => (entry as MarkedEntry)[PREPARED] === true;

/**
 * The entry with its hot-path values. Entries from resolveSpreadMarkupEntry already have them.
 * A hand-built entry or a copy is prepared here; that allocates, so it is never the catalogue or tick path.
 * A copy that sets hasSymbolShaping: true keeps Layer 1 on.
 */
const preparedOf = (entry: SpreadMarkupEntry | null | undefined): PreparedEntry | null => {
  if (!entry) return null;
  if (isPrepared(entry)) return entry;
  return prepareEntry({
    points: entry.points,
    tickSize: entry.tickSize,
    digits: entry.digits,
    fixedSpreadPoints: entry.fixedSpreadPoints ?? 0,
    spreadBalancePoints: entry.spreadBalancePoints ?? 0,
    spreadDiffPoints: entry.spreadDiffPoints ?? 0,
    spreadDiffBalancePoints: entry.spreadDiffBalancePoints ?? 0,
  }, entry.hasSymbolShaping === true);
};

/**
 * Resolves one instrument's markup entry. A tick the instrument sends is used as given (a zero or negative tick drops the
 * legacy share, as the engine does); without a finite tick it is 1 / 10^digits. Returns null when no markup or shaping
 * is active.
 */
export const resolveSpreadMarkupEntry = (
  instrument: Omit<SpreadMarkupInstrument, 'symbol'>,
): SpreadMarkupEntry | null => {
  const digits = normalizeDigits(instrument.digits);
  const tickSize = typeof instrument.tickSize === 'number' && Number.isFinite(instrument.tickSize)
    ? instrument.tickSize
    : digits !== undefined ? 1 / POW10[digits] : null;
  if (tickSize === null) return null;

  return prepareEntry({
    points: Number(instrument.spreadMarkup),
    tickSize,
    digits: digits ?? countDecimals(tickSize),
    fixedSpreadPoints: Number(instrument.fixedSpreadPoints ?? 0),
    spreadBalancePoints: Number(instrument.spreadBalancePoints ?? 0),
    spreadDiffPoints: Number(instrument.spreadDiffPoints ?? 0),
    spreadDiffBalancePoints: Number(instrument.spreadDiffBalancePoints ?? 0),
  });
};

/** Per-symbol markup for the authenticated account catalogue. */
export const buildSpreadMarkupMap = (
  instruments: readonly SpreadMarkupInstrument[],
): SpreadMarkupMap => {
  const map = new Map<string, SpreadMarkupEntry>();
  instruments.forEach((instrument) => {
    const symbol = normalizeSpreadMarkupSymbol(instrument?.symbol);
    if (!symbol) return;
    const entry = resolveSpreadMarkupEntry(instrument);
    if (entry) map.set(symbol, entry);
  });
  return map.size > 0 ? map : EMPTY_SPREAD_MARKUP_MAP;
};

const sameShaping = (left: SpreadMarkupEntry, right: SpreadMarkupEntry): boolean =>
  (left.fixedSpreadPoints ?? 0) === (right.fixedSpreadPoints ?? 0)
  && (left.spreadBalancePoints ?? 0) === (right.spreadBalancePoints ?? 0)
  && (left.spreadDiffPoints ?? 0) === (right.spreadDiffPoints ?? 0)
  && (left.spreadDiffBalancePoints ?? 0) === (right.spreadDiffBalancePoints ?? 0);

export const areSpreadMarkupMapsEqual = (left: SpreadMarkupMap, right: SpreadMarkupMap): boolean => {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [symbol, entry] of left) {
    const other = right.get(symbol);
    if (
      !other
      || other.points !== entry.points
      || other.tickSize !== entry.tickSize
      || other.digits !== entry.digits
      || !sameShaping(entry, other)
    ) return false;
  }
  return true;
};

/** Total visible spread width: markup points * tick size, digit-rounded. Each side moves by its share (see getSpreadMarkupSideOffsets). */
export const getSpreadMarkupOffset = (entry: SpreadMarkupEntry | null | undefined): number => {
  if (!entry || !(entry.points > 0) || !(entry.tickSize > 0)) return 0;
  return roundPriceToDigits(entry.points * entry.tickSize, entry.digits);
};

/**
 * The group share of each side in price units, not rounded: the bid moves down by bidOffset and the ask up by askOffset when
 * Layer 2 applies them to the stored side. It leaves out the Layer 1 shaping (S, SB) and the store rounding, so it is not the
 * move from the raw quote to the shown price. Product code does not call it (marketSides reads the prepared deltas).
 */
export const getSpreadMarkupSideOffsets = (
  entry: SpreadMarkupEntry | null | undefined,
): { bidOffset: number; askOffset: number } => {
  const prepared = preparedOf(entry);
  return prepared
    ? { bidOffset: prepared.groupBidDelta, askOffset: prepared.groupAskDelta }
    : { bidOffset: 0, askOffset: 0 };
};

/** The raw (feed) bid/ask of a quote, whether or not it has been widened. */
export function getRawQuoteSides<T extends QuoteLike>(quote: T): T;
export function getRawQuoteSides<T extends QuoteLike>(quote: T | null | undefined): T | null | undefined;
export function getRawQuoteSides<T extends QuoteLike>(quote: T | null | undefined): T | null | undefined {
  if (!quote || typeof quote !== 'object') return quote;
  if (quote.rawBid === undefined && quote.rawAsk === undefined) return quote;
  return {
    ...quote,
    bid: quote.rawBid ?? quote.bid,
    ask: quote.rawAsk ?? quote.ask,
  };
}

/** Signed: how far the displayed bid sits below the raw bid (negative when shaping narrows it). 0 for a raw quote. */
export const getQuoteBidMarkupOffset = (quote: QuoteLike | null | undefined): number => {
  if (!quote) return 0;
  const bid = Number(quote.bid);
  const rawBid = Number(quote.rawBid);
  if (!Number.isFinite(bid) || !Number.isFinite(rawBid)) return 0;
  return roundPriceToDigits(rawBid - bid, LEGACY_MAX_DIGITS);
};

/** Signed: how far the displayed ask sits above the raw ask (negative when shaping narrows it). 0 for a raw quote. */
export const getQuoteAskMarkupOffset = (quote: QuoteLike | null | undefined): number => {
  if (!quote) return 0;
  const ask = Number(quote.ask);
  const rawAsk = Number(quote.rawAsk);
  if (!Number.isFinite(ask) || !Number.isFinite(rawAsk)) return 0;
  return roundPriceToDigits(ask - rawAsk, LEGACY_MAX_DIGITS);
};

const stripSpreadMarkupTag = <T extends QuoteLike>(quote: T): T => {
  const { rawBid, rawAsk, spreadMarkup: _spreadMarkup, ...rest } = quote;
  void _spreadMarkup;
  const bid = rawBid ?? (quote.bid as number);
  const ask = rawAsk ?? (quote.ask as number);
  const next = { ...rest, bid, ask } as T;
  if (isPositiveFinite(bid) && isPositiveFinite(ask)) {
    (next as QuoteLike).spread = Math.max(0, ask - bid);
  }
  return next;
};

/**
 * The stored and shown sides of one raw pair on the market-order path, written into a scratch object (no allocation).
 * Used by the quote and by the depth top, so the depth top equals the shown quote for the same raw tops.
 */
interface MarketSides {
  /** Shown bid and ask (the market fill prices), positive when the raw side is present. */
  bid: number;
  ask: number;
  /** The stored quote after Layer 1 and the store rounding (the pair the market fill starts from). */
  storedBid: number;
  storedAsk: number;
  /** Layer 1 shift of each side (stored base minus raw side, before rounding), the depth levels move by it. */
  bidShift: number;
  askShift: number;
  /** True when the side's shown price is the stored side (an engine fallback, or the R3(c) guard), not the moved side. */
  bidKept: boolean;
  askKept: boolean;
}

const marketScratch: MarketSides = {
  bid: 0,
  ask: 0,
  storedBid: 0,
  storedAsk: 0,
  bidShift: 0,
  askShift: 0,
  bidKept: false,
  askKept: false,
};

/**
 * The market-order fill price of each side, mirrored operation for operation (no tolerance, configured digits):
 *   1. OnLiveTick (ram_mt5_views_sync.go:1209-1213): Layer 1 when the entry has shaping (ram_symbol_reload_tcp.go
 *      shapeInstrumentBaseQuote: S > 0 splits around the mid or the match, SB shifts both; a crossed base reverts to raw),
 *      then roundPrice on each side: the stored quote. The store rounds even without shaping.
 *   2. The market fill (ram_mt5_engine.go:3443): Layer 2 on the stored pair, with the group share of the entry and the
 *      applySpreadPriceDeltas fallbacks: a non-positive bid keeps the stored bid; a non-positive ask, or a bid above the ask,
 *      keeps the stored pair.
 *   3. roundPrice on each side (ram_mt5_engine.go:3447-3448). The engine has no crossed check and no positivity guard here.
 *   R3(c), the terminal's rule: when a side of the market fill is not positive, the shown side keeps the stored side if that
 *   is positive, else the raw side (keptRaw); a pair that then crosses shows the kept raw pair. A pair whose two sides are
 *   both positive is shown exactly as the engine fills it.
 * The raw pair may carry one side only; the missing side is not computed.
 */
const marketSides = (
  prepared: PreparedEntry,
  rawBid: number,
  rawAsk: number,
  hasBid: boolean,
  hasAsk: boolean,
  out: MarketSides,
): void => {
  const digits = prepared.digits;
  const point = prepared.pointSize;
  let baseBid = rawBid;
  let baseAsk = rawAsk;
  let baseBidShift = 0;
  let baseAskShift = 0;
  if (prepared.hasSymbolShaping) {
    const fixed = prepared.fixedSpreadPoints;
    const balance = prepared.spreadBalancePoints;
    if (fixed > 0) {
      if (hasBid && hasAsk) {
        const fixedSpread = fixed * point;
        const spread = rawAsk - rawBid;
        if (Math.abs(spread - fixedSpread) <= point * 1e-6) {
          baseBidShift = balance * point;
          baseBid = rawBid + baseBidShift;
        } else {
          // Mid-based: the base bid sits (trunc(fixed / 2) - balance) points below the mid of the raw pair.
          const offset = (Math.trunc(fixed / 2) - balance) * point;
          baseBidShift = spread / 2 - offset;
          baseBid = (rawAsk + rawBid) / 2 - offset;
        }
        baseAsk = baseBid + fixedSpread;
        baseAskShift = baseBidShift + (fixedSpread - spread);
      }
    } else {
      if (hasBid) {
        baseBidShift = balance * point;
        baseBid = rawBid + baseBidShift;
      }
      if (hasAsk) {
        baseAskShift = balance * point;
        baseAsk = rawAsk + baseAskShift;
      }
    }
    // A crossed base pair reverts to the raw pair (shapeInstrumentBaseQuote); the shifts revert with it.
    if (hasBid && hasAsk && baseBid > baseAsk) {
      baseBid = rawBid;
      baseAsk = rawAsk;
      baseBidShift = 0;
      baseAskShift = 0;
    }
  }
  const storedBid = hasBid ? roundPriceToDigits(baseBid, digits) : 0;
  const storedAsk = hasAsk ? roundPriceToDigits(baseAsk, digits) : 0;

  // Layer 2 on the stored pair (ram_mt5_engine.go:3443 -> applySpreadPriceDeltas). A fallback keeps the stored side.
  let outBid = storedBid - prepared.groupBidDelta;
  let outAsk = storedAsk + prepared.groupAskDelta;
  let bidKept = false;
  let askKept = false;
  if (hasBid && hasAsk) {
    if (!(outBid > 0)) {
      outBid = storedBid;
      bidKept = true;
    }
    if (!(outAsk > 0) || outBid > outAsk) {
      outBid = storedBid;
      outAsk = storedAsk;
      bidKept = true;
      askKept = true;
    }
  } else if (hasBid) {
    if (!(outBid > 0)) {
      outBid = storedBid;
      bidKept = true;
    }
  } else if (hasAsk) {
    if (!(outAsk > 0)) {
      outAsk = storedAsk;
      askKept = true;
    }
  }

  // roundPrice on each side (ram_mt5_engine.go:3447-3448).
  let effBid = hasBid ? roundPriceToDigits(outBid, digits) : 0;
  let effAsk = hasAsk ? roundPriceToDigits(outAsk, digits) : 0;
  // R3(c): a shown side is never zero or negative.
  if (hasBid && hasAsk) {
    if (!(effBid > 0) || !(effAsk > 0)) {
      let candBid = effBid > 0 ? effBid : storedBid > 0 ? storedBid : keptRaw(rawBid, digits);
      let candAsk = effAsk > 0 ? effAsk : storedAsk > 0 ? storedAsk : keptRaw(rawAsk, digits);
      if (candBid > candAsk) {
        candBid = keptRaw(rawBid, digits);
        candAsk = keptRaw(rawAsk, digits);
        bidKept = true;
        askKept = true;
      }
      if (!(effBid > 0)) bidKept = true;
      if (!(effAsk > 0)) askKept = true;
      effBid = candBid;
      effAsk = candAsk;
    }
  } else if (hasBid) {
    if (!(effBid > 0)) {
      effBid = storedBid > 0 ? storedBid : keptRaw(rawBid, digits);
      bidKept = true;
    }
  } else if (hasAsk) {
    if (!(effAsk > 0)) {
      effAsk = storedAsk > 0 ? storedAsk : keptRaw(rawAsk, digits);
      askKept = true;
    }
  }

  out.bid = effBid;
  out.ask = effAsk;
  out.storedBid = storedBid;
  out.storedAsk = storedAsk;
  out.bidShift = baseBidShift;
  out.askShift = baseAskShift;
  out.bidKept = bidKept;
  out.askKept = askKept;
};

/**
 * Widens a quote by the entry, always from the raw sides, so applying it to an already widened quote (or with a changed
 * markup) never compounds. A missing or inactive entry returns the raw quote. The shown sides are the market-order fill
 * prices (marketSides). A quote already widened to the same result is returned as it is.
 */
export const applySpreadMarkupToQuote = <T extends QuoteLike>(
  quote: T,
  entry: SpreadMarkupEntry | null | undefined,
): T & SpreadMarkupQuoteTag => {
  if (!quote || typeof quote !== 'object') return quote;
  const tagged = quote.rawBid !== undefined || quote.rawAsk !== undefined || quote.spreadMarkup !== undefined;
  // Catalogue entries are prepared once; a copy or a hand-built entry is prepared here (not on the tick path).
  const prepared: PreparedEntry | null = entry && (entry as MarkedEntry)[PREPARED] === true
    ? (entry as PreparedEntry)
    : preparedOf(entry);
  if (!prepared) return tagged ? stripSpreadMarkupTag(quote) : quote;

  const rawBid = quote.rawBid !== undefined ? quote.rawBid : Number(quote.bid);
  const rawAsk = quote.rawAsk !== undefined ? quote.rawAsk : Number(quote.ask);
  const hasBid = isPositiveFinite(rawBid);
  const hasAsk = isPositiveFinite(rawAsk);
  if (!hasBid && !hasAsk) return tagged ? stripSpreadMarkupTag(quote) : quote;

  marketSides(prepared, rawBid, rawAsk, hasBid, hasAsk, marketScratch);
  const digits = prepared.digits;
  const shownBid = hasBid ? marketScratch.bid : quote.bid;
  const shownAsk = hasAsk ? marketScratch.ask : quote.ask;
  const priced = isPositiveFinite(shownBid) && isPositiveFinite(shownAsk);
  const spread = priced
    ? roundPriceToDigits(Math.max(0, (shownAsk as number) - (shownBid as number)), digits)
    : undefined;
  const rawBidTag = hasBid ? rawBid : undefined;
  const rawAskTag = hasAsk ? rawAsk : undefined;
  // Identity: an already widened quote whose widened fields come out the same is returned unchanged.
  if (
    tagged
    && quote.bid === shownBid
    && quote.ask === shownAsk
    && quote.rawBid === rawBidTag
    && quote.rawAsk === rawAskTag
    && quote.spreadMarkup === prepared.points
    && (spread === undefined || quote.spread === spread)
  ) {
    return quote as T & SpreadMarkupQuoteTag;
  }
  const next = {
    ...quote,
    bid: shownBid,
    ask: shownAsk,
    rawBid: rawBidTag,
    rawAsk: rawAskTag,
    spreadMarkup: prepared.points,
  } as T & SpreadMarkupQuoteTag;
  if (spread !== undefined) (next as QuoteLike).spread = spread;
  return next;
};

export const applySpreadMarkupFromMap = <T extends QuoteLike>(
  symbol: unknown,
  quote: T,
  map: SpreadMarkupMap,
): T => applySpreadMarkupToQuote(quote, map.get(normalizeSpreadMarkupSymbol(symbol)));

export interface PriceLevelLike {
  price: number;
}

/**
 * Widens depth-of-market levels. The top is the shown quote for the same raw tops (marketSides). A deeper level is stored at
 * its raw price plus the side's Layer 1 shift, rounded at the digits. On a two-sided side whose top stays at its stored
 * price (the engine's fallback), the level stays at its stored price too; otherwise the group share is subtracted (bid) or
 * added (ask) and the level is rounded once. A level whose price is not positive, or that would cross the top or the level
 * above it, is dropped, so no level is shown at zero or below and the levels keep their order. `opposite` is the other
 * side's levels, best price first, and is required: pass [] when that side has none, which gives a one-sided book. Inputs are
 * never mutated; with no active entry the levels come back as they are, and when nothing changes the same array comes back.
 */
export const applySpreadMarkupToBookLevels = <L extends PriceLevelLike>(
  levels: readonly L[],
  side: 'bid' | 'ask',
  entry: SpreadMarkupEntry | null | undefined,
  opposite: readonly PriceLevelLike[],
): L[] => {
  const prepared: PreparedEntry | null = entry && (entry as MarkedEntry)[PREPARED] === true
    ? (entry as PreparedEntry)
    : preparedOf(entry);
  if (!prepared || levels.length === 0) return levels as L[];
  const top = levels[0];
  const rawTop = top.price;
  if (!isPositiveFinite(rawTop)) return levels as L[];
  const otherTop = opposite?.[0];
  const rawOther = otherTop ? otherTop.price : Number.NaN;
  const twoSided = isPositiveFinite(rawOther);
  const bidSide = side === 'bid';
  const rawBid = bidSide ? rawTop : rawOther;
  const rawAsk = bidSide ? rawOther : rawTop;
  const hasBid = isPositiveFinite(rawBid);
  const hasAsk = isPositiveFinite(rawAsk);
  marketSides(prepared, rawBid, rawAsk, hasBid, hasAsk, marketScratch);
  const sc = marketScratch;
  const digits = prepared.digits;
  const groupBid = prepared.groupBidDelta;
  const groupAsk = prepared.groupAskDelta;
  const shownTop = bidSide ? sc.bid : sc.ask;
  const shift = bidSide ? sc.bidShift : sc.askShift;
  // A two-sided side whose top stays at its stored price (the engine's fallback) keeps its levels at their stored prices.
  const keepLevels = twoSided && (bidSide ? sc.bidKept : sc.askKept);

  const result: L[] = [top.price === shownTop ? top : { ...top, price: shownTop }];
  let changed = top.price !== shownTop;
  let last = shownTop;
  for (let i = 1; i < levels.length; i += 1) {
    const level = levels[i];
    const stored = roundPriceToDigits(level.price + shift, digits);
    let shown = stored;
    if (!keepLevels) {
      const moved = bidSide ? stored - groupBid : stored + groupAsk;
      if (!(moved > 0)) {
        changed = true;
        continue;
      }
      shown = roundPriceToDigits(moved, digits);
    }
    if (!(shown > 0) || (bidSide ? shown > last : shown < last)) {
      changed = true;
      continue;
    }
    last = shown;
    if (shown === level.price) {
      result.push(level);
    } else {
      changed = true;
      result.push({ ...level, price: shown });
    }
  }
  return changed ? result : (levels as L[]);
};

/**
 * Close price of an open position from the (already widened) account quote:
 * a BUY closes at bid, a SELL at ask; `last`/the other side are fallbacks.
 */
export const resolvePositionClosePrice = (
  side: unknown,
  quote: { bid?: unknown; ask?: unknown; last?: unknown } | null | undefined,
): number | null => {
  if (!quote) return null;
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const last = Number(quote.last);
  const isBuy = String(side ?? '').trim().toUpperCase() === 'BUY';
  const ordered = isBuy ? [bid, last, ask] : [ask, last, bid];
  const price = ordered.find(isPositiveFinite);
  return price ?? null;
};
