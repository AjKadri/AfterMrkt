import { BitgetPublicMarketDataAdapter } from '../src/adapters/bitget/index.js';
import { createApiServer } from '../src/api/index.js';
import { InMemorySnapshotStore } from '../src/domain/snapshots.js';
import { FileCaptureStore } from '../src/persistence/store.js';
import { join } from 'node:path';

const port = Number(process.env.PORT ?? 3000);
const server = createApiServer({
  marketData: new BitgetPublicMarketDataAdapter(),
  snapshots: new InMemorySnapshotStore(),
  replayStore: new FileCaptureStore(
    process.env.AFTERMRKT_DATA_DIR ?? join(process.cwd(), '.agent', 'data'),
  ),
});

server.listen(port, '127.0.0.1', () => {
  console.log(`AfterMrkt API listening on http://127.0.0.1:${port}`);
});
