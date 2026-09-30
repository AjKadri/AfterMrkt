import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/index.js';
import { QwenClient } from '../../src/adapters/qwen/index.js';
import {
  SecEdgarAdapter,
  type SecFiling,
  type SecFilingContent,
} from '../../src/adapters/sec/index.js';
import { buildQwenUsageLedger, EventAnalysisService } from '../../src/domain/event-analysis.js';
import { createEventReplayCase, EventReplayEngine } from '../../src/domain/replay.js';
import {
  evaluatePostCloseWindow,
  resolveNextRegularSessionOpen,
  resolveRegularSessionClose,
} from '../../src/domain/event-window.js';
import { FileCaptureStore } from '../../src/persistence/store.js';
import { writeTextFile } from '../../src/observability/evidence.js';
import type { NormalizedRealityInstrument } from '../../src/domain/types.js';
import type { SourceEvent } from '../../src/contracts/events.js';

const preferredTickers = (process.env.AFTERMRKT_EVENT_TICKERS ?? 'NVDA,TSLA,AAPL,META,MSFT,AMZN,MU')
  .split(',')
  .map((ticker) => ticker.trim().toUpperCase())
  .filter(Boolean);
const dataDirectory = process.env.AFTERMRKT_DATA_DIR ?? join(process.cwd(), '.agent', 'data-task4');
const provider = new BitgetPublicMarketDataAdapter();
const sec = new SecEdgarAdapter(
  process.env.SEC_USER_AGENT === undefined ? {} : { userAgent: process.env.SEC_USER_AGENT },
);
const store = new FileCaptureStore(dataDirectory);
const [universe, markets, calendar] = await Promise.all([
  provider.discoverRealityInstruments(),
  provider.getMarketStates(),
  provider.getMarketCalendar(),
]);
const historicalCase = await findHistoricalPostCloseCase(
  universe.data,
  markets.data,
  calendar.data,
);
const { instrument, identity, filing, content, event, regularSessionClose, replayAsOf, nextOpen } =
  historicalCase;
const savedEvent = await store.saveSourceEvent(event);

const companyOverview = await provider.getCompanyOverview(identity.ticker);
const verifiedCompanyName = companyOverview.data[0]?.name ?? identity.companyName;
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
const analysis = await analysisService.analyze(savedEvent, verifiedCompanyName);

const futureSourceEvent = await findFutureSourceEvent(
  instrument,
  filing,
  replayAsOf,
  await sec.getRecentFilings(identity.ticker, 40),
);
const replayInputs = futureSourceEvent === null ? [savedEvent] : [savedEvent, futureSourceEvent];
if (futureSourceEvent !== null) await store.saveSourceEvent(futureSourceEvent);
const eventReplayCase = await store.saveEventReplayCase(
  createEventReplayCase({
    providerSymbol: instrument.providerSymbol,
    nativeTicker: identity.ticker,
    replayAsOf,
    sourceEvents: replayInputs,
    manifestCreatedAt: new Date().toISOString(),
  }),
);
const replay = await new EventReplayEngine(store).simulate(eventReplayCase.manifest.caseId);

