import type { CapabilityStatus } from '../../probes/types.js';

export type BitgetDemoCredentials = {
  apiKey: string;
  secretKey: string;
  passphrase: string;
};

export type DemoLimitOrderIntent = {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
  price: string;
  clientOid: string;
};

export type DemoOrderState = {
  orderId: string | null;
  clientOid: string;
  status: string;
  filledQuantity: string;
  averageFillPrice: string | null;
  remainingQuantity: string;
  receivedAt: string;
};

export type DemoCapabilityResult = {
  status: CapabilityStatus;
  reason: string;
  providerSymbol: string;
  credentialsConfigured: boolean;
};

export interface BitgetDemoRealityAdapter {
  verifyInstrument(symbol: string): Promise<DemoCapabilityResult>;
  placeLimitOrder(intent: DemoLimitOrderIntent): Promise<DemoOrderState>;
  getOrderByClientOid(clientOid: string): Promise<DemoOrderState>;
  cancelOrder(clientOid: string): Promise<DemoOrderState>;
}

export const demoRealityAdapterBoundary = {
  enabled: false,
  reason:
    'Bitget Demo Reality support is not enabled until a separate demo credential and order proof exist.',
};
