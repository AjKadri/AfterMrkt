import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Decimal from 'decimal.js';
import {
  BitgetDemoClient,
  type DemoAssetBalance,
  type DemoOrderState,
} from '../../src/adapters/bitget/demo.js';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/public-market-data.js';
import { ExecutionService } from '../../src/domain/execution.js';
import { InMemorySnapshotStore } from '../../src/domain/snapshots.js';
import type { NormalizedRealityInstrument } from '../../src/domain/types.js';
import { loadLocalEnv } from '../../src/lib/env.js';
import { sha256 } from '../../src/lib/hash.js';
import { FileExecutionStore } from '../../src/persistence/execution-store.js';

loadLocalEnv();

const startedAt = new Date();
const runId = startedAt.toISOString().replace(/[:.]/gu, '-');
const evidenceDirectory = join(process.cwd(), '.agent', 'evidence', 'demo-lifecycle', runId);
await mkdir(evidenceDirectory, { recursive: true });

const demo = new BitgetDemoClient();
const marketData = new BitgetPublicMarketDataAdapter();
const preferredSymbols = [
  process.env.BITGET_DEMO_SYMBOL?.trim(),
  'RNVDAUSDT',
  'RAAPLUSDT',
  'RTSLAUSDT',
].filter((symbol): symbol is string => symbol !== undefined && symbol !== '');

const report: Record<string, unknown> = {
  reportType: 'aftermrkt-bitget-demo-reality-lifecycle',
  startedAt: startedAt.toISOString(),
  completedAt: null,
  status: 'started',
  environment: 'BITGET_DEMO',
  demoHeader: 'paptrading: 1',
  acquisition: null,
  position: null,
  context: {
    requiredProbe: 'npm run probe:context',
    status: 'not-run-by-this-bounded-lifecycle-probe',
  },
  exit: null,
  errors: [],
  security: {
    liveCredentialsRead: false,
    liveFallback: false,
    qwenUsed: false,
    rawSecretsPersisted: false,
  },
};

const writeReport = async (): Promise<void> => {
  report.completedAt = new Date().toISOString();
  await writeJson(join(evidenceDirectory, 'report.json'), report);
};

const addError = (error: unknown, stage: string): void => {
  const errors = report.errors as unknown[];
  errors.push({ stage, ...safeProviderError(error) });
};

const accountBefore = await demo.checkAccount();
report.accountBefore = summarizeAccount(accountBefore);
if (accountBefore.status !== 'verified' || accountBefore.assets.length === 0) {
  report.status = 'demo_funding_unavailable';
  await writeReport();
  console.log(JSON.stringify({ ...report, evidenceDirectory }, null, 2));
  process.exitCode = 1;
} else {
  const universe = await marketData.discoverRealityInstruments();
  const candidate = await selectCandidate(universe.data, accountBefore.assets);
  if (candidate === null) {
    report.status = 'demo_reality_execution=unsupported_or_inaccessible';
    await writeReport();
    console.log(JSON.stringify({ ...report, evidenceDirectory }, null, 2));
    process.exitCode = 1;
  } else {
    const { instrument, quoteBalance, orderBook } = candidate;
    const baseBefore = findAsset(accountBefore.assets, instrument.baseCoin);
    let openOrdersBefore: DemoOrderState[] = [];
    let openOrderError: unknown = null;
    try {
      openOrdersBefore = await demo.getOpenOrders(instrument.providerSymbol);
    } catch (error) {
      openOrderError = error;
    }
    if (openOrderError !== null) {
      report.status = isRealityUnsupportedError(openOrderError)
        ? 'demo_reality_execution=unsupported_or_inaccessible'
        : 'open_order_capability_failed';
      report.candidate = summarizeCandidate(instrument, quoteBalance, orderBook);
      report.openOrdersBefore = null;
      report.openOrderQuery = 'failed';
      report.providerRequest = {
        endpoint: '/api/v3/trade/unfilled-orders',
        category: 'SPOT',
        symbol: instrument.providerSymbol,
        demoHeader: 'paptrading: 1',
      };
      addError(openOrderError, 'open_order_query');
      await writeReport();
      console.log(JSON.stringify({ ...report, evidenceDirectory }, null, 2));
      process.exitCode = 1;
    } else if (openOrdersBefore.length > 0) {
      report.status = 'blocked_existing_demo_open_orders';
      report.candidate = summarizeCandidate(instrument, quoteBalance, orderBook);
      report.openOrdersBefore = openOrdersBefore;
      await writeReport();
      console.log(JSON.stringify({ ...report, evidenceDirectory }, null, 2));
      process.exitCode = 1;
    } else {
      const acquisition = await acquirePosition({
        instrument,
        quoteBalance,
        baseBefore,
        orderBook,
      });
      report.acquisition = acquisition.report;
      if (acquisition.error !== null) addError(acquisition.error, 'acquisition');
      if (acquisition.positionAsset === null) {
        report.status =
          acquisition.error !== null && isRealityUnsupportedError(acquisition.error)
            ? 'demo_reality_execution=unsupported_or_inaccessible'
            : acquisition.error === null
              ? 'acquisition_position_not_proven'
              : 'acquisition_failed';
        await writeReport();
        console.log(JSON.stringify({ ...report, evidenceDirectory }, null, 2));
        process.exitCode = 1;
      } else {
        const executionStore = new FileExecutionStore(join(evidenceDirectory, 'execution-data'));
        const execution = new ExecutionService({
          marketData,
          demo,
          snapshots: new InMemorySnapshotStore(),
          store: executionStore,
        });
        const positionResult = await execution.getDemoPositions();
        const position = positionResult.positions.find(
          (item) => item.providerSymbol === instrument.providerSymbol,
        );
        report.position = {
          providerSymbol: instrument.providerSymbol,
          baseCoin: instrument.baseCoin,
          environment: 'BITGET_DEMO',
          source: 'demo',
          isSimulated: false,
          accountAssetAfterAcquisition: acquisition.positionAsset,
          normalizedPosition: position ?? null,
        };
        if (position === undefined) {
          report.status = 'acquisition_position_not_normalized';
          await writeReport();
          console.log(JSON.stringify({ ...report, evidenceDirectory }, null, 2));
          process.exitCode = 1;
        } else {
          const exit = await runExit({ execution, instrument, position });
          report.exit = exit.report;
          if (exit.error !== null) addError(exit.error, 'exit');
          report.status = exit.status;
          await writeReport();
          console.log(JSON.stringify({ ...report, evidenceDirectory }, null, 2));
          if (exit.status !== 'completed') process.exitCode = 1;
        }
      }
    }
  }
}

