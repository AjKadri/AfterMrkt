import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/index.js';
import { QwenClient } from '../../src/adapters/qwen/index.js';
import { SecEdgarAdapter } from '../../src/adapters/sec/index.js';
import { buildQwenUsageLedger, EventAnalysisService } from '../../src/domain/event-analysis.js';
import { evaluatePostCloseWindow } from '../../src/domain/event-window.js';
import { createReplayCase } from '../../src/domain/replay.js';
import { marketSnapshotInputFromTicker } from '../../src/persistence/types.js';
import { FileCaptureStore } from '../../src/persistence/store.js';
import { writeTextFile } from '../../src/observability/evidence.js';

const nativeTicker = (process.env.AFTERMRKT_EVENT_TICKER ?? 'MU').trim().toUpperCase();
const dataDirectory = process.env.AFTERMRKT_DATA_DIR ?? join(process.cwd(), '.agent', 'data');
const provider = new BitgetPublicMarketDataAdapter();
const sec = new SecEdgarAdapter(
  process.env.SEC_USER_AGENT === undefined ? {} : { userAgent: process.env.SEC_USER_AGENT },
);
const store = new FileCaptureStore(dataDirectory);
const universe = await provider.discoverRealityInstruments();
const instrument = universe.data.find((item) => item.nativeTicker === nativeTicker);
if (instrument === undefined || instrument.nativeTicker === null) {
  throw new Error(`no mapped Reality instrument was found for ${nativeTicker}`);
}

const identity = await sec.getTickerCik(nativeTicker);
const filings = await sec.getRecentFilings(nativeTicker, 10);
const filing = filings[0];
if (filing === undefined) {
  throw new Error(`SEC returned no 8-K, 10-Q, or 10-K filing for ${nativeTicker}`);
}
const event = await store.saveSourceEvent(sec.toSourceEvent(filing, instrument.providerSymbol));

const [ticker, orderBook, markets, calendar, companyOverview] = await Promise.all([
  provider.getTicker(instrument.providerSymbol),
  provider.getOrderBook(instrument.providerSymbol),
  provider.getMarketStates(),
  provider.getMarketCalendar(),
  provider.getCompanyOverview(nativeTicker),
]);
const marketSnapshot = await store.saveMarketSnapshot(marketSnapshotInputFromTicker(ticker.data));
const orderBookSnapshot = await store.saveOrderBook(orderBook.data);
const marketStateSnapshot = await store.saveMarketStateSnapshot({
  data: markets.data,
  providerTimestamp: markets.source.providerTimestamp,
  receivedAt: markets.source.receivedAt,
  source: markets.source,
});

const client = new QwenClient({
  ...(process.env.QWEN_INPUT_PRICE_USD_PER_MILLION === undefined ||
  process.env.QWEN_OUTPUT_PRICE_USD_PER_MILLION === undefined
    ? {}
    : {
        inputPriceUsdPerMillion: process.env.QWEN_INPUT_PRICE_USD_PER_MILLION,
        outputPriceUsdPerMillion: process.env.QWEN_OUTPUT_PRICE_USD_PER_MILLION,
      }),
});
const analysisService = new EventAnalysisService(store, client);
const companyName = companyOverview.data[0]?.name ?? instrument.nativeName;
const analysis = (await analysisService.analyzeMany([event], companyName))[0];
if (analysis === undefined) {
  throw new Error('deduplicated event analysis did not produce a record');
}
const analyses = await store.listEventAnalyses(event.eventId);
const analysisProcessedAt = analysis.processedAt;
const replayAsOf = new Date().toISOString();
const replayCase = await store.saveReplayCase(
  createReplayCase({
    providerSymbol: instrument.providerSymbol,
    nativeTicker,
    replayAsOf,
    marketSnapshot,
    orderBookSnapshot,
    marketStateSnapshot,
    sourceEvents: [event],
    manifestCreatedAt: replayAsOf,
  }),
);
const postClose = evaluatePostCloseWindow({
  event,
  contextAsOf: replayAsOf,
  markets: markets.data,
  calendar: calendar.data,
});
const report = {
  reportType: 'aftermrkt-real-event-pipeline',
  generatedAt: replayAsOf,
  providerSymbol: instrument.providerSymbol,
  nativeTicker,
  instrument: {
    mappingStatus: instrument.mappingStatus,
    nativeName: instrument.nativeName,
    status: instrument.status,
  },
  sec: {
    cik: identity.cik,
    companyName: identity.companyName,
    filing: {
      accessionNumber: filing.accessionNumber,
      form: filing.form,
      filingDate: filing.filingDate,
      sourceUrl: filing.sourceUrl,
      sourceAvailableAt: event.sourceAvailableAt,
      retrievedAt: event.retrievedAt,
    },
  },
  event,
  postClose,
  analysis,
  usageLedger: buildQwenUsageLedger(analyses),
  analysisProcessedAt,
  replayCase: replayCase.manifest,
  sourceRefs: [
    ticker.source,
    orderBook.source,
    markets.source,
    calendar.source,
    companyOverview.source,
  ],
  limitations: [
    'The SEC excerpt is bounded filing metadata. The pipeline does not scrape or summarize full filing bodies.',
    'The Qwen result is source-bounded analysis and is not a price, direction, fair-value, or trading signal.',
    'The replay manifest separates sourceAvailableAt from analysisProcessedAt.',
  ],
};
const outputDirectory = join(
  process.cwd(),
  '.agent',
  'evidence',
  'event-pipeline',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, 'report.json');
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      outputPath,
      providerSymbol: instrument.providerSymbol,
      nativeTicker,
      eventId: event.eventId,
      analysisId: analysis.analysisId,
      analysisStatus: analysis.status,
      inputTokens: analysis.inputTokens,
      outputTokens: analysis.outputTokens,
      totalTokens: analysis.totalTokens,
      providerReportedCostUsd: analysis.providerReportedCostUsd,
      estimatedCost: analysis.estimatedCost,
      replayCaseId: replayCase.manifest.caseId,
    },
    null,
    2,
  ),
);
