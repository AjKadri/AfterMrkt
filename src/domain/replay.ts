import { canonicalJson } from '../lib/canonical.js';
import { sha256 } from '../lib/hash.js';
import {
  calculateMarketMetrics,
  resolveMarketQualityConfig,
  simulateExit,
  type ExitSimulation,
  type MarketMetrics,
  type MarketQualityConfig,
} from './market-quality.js';
import { freshnessFromSource } from './freshness.js';
import type { SourceMetadata, SourceReference } from './types.js';
import type {
  CaptureStore,
  MarketSnapshot,
  MarketStateSnapshot,
  ReplayCase,
  ReplayManifest,
  ReplaySourceReference,
} from '../persistence/types.js';
import type { OrderBookSnapshot } from './types.js';

export type ReplayManifestInput = {
  caseId?: string;
  providerSymbol: string;
  nativeTicker: string | null;
  replayAsOf: string;
  marketSnapshot: MarketSnapshot;
  orderBookSnapshot: OrderBookSnapshot;
  marketStateSnapshot: MarketStateSnapshot | null;
  manifestCreatedAt: string;
};

export type ReplaySimulationInput = {
  requestedQuantity: string;
  maximumAcceptableSlippageBps?: string | undefined;
};

export type ReplaySimulationResult = {
  mode: 'REPLAY';
  asOf: string;
  caseId: string;
  manifestHash: string;
  freshness: ReturnType<typeof freshnessFromSource>;
  data: {
    providerSymbol: string;
    nativeTicker: string | null;
    marketSnapshot: MarketSnapshot;
    orderBookSnapshot: OrderBookSnapshot;
    marketStateSnapshot: MarketStateSnapshot | null;
    metrics: MarketMetrics;
    simulation: ExitSimulation;
  };
  sourceRefs: SourceReference[];
  warnings: string[];
  limitations: string[];
};

export function createReplayCase(input: ReplayManifestInput): ReplayCase {
  if (
    input.orderBookSnapshot.providerSymbol !== input.providerSymbol ||
    input.marketSnapshot.providerSymbol !== input.providerSymbol
  ) {
    throw new ReplayError(
      'replay_manifest_invalid',
      'replay snapshot symbols do not match the manifest provider symbol',
    );
  }
  const sources = [
    replaySourceFromMarket(input.marketSnapshot),
    replaySourceFromOrderBook(input.orderBookSnapshot),
    ...(input.marketStateSnapshot === null
      ? []
      : [replaySourceFromMarketState(input.marketStateSnapshot)]),
  ];
  assertSourcesAvailableBy(input.replayAsOf, sources);
  const caseId =
    input.caseId ??
    sha256(
      canonicalJson({
        providerSymbol: input.providerSymbol,
        replayAsOf: input.replayAsOf,
        marketSnapshotId: input.marketSnapshot.snapshotId,
        orderBookSnapshotId: input.orderBookSnapshot.snapshotId,
        marketStateSnapshotId: input.marketStateSnapshot?.snapshotId ?? null,
      }),
    );
  const withoutHash = {
    caseId,
    providerSymbol: input.providerSymbol,
    nativeTicker: input.nativeTicker,
    replayAsOf: input.replayAsOf,
    marketSnapshotId: input.marketSnapshot.snapshotId,
    orderBookSnapshotId: input.orderBookSnapshot.snapshotId,
    marketStateSnapshotId: input.marketStateSnapshot?.snapshotId ?? null,
    sources,
    manifestCreatedAt: input.manifestCreatedAt,
  } satisfies Omit<ReplayManifest, 'manifestHash'>;
  const manifest: ReplayManifest = {
    ...withoutHash,
    manifestHash: sha256(canonicalJson(withoutHash)),
  };
  return { manifest };
}

export class ReplayEngine {
  constructor(
    private readonly store: CaptureStore,
    private readonly qualityConfig: Partial<MarketQualityConfig> | undefined = undefined,
  ) {}

  async listCases(): Promise<ReplayCase[]> {
    return this.store.listReplayCases();
  }

  async getCase(caseId: string): Promise<ReplayCase | null> {
    const replayCase = await this.store.getReplayCase(caseId);
    if (replayCase !== null) {
      assertManifestHash(replayCase.manifest);
      assertSourcesAvailableBy(replayCase.manifest.replayAsOf, replayCase.manifest.sources);
    }
    return replayCase;
  }

