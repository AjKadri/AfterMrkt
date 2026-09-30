import { describe, expect, it } from 'vitest';
import type { EventAnalysis, SourceEvent } from '../src/contracts/events.js';
import {
  buildAfterMrktContext,
  deriveUnifiedEventContext,
  selectRTokenCloseReference,
} from '../src/domain/market-context.js';
import { createEventReplayCase, EventReplayEngine } from '../src/domain/replay.js';
import {
  deriveSessionContext,
  resolveNextRegularSessionOpen,
  resolvePreviousRegularSessionClose,
} from '../src/domain/event-window.js';
import type {
  NormalizedCandle,
  NormalizedOrderBook,
  NormalizedTicker,
  SourceMetadata,
} from '../src/domain/types.js';
import { sha256 } from '../src/lib/hash.js';
import { canonicalJson } from '../src/lib/canonical.js';
import { InMemoryCaptureStore } from '../src/persistence/store.js';

const MARKETS = [
  {
    market: 'US',
    stateList: [{ state: 'regular', startTime: '09:30:00', endTime: '16:00:00', timeZone: 'EST' }],
  },
];

const CALENDAR = {
  timeZone: 'EST',
  regularConfig: ['SATURDAY', 'SUNDAY'],
  specificConfig: [],
};

const SOURCE: SourceMetadata = {
  provider: 'bitget',
  sourceId: 'bitget_generic_spot_historical_candles',
  sourceType: 'generic-public',
  endpoint: 'https://example.test/market/history-candles',
  providerTimestamp: '2026-08-26T20:51:19.000Z',
  receivedAt: '2026-08-26T20:51:19.000Z',
  rawResponseHash: 'a'.repeat(64),
  httpStatus: 200,
};

