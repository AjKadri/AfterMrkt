import type { EventAnalysis, SourceEvent } from '../contracts/events.js';
import type {
  AfterMrktContext,
  ContextEventReference,
  UnifiedEventContext,
} from '../domain/market-context.js';
import type {
  ExecutionCondition,
  ExitSimulation,
  MarketMetrics,
} from '../domain/market-quality.js';
import type {
  Freshness,
  NormalizedRealityInstrument,
  SourceMetadata,
  SourceReference,
} from '../domain/types.js';
import type { EventReplayCase, ReplayCase, ReplaySourceReference } from '../persistence/types.js';

export const EXECUTION_CAPABILITIES = Object.freeze({
  simulation: 'available',
  bitgetDemoReality: 'unsupported_or_inaccessible',
  liveExecution: 'disabled',
} as const);

export type ExecutionCapabilities = typeof EXECUTION_CAPABILITIES;

export type ProductSectionState =
  'available' | 'unavailable' | 'pending' | 'stale' | 'not_applicable';

export type ProductSourceReference = {
  sourceId: string;
  sourceType: string;
  label: string;
  url: string;
  observedAt: string;
};

export type ProductEventAnalysis = {
  kind: 'ai-interpretation';
  status: EventAnalysis['status'];
  analysisId: string;
  eventType: string;
  materiality: EventAnalysis['materiality'];
  facts: EventAnalysis['facts'];
  uncertainties: string[];
  evidence: EventAnalysis['evidenceSpans'];
  model: string;
  providerReportedModel: string | null;
  processedAt: string;
  confidence: number | null;
  sourceBound: boolean;
};

export type ProductEvent = {
  kind: 'source-fact';
  eventId: string;
  providerSymbol: string;
  nativeTicker: string;
  title: string;
  excerpt: string;
  category: string;
  publishedAt: string | null;
  eventOccurredAt: string | null;
  sourceAvailableAt: string;
  retrievedAt: string;
  source: ProductSourceReference;
  analysis: ProductEventAnalysis | null;
};

export type ProductEventContext = {
  state: ProductSectionState;
  status: UnifiedEventContext['status'];
  label: UnifiedEventContext['status'];
  checkedAt: string;
  checkedProviders: string[];
  qualifyingEventCount: number;
  analyzedEventCount: number;
  pendingEventCount: number;
  unavailableAnalysisCount: number;
  events: Array<ContextEventReference & { kind: 'source-fact'; source: ProductSourceReference }>;
  laterAnalysisIds: string[];
  laterAnalyses: UnifiedEventContext['laterAnalyses'];
  reasons: string[];
};

export type ProductInstrument = {
  providerSymbol: string;
  baseCoin: string | null;
  quoteCoin: string | null;
  nativeTicker: string | null;
  companyName: string | null;
  mappingStatus: NormalizedRealityInstrument['mappingStatus'];
  reality: {
    isReality: boolean;
    isRwa: boolean | null;
  };
  symbolType: string | null;
  status: string | null;
  precision: {
    quantity: string | null;
    price: string | null;
    quote: string | null;
  };
  minimums: {
    quantity: string | null;
    amount: string | null;
  };
  maximumMarketOrderAmount: string | null;
  maximumOrderQuantity: string | null;
  tradingPeriod: string[] | string | null;
  weekendTradable: string | null;
  providerTimestamp: string | null;
  receivedAt: string;
};

export type ProductInstrumentListItem = {
  providerSymbol: string;
  nativeTicker: string | null;
  companyName: string | null;
  status: string | null;
  lastPrice: string | null;
  bid: string | null;
  ask: string | null;
  spreadBps: string | null;
  sessionStatus: 'open' | 'closed' | 'unavailable';
  moveSinceNativeClosePercent: string | null;
  eventContextStatus: UnifiedEventContext['status'] | 'unavailable';
  liquidityStatus: ExecutionCondition['label'] | 'unavailable';
  freshness: Freshness;
  warnings: string[];
};

