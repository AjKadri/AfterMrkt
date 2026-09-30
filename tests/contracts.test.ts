import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  normalizeInstruments,
  normalizeOrderBook,
  normalizeTicker,
  normalizeTickerData,
  parseBitgetResponse,
} from '../src/adapters/bitget/index.js';
import { ProbeError } from '../src/lib/errors.js';
import type { SourceMetadata } from '../src/domain/types.js';

const TICKER_SOURCE: SourceMetadata = {
  provider: 'bitget',
  sourceId: 'bitget_generic_spot_ticker',
  sourceType: 'generic-public',
  endpoint: 'https://example.test/api/v3/market/tickers',
  providerTimestamp: '1770000000000',
  receivedAt: '2026-02-02T00:00:00.000Z',
  rawResponseHash: 'b'.repeat(64),
  httpStatus: 200,
};

describe('Bitget provider contracts', () => {
  it('normalizes a successful instrument response while preserving the exact symbol', () => {
    const result = normalizeInstruments({
      code: '00000',
      msg: 'success',
      requestTime: 1770000000000,
      data: [
        {
          symbol: 'RMUUSDT',
          category: 'SPOT',
          baseCoin: 'rMU',
          quoteCoin: 'USDT',
          isReality: 'yes',
          symbolType: 'stock',
          status: 'online',
          pricePrecision: '2',
          quantityPrecision: '6',
        },
      ],
    });

    expect(result[0]?.symbol).toBe('RMUUSDT');
    expect(result[0]?.baseCoin).toBe('rMU');
    expect(result[0]?.isReality).toBe('yes');
  });

  it('accepts the documented ticker aliases without converting numeric values to numbers', () => {
    const result = normalizeTicker(
      {
        code: '00000',
        msg: 'success',
        data: [
          {
            symbol: 'RMUUSDT',
            lastPr: '100.25',
            bidPr: '100.20',
            askPr: '100.30',
            ts: '1770000000000',
          },
        ],
      },
      'RMUUSDT',
    );

    expect(result.lastPr).toBe('100.25');
    expect(typeof result.lastPr).toBe('string');
  });

  it('normalizes generic order-book aliases into bids and asks', () => {
    const result = normalizeOrderBook(
      {
        code: '00000',
        msg: 'success',
        data: {
          symbol: 'RMUUSDT',
          b: [['100.20', '4']],
          a: [['100.30', '5']],
          ts: '1770000000000',
        },
      },
      'RMUUSDT',
    );

    expect(result.bids?.[0]).toEqual(['100.20', '4']);
    expect(result.asks?.[0]).toEqual(['100.30', '5']);
  });

  it('rejects a missing required provider field', () => {
    expect(() =>
      normalizeTicker({ code: '00000', msg: 'success', data: [{ lastPr: '100.25' }] }, 'RMUUSDT'),
    ).toThrowError(ProbeError);
  });

  it('rejects malformed provider JSON shapes', () => {
    expect(() =>
      normalizeInstruments({ code: '00000', msg: 'success', data: 'not-an-array' }),
    ).toThrow('expected array');
  });

  it('classifies provider errors instead of treating them as successful data', () => {
    expect(() =>
      parseBitgetResponse({ code: '40009', msg: 'Invalid ACCESS_KEY', data: null }, z.null()),
    ).toThrowError(/Invalid ACCESS_KEY/);
  });

  it('rejects a provider symbol mismatch', () => {
    expect(() =>
      normalizeTicker(
        { code: '00000', msg: 'success', data: [{ symbol: 'RNVDAUSDT', lastPr: '100.25' }] },
        'RMUUSDT',
      ),
    ).toThrowError(/symbol mismatch/);
  });

  it('keeps turnover fields separate and marks their semantics as unverified', () => {
    const result = normalizeTickerData(
      {
        symbol: 'RMUUSDT',
        lastPr: '100',
        turnover24h: '1200.50',
        platformTurnover24h: '900.25',
      },
      TICKER_SOURCE,
    );
    expect(result.turnover24h).toBe('1200.50');
    expect(result.platformTurnover24h).toBe('900.25');
    expect(result.quoteVolume).toBeNull();
    expect(result.turnoverObservations.turnover24h.units).toBe('unknown');
    expect(result.turnoverObservations.platformTurnover24h.safeForClassification).toBe(false);
  });
});
