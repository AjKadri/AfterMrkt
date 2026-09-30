import type { DemoAccountCheck, DemoOrderState } from '../adapters/bitget/demo.js';
import type { ExitSimulation, ExecutionCondition, ExecutionReason } from './market-quality.js';
import type { SourceMetadata } from './types.js';

export type PositionSource = 'manual' | 'demo' | 'connected_bitget';
export type ExecutionEnvironment = 'SIMULATED' | 'BITGET_DEMO';

export type Position = {
  positionId: string;
  providerSymbol: string;
  baseCoin: string;
  quantity: string;
  availableQuantity: string;
  lockedQuantity: string;
  source: PositionSource;
  environment: ExecutionEnvironment;
  asOf: string;
  isSimulated: boolean;
};

export type ManualPositionInput = {
  providerSymbol: string;
  quantity: string;
  availableQuantity?: string;
  lockedQuantity?: string;
};

export type ExecutionIntentStatus =
  | 'created'
  | 'awaiting_confirmation'
  | 'validation_failed'
  | 'refresh_required'
  | 'submitted'
  | 'pending_verification'
  | 'live'
  | 'partially_filled'
  | 'filled'
  | 'cancel_requested'
  | 'canceled'
  | 'rejected'
  | 'ambiguous';

export type ExecutionOrderStatus = Exclude<
  ExecutionIntentStatus,
  'created' | 'awaiting_confirmation' | 'validation_failed' | 'refresh_required'
>;

export type ExecutionValidation = {
  status: 'passed' | 'failed' | 'refresh_required';
  reasons: ExecutionReason[];
  checkedAt: string;
  bookSnapshotId: string;
  balanceAsOf: string;
  availableQuantity: string;
  openSellOrderCount: number;
};

export type ExecutionIntent = {
  intentId: string;
  environment: ExecutionEnvironment;
  positionId: string;
  providerSymbol: string;
  side: 'sell';
  orderType: 'market' | 'limit';
  requestedQuantity: string;
  limitPrice: string | null;
  maximumAcceptableSlippageBps: string | null;
  simulationId: string;
  bookSnapshotId: string;
  bookSource: SourceMetadata;
  simulation: ExitSimulation;
  createdAt: string;
  expiresAt: string;
  confirmationExpiresAt: string;
  status: ExecutionIntentStatus;
  validation: ExecutionValidation;
  clientOid: string | null;
  orderId: string | null;
};

export type ExecutionOrder = {
  internalOrderId: string;
  intentId: string;
  environment: 'BITGET_DEMO';
  providerSymbol: string;
  side: 'sell';
  orderType: 'market' | 'limit';
  requestedQuantity: string;
  limitPrice: string | null;
  clientOid: string;
  providerOrderId: string | null;
  status: ExecutionOrderStatus;
  provider: DemoOrderState | null;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
};

export type ExecutionConfirmation = {
  tokenHash: string;
  intentId: string;
  expiresAt: string;
  usedAt: string | null;
};

export type ExecutionAuditEvent = {
  eventId: string;
  eventType:
    | 'intent_created'
    | 'simulation_produced'
    | 'confirmation_issued'
    | 'confirmation_consumed'
    | 'validation_passed'
    | 'validation_failed'
    | 'refresh_required'
    | 'provider_submission_started'
    | 'provider_response'
    | 'reconciliation_attempt'
    | 'order_state_change'
    | 'cancellation_requested';
  intentId: string;
  orderId: string | null;
  occurredAt: string;
  details: Record<string, string | number | boolean | null>;
};

export type DemoPositionsResult = {
  environment: 'BITGET_DEMO';
  status: 'verified' | 'unavailable' | 'unsupported';
  account: DemoAccountCheck | null;
  positions: Position[];
  warnings: string[];
  checkedAt: string;
};

export type ConfirmationResult =
  | {
      status: 'refresh_required';
      intent: ExecutionIntent;
      simulation: ExitSimulation;
      confirmationToken: string;
    }
  | {
      status:
        'submitted' | 'pending_verification' | 'live' | 'partially_filled' | 'filled' | 'ambiguous';
      intent: ExecutionIntent;
      order: ExecutionOrder;
    };

export type ExecutionOrderView = {
  order: ExecutionOrder;
  intent: ExecutionIntent | null;
};

export type ExecutionConditionSummary = Pick<ExecutionCondition, 'label' | 'reasons'>;
