import { sha256 } from '../lib/hash.js';
import type { NormalizedOrderBook, OrderBookSnapshot } from './types.js';

export interface MarketSnapshotStore {
  saveOrderBook(snapshot: NormalizedOrderBook): OrderBookSnapshot;
  getOrderBook(snapshotId: string): OrderBookSnapshot | null;
}

export class InMemorySnapshotStore implements MarketSnapshotStore {
  private readonly orderBooks = new Map<string, OrderBookSnapshot>();

  saveOrderBook(snapshot: NormalizedOrderBook): OrderBookSnapshot {
    const snapshotId = sha256(
      JSON.stringify({
        providerSymbol: snapshot.providerSymbol,
        bids: snapshot.bids,
        asks: snapshot.asks,
        providerTimestamp: snapshot.providerTimestamp,
        receivedAt: snapshot.receivedAt,
        rawResponseHash: snapshot.source.rawResponseHash,
      }),
    );
    const stored = deepFreeze({ ...snapshot, snapshotId });
    this.orderBooks.set(snapshotId, stored);
    return stored;
  }

  getOrderBook(snapshotId: string): OrderBookSnapshot | null {
    return this.orderBooks.get(snapshotId) ?? null;
  }
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
