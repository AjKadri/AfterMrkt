import Decimal from 'decimal.js';
import { assessFreshness, DEFAULT_FRESHNESS_CONFIG, type FreshnessConfig } from './freshness.js';
import type { Freshness, OrderBookLevel, OrderBookSnapshot } from './types.js';

const FINANCIAL_PRECISION = 100;
Decimal.set({ precision: FINANCIAL_PRECISION, rounding: Decimal.ROUND_HALF_UP });

export const DEFAULT_MARKET_QUALITY_CONFIG = Object.freeze({
  // Provisional demo thresholds. They are not statistically validated.
  depthBandsBps: ['0', '25', '50', '100'] as const,
  wideSpreadBps: '100',
  impairedSlippageBps: '100',
  minFillRatioWithin50Bps: '0.80',
  // Bitget VIP 0 spot taker rate. Configurable via AFTERMRKT_TAKER_FEE_RATE.
  takerFeeRate: '0.0005',
  freshness: DEFAULT_FRESHNESS_CONFIG,
});

export type MarketQualityConfig = {
  depthBandsBps: readonly string[];
  wideSpreadBps: string;
  impairedSlippageBps: string;
  minFillRatioWithin50Bps: string;
  takerFeeRate: string;
  freshness: FreshnessConfig;
};

export type ExecutionConditionLabel =
  | 'execution-normal'
  | 'wide-spread'
  | 'thin-book'
  | 'execution-impaired'
  | 'stale-book'
  | 'execution-unavailable'
  | 'invalid-book';

export type ExecutionReason = {
  metric: string;
  value: string;
  threshold: string | null;
  detail: string;
};

export type ExecutionCondition = {
  label: ExecutionConditionLabel;
  reasons: ExecutionReason[];
};

export type DepthBandKey = 'bestBid' | 'within25Bps' | 'within50Bps' | 'within100Bps';

export type DepthMetric = {
  bandBps: string;
  quantity: string;
  notional: string;
  levels: number;
  reasons: ExecutionReason[];
};

export type MarketMetrics = {
  valid: boolean;
  bestBid: string | null;
  bestAsk: string | null;
  midpoint: string | null;
  absoluteSpread: string | null;
  spreadBps: string | null;
  depth: Record<DepthBandKey, DepthMetric>;
  freshness: Freshness;
  condition: ExecutionCondition;
};

export type SimulationInput = {
  providerSymbol: string;
  requestedQuantity: string;
  snapshot: OrderBookSnapshot;
  maximumAcceptableSlippageBps?: string;
  now?: Date;
  config?: Partial<MarketQualityConfig>;
};

export type ExitSimulation = {
  providerSymbol: string;
  snapshotId: string;
  requestedQuantity: string;
  filledQuantity: string;
  unfilledQuantity: string;
  bestBid: string | null;
  midpoint: string | null;
  absoluteSpread: string | null;
  spreadBps: string | null;
  estimatedVWAP: string | null;
  totalExpectedProceeds: string;
  takerFeeRate: string;
  estimatedFee: string;
  netExpectedProceeds: string;
  slippageVersusMidpointBps: string | null;
  slippageVersusBestBidBps: string | null;
  levelsConsumed: number;
  quantityExecutableWithin25Bps: string;
  quantityExecutableWithin50Bps: string;
  quantityExecutableWithin100Bps: string;
  positionPercentageWithin25Bps: string;
  positionPercentageWithin50Bps: string;
  positionPercentageWithin100Bps: string;
  deepestConsumedPrice: string | null;
  snapshotTimestamp: string | null;
  receivedTimestamp: string;
  freshness: Freshness;
  condition: ExecutionCondition;
  estimateDisclaimer: 'observed-book-estimate-not-guaranteed-fill';
};

type ParsedLevel = { price: Decimal; quantity: Decimal; raw: OrderBookLevel };

