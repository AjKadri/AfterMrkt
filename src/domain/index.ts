export { assessFreshness, DEFAULT_FRESHNESS_CONFIG, freshnessFromSource } from './freshness.js';
export type { FreshnessConfig } from './freshness.js';
export {
  calculateMarketMetrics,
  DEFAULT_MARKET_QUALITY_CONFIG,
  resolveMarketQualityConfig,
  simulateExit,
} from './market-quality.js';
export type {
  DepthBandKey,
  DepthMetric,
  ExecutionCondition,
  ExecutionConditionLabel,
  ExecutionReason,
  ExitSimulation,
  MarketMetrics,
  MarketQualityConfig,
  SimulationInput,
} from './market-quality.js';
export { InMemorySnapshotStore } from './snapshots.js';
export { orderBookSnapshotId } from './snapshots.js';
export type { MarketSnapshotStore } from './snapshots.js';
export {
  DEFAULT_BASELINE_CONFIG,
  deriveHistoricalBaseline,
  observationFromMarket,
} from './baselines.js';
export { createReplayCase, ReplayEngine, ReplayError } from './replay.js';
export type { BaselineConfig, HistoricalObservation } from './baselines.js';
export type {
  ReplayManifestInput,
  ReplaySimulationInput,
  ReplaySimulationResult,
} from './replay.js';
export type {
  Freshness,
  NormalizedCandle,
  NormalizedFill,
  NormalizedOrderBook,
  NormalizedRealityInstrument,
  NormalizedTicker,
  OrderBookLevel,
  OrderBookSnapshot,
  ProviderRecord,
  SourceMetadata,
  SourceReference,
  TurnoverObservation,
} from './types.js';