const muNegative = await buildMuNegativeCase(markets.data, calendar.data);
const analyses = await store.listEventAnalyses(savedEvent.eventId);
const generatedAt = new Date().toISOString();
const report = {
  reportType: 'aftermrkt-real-post-close-event-proof',
  generatedAt,
  realityUniverseCount: universe.data.length,
  instrument: {
    providerSymbol: instrument.providerSymbol,
    nativeTicker: identity.ticker,
    mappingStatus: instrument.mappingStatus,
    verifiedCompanyName,
  },
  timing: {
    regularSessionClose,
    sourceAvailableAt: event.sourceAvailableAt,
    replayAsOf,
    nextRegularSessionOpen: nextOpen,
    postClose: evaluatePostCloseWindow({
      event,
      contextAsOf: replayAsOf,
      markets: markets.data,
      calendar: calendar.data,
    }),
    replayBeforeNextSessionOpen: nextOpen !== null && Date.parse(replayAsOf) < Date.parse(nextOpen),
  },
  sec: {
    cik: identity.cik,
    companyName: identity.companyName,
    form: filing.form,
    accessionNumber: filing.accessionNumber,
    primaryDocument: filing.primaryDocument,
    sourceUrl: filing.sourceUrl,
    acceptedTimestamp: filing.acceptanceTimestamp,
    retrievedAt: content.retrievedAt,
    contentHash: content.contentHash,
    contentResponseHash: content.contentResponseHash,
    itemIds: filing.items,
    relevantItemIds: content.relevantItemIds,
    extractionStatus: content.extractionStatus,
    sanitizedTextLength: content.sanitizedTextLength,
    boundedExcerptChars: content.boundedExcerpt.length,
    excerptStartOffset: content.excerptStartOffset,
    excerptEndOffset: content.excerptEndOffset,
  },
  analysis: {
    analysisId: analysis.analysisId,
    eventId: analysis.eventId,
    model: analysis.model,
    providerReportedModel: analysis.providerReportedModel,
    thinkingMode: analysis.thinkingMode,
    promptVersion: analysis.promptVersion,
    schemaVersion: analysis.schemaVersion,
    status: analysis.status,
    materiality: analysis.materiality,
    eventType: analysis.eventType,
    facts: analysis.facts,
    factCount: analysis.facts.length,
    uncertaintyCount: analysis.uncertainties.length,
    uncertainties: analysis.uncertainties,
    evidenceSpans: analysis.evidenceSpans,
    sourceBound: analysis.sourceBound,
    inputTokens: analysis.inputTokens,
    reasoningTokens: analysis.reasoningTokens,
    outputTokens: analysis.outputTokens,
    totalTokens: analysis.totalTokens,
    cachedTokens: analysis.cacheTokens,
    latencyMs: analysis.latencyMs,
    providerReportedCostUsd: analysis.providerReportedCostUsd,
    estimatedCostUsd: analysis.estimatedCost,
    attemptCount: analysis.attemptCount,
    retryReason: analysis.retryReason,
    errorCode: analysis.errorCode,
    validationIssues: analysis.validationIssues,
  },
  replay: {
    manifest: eventReplayCase.manifest,
    includedEventIds: replay.data.events.map((item) => item.eventId),
    includedAnalysisIds: replay.data.analyses.map((item) => item.analysisId),
    laterAnalysisIds: replay.data.laterAnalyses.map((item) => item.analysisId),
    futureSourceEventIdExcluded:
      futureSourceEvent === null
        ? null
        : !replay.data.events.some((item) => item.eventId === futureSourceEvent.eventId),
    contextStateAtReplay: replay.data.analyses.length > 0 ? 'event-supported' : 'analysis-pending',
    limitations: replay.limitations,
  },
  muNegativeCase: muNegative,
  usageLedger: buildQwenUsageLedger(analyses),
  limitations: [
    'The event proof uses an event-only replay because current market snapshots cannot be relabeled as historical.',
    'The Qwen result is source-bounded evidence, not a price, direction, fair-value, or trading signal.',
    'No chain-of-thought or reasoning content is persisted. Only provider-reported reasoning token counts are retained when exposed.',
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
      nativeTicker: identity.ticker,
      eventId: event.eventId,
      analysisId: analysis.analysisId,
      analysisStatus: analysis.status,
      thinkingMode: analysis.thinkingMode,
      inputTokens: analysis.inputTokens,
      reasoningTokens: analysis.reasoningTokens,
      outputTokens: analysis.outputTokens,
      latencyMs: analysis.latencyMs,
      replayCaseId: eventReplayCase.manifest.caseId,
      includedEventIds: replay.data.events.map((item) => item.eventId),
      laterAnalysisIds: replay.data.laterAnalyses.map((item) => item.analysisId),
    },
    null,
    2,
  ),
);

