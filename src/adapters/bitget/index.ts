export { BitgetPublicClient, DEFAULT_BITGET_BASE_URL } from './client.js';
export type { BitgetRequestResult } from './client.js';
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
