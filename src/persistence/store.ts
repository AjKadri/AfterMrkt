import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../lib/canonical.js';
import { sha256 } from '../lib/hash.js';
import { orderBookSnapshotId } from '../domain/snapshots.js';
import type { EventAnalysis, SourceEvent } from '../contracts/events.js';
import type { NormalizedOrderBook, OrderBookSnapshot } from '../domain/types.js';
import type {
  CaptureStore,
  CollectionErrorRecord,
  HistoricalCandleSnapshot,
  HistoricalCandleSnapshotInput,
  MarketCalendarSnapshot,
  MarketCalendarSnapshotInput,
  MarketSnapshot,
  MarketSnapshotInput,
  MarketStateSnapshot,
  MarketStateSnapshotInput,
  EventReplayCase,
  PersistedInstrument,
  ReplayCase,
  ReplayOutcomeReference,
} from './types.js';

export class InMemoryCaptureStore implements CaptureStore {
  private readonly instruments = new Map<string, PersistedInstrument>();
  private readonly marketSnapshots = new Map<string, MarketSnapshot>();
  private readonly orderBooks = new Map<string, OrderBookSnapshot>();
  private readonly marketStates = new Map<string, MarketStateSnapshot>();
  private readonly marketCalendars = new Map<string, MarketCalendarSnapshot>();
  private readonly historicalCandles = new Map<string, HistoricalCandleSnapshot>();
  private readonly replayCases = new Map<string, ReplayCase>();
  private readonly eventReplayCases = new Map<string, EventReplayCase>();
  private readonly replayOutcomes = new Map<string, ReplayOutcomeReference>();
  private readonly collectionErrors = new Map<string, CollectionErrorRecord>();
  private readonly sourceEvents = new Map<string, SourceEvent>();
  private readonly eventAnalyses = new Map<string, EventAnalysis>();

  async saveInstrument(record: PersistedInstrument): Promise<PersistedInstrument> {
    const stored = deepFreeze(record);
    this.instruments.set(record.providerSymbol, stored);
    return stored;
  }

  async getInstrument(providerSymbol: string): Promise<PersistedInstrument | null> {
    return this.instruments.get(providerSymbol) ?? null;
  }

  async saveMarketSnapshot(snapshot: MarketSnapshotInput): Promise<MarketSnapshot> {
    const stored = deepFreeze({ ...snapshot, snapshotId: marketSnapshotId(snapshot) });
    const existing = this.marketSnapshots.get(stored.snapshotId);
    if (existing !== undefined) return existing;
    this.marketSnapshots.set(stored.snapshotId, stored);
    return stored;
  }

  async getMarketSnapshot(snapshotId: string): Promise<MarketSnapshot | null> {
    return this.marketSnapshots.get(snapshotId) ?? null;
  }

  async saveOrderBook(snapshot: NormalizedOrderBook): Promise<OrderBookSnapshot> {
    const stored = deepFreeze({ ...snapshot, snapshotId: orderBookSnapshotId(snapshot) });
    const existing = this.orderBooks.get(stored.snapshotId);
    if (existing !== undefined) return existing;
    this.orderBooks.set(stored.snapshotId, stored);
    return stored;
  }

  async getOrderBook(snapshotId: string): Promise<OrderBookSnapshot | null> {
    return this.orderBooks.get(snapshotId) ?? null;
  }

  async saveMarketStateSnapshot(snapshot: MarketStateSnapshotInput): Promise<MarketStateSnapshot> {
    const stored = deepFreeze({ ...snapshot, snapshotId: marketStateSnapshotId(snapshot) });
    const existing = this.marketStates.get(stored.snapshotId);
    if (existing !== undefined) return existing;
    this.marketStates.set(stored.snapshotId, stored);
    return stored;
  }

  async getMarketStateSnapshot(snapshotId: string): Promise<MarketStateSnapshot | null> {
    return this.marketStates.get(snapshotId) ?? null;
  }

  async saveMarketCalendarSnapshot(
    snapshot: MarketCalendarSnapshotInput,
  ): Promise<MarketCalendarSnapshot> {
    const stored = deepFreeze({ ...snapshot, snapshotId: marketCalendarSnapshotId(snapshot) });
    const existing = this.marketCalendars.get(stored.snapshotId);
    if (existing !== undefined) return existing;
    this.marketCalendars.set(stored.snapshotId, stored);
    return stored;
  }

