import { z } from 'zod';

const StringLike = z.union([z.string(), z.number()]).transform((value) => String(value));
const NullableStringLike = z
  .union([z.string(), z.number(), z.null()])
  .transform((value) => (value === null ? null : String(value)));

export const BitgetResponseBaseSchema = z
  .object({
    code: z.string(),
    msg: z.string(),
    requestTime: StringLike.optional(),
  })
  .passthrough();

export const InstrumentSchema = z
  .object({
    symbol: z.string(),
    category: z.string(),
    baseCoin: z.string().optional(),
    quoteCoin: z.string().optional(),
    isReality: z.string().optional(),
    isRwa: z.string().optional(),
    symbolType: z.string().optional(),
    status: z.string().optional(),
    pricePrecision: NullableStringLike.optional(),
    quantityPrecision: NullableStringLike.optional(),
    quotePrecision: NullableStringLike.optional(),
    minOrderQty: NullableStringLike.optional(),
    minOrderAmount: NullableStringLike.optional(),
    maxMarketOrderAmount: NullableStringLike.optional(),
    maxOrderQty: NullableStringLike.optional(),
    launchTime: NullableStringLike.optional(),
    maintainTime: NullableStringLike.optional(),
    buyLimitPriceRatio: NullableStringLike.optional(),
    sellLimitPriceRatio: NullableStringLike.optional(),
  })
  .passthrough();

export const TickerSchema = z
  .object({
    symbol: z.string(),
    lastPr: NullableStringLike.optional(),
    lastPrice: NullableStringLike.optional(),
    bidPr: NullableStringLike.optional(),
    bidPrice: NullableStringLike.optional(),
    bidSz: NullableStringLike.optional(),
    bidSize: NullableStringLike.optional(),
    askPr: NullableStringLike.optional(),
    askPrice: NullableStringLike.optional(),
    askSz: NullableStringLike.optional(),
    askSize: NullableStringLike.optional(),
    baseVolume: NullableStringLike.optional(),
    volume24h: NullableStringLike.optional(),
    quoteVolume: NullableStringLike.optional(),
    turnover24h: NullableStringLike.optional(),
    usdtVolume: NullableStringLike.optional(),
    ts: NullableStringLike.optional(),
  })
  .passthrough();

export const PriceLevelSchema = z.array(StringLike).min(2);

export const OrderBookSchema = z
  .object({
    symbol: z.string().optional(),
    asks: z.array(PriceLevelSchema).optional(),
    bids: z.array(PriceLevelSchema).optional(),
    a: z.array(PriceLevelSchema).optional(),
    b: z.array(PriceLevelSchema).optional(),
    ts: StringLike.optional(),
    checksum: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export const FillSchema = z
  .object({
    execId: z.string().optional(),
    tradeId: z.string().optional(),
    price: StringLike.optional(),
    size: StringLike.optional(),
    qty: StringLike.optional(),
    side: z.string().optional(),
    ts: StringLike.optional(),
  })
  .passthrough();

export const CandleSchema = z.array(StringLike).min(7);

export const StockInfoSchema = z
  .object({
    symbol: z.string(),
    code: z.string(),
    name: z.string().nullable().optional(),
    tradingPeriod: z.union([z.array(z.string()), z.string()]).optional(),
    weekendTradable: z.string().optional(),
  })
  .passthrough();

export const MarketStateSchema = z
  .object({
    state: z.string(),
    timeZone: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
  })
  .passthrough();

export const MarketSchema = z
  .object({
    market: z.string(),
    daylightType: z.string().optional(),
    stateList: z.array(MarketStateSchema).optional(),
  })
  .passthrough();

export const CalendarEntrySchema = z
  .object({
    remark: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
  })
  .passthrough();

export const CalendarSchema = z
  .object({
    timeZone: z.string().optional(),
    specificConfig: z.array(CalendarEntrySchema).optional(),
    regularConfig: z.array(z.string()).optional(),
  })
  .passthrough();

export type BitgetInstrument = z.infer<typeof InstrumentSchema>;
export type BitgetTicker = z.infer<typeof TickerSchema>;
export type BitgetOrderBook = z.infer<typeof OrderBookSchema>;
export type BitgetFill = z.infer<typeof FillSchema>;
export type BitgetStockInfo = z.infer<typeof StockInfoSchema>;
export type BitgetMarket = z.infer<typeof MarketSchema>;
export type BitgetCalendar = z.infer<typeof CalendarSchema>;

export type BitgetResponse<T> = {
  code: string;
  msg: string;
  requestTime?: string;
  data: T;
};