async function selectCandidate(
  instruments: NormalizedRealityInstrument[],
  assets: DemoAssetBalance[],
): Promise<{
  instrument: NormalizedRealityInstrument;
  quoteBalance: DemoAssetBalance;
  orderBook: Awaited<ReturnType<BitgetPublicMarketDataAdapter['getOrderBook']>>['data'];
} | null> {
  for (const symbol of [...new Set(preferredSymbols)]) {
    const instrument = instruments.find(
      (item) =>
        item.providerSymbol === symbol &&
        item.isReality &&
        item.status?.toLowerCase() === 'online' &&
        item.baseCoin !== null &&
        item.quoteCoin !== null &&
        item.nativeTicker !== null,
    );
    if (instrument === undefined || instrument.quoteCoin === null) continue;
    const quoteBalance = findAsset(assets, instrument.quoteCoin);
    if (quoteBalance === null || !positive(quoteBalance.available)) continue;
    try {
      const orderBook = await marketData.getOrderBook(instrument.providerSymbol, 40);
      const bestBid = orderBook.data.bids[0];
      const bestAsk = orderBook.data.asks[0];
      if (bestBid === undefined || bestAsk === undefined) continue;
      if (!positive(bestBid.price) || !positive(bestAsk.price)) continue;
      return { instrument, quoteBalance, orderBook: orderBook.data };
    } catch {
      continue;
    }
  }
  return null;
}