describe('unified market context', () => {
  it('selects the candle ending exactly at native close and excludes post-close/future candles', () => {
    const result = selectRTokenCloseReference({
      providerSymbol: 'RNVDAUSDT',
      regularClose: '2026-08-26T20:00:00.000Z',
      contextAsOf: '2026-08-26T20:51:19.000Z',
      candles: {
        interval: '1m',
        source: SOURCE,
        sourceRef: null,
        data: [
          candle('2026-08-26T19:58:00.000Z', '99'),
          candle('2026-08-26T19:59:00.000Z', '100'),
          candle('2026-08-26T20:00:00.000Z', '999'),
          candle('2026-08-26T20:51:00.000Z', '1000'),
          candle('malformed', '101'),
        ],
      },
    });
    expect(result.status).toBe('available');
    expect(result.price).toBe('100');
    expect(result.observationTimestamp).toBe('2026-08-26T20:00:00.000Z');
    expect(result.distanceFromRegularCloseMs).toBe(0);
  });

  it('rejects a historical candle gap beyond the provisional reference tolerance', () => {
    const result = selectRTokenCloseReference({
      providerSymbol: 'RNVDAUSDT',
      regularClose: '2026-08-26T20:00:00.000Z',
      contextAsOf: '2026-08-26T20:51:19.000Z',
      maxReferenceDistanceMs: 15 * 60 * 1000,
      candles: {
        interval: '1m',
        source: SOURCE,
        sourceRef: null,
        data: [candle('2026-08-26T19:00:00.000Z', '100')],
      },
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('3540000ms');
  });

  it('derives weekend, holiday, next-open, previous-close, and DST boundaries from provider data', () => {
    const weekend = deriveSessionContext({
      asOf: '2026-08-29T12:00:00.000Z',
      markets: MARKETS,
      calendar: CALENDAR,
    });
    expect(weekend.status).toBe('closed');
    expect(weekend.calendarStatus).toBe('weekend');
    expect(weekend.previousRegularSessionClose).toBe('2026-08-28T20:00:00.000Z');
    expect(weekend.nextRegularSessionOpen).toBe('2026-08-31T13:30:00.000Z');

    const holiday = {
      ...CALENDAR,
      specificConfig: [
        { startTime: '2026-08-27T00:00:00.000Z', endTime: '2026-08-27T23:59:59.000Z' },
      ],
    };
    expect(
      deriveSessionContext({
        asOf: '2026-08-27T15:00:00.000Z',
        markets: MARKETS,
        calendar: holiday,
      }).calendarStatus,
    ).toBe('holiday');
    expect(resolvePreviousRegularSessionClose('2026-08-27T15:00:00.000Z', MARKETS, holiday)).toBe(
      '2026-08-26T20:00:00.000Z',
    );
    expect(resolveNextRegularSessionOpen('2026-08-27T15:00:00.000Z', MARKETS, holiday)).toBe(
      '2026-08-28T13:30:00.000Z',
    );

    expect(
      deriveSessionContext({
        asOf: '2026-03-09T20:30:00.000Z',
        markets: MARKETS,
        calendar: CALENDAR,
      }).regularSessionClose,
    ).toBe('2026-03-09T20:00:00.000Z');
    expect(
      deriveSessionContext({
        asOf: '2026-11-02T21:30:00.000Z',
        markets: MARKETS,
        calendar: CALENDAR,
      }).regularSessionClose,
    ).toBe('2026-11-02T21:00:00.000Z');
  });

  it('keeps deterministic decimal move, liquidity, event, and limitation axes separate', () => {
    const event = makeEvent('2026-08-26T20:21:19.000Z');
    const ticker = makeTicker('102.5');
    const orderBook = makeOrderBook();
    const context = buildAfterMrktContext({
      mode: 'REPLAY',
      asOf: '2026-08-26T20:51:19.000Z',
      providerSymbol: 'RNVDAUSDT',
      instrument: null,
      ticker,
      orderBook,
      markets: MARKETS,
      calendar: CALENDAR,
      suspension: null,
      suspensionStatus: 'not-available',
      candles: {
        interval: '1m',
        source: SOURCE,
        sourceRef: null,
        data: [candle('2026-08-26T19:59:00.000Z', '100')],
      },
      events: [
        event,
        { ...event, eventId: sha256('future'), sourceAvailableAt: '2026-08-26T20:52:00.000Z' },
      ],
      analyses: [],
      sourceRefs: [],
    });
    expect(context.reference.price).toBe('100');
    expect(context.move.absoluteMove).toBe('2.5');
    expect(context.move.percentageMove).toBe('2.5');
    expect(context.move.basisPointMove).toBe('250');
    expect(context.market.midpoint).toBe('102.5');
    expect(context.market.absoluteSpread).toBe('1');
    expect(context.liquidityContext.positionStatus).toBe('position_required');
    expect(context.eventContext.status).toBe('analysis-pending');
    expect(context.eventContext.events).toHaveLength(1);
    expect(context.nativePriceConfirmation.status).toBe('unavailable');
    expect(context.market.turnoverSemantics.status).toBe('unresolved');
    expect(context.limitations.some((item) => item.includes('not a native equity return'))).toBe(
      true,
    );
    expect(context.explanation.headline).toContain('rToken move since native close');
  });

  it('fails closed when calendar/candles are missing and preserves invalid-book state', () => {
    const context = buildAfterMrktContext({
      mode: 'LIVE',
      asOf: '2026-09-30T12:00:00.000Z',
      providerSymbol: 'RNVDAUSDT',
      instrument: null,
      ticker: makeTicker('100'),
      orderBook: makeOrderBook({
        bids: [{ price: '101', quantity: '1' }],
        asks: [{ price: '100', quantity: '1' }],
      }),
      markets: null,
      calendar: null,
      suspension: null,
      suspensionStatus: 'unavailable',
      candles: null,
      events: [],
      analyses: [],
      sourceRefs: [],
    });
    expect(context.session.status).toBe('unavailable');
    expect(context.reference.status).toBe('unavailable');
    expect(context.move.status).toBe('unavailable');
    expect(context.liquidityContext.condition.label).toBe('invalid-book');
    expect(context.liquidityContext.status).toBe('unavailable');
  });

  it('reports an explicit unavailable event source instead of turning it into a negative event result', () => {
    const result = deriveUnifiedEventContext({
      providerSymbol: 'RNVDAUSDT',
      events: [],
      analyses: [],
      contextAsOf: '2026-08-26T20:51:19.000Z',
      markets: MARKETS,
      calendar: CALENDAR,
      eventSourceAvailable: false,
    });
    expect(result.status).toBe('insufficient-event-evidence');
    expect(result.reasons[0]).toContain('storage is unavailable');
  });

  it('builds historical replay context from captured session/reference records without modern order-book data', async () => {
    const store = new InMemoryCaptureStore();
    const event = makeEvent('2026-08-26T20:21:19.000Z');
    const futureEvent = makeEvent('2026-08-26T20:52:00.000Z');
    await store.saveSourceEvent(event);
    await store.saveSourceEvent(futureEvent);
    const laterAnalysis = makeLaterAnalysis(event.eventId);
    await store.saveEventAnalysis(laterAnalysis);
    const marketStateSnapshot = await store.saveMarketStateSnapshot({
      data: MARKETS,
      providerTimestamp: SOURCE.providerTimestamp,
      receivedAt: SOURCE.receivedAt,
      source: { ...SOURCE, sourceId: 'bitget_reality_market_states' },
    });
    const marketCalendarSnapshot = await store.saveMarketCalendarSnapshot({
      data: CALENDAR,
      providerTimestamp: SOURCE.providerTimestamp,
      receivedAt: SOURCE.receivedAt,
      source: { ...SOURCE, sourceId: 'bitget_reality_market_calendar' },
    });
    const historicalCandleSnapshot = await store.saveHistoricalCandleSnapshot({
      providerSymbol: 'RNVDAUSDT',
      interval: '1m',
      data: [candle('2026-08-26T19:59:00.000Z', '100'), candle('2026-08-26T20:00:00.000Z', '999')],
      providerTimestamp: SOURCE.providerTimestamp,
      receivedAt: SOURCE.receivedAt,
      source: SOURCE,
    });
    const replayCase = await store.saveEventReplayCase(
      createEventReplayCase({
        providerSymbol: 'RNVDAUSDT',
        nativeTicker: 'NVDA',
        replayAsOf: '2026-08-26T20:51:19.000Z',
        sourceEvents: [event, futureEvent],
        marketStateSnapshot,
        marketCalendarSnapshot,
        historicalCandleSnapshot,
        manifestCreatedAt: '2026-09-30T00:00:00.000Z',
      }),
    );
    const context = await new EventReplayEngine(store).context(replayCase.manifest.caseId);
    expect(context.reference.price).toBe('100');
    expect(context.eventContext.events.map((item) => item.eventId)).toEqual([event.eventId]);
    expect(context.eventContext.laterAnalyses).toEqual([
      {
        analysisId: laterAnalysis.analysisId,
        eventId: event.eventId,
        status: 'validated',
        processedAt: laterAnalysis.processedAt,
        model: 'qwen3.8-max',
      },
    ]);
    expect(context.liquidityContext.status).toBe('unavailable');
    expect(context.liquidityContext.metrics).toBeNull();
    expect(
      context.sourceRefs.some((source) => source.sourceId === 'bitget_generic_spot_orderbook'),
    ).toBe(false);
    expect(context.limitations.some((item) => item.includes('retrieved after replayAsOf'))).toBe(
      true,
    );
  });
});

function candle(openTime: string, close: string): NormalizedCandle {
  return {
    openTime,
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
    quoteVolume: close,
    extras: [],
  };
}

function makeTicker(lastPrice: string): NormalizedTicker {
  return {
    providerSymbol: 'RNVDAUSDT',
    lastPrice,
    bidPrice: '102',
    bidSize: '1',
    askPrice: '103',
    askSize: '1',
    baseVolume: '10',
    volume24h: '10',
    quoteVolume: '1025',
    usdtVolume: null,
    turnover24h: '1025',
    platformTurnover24h: null,
    turnoverObservations: {
      turnover24h: {
        value: '1025',
        providerField: 'turnover24h',
        units: 'unknown',
        sourceId: SOURCE.sourceId,
        endpoint: SOURCE.endpoint,
        safeForRanking: false,
        safeForClassification: false,
        note: 'fixture',
      },
      platformTurnover24h: {
        value: null,
        providerField: 'platformTurnover24h',
        units: 'unknown',
        sourceId: SOURCE.sourceId,
        endpoint: SOURCE.endpoint,
        safeForRanking: false,
        safeForClassification: false,
        note: 'fixture',
      },
    },
    providerTimestamp: SOURCE.providerTimestamp,
    receivedAt: SOURCE.receivedAt,
    source: SOURCE,
  };
}

function makeOrderBook(
  overrides: Partial<NormalizedOrderBook> = {},
): NormalizedOrderBook & { snapshotId: string } {
  return {
    providerSymbol: 'RNVDAUSDT',
    bids: overrides.bids ?? [
      { price: '102', quantity: '10' },
      { price: '101.5', quantity: '10' },
    ],
    asks: overrides.asks ?? [{ price: '103', quantity: '10' }],
    requestedDepth: 40,
    returnedBidCount: (
      overrides.bids ?? [
        { price: '102', quantity: '10' },
        { price: '101.5', quantity: '10' },
      ]
    ).length,
    returnedAskCount: (overrides.asks ?? [{ price: '103', quantity: '10' }]).length,
    providerTimestamp: SOURCE.providerTimestamp,
    receivedAt: SOURCE.receivedAt,
    source: SOURCE,
    snapshotId: 'b'.repeat(64),
  };
}

function makeEvent(sourceAvailableAt: string): SourceEvent {
  const rawContentHash = sha256(sourceAvailableAt);
  return {
    eventId: sha256(canonicalJson({ rawContentHash, sourceAvailableAt })),
    providerSymbol: 'RNVDAUSDT',
    nativeTicker: 'NVDA',
    sourceType: 'sec-edgar-8k',
    sourceName: 'SEC EDGAR',
    sourceUrl: 'https://www.sec.gov/Archives/edgar/data/example/8-k.htm',
    externalId: `event-${sourceAvailableAt}`,
    title: 'NVDA filing event',
    excerpt: 'Bounded test evidence.',
    publishedAt: null,
    eventOccurredAt: null,
    sourceAvailableAt,
    retrievedAt: sourceAvailableAt,
    category: 'financial_event',
    rawContentHash,
    details: {},
  };
}

function makeLaterAnalysis(eventId: string): EventAnalysis {
  return {
    analysisId: sha256('later-context-analysis'),
    eventId,
    model: 'qwen3.8-max',
    providerReportedModel: 'qwen3.8-max',
    thinkingMode: 'disabled',
    promptVersion: 'event-evidence-v3',
    schemaVersion: 'event-analysis-v3',
    eventType: 'financial_event',
    entities: [],
    status: 'validated',
    materiality: 'possibly_material',
    facts: [],
    uncertainties: [],
    evidenceSpans: [],
    confidence: null,
    sourceBound: true,
    inputTokens: 1,
    reasoningTokens: 0,
    outputTokens: 1,
    totalTokens: 2,
    cacheTokens: 0,
    providerReportedCostUsd: null,
    estimatedCost: null,
    latencyMs: 1,
    processedAt: '2026-09-30T09:31:49.797Z',
    attemptCount: 1,
    retryReason: null,
    errorCode: null,
    validationIssues: [],
  };
}
