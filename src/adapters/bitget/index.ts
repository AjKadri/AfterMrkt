export { BitgetPublicClient, DEFAULT_BITGET_BASE_URL } from './client.js';
export type { BitgetRequestResult } from './client.js';
export {
  BitgetPublicMarketDataAdapter,
  type CandleQuery,
  type PublicMarketDataProvider,
} from './public-market-data.js';
export { demoRealityAdapterBoundary } from './demo.js';
export type {
  BitgetDemoCredentials,
  BitgetDemoRealityAdapter,
  DemoCapabilityResult,
  DemoLimitOrderIntent,
  DemoOrderState,
} from './demo.js';
export {
  assertExactSymbol,
  getProviderTimestamp,
  normalizeCalendar,
  normalizeCandles,
  normalizeFills,
  normalizeInstruments,
  normalizeMarketStates,
  normalizeOrderBook,
  normalizeStockInfo,
  normalizeTicker,
  normalizeTickers,
  parseBitgetResponse,
  selectRealityInstruments,
} from './normalizers.js';
