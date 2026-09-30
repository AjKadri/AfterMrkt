import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import Decimal from 'decimal.js';
import { ZodError } from 'zod';
import { classifyThrownError, ProbeError } from '../lib/errors.js';
import { BitgetDemoClient, type BitgetDemoRealityAdapter } from '../adapters/bitget/demo.js';
import type { PublicMarketDataProvider } from '../adapters/bitget/public-market-data.js';
import {
  ExecutionConfirmationRequestSchema,
  ExecutionIntentRequestSchema,
  ManualPositionRequestSchema,
  ExecutionSimulationRequestSchema,
  ReplaySimulationRequestSchema,
  type ApiEnvelope,
  type ApiErrorCode,
  type ApiErrorEnvelope,
  type ExecutionSimulationRequest,
} from '../contracts/api.js';
import { freshnessFromSource } from '../domain/freshness.js';
import { deriveSessionContext } from '../domain/event-window.js';
import {
  buildAfterMrktContext,
  calculateRTokenMove,
  deriveUnifiedEventContext,
  selectRTokenCloseReference,
  type AfterMrktContext,
} from '../domain/market-context.js';
import { EventReplayEngine, ReplayEngine, ReplayError } from '../domain/replay.js';
import {
  calculateMarketMetrics,
  resolveMarketQualityConfig,
  simulateExit,
  type MarketQualityConfig,
} from '../domain/market-quality.js';
import { InMemorySnapshotStore, type MarketSnapshotStore } from '../domain/snapshots.js';
import type { SourceMetadata, SourceReference } from '../domain/types.js';
import type {
  CaptureStore,
  EventReplayCase,
  ReplayCase,
  ReplaySourceReference,
} from '../persistence/types.js';
import { ExecutionError, ExecutionService } from '../domain/execution.js';
import type { ExecutionStore } from '../domain/execution-store.js';
import { InMemoryExecutionStore } from '../persistence/execution-store.js';
import {
  EXECUTION_CAPABILITIES,
  toProductContext,
  toProductEvent,
  toProductEventAnalysis,
  toProductEventContext,
  toProductInstrumentListItem,
  toProductReplayDetail,
  toProductReplaySummary,
  toProductSimulation,
  toProductSourceReference,
  type ProductInstrumentListItem,
  type ProductSourceReference,
} from './product-contracts.js';

export type ApiServerOptions = {
  marketData: PublicMarketDataProvider;
  snapshots?: MarketSnapshotStore;
  replayStore?: CaptureStore;
  eventReplayStore?: CaptureStore;
  replayEngine?: ReplayEngine;
  eventReplayEngine?: EventReplayEngine;
  eventStore?: CaptureStore;
  demo?: BitgetDemoRealityAdapter;
  executionStore?: ExecutionStore;
  executionService?: ExecutionService;
  now?: () => Date;
  qualityConfig?: Partial<MarketQualityConfig>;
};

type ContextCacheEntry = {
  context: AfterMrktContext;
  cachedAtMs: number;
};

type InstrumentListCacheEntry = {
  expiresAtMs: number;
  data: {
    instruments: ProductInstrumentListItem[];
    executionCapabilities: typeof EXECUTION_CAPABILITIES;
  };
  sourceRefs: ProductSourceReference[];
  warnings: string[];
  asOf: string;
  freshness: ReturnType<typeof freshnessFromSource>;
};

type ApiRuntime = {
  contextCache: Map<string, ContextCacheEntry>;
  instrumentListCache: InstrumentListCacheEntry | null;
};

const MAX_BODY_BYTES = 128 * 1024;
const CONTEXT_CACHE_TTL_MS = 5_000;
const INSTRUMENT_LIST_CACHE_TTL_MS = 5_000;
const DEFAULT_INSTRUMENT_LIST_LIMIT = 12;
const MAX_INSTRUMENT_LIST_LIMIT = 40;

