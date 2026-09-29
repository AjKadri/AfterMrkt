import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createApiServer } from '../src/api/index.js';
import type { PublicMarketDataProvider } from '../src/adapters/bitget/index.js';
import type { ProviderRecord, NormalizedOrderBook } from '../src/domain/types.js';
import { InMemorySnapshotStore } from '../src/domain/snapshots.js';
import { TEST_FIXTURE_SOURCE, testSnapshot } from './fixtures/market.js';

const NOW = new Date('2026-09-29T22:00:00.000Z');

describe('AfterMrkt API contracts', () => {
  it('exposes a server-issued order-book snapshot and accepts only that snapshot ID for simulation', async () => {
    const snapshots = new InMemorySnapshotStore();
    const server = createApiServer({
      marketData: testProvider(),
      snapshots,
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const orderBookResponse = await fetch(`${baseUrl}/api/instruments/RMUUSDT/orderbook`);
      expect(orderBookResponse.status).toBe(200);
      const orderBookBody = (await orderBookResponse.json()) as {
        mode: string;
        data: { snapshot: { snapshotId: string } };
        freshness: { state: string };
      };
      expect(orderBookBody.mode).toBe('LIVE');
      expect(orderBookBody.freshness.state).toBe('fresh');
      expect(orderBookBody.data.snapshot.snapshotId).toMatch(/^[a-f0-9]{64}$/);

      const simulationResponse = await fetch(`${baseUrl}/api/execution/simulations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: 'RMUUSDT',
          requestedQuantity: '5',
          snapshotId: orderBookBody.data.snapshot.snapshotId,
        }),
      });
      expect(simulationResponse.status).toBe(200);
      const simulationBody = (await simulationResponse.json()) as {
        data: { filledQuantity: string; estimateDisclaimer: string };
      };
      expect(simulationBody.data.filledQuantity).toBe('5');
      expect(simulationBody.data.estimateDisclaimer).toBe(
        'observed-book-estimate-not-guaranteed-fill',
      );
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('returns normalized instrument context without exposing a browser-side provider path', async () => {
    const server = createApiServer({
      marketData: testProvider(),
      snapshots: new InMemorySnapshotStore(),
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/instruments/RMUUSDT/context`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { instrument: { providerSymbol: string; nativeTicker: string | null } };
        sourceRefs: Array<{ endpoint: string }>;
      };
      expect(body.data.instrument.providerSymbol).toBe('RMUUSDT');
      expect(body.data.instrument.nativeTicker).toBe('MU');
      expect(body.sourceRefs.every((ref) => ref.endpoint.startsWith('https://'))).toBe(true);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('rejects malformed simulation requests with a stable error code', async () => {
    const server = createApiServer({ marketData: testProvider(), now: () => NOW });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/execution/simulations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', requestedQuantity: 5 }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_REQUEST');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

async function listen(server: ReturnType<typeof createApiServer>): Promise<void> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}

function testProvider(): PublicMarketDataProvider {
  const snapshot = testSnapshot();
  const orderBook: ProviderRecord<NormalizedOrderBook> = {
    source: TEST_FIXTURE_SOURCE,
    data: {
      providerSymbol: snapshot.providerSymbol,
      bids: snapshot.bids,
      asks: snapshot.asks,
      providerTimestamp: snapshot.providerTimestamp,
      receivedAt: snapshot.receivedAt,
      source: TEST_FIXTURE_SOURCE,
    },
  };
  const instrument = {
    providerSymbol: 'RMUUSDT',
    baseCoin: 'rMU',
    quoteCoin: 'USDT',
    nativeTicker: 'MU',
    nativeName: null,
    mappingStatus: 'mapped' as const,
    isReality: true,
    isRwa: null,
    symbolType: 'stock',
    status: 'online',
    quantityPrecision: '5',
    pricePrecision: '2',
    quotePrecision: null,
    minOrderQty: '0.00001',
    minOrderAmount: '10',
    maxMarketOrderAmount: null,
    maxOrderQty: null,
    launchTime: null,
    maintainTime: null,
    tradingPeriod: null,
    weekendTradable: null,
    providerTimestamp: TEST_FIXTURE_SOURCE.providerTimestamp,
    receivedAt: TEST_FIXTURE_SOURCE.receivedAt,
    source: TEST_FIXTURE_SOURCE,
  };
  const ticker = {
    providerSymbol: 'RMUUSDT',
    lastPrice: '100.5',
    bidPrice: '100',
    bidSize: '10',
    askPrice: '101',
    askSize: '10',
    baseVolume: '10',
    quoteVolume: '1005',
    providerTimestamp: TEST_FIXTURE_SOURCE.providerTimestamp,
    receivedAt: TEST_FIXTURE_SOURCE.receivedAt,
    source: TEST_FIXTURE_SOURCE,
  };
  return {
    discoverRealityInstruments: async () => ({ source: TEST_FIXTURE_SOURCE, data: [instrument] }),
    getTicker: async () => ({ source: TEST_FIXTURE_SOURCE, data: ticker }),
    getAllTickers: async () => ({ source: TEST_FIXTURE_SOURCE, data: [ticker] }),
    getOrderBook: async () => orderBook,
    getFills: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getCandles: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getHistoricalCandles: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getStockInfo: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getMarketStates: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getMarketCalendar: async () => ({
      source: TEST_FIXTURE_SOURCE,
      data: { timeZone: 'UTC' },
    }),
  };
}
