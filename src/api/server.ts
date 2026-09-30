import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
import { deriveEventContext, uncheckedEventContext } from '../domain/event-context.js';
import { deriveSessionContext } from '../domain/event-window.js';
import { buildAfterMrktContext, type AfterMrktContext } from '../domain/market-context.js';
import { EventReplayEngine, ReplayEngine, ReplayError } from '../domain/replay.js';
import {
  calculateMarketMetrics,
  resolveMarketQualityConfig,
  simulateExit,
  type MarketQualityConfig,
} from '../domain/market-quality.js';
import { InMemorySnapshotStore, type MarketSnapshotStore } from '../domain/snapshots.js';
import type { SourceMetadata, SourceReference } from '../domain/types.js';
import type { CaptureStore, ReplaySourceReference } from '../persistence/types.js';
import { ExecutionError, ExecutionService } from '../domain/execution.js';
import type { ExecutionStore } from '../domain/execution-store.js';
import { InMemoryExecutionStore } from '../persistence/execution-store.js';

export type ApiServerOptions = {
  marketData: PublicMarketDataProvider;
  snapshots?: MarketSnapshotStore;
  replayStore?: CaptureStore;
  replayEngine?: ReplayEngine;
  eventReplayEngine?: EventReplayEngine;
  eventStore?: CaptureStore;
  demo?: BitgetDemoRealityAdapter;
  executionStore?: ExecutionStore;
  executionService?: ExecutionService;
  now?: () => Date;
  qualityConfig?: Partial<MarketQualityConfig>;
};

const MAX_BODY_BYTES = 128 * 1024;

