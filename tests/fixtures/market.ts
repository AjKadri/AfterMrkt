import type {
  NormalizedOrderBook,
  OrderBookSnapshot,
  SourceMetadata,
} from '../../src/domain/types.js';

export const TEST_FIXTURE_SOURCE: SourceMetadata = {
  provider: 'bitget',
  endpoint: 'https://example.test/market/orderbook',
  providerTimestamp: '1790719199000',
  receivedAt: '2026-09-29T22:00:00.000Z',
  rawResponseHash: 'a'.repeat(64),
  httpStatus: 200,
};

export function testSnapshot(
  overrides: Partial<NormalizedOrderBook> & { snapshotId?: string } = {},
): OrderBookSnapshot {
  const normalized: NormalizedOrderBook = {
    providerSymbol: overrides.providerSymbol ?? 'RMUUSDT',
    bids: overrides.bids ?? [{ price: '100', quantity: '10' }],
    asks: overrides.asks ?? [{ price: '101', quantity: '10' }],
    providerTimestamp: overrides.providerTimestamp ?? TEST_FIXTURE_SOURCE.providerTimestamp,
    receivedAt: overrides.receivedAt ?? TEST_FIXTURE_SOURCE.receivedAt,
    source: overrides.source ?? TEST_FIXTURE_SOURCE,
  };
  return {
    ...normalized,
    snapshotId: overrides.snapshotId ?? 'b'.repeat(64),
  };
}