export function calculateMarketMetrics(
  snapshot: OrderBookSnapshot,
  now = new Date(),
  config: MarketQualityConfig = DEFAULT_MARKET_QUALITY_CONFIG,
): MarketMetrics {
  const freshness = assessFreshness(
    snapshot.providerTimestamp,
    snapshot.receivedAt,
    now,
    config.freshness,
  );
  const parsed = parseBook(snapshot);
  if (parsed.kind === 'malformed') {
    return emptyMetrics(freshness, {
      label: 'invalid-book',
      reasons: [parsed.reason],
    });
  }
  if (parsed.kind === 'empty') {
    return emptyMetrics(freshness, {
      label: 'execution-unavailable',
      reasons: [
        reason(
          'bookAvailability',
          'empty',
          'non-empty bid and ask sides',
          'book has no executable two-sided market',
        ),
      ],
    });
  }
  const bestBid = parsed.bids[0]?.price;
  const bestAsk = parsed.asks[0]?.price;
  if (!bestBid || !bestAsk) {
    return emptyMetrics(freshness, {
      label: 'execution-unavailable',
      reasons: [
        reason('bookAvailability', 'one-sided', 'two-sided book', 'bid or ask side is unavailable'),
      ],
    });
  }
  if (bestBid.gte(bestAsk)) {
    return emptyMetrics(freshness, {
      label: 'invalid-book',
      reasons: [
        reason(
          'bookCrossed',
          `${bestBid.toFixed()} >= ${bestAsk.toFixed()}`,
          'bestBid < bestAsk',
          'book is crossed',
        ),
      ],
    });
  }

  const midpoint = bestBid.plus(bestAsk).div(2);
  const absoluteSpread = bestAsk.minus(bestBid);
  const spreadBps = absoluteSpread.div(midpoint).times(10_000);
  const depth = calculateDepth(parsed.bids, bestBid, midpoint, config.depthBandsBps);
  const baseReasons: ExecutionReason[] = [];
  if (freshness.state === 'unavailable') {
    baseReasons.push(reason('freshness', freshness.state, 'fresh or stale', freshness.reason));
  } else if (freshness.state === 'stale') {
    baseReasons.push(reason('freshness', freshness.state, 'fresh', freshness.reason));
  }
  const condition = classifyCondition({
    freshness,
    spreadBps,
    baseReasons,
    config,
    simulatedSlippageBps: undefined,
    maximumAcceptableSlippageBps: undefined,
  });
  return {
    valid: true,
    bestBid: bestBid.toFixed(),
    bestAsk: bestAsk.toFixed(),
    midpoint: midpoint.toFixed(),
    absoluteSpread: absoluteSpread.toFixed(),
    spreadBps: spreadBps.toFixed(),
    depth,
    freshness,
    condition,
  };
}

