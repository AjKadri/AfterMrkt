import type {
  BitgetCalendar,
  BitgetCompanyOverview,
  BitgetFill,
  BitgetInstrument,
  BitgetMarket,
  BitgetStockInfo,
  BitgetTicker,
} from '../../contracts/bitget.js';
import { hashRawResponse } from '../../observability/evidence.js';
import { ProbeError } from '../../lib/errors.js';
import type {
  NormalizedCandle,
  NormalizedFill,
  NormalizedOrderBook,
  NormalizedRealityInstrument,
  NormalizedTicker,
  ProviderRecord,
  SourceMetadata,
  OrderBookLevel,
} from '../../domain/types.js';
import {
  BitgetPublicClient,
  type BitgetClientOptions,
  type BitgetRequestResult,
} from './client.js';
import {
  getProviderTimestamp,
  normalizeCalendar,
  normalizeCandles,
  normalizeCompanyOverview,
  normalizeFills,
  normalizeInstruments,
  normalizeMarketStates,
  normalizeOrderBook,
  normalizeStockInfo,
  normalizeTicker,
  normalizeTickers,
  selectRealityInstruments,
} from './normalizers.js';

export type CandleQuery = {
  interval?: string;
  limit?: number;
  startTime?: string;
  endTime?: string;
};

export type PublicMarketDataProvider = {
  discoverRealityInstruments(): Promise<ProviderRecord<NormalizedRealityInstrument[]>>;
  getTicker(symbol: string): Promise<ProviderRecord<NormalizedTicker>>;
  getAllTickers(): Promise<ProviderRecord<NormalizedTicker[]>>;
  getOrderBook(symbol: string, limit?: number): Promise<ProviderRecord<NormalizedOrderBook>>;
  getFills(symbol: string, limit?: number): Promise<ProviderRecord<NormalizedFill[]>>;
  getCandles(symbol: string, query?: CandleQuery): Promise<ProviderRecord<NormalizedCandle[]>>;
  getHistoricalCandles(
    symbol: string,
    query?: CandleQuery,
  ): Promise<ProviderRecord<NormalizedCandle[]>>;
  getStockInfo(symbol?: string): Promise<ProviderRecord<BitgetStockInfo[]>>;
  getCompanyOverview(symbol?: string): Promise<ProviderRecord<BitgetCompanyOverview[]>>;
  getMarketStates(): Promise<ProviderRecord<BitgetMarket[]>>;
  getMarketCalendar(): Promise<ProviderRecord<BitgetCalendar>>;
};

export class BitgetPublicMarketDataAdapter implements PublicMarketDataProvider {
  readonly client: BitgetPublicClient;

  constructor(options: BitgetClientOptions = {}) {
    this.client = new BitgetPublicClient(options);
  }

  async discoverRealityInstruments(): Promise<ProviderRecord<NormalizedRealityInstrument[]>> {
    const instrumentResult = await this.client.get('/api/v3/market/instruments', {
      category: 'SPOT',
    });
    const instruments = selectRealityInstruments(
      normalizeInstruments(instrumentResult.json, instrumentResult.raw.status),
    );

    let stockInfo: BitgetStockInfo[] = [];
    let stockInfoSource: SourceMetadata | null = null;
    try {
      const stockInfoResult = await this.getStockInfo();
      stockInfo = stockInfoResult.data;
      stockInfoSource = stockInfoResult.source;
    } catch (error) {
      if (!(error instanceof ProbeError)) {
        throw error;
      }
    }
    const stockBySymbol = new Map(stockInfo.map((item) => [item.symbol, item]));
    const source = sourceFrom(instrumentResult);
    return {
      source,
      data: instruments.map((instrument) =>
        normalizeInstrument(instrument, stockBySymbol, source, stockInfoSource),
      ),
    };
  }

  async getTicker(symbol: string): Promise<ProviderRecord<NormalizedTicker>> {
    const result = await this.client.get('/api/v3/market/tickers', {
      category: 'SPOT',
      symbol,
    });
    const rawTicker = normalizeTicker(result.json, symbol, result.raw.status);
    return { data: normalizeTickerData(rawTicker, sourceFrom(result)), source: sourceFrom(result) };
  }

  async getAllTickers(): Promise<ProviderRecord<NormalizedTicker[]>> {
    const result = await this.client.get('/api/v3/market/tickers', { category: 'SPOT' });
    const source = sourceFrom(result);
    return {
      data: normalizeTickers(result.json, result.raw.status).map((ticker) =>
        normalizeTickerData(ticker, source),
      ),
      source,
    };
  }

  async getOrderBook(symbol: string, limit = 40): Promise<ProviderRecord<NormalizedOrderBook>> {
    const result = await this.client.get('/api/v3/market/orderbook', {
      category: 'SPOT',
      symbol,
      limit: String(limit),
    });
    const normalized = normalizeOrderBook(result.json, symbol, result.raw.status);
    const source = sourceFrom(result);
    return {
      source,
      data: {
        providerSymbol: symbol,
        bids: normalizeLevels(normalized.bids ?? []),
        asks: normalizeLevels(normalized.asks ?? []),
        requestedDepth: limit,
        returnedBidCount: (normalized.bids ?? []).length,
        returnedAskCount: (normalized.asks ?? []).length,
        providerTimestamp: getProviderTimestamp(result.json),
        receivedAt: result.raw.receivedAt,
        source,
      },
    };
  }

