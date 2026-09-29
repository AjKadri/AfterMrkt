import { z } from 'zod';

export const CapabilityStatusSchema = z.enum([
  'verified',
  'environment_unreachable',
  'provider_rejected',
  'authentication_invalid',
  'whitelist_denied',
  'instrument_missing',
  'malformed_provider_data',
  'stale_data',
  'not_attempted',
]);

export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export type ProbeRequest = {
  method: string;
  url: string;
  body?: unknown;
};

export type CapabilityResult = {
  status: CapabilityStatus;
  reason: string;
  httpStatus?: number;
  providerCode?: string;
  providerMessage?: string;
};

export type ProbeRecord = {
  capability: string;
  request: ProbeRequest;
  endpoint: string;
  startedAt: string;
  receivedAt: string;
  providerTimestamp: string | null;
  normalizedResponse: unknown | null;
  rawResponseHash: string;
  capabilityResult: CapabilityResult;
  rawResponse?: string;
};
