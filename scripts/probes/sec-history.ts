import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/index.js';
import { SecEdgarAdapter } from '../../src/adapters/sec/index.js';
import {
  resolveNextRegularSessionOpen,
  resolveRegularSessionClose,
} from '../../src/domain/event-window.js';
import { writeTextFile } from '../../src/observability/evidence.js';
import { createEvidenceDirectory } from './common.js';

const tickers = (process.env.AFTERMRKT_HISTORY_TICKERS ?? 'NVDA,TSLA,AAPL,META,MSFT,AMZN,MU')
  .split(',')
  .map((ticker) => ticker.trim().toUpperCase())
  .filter(Boolean);
const provider = new BitgetPublicMarketDataAdapter();
const sec = new SecEdgarAdapter(
  process.env.SEC_USER_AGENT === undefined ? {} : { userAgent: process.env.SEC_USER_AGENT },
);
const [universe, markets, calendar] = await Promise.all([
  provider.discoverRealityInstruments(),
  provider.getMarketStates(),
  provider.getMarketCalendar(),
]);
const evidenceDirectory = await createEvidenceDirectory('sec-history');
const candidates: Record<string, unknown>[] = [];

for (const nativeTicker of tickers) {
  const instrument = universe.data.find((item) => item.nativeTicker === nativeTicker);
  if (instrument === undefined || instrument.nativeTicker === null) {
    candidates.push({ nativeTicker, status: 'reality-instrument-not-found' });
    continue;
  }
  const filings = await sec.getRecentFilings(nativeTicker, 40);
  for (const filing of filings) {
    if (filing.form !== '8-K' || filing.acceptanceTimestamp === null) continue;
    const close = resolveRegularSessionClose(
      filing.acceptanceTimestamp,
      markets.data,
      calendar.data,
    );
    if (close === null || Date.parse(filing.acceptanceTimestamp) <= Date.parse(close)) continue;
    let content;
    try {
      content = await sec.getFilingContent(filing);
    } catch (error) {
      candidates.push({
        nativeTicker,
        providerSymbol: instrument.providerSymbol,
        accessionNumber: filing.accessionNumber,
        form: filing.form,
        sourceAvailableAt: filing.acceptanceTimestamp,
        regularSessionClose: close,
        status: 'content-failed',
        error: error instanceof Error ? error.message : 'unknown-error',
      });
      continue;
    }
    const replayAsOf = new Date(Date.parse(filing.acceptanceTimestamp) + 30 * 60_000).toISOString();
    const nextOpen = resolveNextRegularSessionOpen(replayAsOf, markets.data, calendar.data);
    candidates.push({
      nativeTicker,
      providerSymbol: instrument.providerSymbol,
      companyName: instrument.nativeName,
      accessionNumber: filing.accessionNumber,
      form: filing.form,
      filingDate: filing.filingDate,
      primaryDocument: filing.primaryDocument,
      sourceUrl: filing.sourceUrl,
      regularSessionClose: close,
      sourceAvailableAt: filing.acceptanceTimestamp,
      replayAsOf,
      nextRegularSessionOpen: nextOpen,
      replayBeforeNextOpen: nextOpen === null || Date.parse(replayAsOf) < Date.parse(nextOpen),
      itemIds: filing.items,
      extractionStatus: content.extractionStatus,
      relevantItemIds: content.relevantItemIds,
      boundedExcerptChars: content.boundedExcerpt.length,
      sanitizedTextLength: content.sanitizedTextLength,
      contentHash: content.contentHash,
      status: 'content-ready',
    });
    if (content.extractionStatus === 'section-isolated' && content.boundedExcerpt.length >= 120) {
      break;
    }
  }
}

const report = {
  reportType: 'aftermrkt-sec-post-close-history',
  generatedAt: new Date().toISOString(),
  dynamicRealityCount: universe.data.length,
  tickers,
  candidates,
};
const outputPath = join(evidenceDirectory, 'report.json');
await mkdir(evidenceDirectory, { recursive: true });
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, candidates }, null, 2));