  async getFills(symbol: string, limit = 100): Promise<ProviderRecord<NormalizedFill[]>> {
    const result = await this.client.get('/api/v3/market/fills', {
      category: 'SPOT',
      symbol,
      limit: String(limit),
    });
    const source = sourceFrom(result);
    return {
      source,
      data: normalizeFills(result.json, symbol, result.raw.status).map((fill) =>
        normalizeFill(fill, getProviderTimestamp(result.json)),
      ),
    };
  }

  async getCandles(
    symbol: string,
    query: CandleQuery = {},
  ): Promise<ProviderRecord<NormalizedCandle[]>> {
    return this.getCandleSeries('/api/v3/market/candles', symbol, query);
  }

  async getHistoricalCandles(
    symbol: string,
    query: CandleQuery = {},
  ): Promise<ProviderRecord<NormalizedCandle[]>> {
    return this.getCandleSeries('/api/v3/market/history-candles', symbol, query);
  }

  async getStockInfo(symbol?: string): Promise<ProviderRecord<BitgetStockInfo[]>> {
    const result = await this.client.get(
      '/api/v3/reality/market/stock-info',
      symbol === undefined ? {} : { symbol },
    );
    const source = sourceFrom(result);
    return {
      source,
      data: normalizeStockInfo(result.json, result.raw.status),
    };
  }

  async getCompanyOverview(symbol?: string): Promise<ProviderRecord<BitgetCompanyOverview[]>> {
    const result = await this.client.get(
      '/api/v3/reality/market/company-overview',
      symbol === undefined ? {} : { symbol },
    );
    const source = sourceFrom(result);
    return {
      source,
      data: normalizeCompanyOverview(result.json, result.raw.status),
    };
  }

  async getMarketStates(): Promise<ProviderRecord<BitgetMarket[]>> {
    const result = await this.client.get('/api/v3/reality/market/states');
    const source = sourceFrom(result);
    return { source, data: normalizeMarketStates(result.json, result.raw.status) };
  }

  async getMarketCalendar(): Promise<ProviderRecord<BitgetCalendar>> {
    const result = await this.client.get('/api/v3/reality/market/calendar');
    const source = sourceFrom(result);
    return { source, data: normalizeCalendar(result.json, result.raw.status) };
  }

  private async getCandleSeries(
    path: string,
    symbol: string,
    query: CandleQuery,
  ): Promise<ProviderRecord<NormalizedCandle[]>> {
    const result = await this.client.get(path, {
      category: 'SPOT',
      symbol,
      interval: query.interval ?? '1m',
      limit: String(query.limit ?? 100),
      startTime: query.startTime,
      endTime: query.endTime,
    });
    const source = sourceFrom(result);
    return {
      source,
      data: normalizeCandles(result.json, result.raw.status).map(normalizeCandle),
    };
  }
}

function sourceFrom(result: BitgetRequestResult): SourceMetadata {
  const sourceId = sourceIdForEndpoint(new URL(result.requestUrl).pathname);
  return {
    provider: 'bitget',
    sourceId,
    sourceType: sourceTypeForSourceId(sourceId),
    endpoint: result.requestUrl,
    providerTimestamp: getProviderTimestamp(result.json),
    receivedAt: result.raw.receivedAt,
    rawResponseHash: hashRawResponse(result.raw.bodyText),
    httpStatus: result.raw.status,
  };
}

function normalizeInstrument(
  instrument: BitgetInstrument,
  stockBySymbol: Map<string, BitgetStockInfo>,
  source: SourceMetadata,
  mappingSource: SourceMetadata | null,
): NormalizedRealityInstrument {
  const mapping = stockBySymbol.get(instrument.symbol);
  return {
    providerSymbol: instrument.symbol,
    baseCoin: instrument.baseCoin ?? null,
    quoteCoin: instrument.quoteCoin ?? null,
    nativeTicker: mapping?.code ?? null,
    nativeName: mapping?.name ?? null,
    mappingStatus: mapping?.code ? 'mapped' : 'unmapped',
    isReality: instrument.isReality?.toLowerCase() === 'yes',
    isRwa: parseBooleanFlag(instrument.isRwa),
    symbolType: instrument.symbolType ?? null,
    status: instrument.status ?? null,
    quantityPrecision: instrument.quantityPrecision ?? null,
    pricePrecision: instrument.pricePrecision ?? null,
    quotePrecision: instrument.quotePrecision ?? null,
    minOrderQty: instrument.minOrderQty ?? null,
    minOrderAmount: instrument.minOrderAmount ?? null,
    maxMarketOrderAmount: instrument.maxMarketOrderAmount ?? null,
    maxOrderQty: instrument.maxOrderQty ?? null,
    launchTime: instrument.launchTime ?? null,
    maintainTime: instrument.maintainTime ?? null,
    tradingPeriod: instrument.tradingPeriod ?? mapping?.tradingPeriod ?? null,
    weekendTradable: mapping?.weekendTradable ?? null,
    providerTimestamp: source.providerTimestamp,
    receivedAt: source.receivedAt,
    source,
    mappingSource,
  };
}

