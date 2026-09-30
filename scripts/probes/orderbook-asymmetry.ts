import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Decimal from 'decimal.js';
import {
  BitgetPublicMarketDataAdapter,
  normalizeOrderBook,
} from '../../src/adapters/bitget/index.js';
import { hashRawResponse } from '../../src/observability/evidence.js';
import { getProviderTimestamp } from '../../src/adapters/bitget/index.js';
import { writeTextFile } from '../../src/observability/evidence.js';

const watchSymbols = ['RNVDAUSDT', 'RTSLAUSDT', 'RAAPLUSDT', 'RSPYUSDT'];
const requestedDepth = 40;
const repeats = 3;
const provider = new BitgetPublicMarketDataAdapter();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputDirectory = join(process.cwd(), '.agent', 'evidence', 'orderbook-asymmetry', runId);
await mkdir(outputDirectory, { recursive: true });

const universe = await provider.discoverRealityInstruments();
const knownSymbols = new Set(universe.data.map((instrument) => instrument.providerSymbol));
const instruments = [] as Array<{
  providerSymbol: string;
  nativeTicker: string | null;
  mappingStatus: string;
  observations: Observation[];
  conclusion: string;
}>;

for (const providerSymbol of watchSymbols) {
  const instrument = universe.data.find((item) => item.providerSymbol === providerSymbol);
  const observations: Observation[] = [];
  if (!knownSymbols.has(providerSymbol)) {
    instruments.push({
      providerSymbol,
      nativeTicker: null,
      mappingStatus: 'unresolved',
      observations,
      conclusion: 'not-present-in-current-reality-universe',
    });
    continue;
  }
  for (let attempt = 1; attempt <= repeats; attempt += 1) {
    try {
      const result = await provider.client.get('/api/v3/market/orderbook', {
        category: 'SPOT',
        symbol: providerSymbol,
        limit: String(requestedDepth),
      });
      const normalized = normalizeOrderBook(result.json, providerSymbol, result.raw.status);
      const rawData = responseData(result.json);
      const rawBids = rawLevels(rawData, 'bids', 'b');
      const rawAsks = rawLevels(rawData, 'asks', 'a');
      observations.push({
        attempt,
        requestedDepth,
        rawBidCount: rawBids.length,
        rawAskCount: rawAsks.length,
        normalizedBidCount: normalized.bids?.length ?? 0,
        normalizedAskCount: normalized.asks?.length ?? 0,
        bestBid: bestBid(normalized.bids ?? []),
        bestAsk: bestAsk(normalized.asks ?? []),
        providerTimestamp: getProviderTimestamp(result.json),
        receivedAt: result.raw.receivedAt,
        rawResponseHash: hashRawResponse(result.raw.bodyText),
        normalizerPreservedBidCount: rawBids.length === (normalized.bids?.length ?? 0),
        normalizerPreservedAskCount: rawAsks.length === (normalized.asks?.length ?? 0),
      });
    } catch (error) {
      observations.push({
        attempt,
        requestedDepth,
        rawBidCount: null,
        rawAskCount: null,
        normalizedBidCount: null,
        normalizedAskCount: null,
        bestBid: null,
        bestAsk: null,
        providerTimestamp: null,
        receivedAt: new Date().toISOString(),
        rawResponseHash: null,
        normalizerPreservedBidCount: null,
        normalizerPreservedAskCount: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  instruments.push({
    providerSymbol,
    nativeTicker: instrument?.nativeTicker ?? null,
    mappingStatus: instrument?.mappingStatus ?? 'unmapped',
    observations,
    conclusion: conclude(observations),
  });
}

const report = {
  reportType: 'aftermrkt-orderbook-asymmetry-investigation',
  generatedAt: new Date().toISOString(),
  provider: 'bitget',
  sourceId: 'bitget_generic_spot_orderbook',
  requestedDepth,
  repeats,
  watchSymbols,
  instruments,
  limitations: [
    'This bounded probe compares provider raw-array counts with normalized counts. It does not claim generic and Reality-specific books are identical.',
    'Reality-specific order-book comparison remains blocked by the authenticated ACCESS_KEY requirement.',
  ],
};
const outputPath = join(outputDirectory, 'report.json');
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, ...report }, null, 2));

type Observation = {
  attempt: number;
  requestedDepth: number;
  rawBidCount: number | null;
  rawAskCount: number | null;
  normalizedBidCount: number | null;
  normalizedAskCount: number | null;
  bestBid: string | null;
  bestAsk: string | null;
  providerTimestamp: string | null;
  receivedAt: string;
  rawResponseHash: string | null;
  normalizerPreservedBidCount: boolean | null;
  normalizerPreservedAskCount: boolean | null;
  error?: string;
};

function responseData(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const data = (value as Record<string, unknown>).data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

function rawLevels(data: Record<string, unknown>, primary: string, alias: string): unknown[] {
  const value = data[primary] ?? data[alias];
  return Array.isArray(value) ? value : [];
}

function bestBid(levels: string[][]): string | null {
  return levels.length === 0
    ? null
    : levels.reduce(
        (best, level) => {
          if (best === null) return level[0] ?? null;
          const price = level[0] ?? null;
          return price !== null && new Decimal(price).gt(best) ? price : best;
        },
        null as string | null,
      );
}

function bestAsk(levels: string[][]): string | null {
  return levels.length === 0
    ? null
    : levels.reduce(
        (best, level) => {
          if (best === null) return level[0] ?? null;
          const price = level[0] ?? null;
          return price !== null && new Decimal(price).lt(best) ? price : best;
        },
        null as string | null,
      );
}

function conclude(observations: Observation[]): string {
  const successful = observations.filter((item) => item.error === undefined);
  if (successful.length === 0) return 'no-successful-snapshots';
  if (
    successful.some(
      (item) => !item.normalizerPreservedBidCount || !item.normalizerPreservedAskCount,
    )
  ) {
    return 'normalizer-count-mismatch-requires-investigation';
  }
  if (successful.every((item) => (item.rawBidCount ?? 0) <= 1)) {
    return 'provider-returned-at-most-one-bid-level';
  }
  const shapes = new Set(successful.map((item) => `${item.rawBidCount}:${item.rawAskCount}`));
  if (shapes.size > 1) return 'provider-shape-varied-across-repeated-snapshots';
  if (successful.some((item) => (item.rawBidCount ?? 0) !== (item.rawAskCount ?? 0))) {
    return 'persistent-provider-side-asymmetry';
  }
  return 'no-persistent-asymmetry-observed';
}
