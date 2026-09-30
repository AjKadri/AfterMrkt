import Decimal from 'decimal.js';
import type { MarketMetrics } from './market-quality.js';
import type { OrderBookSnapshot } from './types.js';
import type {
  BaselineDistribution,
  BaselineMetricName,
  HistoricalBaseline,
} from '../persistence/types.js';

export const DEFAULT_BASELINE_CONFIG = Object.freeze({
  minimumObservations: 30,
});

export type BaselineConfig = {
  minimumObservations: number;
};

export type HistoricalObservation = {
  providerSymbol: string;
  spreadBps: string | null;
  bidDepthWithin25Bps: string | null;
  bidDepthWithin50Bps: string | null;
  bidDepthWithin100Bps: string | null;
  executableNotional: string | null;
  recentVolatility: string | null;
  returnedLevels: string | null;
  nativePriceDeviation: string | null;
};

export function observationFromMarket(
  snapshot: OrderBookSnapshot,
  metrics: MarketMetrics,
): HistoricalObservation {
  return {
    providerSymbol: snapshot.providerSymbol,
    spreadBps: metrics.spreadBps,
    bidDepthWithin25Bps: metrics.depth.within25Bps.quantity,
    bidDepthWithin50Bps: metrics.depth.within50Bps.quantity,
    bidDepthWithin100Bps: metrics.depth.within100Bps.quantity,
    executableNotional: metrics.depth.within100Bps.notional,
    recentVolatility: null,
    returnedLevels: String(snapshot.returnedBidCount + snapshot.returnedAskCount),
    nativePriceDeviation: null,
  };
}

export function deriveHistoricalBaseline(
  providerSymbol: string,
  observations: readonly HistoricalObservation[],
  config: BaselineConfig = DEFAULT_BASELINE_CONFIG,
  generatedAt = new Date().toISOString(),
): HistoricalBaseline {
  const matching = observations.filter(
    (observation) => observation.providerSymbol === providerSymbol,
  );
  const distributions: Partial<Record<BaselineMetricName, BaselineDistribution>> = {};
  const metricNames: BaselineMetricName[] = [
    'spreadBps',
    'bidDepthWithin25Bps',
    'bidDepthWithin50Bps',
    'bidDepthWithin100Bps',
    'executableNotional',
    'recentVolatility',
    'returnedLevels',
    'nativePriceDeviation',
  ];
  for (const metricName of metricNames) {
    const values = matching
      .map((observation) => observation[metricName])
      .filter((value): value is string => value !== null);
    if (values.length > 0) {
      distributions[metricName] = distribution(values);
    }
  }
  return {
    providerSymbol,
    status: matching.length >= config.minimumObservations ? 'ready' : 'insufficient-data',
    minimumObservations: config.minimumObservations,
    observationCount: matching.length,
    distributions,
    generatedAt,
    limitations: [
      `Baseline requires at least ${config.minimumObservations} observations before it is marked ready.`,
      'Distributions are descriptive only. No normal, abnormal, or percentile labels are assigned.',
      'Recent volatility and native price deviation remain unavailable until their source inputs are captured.',
      'Observed turnover fields are intentionally excluded until their provider semantics are verified.',
    ],
  };
}

function distribution(values: string[]): BaselineDistribution {
  const decimals = values.map((value) => new Decimal(value));
  let min = decimals[0] as Decimal;
  let max = decimals[0] as Decimal;
  let total = new Decimal(0);
  for (const value of decimals) {
    if (value.lt(min)) min = value;
    if (value.gt(max)) max = value;
    total = total.plus(value);
  }
  return {
    count: values.length,
    min: min.toFixed(),
    max: max.toFixed(),
    mean: total.div(values.length).toFixed(),
  };
}