export type ProductContext = {
  mode: 'LIVE' | 'REPLAY';
  asOf: string;
  instrument: ProductInstrument | null;
  session: AfterMrktContext['session'] & { state: ProductSectionState };
  closeReference: AfterMrktContext['reference'] & { state: ProductSectionState };
  moveSinceClose: AfterMrktContext['move'] & { state: ProductSectionState };
  /** @deprecated Use closeReference. Kept for clients built against the foundation API. */
  reference: AfterMrktContext['reference'];
  /** @deprecated Use moveSinceClose. Kept for clients built against the foundation API. */
  move: AfterMrktContext['move'];
  market: AfterMrktContext['market'] & { state: ProductSectionState };
  liquidity: {
    state: ProductSectionState;
    condition: ExecutionCondition;
    metrics: MarketMetrics | null;
    positionStatus: AfterMrktContext['liquidityContext']['positionStatus'];
    realityRawDepth: AfterMrktContext['liquidityContext']['realityRawDepth'];
    reason: string;
    source: ProductSourceReference | null;
  };
  /** @deprecated Use liquidity. Kept for clients built against the foundation API. */
  liquidityContext: AfterMrktContext['liquidityContext'];
  eventContext: ProductEventContext;
  nativePriceConfirmation: AfterMrktContext['nativePriceConfirmation'];
  explanation: {
    headline: string;
    summaryPoints: string[];
    warnings: string[];
  };
  limitations: string[];
  warnings: string[];
  sources: ProductSourceReference[];
  executionCapabilities: ExecutionCapabilities;
};

export type ProductSimulation = {
  symbol: string;
  currentPrice: string | null;
  requestedQuantity: string;
  filledQuantity: string;
  unfilledQuantity: string;
  bestBid: string | null;
  midpoint: string | null;
  estimatedVwap: string | null;
  estimatedProceeds: string;
  absoluteSpread: string | null;
  spreadBps: string | null;
  slippageBps: string | null;
  slippageVsBestBidBps: string | null;
  levelsConsumed: number;
  executableWithin25Bps: string;
  executableWithin50Bps: string;
  executableWithin100Bps: string;
  fillRatioWithin25Bps: string;
  fillRatioWithin50Bps: string;
  fillRatioWithin100Bps: string;
  deepestConsumedPrice: string | null;
  condition: ExecutionCondition['label'];
  reasons: ExecutionCondition['reasons'];
  bookAsOf: string | null;
  receivedAt: string;
  freshness: Freshness;
  disclaimer: ExitSimulation['estimateDisclaimer'];
  estimateDisclaimer: ExitSimulation['estimateDisclaimer'];
  sources: ProductSourceReference[];
  executionCapabilities: ExecutionCapabilities;
};

export type ProductReplaySummary = {
  caseId: string;
  symbol: string;
  nativeTicker: string | null;
  asOf: string;
  title: string;
  hasEvent: boolean;
  hasMarketSnapshot: boolean;
  hasOrderBook: boolean;
  simulationAvailable: boolean;
};

export type ProductReplayDetail = ProductReplaySummary & {
  mode: 'REPLAY';
  manifestHash: string;
  limitations: string[];
  sources: ProductSourceReference[];
};

export function toProductInstrument(
  instrument: NormalizedRealityInstrument | null,
): ProductInstrument | null {
  if (instrument === null) return null;
  return {
    providerSymbol: instrument.providerSymbol,
    baseCoin: instrument.baseCoin,
    quoteCoin: instrument.quoteCoin,
    nativeTicker: instrument.nativeTicker,
    companyName: instrument.nativeName,
    mappingStatus: instrument.mappingStatus,
    reality: { isReality: instrument.isReality, isRwa: instrument.isRwa },
    symbolType: instrument.symbolType,
    status: instrument.status,
    precision: {
      quantity: instrument.quantityPrecision,
      price: instrument.pricePrecision,
      quote: instrument.quotePrecision,
    },
    minimums: { quantity: instrument.minOrderQty, amount: instrument.minOrderAmount },
    maximumMarketOrderAmount: instrument.maxMarketOrderAmount,
    maximumOrderQuantity: instrument.maxOrderQty,
    tradingPeriod: instrument.tradingPeriod,
    weekendTradable: instrument.weekendTradable,
    providerTimestamp: instrument.providerTimestamp,
    receivedAt: instrument.receivedAt,
  };
}

