import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ReplayEngine } from '../../src/domain/replay.js';
import { FileCaptureStore } from '../../src/persistence/store.js';
import { writeTextFile } from '../../src/observability/evidence.js';

const dataDirectory = process.env.AFTERMRKT_DATA_DIR ?? join(process.cwd(), '.agent', 'data');
const store = new FileCaptureStore(dataDirectory);
const engine = new ReplayEngine(store);
const cases = await engine.listCases();
const requestedCaseId = process.env.AFTERMRKT_REPLAY_CASE_ID;
const replayCase = requestedCaseId
  ? cases.find((item) => item.manifest.caseId === requestedCaseId)
  : cases[0];
if (replayCase === undefined) {
  throw new Error('no immutable replay case is available in the configured capture store');
}
const result = await engine.simulate(replayCase.manifest.caseId, {
  requestedQuantity: process.env.AFTERMRKT_REPLAY_QTY ?? '1',
});
const report = {
  reportType: 'aftermrkt-replay-simulation',
  generatedAt: new Date().toISOString(),
  dataDirectory,
  providerCalls: 0,
  result,
};
const outputDirectory = join(
  process.cwd(),
  '.agent',
  'evidence',
  'replay',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, 'report.json');
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, ...report }, null, 2));