export function createApiServer(options: ApiServerOptions): Server {
  const snapshots = options.snapshots ?? createDefaultSnapshotStore();
  const replayEngine =
    options.replayEngine ??
    (options.replayStore === undefined
      ? null
      : new ReplayEngine(options.replayStore, options.qualityConfig));
  const eventReplayStore = options.eventReplayStore ?? options.replayStore;
  const eventReplayEngine =
    options.eventReplayEngine ??
    (eventReplayStore === undefined ? null : new EventReplayEngine(eventReplayStore));
  const now = options.now ?? (() => new Date());
  const executionStore = options.executionStore ?? new InMemoryExecutionStore();
  const demo = options.demo ?? new BitgetDemoClient();
  const execution =
    options.executionService ??
    new ExecutionService({
      marketData: options.marketData,
      demo,
      snapshots,
      store: executionStore,
      now,
      qualityConfig: options.qualityConfig ?? {},
    });
  const runtime: ApiRuntime = {
    contextCache: new Map(),
    instrumentListCache: null,
  };

  return createServer((request, response) => {
    void handleRequest(
      request,
      response,
      options,
      snapshots,
      replayEngine,
      eventReplayEngine,
      execution,
      now,
      runtime,
    ).catch((error: unknown) => {
      const mapped = mapError(error);
      const mode = (request.url ?? '').startsWith('/api/replays') ? 'REPLAY' : 'LIVE';
      sendError(
        response,
        now(),
        mapped.code,
        mapped.message,
        mapped.status,
        [],
        mode,
        mapped.details,
      );
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ApiServerOptions,
  snapshots: MarketSnapshotStore,
  replayEngine: ReplayEngine | null,
  eventReplayEngine: EventReplayEngine | null,
  execution: ExecutionService,
  now: () => Date,
  runtime: ApiRuntime,
): Promise<void> {
  const method = request.method ?? 'GET';
  const parsedUrl = new URL(request.url ?? '/', 'http://localhost');
  const parts = parsedUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (method === 'GET' && parsedUrl.pathname === '/api/demo/positions') {
    await sendDemoPositions(response, execution, now);
    return;
  }

  if (method === 'POST' && parsedUrl.pathname === '/api/execution/positions') {
    await sendManualPosition(response, request, execution, now);
    return;
  }

  if (method === 'POST' && parsedUrl.pathname === '/api/execution/intents') {
    await sendExecutionIntent(response, request, execution, now);
    return;
  }

  if (
    method === 'GET' &&
    parts.length === 4 &&
    parts[0] === 'api' &&
    parts[1] === 'execution' &&
    parts[2] === 'intents'
  ) {
    await sendExecutionIntentView(response, execution, now, parts[3] ?? '');
    return;
  }

  if (
    method === 'POST' &&
    parts.length === 5 &&
    parts[0] === 'api' &&
    parts[1] === 'execution' &&
    parts[2] === 'intents' &&
    parts[4] === 'confirm'
  ) {
    await sendExecutionConfirmation(response, request, execution, now, parts[3] ?? '');
    return;
  }

  if (
    method === 'GET' &&
    parts.length === 4 &&
    parts[0] === 'api' &&
    parts[1] === 'execution' &&
    parts[2] === 'orders'
  ) {
    await sendExecutionOrderView(response, execution, now, parts[3] ?? '');
    return;
  }

  if (
    method === 'POST' &&
    parts.length === 5 &&
    parts[0] === 'api' &&
    parts[1] === 'execution' &&
    parts[2] === 'orders' &&
    parts[4] === 'cancel'
  ) {
    await sendExecutionOrderCancellation(response, execution, now, parts[3] ?? '');
    return;
  }

  if (method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'replays') {
    await sendReplayList(response, replayEngine, eventReplayEngine, now);
    return;
  }

  if (method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'replays') {
    await sendReplayCase(response, replayEngine, eventReplayEngine, now, parts[2] ?? '');
    return;
  }

  if (
    method === 'GET' &&
    parts.length === 4 &&
    parts[0] === 'api' &&
    parts[1] === 'replays' &&
    parts[3] === 'context'
  ) {
    await sendReplayContext(response, replayEngine, eventReplayEngine, now, parts[2] ?? '');
    return;
  }

  if (
    method === 'POST' &&
    parts.length === 4 &&
    parts[0] === 'api' &&
    parts[1] === 'replays' &&
    parts[3] === 'simulations'
  ) {
    await sendReplaySimulation(response, request, replayEngine, now, parts[2] ?? '');
    return;
  }

  if (
    method === 'GET' &&
    parts.length === 4 &&
    parts[0] === 'api' &&
    parts[1] === 'instruments' &&
    parts[3] === 'events'
  ) {
    await sendInstrumentEvents(response, options, now, parts[2] ?? '');
    return;
  }

  if (method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'events') {
    await sendEvent(response, options, now, parts[2] ?? '');
    return;
  }

  if (
    method === 'GET' &&
    parts.length === 4 &&
    parts[0] === 'api' &&
    parts[1] === 'events' &&
    parts[3] === 'analysis'
  ) {
    await sendEventAnalysis(response, options, now, parts[2] ?? '');
    return;
  }

  if (method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'instruments') {
    await sendInstrumentList(response, options, now, parsedUrl, runtime);
    return;
  }

  if (
    method === 'GET' &&
    parts.length === 4 &&
    parts[0] === 'api' &&
    parts[1] === 'instruments' &&
    parts[3] === 'context'
  ) {
    await sendContext(response, options, snapshots, now, parts[2] ?? '', runtime);
    return;
  }

  if (
    method === 'GET' &&
    parts.length === 4 &&
    parts[0] === 'api' &&
    parts[1] === 'instruments' &&
    parts[3] === 'orderbook'
  ) {
    await sendOrderBook(response, options, snapshots, now, parts[2] ?? '');
    return;
  }

  if (method === 'POST' && parsedUrl.pathname === '/api/execution/simulations') {
    await sendSimulation(response, request, options, snapshots, now);
    return;
  }

  sendError(response, now(), 'INVALID_REQUEST', 'route not found', 404);
}

async function sendInstrumentList(
  response: ServerResponse,
  options: ApiServerOptions,
  now: () => Date,
  parsedUrl: URL,
  runtime: ApiRuntime,
): Promise<void> {
  const currentTimeMs = now().getTime();
  const cached = runtime.instrumentListCache;
  if (cached !== null && cached.expiresAtMs > currentTimeMs) {
    sendEnvelope(response, {
      mode: 'LIVE',
      asOf: cached.asOf,
      freshness: cached.freshness,
      data: cached.data,
      sourceRefs: cached.sourceRefs,
      warnings: cached.warnings,
    });
    return;
  }

  const requestedLimit = Number(
    parsedUrl.searchParams.get('limit') ?? DEFAULT_INSTRUMENT_LIST_LIMIT,
  );
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, MAX_INSTRUMENT_LIST_LIMIT))
    : DEFAULT_INSTRUMENT_LIST_LIMIT;
  const universe = await options.marketData.discoverRealityInstruments();
  const tickers = await safeProviderCall(() => options.marketData.getAllTickers());
  const marketState = await safeProviderCall(() => options.marketData.getMarketStates());
  const marketCalendar = await safeProviderCall(() => options.marketData.getMarketCalendar());
  const asOf = now();
  const session = deriveSessionContext({
    asOf: asOf.toISOString(),
    markets: marketState?.data ?? null,
    calendar: marketCalendar?.data ?? null,
  });
  const store = options.eventStore ?? options.replayStore;
  const events = store === undefined ? [] : await safeStoreCall(() => store.listSourceEvents());
  const analyses = store === undefined ? [] : await safeStoreCall(() => store.listEventAnalyses());
  const tickerBySymbol = new Map(
    (tickers?.data ?? []).map((ticker) => [ticker.providerSymbol, ticker]),
  );
  const mappedOnline = universe.data
    .filter(
      (instrument) =>
        instrument.mappingStatus === 'mapped' &&
        instrument.nativeTicker !== null &&
        instrument.status?.toLowerCase() === 'online',
    )
    .map((instrument) => ({ instrument, ticker: tickerBySymbol.get(instrument.providerSymbol) }))
    .filter(
      (item): item is typeof item & { ticker: NonNullable<typeof item.ticker> } =>
        item.ticker !== undefined,
    )
    .sort((left, right) =>
      compareInformationalDecimal(
        left.ticker.turnover24h ?? left.ticker.platformTurnover24h ?? left.ticker.quoteVolume,
        right.ticker.turnover24h ?? right.ticker.platformTurnover24h ?? right.ticker.quoteVolume,
      ),
    );
  const selected = mappedOnline.slice(0, limit);
  const listSnapshots = createDefaultSnapshotStore();
  const listItems = await Promise.all(
    selected.map(async ({ instrument, ticker }) => {
      const [orderBook, historicalCandles] = await Promise.all([
        safeProviderCall(() => options.marketData.getOrderBook(instrument.providerSymbol)),
        session.previousRegularSessionClose === null
          ? Promise.resolve(null)
          : safeProviderCall(() =>
              options.marketData.getHistoricalCandles(instrument.providerSymbol, {
                interval: '1m',
                limit: 100,
                endTime: String(Date.parse(session.previousRegularSessionClose as string)),
              }),
            ),
      ]);
      const snapshot = orderBook === null ? null : listSnapshots.saveOrderBook(orderBook.data);
      const metrics =
        snapshot === null
          ? null
          : calculateMarketMetrics(
              snapshot,
              asOf,
              resolveMarketQualityConfig(options.qualityConfig),
            );
      const reference = selectRTokenCloseReference({
        providerSymbol: instrument.providerSymbol,
        regularClose: session.previousRegularSessionClose,
        contextAsOf: asOf.toISOString(),
        candles:
          historicalCandles === null
            ? null
            : {
                data: historicalCandles.data,
                interval: '1m',
                source: historicalCandles.source,
                sourceRef: toSourceReference(
                  historicalCandles.source,
                  instrument.providerSymbol,
                  null,
                ),
              },
      });
      const move = calculateRTokenMove({
        currentPrice: ticker.lastPrice,
        reference,
        contextAsOf: asOf.toISOString(),
      });
      const eventContext =
        store === undefined
          ? null
          : deriveUnifiedEventContext({
              providerSymbol: instrument.providerSymbol,
              events: events.filter((event) => event.providerSymbol === instrument.providerSymbol),
              analyses,
              contextAsOf: asOf.toISOString(),
              markets: marketState?.data ?? null,
              calendar: marketCalendar?.data ?? null,
            });
      const freshness =
        orderBook === null
          ? freshnessFromSource(ticker.source, asOf)
          : freshnessFromSource(orderBook.source, asOf);
      const warnings: string[] = [];
      if (ticker.lastPrice === null) warnings.push('Current ticker price is unavailable.');
      if (orderBook === null) warnings.push('Current order-book data is unavailable.');
      if (move.status === 'unavailable') {
        warnings.push(`Native-close move is unavailable: ${move.reason}.`);
      }
      if (eventContext === null) warnings.push('Event evidence storage is unavailable.');
      if (freshness.state !== 'fresh') {
        warnings.push(`Market data is ${freshness.state}: ${freshness.reason}`);
      }
      return toProductInstrumentListItem({
        instrument,
        lastPrice: ticker.lastPrice,
        bid: metrics?.bestBid ?? ticker.bidPrice,
        ask: metrics?.bestAsk ?? ticker.askPrice,
        spreadBps: metrics?.spreadBps ?? null,
        sessionStatus: session.status,
        moveSinceNativeClosePercent: move.percentageMove,
        eventContextStatus: eventContext?.status ?? 'unavailable',
        liquidityStatus: metrics?.condition.label ?? 'unavailable',
        freshness,
        warnings,
      });
    }),
  );
  const sourceRefs = [
    toProductSourceReference(universe.source),
    ...(tickers === null ? [] : [toProductSourceReference(tickers.source)]),
    ...(marketState === null ? [] : [toProductSourceReference(marketState.source)]),
    ...(marketCalendar === null ? [] : [toProductSourceReference(marketCalendar.source)]),
  ];
  const warnings = [
    ...(tickers === null
      ? ['Ticker collection was unavailable; list metrics may be incomplete.']
      : []),
    ...(marketState === null || marketCalendar === null
      ? ['Session status is unavailable because the provider market schedule is incomplete.']
      : []),
    ...(listItems.length === 0
      ? ['No mapped online Reality instruments with current tickers were available.']
      : []),
  ];
  const freshness = freshnessFromSource(universe.source, asOf);
  const data = { instruments: listItems, executionCapabilities: EXECUTION_CAPABILITIES };
  runtime.instrumentListCache = {
    expiresAtMs: currentTimeMs + INSTRUMENT_LIST_CACHE_TTL_MS,
    data,
    sourceRefs,
    warnings,
    asOf: asOf.toISOString(),
    freshness,
  };
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: asOf.toISOString(),
    freshness,
    data,
    sourceRefs,
    warnings,
  });
}

