import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/index.js';
import { calculateMarketMetrics } from '../../src/domain/market-quality.js';
import { InMemorySnapshotStore } from '../../src/domain/snapshots.js';
import { writeTextFile } from '../../src/observability/evidence.js';

const requestedTickers = (process.env.BITGET_REALITY_TICKERS ?? 'NVDA,TSLA,AAPL,MU')
  .split(',')
  .map((ticker) => ticker.trim().toUpperCase())
  .filter(Boolean);
const provider = new BitgetPublicMarketDataAdapter();
const snapshots = new InMemorySnapshotStore();
const universe = await provider.discoverRealityInstruments();
const records: RealityEventRecord[] = [];

for (const nativeTicker of requestedTickers) {
  const instrument = universe.data.find((item) => item.nativeTicker === nativeTicker);
  if (instrument === undefined) {
    records.push({ nativeTicker, providerSymbol: null, mappingStatus: 'not-found' });
    continue;
  }
  const record: RealityEventRecord = {
    nativeTicker,
    providerSymbol: instrument.providerSymbol,
    mappingStatus: instrument.mappingStatus,
  };
  try {
    const [ticker, orderBook, fills, companyOverview, suspension] = await Promise.all([
      provider.getTicker(instrument.providerSymbol),
      provider.getOrderBook(instrument.providerSymbol),
      provider.getFills(instrument.providerSymbol),
      provider.getCompanyOverview(nativeTicker),
      provider.getSuspensionResumptionInfo(nativeTicker),
    ]);
    const snapshot = snapshots.saveOrderBook(orderBook.data);
    const metrics = calculateMarketMetrics(snapshot, new Date());
    record.ticker = {
      bid: ticker.data.bidPrice,
      ask: ticker.data.askPrice,
      turnover24h: ticker.data.turnover24h,
      providerTimestamp: ticker.data.providerTimestamp,
    };
    record.orderBook = {
      bid: metrics.bestBid,
      ask: metrics.bestAsk,
      spreadBps: metrics.spreadBps,
      bidLevels: snapshot.returnedBidCount,
      askLevels: snapshot.returnedAskCount,
      providerTimestamp: orderBook.source.providerTimestamp,
      receivedAt: orderBook.source.receivedAt,
    };
    record.recentTradeCount = fills.data.length;
    record.companyOverview = companyOverview.data;
    record.suspensionResumption = suspension.data;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  }
  await delay(250);
  records.push(record);
}

const report = {
  reportType: 'aftermrkt-reality-native-ticker-endpoints',
  generatedAt: new Date().toISOString(),
  source: 'bitget-public-reality-and-generic-market-data',
  requestedTickers,
  discoveredRealityCount: universe.data.length,
  records,
};
const outputDirectory = join(
  process.cwd(),
  '.agent',
  'evidence',
  'reality-events',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, 'report.json');
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, ...report }, null, 2));

type RealityEventRecord = {
  nativeTicker: string;
  providerSymbol: string | null;
  mappingStatus: string;
  ticker?: {
    bid: string | null;
    ask: string | null;
    turnover24h: string | null;
    providerTimestamp: string | null;
  };
  orderBook?: {
    bid: string | null;
    ask: string | null;
    spreadBps: string | null;
    bidLevels: number;
    askLevels: number;
    providerTimestamp: string | null;
    receivedAt: string;
  };
  recentTradeCount?: number;
  companyOverview?: unknown;
  suspensionResumption?: unknown;
  error?: string;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
