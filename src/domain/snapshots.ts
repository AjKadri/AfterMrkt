import { sha256 } from '../lib/hash.js';
import { canonicalJson } from '../lib/canonical.js';
import type { NormalizedOrderBook, OrderBookSnapshot } from './types.js';

export interface MarketSnapshotStore {
  saveOrderBook(snapshot: NormalizedOrderBook): OrderBookSnapshot;
  getOrderBook(snapshotId: string): OrderBookSnapshot | null;
}

export class InMemorySnapshotStore implements MarketSnapshotStore {
  private readonly orderBooks = new Map<string, OrderBookSnapshot>();

  saveOrderBook(snapshot: NormalizedOrderBook): OrderBookSnapshot {
    const snapshotId = orderBookSnapshotId(snapshot);
    const stored = deepFreeze({ ...snapshot, snapshotId });
    const existing = this.orderBooks.get(snapshotId);
    if (existing !== undefined) return existing;
    this.orderBooks.set(snapshotId, stored);
    return stored;
  }

  getOrderBook(snapshotId: string): OrderBookSnapshot | null {
    return this.orderBooks.get(snapshotId) ?? null;
  }
}

export function orderBookSnapshotId(snapshot: NormalizedOrderBook): string {
  return sha256(
    canonicalJson({
      providerSymbol: snapshot.providerSymbol,
      bids: snapshot.bids,
      asks: snapshot.asks,
      requestedDepth: snapshot.requestedDepth,
      returnedBidCount: snapshot.returnedBidCount,
      returnedAskCount: snapshot.returnedAskCount,
      providerTimestamp: snapshot.providerTimestamp,
      sourceId: snapshot.source.sourceId,
      rawResponseHash: snapshot.source.rawResponseHash,
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