  async getMarketCalendarSnapshot(snapshotId: string): Promise<MarketCalendarSnapshot | null> {
    return this.marketCalendars.get(snapshotId) ?? null;
  }

  async saveHistoricalCandleSnapshot(
    snapshot: HistoricalCandleSnapshotInput,
  ): Promise<HistoricalCandleSnapshot> {
    const stored = deepFreeze({ ...snapshot, snapshotId: historicalCandleSnapshotId(snapshot) });
    const existing = this.historicalCandles.get(stored.snapshotId);
    if (existing !== undefined) return existing;
    this.historicalCandles.set(stored.snapshotId, stored);
    return stored;
  }

  async getHistoricalCandleSnapshot(snapshotId: string): Promise<HistoricalCandleSnapshot | null> {
    return this.historicalCandles.get(snapshotId) ?? null;
  }

  async saveReplayCase(replayCase: ReplayCase): Promise<ReplayCase> {
    const existing = this.replayCases.get(replayCase.manifest.caseId);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(replayCase)) {
        throw new Error(`immutable replay case conflict at ${replayCase.manifest.caseId}`);
      }
      return existing;
    }
    const stored = deepFreeze(replayCase);
    this.replayCases.set(replayCase.manifest.caseId, stored);
    return stored;
  }

  async getReplayCase(caseId: string): Promise<ReplayCase | null> {
    return this.replayCases.get(caseId) ?? null;
  }

  async listReplayCases(): Promise<ReplayCase[]> {
    return [...this.replayCases.values()].sort((left, right) =>
      left.manifest.replayAsOf.localeCompare(right.manifest.replayAsOf),
    );
  }

  async saveEventReplayCase(replayCase: EventReplayCase): Promise<EventReplayCase> {
    const existing = this.eventReplayCases.get(replayCase.manifest.caseId);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(replayCase)) {
        throw new Error(`immutable event replay case conflict at ${replayCase.manifest.caseId}`);
      }
      return existing;
    }
    const stored = deepFreeze(replayCase);
    this.eventReplayCases.set(replayCase.manifest.caseId, stored);
    return stored;
  }

  async getEventReplayCase(caseId: string): Promise<EventReplayCase | null> {
    return this.eventReplayCases.get(caseId) ?? null;
  }

  async listEventReplayCases(): Promise<EventReplayCase[]> {
    return [...this.eventReplayCases.values()].sort((left, right) =>
      left.manifest.replayAsOf.localeCompare(right.manifest.replayAsOf),
    );
  }

  async saveReplayOutcome(outcome: ReplayOutcomeReference): Promise<ReplayOutcomeReference> {
    const existing = this.replayOutcomes.get(outcome.outcomeId);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(outcome)) {
        throw new Error(`immutable replay outcome conflict at ${outcome.outcomeId}`);
      }
      return existing;
    }
    const stored = deepFreeze(outcome);
    this.replayOutcomes.set(outcome.outcomeId, stored);
    return stored;
  }

  async listReplayOutcomes(caseId: string): Promise<ReplayOutcomeReference[]> {
    return [...this.replayOutcomes.values()].filter((outcome) => outcome.caseId === caseId);
  }

  async appendCollectionError(record: CollectionErrorRecord): Promise<CollectionErrorRecord> {
    const stored = deepFreeze(record);
    this.collectionErrors.set(record.errorId, stored);
    return stored;
  }

  async saveSourceEvent(event: SourceEvent): Promise<SourceEvent> {
    const existing = this.sourceEvents.get(event.eventId);
    if (existing !== undefined) {
      if (
        canonicalJson(withoutKeys(existing, new Set(['retrievedAt']))) !==
        canonicalJson(withoutKeys(event, new Set(['retrievedAt'])))
      ) {
        throw new Error(`immutable source event conflict at ${event.eventId}`);
      }
      return existing;
    }
    const stored = deepFreeze(event);
    this.sourceEvents.set(event.eventId, stored);
    return stored;
  }

  async getSourceEvent(eventId: string): Promise<SourceEvent | null> {
    return this.sourceEvents.get(eventId) ?? null;
  }

  async listSourceEvents(providerSymbol?: string): Promise<SourceEvent[]> {
    return [...this.sourceEvents.values()]
      .filter((event) => providerSymbol === undefined || event.providerSymbol === providerSymbol)
      .sort((left, right) => left.sourceAvailableAt.localeCompare(right.sourceAvailableAt));
  }

  async saveEventAnalysis(analysis: EventAnalysis): Promise<EventAnalysis> {
    const existing = this.eventAnalyses.get(analysis.analysisId);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(analysis)) {
        throw new Error(`immutable event analysis conflict at ${analysis.analysisId}`);
      }
      return existing;
    }
    const stored = deepFreeze(analysis);
    this.eventAnalyses.set(analysis.analysisId, stored);
    return stored;
  }

  async getEventAnalysis(analysisId: string): Promise<EventAnalysis | null> {
    return this.eventAnalyses.get(analysisId) ?? null;
  }

  async listEventAnalyses(eventId?: string): Promise<EventAnalysis[]> {
    return [...this.eventAnalyses.values()]
      .filter((analysis) => eventId === undefined || analysis.eventId === eventId)
      .sort((left, right) => left.processedAt.localeCompare(right.processedAt));
  }
}