export function toProductContext(context: AfterMrktContext): ProductContext {
  const eventContext = toProductEventContext(context.eventContext);
  const sources = uniqueSources([
    ...context.sourceRefs.map((source) => toProductSourceReference(source)),
    ...eventContext.events.map((event) => event.source),
  ]);
  return {
    mode: context.mode,
    asOf: context.asOf,
    instrument: toProductInstrument(context.instrument),
    session: { ...context.session, state: sessionState(context.session.status) },
    closeReference: {
      ...context.reference,
      state: context.reference.status === 'available' ? 'available' : 'unavailable',
    },
    moveSinceClose: {
      ...context.move,
      state: context.move.status === 'available' ? 'available' : 'unavailable',
    },
    reference: context.reference,
    move: context.move,
    market: {
      ...context.market,
      state: sectionState(context.market.status === 'available', context.market.freshness),
    },
    liquidity: {
      state: sectionState(
        context.liquidityContext.status === 'available',
        context.market.freshness,
      ),
      condition: context.liquidityContext.condition,
      metrics: context.liquidityContext.metrics,
      positionStatus: context.liquidityContext.positionStatus,
      realityRawDepth: context.liquidityContext.realityRawDepth,
      reason: context.liquidityContext.reason,
      source:
        context.liquidityContext.sourceRef === null
          ? null
          : toProductSourceReference(context.liquidityContext.sourceRef),
    },
    liquidityContext: context.liquidityContext,
    eventContext,
    nativePriceConfirmation: context.nativePriceConfirmation,
    explanation: {
      headline: context.explanation.headline,
      summaryPoints: context.explanation.points,
      warnings: context.explanation.warnings,
    },
    limitations: context.limitations,
    warnings: context.warnings,
    sources,
    executionCapabilities: EXECUTION_CAPABILITIES,
  };
}

export function toProductInstrumentListItem(input: {
  instrument: NormalizedRealityInstrument;
  lastPrice: string | null;
  bid: string | null;
  ask: string | null;
  spreadBps: string | null;
  sessionStatus: 'open' | 'closed' | 'unavailable';
  moveSinceNativeClosePercent: string | null;
  eventContextStatus: UnifiedEventContext['status'] | 'unavailable';
  liquidityStatus: ExecutionCondition['label'] | 'unavailable';
  freshness: Freshness;
  warnings: string[];
}): ProductInstrumentListItem {
  return {
    providerSymbol: input.instrument.providerSymbol,
    nativeTicker: input.instrument.nativeTicker,
    companyName: input.instrument.nativeName,
    status: input.instrument.status,
    lastPrice: input.lastPrice,
    bid: input.bid,
    ask: input.ask,
    spreadBps: input.spreadBps,
    sessionStatus: input.sessionStatus,
    moveSinceNativeClosePercent: input.moveSinceNativeClosePercent,
    eventContextStatus: input.eventContextStatus,
    liquidityStatus: input.liquidityStatus,
    freshness: input.freshness,
    warnings: input.warnings,
  };
}

