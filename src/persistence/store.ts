import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../lib/canonical.js';
import { sha256 } from '../lib/hash.js';
import { orderBookSnapshotId } from '../domain/snapshots.js';
import type { NormalizedOrderBook, OrderBookSnapshot } from '../domain/types.js';
import type {
  CaptureStore,
  CollectionErrorRecord,
  MarketSnapshot,
  MarketSnapshotInput,
  MarketStateSnapshot,
  MarketStateSnapshotInput,
  PersistedInstrument,
  ReplayCase,
  ReplayOutcomeReference,
} from './types.js';

export class InMemoryCaptureStore implements CaptureStore {
  private readonly instruments = new Map<string, PersistedInstrument>();
  private readonly marketSnapshots = new Map<string, MarketSnapshot>();
  private readonly orderBooks = new Map<string, OrderBookSnapshot>();
  private readonly marketStates = new Map<string, MarketStateSnapshot>();
  private readonly replayCases = new Map<string, ReplayCase>();
  private readonly replayOutcomes = new Map<string, ReplayOutcomeReference>();
  private readonly collectionErrors = new Map<string, CollectionErrorRecord>();

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
): Promise<unknown | null> {
  const existing = await readStored<unknown>(path);
  if (existing !== null) {
    const existingComparable = ignoreReceivedAt ? withoutReceivedAt(existing) : existing;
    const valueComparable = ignoreReceivedAt ? withoutReceivedAt(value) : value;
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

function withoutReceivedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutReceivedAt);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== 'receivedAt')
        .map(([key, child]) => [key, withoutReceivedAt(child)]),
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
