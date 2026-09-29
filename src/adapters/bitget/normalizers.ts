import { z } from 'zod';
import {
  BitgetResponseBaseSchema,
  CalendarSchema,
  CandleSchema,
  FillSchema,
  InstrumentSchema,
  MarketSchema,
  OrderBookSchema,
  StockInfoSchema,
  TickerSchema,
  type BitgetCalendar,
  type BitgetFill,
  type BitgetInstrument,
  type BitgetMarket,
  type BitgetOrderBook,
  type BitgetResponse,
  type BitgetStockInfo,
  type BitgetTicker,
} from '../../contracts/bitget.js';
import { classifyProviderFailure, ProbeError } from '../../lib/errors.js';

export function parseBitgetResponse<T>(raw: unknown, dataSchema: z.ZodType<T>): BitgetResponse<T> {
  const envelope = BitgetResponseBaseSchema.extend({ data: dataSchema }).safeParse(raw);
  if (!envelope.success) {
    throw new ProbeError('malformed_provider_data', formatZodError(envelope.error));
  }

  if (envelope.data.code !== '00000') {
    throw new ProbeError(
      classifyProviderFailure(200, envelope.data.code, envelope.data.msg),
      `Bitget provider error ${envelope.data.code}: ${envelope.data.msg}`,
      { httpStatus: 200, providerCode: envelope.data.code, providerMessage: envelope.data.msg },
    );
  }

  return envelope.data as BitgetResponse<T>;
}

export function normalizeInstruments(raw: unknown): BitgetInstrument[] {
  const response = parseBitgetResponse(raw, z.array(InstrumentSchema));
  return response.data.map((instrument) => ({ ...instrument }));
}

export function selectRealityInstruments(instruments: BitgetInstrument[]): BitgetInstrument[] {
  return instruments.filter((instrument) => instrument.isReality?.toLowerCase() === 'yes');
}

export function normalizeTicker(raw: unknown, expectedSymbol?: string): BitgetTicker {
  const response = parseBitgetResponse(raw, z.array(TickerSchema));
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

export function normalizeOrderBook(raw: unknown, expectedSymbol?: string): BitgetOrderBook {
  const response = parseBitgetResponse(raw, OrderBookSchema);
  assertExactSymbol(response.data.symbol, expectedSymbol);
  return {
    ...response.data,
    bids: response.data.bids ?? response.data.b ?? [],
    asks: response.data.asks ?? response.data.a ?? [],
  };
}

export function normalizeFills(raw: unknown, expectedSymbol?: string): BitgetFill[] {
  const response = parseBitgetResponse(raw, z.array(FillSchema));
  if (expectedSymbol) {
    const rawSymbol = getStringField(response.data[0], 'symbol');
    if (rawSymbol) {
      assertExactSymbol(rawSymbol, expectedSymbol);
    }
  }
  return response.data;
}

export function normalizeCandles(raw: unknown): string[][] {
  const response = parseBitgetResponse(raw, z.array(CandleSchema));
  return response.data;
}

export function normalizeStockInfo(raw: unknown): BitgetStockInfo[] {
  const response = parseBitgetResponse(raw, z.array(StockInfoSchema));
  return response.data;
}

export function normalizeMarketStates(raw: unknown): BitgetMarket[] {
  const response = parseBitgetResponse(raw, z.array(MarketSchema));
  return response.data;
}

export function normalizeCalendar(raw: unknown): BitgetCalendar {
  const response = parseBitgetResponse(raw, CalendarSchema);
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
