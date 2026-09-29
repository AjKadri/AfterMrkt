import { z } from 'zod';
import { DecimalStringSchema } from '../domain/types.js';
import type { Freshness, SourceReference } from '../domain/types.js';

export const ExecutionSimulationRequestSchema = z.object({
  symbol: z.string().trim().min(1),
  requestedQuantity: DecimalStringSchema,
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  maximumAcceptableSlippageBps: DecimalStringSchema.optional(),
});

export type ExecutionSimulationRequest = z.infer<typeof ExecutionSimulationRequestSchema>;

export type ApiMode = 'LIVE';

export type ApiEnvelope<T> = {
  mode: ApiMode;
  asOf: string;
  freshness: Freshness;
  data: T;
  sourceRefs: SourceReference[];
  warnings: string[];
};

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'INSTRUMENT_NOT_FOUND'
  | 'SNAPSHOT_NOT_FOUND'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTHENTICATION_INVALID'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_MALFORMED'
  | 'PROVIDER_REJECTED'
  | 'INVALID_BOOK'
  | 'INTERNAL_ERROR';

export type ApiErrorEnvelope = ApiEnvelope<null> & {
  error: {
    code: ApiErrorCode;
    message: string;
  };
};
