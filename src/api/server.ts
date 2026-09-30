import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { classifyThrownError, ProbeError } from '../lib/errors.js';
import type { PublicMarketDataProvider } from '../adapters/bitget/public-market-data.js';
import {
  ExecutionSimulationRequestSchema,
  ReplaySimulationRequestSchema,
  type ApiEnvelope,
  type ApiErrorCode,
  type ApiErrorEnvelope,
  type ExecutionSimulationRequest,
} from '../contracts/api.js';
import { freshnessFromSource } from '../domain/freshness.js';
import { ReplayEngine, ReplayError } from '../domain/replay.js';
import {
  calculateMarketMetrics,
  resolveMarketQualityConfig,
  simulateExit,
  type MarketQualityConfig,
} from '../domain/market-quality.js';
import { InMemorySnapshotStore, type MarketSnapshotStore } from '../domain/snapshots.js';
import type { SourceMetadata, SourceReference } from '../domain/types.js';
import type { CaptureStore, ReplaySourceReference } from '../persistence/types.js';

export type ApiServerOptions = {
  marketData: PublicMarketDataProvider;
  snapshots?: MarketSnapshotStore;
  replayStore?: CaptureStore;
  replayEngine?: ReplayEngine;
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
  const now = options.now ?? (() => new Date());

  return createServer((request, response) => {
    void handleRequest(request, response, options, snapshots, replayEngine, now).catch(
      (error: unknown) => {
        const mapped = mapError(error);
        const mode = (request.url ?? '').startsWith('/api/replays') ? 'REPLAY' : 'LIVE';
        sendError(response, now(), mapped.code, mapped.message, mapped.status, [], mode);
      },
    );
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ApiServerOptions,
  snapshots: MarketSnapshotStore,
  replayEngine: ReplayEngine | null,
  now: () => Date,
): Promise<void> {
  const method = request.method ?? 'GET';
  const parsedUrl = new URL(request.url ?? '/', 'http://localhost');
  const parts = parsedUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'replays') {
    await sendReplayList(response, replayEngine, now);
    return;
  }

  if (method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'replays') {
    await sendReplayCase(response, replayEngine, now, parts[2] ?? '');
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
  const [ticker, orderBook] = await Promise.all([
    options.marketData.getTicker(symbol),
    options.marketData.getOrderBook(symbol),
  ]);
  let marketState: Awaited<ReturnType<PublicMarketDataProvider['getMarketStates']>> | null = null;
  try {
    marketState = await options.marketData.getMarketStates();
  } catch (error) {
    void error;
  }
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
    data: {
      instrument,
      ticker: ticker.data,
      snapshot,
      metrics,
      marketState: marketState?.data ?? null,
    },
    sourceRefs: [
      toSourceReference(universe.source, symbol, null),
      toSourceReference(ticker.source, symbol, null),
      toSourceReference(orderBook.source, symbol, snapshot.snapshotId),
      ...(marketState === null ? [] : [toSourceReference(marketState.source, null, null)]),
    ],
    warnings: [
      ...freshnessWarnings(freshness),
      ...(marketState === null ? ['Market state was unavailable for this context response.'] : []),
    ],
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
    error: { code, message },
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
} {
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

function createDefaultSnapshotStore(): InMemorySnapshotStore {
  return new InMemorySnapshotStore();
}
