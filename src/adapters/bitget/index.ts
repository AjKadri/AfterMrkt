export { BitgetPublicClient, DEFAULT_BITGET_BASE_URL } from './client.js';
export type { BitgetRequestResult } from './client.js';
export {
  BitgetPublicMarketDataAdapter,
  normalizeTickerData,
  type CandleQuery,
  type PublicMarketDataProvider,
} from './public-market-data.js';
export {
  BitgetDemoClient,
  buildBitgetSignature,
  credentialsFromProcessEnv,
  demoRealityAdapterBoundary,
} from './demo.js';
export type {
  BitgetDemoClientOptions,
  BitgetDemoCredentials,
  BitgetDemoRealityAdapter,
  DemoAccountCheck,
  DemoAssetBalance,
  DemoCapabilityResult,
  DemoOpenOrder,
  DemoOrderIntent,
  DemoOrderState,
} from './demo.js';
export {
  assertExactSymbol,
  getProviderTimestamp,
  normalizeCalendar,
  normalizeCandles,
  normalizeCompanyOverview,
  normalizeFills,
  normalizeInstruments,
  normalizeMarketStates,
  normalizeOrderBook,
  normalizeStockInfo,
  normalizeSuspensionResumption,
  normalizeTicker,
  normalizeTickers,
  parseBitgetResponse,
  selectRealityInstruments,
} from './normalizers.js';
