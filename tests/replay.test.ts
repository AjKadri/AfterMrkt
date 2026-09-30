import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveHistoricalBaseline } from '../src/domain/baselines.js';
import { createReplayCase, ReplayEngine, ReplayError } from '../src/domain/replay.js';
import { InMemoryCaptureStore, FileCaptureStore } from '../src/persistence/store.js';
import type { MarketSnapshotInput } from '../src/persistence/types.js';
import { TEST_FIXTURE_SOURCE, testSnapshot } from './fixtures/market.js';

const REPLAY_AS_OF = '2026-09-29T22:00:00.000Z';
const TICKER_SOURCE = {
  ...TEST_FIXTURE_SOURCE,
  sourceId: 'bitget_generic_spot_ticker',
  endpoint: 'https://example.test/market/tickers?symbol=RMUUSDT',
};

const marketInput: MarketSnapshotInput = {
  providerSymbol: 'RMUUSDT',
  lastPrice: '100.5',
  bidPrice: '100',
  bidSize: '10',
  askPrice: '101',
  askSize: '10',
  baseVolume: '10',
  volume24h: '10',
  quoteVolume: '1005',
  usdtVolume: null,
  turnover24h: '1005',
  platformTurnover24h: '1005',
  turnoverObservations: {
    turnover24h: {
      value: '1005',
      providerField: 'turnover24h',
      units: 'unknown',
      sourceId: TICKER_SOURCE.sourceId,
      endpoint: TICKER_SOURCE.endpoint,
      safeForRanking: false,
      safeForClassification: false,
      note: 'test fixture',
    },
    platformTurnover24h: {
      value: '1005',
      providerField: 'platformTurnover24h',
      units: 'unknown',
      sourceId: TICKER_SOURCE.sourceId,
      endpoint: TICKER_SOURCE.endpoint,
      safeForRanking: false,
      safeForClassification: false,
      note: 'test fixture',
    },
  },
  providerTimestamp: TEST_FIXTURE_SOURCE.providerTimestamp,
  receivedAt: TEST_FIXTURE_SOURCE.receivedAt,
  source: TICKER_SOURCE,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('capture persistence and replay', () => {
  it('deduplicates identical immutable snapshots across changed local receipt time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aftermrkt-capture-'));
    temporaryDirectories.push(directory);
    const store = new FileCaptureStore(directory);
    const first = testSnapshot();
    const second = {
      ...first,
      receivedAt: '2026-09-29T22:00:01.000Z',
      source: { ...first.source, receivedAt: '2026-09-29T22:00:01.000Z' },
    };
    const { snapshotId: firstSnapshotId, ...firstInput } = first;
    const { snapshotId: secondSnapshotId, ...secondInput } = second;
    void firstSnapshotId;
    void secondSnapshotId;
    const savedFirst = await store.saveOrderBook(firstInput);
    const savedSecond = await store.saveOrderBook(secondInput);
    expect(savedSecond.snapshotId).toBe(savedFirst.snapshotId);
    expect(savedSecond.receivedAt).toBe(savedFirst.receivedAt);
    expect(Object.isFrozen(savedSecond)).toBe(true);
  });

  it('replays immutable snapshots deterministically without provider access', async () => {
    const store = new InMemoryCaptureStore();
    const marketSnapshot = await store.saveMarketSnapshot(marketInput);
    const orderBook = testSnapshot();
    const orderBookSnapshot = await store.saveOrderBook(orderBook);
    const marketStateSnapshot = await store.saveMarketStateSnapshot({
      data: [{ market: 'US', stateList: [] }],
      providerTimestamp: TEST_FIXTURE_SOURCE.providerTimestamp,
      receivedAt: TEST_FIXTURE_SOURCE.receivedAt,
      source: {
        ...TEST_FIXTURE_SOURCE,
        sourceId: 'bitget_reality_market_states',
        sourceType: 'reality-public',
        endpoint: 'https://example.test/reality/states',
      },
    });
    const replayCase = await store.saveReplayCase(
      createReplayCase({
        providerSymbol: 'RMUUSDT',
        nativeTicker: 'MU',
        replayAsOf: REPLAY_AS_OF,
        marketSnapshot,
        orderBookSnapshot,
        marketStateSnapshot,
        manifestCreatedAt: '2026-09-30T00:00:00.000Z',
      }),
    );
    const engine = new ReplayEngine(store);
    const first = await engine.simulate(replayCase.manifest.caseId, { requestedQuantity: '5' });
    const second = await engine.simulate(replayCase.manifest.caseId, { requestedQuantity: '5' });
    expect(first).toEqual(second);
    expect(first.mode).toBe('REPLAY');
    expect(first.asOf).toBe(REPLAY_AS_OF);
    expect(first.data.simulation.filledQuantity).toBe('5');
    expect(first.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.limitations[0]).toContain('no external provider calls');
    await store.saveReplayOutcome({
      caseId: replayCase.manifest.caseId,
      outcomeId: 'outcome-1',
      recordedAt: '2026-10-01T00:00:00.000Z',
      reference: 'test outcome only',
    });
    expect((await store.listReplayOutcomes(replayCase.manifest.caseId)).length).toBe(1);
    expect(await engine.simulate(replayCase.manifest.caseId, { requestedQuantity: '5' })).toEqual(
      first,
    );
  });

  it('excludes a source that became available after replayAsOf', async () => {
    const store = new InMemoryCaptureStore();
    const marketSnapshot = await store.saveMarketSnapshot({
      ...marketInput,
      receivedAt: '2026-09-29T22:00:01.000Z',
      source: { ...TICKER_SOURCE, receivedAt: '2026-09-29T22:00:01.000Z' },
    });
    const orderBookSnapshot = await store.saveOrderBook(testSnapshot());
    expect(() =>
      createReplayCase({
        providerSymbol: 'RMUUSDT',
        nativeTicker: 'MU',
        replayAsOf: REPLAY_AS_OF,
        marketSnapshot,
        orderBookSnapshot,
        marketStateSnapshot: null,
        manifestCreatedAt: '2026-09-30T00:00:00.000Z',
      }),
    ).toThrow(ReplayError);
  });
});

describe('historical baseline structures', () => {
  it('remains explicitly insufficient until the configured minimum exists', () => {
    const observation = {
      providerSymbol: 'RMUUSDT',
      spreadBps: '100',
      bidDepthWithin25Bps: '10',
      bidDepthWithin50Bps: '10',
      bidDepthWithin100Bps: '10',
      executableNotional: '1000',
      recentVolatility: null,
      returnedLevels: '80',
      nativePriceDeviation: null,
    };
    const insufficient = deriveHistoricalBaseline('RMUUSDT', [observation], {
      minimumObservations: 2,
    });
    expect(insufficient.status).toBe('insufficient-data');
    const ready = deriveHistoricalBaseline(
      'RMUUSDT',
      [observation, { ...observation, spreadBps: '200' }],
      { minimumObservations: 2 },
    );
    expect(ready.status).toBe('ready');
    expect(ready.distributions.spreadBps?.mean).toBe('150');
    expect(ready.limitations.some((item) => item.includes('percentile'))).toBe(true);
  });
});
