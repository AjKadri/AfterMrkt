import { canonicalJson } from '../lib/canonical.js';
import { sha256 } from '../lib/hash.js';
import type { EventAnalysis, SourceEvent } from '../contracts/events.js';
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
  EventReplayCase,
  EventReplayManifest,
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
  sourceEvents?: SourceEvent[];
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
    events: SourceEvent[];
    analyses: EventAnalysis[];
    laterAnalyses: EventAnalysis[];
  };
  sourceRefs: SourceReference[];
  warnings: string[];
  limitations: string[];
};

export type EventReplayManifestInput = {
  providerSymbol: string;
  nativeTicker: string | null;
  replayAsOf: string;
  sourceEvents: SourceEvent[];
  manifestCreatedAt: string;
};

export type EventReplayResult = {
  mode: 'REPLAY';
  asOf: string;
  caseId: string;
  manifestHash: string;
  data: {
    providerSymbol: string;
    nativeTicker: string | null;
    events: SourceEvent[];
    analyses: EventAnalysis[];
    laterAnalyses: EventAnalysis[];
  };
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
        eventIds: qualifyingEventIds(input.sourceEvents ?? [], input.replayAsOf),
      }),
    );
  const eventIds = qualifyingEventIds(input.sourceEvents ?? [], input.replayAsOf);
  const withoutHash = {
    caseId,
    providerSymbol: input.providerSymbol,
    nativeTicker: input.nativeTicker,
    replayAsOf: input.replayAsOf,
    marketSnapshotId: input.marketSnapshot.snapshotId,
    orderBookSnapshotId: input.orderBookSnapshot.snapshotId,
    marketStateSnapshotId: input.marketStateSnapshot?.snapshotId ?? null,
    sources,
    eventIds,
    manifestCreatedAt: input.manifestCreatedAt,
  } satisfies Omit<ReplayManifest, 'manifestHash'>;
  const manifest: ReplayManifest = {
    ...withoutHash,
    manifestHash: sha256(canonicalJson(withoutHash)),
  };
  return { manifest };
}

export function createEventReplayCase(input: EventReplayManifestInput): EventReplayCase {
  const replayMs = Date.parse(input.replayAsOf);
  if (!Number.isFinite(replayMs)) {
    throw new ReplayError('replay_manifest_invalid', 'replayAsOf is not a valid timestamp');
  }
  const eventIds = qualifyingEventIds(input.sourceEvents, input.replayAsOf);
  const caseId = sha256(
    canonicalJson({
      providerSymbol: input.providerSymbol,
      nativeTicker: input.nativeTicker,
      replayAsOf: input.replayAsOf,
      eventIds,
    }),
  );
  const withoutHash = {
    caseId,
    providerSymbol: input.providerSymbol,
    nativeTicker: input.nativeTicker,
    replayAsOf: input.replayAsOf,
    eventIds,
    manifestCreatedAt: input.manifestCreatedAt,
  } satisfies Omit<EventReplayManifest, 'manifestHash'>;
  return {
    manifest: {
      ...withoutHash,
      manifestHash: sha256(canonicalJson(withoutHash)),
    },
  };
}

export class EventReplayEngine {
  constructor(private readonly store: CaptureStore) {}

  async listCases(): Promise<EventReplayCase[]> {
    return this.store.listEventReplayCases();
  }

