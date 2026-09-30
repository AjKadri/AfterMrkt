import { classifyThrownError, ProbeError } from '../lib/errors.js';
import { assessFreshness } from '../domain/freshness.js';
import type { PublicMarketDataProvider } from '../adapters/bitget/public-market-data.js';
import type { NormalizedRealityInstrument } from '../domain/types.js';
import { createReplayCase } from '../domain/replay.js';
import type { MarketStateSnapshot } from '../persistence/types.js';
import {
  marketSnapshotInputFromTicker,
  type CaptureStore,
  type CollectionErrorRecord,
  type ReplayCase,
} from '../persistence/types.js';

export const DEFAULT_WATCH_SYMBOLS = Object.freeze([
  'RNVDAUSDT',
  'RTSLAUSDT',
  'RAAPLUSDT',
  'RSPYUSDT',
]);

export type CollectorOptions = {
  watchSymbols?: readonly string[];
  orderBookDepth?: number;
  now?: () => Date;
};

export type CollectedSymbol = {
  providerSymbol: string;
  nativeTicker: string | null;
  mappingStatus: 'mapped' | 'unmapped';
  marketSnapshotId: string | null;
  orderBookSnapshotId: string | null;
  marketStateSnapshotId: string | null;
  tickerFreshness: ReturnType<typeof assessFreshness> | null;
  bookFreshness: ReturnType<typeof assessFreshness> | null;
  errors: string[];
};

export type CollectorCycle = {
  startedAt: string;
  completedAt: string;
  watchSymbols: string[];
  symbols: CollectedSymbol[];
  marketStateSnapshotId: string | null;
  errors: CollectionErrorRecord[];
};

export class MarketCollector {
  private readonly watchSymbols: readonly string[];
  private readonly orderBookDepth: number;
  private readonly now: () => Date;

  constructor(
    private readonly provider: PublicMarketDataProvider,
    private readonly store: CaptureStore,
    options: CollectorOptions = {},
  ) {
    this.watchSymbols = options.watchSymbols ?? DEFAULT_WATCH_SYMBOLS;
    this.orderBookDepth = options.orderBookDepth ?? 40;
    this.now = options.now ?? (() => new Date());
  }

  async collectOnce(): Promise<CollectorCycle> {
    const startedAt = this.now().toISOString();
    const errors: CollectionErrorRecord[] = [];
    const universe = await this.provider.discoverRealityInstruments();
    const instruments = new Map(
      universe.data.map((instrument) => [instrument.providerSymbol, instrument]),
    );
    let marketStateSnapshot: MarketStateSnapshot | null = null;
    try {
      const states = await this.provider.getMarketStates();
      marketStateSnapshot = await this.store.saveMarketStateSnapshot({
        data: states.data,
        providerTimestamp: states.source.providerTimestamp,
        receivedAt: states.source.receivedAt,
        source: states.source,
      });
    } catch (error) {
      await this.recordError(errors, 'all', 'market-state', error);
    }

    const symbols: CollectedSymbol[] = [];
    for (const providerSymbol of this.watchSymbols) {
      const instrument = instruments.get(providerSymbol);
      if (instrument === undefined) {
        symbols.push({
          providerSymbol,
          nativeTicker: null,
          mappingStatus: 'unmapped',
          marketSnapshotId: null,
          orderBookSnapshotId: null,
          marketStateSnapshotId: marketStateSnapshot?.snapshotId ?? null,
          tickerFreshness: null,
          bookFreshness: null,
          errors: ['provider symbol was not present in the current Reality universe'],
        });
        await this.recordError(
          errors,
          providerSymbol,
          'resolve-instrument',
          new Error('provider symbol was not present in the current Reality universe'),
        );
        continue;
      }
      await this.store.saveInstrument({
        providerSymbol,
        instrument,
        capturedAt: universe.source.receivedAt,
      });
      symbols.push(
        await this.collectSymbol(providerSymbol, instrument, marketStateSnapshot, errors),
      );
    }

    return {
      startedAt,
      completedAt: this.now().toISOString(),
      watchSymbols: [...this.watchSymbols],
      symbols,
      marketStateSnapshotId: marketStateSnapshot?.snapshotId ?? null,
      errors,
    };
  }