export function simulateExit(input: SimulationInput): ExitSimulation {
  const config = resolveMarketQualityConfig(input.config);
  const metrics = calculateMarketMetrics(input.snapshot, input.now, config);
  const requested = parsePositiveDecimal(input.requestedQuantity);
  if (requested === null) {
    return unavailableSimulation(
      input,
      metrics.freshness,
      reason(
        'requestedQuantity',
        input.requestedQuantity,
        'positive decimal',
        'requested quantity is invalid',
      ),
    );
  }
  if (input.providerSymbol !== input.snapshot.providerSymbol) {
    return unavailableSimulation(
      input,
      metrics.freshness,
      reason(
        'providerSymbol',
        input.providerSymbol,
        input.snapshot.providerSymbol,
        'snapshot symbol mismatch',
      ),
    );
  }
  if (!metrics.valid || metrics.bestBid === null || metrics.midpoint === null) {
    return {
      ...unavailableSimulation(
        input,
        metrics.freshness,
        metrics.condition.reasons[0] ??
          reason('book', 'unavailable', 'valid', 'book is unavailable'),
      ),
      bestBid: metrics.bestBid,
      midpoint: metrics.midpoint,
      absoluteSpread: metrics.absoluteSpread,
      spreadBps: metrics.spreadBps,
      condition: metrics.condition,
      quantityExecutableWithin25Bps: '0',
      quantityExecutableWithin50Bps: '0',
      quantityExecutableWithin100Bps: '0',
      positionPercentageWithin25Bps: '0',
      positionPercentageWithin50Bps: '0',
      positionPercentageWithin100Bps: '0',
    };
  }

  const parsed = parseBook(input.snapshot);
  if (parsed.kind !== 'valid') {
    return unavailableSimulation(
      input,
      metrics.freshness,
      reason('book', parsed.kind, 'valid', 'book is not executable'),
    );
  }
  const execution = walkBids(parsed.bids, requested);
  const fullBookFill = execution.filled;
  const vwap = fullBookFill.gt(0) ? execution.proceeds.div(fullBookFill) : null;
  const slippageVersusMidpoint = vwap
    ? metrics.midpoint === null
      ? null
      : new Decimal(metrics.midpoint).minus(vwap).div(metrics.midpoint).times(10_000)
    : null;
  const slippageVersusBestBid = vwap
    ? new Decimal(metrics.bestBid).minus(vwap).div(metrics.bestBid).times(10_000)
    : null;
  const bandQuantities = {
    within25Bps: executableQuantity(metrics.depth.within25Bps.quantity, requested),
    within50Bps: executableQuantity(metrics.depth.within50Bps.quantity, requested),
    within100Bps: executableQuantity(metrics.depth.within100Bps.quantity, requested),
  };
  const condition = classifyCondition({
    freshness: metrics.freshness,
    spreadBps: new Decimal(metrics.spreadBps ?? '0'),
    baseReasons: metrics.condition.reasons,
    config,
    simulatedSlippageBps: slippageVersusMidpoint,
    fillRatioWithin50Bps: bandQuantities.within50Bps.div(requested),
    unfilledQuantity: requested.minus(fullBookFill),
    cappedBidLevels:
      input.snapshot.requestedDepth > 0 &&
      input.snapshot.returnedBidCount >= input.snapshot.requestedDepth
        ? input.snapshot.returnedBidCount
        : undefined,
    maximumAcceptableSlippageBps: input.maximumAcceptableSlippageBps,
  });
  return {
    providerSymbol: input.providerSymbol,
    snapshotId: input.snapshot.snapshotId,
    requestedQuantity: requested.toFixed(),
    filledQuantity: fullBookFill.toFixed(),
    unfilledQuantity: requested.minus(fullBookFill).toFixed(),
    bestBid: metrics.bestBid,
    midpoint: metrics.midpoint,
    absoluteSpread: metrics.absoluteSpread,
    spreadBps: metrics.spreadBps,
    estimatedVWAP: vwap?.toFixed() ?? null,
    totalExpectedProceeds: execution.proceeds.toFixed(),
    takerFeeRate: config.takerFeeRate,
    estimatedFee: execution.proceeds.times(config.takerFeeRate).toFixed(),
    netExpectedProceeds: execution.proceeds
      .minus(execution.proceeds.times(config.takerFeeRate))
      .toFixed(),
    slippageVersusMidpointBps: slippageVersusMidpoint?.toFixed() ?? null,
    slippageVersusBestBidBps: slippageVersusBestBid?.toFixed() ?? null,
    levelsConsumed: execution.levelsConsumed,
    quantityExecutableWithin25Bps: bandQuantities.within25Bps.toFixed(),
    quantityExecutableWithin50Bps: bandQuantities.within50Bps.toFixed(),
    quantityExecutableWithin100Bps: bandQuantities.within100Bps.toFixed(),
    positionPercentageWithin25Bps: bandQuantities.within25Bps.div(requested).toFixed(),
    positionPercentageWithin50Bps: bandQuantities.within50Bps.div(requested).toFixed(),
    positionPercentageWithin100Bps: bandQuantities.within100Bps.div(requested).toFixed(),
    deepestConsumedPrice: execution.deepestConsumedPrice?.toFixed() ?? null,
    snapshotTimestamp: input.snapshot.providerTimestamp,
    receivedTimestamp: input.snapshot.receivedAt,
    freshness: metrics.freshness,
    condition,
    estimateDisclaimer: 'observed-book-estimate-not-guaranteed-fill',
  };
}

