import Decimal from 'decimal.js';
import type { BitgetCalendar, BitgetMarket } from '../contracts/bitget.js';
import type { EventAnalysis, SourceEvent } from '../contracts/events.js';
import { freshnessFromSource } from './freshness.js';
import {
  deriveSessionContext,
  evaluatePostCloseWindow,
  type SessionContextResult,
} from './event-window.js';
import {
  calculateMarketMetrics,
  resolveMarketQualityConfig,
  type ExecutionCondition,
  type MarketMetrics,
  type MarketQualityConfig,
} from './market-quality.js';
import type {
  Freshness,
  NormalizedCandle,
  NormalizedRealityInstrument,
  NormalizedSuspensionResumption,
  NormalizedTicker,
  OrderBookSnapshot,
  SourceMetadata,
  SourceReference,
} from './types.js';

const FINANCIAL_PRECISION = 100;
Decimal.set({ precision: FINANCIAL_PRECISION, rounding: Decimal.ROUND_HALF_UP });

export const DEFAULT_CLOSE_REFERENCE_MAX_GAP_MS = 15 * 60 * 1000;

export type ContextEventStatus =
  | 'material-event-found'
  | 'possible-material-event-found'
  | 'checked-no-qualifying-material-event'
  | 'analysis-pending'
  | 'analysis-unavailable'
  | 'insufficient-event-evidence';

export type ContextInstrument = NormalizedRealityInstrument | null;

export type ContextSession = SessionContextResult & {
  asOf: string;
  timeSincePreviousCloseMs: number | null;
  timeUntilNextOpenMs: number | null;
  suspension: NormalizedSuspensionResumption | null;
  suspensionStatus: 'recorded' | 'not-available' | 'unavailable';
};

export type RTokenCloseReference = {
  status: 'available' | 'unavailable';
  referenceType: 'rtoken_at_native_regular_close';
  providerSymbol: string;
  price: string | null;
  candleInterval: string;
  candleOpenTime: string | null;
  observationTimestamp: string | null;
  regularClose: string | null;
  distanceFromRegularCloseMs: number | null;
  maxReferenceDistanceMs: number;
  providerTimestamp: string | null;
  sourceRef: SourceReference | null;
  reason: string;
};

export type RTokenMove = {
  status: 'available' | 'unavailable';
  rTokenAtNativeCloseReference: string | null;
  currentRTokenPrice: string | null;
  absoluteMove: string | null;
  percentageMove: string | null;
  basisPointMove: string | null;
  elapsedTimeMs: number | null;
  reason: string;
};

export type CurrentMarketContext = {
  status: 'available' | 'unavailable';
  lastPrice: string | null;
  bidPrice: string | null;
  askPrice: string | null;
  midpoint: string | null;
  absoluteSpread: string | null;
  spreadBps: string | null;
  baseVolume: string | null;
  volume24h: string | null;
  quoteVolume: string | null;
  usdtVolume: string | null;
  turnover24h: string | null;
  platformTurnover24h: string | null;
  turnoverSemantics: {
    status: 'unresolved';
    reason: string;
  };
  providerTimestamp: string | null;
  receivedAt: string | null;
  freshness: Freshness;
  sourceRef: SourceReference | null;
  reason: string;
};

export type LiquidityContext = {
  status: 'available' | 'unavailable';
  condition: ExecutionCondition;
  metrics: MarketMetrics | null;
  positionStatus: 'position_required';
  realityRawDepth: {
    status: 'unavailable';
    reason: string;
  };
  sourceRef: SourceReference | null;
  reason: string;
};

export type ContextEventReference = {
  eventId: string;
  externalId: string | null;
  title: string;
  sourceUrl: string;
  sourceAvailableAt: string;
  analysisId: string | null;
  analysisStatus: EventAnalysis['status'] | 'pending';
  processedAt: string | null;
  model: string | null;
  providerReportedModel: string | null;
  materiality: EventAnalysis['materiality'] | null;
  facts: Array<{
    id: string;
    statement: string;
    evidenceSpanIds: string[];
    supportingQuote?: string;
  }>;
  laterAnalysisIds: string[];
  laterAnalyses: Array<{
    analysisId: string;
    eventId: string;
    status: EventAnalysis['status'];
    processedAt: string;
    model: string;
  }>;
};