export function toProductSimulation(input: {
  simulation: ExitSimulation;
  currentPrice: string | null;
  sources: ProductSourceReference[];
}): ProductSimulation {
  const simulation = input.simulation;
  return {
    symbol: simulation.providerSymbol,
    currentPrice: input.currentPrice,
    requestedQuantity: simulation.requestedQuantity,
    filledQuantity: simulation.filledQuantity,
    unfilledQuantity: simulation.unfilledQuantity,
    bestBid: simulation.bestBid,
    midpoint: simulation.midpoint,
    estimatedVwap: simulation.estimatedVWAP,
    estimatedProceeds: simulation.totalExpectedProceeds,
    absoluteSpread: simulation.absoluteSpread,
    spreadBps: simulation.spreadBps,
    slippageBps: simulation.slippageVersusMidpointBps,
    slippageVsBestBidBps: simulation.slippageVersusBestBidBps,
    levelsConsumed: simulation.levelsConsumed,
    executableWithin25Bps: simulation.quantityExecutableWithin25Bps,
    executableWithin50Bps: simulation.quantityExecutableWithin50Bps,
    executableWithin100Bps: simulation.quantityExecutableWithin100Bps,
    fillRatioWithin25Bps: simulation.positionPercentageWithin25Bps,
    fillRatioWithin50Bps: simulation.positionPercentageWithin50Bps,
    fillRatioWithin100Bps: simulation.positionPercentageWithin100Bps,
    deepestConsumedPrice: simulation.deepestConsumedPrice,
    condition: simulation.condition.label,
    reasons: simulation.condition.reasons,
    bookAsOf:
      simulation.snapshotTimestamp === null
        ? null
        : normalizeObservedAt(simulation.snapshotTimestamp),
    receivedAt: simulation.receivedTimestamp,
    freshness: simulation.freshness,
    disclaimer: simulation.estimateDisclaimer,
    estimateDisclaimer: simulation.estimateDisclaimer,
    sources: uniqueSources(input.sources),
    executionCapabilities: EXECUTION_CAPABILITIES,
  };
}

export function toProductEvent(event: SourceEvent, analysis: EventAnalysis | null): ProductEvent {
  return {
    kind: 'source-fact',
    eventId: event.eventId,
    providerSymbol: event.providerSymbol,
    nativeTicker: event.nativeTicker,
    title: event.title,
    excerpt: event.excerpt,
    category: event.category,
    publishedAt: event.publishedAt,
    eventOccurredAt: event.eventOccurredAt,
    sourceAvailableAt: event.sourceAvailableAt,
    retrievedAt: event.retrievedAt,
    source: toEventSourceReference(event),
    analysis: analysis === null ? null : toProductEventAnalysis(analysis),
  };
}

export function toProductEventAnalysis(analysis: EventAnalysis): ProductEventAnalysis {
  return {
    kind: 'ai-interpretation',
    status: analysis.status,
    analysisId: analysis.analysisId,
    eventType: analysis.eventType,
    materiality: analysis.materiality,
    facts: analysis.facts,
    uncertainties: analysis.uncertainties,
    evidence: analysis.evidenceSpans,
    model: analysis.model,
    providerReportedModel: analysis.providerReportedModel,
    processedAt: analysis.processedAt,
    confidence: analysis.confidence,
    sourceBound: analysis.sourceBound,
  };
}

export function toProductEventContext(context: UnifiedEventContext): ProductEventContext {
  return {
    state:
      context.status === 'analysis-pending'
        ? 'pending'
        : context.status === 'analysis-unavailable' ||
            context.status === 'insufficient-event-evidence'
          ? 'unavailable'
          : 'available',
    status: context.status,
    label: context.status,
    checkedAt: context.checkedAt,
    checkedProviders: context.checkedProviders,
    qualifyingEventCount: context.qualifyingEventCount,
    analyzedEventCount: context.analyzedEventCount,
    pendingEventCount: context.pendingEventCount,
    unavailableAnalysisCount: context.unavailableAnalysisCount,
    events: context.events.map((event) => ({
      ...event,
      kind: 'source-fact' as const,
      source: {
        sourceId: event.eventId,
        sourceType: 'event-evidence',
        label: `SEC EDGAR: ${event.title}`,
        url: event.sourceUrl,
        observedAt: event.sourceAvailableAt,
      },
    })),
    laterAnalysisIds: context.laterAnalysisIds,
    laterAnalyses: context.laterAnalyses,
    reasons: context.reasons,
  };
}