function parseBook(
  snapshot: OrderBookSnapshot,
):
  | { kind: 'valid'; bids: ParsedLevel[]; asks: ParsedLevel[] }
  | { kind: 'empty' }
  | { kind: 'malformed'; reason: ExecutionReason } {
  if (snapshot.bids.length === 0 || snapshot.asks.length === 0) {
    return { kind: 'empty' };
  }
  const bids = parseLevels(snapshot.bids, 'bid');
  const asks = parseLevels(snapshot.asks, 'ask');
  if (bids.kind === 'malformed') {
    return bids;
  }
  if (asks.kind === 'malformed') {
    return asks;
  }
  bids.levels.sort((left, right) => right.price.comparedTo(left.price));
  asks.levels.sort((left, right) => left.price.comparedTo(right.price));
  return { kind: 'valid', bids: bids.levels, asks: asks.levels };
}

function parseLevels(
  levels: OrderBookLevel[],
  side: 'bid' | 'ask',
): { kind: 'valid'; levels: ParsedLevel[] } | { kind: 'malformed'; reason: ExecutionReason } {
  const parsed: ParsedLevel[] = [];
  for (const [index, level] of levels.entries()) {
    if (level.price.trim() === '' || level.quantity.trim() === '') {
      return {
        kind: 'malformed',
        reason: reason(
          'bookLevel',
          `${side}[${index}]`,
          'positive price and quantity',
          'level is missing a value',
        ),
      };
    }
    try {
      const price = new Decimal(level.price);
      const quantity = new Decimal(level.quantity);
      if (!price.isFinite() || !price.gt(0) || !quantity.isFinite() || !quantity.gt(0)) {
        return {
          kind: 'malformed',
          reason: reason(
            'bookLevel',
            `${side}[${index}]`,
            'positive finite decimal values',
            'level is non-positive or non-finite',
          ),
        };
      }
      parsed.push({ price, quantity, raw: level });
    } catch {
      return {
        kind: 'malformed',
        reason: reason(
          'bookLevel',
          `${side}[${index}]`,
          'decimal strings',
          'level cannot be parsed exactly',
        ),
      };
    }
  }
  return { kind: 'valid', levels: parsed };
}

function calculateDepth(
  bids: ParsedLevel[],
  bestBid: Decimal,
  midpoint: Decimal,
  bands: readonly string[],
): Record<DepthBandKey, DepthMetric> {
  const get = (band: string): DepthMetric => {
    const tolerance = new Decimal(band);
    const floor = tolerance.isZero()
      ? bestBid
      : midpoint.times(new Decimal(1).minus(tolerance.div(10_000)));
    const levels = bids.filter((level) => level.price.gte(floor));
    const quantity = levels.reduce((sum, level) => sum.plus(level.quantity), new Decimal(0));
    const notional = levels.reduce(
      (sum, level) => sum.plus(level.quantity.times(level.price)),
      new Decimal(0),
    );
    return {
      bandBps: band,
      quantity: quantity.toFixed(),
      notional: notional.toFixed(),
      levels: levels.length,
      reasons: [
        reason(
          'depthBandBps',
          band,
          band,
          'bid levels at or above the configured midpoint tolerance floor',
        ),
      ],
    };
  };
  const band = (index: number, fallback: string): string => bands[index] ?? fallback;
  return {
    bestBid: get(band(0, '0')),
    within25Bps: get(band(1, '25')),
    within50Bps: get(band(2, '50')),
    within100Bps: get(band(3, '100')),
  };
}