  async createReplayCaseFromCapture(
    cycle: CollectorCycle,
    providerSymbol: string,
    manifestCreatedAt = this.now().toISOString(),
  ): Promise<ReplayCase> {
    const result = cycle.symbols.find((item) => item.providerSymbol === providerSymbol);
    if (!result?.marketSnapshotId || !result.orderBookSnapshotId) {
      throw new Error(
        `capture for ${providerSymbol} has no complete market and order-book snapshots`,
      );
    }
    const [instrument, marketSnapshot, orderBookSnapshot, marketStateSnapshot] = await Promise.all([
      this.store.getInstrument(providerSymbol),
      this.store.getMarketSnapshot(result.marketSnapshotId),
      this.store.getOrderBook(result.orderBookSnapshotId),
      result.marketStateSnapshotId === null
        ? Promise.resolve(null)
        : this.store.getMarketStateSnapshot(result.marketStateSnapshotId),
    ]);
    if (instrument === null || marketSnapshot === null || orderBookSnapshot === null) {
      throw new Error(`capture references for ${providerSymbol} could not be loaded`);
    }
    const replayAsOf = maxTimestamp(
      [
        marketSnapshot.receivedAt,
        orderBookSnapshot.receivedAt,
        marketStateSnapshot?.receivedAt,
      ].filter((value): value is string => value !== undefined),
    );
    const replayCase = createReplayCase({
      providerSymbol,
      nativeTicker: instrument.instrument.nativeTicker,
      replayAsOf,
      marketSnapshot,
      orderBookSnapshot,
      marketStateSnapshot,
      manifestCreatedAt,
    });
    return this.store.saveReplayCase(replayCase);
  }

  private async collectSymbol(
    providerSymbol: string,
    instrument: NormalizedRealityInstrument,
    marketStateSnapshot: MarketStateSnapshot | null,
    errors: CollectionErrorRecord[],
  ): Promise<CollectedSymbol> {
    const result: CollectedSymbol = {
      providerSymbol,
      nativeTicker: instrument.nativeTicker,
      mappingStatus: instrument.mappingStatus,
      marketSnapshotId: null,
      orderBookSnapshotId: null,
      marketStateSnapshotId: marketStateSnapshot?.snapshotId ?? null,
      tickerFreshness: null,
      bookFreshness: null,
      errors: [],
    };
    try {
      const ticker = await this.provider.getTicker(providerSymbol);
      const tickerFreshness = assessFreshness(
        ticker.source.providerTimestamp,
        ticker.source.receivedAt,
        this.now(),
      );
      result.tickerFreshness = tickerFreshness;
      if (tickerFreshness.state === 'unavailable') {
        const record = await this.recordError(
          errors,
          providerSymbol,
          'ticker-timestamp-validation',
          new Error(tickerFreshness.reason),
        );
        result.errors.push(record.message);
      }
      result.marketSnapshotId = (
        await this.store.saveMarketSnapshot(marketSnapshotInputFromTicker(ticker.data))
      ).snapshotId;
    } catch (error) {
      const record = await this.recordError(errors, providerSymbol, 'ticker', error);
      result.errors.push(record.message);
    }
    try {
      const orderBook = await this.provider.getOrderBook(providerSymbol, this.orderBookDepth);
      const bookFreshness = assessFreshness(
        orderBook.source.providerTimestamp,
        orderBook.source.receivedAt,
        this.now(),
      );
      result.bookFreshness = bookFreshness;
      if (bookFreshness.state === 'unavailable') {
        const record = await this.recordError(
          errors,
          providerSymbol,
          'orderbook-timestamp-validation',
          new Error(bookFreshness.reason),
        );
        result.errors.push(record.message);
      }
      result.orderBookSnapshotId = (await this.store.saveOrderBook(orderBook.data)).snapshotId;
    } catch (error) {
      const record = await this.recordError(errors, providerSymbol, 'orderbook', error);
      result.errors.push(record.message);
    }
    return result;
  }

  private async recordError(
    errors: CollectionErrorRecord[],
    providerSymbol: string,
    operation: string,
    error: unknown,
  ): Promise<CollectionErrorRecord> {
    const record: CollectionErrorRecord = {
      errorId: `${this.now().toISOString()}-${providerSymbol}-${operation}`,
      providerSymbol,
      operation,
      code: error instanceof ProbeError ? error.status : classifyThrownError(error),
      message: error instanceof Error ? error.message : String(error),
      occurredAt: this.now().toISOString(),
    };
    await this.store.appendCollectionError(record);
    if (!errors.some((item) => item.errorId === record.errorId)) errors.push(record);
    return record;
  }
}

function maxTimestamp(values: string[]): string {
  const sorted = [...values].sort((left, right) => Date.parse(left) - Date.parse(right));
  const latest = sorted.at(-1);
  if (latest === undefined || !Number.isFinite(Date.parse(latest))) {
    throw new Error('capture did not contain a valid source availability timestamp');
  }
  return latest;
}
