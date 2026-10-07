import { describe, expect, it } from 'vitest';
import {
  calculateMarketMetrics,
  parseTakerFeeRate,
  simulateExit,
} from '../src/domain/market-quality.js';
import { testSnapshot } from './fixtures/market.js';

const NOW = new Date('2026-09-29T22:00:00.000Z');

describe('deterministic market-quality engine', () => {
  it('simulates a position that fits entirely at the best bid', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '5',
      snapshot: testSnapshot(),
      now: NOW,
    });

    expect(result.filledQuantity).toBe('5');
    expect(result.unfilledQuantity).toBe('0');
    expect(result.estimatedVWAP).toBe('100');
    expect(result.totalExpectedProceeds).toBe('500');
    expect(result.levelsConsumed).toBe(1);
    expect(result.condition.label).toBe('execution-normal');
  });

  it('computes the taker fee and net proceeds with Decimal maths', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '4',
      snapshot: testSnapshot({
        bids: [
          { price: '100', quantity: '2' },
          { price: '99', quantity: '3' },
        ],
      }),
      now: NOW,
    });
    expect(result.totalExpectedProceeds).toBe('398');
    expect(result.takerFeeRate).toBe('0.0005');
    expect(result.estimatedFee).toBe('0.199');
    expect(result.netExpectedProceeds).toBe('397.801');
  });

  it('honours a custom taker fee rate and reports zero fee when unavailable', () => {
    const custom = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '5',
      snapshot: testSnapshot(),
      now: NOW,
      config: { takerFeeRate: '0.001' },
    });
    expect(custom.estimatedFee).toBe('0.5');
    expect(custom.netExpectedProceeds).toBe('499.5');
    const unavailable = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '0',
      snapshot: testSnapshot(),
      now: NOW,
    });
    expect(unavailable).toMatchObject({
      takerFeeRate: '0.0005',
      estimatedFee: '0',
      netExpectedProceeds: '0',
    });
  });

  it('parses the env taker fee rate and falls back on invalid values', () => {
    expect(parseTakerFeeRate('0.001')).toBe('0.001');
    expect(parseTakerFeeRate('0')).toBe('0');
    for (const bad of [undefined, '', '1', '-0.1', 'abc', '1e-3'])
      expect(parseTakerFeeRate(bad)).toBe('0.0005');
  });

  it('walks several bid levels in descending price order', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '4',
      snapshot: testSnapshot({
        bids: [
          { price: '100', quantity: '2' },
          { price: '99', quantity: '3' },
          { price: '98', quantity: '5' },
        ],
      }),
      now: NOW,
    });

    expect(result.filledQuantity).toBe('4');
    expect(result.totalExpectedProceeds).toBe('398');
    expect(result.estimatedVWAP).toBe('99.5');
    expect(result.levelsConsumed).toBe(2);
    expect(result.deepestConsumedPrice).toBe('99');
  });

  it('reports a partial fill when the bid book is insufficient', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '12',
      snapshot: testSnapshot(),
      now: NOW,
    });

    expect(result.filledQuantity).toBe('10');
    expect(result.unfilledQuantity).toBe('2');
    expect(result.condition.label).toBe('thin-book');
    expect(result.condition.reasons).toContainEqual(
      expect.objectContaining({ metric: 'unfilledQuantity', value: '2' }),
    );
  });

  it('flags a capped book as unknown depth beyond the fetched levels', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '12',
      snapshot: testSnapshot({
        bids: [
          { price: '100', quantity: '5' },
          { price: '99', quantity: '5' },
        ],
        requestedDepth: 2,
      }),
      now: NOW,
    });

    expect(result.unfilledQuantity).toBe('2');
    expect(result.condition.label).toBe('thin-book');
    expect(result.condition.reasons).toContainEqual(
      expect.objectContaining({
        metric: 'observedDepthLimit',
        value: '2',
        detail: 'observed book was limited to 2 bid levels; liquidity beyond them is unknown',
      }),
    );
  });

  it('reports no fill for an empty book', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '1',
      snapshot: testSnapshot({ bids: [], asks: [] }),
      now: NOW,
    });

    expect(result.filledQuantity).toBe('0');
    expect(result.unfilledQuantity).toBe('1');
    expect(result.condition.label).toBe('execution-unavailable');
  });

  it('reports a one-sided book as unavailable instead of calculating a midpoint', () => {
    const result = calculateMarketMetrics(testSnapshot({ asks: [] }), NOW);
    expect(result.valid).toBe(false);
    expect(result.midpoint).toBeNull();
    expect(result.condition.label).toBe('execution-unavailable');
  });

  it('handles a requested quantity much larger than observed depth', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '1000000000000000000000000.123456789',
      snapshot: testSnapshot({
        bids: [{ price: '100', quantity: '0.123456789' }],
      }),
      now: NOW,
    });

    expect(result.filledQuantity).toBe('0.123456789');
    expect(result.unfilledQuantity).toBe('1000000000000000000000000');
  });

  it('labels an unusually wide spread', () => {
    const metrics = calculateMarketMetrics(
      testSnapshot({ asks: [{ price: '103', quantity: '10' }] }),
      NOW,
    );

    expect(metrics.absoluteSpread).toBe('3');
    expect(metrics.spreadBps).toBe(
      '295.5665024630541871921182266009852216748768472906403940886699507389162561576354679802955665024630542',
    );
    expect(metrics.condition.label).toBe('wide-spread');
  });

  it('does not treat a stale book as current', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '1',
      snapshot: testSnapshot({ providerTimestamp: '1790719139000' }),
      now: NOW,
    });

    expect(result.freshness.state).toBe('stale');
    expect(result.condition.label).toBe('stale-book');
  });

  it('labels a crossed book invalid instead of calculating misleading metrics', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '1',
      snapshot: testSnapshot({ asks: [{ price: '99', quantity: '10' }] }),
      now: NOW,
    });

    expect(result.condition.label).toBe('invalid-book');
    expect(result.midpoint).toBeNull();
  });

  it('preserves high decimal precision in midpoint and spread calculations', () => {
    const metrics = calculateMarketMetrics(
      testSnapshot({
        bids: [{ price: '0.123456789', quantity: '1.000000001' }],
        asks: [{ price: '0.123456799', quantity: '1.000000001' }],
      }),
      NOW,
    );

    expect(metrics.midpoint).toBe('0.123456794');
    expect(metrics.absoluteSpread).toBe('0.00000001');
    expect(metrics.spreadBps).toBe(
      '0.0008099999745660007986275749230941474148437711739055851393646266239507240079472661504558428756865337034',
    );
  });

  it('supports tiny quantities without converting them to binary floats', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '0.000000001',
      snapshot: testSnapshot({
        bids: [{ price: '100.123456789', quantity: '0.000000002' }],
      }),
      now: NOW,
    });

    expect(result.filledQuantity).toBe('0.000000001');
    expect(result.totalExpectedProceeds).toBe('0.000000100123456789');
  });

  it('returns explicit reasons for a requested slippage limit', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '4',
      maximumAcceptableSlippageBps: '10',
      snapshot: testSnapshot({
        bids: [
          { price: '100', quantity: '2' },
          { price: '99', quantity: '3' },
        ],
      }),
      now: NOW,
    });

    expect(result.condition.label).toBe('execution-impaired');
    expect(result.condition.reasons).toContainEqual(
      expect.objectContaining({ metric: 'simulatedSlippageBps', threshold: '10' }),
    );
  });

  it('rejects malformed levels as invalid-book', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '1',
      snapshot: testSnapshot({ bids: [{ price: 'not-a-number', quantity: '1' }] }),
      now: NOW,
    });

    expect(result.condition.label).toBe('invalid-book');
    expect(result.condition.reasons[0]?.metric).toBe('bookLevel');
  });

  it('reports percentage executable within each configured band', () => {
    const result = simulateExit({
      providerSymbol: 'RMUUSDT',
      requestedQuantity: '10',
      snapshot: testSnapshot({
        bids: [
          { price: '100', quantity: '2' },
          { price: '99.8', quantity: '3' },
          { price: '99.1', quantity: '10' },
        ],
        asks: [{ price: '100.1', quantity: '10' }],
      }),
      now: NOW,
    });

    expect(result.quantityExecutableWithin25Bps).toBe('5');
    expect(result.positionPercentageWithin25Bps).toBe('0.5');
    expect(result.quantityExecutableWithin50Bps).toBe('5');
    expect(result.positionPercentageWithin100Bps).toBe('1');
  });
});
