import { BitgetPublicMarketDataAdapter } from '../src/adapters/bitget/index.js';
import { createApiServer } from '../src/api/index.js';
import { InMemorySnapshotStore } from '../src/domain/snapshots.js';
import { FileCaptureStore } from '../src/persistence/store.js';
import { FileExecutionStore } from '../src/persistence/execution-store.js';
import { join } from 'node:path';
import { loadLocalEnv } from '../src/lib/env.js';

loadLocalEnv();

const port = Number(process.env.PORT ?? 3000);
const dataDirectory = process.env.AFTERMRKT_DATA_DIR ?? join(process.cwd(), '.agent', 'data');
const server = createApiServer({
  marketData: new BitgetPublicMarketDataAdapter(),
  snapshots: new InMemorySnapshotStore(),
  replayStore: new FileCaptureStore(dataDirectory),
  executionStore: new FileExecutionStore(dataDirectory),
});

server.listen(port, '127.0.0.1', () => {
  console.log(`AfterMrkt API listening on http://127.0.0.1:${port}`);
});