async function sendContext(
  response: ServerResponse,
  options: ApiServerOptions,
  snapshots: MarketSnapshotStore,
  now: () => Date,
  symbol: string,
  runtime: ApiRuntime,
): Promise<void> {
  const cacheEntry = runtime.contextCache.get(symbol);
  const currentTimeMs = now().getTime();
  if (cacheEntry !== undefined && cacheEntry.cachedAtMs + CONTEXT_CACHE_TTL_MS > currentTimeMs) {
    const cachedData = toProductContext(cacheEntry.context);
    sendEnvelope(response, {
      mode: 'LIVE',
      asOf: cacheEntry.context.asOf,
      freshness: contextFreshness(cacheEntry.context),
      data: cachedData,
      sourceRefs: cacheEntry.context.sourceRefs.map((source) => toProductSourceReference(source)),
      warnings: cacheEntry.context.warnings,
    });
    return;
  }
  const universe = await options.marketData.discoverRealityInstruments();
  const instrument = universe.data.find((item) => item.providerSymbol === symbol);
  if (!instrument) {
    sendError(response, now(), 'INSTRUMENT_NOT_FOUND', `instrument ${symbol} was not found`, 404);
    return;
  }
  const asOf = now();
  const [ticker, orderBook, marketState, marketCalendar] = await Promise.all([
    safeProviderCall(() => options.marketData.getTicker(symbol)),
    safeProviderCall(() => options.marketData.getOrderBook(symbol)),
    safeProviderCall(() => options.marketData.getMarketStates()),
    safeProviderCall(() => options.marketData.getMarketCalendar()),
  ]);
  const getSuspension = options.marketData.getSuspensionResumptionInfo;
  const suspension =
    instrument.nativeTicker !== null && getSuspension !== undefined
      ? await safeProviderCall(() => getSuspension(instrument.nativeTicker as string))
      : null;
  const sessionSchedule = deriveSessionContext({
    asOf: asOf.toISOString(),
    markets: marketState?.data ?? null,
    calendar: marketCalendar?.data ?? null,
  });
  const historicalCandles =
    sessionSchedule.previousRegularSessionClose === null
      ? null
      : await safeProviderCall(() =>
          options.marketData.getHistoricalCandles(symbol, {
            interval: '1m',
            limit: 100,
            endTime: String(Date.parse(sessionSchedule.previousRegularSessionClose as string)),
          }),
        );
  const store = options.eventStore ?? options.replayStore;
  const events = store === undefined ? [] : await store.listSourceEvents(symbol);
  const analyses = store === undefined ? [] : await store.listEventAnalyses();
  const snapshot = orderBook === null ? null : snapshots.saveOrderBook(orderBook.data);
  const sourceRefs = [
    toSourceReference(universe.source, symbol, null),
    ...(ticker === null ? [] : [toSourceReference(ticker.source, symbol, null)]),
    ...(orderBook === null || snapshot === null
      ? []
      : [toSourceReference(orderBook.source, symbol, snapshot.snapshotId)]),
    ...(marketState === null ? [] : [toSourceReference(marketState.source, null, null)]),
    ...(marketCalendar === null ? [] : [toSourceReference(marketCalendar.source, null, null)]),
    ...(suspension === null
      ? []
      : [toSourceReference(suspension.source, instrument.nativeTicker, null)]),
    ...(historicalCandles === null
      ? []
      : [toSourceReference(historicalCandles.source, symbol, null)]),
  ];
  const session = buildAfterMrktContext({
    mode: 'LIVE',
    asOf: asOf.toISOString(),
    providerSymbol: symbol,
    instrument,
    ticker: ticker?.data ?? null,
    orderBook: snapshot,
    markets: marketState?.data ?? null,
    calendar: marketCalendar?.data ?? null,
    suspension: suspension?.data ?? null,
    suspensionStatus: suspension?.data.recordStatus ?? 'unavailable',
    candles:
      historicalCandles === null
        ? null
        : {
            data: historicalCandles.data,
            interval: '1m',
            source: historicalCandles.source,
            sourceRef: toSourceReference(historicalCandles.source, symbol, null),
          },
    events,
    analyses,
    sourceRefs,
    ...(store === undefined ? { eventSourceAvailable: false } : {}),
    ...(options.qualityConfig === undefined ? {} : { qualityConfig: options.qualityConfig }),
  });
  runtime.contextCache.set(symbol, { context: session, cachedAtMs: currentTimeMs });
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: session.asOf,
    freshness: contextFreshness(session),
    data: toProductContext(session),
    sourceRefs: session.sourceRefs.map((source) => toProductSourceReference(source)),
    warnings: session.warnings,
  });
}

