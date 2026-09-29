import { BitgetPublicMarketDataAdapter } from '../src/adapters/bitget/index.js';
import { createApiServer } from '../src/api/index.js';
import { InMemorySnapshotStore } from '../src/domain/snapshots.js';

const port = Number(process.env.PORT ?? 3000);
const server = createApiServer({
  marketData: new BitgetPublicMarketDataAdapter(),
  snapshots: new InMemorySnapshotStore(),
});

server.listen(port, '127.0.0.1', () => {
  console.log(`AfterMrkt API listening on http://127.0.0.1:${port}`);
});
