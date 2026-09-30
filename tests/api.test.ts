import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createApiServer } from '../src/api/index.js';
import type { PublicMarketDataProvider } from '../src/adapters/bitget/index.js';
import type { ProviderRecord, NormalizedOrderBook } from '../src/domain/types.js';
import { InMemorySnapshotStore } from '../src/domain/snapshots.js';
import { createReplayCase } from '../src/domain/replay.js';
import { InMemoryCaptureStore } from '../src/persistence/store.js';
import { canonicalJson } from '../src/lib/canonical.js';
import { sha256 } from '../src/lib/hash.js';
import type { SourceEvent } from '../src/contracts/events.js';
import { TEST_FIXTURE_SOURCE, testMarketSnapshotInput, testSnapshot } from './fixtures/market.js';

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
        data: {
          instrument: { providerSymbol: string; nativeTicker: string | null };
          session: { status: string };
          reference: { status: string };
          move: { status: string };
          market: { status: string };
          liquidityContext: { positionStatus: string };
          eventContext: { status: string };
          nativePriceConfirmation: { status: string };
          explanation: { headline: string };
        };
        sourceRefs: Array<{ endpoint: string }>;
      };
      expect(body.data.instrument.providerSymbol).toBe('RMUUSDT');
      expect(body.data.instrument.nativeTicker).toBe('MU');
      expect(body.data.session.status).toBe('unavailable');
      expect(body.data.reference.status).toBe('unavailable');
      expect(body.data.move.status).toBe('unavailable');
      expect(body.data.market.status).toBe('available');
      expect(body.data.liquidityContext.positionStatus).toBe('position_required');
      expect(body.data.eventContext.status).toBe('insufficient-event-evidence');
      expect(body.data.nativePriceConfirmation.status).toBe('unavailable');
      expect(body.data.explanation.headline).toContain('context');
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

  it('exposes manual positions and requires Demo-only confirmation for external execution', async () => {
    const server = createApiServer({ marketData: testProvider(), now: () => NOW });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const positionResponse = await fetch(`${baseUrl}/api/execution/positions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', quantity: '5' }),
      });
      expect(positionResponse.status).toBe(200);
      const positionBody = (await positionResponse.json()) as {
        data: { position: { positionId: string; environment: string; isSimulated: boolean } };
      };
      expect(positionBody.data.position.positionId).toMatch(/^[a-f0-9]{64}$/);
      expect(positionBody.data.position.environment).toBe('SIMULATED');
      expect(positionBody.data.position.isSimulated).toBe(true);

      const intentResponse = await fetch(`${baseUrl}/api/execution/intents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          positionId: positionBody.data.position.positionId,
          symbol: 'RMUUSDT',
          orderType: 'market',
          requestedQuantity: '5',
        }),
      });
      expect(intentResponse.status).toBe(200);
      const intentBody = (await intentResponse.json()) as {
        data: { intent: { intentId: string; environment: string }; confirmationToken: string };
        sourceRefs: Array<{ snapshotId: string | null; providerSymbol: string | null }>;
      };
      expect(intentBody.data.intent.environment).toBe('SIMULATED');
      expect(intentBody.data.confirmationToken.length).toBeGreaterThan(20);
      expect(intentBody.sourceRefs).toHaveLength(1);
      expect(intentBody.sourceRefs[0]).toMatchObject({
        snapshotId: expect.any(String),
        providerSymbol: 'RMUUSDT',
      });

      const blockedResponse = await fetch(
        `${baseUrl}/api/execution/intents/${intentBody.data.intent.intentId}/confirm`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmationToken: intentBody.data.confirmationToken }),
        },
      );
      expect(blockedResponse.status).toBe(400);
      expect((await blockedResponse.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'MANUAL_POSITION_NOT_EXECUTABLE' },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('exposes persisted source events and pending analysis without invoking Qwen', async () => {
    const eventStore = new InMemoryCaptureStore();
    const event = testEvent();
    await eventStore.saveSourceEvent(event);
    const server = createApiServer({
      marketData: testProvider(),
      eventStore,
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const listResponse = await fetch(`${baseUrl}/api/instruments/RMUUSDT/events`);
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        data: { events: SourceEvent[]; eventContext: { label: string } };
      };
      expect(listBody.data.events).toHaveLength(1);
      expect(listBody.data.eventContext.label).toBe('insufficient-event-evidence');

      const eventResponse = await fetch(`${baseUrl}/api/events/${event.eventId}`);
      expect(eventResponse.status).toBe(200);
      expect((await eventResponse.json()) as { data: { latestAnalysis: unknown } }).toMatchObject({
        data: { latestAnalysis: null },
      });

      const analysisResponse = await fetch(`${baseUrl}/api/events/${event.eventId}/analysis`);
      expect(analysisResponse.status).toBe(200);
      expect((await analysisResponse.json()) as { data: { status: string } }).toMatchObject({
        data: { status: 'pending' },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('serves replay metadata and simulations without invoking the provider', async () => {
    const captureStore = new InMemoryCaptureStore();
    const marketSnapshot = await captureStore.saveMarketSnapshot(testMarketSnapshotInput());
    const orderBookSnapshot = await captureStore.saveOrderBook(testSnapshot());
    const replayCase = await captureStore.saveReplayCase(
      createReplayCase({
        providerSymbol: 'RMUUSDT',
        nativeTicker: 'MU',
        replayAsOf: NOW.toISOString(),
        marketSnapshot,
        orderBookSnapshot,
        marketStateSnapshot: null,
        manifestCreatedAt: '2026-09-30T00:00:00.000Z',
      }),
    );
    const provider = testProvider();
    const failIfCalled = async (): Promise<never> => {
      throw new Error('provider must not be called by replay routes');
    };
    provider.discoverRealityInstruments = failIfCalled;
    provider.getTicker = failIfCalled;
    provider.getOrderBook = failIfCalled;
    const server = createApiServer({
      marketData: provider,
      replayStore: captureStore,
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const listResponse = await fetch(`${baseUrl}/api/replays`);
      expect(listResponse.status).toBe(200);
      expect((await listResponse.json()) as { mode: string }).toMatchObject({ mode: 'REPLAY' });
      const caseResponse = await fetch(`${baseUrl}/api/replays/${replayCase.manifest.caseId}`);
      expect(caseResponse.status).toBe(200);
      const caseBody = (await caseResponse.json()) as {
        data: { manifest: { manifestHash: string } };
      };
      expect(caseBody.data.manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
      const simulationResponse = await fetch(
        `${baseUrl}/api/replays/${replayCase.manifest.caseId}/simulations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestedQuantity: '5' }),
        },
      );
      expect(simulationResponse.status).toBe(200);
      const simulationBody = (await simulationResponse.json()) as {
        mode: string;
        data: { data: { simulation: { filledQuantity: string } } };
      };
      expect(simulationBody.mode).toBe('REPLAY');
      expect(simulationBody.data.data.simulation.filledQuantity).toBe('5');

      const contextResponse = await fetch(
        `${baseUrl}/api/replays/${replayCase.manifest.caseId}/context`,
      );
      expect(contextResponse.status).toBe(200);
      const contextBody = (await contextResponse.json()) as {
        mode: string;
        data: {
          mode: string;
          reference: { status: string };
          liquidityContext: { status: string };
        };
      };
      expect(contextBody.mode).toBe('REPLAY');
      expect(contextBody.data.mode).toBe('REPLAY');
      expect(contextBody.data.reference.status).toBe('unavailable');
      expect(contextBody.data.liquidityContext.status).toBe('available');
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
      requestedDepth: snapshot.requestedDepth,
      returnedBidCount: snapshot.returnedBidCount,
      returnedAskCount: snapshot.returnedAskCount,
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
    mappingSource: TEST_FIXTURE_SOURCE,
  };
  const ticker = {
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
    turnover24h: null,
    platformTurnover24h: null,
    turnoverObservations: {
      turnover24h: {
        value: null,
        providerField: 'turnover24h' as const,
        units: 'unknown' as const,
        sourceId: TEST_FIXTURE_SOURCE.sourceId,
        endpoint: TEST_FIXTURE_SOURCE.endpoint,
        safeForRanking: false as const,
        safeForClassification: false as const,
        note: 'test fixture',
      },
      platformTurnover24h: {
        value: null,
        providerField: 'platformTurnover24h' as const,
        units: 'unknown' as const,
        sourceId: TEST_FIXTURE_SOURCE.sourceId,
        endpoint: TEST_FIXTURE_SOURCE.endpoint,
        safeForRanking: false as const,
        safeForClassification: false as const,
        note: 'test fixture',
      },
    },
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
    getCompanyOverview: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getMarketStates: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getMarketCalendar: async () => ({
      source: TEST_FIXTURE_SOURCE,
      data: { timeZone: 'UTC' },
    }),
  };
}

function testEvent(): SourceEvent {
  const rawContentHash = sha256('api event fixture');
  return {
    eventId: sha256(canonicalJson({ rawContentHash, externalId: 'api-event' })),
    providerSymbol: 'RMUUSDT',
    nativeTicker: 'MU',
    sourceType: 'test-fixture',
    sourceName: 'test source',
    sourceUrl: 'https://example.test/events/api-event',
    externalId: 'api-event',
    title: 'API event fixture',
    excerpt: 'The source reports a filing.',
    publishedAt: null,
    eventOccurredAt: null,
    sourceAvailableAt: '2026-09-29T20:01:00.000Z',
    retrievedAt: '2026-09-29T20:02:00.000Z',
    category: 'financial_event',
    rawContentHash,
    details: {},
  };
}
