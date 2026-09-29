export { BitgetPublicClient, DEFAULT_BITGET_BASE_URL } from './client.js';
export type { BitgetRequestResult } from './client.js';
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
  parseBitgetResponse,
  selectRealityInstruments,
} from './normalizers.js';
