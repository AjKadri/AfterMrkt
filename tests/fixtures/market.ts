import type {
  NormalizedOrderBook,
  OrderBookSnapshot,
  SourceMetadata,
} from '../../src/domain/types.js';
import type { MarketSnapshotInput } from '../../src/persistence/types.js';

export const TEST_FIXTURE_SOURCE: SourceMetadata = {
  provider: 'bitget',
  sourceId: 'bitget_generic_spot_orderbook',
  sourceType: 'generic-public',
  endpoint: 'https://example.test/market/orderbook',
  providerTimestamp: '1790719199000',
  receivedAt: '2026-09-29T22:00:00.000Z',
  rawResponseHash: 'a'.repeat(64),
  httpStatus: 200,
};

export const TEST_TICKER_SOURCE: SourceMetadata = {
  ...TEST_FIXTURE_SOURCE,
  sourceId: 'bitget_generic_spot_ticker',
  endpoint: 'https://example.test/market/tickers',
};

export function testMarketSnapshotInput(): MarketSnapshotInput {
  return {
    providerSymbol: 'RMUUSDT',
    lastPrice: '100.5',
    bidPrice: '100',
    bidSize: '10',
    askPrice: '101',
    askSize: '10',
    baseVolume: '10',
    volume24h: '10',
    quoteVolume: '1005',
    usdtVolume: null,
    turnover24h: '1005',
    platformTurnover24h: '1005',
    turnoverObservations: {
      turnover24h: {
        value: '1005',
        providerField: 'turnover24h',
        units: 'unknown',
        sourceId: TEST_TICKER_SOURCE.sourceId,
        endpoint: TEST_TICKER_SOURCE.endpoint,
        safeForRanking: false,
        safeForClassification: false,
        note: 'test fixture',
      },
      platformTurnover24h: {
        value: '1005',
        providerField: 'platformTurnover24h',
        units: 'unknown',
        sourceId: TEST_TICKER_SOURCE.sourceId,
        endpoint: TEST_TICKER_SOURCE.endpoint,
        safeForRanking: false,
        safeForClassification: false,
        note: 'test fixture',
      },
    },
    providerTimestamp: TEST_TICKER_SOURCE.providerTimestamp,
    receivedAt: TEST_TICKER_SOURCE.receivedAt,
    source: TEST_TICKER_SOURCE,
  };
}

export function testSnapshot(
  overrides: Partial<NormalizedOrderBook> & { snapshotId?: string } = {},
): OrderBookSnapshot {
  const normalized: NormalizedOrderBook = {
    providerSymbol: overrides.providerSymbol ?? 'RMUUSDT',
    bids: overrides.bids ?? [{ price: '100', quantity: '10' }],
    asks: overrides.asks ?? [{ price: '101', quantity: '10' }],
    requestedDepth: overrides.requestedDepth ?? 40,
    returnedBidCount:
      overrides.returnedBidCount ?? (overrides.bids ?? [{ price: '100', quantity: '10' }]).length,
    returnedAskCount:
      overrides.returnedAskCount ?? (overrides.asks ?? [{ price: '101', quantity: '10' }]).length,
    providerTimestamp: overrides.providerTimestamp ?? TEST_FIXTURE_SOURCE.providerTimestamp,
    receivedAt: overrides.receivedAt ?? TEST_FIXTURE_SOURCE.receivedAt,
    source: overrides.source ?? TEST_FIXTURE_SOURCE,
  };
  return {
    ...normalized,
    snapshotId: overrides.snapshotId ?? 'b'.repeat(64),
  };
}
