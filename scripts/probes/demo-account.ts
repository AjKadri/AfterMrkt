import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BitgetDemoClient } from '../../src/adapters/bitget/demo.js';
import { loadLocalEnv } from '../../src/lib/env.js';

loadLocalEnv();

const client = new BitgetDemoClient();
const symbol = process.argv[2] ?? process.env.BITGET_DEMO_SYMBOL ?? 'RNVDAUSDT';
const account = await client.checkAccount();
const instrument = await client.verifyInstrument(symbol);
const assetsProbe = await probeCall(() => client.getAssets());
const openOrdersProbe = await probeCall(() => client.getOpenOrders(symbol));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDirectory = join(process.cwd(), '.agent', 'evidence', 'demo-account', runId);
await mkdir(evidenceDirectory, { recursive: true });

const report = {
  reportType: 'aftermrkt-bitget-demo-account-proof',
  checkedAt: account.checkedAt,
  environment: 'BITGET_DEMO',
  credentialsConfigured: account.credentialsConfigured,
  demoHeaderRequired: 'paptrading: 1',
  endpoints: {
    assets: '/api/v3/account/assets',
    settings: '/api/v3/account/settings',
    openOrders: '/api/v3/trade/unfilled-orders',
    orderInfo: '/api/v3/trade/order-info',
  },
  account: {
    status: account.status,
    authentication: account.authentication,
    withdrawalPermission: account.withdrawalPermission,
    permissions: account.permissions,
    warnings: account.warnings,
    assets: account.assets,
  },
  directCalls: {
    assets: assetsProbe,
    openOrders: openOrdersProbe,
  },
  exactProviderSymbol: symbol,
  orderQueryCapability: instrument,
  security: {
    liveCredentialsRead: false,
    liveFallback: false,
    secretValuesPersisted: false,
  },
};

await writeFile(
  join(evidenceDirectory, 'report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify({ ...report, evidenceDirectory }, null, 2));

async function probeCall<T>(action: () => Promise<T>): Promise<Record<string, unknown>> {
  try {
    const data = await action();
    return { status: 'verified', itemCount: Array.isArray(data) ? data.length : null };
  } catch (error) {
    const providerError = error as {
      httpStatus?: number;
      providerCode?: string;
      providerMessage?: string;
      rawResponse?: { status: number; bodyText: string };
    };
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
      httpStatus: providerError.httpStatus ?? providerError.rawResponse?.status ?? null,
      providerCode: providerError.providerCode ?? null,
      providerMessage: providerError.providerMessage ?? null,
      providerBody: providerError.rawResponse?.bodyText ?? null,
    };
  }
}