async function sendDemoPositions(
  response: ServerResponse,
  execution: ExecutionService,
  now: () => Date,
): Promise<void> {
  const result = await execution.getDemoPositions();
  const freshness =
    result.status === 'verified'
      ? localFreshness(result.checkedAt, 'authenticated BITGET_DEMO account query completed')
      : unavailableFreshness(result.warnings[0] ?? 'BITGET_DEMO account is unavailable');
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: result.checkedAt,
    freshness,
    data: result,
    sourceRefs: [],
    warnings: result.warnings,
  });
  void now;
}

async function sendManualPosition(
  response: ServerResponse,
  request: IncomingMessage,
  execution: ExecutionService,
  now: () => Date,
): Promise<void> {
  const payload = await parseRequestBody(response, request, now);
  if (payload === null) return;
  const parsed = ManualPositionRequestSchema.safeParse(payload);
  if (!parsed.success) {
    sendError(response, now(), 'INVALID_REQUEST', formatZodError(parsed.error), 400);
    return;
  }
  const position = await execution.createManualPosition({
    providerSymbol: parsed.data.symbol,
    quantity: parsed.data.quantity,
    ...(parsed.data.availableQuantity === undefined
      ? {}
      : { availableQuantity: parsed.data.availableQuantity }),
    ...(parsed.data.lockedQuantity === undefined
      ? {}
      : { lockedQuantity: parsed.data.lockedQuantity }),
  });
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: position.asOf,
    freshness: localFreshness(position.asOf, 'manual position was created locally'),
    data: { position },
    sourceRefs: [],
    warnings: ['Manual positions are simulated and cannot submit a Demo order.'],
  });
}

async function sendExecutionIntent(
  response: ServerResponse,
  request: IncomingMessage,
  execution: ExecutionService,
  now: () => Date,
): Promise<void> {
  const payload = await parseRequestBody(response, request, now);
  if (payload === null) return;
  const parsed = ExecutionIntentRequestSchema.safeParse(payload);
  if (!parsed.success) {
    sendError(response, now(), 'INVALID_REQUEST', formatZodError(parsed.error), 400);
    return;
  }
  const created = await execution.createIntent({
    positionId: parsed.data.positionId,
    providerSymbol: parsed.data.symbol,
    orderType: parsed.data.orderType,
    requestedQuantity: parsed.data.requestedQuantity,
    ...(parsed.data.limitPrice === undefined ? {} : { limitPrice: parsed.data.limitPrice }),
    ...(parsed.data.maximumAcceptableSlippageBps === undefined
      ? {}
      : { maximumAcceptableSlippageBps: parsed.data.maximumAcceptableSlippageBps }),
  });
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: created.intent.createdAt,
    freshness: created.intent.simulation.freshness,
    data: created,
    sourceRefs: [
      toSourceReference(
        created.intent.bookSource,
        created.intent.providerSymbol,
        created.intent.bookSnapshotId,
      ),
    ],
    warnings: executionWarnings(created.intent.simulation),
  });
}

async function sendExecutionIntentView(
  response: ServerResponse,
  execution: ExecutionService,
  now: () => Date,
  intentId: string,
): Promise<void> {
  const intent = await execution.getIntent(intentId);
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: intent.createdAt,
    freshness: intent.simulation.freshness,
    data: { intent },
    sourceRefs: [
      toSourceReference(intent.bookSource, intent.providerSymbol, intent.bookSnapshotId),
    ],
    warnings: executionWarnings(intent.simulation),
  });
  void now;
}

async function sendExecutionConfirmation(
  response: ServerResponse,
  request: IncomingMessage,
  execution: ExecutionService,
  now: () => Date,
  intentId: string,
): Promise<void> {
  const payload = await parseRequestBody(response, request, now);
  if (payload === null) return;
  const parsed = ExecutionConfirmationRequestSchema.safeParse(payload);
  if (!parsed.success) {
    sendError(response, now(), 'INVALID_REQUEST', formatZodError(parsed.error), 400);
    return;
  }
  const result = await execution.confirmIntent(intentId, parsed.data.confirmationToken);
  const freshness =
    result.status === 'refresh_required'
      ? result.simulation.freshness
      : orderFreshness(result.order.provider?.receivedAt ?? null, now());
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: result.status === 'refresh_required' ? result.intent.createdAt : result.order.updatedAt,
    freshness,
    data: result,
    sourceRefs: [
      toSourceReference(
        result.intent.bookSource,
        result.intent.providerSymbol,
        result.intent.bookSnapshotId,
      ),
    ],
    warnings:
      result.status === 'refresh_required'
        ? executionWarnings(result.simulation)
        : [
            'BITGET_DEMO provider acknowledgement is not a fill; order state is reconciled separately.',
          ],
  });
}

async function sendExecutionOrderView(
  response: ServerResponse,
  execution: ExecutionService,
  now: () => Date,
  orderId: string,
): Promise<void> {
  const result = await execution.getOrder(orderId);
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: result.order.updatedAt,
    freshness: orderFreshness(result.order.provider?.receivedAt ?? null, now()),
    data: result,
    sourceRefs:
      result.intent === null
        ? []
        : [
            toSourceReference(
              result.intent.bookSource,
              result.intent.providerSymbol,
              result.intent.bookSnapshotId,
            ),
          ],
    warnings: ['Order state is provider-reconciled.'],
  });
}

