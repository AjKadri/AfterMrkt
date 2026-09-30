import { z } from 'zod';
import {
  BitgetResponseBaseSchema,
  CalendarSchema,
  CandleSchema,
  CompanyOverviewSchema,
  FillSchema,
  InstrumentSchema,
  MarketSchema,
  OrderBookSchema,
  StockInfoSchema,
  TickerSchema,
  type BitgetCalendar,
  type BitgetCompanyOverview,
  type BitgetFill,
  type BitgetInstrument,
  type BitgetMarket,
  type BitgetOrderBook,
  type BitgetResponse,
  type BitgetStockInfo,
  type BitgetTicker,
} from '../../contracts/bitget.js';
import { classifyProviderFailure, ProbeError } from '../../lib/errors.js';

export function parseBitgetResponse<T>(
  raw: unknown,
  dataSchema: z.ZodType<T>,
  httpStatus = 200,
): BitgetResponse<T> {
  const baseEnvelope = BitgetResponseBaseSchema.extend({ data: z.unknown() }).safeParse(raw);
  if (!baseEnvelope.success) {
    throw new ProbeError('malformed_provider_data', formatZodError(baseEnvelope.error));
  }

  if (baseEnvelope.data.code !== '00000') {
    throw new ProbeError(
      classifyProviderFailure(httpStatus, baseEnvelope.data.code, baseEnvelope.data.msg),
      `Bitget provider error ${baseEnvelope.data.code}: ${baseEnvelope.data.msg}`,
      {
        httpStatus,
        providerCode: baseEnvelope.data.code,
        providerMessage: baseEnvelope.data.msg,
      },
    );
  }

  const dataResult = dataSchema.safeParse(baseEnvelope.data.data);
  if (!dataResult.success) {
    throw new ProbeError('malformed_provider_data', formatZodError(dataResult.error));
  }

  return { ...baseEnvelope.data, data: dataResult.data } as BitgetResponse<T>;
}

export function normalizeInstruments(raw: unknown, httpStatus = 200): BitgetInstrument[] {
  const response = parseBitgetResponse(raw, z.array(InstrumentSchema), httpStatus);
  return response.data.map((instrument) => ({ ...instrument }));
}

export function selectRealityInstruments(instruments: BitgetInstrument[]): BitgetInstrument[] {
  return instruments.filter((instrument) => instrument.isReality?.toLowerCase() === 'yes');
}

export function normalizeTicker(
  raw: unknown,
  expectedSymbol?: string,
  httpStatus = 200,
): BitgetTicker {
  const response = parseBitgetResponse(raw, z.array(TickerSchema), httpStatus);
  const ticker = expectedSymbol
    ? response.data.find((item) => item.symbol === expectedSymbol)
    : response.data[0];
  if (!ticker) {
    const onlyTicker = response.data.length === 1 ? response.data[0] : undefined;
    if (onlyTicker && expectedSymbol) {
      assertExactSymbol(onlyTicker.symbol, expectedSymbol);
    }
    throw new ProbeError(
      'instrument_missing',
      `Bitget ticker response did not contain ${expectedSymbol ?? 'a ticker'}`,
    );
  }
  assertExactSymbol(ticker.symbol, expectedSymbol);
  return ticker;
}

export function normalizeTickers(raw: unknown, httpStatus = 200): BitgetTicker[] {
  const response = parseBitgetResponse(raw, z.array(TickerSchema), httpStatus);
  return response.data;
}

export function normalizeOrderBook(
  raw: unknown,
  expectedSymbol?: string,
  httpStatus = 200,
): BitgetOrderBook {
  const response = parseBitgetResponse(raw, OrderBookSchema, httpStatus);
  if (response.data.symbol) {
    assertExactSymbol(response.data.symbol, expectedSymbol);
  } else if (!expectedSymbol) {
    throw new ProbeError(
      'malformed_provider_data',
      'Order-book response omitted the provider symbol',
    );
  }
  return {
    ...response.data,
    symbol: response.data.symbol ?? expectedSymbol,
    bids: response.data.bids ?? response.data.b ?? [],
    asks: response.data.asks ?? response.data.a ?? [],
  };
}

export function normalizeFills(
  raw: unknown,
  expectedSymbol?: string,
  httpStatus = 200,
): BitgetFill[] {
  const response = parseBitgetResponse(raw, z.array(FillSchema), httpStatus);
  if (expectedSymbol) {
    const rawSymbol = getStringField(response.data[0], 'symbol');
    if (rawSymbol) {
      assertExactSymbol(rawSymbol, expectedSymbol);
    }
  }
  return response.data;
}

export function normalizeCandles(raw: unknown, httpStatus = 200): string[][] {
  const response = parseBitgetResponse(raw, z.array(CandleSchema), httpStatus);
  return response.data;
}

export function normalizeStockInfo(raw: unknown, httpStatus = 200): BitgetStockInfo[] {
  const response = parseBitgetResponse(raw, z.array(StockInfoSchema), httpStatus);
  return response.data;
}

export function normalizeCompanyOverview(raw: unknown, httpStatus = 200): BitgetCompanyOverview[] {
  const response = parseBitgetResponse(
    raw,
    z.union([z.array(CompanyOverviewSchema), CompanyOverviewSchema]),
    httpStatus,
  );
  return Array.isArray(response.data) ? response.data : [response.data];
}

export function normalizeMarketStates(raw: unknown, httpStatus = 200): BitgetMarket[] {
  const response = parseBitgetResponse(
    raw,
    z.union([z.array(MarketSchema), MarketSchema]),
    httpStatus,
  );
  return Array.isArray(response.data) ? response.data : [response.data];
}

export function normalizeCalendar(raw: unknown, httpStatus = 200): BitgetCalendar {
  const response = parseBitgetResponse(raw, CalendarSchema, httpStatus);
  return response.data;
}

export function getProviderTimestamp(raw: unknown): string | null {
  const envelope = BitgetResponseBaseSchema.safeParse(raw);
  if (!envelope.success) {
    return null;
  }
  const record = envelope.data.data;
  if (typeof record === 'object' && record !== null && 'ts' in record) {
    const value = record.ts;
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  }
  return envelope.data.requestTime ?? null;
}

export function assertExactSymbol(actual: string, expected?: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new ProbeError(
      'malformed_provider_data',
      `Provider symbol mismatch: requested ${expected}, received ${actual}`,
    );
  }
}

function getStringField(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' ? fieldValue : null;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