function classifyCondition(input: {
  freshness: Freshness;
  spreadBps: Decimal;
  baseReasons: ExecutionReason[];
  config: MarketQualityConfig;
  simulatedSlippageBps: Decimal | null | undefined;
  fillRatioWithin50Bps?: Decimal;
  unfilledQuantity?: Decimal;
  cappedBidLevels?: number | undefined;
  maximumAcceptableSlippageBps: string | undefined;
}): ExecutionCondition {
  const reasons = [...input.baseReasons];
  const spreadThreshold = new Decimal(input.config.wideSpreadBps);
  const impairedThreshold = new Decimal(input.config.impairedSlippageBps);
  let impaired = false;
  let wide = false;
  let thin = false;

  if (input.spreadBps.gt(spreadThreshold)) {
    wide = true;
    reasons.push(
      reason(
        'spreadBps',
        input.spreadBps.toFixed(),
        input.config.wideSpreadBps,
        'spread exceeds the provisional wide-spread threshold',
      ),
    );
  }
  if (
    input.fillRatioWithin50Bps &&
    input.fillRatioWithin50Bps.lt(input.config.minFillRatioWithin50Bps)
  ) {
    thin = true;
    reasons.push(
      reason(
        'fillRatioWithin50Bps',
        input.fillRatioWithin50Bps.toFixed(),
        input.config.minFillRatioWithin50Bps,
        'less than the provisional minimum fill ratio',
      ),
    );
  }
  if (input.unfilledQuantity && input.unfilledQuantity.gt(0)) {
    thin = true;
    reasons.push(
      reason(
        'unfilledQuantity',
        input.unfilledQuantity.toFixed(),
        '0',
        input.cappedBidLevels === undefined
          ? 'requested quantity exceeds observed bid depth'
          : 'requested quantity exceeds the bid levels observed in the capped book',
      ),
    );
    if (input.cappedBidLevels !== undefined) {
      reasons.push(
        reason(
          'observedDepthLimit',
          String(input.cappedBidLevels),
          String(input.cappedBidLevels),
          `observed book was limited to ${input.cappedBidLevels} bid levels; liquidity beyond them is unknown`,
        ),
      );
    }
  }
  if (input.simulatedSlippageBps && input.simulatedSlippageBps.gt(impairedThreshold)) {
    impaired = true;
    reasons.push(
      reason(
        'simulatedSlippageBps',
        input.simulatedSlippageBps.toFixed(),
        input.config.impairedSlippageBps,
        'simulated midpoint slippage exceeds the provisional threshold',
      ),
    );
  }
  if (input.maximumAcceptableSlippageBps !== undefined) {
    try {
      const maximum = new Decimal(input.maximumAcceptableSlippageBps);
      if (!maximum.isFinite() || maximum.lt(0)) {
        impaired = true;
        reasons.push(
          reason(
            'maximumAcceptableSlippageBps',
            input.maximumAcceptableSlippageBps,
            'non-negative decimal',
            'maximum acceptable slippage is invalid',
          ),
        );
      } else if (input.simulatedSlippageBps && input.simulatedSlippageBps.gt(maximum)) {
        impaired = true;
        reasons.push(
          reason(
            'simulatedSlippageBps',
            input.simulatedSlippageBps.toFixed(),
            maximum.toFixed(),
            'simulation exceeds the requested maximum slippage',
          ),
        );
      }
    } catch {
      impaired = true;
      reasons.push(
        reason(
          'maximumAcceptableSlippageBps',
          input.maximumAcceptableSlippageBps,
          'decimal string',
          'maximum acceptable slippage is invalid',
        ),
      );
    }
  }

  if (input.freshness.state === 'unavailable') {
    return { label: 'execution-unavailable', reasons };
  }
  if (input.freshness.state === 'stale') {
    return { label: 'stale-book', reasons };
  }
  if (impaired) {
    return { label: 'execution-impaired', reasons };
  }
  if (wide) {
    return { label: 'wide-spread', reasons };
  }
  if (thin) {
    return { label: 'thin-book', reasons };
  }
  return {
    label: 'execution-normal',
    reasons:
      reasons.length === 0
        ? [
            reason(
              'marketState',
              'normal',
              'configured thresholds',
              'book meets provisional execution conditions',
            ),
          ]
        : reasons,
  };
}

function walkBids(
  bids: ParsedLevel[],
  requested: Decimal,
): {
  filled: Decimal;
  proceeds: Decimal;
  levelsConsumed: number;
  deepestConsumedPrice: Decimal | null;
} {
  let remaining = requested;
  let proceeds = new Decimal(0);
  let filled = new Decimal(0);
  let levelsConsumed = 0;
  let deepestConsumedPrice: Decimal | null = null;
  for (const level of bids) {
    if (remaining.lte(0)) {
      break;
    }
    const quantity = Decimal.min(level.quantity, remaining);
    if (quantity.lte(0)) {
      continue;
    }
    filled = filled.plus(quantity);
    remaining = remaining.minus(quantity);
    proceeds = proceeds.plus(quantity.times(level.price));
    levelsConsumed += 1;
    deepestConsumedPrice = level.price;
  }
  return { filled, proceeds, levelsConsumed, deepestConsumedPrice };
}