export type UnifiedEventContext = {
  status: ContextEventStatus;
  checkedAt: string;
  checkedProviders: string[];
  qualifyingEventCount: number;
  analyzedEventCount: number;
  pendingEventCount: number;
  unavailableAnalysisCount: number;
  events: ContextEventReference[];
  laterAnalysisIds: string[];
  laterAnalyses: ContextEventReference['laterAnalyses'];
  reasons: string[];
};

export type NativePriceConfirmation = {
  status: 'unavailable';
  reason: 'native_quote_provider_unreachable';
  checkedProvider: 'bitget-equities-mcp';
};

export type DeterministicExplanation = {
  headline: string;
  points: string[];
  warnings: string[];
};

export type AfterMrktContext = {
  mode: 'LIVE' | 'REPLAY';
  asOf: string;
  instrument: ContextInstrument;
  session: ContextSession;
  reference: RTokenCloseReference;
  move: RTokenMove;
  market: CurrentMarketContext;
  liquidityContext: LiquidityContext;
  eventContext: UnifiedEventContext;
  nativePriceConfirmation: NativePriceConfirmation;
  explanation: DeterministicExplanation;
  limitations: string[];
  warnings: string[];
  sourceRefs: SourceReference[];
};

export type CandleContextInput = {
  data: NormalizedCandle[];
  interval: string;
  source: SourceMetadata;
  sourceRef: SourceReference | null;
};

export type BuildMarketContextInput = {
  mode: 'LIVE' | 'REPLAY';
  asOf: string;
  providerSymbol: string;
  instrument: ContextInstrument;
  ticker: NormalizedTicker | null;
  orderBook: OrderBookSnapshot | null;
  markets: BitgetMarket[] | null;
  calendar: BitgetCalendar | null;
  suspension: NormalizedSuspensionResumption | null;
  suspensionStatus: ContextSession['suspensionStatus'];
  candles: CandleContextInput | null;
  events: SourceEvent[];
  analyses: EventAnalysis[];
  eventSourceAvailable?: boolean;
  sourceRefs: SourceReference[];
  qualityConfig?: Partial<MarketQualityConfig>;
  maxReferenceDistanceMs?: number;
};