export class FileCaptureStore implements CaptureStore {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory;
  }

  async saveInstrument(record: PersistedInstrument): Promise<PersistedInstrument> {
    const path = this.path('instruments', `${sha256(record.providerSymbol)}.json`);
    await writeUpsert(path, record);
    return deepFreeze(record);
  }

  async getInstrument(providerSymbol: string): Promise<PersistedInstrument | null> {
    return readStored<PersistedInstrument>(
      this.path('instruments', `${sha256(providerSymbol)}.json`),
    );
  }

  async saveMarketSnapshot(snapshot: MarketSnapshotInput): Promise<MarketSnapshot> {
    const stored = { ...snapshot, snapshotId: marketSnapshotId(snapshot) };
    const path = this.path('market-snapshots', `${stored.snapshotId}.json`);
    const existing = await writeImmutable(path, stored, true);
    return deepFreeze((existing as MarketSnapshot | null) ?? stored);
  }

  async getMarketSnapshot(snapshotId: string): Promise<MarketSnapshot | null> {
    return readStored<MarketSnapshot>(this.path('market-snapshots', `${snapshotId}.json`));
  }

  async saveOrderBook(snapshot: NormalizedOrderBook): Promise<OrderBookSnapshot> {
    const stored = { ...snapshot, snapshotId: orderBookSnapshotId(snapshot) };
    const path = this.path('order-book-snapshots', `${stored.snapshotId}.json`);
    const existing = await writeImmutable(path, stored, true);
    return deepFreeze((existing as OrderBookSnapshot | null) ?? stored);
  }

  async getOrderBook(snapshotId: string): Promise<OrderBookSnapshot | null> {
    return readStored<OrderBookSnapshot>(this.path('order-book-snapshots', `${snapshotId}.json`));
  }

  async saveMarketStateSnapshot(snapshot: MarketStateSnapshotInput): Promise<MarketStateSnapshot> {
    const stored = { ...snapshot, snapshotId: marketStateSnapshotId(snapshot) };
    const path = this.path('market-state-snapshots', `${stored.snapshotId}.json`);
    const existing = await writeImmutable(path, stored, true);
    return deepFreeze((existing as MarketStateSnapshot | null) ?? stored);
  }

  async getMarketStateSnapshot(snapshotId: string): Promise<MarketStateSnapshot | null> {
    return readStored<MarketStateSnapshot>(
      this.path('market-state-snapshots', `${snapshotId}.json`),
    );
  }

  async saveMarketCalendarSnapshot(
    snapshot: MarketCalendarSnapshotInput,
  ): Promise<MarketCalendarSnapshot> {
    const stored = { ...snapshot, snapshotId: marketCalendarSnapshotId(snapshot) };
    const path = this.path('market-calendar-snapshots', `${stored.snapshotId}.json`);
    const existing = await writeImmutable(path, stored, true);
    return deepFreeze((existing as MarketCalendarSnapshot | null) ?? stored);
  }

  async getMarketCalendarSnapshot(snapshotId: string): Promise<MarketCalendarSnapshot | null> {
    return readStored<MarketCalendarSnapshot>(
      this.path('market-calendar-snapshots', `${snapshotId}.json`),
    );
  }

  async saveHistoricalCandleSnapshot(
    snapshot: HistoricalCandleSnapshotInput,
  ): Promise<HistoricalCandleSnapshot> {
    const stored = { ...snapshot, snapshotId: historicalCandleSnapshotId(snapshot) };
    const path = this.path('historical-candle-snapshots', `${stored.snapshotId}.json`);
    const existing = await writeImmutable(path, stored, true);
    return deepFreeze((existing as HistoricalCandleSnapshot | null) ?? stored);
  }

  async getHistoricalCandleSnapshot(snapshotId: string): Promise<HistoricalCandleSnapshot | null> {
    return readStored<HistoricalCandleSnapshot>(
      this.path('historical-candle-snapshots', `${snapshotId}.json`),
    );
  }

  async saveReplayCase(replayCase: ReplayCase): Promise<ReplayCase> {
    const path = this.path('replay-cases', `${replayCase.manifest.caseId}.json`);
    const existing = await writeImmutable(path, replayCase);
    return deepFreeze((existing as ReplayCase | null) ?? replayCase);
  }

  async getReplayCase(caseId: string): Promise<ReplayCase | null> {
    return readStored<ReplayCase>(this.path('replay-cases', `${caseId}.json`));
  }

  async listReplayCases(): Promise<ReplayCase[]> {
    const { readdir } = await import('node:fs/promises');
    let names: string[];
    try {
      names = await readdir(this.path('replay-cases'));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const cases = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map((name) => readStored<ReplayCase>(this.path('replay-cases', name))),
    );
    return cases
      .filter((replayCase): replayCase is ReplayCase => replayCase !== null)
      .sort((left, right) => left.manifest.replayAsOf.localeCompare(right.manifest.replayAsOf));
  }

  async saveEventReplayCase(replayCase: EventReplayCase): Promise<EventReplayCase> {
    const path = this.path('event-replay-cases', `${replayCase.manifest.caseId}.json`);
    const existing = await writeImmutable(path, replayCase);
    return deepFreeze((existing as EventReplayCase | null) ?? replayCase);
  }

  async getEventReplayCase(caseId: string): Promise<EventReplayCase | null> {
    return readStored<EventReplayCase>(this.path('event-replay-cases', `${caseId}.json`));
  }

  async listEventReplayCases(): Promise<EventReplayCase[]> {
    const cases = await readDirectoryRecords<EventReplayCase>(this.path('event-replay-cases'));
    return cases.sort((left, right) =>
      left.manifest.replayAsOf.localeCompare(right.manifest.replayAsOf),
    );
  }

  async saveReplayOutcome(outcome: ReplayOutcomeReference): Promise<ReplayOutcomeReference> {
    const path = this.path('replay-outcomes', `${outcome.outcomeId}.json`);
    const existing = await writeImmutable(path, outcome);
    return deepFreeze((existing as ReplayOutcomeReference | null) ?? outcome);
  }

  async listReplayOutcomes(caseId: string): Promise<ReplayOutcomeReference[]> {
    const { readdir } = await import('node:fs/promises');
    let names: string[];
    try {
      names = await readdir(this.path('replay-outcomes'));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const outcomes = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map((name) => readStored<ReplayOutcomeReference>(this.path('replay-outcomes', name))),
    );
    return outcomes
      .filter((outcome): outcome is ReplayOutcomeReference => outcome !== null)
      .filter((outcome) => outcome.caseId === caseId)
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  }

  async appendCollectionError(record: CollectionErrorRecord): Promise<CollectionErrorRecord> {
    const path = this.path('collection-errors', `${record.errorId}.json`);
    await writeImmutable(path, record);
    return deepFreeze(record);
  }

  async saveSourceEvent(event: SourceEvent): Promise<SourceEvent> {
    const path = this.path('source-events', `${event.eventId}.json`);
    const existing = await writeImmutable(path, event, false, ['retrievedAt']);
    return deepFreeze((existing as SourceEvent | null) ?? event);
  }

  async getSourceEvent(eventId: string): Promise<SourceEvent | null> {
    return readStored<SourceEvent>(this.path('source-events', `${eventId}.json`));
  }

  async listSourceEvents(providerSymbol?: string): Promise<SourceEvent[]> {
    const events = await readDirectoryRecords<SourceEvent>(this.path('source-events'));
    return events
      .filter((event) => providerSymbol === undefined || event.providerSymbol === providerSymbol)
      .sort((left, right) => left.sourceAvailableAt.localeCompare(right.sourceAvailableAt));
  }

  async saveEventAnalysis(analysis: EventAnalysis): Promise<EventAnalysis> {
    const path = this.path('event-analyses', `${analysis.analysisId}.json`);
    const existing = await writeImmutable(path, analysis);
    return deepFreeze((existing as EventAnalysis | null) ?? analysis);
  }

  async getEventAnalysis(analysisId: string): Promise<EventAnalysis | null> {
    return readStored<EventAnalysis>(this.path('event-analyses', `${analysisId}.json`));
  }

  async listEventAnalyses(eventId?: string): Promise<EventAnalysis[]> {
    const analyses = await readDirectoryRecords<EventAnalysis>(this.path('event-analyses'));
    return analyses
      .filter((analysis) => eventId === undefined || analysis.eventId === eventId)
      .sort((left, right) => left.processedAt.localeCompare(right.processedAt));
  }

  private path(directory: string, filename?: string): string {
    return filename === undefined
      ? join(this.rootDirectory, directory)
      : join(this.rootDirectory, directory, filename);
  }
}

