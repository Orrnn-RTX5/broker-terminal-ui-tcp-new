import type { OverlayNodeData } from './tradeRuntimeContracts';

/** Upper bound of closed trades that keep DOM nodes on one chart (most recent first). */
export const MAX_HISTORY_OVERLAY_TRADES = 200;

export interface HistoryOverlayEntry {
  contentKey: string;
  elements: HTMLElement[];
}

/** Closed-trade key (ticket id) -> the DOM nodes drawn for it. */
export type HistoryOverlayEntries = Map<string, HistoryOverlayEntry>;

export interface HistoryOverlayDesiredTrade<T> {
  key: string;
  /** Changes whenever anything the trade draws changes; equal keys keep the existing nodes. */
  contentKey: string;
  item: T;
}

export interface HistoryReconcileResult {
  created: number;
  removed: number;
  kept: number;
}

interface MutableRef<V> { current: V }

/**
 * Keyed, incremental diff of the history overlay: nodes of unchanged trades are kept untouched,
 * only new trades are created and only gone (or changed) trades are removed.
 * `create` must append the trade's nodes to `nodesRef` / `dataRef` (as the DOM runtime does).
 */
export const reconcileHistoryOverlayNodes = <T>({
  desired,
  entries,
  nodesRef,
  dataRef,
  create,
}: {
  desired: ReadonlyArray<HistoryOverlayDesiredTrade<T>>;
  entries: HistoryOverlayEntries;
  nodesRef: MutableRef<HTMLElement[]>;
  dataRef: MutableRef<OverlayNodeData[]>;
  create: (item: T) => void;
}): HistoryReconcileResult => {
  const desiredContentByKey = new Map<string, string>();
  for (const trade of desired) desiredContentByKey.set(trade.key, trade.contentKey);

  let removedTrades = 0;
  let removedElements: Set<HTMLElement> | null = null;
  for (const [key, entry] of entries) {
    if (desiredContentByKey.get(key) === entry.contentKey) continue;
    removedElements ??= new Set();
    for (const element of entry.elements) {
      removedElements.add(element);
      try { element.remove(); } catch { /* detached node */ }
    }
    entries.delete(key);
    removedTrades++;
  }
  if (removedElements) {
    const nextNodes: HTMLElement[] = [];
    const nextData: OverlayNodeData[] = [];
    const nodes = nodesRef.current;
    const data = dataRef.current;
    for (let i = 0; i < nodes.length; i++) {
      if (removedElements.has(nodes[i])) continue;
      nextNodes.push(nodes[i]);
      nextData.push(data[i]);
    }
    nodesRef.current = nextNodes;
    dataRef.current = nextData;
  }

  let created = 0;
  // New trades are created in key order, as the former full rebuild did (stable DOM order).
  let toCreate: Array<HistoryOverlayDesiredTrade<T>> | null = null;
  for (const trade of desired) {
    if (!entries.has(trade.key)) (toCreate ??= []).push(trade);
  }
  if (toCreate && toCreate.length > 1) toCreate.sort((a, b) => a.key.localeCompare(b.key));
  for (const trade of toCreate ?? []) {
    const before = nodesRef.current.length;
    create(trade.item);
    entries.set(trade.key, { contentKey: trade.contentKey, elements: nodesRef.current.slice(before) });
    created++;
  }
  return { created, removed: removedTrades, kept: desired.length - created };
};

/** Most recent `max` trades (by latest execution time), without sorting when under the cap. */
export const capRecentHistoryTrades = <T extends { key: string; entryTime: number; exitTime: number }>(
  trades: T[],
  max = MAX_HISTORY_OVERLAY_TRADES,
): T[] => {
  if (trades.length <= max) return trades;
  return trades
    .slice()
    .sort((a, b) => (
      Math.max(b.entryTime, b.exitTime) - Math.max(a.entryTime, a.exitTime) || a.key.localeCompare(b.key)
    ))
    .slice(0, max);
};

/** 32-bit FNV-1a; used to fold per-trade content keys into an order-independent set signature. */
export const hashString32 = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};
