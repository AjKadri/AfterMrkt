import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/index.js';
import { buildAfterMrktContext } from '../../src/domain/market-context.js';
import { deriveSessionContext } from '../../src/domain/event-window.js';
import { InMemorySnapshotStore } from '../../src/domain/snapshots.js';
import { FileCaptureStore } from '../../src/persistence/store.js';
import { writeTextFile } from '../../src/observability/evidence.js';
import type { SourceMetadata, SourceReference } from '../../src/domain/types.js';

const providerSymbol = process.env.AFTERMRKT_CONTEXT_SYMBOL ?? 'RNVDAUSDT';
const eventDataDirectory =
  process.env.AFTERMRKT_EVENT_DATA_DIR ?? join(process.cwd(), '.agent', 'data-task4-proof-v4');
const provider = new BitgetPublicMarketDataAdapter();
const eventStore = new FileCaptureStore(eventDataDirectory);
const snapshots = new InMemorySnapshotStore();
const asOf = new Date();

const [universe, markets, calendar, ticker, orderBook] = await Promise.all([
  provider.discoverRealityInstruments(),
  provider.getMarketStates(),
  provider.getMarketCalendar(),
  provider.getTicker(providerSymbol),
  provider.getOrderBook(providerSymbol, 40),
]);
const instrument = universe.data.find((item) => item.providerSymbol === providerSymbol);
if (instrument === undefined) throw new Error(`provider symbol ${providerSymbol} was not found`);
const marketSnapshot = snapshots.saveOrderBook(orderBook.data);
const session = deriveSessionContext({
  asOf: asOf.toISOString(),
  markets: markets.data,
  calendar: calendar.data,
});
const candles =
  session.previousRegularSessionClose === null
    ? null
    : await provider.getHistoricalCandles(providerSymbol, {
        interval: '1m',
        limit: 100,
        endTime: String(Date.parse(session.previousRegularSessionClose)),
      });
const suspension =
  instrument.nativeTicker === null
    ? null
    : await provider.getSuspensionResumptionInfo?.(instrument.nativeTicker);
const events = await eventStore.listSourceEvents(providerSymbol);
const analyses = await eventStore.listEventAnalyses();
const sourceRefs = [
  sourceReference(universe.source, providerSymbol, null),
  sourceReference(markets.source, null, null),
  sourceReference(calendar.source, null, null),
  sourceReference(ticker.source, providerSymbol, null),
  sourceReference(orderBook.source, providerSymbol, marketSnapshot.snapshotId),
  ...(candles === null ? [] : [sourceReference(candles.source, providerSymbol, null)]),
  ...(suspension === null || suspension === undefined
    ? []
    : [sourceReference(suspension.source, instrument.nativeTicker, null)]),
];
const context = buildAfterMrktContext({
  mode: 'LIVE',
  asOf: asOf.toISOString(),
  providerSymbol,
  instrument,
  ticker: ticker.data,
  orderBook: marketSnapshot,
  markets: markets.data,
  calendar: calendar.data,
  suspension: suspension?.data ?? null,
  suspensionStatus: suspension?.data.recordStatus ?? 'unavailable',
  candles:
    candles === null
      ? null
      : {
          data: candles.data,
          interval: '1m',
          source: candles.source,
          sourceRef: sourceReference(candles.source, providerSymbol, null),
        },
  events,
  analyses,
  sourceRefs,
});
const report = {
  reportType: 'aftermrkt-live-unified-context',
  generatedAt: new Date().toISOString(),
  realityUniverseCount: universe.data.length,
  providerSymbol,
  nativeTicker: instrument.nativeTicker,
  mappingStatus: instrument.mappingStatus,
  context,
  calculationNotes: {
    move: 'Exact Decimal arithmetic over the current rToken ticker and selected historical candle.',
    liquidity: 'Generic public bid/ask book metrics only. No requested position was supplied.',
    events: 'Persisted source events and analyses only. The probe did not call Qwen.',
  },
};
const outputDirectory = join(
  process.cwd(),
  '.agent',
  'evidence',
  'context',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, 'report.json');
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, ...report }, null, 2));

function sourceReference(
  source: SourceMetadata,
  providerSymbol: string | null,
  snapshotId: string | null,
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