export function marketSnapshotId(snapshot: MarketSnapshotInput): string {
  return sha256(
    canonicalJson({
      providerSymbol: snapshot.providerSymbol,
      lastPrice: snapshot.lastPrice,
      bidPrice: snapshot.bidPrice,
      bidSize: snapshot.bidSize,
      askPrice: snapshot.askPrice,
      askSize: snapshot.askSize,
      baseVolume: snapshot.baseVolume,
      volume24h: snapshot.volume24h,
      quoteVolume: snapshot.quoteVolume,
      usdtVolume: snapshot.usdtVolume,
      turnover24h: snapshot.turnover24h,
      platformTurnover24h: snapshot.platformTurnover24h,
      providerTimestamp: snapshot.providerTimestamp,
      sourceId: snapshot.source.sourceId,
      rawResponseHash: snapshot.source.rawResponseHash,
    }),
  );
}

export function marketStateSnapshotId(snapshot: MarketStateSnapshotInput): string {
  return sha256(
    canonicalJson({
      data: snapshot.data,
      providerTimestamp: snapshot.providerTimestamp,
      sourceId: snapshot.source.sourceId,
      rawResponseHash: snapshot.source.rawResponseHash,
    }),
  );
}

export function marketCalendarSnapshotId(snapshot: MarketCalendarSnapshotInput): string {
  return sha256(
    canonicalJson({
      data: snapshot.data,
      providerTimestamp: snapshot.providerTimestamp,
      sourceId: snapshot.source.sourceId,
      rawResponseHash: snapshot.source.rawResponseHash,
    }),
  );
}