async function findHistoricalPostCloseCase(
  instruments: NormalizedRealityInstrument[],
  marketStates: Parameters<typeof evaluatePostCloseWindow>[0]['markets'] & object,
  calendar: Parameters<typeof evaluatePostCloseWindow>[0]['calendar'] & object,
): Promise<{
  instrument: NormalizedRealityInstrument;
  identity: { ticker: string; cik: string; companyName: string };
  filing: SecFiling;
  content: SecFilingContent;
  event: SourceEvent;
  regularSessionClose: string;
  replayAsOf: string;
  nextOpen: string;
}> {
  for (const nativeTicker of preferredTickers) {
    const instrument = instruments.find((item) => item.nativeTicker === nativeTicker);
    if (instrument === undefined || instrument.nativeTicker === null) continue;
    const identity = await sec.getTickerCik(nativeTicker);
    const filings = await sec.getRecentFilings(nativeTicker, 40);
    for (const filing of filings) {
      if (filing.form !== '8-K' || filing.acceptanceTimestamp === null) continue;
      const close = resolveRegularSessionClose(filing.acceptanceTimestamp, marketStates, calendar);
      if (close === null || Date.parse(filing.acceptanceTimestamp) <= Date.parse(close)) continue;
      const replayAsOf = new Date(
        Date.parse(filing.acceptanceTimestamp) + 30 * 60_000,
      ).toISOString();
      const nextOpen = resolveNextRegularSessionOpen(replayAsOf, marketStates, calendar);
      if (nextOpen === null || Date.parse(replayAsOf) >= Date.parse(nextOpen)) continue;
      const eventWindow = evaluatePostCloseWindow({
        event: { sourceAvailableAt: filing.acceptanceTimestamp },
        contextAsOf: replayAsOf,
        markets: marketStates,
        calendar,
      });
      if (eventWindow.status !== 'qualifies') continue;
      const content = await sec.getFilingContent(filing);
      if (content.extractionStatus !== 'section-isolated' || content.boundedExcerpt.length < 120) {
        continue;
      }
      const event = sec.toSourceEvent(filing, instrument.providerSymbol, content);
      return {
        instrument,
        identity,
        filing,
        content,
        event,
        regularSessionClose: close,
        replayAsOf,
        nextOpen,
      };
    }
  }
  throw new Error('no historical post-close filing with bounded primary content was found');
}

async function findFutureSourceEvent(
  instrument: NormalizedRealityInstrument,
  selectedFiling: SecFiling,
  replayAsOf: string,
  filings: SecFiling[],
): Promise<SourceEvent | null> {
  const future = filings.find(
    (filing) =>
      filing.accessionNumber !== selectedFiling.accessionNumber &&
      filing.acceptanceTimestamp !== null &&
      Date.parse(filing.acceptanceTimestamp) > Date.parse(replayAsOf),
  );
  return future === undefined ? null : sec.toSourceEvent(future, instrument.providerSymbol);
}

async function buildMuNegativeCase(
  marketStates: Parameters<typeof evaluatePostCloseWindow>[0]['markets'],
  calendar: Parameters<typeof evaluatePostCloseWindow>[0]['calendar'],
): Promise<Record<string, unknown>> {
  const instrument = (await provider.discoverRealityInstruments()).data.find(
    (item) => item.nativeTicker === 'MU',
  );
  if (instrument === undefined) return { status: 'instrument-not-found' };
  const filings = await sec.getRecentFilings('MU', 100);
  const filing =
    filings.find((item) => item.accessionNumber === '0001104659-26-101067') ??
    filings.find((item) => item.form === '8-K');
  if (filing === undefined) return { status: 'filing-not-found' };
  const event = sec.toSourceEvent(filing, instrument.providerSymbol);
  const contextAsOf = new Date().toISOString();
  const window = evaluatePostCloseWindow({
    event,
    contextAsOf,
    markets: marketStates,
    calendar,
  });
  return {
    providerSymbol: instrument.providerSymbol,
    nativeTicker: 'MU',
    accessionNumber: filing.accessionNumber,
    form: filing.form,
    sourceAvailableAt: event.sourceAvailableAt,
    contextAsOf,
    status: window.status,
    reason: window.reason,
    regularSessionClose: window.regularSessionClose,
  };
}
