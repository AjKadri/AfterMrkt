import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/index.js';
import { EventReplayEngine, createEventReplayCase } from '../../src/domain/replay.js';
import { FileCaptureStore } from '../../src/persistence/store.js';
import { writeTextFile } from '../../src/observability/evidence.js';

const dataDirectory =
  process.env.AFTERMRKT_EVENT_DATA_DIR ?? join(process.cwd(), '.agent', 'data-task4-proof-v4');
const providerSymbol = process.env.AFTERMRKT_CONTEXT_SYMBOL ?? 'RNVDAUSDT';
const replayAsOf = '2026-08-26T20:51:19.000Z';
const regularClose = '2026-08-26T20:00:00.000Z';
const store = new FileCaptureStore(dataDirectory);
const provider = new BitgetPublicMarketDataAdapter();
const existingCase = (await store.listEventReplayCases()).find(
  (item) =>
    item.manifest.providerSymbol === providerSymbol && item.manifest.replayAsOf === replayAsOf,
);
if (existingCase === undefined) throw new Error('preserved NVDA event replay case was not found');
const [universe, markets, calendar] = await Promise.all([
  provider.discoverRealityInstruments(),
  provider.getMarketStates(),
  provider.getMarketCalendar(),
]);
const instrument = universe.data.find((item) => item.providerSymbol === providerSymbol);
if (instrument === undefined) throw new Error(`provider symbol ${providerSymbol} was not found`);
const events = await store.listSourceEvents(providerSymbol);
const historicalCandles = await provider.getHistoricalCandles(providerSymbol, {
  interval: '1m',
  limit: 100,
  endTime: String(Date.parse(regularClose)),
});
const marketStateSnapshot = await store.saveMarketStateSnapshot({
  data: markets.data,
  providerTimestamp: markets.source.providerTimestamp,
  receivedAt: markets.source.receivedAt,
  source: markets.source,
});
const marketCalendarSnapshot = await store.saveMarketCalendarSnapshot({
  data: calendar.data,
  providerTimestamp: calendar.source.providerTimestamp,
  receivedAt: calendar.source.receivedAt,
  source: calendar.source,
});
const historicalCandleSnapshot = await store.saveHistoricalCandleSnapshot({
  providerSymbol,
  interval: '1m',
  data: historicalCandles.data,
  providerTimestamp: historicalCandles.source.providerTimestamp,
  receivedAt: historicalCandles.source.receivedAt,
  source: historicalCandles.source,
});
const replayCase = await store.saveEventReplayCase(
  createEventReplayCase({
    providerSymbol,
    nativeTicker: instrument.nativeTicker,
    replayAsOf,
    sourceEvents: events,
    instrument,
    marketStateSnapshot,
    marketCalendarSnapshot,
    historicalCandleSnapshot,
    manifestCreatedAt: new Date().toISOString(),
  }),
);
const context = await new EventReplayEngine(store).context(replayCase.manifest.caseId);
const report = {
  reportType: 'aftermrkt-historical-nvda-unified-context',
  generatedAt: new Date().toISOString(),
  preservedEventReplayCaseId: existingCase.manifest.caseId,
  contextReplayCaseId: replayCase.manifest.caseId,
  preservedTiming: {
    regularClose,
    sourceAvailableAt: '2026-08-26T20:21:19.000Z',
    replayAsOf,
    nextOpen: '2026-08-27T13:30:00.000Z',
  },
  context,
  evidence: {
    historicalCandlesSource: historicalCandles.source,
    historicalCandleSnapshotId: historicalCandleSnapshot.snapshotId,
    noModernOrderBookUsed: context.liquidityContext.metrics === null,
    qwenCalled: false,
  },
};
const outputDirectory = join(
  process.cwd(),
  '.agent',
  'evidence',
  'context-replay',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, 'report.json');
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, ...report }, null, 2));