export function historicalCandleSnapshotId(snapshot: HistoricalCandleSnapshotInput): string {
  return sha256(
    canonicalJson({
      providerSymbol: snapshot.providerSymbol,
      interval: snapshot.interval,
      data: snapshot.data,
      providerTimestamp: snapshot.providerTimestamp,
      sourceId: snapshot.source.sourceId,
      rawResponseHash: snapshot.source.rawResponseHash,
    }),
  );
}

async function writeUpsert(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

async function writeImmutable(
  path: string,
  value: unknown,
  ignoreReceivedAt = false,
  ignoredKeys: string[] = [],
): Promise<unknown | null> {
  const existing = await readStored<unknown>(path);
  if (existing !== null) {
    const keys = new Set(ignoredKeys);
    if (ignoreReceivedAt) keys.add('receivedAt');
    const existingComparable = keys.size === 0 ? existing : withoutKeys(existing, keys);
    const valueComparable = keys.size === 0 ? value : withoutKeys(value, keys);
    if (canonicalJson(existingComparable) !== canonicalJson(valueComparable)) {
      throw new Error(`immutable capture conflict at ${path}`);
    }
    return existing;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
  return null;
}

function withoutKeys(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutKeys(item, keys));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => !keys.has(key))
        .map(([key, child]) => [key, withoutKeys(child, keys)]),
    );
  }
  return value;
}

async function readStored<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, 'utf8');
    return deepFreeze(JSON.parse(content) as T);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readDirectoryRecords<T>(directory: string): Promise<T[]> {
  const { readdir } = await import('node:fs/promises');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) => readStored<T>(join(directory, name))),
  );
  return records.filter((record) => record !== null) as T[];
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
