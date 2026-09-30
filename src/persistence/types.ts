import type { BitgetMarket } from '../contracts/bitget.js';
import type { EventAnalysis, SourceEvent } from '../contracts/events.js';
import type {
  NormalizedRealityInstrument,
  NormalizedTicker,
  OrderBookSnapshot,
  SourceMetadata,
  SourceReference,
  TurnoverObservation,
} from '../domain/types.js';

export type MarketSnapshot = {
  snapshotId: string;
  providerSymbol: string;
  lastPrice: string | null;
  bidPrice: string | null;
  bidSize: string | null;
  askPrice: string | null;
  askSize: string | null;
  baseVolume: string | null;
  volume24h: string | null;
  quoteVolume: string | null;
  usdtVolume: string | null;
  turnover24h: string | null;
  platformTurnover24h: string | null;
  turnoverObservations: {
    turnover24h: TurnoverObservation;
    platformTurnover24h: TurnoverObservation;
  };
  providerTimestamp: string | null;
  receivedAt: string;
  source: SourceMetadata;
};

export type MarketStateSnapshot = {
  snapshotId: string;
  data: BitgetMarket[];
  providerTimestamp: string | null;
  receivedAt: string;
  source: SourceMetadata;
};

export type PersistedInstrument = {
  providerSymbol: string;
  instrument: NormalizedRealityInstrument;
  capturedAt: string;
};

export type CollectionErrorRecord = {
  errorId: string;
  providerSymbol: string;
  operation: string;
  code: string;
  message: string;
  occurredAt: string;
};

export type ReplaySourceReference = Omit<SourceReference, 'snapshotId'> & {
  snapshotId: string;
  sourceAvailableAt: string;
  captureTimestamp: string;
};

export type ReplayManifest = {
  caseId: string;
  providerSymbol: string;
  nativeTicker: string | null;
  replayAsOf: string;
  marketSnapshotId: string;
  orderBookSnapshotId: string;
  marketStateSnapshotId: string | null;
  sources: ReplaySourceReference[];
  eventIds?: string[];
  manifestCreatedAt: string;
  manifestHash: string;
};

export type ReplayOutcomeReference = {
  caseId: string;
  outcomeId: string;
  recordedAt: string;
  reference: string;
};

export type ReplayCase = {
  manifest: ReplayManifest;
};

export type EventReplayManifest = {
  caseId: string;
  providerSymbol: string;
  nativeTicker: string | null;
  replayAsOf: string;
  eventIds: string[];
  manifestCreatedAt: string;
  manifestHash: string;
};

export type EventReplayCase = {
  manifest: EventReplayManifest;
};

export type BaselineMetricName =
  | 'spreadBps'
  | 'bidDepthWithin25Bps'
  | 'bidDepthWithin50Bps'
  | 'bidDepthWithin100Bps'
  | 'executableNotional'
  | 'recentVolatility'
  | 'returnedLevels'
  | 'nativePriceDeviation';

export type BaselineDistribution = {
  count: number;
  min: string;
  max: string;
  mean: string;
};

export type HistoricalBaseline = {
  providerSymbol: string;
  status: 'insufficient-data' | 'ready';
  minimumObservations: number;
  observationCount: number;
  distributions: Partial<Record<BaselineMetricName, BaselineDistribution>>;
  generatedAt: string;
  limitations: string[];
};

export type MarketSnapshotInput = Omit<MarketSnapshot, 'snapshotId'>;
export type MarketStateSnapshotInput = Omit<MarketStateSnapshot, 'snapshotId'>;

export type CaptureStore = {
  saveInstrument(record: PersistedInstrument): Promise<PersistedInstrument>;
  getInstrument(providerSymbol: string): Promise<PersistedInstrument | null>;
  saveMarketSnapshot(snapshot: MarketSnapshotInput): Promise<MarketSnapshot>;
  getMarketSnapshot(snapshotId: string): Promise<MarketSnapshot | null>;
  saveOrderBook(snapshot: Omit<OrderBookSnapshot, 'snapshotId'>): Promise<OrderBookSnapshot>;
  getOrderBook(snapshotId: string): Promise<OrderBookSnapshot | null>;
  saveMarketStateSnapshot(snapshot: MarketStateSnapshotInput): Promise<MarketStateSnapshot>;
  getMarketStateSnapshot(snapshotId: string): Promise<MarketStateSnapshot | null>;
  saveReplayCase(replayCase: ReplayCase): Promise<ReplayCase>;
  getReplayCase(caseId: string): Promise<ReplayCase | null>;
  listReplayCases(): Promise<ReplayCase[]>;
  saveEventReplayCase(replayCase: EventReplayCase): Promise<EventReplayCase>;
  getEventReplayCase(caseId: string): Promise<EventReplayCase | null>;
  listEventReplayCases(): Promise<EventReplayCase[]>;
  saveReplayOutcome(outcome: ReplayOutcomeReference): Promise<ReplayOutcomeReference>;
  listReplayOutcomes(caseId: string): Promise<ReplayOutcomeReference[]>;
  appendCollectionError(record: CollectionErrorRecord): Promise<CollectionErrorRecord>;
  saveSourceEvent(event: SourceEvent): Promise<SourceEvent>;
  getSourceEvent(eventId: string): Promise<SourceEvent | null>;
  listSourceEvents(providerSymbol?: string): Promise<SourceEvent[]>;
  saveEventAnalysis(analysis: EventAnalysis): Promise<EventAnalysis>;
  getEventAnalysis(analysisId: string): Promise<EventAnalysis | null>;
  listEventAnalyses(eventId?: string): Promise<EventAnalysis[]>;
};

export function marketSnapshotInputFromTicker(ticker: NormalizedTicker): MarketSnapshotInput {
  return {
    providerSymbol: ticker.providerSymbol,
    lastPrice: ticker.lastPrice,
    bidPrice: ticker.bidPrice,
    bidSize: ticker.bidSize,
    askPrice: ticker.askPrice,
    askSize: ticker.askSize,
    baseVolume: ticker.baseVolume,
    volume24h: ticker.volume24h,
    quoteVolume: ticker.quoteVolume,
    usdtVolume: ticker.usdtVolume,
    turnover24h: ticker.turnover24h,
    platformTurnover24h: ticker.platformTurnover24h,
    turnoverObservations: ticker.turnoverObservations,
    providerTimestamp: ticker.providerTimestamp,
    receivedAt: ticker.receivedAt,
    source: ticker.source,
  };
}
