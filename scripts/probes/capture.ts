import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/index.js';
import { DEFAULT_WATCH_SYMBOLS, MarketCollector } from '../../src/collector/market-collector.js';
import { FileCaptureStore } from '../../src/persistence/store.js';
import { writeTextFile } from '../../src/observability/evidence.js';

const provider = new BitgetPublicMarketDataAdapter();
const dataDirectory = process.env.AFTERMRKT_DATA_DIR ?? join(process.cwd(), '.agent', 'data');
const store = new FileCaptureStore(dataDirectory);
const collector = new MarketCollector(provider, store, {
  watchSymbols: DEFAULT_WATCH_SYMBOLS,
  orderBookDepth: 40,
});
const cycle = await collector.collectOnce();
const complete = cycle.symbols.find(
  (item) => item.marketSnapshotId !== null && item.orderBookSnapshotId !== null,
);
let replayCaseId: string | null = null;
if (complete !== undefined) {
  replayCaseId = (await collector.createReplayCaseFromCapture(cycle, complete.providerSymbol))
    .manifest.caseId;
}

const report = {
  reportType: 'aftermrkt-bitget-capture-cycle',
  generatedAt: new Date().toISOString(),
  dataDirectory,
  watchSymbols: DEFAULT_WATCH_SYMBOLS,
  cycle,
  firstReplayCaseId: replayCaseId,
  note: 'The first replay case is a captured case reference, not a permanent demo-instrument selection.',
};
const outputDirectory = join(
  process.cwd(),
  '.agent',
  'evidence',
  'capture',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, 'report.json');
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, ...report }, null, 2));
