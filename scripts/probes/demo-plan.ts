import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BitgetDemoClient } from '../../src/adapters/bitget/demo.js';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/public-market-data.js';
import { loadLocalEnv } from '../../src/lib/env.js';

loadLocalEnv();

const symbol = process.argv[2] ?? process.env.BITGET_DEMO_SYMBOL ?? 'RNVDAUSDT';
const publicMarketData = new BitgetPublicMarketDataAdapter();
const demo = new BitgetDemoClient();
const [universe, ticker, orderBook, account] = await Promise.all([
  publicMarketData.discoverRealityInstruments(),
  publicMarketData.getTicker(symbol),
  publicMarketData.getOrderBook(symbol, 40),
  demo.checkAccount(),
]);
const instrument = universe.data.find((item) => item.providerSymbol === symbol) ?? null;
const baseBalance =
  instrument?.baseCoin === null || instrument?.baseCoin === undefined
    ? null
    : (account.assets.find((asset) => asset.asset === instrument.baseCoin) ?? null);
const quoteBalance =
  instrument?.quoteCoin === null || instrument?.quoteCoin === undefined
    ? null
    : (account.assets.find((asset) => asset.asset === instrument.quoteCoin) ?? null);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDirectory = join(process.cwd(), '.agent', 'evidence', 'demo-plan', runId);
await mkdir(evidenceDirectory, { recursive: true });

const report = {
  reportType: 'aftermrkt-bitget-demo-trade-plan',
  checkedAt: new Date().toISOString(),
  environment: 'BITGET_DEMO',
  exactProviderSymbol: symbol,
  instrument:
    instrument === null
      ? null
      : {
          providerSymbol: instrument.providerSymbol,
          baseCoin: instrument.baseCoin,
          quoteCoin: instrument.quoteCoin,
          nativeTicker: instrument.nativeTicker,
          status: instrument.status,
          quantityPrecision: instrument.quantityPrecision,
          pricePrecision: instrument.pricePrecision,
          minOrderQty: instrument.minOrderQty,
          minOrderAmount: instrument.minOrderAmount,
          maxMarketOrderAmount: instrument.maxMarketOrderAmount,
        },
  publicMarket: {
    ticker: {
      lastPrice: ticker.data.lastPrice,
      bidPrice: ticker.data.bidPrice,
      askPrice: ticker.data.askPrice,
      providerTimestamp: ticker.data.providerTimestamp,
      receivedAt: ticker.data.receivedAt,
    },
    orderBook: {
      bestBid: orderBook.data.bids[0] ?? null,
      bestAsk: orderBook.data.asks[0] ?? null,
      bidLevels: orderBook.data.bids.length,
      askLevels: orderBook.data.asks.length,
      providerTimestamp: orderBook.data.providerTimestamp,
      receivedAt: orderBook.data.receivedAt,
    },
  },
  demoAccount: {
    status: account.status,
    authentication: account.authentication,
    assetCount: account.assets.length,
    baseBalance,
    quoteBalance,
    openOrdersChecked: true,
    warnings: account.warnings,
  },
  safeBuyDecision:
    baseBalance !== null && baseBalance.available !== '0'
      ? 'existing-base-position'
      : quoteBalance !== null && quoteBalance.available !== '0'
        ? 'quote-balance-present-buy-still-requires-explicit-review'
        : 'blocked-no-available-demo-base-or-quote-balance',
  security: {
    liveCredentialsRead: false,
    liveFallback: false,
    orderSubmitted: false,
    secretValuesPersisted: false,
  },
};

await writeFile(
  join(evidenceDirectory, 'report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify({ ...report, evidenceDirectory }, null, 2));
