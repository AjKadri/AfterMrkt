import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/index.js';
import { freshnessFromSource } from '../../src/domain/freshness.js';
import { calculateMarketMetrics } from '../../src/domain/market-quality.js';
import { InMemorySnapshotStore } from '../../src/domain/snapshots.js';
import { writeTextFile } from '../../src/observability/evidence.js';

const watchSymbols = ['RNVDAUSDT', 'RTSLAUSDT', 'RAAPLUSDT', 'RSPYUSDT'];
const provider = new BitgetPublicMarketDataAdapter();
const snapshots = new InMemorySnapshotStore();
const now = new Date();
const universe = await provider.discoverRealityInstruments();
const marketStateAvailable = await provider
  .getMarketStates()
  .then(() => true)
  .catch(() => false);
const diagnostics: Diagnostic[] = [];

for (const providerSymbol of watchSymbols) {
  const instrument = universe.data.find((item) => item.providerSymbol === providerSymbol);
  const warnings: string[] = [];
  if (instrument === undefined) {
    diagnostics.push({
      providerSymbol,
      nativeTicker: null,
      tickerFreshness: null,
      bookFreshness: null,
      bidLevels: 0,
      askLevels: 0,
      spreadBps: null,
      turnover24h: null,
      platformTurnover24h: null,
      marketStateAvailable,
      mappingAvailable: false,
      warnings: ['provider symbol was not present in the current Reality universe'],
    });
    continue;
  }
  try {
    const [ticker, orderBook] = await Promise.all([
      provider.getTicker(providerSymbol),
      provider.getOrderBook(providerSymbol),
    ]);
    const snapshot = snapshots.saveOrderBook(orderBook.data);
    const metrics = calculateMarketMetrics(snapshot, now);
    const tickerFreshness = freshnessFromSource(ticker.source, now);
    const bookFreshness = freshnessFromSource(orderBook.source, now);
    if (tickerFreshness.state !== 'fresh') warnings.push(`ticker: ${tickerFreshness.reason}`);
    if (bookFreshness.state !== 'fresh') warnings.push(`book: ${bookFreshness.reason}`);
    if (!metrics.valid) warnings.push(...metrics.condition.reasons.map((reason) => reason.detail));
    diagnostics.push({
      providerSymbol,
      nativeTicker: instrument.nativeTicker,
      tickerFreshness,
      bookFreshness,
      bidLevels: snapshot.returnedBidCount,
      askLevels: snapshot.returnedAskCount,
      spreadBps: metrics.spreadBps,
      turnover24h: ticker.data.turnover24h,
      platformTurnover24h: ticker.data.platformTurnover24h,
      marketStateAvailable,
      mappingAvailable: instrument.mappingStatus === 'mapped',
      warnings,
      sourceRefs: [ticker.source, orderBook.source],
    });
  } catch (error) {
    diagnostics.push({
      providerSymbol,
      nativeTicker: instrument.nativeTicker,
      tickerFreshness: null,
      bookFreshness: null,
      bidLevels: 0,
      askLevels: 0,
      spreadBps: null,
      turnover24h: null,
      platformTurnover24h: null,
      marketStateAvailable,
      mappingAvailable: instrument.mappingStatus === 'mapped',
      warnings: [error instanceof Error ? error.message : String(error)],
    });
  }
}

const report = {
  reportType: 'aftermrkt-watched-instrument-diagnostics',
  generatedAt: new Date().toISOString(),
  source: 'bitget_generic_public_market_data',
  turnoverUse: 'observed-only-unverified-semantics',
  diagnostics,
};
const outputDirectory = join(
  process.cwd(),
  '.agent',
  'evidence',
  'diagnostics',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, 'report.json');
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, ...report }, null, 2));

type Diagnostic = {
  providerSymbol: string;
  nativeTicker: string | null;
  tickerFreshness: unknown;
  bookFreshness: unknown;
  bidLevels: number;
  askLevels: number;
  spreadBps: string | null;
  turnover24h: string | null;
  platformTurnover24h: string | null;
  marketStateAvailable: boolean;
  mappingAvailable: boolean;
  warnings: string[];
  sourceRefs?: unknown;
};