function executableQuantity(available: string, requested: Decimal): Decimal {
  return Decimal.min(new Decimal(available), requested);
}

function emptyMetrics(freshness: Freshness, condition: ExecutionCondition): MarketMetrics {
  const emptyDepth = (bandBps: string): DepthMetric => ({
    bandBps,
    quantity: '0',
    notional: '0',
    levels: 0,
    reasons: [reason('depthBandBps', bandBps, bandBps, 'no valid bid levels available')],
  });
  return {
    valid: false,
    bestBid: null,
    bestAsk: null,
    midpoint: null,
    absoluteSpread: null,
    spreadBps: null,
    depth: {
      bestBid: emptyDepth('0'),
      within25Bps: emptyDepth('25'),
      within50Bps: emptyDepth('50'),
      within100Bps: emptyDepth('100'),
    },
    freshness,
    condition,
  };
}

function unavailableSimulation(
  input: SimulationInput,
  freshness: Freshness,
  simulationReason: ExecutionReason,
): ExitSimulation {
  const requested = safeDecimal(input.requestedQuantity);
  const requestedValue = requested?.toFixed() ?? input.requestedQuantity;
  return {
    providerSymbol: input.providerSymbol,
    snapshotId: input.snapshot.snapshotId,
    requestedQuantity: requestedValue,
    filledQuantity: '0',
    unfilledQuantity: requestedValue,
    bestBid: null,
    midpoint: null,
    absoluteSpread: null,
    spreadBps: null,
    estimatedVWAP: null,
    totalExpectedProceeds: '0',
    takerFeeRate: resolveMarketQualityConfig(input.config).takerFeeRate,
    estimatedFee: '0',
    netExpectedProceeds: '0',
    slippageVersusMidpointBps: null,
    slippageVersusBestBidBps: null,
    levelsConsumed: 0,
    quantityExecutableWithin25Bps: '0',
    quantityExecutableWithin50Bps: '0',
    quantityExecutableWithin100Bps: '0',
    positionPercentageWithin25Bps: '0',
    positionPercentageWithin50Bps: '0',
    positionPercentageWithin100Bps: '0',
    deepestConsumedPrice: null,
    snapshotTimestamp: input.snapshot.providerTimestamp,
    receivedTimestamp: input.snapshot.receivedAt,
    freshness,
    condition: { label: 'execution-unavailable', reasons: [simulationReason] },
    estimateDisclaimer: 'observed-book-estimate-not-guaranteed-fill',
  };
}

export function resolveMarketQualityConfig(
  overrides: Partial<MarketQualityConfig> | undefined,
): MarketQualityConfig {
  return {
    ...DEFAULT_MARKET_QUALITY_CONFIG,
    ...overrides,
    depthBandsBps: overrides?.depthBandsBps ?? DEFAULT_MARKET_QUALITY_CONFIG.depthBandsBps,
    freshness: { ...DEFAULT_FRESHNESS_CONFIG, ...overrides?.freshness },
  };
}

function parsePositiveDecimal(value: string): Decimal | null {
  const parsed = safeDecimal(value);
  return parsed && parsed.gt(0) ? parsed : null;
}

function safeDecimal(value: string): Decimal | null {
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

function reason(
  metric: string,
  value: string,
  threshold: string | null,
  detail: string,
): ExecutionReason {
  return { metric, value, threshold, detail };
}

export const DEFAULT_TAKER_FEE_RATE = DEFAULT_MARKET_QUALITY_CONFIG.takerFeeRate;

/** Parses a non-negative decimal below 1; anything else falls back to the default. */
export function parseTakerFeeRate(value: string | undefined): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || !/^\d+(?:\.\d+)?$/u.test(trimmed)) return DEFAULT_TAKER_FEE_RATE;
  const parsed = safeDecimal(trimmed);
  return parsed !== null && parsed.gte(0) && parsed.lt(1)
    ? parsed.toFixed()
    : DEFAULT_TAKER_FEE_RATE;
}
