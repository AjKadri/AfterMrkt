import { z } from 'zod';

export const DecimalStringSchema = z
  .string()
  .regex(/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/, 'must be a decimal string');

export const SourceMetadataSchema = z.object({
  provider: z.literal('bitget'),
  endpoint: z.string().url(),
  providerTimestamp: z.string().nullable(),
  receivedAt: z.string().datetime(),
  rawResponseHash: z.string().regex(/^[a-f0-9]{64}$/),
  httpStatus: z.number().int().nonnegative(),
});

export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;

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
};

export type NormalizedTicker = {
  providerSymbol: string;
  lastPrice: string | null;
  bidPrice: string | null;
  bidSize: string | null;
  askPrice: string | null;
  askSize: string | null;
  baseVolume: string | null;
  quoteVolume: string | null;
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
  providerTimestamp: string | null;
  receivedAt: string | null;
};

export type SourceReference = {
  provider: 'bitget';
  endpoint: string;
  rawResponseHash: string;
  providerTimestamp: string | null;
  receivedAt: string;
};