async function sendExecutionOrderCancellation(
  response: ServerResponse,
  execution: ExecutionService,
  now: () => Date,
  orderId: string,
): Promise<void> {
  const result = await execution.cancelOrder(orderId);
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: result.order.updatedAt,
    freshness: orderFreshness(result.order.provider?.receivedAt ?? null, now()),
    data: result,
    sourceRefs:
      result.intent === null
        ? []
        : [
            toSourceReference(
              result.intent.bookSource,
              result.intent.providerSymbol,
              result.intent.bookSnapshotId,
            ),
          ],
    warnings:
      result.order.status === 'canceled'
        ? []
        : ['Cancellation was requested but the final provider state is not yet verified.'],
  });
}

async function sendInstrumentEvents(
  response: ServerResponse,
  options: ApiServerOptions,
  now: () => Date,
  symbol: string,
): Promise<void> {
  const store = options.eventStore ?? options.replayStore;
  if (store === undefined) {
    const checkedAt = now().toISOString();
    const eventContext = deriveUnifiedEventContext({
      providerSymbol: symbol,
      events: [],
      analyses: [],
      contextAsOf: checkedAt,
      markets: null,
      calendar: null,
      eventSourceAvailable: false,
    });
    sendEnvelope(response, {
      mode: 'LIVE',
      asOf: checkedAt,
      freshness: unavailableFreshness('event storage is not configured'),
      data: {
        events: [],
        analyses: [],
        eventContext: toProductEventContext(eventContext),
        sources: [],
      },
      sourceRefs: [],
      warnings: ['No persisted event source is configured.'],
    });
    return;
  }
  const events = await store.listSourceEvents(symbol);
  const analyses = await store.listEventAnalyses();
  let markets: Awaited<ReturnType<PublicMarketDataProvider['getMarketStates']>>['data'] | null =
    null;
  let calendar: Awaited<ReturnType<PublicMarketDataProvider['getMarketCalendar']>>['data'] | null =
    null;
  try {
    markets = (await options.marketData.getMarketStates()).data;
  } catch (error) {
    void error;
  }
  try {
    calendar = (await options.marketData.getMarketCalendar()).data;
  } catch (error) {
    void error;
  }
  const asOf = now();
  const eventContext = deriveUnifiedEventContext({
    providerSymbol: symbol,
    events,
    analyses,
    contextAsOf: asOf.toISOString(),
    markets,
    calendar,
  });
  const latestAnalysisByEvent = new Map<string, (typeof analyses)[number]>();
  for (const analysis of analyses) latestAnalysisByEvent.set(analysis.eventId, analysis);
  const productEvents = events.map((event) =>
    toProductEvent(event, latestAnalysisByEvent.get(event.eventId) ?? null),
  );
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: asOf.toISOString(),
    freshness: unavailableFreshness(
      'event records use source availability and analysis timestamps',
    ),
    data: {
      events: productEvents,
      analyses: analyses.map((analysis) => toProductEventAnalysis(analysis)),
      eventContext: toProductEventContext(eventContext),
      sources: productEvents.map((event) => event.source),
    },
    sourceRefs: [],
    warnings: eventContext.reasons,
  });
}

async function sendEvent(
  response: ServerResponse,
  options: ApiServerOptions,
  now: () => Date,
  eventId: string,
): Promise<void> {
  const store = options.eventStore ?? options.replayStore;
  if (store === undefined) {
    sendError(response, now(), 'EVENT_NOT_FOUND', `event ${eventId} was not found`, 404);
    return;
  }
  const event = await store.getSourceEvent(eventId);
  if (event === null) {
    sendError(response, now(), 'EVENT_NOT_FOUND', `event ${eventId} was not found`, 404);
    return;
  }
  const analyses = await store.listEventAnalyses(eventId);
  const latestAnalysis = analyses.at(-1) ?? null;
  const productEvent = toProductEvent(event, latestAnalysis);
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: event.sourceAvailableAt,
    freshness: unavailableFreshness(
      'event freshness is represented by sourceAvailableAt and retrievedAt',
    ),
    data: {
      event: productEvent,
      analysis: latestAnalysis === null ? null : toProductEventAnalysis(latestAnalysis),
      latestAnalysis: latestAnalysis === null ? null : toProductEventAnalysis(latestAnalysis),
      sources: [productEvent.source],
    },
    sourceRefs: [],
    warnings: latestAnalysis === null ? ['Analysis is pending for this source event.'] : [],
  });
}

async function sendEventAnalysis(
  response: ServerResponse,
  options: ApiServerOptions,
  now: () => Date,
  eventId: string,
): Promise<void> {
  const store = options.eventStore ?? options.replayStore;
  if (store === undefined) {
    sendError(response, now(), 'EVENT_NOT_FOUND', `event ${eventId} was not found`, 404);
    return;
  }
  const event = await store.getSourceEvent(eventId);
  if (event === null) {
    sendError(response, now(), 'EVENT_NOT_FOUND', `event ${eventId} was not found`, 404);
    return;
  }
  const analyses = await store.listEventAnalyses(eventId);
  const analysis = analyses.at(-1) ?? null;
  const productEvent = toProductEvent(event, analysis);
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: analysis?.processedAt ?? event.retrievedAt,
    freshness: unavailableFreshness(
      'analysis processing time is distinct from source availability',
    ),
    data: {
      event: productEvent,
      analysis: analysis === null ? null : toProductEventAnalysis(analysis),
      status: analysis?.status ?? 'pending',
      sources: [productEvent.source],
    },
    sourceRefs: [],
    warnings: analysis === null ? ['Analysis is pending for this source event.'] : [],
  });
}

async function sendOrderBook(
  response: ServerResponse,
  options: ApiServerOptions,
  snapshots: MarketSnapshotStore,
  now: () => Date,
  symbol: string,
): Promise<void> {
  const orderBook = await options.marketData.getOrderBook(symbol);
  const snapshot = snapshots.saveOrderBook(orderBook.data);
  const metrics = calculateMarketMetrics(
    snapshot,
    now(),
    resolveMarketQualityConfig(options.qualityConfig),
  );
  const freshness = freshnessFromSource(orderBook.source, now());
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: orderBook.source.providerTimestamp ?? orderBook.source.receivedAt,
    freshness,
    data: { snapshot, metrics },
    sourceRefs: [toSourceReference(orderBook.source, symbol, snapshot.snapshotId)],
    warnings: freshnessWarnings(freshness),
  });
}