export function normalizeTickerData(
  ticker: BitgetTicker,
  source: SourceMetadata,
): NormalizedTicker {
  const turnover24h = ticker.turnover24h ?? null;
  const platformTurnover24h = ticker.platformTurnover24h ?? null;
  return {
    providerSymbol: ticker.symbol,
    lastPrice: ticker.lastPr ?? ticker.lastPrice ?? null,
    bidPrice: ticker.bidPr ?? ticker.bidPrice ?? null,
    bidSize: ticker.bidSz ?? ticker.bidSize ?? null,
    askPrice: ticker.askPr ?? ticker.askPrice ?? null,
    askSize: ticker.askSz ?? ticker.askSize ?? null,
    baseVolume: ticker.baseVolume ?? ticker.volume24h ?? null,
    volume24h: ticker.volume24h ?? null,
    quoteVolume: ticker.quoteVolume ?? null,
    usdtVolume: ticker.usdtVolume ?? null,
    turnover24h,
    platformTurnover24h,
    turnoverObservations: {
      turnover24h: turnoverObservation('turnover24h', turnover24h, source),
      platformTurnover24h: turnoverObservation('platformTurnover24h', platformTurnover24h, source),
    },
    providerTimestamp: ticker.ts ?? source.providerTimestamp,
    receivedAt: source.receivedAt,
    source: { ...source, providerTimestamp: ticker.ts ?? source.providerTimestamp },
  };
}

function normalizeLevels(levels: string[][]): OrderBookLevel[] {
  return levels.map((level) => ({ price: level[0] ?? '', quantity: level[1] ?? '' }));
}

function turnoverObservation(
  providerField: 'turnover24h' | 'platformTurnover24h',
  value: string | null,
  source: SourceMetadata,
) {
  return {
    value,
    providerField,
    units: 'unknown' as const,
    sourceId: source.sourceId,
    endpoint: source.endpoint,
    safeForRanking: false as const,
    safeForClassification: false as const,
    note: 'Provider field was preserved, but units and semantics are not independently verified.',
  };
}

function sourceIdForEndpoint(pathname: string): string {
  if (pathname === '/api/v3/market/instruments') return 'bitget_spot_instruments';
  if (pathname === '/api/v3/market/tickers') return 'bitget_generic_spot_ticker';
  if (pathname === '/api/v3/market/orderbook') return 'bitget_generic_spot_orderbook';
  if (pathname === '/api/v3/market/fills') return 'bitget_generic_spot_fills';
  if (pathname === '/api/v3/market/candles') return 'bitget_generic_spot_candles';
  if (pathname === '/api/v3/market/history-candles') {
    return 'bitget_generic_spot_historical_candles';
  }
  if (pathname === '/api/v3/reality/market/stock-info') return 'bitget_reality_stock_info';
  if (pathname === '/api/v3/reality/market/states') return 'bitget_reality_market_states';
  if (pathname === '/api/v3/reality/market/calendar') return 'bitget_reality_market_calendar';
  if (pathname === '/api/v3/reality/market/company-overview') {
    return 'bitget_reality_company_overview';
  }
  return 'bitget_unknown_public_endpoint';
}

function sourceTypeForSourceId(sourceId: string): SourceMetadata['sourceType'] {
  if (sourceId.startsWith('bitget_reality_')) return 'reality-public';
  if (sourceId === 'bitget_unknown_public_endpoint') return 'mixed-public';
  return 'generic-public';
}

function normalizeFill(fill: BitgetFill, providerTimestamp: string | null): NormalizedFill {
  const record = fill as BitgetFill & Record<string, unknown>;
  return {
    executionId: fill.execId ?? null,
    tradeId: fill.tradeId ?? null,
    price: fill.price ?? null,
    quantity: fill.qty ?? fill.size ?? null,
    side: fill.side ?? null,
    providerTimestamp: stringValue(record.ts) ?? providerTimestamp,
  };
}

function normalizeCandle(candle: string[]): NormalizedCandle {
  return {
    openTime: candle[0] ?? '',
    open: candle[1] ?? '',
    high: candle[2] ?? '',
    low: candle[3] ?? '',
    close: candle[4] ?? '',
    volume: candle[5] ?? '',
    quoteVolume: candle[6] ?? '',
    extras: candle.slice(7),
  };
}

function parseBooleanFlag(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null;
  }
  if (['yes', 'true', '1'].includes(value.toLowerCase())) {
    return true;
  }
  if (['no', 'false', '0'].includes(value.toLowerCase())) {
    return false;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}