  async simulate(caseId: string, input: ReplaySimulationInput): Promise<ReplaySimulationResult> {
    const replayCase = await this.store.getReplayCase(caseId);
    if (replayCase === null) {
      throw new ReplayError('replay_case_not_found', `replay case ${caseId} was not found`);
    }
    const { manifest } = replayCase;
    assertManifestHash(manifest);
    assertSourcesAvailableBy(manifest.replayAsOf, manifest.sources);
    const [marketSnapshot, orderBookSnapshot, marketStateSnapshot] = await Promise.all([
      this.store.getMarketSnapshot(manifest.marketSnapshotId),
      this.store.getOrderBook(manifest.orderBookSnapshotId),
      manifest.marketStateSnapshotId === null
        ? Promise.resolve(null)
        : this.store.getMarketStateSnapshot(manifest.marketStateSnapshotId),
    ]);
    if (marketSnapshot === null || orderBookSnapshot === null) {
      throw new ReplayError(
        'replay_snapshot_not_found',
        'replay manifest references a missing immutable snapshot',
      );
    }
    if (marketStateSnapshot === null && manifest.marketStateSnapshotId !== null) {
      throw new ReplayError(
        'replay_snapshot_not_found',
        'replay manifest references a missing market-state snapshot',
      );
    }
    if (orderBookSnapshot.providerSymbol !== manifest.providerSymbol) {
      throw new ReplayError(
        'replay_manifest_invalid',
        'replay order-book symbol does not match case',
      );
    }
    const replayTime = new Date(manifest.replayAsOf);
    if (!Number.isFinite(replayTime.getTime())) {
      throw new ReplayError('replay_manifest_invalid', 'replayAsOf is not a valid timestamp');
    }
    const qualityConfig = resolveMarketQualityConfig(this.qualityConfig);
    const metrics = calculateMarketMetrics(orderBookSnapshot, replayTime, qualityConfig);
    const simulation = simulateExit({
      providerSymbol: manifest.providerSymbol,
      requestedQuantity: input.requestedQuantity,
      snapshot: orderBookSnapshot,
      now: replayTime,
      ...(input.maximumAcceptableSlippageBps === undefined
        ? {}
        : { maximumAcceptableSlippageBps: input.maximumAcceptableSlippageBps }),
      config: qualityConfig,
    });
    const freshness = simulation.freshness;
    const sourceRefs = manifest.sources.map(toSourceReference);
    const warnings =
      freshness.state === 'fresh'
        ? []
        : [`Replay market data is ${freshness.state}: ${freshness.reason}`];
    return {
      mode: 'REPLAY',
      asOf: manifest.replayAsOf,
      caseId: manifest.caseId,
      manifestHash: manifest.manifestHash,
      freshness,
      data: {
        providerSymbol: manifest.providerSymbol,
        nativeTicker: manifest.nativeTicker,
        marketSnapshot,
        orderBookSnapshot,
        marketStateSnapshot,
        metrics,
        simulation,
      },
      sourceRefs,
      warnings,
      limitations: [
        'Replay uses immutable captured provider responses and makes no external provider calls.',
        'Execution results are observed-book estimates, not guaranteed fills.',
        'Later outcome references are stored separately and never alter the captured state.',
      ],
    };
  }
}

export class ReplayError extends Error {
  constructor(
    readonly code:
      'replay_case_not_found' | 'replay_snapshot_not_found' | 'replay_manifest_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

function replaySourceFromMarket(snapshot: MarketSnapshot): ReplaySourceReference {
  return {
    ...sourceReferenceFromMetadata(snapshot.source, snapshot.providerSymbol, snapshot.snapshotId),
    snapshotId: snapshot.snapshotId,
    sourceAvailableAt: snapshot.receivedAt,
    captureTimestamp: snapshot.receivedAt,
  };
}

function replaySourceFromOrderBook(snapshot: OrderBookSnapshot): ReplaySourceReference {
  return {
    ...sourceReferenceFromMetadata(snapshot.source, snapshot.providerSymbol, snapshot.snapshotId),
    snapshotId: snapshot.snapshotId,
    sourceAvailableAt: snapshot.receivedAt,
    captureTimestamp: snapshot.receivedAt,
  };
}

function replaySourceFromMarketState(snapshot: MarketStateSnapshot): ReplaySourceReference {
  return {
    ...sourceReferenceFromMetadata(snapshot.source, null, snapshot.snapshotId),
    snapshotId: snapshot.snapshotId,
    sourceAvailableAt: snapshot.receivedAt,
    captureTimestamp: snapshot.receivedAt,
  };
}

function toSourceReference(source: ReplaySourceReference): SourceReference {
  return {
    provider: source.provider,
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    providerSymbol: source.providerSymbol,
    snapshotId: source.snapshotId,
    endpoint: source.endpoint,
    rawResponseHash: source.rawResponseHash,
    providerTimestamp: source.providerTimestamp,
    receivedAt: source.receivedAt,
  };
}

function sourceReferenceFromMetadata(
  source: SourceMetadata,
  providerSymbol: string | null,
  snapshotId: string,
): SourceReference {
  return {
    provider: source.provider,
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    providerSymbol,
    snapshotId,
    endpoint: source.endpoint,
    rawResponseHash: source.rawResponseHash,
    providerTimestamp: source.providerTimestamp,
    receivedAt: source.receivedAt,
  };
}

function assertSourcesAvailableBy(replayAsOf: string, sources: ReplaySourceReference[]): void {
  const replayMs = Date.parse(replayAsOf);
  if (!Number.isFinite(replayMs)) {
    throw new ReplayError('replay_manifest_invalid', 'replayAsOf is not a valid timestamp');
  }
  for (const source of sources) {
    const availableMs = Date.parse(source.sourceAvailableAt);
    if (!Number.isFinite(availableMs)) {
      throw new ReplayError(
        'replay_manifest_invalid',
        `source ${source.snapshotId} has an invalid availability timestamp`,
      );
    }
    if (availableMs > replayMs) {
      throw new ReplayError(
        'replay_manifest_invalid',
        `source ${source.snapshotId} became available after replayAsOf and is excluded`,
      );
    }
  }
}

function assertManifestHash(manifest: ReplayManifest): void {
  const withoutHash = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'manifestHash'),
  );
  const expected = sha256(canonicalJson(withoutHash));
  if (expected !== manifest.manifestHash) {
    throw new ReplayError(
      'replay_manifest_invalid',
      'replay manifest hash does not match its contents',
    );
  }
}