  async simulate(caseId: string): Promise<EventReplayResult> {
    const replayCase = await this.store.getEventReplayCase(caseId);
    if (replayCase === null) {
      throw new ReplayError('replay_case_not_found', `event replay case ${caseId} was not found`);
    }
    assertEventReplayManifestHash(replayCase.manifest);
    const events = await Promise.all(
      replayCase.manifest.eventIds.map((eventId) => this.store.getSourceEvent(eventId)),
    );
    const missingEventId = replayCase.manifest.eventIds.find((_, index) => events[index] === null);
    if (missingEventId !== undefined) {
      throw new ReplayError(
        'replay_snapshot_not_found',
        `event replay manifest references a missing source event ${missingEventId}`,
      );
    }
    const resolvedEvents = events.filter((event): event is SourceEvent => event !== null);
    assertEventsAvailableBy(replayCase.manifest.replayAsOf, resolvedEvents);
    const allAnalyses = (
      await Promise.all(resolvedEvents.map((event) => this.store.listEventAnalyses(event.eventId)))
    ).flat();
    const replayMs = Date.parse(replayCase.manifest.replayAsOf);
    const analyses = allAnalyses.filter((analysis) => Date.parse(analysis.processedAt) <= replayMs);
    const laterAnalyses = allAnalyses.filter(
      (analysis) => Date.parse(analysis.processedAt) > replayMs,
    );
    return {
      mode: 'REPLAY',
      asOf: replayCase.manifest.replayAsOf,
      caseId: replayCase.manifest.caseId,
      manifestHash: replayCase.manifest.manifestHash,
      data: {
        providerSymbol: replayCase.manifest.providerSymbol,
        nativeTicker: replayCase.manifest.nativeTicker,
        events: resolvedEvents,
        analyses,
        laterAnalyses,
      },
      warnings:
        laterAnalyses.length === 0
          ? []
          : ['analysis was generated later and is not part of the historical replay context'],
      limitations: [
        'Event replay uses immutable SEC source events and persisted analyses without provider calls.',
        'This event-only replay intentionally contains no fabricated historical market snapshots.',
        'Source availability and analysis processing time are kept separate.',
      ],
    };
  }
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
      await this.assertEventsAvailable(replayCase.manifest);
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
    const events = await this.loadReplayEvents(manifest);
    const [marketSnapshot, orderBookSnapshot, marketStateSnapshot, allAnalyses] = await Promise.all(
      [
        this.store.getMarketSnapshot(manifest.marketSnapshotId),
        this.store.getOrderBook(manifest.orderBookSnapshotId),
        manifest.marketStateSnapshotId === null
          ? Promise.resolve(null)
          : this.store.getMarketStateSnapshot(manifest.marketStateSnapshotId),
        Promise.all(events.map((event) => this.store.listEventAnalyses(event.eventId))).then(
          (groups) => groups.flat(),
        ),
      ],
    );
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
    const replayMs = replayTime.getTime();
    const analyses = allAnalyses.filter((analysis) => Date.parse(analysis.processedAt) <= replayMs);
    const laterAnalyses = allAnalyses.filter(
      (analysis) => Date.parse(analysis.processedAt) > replayMs,
    );
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
        events,
        analyses,
        laterAnalyses,
      },
      sourceRefs,
      warnings,
      limitations: [
        'Replay uses immutable captured provider responses and makes no external provider calls.',
        'Execution results are observed-book estimates, not guaranteed fills.',
        'Later outcome references are stored separately and never alter the captured state.',
        'Source availability and analysis processing time are kept separate. Analyses processed after replayAsOf are reported as laterAnalyses.',
      ],
    };
  }

  private async loadReplayEvents(manifest: ReplayManifest): Promise<SourceEvent[]> {
    const eventIds = manifest.eventIds ?? [];
    const events = await Promise.all(eventIds.map((eventId) => this.store.getSourceEvent(eventId)));
    const missing = eventIds.find((_, index) => events[index] === null);
    if (missing !== undefined) {
      throw new ReplayError(
        'replay_snapshot_not_found',
        `replay manifest references a missing source event ${missing}`,
      );
    }
    const resolved = events.filter((event): event is SourceEvent => event !== null);
    assertEventsAvailableBy(manifest.replayAsOf, resolved);
    return resolved;
  }

  private async assertEventsAvailable(manifest: ReplayManifest): Promise<void> {
    await this.loadReplayEvents(manifest);
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

function qualifyingEventIds(events: SourceEvent[], replayAsOf: string): string[] {
  const replayMs = Date.parse(replayAsOf);
  if (!Number.isFinite(replayMs)) {
    throw new ReplayError('replay_manifest_invalid', 'replayAsOf is not a valid timestamp');
  }
  return events
    .filter((event) => {
      const availableMs = Date.parse(event.sourceAvailableAt);
      if (!Number.isFinite(availableMs)) {
        throw new ReplayError(
          'replay_manifest_invalid',
          `source event ${event.eventId} has an invalid availability timestamp`,
        );
      }
      return availableMs <= replayMs;
    })
    .map((event) => event.eventId)
    .sort();
}

function assertEventsAvailableBy(replayAsOf: string, events: SourceEvent[]): void {
  const replayMs = Date.parse(replayAsOf);
  if (!Number.isFinite(replayMs)) {
    throw new ReplayError('replay_manifest_invalid', 'replayAsOf is not a valid timestamp');
  }
  for (const event of events) {
    const availableMs = Date.parse(event.sourceAvailableAt);
    if (!Number.isFinite(availableMs) || availableMs > replayMs) {
      throw new ReplayError(
        'replay_manifest_invalid',
        `source event ${event.eventId} was not available by replayAsOf`,
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

function assertEventReplayManifestHash(manifest: EventReplayManifest): void {
  const withoutHash = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'manifestHash'),
  );
  const expected = sha256(canonicalJson(withoutHash));
  if (expected !== manifest.manifestHash) {
    throw new ReplayError(
      'replay_manifest_invalid',
      'event replay manifest hash does not match its contents',
    );
  }
}