async function sendSimulation(
  response: ServerResponse,
  request: IncomingMessage,
  options: ApiServerOptions,
  snapshots: MarketSnapshotStore,
  now: () => Date,
): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(request)) as unknown;
  } catch {
    sendError(response, now(), 'INVALID_REQUEST', 'request body must be valid JSON', 400);
    return;
  }
  const parsed = ExecutionSimulationRequestSchema.safeParse(payload);
  if (!parsed.success) {
    sendError(response, now(), 'INVALID_REQUEST', formatZodError(parsed.error), 400);
    return;
  }
  const input: ExecutionSimulationRequest = parsed.data;
  if (!isPositiveDecimal(input.requestedQuantity)) {
    sendError(
      response,
      now(),
      'simulation_invalid_quantity',
      'quantity must be a positive decimal string',
      400,
    );
    return;
  }
  let snapshot = input.snapshotId === undefined ? null : snapshots.getOrderBook(input.snapshotId);
  let currentPrice: string | null = null;
  let orderBookSource: SourceMetadata | null = null;
  let tickerSource: SourceMetadata | null = null;
  if (input.snapshotId !== undefined && snapshot === null) {
    sendError(response, now(), 'SNAPSHOT_NOT_FOUND', 'snapshot ID was not found', 404);
    return;
  }
  if (snapshot !== null && snapshot.providerSymbol !== input.symbol) {
    sendError(
      response,
      now(),
      'INVALID_REQUEST',
      'snapshot symbol does not match requested symbol',
      400,
    );
    return;
  }
  if (snapshot === null) {
    try {
      const result = await options.marketData.getOrderBook(input.symbol);
      snapshot = snapshots.saveOrderBook(result.data);
      orderBookSource = result.source;
    } catch (error) {
      const mapped = mapProductMarketError(error, 'simulation_book_unavailable');
      sendError(response, now(), mapped.code, mapped.message, mapped.status);
      return;
    }
    const ticker = await safeProviderCall(() => options.marketData.getTicker(input.symbol));
    currentPrice = ticker?.data.lastPrice ?? null;
    tickerSource = ticker?.source ?? null;
  }
  if (snapshot === null) {
    sendError(
      response,
      now(),
      'simulation_book_unavailable',
      'order-book snapshot is unavailable',
      503,
    );
    return;
  }
  const simulation = simulateExit({
    providerSymbol: input.symbol,
    requestedQuantity: input.requestedQuantity,
    snapshot,
    ...(input.maximumAcceptableSlippageBps === undefined
      ? {}
      : { maximumAcceptableSlippageBps: input.maximumAcceptableSlippageBps }),
    now: now(),
    ...(options.qualityConfig === undefined ? {} : { config: options.qualityConfig }),
  });
  const freshness = simulation.freshness;
  const sources = [
    toProductSourceReference(snapshot.source),
    ...(tickerSource === null ? [] : [toProductSourceReference(tickerSource)]),
  ];
  const data = toProductSimulation({ simulation, currentPrice, sources });
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: data.bookAsOf ?? data.receivedAt,
    freshness,
    data,
    sourceRefs: [
      toProductSourceReference(orderBookSource ?? snapshot.source),
      ...(tickerSource === null ? [] : [toProductSourceReference(tickerSource)]),
    ],
    warnings: [
      ...freshnessWarnings(freshness),
      ...(currentPrice === null
        ? ['Current ticker price was unavailable for this simulation.']
        : []),
    ],
  });
}

async function sendReplayList(
  response: ServerResponse,
  replayEngine: ReplayEngine | null,
  eventReplayEngine: EventReplayEngine | null,
  now: () => Date,
): Promise<void> {
  if (replayEngine === null && eventReplayEngine === null) {
    sendError(
      response,
      now(),
      'replay_unavailable',
      'replay storage is not configured',
      503,
      [],
      'REPLAY',
    );
    return;
  }
  const marketCases = replayEngine === null ? [] : await replayEngine.listCases();
  const eventCases = eventReplayEngine === null ? [] : await eventReplayEngine.listCases();
  const cases = curateReplayCases([...marketCases, ...eventCases]);
  const summaries = cases.map((replayCase) => toProductReplaySummary(replayCase));
  const latest = summaries.at(-1);
  const asOf = latest?.asOf ?? '1970-01-01T00:00:00.000Z';
  const freshness =
    summaries.length > 0
      ? {
          state: 'fresh' as const,
          reason: 'replay case metadata is available',
          ageMs: 0,
          clockSkewMs: 0,
          timestampConflict: false,
          providerTimestamp: null,
          receivedAt: asOf,
        }
      : unavailableFreshness('no replay cases are available');
  sendEnvelope(response, {
    mode: 'REPLAY',
    asOf,
    freshness,
    data: {
      replays: summaries,
      executionCapabilities: EXECUTION_CAPABILITIES,
    },
    sourceRefs: cases.flatMap((replayCase) =>
      'sources' in replayCase.manifest
        ? replayCase.manifest.sources.map((source) => toProductSourceReference(source))
        : [],
    ),
    warnings: summaries.length === 0 ? ['No curated replay cases are available.'] : [],
  });
}

async function sendReplayCase(
  response: ServerResponse,
  replayEngine: ReplayEngine | null,
  eventReplayEngine: EventReplayEngine | null,
  now: () => Date,
  caseId: string,
): Promise<void> {
  if (replayEngine === null && eventReplayEngine === null) {
    sendError(
      response,
      now(),
      'replay_unavailable',
      'replay storage is not configured',
      503,
      [],
      'REPLAY',
    );
    return;
  }
  const replayCase = replayEngine === null ? null : await replayEngine.getCase(caseId);
  const eventReplayCase =
    replayCase === null && eventReplayEngine !== null
      ? await eventReplayEngine
          .listCases()
          .then((cases) => cases.find((item) => item.manifest.caseId === caseId) ?? null)
      : null;
  if (replayCase === null && eventReplayCase === null) {
    sendError(
      response,
      now(),
      'replay_not_found',
      `replay case ${caseId} was not found`,
      404,
      [],
      'REPLAY',
    );
    return;
  }
  const selectedCase = replayCase ?? eventReplayCase;
  if (selectedCase === null) {
    sendError(
      response,
      now(),
      'replay_not_found',
      `replay case ${caseId} was not found`,
      404,
      [],
      'REPLAY',
    );
    return;
  }
  const orderBookSource =
    'sources' in selectedCase.manifest ? findOrderBookSource(selectedCase.manifest) : undefined;
  const freshness = orderBookSource
    ? freshnessFromSource(
        {
          provider: orderBookSource.provider,
          sourceId: orderBookSource.sourceId,
          sourceType: orderBookSource.sourceType,
          endpoint: orderBookSource.endpoint,
          providerTimestamp: orderBookSource.providerTimestamp,
          receivedAt: orderBookSource.receivedAt,
          rawResponseHash: orderBookSource.rawResponseHash,
          httpStatus: 200,
        },
        new Date(selectedCase.manifest.replayAsOf),
      )
    : localFreshness(selectedCase.manifest.replayAsOf, 'replay case metadata is immutable');
  const detail = toProductReplayDetail(
    selectedCase,
    replayCase === null
      ? ['This event-only replay has no captured market or order-book snapshot.']
      : [
          'Replay uses immutable captured provider responses and makes no external provider calls.',
          'Any simulation is an observed-book estimate, not a guaranteed fill.',
        ],
  );
  sendEnvelope(response, {
    mode: 'REPLAY',
    asOf: selectedCase.manifest.replayAsOf,
    freshness,
    data: {
      ...detail,
      manifest: { manifestHash: selectedCase.manifest.manifestHash },
    },
    sourceRefs:
      'sources' in selectedCase.manifest
        ? selectedCase.manifest.sources.map((source) => toProductSourceReference(source))
        : [],
    warnings: freshnessWarnings(freshness),
  });
}

