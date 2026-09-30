import {
  BitgetPublicClient,
  getProviderTimestamp,
  normalizeCalendar,
  normalizeCandles,
  normalizeCompanyOverview,
  normalizeFills,
  normalizeInstruments,
  normalizeMarketStates,
  normalizeOrderBook,
  normalizeStockInfo,
  normalizeTicker,
  selectRealityInstruments,
} from '../../src/adapters/bitget/index.js';
import type { BitgetRequestResult } from '../../src/adapters/bitget/index.js';
import type { BitgetInstrument } from '../../src/contracts/bitget.js';
import {
  createEvidenceDirectory,
  executeProbe,
  summarizeProbe,
  type ProbeCapture,
} from './common.js';

const initialSymbol = process.env.BITGET_SYMBOL ?? 'RMUUSDT';
const symbolLimit = Math.max(2, Math.min(Number(process.env.BITGET_SYMBOL_LIMIT ?? 5), 10));
const client = new BitgetPublicClient();
const evidenceDirectory = await createEvidenceDirectory('bitget');

const runs: Array<Awaited<ReturnType<typeof executeProbe>>> = [];

const discoveryUrl = `${client.baseUrl.replace(/\/+$/, '')}/api/v3/market/instruments?category=SPOT`;
const discovery = await executeProbe({
  capability: 'bitget.instruments.spot',
  request: { method: 'GET', url: discoveryUrl },
  action: async () =>
    toCapture(await client.get('/api/v3/market/instruments', { category: 'SPOT' })),
  normalize: normalizeInstruments,
  outputDirectory: evidenceDirectory,
});
runs.push(discovery);

const discovered = Array.isArray(discovery.normalizedResponse)
  ? (discovery.normalizedResponse as BitgetInstrument[])
  : [];
const realityInstruments = selectRealityInstruments(discovered);
const symbols = chooseSymbols(realityInstruments, initialSymbol, symbolLimit);

if (symbols.length === 0) {
  throw new Error(
    'No Reality symbols were returned by Bitget, so symbol-specific probes were not attempted.',
  );
}

for (const symbol of symbols) {
  runs.push(
    await executeProbe({
      capability: `bitget.ticker.${symbol}`,
      request: {
        method: 'GET',
        url: buildUrl('/api/v3/market/tickers', { category: 'SPOT', symbol }),
      },
      action: async () =>
        toCapture(await client.get('/api/v3/market/tickers', { category: 'SPOT', symbol })),
      normalize: (payload) => normalizeTicker(payload, symbol),
      outputDirectory: evidenceDirectory,
    }),
  );
  runs.push(
    await executeProbe({
      capability: `bitget.orderbook.generic.${symbol}`,
      request: {
        method: 'GET',
        url: buildUrl('/api/v3/market/orderbook', { category: 'SPOT', symbol, limit: '40' }),
      },
      action: async () =>
        toCapture(
          await client.get('/api/v3/market/orderbook', { category: 'SPOT', symbol, limit: '40' }),
        ),
      normalize: (payload) => normalizeOrderBook(payload, symbol),
      outputDirectory: evidenceDirectory,
    }),
  );
  runs.push(
    await executeProbe({
      capability: `bitget.fills.generic.${symbol}`,
      request: {
        method: 'GET',
        url: buildUrl('/api/v3/market/fills', { category: 'SPOT', symbol, limit: '100' }),
      },
      action: async () =>
        toCapture(
          await client.get('/api/v3/market/fills', { category: 'SPOT', symbol, limit: '100' }),
        ),
      normalize: (payload) => normalizeFills(payload, symbol),
      outputDirectory: evidenceDirectory,
    }),
  );
  runs.push(
    await executeProbe({
      capability: `bitget.candles.${symbol}`,
      request: {
        method: 'GET',
        url: buildUrl('/api/v3/market/candles', {
          category: 'SPOT',
          symbol,
          interval: '1m',
          limit: '10',
        }),
      },
      action: async () =>
        toCapture(
          await client.get('/api/v3/market/candles', {
            category: 'SPOT',
            symbol,
            interval: '1m',
            limit: '10',
          }),
        ),
      normalize: normalizeCandles,
      outputDirectory: evidenceDirectory,
    }),
  );
}