export function buildAfterMrktContext(input: BuildMarketContextInput): AfterMrktContext {
  const asOfDate = new Date(input.asOf);
  const asOf = Number.isFinite(asOfDate.getTime()) ? asOfDate.toISOString() : input.asOf;
  const sessionBase = deriveSessionContext({
    asOf,
    markets: input.markets,
    calendar: input.calendar,
  });
  const asOfMs = Date.parse(asOf);
  const previousCloseMs = Date.parse(sessionBase.previousRegularSessionClose ?? '');
  const nextOpenMs = Date.parse(sessionBase.nextRegularSessionOpen ?? '');
  const session: ContextSession = {
    ...sessionBase,
    asOf,
    timeSincePreviousCloseMs:
      Number.isFinite(asOfMs) && Number.isFinite(previousCloseMs) ? asOfMs - previousCloseMs : null,
    timeUntilNextOpenMs:
      Number.isFinite(asOfMs) && Number.isFinite(nextOpenMs) ? nextOpenMs - asOfMs : null,
    suspension: input.suspension,
    suspensionStatus: input.suspensionStatus,
  };
  const maxReferenceDistanceMs = input.maxReferenceDistanceMs ?? DEFAULT_CLOSE_REFERENCE_MAX_GAP_MS;
  const reference = selectRTokenCloseReference({
    providerSymbol: input.providerSymbol,
    candles: input.candles,
    regularClose: session.previousRegularSessionClose,
    contextAsOf: asOf,
    maxReferenceDistanceMs,
  });
  const move = calculateRTokenMove({
    currentPrice: input.ticker?.lastPrice ?? null,
    reference,
    contextAsOf: asOf,
  });
  const qualityConfig = resolveMarketQualityConfig(input.qualityConfig);
  const metrics =
    input.orderBook === null
      ? null
      : calculateMarketMetrics(input.orderBook, asOfDate, qualityConfig);
  const market = buildCurrentMarket(input.ticker, metrics, input.orderBook, asOf);
  const liquidityContext = buildLiquidityContext(input.orderBook, metrics, input.sourceRefs);
  const eventContext = deriveUnifiedEventContext({
    providerSymbol: input.providerSymbol,
    events: input.events,
    analyses: input.analyses,
    contextAsOf: asOf,
    markets: input.markets,
    calendar: input.calendar,
    ...(input.eventSourceAvailable === undefined
      ? {}
      : { eventSourceAvailable: input.eventSourceAvailable }),
  });
  const nativePriceConfirmation: NativePriceConfirmation = {
    status: 'unavailable',
    reason: 'native_quote_provider_unreachable',
    checkedProvider: 'bitget-equities-mcp',
  };
  const limitations = buildLimitations({
    mode: input.mode,
    reference,
    market,
    liquidityContext,
    eventContext,
    nativePriceConfirmation,
    candles: input.candles,
  });
  const warnings = [
    ...buildWarnings(session, reference, move, market, liquidityContext, eventContext),
    ...(input.mode === 'REPLAY'
      ? ['Replay context uses immutable captured records and makes no provider calls.']
      : []),
  ];
  return {
    mode: input.mode,
    asOf,
    instrument: input.instrument,
    session,
    reference,
    move,
    market,
    liquidityContext,
    eventContext,
    nativePriceConfirmation,
    explanation: buildExplanation(
      input.providerSymbol,
      input.instrument,
      session,
      reference,
      move,
      market,
      liquidityContext,
      eventContext,
    ),
    limitations,
    warnings,
    sourceRefs: input.sourceRefs,
  };
}