async function acquirePosition(input: {
  instrument: NormalizedRealityInstrument;
  quoteBalance: DemoAssetBalance;
  baseBefore: DemoAssetBalance | null;
  orderBook: Awaited<ReturnType<BitgetPublicMarketDataAdapter['getOrderBook']>>['data'];
}): Promise<{
  report: Record<string, unknown>;
  positionAsset: DemoAssetBalance | null;
  error: unknown;
}> {
  const { instrument, quoteBalance, baseBefore, orderBook } = input;
  const minimumAmount = decimalOrNull(instrument.minOrderAmount) ?? new Decimal('10');
  const requestedNotional = Decimal.max(
    minimumAmount.times('1.25'),
    new Decimal('10'),
  ).toDecimalPlaces(2, Decimal.ROUND_UP);
  const maxMarketAmount = decimalOrNull(instrument.maxMarketOrderAmount);
  const acquisitionClientOid = `am-acq-${sha256(`${Date.now()}-${randomBytes(12).toString('hex')}`).slice(0, 24)}`;
  const request = {
    category: 'SPOT',
    symbol: instrument.providerSymbol,
    side: 'buy',
    orderType: 'market',
    qty: requestedNotional.toFixed(),
    clientOid: acquisitionClientOid,
    demoHeader: 'paptrading: 1',
    quantityUnit: 'quote-coin',
  };
  const report: Record<string, unknown> = {
    candidate: summarizeCandidate(instrument, quoteBalance, orderBook),
    before: {
      baseBalance: baseBefore,
      quoteBalance,
    },
    validation: {
      exactProviderSymbol: instrument.providerSymbol,
      status: instrument.status,
      minimumQuantity: instrument.minOrderQty,
      quantityPrecision: instrument.quantityPrecision,
      minimumAmount: instrument.minOrderAmount,
      maximumMarketOrderAmount: instrument.maxMarketOrderAmount,
      requestedNotional: requestedNotional.toFixed(),
      quoteAvailable: quoteBalance.available,
      quoteSufficient: new Decimal(quoteBalance.available).gte(requestedNotional),
      maximumAmountSatisfied: maxMarketAmount === null || requestedNotional.lte(maxMarketAmount),
    },
    request,
    providerOrder: null,
    reconciliation: null,
    after: null,
  };
  await writeJson(join(evidenceDirectory, 'acquisition-intent.json'), report);
  if (baseBefore !== null && positive(baseBefore.available)) {
    return {
      report: { ...report, skipped: 'existing_base_position' },
      positionAsset: baseBefore,
      error: null,
    };
  }
  if (new Decimal(quoteBalance.available).lt(requestedNotional)) {
    return { report, positionAsset: null, error: new Error('Demo quote balance is insufficient') };
  }
  if (maxMarketAmount !== null && requestedNotional.gt(maxMarketAmount)) {
    return {
      report,
      positionAsset: null,
      error: new Error('requested market amount exceeds provider maximum'),
    };
  }
  let providerOrder: DemoOrderState | null = null;
  let error: unknown = null;
  try {
    providerOrder = await demo.placeOrder({
      symbol: instrument.providerSymbol,
      side: 'buy',
      orderType: 'market',
      quantity: requestedNotional.toFixed(),
      clientOid: acquisitionClientOid,
    });
  } catch (caught) {
    error = caught;
  }
  const reconciled = await reconcile(demo, acquisitionClientOid, providerOrder);
  providerOrder = reconciled.order;
  report.providerOrder = providerOrder;
  report.reconciliation = reconciled;
  const assets = await readAssets(demo);
  const positionAsset = findAsset(assets, instrument.baseCoin);
  report.after = {
    baseBalance: positionAsset,
    quoteBalance: findAsset(assets, instrument.quoteCoin),
  };
  return {
    report,
    positionAsset:
      positionAsset !== null && positive(positionAsset.available) ? positionAsset : null,
    error,
  };
}

async function runExit(input: {
  execution: ExecutionService;
  instrument: NormalizedRealityInstrument;
  position: Awaited<ReturnType<ExecutionService['getDemoPositions']>>['positions'][number];
}): Promise<{ report: Record<string, unknown>; status: string; error: unknown }> {
  const { execution, instrument, position } = input;
  const precision = precisionNumber(instrument.quantityPrecision);
  const available = new Decimal(position.availableQuantity);
  const requestedQuantity =
    precision === null ? available : available.toDecimalPlaces(precision, Decimal.ROUND_DOWN);
  const report: Record<string, unknown> = {
    position,
    requestedQuantity: requestedQuantity.toFixed(),
    maximumAcceptableSlippageBps: '100',
    intent: null,
    confirmationAttempts: [],
    order: null,
    reconciliation: null,
    finalBalance: null,
    cancellation: { requested: false },
    estimateDisclaimer: 'observed-book-estimate-not-guaranteed-fill',
  };
  if (requestedQuantity.lte(0)) {
    return {
      report,
      status: 'exit_unavailable_zero_quantity',
      error: new Error('no available position quantity'),
    };
  }
  let created;
  try {
    created = await execution.createIntent({
      positionId: position.positionId,
      providerSymbol: instrument.providerSymbol,
      orderType: 'market',
      requestedQuantity: requestedQuantity.toFixed(),
      maximumAcceptableSlippageBps: '100',
    });
  } catch (error) {
    return { report, status: 'exit_intent_failed', error };
  }
  report.intent = created.intent;
  await writeJson(join(evidenceDirectory, 'exit-intent.json'), {
    intent: created.intent,
    confirmation: { status: 'issued', tokenPersisted: false },
  });
  let confirmationToken = created.confirmationToken;
  let result: Awaited<ReturnType<ExecutionService['confirmIntent']>> | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      result = await execution.confirmIntent(created.intent.intentId, confirmationToken);
    } catch (error) {
      return { report, status: 'exit_confirmation_failed', error };
    }
    const attempts = report.confirmationAttempts as unknown[];
    attempts.push({
      attempt,
      status: result.status,
      intentId: result.intent.intentId,
      bookSnapshotId: result.intent.bookSnapshotId,
      orderId: result.status === 'refresh_required' ? null : result.order.internalOrderId,
    });
    if (result.status !== 'refresh_required') break;
    confirmationToken = result.confirmationToken;
  }
  if (result === null || result.status === 'refresh_required') {
    return { report, status: 'exit_refresh_required', error: null };
  }
  report.order = result.order;
  const providerOrder = await reconcile(demo, result.order.clientOid, result.order.provider);
  report.reconciliation = providerOrder;
  if (
    providerOrder.order !== null &&
    ['live', 'partially_filled'].includes(providerOrder.order.orderStatus.toLowerCase())
  ) {
    report.cancellation = {
      requested: false,
      reason: 'open state preserved; no automatic cancellation was requested',
    };
  }
  const finalAssets = await readAssets(demo);
  report.finalBalance = findAsset(finalAssets, instrument.baseCoin);
  return { report, status: 'completed', error: null };
}