async function sendReplayContext(
  response: ServerResponse,
  replayEngine: ReplayEngine | null,
  eventReplayEngine: EventReplayEngine | null,
  now: () => Date,
  caseId: string,
): Promise<void> {
  let context: AfterMrktContext | null = null;
  if (eventReplayEngine !== null) {
    try {
      context = await eventReplayEngine.context(caseId);
    } catch (error) {
      if (!(error instanceof ReplayError) || error.code !== 'replay_case_not_found') throw error;
    }
  }
  if (context === null && replayEngine !== null) {
    context = await replayEngine.context(caseId);
  }
  if (context === null) {
    sendError(
      response,
      now(),
      'replay_not_found',
      `replay case ${caseId} was not found`,
      404,
      [],
      'REPLAY',
    );
    return;
  }
  sendEnvelope(response, {
    mode: 'REPLAY',
    asOf: context.asOf,
    freshness: contextFreshness(context),
    data: toProductContext(context),
    sourceRefs: context.sourceRefs.map((source) => toProductSourceReference(source)),
    warnings: context.warnings,
  });
}

async function sendReplaySimulation(
  response: ServerResponse,
  request: IncomingMessage,
  replayEngine: ReplayEngine | null,
  now: () => Date,
  caseId: string,
): Promise<void> {
  if (replayEngine === null) {
    sendError(
      response,
      now(),
      'replay_unavailable',
      'replay storage is not configured',
      503,
      [],
      'REPLAY',
    );
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(request)) as unknown;
  } catch {
    sendError(
      response,
      now(),
      'INVALID_REQUEST',
      'request body must be valid JSON',
      400,
      [],
      'REPLAY',
    );
    return;
  }
  const parsed = ReplaySimulationRequestSchema.safeParse(payload);
  if (!parsed.success) {
    sendError(response, now(), 'INVALID_REQUEST', formatZodError(parsed.error), 400, [], 'REPLAY');
    return;
  }
  const result = await replayEngine.simulate(caseId, parsed.data);
  const simulation = toProductSimulation({
    simulation: result.data.simulation,
    currentPrice: result.data.marketSnapshot.lastPrice,
    sources: result.sourceRefs.map((source) => toProductSourceReference(source)),
  });
  sendEnvelope(response, {
    mode: 'REPLAY',
    asOf: result.asOf,
    freshness: result.freshness,
    data: {
      mode: result.mode,
      asOf: result.asOf,
      caseId: result.caseId,
      simulation,
      data: { simulation },
      warnings: result.warnings,
      limitations: result.limitations,
      sources: result.sourceRefs.map((source) => toProductSourceReference(source)),
    },
    sourceRefs: result.sourceRefs.map((source) => toProductSourceReference(source)),
    warnings: result.warnings,
  });
}

async function parseRequestBody(
  response: ServerResponse,
  request: IncomingMessage,
  now: () => Date,
): Promise<unknown | null> {
  try {
    return JSON.parse(await readBody(request)) as unknown;
  } catch {
    sendError(response, now(), 'INVALID_REQUEST', 'request body must be valid JSON', 400);
    return null;
  }
}

function sendEnvelope<T>(response: ServerResponse, envelope: ApiEnvelope<T>): void {
  sendJson(response, 200, envelope);
}