export function toProductReplaySummary(
  replayCase: ReplayCase | EventReplayCase,
): ProductReplaySummary {
  const manifest = replayCase.manifest;
  const hasMarketSnapshot = 'marketSnapshotId' in manifest;
  const hasOrderBook = 'orderBookSnapshotId' in manifest;
  const hasEvent = (manifest.eventIds?.length ?? 0) > 0;
  const ticker = manifest.nativeTicker ?? manifest.providerSymbol;
  return {
    caseId: manifest.caseId,
    symbol: manifest.providerSymbol,
    nativeTicker: manifest.nativeTicker,
    asOf: manifest.replayAsOf,
    title: hasEvent
      ? `${ticker} market and event evidence replay`
      : `${ticker} market and liquidity replay`,
    hasEvent,
    hasMarketSnapshot,
    hasOrderBook,
    simulationAvailable: hasMarketSnapshot && hasOrderBook,
  };
}

export function toProductReplayDetail(
  replayCase: ReplayCase | EventReplayCase,
  limitations: string[] = [],
): ProductReplayDetail {
  const summary = toProductReplaySummary(replayCase);
  return {
    ...summary,
    mode: 'REPLAY',
    manifestHash: replayCase.manifest.manifestHash,
    limitations,
    sources:
      'sources' in replayCase.manifest
        ? uniqueSources(
            replayCase.manifest.sources.map((source) => toProductSourceReference(source)),
          )
        : [],
  };
}

export function toProductSourceReference(
  source: SourceMetadata | SourceReference | ReplaySourceReference,
): ProductSourceReference {
  const sourceId = source.sourceId;
  const rawObservedAt = source.providerTimestamp ?? source.receivedAt;
  return {
    sourceId,
    sourceType: productSourceType(sourceId, source.sourceType),
    label: productSourceLabel(sourceId, source.sourceType),
    url: source.endpoint,
    observedAt: normalizeObservedAt(rawObservedAt),
  };
}

function toEventSourceReference(event: SourceEvent): ProductSourceReference {
  return {
    sourceId: event.eventId,
    sourceType: 'event-evidence',
    label: `SEC EDGAR: ${event.title}`,
    url: event.sourceUrl,
    observedAt: event.sourceAvailableAt,
  };
}

function productSourceType(sourceId: string, sourceType: string): string {
  if (sourceType === 'replay') return 'replay-manifest';
  if (sourceId.includes('calendar')) return 'market-calendar';
  if (sourceId.includes('states')) return 'market-state';
  if (sourceId.includes('stock_info') || sourceId.includes('instruments')) return 'instrument';
  if (
    sourceId.includes('orderbook') ||
    sourceId.includes('ticker') ||
    sourceId.includes('candle')
  ) {
    return 'market-data';
  }
  return sourceType;
}

function productSourceLabel(sourceId: string, sourceType: string): string {
  if (sourceId.includes('orderbook')) return 'Bitget Reality order book';
  if (sourceId.includes('ticker')) return 'Bitget Reality ticker';
  if (sourceId.includes('calendar')) return 'Bitget market calendar';
  if (sourceId.includes('states')) return 'Bitget market state';
  if (sourceId.includes('stock_info')) return 'Bitget Reality stock mapping';
  if (sourceId.includes('instruments')) return 'Bitget Reality instrument universe';
  if (sourceId.includes('candle')) return 'Bitget Reality candles';
  if (sourceType === 'sec-edgar') return 'SEC EDGAR filing';
  if (sourceType === 'replay') return 'AfterMrkt replay manifest';
  return sourceId;
}

function normalizeObservedAt(value: string): string {
  if (!/^\d+$/.test(value)) return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  const milliseconds = value.length <= 10 ? numeric * 1_000 : numeric;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : value;
}

function sessionState(status: AfterMrktContext['session']['status']): ProductSectionState {
  return status === 'unavailable' ? 'unavailable' : 'available';
}

function sectionState(available: boolean, freshness: Freshness): ProductSectionState {
  if (!available || freshness.state === 'unavailable') return 'unavailable';
  if (freshness.state === 'stale') return 'stale';
  return 'available';
}

function uniqueSources(sources: ProductSourceReference[]): ProductSourceReference[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.sourceId}:${source.url}:${source.observedAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
