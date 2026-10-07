import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BitgetDemoClient,
  buildBitgetSignature,
  type DemoAccountCheck,
  type DemoAssetBalance,
  type DemoOrderIntent,
  type DemoOrderState,
  type BitgetDemoRealityAdapter,
} from '../src/adapters/bitget/demo.js';
import { ExecutionService } from '../src/domain/execution.js';
import { InMemorySnapshotStore } from '../src/domain/snapshots.js';
import { InMemoryExecutionStore } from '../src/persistence/execution-store.js';
import type { NormalizedOrderBook, ProviderRecord } from '../src/domain/types.js';
import type { PublicMarketDataProvider } from '../src/adapters/bitget/public-market-data.js';
import { TEST_FIXTURE_SOURCE, testSnapshot } from './fixtures/market.js';

const NOW = new Date('2026-09-29T22:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Bitget Demo provider boundary', () => {
  it('uses Demo-only credentials, exact query signing, and paptrading header', async () => {
    const client = new BitgetDemoClient({
      baseUrl: 'https://api.example.test',
      credentials: { apiKey: 'demo-key', secretKey: 'demo-secret', passphrase: 'demo-pass' },
      now: () => NOW,
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: '00000',
          msg: 'success',
          requestTime: '1790719200000',
          data: { list: [], cursor: null },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(client.getOpenOrders('RNVDAUSDT')).resolves.toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://api.example.test/api/v3/trade/unfilled-orders?category=SPOT&limit=100&symbol=RNVDAUSDT',
    );
    const headers = new Headers(init?.headers);
    expect(headers.get('paptrading')).toBe('1');
    expect(headers.get('ACCESS-KEY')).toBe('demo-key');
    expect(headers.get('ACCESS-PASSPHRASE')).toBe('demo-pass');
    expect(headers.get('ACCESS-SIGN')).toBe(
      buildBitgetSignature(
        String(NOW.getTime()),
        'GET',
        '/api/v3/trade/unfilled-orders',
        'category=SPOT&limit=100&symbol=RNVDAUSDT',
        '',
        'demo-secret',
      ),
    );
  });

  it('normalizes the UTA account-assets summary with an assets array', async () => {
    const client = new BitgetDemoClient({
      baseUrl: 'https://api.example.test',
      credentials: { apiKey: 'demo-key', secretKey: 'demo-secret', passphrase: 'demo-pass' },
      now: () => NOW,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: '00000',
          msg: 'success',
          requestTime: '1790719200000',
          data: { accountEquity: '500', assets: [{ coin: 'rNVDA', available: '2', frozen: '1' }] },
        }),
        { status: 200 },
      ),
    );
    await expect(client.getAssets()).resolves.toMatchObject([
      {
        asset: 'rNVDA',
        available: '2',
        locked: '1',
        total: '3',
        providerTimestamp: '1790719200000',
      },
    ]);
  });

  it('does not create a client from live credential names', () => {
    const client = new BitgetDemoClient({ credentials: null });
    expect(client.credentialsConfigured).toBe(false);
  });

  it('normalizes an empty Demo order-info payload as not found', async () => {
    const client = new BitgetDemoClient({
      baseUrl: 'https://api.example.test',
      credentials: { apiKey: 'demo-key', secretKey: 'demo-secret', passphrase: 'demo-pass' },
      now: () => NOW,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: '00000',
          msg: 'success',
          requestTime: '1790719200000',
          data: {},
        }),
        { status: 200 },
      ),
    );
    await expect(client.getOrderByClientOid('missing-client-oid')).resolves.toBeNull();
  });

  it('preserves provider rejection taxonomy for unsupported Demo symbols', async () => {
    const client = new BitgetDemoClient({
      baseUrl: 'https://api.example.test',
      credentials: { apiKey: 'demo-key', secretKey: 'demo-secret', passphrase: 'demo-pass' },
      now: () => NOW,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: '40034',
          msg: 'Parameter RTSLAUSDT does not exist',
          requestTime: '1790719200000',
          data: null,
        }),
        { status: 400 },
      ),
    );
    await expect(client.getOpenOrders('RTSLAUSDT')).rejects.toMatchObject({
      status: 'provider_rejected',
      providerCode: '40034',
      providerMessage: 'Parameter RTSLAUSDT does not exist',
    });
  });
});