async function reconcile(
  client: BitgetDemoClient,
  clientOid: string,
  initial: DemoOrderState | null,
): Promise<{ order: DemoOrderState | null; attempts: number }> {
  let order = initial;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      order = (await client.getOrderByClientOid(clientOid)) ?? order;
    } catch {
      // Preserve the prior response and continue the bounded reconciliation window.
    }
    if (order !== null && isSettled(order)) return { order, attempts: attempt };
    if (attempt < 4) await sleep(500);
  }
  return { order, attempts: 4 };
}

async function readAssets(client: BitgetDemoClient): Promise<DemoAssetBalance[]> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await client.getAssets();
    } catch {
      if (attempt === 4) throw new Error('Demo assets could not be re-queried');
      await sleep(500);
    }
  }
  return [];
}

function summarizeCandidate(
  instrument: NormalizedRealityInstrument,
  quoteBalance: DemoAssetBalance,
  orderBook: {
    bids: Array<{ price: string; quantity: string }>;
    asks: Array<{ price: string; quantity: string }>;
    providerTimestamp: string | null;
    receivedAt: string;
  },
) {
  return {
    providerSymbol: instrument.providerSymbol,
    baseCoin: instrument.baseCoin,
    quoteCoin: instrument.quoteCoin,
    nativeTicker: instrument.nativeTicker,
    status: instrument.status,
    mappingStatus: instrument.mappingStatus,
    quantityPrecision: instrument.quantityPrecision,
    pricePrecision: instrument.pricePrecision,
    minOrderQty: instrument.minOrderQty,
    minOrderAmount: instrument.minOrderAmount,
    maxMarketOrderAmount: instrument.maxMarketOrderAmount,
    quoteAvailable: quoteBalance.available,
    bestBid: orderBook.bids[0] ?? null,
    bestAsk: orderBook.asks[0] ?? null,
    bidLevels: orderBook.bids.length,
    askLevels: orderBook.asks.length,
    providerTimestamp: orderBook.providerTimestamp,
    receivedAt: orderBook.receivedAt,
  };
}

function summarizeAccount(account: Awaited<ReturnType<BitgetDemoClient['checkAccount']>>) {
  return {
    status: account.status,
    authentication: account.authentication,
    assets: account.assets,
    warnings: account.warnings,
    checkedAt: account.checkedAt,
  };
}

function findAsset(assets: DemoAssetBalance[], asset: string | null): DemoAssetBalance | null {
  if (asset === null) return null;
  return assets.find((item) => item.asset === asset) ?? null;
}

function decimalOrNull(value: string | null): Decimal | null {
  if (value === null) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() && parsed.gt(0) ? parsed : null;
  } catch {
    return null;
  }
}

function precisionNumber(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function positive(value: string): boolean {
  return decimalOrNull(value) !== null;
}

function isSettled(order: DemoOrderState): boolean {
  return ['filled', 'canceled', 'cancelled', 'rejected'].includes(order.orderStatus.toLowerCase());
}

function safeProviderError(error: unknown): Record<string, unknown> {
  const value = error as {
    status?: string;
    httpStatus?: number;
    providerCode?: string;
    providerMessage?: string;
    rawResponse?: { url?: string; status?: number };
  };
  return {
    message: error instanceof Error ? error.message : String(error),
    status: value.status ?? null,
    httpStatus: value.httpStatus ?? value.rawResponse?.status ?? null,
    providerCode: value.providerCode ?? null,
    providerMessage: value.providerMessage ?? null,
    endpoint: value.rawResponse?.url ?? null,
  };
}

function isRealityUnsupportedError(error: unknown): boolean {
  const providerCode = String((error as { providerCode?: unknown }).providerCode ?? '');
  return ['25101', '25200', '40034'].includes(providerCode);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