export function createApiServer(options: ApiServerOptions): Server {
  const snapshots = options.snapshots ?? createDefaultSnapshotStore();
  const replayEngine =
    options.replayEngine ??
    (options.replayStore === undefined
      ? null
      : new ReplayEngine(options.replayStore, options.qualityConfig));
  const eventReplayEngine =
    options.eventReplayEngine ??
    (options.replayStore === undefined ? null : new EventReplayEngine(options.replayStore));
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
    await sendReplayList(response, replayEngine, now);
    return;
  }

  if (method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'replays') {
    await sendReplayCase(response, replayEngine, now, parts[2] ?? '');
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
    const result = await options.marketData.discoverRealityInstruments();
    sendEnvelope(response, {
      mode: 'LIVE',
      asOf: result.source.providerTimestamp ?? result.source.receivedAt,
      freshness: freshnessFromSource(result.source, now()),
      data: result.data,
      sourceRefs: [toSourceReference(result.source, null, null)],
      warnings: freshnessWarnings(freshnessFromSource(result.source, now())),
    });
    return;
  }

  if (
    method === 'GET' &&
    parts.length === 4 &&
    parts[0] === 'api' &&
    parts[1] === 'instruments' &&
    parts[3] === 'context'
  ) {
    await sendContext(response, options, snapshots, now, parts[2] ?? '');
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

async function sendContext(
  response: ServerResponse,
  options: ApiServerOptions,
  snapshots: MarketSnapshotStore,
  now: () => Date,
  symbol: string,
): Promise<void> {
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
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: session.asOf,
    freshness: contextFreshness(session),
    data: session,
    sourceRefs: session.sourceRefs,
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
    sendEnvelope(response, {
      mode: 'LIVE',
      asOf: checkedAt,
      freshness: unavailableFreshness('event storage is not configured'),
      data: { events: [], analyses: [], eventContext: uncheckedEventContext(checkedAt) },
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
  const eventContext = deriveEventContext({
    events,
    analyses,
    contextAsOf: asOf.toISOString(),
    markets,
    calendar,
    checkedAt: asOf.toISOString(),
  });
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: asOf.toISOString(),
    freshness: unavailableFreshness(
      'event records use source availability and analysis timestamps',
    ),
    data: { events, analyses, eventContext },
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
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: event.sourceAvailableAt,
    freshness: unavailableFreshness(
      'event freshness is represented by sourceAvailableAt and retrievedAt',
    ),
    data: { event, latestAnalysis: analyses.at(-1) ?? null },
    sourceRefs: [],
    warnings: analyses.length === 0 ? ['Analysis is pending for this source event.'] : [],
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
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: analysis?.processedAt ?? event.retrievedAt,
    freshness: unavailableFreshness(
      'analysis processing time is distinct from source availability',
    ),
    data: { event, analysis, status: analysis?.status ?? 'pending' },
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
  const snapshot = snapshots.getOrderBook(input.snapshotId);
  if (!snapshot) {
    sendError(response, now(), 'SNAPSHOT_NOT_FOUND', 'snapshot ID was not found', 404);
    return;
  }
  if (snapshot.providerSymbol !== input.symbol) {
    sendError(
      response,
      now(),
      'INVALID_REQUEST',
      'snapshot symbol does not match requested symbol',
      400,
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
  sendEnvelope(response, {
    mode: 'LIVE',
    asOf: simulation.snapshotTimestamp ?? simulation.receivedTimestamp,
    freshness,
    data: simulation,
    sourceRefs: [toSourceReference(snapshot.source, input.symbol, snapshot.snapshotId)],
    warnings: freshnessWarnings(freshness),
  });
}

async function sendReplayList(
  response: ServerResponse,
  replayEngine: ReplayEngine | null,
  now: () => Date,
): Promise<void> {
  if (replayEngine === null) {
    sendError(
      response,
      now(),
      'REPLAY_UNAVAILABLE',
      'replay storage is not configured',
      503,
      [],
      'REPLAY',
    );
    return;
  }
  const cases = await replayEngine.listCases();
  const latest = cases.at(-1);
  const asOf = latest?.manifest.replayAsOf ?? '1970-01-01T00:00:00.000Z';
  const freshness = latest
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
    data: cases,
    sourceRefs: cases.flatMap((replayCase) =>
      replayCase.manifest.sources.map((source) => toSourceReference(source, null, null)),
    ),
    warnings: cases.length === 0 ? ['No captured replay cases are available.'] : [],
  });
}

async function sendReplayCase(
  response: ServerResponse,
  replayEngine: ReplayEngine | null,
  now: () => Date,
  caseId: string,
): Promise<void> {
  if (replayEngine === null) {
    sendError(
      response,
      now(),
      'REPLAY_UNAVAILABLE',
      'replay storage is not configured',
      503,
      [],
      'REPLAY',
    );
    return;
  }
  const replayCase = await replayEngine.getCase(caseId);
  if (replayCase === null) {
    sendError(
      response,
      now(),
      'REPLAY_CASE_NOT_FOUND',
      `replay case ${caseId} was not found`,
      404,
      [],
      'REPLAY',
    );
    return;
  }
  const orderBookSource = replayCase.manifest.sources.find(
    (source) => source.snapshotId === replayCase.manifest.orderBookSnapshotId,
  );
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
        new Date(replayCase.manifest.replayAsOf),
      )
    : unavailableFreshness('replay order-book source is missing');
  sendEnvelope(response, {
    mode: 'REPLAY',
    asOf: replayCase.manifest.replayAsOf,
    freshness,
    data: replayCase,
    sourceRefs: replayCase.manifest.sources.map((source) => toSourceReference(source, null, null)),
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
      'REPLAY_CASE_NOT_FOUND',
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
    data: context,
    sourceRefs: context.sourceRefs,
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
      'REPLAY_UNAVAILABLE',
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
  sendEnvelope(response, {
    mode: 'REPLAY',
    asOf: result.asOf,
    freshness: result.freshness,
    data: result,
    sourceRefs: result.sourceRefs,
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

function safeMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
      return { code: 'REPLAY_CASE_NOT_FOUND', message: error.message, status: 404 };
    }
    if (error.code === 'replay_snapshot_not_found') {
      return { code: 'REPLAY_SNAPSHOT_NOT_FOUND', message: error.message, status: 422 };
    }
    return { code: 'REPLAY_MANIFEST_INVALID', message: error.message, status: 422 };
  }
  const status = classifyThrownError(error);
  const message = safeMessage(error);
  switch (status) {
    case 'authentication_invalid':
      return { code: 'PROVIDER_AUTHENTICATION_INVALID', message, status: 502 };
    case 'rate_limited':
      return { code: 'PROVIDER_RATE_LIMITED', message, status: 429 };
    case 'malformed_provider_data':
      return { code: 'PROVIDER_MALFORMED', message, status: 502 };
    case 'instrument_missing':
      return { code: 'INSTRUMENT_NOT_FOUND', message, status: 404 };
    case 'provider_rejected':
    case 'whitelist_denied':
      return { code: 'PROVIDER_REJECTED', message, status: 502 };
    case 'request_timeout':
    case 'environment_unreachable':
      return { code: 'PROVIDER_UNAVAILABLE', message, status: 503 };
    default:
      return {
        code: error instanceof ProbeError ? 'INTERNAL_ERROR' : 'INTERNAL_ERROR',
        message,
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