describe('deterministic position and confirmation workflow', () => {
  it('keeps manual positions usable for simulation but refuses external confirmation', async () => {
    const provider = marketProvider([testSnapshot()]);
    const service = createService(provider, new FakeDemo([]));
    const position = await service.createManualPosition({
      providerSymbol: 'RMUUSDT',
      quantity: '5',
    });
    const created = await service.createIntent({
      positionId: position.positionId,
      providerSymbol: 'RMUUSDT',
      orderType: 'market',
      requestedQuantity: '5',
    });
    expect(created.intent.environment).toBe('SIMULATED');
    expect(created.intent.simulation.filledQuantity).toBe('5');
    await expect(
      service.confirmIntent(created.intent.intentId, created.confirmationToken),
    ).rejects.toMatchObject({
      code: 'MANUAL_POSITION_NOT_EXECUTABLE',
    });
  });

  it('records a paper decision when the book only ticks before confirmation', async () => {
    const demo = new FakeDemo([]);
    const provider = marketProvider([
      testSnapshot(),
      testSnapshot({ bids: [{ price: '100.01', quantity: '10' }] }),
    ]);
    const service = createService(provider, demo);
    const position = await service.createManualPosition({
      providerSymbol: 'RMUUSDT',
      quantity: '5',
    });
    const prepared = await service.prepareTraderDecision({
      positionId: position.positionId,
      providerSymbol: 'RMUUSDT',
      decision: 'partial_exit',
      requestedQuantity: '2.5',
      orderType: 'market',
    });
    const created = await service.saveTraderDecision({
      prepared,
      decisionStressTest: null,
      currentPrice: '100.5',
    });
    const confirmed = await service.confirmTraderDecision(
      created.decision.decisionId,
      created.confirmationToken,
    );
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.decision.executionStatus).toBe('execution_unavailable');
    expect(confirmed.decision.simulation?.estimatedVWAP).toBe('100');
  });

  it('revalidates a manual exit decision before recording confirmation', async () => {
    const demo = new FakeDemo([]);
    const provider = marketProvider([
      testSnapshot(),
      testSnapshot({ bids: [{ price: '99', quantity: '10' }] }),
      testSnapshot({ bids: [{ price: '99', quantity: '10' }] }),
    ]);
    const service = createService(provider, demo);
    const position = await service.createManualPosition({
      providerSymbol: 'RMUUSDT',
      quantity: '5',
    });
    const prepared = await service.prepareTraderDecision({
      positionId: position.positionId,
      providerSymbol: 'RMUUSDT',
      decision: 'partial_exit',
      requestedQuantity: '2.5',
      orderType: 'market',
    });
    const created = await service.saveTraderDecision({
      prepared,
      decisionStressTest: {
        status: 'available',
        stressTestId: 'stress-test',
        immediateExit: 'The observed depth has a trade-off.',
        evidence: 'The deterministic simulation is the evidence.',
        mainUncertainty: 'The next book may differ.',
        considerations: ['Review the deterministic facts.'],
        model: 'qwen3.8-max',
        providerReportedModel: 'qwen3.8-max',
        promptVersion: 'decision-stress-test-v1',
        processedAt: NOW.toISOString(),
        inputHash: 'a'.repeat(64),
      },
      currentPrice: '100.5',
    });
    expect(created.decision.decisionStressTestInputHash).toBe('a'.repeat(64));
    const refreshed = await service.confirmTraderDecision(
      created.decision.decisionId,
      created.confirmationToken,
    );
    expect(refreshed.status).toBe('refresh_required');
    if (refreshed.status !== 'refresh_required') throw new Error('expected refresh');
    expect(refreshed.decision.decisionStressTest).toBeNull();
    expect(refreshed.decision.decisionStressTestInputHash).toBeNull();
    const confirmed = await service.confirmTraderDecision(
      refreshed.decision.decisionId,
      refreshed.confirmationToken,
    );
    expect(confirmed.status).toBe('confirmed');
    if (confirmed.status === 'refresh_required') throw new Error('expected confirmation');
    expect(confirmed.decision.executionStatus).toBe('execution_unavailable');
    expect(demo.placeCalls).toBe(0);
  });

  it('rejects decision labels whose quantities disagree with the available position', async () => {
    const service = createService(marketProvider([testSnapshot()]), new FakeDemo([]));
    const position = await service.createManualPosition({
      providerSymbol: 'RMUUSDT',
      quantity: '5',
    });

    await expect(
      service.prepareTraderDecision({
        positionId: position.positionId,
        providerSymbol: 'RMUUSDT',
        decision: 'full_exit',
        requestedQuantity: '2.5',
        orderType: 'market',
      }),
    ).rejects.toMatchObject({
      code: 'DECISION_QUANTITY_MISMATCH',
      message: 'full_exit must use the entire available position quantity',
    });
    await expect(
      service.prepareTraderDecision({
        positionId: position.positionId,
        providerSymbol: 'RMUUSDT',
        decision: 'partial_exit',
        requestedQuantity: '5',
        orderType: 'market',
      }),
    ).rejects.toMatchObject({
      code: 'DECISION_QUANTITY_MISMATCH',
      message:
        'partial_exit must use a positive quantity smaller than the available position quantity',
    });
    await expect(
      service.prepareTraderDecision({
        positionId: position.positionId,
        providerSymbol: 'RMUUSDT',
        decision: 'partial_exit',
        requestedQuantity: '0',
        orderType: 'market',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUANTITY',
      message: 'requested quantity must be greater than zero',
    });
  });

  it('renews the final review lifetime after a slow stress-test phase', async () => {
    let currentTimeMs = NOW.getTime();
    const service = createService(
      marketProvider([testSnapshot(), testSnapshot()]),
      new FakeDemo([]),
      () => new Date(currentTimeMs),
    );
    const position = await service.createManualPosition({
      providerSymbol: 'RMUUSDT',
      quantity: '5',
    });
    const prepared = await service.prepareTraderDecision({
      positionId: position.positionId,
      providerSymbol: 'RMUUSDT',
      decision: 'partial_exit',
      requestedQuantity: '2.5',
      orderType: 'market',
    });
    const initialToken = prepared.confirmationToken;
    currentTimeMs += 20_000;
    const created = await service.saveTraderDecision({
      prepared,
      decisionStressTest: null,
      currentPrice: '100.5',
    });
    expect(initialToken).not.toBe(created.confirmationToken);
    const intent = await service.getIntent(created.decision.intentId as string);
    expect(Date.parse(intent.expiresAt) - currentTimeMs).toBe(120_000);
    expect(Date.parse(intent.confirmationExpiresAt) - currentTimeMs).toBe(120_000);

    const confirmed = await service.confirmTraderDecision(
      created.decision.decisionId,
      created.confirmationToken,
    );
    expect(confirmed.status).toBe('confirmed');
    if (confirmed.status === 'refresh_required') throw new Error('expected confirmation');
    expect(confirmed.decision.executionStatus).toBe('execution_unavailable');
  });

  it('rejects quantities above available position and preserves locked quantity', async () => {
    const service = createService(marketProvider([testSnapshot()]), new FakeDemo([]));
    const position = await service.createManualPosition({
      providerSymbol: 'RMUUSDT',
      quantity: '5',
      availableQuantity: '2',
      lockedQuantity: '3',
    });
    expect(position.lockedQuantity).toBe('3');
    await expect(
      service.createIntent({
        positionId: position.positionId,
        providerSymbol: 'RMUUSDT',
        orderType: 'market',
        requestedQuantity: '3',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_POSITION' });
  });

  it('rejects precision, minimum amount, stale books, and maximum slippage deterministically', async () => {
    const service = createService(
      marketProvider([testSnapshot({ providerTimestamp: '1790719000000' })]),
      new FakeDemo([]),
    );
    const position = await service.createManualPosition({
      providerSymbol: 'RMUUSDT',
      quantity: '1',
    });
    await expect(
      service.createIntent({
        positionId: position.positionId,
        providerSymbol: 'RMUUSDT',
        orderType: 'market',
        requestedQuantity: '1',
      }),
    ).rejects.toMatchObject({ code: 'STALE_BOOK' });

    const precisionService = createService(marketProvider([testSnapshot()]), new FakeDemo([]));
    const precisionPosition = await precisionService.createManualPosition({
      providerSymbol: 'RMUUSDT',
      quantity: '20',
    });
    await expect(
      precisionService.createIntent({
        positionId: precisionPosition.positionId,
        providerSymbol: 'RMUUSDT',
        orderType: 'market',
        requestedQuantity: '1.123456',
      }),
    ).rejects.toMatchObject({ code: 'QUANTITY_PRECISION' });

    const slippageService = createService(
      marketProvider([
        testSnapshot({
          bids: [
            { price: '100', quantity: '1' },
            { price: '99', quantity: '2' },
          ],
        }),
      ]),
      new FakeDemo([]),
    );
    const slippagePosition = await slippageService.createManualPosition({
      providerSymbol: 'RMUUSDT',
      quantity: '2',
    });
    await expect(
      slippageService.createIntent({
        positionId: slippagePosition.positionId,
        providerSymbol: 'RMUUSDT',
        orderType: 'market',
        requestedQuantity: '2',
        maximumAcceptableSlippageBps: '0.1',
      }),
    ).rejects.toMatchObject({ code: 'MAX_SLIPPAGE_EXCEEDED' });
  });

  it('fails closed when a fresh book has no executable bid depth', async () => {
    const service = createService(marketProvider([testSnapshot({ bids: [] })]), new FakeDemo([]));
    const position = await service.createManualPosition({
      providerSymbol: 'RMUUSDT',
      quantity: '20',
    });
    await expect(
      service.createIntent({
        positionId: position.positionId,
        providerSymbol: 'RMUUSDT',
        orderType: 'market',
        requestedQuantity: '1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BOOK' });
  });

  it('requires refresh on changed market conditions, then submits once after explicit confirmation', async () => {
    const demo = new FakeDemo([asset('rMU', '5', '0', NOW)]);
    const provider = marketProvider([
      testSnapshot(),
      testSnapshot({ bids: [{ price: '99.99', quantity: '10' }] }),
      testSnapshot({ bids: [{ price: '99.99', quantity: '10' }] }),
    ]);
    const service = createService(provider, demo);
    const positions = await service.getDemoPositions();
    expect(positions.positions).toHaveLength(1);
    const position = positions.positions[0];
    if (position === undefined) throw new Error('expected Demo position');
    const created = await service.createIntent({
      positionId: position.positionId,
      providerSymbol: 'RMUUSDT',
      orderType: 'limit',
      requestedQuantity: '1',
      limitPrice: '99',
    });
    const refreshed = await service.confirmIntent(
      created.intent.intentId,
      created.confirmationToken,
    );
    expect(refreshed.status).toBe('refresh_required');
    if (refreshed.status !== 'refresh_required') throw new Error('expected refresh');
    const confirmed = await service.confirmIntent(
      refreshed.intent.intentId,
      refreshed.confirmationToken,
    );
    expect(confirmed.status).toBe('live');
    if (confirmed.status === 'refresh_required') throw new Error('expected order result');
    expect(demo.placeCalls).toBe(1);
    expect(confirmed.order.clientOid).toHaveLength(31);
    await expect(
      service.confirmIntent(refreshed.intent.intentId, refreshed.confirmationToken),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REUSED',
    });
  });

  it('reconciles an ambiguous provider response without resubmitting', async () => {
    const demo = new FakeDemo([asset('rMU', '5', '0', NOW)]);
    demo.throwOnPlace = true;
    const service = createService(marketProvider([testSnapshot(), testSnapshot()]), demo);
    const positions = await service.getDemoPositions();
    const position = positions.positions[0];
    if (position === undefined) throw new Error('expected Demo position');
    const created = await service.createIntent({
      positionId: position.positionId,
      providerSymbol: 'RMUUSDT',
      orderType: 'market',
      requestedQuantity: '1',
    });
    const result = await service.confirmIntent(created.intent.intentId, created.confirmationToken);
    expect(result.status).toBe('ambiguous');
    expect(demo.placeCalls).toBe(1);
    await expect(
      service.confirmIntent(created.intent.intentId, created.confirmationToken),
    ).rejects.toMatchObject({
      code: 'CONFIRMATION_REUSED',
    });
  });
  it('reports cancellation only after the provider query confirms it', async () => {
    const demo = new FakeDemo([asset('rMU', '5', '0', NOW)]);
    const service = createService(marketProvider([testSnapshot(), testSnapshot()]), demo);
    const positions = await service.getDemoPositions();
    const position = positions.positions[0];
    if (position === undefined) throw new Error('expected Demo position');
    const created = await service.createIntent({
      positionId: position.positionId,
      providerSymbol: 'RMUUSDT',
      orderType: 'limit',
      requestedQuantity: '1',
      limitPrice: '99',
    });
    const submitted = await service.confirmIntent(
      created.intent.intentId,
      created.confirmationToken,
    );
    if (submitted.status === 'refresh_required') throw new Error('expected order result');
    const canceled = await service.cancelOrder(submitted.order.internalOrderId);
    expect(canceled.order.status).toBe('canceled');
    expect(canceled.order.provider?.orderStatus).toBe('canceled');
  });
});

function createService(
  provider: PublicMarketDataProvider,
  demo: FakeDemo,
  now: () => Date = () => NOW,
): ExecutionService {
  return new ExecutionService({
    marketData: provider,
    demo,
    snapshots: new InMemorySnapshotStore(),
    store: new InMemoryExecutionStore(),
    now,
  });
}

function marketProvider(books: ReturnType<typeof testSnapshot>[]): PublicMarketDataProvider {
  let index = 0;
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
  const getBook = async (): Promise<ProviderRecord<NormalizedOrderBook>> => {
    const current = books[Math.min(index++, books.length - 1)];
    if (current === undefined) throw new Error('book fixture missing');
    const { snapshotId, ...data } = current;
    void snapshotId;
    return { source: TEST_FIXTURE_SOURCE, data };
  };
  return {
    discoverRealityInstruments: async () => ({ source: TEST_FIXTURE_SOURCE, data: [instrument] }),
    getTicker: async () => {
      throw new Error('not used');
    },
    getAllTickers: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getOrderBook: getBook,
    getFills: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getCandles: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getHistoricalCandles: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getStockInfo: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getCompanyOverview: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getMarketStates: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getMarketCalendar: async () => ({ source: TEST_FIXTURE_SOURCE, data: { timeZone: 'UTC' } }),
  };
}

function asset(assetName: string, available: string, locked: string, now: Date): DemoAssetBalance {
  return {
    asset: assetName,
    available,
    locked,
    total: '5',
    providerTimestamp: String(now.getTime()),
    receivedAt: now.toISOString(),
  };
}

class FakeDemo implements BitgetDemoRealityAdapter {
  readonly environment = 'BITGET_DEMO' as const;
  readonly credentialsConfigured = true;
  readonly balances: DemoAssetBalance[];
  readonly orders = new Map<string, DemoOrderState>();
  placeCalls = 0;
  throwOnPlace = false;

  constructor(balances: DemoAssetBalance[]) {
    this.balances = balances;
  }

  async checkAccount(): Promise<DemoAccountCheck> {
    return {
      status: 'verified',
      environment: 'BITGET_DEMO',
      credentialsConfigured: true,
      authentication: 'verified',
      assets: this.balances,
      settings: {},
      withdrawalPermission: 'unknown',
      permissions: [],
      warnings: [],
      checkedAt: NOW.toISOString(),
    };
  }

  async getAssets(): Promise<DemoAssetBalance[]> {
    return this.balances;
  }

  async getOpenOrders(): Promise<DemoOrderState[]> {
    return [...this.orders.values()].filter((order) =>
      ['live', 'partially_filled'].includes(order.orderStatus),
    );
  }

  async placeOrder(intent: DemoOrderIntent): Promise<DemoOrderState> {
    this.placeCalls += 1;
    if (this.throwOnPlace) throw new Error('simulated provider timeout');
    const order = demoOrder(intent, 'live');
    this.orders.set(intent.clientOid, order);
    return order;
  }

  async getOrderByClientOid(clientOid: string): Promise<DemoOrderState | null> {
    return this.orders.get(clientOid) ?? null;
  }

  async cancelOrder(clientOid: string): Promise<DemoOrderState | null> {
    const current = this.orders.get(clientOid);
    if (current === undefined) return null;
    const canceled = { ...current, orderStatus: 'canceled' };
    this.orders.set(clientOid, canceled);
    return canceled;
  }
}

function demoOrder(intent: DemoOrderIntent, status: string): DemoOrderState {
  return {
    orderId: `provider-${intent.clientOid}`,
    clientOid: intent.clientOid,
    symbol: intent.symbol,
    side: intent.side,
    orderType: intent.orderType,
    orderStatus: status,
    requestedQuantity: intent.quantity,
    filledQuantity: '0',
    remainingQuantity: intent.quantity,
    averageFillPrice: null,
    executedValue: null,
    fees: [],
    createdTime: String(NOW.getTime()),
    updatedTime: String(NOW.getTime()),
    receivedAt: NOW.toISOString(),
  };
}