function sendError(
  response: ServerResponse,
  now: Date,
  code: ApiErrorCode,
  message: string,
  status: number,
  sourceRefs: SourceReference[] = [],
  mode: 'LIVE' | 'REPLAY' = 'LIVE',
  details: Record<string, string | number | boolean | null> = {},
): void {
  const envelope: ApiErrorEnvelope = {
    mode,
    asOf: now.toISOString(),
    freshness: {
      state: 'unavailable',
      reason: message,
      ageMs: null,
      clockSkewMs: null,
      timestampConflict: false,
      providerTimestamp: null,
      receivedAt: null,
    },
    data: null,
    sourceRefs,
    warnings: [message],
    error: { code, message, ...(Object.keys(details).length === 0 ? {} : { details }) },
  };
  sendJson(response, status, envelope);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(body)}\n`);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function toSourceReference(
  source: SourceMetadata | ReplaySourceReference,
  providerSymbol: string | null,
  snapshotId: string | null,
): SourceReference {
  const replaySource = isReplaySource(source) ? source : null;
  return {
    provider: source.provider,
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    providerSymbol: replaySource?.providerSymbol ?? providerSymbol,
    snapshotId: replaySource?.snapshotId ?? snapshotId,
    endpoint: source.endpoint,
    rawResponseHash: source.rawResponseHash,
    providerTimestamp: source.providerTimestamp,
    receivedAt: source.receivedAt,
  };
}

function isReplaySource(
  source: SourceMetadata | ReplaySourceReference,
): source is ReplaySourceReference {
  return 'snapshotId' in source;
}

function freshnessWarnings(freshness: ReturnType<typeof freshnessFromSource>): string[] {
  return freshness.state === 'fresh'
    ? []
    : [`Market data is ${freshness.state}: ${freshness.reason}`];
}

function contextFreshness(context: AfterMrktContext) {
  return context.liquidityContext.metrics?.freshness ?? context.market.freshness;
}

function localFreshness(receivedAt: string, reason: string) {
  return {
    state: 'fresh' as const,
    reason,
    ageMs: 0,
    clockSkewMs: 0,
    timestampConflict: false,
    providerTimestamp: receivedAt,
    receivedAt,
  };
}

function orderFreshness(receivedAt: string | null, now: Date) {
  if (receivedAt === null)
    return unavailableFreshness('provider order state has no receipt timestamp');
  const receivedMs = Date.parse(receivedAt);
  if (!Number.isFinite(receivedMs))
    return unavailableFreshness('provider order receipt timestamp is invalid');
  const ageMs = Math.max(0, now.getTime() - receivedMs);
  return {
    state: ageMs <= DEFAULT_FRESHNESS_WINDOW_MS ? ('fresh' as const) : ('stale' as const),
    reason: 'provider order state was queried by clientOid',
    ageMs,
    clockSkewMs: null,
    timestampConflict: false,
    providerTimestamp: null,
    receivedAt,
  };
}

function executionWarnings(simulation: {
  condition: { label: string; reasons: unknown[] };
}): string[] {
  return simulation.condition.label === 'execution-normal'
    ? []
    : [
        `Execution condition is ${simulation.condition.label}. Review the deterministic reasons before confirming.`,
      ];
}

const DEFAULT_FRESHNESS_WINDOW_MS = 30_000;

async function safeProviderCall<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    void error;
    return null;
  }
}

function unavailableFreshness(reason: string) {
  return {
    state: 'unavailable' as const,
    reason,
    ageMs: null,
    clockSkewMs: null,
    timestampConflict: false,
    providerTimestamp: null,
    receivedAt: null,
  };
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

async function safeStoreCall<T extends unknown[]>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    void error;
    return [] as unknown as T;
  }
}

function compareInformationalDecimal(left: string | null, right: string | null): number {
  return decimalOrZero(right).comparedTo(decimalOrZero(left));
}

function decimalOrZero(value: string | null): Decimal {
  if (value === null) return new Decimal(0);
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

function isPositiveDecimal(value: string): boolean {
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() && parsed.gt(0);
  } catch {
    return false;
  }
}

function mapProductMarketError(
  error: unknown,
  fallback: 'market_data_unavailable' | 'simulation_book_unavailable',
): { code: ApiErrorCode; message: string; status: number } {
  const category = classifyThrownError(error);
  if (category === 'instrument_missing') {
    return { code: 'instrument_not_found', message: 'instrument was not found', status: 404 };
  }
  if (category === 'rate_limited') {
    return { code: fallback, message: 'market data rate limit reached', status: 429 };
  }
  return {
    code: fallback,
    message:
      fallback === 'simulation_book_unavailable'
        ? 'order-book data is unavailable for this simulation'
        : 'market data is unavailable',
    status: 503,
  };
}

function curateReplayCases(
  cases: Array<ReplayCase | EventReplayCase>,
): Array<ReplayCase | EventReplayCase> {
  const byCaseId = new Map<string, ReplayCase | EventReplayCase>();
  for (const replayCase of cases) {
    const existing = byCaseId.get(replayCase.manifest.caseId);
    if (existing === undefined || 'marketSnapshotId' in replayCase.manifest) {
      byCaseId.set(replayCase.manifest.caseId, replayCase);
    }
  }
  const ordered = [...byCaseId.values()].sort((left, right) =>
    left.manifest.replayAsOf.localeCompare(right.manifest.replayAsOf),
  );
  const selected: Array<ReplayCase | EventReplayCase> = [];
  const selectedKinds = new Set<string>();
  for (const replayCase of ordered) {
    const summary = toProductReplaySummary(replayCase);
    const key = `${summary.symbol}:${summary.hasEvent}:${summary.hasOrderBook}`;
    if (selectedKinds.has(key)) continue;
    selectedKinds.add(key);
    selected.push(replayCase);
    if (selected.length === 4) return selected;
  }
  return selected;
}

function findOrderBookSource(
  manifest: Extract<ReplayCase['manifest'], { sources: ReplaySourceReference[] }>,
): ReplaySourceReference | undefined {
  return manifest.sources.find((source) => source.snapshotId === manifest.orderBookSnapshotId);
}

function mapError(error: unknown): {
  code: ApiErrorCode;
  message: string;
  status: number;
  details?: Record<string, string | number | boolean | null>;
} {
  if (error instanceof ExecutionError) {
    return {
      code: error.code,
      message: error.message,
      status: executionErrorStatus(error.code),
      ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
    };
  }
  if (error instanceof ReplayError) {
    if (error.code === 'replay_case_not_found') {
      return { code: 'replay_not_found', message: 'replay case was not found', status: 404 };
    }
    if (error.code === 'replay_snapshot_not_found') {
      return {
        code: 'replay_unavailable',
        message: 'replay evidence is incomplete',
        status: 422,
      };
    }
    return { code: 'replay_unavailable', message: 'replay manifest is invalid', status: 422 };
  }
  const status = classifyThrownError(error);
  switch (status) {
    case 'authentication_invalid':
      return {
        code: 'market_data_unavailable',
        message: 'market data authentication is unavailable',
        status: 503,
      };
    case 'rate_limited':
      return {
        code: 'market_data_unavailable',
        message: 'market data rate limit reached',
        status: 429,
      };
    case 'malformed_provider_data':
      return {
        code: 'market_data_unavailable',
        message: 'market data response could not be normalized',
        status: 502,
      };
    case 'instrument_missing':
      return { code: 'instrument_not_found', message: 'instrument was not found', status: 404 };
    case 'provider_rejected':
    case 'whitelist_denied':
      return {
        code: 'market_data_unavailable',
        message: 'market data request was rejected',
        status: 502,
      };
    case 'request_timeout':
    case 'environment_unreachable':
      return {
        code: 'market_data_unavailable',
        message: 'market data provider is unavailable',
        status: 503,
      };
    default:
      return {
        code: error instanceof ProbeError ? 'market_data_unavailable' : 'INTERNAL_ERROR',
        message:
          error instanceof ProbeError ? 'market data request failed' : 'internal server error',
        status: 500,
      };
  }
}

function executionErrorStatus(code: ExecutionError['code']): number {
  if (
    code === 'POSITION_NOT_FOUND' ||
    code === 'INSTRUMENT_NOT_FOUND' ||
    code === 'INTENT_NOT_FOUND' ||
    code === 'ORDER_NOT_FOUND'
  ) {
    return 404;
  }
  if (code === 'DEMO_UNAVAILABLE' || code === 'DEMO_UNSUPPORTED' || code === 'PROVIDER_UNAVAILABLE')
    return 503;
  if (code === 'PROVIDER_REJECTED') return 502;
  if (
    code === 'REFRESH_REQUIRED' ||
    code === 'CONFIRMATION_REUSED' ||
    code === 'CONFIRMATION_EXPIRED' ||
    code === 'CONFIRMATION_INVALID' ||
    code === 'INTENT_EXPIRED' ||
    code === 'OPEN_SELL_ORDER' ||
    code === 'ORDER_NOT_CANCELABLE'
  ) {
    return 409;
  }
  return 400;
}

function createDefaultSnapshotStore(): InMemorySnapshotStore {
  return new InMemorySnapshotStore();
}
