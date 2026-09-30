import { z } from 'zod';
import { DecimalStringSchema } from '../domain/types.js';
import type { Freshness, SourceReference } from '../domain/types.js';
import type { ProductSourceReference } from '../api/product-contracts.js';

const ExecutionSimulationInputSchema = z
  .object({
    symbol: z.string().trim().min(1),
    quantity: DecimalStringSchema.optional(),
    requestedQuantity: DecimalStringSchema.optional(),
    snapshotId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    maximumAcceptableSlippageBps: DecimalStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quantity === undefined && value.requestedQuantity === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'quantity is required',
      });
    }
    if (value.quantity !== undefined && value.requestedQuantity !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'use quantity or requestedQuantity, not both',
      });
    }
  });

export const ExecutionSimulationRequestSchema = ExecutionSimulationInputSchema.transform(
  (value) => ({
    symbol: value.symbol,
    requestedQuantity: value.quantity ?? value.requestedQuantity ?? '',
    ...(value.snapshotId === undefined ? {} : { snapshotId: value.snapshotId }),
    ...(value.maximumAcceptableSlippageBps === undefined
      ? {}
      : { maximumAcceptableSlippageBps: value.maximumAcceptableSlippageBps }),
  }),
);

const ReplaySimulationInputSchema = z
  .object({
    quantity: DecimalStringSchema.optional(),
    requestedQuantity: DecimalStringSchema.optional(),
    maximumAcceptableSlippageBps: DecimalStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quantity === undefined && value.requestedQuantity === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'quantity is required',
      });
    }
    if (value.quantity !== undefined && value.requestedQuantity !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'use quantity or requestedQuantity, not both',
      });
    }
  });

export const ReplaySimulationRequestSchema = ReplaySimulationInputSchema.transform((value) => ({
  requestedQuantity: value.quantity ?? value.requestedQuantity ?? '',
  ...(value.maximumAcceptableSlippageBps === undefined
    ? {}
    : { maximumAcceptableSlippageBps: value.maximumAcceptableSlippageBps }),
}));

export const ManualPositionRequestSchema = z
  .object({
    symbol: z.string().trim().min(1),
    quantity: DecimalStringSchema,
    availableQuantity: DecimalStringSchema.optional(),
    lockedQuantity: DecimalStringSchema.optional(),
  })
  .strict();

export const ExecutionIntentRequestSchema = z
  .object({
    positionId: z.string().regex(/^[a-f0-9]{64}$/),
    symbol: z.string().trim().min(1),
    orderType: z.enum(['market', 'limit']),
    requestedQuantity: DecimalStringSchema,
    limitPrice: DecimalStringSchema.optional(),
    maximumAcceptableSlippageBps: DecimalStringSchema.optional(),
  })
  .strict();

export const ExecutionConfirmationRequestSchema = z
  .object({
    confirmationToken: z.string().min(20),
  })
  .strict();

export type ExecutionSimulationRequest = z.infer<typeof ExecutionSimulationRequestSchema>;
export type ManualPositionRequest = z.infer<typeof ManualPositionRequestSchema>;
export type ExecutionIntentRequest = z.infer<typeof ExecutionIntentRequestSchema>;
export type ExecutionConfirmationRequest = z.infer<typeof ExecutionConfirmationRequestSchema>;

export type ApiMode = 'LIVE' | 'REPLAY';

export type ApiEnvelope<T> = {
  mode: ApiMode;
  asOf: string;
  freshness: Freshness;
  data: T;
  sourceRefs: Array<SourceReference | ProductSourceReference>;
  warnings: string[];
};

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'INSTRUMENT_NOT_FOUND'
  | 'EVENT_NOT_FOUND'
  | 'SNAPSHOT_NOT_FOUND'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTHENTICATION_INVALID'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_MALFORMED'
  | 'PROVIDER_REJECTED'
  | 'INVALID_BOOK'
  | 'REPLAY_CASE_NOT_FOUND'
  | 'REPLAY_SNAPSHOT_NOT_FOUND'
  | 'REPLAY_MANIFEST_INVALID'
  | 'REPLAY_UNAVAILABLE'
  | 'instrument_not_found'
  | 'market_data_unavailable'
  | 'market_data_stale'
  | 'session_unavailable'
  | 'event_evidence_unavailable'
  | 'simulation_invalid_quantity'
  | 'simulation_book_unavailable'
  | 'replay_not_found'
  | 'replay_unavailable'
  | 'POSITION_NOT_FOUND'
  | 'INSTRUMENT_OFFLINE'
  | 'INVALID_SYMBOL'
  | 'INVALID_QUANTITY'
  | 'INSUFFICIENT_POSITION'
  | 'LOCKED_POSITION'
  | 'QUANTITY_PRECISION'
  | 'MINIMUM_QUANTITY'
  | 'MINIMUM_AMOUNT'
  | 'MAX_SLIPPAGE_EXCEEDED'
  | 'STALE_BOOK'
  | 'OPEN_SELL_ORDER'
  | 'DEMO_UNAVAILABLE'
  | 'DEMO_UNSUPPORTED'
  | 'MANUAL_POSITION_NOT_EXECUTABLE'
  | 'INTENT_NOT_FOUND'
  | 'INTENT_EXPIRED'
  | 'CONFIRMATION_INVALID'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_REUSED'
  | 'REFRESH_REQUIRED'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_NOT_CANCELABLE'
  | 'INTERNAL_ERROR';

export type ApiErrorEnvelope = ApiEnvelope<null> & {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, string | number | boolean | null>;
  };
};