runs.push(
  await executeProbe({
    capability: 'bitget.reality.stock-info',
    request: { method: 'GET', url: buildUrl('/api/v3/reality/market/stock-info', {}) },
    action: async () => toCapture(await client.get('/api/v3/reality/market/stock-info')),
    normalize: normalizeStockInfo,
    outputDirectory: evidenceDirectory,
  }),
);
runs.push(
  await executeProbe({
    capability: 'bitget.reality.market-states',
    request: { method: 'GET', url: buildUrl('/api/v3/reality/market/states', {}) },
    action: async () => toCapture(await client.get('/api/v3/reality/market/states')),
    normalize: normalizeMarketStates,
    outputDirectory: evidenceDirectory,
  }),
);
runs.push(
  await executeProbe({
    capability: 'bitget.reality.market-calendar',
    request: { method: 'GET', url: buildUrl('/api/v3/reality/market/calendar', {}) },
    action: async () => toCapture(await client.get('/api/v3/reality/market/calendar')),
    normalize: normalizeCalendar,
    outputDirectory: evidenceDirectory,
  }),
);

const comparisonSymbol = symbols[0];
if (comparisonSymbol) {
  runs.push(
    await executeProbe({
      capability: `bitget.historical-candles.${comparisonSymbol}`,
      request: {
        method: 'GET',
        url: buildUrl('/api/v3/market/history-candles', {
          category: 'SPOT',
          symbol: comparisonSymbol,
          interval: '1m',
          limit: '10',
        }),
      },
      action: async () =>
        toCapture(
          await client.get('/api/v3/market/history-candles', {
            category: 'SPOT',
            symbol: comparisonSymbol,
            interval: '1m',
            limit: '10',
          }),
        ),
      normalize: normalizeCandles,
      outputDirectory: evidenceDirectory,
    }),
  );
  runs.push(
    await executeProbe({
      capability: `bitget.reality.company-overview.${comparisonSymbol}`,
      request: {
        method: 'GET',
        url: buildUrl('/api/v3/reality/market/company-overview', { symbol: comparisonSymbol }),
      },
      action: async () =>
        toCapture(
          await client.get('/api/v3/reality/market/company-overview', {
            symbol: comparisonSymbol,
          }),
        ),
      normalize: (payload) => normalizeCompanyOverview(payload),
      outputDirectory: evidenceDirectory,
    }),
  );
  runs.push(
    await executeProbe({
      capability: 'bitget.reality.company-overview.all',
      request: {
        method: 'GET',
        url: buildUrl('/api/v3/reality/market/company-overview', {}),
      },
      action: async () => toCapture(await client.get('/api/v3/reality/market/company-overview')),
      normalize: (payload) => normalizeCompanyOverview(payload),
      outputDirectory: evidenceDirectory,
    }),
  );
  runs.push(
    await executeProbe({
      capability: `bitget.orderbook.reality-specific.${comparisonSymbol}`,
      request: {
        method: 'GET',
        url: buildUrl('/api/v3/account/reality-orderbook', { symbol: comparisonSymbol }),
      },
      action: async () =>
        toCapture(
          await client.get('/api/v3/account/reality-orderbook', { symbol: comparisonSymbol }),
        ),
      normalize: (payload) => normalizeOrderBook(payload, comparisonSymbol),
      outputDirectory: evidenceDirectory,
    }),
  );
  runs.push(
    await executeProbe({
      capability: `bitget.fills.reality-specific.${comparisonSymbol}`,
      request: {
        method: 'GET',
        url: buildUrl('/api/v3/account/reality-fills', { symbol: comparisonSymbol, limit: '100' }),
      },
      action: async () =>
        toCapture(
          await client.get('/api/v3/account/reality-fills', {
            symbol: comparisonSymbol,
            limit: '100',
          }),
        ),
      normalize: (payload) => normalizeFills(payload, comparisonSymbol),
      outputDirectory: evidenceDirectory,
    }),
  );
}

console.log(
  JSON.stringify(
    {
      provider: 'bitget',
      evidenceDirectory,
      initialSymbol,
      symbolsTested: symbols,
      discoveredRealityCount: realityInstruments.length,
      qwenOrCredentialsUsed: false,
      probes: runs.map(summarizeProbe),
    },
    null,
    2,
  ),
);

function chooseSymbols(
  instruments: BitgetInstrument[],
  preferred: string,
  limit: number,
): string[] {
  const exact = instruments.find((instrument) => instrument.symbol === preferred)?.symbol;
  const remaining = instruments
    .map((instrument) => instrument.symbol)
    .filter((symbol) => symbol !== exact);
  return [...(exact ? [exact] : []), ...remaining].slice(0, limit);
}

function toCapture(result: BitgetRequestResult): ProbeCapture {
  const providerTimestamp = getProviderTimestamp(result.json);
  return {
    requestUrl: result.requestUrl,
    raw: result.raw,
    payload: result.json,
    providerTimestamp,
  };
}

function buildUrl(path: string, query: Record<string, string>): string {
  const url = new URL(`${client.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
