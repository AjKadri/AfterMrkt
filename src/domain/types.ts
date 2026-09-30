import { z } from 'zod';

export const DecimalStringSchema = z
  .string()
  .regex(/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/, 'must be a decimal string');

export const SourceMetadataSchema = z.object({
  provider: z.literal('bitget'),
  sourceId: z.string().min(1),
  sourceType: z.enum(['generic-public', 'reality-public', 'mixed-public']),
  endpoint: z.string().url(),
  providerTimestamp: z.string().nullable(),
  receivedAt: z.string().datetime(),
  rawResponseHash: z.string().regex(/^[a-f0-9]{64}$/),
  httpStatus: z.number().int().nonnegative(),
});

export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;

export type TurnoverObservation = {
  value: string | null;
  providerField: 'turnover24h' | 'platformTurnover24h';
  units: 'unknown';
  sourceId: string;
  endpoint: string;
  safeForRanking: false;
  safeForClassification: false;
  note: string;
};

export type ProviderRecord<T> = {
  data: T;
  source: SourceMetadata;
};

export type MappingStatus = 'mapped' | 'unmapped';

export type NormalizedRealityInstrument = {
  providerSymbol: string;
  baseCoin: string | null;
  quoteCoin: string | null;
  nativeTicker: string | null;
  nativeName: string | null;
  mappingStatus: MappingStatus;
  isReality: boolean;
  isRwa: boolean | null;
  symbolType: string | null;
  status: string | null;
  quantityPrecision: string | null;
  pricePrecision: string | null;
  quotePrecision: string | null;
  minOrderQty: string | null;
  minOrderAmount: string | null;
  maxMarketOrderAmount: string | null;
  maxOrderQty: string | null;
  launchTime: string | null;
  maintainTime: string | null;
  tradingPeriod: string[] | string | null;
  weekendTradable: string | null;
  providerTimestamp: string | null;
  receivedAt: string;
  source: SourceMetadata;
  mappingSource: SourceMetadata | null;
};

export type NormalizedTicker = {
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

export type NormalizedFill = {
  executionId: string | null;
  tradeId: string | null;
  price: string | null;
  quantity: string | null;
  side: string | null;
  providerTimestamp: string | null;
};

export type NormalizedSuspensionResumption = {
  nativeTicker: string;
  recordStatus: 'recorded' | 'not-available';
  companyName: string | null;
  suspensionDate: string | null;
  suspensionTime: string | null;
  suspensionReason: string | null;
  suspensionPrice: string | null;
  resumptionDate: string | null;
  resumptionQuoteTime: string | null;
  resumptionTradingTime: string | null;
};

export type NormalizedCandle = {
  openTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quoteVolume: string;
  extras: string[];
};

export type OrderBookLevel = {
  price: string;
  quantity: string;
};

export type OrderBookSnapshot = {
  snapshotId: string;
  providerSymbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  requestedDepth: number;
  returnedBidCount: number;
  returnedAskCount: number;
  providerTimestamp: string | null;
  receivedAt: string;
  source: SourceMetadata;
};

export type NormalizedOrderBook = Omit<OrderBookSnapshot, 'snapshotId'>;

export type MarketFreshnessState = 'fresh' | 'stale' | 'unavailable';

export type Freshness = {
  state: MarketFreshnessState;
  reason: string;
  ageMs: number | null;
  clockSkewMs: number | null;
  timestampConflict: boolean;
  providerTimestamp: string | null;
  receivedAt: string | null;
};

export type SourceReference = {
  provider: 'bitget';
  sourceId: string;
  sourceType: SourceMetadata['sourceType'];
  providerSymbol: string | null;
  snapshotId: string | null;
  endpoint: string;
  rawResponseHash: string;
  providerTimestamp: string | null;
  receivedAt: string;
};