export function selectRTokenCloseReference(input: {
  providerSymbol: string;
  candles: CandleContextInput | null;
  regularClose: string | null;
  contextAsOf: string;
  maxReferenceDistanceMs?: number;
}): RTokenCloseReference {
  const maxReferenceDistanceMs = input.maxReferenceDistanceMs ?? DEFAULT_CLOSE_REFERENCE_MAX_GAP_MS;
  const unavailable = (reason: string): RTokenCloseReference => ({
    status: 'unavailable',
    referenceType: 'rtoken_at_native_regular_close',
    providerSymbol: input.providerSymbol,
    price: null,
    candleInterval: input.candles?.interval ?? '1m',
    candleOpenTime: null,
    observationTimestamp: null,
    regularClose: input.regularClose,
    distanceFromRegularCloseMs: null,
    maxReferenceDistanceMs,
    providerTimestamp: input.candles?.source.providerTimestamp ?? null,
    sourceRef: input.candles?.sourceRef ?? null,
    reason,
  });
  if (input.candles === null) return unavailable('historical candle source was unavailable');
  const closeMs = Date.parse(input.regularClose ?? '');
  const contextMs = Date.parse(input.contextAsOf);
  if (!Number.isFinite(closeMs)) return unavailable('regular session close is unavailable');
  if (!Number.isFinite(contextMs)) return unavailable('context timestamp is invalid');
  const intervalMs = parseCandleIntervalMs(input.candles.interval);
  if (intervalMs === null) return unavailable('candle interval is unsupported');
  const candidates = input.candles.data
    .map((candle) => {
      const openMs = parseTimestamp(candle.openTime);
      const close = parsePositiveDecimal(candle.close);
      if (openMs === null || close === null) return null;
      const observationMs = openMs + intervalMs;
      if (observationMs > closeMs || observationMs > contextMs) return null;
      return { candle, openMs, observationMs, close };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => right.observationMs - left.observationMs);
  const selected = candidates[0];
  if (selected === undefined) {
    return unavailable('no valid candle was observed at or before the native regular close');
  }
  const distanceFromRegularCloseMs = closeMs - selected.observationMs;
  if (distanceFromRegularCloseMs > maxReferenceDistanceMs) {
    return unavailable(
      `nearest valid candle is ${distanceFromRegularCloseMs}ms before the native regular close`,
    );
  }
  return {
    status: 'available',
    referenceType: 'rtoken_at_native_regular_close',
    providerSymbol: input.providerSymbol,
    price: selected.close.toFixed(),
    candleInterval: input.candles.interval,
    candleOpenTime: new Date(selected.openMs).toISOString(),
    observationTimestamp: new Date(selected.observationMs).toISOString(),
    regularClose: input.regularClose,
    distanceFromRegularCloseMs,
    maxReferenceDistanceMs,
    providerTimestamp: input.candles.source.providerTimestamp,
    sourceRef: input.candles.sourceRef,
    reason: 'latest valid historical candle ended at or before the native regular close',
  };
}

export function calculateRTokenMove(input: {
  currentPrice: string | null;
  reference: RTokenCloseReference;
  contextAsOf: string;
}): RTokenMove {
  const unavailable = (reason: string): RTokenMove => ({
    status: 'unavailable',
    rTokenAtNativeCloseReference: input.reference.price,
    currentRTokenPrice: input.currentPrice,
    absoluteMove: null,
    percentageMove: null,
    basisPointMove: null,
    elapsedTimeMs: elapsedSince(input.reference.regularClose, input.contextAsOf),
    reason,
  });
  if (input.reference.status !== 'available' || input.reference.price === null) {
    return unavailable('rToken-at-native-close reference is unavailable');
  }
  const current = parsePositiveOrNegativeDecimal(input.currentPrice);
  const reference = parsePositiveDecimal(input.reference.price);
  if (current === null || reference === null || reference.isZero()) {
    return unavailable('current rToken price or close reference is invalid');
  }
  const absoluteMove = current.minus(reference);
  const ratio = absoluteMove.div(reference);
  return {
    status: 'available',
    rTokenAtNativeCloseReference: reference.toFixed(),
    currentRTokenPrice: current.toFixed(),
    absoluteMove: absoluteMove.toFixed(),
    percentageMove: ratio.times(100).toFixed(),
    basisPointMove: ratio.times(10_000).toFixed(),
    elapsedTimeMs: elapsedSince(input.reference.regularClose, input.contextAsOf),
    reason: 'current rToken price compared with the observed rToken candle at native close',
  };
}

export function deriveUnifiedEventContext(input: {
  providerSymbol: string;
  events: SourceEvent[];
  analyses: EventAnalysis[];
  contextAsOf: string;
  markets: BitgetMarket[] | null;
  calendar: BitgetCalendar | null;
  eventSourceAvailable?: boolean;
}): UnifiedEventContext {
  const checkedAt = input.contextAsOf;
  if (input.eventSourceAvailable === false) {
    return {
      status: 'insufficient-event-evidence',
      checkedAt,
      checkedProviders: ['SEC EDGAR'],
      qualifyingEventCount: 0,
      analyzedEventCount: 0,
      pendingEventCount: 0,
      unavailableAnalysisCount: 0,
      events: [],
      laterAnalysisIds: [],
      laterAnalyses: [],
      reasons: ['persisted SEC EDGAR source-event storage is unavailable for this context'],
    };
  }
  const uniqueEvents = deduplicateEvents(input.events).filter(
    (event) => event.providerSymbol === input.providerSymbol,
  );
  const windows = uniqueEvents.map((event) =>
    evaluatePostCloseWindow({
      event,
      contextAsOf: input.contextAsOf,
      markets: input.markets,
      calendar: input.calendar,
    }),
  );
  const qualifying = uniqueEvents.filter((_, index) => windows[index]?.status === 'qualifies');
  const analysesByEvent = new Map<string, EventAnalysis[]>();
  for (const analysis of input.analyses) {
    const group = analysesByEvent.get(analysis.eventId) ?? [];
    group.push(analysis);
    analysesByEvent.set(analysis.eventId, group);
  }
  const contextMs = Date.parse(input.contextAsOf);
  const references: ContextEventReference[] = qualifying.map((event) => {
    const all = (analysesByEvent.get(event.eventId) ?? []).sort((left, right) =>
      left.processedAt.localeCompare(right.processedAt),
    );
    const available = all.filter((analysis) => Date.parse(analysis.processedAt) <= contextMs);
    const latest = available.at(-1);
    const laterAnalyses = all
      .filter((analysis) => Date.parse(analysis.processedAt) > contextMs)
      .map((analysis) => ({
        analysisId: analysis.analysisId,
        eventId: analysis.eventId,
        status: analysis.status,
        processedAt: analysis.processedAt,
        model: analysis.model,
      }));
    return {
      eventId: event.eventId,
      externalId: event.externalId,
      title: event.title,
      sourceUrl: event.sourceUrl,
      sourceAvailableAt: event.sourceAvailableAt,
      analysisId: latest?.analysisId ?? null,
      analysisStatus: latest?.status ?? 'pending',
      processedAt: latest?.processedAt ?? null,
      model: latest?.model ?? null,
      providerReportedModel: latest?.providerReportedModel ?? null,
      materiality: latest?.materiality ?? null,
      facts:
        latest?.facts.map((fact) => ({
          id: fact.id,
          statement: fact.statement,
          evidenceSpanIds: fact.evidenceSpanIds,
          ...(fact.supportingQuote === undefined ? {} : { supportingQuote: fact.supportingQuote }),
        })) ?? [],
      laterAnalysisIds: laterAnalyses.map((analysis) => analysis.analysisId),
      laterAnalyses,
    };
  });
  const pending = references.filter((event) => event.analysisStatus === 'pending');
  const unavailable = references.filter(
    (event) => event.analysisStatus === 'unavailable' || event.analysisStatus === 'quarantined',
  );
  const validatedMaterial = references.some(
    (event) =>
      event.analysisStatus === 'validated' &&
      (event.materiality === 'material' || event.materiality === 'possibly_material'),
  );
  const validatedMaterialOnly = references.some(
    (event) => event.analysisStatus === 'validated' && event.materiality === 'material',
  );
  const insufficient = references.some(
    (event) =>
      event.analysisStatus === 'validated' && event.materiality === 'insufficient_evidence',
  );
  const windowUnavailable = windows.some((window) => window.status === 'time_window_unavailable');
  let status: ContextEventStatus;
  let reasons: string[];
  if (pending.length > 0) {
    status = 'analysis-pending';
    reasons = [
      'one or more qualifying SEC EDGAR source events have no analysis available by context time',
    ];
  } else if (validatedMaterialOnly) {
    status = 'material-event-found';
    reasons = ['a qualifying source event has validated, source-bound materiality evidence'];
  } else if (validatedMaterial) {
    status = 'possible-material-event-found';
    reasons = ['a qualifying source event has validated possible-materiality evidence'];
  } else if (unavailable.length > 0) {
    status = 'analysis-unavailable';
    reasons = ['a qualifying source event has unavailable or quarantined analysis'];
  } else if (insufficient || windowUnavailable) {
    status = 'insufficient-event-evidence';
    reasons = windowUnavailable
      ? ['post-close timing could not be determined from provider calendar data']
      : ['qualifying event analysis did not establish sufficient source-bound evidence'];
  } else {
    status = 'checked-no-qualifying-material-event';
    reasons = [
      'no qualifying SEC EDGAR source event was available in the checked post-close window',
    ];
  }
  return {
    status,
    checkedAt,
    checkedProviders: ['SEC EDGAR'],
    qualifyingEventCount: qualifying.length,
    analyzedEventCount: references.filter((event) => event.analysisId !== null).length,
    pendingEventCount: pending.length,
    unavailableAnalysisCount: unavailable.length,
    events: references,
    laterAnalysisIds: references.flatMap((event) => event.laterAnalysisIds),
    laterAnalyses: references.flatMap((event) => event.laterAnalyses),
    reasons,
  };
}

function buildCurrentMarket(
  ticker: NormalizedTicker | null,
  metrics: MarketMetrics | null,
  orderBook: OrderBookSnapshot | null,
  asOf: string,
): CurrentMarketContext {
  const unavailable = freshnessUnavailable('ticker was unavailable');
  if (ticker === null) {
    return {
      status: 'unavailable',
      lastPrice: null,
      bidPrice: null,
      askPrice: null,
      midpoint: metrics?.midpoint ?? null,
      absoluteSpread: metrics?.absoluteSpread ?? null,
      spreadBps: metrics?.spreadBps ?? null,
      baseVolume: null,
      volume24h: null,
      quoteVolume: null,
      usdtVolume: null,
      turnover24h: null,
      platformTurnover24h: null,
      turnoverSemantics: turnoverSemantics(),
      providerTimestamp: orderBook?.providerTimestamp ?? null,
      receivedAt: orderBook?.receivedAt ?? null,
      freshness: metrics?.freshness ?? unavailable,
      sourceRef:
        orderBook === null
          ? null
          : sourceReference(orderBook.source, orderBook.providerSymbol, orderBook.snapshotId),
      reason: `ticker was unavailable as of ${asOf}`,
    };
  }
  const tickerFreshness = freshnessFromSource(ticker.source, new Date(asOf));
  return {
    status: ticker.lastPrice === null ? 'unavailable' : 'available',
    lastPrice: ticker.lastPrice,
    bidPrice: metrics?.bestBid ?? ticker.bidPrice,
    askPrice: metrics?.bestAsk ?? ticker.askPrice,
    midpoint: metrics?.midpoint ?? null,
    absoluteSpread: metrics?.absoluteSpread ?? null,
    spreadBps: metrics?.spreadBps ?? null,
    baseVolume: ticker.baseVolume,
    volume24h: ticker.volume24h,
    quoteVolume: ticker.quoteVolume,
    usdtVolume: ticker.usdtVolume,
    turnover24h: ticker.turnover24h,
    platformTurnover24h: ticker.platformTurnover24h,
    turnoverSemantics: turnoverSemantics(),
    providerTimestamp: ticker.providerTimestamp,
    receivedAt: ticker.receivedAt,
    freshness: tickerFreshness,
    sourceRef: sourceReference(ticker.source, ticker.providerSymbol, null),
    reason:
      ticker.lastPrice === null
        ? 'ticker did not contain a valid last price'
        : 'current generic public ticker is available',
  };
}

function buildLiquidityContext(
  orderBook: OrderBookSnapshot | null,
  metrics: MarketMetrics | null,
  sourceRefs: SourceReference[],
): LiquidityContext {
  const sourceRef =
    sourceRefs.find(
      (reference) =>
        reference.snapshotId === orderBook?.snapshotId ||
        reference.sourceId === 'bitget_generic_spot_orderbook',
    ) ??
    (orderBook === null
      ? null
      : sourceReference(orderBook.source, orderBook.providerSymbol, orderBook.snapshotId));
  const unavailableCondition: ExecutionCondition = {
    label: 'execution-unavailable',
    reasons: [
      {
        metric: 'orderBook',
        value: 'unavailable',
        threshold: 'two-sided observed book',
        detail: 'no order-book snapshot was available for the context',
      },
    ],
  };
  if (orderBook === null || metrics === null) {
    return {
      status: 'unavailable',
      condition: unavailableCondition,
      metrics: null,
      positionStatus: 'position_required',
      realityRawDepth: realityRawDepthUnavailable(),
      sourceRef,
      reason: 'generic public order-book snapshot was unavailable',
    };
  }
  return {
    status: metrics.valid ? 'available' : 'unavailable',
    condition: metrics.condition,
    metrics,
    positionStatus: 'position_required',
    realityRawDepth: realityRawDepthUnavailable(),
    sourceRef,
    reason: metrics.valid
      ? 'generic public order-book depth is available; position size is required for execution simulation'
      : (metrics.condition.reasons[0]?.detail ?? 'order-book metrics are unavailable'),
  };
}

function buildExplanation(
  providerSymbol: string,
  instrument: ContextInstrument,
  session: ContextSession,
  reference: RTokenCloseReference,
  move: RTokenMove,
  market: CurrentMarketContext,
  liquidity: LiquidityContext,
  events: UnifiedEventContext,
): DeterministicExplanation {
  const ticker = instrument?.nativeTicker ?? providerSymbol;
  const headline =
    move.status === 'available' && move.percentageMove !== null
      ? `${ticker} rToken move since native close: ${signed(move.percentageMove)}%`
      : `${ticker} rToken context is incomplete for a close-to-current move`;
  const points = [
    `Session: ${session.status} (${session.calendarStatus}); previous regular close ${session.previousRegularSessionClose ?? 'unavailable'}.`,
    `Reference: ${reference.status}; ${reference.reason}.`,
    `Current market: ${market.status}; spread ${market.spreadBps ?? 'unavailable'} bps.`,
    `Liquidity: ${liquidity.condition.label}; ${liquidity.reason}.`,
    `Events: ${events.status}; ${events.reasons[0] ?? 'no event reason available'}.`,
  ];
  const warnings = [
    'This explanation is deterministic and does not predict price or infer fair value.',
    'Native-price confirmation is unavailable because the Bitget equities MCP is not reachable from this environment.',
  ];
  return { headline, points, warnings };
}

function buildWarnings(
  session: ContextSession,
  reference: RTokenCloseReference,
  move: RTokenMove,
  market: CurrentMarketContext,
  liquidity: LiquidityContext,
  events: UnifiedEventContext,
): string[] {
  const warnings: string[] = [];
  if (session.status === 'unavailable') warnings.push(`Session is unavailable: ${session.reason}`);
  if (reference.status === 'unavailable')
    warnings.push(`Close reference is unavailable: ${reference.reason}`);
  if (move.status === 'unavailable') warnings.push(`rToken move is unavailable: ${move.reason}`);
  if (market.freshness.state !== 'fresh') {
    warnings.push(`Ticker freshness is ${market.freshness.state}: ${market.freshness.reason}`);
  }
  if (liquidity.condition.label !== 'execution-normal') {
    warnings.push(`Execution condition is ${liquidity.condition.label}.`);
  }
  if (events.status === 'analysis-pending')
    warnings.push('One or more qualifying events still await persisted analysis.');
  if (events.laterAnalysisIds.length > 0) {
    warnings.push(
      'One or more validated analyses were processed after this context time and are excluded from the historical state.',
    );
  }
  return warnings;
}

function buildLimitations(input: {
  mode: 'LIVE' | 'REPLAY';
  reference: RTokenCloseReference;
  market: CurrentMarketContext;
  liquidityContext: LiquidityContext;
  eventContext: UnifiedEventContext;
  nativePriceConfirmation: NativePriceConfirmation;
  candles: CandleContextInput | null;
}): string[] {
  return [
    'The move is rToken price versus an observed rToken candle at the provider-defined native regular close. It is not a native equity return, fair-value estimate, or prediction.',
    'Native-price confirmation is unavailable until the official Bitget equities quote provider is reachable.',
    'Generic public order-book depth is used because the Reality-specific raw depth endpoint is unavailable without authenticated access.',
    'Turnover fields are preserved but their units and semantics remain unresolved and are not used for classification.',
    'Execution condition thresholds are provisional demo constants and are not statistically validated.',
    'Liquidity context is position-independent. A requested position size is required for exit simulation.',
    'Event context uses persisted SEC EDGAR source events and persisted Qwen analyses. The context engine never calls Qwen.',
    ...(input.reference.status === 'available' && input.candles !== null && input.mode === 'REPLAY'
      ? [
          'Historical candle data may have been retrieved after replayAsOf; only candle observations at or before the replay reference boundary are used.',
        ]
      : []),
    ...(input.market.status === 'unavailable' ? ['Current ticker data was unavailable.'] : []),
    ...(input.liquidityContext.status === 'unavailable'
      ? ['Current executable liquidity could not be established from the observed book.']
      : []),
    ...(input.eventContext.status === 'checked-no-qualifying-material-event'
      ? [
          'No qualifying source event was found in the checked provider window. This is not proof that no event occurred.',
        ]
      : []),
    input.nativePriceConfirmation.reason,
  ];
}

function deduplicateEvents(events: SourceEvent[]): SourceEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = event.externalId
      ? `${event.sourceType}:${event.externalId}`
      : `${event.sourceType}:${event.sourceUrl}:${event.rawContentHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseCandleIntervalMs(interval: string): number | null {
  const normalized = interval.trim().toUpperCase();
  const match = /^(\d+)(S|M|H|D|W)$/.exec(normalized);
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2];
  const multiplier =
    unit === 'S'
      ? 1_000
      : unit === 'M'
        ? 60_000
        : unit === 'H'
          ? 3_600_000
          : unit === 'D'
            ? 86_400_000
            : 604_800_000;
  const result = amount * multiplier;
  return Number.isSafeInteger(result) ? result : null;
}

function parseTimestamp(value: string): number | null {
  const numeric = /^\d+$/.test(value.trim()) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function parsePositiveDecimal(value: string): Decimal | null {
  if (value.trim() === '') return null;
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() && decimal.gt(0) ? decimal : null;
  } catch {
    return null;
  }
}

function parsePositiveOrNegativeDecimal(value: string | null): Decimal | null {
  if (value === null || value.trim() === '') return null;
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() && decimal.gt(0) ? decimal : null;
  } catch {
    return null;
  }
}

function elapsedSince(close: string | null, asOf: string): number | null {
  const closeMs = Date.parse(close ?? '');
  const asOfMs = Date.parse(asOf);
  return Number.isFinite(closeMs) && Number.isFinite(asOfMs) ? asOfMs - closeMs : null;
}

function sourceReference(
  source: SourceMetadata,
  providerSymbol: string | null,
  snapshotId: string | null,
): SourceReference {
  return {
    provider: source.provider,
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    providerSymbol,
    snapshotId,
    endpoint: source.endpoint,
    rawResponseHash: source.rawResponseHash,
    providerTimestamp: source.providerTimestamp,
    receivedAt: source.receivedAt,
  };
}

function freshnessUnavailable(reason: string): Freshness {
  return {
    state: 'unavailable',
    reason,
    ageMs: null,
    clockSkewMs: null,
    timestampConflict: false,
    providerTimestamp: null,
    receivedAt: null,
  };
}

function turnoverSemantics(): CurrentMarketContext['turnoverSemantics'] {
  return {
    status: 'unresolved',
    reason: 'Bitget turnover field units and semantics are not independently verified.',
  };
}

function realityRawDepthUnavailable(): LiquidityContext['realityRawDepth'] {
  return {
    status: 'unavailable',
    reason:
      'Reality-specific raw order-book depth requires authenticated access; generic public depth is the canonical MVP source.',
  };
}

function signed(value: string): string {
  const decimal = new Decimal(value);
  return decimal.gte(0) ? `+${decimal.toFixed()}` : decimal.toFixed();
}
