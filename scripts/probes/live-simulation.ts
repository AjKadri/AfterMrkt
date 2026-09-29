import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/index.js';
import { simulateExit } from '../../src/domain/market-quality.js';
import { InMemorySnapshotStore } from '../../src/domain/snapshots.js';
import { writeTextFile } from '../../src/observability/evidence.js';

const symbol = process.env.BITGET_SYMBOL ?? 'RMUUSDT';
const requestedQuantity = process.env.BITGET_SIMULATION_QTY ?? '0.01';
const provider = new BitgetPublicMarketDataAdapter();
const snapshots = new InMemorySnapshotStore();
const orderBook = await provider.getOrderBook(symbol, 40);
const snapshot = snapshots.saveOrderBook(orderBook.data);
const simulation = simulateExit({
  providerSymbol: symbol,
  requestedQuantity,
  snapshot,
  now: new Date(),
});

const report = {
  provider: 'bitget',
  source: orderBook.source,
  snapshotId: snapshot.snapshotId,
  requestedQuantity,
  topBids: snapshot.bids.slice(0, 5),
  topAsks: snapshot.asks.slice(0, 5),
  simulation,
};
const outputDirectory = join(
  process.cwd(),
  '.agent',
  'evidence',
  'simulations',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, 'report.json');
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, ...report }, null, 2));
