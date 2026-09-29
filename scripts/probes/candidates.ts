import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Decimal from 'decimal.js';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/index.js';
import { calculateMarketMetrics } from '../../src/domain/market-quality.js';
import { InMemorySnapshotStore } from '../../src/domain/snapshots.js';
import { writeTextFile } from '../../src/observability/evidence.js';

const provider = new BitgetPublicMarketDataAdapter();
const snapshotStore = new InMemorySnapshotStore();
const candidateLimit = Math.max(5, Math.min(Number(process.env.BITGET_CANDIDATE_LIMIT ?? 10), 20));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDirectory = join(process.cwd(), '.agent', 'evidence', 'candidates', runId);
await mkdir(outputDirectory, { recursive: true });

const universe = await provider.discoverRealityInstruments();
const tickers = await provider.getAllTickers();
const tickerBySymbol = new Map(tickers.data.map((ticker) => [ticker.providerSymbol, ticker]));
const mappedOnline = universe.data.filter(
  (instrument) =>
    instrument.mappingStatus === 'mapped' &&
    instrument.nativeTicker !== null &&
    instrument.status?.toLowerCase() === 'online',
);
const ranked = mappedOnline
  .map((instrument) => ({ instrument, ticker: tickerBySymbol.get(instrument.providerSymbol) }))
  .filter(
    (item): item is typeof item & { ticker: NonNullable<typeof item.ticker> } =>
      item.ticker !== undefined,
  )
  .sort((left, right) => compareTurnover(left.ticker.quoteVolume, right.ticker.quoteVolume));

const candidates: CandidateReport[] = [];
for (const item of ranked.slice(0, Math.max(candidateLimit * 4, 20))) {
  if (candidates.length >= candidateLimit) {
    break;
  }
  try {
    const orderBook = await provider.getOrderBook(item.instrument.providerSymbol);
    const snapshot = snapshotStore.saveOrderBook(orderBook.data);
    const metrics = calculateMarketMetrics(snapshot, new Date());
    if (
      !metrics.valid ||
      metrics.bestBid === null ||
      metrics.bestAsk === null ||
      metrics.spreadBps === null
    ) {
      continue;
    }
    let recentTradeCount: number | null = null;
    try {
      recentTradeCount = (await provider.getFills(item.instrument.providerSymbol)).data.length;
    } catch {
      recentTradeCount = null;
    }
    candidates.push({
      providerSymbol: item.instrument.providerSymbol,
      nativeTicker: item.instrument.nativeTicker,
      bid: metrics.bestBid,
      ask: metrics.bestAsk,
      spreadBps: metrics.spreadBps,
      bidLevels: metrics.depth.bestBid.levels,
      askLevels: countLevels(snapshot.asks),
      turnover24h: item.ticker.quoteVolume,
      recentTradeCount,
      mappingStatus: item.instrument.mappingStatus,
      timestamp: orderBook.source.providerTimestamp ?? orderBook.source.receivedAt,
      sourceRefs: [orderBook.source.endpoint],
    });
  } catch {
    // A candidate is only reported after a valid live book is available.
  }
}

const report = {
  reportType: 'aftermrkt-reality-demo-candidates',
  generatedAt: new Date().toISOString(),
  provider: 'bitget',
  source: 'generic-public-market-data',
  permanentDemoSelection: null,
  discoveredRealityCount: universe.data.length,
  mappedOnlineCount: mappedOnline.length,
  examinedCount: Math.min(ranked.length, Math.max(candidateLimit * 4, 20)),
  candidates,
};
const outputPath = join(outputDirectory, 'report.json');
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, ...report }, null, 2));

type CandidateReport = {
  providerSymbol: string;
  nativeTicker: string | null;
  bid: string;
  ask: string;
  spreadBps: string;
  bidLevels: number;
  askLevels: number;
  turnover24h: string | null;
  recentTradeCount: number | null;
  mappingStatus: string;
  timestamp: string;
  sourceRefs: string[];
};

function compareTurnover(left: string | null, right: string | null): number {
  const leftValue = decimalOrZero(left);
  const rightValue = decimalOrZero(right);
  return rightValue.comparedTo(leftValue);
}

function decimalOrZero(value: string | null): Decimal {
  if (value === null) {
    return new Decimal(0);
  }
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

function countLevels(levels: unknown[]): number {
  return levels.length;
}
